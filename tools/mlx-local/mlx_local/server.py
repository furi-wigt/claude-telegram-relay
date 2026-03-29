"""MLX servers — generation-only and standalone embedding-only.

Generation server (port 8800): wraps mlx_lm.server for text generation only.
  No embedding model loaded, no /v1/embeddings endpoint.
Embedding server (port 8801): lightweight HTTP server for embeddings only.
  Each runs as a separate process with its own Metal command queue.
"""

import json
import logging
import argparse
import threading
import click
import numpy as np
import mlx.core as mx


_GB = 1 << 30

# ── Generation server memory caps ──────────────────────────────────────────
# Qwen3.5-9B-4bit: ~5.6 GB. Single-user workload.
_PROMPT_CACHE_MAX_SEQUENCES = 4
_PROMPT_CACHE_MAX_BYTES = 3 * _GB
_MLX_CACHE_LIMIT_GEN = 1 * _GB

# ── Embedding server memory caps ───────────────────────────────────────────
# bge-m3-fp16: ~0.5 GB. No KV caches, only inference tensors.
_MLX_CACHE_LIMIT_EMBED = _GB // 2


def _send_json(handler, data: dict, status: int = 200):
    """Shared JSON response helper."""
    body = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _build_args(model: str) -> argparse.Namespace:
    """Build argparse.Namespace with all attributes mlx_lm.server expects."""
    return argparse.Namespace(
        model=model,
        adapter_path=None,
        trust_remote_code=False,
        chat_template="",
        chat_template_args={"enable_thinking": False},
        use_default_chat_template=False,
        draft_model=None,
        num_draft_tokens=3,
        prompt_concurrency=8,
        decode_concurrency=32,
        prefill_step_size=2048,
        prompt_cache_size=_PROMPT_CACHE_MAX_SEQUENCES,
        prompt_cache_bytes=_PROMPT_CACHE_MAX_BYTES,
        pipeline=False,
        log_level="INFO",
        max_tokens=4096,
        temp=0.0,
        top_p=1.0,
        top_k=0,
        min_p=0.0,
    )


# ── Generation-only server ─────────────────────────────────────────────────

def run_gen_server(model: str, host: str, port: int):
    """Start generation-only server. No embedding model, no /v1/embeddings."""
    from mlx_lm.server import (
        APIHandler, ModelProvider, ResponseGenerator,
        LRUPromptCache, _run_http_server,
    )

    class GenHandler(APIHandler):
        """Generation-only handler with /health. Rejects embedding requests."""

        gen_model = model

        def do_POST(self):
            if self.path == "/v1/embeddings":
                return _send_json(self, {
                    "error": {
                        "message": "Embeddings not supported on this server. Use the embed server (port 8801).",
                        "type": "invalid_request",
                    }
                }, 400)
            try:
                return super().do_POST()
            except BrokenPipeError:
                click.echo("[mlx] Client disconnected during generation (broken pipe)", err=True)

        def do_GET(self):
            if self.path in ("/health", "/healthz"):
                return _send_json(self, {
                    "status": "ok",
                    "model": self.gen_model,
                    "type": "generation",
                })
            return super().do_GET()

    click.echo(f"[mlx] Generation server starting on {host}:{port}")
    click.echo(f"[mlx]   Model: {model}")
    click.echo(f"[mlx] Endpoints:")
    click.echo(f"[mlx]   POST /v1/chat/completions — text generation")
    click.echo(f"[mlx]   GET  /health               — health check")

    if mx.metal.is_available():
        wired_limit = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(wired_limit)
        mx.set_cache_limit(_MLX_CACHE_LIMIT_GEN)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )

    args = _build_args(model)
    provider = ModelProvider(args)
    cache = LRUPromptCache(args.prompt_cache_size)
    response_gen = ResponseGenerator(provider, cache)

    _run_http_server(host, port, response_gen, handler_class=GenHandler)


# ── Embedding-only server ──────────────────────────────────────────────────

