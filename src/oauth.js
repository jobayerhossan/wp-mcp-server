import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const authContext = new AsyncLocalStorage();
const DB_FILE = resolve(process.env.WPMCP_OAUTH_FILE || "./data/oauth.json");
const ACCESS_LIFETIME = 3600;
const REFRESH_LIFETIME = 30 * 24 * 3600;
const CODE_LIFETIME = 300;
const failedPasswords = new Map();

const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const constantEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[ch]);

function dbRead() {
  if (!existsSync(DB_FILE)) return { clients: {}, codes: {}, access: {}, refresh: {} };
  const data = JSON.parse(readFileSync(DB_FILE, "utf8"));
  for (const key of ["clients", "codes", "access", "refresh"]) {
    if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
  }
  return data;
}
function dbWrite(data) {
  mkdirSync(dirname(DB_FILE), { recursive: true, mode: 0o700 });
  const temp = DB_FILE + "." + randomBytes(6).toString("hex") + ".tmp";
  writeFileSync(temp, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
  renameSync(temp, DB_FILE);
}
function prune(data) {
  const t = now();
  for (const group of ["codes", "access", "refresh"]) {
    for (const [key, value] of Object.entries(data[group])) {
      if (value.expires <= t) delete data[group][key];
    }
  }
}
function sendJson(res, status, data, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
    ...extra
  });
  res.end(JSON.stringify(data));
}
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  });
  res.end(html);
}
async function readBody(req, max = 16384) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request body too large");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}
function validRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return Boolean(url.hostname);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  } catch { return false; }
}
function urlWithQuery(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}
function validateAuthorization(params, base) {
  const data = dbRead();
  const client = data.clients[params.get("client_id") || ""];
  if (!client) throw new Error("Unknown OAuth client");
  const redirectUri = params.get("redirect_uri") || "";
  if (!client.redirect_uris.includes(redirectUri)) throw new Error("OAuth redirect URI not registered");
  if (params.get("response_type") !== "code") throw new Error("Only authorization code grants are supported");
  if (params.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 is required");
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") || "")) throw new Error("Invalid PKCE challenge");
  if ((params.get("state") || "").length > 2048) throw new Error("OAuth state too long");
  const resource = params.get("resource");
  if (resource && resource !== base + "/mcp" && resource !== base) throw new Error("Invalid OAuth resource");
  return { client, redirectUri };
}
function authorizationPage(params, base, message = "") {
  const { client, redirectUri } = validateAuthorization(params, base);
  const fields = ["client_id", "redirect_uri", "response_type", "state", "scope", "code_challenge", "code_challenge_method", "resource"];
  const hidden = fields.map(key =>
    '<input type="hidden" name="' + key + '" value="' + escapeHtml(params.get(key) || "") + '">'
  ).join("\n");
  const clientName = escapeHtml(client.client_name || client.client_id);
  const callback = escapeHtml(redirectUri);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize WordPress MCP</title></head><body>' +
    '<main><h1>Authorize WordPress MCP</h1><p>Client: <strong>' + clientName + '</strong></p>' +
    '<p>Callback: <code>' + callback + '</code></p>' +
    '<p>This client will be able to read information from your configured WordPress sites. Enable writes only if you trust the client.</p>' +
    (message ? '<p role="alert">' + escapeHtml(message) + '</p>' : "") +
    '<form method="post" action="/authorize">' + hidden +
    '<p><label>Owner password: <input type="password" name="owner_password" required autocomplete="current-password"></label></p>' +
    '<p><label><input type="checkbox" name="allow_write" value="yes"> Allow WordPress writes (content, Elementor and theme/plugin file changes)</label></p>' +
    '<button type="submit">Authorize</button></form></main></body></html>';
}
export function oauthReady() {
  return typeof process.env.WPMCP_OWNER_PASSWORD === "string" && process.env.WPMCP_OWNER_PASSWORD.length >= 16;
}
function ownerAuthorized(password, ip) {
  const key = ip || "unknown";
  const t = Date.now();
  const state = failedPasswords.get(key) || { count: 0, expires: t + 300000 };
  if (state.expires < t) { state.count = 0; state.expires = t + 300000; }
  if (state.count >= 5) return false;
  const correct = constantEqual(password, process.env.WPMCP_OWNER_PASSWORD || "");
  if (!correct) {
    state.count++;
    failedPasswords.set(key, state);
  } else failedPasswords.delete(key);
  return correct;
}
function mintTokens(data, record) {
  const accessToken = random();
  const refreshToken = random();
  const expiration = now() + ACCESS_LIFETIME;
  data.access[hash(accessToken)] = { client_id: record.client_id, scopes: record.scopes, expires: expiration };
  data.refresh[hash(refreshToken)] = { client_id: record.client_id, scopes: record.scopes, expires: now() + REFRESH_LIFETIME };
  dbWrite(data);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_LIFETIME,
    refresh_token: refreshToken,
    scope: record.scopes.join(" ")
  };
}
export function authorizeRequest(req) {
  const match = /^Bearer\s+([A-Za-z0-9_-]{30,})$/i.exec(req.headers.authorization || "");
  if (!match) throw new Error("Missing access token");
  const data = dbRead();
  const token = data.access[hash(match[1])];
  if (!token || token.expires <= now()) throw new Error("Expired or invalid access token");
  return { clientId: token.client_id, scopes: token.scopes };
}
export function canWrite() {
  return process.env.WPMCP_ALLOW_WRITES === "true" && authContext.getStore()?.scopes?.includes("wordpress:write") === true;
}
export function challenge(res, base) {
  sendJson(res, 401, { error: "unauthorized" }, {
    "www-authenticate": 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource", error="invalid_token"'
  });
}

