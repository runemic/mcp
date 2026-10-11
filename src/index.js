// Runemic MCP server that runs on your own computer (stdio), for Claude Desktop, Claude Code, Codex, Cursor and
// other local MCP clients. Unlike the hosted server (https://mcp.runemic.com/mcp), it can read files on this
// machine: give it a path to an image, a PDF or a folder of pages, and it sends them to the Runemic OCR API.
//
//   RUNEMIC_API_KEY   your key from https://console.runemic.com (required)
//   RUNEMIC_API_URL   default https://api.runemic.com
//   RUNEMIC_MCP_URL   default https://mcp.runemic.com/mcp (used for get_account)
//
// Files are read locally and sent only to Runemic; nothing is stored there.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

const VERSION = "1.1.0";
const API = (process.env.RUNEMIC_API_URL || "https://api.runemic.com").replace(/\/+$/, "");
const MCP = process.env.RUNEMIC_MCP_URL || "https://mcp.runemic.com/mcp";
const KEY = (process.env.RUNEMIC_API_KEY || "").trim();
const MAX_BYTES = 4 * 1024 * 1024, MAX_PAGES = 50, MAX_SIDE = 2400;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".heic", ".heif"]);
const run = promisify(execFile);

// ───────────────────────────── files

const expand = (p) => path.resolve(p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p);

function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return null;
}

async function have(cmd) {
  try { await run(process.platform === "win32" ? "where" : "which", [cmd]); return true; } catch { return false; }
}

// Turns a large or unusual image (HEIC, TIFF, BMP, huge scans) into a JPEG the API accepts, with the tools the
// computer has: sips (macOS) or ImageMagick.
async function convert(file, dir) {
  const out = path.join(dir, path.basename(file).replace(/\.[^.]+$/, "") + `-${Date.now()}.jpg`);
  if (process.platform === "darwin" && await have("sips")) {
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(MAX_SIDE), file, "--out", out]);
    return out;
  }
  for (const im of ["magick", "convert"]) {
    if (await have(im)) {
      await run(im, [file + "[0]", "-auto-orient", "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, "-quality", "85", out]);
      return out;
    }
  }
  throw new Error("this image is too large or in a format the API doesn't take, and no converter was found. Install ImageMagick, or save it as PNG or JPEG under 4 MB");
}

function parsePages(spec, count) {
  if (!spec) return [...Array(Math.min(count, MAX_PAGES)).keys()].map((i) => i + 1);
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw new Error(`pages: "${part.trim()}" is not a page number or range like 1-3`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let i = Math.max(1, a); i <= Math.min(b, count); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y).slice(0, MAX_PAGES);
}

// PDF pages as PNG images (Poppler's pdftoppm)
async function pdfPages(file, spec, dir) {
  if (!(await have("pdftoppm"))) throw new Error("reading PDFs needs Poppler (pdftoppm): macOS `brew install poppler`, Ubuntu `sudo apt install poppler-utils`, Windows https://github.com/oschwartz10612/poppler-windows. Or export the pages as images");
  let count = 0;
  if (await have("pdfinfo")) {
    const { stdout } = await run("pdfinfo", [file]);
    count = Number((stdout.match(/^Pages:\s+(\d+)/m) || [])[1] || 0);
  }
  const pages = parsePages(spec, count || MAX_PAGES);
  const out = [];
  for (const n of pages) {
    const base = path.join(dir, `page-${n}`);
    try { await run("pdftoppm", ["-f", String(n), "-l", String(n), "-r", "150", "-png", "-singlefile", file, base]); }
    catch (e) { if (!count) break; throw e; }
    out.push({ file: base + ".png", label: `page ${n}` });
  }
  if (!out.length) throw new Error("no pages found in this PDF");
  return out;
}

// One page image → { bytes, type } ready for the API (converted when needed)
async function prepare(file, dir) {
  let bytes = await readFile(file), type = sniff(bytes);
  if (!type || type === "application/pdf" || bytes.length > MAX_BYTES) {
    bytes = await readFile(await convert(file, dir));
    type = sniff(bytes);
    if (!type || bytes.length > MAX_BYTES) throw new Error("the image is still too large after converting (max 4 MB)");
  }
  return { bytes, type };
}

// ───────────────────────────── the API

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = () => ({ Authorization: `Bearer ${KEY}`, "User-Agent": `runemic-mcp/${VERSION}` });

async function ocr({ bytes, type }, name, { format, model, instructions }) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type }), name);
    form.set("format", format || "markdown");
    if (model) form.set("model", model);
    if (instructions) form.set("instructions", instructions);
    const r = await fetch(`${API}/v1/ocr`, { method: "POST", headers: headers(), body: form });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const e = j.error || {};
    // per-minute limit: wait as told, a few times
    if (r.status === 429 && e.code === "rate_limited" && attempt < 3) { await sleep(Math.min(60, Number(r.headers.get("Retry-After")) || 20) * 1000); continue; }
    throw Object.assign(new Error(`${e.message || `HTTP ${r.status}`} (${e.code || r.status})`), { code: e.code, stop: ["insufficient_credits", "account_blocked", "invalid_api_key", "daily_limit", "capacity", "maintenance"].includes(e.code) });
  }
}

