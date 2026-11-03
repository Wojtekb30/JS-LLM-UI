const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto } = require("node:crypto");
const vm = require("node:vm");

// A small DOM stand-in exercises the real UI handlers and encrypted persistence.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {};
    this.style = {}; this.dataset = {}; this.disabled = false; this.hidden = false;
    this.checked = false; this._value = ""; this.textContent = "";
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {
    this.children = children;
    if (this.tagName === "SELECT") this.value = children[0]?.value || "";
  }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  async emit(name) { await Promise.all((this.listeners[name] || []).map((listener) => listener({ preventDefault() {}, stopPropagation() {} }))); }
  focus() {}
  setAttribute() {}
  querySelector(tag) {
    for (const child of this.children) {
      if (child.tagName === tag.toUpperCase()) return child;
      const nested = child.querySelector(tag); if (nested) return nested;
    }
    return null;
  }
}

function setup(generate, fetch, storage = new Map()) {
  const html = readFileSync(`${__dirname}/index.html`, "utf8");
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1]));
  elements.get("providerSelect").value = "openai";
  elements.get("openaiEnabled").checked = true;
  elements.get("geminiEnabled").checked = true;
  elements.get("ollamaEnabled").checked = false;
  elements.get("ollamaUrl").value = "http://localhost";
  elements.get("ollamaPort").value = "11434";
  elements.get("reasoningEffort").value = "default";
  elements.get("showReasoning").checked = true;
  const events = {};
  const window = { crypto: webcrypto, addEventListener(name, fn) { events[name] = fn; }, confirm: () => true, prompt: () => "Renamed chat", LLMProviders: { generate } };
  const context = vm.createContext({ window, document: { getElementById: (id) => elements.get(id), createElement: (tag) => new Element(tag), createTextNode: (text) => { const node = new Element("#text"); node.textContent = text; return node; }, querySelectorAll: () => [], body: new Element("body") }, location: { href: "https://local.test/", origin: "https://local.test" },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    crypto: webcrypto, TextEncoder, TextDecoder, URL, AbortController, btoa, atob, fetch, setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(readFileSync(`${__dirname}/providers.js`, "utf8"), context);
  window.LLMProviders.generate = generate;
  vm.runInContext(readFileSync(`${__dirname}/math.js`, "utf8"), context);
  vm.runInContext(readFileSync(`${__dirname}/markdown.js`, "utf8"), context);
  let source = readFileSync(`${__dirname}/app.js`, "utf8");
  source = source.replace(/\}\)\(\);\s*$/, "window.testApp = { state, createVault, unlockVault, lockVault, persist, renderAll, sendMessage, currentChat, editMessage, renameChat, newChat, generateReply }; })();");
  vm.runInContext(source, context);
  return { app: window.testApp, elements, storage, events };
}

test("chat generation persists files, controls, streamed summary and renamed title in encrypted vault", async () => {
  let received;
  const { app, elements, storage } = setup(async (chat, key, options, signal, update) => {
    received = { chat, key, options };
    update({ text: "Streamed answer", reasoning: "Provider summary", sources: [], notices: [], geminiParts: [] });
  });
  await app.createVault("test-password");
  assert.equal(app.state.vault.settings.renderMarkdown, true);
  app.state.vault.settings.models.openai = ["available-model"];
  app.state.vault.settings.keys.openai = "secret-api-key";
  app.renderAll();
  elements.get("reasoningEffort").value = "high";
  elements.get("webSearch").checked = true;
  app.state.attachments = [{ kind: "text", name: "notes.txt", text: "Private file content", size: 20 }];
  await app.sendMessage("Private prompt");
  const chat = app.currentChat();
  assert.equal(received.options.effort, "high");
  assert.equal(received.options.webSearch, true);
  assert.equal(received.key, "secret-api-key");
  assert.equal(chat.messages[0].attachments[0].name, "notes.txt");
  assert.equal(chat.messages[1].reasoning, "Provider summary");
  assert.equal(chat.messages[1].pending, undefined);
  app.renameChat(chat);
  await app.persist();
  const saved = [...storage.values()][0];
  for (const secret of ["Private prompt", "Private file content", "secret-api-key", "Provider summary", "Renamed chat"]) assert.ok(!saved.includes(secret));
  app.lockVault();
  await app.unlockVault("test-password");
  assert.equal(app.currentChat().title, "Renamed chat");
  assert.equal(app.currentChat().generation.effort, "high");
  assert.equal(app.currentChat().messages[1].text, "Streamed answer");
  assert.equal(app.currentChat().messages[0].attachments[0].text, "Private file content");
  elements.get("markdownEnabled").checked = false;
  elements.get("openaiKey").value = "secret-api-key";
  elements.get("geminiKey").value = "";
  await elements.get("settingsForm").emit("submit");
  assert.equal(app.state.vault.settings.renderMarkdown, false);
  app.lockVault();
  await app.unlockVault("test-password");
  assert.equal(app.state.vault.settings.renderMarkdown, false);
});

