# Qwen OpenAI Proxy

![License](https://img.shields.io/github/license/palprateek/qwenchat2api)
![Node](https://img.shields.io/badge/node-%3E%3D18-blue)
![OpenAI Compatible](https://img.shields.io/badge/OpenAI-compatible-green)

An OpenAI-compatible proxy server that routes requests from any OpenAI SDK client to Qwen models via `chat.qwen.ai`.

- Drop-in replacement for `api.openai.com`
- Streaming SSE support
- OpenAI tool calling compatibility
- Session persistence
- System prompt merging for Qwen compatibility

---

## Why?

Qwen provides powerful models through `chat.qwen.ai`, but does not expose a fully OpenAI-compatible API.

This proxy allows existing OpenAI SDKs, coding agents, and developer tools to use Qwen models without modification.

---

## Features

- [x] OpenAI-compatible API
- [x] Streaming responses (SSE)
- [x] Tool/function calling
- [x] Conversation persistence
- [x] Automatic system message merging
- [x] Model aliases
- [x] OpenCode support
- [x] LangChain support
- [ ] Vision uploads
- [ ] Docker image
- [ ] Multi-account rotation

---

## Compatible Clients

Works with:

- OpenCode
- Cline
- Continue.dev
- LangChain
- OpenAI SDK
- Roo Code
- OpenWebUI
- LibreChat
- AnythingLLM
- Cursor

Any OpenAI-compatible client should work.

---

## Requirements

- Node.js 18+
- npm or pnpm

---

## Quick Start

```bash
npm install
npm run build
npm start
```

Server runs at:

```txt
http://localhost:5000/v1
```

---

## Authentication

### Option A — Playwright Login (Recommended)

```bash
npm run login
```

This opens a browser window.

1. Log in to `chat.qwen.ai`
2. Press Enter in the terminal
3. Tokens and cookies are extracted automatically

---

### Option B — Manual Extraction

1. Log in to `https://chat.qwen.ai`
2. Open DevTools (`F12`)
3. Go to Console tab
4. Run:

```js
localStorage.getItem("token")
```

5. Copy the token
6. Open Network tab
7. Copy the `Cookie` header from any request
8. Create `.env`:

```env
QWEN_AUTH_TOKEN=your_token_here
QWEN_COOKIE="your_cookie_here"
```

---

## Usage

### curl

```bash
curl http://localhost:5000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"qwen-coder",
    "messages":[
      {
        "role":"user",
        "content":"Write a Python web scraper"
      }
    ]
  }'
```

---

### OpenAI SDK

```ts
import OpenAI from "openai"

const client = new OpenAI({
  baseURL: "http://localhost:5000/v1",
  apiKey: "dummy"
})

const response = await client.chat.completions.create({
  model: "qwen-coder",
  messages: [
    {
      role: "user",
      content: "Hello"
    }
  ]
})

console.log(response.choices[0].message)
```

---

### Sample `opencode.json` config

Add this to your `opencode.json` providers:

```jsonc
"localproxy": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Local Proxy",
  "options": {
    "baseURL": "http://localhost:5000/v1",
    "apiKey": "dummy"
  },
  "models": {
    "qwen3.7-max": {
      "name": "Qwen 3.7 Max"
    },
    "qwen3.6-plus": {
      "name": "Qwen 3.6 Plus"
    }
    // Add any model from /v1/models above
  }
}
```

---

## Tool Calling Example

```json
{
  "model": "qwen-coder",
  "messages": [
    {
      "role": "user",
      "content": "Read config.json"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Read a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string"
            }
          },
          "required": ["path"]
        }
      }
    }
  ]
}
```

---

## Model Aliases

| Alias | Upstream Model | Use Case |
|---|---|---|
| `qwen` | `qwen-max-latest` | General purpose |
| `qwen-max` | `qwen-max-latest` | General purpose |
| `qwen-think` | `qwen3-235b-a22b` | Reasoning |
| `qwen-coder` | `qwen3-coder-plus` | Coding |
| `qwen-flash` | `qwen3-30b-a3b` | Fast responses |
| `qwen-vl` | `qwen3-vl-plus` | Vision |
| `qwq` | `qwq-32b` | Math/reasoning |

Direct upstream model IDs are also supported.

---

## API Endpoints

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint.

### `GET /v1/models`

Lists available models.

```bash
curl http://localhost:5000/v1/models
```

### `DELETE /v1/chats/:chatId`

Deletes stored chat sessions.

### `POST /v1/auth/refresh`

Refreshes Qwen authentication credentials.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `QWEN_AUTH_TOKEN` | — | Qwen bearer token |
| `QWEN_COOKIE` | — | Browser cookie |
| `PORT` | `5000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Logging level |
| `DATA_DIR` | `./data` | Session storage |
| `RATE_LIMIT` | `30` | Requests/min/IP |
| `REQUEST_TIMEOUT` | `120000` | Upstream timeout |

---

## Architecture

```txt
Client (OpenAI SDK / OpenCode / LangChain)
                ↓
        Qwen OpenAI Proxy
                ↓
          chat.qwen.ai
                ↓
           Qwen Models
```

```txt
src/
├── index.ts
├── auth/
├── client/
├── proxy/
├── streaming/
├── tools/
├── session/
└── utils/
```

---

## Qwen Compatibility

Qwen enforces a strict constraint:

- Maximum one system message
- System message must be first

The proxy automatically:
- merges multiple system prompts
- preserves tool messages
- preserves assistant messages
- fixes compatibility with OpenCode and similar agents

---

## Docker

```bash
# Build
docker build -t qwenchat2api .

# Run
docker run -d \
  -p 5000:5000 \
  -e QWEN_AUTH_TOKEN=your_token \
  -e QWEN_COOKIE="your_cookie" \
  -v qwenchat2api-data:/app/data \
  --name qwenchat2api \
  qwenchat2api
```

## Caveats

- `chat.qwen.ai` is not an official public API
- This project reverse-engineers the web interface
- Tokens expire periodically
- Rate limits are undocumented and account-dependent
- Some upstream model names may change

---

## Roadmap

- Vision/image uploads
- Docker image
- WebSocket support
- Multi-account routing
- Better retry handling
- OAuth authentication flow

---

## Disclaimer

This project is unofficial and is not affiliated with Alibaba or Qwen.

Use responsibly and at your own risk.

---

## License

MIT
