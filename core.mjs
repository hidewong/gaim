import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { systemChromePath } from "./platform.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  chrome: systemChromePath(),
  cdpHost: "127.0.0.1",
  cdpPort: Number(process.env.GAIM_CDP_PORT ?? 9224),
  userDataDir: process.env.GAIM_USER_DATA_DIR ?? join(homedir(), ".local", "share", "gaim", "chrome-profile"),
  aiModeUrl: process.env.GAIM_AI_MODE_URL ?? "https://www.google.com/ai",
  generationTimeoutMs: Number(process.env.GAIM_GENERATION_TIMEOUT_MS ?? 15_000),
  browserIdleMs: Number(process.env.GAIM_BROWSER_IDLE_MS ?? 60_000),
  minimumSources: Number(process.env.GAIM_MIN_SOURCES ?? 1),
  debugHtml: process.env.GAIM_DEBUG_HTML === "1",
  selectors: {
    composer: [
      "textarea[aria-label]",
      "textarea[placeholder]",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true'][aria-label]",
      "input[type='text'][aria-label]",
    ],
    answerRoot: ["[data-container-id='main-col']", "main", "[role='main']", "[aria-live='polite']"],
    stopControl: [
      "button[aria-label*='Stop' i]",
      "button[aria-label*='Cancel' i]",
      "[role='button'][aria-label*='Stop' i]",
    ],
    submitControl: [
      "button[aria-label='Send' i]",
      "[role='button'][aria-label='Send' i]",
    ],
    completionCopyControl: [
      "button[aria-label='Copy text' i]",
      "button[aria-label='Copy' i]",
      "button[aria-label='\u590d\u5236\u6587\u672c']",
      "button[aria-label='\u590d\u5236']",
    ],
    completionCompanionControl: [
      "button[aria-label='Share' i]",
      "button[aria-label='Good response' i]",
      "button[aria-label='Bad response' i]",
      "button[aria-label='More options for this response' i]",
      "button[aria-label='\u5206\u4eab']",
    ],
    aiModeTab: ["a", "button", "[role='tab']", "[role='link']"],
  },
  aiModeLabels: ["AI Mode"],
});

const SEARCH_DIRECTIVE = [
  "For this turn, perform a fresh and thorough Google web search before answering.",
  "Do not answer only from the existing conversation context.",
  "Cross-check multiple relevant sources when possible.",
].join(" ");

export class GaimError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GaimError";
    this.code = code;
    this.details = details;
  }
}

export class JsonStateStore {
  constructor(stateDir = process.env.GAIM_STATE_DIR ?? join(homedir(), ".local", "share", "gaim")) {
    this.stateDir = stateDir;
    this.file = join(stateDir, "state.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      return parsed.version === 1 ? parsed : emptyState();
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async save(state) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }
}

export class GaimCore {
  constructor({
    browser = new GoogleAiBrowser(),
    store = new JsonStateStore(),
    maxParallel = Number(process.env.GAIM_MAX_PARALLEL ?? 3),
  } = {}) {
    this.browser = browser;
    this.store = store;
    this.state = null;
    this.maxParallel = Number.isFinite(maxParallel) && maxParallel > 0 ? Math.floor(maxParallel) : 3;
    this.activeTurns = 0;
    this.turnWaiters = [];
    this.conversationQueues = new Map();
    this.inFlightRequests = new Map();
    this.saveQueue = Promise.resolve();
    this.queuedTurns = 0;
  }

  async initialize() {
    if (!this.state) this.state = await this.store.load();
    return this;
  }

