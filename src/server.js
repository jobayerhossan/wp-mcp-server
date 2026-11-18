import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildMcp } from "./tools.js";
import { publicSites, registerSite } from "./sites.js";
import { handleOAuth, authorizeRequest, authContext, challenge, oauthReady } from "./oauth.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_URL = String(process.env.MCP_PUBLIC_URL || "").replace(/\/$/, "");
if (!PUBLIC_URL || !/^https:\/\//.test(PUBLIC_URL)) throw new Error("MCP_PUBLIC_URL must be a public HTTPS origin");

const handler = createMcpHandler(() => buildMcp(), { responseMode: "json" });
const mcp = toNodeHandler(handler);
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization,content-type,accept,mcp-session-id,last-event-id",
  "access-control-expose-headers": "www-authenticate,mcp-session-id"
};
const app = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    if (await handleOAuth(req, res, url, PUBLIC_URL)) return;
    if (req.method === "POST" && url.pathname === "/register-site") return await registerSite(req, res);
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, service: "wp-mcp-server", version: "0.1.0", auth: "self-hosted-oauth", auth_ready: oauthReady(), writes_enabled: process.env.WPMCP_ALLOW_WRITES === "true", site_count: publicSites().length }));
      return;
    }
    if (url.pathname === "/mcp") {
      let token;
      try { token = authorizeRequest(req); } catch { return challenge(res, PUBLIC_URL); }
      return authContext.run(token, async () => mcp(req, res));
    }
    res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "internal_error" }));
    } else res.end();
    console.error("Server request error:", error?.message || error);
  }
});
app.listen(PORT, HOST, () => console.log("WordPress MCP server listening on " + HOST + ":" + PORT));
process.on("SIGTERM", () => app.close());
process.on("SIGINT", () => app.close());
