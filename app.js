(() => {
  "use strict";
  const VAULT_KEY = "local-llm-encrypted-vault-v1";
  const ITERATIONS = 310000;
  const $ = (id) => document.getElementById(id);
  const state = { vault: null, cryptoKey: null, activeChatId: null, busy: false, settingsProvider: "openai", authMode: "unlock", toastTimer: null, attachments: [], readingFiles: false, controller: null, streamingChatId: null, saveGeneration: 0 };
  let saveQueue = Promise.resolve();
  let storedRecord = null;
  let session = 0;
  let refreshController = null;
  let draftChatId = null;
  const drafts = new Map();
  const messageNodes = new WeakMap();
  const elements = {
    authOverlay: $("authOverlay"), authForm: $("authForm"), authTitle: $("authTitle"), authDescription: $("authDescription"), passwordInput: $("passwordInput"), confirmPassword: $("confirmPassword"), confirmPasswordWrap: $("confirmPasswordWrap"), authSubmit: $("authSubmit"), authError: $("authError"), resetVault: $("resetVault"),
    chatList: $("chatList"), messages: $("messages"), conversation: $("conversation"), providerSelect: $("providerSelect"), modelSelect: $("modelSelect"), promptInput: $("promptInput"), sendButton: $("sendButton"), settingsOverlay: $("settingsOverlay"), openaiKey: $("openaiKey"), geminiKey: $("geminiKey"), toast: $("toast")
  };

  function bytesToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  async function deriveKey(password, salt) {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  function withStorageLock(action) {
    return globalThis.navigator?.locks ? navigator.locks.request(VAULT_KEY, action) : Promise.resolve().then(action);
  }
  function storageConflict() {
    state.saveGeneration++;
    lockVault(false);
    elements.authError.textContent = "The vault changed in another tab. Unlock again to load the latest saved data.";
  }
  async function encryptVault(vault, key, salt) {
    const generation = state.saveGeneration;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(vault));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    if (generation !== state.saveGeneration) return;
    const record = JSON.stringify({ version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) });
    await withStorageLock(() => {
      if (generation !== state.saveGeneration) return;
      if (localStorage.getItem(VAULT_KEY) !== storedRecord) {
        storageConflict();
        throw new Error("The vault was updated elsewhere; this stale save was cancelled.");
      }
      localStorage.setItem(VAULT_KEY, record);
      storedRecord = record;
    });
  }
  function emptyVault() {
    return { settings: {
      keys: { openai: "", gemini: "", ollama: "" }, models: { openai: [], gemini: [], ollama: [] },
      sources: { openai: true, gemini: true, ollama: false },
      ollama: { url: "http://localhost", port: 11434 }, renderMarkdown: true
    }, chats: [], createdAt: new Date().toISOString() };
  }
  function makeId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  function newChat() {
    if (!state.vault) return;
    const provider = elements.providerSelect.value || "openai";
    const chat = { id: makeId(), title: "New conversation", provider, model: elements.modelSelect.value || "", generation: generationOptions(), messages: [], updatedAt: new Date().toISOString() };
    if (!state.activeChatId) drafts.set(chat.id, { text: elements.promptInput.value, attachments: state.attachments });
    state.vault.chats.unshift(chat);
    state.activeChatId = chat.id;
    persist().then(renderAll).catch(showError);
    renderAll();
  }
  function currentChat() {
    return state.vault?.chats.find((chat) => chat.id === state.activeChatId) || null;
  }
  async function persist() {
    if (!state.vault || !state.cryptoKey || !state.salt) return;
    const snapshot = JSON.parse(JSON.stringify(state.vault));
    const key = state.cryptoKey;
    const salt = state.salt;
    const generation = state.saveGeneration;
    const save = saveQueue.catch(() => {}).then(() => {
      if (generation === state.saveGeneration) return encryptVault(snapshot, key, salt);
    });
    saveQueue = save;
    await save;
  }
  function showError(error) {
    if (!state.vault) return;
    showToast(error?.message || "Something went wrong.");
  }
  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4000);
  }
  function setAuthMode(mode) {
    state.authMode = mode;
    const isCreate = mode === "create";
    $("authTitle").textContent = isCreate ? "Create your private vault" : "Unlock your vault";
    $("authDescription").textContent = isCreate ? "Choose a password to encrypt chats and API keys stored on this device." : "Enter your password to decrypt your chats and API keys on this device.";
    $("passwordLabel").textContent = isCreate ? "Create a password" : "Vault password";
    elements.passwordInput.autocomplete = isCreate ? "new-password" : "current-password";
    elements.passwordInput.value = "";
    elements.confirmPassword.value = "";
    elements.confirmPasswordWrap.hidden = !isCreate;
    elements.authSubmit.textContent = isCreate ? "Create encrypted vault" : "Unlock vault";
    elements.resetVault.hidden = isCreate;
    elements.authError.textContent = "";
    setTimeout(() => elements.passwordInput.focus(), 30);
  }
  async function createVault(password) {
    const attempt = ++session;
    if (localStorage.getItem(VAULT_KEY)) throw new Error("A vault already exists. Unlock or reset it first.");
    storedRecord = null;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    if (attempt !== session) return;
    const vault = emptyVault();
    await encryptVault(vault, key, salt);
    if (attempt !== session) return;
    state.vault = vault;
    state.cryptoKey = key;
    state.salt = salt;
    unlockUI();
  }
  async function unlockVault(password) {
    const attempt = ++session;
    await saveQueue.catch(() => {});
    if (attempt !== session) return;
    const record = localStorage.getItem(VAULT_KEY);
    const stored = JSON.parse(record);
    if (!stored || stored.version !== 1) throw new Error("The saved vault format is not supported.");
    const salt = base64ToBytes(stored.salt);
    const key = await deriveKey(password, salt);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(stored.iv) }, key, base64ToBytes(stored.ciphertext));
    const vault = JSON.parse(new TextDecoder().decode(plaintext));
    if (attempt !== session) return;
    if (record !== localStorage.getItem(VAULT_KEY)) { storageConflict(); return; }
    if (!vault || !Array.isArray(vault.chats) || !vault.settings) throw new Error("The vault data is invalid.");
    vault.settings.keys ||= { openai: "", gemini: "" };
    vault.settings.models ||= {};
    vault.settings.sources = { openai: true, gemini: true, ollama: false, ...(vault.settings.sources || {}) };
    vault.settings.ollama = { url: "http://localhost", port: 11434, ...(vault.settings.ollama || {}) };
    for (const chat of vault.chats) for (const message of chat.messages) {
      if (message.pending) { delete message.pending; message.stopped = true; }
    }
    state.vault = vault;
    storedRecord = record;
    state.cryptoKey = key;
    state.salt = salt;
    state.activeChatId = vault.chats[0]?.id || null;
    unlockUI();
  }
  function unlockUI() {
    $("app").inert = false;
    elements.authOverlay.hidden = true;
    if (!state.activeChatId) {
      const mostRecent = state.vault.chats[0];
      if (mostRecent) state.activeChatId = mostRecent.id;
    }
    renderAll();
    elements.promptInput.focus();
  }
  function lockVault(save = true) {
    session++;
    refreshController?.abort();
    refreshController = null;
    state.controller?.abort();
    // Save a final encrypted snapshot, including any partial streamed answer.
    if (save && state.vault) {
      for (const chat of state.vault.chats) for (const message of chat.messages) {
        if (message.pending) { delete message.pending; message.stopped = true; }
      }
      persist().catch(() => {});
    }
    state.vault = null;
    state.cryptoKey = null;
    state.salt = null;
    state.activeChatId = null;
    state.busy = false;
    state.controller = null;
    state.streamingChatId = null;
    state.attachments = [];
    drafts.clear(); draftChatId = null;
    state.readingFiles = false;
    $("app").inert = true;
    clearTimeout(state.toastTimer);
    elements.toast.hidden = true; elements.toast.textContent = "";
    $("modelRefreshStatus").textContent = "";
    $("refreshModels").disabled = false;
    $("refreshModels").textContent = "↻ Refresh model list";
    elements.modelSelect.replaceChildren();
    $("fileInput").value = "";
    $("ollamaUrl").value = "http://localhost";
    $("ollamaPort").value = "11434";
    renderDraftAttachments();
    $("stopGeneration").hidden = true;
    $("app").classList.remove("sidebar-open");
    elements.messages.replaceChildren();
    elements.chatList.replaceChildren();
    elements.promptInput.value = "";
    elements.promptInput.style.height = "auto";
    elements.openaiKey.value = "";
    elements.geminiKey.value = "";
    $("ollamaKey").value = "";
    elements.settingsOverlay.hidden = true;
    elements.sendButton.disabled = false;
    elements.authOverlay.hidden = false;
    try { setAuthMode(localStorage.getItem(VAULT_KEY) ? "unlock" : "create"); }
    catch { elements.authError.textContent = "Browser storage is unavailable. Allow site storage and reload."; }
  }
  function modelsFor(provider) {
    const models = state.vault?.settings?.models?.[provider];
    return Array.isArray(models) ? models : [];
  }
  function sourceEnabled(provider) {
    return state.vault?.settings?.sources?.[provider] === true;
  }
  function syncProviderOptions() {
    const ollamaOption = elements.providerSelect.querySelector('option[value="ollama"]');
    if (ollamaOption) {
      ollamaOption.disabled = !sourceEnabled("ollama");
      ollamaOption.textContent = sourceEnabled("ollama") ? "Ollama" : "Ollama (disabled)";
    }
    for (const option of elements.providerSelect.options || []) {
      if (["openai", "gemini"].includes(option.value)) option.disabled = !sourceEnabled(option.value);
    }
  }
  function setProvider(provider, chat = currentChat()) {
    const models = modelsFor(provider);
    const previousModel = elements.modelSelect.value;
    elements.providerSelect.value = provider;
    const options = models.map((model) => {
      const option = document.createElement("option"); option.value = model; option.textContent = model; return option;
    });
    if (chat) {
      const providerChanged = chat.provider !== provider;
      chat.provider = provider;
      if (providerChanged && !models.length) chat.model = "";
      if (models.length && !models.includes(chat.model)) chat.model = models[0];
      if (chat.model && !models.includes(chat.model)) {
        const savedOption = document.createElement("option");
        savedOption.value = chat.model;
        savedOption.textContent = `${chat.model} (saved in this chat)`;
        options.unshift(savedOption);
      }
    }
    if (!models.length && !(chat && chat.model)) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Refresh model list in settings";
      options.unshift(placeholder);
    }
    elements.modelSelect.replaceChildren(...options);
    if (chat) elements.modelSelect.value = chat.model || "";
    else elements.modelSelect.value = models.includes(previousModel) ? previousModel : models[0] || "";
    elements.modelSelect.disabled = !models.length && !(chat && chat.model);
    const effort = $("reasoningEffort");
    const selected = chat?.generation?.effort || effort.value;
    const choices = provider === "ollama"
      ? [["true", "True"], ["false", "False"]]
      : [["default", "Model default"], ["none", "None"], ["minimal", "Minimal"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Maximum"]];
    effort.replaceChildren(...choices.map(([value, label]) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
    }));
    effort.value = choices.some(([value]) => value === selected) ? selected
      : provider === "ollama" ? (chat?.generation?.showReasoning === false ? "false" : "true") : "default";
    if (chat?.generation) chat.generation.effort = effort.value;
    effort.disabled = state.busy;
    $("webSearch").disabled = state.busy || provider === "ollama";
    $("generationProviderNote").hidden = provider !== "ollama";
  }
  function renderChats() {
    elements.chatList.replaceChildren();
    for (const chat of state.vault.chats) {
      const row = document.createElement("div");
      row.className = `chat-row${chat.id === state.activeChatId ? " active" : ""}`;
      const title = document.createElement("button"); title.className = "chat-title"; title.textContent = chat.title || "New conversation";
      title.addEventListener("click", () => { state.activeChatId = chat.id; $("app").classList.remove("sidebar-open"); renderAll(); });
      const rename = document.createElement("button"); rename.className = "rename-chat"; rename.textContent = "✎"; rename.title = "Rename conversation";
      rename.setAttribute("aria-label", `Rename ${chat.title}`);
      rename.addEventListener("click", () => renameChat(chat));
      const remove = document.createElement("button"); remove.className = "delete-chat"; remove.textContent = "×"; remove.title = "Delete conversation";
      remove.setAttribute("aria-label", `Delete ${chat.title}`);
      remove.addEventListener("click", (event) => { event.stopPropagation(); deleteChat(chat.id); });
      row.append(title, rename, remove);
      elements.chatList.append(row);
    }
  }
  function renderMessages() {
    elements.messages.replaceChildren();
    const chat = currentChat();
    if (!chat || !chat.messages.length) {
      const welcome = document.createElement("div"); welcome.className = "welcome";
      const icon = document.createElement("div"); icon.className = "welcome-icon"; icon.textContent = "⚙";
      const heading = document.createElement("h1"); heading.textContent = "What would you like to explore?";
      const description = document.createElement("p"); description.textContent = "Choose a model, add its API key in settings, and start a conversation. Your chats stay encrypted in this browser.";
      welcome.append(icon, heading, description); elements.messages.append(welcome); return;
    }
    for (const message of chat.messages) {
      const wrapper = document.createElement("article"); wrapper.className = `message ${message.role}${message.error ? " error" : ""}`;
      const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = message.role === "user" ? "Y" : "⚙";
      const content = document.createElement("div"); content.className = "message-content";
      const role = document.createElement("div"); role.className = "message-role"; role.textContent = message.role === "user" ? "You" : message.error ? "Error" : "Assistant";
      const text = document.createElement("div"); text.className = "message-text";
      const copy = document.createElement("button"); copy.className = "copy-message"; copy.textContent = "Copy";
      copy.setAttribute("aria-label", "Copy entire message");
      copy.addEventListener("click", () => copyText(message.text || "", copy));
      const reasoning = document.createElement("details"); reasoning.className = "reasoning-panel";
      const summary = document.createElement("summary"); summary.textContent = "Reasoning summary";
      const reasoningText = document.createElement("div"); reasoning.append(summary, reasoningText);
      const notices = document.createElement("div"); notices.className = "message-notices";
      const sources = document.createElement("div"); sources.className = "message-sources";
      const files = document.createElement("div"); files.className = "attachment-list";
      for (const file of message.attachments || []) {
        const badge = document.createElement("span"); badge.className = "attachment-chip"; badge.textContent = file.name; files.append(badge);
      }
      const edit = document.createElement("button"); edit.className = "message-edit"; edit.textContent = "Edit"; edit.disabled = state.busy;
      edit.addEventListener("click", () => editMessage(chat, message, content));
      content.append(role, files, reasoning, text, notices, sources, copy, edit);
      messageNodes.set(message, { text, reasoning, reasoningText, notices, sources, copy });
      updateMessage(message);
      wrapper.append(avatar, content); elements.messages.append(wrapper);
    }
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
  }
  function renderAll() {
    if (!state.vault) return;
    if (draftChatId !== state.activeChatId) {
      drafts.set(draftChatId, { text: elements.promptInput.value, attachments: state.attachments });
      const draft = drafts.get(state.activeChatId);
      elements.promptInput.value = draft?.text || "";
      state.attachments = draft?.attachments || [];
      draftChatId = state.activeChatId;
      renderDraftAttachments();
    }
    syncProviderOptions();
    renderChats();
    const chat = currentChat();
    if (chat) setProvider(chat.provider, chat);
    else setProvider(elements.providerSelect.value || "openai", null);
    if (chat) {
      const options = chat.generation || { effort: "default", webSearch: false, showReasoning: true };
      $("webSearch").checked = options.webSearch;
      $("showReasoning").checked = options.showReasoning;
    }
    elements.providerSelect.disabled = state.busy;
    elements.modelSelect.disabled ||= state.busy;
    for (const id of ["reasoningEffort", "webSearch", "showReasoning"]) $(id).disabled = state.busy;
    const ollamaSelected = elements.providerSelect.value === "ollama";
    $("reasoningEffort").disabled = state.busy;
    $("webSearch").disabled = state.busy || ollamaSelected;
    $("generationProviderNote").hidden = !ollamaSelected;
    elements.sendButton.disabled = state.busy || state.readingFiles;
    $("attachFiles").disabled = state.busy || state.readingFiles;
    $("stopGeneration").hidden = !state.busy;
    renderMessages();
  }
  function generationOptions() {
    return { effort: $("reasoningEffort").value, webSearch: $("webSearch").checked, showReasoning: $("showReasoning").checked };
  }
  function renameChat(chat) {
    const title = window.prompt("Conversation name", chat.title);
    if (title === null || !title.trim()) return;
    chat.title = title.trim().slice(0, 150);
    chat.renamed = true;
    renderChats(); persist().catch(showError);
  }
  function updateMessage(message) {
    const nodes = messageNodes.get(message);
    if (!nodes) return;
    const text = message.text || (message.pending ? "Waiting for the model…" : "");
    if (message.role === "assistant" && state.vault?.settings?.renderMarkdown !== false && window.SafeMarkdown) window.SafeMarkdown.render(nodes.text, text, copyText);
    else { nodes.text.classList.remove("markdown-body"); nodes.text.textContent = text; }
    nodes.copy.disabled = !message.text;
    nodes.reasoning.hidden = !message.reasoning;
    nodes.reasoningText.textContent = message.reasoning || "";
    nodes.notices.textContent = [...(message.notices || []), message.failure || "", message.stopped ? "Generation stopped. Partial response saved." : ""].filter(Boolean).join("\n");
    nodes.sources.replaceChildren();
    for (const source of message.sources || []) {
      try {
        const url = new URL(source.url);
        if (!["https:", "http:"].includes(url.protocol)) continue;
        const link = document.createElement("a"); link.href = url.href; link.textContent = source.title || url.hostname;
        link.target = "_blank"; link.rel = "noopener noreferrer"; nodes.sources.append(link);
      } catch { /* Ignore invalid provider URLs. */ }
    }
  }
  async function copyText(text, button) {
    if (!text) return;
    const copySession = session;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (copySession !== session) return;
      const helper = document.createElement("textarea");
      helper.value = text; helper.style.position = "fixed"; helper.style.opacity = "0";
      document.body.append(helper); helper.select();
      let copied = false;
      try { copied = document.execCommand?.("copy"); } catch { /* Clipboard permission denied. */ }
      finally { helper.remove(); }
      if (!copied) { showToast("Could not copy to clipboard in this browser."); return; }
    }
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = original; }, 1300);
  }
  function editMessage(chat, message, container) {
    if (state.busy || container.querySelector("textarea")) return;
    const editor = document.createElement("textarea"); editor.className = "message-editor"; editor.value = message.text;
    const actions = document.createElement("div"); actions.className = "editor-actions";
    const save = document.createElement("button"); save.textContent = "Save edit";
    const resend = document.createElement("button"); resend.textContent = "Save & resend";
    const cancel = document.createElement("button"); cancel.textContent = "Cancel";
    async function commit(regenerate) {
      if (!state.vault || state.busy) return;
      const vault = state.vault;
      const text = editor.value.trim();
      if (!text && !message.attachments?.length) return;
      const index = chat.messages.indexOf(message);
      if (index < chat.messages.length - 1 && !window.confirm("Editing this message removes all later messages in this conversation. Continue?")) return;
      if (regenerate && (!chat.model || !sourceEnabled(chat.provider) || (chat.provider !== "ollama" && !state.vault.settings.keys?.[chat.provider]))) { showToast("Enable this provider and select a model; save its API key if it requires one."); return; }
      message.text = text;
      delete message.geminiParts; delete message.reasoning; delete message.sources; delete message.failure; delete message.error; delete message.stopped;
      chat.messages.splice(index + 1);
      chat.updatedAt = new Date().toISOString();
      await persist();
      if (state.vault !== vault || !vault.chats.includes(chat)) return;
      renderAll();
      if (regenerate) await generateReply(chat);
    }
    save.addEventListener("click", () => commit(false).catch(showError));
    resend.addEventListener("click", () => commit(true).catch(showError));
    cancel.addEventListener("click", renderMessages);
    actions.append(save);
    if (message.role === "user") actions.append(resend);
    actions.append(cancel); container.append(editor, actions); editor.focus();
  }
  function renderDraftAttachments() {
    $("draftAttachments").replaceChildren();
    state.attachments.forEach((file, index) => {
      const chip = document.createElement("button"); chip.type = "button"; chip.className = "attachment-chip";
      chip.textContent = `${file.name} ×`; chip.title = "Remove attachment";
      chip.addEventListener("click", () => { state.attachments.splice(index, 1); renderDraftAttachments(); });
      $("draftAttachments").append(chip);
    });
  }
  function deleteChat(id) {
    if (id === state.streamingChatId) { showToast("Stop generation before deleting this conversation."); return; }
    const chat = state.vault.chats.find((item) => item.id === id);
    if (!chat || !window.confirm(`Delete “${chat.title}”? This cannot be undone.`)) return;
    state.vault.chats = state.vault.chats.filter((item) => item.id !== id);
    drafts.delete(id);
    if (state.activeChatId === id) state.activeChatId = state.vault.chats[0]?.id || null;
    persist().then(renderAll).catch(showError);
  }
  function openSettings() {
    if (!state.vault) return;
    $("app").classList.remove("sidebar-open");
    $("app").inert = true;
    const keys = state.vault.settings.keys || {};
    const sources = state.vault.settings.sources || {};
    const ollama = state.vault.settings.ollama || { url: "http://localhost", port: 11434 };
    elements.openaiKey.value = keys.openai || "";
    elements.geminiKey.value = keys.gemini || "";
    $("ollamaKey").value = keys.ollama || "";
    $("ollamaOriginNote").textContent = location.origin === "null"
      ? "Serve this page over localhost or HTTPS instead of file://, then allow its origin in OLLAMA_ORIGINS and restart Ollama."
      : `Page origin: ${location.origin}. If Ollama returns 403, include this origin in OLLAMA_ORIGINS and restart Ollama. An API key does not override CORS permissions.`;
    $("openaiEnabled").checked = sources.openai !== false;
    $("geminiEnabled").checked = sources.gemini !== false;
    $("ollamaEnabled").checked = sources.ollama === true;
    $("ollamaUrl").value = ollama.url || "http://localhost";
    $("ollamaPort").value = ollama.port || 11434;
    $("markdownEnabled").checked = state.vault.settings.renderMarkdown !== false;
    selectSettingsProvider(elements.providerSelect.value);
    updateModelRefreshStatus();
    elements.settingsOverlay.hidden = false;
    $("closeSettings").focus();
  }
  function closeSettings() {
    refreshController?.abort(); refreshController = null;
    elements.settingsOverlay.hidden = true;
    elements.openaiKey.value = ""; elements.geminiKey.value = ""; $("ollamaKey").value = "";
    $("refreshModels").disabled = false; $("refreshModels").textContent = "↻ Refresh model list";
    $("app").inert = !state.vault;
  }
  function selectSettingsProvider(provider) {
    state.settingsProvider = provider;
    document.querySelectorAll(".provider-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.provider === provider));
    $("openaiSettings").hidden = provider !== "openai";
    $("geminiSettings").hidden = provider !== "gemini";
    $("ollamaSettings").hidden = provider !== "ollama";
    updateModelRefreshStatus();
  }
  function updateModelRefreshStatus(message = "") {
    if (message) {
      $("modelRefreshStatus").textContent = message;
      return;
    }
    const count = modelsFor(state.settingsProvider).length;
    $("modelRefreshStatus").textContent = count
      ? `${count} model${count === 1 ? "" : "s"} cached in your encrypted vault. Refresh to update.`
      : state.settingsProvider === "ollama" ? "No cached models yet. Enable Ollama and refresh to load local models." : "No cached models yet. Add an API key and refresh to load models.";
  }
  async function fetchOpenAIModels(apiKey, signal) {
    const models = [];
    let cursor = "";
    do {
      const url = new URL("https://api.openai.com/v1/models");
      if (cursor) url.searchParams.set("after", cursor);
      signal.throwIfAborted();
      const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `OpenAI model request failed (${response.status}).`);
      models.push(...(data.data || []).map((model) => model.id).filter(Boolean));
      const nextCursor = data.has_more ? (data.last_id || data.data?.at(-1)?.id || "") : "";
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    } while (cursor);
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  }
  async function fetchGeminiModels(apiKey, signal) {
    const models = [];
    let pageToken = "";
    const visited = new Set();
    do {
      if (visited.has(pageToken)) throw new Error("Provider returned a repeated model-list page token.");
      visited.add(pageToken);
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      signal.throwIfAborted();
      const response = await fetch(url, { headers: { "x-goog-api-key": apiKey }, signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || `Gemini model request failed (${response.status}).`);
      models.push(...(data.models || [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => model.name?.replace(/^models\//, ""))
        .filter(Boolean));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  }
  function ollamaBaseUrl(urlValue = $("ollamaUrl").value, portValue = $("ollamaPort").value) {
    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a valid Ollama port (1–65535).");
    let url;
    try { url = new URL(urlValue.trim()); } catch { throw new Error("Enter a valid Ollama URL, such as http://localhost."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Ollama URL must use HTTP(S) and cannot contain credentials, a query, or a fragment.");
    }
    url.port = String(port);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  }
  async function fetchOllamaModels(baseUrl, apiKey, signal) {
    return window.LLMProviders.listOllamaModels(baseUrl, apiKey, signal);
  }
  async function refreshModelList() {
    if (!state.vault || refreshController) return;
    if (state.busy) { updateModelRefreshStatus("Stop generation before refreshing model lists."); return; }
    const vault = state.vault;
    const provider = state.settingsProvider;
    if (!$(`${provider}Enabled`).checked) {
      updateModelRefreshStatus(`Enable ${provider === "ollama" ? "Ollama" : provider === "openai" ? "OpenAI" : "Gemini"} before refreshing its model list.`);
      return;
    }
    const apiKey = (provider === "ollama" ? $("ollamaKey").value : provider === "openai" ? elements.openaiKey.value : elements.geminiKey.value).trim();
    if (provider !== "ollama" && !apiKey) {
      updateModelRefreshStatus("Add an API key above before refreshing models.");
      return;
    }
    const button = $("refreshModels");
    const controller = new AbortController();
    refreshController = controller;
    button.disabled = true;
    button.textContent = "Loading models…";
    updateModelRefreshStatus(`Fetching available ${provider === "openai" ? "OpenAI" : provider === "gemini" ? "Gemini" : "Ollama"} models…`);
    try {
      const ollama = provider === "ollama" ? { url: $("ollamaUrl").value.trim(), port: Number($("ollamaPort").value) } : null;
      const models = provider === "openai" ? await fetchOpenAIModels(apiKey, controller.signal) : provider === "gemini" ? await fetchGeminiModels(apiKey, controller.signal) : await fetchOllamaModels(ollamaBaseUrl(ollama.url, ollama.port), apiKey, controller.signal);
      if (state.vault !== vault || controller.signal.aborted) return;
      if (!models.length) throw new Error("No compatible models were returned for this API key.");
      state.vault.settings.models ||= {};
      state.vault.settings.models[provider] = models;
      if (provider === "ollama") {
        state.vault.settings.sources.ollama = true;
        state.vault.settings.ollama = ollama;
        state.vault.settings.keys.ollama = apiKey;
      }
      const chat = currentChat();
      if (chat?.provider === provider && !models.includes(chat.model)) chat.model = models[0];
      await persist();
      if (state.vault !== vault || controller.signal.aborted) return;
      if (elements.providerSelect.value === provider) setProvider(provider, chat?.provider === provider ? chat : null);
      renderAll();
      updateModelRefreshStatus(`Loaded and saved ${models.length} ${provider === "openai" ? "OpenAI" : provider === "gemini" ? "Gemini" : "Ollama"} models in your encrypted vault.`);
    } catch (error) {
      if (state.vault === vault && !controller.signal.aborted) updateModelRefreshStatus(`Could not refresh models: ${error?.message || "Request failed."}`);
    } finally {
      if (refreshController === controller) {
        refreshController = null;
        button.disabled = false;
        button.textContent = "↻ Refresh model list";
      }
    }
  }
  async function sendMessage(text) {
    if (state.busy || !state.vault || state.readingFiles) return;
    let chat = currentChat();
    if (!chat) { newChat(); chat = currentChat(); }
    chat.provider = elements.providerSelect.value;
    chat.model = elements.modelSelect.value;
    if (!sourceEnabled(chat.provider)) { showToast("Enable this provider in API keys & settings before using it."); return; }
    if (!chat.model) { showToast("Refresh the model list in settings and select a model first."); return; }
    const apiKey = chat.provider === "ollama" ? "" : state.vault.settings.keys?.[chat.provider]?.trim();
    if (chat.provider !== "ollama" && !apiKey) { showToast(`Add your ${chat.provider === "openai" ? "OpenAI" : "Gemini"} API key in settings first.`); return; }
    chat.generation = generationOptions();
    const message = { role: "user", text, attachments: state.attachments.slice() };
    chat.messages.push(message);
    if (chat.title === "New conversation" && !chat.renamed) chat.title = (text || message.attachments[0]?.name || "New conversation").replace(/\s+/g, " ").slice(0, 38);
    chat.updatedAt = new Date().toISOString();
    const vault = state.vault;
    state.busy = true;
    renderAll();
    try {
      await persist();
    } catch (error) {
      chat.messages.pop();
      if (state.vault === vault) { state.busy = false; renderAll(); }
      throw new Error(`Could not save your message: ${error.message}. Local storage may be full; remove attachments or old chats.`);
    }
    if (state.vault !== vault) return;
    state.busy = false;
    drafts.set(chat.id, { text: "", attachments: [] });
    if (state.activeChatId === chat.id) {
      elements.promptInput.value = ""; elements.promptInput.style.height = "auto";
      state.attachments = []; renderDraftAttachments();
    }
    await generateReply(chat);
  }
  async function generateReply(chat) {
    if (state.busy || !state.vault || !state.vault.chats.includes(chat) || !sourceEnabled(chat.provider)) return;
    const vault = state.vault;
    const controller = new AbortController();
    state.controller = controller;
    state.busy = true;
    state.streamingChatId = chat.id;
    const answer = { role: "assistant", text: "", provider: chat.provider, model: chat.model, pending: true };
    chat.messages.push(answer);
    renderAll();
    let lastSave = Date.now();
    let saveFailed = false;
    try {
      const requestOptions = { ...(chat.generation || generationOptions()) };
      // Freeze the request history so UI changes cannot alter an in-flight retry.
      const requestChat = JSON.parse(JSON.stringify(chat));
      if (chat.provider === "ollama") requestOptions.ollamaBaseUrl = ollamaBaseUrl(vault.settings.ollama.url, vault.settings.ollama.port);
      await window.LLMProviders.generate(requestChat, vault.settings.keys[chat.provider] || "", requestOptions, controller.signal, (update) => {
        if (state.vault !== vault || controller.signal.aborted) return;
        const nearBottom = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight < 100;
        Object.assign(answer, JSON.parse(JSON.stringify(update)));
        if (state.activeChatId === chat.id) updateMessage(answer);
        if (nearBottom) elements.conversation.scrollTop = elements.conversation.scrollHeight;
        if (!saveFailed && Date.now() - lastSave > 1000) {
          lastSave = Date.now();
          persist().catch(() => { saveFailed = true; if (state.vault === vault) showToast("Could not save this reply. Free storage space before leaving."); });
        }
      });
    } catch (error) {
      if (state.vault !== vault) return;
      if (controller.signal.aborted) answer.stopped = true;
      else answer.failure = error?.message || "Request failed.";
      if (!answer.text && !answer.reasoning) answer.error = true;
    } finally {
      if (state.vault === vault) {
        delete answer.pending;
        chat.updatedAt = new Date().toISOString();
        state.busy = false; state.controller = null; state.streamingChatId = null;
        await persist().catch(() => { if (state.vault === vault) showToast("Could not save the response. Local storage may be full; remove old chats or attachments."); });
        if (state.vault === vault) { renderAll(); elements.promptInput.focus(); }
      }
    }
  }

  elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.authError.textContent = "";
    const password = elements.passwordInput.value;
    if (password.length < 8) { elements.authError.textContent = "Use a password with at least 8 characters."; return; }
    if (state.authMode === "create" && password !== elements.confirmPassword.value) { elements.authError.textContent = "The passwords do not match."; return; }
    elements.authSubmit.disabled = true;
    try {
      if (state.authMode === "create") await createVault(password);
      else await unlockVault(password);
    } catch {
      elements.authError.textContent = state.authMode === "create" ? "Could not create the encrypted vault. Check that this page is running in a secure browser context." : "Incorrect password, or the vault data is damaged.";
    } finally { elements.authSubmit.disabled = false; elements.passwordInput.value = ""; elements.confirmPassword.value = ""; }
  });
  elements.resetVault.addEventListener("click", async () => {
    const confirmed = window.confirm("Permanently erase the encrypted vault on this browser? All saved conversations and API keys will be lost.");
    if (!confirmed) return;
    state.saveGeneration++;
    lockVault(false);
    try {
      await withStorageLock(() => { localStorage.removeItem(VAULT_KEY); storedRecord = null; });
      setAuthMode("create");
    } catch { elements.authError.textContent = "Could not reset the vault. Browser storage is unavailable."; }
  });
  $("newChat").addEventListener("click", newChat);
  $("mobileNewChat").addEventListener("click", () => { $("app").classList.remove("sidebar-open"); newChat(); });
  $("toggleSidebar").addEventListener("click", () => $("app").classList.toggle("sidebar-open"));
  $("app").addEventListener("click", (event) => {
    if (event.target === $("app")) $("app").classList.remove("sidebar-open");
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      $("app").classList.remove("sidebar-open");
      closeSettings();
    }
  });
  $("stopGeneration").addEventListener("click", () => state.controller?.abort());
  $("attachFiles").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async () => {
    if (!state.vault || state.readingFiles) return;
    const vault = state.vault;
    const chatId = state.activeChatId;
    state.readingFiles = true;
    elements.sendButton.disabled = true; $("attachFiles").disabled = true;
    try {
      const files = await window.ChatAttachments.load(Array.from($("fileInput").files), state.attachments);
      if (state.vault === vault && state.activeChatId === chatId) { state.attachments.push(...files); renderDraftAttachments(); }
    } catch (error) { if (state.vault === vault) showError(error); }
    finally {
      if (state.vault === vault) {
        state.readingFiles = false; $("fileInput").value = "";
        elements.sendButton.disabled = state.busy; $("attachFiles").disabled = state.busy;
      }
    }
  });
  for (const id of ["reasoningEffort", "webSearch", "showReasoning"]) $(id).addEventListener("change", () => {
    const chat = currentChat();
    if (chat) { chat.generation = generationOptions(); persist().catch(showError); }
  });
  $("openSettings").addEventListener("click", openSettings);
  $("mobileSettings").addEventListener("click", openSettings);
  $("lockVault").addEventListener("click", lockVault);
  $("mobileLock").addEventListener("click", lockVault);
  $("closeSettings").addEventListener("click", closeSettings);
  $("cancelSettings").addEventListener("click", closeSettings);
  $("refreshModels").addEventListener("click", refreshModelList);
  document.querySelectorAll(".provider-tab").forEach((tab) => tab.addEventListener("click", () => selectSettingsProvider(tab.dataset.provider)));
  $("settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.vault) return;
    const vault = state.vault;
    refreshController?.abort(); refreshController = null;
    const ollama = { url: $("ollamaUrl").value.trim(), port: Number($("ollamaPort").value) };
    try {
      if ($("ollamaEnabled").checked) ollamaBaseUrl(ollama.url, ollama.port);
      const oldOllama = state.vault.settings.ollama || { url: "http://localhost", port: 11434 };
      state.vault.settings.keys = { openai: elements.openaiKey.value.trim(), gemini: elements.geminiKey.value.trim(), ollama: $("ollamaKey").value.trim() };
      state.vault.settings.sources = {
        openai: $("openaiEnabled").checked,
        gemini: $("geminiEnabled").checked,
        ollama: $("ollamaEnabled").checked
      };
      state.vault.settings.ollama = ollama;
      if (oldOllama.url !== ollama.url || Number(oldOllama.port) !== ollama.port) state.vault.settings.models.ollama = [];
      state.vault.settings.renderMarkdown = $("markdownEnabled").checked;
      const activeProvider = vault.chats.find((chat) => chat.id === state.streamingChatId)?.provider;
      if (activeProvider && !sourceEnabled(activeProvider)) state.controller?.abort();
      await persist();
      if (state.vault === vault) { closeSettings(); renderAll(); showToast("Settings saved in your encrypted vault."); }
    }
    catch (error) { showError(error); }
  });
  elements.providerSelect.addEventListener("change", () => {
    const chat = currentChat();
    if (!sourceEnabled(elements.providerSelect.value)) {
      showToast("Enable this provider in API keys & settings before selecting it.");
      renderAll();
      return;
    }
    if (chat) { setProvider(elements.providerSelect.value, chat); persist().catch(showError); renderAll(); }
    else setProvider(elements.providerSelect.value, null);
  });
  elements.modelSelect.addEventListener("change", () => {
    const chat = currentChat();
    if (chat) { chat.model = elements.modelSelect.value; persist().catch(showError); }
  });
  $("chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.promptInput.value.trim();
    if ((!text && !state.attachments.length) || state.busy || state.readingFiles) return;
    sendMessage(text).catch(showError);
  });
  elements.promptInput.addEventListener("input", () => { elements.promptInput.style.height = "auto"; elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 180)}px`; });
  elements.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("chatForm").requestSubmit(); }
  });
  window.addEventListener("pagehide", lockVault);
  window.addEventListener("storage", (event) => {
    if ((event.key === VAULT_KEY || event.key === null) && localStorage.getItem(VAULT_KEY) !== storedRecord) storageConflict();
  });

  if (!window.crypto?.subtle) {
    elements.authTitle.textContent = "Secure browser required";
    elements.authDescription.textContent = "This app needs the Web Crypto API. Open it on HTTPS or through localhost in a modern browser.";
    elements.passwordInput.disabled = true; elements.authSubmit.disabled = true;
  } else {
    try { setAuthMode(localStorage.getItem(VAULT_KEY) ? "unlock" : "create"); }
    catch {
      elements.authError.textContent = "Browser storage is unavailable. Allow site storage and reload.";
      elements.authSubmit.disabled = true;
    }
  }
})();
