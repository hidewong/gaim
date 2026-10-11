#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { gaimCall } from "./client.mjs";

const firstQuestion = process.argv[2] ?? "What changed in the latest stable Node.js release? Use current sources.";
const followUp = process.argv[3] ?? "Expand the most important change and search for additional primary sources.";
const speaker = { id: "e2e-self-test", name: "GAIM self-test" };

const first = await gaimCall("turn", {
  message: firstQuestion,
  speaker,
  request_id: randomUUID(),
});
print("FIRST TURN", first);

const second = await gaimCall("turn", {
  conversation_id: first.conversation_id,
  message: followUp,
  speaker,
  request_id: randomUUID(),
});
print("FOLLOW-UP", second);

function print(label, result) {
  process.stdout.write(`\n=== ${label} ===\n${JSON.stringify(result, null, 2)}\n`);
}
