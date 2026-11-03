/* Render a safe TeX math subset as native MathML (no HTML parsing or external assets). */
(() => {
  "use strict";
  const NS = "http://www.w3.org/1998/Math/MathML";
  const symbols = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ϵ", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    times: "×", cdot: "⋅", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", propto: "∝", infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", land: "∧", lor: "∨", neg: "¬", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔", mapsto: "↦", cdots: "⋯", ldots: "…", vdots: "⋮", ddots: "⋱", prime: "′", emptyset: "∅", angle: "∠", degree: "°", ell: "ℓ", Re: "ℜ", Im: "ℑ", hbar: "ℏ", esint: "∮"
  };
  const greek = new Set("alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega".split(" "));
  const operators = new Set(["sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigcup", "bigcap", "bigvee", "bigwedge", "lim", "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "min", "max", "sup", "inf", "det", "gcd", "Pr"]);
  const spacing = { ",": "0.167em", ";": "0.278em", ":": "0.222em", "!": "-0.167em", quad: "1em", qquad: "2em", enspace: "0.5em" };

  function element(tag, text) {
    const result = document.createElementNS(NS, tag);
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function row(nodes) {
    if (nodes.length === 1) return nodes[0];
    const result = element("mrow"); result.append(...nodes); return result;
  }
  function fenced(content, open = "(", close = ")") {
    const group = element("mrow");
    const left = element("mo", open); const right = element("mo", close);
    left.setAttribute("stretchy", "true"); right.setAttribute("stretchy", "true");
    group.append(left, content, right); return group;
  }
  function readTextGroup(state) {
    while (/\s/.test(state.source[state.index] || "")) state.index++;
    if (state.source[state.index] !== "{") return "";
    state.index++;
    const start = state.index;
    let depth = 1;
    while (state.index < state.source.length && depth) {
      if (state.source[state.index] === "\\") { state.index += 2; continue; }
      if (state.source[state.index] === "{") depth++;
      if (state.source[state.index] === "}") depth--;
      state.index++;
    }
    return state.source.slice(start, depth ? state.source.length : state.index - 1);
  }
  function splitMathRows(source) {
    const rows = []; let current = ""; let depth = 0;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === "\\" && source[index + 1] === "\\" && depth === 0) { rows.push(current); current = ""; index++; continue; }
      if (char === "\\") { current += char + (source[index + 1] || ""); index++; continue; }
      if (char === "{") depth++;
      if (char === "}") depth--;
      current += char;
    }
    if (current.trim() || !rows.length) rows.push(current);
    return rows;
  }
  function splitMathCells(source) {
    const cells = []; let current = ""; let depth = 0;
    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === "\\") { current += char + (source[index + 1] || ""); index++; continue; }
      if (char === "{") depth++;
      if (char === "}") depth--;
      if (char === "&" && depth === 0) { cells.push(current); current = ""; continue; }
      current += char;
    }
    cells.push(current);
    return cells;
  }

  function parse(source) {
    const state = { source, index: 0 };
    function skipSpace() { while (/\s/.test(state.source[state.index] || "")) state.index++; }
    function parseSequence(end = "") {
      const nodes = [];
      while (state.index < state.source.length) {
        const char = state.source[state.index];
        if (char === end && end) { state.index++; break; }
        if (/\s/.test(char)) { state.index++; continue; }
        if (char === "^") { state.index++; applyScript(nodes, "sup"); continue; }
        if (char === "_") { state.index++; applyScript(nodes, "sub"); continue; }
        if (char === "{") { state.index++; nodes.push(row(parseSequence("}"))); continue; }
        if (char === "\\") { const command = parseCommand(); if (command) nodes.push(command); continue; }
        if (/[0-9]/.test(char)) {
          let value = "";
          while (/[0-9.,]/.test(state.source[state.index] || "")) value += state.source[state.index++];
          nodes.push(element("mn", value)); continue;
        }
        if (/[A-Za-z]/.test(char)) {
          nodes.push(element("mi", state.source[state.index++])); continue;
        }
        state.index++;
        if ("+-=<>(),;:|[]".includes(char)) nodes.push(element("mo", char));
        else if (char === "&") nodes.push(element("mo", "&"));
        else nodes.push(element("mi", char));
      }
      return nodes;
    }
    function readArgument() {
      skipSpace();
      if (state.source[state.index] === "{") { state.index++; return row(parseSequence("}")); }
      if (state.source[state.index] === "\\") return parseCommand() || element("mrow");
      if (state.index >= state.source.length) return element("mrow");
      if (/[0-9]/.test(state.source[state.index])) {
        return element("mn", state.source[state.index++]);
      }
      return element(/[A-Za-z]/.test(state.source[state.index]) ? "mi" : "mo", state.source[state.index++]);
    }
    function readOptionalArgument() {
      skipSpace();
      if (state.source[state.index] !== "[") return null;
      state.index++;
      const start = state.index;
      let depth = 0;
      while (state.index < state.source.length) {
        const char = state.source[state.index];
        if (char === "{") depth++;
        if (char === "}") depth--;
        if (char === "]" && depth === 0) break;
        state.index++;
      }
      const value = state.source.slice(start, state.index);
      if (state.source[state.index] === "]") state.index++;
      return parse(value);
    }
    function applyScript(nodes, kind) {
      const script = readArgument();
      let base = nodes.pop() || element("mi", "□");
      let sub = null; let sup = null;
      if (base.localName === "msub") { sub = base.children[1]; base = base.children[0]; }
      else if (base.localName === "msup") { sup = base.children[1]; base = base.children[0]; }
      else if (base.localName === "msubsup") { sub = base.children[1]; sup = base.children[2]; base = base.children[0]; }
      if (kind === "sub") sub = script; else sup = script;
      const combined = element(sub && sup ? "msubsup" : sub ? "msub" : "msup");
      combined.append(base);
      if (sub) combined.append(sub);
      if (sup) combined.append(sup);
      nodes.push(combined);
    }
    function parseCommand() {
      state.index++;
      if (state.index >= state.source.length) return element("mtext", "\\");
      let command;
      if (/[A-Za-z]/.test(state.source[state.index])) {
        const start = state.index;
        while (/[A-Za-z]/.test(state.source[state.index] || "")) state.index++;
        command = state.source.slice(start, state.index);
      } else command = state.source[state.index++];

      if (["frac", "dfrac", "tfrac"].includes(command)) {
        const fraction = element("mfrac"); fraction.append(readArgument(), readArgument()); return fraction;
      }
      if (command === "begin") {
        const environment = readTextGroup(state);
        const allowed = new Set(["matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases", "aligned", "align"]);
        if (!allowed.has(environment)) return element("mtext", `\\begin{${environment}}`);
        const terminator = `\\end{${environment}}`;
        const end = state.source.indexOf(terminator, state.index);
        if (end < 0) return element("mtext", `\\begin{${environment}}`);
        const contents = state.source.slice(state.index, end);
        state.index = end + terminator.length;
        const table = element("mtable");
        for (const sourceRow of splitMathRows(contents)) {
          const tableRow = element("mtr");
          for (const sourceCell of splitMathCells(sourceRow)) {
            const cell = element("mtd"); cell.append(parse(sourceCell.trim())); tableRow.append(cell);
          }
          table.append(tableRow);
        }
        if (environment === "cases") {
          const cases = element("mrow"); const brace = element("mo", "{"); brace.setAttribute("stretchy", "true");
          cases.append(brace, table); return cases;
        }
        const fences = { pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"] }[environment];
        if (!fences) return table;
        return fenced(table, fences[0], fences[1]);
      }
      if (command === "sqrt") {
        const degree = readOptionalArgument(); const radicand = readArgument();
        const root = element(degree ? "mroot" : "msqrt");
        if (degree) root.append(radicand, degree); else root.append(radicand);
        return root;
      }
      if (["text", "textrm", "textsf", "texttt"].includes(command)) return element("mtext", readTextGroup(state));
      if (command === "operatorname") return element("mi", readTextGroup(state));
      const variants = { mathrm: "normal", mathbf: "bold", mathit: "italic", mathbb: "double-struck", mathcal: "script", mathfrak: "fraktur" };
      if (Object.hasOwn(variants, command)) { const style = element("mstyle"); style.setAttribute("mathvariant", variants[command]); style.append(readArgument()); return style; }
      const accents = { overline: ["mover", "¯"], bar: ["mover", "¯"], hat: ["mover", "ˆ"], widehat: ["mover", "ˆ"], vec: ["mover", "→"], tilde: ["mover", "˜"], underline: ["munder", "_"], overrightarrow: ["mover", "→"] };
      if (Object.hasOwn(accents, command)) {
        const accent = element(accents[command][0]); accent.append(readArgument(), element("mo", accents[command][1]));
        accent.setAttribute("accent", "true"); return accent;
      }
      if (command === "binom") {
        const fraction = element("mfrac"); fraction.setAttribute("linethickness", "0"); fraction.append(readArgument(), readArgument());
        return fenced(fraction);
      }
      if (command === "left" || command === "right") {
        skipSpace();
        const delimiter = state.source[state.index] === "\\" ? parseCommand() : element("mo", state.source[state.index++] || "");
        delimiter.setAttribute("stretchy", "true"); return delimiter;
      }
      if (spacing[command]) { const space = element("mspace"); space.setAttribute("width", spacing[command]); return space; }
      if (command === "\\") return element("mspace", " ");
      if (command === "displaystyle" || command === "textstyle" || command === "scriptstyle") return null;
      if (Object.hasOwn(symbols, command)) return element(greek.has(command) ? "mi" : "mo", symbols[command]);
      const largeOperators = { sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂", bigvee: "⋁", bigwedge: "⋀" };
      if (Object.hasOwn(largeOperators, command)) return element("mo", largeOperators[command]);
      if (operators.has(command)) { const name = element("mi", command); name.setAttribute("mathvariant", "normal"); return name; }
      const escaped = { "%": "%", "_": "_", "{": "{", "}": "}", "$": "$", "#": "#", "&": "&", " ": "\\ " };
      if (Object.hasOwn(escaped, command)) return element("mo", escaped[command]);
      return element("mtext", `\\${command}`);
    }
    return row(parseSequence());
  }

  function render(expression, display = false) {
    const math = element("math");
    math.setAttribute("xmlns", NS);
    math.setAttribute("display", display ? "block" : "inline");
    math.setAttribute("class", display ? "math-display" : "math-inline");
    try {
      let depth = 0;
      if (expression.length > 8192) throw new Error("Expression too long");
      for (const char of expression) {
        if (char === "{" && ++depth > 64) throw new Error("Expression too deep");
        if (char === "}") depth--;
      }
      math.append(parse(expression));
    }
    catch { math.append(element("mtext", expression)); }
    return math;
  }
  window.SafeMath = { render };
})();
