# gemini-vision-mcp-safe

[English](./README.md)｜简体中文

一个体积小、注重隐私的 [MCP](https://modelcontextprotocol.io/) 服务端，让 MCP
客户端（Claude Code、Claude Desktop 等）能调用 **Google Gemini** 看图——本地
文件或 URL 都行——并返回描述、文字提取、对比分析等结果。

名字里的 "safe" 是个明确的设计目标：

- **双步握手**：图片在离开你的电脑前必须先经过一次确认。第一次调用只返回中文
  确认提示，只有第二次（带 `confirm_send_to_gemini=true`）才会真的把数据发给
  Gemini。这样可以避免某个 AI 模型悄悄把你的图片上传给 Google。
- **SSRF 防护**（针对 URL 输入）：协议白名单、手动跟随重定向、每跳都重新做
  DNS 解析并校验是否落在内网/回环段、HTTPS→HTTP 降级直接拒绝。
- **靠 magic byte 识别图片**，不信任扩展名或 `Content-Type`。
- **大小限制双保险**：先看 `Content-Length`，再用流式读取硬卡。远程图片以
  流的方式落入临时文件，并在 `finally` 里删掉，不会在内存里堆几份。
- **代理友好**：识别 `HTTPS_PROXY` / `HTTP_PROXY`。在 Google API 不能直连的
  地区（比如中国大陆通过 clash/mihomo）特别有用。代理 URL 在日志里会被打码。
- **API key 放 `.env`，不放 MCP 配置里**。仓库的 `.gitignore` 排除了 `.env`，
  保证 key 永远不会进 git。

返回的结果文本和错误提示都是中文。

## 工具

### `analyze_image_with_gemini`

把一张本地图或一个 HTTP/HTTPS 图片 URL 发给 Gemini。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `image_source` | 是 | 本地路径（`C:/path/to.png`）或 URL（`https://…`）。 |
| `prompt` | 否 | 给 Gemini 的提问。默认是中文「请详细描述这张图片」。 |
| `model` | 否 | 单次调用覆盖模型（如 `gemini-2.5-flash`）。不传则用 `GEMINI_VISION_MODEL`。 |
| `confirm_send_to_gemini` | 否 | 必须 `true` 才会真的发送。默认 `false`。 |

### `analyze_images_batch`

一次给 Gemini 发 2–5 张图（适合「对比这两张截图」「多页文档」这种场景）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `image_sources` | 是 | 2–5 个路径或 URL 组成的数组。可以混用。 |
| `prompt` | 否 | 给 Gemini 的提问。 |
| `model` | 否 | 同上。 |
| `confirm_send_to_gemini` | 否 | 同样要走握手。 |

如果某一张图加载失败，错误提示会精确到「第 N 张：」。

## 安装

```bash
git clone https://github.com/nianshou555qiansui/gemini-vision-mcp-safe.git
cd gemini-vision-mcp-safe
npm install
npm run build
cp .env.example .env       # 然后编辑 .env，把你的 Gemini API key 填进去
```

API key 在这里申请：<https://aistudio.google.com/apikey>

## 接入 MCP 客户端

### Claude Code

`~/.claude.json`（或 Claude Desktop 的 `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "gemini-vision-safe": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--env-file=/绝对路径/到/gemini-vision-mcp-safe/.env",
        "/绝对路径/到/gemini-vision-mcp-safe/dist/index.js"
      ],
      "env": {
        "HTTPS_PROXY": "http://127.0.0.1:7890",
        "HTTP_PROXY": "http://127.0.0.1:7890"
      }
    }
  }
}
```

`--env-file` 需要 Node ≥ 20.6。MCP 配置里的 `env` 块只放非敏感设置（比如代理
地址）；API key 放在 `.env` 里，这样不会进版本控制，也不会被共享配置带出去。

Windows 上如果启动器需要走 shell，把 `node …` 换成 `cmd /c node …`。

## 配置项

`.env` 里的可配置项（参考 `.env.example`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `GEMINI_API_KEY` | （必填） | Google AI Studio 申请的 API key。 |
| `GEMINI_VISION_MODEL` | `gemini-2.5-flash` | 默认模型。单次调用传 `model` 参数会覆盖这个值。 |
| `GEMINI_VISION_MAX_IMAGE_MB` | `10` | 硬上限。远程图片在 `Content-Length` 超过时直接拒绝下载；流式读取时也会兜底。 |
| `GEMINI_VISION_REQUEST_TIMEOUT_MS` | `20000` | 单跳 URL 拉取的超时。 |
| `GEMINI_VISION_GEMINI_TIMEOUT_MS` | `60000` | Gemini SDK 调用的超时。 |
| `GEMINI_VISION_ALLOW_URL` | `true` | 设为 `false` 可以彻底禁用 URL 输入。 |
| `GEMINI_VISION_ALLOW_LOCAL_FILE` | `true` | 设为 `false` 可以彻底禁用本地文件输入。 |
| `GEMINI_VISION_BLOCK_LOCAL_URLS` | `true` | 设为 `false` 会关闭 SSRF/内网 IP 拦截（不推荐）。 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 不设 | `fetch` 和 Gemini SDK 都会通过 undici 全局 dispatcher 走这个代理。 |

## 隐私说明

- 本地路径：内容不出本机，只有你确认过的图片字节才会被发给 Gemini。
- URL：**先由你的电脑把图片下载下来，再转发给 Gemini**——原图床看到的是
  你（或你代理）的 IP，而不是 Google；反过来 Google 也看不到原图床。
- 仓库里永远不会有 API key。提交前可以这样确认：
  `git ls-files | grep -F .env` 不应该有任何输出。

## 已知边界

- DNS rebinding / TOCTOU **没有**专门防护：SSRF 检查走系统解析器，但底层 TCP
  连接时会再解析一次。本地自用没问题；**不要把这个 MCP 暴露成公网服务**。
- 系统解析器**不走** `HTTPS_PROXY`。如果你的本地 DNS 不靠谱，建议自己解析过
  的域名，或者把 DNS 上游切到一个可信源。
- Gemini 在某些地区可能不可用，是 Google 那边的策略。错误映射会在遇到
  403 / 429 / 503 时给出对应的中文提示。

## 协议

MIT — 见 [`LICENSE`](./LICENSE)。
