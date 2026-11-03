/* A deliberately small Markdown renderer. It never parses or inserts HTML. */
(() => {
  "use strict";

  function appendText(parent, value) {
    const lines = value.split("\n");
    lines.forEach((line, index) => {
      if (index) parent.append(document.createElement("br"));
      if (line) parent.append(document.createTextNode(line));
    });
  }

  function safeLink(target) {
    try {
      const value = new URL(target.trim(), location.href);
      if (["https:", "http:", "mailto:"].includes(value.protocol)) return value.href;
    } catch { /* Invalid or unsupported link target; leave it as plain text. */ }
    return "";
  }

  function appendInline(parent, source, copyCode) {
    // Bound work on pathological/unclosed delimiter sequences from model output.
    if (source.length > 8192) { appendText(parent, source); return; }
    const pattern = /(`+)(.+?)\1|(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\s)[^$\n]+?(?<!\\)\$)|\[([^\]]+)\]\(([^)]+)\)|(\*\*|__)(.+?)\6|(\*|_)(.+?)\8|~~(.+?)~~/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
      appendText(parent, source.slice(cursor, match.index));
      let node;
      if (match[2] !== undefined) {
        const codeText = match[2];
        node = document.createElement("code"); node.textContent = codeText;
        if (copyCode) {
          const wrapper = document.createElement("span"); wrapper.className = "inline-code";
          const copy = document.createElement("button"); copy.className = "copy-inline-code"; copy.textContent = "Copy";
          copy.setAttribute("aria-label", "Copy code snippet");
          copy.addEventListener("click", () => copyCode(codeText, copy));
          wrapper.append(node, copy); parent.append(wrapper);
        } else parent.append(node);
      } else if (match[3] !== undefined) {
        const token = match[3];
        const display = token.startsWith("$$") || token.startsWith("\\[");
        const expression = token.startsWith("$$") ? token.slice(2, -2)
          : token.startsWith("\\[") ? token.slice(2, -2)
            : token.startsWith("\\(") ? token.slice(2, -2) : token.slice(1, -1);
        if (window.SafeMath) parent.append(window.SafeMath.render(expression, display));
        else appendText(parent, token);
      } else if (match[4] !== undefined) {
        const href = safeLink(match[5]);
        if (!href) appendText(parent, match[0]);
        else {
          node = document.createElement("a"); node.href = href; node.textContent = match[4];
          node.target = "_blank"; node.rel = "noopener noreferrer"; parent.append(node);
        }
      } else if (match[7] !== undefined) {
        node = document.createElement("strong"); node.textContent = match[7]; parent.append(node);
      } else if (match[9] !== undefined) {
        node = document.createElement("em"); node.textContent = match[9]; parent.append(node);
      } else {
        node = document.createElement("del"); node.textContent = match[10]; parent.append(node);
      }
      cursor = pattern.lastIndex;
    }
    appendText(parent, source.slice(cursor));
  }

  function tableCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
  }

  function render(root, source, copyCode) {
    if (String(source || "").length > 100000) {
      root.classList.remove("markdown-body"); root.textContent = source; return;
    }
    root.classList.add("markdown-body");
    root.replaceChildren();
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    const isFence = (line) => /^ {0,3}(`{3,}|~{3,})/.exec(line);
    const isList = (line) => /^ {0,3}([-+*]|\d+[.)])\s+/.test(line);
    const isTableDelimiter = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
    const isTableStart = (position) => lines[position]?.includes("|") && position + 1 < lines.length && isTableDelimiter(lines[position + 1]);
    const isBlockStart = (line, position) => /^ {0,3}(#{1,6}\s|>|[-*_]{3,}\s*$)/.test(line) || isFence(line) || isList(line) || isTableStart(position);
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }

      const fence = isFence(line);
      if (fence) {
        const marker = fence[1];
        const language = line.slice(fence[0].length).trim().split(/\s+/)[0];
        const codeLines = [];
        index++;
        while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index++;
        const code = codeLines.join("\n");
        const block = document.createElement("div"); block.className = "code-block";
        const toolbar = document.createElement("div"); toolbar.className = "code-toolbar";
        const label = document.createElement("span"); label.textContent = language || "Code";
        const button = document.createElement("button"); button.className = "copy-code"; button.textContent = "Copy code";
        button.setAttribute("aria-label", "Copy code block");
        button.addEventListener("click", () => copyCode?.(code, button));
        toolbar.append(label, button);
        const pre = document.createElement("pre"); const codeElement = document.createElement("code");
        if (language) codeElement.className = `language-${language.replace(/[^a-z0-9_-]/gi, "")}`;
        codeElement.textContent = code; pre.append(codeElement); block.append(toolbar, pre); root.append(block);
        continue;
      }

      const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        const node = document.createElement(`h${heading[1].length}`); appendInline(node, heading[2], copyCode); root.append(node); index++; continue;
      }
      if (/^ {0,3}(---+|___+|\*\*\*+)\s*$/.test(line)) { root.append(document.createElement("hr")); index++; continue; }

      if (line.includes("|") && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
        const headers = tableCells(line);
        const alignment = tableCells(lines[index + 1]).map((cell) => cell.startsWith(":") ? (cell.endsWith(":") ? "center" : "left") : (cell.endsWith(":") ? "right" : ""));
        const table = document.createElement("table");
        const head = document.createElement("thead"); const headRow = document.createElement("tr");
        headers.forEach((value, cellIndex) => {
          const cell = document.createElement("th"); cell.scope = "col";
          if (alignment[cellIndex]) cell.style.textAlign = alignment[cellIndex];
          appendInline(cell, value, copyCode); headRow.append(cell);
        });
        head.append(headRow); table.append(head);
        const body = document.createElement("tbody");
        index += 2;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const row = document.createElement("tr");
          tableCells(lines[index++]).forEach((value, cellIndex) => {
            const cell = document.createElement("td");
            if (alignment[cellIndex]) cell.style.textAlign = alignment[cellIndex];
            appendInline(cell, value, copyCode); row.append(cell);
          });
          body.append(row);
        }
        table.append(body); root.append(table); continue;
      }

      if (/^ {0,3}>/.test(line)) {
        const quote = document.createElement("blockquote");
        while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
          const paragraph = document.createElement("p");
          appendInline(paragraph, lines[index++].replace(/^ {0,3}>\s?/, ""), copyCode); quote.append(paragraph);
        }
        root.append(quote); continue;
      }

      if (isList(line)) {
        const ordered = /^ {0,3}\d+[.)]/.test(line);
        const list = document.createElement(ordered ? "ol" : "ul");
        while (index < lines.length && isList(lines[index]) && /^ {0,3}\d+[.)]/.test(lines[index]) === ordered) {
          const item = document.createElement("li");
          appendInline(item, lines[index++].replace(/^ {0,3}(?:[-+*]|\d+[.)])\s+/, ""), copyCode); list.append(item);
        }
        root.append(list); continue;
      }

      const paragraphLines = [];
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], index)) paragraphLines.push(lines[index++]);
      if (!paragraphLines.length) { appendText(root, lines[index++]); continue; }
      const paragraph = document.createElement("p"); appendInline(paragraph, paragraphLines.join("\n"), copyCode); root.append(paragraph);
    }
  }

  window.SafeMarkdown = { render };
})();
