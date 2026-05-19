#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import dnsPromises from "node:dns/promises";
import { GoogleGenAI } from "@google/genai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { z } from "zod";

const SERVER_NAME = "gemini-vision-mcp-safe";
const SERVER_VERSION = "1.2.0";
const MAX_REDIRECTS = 5;

const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;
if (PROXY_URL) {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.error(`[${SERVER_NAME}] Using proxy: ${PROXY_URL}`);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
const MAX_IMAGE_MB = Number(process.env.GEMINI_VISION_MAX_IMAGE_MB || "10");
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_VISION_REQUEST_TIMEOUT_MS || "20000");
const ALLOW_URL = (process.env.GEMINI_VISION_ALLOW_URL || "true").toLowerCase() !== "false";
const ALLOW_LOCAL_FILE = (process.env.GEMINI_VISION_ALLOW_LOCAL_FILE || "true").toLowerCase() !== "false";
const BLOCK_LOCAL_URLS = (process.env.GEMINI_VISION_BLOCK_LOCAL_URLS || "true").toLowerCase() !== "false";

if (!GEMINI_API_KEY) {
  console.error(`[${SERVER_NAME}] Missing GEMINI_API_KEY environment variable.`);
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

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
      `Unsupported image format: ${ext || "(none)"}. Supported: png, jpg, jpeg, webp, gif, bmp, tiff`
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
      `Blocked local hostname: ${hostname}. Set GEMINI_VISION_BLOCK_LOCAL_URLS=false to override.`
    );
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsPromises.lookup(h, { all: true });
  } catch (e) {
    throw new Error(`DNS resolution failed for ${hostname}: ${(e as Error).message}`);
  }

  if (addresses.length === 0) {
    throw new Error(`No addresses resolved for ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateOrLocalIp(address)) {
      throw new Error(
        `Blocked URL: ${hostname} resolves to private/local IP ${address}. ` +
          `Set GEMINI_VISION_BLOCK_LOCAL_URLS=false to override.`
      );
    }
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("Response body is empty.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Remote image too large. Max allowed: ${MAX_IMAGE_MB}MB`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

async function fetchImageWithRedirects(
  url: string
): Promise<{ buffer: Buffer; mimeType: string; finalUrl: string }> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Only http/https URLs are allowed (got: ${parsed.protocol})`);
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
          throw new Error(`Redirect ${response.status} without Location header`);
        }
        if (hop === MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch image: HTTP ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const size = Number(contentLength);
        if (!Number.isNaN(size) && size > MAX_IMAGE_BYTES) {
          throw new Error(
            `Remote image too large: ${(size / 1024 / 1024).toFixed(2)}MB. Max: ${MAX_IMAGE_MB}MB`
          );
        }
      }

      const buffer = await readBodyWithLimit(response, MAX_IMAGE_BYTES);
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) {
        throw new Error(
          "Downloaded content is not a recognized image format (PNG/JPEG/WEBP/GIF/BMP/TIFF)."
        );
      }

      return { buffer, mimeType: sniffed, finalUrl: currentUrl };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Unreachable: redirect loop exited without return");
}

async function loadImageFromUrl(url: string): Promise<LoadedImage> {
  if (!ALLOW_URL) {
    throw new Error("URL image input is disabled by GEMINI_VISION_ALLOW_URL=false.");
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
    throw new Error("Local file image input is disabled by GEMINI_VISION_ALLOW_LOCAL_FILE=false.");
  }
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large: ${(stat.size / 1024 / 1024).toFixed(2)}MB. Max: ${MAX_IMAGE_MB}MB`
    );
  }
  getMimeFromPath(resolved);
  const buffer = fs.readFileSync(resolved);
  const sniffed = sniffImageMime(buffer);
  if (!sniffed) {
    throw new Error(
      `File contents do not match a supported image format (extension: ${path.extname(resolved)})`
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
      confirm_send_to_gemini: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Must be true only after the user explicitly agrees to send this image to Gemini. Defaults to false."
        )
    }
  },
  async ({ image_source, prompt, confirm_send_to_gemini }) => {
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

    const loaded = await loadImage(cleaned);
    const finalPrompt =
      prompt || "请详细描述这张图片的内容。如果图片中有文字，请尽可能完整地提取出来。";

    const response = await ai.models.generateContent({
      model: GEMINI_VISION_MODEL,
      contents: [
        { inlineData: { mimeType: loaded.mimeType, data: loaded.base64 } },
        { text: finalPrompt }
      ]
    });

    const text =
      response.text ||
      "Gemini returned an empty response. Please try a clearer image or a more specific prompt.";

    return {
      content: [
        {
          type: "text",
          text: [
            "Gemini vision analysis completed.",
            `Model: ${GEMINI_VISION_MODEL}`,
            `Source type: ${loaded.sourceType}`,
            `Source: ${loaded.source}`,
            `MIME: ${loaded.mimeType}`,
            `Size: ${(loaded.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
            "",
            "Result:",
            text
          ].join("\n")
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
