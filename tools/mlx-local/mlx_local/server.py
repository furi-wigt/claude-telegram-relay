"""MLX servers — unified (generation + embeddings) and standalone embedding-only.

Unified server: extends mlx_lm.server with /v1/embeddings endpoint.
Embedding server: lightweight HTTP server for embeddings only — no GPU lock contention
with generation. Run as a separate process on a different port.
"""

import json
import logging
import argparse
import threading
import click
import numpy as np
import mlx.core as mx


# Module-level GPU lock — serializes all Metal operations (generation + embedding)
# to prevent concurrent command buffer access crashes.
_gpu_lock = threading.Lock()


class EmbeddingModel:
    """Lazy-loaded embedding model with thread-safe inference."""

    def __init__(self, model_id: str):
        self.model_id = model_id
        self._model = None
        self._tokenizer = None
        self._lock = _gpu_lock

    def _ensure_loaded(self):
        if self._model is not None:
            return
        click.echo(f"[mlx] Loading embedding model: {self.model_id}")
        from mlx_embeddings.utils import load as load_embed
        self._model, tok_wrapper = load_embed(self.model_id)
        # Ensure fp16 — mlx-community/bge-m3-mlx-fp16 is already fp16,
        # but this guards against model ID override via --embed-model.
        self._model.set_dtype(mx.float16)
        self._tokenizer = tok_wrapper._tokenizer
        click.echo(f"[mlx] Embedding model ready: {self.model_id} (fp16)")

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
        prompt_cache_size=10,
        prompt_cache_bytes=None,
        pipeline=False,
        log_level="INFO",
        max_tokens=4096,
        temp=0.0,
        top_p=1.0,
        top_k=0,
        min_p=0.0,
    )


def _handle_embeddings(handler, embed_ref, emb_model):
    """Shared embedding request handler for both unified and standalone servers."""
    try:
        content_length = int(handler.headers.get("Content-Length", 0))
        body = json.loads(handler.rfile.read(content_length))

        input_data = body.get("input", [])
        if isinstance(input_data, str):
            input_data = [input_data]

        vectors = embed_ref.embed(input_data)

        response = {
            "object": "list",
            "model": emb_model,
            "data": [
                {"object": "embedding", "index": i, "embedding": vec}
                for i, vec in enumerate(vectors)
            ],
            "usage": {
                "prompt_tokens": sum(len(t.split()) for t in input_data),
                "total_tokens": sum(len(t.split()) for t in input_data),
            },
        }
        _send_json(handler, response)

    except BrokenPipeError:
        click.echo("[mlx] Client disconnected before response (broken pipe)", err=True)
    except Exception as e:
        try:
            _send_json(
                handler,
                {"error": {"message": str(e), "type": "server_error"}}, 500
            )
        except BrokenPipeError:
            click.echo(f"[mlx] Client disconnected, could not send error: {e}", err=True)


def _send_json(handler, data: dict, status: int = 200):
    """Shared JSON response helper."""
    body = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def run_server(model: str, embed_model: str, host: str, port: int):
    """Start unified server with text generation + embeddings."""
    from mlx_lm.server import (
        APIHandler, ModelProvider, ResponseGenerator,
        LRUPromptCache, _run_http_server,
    )

    _embed = EmbeddingModel(embed_model)

    class UnifiedHandler(APIHandler):
        """Extends mlx_lm APIHandler with /v1/embeddings and /health."""

        embed_ref = _embed
        gen_model = model
        emb_model = embed_model

        def do_POST(self):
            if self.path == "/v1/embeddings":
                return _handle_embeddings(self, self.embed_ref, self.emb_model)
            with _gpu_lock:
                try:
                    return super().do_POST()
                except BrokenPipeError:
                    click.echo("[mlx] Client disconnected during generation (broken pipe)", err=True)

        def do_GET(self):
            if self.path == "/health":
                return _send_json(self, {"status": "ok", "models": {
                    "generation": self.gen_model,
                    "embedding": self.emb_model,
                }})
            return super().do_GET()

    click.echo(f"[mlx] Unified server starting on {host}:{port}")
    click.echo(f"[mlx]   Generation: {model}")
    click.echo(f"[mlx]   Embeddings: {embed_model}")
    click.echo(f"[mlx] Endpoints:")
    click.echo(f"[mlx]   POST /v1/chat/completions — text generation")
    click.echo(f"[mlx]   POST /v1/embeddings       — embeddings")
    click.echo(f"[mlx]   GET  /health               — health check")

    if mx.metal.is_available():
        wired_limit = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(wired_limit)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )

    args = _build_args(model)
    provider = ModelProvider(args)
    cache = LRUPromptCache(args.prompt_cache_size)
    response_gen = ResponseGenerator(provider, cache)

    _run_http_server(host, port, response_gen, handler_class=UnifiedHandler)


def run_embed_server(embed_model: str, host: str, port: int):
    """Start embedding-only server — no generation model, no GPU lock contention.

    Runs as a separate process from the generation server so embedding requests
    are never blocked by long-running text generation. Each process gets its own
    Metal command queue via macOS unified memory.
    """
    from http.server import HTTPServer, BaseHTTPRequestHandler

    # Private lock — not shared with generation process
    _embed = EmbeddingModel(embed_model)
    _embed._lock = threading.Lock()

    class EmbedHandler(BaseHTTPRequestHandler):
        """Lightweight HTTP handler for embeddings only."""

        def do_POST(self):
            if self.path == "/v1/embeddings":
                return _handle_embeddings(self, _embed, embed_model)
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

    server = HTTPServer((host, port), EmbedHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        click.echo("[mlx-embed] Shutting down")
    finally:
        server.server_close()
