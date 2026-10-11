#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { gaimCall } from "./client.mjs";
import { VERSION } from "./meta.mjs";

export class GaimAcpAgent {
  constructor() {
    this.sessions = new Map();
  }

  initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "gaim", version: VERSION },
    };
  }

  newSession() {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { conversationId: null });
    return { sessionId };
  }

  async prompt(params, client) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw Object.assign(new Error(`Unknown session: ${params.sessionId}`), { code: "SESSION_NOT_FOUND" });
    const message = promptText(params.prompt);
    let output;
    try {
      output = await this.runCommand(message, params.sessionId, session);
    } catch (error) {
      output = formatError(error, session.conversationId);
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: output },
      },
    });
    return { stopReason: "end_turn" };
  }

  async runCommand(message, sessionId, session) {
    if (message === "/status") return JSON.stringify(await gaimCall("status"), null, 2);
    if (message === "/history") {
      if (!session.conversationId) return "This ACP session has no GAIM conversation yet.";
      return JSON.stringify(await gaimCall("history", { conversation_id: session.conversationId }), null, 2);
    }
    if (message === "/new") {
      session.conversationId = null;
      return "The next message will start a new isolated GAIM conversation.";
    }
    if (message.startsWith("/join ")) {
      session.conversationId = message.slice(6).trim();
      await gaimCall("history", { conversation_id: session.conversationId, limit: 1 });
      return `This ACP session joined GAIM conversation ${session.conversationId}.`;
    }

    const result = await gaimCall("turn", {
      message,
      speaker: { id: `acp:${sessionId}`, name: "ACP client" },
      request_id: randomUUID(),
      ...(session.conversationId ? { conversation_id: session.conversationId } : {}),
    });
    session.conversationId = result.conversation_id;
    return formatTurn(result);
  }

  close(params) {
    this.sessions.delete(params.sessionId);
    return {};
  }
}

function promptText(blocks) {
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw Object.assign(new Error("A text prompt is required."), { code: "EMPTY_QUERY" });
  return text;
}

function formatTurn(result) {
  const sources = result.sources.length
    ? `\n\nSources (approximate):\n${result.sources.map((source) => `- [${source.title}](${source.url})`).join("\n")}`
    : "";
  return `${result.answer_markdown}${sources}\n\nGAIM conversation: ${result.conversation_id}\nSearch evidence: ${JSON.stringify(result.search_evidence)}`;
}

function formatError(error, conversationId) {
  return JSON.stringify({
    error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
    ...(conversationId ? { conversation_id: conversationId } : {}),
  }, null, 2);
}

export async function runAcp() {
  const agent = new GaimAcpAgent();
  process.stdin.resume();
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const connection = acp.agent({ name: "gaim" })
    .onRequest(acp.methods.agent.initialize, () => agent.initialize())
    .onRequest(acp.methods.agent.session.new, () => agent.newSession())
    .onRequest(acp.methods.agent.session.prompt, (context) => agent.prompt(context.params, context.client))
    .onRequest(acp.methods.agent.session.close, (context) => agent.close(context.params))
    .connect(stream);
  await connection.closed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAcp();