class EmbeddingModel:
    """Lazy-loaded embedding model with thread-safe inference."""

    def __init__(self, model_id: str):
        self.model_id = model_id
        self._model = None
        self._tokenizer = None
        self._lock = threading.Lock()

    def _ensure_loaded(self):
        if self._model is not None:
            return
        click.echo(f"[mlx-embed] Loading embedding model: {self.model_id}")
        from mlx_embeddings.utils import load as load_embed
        self._model, tok_wrapper = load_embed(self.model_id)
        self._model.set_dtype(mx.float16)
        self._tokenizer = tok_wrapper._tokenizer
        click.echo(f"[mlx-embed] Embedding model ready: {self.model_id} (fp16)")

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for a list of texts. Thread-safe."""
        with self._lock:
            self._ensure_loaded()
            inputs = self._tokenizer(
                texts, padding=True, truncation=True,
                max_length=512, return_tensors="np"
            )
            input_ids = mx.array(inputs["input_ids"])
            attention_mask = mx.array(inputs["attention_mask"])

            output = self._model(input_ids=input_ids, attention_mask=attention_mask)
            lhs = output.last_hidden_state

            # Mean pooling — compute in fp32 for numerical stability
            lhs_f32 = lhs.astype(mx.float32)
            mask_f = mx.expand_dims(attention_mask, -1).astype(mx.float32)
            embeddings = mx.sum(lhs_f32 * mask_f, axis=1) / mx.sum(mask_f, axis=1)
            mx.eval(embeddings)

            return np.array(embeddings).tolist()


def run_embed_server(embed_model: str, host: str, port: int):
    """Start embedding-only server — no generation model, separate process."""
    from http.server import HTTPServer, BaseHTTPRequestHandler

    _embed = EmbeddingModel(embed_model)

    class EmbedHandler(BaseHTTPRequestHandler):
        """Lightweight HTTP handler for embeddings only."""

        def do_POST(self):
            if self.path == "/v1/embeddings":
                try:
                    content_length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(content_length))

                    input_data = body.get("input", [])
                    if isinstance(input_data, str):
                        input_data = [input_data]

                    vectors = _embed.embed(input_data)

                    response = {
                        "object": "list",
                        "model": embed_model,
                        "data": [
                            {"object": "embedding", "index": i, "embedding": vec}
                            for i, vec in enumerate(vectors)
                        ],
                        "usage": {
                            "prompt_tokens": sum(len(t.split()) for t in input_data),
                            "total_tokens": sum(len(t.split()) for t in input_data),
                        },
                    }
                    _send_json(self, response)

                except BrokenPipeError:
                    click.echo("[mlx-embed] Client disconnected (broken pipe)", err=True)
                except Exception as e:
                    try:
                        _send_json(
                            self,
                            {"error": {"message": str(e), "type": "server_error"}}, 500
                        )
                    except BrokenPipeError:
                        click.echo(f"[mlx-embed] Client disconnected, could not send error: {e}", err=True)
                return

            _send_json(self, {"error": {"message": "Not found", "type": "invalid_request"}}, 404)

        def do_GET(self):
            if self.path in ("/health", "/healthz"):
                return _send_json(self, {"status": "ok", "model": embed_model})
            _send_json(self, {"error": {"message": "Not found", "type": "invalid_request"}}, 404)

        def log_message(self, format, *args):
            click.echo(f"[mlx-embed] {args[0]} {args[1]} {args[2]}")

    click.echo(f"[mlx-embed] Embedding server starting on {host}:{port}")
    click.echo(f"[mlx-embed]   Model: {embed_model}")
    click.echo(f"[mlx-embed] Endpoints:")
    click.echo(f"[mlx-embed]   POST /v1/embeddings — embeddings")
    click.echo(f"[mlx-embed]   GET  /health         — health check")

    if mx.metal.is_available():
        wired_limit = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(wired_limit)
        mx.set_cache_limit(_MLX_CACHE_LIMIT_EMBED)

    server = HTTPServer((host, port), EmbedHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        click.echo("[mlx-embed] Shutting down")
    finally:
        server.server_close()
