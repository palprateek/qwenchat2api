# Qwen OpenAI Proxy

An OpenAI-compatible proxy server that routes requests from any OpenAI SDK client to Qwen models via [chat.qwen.ai](https://chat.qwen.ai).

- **Drop-in replacement** for `api.openai.com` — works with OpenCode, LangChain, any OpenAI-compatible tool
- **Streaming SSE** — real‑time token streams in OpenAI chunk format
- **Tool calling** — translates Qwen's XML‑style tool calls to OpenAI `tool_calls`
- **Conversation persistence** — reuses Qwen chat sessions; no `X‑Conversation‑Id` header required (auto‑assigned per client IP)
- **System message merging** — multiple system prompts are merged into one (Qwen constraint: ≤1 system message, must be at index 0)

## Quick Start

```bash
npm install
npm run build
npm start          # → http://localhost:5000/v1/chat/completions
```

### Authentication

**Option A: Playwright Login (Recommended)**

```bash
npm run login
```

Opens a browser. Log in to chat.qwen.ai, then press Enter in the terminal to extract tokens.

**Option B: Manual Token Extraction**

1. Log in to [chat.qwen.ai](https://chat.qwen.ai)
2. Open browser DevTools (F12)
3. Go to Console tab
4. Run: `localStorage.getItem("token")`
5. Copy the token value
6. Go to Network tab, find any request to chat.qwen.ai
7. Copy the `Cookie` header value
8. Create a `.env` file:

```env
QWEN_AUTH_TOKEN=your_token_here
QWEN_COOKIE="your_cookie_string_here"
```

### Model Aliases

| Name | Maps to | Use case |
|------|---------|----------|
| `qwen`, `qwen-max` | `qwen-max-latest` | General purpose |
| `qwen-think` | `qwen3-235b-a22b` | Deep reasoning |
| `qwen-coder` | `qwen3-coder-plus` | Code generation |
| `qwen-flash` | `qwen3-30b-a3b` | Fast responses |
| `qwen-vl` | `qwen3-vl-plus` | Vision |
| `qwq` | `qwq-32b` | Math/reasoning |

Upstream model IDs (e.g. `qwen3-235b-a22b`) are passed through directly.

## API

### `POST /v1/chat/completions`

Accepts the standard [OpenAI chat completion format](https://platform.openai.com/docs/api-reference/chat).

```json
{
  "model": "qwen-coder",
  "messages": [
    { "role": "user", "content": "Write a Python web scraper" }
  ],
  "stream": true
}
```

With tools:

```json
{
  "model": "qwen-coder",
  "messages": [{ "role": "user", "content": "Read config.json" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Read a file",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
    }
  }]
}
```

### `GET /v1/models`

Lists available Qwen models. Response follows OpenAI format:

```json
{
  "object": "list",
  "data": [
    { "id": "qwen-max-latest", "object": "model", "owned_by": "qwen" },
    { "id": "qwen3-coder-plus", "object": "model", "owned_by": "qwen" }
  ]
}
```

### `DELETE /v1/chats/:chatId`

Removes a Qwen chat session from the server and upstream.

### `POST /v1/auth/refresh`

Refreshes authentication credentials.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_AUTH_TOKEN` | — | Bearer token from chat.qwen.ai |
| `QWEN_COOKIE` | — | Cookie string for Cloudflare bypass |
| `PORT` | `5000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DATA_DIR` | `./data` | Session persistence directory |
| `RATE_LIMIT` | `30` | Requests/minute/IP |
| `REQUEST_TIMEOUT` | `120000` | Upstream timeout (ms) |

## Architecture

```
Client (OpenCode, curl, etc.)
     ↓  OpenAI-format JSON
Qwen OpenAI Proxy
     ↓  Qwen API payloads
chat.qwen.ai
     ↓
Qwen models
```

```
src/
├── index.ts               # Server entry point
├── auth/auth-manager.ts   # Token & cookie lifecycle
├── client/
│   ├── qwen-client.ts     # Upstream API client
│   └── models.ts          # Model resolution & aliases
├── proxy/
│   ├── router.ts          # Express routes
│   └── openai-compat.ts   # OpenAI ↔ Qwen translation
├── streaming/
│   └── stream-adapter.ts  # SSE parsing
├── tools/
│   └── tool-translator.ts # Tool call format conversion
├── session/
│   └── session-manager.ts # Chat session persistence
└── utils/
    ├── logger.ts
    ├── error-handler.ts
    └── rate-limiter.ts
```

## Caveats

- chat.qwen.ai is not an official public API — this proxy reverse‑engineers the web interface
- Tokens expire periodically; re‑run `npm run login` or refresh via the `/v1/auth/refresh` endpoint
- Qwen enforces ≤1 system message, first position — the proxy merges multiple system prompts automatically
- Rate limits are per‑account and unadvertised; adjust `RATE_LIMIT` in `.env` if you hit 429s

## License

MIT