export async function handleOAuth(req, res, url, base) {
  const path = url.pathname;
  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    sendJson(res, 200, {
      resource: base + "/mcp",
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["wordpress:read", "wordpress:write"]
    });
    return true;
  }
  if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
    sendJson(res, 200, {
      issuer: base,
      authorization_endpoint: base + "/authorize",
      token_endpoint: base + "/token",
      registration_endpoint: base + "/register",
      revocation_endpoint: base + "/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["wordpress:read", "wordpress:write"]
    });
    return true;
  }
  if (path === "/register" && req.method === "POST") {
    if (!oauthReady()) { sendJson(res, 503, { error: "server_not_configured" }); return true; }
    try {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 10 ||
        body.redirect_uris.some(uri => typeof uri !== "string" || uri.length > 2048 || !validRedirect(uri))) {
        sendJson(res, 400, { error: "invalid_redirect_uri" }); return true;
      }
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
        sendJson(res, 400, { error: "invalid_client_metadata" }); return true;
      }
      const data = dbRead();
      if (Object.keys(data.clients).length >= 200) { sendJson(res, 429, { error: "too_many_clients" }); return true; }
      const clientId = random();
      const client = {
        client_id: clientId,
        client_name: String(body.client_name || "MCP Client").slice(0, 120),
        redirect_uris: [...new Set(body.redirect_uris)],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: now()
      };
      data.clients[clientId] = client;
      dbWrite(data);
      sendJson(res, 201, client);
    } catch { sendJson(res, 400, { error: "invalid_client_metadata" }); }
    return true;
  }
  if (path === "/authorize" && req.method === "GET") {
    if (!oauthReady()) { sendJson(res, 503, { error: "server_not_configured" }); return true; }
    try { sendHtml(res, 200, authorizationPage(url.searchParams, base)); }
    catch { sendJson(res, 400, { error: "invalid_request" }); }
    return true;
  }
  if (path === "/authorize" && req.method === "POST") {
    if (!oauthReady()) { sendJson(res, 503, { error: "server_not_configured" }); return true; }
    let params;
    try { params = new URLSearchParams(await readBody(req)); validateAuthorization(params, base); }
    catch { sendJson(res, 400, { error: "invalid_request" }); return true; }
    if (!ownerAuthorized(params.get("owner_password") || "", req.socket.remoteAddress)) {
      sendHtml(res, 403, authorizationPage(params, base, "Incorrect password or too many attempts."));
      return true;
    }
    const clientId = params.get("client_id");
    const code = random();
    const data = dbRead();
    prune(data);
    data.codes[hash(code)] = {
      client_id: clientId,
      redirect_uri: params.get("redirect_uri"),
      challenge: params.get("code_challenge"),
      scopes: params.get("allow_write") === "yes" ? ["wordpress:read", "wordpress:write"] : ["wordpress:read"],
      expires: now() + CODE_LIFETIME
    };
    dbWrite(data);
    const redirect = urlWithQuery(params.get("redirect_uri"), { code, state: params.get("state") || "", iss: base });
    res.writeHead(303, { "location": redirect, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
    return true;
  }
  if (path === "/token" && req.method === "POST") {
    if (!oauthReady()) { sendJson(res, 503, { error: "server_not_configured" }); return true; }
    let params;
    try { params = new URLSearchParams(await readBody(req)); }
    catch { sendJson(res, 400, { error: "invalid_request" }); return true; }
    const clientId = params.get("client_id");
    const data = dbRead();
    prune(data);
    const client = data.clients[clientId];
    if (!client) { sendJson(res, 401, { error: "invalid_client" }); return true; }
    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      const codeHash = hash(params.get("code") || "");
      const grant = data.codes[codeHash];
      const verifier = params.get("code_verifier") || "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!grant || grant.client_id !== clientId || grant.redirect_uri !== params.get("redirect_uri") ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !constantEqual(challenge, grant.challenge)) {
        sendJson(res, 400, { error: "invalid_grant" }); return true;
      }
      delete data.codes[codeHash];
      sendJson(res, 200, mintTokens(data, grant));
      return true;
    }
    if (grantType === "refresh_token") {
      const tokenHash = hash(params.get("refresh_token") || "");
      const grant = data.refresh[tokenHash];
      if (!grant || grant.client_id !== clientId) { sendJson(res, 400, { error: "invalid_grant" }); return true; }
      delete data.refresh[tokenHash];
      sendJson(res, 200, mintTokens(data, grant));
      return true;
    }
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return true;
  }
  if (path === "/revoke" && req.method === "POST") {
    let params;
    try { params = new URLSearchParams(await readBody(req)); }
    catch { sendJson(res, 400, { error: "invalid_request" }); return true; }
    const tokenHash = hash(params.get("token") || "");
    const data = dbRead();
    const clientId = params.get("client_id");
    if (data.clients[clientId]) {
      if (data.access[tokenHash]?.client_id === clientId) delete data.access[tokenHash];
      if (data.refresh[tokenHash]?.client_id === clientId) delete data.refresh[tokenHash];
      dbWrite(data);
    }
    sendJson(res, 200, {});
    return true;
  }
  return false;
}
