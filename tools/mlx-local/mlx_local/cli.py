"""CLI for mlx: unified local inference — text generation + embeddings on Apple Silicon."""

import os
import click
import json
import re

# Fix Cloudflare WARP SSL: inject corporate CA into httpx/requests cert chain
_CLOUDFLARE_CA = "/etc/ssl/Cloudflare_CA.pem"
if os.path.exists(_CLOUDFLARE_CA) and "SSL_CERT_FILE" not in os.environ:
    import tempfile, certifi
    _combined = os.path.join(tempfile.gettempdir(), "mlx_ca_bundle.pem")
    if not os.path.exists(_combined):
        with open(_combined, "w") as out:
            with open(certifi.where()) as f:
                out.write(f.read())
            with open(_CLOUDFLARE_CA) as f:
                out.write(f.read())
    os.environ["SSL_CERT_FILE"] = _combined
    os.environ["REQUESTS_CA_BUNDLE"] = _combined

DEFAULT_GEN_MODEL = "mlx-community/Qwen3.5-9B-MLX-4bit"
DEFAULT_EMBED_MODEL = "mlx-community/bge-m3-mlx-fp16"
DEFAULT_MAX_TOKENS = 2048


def _strip_think_tags(text: str) -> str:
    """Remove <think>...</think> blocks from output."""
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL).strip()


@click.group()
def main():
    """MLX Local — text generation + embeddings on Apple Silicon."""
    pass


@main.command()
@click.argument("prompt")
@click.option("--model", "-m", default=DEFAULT_GEN_MODEL, help="HuggingFace model ID")
@click.option("--max-tokens", "-t", default=DEFAULT_MAX_TOKENS, type=int)
@click.option("--json-output", "-j", is_flag=True, help="Output JSON with metadata")
def generate(prompt: str, model: str, max_tokens: int, json_output: bool):
    """One-shot text generation from a prompt."""
    from mlx_lm import load, generate as mlx_generate

    model_obj, tokenizer = load(model)

    messages = [
        {"role": "system", "content": "You are a helpful assistant. Do not use thinking tags. Respond directly."},
        {"role": "user", "content": prompt},
    ]
    chat_prompt = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    chat_prompt += "<think>\n</think>\n\n"

    response = mlx_generate(
        model_obj, tokenizer, prompt=chat_prompt, max_tokens=max_tokens, verbose=False
    )
    cleaned = _strip_think_tags(response)

    if json_output:
        click.echo(json.dumps({"model": model, "response": cleaned}))
    else:
        click.echo(cleaned)


@main.command()
@click.argument("text", nargs=-1, required=True)
@click.option("--model", "-m", default=DEFAULT_EMBED_MODEL, help="Embedding model ID")
@click.option("--json-output", "-j", is_flag=True, help="Output JSON with vectors")
def embed(text: tuple, model: str, json_output: bool):
    """Generate embeddings for one or more texts."""
    from mlx_embeddings.utils import load as load_embed
    import mlx.core as mx
    import numpy as np

    model_obj, tokenizer = load_embed(model)
    tok = tokenizer._tokenizer

    texts = list(text)
    inputs = tok(texts, padding=True, truncation=True, max_length=512, return_tensors="np")
    input_ids = mx.array(inputs["input_ids"])
    attention_mask = mx.array(inputs["attention_mask"])

    output = model_obj(input_ids=input_ids, attention_mask=attention_mask)
    lhs = output.last_hidden_state

    # Mean pooling with attention mask
    mask_f = mx.expand_dims(attention_mask, -1).astype(mx.float32)
    embeddings = mx.sum(lhs * mask_f, axis=1) / mx.sum(mask_f, axis=1)
    mx.eval(embeddings)

    result = np.array(embeddings).tolist()

    if json_output:
        click.echo(json.dumps({"model": model, "dimensions": len(result[0]), "embeddings": result}))
    else:
        for i, emb in enumerate(result):
            click.echo(f"[{i}] dim={len(emb)} first_5={emb[:5]}")


@main.command()
@click.option("--model", "-m", default=DEFAULT_GEN_MODEL, help="Generation model ID")
@click.option("--embed-model", default=DEFAULT_EMBED_MODEL, help="Embedding model ID")
@click.option("--host", default="127.0.0.1")
@click.option("--port", "-p", default=8800, type=int)
def serve(model: str, embed_model: str, host: str, port: int):
    """Start unified HTTP server — text generation + embeddings."""
    from mlx_local.server import run_server
    run_server(model=model, embed_model=embed_model, host=host, port=port)


@main.command()
@click.option("--model", "-m", default=DEFAULT_GEN_MODEL, help="Generation model ID")
@click.option("--embed", is_flag=True, help="Also pull embedding model")
def pull(model: str, embed: bool):
    """Pre-download model weights to local cache."""
    from huggingface_hub import snapshot_download

    click.echo(f"Downloading {model}...")
    path = snapshot_download(repo_id=model)
    click.echo(f"Cached: {path}")

    if embed:
        click.echo(f"Downloading {DEFAULT_EMBED_MODEL}...")
        embed_path = snapshot_download(repo_id=DEFAULT_EMBED_MODEL)
        click.echo(f"Cached: {embed_path}")


@main.command()
def info():
    """Show default models and cache info."""
    from huggingface_hub import scan_cache_dir
    click.echo(f"Generation model: {DEFAULT_GEN_MODEL}")
    click.echo(f"Embedding model:  {DEFAULT_EMBED_MODEL}")
    try:
        cache = scan_cache_dir()
        for repo in cache.repos:
            if any(k in repo.repo_id for k in ["Qwen3.5", "bge-m3"]):
                size_gb = repo.size_on_disk / (1024**3)
                click.echo(f"  Cached: {repo.repo_id} ({size_gb:.1f} GB)")
    except Exception:
        click.echo("  Cache: unable to scan")
