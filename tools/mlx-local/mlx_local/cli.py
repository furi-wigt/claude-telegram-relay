"""CLI for mlx-local: embeddings on Apple Silicon (serve-embed server)."""

import os
import click
import json

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

DEFAULT_EMBED_MODEL = "mlx-community/bge-m3-mlx-fp16"


@click.group()
def main():
    """MLX Local — embeddings on Apple Silicon."""
    pass


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


@main.command("serve-embed")
@click.option("--model", "-m", default=DEFAULT_EMBED_MODEL, help="Embedding model ID")
@click.option("--host", default="127.0.0.1")
@click.option("--port", "-p", default=8801, type=int)
def serve_embed(model: str, host: str, port: int):
    """Start embedding-only HTTP server on port 8801."""
    from mlx_local.server import run_embed_server
    run_embed_server(embed_model=model, host=host, port=port)


@main.command()
@click.option("--model", "-m", default=DEFAULT_EMBED_MODEL, help="Embedding model ID")
def pull(model: str):
    """Pre-download embedding model weights to local cache."""
    from huggingface_hub import snapshot_download

    click.echo(f"Downloading {model}...")
    path = snapshot_download(repo_id=model)
    click.echo(f"Cached: {path}")


@main.command()
def info():
    """Show embedding model and cache info."""
    from huggingface_hub import scan_cache_dir
    click.echo(f"Embedding model: {DEFAULT_EMBED_MODEL}")
    try:
        cache = scan_cache_dir()
        for repo in cache.repos:
            if "bge-m3" in repo.repo_id:
                size_gb = repo.size_on_disk / (1024**3)
                click.echo(f"  Cached: {repo.repo_id} ({size_gb:.1f} GB)")
    except Exception:
        click.echo("  Cache: unable to scan")
