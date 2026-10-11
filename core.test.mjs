import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractEmbeddedSourceUrls,
  GaimCore,
  GaimError,
  isCompleteAnswerSnapshot,
  isSubmissionAccepted,
  JsonStateStore,
  resolveSources,
  responseErrorFromAnswer,
} from "./core.mjs";

class FakeBrowser {
  constructor() {
    this.calls = [];
    this.active = 0;
    this.maximumActive = 0;
    this.loginCalls = 0;
    this.shutdownOptions = [];
  }

  async ask(input) {
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.calls.push(structuredClone(input));
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    const index = this.calls.length;
    return {
      answer_markdown: `answer ${index}`,
      sources: [{ title: `source ${index}`, url: `https://example.com/${index}` }],
      conversation_url: input.conversationUrl ?? `https://google.test/conversation/${index}`,
      search_evidence: { fresh_search: true, source_count: 1, generation_complete: true },
    };
  }

  async status() {
    return { browser_connected: true, login_status: "ready", last_error: null };
  }

  async login() {
    this.loginCalls += 1;
    return { ok: true };
  }

  async shutdown(options) {
    this.shutdownOptions.push(options);
  }
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gaim-core-test-"));
  const browser = new FakeBrowser();
  const core = await new GaimCore({ browser, store: new JsonStateStore(directory), ...options }).initialize();
  return {
    browser,
    core,
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const codex = { id: "codex-main", name: "Codex" };
const claude = { id: "claude-reviewer", name: "Claude" };

test("only a new answer with its completed-response toolbar is complete", () => {
  const baseline = { rootKey: "old-answer" };
  const complete = {
    rootKey: "new-answer",
    answer: "A".repeat(81),
    completionVisible: true,
    stopVisible: false,
  };
  assert.equal(isCompleteAnswerSnapshot(baseline, complete), true);
  assert.equal(isCompleteAnswerSnapshot(baseline, { ...complete, rootKey: "old-answer" }), false);
  assert.equal(isCompleteAnswerSnapshot(baseline, { ...complete, completionVisible: false }), false);
  assert.equal(isCompleteAnswerSnapshot(baseline, { ...complete, stopVisible: true }), false);
});

test("submission confirmation uses page state instead of a fixed delay", () => {
  const baseline = {
    rootKey: "old-answer",
    url: "https://google.test/thread",
    composerValue: "pending question",
  };
  assert.equal(isSubmissionAccepted(baseline, {
    ...baseline, composerValue: "", stopVisible: false,
  }), true);
  assert.equal(isSubmissionAccepted(baseline, {
    ...baseline, rootKey: "new-answer", stopVisible: false,
  }), true);
  assert.equal(isSubmissionAccepted(baseline, {
    ...baseline, stopVisible: false,
  }), false);
});

test("Google's explicit empty-response block returns a clear error", () => {
  assert.deepEqual(responseErrorFromAnswer("There's no response available for this search. Try asking something else."), {
    code: "AI_RESPONSE_UNAVAILABLE",
    message: "Google AI Mode did not provide a response for this search.",
  });
  assert.equal(responseErrorFromAnswer("A normal researched answer."), null);
});

test("the core is the single owner of login and browser shutdown", async () => {
  const { browser, core, close } = await fixture();
  try {
    assert.deepEqual(await core.login(), { ok: true });
    await core.shutdown();
    assert.equal(browser.loginCalls, 1);
    assert.deepEqual(browser.shutdownOptions, [{ force: true }]);
  } finally {
    await close();
  }
});

test("embedded AI Mode metadata provides a direct-source fallback", () => {
  const html = '<!--[&quot;https://encrypted-tbn0.gstatic.com/faviconV2?url\\u003dhttps://example.com&quot;,'
    + '&quot;https://example.com&quot;,&quot;https://example.com/history/article&quot;]-->';
  assert.deepEqual(extractEmbeddedSourceUrls(html), ["https://example.com/history/article"]);
});

test("explicit answer sources win over unrelated embedded page metadata", async () => {
  const sources = await resolveSources([
    { title: "Node.js", url: "https://nodejs.org/en" },
    { title: "", url: "http://www.w3.org/2000/svg" },
  ], '<a href="https://unrelated.example/old-turn">old metadata</a>');
  assert.deepEqual(sources, [{ title: "Node.js", url: "https://nodejs.org/en" }]);
});

test("new turns are isolated unless a conversation id is supplied", async () => {
  const { core, close } = await fixture();
  try {
    const first = await core.turn({ speaker: codex, message: "first" });
    const second = await core.turn({ speaker: codex, message: "second" });
    assert.notEqual(first.conversation_id, second.conversation_id);

    const shared = await core.turn({
      conversation_id: first.conversation_id,
      speaker: claude,
      message: "follow up",
    });
    assert.equal(shared.conversation_id, first.conversation_id);
    const history = await core.history({ conversation_id: first.conversation_id });
    assert.deepEqual(history.turns.map((turn) => turn.speaker.id), ["codex-main", "claude-reviewer"]);
    assert.deepEqual(history.turns.map((turn) => turn.message), ["first", "follow up"]);
  } finally {
    await close();
  }
});

test("different conversations can run in parallel", async () => {
  const { browser, core, close } = await fixture();
  try {
    await Promise.all([
      core.turn({ speaker: codex, message: "one" }),
      core.turn({ speaker: claude, message: "two" }),
      core.turn({ speaker: codex, message: "three" }),
    ]);
    assert.ok(browser.maximumActive > 1);
  } finally {
    await close();
  }
});

test("turns in the same conversation are serialized", async () => {
  const { browser, core, close } = await fixture();
  try {
    const first = await core.turn({ speaker: codex, message: "first" });
    browser.maximumActive = 0;
    await Promise.all([
      core.turn({ conversation_id: first.conversation_id, speaker: codex, message: "two" }),
      core.turn({ conversation_id: first.conversation_id, speaker: claude, message: "three" }),
    ]);
    assert.equal(browser.maximumActive, 1);
  } finally {
    await close();
  }
});

test("parallel conversations respect the configured upper bound", async () => {
  const { browser, core, close } = await fixture({ maxParallel: 2 });
  try {
    await Promise.all(Array.from({ length: 5 }, (_, index) => core.turn({
      speaker: codex,
      message: `parallel ${index}`,
    })));
    assert.equal(browser.maximumActive, 2);
  } finally {
    await close();
  }
});

test("request ids make retries idempotent", async () => {
  const { browser, core, close } = await fixture();
  try {
    const request = { request_id: "request-1", speaker: codex, message: "once" };
    const first = await core.turn(request);
    const retry = await core.turn(request);
    assert.deepEqual(retry, first);
    assert.equal(browser.calls.length, 1);
  } finally {
    await close();
  }
});

test("an explicit unknown conversation never creates a replacement", async () => {
  const { core, close } = await fixture();
  try {
    await assert.rejects(
      core.turn({ conversation_id: "missing", speaker: codex, message: "hello" }),
      (error) => error instanceof GaimError && error.code === "CONVERSATION_NOT_FOUND",
    );
  } finally {
    await close();
  }
});