  async turn(input) {
    await this.initialize();
    const request = validateTurn(input);
    const prior = this.state.requests[request.request_id];
    if (prior) return structuredClone(prior);
    const inFlight = this.inFlightRequests.get(request.request_id);
    if (inFlight) return structuredClone(await inFlight);

    const createdConversation = !request.conversation_id;
    const conversation = request.conversation_id
      ? this.state.conversations[request.conversation_id]
      : createConversation(this.state);
    if (!conversation) {
      throw new GaimError("CONVERSATION_NOT_FOUND", "The requested GAIM conversation does not exist.", {
        conversation_id: request.conversation_id,
      });
    }

    this.queuedTurns += 1;
    const previous = this.conversationQueues.get(conversation.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const existing = this.state.requests[request.request_id];
      if (existing) return structuredClone(existing);
      const result = await this.withTurnSlot(() => this.browser.ask({
        conversationId: conversation.id,
        conversationUrl: conversation.google_url,
        message: request.message,
        speaker: request.speaker,
      }));
      const turn = {
        turn_id: randomUUID(),
        request_id: request.request_id,
        speaker: request.speaker,
        message: request.message,
        answer: result.answer_markdown,
        sources: result.sources,
        search_evidence: result.search_evidence,
        created_at: new Date().toISOString(),
      };
      conversation.google_url = result.conversation_url;
      conversation.turns.push(turn);
      conversation.updated_at = turn.created_at;
      const response = {
        conversation_id: conversation.id,
        turn_id: turn.turn_id,
        answer_markdown: turn.answer,
        sources: turn.sources,
        search_evidence: turn.search_evidence,
        ...(result.raw_html_snippet ? { raw_html_snippet: result.raw_html_snippet } : {}),
      };
      this.state.requests[request.request_id] = response;
      await this.saveState();
      return structuredClone(response);
    });
    this.conversationQueues.set(conversation.id, operation);
    this.inFlightRequests.set(request.request_id, operation);
    try {
      return await operation;
    } catch (error) {
      if (createdConversation && conversation.turns.length === 0) {
        delete this.state.conversations[conversation.id];
      }
      throw error;
    } finally {
      this.queuedTurns -= 1;
      if (this.conversationQueues.get(conversation.id) === operation) {
        this.conversationQueues.delete(conversation.id);
      }
      if (this.inFlightRequests.get(request.request_id) === operation) {
        this.inFlightRequests.delete(request.request_id);
      }
    }
  }

  async saveState() {
    const snapshot = structuredClone(this.state);
    const operation = this.saveQueue.then(() => this.store.save(snapshot));
    this.saveQueue = operation.catch(() => undefined);
    await operation;
  }

  async withTurnSlot(callback) {
    await this.acquireTurnSlot();
    try {
      return await callback();
    } finally {
      this.releaseTurnSlot();
    }
  }

  async acquireTurnSlot() {
    if (this.activeTurns < this.maxParallel) {
      this.activeTurns += 1;
      return;
    }
    await new Promise((resolve) => this.turnWaiters.push(resolve));
  }

  releaseTurnSlot() {
    const next = this.turnWaiters.shift();
    if (next) next();
    else this.activeTurns -= 1;
  }

  async history(input) {
    await this.initialize();
    const conversationId = requiredString(input?.conversation_id, "conversation_id");
    const conversation = this.state.conversations[conversationId];
    if (!conversation) {
      throw new GaimError("CONVERSATION_NOT_FOUND", "The requested GAIM conversation does not exist.", {
        conversation_id: conversationId,
      });
    }
    const limit = Math.min(Math.max(Number(input?.limit ?? 50), 1), 200);
    return {
      conversation_id: conversation.id,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
      turns: structuredClone(conversation.turns.slice(-limit)),
    };
  }

  async status() {
    await this.initialize();
    return {
      ...(await this.browser.status()),
      conversation_count: Object.keys(this.state.conversations).length,
      queued_turns: this.queuedTurns,
      active_turns: this.activeTurns,
      max_parallel_turns: this.maxParallel,
    };
  }

  async login() {
    await this.initialize();
    return this.browser.login();
  }

  async shutdown() {
    await this.browser.shutdown?.({ force: true });
  }
}

