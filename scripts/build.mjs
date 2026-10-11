// Builds the local Runemic MCP server (src/index.js) into one file and two downloads, in out/:
//   out/runemic-mcp.tgz   npm package; runemic.com/mcp/runemic-mcp.tgz serves the latest release's copy
//   out/runemic.mcpb      Claude Desktop extension (double-click to install)
// npm run build (the release workflow runs it and attaches both files to a GitHub release)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync, renameSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pkgDir = root;
const out = path.join(root, "out");
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
mkdirSync(out, { recursive: true });

// 1. one self-contained ES module (MCP SDK and zod included)
await build({
  entryPoints: [path.join(pkgDir, "src/index.js")], outfile: path.join(pkgDir, "dist/runemic-mcp.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node18", minify: true, legalComments: "eof",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

// 2. npm tarball
const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", out], { cwd: pkgDir }).toString().trim().split("\n").pop();
renameSync(path.join(out, tgz), path.join(out, "runemic-mcp.tgz"));

// 3. Claude Desktop extension (MCP Bundle), packed and validated with the official mcpb CLI
const b = path.join(root, ".bundle");
rmSync(b, { recursive: true, force: true });
mkdirSync(path.join(b, "server"), { recursive: true });
copyFileSync(path.join(pkgDir, "dist/runemic-mcp.mjs"), path.join(b, "server/index.mjs"));
copyFileSync(path.join(root, "assets/icon.png"), path.join(b, "icon.png"));
writeFileSync(path.join(b, "manifest.json"), JSON.stringify({
  manifest_version: "0.2",
  name: "runemic",
  display_name: "Runemic OCR",
  version: pkg.version,
  description: "Read images, PDFs and folders of pages on your computer, in any script.",
  long_description: "Runemic reads document pages and returns their text in reading order, as Markdown (headings, lists and tables kept) or plain text. It is strongest on non-Latin scripts (Arabic, Persian, Urdu, Hindi, Cyrillic, CJK), old scans, handwriting and complex layouts. Point Claude at a file or a folder; each page costs 2–3 Runemic credits and pages are never stored.",
  author: { name: "Runemic", email: "hello@runemic.com", url: "https://runemic.com" },
  homepage: "https://runemic.com",
  documentation: "https://runemic.com/docs#mcp-local",
  support: "mailto:hello@runemic.com",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "server/index.mjs",
    mcp_config: { command: "node", args: ["${__dirname}/server/index.mjs"], env: { RUNEMIC_API_KEY: "${user_config.api_key}" } },
  },
  tools: [
    { name: "read_file", description: "Read the text of a page image or a PDF" },
    { name: "read_folder", description: "Read every page in a folder, in order" },
    { name: "list_models", description: "List the OCR models and their credits per page" },
    { name: "get_account", description: "Show credits left and limits" },
  ],
  user_config: {
    api_key: { type: "string", title: "Runemic API key", description: "Create one at https://console.runemic.com under API keys (starts with rk_live_).", sensitive: true, required: true },
  },
  keywords: ["ocr", "pdf", "documents", "arabic", "persian", "urdu", "hindi", "handwriting"],
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=18.0.0" } },
  privacy_policies: ["https://runemic.com/privacy"],
}, null, 2));
const mcpb = (...a) => execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2", ...a], { cwd: root, stdio: ["ignore", "pipe", "inherit"] }).toString();
mcpb("validate", path.join(b, "manifest.json"));
mcpb("pack", b, path.join(out, "runemic.mcpb"));
rmSync(b, { recursive: true, force: true });
console.log("built:", readdirSync(out).join(", "));
