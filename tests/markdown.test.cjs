const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

class Node {
  constructor(tagName, text = "") {
    this.tagName = tagName; this.localName = tagName; this.children = []; this.listeners = {}; this.attributes = {}; this.style = {};
    this.className = ""; this.classList = { add: (value) => { this.className += ` ${value}`; }, remove() {} };
    this._text = text;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ""; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  async emit(name) { for (const listener of this.listeners[name] || []) await listener({}); }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
}

function renderer() {
  const document = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Node("#text", text) };
  document.createElementNS = (_namespace, tag) => new Node(tag);
  const window = {};
  const context = vm.createContext({ document, window, URL, location: { href: "https://local.test/", origin: "https://local.test" } });
  vm.runInContext(readFileSync(`${__dirname}/math.js`, "utf8"), context);
  vm.runInContext(readFileSync(`${__dirname}/markdown.js`, "utf8"), context);
  context.window.SafeMarkdown.math = context.window.SafeMath;
  return context.window.SafeMarkdown;
}

test("renderer creates common Markdown elements and treats raw HTML as plain text", () => {
  const markdown = renderer();
  const root = new Node("div");
  markdown.render(root, "# Title\n\n**bold** and *italic*, ~~removed~~, `inline`\n\n- first\n- second\n\n> quoted\n\n---\n\n<img src=x onerror=alert(1)><script>alert(2)</script>");
  for (const element of ["h1", "strong", "em", "del", "code", "ul", "li", "blockquote", "hr"]) assert.ok(root.querySelectorAll(element).length, `expected ${element}`);
  assert.equal(root.querySelectorAll("script").length, 0);
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(root.textContent, /<script>alert\(2\)<\/script>/);
});

test("links permit safe web, mail and same-page destinations but reject script and data URLs", () => {
  const markdown = renderer();
  const root = new Node("div");
  markdown.render(root, "[web](https://example.com/path) [mail](mailto:hi@example.com) [anchor](#top) [bad](javascript:alert(1)) [data](data:text/html,hello)");
  const links = root.querySelectorAll("a");
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((link) => link.href), ["https://example.com/path", "mailto:hi@example.com", "https://local.test/#top"]);
  assert.ok(links.every((link) => link.rel === "noopener noreferrer" && link.target === "_blank"));
  assert.match(root.textContent, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(root.textContent, /\[data\]\(data:text\/html,hello\)/);
});

test("fenced and inline code each have a copy callback with exact source text", async () => {
  const markdown = renderer();
  const root = new Node("div");
  const copied = [];
  markdown.render(root, "Run `print(1)` now.\n\n```js\nconst x = 1;\nconsole.log(x);\n```", (code, button) => { copied.push([code, button.textContent]); });
  const buttons = root.querySelectorAll("button");
  assert.equal(buttons.length, 2);
  await buttons[0].emit("click");
  await buttons[1].emit("click");
  assert.deepEqual(copied.map(([code]) => code), ["print(1)", "const x = 1;\nconsole.log(x);"]);
  assert.equal(root.querySelectorAll("pre").length, 1);
  assert.equal(root.querySelectorAll("code")[1].textContent, "const x = 1;\nconsole.log(x);");
});

test("tables render as scrollable semantic cells with inline formatting", () => {
  const markdown = renderer();
  const root = new Node("div");
  markdown.render(root, "| Name | Count |\n| :--- | ---: |\n| **Apples** | 12 |");
  assert.equal(root.querySelectorAll("table").length, 1);
  assert.equal(root.querySelectorAll("th").length, 2);
  assert.equal(root.querySelectorAll("td").length, 2);
  assert.equal(root.querySelectorAll("strong").length, 1);
});

