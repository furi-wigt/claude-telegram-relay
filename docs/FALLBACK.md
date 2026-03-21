# Fallback AI Configuration

When Claude API is down or rate-limited, your bot can automatically fall back to a local AI model running on Ollama.

## How It Works

1. Bot tries to call Claude first (as normal)
2. If Claude fails (API down, rate limit, network error), bot automatically tries the fallback
3. Response is prefixed with `[via fallback-model]` so you know it came from the backup
4. If both fail, you get an error message

This ensures your bot stays responsive even when Claude is unavailable.

## Setup

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows
# Download from https://ollama.com/download
```

### 2. Start Ollama Server

```bash
ollama serve
```

Leave this running in a terminal, or set it up as a background service.

### 3. Configure Fallback Model

Add to your `.env`:

```bash
FALLBACK_MODEL=gemma3-4b
```

**Recommended models:**

- `gemma3-4b` — 4B parameters, fast, good quality (recommended)
- `llama3.2:1b` — 1B parameters, very fast, lower quality
- `mistral` — 7B parameters, slower, higher quality

### 4. Test Configuration

```bash
bun run test:fallback
```

This will:
- Check if Ollama is running
- Pull the model if not already downloaded (one-time, ~2-4GB)
- Test inference with a simple prompt
- Confirm everything works

## Usage

No code changes needed! Just set `FALLBACK_MODEL` in `.env` and restart your bot.

When Claude fails, you'll see:

```
User: What's the weather like?
Bot: [via gemma3-4b]

I don't have access to real-time weather data...
```

## Advanced Configuration

### Custom Ollama Endpoint

If running Ollama on a different machine or port:

```bash
OLLAMA_API_URL=http://192.168.1.100:11434
```

### Disable Fallback

Remove or comment out `FALLBACK_MODEL` in `.env`:

```bash
# FALLBACK_MODEL=gemma3-4b
```

### Run Ollama as a Service

**macOS (launchd):**

```bash
# Create service file
cat > ~/Library/LaunchAgents/com.ollama.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ollama</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ollama</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF

# Load and start
launchctl load ~/Library/LaunchAgents/com.ollama.plist
```

**Linux (systemd):**

```bash
sudo systemctl enable ollama
sudo systemctl start ollama
```

## Limitations

- **No session continuity**: Fallback models don't support Claude's `--resume` sessions
- **No image support**: Fallback handles text only (photos/documents will fail gracefully)
- **Lower quality**: Smaller models produce less sophisticated responses than Claude
- **No memory integration**: Fallback doesn't use Supabase memory system

This is intentional — fallback is for availability, not feature parity.

## Troubleshooting

### "Ollama is not running"

```bash
ollama serve
```

Or check if already running:

```bash
curl http://localhost:11434/api/tags
```

### "Model not found"

Pull it manually:

```bash
ollama pull gemma3-4b
```

### "Both Claude and fallback failed"

Check:
1. Internet connection (for Claude)
2. Ollama service is running: `curl http://localhost:11434/api/tags`
3. Model is pulled: `ollama list`

## Cost Comparison

| Model | Size | Speed | Quality | Cost |
|-------|------|-------|---------|------|
| Claude Sonnet | Cloud API | Fast | Excellent | ~$3/million tokens |
| Claude Haiku | Cloud API | Very Fast | Good | ~$0.25/million tokens |
| gemma3-4b | 4GB local | Fast | Good | **FREE** (runs locally) |
| llama3.2:1b | 1GB local | Very Fast | Fair | **FREE** (runs locally) |

Fallback lets you run indefinitely without API costs when Claude is down.

## When Fallback Activates

- Claude API is down (500, 503 errors)
- Rate limit exceeded (429 errors)
- Network timeout
- `claude` CLI not found or fails to execute
- Any other spawn/execution error

Fallback does NOT activate for:
- Valid Claude responses (even errors like "I can't do that")
- User permission denials (those are intentional blocks)
- Image processing (fallback can't handle images)

## Next Steps

Once configured:
1. Test with `bun run test:fallback`
2. Restart your bot: `bun run start`
3. Simulate Claude failure by setting wrong path: `CLAUDE_PATH=/nonexistent`
4. Verify fallback activates in logs

Your bot now has resilience against Claude API outages.