const needKey = () => (KEY ? null : {
  isError: true,
  content: [{ type: "text", text: "RUNEMIC_API_KEY is not set. Create a key at https://console.runemic.com (API keys) and add it to this MCP server's settings as RUNEMIC_API_KEY. Don't paste it into the chat." }],
});

// reads a list of pages one after another; stops early on account problems
async function readPages(items, opts, dir) {
  const pages = [];
  for (const it of items) {
    try {
      const r = await ocr(await prepare(it.file, dir), path.basename(it.file), opts);
      pages.push({ source: it.label, text: r.text, model: r.model, request_id: r.id, credits_used: r.usage?.credits_used ?? 0, credits_left: r.credits_left });
    } catch (e) {
      pages.push({ source: it.label, error: e.message });
      if (e.stop) break;
    }
  }
  const ok = pages.filter((p) => !p.error);
  const total = ok.reduce((s, p) => s + p.credits_used, 0);
  const many = items.length > 1;
  const text = pages.map((p) => (many ? `## ${p.source}\n\n` : "") + (p.error ? `[not read: ${p.error}]` : p.text)).join("\n\n");
  return {
    ...(ok.length ? {} : { isError: true }),
    content: [{ type: "text", text: text + (many ? `\n\n---\n${ok.length} of ${pages.length} pages read · ${total.toLocaleString("en-US")} credit${total === 1 ? "" : "s"}` : "") }],
    structuredContent: { pages, pages_read: ok.length, total_credits_used: total, credits_left: ok.length ? ok[ok.length - 1].credits_left : null },
  };
}

const withTemp = async (fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), "runemic-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
};

const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

// ───────────────────────────── the server

const server = new McpServer(
  { name: "runemic-local", title: "Runemic OCR (local files)", version: VERSION, websiteUrl: "https://runemic.com" },
  { instructions: "Reads document pages on this computer with Runemic OCR: images (PNG, JPEG, WebP, GIF; HEIC, TIFF and large scans are converted), PDFs (needs Poppler) and folders of pages. Give absolute paths or paths starting with ~. Each page costs 2–3 of the user's Runemic credits, depending on the model; failed pages are free. Text comes back in reading order as Markdown (or plain text)." },
);

const common = {
  format: z.enum(["markdown", "text"]).optional().describe("'markdown' (default) keeps headings, lists and tables; 'text' is plain text."),
  model: z.string().max(64).optional().describe("A model id from list_models. Usually leave it out: the default model is used, with automatic fallback."),
  instructions: z.string().max(300).optional().describe("Optional notes on how to transcribe, e.g. 'only the table'."),
};

