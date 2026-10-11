#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gaimCall } from "./client.mjs";
import { VERSION } from "./meta.mjs";

const tools = [
  {
    name: "gaim_turn",
    description: "Ask Google AI Mode. Omit conversation_id to start an isolated conversation; reuse it for a follow-up.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Natural-language research request." },
        conversation_id: { type: "string", description: "Existing GAIM conversation to continue." },
        speaker_id: { type: "string", description: "Stable identity of the calling agent." },
        speaker_name: { type: "string", description: "Human-readable name of the calling agent." },
        request_id: { type: "string", description: "Optional idempotency key." },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "gaim_history",
    description: "Read the recent transcript of one GAIM conversation.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["conversation_id"],
      additionalProperties: false,
    },
  },
  {
    name: "gaim_status",
    description: "Report GAIM browser connectivity, login availability, queue depth, and the last error.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export async function runMcp() {
  process.stdin.resume();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      const result = await handleMcpRequest(request);
      reply({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      reply({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: { code: -32603, message: error.message ?? String(error), data: { code: error.code } },
      });
    }
  }
}

export async function handleMcpRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "gaim", version: VERSION },
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw methodError(request.method);

  const name = request.params?.name;
  const input = request.params?.arguments ?? {};
  try {
    let result;
    if (name === "gaim_status") {
      result = await gaimCall("status");
    } else if (name === "gaim_history") {
      result = await gaimCall("history", input);
    } else if (name === "gaim_turn") {
      result = await gaimCall("turn", {
        message: input.message,
        speaker: {
          id: input.speaker_id ?? process.env.GAIM_SPEAKER_ID ?? "mcp-client",
          name: input.speaker_name ?? process.env.GAIM_SPEAKER_NAME ?? "MCP client",
        },
        request_id: input.request_id ?? randomUUID(),
        ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
      });
    } else {
      throw methodError(`tool ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (error) {
    const body = { error: { code: error.code ?? "INTERNAL_ERROR", message: error.message } };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
  }
}

function methodError(name) {
  return Object.assign(new Error(`Method not found: ${name}`), { code: "METHOD_NOT_FOUND" });
}

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runMcp();
