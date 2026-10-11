#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gaimCall } from "./client.mjs";
import { DEFAULT_CONFIG } from "./core.mjs";
import { VERSION } from "./meta.mjs";

const [command = "status", ...args] = process.argv.slice(2);

try {
  let result;
  if (["help", "-h", "--help"].includes(command)) {
    printUsage();
  } else if (["version", "-v", "--version"].includes(command)) {
    process.stdout.write(`${VERSION}\n`);
  } else if (command === "mcp") {
    await import("./gaim-mcp.mjs").then(({ runMcp }) => runMcp());
  } else if (command === "acp") {
    await import("./gaim-acp.mjs").then(({ runAcp }) => runAcp());
  } else if (command === "daemon") {
    await import("./daemon.mjs").then(({ runDaemon }) => runDaemon());
  } else if (command === "init") {
    result = installationInfo();
  } else if (command === "setup") {
    result = await setup();
  } else if (command === "doctor") {
    result = await doctor();
  } else if (command === "login") {
    result = await login();
  } else if (command === "stop") {
    result = await stop();
  } else if (command === "guide") {
    const guide = fileURLToPath(new URL("./skills/gaim/GUIDE.md", import.meta.url));
    process.stdout.write(await import("node:fs/promises").then(({ readFile }) => readFile(guide, "utf8")));
  } else if (command === "status") {
    result = await gaimCall("status");
  } else if (command === "history") {
    const conversationId = args[0];
    if (!conversationId) usage("history requires a conversation ID");
    result = await gaimCall("history", { conversation_id: conversationId });
  } else if (command === "turn") {
    result = await gaimCall("turn", parseTurn(args));
  } else {
    usage(`unknown command: ${command}`);
  }
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const details = Object.fromEntries(
    Object.entries(error).filter(([key]) => !["name", "message", "stack", "code"].includes(key)),
  );
  process.stderr.write(`${JSON.stringify({
    error: { code: error.code ?? "INTERNAL_ERROR", message: error.message, ...details },
  }, null, 2)}\n`);
  process.exitCode = 1;
}

function installationInfo() {
  const entry = fileURLToPath(import.meta.url);
  return {
    mcp: {
      name: "gaim",
      config: { command: process.execPath, args: [entry, "mcp"] },
    },
    acp: {
      name: "gaim",
      command: process.execPath,
      args: [entry, "acp"],
    },
    daemon: { command: process.execPath, args: [entry, "daemon"] },
    next_steps: [
      "Register the MCP config with your coding agent, or the ACP command with an ACP host.",
      "Run `gaim doctor`.",
      "Run `gaim login` once in a graphical session, then call gaim_status.",
    ],
  };
}

async function doctor() {
  const checks = {
    node: { ok: Number(process.versions.node.split(".")[0]) >= 22, version: process.versions.node },
    chrome: { ok: await exists(DEFAULT_CONFIG.chrome), path: DEFAULT_CONFIG.chrome },
    profile: { path: DEFAULT_CONFIG.userDataDir },
    browser_policy: "GAIM never downloads a browser; set GAIM_CHROME to another system Chrome path if needed.",
  };
  return { ok: checks.node.ok && checks.chrome.ok, checks, integration: installationInfo() };
}

async function setup() {
  const diagnostics = await doctor();
  if (!diagnostics.ok) {
    throw Object.assign(new Error(
      "GAIM requires Node.js 22 or newer and an installed system Google Chrome. It never downloads a browser.",
    ), { code: "SETUP_REQUIREMENTS_NOT_MET" });
  }
  const before = await gaimCall("status");
  if (before.login_status !== "ready") await login();
  const after = before.login_status === "ready" ? before : await gaimCall("status");
  if (after.login_status !== "ready") {
    throw Object.assign(new Error(after.last_error?.message ?? "Google AI Mode is not ready."), {
      code: after.last_error?.code ?? "SETUP_NOT_READY",
    });
  }
  return { ready: true, status: after, integration: installationInfo() };
}

async function login() {
  return gaimCall("login", {}, { timeoutMs: 86_400_000 });
}

async function stop() {
  try {
    await gaimCall("shutdown", {}, { noAutoStart: true, timeoutMs: 2_000 });
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
  }
  return { stopped: true };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseTurn(args) {
  const values = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      values.push(argument);
      continue;
    }
    const name = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} requires a value`);
    flags[name] = value;
    index += 1;
  }
  const message = values.join(" ").trim();
  if (!message) usage("turn requires a message");
  return {
    message,
    speaker: {
      id: flags["speaker-id"] ?? "cli",
      name: flags["speaker-name"] ?? "CLI user",
    },
    request_id: flags["request-id"] ?? randomUUID(),
    ...(flags.conversation ? { conversation_id: flags.conversation } : {}),
  };
}

function usage(message) {
  process.stderr.write(`gaim: ${message}\n\n`);
  printUsage(process.stderr);
  process.exit(2);
}

function printUsage(stream = process.stdout) {
  stream.write([
    "Usage:",
    "  gaim --help               Show this help",
    "  gaim --version            Show the installed version",
    "  gaim setup                Detect Chrome, complete local login, and verify AI Mode",
    "  gaim init                 Print ready-to-use MCP and ACP configuration",
    "  gaim doctor               Check Node, system Chrome, and local paths",
    "  gaim login                Open the dedicated Chrome profile on this desktop",
    "  gaim stop                 Stop the local core and its dedicated Chrome",
    "  gaim mcp                  Run the local stdio MCP server",
    "  gaim acp                  Run the ACP agent",
    "  gaim daemon               Run the singleton local conversation core",
    "  gaim guide                Print the version-matched agent guide",
    "  gaim status",
    "  gaim history CONVERSATION_ID",
    "  gaim turn MESSAGE [--conversation ID] [--speaker-id ID] [--speaker-name NAME]",
  ].join("\n") + "\n");
}
