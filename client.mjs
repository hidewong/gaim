import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { gaimSocketPath } from "./paths.mjs";

export class GaimClientError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "GaimClientError";
    Object.assign(this, error);
  }
}

export async function gaimCall(method, params = {}, options = {}) {
  const socketPath = options.socketPath ?? gaimSocketPath();
  try {
    return await send(socketPath, method, params, options.timeoutMs);
  } catch (error) {
    if (!options.noAutoStart && ["ENOENT", "ECONNREFUSED"].includes(error?.code)) {
      startDaemon();
      await waitForDaemon(socketPath, 5_000);
      return send(socketPath, method, params, options.timeoutMs);
    }
    throw error;
  }
}

function send(socketPath, method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("GAIM request timed out."), { code: "CLIENT_TIMEOUT" }));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.destroy();
      const response = JSON.parse(buffer.slice(0, newline));
      if (response.error) reject(new GaimClientError(response.error));
      else resolve(response.result);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`);
    });
  });
}

function startDaemon() {
  const daemon = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
  const child = spawn(process.execPath, [daemon], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

async function waitForDaemon(socketPath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await send(socketPath, "ping", {}, 500);
      return;
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED", "CLIENT_TIMEOUT"].includes(error?.code)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error("GAIM daemon did not start."), { code: "DAEMON_UNAVAILABLE" });
}