export class GoogleAiBrowser {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config;
    this.lastError = null;
    this.ownsBrowser = false;
    this.idleTimer = null;
    this.conversationPages = new Map();
    this.submissionQueue = Promise.resolve();
  }

  baseUrl(path = "") {
    return `http://${this.config.cdpHost}:${this.config.cdpPort}${path}`;
  }

  async isConnected() {
    try {
      return (await fetch(this.baseUrl("/json/version"))).ok;
    } catch {
      return false;
    }
  }

  async ensureBrowser() {
    this.cancelIdleShutdown();
    if (await this.isConnected()) return;
    await mkdir(this.config.userDataDir, { recursive: true, mode: 0o700 });
    const chromeArguments = [
      "--start-minimized",
      `--remote-debugging-address=${this.config.cdpHost}`,
      `--remote-debugging-port=${this.config.cdpPort}`,
      `--user-data-dir=${this.config.userDataDir}`,
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--no-first-run",
      "--window-size=1440,1000",
      this.config.aiModeUrl,
    ];
    if (process.env.GAIM_NO_SANDBOX === "1") chromeArguments.unshift("--no-sandbox");
    const child = spawn(this.config.chrome, chromeArguments, { detached: true, stdio: "ignore" });
    child.unref();
    await waitUntil(() => this.isConnected(), 15_000, "BROWSER_UNAVAILABLE");
    this.ownsBrowser = true;
  }

  async login() {
    try {
      await access(this.config.chrome);
    } catch {
      throw new GaimError(
        "CHROME_NOT_FOUND",
        `System Google Chrome was not found at ${this.config.chrome}. Set GAIM_CHROME to its path.`,
      );
    }
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new GaimError(
        "LOGIN_DISPLAY_REQUIRED",
        "GAIM login requires a graphical desktop session in the first release.",
      );
    }

    await this.shutdown({ force: true });
    await mkdir(this.config.userDataDir, { recursive: true, mode: 0o700 });
    const chromeArguments = [
      `--remote-debugging-address=${this.config.cdpHost}`,
      `--remote-debugging-port=${this.config.cdpPort}`,
      `--user-data-dir=${this.config.userDataDir}`,
      "--disable-dev-shm-usage",
      "--no-first-run",
      this.config.aiModeUrl,
    ];
    if (process.env.GAIM_NO_SANDBOX === "1") chromeArguments.unshift("--no-sandbox");
    const exit = await new Promise((resolveExit, reject) => {
      const child = spawn(this.config.chrome, chromeArguments, { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    this.ownsBrowser = false;
    if (exit.code !== 0 && exit.code !== null) {
      throw new GaimError("LOGIN_BROWSER_FAILED", `Chrome exited with code ${exit.code}.`);
    }
    return { ok: true, message: "Login browser closed. Run `gaim status` to verify AI Mode availability." };
  }

  async openPage(url) {
    await this.ensureBrowser();
    const response = await fetch(this.baseUrl(`/json/new?${encodeURIComponent(url)}`), { method: "PUT" });
    if (!response.ok) throw new GaimError("BROWSER_UNAVAILABLE", `Chrome returned HTTP ${response.status}.`);
    return new CdpPage(await response.json()).connect();
  }

  async closePage(page) {
    page.closeSocket();
    await fetch(this.baseUrl(`/json/close/${page.target.id}`)).catch(() => undefined);
  }

  async findOpenPage(url) {
    if (!url) return null;
    await this.ensureBrowser();
    let targets;
    await waitUntil(async () => {
      try {
        const response = await fetch(this.baseUrl("/json/list"));
        if (!response.ok) return false;
        targets = await response.json();
        return Array.isArray(targets);
      } catch {
        return false;
      }
    }, 5_000, "BROWSER_UNAVAILABLE");
    const target = targets.find((item) => item.type === "page" && item.url === url);
    return target ? new CdpPage(target).connect() : null;
  }

  async status() {
    let page;
    try {
      await this.ensureBrowser();
      page = await this.openPage(this.config.aiModeUrl);
      const state = await enterAiMode(page, null, this.config);
      const loginStatus = state.error?.code === "NOT_LOGGED_IN" ? "not_logged_in"
        : state.error || !state.aiModeActive || !state.composerFound ? "unavailable" : "ready";
      this.lastError = state.error ?? null;
      return { browser_connected: true, login_status: loginStatus, page_url: state.url, last_error: this.lastError };
    } catch (error) {
      this.lastError = normalizeError(error);
      return { browser_connected: true, login_status: "unknown", last_error: this.lastError };
    } finally {
      if (page) await this.closePage(page);
      this.scheduleIdleShutdown();
    }
  }

  async ask({ conversationId, conversationUrl, message, speaker }) {
    let page = this.conversationPages.get(conversationId);
    try {
      let reusedPage = page?.socket.readyState === WebSocket.OPEN;
      if (!page || page.socket.readyState !== WebSocket.OPEN) {
        page = await this.findOpenPage(conversationUrl);
        reusedPage = Boolean(page);
        page ??= await this.openPage(conversationUrl ?? this.config.aiModeUrl);
        this.conversationPages.set(conversationId, page);
      }
      const initial = reusedPage
        ? await readPageState(page, this.config)
        : await enterAiMode(page, conversationUrl, this.config);
      if (initial.error) throw new GaimError(initial.error.code, initial.error.message, { url: initial.url });
      if (!initial.aiModeActive || !initial.composerFound) {
        throw new GaimError("COMPOSER_NOT_FOUND", "Google AI Mode prompt box was not found.", { url: initial.url });
      }

      const searchRequests = [];
      const removeNetworkListener = page.on("Network.requestWillBeSent", ({ request }) => {
        if (isSearchRequest(request.url)) searchRequests.push(request.url);
      });
      const submittedQuery = `${SEARCH_DIRECTIVE}\n\n[Speaker: ${speaker.name} (${speaker.id})]\n${message}`;
      await setComposerText(page, submittedQuery, this.config);
      const baseline = await readPageSnapshot(page, this.config);
      const submittedAt = new Date().toISOString();
      await this.submit(page, baseline);
      const result = await waitForCompleteAnswer(page, baseline, this.config);
      removeNetworkListener();

      const sources = await resolveSources(result.links, result.html);
      const evidence = {
        fresh_search: searchRequests.length > 0,
        search_request_count: searchRequests.length,
        source_count: sources.length,
        generation_complete: result.generationComplete,
        submitted_at: submittedAt,
        completed_at: new Date().toISOString(),
        answer_sha256: createHash("sha256").update(result.answer).digest("hex"),
      };
      if (!evidence.fresh_search || sources.length < this.config.minimumSources) {
        throw new GaimError(
          "SEARCH_EVIDENCE_INSUFFICIENT",
          "This turn did not produce enough evidence of a fresh web search.",
          evidence,
        );
      }
      this.lastError = null;
      return {
        answer_markdown: result.answer,
        sources,
        conversation_url: result.url,
        search_evidence: evidence,
        ...(this.config.debugHtml ? { raw_html_snippet: result.html.slice(0, 4_000) } : {}),
      };
    } catch (error) {
      this.lastError = normalizeError(error);
      throw error;
    } finally {
      this.scheduleIdleShutdown();
    }
  }

  async submit(page, baseline) {
    const operation = this.submissionQueue.then(async () => {
      if (!(await clickSubmit(page, this.config))) await pressEnter(page);
      if (await waitForSubmission(page, baseline, this.config)) return;
      if (await clickSubmit(page, this.config)) {
        if (await waitForSubmission(page, baseline, this.config)) return;
      }
      throw new GaimError("SUBMISSION_FAILED", "Google AI Mode did not accept the prompt.");
    });
    this.submissionQueue = operation.catch(() => undefined);
    return operation;
  }

  cancelIdleShutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdleShutdown() {
    this.cancelIdleShutdown();
    if (!this.ownsBrowser || this.config.browserIdleMs <= 0 || this.conversationPages.size > 0) return;
    this.idleTimer = setTimeout(() => void this.shutdown(), this.config.browserIdleMs);
    this.idleTimer.unref();
  }

  async shutdown({ force = false } = {}) {
    this.cancelIdleShutdown();
    if ((!this.ownsBrowser && !force) || !(await this.isConnected())) return;
    try {
      const version = await fetch(this.baseUrl("/json/version")).then((response) => response.json());
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await delay(250);
      socket.close();
    } catch {
      // Chrome may already be gone.
    } finally {
      this.ownsBrowser = false;
      this.conversationPages.clear();
    }
  }
}

class CdpPage {
  constructor(target) {
    this.target = target;
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve();
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    return this;
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? "Browser evaluation failed");
    return result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await waitUntil(async () => {
      const state = await this.evaluate("document.readyState");
      return state === "interactive" || state === "complete";
    }, 30_000, "PAGE_LOAD_TIMEOUT");
    await delay(1_000);
  }

  closeSocket() {
    this.socket.close();
  }
}

function emptyState() {
  return { version: 1, conversations: {}, requests: {} };
}

function createConversation(state) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const conversation = { id, google_url: null, created_at: now, updated_at: now, turns: [] };
  state.conversations[id] = conversation;
  return conversation;
}

