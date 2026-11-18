import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

test("self-hosted OAuth supports DCR, PKCE, access/refresh tokens, and write consent", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wpmcp-oauth-test-"));
  const previous = {
    file: process.env.WPMCP_OAUTH_FILE,
    owner: process.env.WPMCP_OWNER_PASSWORD,
    writes: process.env.WPMCP_ALLOW_WRITES
  };
  process.env.WPMCP_OAUTH_FILE = join(scratch, "oauth.json");
  process.env.WPMCP_OWNER_PASSWORD = "integration-test-password-very-long";
  process.env.WPMCP_ALLOW_WRITES = "true";
  const { handleOAuth, authorizeRequest, authContext, canWrite, oauthReady } = await import("../src/oauth.js?integration-test");
  const issuer = "https://mcp.example.com";
  const callback = "https://chatgpt.com/connector/oauth/callback";
  const server = createServer(async (req, res) => {
    try {
      const handled = await handleOAuth(req, res, new URL(req.url, "http://localhost"), issuer);
      if (!handled) { res.writeHead(404); res.end(); }
    } catch {
      res.writeHead(500); res.end();
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const host = "http://127.0.0.1:" + server.address().port;
    assert.equal(oauthReady(), true);
    const discovery = await fetch(host + "/.well-known/oauth-authorization-server");
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json();
    assert.equal(metadata.authorization_endpoint, issuer + "/authorize");
    assert.ok(metadata.code_challenge_methods_supported.includes("S256"));

    const registration = await fetch(host + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT Test", redirect_uris: [callback], token_endpoint_auth_method: "none" })
    });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    assert.ok(client.client_id);

    const verifier = "a-test-code-verifier-that-is-long-enough-for-pkce-123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(host + "/authorize");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", callback);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("state", "test-state");
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", issuer + "/mcp");
    const approvalPage = await fetch(authorize);
    assert.equal(approvalPage.status, 200);
    assert.match(await approvalPage.text(), /Authorize WordPress MCP/);

    const form = new URLSearchParams(authorize.searchParams);
    form.set("owner_password", process.env.WPMCP_OWNER_PASSWORD);
    form.set("allow_write", "yes");
    const approved = await fetch(host + "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual"
    });
    assert.equal(approved.status, 303);
    const redirect = new URL(approved.headers.get("location"));
    assert.equal(redirect.origin, "https://chatgpt.com");
    assert.equal(redirect.searchParams.get("state"), "test-state");
    const code = redirect.searchParams.get("code");
    assert.ok(code);

    const bad = await fetch(host + "/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: callback, code, code_verifier: "wrong-verifier-that-is-long-enough-for-pkce-xxxxxxxxxxxx" })
    });
    assert.equal(bad.status, 400);

    const exchanged = await fetch(host + "/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: callback, code, code_verifier: verifier })
    });
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.match(tokens.scope, /wordpress:write/);
    const identity = authorizeRequest({ headers: { authorization: "Bearer " + tokens.access_token } });
    assert.equal(identity.clientId, client.client_id);
    assert.equal(authContext.run(identity, () => canWrite()), true);

    const replay = await fetch(host + "/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: callback, code, code_verifier: verifier })
    });
    assert.equal(replay.status, 400);

    const refreshed = await fetch(host + "/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token })
    });
    assert.equal(refreshed.status, 200);
    const fresh = await refreshed.json();
    assert.notEqual(fresh.access_token, tokens.access_token);
    assert.ok(authorizeRequest({ headers: { authorization: "Bearer " + fresh.access_token } }));

    const revoke = await fetch(host + "/revoke", {
      method: "POST",
      body: new URLSearchParams({ client_id: client.client_id, token: fresh.access_token })
    });
    assert.equal(revoke.status, 200);
    assert.throws(() => authorizeRequest({ headers: { authorization: "Bearer " + fresh.access_token } }));
  } finally {
    server.close();
    await once(server, "close");
    rmSync(scratch, { recursive: true, force: true });
    for (const [key, variable] of [["file", "WPMCP_OAUTH_FILE"], ["owner", "WPMCP_OWNER_PASSWORD"], ["writes", "WPMCP_ALLOW_WRITES"]]) {
      if (previous[key] === undefined) delete process.env[variable];
      else process.env[variable] = previous[key];
    }
  }
});
