import assert from "node:assert/strict";
import test from "node:test";
import { buildMcp } from "../src/tools.js";

test("WordPress-only MCP tools initialize without private integrations", () => {
  const server = buildMcp();
  assert.ok(server);
  assert.equal(typeof server.registerTool, "function");
  assert.equal(typeof server.close, "function");
});
