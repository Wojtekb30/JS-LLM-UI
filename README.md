# JS-LLM-UI

> [!NOTE]
> **This entire program was vibe-coded with GPT-6 and manually tested by the project maintainer.**

A lightweight, static chat interface for **OpenAI, Google Gemini, and Ollama**, built with plain HTML, CSS, and JavaScript.

Bring your own API keys or connect to Ollama. Chats, credentials, provider settings, and cached model lists live in a password-encrypted vault in your browser. Requests go directly from your browser to the selected provider.

**No application backend · No build step · No cookies · No analytics · No third-party runtime assets**

[Quick start](#quick-start) · [Providers](#providers) · [Features](#features) · [Deployment](#deployment) · [Privacy](#encryption-and-privacy) · [Ollama troubleshooting](#ollama-troubleshooting) · [Development](#development)

## Quick start

### Run locally

Download or clone the project, then serve its folder with a static file server. For example, with Python 3:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open **http://localhost:8080** in a modern browser. This server only serves static files; all application logic runs in the browser. You can also deploy the app to an HTTPS static host, including GitHub Pages.

The app needs the Web Crypto API, available on HTTPS and localhost. Opening `index.html` directly with `file://` is not recommended because browser storage and cross-origin request behavior vary.

### Set up your vault

1. **Create a password** of at least 8 characters. The password is not saved or recoverable.
2. Open **API keys & settings** and configure your provider.
3. Click **Refresh model list** to fetch and cache its available models.
4. **Save settings**, select a model, and start chatting.

Model lists are refreshed only when you request it. There is no automatic polling.

## Providers

| Provider | API | Default state | Authentication |
| --- | --- | --- | --- |
| OpenAI | Responses API | Enabled | OpenAI API key |
| Google Gemini | Gemini API | Enabled | Google AI API key |
| Ollama | Native `/api/tags` and streaming `/api/chat` | **Disabled** | Optional Bearer API key |

Each provider has its own enable/disable switch in settings. Ollama is opt-in: the app does not contact it until you enable it and explicitly refresh models or send a message.

### Connecting to Ollama

1. Start Ollama and install the models you want to use.
2. In **API keys & settings → Ollama**, enable the provider.
3. Set the URL and port. Defaults are **`http://localhost`** and **`11434`**.
4. Leave the API key blank for standard local Ollama. For a protected endpoint or proxy, enter its key; it is sent as `Authorization: Bearer <key>` for model discovery and chat.
5. Refresh the model list, save settings, and select an Ollama model.

**`localhost` refers to the device running the browser, not the hosting server.** On a phone, connecting to Ollama on your computer requires that computer's reachable address. The Ollama server must allow the page's browser origin; see [troubleshooting](#ollama-troubleshooting) if it returns 403.

## Features

### Conversations and streaming

- Stream replies and provider-exposed reasoning into the chat as they arrive.
- Stop generation and keep the partial answer. Stopping cannot undo provider work already performed.
- Rename conversations using the sidebar pencil button.
- Edit user or assistant messages. **Save & resend** on a user message generates a new reply. Editing removes later messages after confirmation and retains the edited message's attachments.
- Use the responsive layout on desktop or mobile, with a conversation drawer on narrow screens.

Partial replies are encrypted periodically during streaming and saved when generation finishes or stops. If you close the page mid-response, only the most recently completed save is guaranteed to remain.

Unsent drafts and attachments are kept in memory per conversation and discarded when locking or leaving the page. Opening settings cancels neither the chat nor its stream; disabling the active provider stops generation.

### Reasoning and web search

- **OpenAI:** choose a model-default or explicit reasoning effort.
- **Gemini:** reasoning controls map to thinking budgets on Gemini 2.x and thinking levels on newer models.
- **Ollama:** the same **Reasoning effort** dropdown offers **True** and **False**, sending a boolean `think` value independently of the reasoning-summaries checkbox.
- View reasoning summaries or thinking output when the provider exposes it. Some models return none; the app does not unlock private reasoning that an API withholds.
- Enable OpenAI's native web-search tool or Gemini's Google Search grounding, with returned source links below the answer. Provider-managed web search is unavailable for Ollama in this app.

Generation controls are saved per conversation. If a provider rejects a reasoning setting, the app reports a fallback and retries with defaults or without the unsupported parameter. Authentication, rate-limit, unrelated request errors, and failures after streaming begins do not trigger reasoning fallback. Model capabilities and API costs depend on the provider.

### Files, formatting, and copying

- Attach PNG, JPEG, WebP, GIF, PDF, and text/code files. Attachments are sent with the request and stored in the encrypted conversation.
- Up to **four files and 1.5 MB total per message**, subject to the browser's overall localStorage quota. Model support varies; Ollama accepts text and compatible image inputs, but not PDF attachments.
- Toggle assistant **Markdown rendering** in settings. Supported formatting includes headings, lists, tables, quotes, links, emphasis, and code.
- Render a subset of **LaTeX math** using native MathML: `$...$`, `\(...\)`, `$$...$$`, and `\[...\]`. Supported constructs include fractions, roots, scripts, matrices/cases, Greek letters, and common operators. Math follows the Markdown setting.
- Copy entire message text, fenced code blocks, or inline code snippets.

Markdown and math use DOM-created elements and text rather than HTML injection. Raw HTML and unknown TeX commands remain inert text; links are restricted to supported protocols.

Very long replies/paragraphs fall back to plain text rendering to bound parsing work. Streaming has client-side limits of 2 MB per buffered event and 1 million characters of answer plus reasoning; exceeding a limit stops generation with an error and retains the last partial update. Markdown/LaTeX support is a subset, not full CommonMark or TeX compatibility.

## Deployment

Publish **only these seven runtime files**, together in the same directory on your HTTPS static host:

```text
index.html
styles.css
app.js
providers.js
attachments.js
math.js
markdown.js
```

**Exclude development tests from the deployed site:** `app.test.cjs`, `providers.test.cjs`, and `markdown.test.cjs`. Keep them in the GitHub repository for development. `README.md` is not needed at runtime.

For GitHub Pages, publish a directory or deployment artifact containing the runtime files above. No build output, Node.js server, or application backend is required.

Use a dedicated, trusted HTTPS origin. Different URL paths on the same origin share localStorage and are not separate security boundaries. The page includes a Content Security Policy restricting scripts to same-origin files and disabling form submissions, embedded frames, and objects. If your host supports response headers, also set `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`. `frame-ancestors` must be a response header; it cannot be supplied by the page's CSP meta tag. The host must serve JavaScript and CSS with correct MIME types.

## Encryption and privacy

- **Encryption:** AES-256-GCM, with a fresh random nonce for each save.
- **Key derivation:** PBKDF2-SHA-256 with a random salt and 310,000 iterations.
- **Storage:** encrypted vault data and encryption metadata in browser `localStorage`. The password and derived key are not persisted.
- **While unlocked:** decrypted data is available in page memory. Use **Lock vault** when stepping away; opening or reloading the page requires the password again.
- **Storage scope:** data belongs to this browser profile and site origin. It does not automatically sync between devices, and clearing site data erases it.

### User and tab isolation

There are no user accounts or shared server-side chat storage. Separate browser profiles/devices have separate vaults, even if users choose the same password. **People sharing the same browser profile and origin share one vault**, not separate accounts. Use separate browser/OS profiles for different people; an already unlocked tab is accessible to anyone using that profile.

When another tab saves or resets the shared vault, an unlocked stale tab locks and requires unlocking again. Saves compare the stored ciphertext to the last known version; Web Locks serialize writes across tabs where supported. Use one active tab on browsers without Web Locks. These controls prevent stale writes; they are not an account or access-control system.

If you forget the password, choose **Forgot password? Reset encrypted vault** on the unlock screen. **Reset permanently deletes the saved chats, attachments, keys, and settings.** There is no password recovery.

Encryption protects data at rest in the browser profile. It cannot protect an unlocked page from malicious extensions, injected scripts, a compromised device, or someone using your browser. Prompts, relevant conversation history, attachments, and credentials are sent directly to the selected provider. Provider privacy policies and billing still apply.

Use a strong, unique passphrase: someone with a copy of the encrypted vault can try passwords offline. Locking drops application references but JavaScript cannot guarantee secure memory erasure. Clipboard contents and browser/password-manager features are outside the vault. Plain HTTP to a remote Ollama server does not encrypt prompts or keys in transit; use HTTPS for remote endpoints. Changing a conversation's provider sends its existing history to that provider when you next generate a response.

API requests omit cookies/referrers, request no caching, and reject redirects. Configure the final provider URL directly. This app uses OpenAI `store: false`, but that does not override a provider's logging or retention policies. Clearing localStorage cannot erase data already sent to a provider.

## Ollama troubleshooting

### HTTP 403 and browser origins

The client uses Ollama's native API: `GET /api/tags` to discover installed models, and `POST /api/chat` with JSON containing `model`, `messages`, and `stream: true`. A 403 means access was denied by Ollama or a proxy. It commonly indicates a disallowed browser origin rather than an invalid chat payload. If the log shows `OPTIONS` returning 403, the browser's CORS preflight was denied before the actual request was sent.

Allow the **origin of the page hosting JS-LLM-UI**, including its scheme and port (not the Ollama URL, and not a URL path). For example, for a page hosted at `https://chat.example.com`, stop the existing Ollama process and start it with:

```sh
OLLAMA_ORIGINS="https://chat.example.com" ollama serve
```

For a Linux systemd installation, run `sudo systemctl edit ollama.service` and add:

```ini
[Service]
Environment="OLLAMA_ORIGINS=https://chat.example.com"
```

Then apply it:

```sh
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

On Windows, set `OLLAMA_ORIGINS` in your user environment variables, quit Ollama, and relaunch it. On macOS, use `launchctl setenv OLLAMA_ORIGINS "https://chat.example.com"` and restart the Ollama application. For multiple page origins, supply a comma-separated list. Settings displays the current page origin for reference. Serve the app over localhost or HTTPS rather than opening it as `file://`.

For an authenticated proxy, also set the optional API key in the Ollama settings tab. The proxy must permit unauthenticated `OPTIONS` preflight requests from the allowed origin and allow the `Authorization` and `Content-Type` headers. Preflight requests do not carry the Bearer key. Adding a key does not fix a disallowed origin. If using a tunnel, check its upstream Host handling as described in the [Ollama FAQ](https://docs.ollama.com/faq).

The browser may hide a rejected CORS response behind a generic network error; inspect its Network panel and Ollama's logs. Browser local-network permissions and HTTPS-to-HTTP restrictions may also apply. The static client cannot change server CORS policy or bypass browser restrictions.

## Development

### Project layout

| File | Responsibility |
| --- | --- |
| `index.html` | Page structure and controls |
| `styles.css` | Desktop and mobile styling |
| `app.js` | Vault, settings, and chat UI |
| `providers.js` | Provider requests, streaming, and fallback handling |
| `attachments.js` | File loading and validation |
| `markdown.js` | DOM-based Markdown rendering |
| `math.js` | TeX-subset to MathML rendering |
| `*.test.cjs` | Development-only automated tests |

### Run tests

Requires **Node.js 18 or later**. No package installation is needed.

```sh
node --test app.test.cjs providers.test.cjs markdown.test.cjs
```

Tests use mocked API responses and lightweight DOM stand-ins to cover streaming, provider requests, opt-in behavior, authentication, reasoning fallback, editing, formatting safety, and encrypted persistence. Manual testing with a browser and real provider connections complements these checks. Live OpenAI/Gemini requests require API keys; Ollama requires a running, browser-accessible instance.