test("inline and display LaTeX render fractions, roots, scripts, Greek symbols, and delimiters as MathML", () => {
  const markdown = renderer();
  const root = new Node("div");
  markdown.render(root, "Inline $x^2 + \\alpha$ and \\(a_i\\).\n\n$$\\frac{1}{\\sqrt[3]{x}} = \\sum_{i=1}^{n} i$$\n\n\\[\\int_0^1 x^2 \\, dx\\]");
  const math = root.querySelectorAll("math");
  assert.equal(math.length, 4);
  assert.equal(math.filter((node) => node.attributes.display === "block").length, 2);
  for (const tag of ["msup", "msub", "mfrac", "mroot", "mo", "mi"]) assert.ok(root.querySelectorAll(tag).length, `expected MathML ${tag}`);
  assert.equal(root.querySelectorAll("script").length, 0);
});

test("unknown TeX commands and HTML-like math text remain inert MathML text", () => {
  const markdown = renderer();
  const root = new Node("div");
  const rendered = markdown.math.render("\\htmlClass{danger}{<img src=x onerror=alert(1)>} + \\text{<script>hello</script>}");
  root.append(rendered);
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.equal(root.querySelectorAll("script").length, 0);
  assert.ok(root.querySelectorAll("mtext").length);
  assert.match(root.textContent, /\\htmlClass/);
  assert.match(root.textContent, /<script>hello<\/script>/);
});

test("matrix and cases environments build MathML tables and safe fences", () => {
  const markdown = renderer();
  const root = new Node("div");
  markdown.render(root, String.raw`$$\begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix} + \begin{cases}x & x>0 \\ -x & x<0\end{cases}$$`);
  assert.equal(root.querySelectorAll("mtable").length, 2);
  assert.equal(root.querySelectorAll("mtr").length, 4);
  assert.equal(root.querySelectorAll("mtd").length, 8);
  assert.equal(root.querySelectorAll("mfenced").length, 0); // Unsupported by Chromium MathML Core.
  assert.ok(root.querySelectorAll("mo").some((node) => node.textContent === "("));
  assert.ok(root.querySelectorAll("mo").some((node) => node.textContent === ")"));
});

test("emphasis consumes complete delimiters after math tokenizer changes", () => {
  const root = new Node("div");
  renderer().render(root, "**bold** and *italic* then __strong__ and _emphasis_");
  assert.deepEqual(root.querySelectorAll("strong").map((node) => node.textContent), ["bold", "strong"]);
  assert.deepEqual(root.querySelectorAll("em").map((node) => node.textContent), ["italic", "emphasis"]);
  assert.equal(root.textContent, "bold and italic then strong and emphasis");
});

test("same-origin blob links and obfuscated script URLs stay non-clickable", () => {
  const root = new Node("div");
  renderer().render(root, "[blob](blob:https://local.test/id#hash) [script](java\tscript:alert%281%29) [data](data:text/html,hello#hash)");
  assert.equal(root.querySelectorAll("a").length, 0);
});

test("math uses actual large-operator symbols and one-token unbraced scripts", () => {
  const root = new Node("div");
  renderer().render(root, String.raw`$ax^2 + \frac12 + \sum_{i=1}^{n} i + \int_0^1 x dx$`);
  assert.ok(root.querySelectorAll("mo").some((node) => node.textContent === "∑"));
  assert.ok(root.querySelectorAll("mo").some((node) => node.textContent === "∫"));
  assert.equal(root.querySelectorAll("msup")[0].children[0].textContent, "x");
  assert.deepEqual(root.querySelectorAll("mfrac")[0].children.map((node) => node.textContent), ["1", "2"]);
});

test("oversized Markdown and deeply nested math fall back to safe text", () => {
  const root = new Node("div");
  renderer().render(root, "*".repeat(100001));
  assert.equal(root.textContent.length, 100001);
  const math = renderer().math.render("{".repeat(100) + "x" + "}".repeat(100));
  assert.equal(math.querySelectorAll("mtext").length, 1);
});

test("renderer does not use HTML injection APIs", () => {
  const source = readFileSync(`${__dirname}/markdown.js`, "utf8");
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /insertAdjacentHTML/);
});