function validateTurn(input) {
  const speaker = input?.speaker;
  return {
    conversation_id: optionalString(input?.conversation_id, "conversation_id"),
    request_id: optionalString(input?.request_id, "request_id") ?? randomUUID(),
    message: requiredString(input?.message, "message"),
    speaker: {
      id: requiredString(speaker?.id, "speaker.id"),
      name: requiredString(speaker?.name, "speaker.name"),
    },
  };
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GaimError("INVALID_REQUEST", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

async function readPageState(page, config) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const composer = ${JSON.stringify(config.selectors.composer)}
      .flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    const text = document.body?.innerText ?? '';
    let error = null;
    if (!composer && /captcha|unusual traffic|not a robot|verify you are human/i.test(text)) {
      error = { code: 'HUMAN_VERIFICATION', message: 'Google requires human verification.' };
    } else if (!composer && /AI Mode is not currently available|AI Mode isn.t available/i.test(text)) {
      error = { code: 'AI_MODE_UNAVAILABLE', message: 'Google AI Mode is unavailable for this device, region, or account.' };
    } else if (!composer && /sign in/i.test(text)) {
      error = { code: 'NOT_LOGGED_IN', message: 'The dedicated Google profile is not signed in.' };
    }
    const current = new URL(location.href);
    const aiModeActive = current.pathname === '/ai'
      || current.searchParams.get('udm') === '50'
      || current.searchParams.get('aep') === '11';
    return { url: location.href, aiModeActive, composerFound: Boolean(composer), error };
  })()`);
}

async function enterAiMode(page, conversationUrl, config) {
  await page.navigate(conversationUrl ?? config.aiModeUrl);
  let state = await readPageState(page, config);
  if (state.aiModeActive && state.composerFound && !state.error) return state;
  if (conversationUrl) return state;
  if (["HUMAN_VERIFICATION", "NOT_LOGGED_IN"].includes(state.error?.code)) return state;

  const directFailure = state.error;
  await page.navigate("https://www.google.com/search?q=Google");
  const clicked = await clickAiModeTab(page, config);
  if (!clicked) return directFailure ? { ...state, error: directFailure } : state;
  try {
    await waitUntil(async () => {
      state = await readPageState(page, config);
      return state.aiModeActive || Boolean(state.error);
    }, 15_000, "AI_MODE_NAVIGATION_TIMEOUT");
  } catch (error) {
    if (directFailure) return { ...state, error: directFailure };
    throw error;
  }
  return state;
}

async function clickAiModeTab(page, config) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labels = ${JSON.stringify(config.aiModeLabels)}.map((label) => label.toLocaleLowerCase());
    const elements = ${JSON.stringify(config.selectors.aiModeTab)}
      .flatMap((selector) => [...document.querySelectorAll(selector)]);
    const target = elements.find((element) => {
      if (!visible(element)) return false;
      const label = (element.getAttribute('aria-label') || element.innerText || '').trim().toLocaleLowerCase();
      return labels.includes(label);
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function setComposerText(page, text, config) {
  const result = await page.evaluate(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const element = ${JSON.stringify(config.selectors.composer)}
      .flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    if (!element) return false;
    const text = ${JSON.stringify(text)};
    element.focus();
    if (element.isContentEditable) element.textContent = text;
    else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!result) throw new GaimError("COMPOSER_NOT_FOUND", "Google AI Mode prompt box disappeared.");
}

async function pressEnter(page) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

async function clickSubmit(page, config) {
  const point = await page.evaluate(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const button = ${JSON.stringify(config.selectors.submitControl)}
      .flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    if (!button) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  await page.send("Page.bringToFront");
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
  });
  return true;
}

async function readPageSnapshot(page, config) {
  return page.evaluate(`(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    let root = null;
    for (const selector of ${JSON.stringify(config.selectors.answerRoot)}) {
      const matches = [...document.querySelectorAll(selector)].filter(visible);
      if (matches.length) {
        root = matches.at(-1);
        break;
      }
    }
    root ??= document.body;
    const composer = ${JSON.stringify(config.selectors.composer)}
      .flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    const stopVisible = ${JSON.stringify(config.selectors.stopControl)}
      .some((selector) => [...document.querySelectorAll(selector)].some(visible));
    const completionVisible = ${JSON.stringify(config.selectors.completionCopyControl)}
      .some((selector) => [...root.querySelectorAll(selector)].some(visible))
      && ${JSON.stringify(config.selectors.completionCompanionControl)}
        .some((selector) => [...root.querySelectorAll(selector)].some(visible));
    return {
      url: location.href,
      rootKey: root.getAttribute('jsuid') || root.getAttribute('data-container-id') || root.tagName,
      answer: (root?.innerText ?? '').trim(),
      html: root?.innerHTML ?? '',
      stopVisible,
      completionVisible,
      composerValue: composer ? (composer.value ?? composer.textContent ?? '').trim() : null,
      links: [...root.querySelectorAll('a[href]')].map((link) => ({
        title: (link.innerText || link.getAttribute('aria-label') || link.title || '').trim(),
        url: link.href,
      })),
    };
  })()`);
}

async function waitForSubmission(page, baseline, config) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8_000) {
    await delay(250);
    const current = await readPageSnapshot(page, config);
    if (isSubmissionAccepted(baseline, current)) return true;
  }
  return false;
}

export function isSubmissionAccepted(baseline, current) {
  return current.rootKey !== baseline.rootKey
    || current.url !== baseline.url
    || current.stopVisible === true
    || (baseline.composerValue && current.composerValue === "");
}

async function waitForCompleteAnswer(page, baseline, config) {
  const startedAt = Date.now();
  let responseStarted = false;
  let completionMarkerSeen = false;
  while (Date.now() - startedAt < config.generationTimeoutMs) {
    await delay(1_000);
    const state = await readPageState(page, config);
    if (state.error) throw new GaimError(state.error.code, state.error.message, { url: state.url });
    const current = await readPageSnapshot(page, config);
    if (current.rootKey !== baseline.rootKey) responseStarted = true;
    const responseError = responseStarted ? responseErrorFromAnswer(current.answer) : null;
    if (responseError) throw new GaimError(responseError.code, responseError.message, { url: current.url });
    if (current.completionVisible) completionMarkerSeen = true;
    if (isCompleteAnswerSnapshot(baseline, current)) {
      return { ...current, generationComplete: true };
    }
  }
  throw new GaimError("GENERATION_TIMEOUT", "Google AI Mode did not finish before the timeout.", {
    timeout_ms: config.generationTimeoutMs,
    response_started: responseStarted,
    completion_marker_seen: completionMarkerSeen,
  });
}

export function responseErrorFromAnswer(answer) {
  if (/no response available for this search|couldn['\u2019]t generate a response|unable to generate a response/i.test(answer)) {
    return {
      code: "AI_RESPONSE_UNAVAILABLE",
      message: "Google AI Mode did not provide a response for this search.",
    };
  }
  return null;
}

export function isCompleteAnswerSnapshot(baseline, current) {
  return current.rootKey !== baseline.rootKey
    && current.completionVisible === true
    && current.stopVisible === false
    && current.answer.length > 80;
}

export async function resolveSources(links, html) {
  const sources = [];
  const seen = new Set();
  const labeledLinks = links.filter((link) => link.title.trim() && isPotentialSourceUrl(link.url));
  const gotoLinks = labeledLinks.filter((link) => isGoogleGotoUrl(link.url));
  const candidates = [...new Map((gotoLinks.length ? gotoLinks : labeledLinks)
    .map((link) => [link.url, link])).values()].slice(0, 24);
  const resolved = await mapConcurrent(candidates, 4, async (link) => ({
    link,
    url: await resolveSourceUrl(link.url),
  }));
  for (const { link, url } of resolved) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = link.title.replace(/\. Opens in new tab\.?$/i, "").trim();
    sources.push({ title: title || new URL(url).hostname, url });
  }
  if (sources.length === 0) {
    for (const url of extractEmbeddedSourceUrls(html)) {
      if (seen.has(url)) continue;
      seen.add(url);
      sources.push({ title: new URL(url).hostname, url });
    }
  }
  return sources;
}

export function extractEmbeddedSourceUrls(html) {
  const decoded = String(html ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("\\u003d", "=")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\/", "/");
  const urls = [];
  for (const match of decoded.match(/https?:\/\/[^\s"'<>\\]+/g) ?? []) {
    const url = unwrapGoogleUrl(match.replace(/[),.;]+$/, ""));
    if (!url) continue;
    const hostname = new URL(url).hostname.toLowerCase();
    if (/(^|\.)(gstatic|googleusercontent)\.com$/.test(hostname)) continue;
    if (hostname === "www.w3.org" && /^\/\d{4}\/(svg|xhtml|xml)/i.test(new URL(url).pathname)) continue;
    urls.push(url);
  }
  const unique = [...new Set(urls)];
  return unique.filter((value) => {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search) return true;
    return !unique.some((other) => {
      const candidate = new URL(other);
      return candidate.hostname === url.hostname && (candidate.pathname !== "/" || candidate.search);
    });
  }).slice(0, 24);
}

function isPotentialSourceUrl(value) {
  if (isGoogleGotoUrl(value)) return true;
  const url = unwrapGoogleUrl(value);
  if (!url) return false;
  const parsed = new URL(url);
  return !(parsed.hostname === "www.w3.org" && /^\/\d{4}\/(svg|xhtml|xml)/i.test(parsed.pathname));
}

async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isGoogleGotoUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)google\./i.test(url.hostname) && url.pathname === "/goto";
  } catch {
    return false;
  }
}

async function resolveSourceUrl(value) {
  if (!isGoogleGotoUrl(value)) return unwrapGoogleUrl(value);
  try {
    const response = await fetch(value, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Mozilla/5.0" },
    });
    await response.body?.cancel().catch(() => undefined);
    return unwrapGoogleUrl(response.url);
  } catch {
    return null;
  }
}

function unwrapGoogleUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (/(^|\.)google\./i.test(url.hostname)) {
      if (url.pathname === "/url") {
        const target = url.searchParams.get("q") ?? url.searchParams.get("url");
        return target ? unwrapGoogleUrl(target) : null;
      }
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isSearchRequest(value) {
  try {
    const url = new URL(value);
    return /(^|\.)google\./i.test(url.hostname)
      && /(\/search|batchexecute|\/async\/|udm=50|aep=)/i.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

export function normalizeError(error) {
  if (error instanceof GaimError) return { code: error.code, message: error.message, ...error.details };
  return {
    code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function waitUntil(check, timeoutMs, code) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await delay(250);
  }
  throw new GaimError(code, `Timed out after ${timeoutMs} ms.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
