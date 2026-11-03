/* Direct provider requests. No keys or conversation state are kept in this module. */
(() => {
  "use strict";

  function ollamaAccessError(baseUrl, status) {
    const origin = typeof location !== "undefined" ? location.origin : "your page's origin";
    const originHint = origin === "null"
      ? "Serve this page over localhost or HTTPS instead of file://, then allow its origin in OLLAMA_ORIGINS and restart Ollama."
      : `Set OLLAMA_ORIGINS to include ${origin} on the Ollama server and restart Ollama.`;
    const prefix = status ? `Ollama returned HTTP ${status}${baseUrl ? ` at ${baseUrl}` : ""}.` : `Could not connect to Ollama at ${baseUrl}.`;
    return `${prefix} ${status === 401 ? "Check the optional Ollama API key required by your endpoint or proxy. " : ""}${originHint} If the endpoint requires authentication, enter its API key in settings. A proxy must allow OPTIONS preflight requests and the Authorization and Content-Type headers. ${status ? "" : "The browser may hide a CORS rejection as a network error; also check the server address and browser local-network permissions."}`.trim();
  }

  const networkPolicy = { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" };
  async function listOllamaModels(baseUrl, apiKey = "", signal) {
    const headers = {};
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    let response;
    try { response = await fetch(`${baseUrl}/api/tags`, { ...networkPolicy, headers, signal }); }
    catch (error) { if (signal?.aborted) throw error; throw new Error(ollamaAccessError(baseUrl)); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error(ollamaAccessError(baseUrl, response.status));
      throw new Error(data.error?.message || data.error || `Ollama model request failed (${response.status}).`);
    }
    return [...new Set((data.models || []).map((model) => model.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  async function readSSE(response, onEvent, signal) {
    if (!response.body) throw new Error("This browser did not expose a streaming response body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let data = [];
    let event = "";
    function dispatch() {
      if (data.length) {
        const value = data.join("\n");
        if (value !== "[DONE]") onEvent(JSON.parse(value), event);
      }
      data = []; event = "";
    }
    function line(value) {
      if (!value) return dispatch();
      if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
      if (value.startsWith("event:")) event = value.slice(6).trim();
    }
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length + data.join("\n").length > 2000000) throw new Error("Provider stream event exceeds the 2 MB client limit.");
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, end).replace(/\r$/, ""));
          buffer = buffer.slice(end + 1);
        }
        if (chunk.done) break;
      }
      if (buffer) line(buffer.replace(/\r$/, ""));
      dispatch();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function readNDJSON(response, onRecord, signal) {
    if (!response.body) throw new Error("This browser did not expose a streaming response body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    function line(value) {
      const trimmed = value.trim();
      if (trimmed) onRecord(JSON.parse(trimmed));
    }
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        if (buffer.length > 2000000) throw new Error("Provider stream event exceeds the 2 MB client limit.");
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          line(buffer.slice(0, end).replace(/\r$/, ""));
          buffer = buffer.slice(end + 1);
        }
        if (chunk.done) break;
      }
      if (buffer.trim()) line(buffer);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  function openAIInput(messages) {
    return messages.filter((message) => !message.error && !message.pending).map((message) => {
      if (message.role === "assistant") return { role: "assistant", content: message.text || "(No text response.)" };
      const content = [];
      if (message.text) content.push({ type: "input_text", text: message.text });
      for (const file of message.attachments || []) {
        if (file.kind === "text") content.push({ type: "input_text", text: `File: ${file.name}\n${file.text}` });
        else if (file.kind === "image") content.push({ type: "input_image", image_url: file.dataUrl });
        else content.push({ type: "input_file", filename: file.name, file_data: file.dataUrl });
      }
      return { role: "user", content };
    });
  }

  function geminiContents(chat) {
    return chat.messages.filter((message) => !message.error && !message.pending).map((message) => {
      if (message.role === "assistant" && message.provider === "gemini" && message.model === chat.model && message.geminiParts?.length) {
        return { role: "model", parts: message.geminiParts };
      }
      const parts = [];
      if (message.text) parts.push({ text: message.text });
      for (const file of message.attachments || []) {
        if (file.kind === "text") parts.push({ text: `File: ${file.name}\n${file.text}` });
        else parts.push({ inlineData: { mimeType: file.mimeType, data: file.dataUrl.split(",")[1] } });
      }
      return { role: message.role === "assistant" ? "model" : "user", parts: parts.length ? parts : [{ text: "(No text response.)" }] };
    });
  }

  function ollamaMessages(chat, options) {
    return chat.messages.filter((message) => !message.error && !message.pending).map((message) => {
      let content = message.text || "";
      const images = [];
      for (const file of message.attachments || []) {
        if (file.kind === "text") content += `${content ? "\n\n" : ""}File: ${file.name}\n${file.text}`;
        else if (file.kind === "image") images.push(file.dataUrl.split(",")[1]);
        else throw new Error(`Ollama chat API cannot accept ${file.name}. Remove the PDF attachment or choose an API provider.`);
      }
      const item = { role: message.role, content };
      if (images.length) item.images = images;
      if (options.showReasoning && message.role === "assistant" && message.provider === "ollama" && message.model === chat.model && message.reasoning) item.thinking = message.reasoning;
      return item;
    });
  }

  function buildRequest(chat, options) {
    if (!["openai", "gemini", "ollama"].includes(chat.provider)) throw new Error("Unknown provider.");
    if (chat.provider === "openai") {
      const body = { model: chat.model, input: openAIInput(chat.messages), stream: true, store: false };
      if (options.webSearch) body.tools = [{ type: "web_search" }];
      if (options.effort !== "default" || options.showReasoning) {
        body.reasoning = {};
        if (options.effort !== "default") body.reasoning.effort = options.effort;
        if (options.showReasoning) body.reasoning.summary = "auto";
      }
      return { url: "https://api.openai.com/v1/responses", body };
    }
    if (chat.provider === "ollama") {
      const baseUrl = String(options.ollamaBaseUrl || "").replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Set a valid Ollama URL and port in API keys & settings first.");
      const body = { model: chat.model, messages: ollamaMessages(chat, options), stream: true };
      if (!options.omitOllamaThink) {
        if (options.effort === "true" || options.effort === "false") body.think = options.effort === "true";
        else if (options.showReasoning) body.think = true; // Compatibility with older saved chats.
      }
      return { url: `${baseUrl}/api/chat`, body };
    }
    const body = { contents: geminiContents(chat) };
    if (options.webSearch) body.tools = [{ google_search: {} }];
    if (options.effort !== "default" || options.showReasoning) {
      const thinkingConfig = {};
      if (options.showReasoning) thinkingConfig.includeThoughts = true;
      if (options.effort !== "default") {
        if (/gemini-2(?:\.|-)/i.test(chat.model)) {
          thinkingConfig.thinkingBudget = { none: 0, minimal: 128, low: 1024, medium: 8192, high: 24576, xhigh: 24576, max: 24576 }[options.effort];
        } else {
          thinkingConfig.thinkingLevel = { none: "minimal", xhigh: "high", max: "high" }[options.effort] || options.effort;
        }
      }
      body.generationConfig = { thinkingConfig };
    }
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chat.model)}:streamGenerateContent?alt=sse`, body };
  }

  // Only rejected request parameters can trigger a retry, never a partially streamed answer.
  async function request(chat, apiKey, options, signal, onNotice) {
    let effective = { ...options };
    for (let attempt = 0; attempt < 3; attempt++) {
      const { url, body } = buildRequest(chat, effective);
      signal?.throwIfAborted();
      const headers = { "Content-Type": "application/json" };
      if (chat.provider === "openai") headers.Authorization = `Bearer ${apiKey}`;
      else if (chat.provider === "gemini") headers["x-goog-api-key"] = apiKey;
      else if (chat.provider === "ollama" && apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
      let response;
      try { response = await fetch(url, { ...networkPolicy, method: "POST", headers, body: JSON.stringify(body), signal }); }
      catch (error) {
        if (signal?.aborted) throw error;
        if (chat.provider === "ollama") throw new Error(ollamaAccessError(options.ollamaBaseUrl));
        throw error;
      }
      if (response.ok) return response;
      if (chat.provider === "ollama" && [401, 403].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new Error(ollamaAccessError(options.ollamaBaseUrl, response.status));
      }
      const data = await response.json().catch(() => ({}));
      const detail = data.error || {};
      const message = typeof detail === "string" ? detail : detail.message || `Request failed (${response.status}).`;
      const parameter = `${typeof detail === "object" ? detail.param || "" : ""} ${message}`;
      const rejectedThinking = [400, 422].includes(response.status) && /reasoning|thinking|\bthink\b|include.?thoughts/i.test(parameter);
      if (chat.provider === "ollama") {
        if (rejectedThinking && Object.hasOwn(body, "think")) {
          effective.omitOllamaThink = true;
          onNotice("Ollama rejected the thinking setting. Retrying without it, using the model default.");
          continue;
        }
        throw new Error(message);
      }
      if (rejectedThinking && effective.effort !== "default") {
        effective.effort = "default";
        onNotice("The model rejected this reasoning effort. Retrying with its default effort.");
        continue;
      }
      if (rejectedThinking && effective.showReasoning) {
        effective.showReasoning = false;
        onNotice("The model rejected reasoning summaries. Retrying without requesting summaries.");
        continue;
      }
      throw new Error(message);
    }
    throw new Error("The model rejected the reasoning settings after fallback.");
  }

  function openAISources(response) {
    return (response.output || []).flatMap((item) => (item.content || []).flatMap((part) => (part.annotations || [])
      .filter((annotation) => annotation.type === "url_citation")
      .map((annotation) => ({ url: annotation.url, title: annotation.title || annotation.url }))));
  }

  async function generate(chat, apiKey, options, signal, onUpdate) {
    const result = { text: "", reasoning: "", sources: [], notices: [], geminiParts: [] };
    const response = await request(chat, apiKey, options, signal, (notice) => {
      result.notices.push(notice); onUpdate(result);
    });
    let completed = false;
    const consumeEvent = (data, eventName = "") => {
      signal?.throwIfAborted();
      if (data.error) throw new Error(typeof data.error === "string" ? data.error : data.error.message || "The provider returned a stream error.");
      if (chat.provider === "openai") {
        const type = data.type || eventName;
        if (type === "response.output_text.delta" || type === "response.refusal.delta") result.text += data.delta || "";
        if (type === "response.reasoning_summary_text.delta") result.reasoning += data.delta || "";
        if (type === "response.reasoning_summary_part.added" && result.reasoning) result.reasoning += "\n\n";
        if (type === "response.output_text.annotation.added" && data.annotation?.type === "url_citation") {
          result.sources.push({ url: data.annotation.url, title: data.annotation.title || data.annotation.url });
        }
        if (type === "response.failed" || type === "error") throw new Error(data.response?.error?.message || data.message || "Generation failed.");
        if (type === "response.completed" || type === "response.incomplete") {
          completed = true;
          const final = data.response || {};
          const parts = (final.output || []).flatMap((item) => item.content || []);
          result.text = parts.map((part) => part.text || part.refusal || "").join("") || result.text;
          result.reasoning = (final.output || []).flatMap((item) => item.summary || []).map((part) => part.text || "").join("\n\n") || result.reasoning;
          result.sources.push(...openAISources(final));
          if (type === "response.incomplete") result.notices.push(`Incomplete response: ${final.incomplete_details?.reason || "provider limit"}.`);
        }
      } else if (chat.provider === "gemini") {
        if (data.promptFeedback?.blockReason) throw new Error(`Request blocked: ${data.promptFeedback.blockReason}.`);
        const candidate = data.candidates?.[0];
        for (const part of candidate?.content?.parts || []) {
          if (part.thought) result.reasoning += part.text || "";
          else result.text += part.text || "";
          // Preserve provider-issued parts and opaque signatures for subsequent turns.
          const last = result.geminiParts.at(-1);
          if (last && part.text !== undefined && last.text !== undefined && Boolean(last.thought) === Boolean(part.thought) && !part.thoughtSignature && !last.thoughtSignature) last.text += part.text;
          else result.geminiParts.push({ ...part });
        }
        for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
          if (chunk.web?.uri) result.sources.push({ url: chunk.web.uri, title: chunk.web.title || chunk.web.uri });
        }
        if (candidate?.finishReason) {
          completed = true;
          if (candidate.finishReason !== "STOP") result.notices.push(`Generation ended: ${candidate.finishReason}.`);
        }
      } else {
        if (typeof data.error === "string") throw new Error(data.error);
        result.text += data.message?.content || "";
        result.reasoning += data.message?.thinking || "";
        if (data.done) {
          completed = true;
          if (data.done_reason && data.done_reason !== "stop") result.notices.push(`Generation ended: ${data.done_reason}.`);
        }
      }
      result.sources = [...new Map(result.sources.map((source) => [source.url, source])).values()];
      if (result.text.length + result.reasoning.length > 1000000) throw new Error("Response exceeds the 1 million character client limit; partial output was retained.");
      onUpdate(result);
    };
    if (chat.provider === "ollama") await readNDJSON(response, consumeEvent, signal);
    else await readSSE(response, consumeEvent, signal);
    if (!completed) throw new Error("The response stream ended unexpectedly. Any partial answer is kept below.");
    if (!result.text && !result.reasoning) throw new Error("The model returned no text or reasoning summary.");
    return result;
  }

  window.LLMProviders = { generate, buildRequest, readSSE, readNDJSON, ollamaMessages, listOllamaModels, ollamaAccessError };
})();