test("message edit truncates later turns, keeps attachments, and save-and-resend generates anew", async () => {
  let generations = 0;
  const { app, elements } = setup(async (chat, key, options, signal, update) => { generations++; update({ text: "New reply" }); });
  await app.createVault("test-password");
  app.state.vault.settings.models.openai = ["model"];
  app.state.vault.settings.keys.openai = "key";
  app.renderAll();
  await app.sendMessage("Original question");
  const chat = app.currentChat();
  const user = chat.messages[0];
  user.attachments = [{ kind: "text", name: "context.txt", text: "context", size: 7 }];
  const content = elements.get("messages").children[0].children[1];
  app.editMessage(chat, user, content);
  content.querySelector("textarea").value = "Edited question";
  const actions = content.children.at(-1);
  await actions.children.find((button) => button.textContent === "Save & resend").emit("click");
  assert.equal(generations, 2);
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].text, "Edited question");
  assert.equal(chat.messages[0].attachments[0].name, "context.txt");
  assert.equal(chat.messages[1].text, "New reply");
});

test("locking during generation aborts the request and retains encrypted partial response", async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { app } = setup(async (chat, key, options, signal, update) => {
    update({ text: "Partial reply" });
    started();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
  });
  await app.createVault("test-password");
  app.state.vault.settings.models.openai = ["model"];
  app.state.vault.settings.keys.openai = "key";
  app.renderAll();
  const sending = app.sendMessage("Question");
  await ready;
  app.lockVault();
  await sending;
  assert.equal(app.state.vault, null);
  // Wait for the encrypted save queued by Lock.
  await new Promise((resolve) => setImmediate(resolve));
  await app.unlockVault("test-password");
  const answer = app.currentChat().messages.at(-1);
  assert.equal(answer.text, "Partial reply");
  assert.equal(answer.stopped, true);
  assert.equal(answer.pending, undefined);
});

test("Ollama starts disabled and cannot be contacted before explicit opt-in", async () => {
  let generations = 0;
  const { app, elements } = setup(async () => { generations++; });
  await app.createVault("test-password");
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.vault.settings.sources)), { openai: true, gemini: true, ollama: false });
  app.state.vault.settings.models.ollama = ["llama3.2"];
  elements.get("providerSelect").value = "ollama";
  app.renderAll();
  await app.sendMessage("Local request must not be sent");
  assert.equal(generations, 0);
  assert.equal(app.state.vault.settings.sources.ollama, false);
});

test("Ollama dropdown offers booleans, persists False, and restores API effort choices", async () => {
  let received;
  const { app, elements } = setup(async (_chat, _key, options, _signal, update) => {
    received = options; update({ text: "OK" });
  });
  await app.createVault("test-password");
  app.state.vault.settings.sources.ollama = true;
  app.state.vault.settings.models.ollama = ["local-model"];
  elements.get("providerSelect").value = "ollama";
  await elements.get("providerSelect").emit("change");
  const effort = elements.get("reasoningEffort");
  assert.deepEqual(Array.from(effort.children, (option) => option.textContent), ["True", "False"]);
  assert.equal(effort.disabled, false);
  effort.value = "false";
  await app.sendMessage("No thinking please");
  assert.equal(received.effort, "false");
  app.lockVault();
  await app.unlockVault("test-password");
  assert.equal(effort.value, "false");
  assert.equal(app.currentChat().generation.effort, "false");
  elements.get("providerSelect").value = "openai";
  await elements.get("providerSelect").emit("change");
  assert.equal(effort.value, "default");
  assert.ok(effort.children.some((option) => option.value === "high"));
  assert.ok(!effort.children.some((option) => option.value === "false"));
});

