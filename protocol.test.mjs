import assert from "node:assert/strict";
import test from "node:test";
import { handleDaemonRequest } from "./daemon.mjs";
import { GaimAcpAgent } from "./gaim-acp.mjs";
import { handleMcpRequest } from "./gaim-mcp.mjs";

test("MCP advertises the stable three-tool interface", { timeout: 5_000 }, async () => {
  const initialized = await handleMcpRequest({
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  const listed = await handleMcpRequest({ method: "tools/list", params: {} });
  assert.equal(initialized.serverInfo.name, "gaim");
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["gaim_turn", "gaim_history", "gaim_status"]);
});

test("ACP creates an isolated session and handles local commands", { timeout: 5_000 }, async () => {
  const agent = new GaimAcpAgent();
  const { sessionId } = agent.newSession();
  const updates = [];
  const result = await agent.prompt({
    sessionId,
    prompt: [{ type: "text", text: "/new" }],
  }, {
    notify: async (_method, params) => updates.push(params.update),
  });
  assert.equal(result.stopReason, "end_turn");
  assert.match(updates[0].content.text, /new isolated GAIM conversation/);
});

test("daemon dispatches methods and preserves error codes", async () => {
  let stopped = false;
  const core = {
    status: async () => ({ browser_connected: false }),
    login: async () => ({ ok: true }),
    turn: async (params) => ({ echoed: params.message }),
    history: async () => ({ turns: [] }),
    shutdown: async () => { stopped = true; },
  };
  const status = await handleDaemonRequest('{"id":1,"method":"status","params":{}}', core);
  assert.equal(status.result.browser_connected, false);
  const login = await handleDaemonRequest('{"id":4,"method":"login","params":{}}', core);
  assert.equal(login.result.ok, true);
  const missing = await handleDaemonRequest('{"id":2,"method":"unknown","params":{}}', core);
  assert.equal(missing.error.code, "METHOD_NOT_FOUND");
  const invalid = await handleDaemonRequest("not json", core);
  assert.equal(invalid.error.code, "INVALID_REQUEST");
  const shutdown = await handleDaemonRequest('{"id":3,"method":"shutdown","params":{}}', core);
  assert.equal(shutdown.result.stopped, true);
  assert.equal(stopped, true);
});

test("daemon readiness ping never starts a browser status probe", async () => {
  let statusCalls = 0;
  const core = {
    status: async () => { statusCalls += 1; return {}; },
  };
  const ping = await handleDaemonRequest('{"id":1,"method":"ping","params":{}}', core);
  assert.deepEqual(ping.result, { ready: true });
  assert.equal(statusCalls, 0);
});
