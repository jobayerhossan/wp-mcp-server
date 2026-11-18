import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SITES_FILE = resolve(process.env.WPMCP_SITES_FILE || "./data/sites.json");
const REGISTRATION_KEY = process.env.WPMCP_REGISTRATION_KEY || "";
const NS = "/wp-mcp/v1";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function readSitesFile() {
  if (!existsSync(SITES_FILE)) return {};
  const v = JSON.parse(readFileSync(SITES_FILE, "utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid sites file");
  return v;
}
function staticSites() {
  if (!process.env.WPMCP_SITES_JSON) return {};
  const v = JSON.parse(process.env.WPMCP_SITES_JSON);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("WPMCP_SITES_JSON must be an alias-to-site object");
  return v;
}
function saveSitesFile(data) {
  mkdirSync(dirname(SITES_FILE), { recursive: true, mode: 0o700 });
  const tmp = SITES_FILE + "." + randomBytes(6).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(tmp, SITES_FILE);
}
function allSites() {
  return { ...readSitesFile(), ...staticSites() };
}
export function publicSites() {
  return Object.entries(allSites()).map(([alias, site]) => ({ alias, baseUrl: site.baseUrl, siteName: site.siteName || "" }));
}
export function getSite(alias) {
  const site = allSites()[alias];
  if (!site) throw new Error("Unknown site alias");
  if (!site.baseUrl || !site.siteId || !site.secret) throw new Error("Incomplete WordPress site configuration");
  return site;
}
function rejectPrivateIPv4(ip) {
  const a = ip.split(".").map(Number);
  if (a.length !== 4 || a.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return true;
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && (a[1] === 168 || a[1] === 0 || a[1] === 88)) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19)) ||
    (a[0] === 198 && a[1] === 51 && a[2] === 100) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113);
}
async function validatedAddress(target) {
  if (target.protocol !== "https:" || (target.port && target.port !== "443")) throw new Error("Only HTTPS WordPress origins on port 443 are allowed");
  const host = target.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || isIP(host)) throw new Error("WordPress host must use a public DNS hostname");
  const records = await dnsLookup(host, { all: true });
  const v4 = records.filter(r => r.family === 4);
  if (!v4.length || records.some(r => r.family === 4 && rejectPrivateIPv4(r.address))) throw new Error("WordPress DNS must resolve to public IPv4 addresses only");
  return v4[0].address;
}
function signedHeaders(site, method, route, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const canonical = [timestamp, nonce, method.toUpperCase(), NS + route, sha256(body)].join("\n");
  const signature = createHmac("sha256", site.secret).update(canonical).digest("hex");
  return { "X-WPMCP-Site": site.siteId, "X-WPMCP-Timestamp": timestamp, "X-WPMCP-Nonce": nonce, "X-WPMCP-Signature": signature };
}
async function requestWordPress(site, method, route, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const url = new URL(site.baseUrl.replace(/\/$/, "") + "/wp-json" + NS + route);
  const address = await validatedAddress(url);
  const headers = { "accept": "application/json", ...signedHeaders(site, method, route, body) };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolveResult, reject) => {
    const request = httpsRequest(url, {
      method, headers, agent: false, timeout: 30000,
      lookup: (hostname, options, callback) => callback(null, address, 4)
    }, response => {
      let length = 0;
      const parts = [];
      response.on("data", chunk => {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) { request.destroy(new Error("WordPress response exceeds 16MB")); return; }
        parts.push(chunk);
      });
      response.on("end", () => {
        const raw = Buffer.concat(parts).toString("utf8");
        let data;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw: raw.slice(0, 1000) }; }
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          const error = new Error("WordPress agent request failed with HTTP " + status);
          error.details = { status, method, route };
          reject(error);
        } else resolveResult(data);
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("WordPress request timed out"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    request.end(payload === undefined ? undefined : body);
  });
}
export async function callWordPress(alias, method, route, payload) {
  return requestWordPress(getSite(alias), method, route, payload);
}
export function networkCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "HTTPS_NETWORK_ERROR";
}
export async function diagnoseSiteTransport(site) {
  const target = new URL(site.baseUrl);
  const address = await validatedAddress(target);
  return { host: target.hostname, resolved_public_ipv4: Boolean(address), https_required: true };
}
function readBody(req, limit = 65536) {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > limit) req.destroy();
    });
    req.on("end", () => {
      try { resolveBody(JSON.parse(data || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function sanitizeAlias(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
export async function registerSite(req, res) {
  if (!REGISTRATION_KEY || REGISTRATION_KEY.length < 24) return send(res, 503, { connected: false, message: "Server registration is not configured." });
  if (!safeEqual(req.headers["x-wpmcp-registration-key"] || "", REGISTRATION_KEY)) return send(res, 401, { connected: false, message: "Invalid registration key." });
  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { connected: false, message: "Invalid registration body." }); }
  const baseUrl = String(body.base_url || "").replace(/\/$/, "");
  const siteId = String(body.site_id || "");
  const secret = String(body.secret || "");
  const alias = sanitizeAlias(body.alias);
  if (!alias || !/^site_[A-Za-z0-9_-]{8,80}$/.test(siteId) || !/^[a-f0-9]{64}$/i.test(secret))
    return send(res, 400, { connected: false, message: "Invalid site credentials or alias." });
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) return send(res, 400, { connected: false, message: "Use the HTTPS WordPress origin URL." });
  if (Object.hasOwn(staticSites(), alias)) return send(res, 409, { connected: false, message: "Alias reserved by server configuration." });
  const candidate = { baseUrl, siteId, secret, siteName: String(body.site_name || "").slice(0, 160) };
  try { await requestWordPress(candidate, "GET", "/site", undefined); }
  catch { return send(res, 400, { connected: false, message: "Could not verify the WordPress plugin or HTTPS host." }); }
  const sites = readSitesFile();
  sites[alias] = candidate;
  saveSitesFile(sites);
  return send(res, 200, { connected: true, alias, base_url: baseUrl });
}