test("explicit Ollama opt-in saves the configured URL and sends without an API key", async () => {
  let received;
  const { app, elements } = setup(async (chat, key, options, signal, update) => {
    received = { chat, key, options };
    update({ text: "Local response", reasoning: "Local thought", sources: [], notices: [] });
  });
  await app.createVault("test-password");
  elements.get("ollamaEnabled").checked = true;
  elements.get("ollamaUrl").value = "http://192.168.1.50";
  elements.get("ollamaPort").value = "11435";
  await elements.get("settingsForm").emit("submit");
  assert.equal(app.state.vault.settings.sources.ollama, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.state.vault.settings.ollama)), { url: "http://192.168.1.50", port: 11435 });
  app.state.vault.settings.models.ollama = ["llama3.2"];
  elements.get("providerSelect").value = "ollama";
  app.renderAll();
  await app.sendMessage("Hello local model");
  assert.equal(received.key, "");
  assert.equal(received.options.ollamaBaseUrl, "http://192.168.1.50:11435");
  assert.equal(received.options.webSearch, false);
  assert.equal(app.currentChat().messages.at(-1).text, "Local response");
});

test("Ollama key is encrypted, restored into settings, sent to chat, and cleared on lock", async () => {
  let receivedKey;
  const { app, elements, storage } = setup(async (_chat, key, _options, _signal, update) => {
    receivedKey = key; update({ text: "Authenticated response" });
  });
  await app.createVault("test-password");
  await elements.get("openSettings").emit("click");
  elements.get("ollamaEnabled").checked = true;
  elements.get("ollamaKey").value = "  private-ollama-token  ";
  await elements.get("settingsForm").emit("submit");
  assert.equal(app.state.vault.settings.keys.ollama, "private-ollama-token");
  assert.ok(![...storage.values()][0].includes("private-ollama-token"));
  app.lockVault();
  assert.equal(elements.get("ollamaKey").value, "");
  await app.unlockVault("test-password");
  await elements.get("openSettings").emit("click");
  assert.equal(elements.get("ollamaKey").value, "private-ollama-token");
  app.state.vault.settings.models.ollama = ["local-model"];
  elements.get("providerSelect").value = "ollama";
  app.renderAll();
  await app.sendMessage("Hello");
  assert.equal(receivedKey, "private-ollama-token");
});

test("Ollama refresh respects opt-in and persists the key used for discovery", async () => {
  const requests = [];
  const { app, elements } = setup(async () => {}, async (url, request) => {
    requests.push({ url, request });
    return Response.json({ models: [{ name: "local-model" }] });
  });
  await app.createVault("test-password");
  await elements.get("openSettings").emit("click");
  app.state.settingsProvider = "ollama";
  elements.get("ollamaKey").value = "discovery-token";
  await elements.get("refreshModels").emit("click");
  assert.equal(requests.length, 0);
  elements.get("ollamaEnabled").checked = true;
  await elements.get("refreshModels").emit("click");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://localhost:11434/api/tags");
  assert.equal(requests[0].request.headers.Authorization, "Bearer discovery-token");
  assert.equal(app.state.vault.settings.keys.ollama, "discovery-token");
  assert.equal(app.state.vault.settings.models.ollama[0], "local-model");
});

const VAULT_KEY = "local-llm-encrypted-vault-v1";

test("wrong passwords and ciphertext tampering do not unlock; saves use fresh nonces", async () => {
  const { app, storage } = setup();
  await app.createVault("correct-password");
  const original = storage.get(VAULT_KEY);
  await app.persist();
  assert.notEqual(JSON.parse(original).iv, JSON.parse(storage.get(VAULT_KEY)).iv);
  app.lockVault(false);
  await assert.rejects(app.unlockVault("wrong-password"));
  assert.equal(app.state.vault, null);
  const modified = JSON.parse(storage.get(VAULT_KEY));
  const bytes = Buffer.from(modified.ciphertext, "base64"); bytes[0] ^= 1;
  modified.ciphertext = bytes.toString("base64");
  storage.set(VAULT_KEY, JSON.stringify(modified));
  await assert.rejects(app.unlockVault("correct-password"));
  assert.equal(app.state.vault, null);
});

test("late vault creation and unlock cannot undo Lock or Reset", async () => {
  const { app, elements, storage } = setup();
  const creating = app.createVault("first-password");
  app.lockVault(false);
  await creating;
  assert.equal(app.state.vault, null);
  assert.equal(storage.size, 0);
  await app.createVault("first-password");
  app.lockVault(false);
  const unlocking = app.unlockVault("first-password");
  await elements.get("resetVault").emit("click");
  await unlocking;
  assert.equal(app.state.vault, null);
  assert.equal(storage.size, 0);
  await app.createVault("new-password");
  assert.equal(app.state.vault.chats.length, 0);
});

