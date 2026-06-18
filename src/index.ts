#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import dnsPromises from "node:dns/promises";
import { GoogleGenAI } from "@google/genai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";

const SERVER_NAME = "gemini-vision-mcp-safe";
const SERVER_VERSION = "1.4.1";
const MAX_REDIRECTS = 5;

function redactProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return "(invalid URL)";
  }
}

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.error(`[${SERVER_NAME}] Using proxy: ${redactProxyUrl(PROXY_URL)}`);
}

function parsePositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[${SERVER_NAME}] Invalid ${name}="${raw}", using default ${fallback}`
    );
    return fallback;
  }
  return n;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
const MAX_IMAGE_MB = parsePositiveNumberEnv("GEMINI_VISION_MAX_IMAGE_MB", 10);
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
const REQUEST_TIMEOUT_MS = parsePositiveNumberEnv("GEMINI_VISION_REQUEST_TIMEOUT_MS", 20000);
const GEMINI_TIMEOUT_MS = parsePositiveNumberEnv("GEMINI_VISION_GEMINI_TIMEOUT_MS", 60000);
const ALLOW_URL = (process.env.GEMINI_VISION_ALLOW_URL || "true").toLowerCase() !== "false";
const ALLOW_LOCAL_FILE = (process.env.GEMINI_VISION_ALLOW_LOCAL_FILE || "true").toLowerCase() !== "false";
const BLOCK_LOCAL_URLS = (process.env.GEMINI_VISION_BLOCK_LOCAL_URLS || "true").toLowerCase() !== "false";

if (!GEMINI_API_KEY) {
  console.error(`[${SERVER_NAME}] Missing GEMINI_API_KEY environment variable.`);
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { timeout: GEMINI_TIMEOUT_MS } });
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

function mapGeminiError(e: unknown): string {
  const err = e as Error & { status?: number; code?: string };
  if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
    return `Gemini 请求超时，请检查代理是否正常运行。(${GEMINI_TIMEOUT_MS}ms)`;
  } else if (err.status === 403 || err.message?.includes("403")) {
    return "Gemini 拒绝访问（403），可能是地区限制或 API key 无效，请确认代理已开启。";
  } else if (err.status === 429 || err.message?.includes("429")) {
    return "Gemini 请求过于频繁（429），请稍后重试。";
  } else if (err.status === 503 || err.message?.includes("503") || err.message?.includes("UNAVAILABLE")) {
    return "Gemini 暂时不可用（503）：服务负载过高或模型刚上线限流，请稍后重试或换个模型。";
  } else if (err.status === 400 || err.message?.includes("400")) {
    return `Gemini 请求参数错误（400）: ${err.message}`;
  } else {
    return `Gemini 调用失败: ${err.message || String(e)}`;
  }
}

type LoadedImage = {
  source: string;
  sourceType: "local_file" | "url";
  mimeType: string;
  base64: string;
  sizeBytes: number;
};

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff"
};

function getMimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const m = MIME_BY_EXT[ext];
  if (!m) {
    throw new Error(
      `不支持的图片格式: ${ext || "(无扩展名)"}。支持: png, jpg, jpeg, webp, gif, bmp, tiff`
    );
  }
  return m;
}

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) return "image/tiff";
  if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) return "image/tiff";
  return null;
}

function cleanInputSource(input: string): string {
  return input.trim().replace(/^["']|["']$/g, "");
}

function isHttpUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateOrLocalIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped) return isPrivateOrLocalIp(v4mapped[1]);
  return false;
}

async function assertSafeHostname(hostname: string): Promise<void> {
  if (!BLOCK_LOCAL_URLS) return;

  const h = hostname.replace(/^\[|\]$/g, "");
  const lh = h.toLowerCase();
  if (lh === "localhost" || lh.endsWith(".localhost")) {
    throw new Error(
      `已拦截本地主机名: ${hostname}。设置 GEMINI_VISION_BLOCK_LOCAL_URLS=false 可覆盖。`
    );
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsPromises.lookup(h, { all: true });
  } catch (e) {
    throw new Error(`DNS 解析失败 (${hostname}): ${(e as Error).message}`);
  }

  if (addresses.length === 0) {
    throw new Error(`无法解析主机名: ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateOrLocalIp(address)) {
      throw new Error(
        `已拦截: ${hostname} 解析到内网/本地 IP ${address}。` +
          `设置 GEMINI_VISION_BLOCK_LOCAL_URLS=false 可覆盖。`
      );
    }
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("响应体为空。");
  const tmpFile = path.join(os.tmpdir(), `gemini-vision-${crypto.randomUUID()}.tmp`);
  const reader = response.body.getReader();
  let total = 0;
  try {
    const fd = fs.openSync(tmpFile, "w");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            throw new Error(`远程图片太大，已超过限制。最大允许: ${MAX_IMAGE_MB}MB`);
          }
          fs.writeSync(fd, value);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return fs.readFileSync(tmpFile);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function fetchImageWithRedirects(
  url: string
): Promise<{ buffer: Buffer; mimeType: string; finalUrl: string }> {
  let currentUrl = url;
  const initialProtocol = new URL(url).protocol;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`只允许 http/https 协议（收到: ${parsed.protocol}）`);
    }

    if (initialProtocol === "https:" && parsed.protocol === "http:") {
      throw new Error(
        `安全拦截：原始请求是 HTTPS，但重定向目标降级为 HTTP（${currentUrl}），已阻止。`
      );
    }

    await assertSafeHostname(parsed.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
          Accept: "image/*"
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`重定向 ${response.status} 但没有 Location 头`);
        }
        if (hop === MAX_REDIRECTS) {
          throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`获取图片失败: HTTP ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const size = Number(contentLength);
        if (!Number.isNaN(size) && size > MAX_IMAGE_BYTES) {
          throw new Error(
            `远程图片太大: ${(size / 1024 / 1024).toFixed(2)}MB。最大允许: ${MAX_IMAGE_MB}MB`
          );
        }
      }

      const buffer = await readBodyWithLimit(response, MAX_IMAGE_BYTES);
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) {
        throw new Error(
          "下载的内容不是可识别的图片格式（支持 PNG/JPEG/WEBP/GIF/BMP/TIFF）。"
        );
      }

      return { buffer, mimeType: sniffed, finalUrl: currentUrl };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("不可达：重定向循环异常退出");
}

async function loadImageFromUrl(url: string): Promise<LoadedImage> {
  if (!ALLOW_URL) {
    throw new Error("URL 图片输入已禁用（GEMINI_VISION_ALLOW_URL=false）。");
  }
  const { buffer, mimeType, finalUrl } = await fetchImageWithRedirects(url);
  return {
    source: finalUrl,
    sourceType: "url",
    mimeType,
    base64: buffer.toString("base64"),
    sizeBytes: buffer.byteLength
  };
}

function loadImageFromLocalFile(inputPath: string): LoadedImage {
  if (!ALLOW_LOCAL_FILE) {
    throw new Error("本地文件图片输入已禁用（GEMINI_VISION_ALLOW_LOCAL_FILE=false）。");
  }
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`图片文件不存在: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`路径不是文件: ${resolved}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片太大: ${(stat.size / 1024 / 1024).toFixed(2)}MB。最大允许: ${MAX_IMAGE_MB}MB`
    );
  }
  const buffer = fs.readFileSync(resolved);
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw new Error(
      `文件内容不是支持的图片格式（扩展名: ${path.extname(resolved)}）`
    );
  }
  return {
    source: resolved,
    sourceType: "local_file",
    mimeType: sniffed,
    base64: buffer.toString("base64"),
    sizeBytes: buffer.byteLength
  };
}

