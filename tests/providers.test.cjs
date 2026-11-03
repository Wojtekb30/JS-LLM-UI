const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

function setup(fetch) {
  const context = vm.createContext({ window: {}, fetch, TextDecoder, URL, location: { origin: "https://chat.example.com" } });
  vm.runInContext(readFileSync(`${__dirname}/providers.js`, "utf8"), context);
  return context.window.LLMProviders;
}
const options = { effort: "high", webSearch: true, showReasoning: true };
function chat(provider = "openai", model = "test-model") {
  return { provider, model, messages: [{ role: "user", text: "Hello" }] };
}
function stream(events, size = 7) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
    }
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function ndjson(records, size = 5) {
  const bytes = new TextEncoder().encode(records.map((record) => `${JSON.stringify(record)}\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
  } }), { headers: { "Content-Type": "application/x-ndjson" } });
}
const complete = { type: "response.completed", response: { output: [] } };
const signal = () => new AbortController().signal;

test("SSE handles split UTF-8, CRLF, multiline data, comments and final unterminated event", async () => {
  const providers = setup();
  const bytes = new TextEncoder().encode(': ping\r\nevent: update\r\ndata: {"value":\r\ndata: "🌱"}\r\n\r\ndata: {"last":true}');
  let offset = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, ++offset));
  } }));
  const events = [];
  await providers.readSSE(response, (data, event) => events.push({ ...data, event }), signal());
  assert.deepEqual(events, [{ value: "🌱", event: "update" }, { last: true, event: "" }]);
});

test("OpenAI input includes text, images and PDFs but excludes pending and failed messages", () => {
  const input = chat();
  input.messages[0].attachments = [
    { kind: "text", name: "code.js", text: "let x = 1;" },
    { kind: "image", dataUrl: "data:image/png;base64,AA==" },
    { kind: "pdf", name: "document.pdf", dataUrl: "data:application/pdf;base64,AA==" }
  ];
  input.messages.push({ role: "assistant", text: "old answer" }, { role: "assistant", text: "", pending: true }, { role: "assistant", text: "failed", error: true });
  const { body } = setup().buildRequest(input, options);
  assert.equal(body.input.length, 2);
  assert.equal(body.input[0].content[1].text, "File: code.js\nlet x = 1;");
  assert.equal(body.input[0].content[2].type, "input_image");
  assert.equal(body.input[0].content[3].filename, "document.pdf");
  assert.equal(body.input[1].content, "old answer");
  assert.equal(body.reasoning.effort, "high");
  assert.equal(body.reasoning.summary, "auto");
  assert.equal(body.tools[0].type, "web_search");
  assert.equal(body.store, false);
});

test("Gemini maps thinking budgets and levels and preserves same-model signatures", () => {
  const input = chat("gemini", "gemini-2.5-flash");
  input.messages[0].attachments = [{ kind: "pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,AA==" }];
  input.messages.push({ role: "assistant", text: "Hi", provider: "gemini", model: input.model, geminiParts: [{ text: "Hi", thoughtSignature: "opaque" }] });
  const providers = setup();
  const { body, url } = providers.buildRequest(input, options);
  assert.match(url, /streamGenerateContent\?alt=sse$/);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 24576);
  assert.equal(body.tools[0].google_search !== undefined, true);
  assert.equal(body.contents[0].parts[1].inlineData.data, "AA==");
  assert.equal(body.contents[1].parts[0].thoughtSignature, "opaque");
  input.model = "gemini-3-pro-preview";
  const next = providers.buildRequest(input, options).body;
  assert.equal(next.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(next.contents[1].parts[0].thoughtSignature, undefined);
});

test("default controls omit optional reasoning and search settings", () => {
  const providers = setup();
  for (const provider of ["openai", "gemini"]) {
    const { body } = providers.buildRequest(chat(provider), { effort: "default", webSearch: false, showReasoning: false });
    assert.equal(body.reasoning, undefined);
    assert.equal(body.generationConfig, undefined);
    assert.equal(body.tools, undefined);
  }
});

test("Ollama uses its local chat endpoint, streams without auth, and maps text and image attachments", () => {
  const input = chat("ollama", "llama3.2");
  input.messages[0].attachments = [
    { kind: "text", name: "notes.txt", text: "Local context" },
    { kind: "image", dataUrl: "data:image/png;base64,AA==" }
  ];
  input.messages.push({ role: "assistant", text: "Earlier", reasoning: "Thinking", provider: "ollama", model: "llama3.2" });
  const optionsWithSearch = { ...options, ollamaBaseUrl: "http://localhost:11434", webSearch: true };
  const { url, body } = setup().buildRequest(input, optionsWithSearch);
  assert.equal(url, "http://localhost:11434/api/chat");
  assert.equal(body.model, "llama3.2");
  assert.equal(body.stream, true);
  assert.equal(body.think, true);
  assert.equal(body.messages[0].content, "Hello\n\nFile: notes.txt\nLocal context");
  assert.deepEqual(Array.from(body.messages[0].images), ["AA=="]);
  assert.equal(body.messages[1].thinking, "Thinking");
  assert.equal(body.tools, undefined);
  const request = setup().buildRequest(input, { ...optionsWithSearch, showReasoning: false }).body;
  assert.equal(request.think, undefined);
  assert.equal(request.messages[1].thinking, undefined);
});

test("Ollama PDF attachments fail clearly instead of sending incompatible data", () => {
  const input = chat("ollama");
  input.messages[0].attachments = [{ kind: "pdf", name: "scan.pdf", dataUrl: "data:application/pdf;base64,AA==" }];
  assert.throws(() => setup().buildRequest(input, { ollamaBaseUrl: "http://localhost:11434", showReasoning: false }), /cannot accept scan.pdf/);
});

test("Ollama effort sends explicit boolean think independently of summaries", () => {
  for (const effort of ["true", "false"]) for (const showReasoning of [true, false]) {
    const { body } = setup().buildRequest(chat("ollama"), { ...options, effort, showReasoning, ollamaBaseUrl: "http://localhost:11434" });
    assert.equal(body.think, effort === "true");
  }
});

test("Ollama rejected boolean thinking retries once with the parameter omitted", async () => {
  for (const effort of ["true", "false"]) {
    const bodies = [];
    const providers = setup(async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return bodies.length === 1 ? Response.json({ error: "think is unsupported" }, { status: 400 })
        : ndjson([{ message: { content: "OK" }, done: true }]);
    });
    await providers.generate(chat("ollama"), "", { ...options, effort, ollamaBaseUrl: "http://localhost:11434" }, signal(), () => {});
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].think, effort === "true");
    assert.equal(Object.hasOwn(bodies[1], "think"), false);
  }
});

test("Ollama NDJSON streaming accumulates content and thinking fields", async () => {
  const providers = setup(async () => ndjson([
    { model: "llama3.2", message: { role: "assistant", thinking: "Planning " }, done: false },
    { model: "llama3.2", message: { role: "assistant", thinking: "locally." }, done: false },
    { model: "llama3.2", message: { role: "assistant", content: "Hello " }, done: false },
    { model: "llama3.2", message: { role: "assistant", content: "from Ollama." }, done: true, done_reason: "stop" }
  ]));
  const updates = [];
  const result = await providers.generate(chat("ollama", "llama3.2"), "", { ...options, ollamaBaseUrl: "http://localhost:11434" }, signal(), (value) => updates.push(value.text));
  assert.ok(updates.includes("Hello "));
  assert.equal(result.text, "Hello from Ollama.");
  assert.equal(result.reasoning, "Planning locally.");
});

test("Ollama retries if the selected model does not support the think field", async () => {
  const bodies = [];
  const providers = setup(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) return Response.json({ error: "unknown field 'think'" }, { status: 400 });
    return ndjson([{ message: { content: "No-think fallback" }, done: true }]);
  });
  const result = await providers.generate(chat("ollama"), "", { ...options, ollamaBaseUrl: "http://localhost:11434" }, signal(), () => {});
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].think, true);
  assert.equal(bodies[1].think, undefined);
  assert.equal(result.notices.length, 1);
  assert.equal(result.text, "No-think fallback");
});

test("Ollama connection failures include the configured host and origin hint", async () => {
  const providers = setup(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(providers.generate(chat("ollama"), "", { ...options, ollamaBaseUrl: "http://192.168.1.50:11435" }, signal(), () => {}), /http:\/\/192\.168\.1\.50:11435.*OLLAMA_ORIGINS.*https:\/\/chat.example.com/);
});

test("Ollama model discovery and chat send optional Bearer keys only in headers", async () => {
  for (const key of ["", "  private-token  "]) {
    const requests = [];
    const providers = setup(async (url, request) => {
      requests.push({ url, request });
      return url.endsWith("/api/tags") ? Response.json({ models: [{ name: "local-model" }] }) : ndjson([{ message: { content: "OK" }, done: true }]);
    });
    const models = await providers.listOllamaModels("http://localhost:11434", key);
    assert.equal(models[0], "local-model");
    await providers.generate(chat("ollama"), key, { ...options, ollamaBaseUrl: "http://localhost:11434" }, signal(), () => {});
    assert.equal(requests.length, 2);
    assert.equal(requests[0].request.method, undefined); // GET is the fetch default.
    assert.equal(requests[1].request.method, "POST");
    for (const { url, request } of requests) {
      assert.equal(request.headers.Authorization, key ? "Bearer private-token" : undefined);
      assert.equal(request.headers["x-goog-api-key"], undefined);
      assert.ok(!url.includes("private-token"));
      assert.ok(!(request.body || "").includes("private-token"));
    }
  }
});

test("Ollama 401/403 errors explain origin and auth requirements without retrying", async () => {
  for (const status of [401, 403]) {
    for (const discovery of [true, false]) {
      let calls = 0;
      const providers = setup(async () => { calls++; return new Response("Forbidden", { status }); });
      const promise = discovery ? providers.listOllamaModels("http://localhost:11434", "token")
        : providers.generate(chat("ollama"), "token", { ...options, ollamaBaseUrl: "http://localhost:11434" }, signal(), () => {});
      await assert.rejects(promise, (error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, /OLLAMA_ORIGINS.*https:\/\/chat.example.com/);
        assert.match(error.message, /API key/);
        assert.match(error.message, /OPTIONS/);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("Ollama discovery reports CORS-blocked failures when the browser hides the status", async () => {
  const providers = setup(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(providers.listOllamaModels("http://localhost:11434"), /browser may hide a CORS rejection/);
});

test("OpenAI streams answer and reasoning before completion and deduplicates citations", async () => {
  const providers = setup(async () => stream([
    { type: "response.reasoning_summary_text.delta", delta: "Checking…" },
    { type: "response.output_text.delta", delta: "Hello " },
    { type: "response.output_text.delta", delta: "world 🌱" },
    { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com", title: "Source" } },
    { type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: "Hello world 🌱", annotations: [{ type: "url_citation", url: "https://example.com", title: "Source" }] }] }] } }
  ]));
  const updates = [];
  const result = await providers.generate(chat(), "key", options, signal(), (data) => updates.push(data.text));
  assert.ok(updates.includes("Hello "));
  assert.equal(result.text, "Hello world 🌱");
  assert.equal(result.reasoning, "Checking…");
  assert.equal(result.sources.length, 1);
});

test("rejected effort retries with default, then removes unsupported summaries", async () => {
  const bodies = [];
  const providers = setup(async (url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length < 3) return Response.json({ error: { message: "Unsupported reasoning parameter", param: "reasoning" } }, { status: 400 });
    return stream([{ type: "response.output_text.delta", delta: "OK" }, complete]);
  });
  const result = await providers.generate(chat(), "key", options, signal(), () => {});
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].reasoning.effort, "high");
  assert.equal(bodies[1].reasoning.effort, undefined);
  assert.equal(bodies[1].reasoning.summary, "auto");
  assert.equal(bodies[2].reasoning, undefined);
  assert.equal(bodies[2].tools[0].type, "web_search");
  assert.equal(result.notices.length, 2);
});

test("Gemini retries rejected thinking settings without changing web search", async () => {
  const bodies = [];
  const providers = setup(async (url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) return Response.json({ error: { message: "thinkingBudget is not supported" } }, { status: 400 });
    return stream([{ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]);
  });
  await providers.generate(chat("gemini", "gemini-2.5-pro"), "key", options, signal(), () => {});
  assert.equal(bodies[1].generationConfig.thinkingConfig.thinkingBudget, undefined);
  assert.equal(bodies[1].generationConfig.thinkingConfig.includeThoughts, true);
  assert.ok(bodies[1].tools);
});

test("authentication and unrelated request errors never trigger reasoning fallback", async () => {
  for (const [status, message] of [[401, "Invalid API key"], [400, "Unsupported web_search tool"], [429, "Rate limit"]]) {
    let calls = 0;
    const providers = setup(async () => { calls++; return Response.json({ error: { message } }, { status }); });
    await assert.rejects(providers.generate(chat(), "key", options, signal(), () => {}), new RegExp(message));
    assert.equal(calls, 1);
  }
});

test("Gemini separates thought summaries, preserves signatures, and collects grounding sources", async () => {
  const providers = setup(async () => stream([
    { candidates: [{ content: { parts: [{ text: "Thinking", thought: true }] } }] },
    { candidates: [{ content: { parts: [{ text: "Answer", thoughtSignature: "opaque" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }] }, finishReason: "STOP" }] }
  ]));
  const result = await providers.generate(chat("gemini"), "key", options, signal(), () => {});
  assert.equal(result.reasoning, "Thinking");
  assert.equal(result.text, "Answer");
  assert.equal(result.geminiParts[1].thoughtSignature, "opaque");
  assert.equal(result.sources[0].title, "Example");
});

test("truncated and failed streams preserve partial text and are never retried", async () => {
  for (const ending of [[], [{ type: "response.failed", response: { error: { message: "Provider failed" } } }]]) {
    let calls = 0;
    let partial = "";
    const providers = setup(async () => { calls++; return stream([{ type: "response.output_text.delta", delta: "Partial" }, ...ending]); });
    await assert.rejects(providers.generate(chat(), "key", options, signal(), (data) => { partial = data.text; }));
    assert.equal(partial, "Partial");
    assert.equal(calls, 1);
  }
});

test("abort signal stops streaming without a retry", async () => {
  const controller = new AbortController();
  const providers = setup(async () => stream([{ type: "response.output_text.delta", delta: "First" }, complete], 1));
  await assert.rejects(providers.generate(chat(), "key", options, controller.signal, () => controller.abort()), { name: "AbortError" });
});

test("attachment validation rejects unsupported, oversized, or excessive files", async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(readFileSync(`${__dirname}/attachments.js`, "utf8"), context);
  const { load } = context.window.ChatAttachments;
  await assert.rejects(load([{ name: "archive.zip", size: 10, type: "application/zip" }]), /plain-text/);
  await assert.rejects(load([{ name: "large.pdf", size: 1500001, type: "application/pdf" }]), /1.5 MB/);
  await assert.rejects(load(Array(5).fill({ size: 1 })), /at most 4/);
  await assert.rejects(load([{ size: 800000 }], [{ size: 800000 }]), /1.5 MB/);
});

test("provider requests reject redirects, omit cookies/referrer, and do not cache keys or chats", async () => {
  for (const provider of ["openai", "gemini", "ollama"]) {
    const providers = setup(async (_url, request) => {
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      assert.equal(request.referrerPolicy, "no-referrer");
      assert.equal(request.cache, "no-store");
      if (provider === "gemini") {
        assert.equal(request.headers.Authorization, undefined);
        assert.equal(request.headers["x-goog-api-key"], "provider-key");
        return stream([{ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }]);
      }
      assert.equal(request.headers["x-goog-api-key"], undefined);
      assert.equal(request.headers.Authorization, "Bearer provider-key");
      return provider === "ollama" ? ndjson([{ message: { content: "OK" }, done: true }])
        : stream([{ type: "response.output_text.delta", delta: "OK" }, complete]);
    });
    await providers.generate(chat(provider), "provider-key", { ...options, ollamaBaseUrl: "http://localhost:11434" }, signal(), () => {});
  }
});

test("unknown providers never fall through to a different API", async () => {
  let requests = 0;
  const providers = setup(async () => { requests++; });
  await assert.rejects(providers.generate(chat("unknown"), "secret", options, signal(), () => {}), /Unknown provider/);
  assert.equal(requests, 0);
});

test("oversized and truncated NDJSON responses are rejected", async () => {
  const providers = setup(async () => ndjson([{ message: { content: "Partial" }, done: false }]));
  await assert.rejects(providers.generate(chat("ollama"), "", { ...options, ollamaBaseUrl: "http://localhost:11434" }, signal(), () => {}), /ended unexpectedly/);
  await assert.rejects(providers.readNDJSON(new Response("x".repeat(2000001)), () => {}, signal()), /2 MB/);
  await assert.rejects(providers.readSSE(new Response("x".repeat(2000001)), () => {}, signal()), /2 MB/);
});
