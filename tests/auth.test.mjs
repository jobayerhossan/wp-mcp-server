import assert from "node:assert/strict";
import test from "node:test";
import { canWrite, oauthReady, authContext } from "../src/oauth.js";
import { publicSites } from "../src/sites.js";

test("OAuth requires configured strong password", () => {
  const previous = process.env.WPMCP_OWNER_PASSWORD;
  delete process.env.WPMCP_OWNER_PASSWORD;
  assert.equal(oauthReady(), false);
  process.env.WPMCP_OWNER_PASSWORD = "short";
  assert.equal(oauthReady(), false);
  process.env.WPMCP_OWNER_PASSWORD = "some-random-test-password-long-enough";
  assert.equal(oauthReady(), true);
  if (previous === undefined) delete process.env.WPMCP_OWNER_PASSWORD;
  else process.env.WPMCP_OWNER_PASSWORD = previous;
});
test("writing requires both server enablement and OAuth write scope", async () => {
  const previous = process.env.WPMCP_ALLOW_WRITES;
  delete process.env.WPMCP_ALLOW_WRITES;
  assert.equal(canWrite(), false);
  await authContext.run({ scopes: ["wordpress:read", "wordpress:write"] }, async () => {
    assert.equal(canWrite(), false);
    process.env.WPMCP_ALLOW_WRITES = "true";
    assert.equal(canWrite(), true);
  });
  assert.equal(canWrite(), false);
  if (previous === undefined) delete process.env.WPMCP_ALLOW_WRITES;
  else process.env.WPMCP_ALLOW_WRITES = previous;
});
test("no production site credentials are required for empty site list", () => {
  if (!process.env.WPMCP_SITES_JSON && !process.env.WPMCP_SITES_FILE) {
    assert.deepEqual(publicSites(), []);
  }
});