server.registerTool("read_file", {
  title: "Read a file (OCR)",
  description: "Reads the text of a page image or a PDF on this computer. For a PDF, every page is read (or the ones in 'pages', e.g. '1-3,7'; at most 50 per call).",
  inputSchema: { path: z.string().min(1).describe("Path to the file, e.g. ~/Desktop/page.png or /Users/me/scan.pdf."), pages: z.string().max(100).optional().describe("PDF only: pages to read, e.g. '1-3,7'."), ...common },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ path: p, pages, ...opts }) => {
  const missing = needKey(); if (missing) return missing;
  const file = expand(p);
  let st;
  try { st = await stat(file); } catch { return fail(`File not found: ${file}`); }
  if (st.isDirectory()) return fail(`${file} is a folder. Use read_folder to read all the pages in it.`);
  return withTemp(async (dir) => {
    try {
      const head = (await readFile(file)).subarray(0, 8);
      const items = sniff(head) === "application/pdf" || /\.pdf$/i.test(file) ? await pdfPages(file, pages, dir) : [{ file, label: path.basename(file) }];
      return await readPages(items, opts, dir);
    } catch (e) { return fail(`Could not read ${path.basename(file)}: ${e.message}.`); }
  });
});

server.registerTool("read_folder", {
  title: "Read a folder of pages",
  description: "Reads every page image (and PDF) in a folder, in natural name order (page2 before page10), up to 50 pages. Good for scanned books, letters and archives.",
  inputSchema: { path: z.string().min(1).describe("Path to the folder."), limit: z.number().int().min(1).max(MAX_PAGES).optional().describe("Read at most this many pages (default 50)."), ...common },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ path: p, limit, ...opts }) => {
  const missing = needKey(); if (missing) return missing;
  const folder = expand(p);
  let names;
  try { names = await readdir(folder); } catch { return fail(`Folder not found: ${folder}`); }
  const files = names.filter((n) => !n.startsWith(".") && (IMAGE_EXT.has(path.extname(n).toLowerCase()) || /\.pdf$/i.test(n)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  if (!files.length) return fail(`No images or PDFs in ${folder}.`);
  const cap = limit || MAX_PAGES;
  return withTemp(async (dir) => {
    const items = [];
    for (const n of files) {
      if (items.length >= cap) break;
      const f = path.join(folder, n);
      if (/\.pdf$/i.test(n)) {
        try { for (const pg of await pdfPages(f, null, dir)) { if (items.length < cap) items.push({ file: pg.file, label: `${n}, ${pg.label}` }); } }
        catch (e) { items.push({ file: f, label: n, broken: e.message }); }
      } else items.push({ file: f, label: n });
    }
    const good = items.filter((i) => !i.broken);
    const res = await readPages(good, opts, dir);
    const broken = items.filter((i) => i.broken);
    if (broken.length) res.content[0].text += "\n\nNot read: " + broken.map((b) => `${b.label} (${b.broken})`).join("; ");
    return res;
  });
});

server.registerTool("list_models", {
  title: "List OCR models",
  description: "Lists the OCR models available now, with their credits per page (2–3 credits a page) and what each is best at.",
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => {
  const r = await fetch(`${API}/v1/models`, { headers: { "User-Agent": `runemic-mcp/${VERSION}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return fail(`Could not list models (HTTP ${r.status}).`);
  return { content: [{ type: "text", text: JSON.stringify(j.data.map((m) => ({ id: m.id, name: m.name, default: m.default, credits_per_page: m.credits_per_page, best_for: m.best_for })), null, 2) }] };
});

server.registerTool("get_account", {
  title: "Credits and limits",
  description: "Shows the Runemic account's credits left, today's pages and daily limit, and this month's usage.",
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async () => {
  const missing = needKey(); if (missing) return missing;
  const r = await fetch(MCP, { method: "POST", headers: { ...headers(), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_account", arguments: {} } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.result) return fail(r.status === 401 ? "The API key was not accepted. Check RUNEMIC_API_KEY." : `Could not load the account (HTTP ${r.status}).`);
  return j.result;
});

await server.connect(new StdioServerTransport());