test("stale tabs cannot overwrite newer saves or resurrect a reset vault", async () => {
  const storage = new Map();
  const first = setup(undefined, undefined, storage);
  await first.app.createVault("shared-password");
  const second = setup(undefined, undefined, storage);
  await second.app.unlockVault("shared-password");
  second.app.state.vault.settings.keys.openai = "new-key";
  await second.app.persist();
  const newer = storage.get(VAULT_KEY);
  first.app.state.vault.settings.keys.openai = "stale-key";
  await assert.rejects(first.app.persist(), /stale save/);
  assert.equal(first.app.state.vault, null);
  assert.equal(storage.get(VAULT_KEY), newer);
  await first.app.unlockVault("shared-password");
  await second.elements.get("resetVault").emit("click");
  first.events.storage({ key: VAULT_KEY });
  assert.equal(first.app.state.vault, null);
  await first.app.persist();
  assert.equal(storage.size, 0);
});

test("separate browser stores cannot see each other's chats or keys", async () => {
  const first = setup(); const second = setup();
  await first.app.createVault("same-password");
  first.app.state.vault.settings.keys.openai = "first-user-only";
  first.app.newChat();
  first.app.currentChat().title = "Private conversation";
  await first.app.persist();
  await second.app.createVault("same-password");
  assert.equal(second.app.state.vault.settings.keys.openai, "");
  assert.equal(second.app.state.vault.chats.length, 0);
  assert.notEqual(first.storage.get(VAULT_KEY), second.storage.get(VAULT_KEY));
});

test("creation fails closed when localStorage is full", async () => {
  class FullStorage extends Map { set() { throw new Error("QuotaExceededError"); } }
  const { app, elements } = setup(undefined, undefined, new FullStorage());
  await assert.rejects(app.createVault("test-password"), /QuotaExceeded/);
  assert.equal(app.state.vault, null);
  assert.equal(app.state.cryptoKey, null);
  assert.notEqual(elements.get("authOverlay").hidden, true);
});

test("locking cancels model refresh and ignores late results from an earlier vault", async () => {
  let finish;
  let requestSignal;
  const { app, elements } = setup(undefined, (_url, request) => {
    requestSignal = request.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  await app.createVault("old-password");
  await elements.get("openSettings").emit("click");
  elements.get("ollamaEnabled").checked = true;
  elements.get("ollamaKey").value = "old-token";
  app.state.settingsProvider = "ollama";
  const refresh = elements.get("refreshModels").emit("click");
  app.lockVault(false);
  assert.equal(requestSignal.aborted, true);
  assert.equal(elements.get("ollamaKey").value, "");
  await elements.get("resetVault").emit("click");
  await app.createVault("new-password");
  finish(Response.json({ models: [{ name: "old-private-model" }] }));
  await refresh;
  assert.equal(app.state.vault.settings.keys.ollama, "");
  assert.equal(app.state.vault.settings.sources.ollama, false);
  assert.equal(app.state.vault.settings.models.ollama.length, 0);
  assert.ok(!elements.get("modelRefreshStatus").textContent.includes("old-private-model"));
});

test("an old chat cannot be generated with a newly unlocked vault's credentials", async () => {
  let requests = 0;
  const { app, elements } = setup(async () => { requests++; });
  await app.createVault("old-password");
  app.newChat(); const oldChat = app.currentChat();
  oldChat.messages.push({ role: "user", text: "Previous user's secret" });
  app.lockVault(false);
  await elements.get("resetVault").emit("click");
  await app.createVault("new-password");
  app.state.vault.settings.keys.openai = "new-user-key";
  await app.generateReply(oldChat);
  assert.equal(requests, 0);
});

test("draft attachments stay with their conversation and are cleared on lock", async () => {
  const { app, elements } = setup();
  await app.createVault("test-password");
  app.newChat(); const first = app.currentChat();
  elements.get("promptInput").value = "Private draft";
  app.state.attachments = [{ name: "private.txt", kind: "text", text: "Private data", size: 12 }];
  app.newChat();
  assert.equal(elements.get("promptInput").value, "");
  assert.equal(app.state.attachments.length, 0);
  app.state.activeChatId = first.id; app.renderAll();
  assert.equal(elements.get("promptInput").value, "Private draft");
  assert.equal(app.state.attachments[0].name, "private.txt");
  app.lockVault();
  await app.unlockVault("test-password");
  app.state.activeChatId = first.id; app.renderAll();
  assert.equal(elements.get("promptInput").value, "");
  assert.equal(app.state.attachments.length, 0);
});
