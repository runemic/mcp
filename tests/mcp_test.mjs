// The local MCP server (dist/runemic-mcp.mjs, from npm run build) started over stdio by the official MCP client, the
// way Claude Desktop, Claude Code or Codex start it, against a stand-in API (mock-api.mjs). Reads an image, a two-page
// PDF, a folder and a too-large image, and checks the errors for missing keys, wrong keys and missing files.
// Needs ImageMagick (convert) and Poppler (pdftoppm).   npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start, KEY } from "./mock-api.mjs";

const server = fileURLToPath(new URL("../dist/runemic-mcp.mjs", import.meta.url));
if (!existsSync(server)) { console.log("Build first: npm run build"); process.exit(1); }
const { server: api, url: B } = await start();
let pass = 0, fail = 0;
const check = (n, c, d = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (d ? "  " + String(d).slice(0, 200) : "")); };

// fixtures: a page, a folder with two pages (natural order), a 2-page PDF, a huge image
const dir = mkdtempSync(path.join(tmpdir(), "rmcp-"));
const PNG = path.join(dir, "..", path.basename(dir) + "-page.png");
execFileSync("convert", ["-size", "600x400", "xc:white", "-fill", "black", "-draw", "rectangle 40,40 560,80", PNG]);
execFileSync("cp", [PNG, path.join(dir, "page10.png")]);
execFileSync("cp", [PNG, path.join(dir, "page2.png")]);
writeFileSync(path.join(dir, "notes.txt"), "not a page");
const bigFile = path.join(dir, "..", path.basename(dir) + "-big.png");
execFileSync("convert", [PNG, PNG, path.join(dir, "doc.pdf")]);
execFileSync("convert", [PNG, "+noise", "Uniform", "-resize", "600%", "-define", "png:compression-level=0", bigFile]);

async function connect(env) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StdioClientTransport({ command: "node", args: [server], env: { ...process.env, ...env }, stderr: "pipe" }));
  return c;
}
const text = (r) => (r.content || []).map((c) => c.text || "").join("\n");

const c = await connect({ RUNEMIC_API_KEY: KEY, RUNEMIC_API_URL: B, RUNEMIC_MCP_URL: B + "/mcp" });
const tools = (await c.listTools()).tools.map((t) => t.name).sort();
check("tools: read_file, read_folder, list_models, get_account", JSON.stringify(tools) === JSON.stringify(["get_account", "list_models", "read_file", "read_folder"]), tools);

let r = await c.callTool({ name: "read_file", arguments: { path: PNG } });
check("read_file: an image", !r.isError && text(r).includes("INVOICE") && r.structuredContent.pages_read === 1, text(r).slice(0, 80));
const sc1 = r.structuredContent || {};
check("read_file: credits used and left (no dollars)", sc1.total_credits_used === 2 && sc1.pages[0].credits_used === 2 && Number.isInteger(sc1.credits_left) && !("total_cost_usd" in sc1) && !("cost_usd" in sc1.pages[0]), JSON.stringify(sc1).slice(0, 160));
r = await c.callTool({ name: "read_file", arguments: { path: path.join(dir, "doc.pdf"), format: "text" } });
check("read_file: a PDF, every page, in order", !r.isError && r.structuredContent.pages_read === 2 && r.structuredContent.total_credits_used === 4 && text(r).includes("2 of 2 pages read · 4 credits") && /## page 1[\s\S]*## page 2/.test(text(r)) && !text(r).includes("**"), text(r).slice(0, 120));
r = await c.callTool({ name: "read_file", arguments: { path: path.join(dir, "doc.pdf"), pages: "2" } });
check("read_file: chosen PDF pages", !r.isError && r.structuredContent.pages_read === 1 && r.structuredContent.pages[0].source === "page 2", JSON.stringify(r.structuredContent.pages.map((p) => p.source)));
r = await c.callTool({ name: "read_file", arguments: { path: bigFile } });
check("read_file: an image over 4 MB is converted first", !r.isError && text(r).includes("INVOICE"), text(r).slice(0, 120));
r = await c.callTool({ name: "read_folder", arguments: { path: dir } });
const order = r.structuredContent ? r.structuredContent.pages.map((p) => p.source) : [];
check("read_folder: pages in natural order, PDFs included, other files skipped", !r.isError && JSON.stringify(order) === JSON.stringify(["doc.pdf, page 1", "doc.pdf, page 2", "page2.png", "page10.png"]), JSON.stringify(order));
r = await c.callTool({ name: "read_file", arguments: { path: path.join(dir, "missing.png") } });
check("a missing file: a clear error", r.isError && text(r).includes("File not found"));
r = await c.callTool({ name: "read_file", arguments: { path: dir } });
check("a folder given to read_file: points to read_folder", r.isError && text(r).includes("read_folder"));
r = await c.callTool({ name: "list_models", arguments: {} });
check("list_models: credits per page", !r.isError && (() => { const m = Object.fromEntries(JSON.parse(text(r)).map((x) => [x.id, x.credits_per_page])); return m["preview-gemma-4"] === 2 && m["preview-mistral-small"] === 3; })(), text(r).slice(0, 160));
r = await c.callTool({ name: "get_account", arguments: {} });
check("get_account (through the hosted server, with the key)", !r.isError && text(r).includes("credits_left") && !text(r).includes("usd"), text(r).slice(0, 100));
await c.close();

const nokey = await connect({ RUNEMIC_API_KEY: "", RUNEMIC_API_URL: B });
r = await nokey.callTool({ name: "read_file", arguments: { path: PNG } });
check("without a key: says how to get one, never asks for it in chat", r.isError && text(r).includes("console.runemic.com") && text(r).includes("Don't paste it"));
await nokey.close();
const badkey = await connect({ RUNEMIC_API_KEY: "rk_live_" + "x".repeat(43), RUNEMIC_API_URL: B });
r = await badkey.callTool({ name: "read_file", arguments: { path: PNG } });
check("a wrong key: the API's error", r.isError && text(r).includes("invalid_api_key"), text(r).slice(0, 120));
await badkey.close();

api.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
