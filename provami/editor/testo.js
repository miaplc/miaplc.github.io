// ============================================================
//  EspPlc — testo.js
//  FC scritte in testo: dal testo all'albero (AST) che compiler.js traduce nelle istruzioni della VM (5.1: salti, array).
//  Due scritture dello stesso linguaggio, stesso albero:
//    ST, testo strutturato (IEC 61131-3):  IF #a > 10 THEN #b := TRUE; ELSIF #c THEN ... ELSE ... END_IF;
//                            FOR #i := 0 TO 9 BY 1 DO ... END_FOR;  WHILE ... DO ... END_WHILE;  REPEAT ... UNTIL ... END_REPEAT;
//                            CASE #n OF 1: ...; 2, 5..7: ...; ELSE ... END_CASE;  EXIT;  CONTINUE;  RETURN;
//    C (sintassi del C, solo quello che c'è anche in ST): if (a > 10) { b = true; } else if (c) { } else { }
//                            for (i = 0; i < 10; i++) { }  while (c) { }  do { } while (c);  switch (n) { case 1: ...; break; default: ... }
//                            break;  continue;  return;
//  Operandi: #nome (interfaccia della FC; in C senza #), "DB".campo o DB3.campo, I5 Q0 M100 (un numero per bit, come nel
//  ladder; anche %I5), T5 (bit del timer), SM0..SM5, elementi di array nome[indice]; "Nome" (in C anche Nome senza
//  virgolette, se non è dell'interfaccia) = un simbolo della tabella dei simboli. Costanti: 12, -3, 16#FF / 0xFF, 2#1010, 1.5, TRUE/FALSE.
//  Espressioni: OR XOR AND NOT (|| ^ && !), = <> < > <= >= (== !=), + - * / MOD (%), parentesi.
//
//  Albero (ogni nodo ha .pos = { line, col } per gli errori):
//    Stmt = { k: "assign", to: Ref, e: Expr } | { k: "if", arms: [{ c: Expr, body }], els: body|null }
//         | { k: "case", e, arms: [{ labels: [{ lo, hi }], body }], els } | { k: "for", v: Ref, from, to, by, body }
//         | { k: "while", c, body } | { k: "repeat", body, c } | { k: "exit" } | { k: "continue" } | { k: "return" }
//    Expr = { k: "num", v, real } | { k: "bool", v } | { k: "ref", r: Ref } | { k: "un", op, e } | { k: "bin", op, a, b }
//    Ref  = { ns: "L", v } | { ns: "DB", db, f } (db: numero o nome) | { ns: "I"|"Q"|"M"|"T"|"SM", idx } | { ns: "SYM", name },
//           con .index = Expr per un elemento di array
//  Errori: EspText.parse ritorna { ok, stmts, errors: [{ line, col, msg }] } (l'errore fra i primi, il resto del testo non si legge)
// ============================================================
(function (root) {
  "use strict";

  // ── parole e simboli ──
  const KW_ST = new Set(["IF", "THEN", "ELSIF", "ELSE", "END_IF", "CASE", "OF", "END_CASE", "FOR", "TO", "BY", "DO", "END_FOR",
    "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT", "EXIT", "CONTINUE", "RETURN", "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE"]);
  const KW_C = new Set(["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "true", "false"]);
  const SYM = [":=", "<>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "..",
               "(", ")", "[", "]", "{", "}", ";", ":", ",", ".", "+", "-", "*", "/", "%", "=", "<", ">", "!", "^", "&", "|"];

  class SclError extends Error { constructor(msg, pos) { super(msg); this.pos = pos || { line: 1, col: 1 }; } }

  // ── testo → parole ──
  function lex(text, ard) {
    const out = [];
    let i = 0, line = 1, col = 1;
    const at = () => ({ line, col });
    const adv = n => { for (let k = 0; k < n; k++) { if (text[i] === "\n") { line++; col = 1; } else col++; i++; } };
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(1); continue; }
      if (text.startsWith("//", i)) { while (i < text.length && text[i] !== "\n") adv(1); continue; }
      if (!ard && text.startsWith("(*", i)) { const p = at(); const e = text.indexOf("*)", i + 2); if (e < 0) throw new SclError("commento (* senza *)", p); adv(e + 2 - i); continue; }
      if (text.startsWith("/*", i)) { const p = at(); const e = text.indexOf("*/", i + 2); if (e < 0) throw new SclError("commento /* senza */", p); adv(e + 2 - i); continue; }
      const p = at();
      if (c === '"') {                                    // nome di un DB tra virgolette
        const e = text.indexOf('"', i + 1);
        if (e < 0 || text.slice(i, e).includes("\n")) throw new SclError("nome tra virgolette non chiuso", p);
        out.push({ t: "qname", v: text.slice(i + 1, e), pos: p }); adv(e + 1 - i); continue;
      }
      // numeri: 12  1.5  1e3  16#FF  2#1010  0xFF  0b1010
      const num = /^(?:(2|8|16)#([0-9A-Fa-f_]+)|0[xX]([0-9A-Fa-f]+)|0[bB]([01]+)|(\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?))/.exec(text.slice(i));
      if (num && /\d/.test(c)) {
        let v, real = false;
        if (num[1]) v = parseInt(num[2].replace(/_/g, ""), +num[1]);
        else if (num[3]) v = parseInt(num[3], 16);
        else if (num[4]) v = parseInt(num[4], 2);
        else { const s = num[5].replace(/_/g, ""); real = /[.eE]/.test(s); v = Number(s); }
        // 1..5 (CASE): «1.» non è un REAL
        if (real && num[5] && text.startsWith("..", i + num[5].indexOf("."))) { const s = num[5].slice(0, num[5].indexOf(".")); out.push({ t: "num", v: Number(s), real: false, pos: p }); adv(s.length); continue; }
        out.push({ t: "num", v, real, pos: p }); adv(num[0].length); continue;
      }
      // v5.2: tempi T#1m30s, T#250ms, TIME#2h (in ms, un DINT)
      const tl = /^(?:TIME|T)#(-?)((?:\d+(?:\.\d+)?(?:ms|d|h|m|s)_?)+)(?![\w])/i.exec(text.slice(i));
      if (tl) {
        const U = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
        let v = 0;
        for (const x of tl[2].matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi)) v += Number(x[1]) * U[x[2].toLowerCase()];
        v = Math.round(tl[1] ? -v : v);
        if (Math.abs(v) > 2147483647) throw new SclError(`${tl[0]}: oltre ±24 giorni`, p);
        out.push({ t: "num", v, real: false, pos: p }); adv(tl[0].length); continue;
      }
      // indirizzi: %I0.0 I0.0 Q1.2 M10.3 T5 SM0 (prima dei nomi: «I0» non è un nome)
      const adr = /^%?(I|Q|M|T|SM)(\d+)(?:\.(\d))?(?![\w.])/.exec(text.slice(i));
      if (adr && (c === "%" || !/[\w]/.test(text[i - 1] || ""))) {
        out.push({ t: "adr", ns: adr[1], idx: +adr[2], bit: adr[3] != null ? +adr[3] : null, pos: p }); adv(adr[0].length); continue;
      }
      const id = /^#?[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      if (id) {
        const s = id[0];
        if (s[0] !== "#" && (ard ? KW_C.has(s) : KW_ST.has(s.toUpperCase()))) out.push({ t: "kw", v: ard ? s : s.toUpperCase(), pos: p });
        else out.push({ t: "id", v: s[0] === "#" ? s.slice(1) : s, hash: s[0] === "#", pos: p });
        adv(s.length); continue;
      }
      const sym = SYM.find(s => text.startsWith(s, i));
      if (sym) { out.push({ t: "sym", v: sym, pos: p }); adv(sym.length); continue; }
      throw new SclError(`carattere non valido: «${c}»`, p);
    }
    out.push({ t: "end", pos: at() });
    return out;
  }

  // ── parole → albero ──
  function parser(toks, ard) {
    let p = 0;
    const peek = (k = 0) => toks[Math.min(p + k, toks.length - 1)];
    const isKw = (v, k = 0) => peek(k).t === "kw" && peek(k).v === v;
    const isSym = (v, k = 0) => peek(k).t === "sym" && peek(k).v === v;
    const next = () => toks[p < toks.length - 1 ? p++ : p];
    const what = t => t.t === "end" ? "fine del testo" : t.t === "num" ? `«${t.v}»` : t.t === "adr" ? `«${t.ns}${t.idx}${t.bit != null ? "." + t.bit : ""}»` : `«${t.v}»`;
    const fail = (msg, t) => { throw new SclError(msg, (t || peek()).pos); };
    const kw = v => { if (!isKw(v)) fail(`atteso ${v}, trovato ${what(peek())}`); return next(); };
    const sym = v => { if (!isSym(v)) fail(`atteso «${v}», trovato ${what(peek())}`); return next(); };
    const semi = () => { if (!isSym(";")) fail(`manca «;» prima di ${what(peek())}`); next(); };

    // espressioni, dalla precedenza più bassa
    const BIN = ard
      ? [["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "%"]]
      : [["OR"], ["XOR"], ["AND", "&"], ["=", "<>"], ["<", ">", "<=", ">="], ["+", "-"], ["*", "/", "MOD"]];
    const NORM = { "||": "OR", "&&": "AND", "^": "XOR", "|": "BOR", "&": ard ? "BAND" : "AND", "==": "=", "!=": "<>", "%": "MOD" };
    function binary(lvl) {
      if (lvl === BIN.length) return unary();
      let a = binary(lvl + 1);
      for (;;) {
        const t = peek();
        if (!((t.t === "sym" || t.t === "kw") && BIN[lvl].includes(t.v))) return a;
        next();
        const b = binary(lvl + 1);
        a = { k: "bin", op: NORM[t.v] || t.v, a, b, pos: t.pos };
      }
    }
    function unary() {
      const t = peek();
      if ((ard && isSym("!")) || (!ard && isKw("NOT"))) { next(); return { k: "un", op: "NOT", e: unary(), pos: t.pos }; }
      if (isSym("-")) { next(); const e = unary(); return e.k === "num" ? Object.assign(e, { v: -e.v }) : { k: "un", op: "NEG", e, pos: t.pos }; }
      if (isSym("+")) { next(); return unary(); }
      return primary();
    }
    function primary() {
      const t = peek();
      if (t.t === "num") { next(); return { k: "num", v: t.v, real: t.real, pos: t.pos }; }
      if (isKw(ard ? "true" : "TRUE") || isKw(ard ? "false" : "FALSE")) { next(); return { k: "bool", v: /^t/i.test(t.v), pos: t.pos }; }
      if (isSym("(")) { next(); const e = expr(); sym(")"); return e; }
      if (t.t === "id" || t.t === "qname" || t.t === "adr") return { k: "ref", r: ref(), pos: t.pos };
      fail(`atteso un valore, trovato ${what(t)}`);
    }
    const expr = () => binary(0);
    // operando (anche a sinistra di :=)
    function ref() {
      const t = next();
      let r;
      if (t.t === "adr") {
        // come nel resto dell'editor: un numero per bit (I5, Q0, M100), senza «.»
        if (t.bit != null) fail(`${t.ns}${t.idx}.${t.bit}: si scrive ${t.ns}${t.idx * 8 + t.bit} (un numero per bit, come nel ladder)`, t);
        r = { ns: t.ns, idx: t.idx };
      } else if (t.t === "qname" && !isSym(".")) {        // "Nome": un simbolo della tabella dei simboli
        r = { ns: "SYM", name: t.v };
      } else if (t.t === "qname" || (t.t === "id" && /^DB\d+$/i.test(t.v) && isSym("."))) {
        sym(".");
        const f = next();
        if (f.t !== "id") fail(`atteso il nome di un campo dopo «.»`, f);
        r = { ns: "DB", db: t.t === "qname" ? t.v : +t.v.slice(2), f: f.v };
      } else if (t.t === "id") {
        if (!ard && !t.hash) fail(`«${t.v}»: le variabili dell'interfaccia si scrivono con # (#${t.v}); un DB tra virgolette ("${t.v}".campo)`, t);
        r = { ns: "L", v: t.v };
      } else fail(`atteso un operando, trovato ${what(t)}`, t);
      // v5.2: campo di una struttura ("Dati".mot.vel, #t.Q)
      if (r.ns === "DB" || r.ns === "L") { const k = r.ns === "DB" ? "f" : "v"; while (isSym(".") && peek(1).t === "id") { next(); r[k] += "." + next().v; } }
      r.pos = t.pos;
      if (isSym("[")) {
        if (r.ns !== "L" && r.ns !== "DB") fail("solo le variabili e i campi dei DB possono essere array", t);
        next(); r.index = expr(); sym("]");
      }
      return r;
    }

    // istruzioni
    function body(ends) {                               // fino a una delle parole ends (non letta)
      const out = [];
      while (!ends.some(e => isKw(e) || isSym(e)) && peek().t !== "end") out.push(stmt());
      return out;
    }
    function stmt() {
      return ard ? stmtArd() : stmtScl();
    }
    function assignTail(r, pos) {                        // dopo l'operando: := espressione (ST) / = ++ -- += -= (C)
      if (!ard) { sym(":="); const e = expr(); return { k: "assign", to: r, e, pos }; }
      if (isSym("++") || isSym("--")) { const o = next(); return { k: "assign", to: r, e: { k: "bin", op: o.v[0], a: { k: "ref", r, pos }, b: { k: "num", v: 1, real: false, pos }, pos }, pos }; }
      if (isSym("+=") || isSym("-=")) { const o = next(); const e = expr(); return { k: "assign", to: r, e: { k: "bin", op: o.v[0], a: { k: "ref", r, pos }, b: e, pos }, pos }; }
      sym("="); const e = expr(); return { k: "assign", to: r, e, pos };
    }
    function stmtScl() {
      const t = peek();
      if (isKw("IF")) {
        next(); const arms = []; let els = null;
        const c = expr(); kw("THEN"); arms.push({ c, body: body(["ELSIF", "ELSE", "END_IF"]) });
        while (isKw("ELSIF")) { next(); const c2 = expr(); kw("THEN"); arms.push({ c: c2, body: body(["ELSIF", "ELSE", "END_IF"]) }); }
        if (isKw("ELSE")) { next(); els = body(["END_IF"]); }
        kw("END_IF"); semi();
        return { k: "if", arms, els, pos: t.pos };
      }
      if (isKw("CASE")) {
        next(); const e = expr(); kw("OF");
        const arms = []; let els = null;
        while (!isKw("ELSE") && !isKw("END_CASE")) {
          const labels = caseLabels();
          sym(":");
          arms.push({ labels, body: caseBody() });
          if (peek().t === "end") fail("manca END_CASE");
        }
        if (isKw("ELSE")) { next(); els = body(["END_CASE"]); }
        kw("END_CASE"); semi();
        return { k: "case", e, arms, els, pos: t.pos };
      }
      if (isKw("FOR")) {
        next(); const v = ref(); sym(":="); const from = expr(); kw("TO"); const to = expr();
        let by = null; if (isKw("BY")) { next(); by = expr(); }
        kw("DO"); const b = body(["END_FOR"]); kw("END_FOR"); semi();
        return { k: "for", v, from, to, by, body: b, pos: t.pos };
      }
      if (isKw("WHILE")) { next(); const c = expr(); kw("DO"); const b = body(["END_WHILE"]); kw("END_WHILE"); semi(); return { k: "while", c, body: b, pos: t.pos }; }
      if (isKw("REPEAT")) { next(); const b = body(["UNTIL"]); kw("UNTIL"); const c = expr(); kw("END_REPEAT"); semi(); return { k: "repeat", body: b, c, pos: t.pos }; }
      if (isKw("EXIT")) { next(); semi(); return { k: "exit", pos: t.pos }; }
      if (isKw("CONTINUE")) { next(); semi(); return { k: "continue", pos: t.pos }; }
      if (isKw("RETURN")) { next(); semi(); return { k: "return", pos: t.pos }; }
      if (isSym(";")) { next(); return { k: "nop", pos: t.pos }; }
      if (t.t === "id" || t.t === "qname" || t.t === "adr") { const r = ref(); const s = assignTail(r, t.pos); semi(); return s; }
      fail(`istruzione non valida: ${what(t)}`);
    }
    function caseLabels() {
      const out = [];
      for (;;) {
        const lo = expr();
        let hi = lo;
        if (isSym("..")) { next(); hi = expr(); }
        for (const e of [lo, hi]) if (e.k !== "num" || e.real) fail("CASE: le etichette sono numeri interi (es. 1, 2..5)", toks[p - 1]);
        out.push({ lo: lo.v, hi: hi.v });
        if (!isSym(",")) return out;
        next();
      }
    }
    function caseBody() {                               // fino alla prossima etichetta «n:» / «n..m:» / «n,», ELSE, END_CASE
      const out = [];
      const label = () => peek().t === "num" || (isSym("-") && peek(1).t === "num");
      while (!isKw("ELSE") && !isKw("END_CASE") && !label() && peek().t !== "end") out.push(stmt());
      return out;
    }
    function block() {                                  // C: { ... } o una istruzione sola
      if (isSym("{")) { next(); const b = body(["}"]); sym("}"); return b; }
      return [stmt()];
    }
    function stmtArd() {
      const t = peek();
      if (isKw("if")) {
        const arms = []; let els = null;
        next(); sym("("); const c = expr(); sym(")"); arms.push({ c, body: block() });
        while (isKw("else") && isKw("if", 1)) { next(); next(); sym("("); const c2 = expr(); sym(")"); arms.push({ c: c2, body: block() }); }
        if (isKw("else")) { next(); els = block(); }
        return { k: "if", arms, els, pos: t.pos };
      }
      if (isKw("while")) { next(); sym("("); const c = expr(); sym(")"); return { k: "while", c, body: block(), pos: t.pos }; }
      if (isKw("do")) {
        next(); const b = block(); kw("while"); sym("("); const c = expr(); sym(")"); semi();
        return { k: "repeat", body: b, c: { k: "un", op: "NOT", e: c, pos: c.pos }, pos: t.pos };   // do … while (c) = REPEAT … UNTIL NOT c
      }
      if (isKw("for")) {
        // for (i = a; i < b; i++)  /  i <= b  /  i += k  /  i > b; i--: diventa un FOR con TO e BY
        next(); sym("(");
        const v = ref(); sym("="); const from = expr(); semi();
        const cv = ref(); if (!sameRef(cv, v)) fail("for: la condizione deve usare la variabile del ciclo", toks[p - 1]);
        const ct = next(); if (!(ct.t === "sym" && ["<", "<=", ">", ">="].includes(ct.v))) fail("for: la condizione è < <= > o >=", ct);
        const lim = expr(); semi();
        const sv = ref(); if (!sameRef(sv, v)) fail("for: il passo deve cambiare la variabile del ciclo", toks[p - 1]);
        let by;
        if (isSym("++") || isSym("--")) { const o = next(); by = { k: "num", v: o.v === "++" ? 1 : -1, real: false, pos: o.pos }; }
        else if (isSym("+=") || isSym("-=")) { const o = next(); const e = expr(); if (e.k !== "num" || e.real) fail("for: il passo è un numero intero (i += 2)", o); by = { k: "num", v: o.v === "+=" ? e.v : -e.v, real: false, pos: o.pos }; }
        else fail("for: il passo è i++, i--, i += n o i -= n");
        sym(")");
        if ((by.v > 0) !== (ct.v[0] === "<")) fail("for: il passo va nel verso sbagliato rispetto alla condizione", ct);
        // i < b  →  TO b - 1;  i > b  →  TO b + 1
        const to = ct.v.length === 2 ? lim : { k: "bin", op: by.v > 0 ? "-" : "+", a: lim, b: { k: "num", v: 1, real: false, pos: ct.pos }, pos: ct.pos };
        return { k: "for", v, from, to, by, body: block(), pos: t.pos };
      }
      if (isKw("switch")) {
        next(); sym("("); const e = expr(); sym(")"); sym("{");
        const arms = []; let els = null;
        while (!isSym("}")) {
          if (isKw("default")) { next(); sym(":"); els = switchBody(); continue; }
          const labels = [];
          while (isKw("case")) { next(); const v = expr(); if (v.k !== "num" || v.real) fail("case: un numero intero", toks[p - 1]); labels.push({ lo: v.v, hi: v.v }); sym(":"); }
          if (!labels.length) fail(`atteso case o default, trovato ${what(peek())}`);
          arms.push({ labels, body: switchBody() });
        }
        next();
        return { k: "case", e, arms, els, pos: t.pos };
      }
      if (isKw("break")) { next(); semi(); return { k: "exit", pos: t.pos }; }
      if (isKw("continue")) { next(); semi(); return { k: "continue", pos: t.pos }; }
      if (isKw("return")) { next(); semi(); return { k: "return", pos: t.pos }; }
      if (isSym("{")) return { k: "block", body: block(), pos: t.pos };
      if (isSym(";")) { next(); return { k: "nop", pos: t.pos }; }
      if (t.t === "id" || t.t === "qname" || t.t === "adr") { const r = ref(); const s = assignTail(r, t.pos); semi(); return s; }
      fail(`istruzione non valida: ${what(t)}`);
    }
    // corpo di un case: fino al prossimo case/default/}; deve finire con break (niente «caduta» nel case dopo)
    function switchBody() {
      const out = [];
      while (!isKw("case") && !isKw("default") && !isSym("}") && peek().t !== "end") {
        if (isKw("break")) { next(); semi(); return out; }
        out.push(stmt());
      }
      const last = out[out.length - 1];                   // continue / return: no fall-through either
      if (out.length && !(isSym("}")) && last.k !== "continue" && last.k !== "return") fail("case: finisce con break; (il passaggio al case dopo non c'è)");
      return out;
    }
    const sameRef = (a, b) => a.ns === b.ns && a.v === b.v && a.db === b.db && a.f === b.f && a.idx === b.idx && !a.index && !b.index;

    const stmts = [];
    while (peek().t !== "end") stmts.push(stmt());
    return stmts;
  }

  function parse(text, opts) {
    const ard = !!(opts && opts.lang === "C");
    try {
      return { ok: true, stmts: parser(lex(String(text || ""), ard), ard), errors: [] };
    } catch (e) {
      if (!(e instanceof SclError)) throw e;
      return { ok: false, stmts: [], errors: [{ line: e.pos.line, col: e.pos.col, msg: e.message }] };
    }
  }

  const api = { parse, lex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EspText = api;
})(typeof window !== "undefined" ? window : globalThis);
