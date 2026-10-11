// A stand-in for the Runemic API (api.runemic.com) with just what the local MCP server calls: GET /v1/models,
// POST /v1/ocr and the hosted MCP's get_account tool. The response shapes follow https://runemic.com/docs.
// It reads nothing: every page comes back as the same short invoice, 2 credits a page.
import http from "node:http";

export const KEY = ["rk", "live", "test".repeat(8)].join("_");  // built here so secret scanners don't mistake it for a real key
const MODELS = [
  { id: "preview-gemma-4", name: "Gemma 4", default: true, credits_per_page: 2, best_for: ["printed pages"] },
  { id: "preview-llama-4-scout", name: "Llama 4 Scout", default: false, credits_per_page: 2, best_for: ["fast drafts"] },
  { id: "preview-mistral-small", name: "Mistral Small", default: false, credits_per_page: 3, best_for: ["tables"] },
];

export function start(port = 0) {
  let credits = 2500;
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const error = (res, status, code, message) => json(res, status, { error: { code, message } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, { object: "list", data: MODELS });
    if (req.headers.authorization !== `Bearer ${KEY}`) return error(res, 401, "invalid_api_key", "Invalid API key");
    if (req.method === "POST" && req.url === "/v1/ocr") {
      if (!body.includes("Content-Type: image/")) return error(res, 400, "invalid_file", "Send a page image");
      const plain = /name="format"\r\n\r\ntext\r\n/.test(body.toString("latin1"));
      credits -= 2;
      return json(res, 200, { id: "req_test", model: "preview-gemma-4", text: plain ? "INVOICE\nNo. 4821" : "# **INVOICE**\n\nNo. 4821",
        usage: { pages: 1, credits_used: 2 }, credits_left: credits });
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const m = JSON.parse(body.toString() || "{}");
      if (m.method === "tools/call" && m.params?.name === "get_account")
        return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ credits_left: credits, month: { pages: 0, credits_used: 0 } }) }] } });
    }
    error(res, 404, "not_found", "Not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}
