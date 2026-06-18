# Changelog

All notable changes to `gemini-vision-mcp-safe` are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.4.1] - 2026-06-19

### Added
- Distinct `图片加载失败:` prefix when an error happens in the local validation
  phase (file not found, blocked URL, unsupported MIME, etc.), separating it
  from `Gemini 调用失败:` errors that come from the Gemini API itself.
- Multi-image errors now include an index marker like `第 2 张: ...` so it is
  obvious which image in a batch caused the failure.
- 503 / `UNAVAILABLE` responses are now translated to a friendly Chinese
  message: *"Gemini 暂时不可用（503）：服务负载过高或模型刚上线限流，请稍后重试或换个模型。"*
- Internal `mapGeminiError()` helper, shared by the single-image and
  multi-image tools.

### Changed
- Both tool handlers refactored: `loadImage` is awaited in its own try/catch,
  separated from the Gemini call.

## [1.4.0] - 2026-06-19

### Added
- New tool `analyze_images_batch` for sending 2–5 images to Gemini in a single
  call (compare screenshots, before/after, multi-page docs).
- Optional `model` parameter on both tools so callers can switch models per
  call without restarting the MCP. Falls back to `GEMINI_VISION_MODEL`.
- Chinese-classified error handling around `generateContent`: timeout, 403,
  429, 400 each get a localized hint; everything else gets a generic Chinese
  prefix instead of leaking an English stack trace.
- HTTPS-to-HTTP redirect downgrade is rejected at the redirect-following step.

### Changed
- All error messages, confirmation prompts, and result headers are now in
  Chinese.
- Remote image bodies stream into a temp file (`os.tmpdir()` +
  `crypto.randomUUID()`) and the temp file is unlinked in `finally`, so peak
  memory stays roughly proportional to one image instead of two-plus copies.

## [1.3.0] - 2026-05-19

### Added
- Privacy redaction for proxy URLs in startup logs.
- Numeric env validation (`parsePositiveNumberEnv`) for image-size and
  timeout settings.
- Configurable Gemini SDK timeout via `GEMINI_VISION_GEMINI_TIMEOUT_MS`.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`,
  `idempotentHint`).

### Changed
- Removed extension allowlist gate — MIME is now decided by sniffing magic
  bytes, regardless of extension casing or absence.

## [1.0.0] - 2026-05-18

Initial release.

- Single tool `analyze_image_with_gemini`.
- Two-step privacy handshake via `confirm_send_to_gemini`.
- SSRF defenses for URL inputs: protocol allowlist, manual redirect handling
  with per-hop hostname validation, private/local IP blocking, configurable
  size cap.