async function loadImage(imageSource: string): Promise<LoadedImage> {
  const cleaned = cleanInputSource(imageSource);
  if (isHttpUrl(cleaned)) {
    return await loadImageFromUrl(cleaned);
  }
  return loadImageFromLocalFile(cleaned);
}

server.registerTool(
  "analyze_image_with_gemini",
  {
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false
    },
    description: [
      "Analyze a local image file or image URL using Google Gemini Vision.",
      "",
      "PRIVACY RULES:",
      "1. Use this tool ONLY when the current main model cannot natively understand images.",
      "2. If the current main model has native vision capability, do NOT use this tool unless the user explicitly asks to use Gemini.",
      "3. Before calling this tool with confirm_send_to_gemini=true, you MUST ask the user for consent.",
      "4. The image bytes and prompt will be sent to Google Gemini API.",
      "5. If image_source is a URL, this MCP downloads the image from your machine first, then sends bytes to Gemini.",
      "6. If the user has not explicitly agreed, omit confirm_send_to_gemini or set it to false to show a confirmation notice only.",
      "",
      "Supported inputs:",
      "- Local file path, e.g. C:/Users/me/Desktop/image.png",
      "- HTTP/HTTPS image URL, e.g. https://example.com/image.png"
    ].join("\n"),
    inputSchema: {
      image_source: z
        .string()
        .describe(
          "Local image path or HTTP/HTTPS image URL. Examples: C:/Users/me/Desktop/a.png or https://example.com/a.png"
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "What to analyze. Example: 'Extract all visible text and summarize the screenshot.'"
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Override the Gemini model for this call. Examples: gemini-2.5-flash, gemini-2.5-pro. Defaults to env GEMINI_VISION_MODEL."
        ),
      confirm_send_to_gemini: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Must be true only after the user explicitly agrees to send this image to Gemini. Defaults to false."
        )
    }
  },
  async ({ image_source, prompt, model, confirm_send_to_gemini }) => {
    const cleaned = cleanInputSource(image_source);

    if (!confirm_send_to_gemini) {
      const sourceType = isHttpUrl(cleaned) ? "URL" : "本地文件";
      return {
        content: [
          {
            type: "text",
            text: [
              "需要你的确认：",
              "",
              "这个工具会把图片发送到 Google Gemini API 进行视觉分析。",
              "",
              `图片来源类型：${sourceType}`,
              `图片来源：${cleaned}`,
              "",
              "如果你同意，请回复类似：",
              "",
              "同意发送这张图片到 Gemini 分析。",
              "",
              "然后我会再次调用工具，并设置 confirm_send_to_gemini=true。",
              "",
              "注意：",
              "- 如果图片包含隐私、密钥、账号、公司内部数据，请先打码或不要发送。",
              "- 如果图片是 URL，本 MCP 会先从你的电脑访问该 URL，图床可能看到你的访问 IP。"
            ].join("\n")
          }
        ]
      };
    }

    const useModel = model || GEMINI_VISION_MODEL;

    let loaded: LoadedImage;
    try {
      loaded = await loadImage(cleaned);
    } catch (e: unknown) {
      const err = e as Error;
      return {
        content: [{ type: "text", text: `图片加载失败: ${err.message || String(e)}` }],
        isError: true
      };
    }

    const finalPrompt =
      prompt || "请详细描述这张图片的内容。如果图片中有文字，请尽可能完整地提取出来。";

    try {
      const response = await ai.models.generateContent({
        model: useModel,
        contents: [
          { inlineData: { mimeType: loaded.mimeType, data: loaded.base64 } },
          { text: finalPrompt }
        ]
      });

      const text =
        response.text ||
        "Gemini 返回了空响应。请尝试更清晰的图片或更具体的提示词。";

      return {
        content: [
          {
            type: "text",
            text: [
              "Gemini 视觉分析完成。",
              `模型: ${useModel}`,
              `来源类型: ${loaded.sourceType}`,
              `来源: ${loaded.source}`,
              `MIME: ${loaded.mimeType}`,
              `大小: ${(loaded.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
              "",
              "结果:",
              text
            ].join("\n")
          }
        ]
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text", text: mapGeminiError(e) }],
        isError: true
      };
    }
  }
);

server.registerTool(
  "analyze_images_batch",
  {
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false
    },
    description: [
      "Batch analyze multiple images (2-5) using Google Gemini Vision.",
      "",
      "Same privacy rules as analyze_image_with_gemini apply.",
      "Useful for comparing screenshots, before/after views, or multi-page documents.",
      "",
      "Supported inputs: local file paths or HTTP/HTTPS image URLs (can mix)."
    ].join("\n"),
    inputSchema: {
      image_sources: z
        .array(z.string())
        .min(2)
        .max(5)
        .describe(
          "Array of 2-5 image sources (local paths or URLs). Example: ['C:/a.png', 'https://example.com/b.png']"
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "What to analyze across all images. Example: 'Compare these two screenshots and list differences.'"
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Override the Gemini model. Defaults to env GEMINI_VISION_MODEL."
        ),
      confirm_send_to_gemini: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Must be true only after the user explicitly agrees. Defaults to false."
        )
    }
  },
  async ({ image_sources, prompt, model, confirm_send_to_gemini }) => {
    if (!confirm_send_to_gemini) {
      const summary = image_sources
        .map((s: string) => {
          const c = cleanInputSource(s);
          return `  - [${isHttpUrl(c) ? "URL" : "本地文件"}] ${c}`;
        })
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: [
              "需要你的确认：",
              "",
              `这个工具会把 ${image_sources.length} 张图片发送到 Google Gemini API 进行视觉分析。`,
              "",
              "图片列表：",
              summary,
              "",
              "如果你同意，请回复确认，然后我会设置 confirm_send_to_gemini=true 再次调用。",
              "",
              "注意：",
              "- 如果图片包含隐私、密钥、账号、公司内部数据，请先打码或不要发送。",
              "- URL 图片会先从你的电脑下载。"
            ].join("\n")
          }
        ]
      };
    }

    const useModel = model || GEMINI_VISION_MODEL;

    let loadedImages: LoadedImage[];
    try {
      loadedImages = await Promise.all(
        image_sources.map(async (s: string, i: number) => {
          try {
            return await loadImage(s);
          } catch (e) {
            const m = (e as Error).message || String(e);
            throw new Error(`第 ${i + 1} 张: ${m}`);
          }
        })
      );
    } catch (e: unknown) {
      const err = e as Error;
      return {
        content: [{ type: "text", text: `图片加载失败: ${err.message || String(e)}` }],
        isError: true
      };
    }

    const finalPrompt =
      prompt || "请详细描述并对比这些图片的内容。";

    const contents: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    for (const img of loadedImages) {
      contents.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    contents.push({ text: finalPrompt });

    try {
      const response = await ai.models.generateContent({
        model: useModel,
        contents
      });

      const text =
        response.text ||
        "Gemini 返回了空响应。请尝试更清晰的图片或更具体的提示词。";

      const meta = loadedImages
        .map(
          (img, i) =>
            `  图片${i + 1}: [${img.sourceType}] ${img.source} (${img.mimeType}, ${(img.sizeBytes / 1024 / 1024).toFixed(2)}MB)`
        )
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: [
              "Gemini 多图视觉分析完成。",
              `模型: ${useModel}`,
              `图片数量: ${loadedImages.length}`,
              meta,
              "",
              "结果:",
              text
            ].join("\n")
          }
        ]
      };
    } catch (e: unknown) {
      return {
        content: [{ type: "text", text: mapGeminiError(e) }],
        isError: true
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
