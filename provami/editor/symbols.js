// ============================================================
//  EspPlc — symbols.js
//  Tabella dei simboli (testi simbolici): un nome e un commento per
//  operando I / Q / M / T, come una tabella delle variabili.
//
//  - Separata dal programma: non entra nel bytecode né nel sorgente
//    compresso sul PLC (non consuma la flash del programma).
//  - Archivio: file /symbols.json sullo SPIFFS del PLC
//      GET /api/plc/symbols  → il file (tabella vuota se non c'è)
//      PUT /api/plc/symbols  → lo riscrive (max 32 KB, firmware di prima)
//      v4.6: un file COMPRESSO (gzip) per area (I, Q, M, T, SM, MW…), a pezzi, in tutto fino a 256 KB
//            (spazio dei simboli = SPIFFS del PLC − 444 KB per il sistema): POST/DELETE /api/plc/symbols/file?part=M, GET /api/plc/symbols/parts,
//            GET /api/plc/symbols?gz=1&part=M. Si riscrivono solo le aree cambiate.
//    Copia nel browser (localStorage) per partire subito e per non perdere
//    modifiche se il PLC non risponde: restano "da salvare" e si riprova.
//  - Esporta CSV (foglio di calcolo, separatore ";"):   Operando;Nome;Commento
//    Importa CSV (separatore ; , o TAB) oppure il JSON:
//      { "format": "espplc-symbols", "version": 1,
//        "symbols": { "M5": { "name": "Motore_on", "comment": "…" } } }
//
//  API: EspSymbols.get(key) / nameOf(op) / lookup(name) / list() / set() /
//       remove() / clear() / count() / exportCSV() / exportJSON() /
//       parse(text) / merge(rows, replace) / mode() / setMode() / onChange(fn)
// ============================================================
(function () {
  "use strict";

  const NS = ["I", "Q", "M", "T", "SM", "MB", "MW", "MI", "MD", "MDI", "MR"];   // v3.1: anche le aree numeriche
  const MAX_IDX = { I: 1023, Q: 1023, M: 1023, T: 255, SM: 5 };
  const WBITS = { MB: 8, MW: 16, MI: 16, MD: 32, MDI: 32 };                     // v4.6: bit di una parola (MW3.5)
  // v4.6: bit di sistema, con il loro nome già pronto (si può cambiare nella tabella)
  const SM_NAMES = ["PrimoCiclo", "Sempre1", "Sempre0", "Clock_10Hz", "Clock_2Hz", "Clock_1Hz"];
  const SM_COMMENTS = ["bit di sistema: 1 nel primo ciclo dopo il passaggio in RUN", "bit di sistema: sempre 1", "bit di sistema: sempre 0",
                       "bit di sistema: clock 10 Hz (50 ms acceso, 50 ms spento)", "bit di sistema: clock 2 Hz (250 + 250 ms)", "bit di sistema: clock 1 Hz (500 + 500 ms)"];
  const smBuiltin = key => { const m = /^SM(\d)$/.exec(key || ""); return m && SM_NAMES[+m[1]] ? { name: SM_NAMES[+m[1]], comment: SM_COMMENTS[+m[1]] } : null; };
  const NUM_MAX = { MB: 255, MW: 255, MI: 255, MD: 127, MDI: 127, MR: 127 };
  const NAME_MAX = 32, COMMENT_MAX = 160;
  const LS = "espplc.symbols", LS_MODE = "espplc.labelMode";
  // etichette: "both" | "sym" | "addr", con "+c" = commento flottante al passaggio del mouse
  const MODES = ["both", "both+c", "sym", "addr+c", "addr"];

  const LS_PENDING = "espplc.symbols.pending";
  const URL_SYM = "/api/plc/symbols", PLC_MAX = 32768;
  let PLC_GZ_MAX = 312 * 1024;          // spazio per i simboli: lo dice il PLC (SPIFFS − 444 KB del sistema)
  async function gzip(text) {
    const cs = new CompressionStream("gzip"), w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(text)); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  // v4.6: sul PLC un file compresso per area (I, Q, M, T, SM, MB, MW, …): si riscrive solo l'area cambiata
  // (O = area delle uscite dei firmware di prima: si legge e poi si toglie)
  const PARTS = ["I", "Q", "O", "M", "T", "SM", "MB", "MW", "MI", "MD", "MDI", "MR"];
  function partDocs() {                                   // area → JSON (solo le aree con simboli)
    const by = new Map();
    for (const k of [...table.keys()].sort(keyCmp)) {
      const ns = parseKey(k).ns;
      if (!by.has(ns)) by.set(ns, {});
      by.get(ns)[k] = table.get(k);
    }
    const out = new Map();
    for (const [ns, symbols] of by) out.set(ns, JSON.stringify({ format: "espplc-symbols", version: 1, part: ns, symbols }));
    return out;
  }
  const gzCache = new Map();                              // JSON di un'area → byte compressi
  async function gzOf(json) {
    if (gzCache.has(json)) return gzCache.get(json);
    const g = await gzip(json);
    if (gzCache.size > 40) gzCache.clear();
    gzCache.set(json, g);
    return g;
  }
  // byte compressi in tutto (= quello che occupa sul PLC), per la barra «Simboli»
  let gzSize = 0, gzTimer = 0;
  const sizeListeners = [];
  function measure() {
    clearTimeout(gzTimer);
    gzTimer = setTimeout(async () => {
      let t = 0;
      try { for (const j of partDocs().values()) t += (await gzOf(j)).length; } catch (e) { t = exportJSON(true).length; }
      gzSize = t;
      sizeListeners.forEach(fn => { try { fn(gzSize, PLC_GZ_MAX); } catch (e) {} });
    }, 300);
  }
  let onPlc = new Map();                                  // area → JSON che c'è sul PLC (null = non si sa: si riscrive tutto)
  let plcKnown = false;
  const store = {                       // copia locale
    load() { try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { return null; } },
    save(doc) { try { localStorage.setItem(LS, JSON.stringify(doc)); } catch (e) {} },
    pending(v) {
      try { if (v === undefined) return localStorage.getItem(LS_PENDING) === "1";
            if (v) localStorage.setItem(LS_PENDING, "1"); else localStorage.removeItem(LS_PENDING); } catch (e) { return false; }
    },
  };

  // ── Sincronizzazione con il PLC ────────────────────
  // stato: loading | ok | pending | error | offline | nofw | toolarge
  let sync = "loading", syncMsg = "", upTimer = 0, retryMs = 3000;
  const syncListeners = [];
  function setSync(st, msg) {
    sync = st; syncMsg = msg || "";
    syncListeners.forEach(fn => { try { fn(sync, syncMsg); } catch (e) { console.error(e); } });
  }
  function scheduleUpload(ms) {
    clearTimeout(upTimer);
    upTimer = setTimeout(upload, ms);
    if (sync !== "error") setSync("pending");
  }
  async function upload() {
    clearTimeout(upTimer);
    try {
      // v4.6: solo le aree cambiate, compresse e a pezzi (in tutto fino a 256 KB);
      // firmware di prima: tutta la tabella in una volta, fino a 32 KB
      const docs = partDocs();
      let total = 0;
      for (const j of docs.values()) total += (await gzOf(j)).length;
      gzSize = total;
      if (total > PLC_GZ_MAX) { setSync("toolarge", `${(total / 1024).toFixed(0)} KB compressi > ${(PLC_GZ_MAX / 1024).toFixed(0)} KB per i simboli sul PLC`); return; }
      // prima le aree che si riducono o spariscono (fanno spazio), poi le altre
      const names = [...new Set([...docs.keys(), ...(plcKnown ? onPlc.keys() : PARTS)])];
      const old = ns => plcKnown && onPlc.has(ns) ? onPlc.get(ns).length : 0;
      names.sort((a, b) => ((docs.get(a) || "").length - old(a)) - ((docs.get(b) || "").length - old(b)));
      let sent = 0, kb = 0;
      for (const ns of names) {
        const j = docs.get(ns) || null;
        if (plcKnown && (onPlc.get(ns) || null) === j) continue;          // uguale a quella sul PLC
        let r;
        if (!j) {
          if (plcKnown && !onPlc.has(ns)) continue;
          r = await fetch(`${URL_SYM}/file?part=${ns}`, { method: "DELETE", headers: { "X-EspPlc": "1" } });
        } else {
          const gz = await gzOf(j), fd = new FormData();
          fd.append("f", new Blob([gz], { type: "application/gzip" }), `sym_${ns}.gz`);
          r = await fetch(`${URL_SYM}/file?part=${ns}`, { method: "POST", headers: { "X-EspPlc": "1" }, body: fd });
          kb += gz.length;
        }
        if (r.status === 404 || r.status === 405) return uploadOld();             // firmware di prima
        if (!r.ok) { let e = {}; try { e = await r.json(); } catch (x) {} throw new Error(e.msg || "HTTP " + r.status); }
        if (j) onPlc.set(ns, j); else onPlc.delete(ns);
        sent++;
      }
      plcKnown = true;
      store.pending(false); retryMs = 3000;
      setSync("ok", sent ? `${sent} ${sent === 1 ? "area" : "aree"} sul PLC (${(kb / 1024).toFixed(1)} KB compressi) · in tutto ${(total / 1024).toFixed(1)} KB`
                          : `uguale al PLC · ${(total / 1024).toFixed(1)} KB compressi`);
    } catch (e) {
      setSync("error", e.message);
      upTimer = setTimeout(upload, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }
  }
  async function uploadOld() {
    const body = exportJSON(true);
    if (body.length > PLC_MAX) { setSync("toolarge", `${(body.length / 1024).toFixed(1)} KB > ${PLC_MAX / 1024} KB: aggiorna il firmware del PLC (fino a 256 KB compressi)`); return; }
    const r = await fetch(URL_SYM, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (r.status === 404) { setSync("nofw", "il firmware non ha /api/plc/symbols"); return; }
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) {} throw new Error(j.msg || "HTTP " + r.status); }
    store.pending(false); retryMs = 3000;
    setSync("ok", `${body.length} B sul PLC`);
  }
  const unzipJson = async raw => JSON.parse(raw[0] === 0x1F && raw[1] === 0x8B
    ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(raw));
  // Lettura dal PLC all'avvio. Se nel browser ci sono modifiche non ancora
  // salvate vince il browser; altrimenti vale quello che c'è sul PLC.
  async function init() {
    setSync("loading");
    let doc, oldOut = false;
    try {
      // v4.6: le aree compresse; firmware di prima: un file solo (JSON o compresso)
      plcKnown = false; onPlc = new Map();
      const lp = await fetch(URL_SYM + "/parts");
      const L = lp.ok ? await lp.json() : null;
      if (L && L.max > 0) { PLC_GZ_MAX = L.max; measure(); }
      if (L && L.parts && Object.keys(L.parts).length) {
        doc = { format: "espplc-symbols", version: 1, symbols: {} };
        oldOut = "O" in L.parts;                          // uscite di prima (O): lette per prime, poi riscritte in Q
        for (const ns of Object.keys(L.parts).sort((a, b) => (b === "O") - (a === "O"))) {
          const r = await fetch(`${URL_SYM}?gz=1&part=${ns}`);
          if (!r.ok) throw new Error(`area ${ns}: HTTP ${r.status}`);
          const d = await unzipJson(new Uint8Array(await r.arrayBuffer()));
          Object.assign(doc.symbols, d.symbols || {});
        }
        plcKnown = true;                                  // onPlc si riempie qui sotto, dalla tabella letta
      } else {
        const r = await fetch(URL_SYM + "?gz=1");          // firmware di prima: ignora ?gz e dà il JSON
        if (r.status === 404) { setSync("nofw", "il firmware non ha /api/plc/symbols: simboli solo nel browser"); return "local"; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        doc = await unzipJson(new Uint8Array(await r.arrayBuffer()));
        plcKnown = !!(L && !L.legacy);                    // PLC nuovo e vuoto: si sa che non c'è niente
      }
    } catch (e) {
      if (store.pending()) { setSync("error", e.message); upTimer = setTimeout(upload, retryMs); }
      else setSync("offline", "PLC non raggiungibile: simboli dalla copia nel browser");
      return "local";
    }
    const remote = (doc && doc.format === "espplc-symbols" && doc.symbols) || {};
    // Vince il browser solo se ha modifiche non ancora salvate sul PLC. Un PLC
    // vuoto (SPIFFS formattato) resta vuoto: la copia nel browser non lo riempie.
    if (store.pending()) { plcKnown = false; scheduleUpload(0); return "local"; }   // non si sa cosa c'è: si riscrive tutto
    table = new Map();
    for (const [k, v] of Object.entries(remote)) {
      const p = parseKey(k);
      if (p && v && (v.name || v.comment)) table.set(p.key, { name: String(v.name || ""), comment: String(v.comment || "") });
    }
    rebuild();
    store.save(docOf());
    if (plcKnown) onPlc = partDocs();                     // il PLC ha esattamente queste aree
    if (plcKnown && oldOut) { onPlc.set("O", "old"); onPlc.delete("Q"); scheduleUpload(0); }
    setSync("ok", `${table.size} simboli dal PLC`);
    emit();
    return "plc";
  }

  let table = new Map();            // "M5" -> { name, comment }
  let byName = new Map();           // "motore_on" -> "M5"
  const listeners = [];

  function parseKey(k) {
    const m = /^\s*%?(MDI|MB|MW|MI|MD|MR|SM|[IOQMT])\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/i.exec(String(k || ""));
    if (!m) return null;
    const idx = +m[2], ns = m[1].toUpperCase() === "O" ? "Q" : m[1].toUpperCase();      // O = Q dei progetti di prima
    if (idx > (NUM_MAX[ns] ?? MAX_IDX[ns])) return null;
    if (m[3] === undefined) return { ns, idx, key: ns + idx };
    const bit = +m[3];
    if (!(ns in WBITS) || bit >= WBITS[ns]) return null;
    return { ns, idx, bit, key: `${ns}${idx}.${bit}` };
  }
  const keyOf = op => op ? op.ns + op.idx + (op.bit != null ? "." + op.bit : "") : "";
  const norm = n => String(n || "").trim().toLowerCase();

  function checkName(name, forKey) {
    const n = String(name || "").trim();
    if (!n) return null;
    if (n.length > NAME_MAX) return `nome troppo lungo (max ${NAME_MAX})`;
    if (/["';\t\r\n]/.test(n)) return "il nome non può contenere \" ' ; o a capo";
    if (/^(FC\d+|(MDI|MB|MW|MI|MD|MR|SM|[IOQMT])\d+(\.\d+)?)$/i.test(n)) return "il nome non può essere un indirizzo (es. M5, MW3, MW3.5, FC1)";
    const smi = SM_NAMES.findIndex(x => norm(x) === norm(n));
    if (smi >= 0 && forKey !== "SM" + smi) return `nome già usato da SM${smi} (bit di sistema)`;
    if (/^[+-]?\d/.test(n)) return "il nome non può iniziare con una cifra (si confonderebbe con una costante)";
    const other = byName.get(norm(n));
    if (other && other !== forKey) return `nome già usato da ${other}`;
    return null;
  }

  function rebuild() {
    byName = new Map();
    for (const [k, s] of table) if (s.name) byName.set(norm(s.name), k);
  }
  function docOf() {
    const symbols = {};
    [...table.keys()].sort(keyCmp).forEach(k => { symbols[k] = table.get(k); });
    return { format: "espplc-symbols", version: 1, symbols };
  }
  function persist() {
    store.save(docOf());
    store.pending(true);
    if (sync !== "nofw") scheduleUpload(500);      // più modifiche di fila = un solo invio
  }
  function emit() { measure(); listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
  function keyCmp(a, b) {
    const pa = parseKey(a), pb = parseKey(b);
    return NS.indexOf(pa.ns) - NS.indexOf(pb.ns) || pa.idx - pb.idx || (pa.bit ?? -1) - (pb.bit ?? -1);
  }

  // Imposta nome/commento di un operando. Nome e commento vuoti = elimina.
  // Ritorna un messaggio d'errore oppure null.
  function set(key, name, comment, silent) {
    const p = parseKey(key);
    if (!p) return "operando non valido (I, Q, M da 0 a 1023, T da 0 a 255, SM da 0 a 5, MW3.5…)";
    const n = String(name || "").trim(), c = String(comment || "").replace(/[\r\n\t]+/g, " ").trim();
    const err = checkName(n, p.key);
    if (err) return err;
    if (c.length > COMMENT_MAX) return `commento troppo lungo (max ${COMMENT_MAX})`;
    if (!n && !c) table.delete(p.key);
    else table.set(p.key, { name: n, comment: c });
    rebuild();
    if (!silent) { persist(); emit(); }
    return null;
  }

  // ── CSV / JSON ─────────────────────────────────────
  function csvCell(v) {
    v = String(v == null ? "" : v);
    return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCSV() {
    const lines = ["Operando;Nome;Commento"];
    [...table.keys()].sort(keyCmp).forEach(k => {
      const s = table.get(k);
      lines.push([k, s.name, s.comment].map(csvCell).join(";"));
    });
    return "﻿" + lines.join("\r\n") + "\r\n";     // BOM: i fogli di calcolo leggono le lettere accentate
  }
  function exportJSON(compact) { return JSON.stringify(docOf(), null, compact ? 0 : 2); }
  function splitCsv(text, sep) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === "") q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ""));
  }
  // Legge un file: ritorna { rows: [{line, key, name, comment}], errors: [..] }
  function parse(text) {
    text = String(text || "").replace(/^﻿/, "");
    const out = { rows: [], errors: [] };
    const t = text.trim();
    if (t.startsWith("{")) {
      let doc;
      try { doc = JSON.parse(t); } catch (e) { out.errors.push("JSON non valido: " + e.message); return out; }
      if (!doc || doc.format !== "espplc-symbols" || typeof doc.symbols !== "object") {
        out.errors.push("il JSON non è un file di simboli MiaPLC (format: espplc-symbols)"); return out;
      }
      Object.entries(doc.symbols).forEach(([k, s], i) =>
        out.rows.push({ line: i + 1, key: k, name: s && s.name, comment: s && s.comment }));
      return out;
    }
    const first = t.split(/\r?\n/)[0] || "";
    const sep = [";", "\t", ","].map(s => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = splitCsv(text, sep);
    if (!rows.length) { out.errors.push("file vuoto"); return out; }
    // colonne dall'intestazione (italiano o inglese); senza intestazione: Operando, Nome, Commento
    let ci = { key: 0, name: 1, comment: 2 }, start = 0;
    const h = rows[0].map(c => norm(c));
    const find = (...names) => h.findIndex(c => names.includes(c));
    if (!parseKey(rows[0][0])) {
      const k = find("operando", "indirizzo", "address", "operand", "logical address");
      const n = find("nome", "simbolo", "name", "symbol", "tag");
      const c = find("commento", "comment", "descrizione", "description");
      if (k < 0 || n < 0) { out.errors.push("intestazione non riconosciuta: servono le colonne Operando e Nome"); return out; }
      ci = { key: k, name: n, comment: c }; start = 1;
    }
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      out.rows.push({ line: i + 1, key: r[ci.key], name: r[ci.name], comment: ci.comment >= 0 ? r[ci.comment] : "" });
    }
    return out;
  }
  // Applica le righe lette. replace=true: prima svuota la tabella.
  // Ritorna { added, updated, unchanged, errors: ["riga 4: …"] }
  function merge(rows, replace) {
    const backup = new Map(table);
    if (replace) { table = new Map(); rebuild(); }
    const res = { added: 0, updated: 0, unchanged: 0, errors: [] };
    const seen = new Set();
    // operandi riscritti dal file: il loro nome attuale si può spostare altrove
    const inFile = new Set(rows.map(r => parseKey(r.key)).filter(Boolean).map(p => p.key));
    for (const r of rows) {
      const p = parseKey(r.key);
      if (!p) { res.errors.push(`riga ${r.line}: operando «${r.key}» non valido`); continue; }
      if (seen.has(p.key)) { res.errors.push(`riga ${r.line}: ${p.key} ripetuto, tenuta la prima riga`); continue; }
      seen.add(p.key);
      const old = table.get(p.key);
      const name = String(r.name || "").trim(), comment = String(r.comment || "").trim();
      if (!name && !comment) continue;
      if (old && old.name === name && old.comment === comment) { res.unchanged++; continue; }
      // un nome che nel file passa a un altro operando: libera quello vecchio
      // solo se anche l'operando vecchio è nel file (verrà riscritto)
      const holder = byName.get(norm(name));
      if (holder && holder !== p.key && inFile.has(holder) && !seen.has(holder) && !replace) {
        const h = table.get(holder); table.set(holder, { name: "", comment: h.comment });
        if (!h.comment) table.delete(holder);
        rebuild();
      }
      const err = set(p.key, name, comment, true);
      if (err) { res.errors.push(`riga ${r.line}: ${p.key} — ${err}`); continue; }
      if (old) res.updated++; else res.added++;
    }
    if (replace && res.added + res.updated + res.unchanged === 0 && res.errors.length) { table = backup; rebuild(); }
    persist(); emit();
    return res;
  }

  // ── Caricamento ───────────────────────────────────
  (function load() {
    const doc = store.load();
    if (doc && doc.symbols) for (const [k, s] of Object.entries(doc.symbols)) {
      const p = parseKey(k);
      if (p && s && (s.name || s.comment)) table.set(p.key, { name: String(s.name || ""), comment: String(s.comment || "") });
    }
    rebuild();
  })();
  let mode = (() => { try { const m = localStorage.getItem(LS_MODE); return MODES.includes(m) ? m : "both"; } catch (e) { return "both"; } })();

  window.EspSymbols = {
    NAME_MAX, COMMENT_MAX, parseKey, keyOf, checkName, set,
    get: key => table.get(key) || smBuiltin(key),
    nameOf: op => { const s = op && table.get(keyOf(op)); return s && s.name ? s.name : (op && op.ns === "SM" && SM_NAMES[op.idx]) || ""; },
    lookup: name => {
      const k = byName.get(norm(name));
      if (k) return parseKey(k);
      const i = SM_NAMES.findIndex(x => norm(x) === norm(name));
      return i >= 0 && !table.get("SM" + i)?.name ? parseKey("SM" + i) : null;
    },
    SM_NAMES,
    list: () => [...table.keys()].sort(keyCmp).map(k => Object.assign({ key: k }, parseKey(k), table.get(k))),
    count: () => table.size,
    named: () => byName.size,
    remove: key => set(key, "", ""),
    clear: () => { table = new Map(); rebuild(); persist(); emit(); },
    exportCSV, exportJSON, parse, merge, keyCmp,
    init, retry: () => store.pending() ? upload() : init(),
    syncState: () => ({ state: sync, msg: syncMsg }),
    onSync: fn => syncListeners.push(fn),
    mode: () => mode.split("+")[0],
    floatTip: () => mode.endsWith("+c"),
    rawMode: () => mode,
    setMode: m => { if (!MODES.includes(m)) return; mode = m; try { localStorage.setItem(LS_MODE, m); } catch (e) {} emit(); },
    onChange: fn => listeners.push(fn),
    onSize: fn => { sizeListeners.push(fn); measure(); },          // v4.6: (byte compressi, spazio riservato)
    size: () => ({ bytes: gzSize, max: PLC_GZ_MAX }),
  };
})();
