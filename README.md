# Runemic OCR, local MCP server

Reads document pages on your computer with [Runemic](https://runemic.com): page images (PNG, JPEG, WebP, GIF; HEIC,
TIFF and large scans are converted), PDFs and whole folders. Text comes back in reading order as Markdown or plain
text, in any script: Arabic, Persian, Urdu, Hindi, Cyrillic, Chinese, Japanese and more.

Needs Node 18+ and a Runemic API key from [console.runemic.com](https://console.runemic.com) (2,500 free credits).
For PDFs, install Poppler (`pdftoppm`).

## Claude Desktop

Download [runemic.mcpb](https://runemic.com/mcp/runemic.mcpb) and double-click it, then paste your API key.

## Any MCP client (Claude Code, Codex, Cursor, VS Code …)

```json
{
  "mcpServers": {
    "runemic": {
      "command": "npx",
      "args": ["-y", "--package=https://runemic.com/mcp/runemic-mcp.tgz", "runemic-mcp"],
      "env": { "RUNEMIC_API_KEY": "rk_live_…" }
    }
  }
}
```

Tools: `read_file` (an image or PDF), `read_folder` (all pages in a folder, in order), `list_models`, `get_account`.
Pages are sent to the Runemic API to be read and are not stored. Docs: [runemic.com/docs#mcp-local](https://runemic.com/docs#mcp-local).

Prefer no install? The hosted MCP server at `https://mcp.runemic.com/mcp` needs no key: you sign in in the browser.

## Build

```sh
npm install && npm run build   # out/runemic-mcp.tgz, out/runemic.mcpb
```

```sh
npm test   # the built server against a stand-in API (tests/mock-api.mjs); needs ImageMagick and Poppler
```

Every push runs the tests. Releases: bump `version` in `package.json` on `main`; the release workflow tests, builds and publishes both files.

## Licence

Apache-2.0
