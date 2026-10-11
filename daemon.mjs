#!/usr/bin/env node

import { unlinkSync } from "node:fs";
import { access, chmod, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GaimCore, normalizeError } from "./core.mjs";
import { gaimSocketPath } from "./paths.mjs";

export async function runDaemon({
  socketPath = gaimSocketPath(),
  core = new GaimCore(),
} = {}) {
  await core.initialize();
  if (await socketAcceptsConnections(socketPath)) return null;
  if (process.platform !== "win32" && await socketExists(socketPath)) {
    await unlink(socketPath);
  }

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) socket.destroy(new Error("GAIM request is too large"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      const shouldStop = requestMethod(line) === "shutdown";
      void handleDaemonRequest(line, core).then(
        (response) => socket.end(`${JSON.stringify(response)}\n`, () => {
          if (shouldStop) server.close(() => process.exit(0));
        }),
        (error) => socket.end(`${JSON.stringify({ id: null, error: normalizeError(error) })}\n`),
      );
    });
  });

  server.on("error", (error) => {
    console.error(`gaim daemon: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(socketPath, () => {
    const secureSocket = process.platform === "win32"
      ? Promise.resolve()
      : chmod(socketPath, 0o600);
    void secureSocket.then(
      () => process.stderr.write(`gaim daemon listening on ${socketPath}\n`),
      (error) => server.close(() => {
        process.stderr.write(`gaim daemon: could not secure local socket: ${error.message}\n`);
        process.exitCode = 1;
      }),
    );
  });

  const cleanup = () => {
    if (process.platform === "win32") return;
    try {
      unlinkSync(socketPath);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`gaim daemon cleanup: ${error.message}`);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
  process.once("exit", cleanup);
  return server;
}

export async function handleDaemonRequest(line, core) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return { id: null, error: { code: "INVALID_REQUEST", message: "Request must be valid JSON." } };
  }
  try {
    let result;
    if (request.method === "turn") result = await core.turn(request.params);
    else if (request.method === "history") result = await core.history(request.params);
    else if (request.method === "status") result = await core.status();
    else if (request.method === "login") result = await core.login();
    else if (request.method === "ping") result = { ready: true };
    else if (request.method === "shutdown") {
      await core.shutdown();
      result = { stopped: true };
    } else throw Object.assign(new Error(`Unknown method: ${request.method}`), { code: "METHOD_NOT_FOUND" });
    return { id: request.id, result };
  } catch (error) {
    return { id: request.id, error: normalizeError(error) };
  }
}

function requestMethod(line) {
  try {
    return JSON.parse(line)?.method;
  } catch {
    return null;
  }
}

async function socketExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function socketAcceptsConnections(path) {
  return new Promise((resolveConnection) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", () => resolveConnection(false));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDaemon();
