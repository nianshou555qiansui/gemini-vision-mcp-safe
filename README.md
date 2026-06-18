# gemini-vision-mcp-safe

English｜[简体中文](./README.zh-CN.md)

A minimal, privacy-conscious [MCP](https://modelcontextprotocol.io/) server
that lets an MCP client (Claude Code, Claude Desktop, etc.) ask **Google
Gemini** to look at an image — local file or URL — and return a description,
text extraction, comparison, and so on.

The "safe" in the name is a design goal:

- **Two-step handshake** before any image leaves the machine. The first call
  returns a Chinese confirmation prompt; the second call (with
  `confirm_send_to_gemini=true`) is the only one that actually talks to
  Gemini. This stops a model from silently uploading user files to Google.
- **SSRF defenses** for URL inputs: protocol allowlist, manual redirect
  handling, per-hop DNS check against private/loopback ranges, HTTPS→HTTP
  downgrade refused.
- **Magic-byte sniffing** instead of trusting file extensions or
  `Content-Type`.
- **Configurable size cap** with both `Content-Length` pre-check and a hard
  streaming limit; remote bodies stream to a temp file that is removed in
  `finally`.
- **Proxy aware** via `HTTPS_PROXY` / `HTTP_PROXY`. Useful where Google APIs
  are not directly reachable (e.g. mainland China through clash/mihomo). The
  proxy URL is redacted in logs.
- **API key in `.env`, not in the MCP config**. The repo's `.gitignore`
  excludes `.env` so the key never ends up in git.

Result text and error messages are in Chinese.

## Tools

### `analyze_image_with_gemini`

Send one local image or one HTTP/HTTPS image URL to Gemini.

| Parameter | Required | Description |
| --- | --- | --- |
| `image_source` | yes | Local path (`C:/path/to.png`) or URL (`https://…`). |
| `prompt` | no | What to ask Gemini. Defaults to a Chinese "describe this image" prompt. |
| `model` | no | Override the model for this call (e.g. `gemini-2.5-flash`). Falls back to `GEMINI_VISION_MODEL`. |
| `confirm_send_to_gemini` | no | Must be `true` to actually send. Defaults to `false`. |

### `analyze_images_batch`

Send 2–5 images in a single Gemini call (good for "compare these
screenshots" or multi-page documents).

| Parameter | Required | Description |
| --- | --- | --- |
| `image_sources` | yes | Array of 2–5 paths or URLs. Mixed is fine. |
| `prompt` | no | What to ask Gemini across all images. |
| `model` | no | Same as above. |
| `confirm_send_to_gemini` | no | Same handshake. |

If one image fails to load, the error message tells you which one
(`第 N 张: …`).

## Install

```bash
git clone https://github.com/nianshou555qiansui/gemini-vision-mcp-safe.git
cd gemini-vision-mcp-safe
npm install
npm run build
cp .env.example .env       # then edit .env, paste your Gemini API key
```

Get a key at <https://aistudio.google.com/apikey>.

## Wire it up

### Claude Code

`~/.claude.json` (or `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "gemini-vision-safe": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/gemini-vision-mcp-safe/.env",
        "/absolute/path/to/gemini-vision-mcp-safe/dist/index.js"
      ],
      "env": {
        "HTTPS_PROXY": "http://127.0.0.1:7890",
        "HTTP_PROXY": "http://127.0.0.1:7890"
      }
    }
  }
}
```

`--env-file` requires Node ≥ 20.6. The `env` block in MCP config is for
non-secret settings (proxy address); the API key lives in `.env` so it
never ends up in version control or shared configs.

On Windows where the launcher needs a shell, use `cmd /c node …` instead of
`node …`.

## Configuration

`.env` keys (see `.env.example`):

| Key | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | (required) | Your key from Google AI Studio. |
| `GEMINI_VISION_MODEL` | `gemini-2.5-flash` | Default model. Per-call `model` arg overrides this. |
| `GEMINI_VISION_MAX_IMAGE_MB` | `10` | Hard cap. Remote images that exceed this via `Content-Length` are rejected before download; the streaming reader also enforces it. |
| `GEMINI_VISION_REQUEST_TIMEOUT_MS` | `20000` | Per-hop URL fetch timeout. |
| `GEMINI_VISION_GEMINI_TIMEOUT_MS` | `60000` | SDK-level timeout for the Gemini call. |
| `GEMINI_VISION_ALLOW_URL` | `true` | Set `false` to refuse URL inputs entirely. |
| `GEMINI_VISION_ALLOW_LOCAL_FILE` | `true` | Set `false` to refuse local file inputs. |
| `GEMINI_VISION_BLOCK_LOCAL_URLS` | `true` | Set `false` to disable SSRF/private-IP blocking (not recommended). |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset | Used by both `fetch` and the Gemini SDK via undici's global dispatcher. |

## Privacy notes

- A local file path stays local; only the bytes of the file you confirm
  travel to Gemini.
- A URL is fetched **from your machine first**, then forwarded to Gemini —
  the original host sees your IP (or your proxy's), but never sees Google.
  Conversely Google never sees the original host.
- The repo never contains an API key. Verify before committing:
  `git ls-files | grep -F .env` should print nothing.

## Caveats

- DNS rebinding / TOCTOU is **not** mitigated: the SSRF check uses the OS
  resolver, but the actual TCP connect resolves again. Acceptable for local
  use; not safe to expose this MCP as a public service.
- The OS resolver does not go through `HTTPS_PROXY`. If your local DNS is
  unreliable, prefer URLs whose hostnames you've already pre-resolved or run
  a trusted DNS upstream.
- Per-region Gemini availability is Google's decision. The error mapper will
  tell you when it sees 403 / 429 / 503.

## License

MIT — see [`LICENSE`](./LICENSE).
