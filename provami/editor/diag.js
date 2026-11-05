// ============================================================
//  EspPlc — diag.js  (Impostazioni e diagnostica: finestra grande dentro l'editor)
//  Stessa pagina dell'editor: le richieste passano dal suo collegamento (rete, USB, simulatore)
//  e mentre la finestra è aperta l'editor non legge lo stato (lo legge lei, con il suo SID).
//  Log a ricircolo del PLC: GET /api/plc/log?after=<seq> (solo le voci
//  nuove), POST /api/plc/log/config {bytes}. Il log non si azzera (solo
//  formattando lo SPIFFS): nessun pulsante e nessun endpoint per farlo.
//  Testi da log-texts.js.
// ============================================================
(function () {
  "use strict";
  const T = window.ESPPLC_LOG_TEXTS || { ids: {}, vals: {} };
  const $ = id => document.getElementById(id);
  // Aggiornamenti periodici: non si ridisegna una parte dove l'utente sta selezionando del testo o ha una tendina
  // (o un campo) aperta, altrimenti la selezione si perde e la tendina si chiude. Si riprova al giro dopo.
  function busyIn(el) {
    const a = document.activeElement, sel = window.getSelection && window.getSelection();
    if (a && el.contains(a) && /^(SELECT|INPUT|TEXTAREA)$/.test(a.tagName)) return true;
    return !!(sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer));
  }
  function put(el, html) { if (!el || el.innerHTML === html || busyIn(el)) return; el.innerHTML = html; }
  const LV = { info: 0, warn: 1, err: 2 };
  const hex8 = n => (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let rows = [], last = 0, info = null, busy = false;
  // SID dell'editor: con la Diagnostica aperta l'editor non legge lo stato, la legge lei per lui
  const sidq = () => window.ESPPLC_SID ? "&sid=" + window.ESPPLC_SID : "";
  async function api(path, opts) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(path, Object.assign({ signal: ctl.signal }, opts || {}));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.msg || "HTTP " + r.status);
      $("d-offline").classList.add("hidden");
      return j;
    } catch (e) { if (e.name === "AbortError" || /fetch/i.test(e.message)) $("d-offline").classList.remove("hidden"); throw e; }
    finally { clearTimeout(t); }
  }

  // ── Testo di una voce ─────────────────────────────
  const dur = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return h ? `${h} h ${m} min` : m ? `${m} min ${x} s` : `${x} s`; };
  function when(t) {
    if (t & 0x80000000) return "avvio +" + dur(t & 0x7FFFFFFF);
    return new Date(t * 1000).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "medium" });
  }
  // codice delle impostazioni cambiate (firmware set_code.h): «b1 d3 c» = campo b scelta 1, campo d scelta 3, campo c
  function setCode(v) {
    const out = [];
    for (let k = 0; k < 4; k++) { const b = (v >>> (8 * k)) & 255; if (!b) continue;
      out.push({ f: (b >> 3) - 1, s: b & 7 }); }
    return out;
  }
  function fmtVal(type, v) {
    if (!type) return v ? String(v) : "";
    if (type === "setcode_plc" && v === 1) return "rete";                     // firmware di prima: 1 = impostazioni di rete
    if (type.startsWith("setcode_")) return setCode(v).map(c => String.fromCharCode(97 + c.f) + (c.s === 7 ? "" : c.s)).join(" ");
    if (type === "src" && v >= 256) return `dall'editor ${fmtVal("ip", v)}`;
    if (type === "ppauto") return `id ${v >>> 8} · ${(T.vals.ppauto || {})[v & 255] || "codice " + (v & 255)}`;
    if (T.vals[type]) return T.vals[type][v] || `codice ${v}`;
    switch (type) {
      case "ip":    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24].join(".");
      case "mod": { const m = busCfg && busCfg.modules.find(x => x.station === v); return m && m.name ? `${m.name} (id ${v})` : `id ${v}`; }   // modulo uLink
      case "bytes": return `${v} B`;
      case "stopstart": return `stop 0x${(v >>> 16).toString(16)} · start 0x${(v & 0xFFFF).toString(16)}`;
      case "ms":    return `${v} ms`;
      case "us":    return v >= 1000 ? `${(v / 1000).toFixed(1)} ms` : `${v} µs`;
      case "crc":   return "CRC " + hex8(v);
      case "scans": return `dopo ${v} scansioni`;
      case "mbit":  return `M${v >>> 1} = ${v & 1}`;
      case "where": return where(v >>> 16, v & 0xFFFF);           // (per id 9 con l'istruzione: vedi describe)
      case "times": return `${v.toLocaleString("it-IT")} volte`;
      case "vars":  return `${v} variabili`;
      case "files": return `${v} file`;
      case "numkey": return (["MW", "MI", "MD", "MDI", "MR", "MB"][v >>> 16] || "?") + (v & 0xFFFF);
      default:      return String(v);
    }
  }
  function describe(e) {
    const [seq, t, id, sub, val] = e;
    const c = T.ids[id] || { name: `categoria ${id}` };
    let ev, lvl = c.level || "info", vt = c.val;
    const fl = (c.flags || (c.repeat ? [c.repeat] : [])).find(x => sub & x.flag);
    if (fl) { ev = `${fl.text}: ${fmtVal(c.sub_is, sub & 0xFF)}`; vt = fl.val; lvl = fl.level || lvl; }
    else if (c.sub_is) { ev = `${c.text}: ${fmtVal(c.sub_is, sub)}`; }
    else {
      const s = c.subs && c.subs[sub];
      if (typeof s === "string") ev = s;
      else if (s) { ev = s.text; lvl = s.level || lvl; vt = s.val; }
      else ev = `evento ${sub}`;
    }
    const det = id === 9 ? whereFull(val >>> 16, val & 0xFFFF, sub & 0xFF) : fmtVal(vt, val);   // errore: blocco, network, istruzione
    let tip = "";                                        // impostazioni cambiate: i campi del codice per esteso
    if (vt && vt.startsWith("setcode_") && !(vt === "setcode_plc" && val === 1)) {
      const names = (T.setcode || {})[vt.slice(8)] || [];
      tip = setCode(val).map(c => `${String.fromCharCode(97 + c.f)}${c.s === 7 ? "" : c.s}: ${names[c.f] || "campo " + c.f}`).join("\n");
    }
    return { seq, t, id, sub, val, vt, when: when(t), cat: c.name, ev, lvl, det, tip, boot: id === 1 && sub === 1 };
  }

  // ── Lettura e disegno ─────────────────────────────
  let bootSeq = null;                                  // avvio del PLC che ha dato il log (cambia a ogni riavvio)
  async function load(full) {
    if (busy) return;
    busy = true;
    try {
      // all'apertura solo le ultime voci (quelle a vista); le più vecchie dopo, a gradini (olderStep)
      const j = await api(full ? `/api/plc/log?tail=${LOG_FIRST}` : `/api/plc/log?after=${last}`);
      // PLC riavviato: le voci non ancora salvate prima del riavvio sono perse e i numeri ripartono da lì →
      // si rilegge tutto (prima: voci nuove con numeri già visti, come «Avvio», non comparivano)
      const rebooted = j.boot !== undefined && bootSeq !== null && j.boot !== bootSeq;
      if (j.boot !== undefined) bootSeq = j.boot;
      if (full || j.last < last || rebooted) { rows = []; last = 0; if (!full) return busy = false, load(true); }
      info = j;
      for (const e of j.entries) rows.push(describe(e));
      const keep = Math.max(4000, j.cap || 0);           // P4: fino a 16384 voci
      if (rows.length > keep) rows.splice(0, rows.length - keep);
      if (j.entries.length) last = j.entries[j.entries.length - 1][0];
      $("d-log-info").textContent = `${j.count} voci su ${j.cap} (${j.bytes} byte) · ultima #${j.last}`;
      logSizes(j);
      if (document.activeElement !== $("d-logsize")) $("d-logsize").value = String(j.bytes);
      if (full || j.entries.length) render();
    } catch (e) { $("d-log-info").textContent = "log non disponibile: " + e.message; }
    busy = false;
  }
  // Dimensioni del log scelte dal chip (firmware 0.3.61: min, max, def; P4 da 32 KB a 256 KB). Firmware di prima: le scelte fisse
  function logSizes(j) {
    if (!j.min || !j.max) return;
    const sel = $("d-logsize"), key = `${j.min}-${j.max}-${j.def}`;
    if (sel.dataset.sizes === key) return;
    sel.dataset.sizes = key;
    const opts = [];
    for (let b = j.min; b <= j.max; b *= 2) {
      const txt = (b < 1024 ? `${b} byte` : `${b / 1024} KB`) + ` — ${b / 16} voci` + (b === j.def ? " (default)" : b === j.max ? " (massimo)" : "");
      opts.push(`<option value="${b}">${txt}</option>`);
    }
    sel.innerHTML = opts.join("");
  }
  // Voci più vecchie di quelle lette: n per volta (?before=…&n=…). Firmware di prima: il log arriva già tutto.
  const LOG_FIRST = 64, LOG_STEP = 23;                   // a vista all'apertura; ~1 KB di risposta al secondo
  let olderDirty = false;
  const firstSeq = () => info ? Math.max(1, info.last - info.count + 1) : 1;
  const olderLeft = () => info && rows.length && rows[0].seq > firstSeq();
  async function loadOlder(n) {
    if (busy || !olderLeft()) return false;
    busy = true;
    try {
      const j = await api(`/api/plc/log?before=${rows[0].seq}&n=${n}`);
      const older = (j.entries || []).filter(e => e[0] < rows[0].seq).map(describe);
      if (!older.length) return false;
      rows.unshift(...older);
      if (nearEnd()) render(); else olderDirty = true;   // stanno in fondo alla tabella: si disegnano quando si arriva lì
      return true;
    } catch (e) { return false; } finally { busy = false; }
  }
  async function loadAllOlder() { while (await loadOlder(64)) {} if (olderDirty) { olderDirty = false; render(); } }
  const nearEnd = () => { const w = $("d-log").closest(".log-wrap"); return w.scrollTop + w.clientHeight > w.scrollHeight - 200; };
  function render() {
    const min = +$("d-level").value, f = $("d-filter").value.trim().toLowerCase();
    const tb = $("d-log").querySelector("tbody");
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {                 // più recenti in alto
      const r = rows[i];
      if (LV[r.lvl] < min) continue;
      if (f && !`${r.seq} ${r.when} ${r.cat} ${r.ev} ${r.det}`.toLowerCase().includes(f)) continue;
      out.push(`<tr class="${r.lvl}${r.boot ? " boot" : ""}" title="id ${r.id} · sub ${r.sub} · val ${r.val}">` +
        `<td class="seq">${r.seq}</td><td class="when">${esc(r.when)}</td><td class="code" title="id ${r.id}, sub ${r.sub} (0x${(r.sub >>> 0).toString(16)})">${r.id}.${r.sub > 255 ? (r.sub & 255) + "/" + (r.sub >> 8) : r.sub}</td>` +
        `<td class="lvl">${r.lvl === "err" ? "⛔" : r.lvl === "warn" ? "⚠" : "·"}</td>` +
        `<td>${esc(r.cat)}</td><td class="ev">${esc(r.ev)}</td><td${r.tip ? ` title="${esc(r.tip)}"` : ""}>${esc(r.det)}</td></tr>`);
    }
    put(tb, out.join("") || `<tr><td colspan="7" class="muted">Nessuna voce</td></tr>`);
  }

  // ── Errori del programma (GET /api/plc/diag) ─────────
  // Dove: blocco + offset → "FC3 network 2", ricompilando il sorgente del PLC
  // (stesso bytecode: si controlla il CRC di ogni blocco).
  let netMap = new Map(), netMapFor = null, symNames = new Map(), dbNames = new Map();
  function where(blk, off) {
    const m = netMap.get(blk);
    if (!m) return `${blk === 0xFFFF ? "StartUp" : blk ? "FC" + blk : "Main"} (offset ${off})`;
    let i = 0; m.nets.forEach((o, k) => { if (o <= off) i = k; });
    return `${m.label} network ${i + 1}`;
  }
  // Istruzione nel punto dell'errore, con le variabili (dal bytecode del blocco, uguale a quello del PLC)
  const AREA = ["MW", "MI", "MD", "MDI", "MR", "MB"], BOXOP = { 0x72: "+", 0x73: "−", 0x74: "×", 0x75: "/", 0x76: "MOD" };
  function instr(blk, off, code) {
    const m = netMap.get(blk), c = m && m.code;
    if (!c || off >= c.length) return "";
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const od = (p, T) => {                                  // → { t: testo, n: byte }
      if (c[p] === 0x80) {
        const v = T === 5 ? dv.getFloat32(p + 1, true) : (T === 2 || T === 4 || T === 6) ? dv.getUint32(p + 1, true) : dv.getInt32(p + 1, true);
        return { t: String(T === 5 ? +v.toPrecision(7) : v), n: 5, k: true, v };
      }
      const o16 = c[p + 1] | (c[p + 2] << 8);
      if (c[p] === 0x16) return { t: dbNames.get(o16) || `DB+${o16}`, n: 3 };
      if (c[p] === 0x17) return { t: (m.locals && m.locals.get(o16)) || `#L${o16}`, n: 3 };
      if (c[p] === 0x18) return { t: `#LN${o16}`, n: 3 };
      const ar = c[p] - 0x10, idx = c[p + 1] | (c[p + 2] << 8), key = (AREA[ar] || "?") + idx, nm = symNames.get(key);
      return { t: nm ? `${key} "${nm}"` : key, n: 3 };
    };
    const op = c[off];
    if (op >= 0x71 && op <= 0x78) {
      const T = c[off + 1], two = op >= 0x72 && op <= 0x76;
      const A = od(off + 2, T), B = two ? od(off + 2 + A.n, T) : null, O = od(off + 2 + A.n + (B ? B.n : 0), T);
      const e = op === 0x71 ? A.t : op === 0x77 ? `−${A.t}` : op === 0x78 ? `|${A.t}|` : `${A.t} ${BOXOP[op]} ${B.t}`;
      return `${O.t} := ${e}` + (code === 5 && B ? ` — divisore ${B.t} = 0` : "");
    }
    if (op === 0x79) { const A = od(off + 4, c[off + 1]), O = od(off + 4 + A.n, c[off + 2]); return `${O.t} := CONV(${A.t})`; }
    if (op === 0x70) { const T = c[off + 2], A = od(off + 4, T), B = od(off + 4 + A.n, T); return `confronto ${A.t} ${["==", "<>", "<", ">", "<=", ">="][c[off + 3]] || "?"} ${B.t}`; }
    if (op === 0x60) return `chiamata FC${c[off + 1] | (c[off + 2] << 8)}`;
    if (op >= 0x50 && op <= 0x52) return `timer ${["TON", "TOF", "TP"][op - 0x50]} T${c[off + 1]}`;
    return `istruzione 0x${op.toString(16).padStart(2, "0")}`;
  }
  const whereFull = (blk, off, code) => { const i = instr(blk, off, code); return where(blk, off) + (i ? " · " + i : ""); };
  async function refreshNetMap(crc) {
    if (crc === netMapFor) return;
    netMapFor = crc; netMap = new Map();
    if (!crc || !window.EspBlocks || !window.compileIR) return;
    try {
      // il programma del PLC è quello dell'ultimo Compile dell'editor: blocchi e progetto da lì, nessuna richiesta
      const ed = window.ESPPLC_EDITOR_PROG && window.ESPPLC_EDITOR_PROG();
      let pj, r, plc = null;
      if (ed && ed.crc === crc) { pj = ed.project; r = ed.r; }
      else {
        const p = await api("/api/plc/program");
        const bl = await api("/api/plc/blocks");
        if (!p.source_b64gz) return;
        const src = Uint8Array.from(atob(p.source_b64gz), c => c.charCodeAt(0));
        pj = await EspBlocks.sourceToProject(src);
        if (!pj) return;
        r = await compileIR(pj);
        plc = EspBlocks.plcBlockMap(bl);
      }
      if (!r.blocks) return;
      const names = vars => new Map([...vars.values()].filter(v => v.type !== "BOOL").map(v => [v.off, v.name]));
      dbNames = new Map();
      if (window.EspIR) EspIR.layoutDbs(pj).dbs.forEach(d => d.vars.forEach(v => { if (v.type !== "BOOL") dbNames.set(d.base + v.off, `"${d.db.name || "DB" + d.db.number}".${v.name}`); }));
      const fcs = new Map((pj.blocks || []).filter(b => b.type === "fc").map(b => [b.number, b]));
      for (const b of r.blocks) {
        const o = plc ? plc.get(EspBlocks.blkKey(b.type, b.number)) : b;   // programma dell'editor: è quello del PLC
        if (o && o.crc === b.crc && b.type !== 3) netMap.set(b.type === 2 ? 0xFFFF : b.number, { label: b.label, nets: b.nets, code: b.code,
          locals: b.type === 1 && fcs.has(b.number) && window.EspIR ? new Map([...names(EspIR.layoutIface(fcs.get(b.number)).vars)].map(([k, n]) => [k, "#" + n])) : null });   // StartUp = 0xFFFF
      }
      if (!plc && window.EspSymbols) symNames = new Map(EspSymbols.list().filter(v => v.name).map(v => [v.key, v.name]));   // simboli dell'editor
      else try { const sy = await api("/api/plc/symbols"); symNames = new Map(Object.entries(sy.symbols || {}).filter(([, v]) => v && v.name).map(([k, v]) => [k, v.name])); } catch (e) {}
      // voci del log già lette: il punto diventa "FCn network m · istruzione con le variabili"
      rows.forEach(r => { if (r.id === 9) r.det = whereFull(r.val >>> 16, r.val & 0xFFFF, r.sub & 0xFF); });
      render();
    } catch (e) { netMapFor = null; }
  }
  async function loadErrors(crc) {
    let d;
    try { d = await api("/api/plc/diag"); } catch (e) { $("d-err-info").textContent = "non disponibile"; return; }
    showErrors(d);
    // il punto «FCn network m» chiede programma e blocchi al PLC: dopo, e solo se ci sono errori (anche nel log)
    if ((d.entries.length || rows.some(r => r.id === 9)) && crc !== netMapFor) { await refreshNetMap(crc); showErrors(d); }
  }
  function showErrors(d) {
    if (!d || !Array.isArray(d.entries)) { $("d-err-info").textContent = "non disponibile"; return; }   // risposta a metà
    const F = T.vals.fault || {};
    const act = d.entries.filter(e => e.active).length;
    $("d-err-info").textContent = act ? `· ${act} in corso (SF acceso)` : d.entries.length ? "· nessuno in corso" : "· nessuno";
    put($("d-err").querySelector("tbody"), d.entries.length ? d.entries.map(e =>
      `<tr class="${e.active ? "err-on" : ""}"><td>${e.active ? "● in corso" : e.sw ? "terminato" : "STOP"}</td><td>${esc(F[e.code] || "codice " + e.code)}</td>` +
      `<td>${esc(where(e.blk, e.off))}</td><td>${esc(instr(e.blk, e.off, e.code))}</td>` +
      `<td class="num">${e.count.toLocaleString("it-IT")}</td><td class="when">${esc(when(e.first))}</td><td class="when">${esc(when(e.last))}</td></tr>`).join("")
      : `<tr><td colspan="7" class="muted">Nessun errore dall'avvio</td></tr>`);
  }

  // ── Stato ─────────────────────────────────────────
  const cycS = [];                                     // tempi del ciclo degli ultimi 6 s (tabella di Base)
  let mem = null, memTs = 0, stBusy = false, lastCrc = null, fwi = null, liveApi = true, gen = null, memCrc;
  const kb = b => Math.round((b || 0) / 1024);
  const kb1 = b => ((b || 0) / 1024).toFixed(1).replace(".", ",");
  const loadErrorsNow = () => loadErrors(lastCrc);
  const us = v => v >= 10000 ? `${(v / 1000).toFixed(1)} ms` : v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v} µs`;
  async function loadState(withErrors) {
    if (stBusy) return;                          // una richiesta per volta (ogni 500 ms)
    stBusy = true;
    try { await loadStateOnce(withErrors); } finally { stBusy = false; }
  }
  async function loadStateOnce(withErrors) {
    let s;
    // v4.7: frame leggero con le statistiche del ciclo (c=1); firmware di prima: lo stato completo
    try { s = liveApi ? await api("/api/plc/live?c=1" + sidq()) : await api("/api/plc/status?cyc=1&t=" + sidq()); }
    catch (e) { if (liveApi && /404|not found/i.test(e.message)) { liveApi = false; return loadStateOnce(withErrors); } return; }
    if (!s || typeof s.state !== "string") return;          // risposta a metà (riavvio, USB occupata): resta quello di prima
    const suCount = lastSu ? lastSu.count : null;
    lastSu = s.startup || null;
    // memoria e file: all'apertura, quando cambia il programma e ogni 30 s (i file cambiano con log e simboli)
    const pc = s.crc32 === undefined ? null : s.crc32 >>> 0;
    if (pc !== memCrc || Date.now() - memTs > 30000) { memCrc = pc; memTs = Date.now(); try { mem = await api("/api/plc/memory"); } catch (e) {} try { fwi = await api("/api/fw/info"); } catch (e) {} }
    // bit di aggiornamento: si rilegge una parte solo quando è cambiata
    const g = s.g, old = gen;
    gen = g || null;
    if (g && old) {
      if (g.log !== old.log && $("d-auto").checked) load(false);
      if (g.dg !== old.dg) loadErrors(s.crc32 === undefined ? null : s.crc32 >>> 0);
      if (g.boot !== old.boot || (lastSu && lastSu.count !== suCount)) loadBoot();
      if (g.set !== old.set && !setDirty()) loadSettings();
      if (g.net !== old.net && !netDirty()) loadNet();
    }
    const b = $("d-state");
    const ST = { running: "RUN", stopped: "STOP", fault: "STOP (errore)", no_program: "NESSUN PROGRAMMA" };
    b.textContent = ST[s.state] || (s.state || "?").toUpperCase();
    b.className = "badge state-" + s.state;
    const stCls = s.state === "running" ? "run" : s.state === "fault" ? "fault" : "stop";      // verde, rosso, giallo
    const kv = [
      ["Stato", `<span class="st-badge st-${stCls}">${esc(s.state === "fault" ? "STOP per errore" : ST[s.state] || s.state)}</span>` +
        (s.fault && s.fault !== "PLC_OK" ? ` <span class="muted">${esc(s.fault)}</span>` : ""), true],
      ["Programma", s.bc_crc32 === undefined ? esc("nessuno") : esc(`bytecode ${hex8(s.bc_crc32)}`) + "<br>" + esc(`sorgente ${hex8(s.src_crc32 || 0)}`), true],
      ["Editor collegati", (() => {                       // per indirizzo: «2 da 192.168.0.1, 1 da 10.10.10.2 (Online)»
        const cl = s.clients || [], by = new Map();
        cl.forEach(c => { const g = by.get(c.ip) || { n: 0, on: false }; g.n++; g.on = g.on || !!c.on; by.set(c.ip, g); });
        return String(cl.length) + (cl.length ? " — " + [...by].map(([ip, g]) => `${g.n} dall'IP ${ip}` + (g.on ? " (Online)" : "")).join(", ") : "");
      })()],
      ["Ultimo Download", s.last_dl ? `${s.last_dl.ip}, ${dur(s.last_dl.age_s)} fa` : "—"],
      ["Acceso da", info ? dur(info.up) : "…"],
      // temperatura del chip (sensore interno); null = sensore non disponibile
      ...(s.cycle && s.cycle.temp_c !== undefined ? [["Temperatura", s.cycle.temp_c === null ? "-" : `${s.cycle.temp_c.toFixed(1).replace(".", ",")} °C`]] : []),
      ["VM", mem ? (mem.vm_version ? `VM ${mem.vm_version} · scan ${mem.scan_interval_ms} ms` : "VM ≤ 2.4 (non dichiara i limiti)") : "…"],
      ["Memoria programma", !mem ? "…" : mem.work_total_bytes
        ? `${kb1(mem.work_used_bytes)}/${kb1(mem.work_total_bytes)} KB RAM` +
          ` · ${kb1(20 + (mem.bytecode_used_bytes || 0) + (mem.source_used_bytes || 0))}/${kb1(mem.partition_total_bytes)} KB flash`
        : `${kb1(mem.bytecode_used_bytes || 0)}/${kb1(mem.bytecode_max_bytes)} KB`],
      ["File", !fwi || !fwi.fs_total ? "…" : `${kb(fwi.fs_used)}/${kb(fwi.fs_total)} KB · ${Math.round(100 * (fwi.fs_total - fwi.fs_used) / fwi.fs_total)}% liberi`],
    ];
    put($("d-kv"), kv.map(([k, v, html]) => { const ly = KV_ADV.has(k) ? ' data-layer="adv"' : "";
      return `<dt${ly}>${esc(k)}</dt><dd${ly}>${html ? v : esc(v)}</dd>`; }).join(""));
    {   // versioni (03-11-2026): chip, firmware, editor, libreria uLink, MiaConfig, impronta hardware (firmware 0.3.66)
      const chip = c => !c ? "" : c === "esp32" ? "ESP32" : /^esp32/.test(c) ? "ESP32-" + c.slice(5).toUpperCase() : c;
      const rev = r => r === undefined ? "" : ` rev ${Math.floor(r / 100)}.${r % 100}`;
      const v = x => !fwi ? "…" : x || "—";
      const ver = [["Chip", v(fwi && chip(fwi.chip) + rev(fwi.chip_rev))], ["Firmware", v(fwi && fwi.version)],
        ["Editor", window.ESPPLC_EDITOR_VERSION || "—"], ["uLink", v(fwi && fwi.ulink)], ["MiaConfig", v(fwi && fwi.miaconfig)],
        ["Impronta hw", v(fwi && fwi.hw_id)]];
      put($("d-ver"), ver.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join(""));
    }
    {   // statistiche del ciclo (v4.2)
      const c = s.cycle, run = s.state === "running";
      $("d-cyc").classList.toggle("hidden", !c);
      if ($("d-cyc-b")) $("d-cyc-b").classList.toggle("hidden", !c);
      if (c && $("d-cyc-b")) {
        const now = Date.now();
        cycS.push({ t: now, m: run ? c.last_us : 0, p: c.per_us || 0 });
        while (cycS.length && now - cycS[0].t > 6000) cycS.shift();
        const row = (n, f) => { const v = cycS.map(f).filter(x => x > 0), td = x => `<td>${x ? us(x) : "—"}</td>`;
          return `<tr><td>${n}</td>${td(v.length ? v[v.length - 1] : 0)}${td(v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0)}${td(v.length ? Math.max(...v) : 0)}</tr>`; };
        put($("d-cyc-b").querySelector("tbody"), row("Ciclo Main", x => x.m) + row("Ciclo PLC", x => x.p));
      }
      if (c) {
        const td = v => `<td>${v ? us(v) : "—"}</td>`;
        put($("d-cyc").querySelector("tbody"), `<tr><td>Ciclo Main</td>${td(c.min_us)}${td(run ? c.last_us : 0)}${td(c.max_us)}${td(c.max_h_us)}</tr>` +
          `<tr><td>Ciclo PLC</td>${c.per_min_us !== undefined ? td(c.per_min_us) : "<td>—</td>"}${td(c.per_us)}${td(c.per_max_us)}${td(c.per_max_h_us)}</tr>`);
      }
    }
    const crcNow = s.crc32 === undefined ? null : s.crc32 >>> 0;
    if (crcNow !== lastCrc && !withErrors && g) loadErrors(crcNow);     // programma cambiato: punti degli errori da rifare
    lastCrc = crcNow;
    if (withErrors || !g) loadErrors(lastCrc);
  }

  // ── Moduli I/O sul bus a livello 2. Sul PLC (GET /api/bus, GET/POST /api/bus/config): i moduli (io1, io2…) con id,
  //    dispositivo abbinato e tabella dei punti, e i dispositivi trovati in rete (Identifica, Abbina). Sul modulo I/O:
  //    il suo stato e la tabella che gli ha mandato il PLC, in sola lettura ──
  const BUS_ST = { 0: "RUN", 1: "bloccato", 2: "riarmo", 3: "non configurato" };
  let busCfg = null, busEdit = false, busB = null;
  const busOpen = new Set();                             // moduli con la tabella aperta (id)
  const identOn = new Set();                             // dispositivi da identificare (MAC): pulsante premuto
  // bit i di una stringa esadecimale (byte 0 per primo)
  const bitAt = (hex, i) => ((parseInt(String(hex || "").substr((i >> 3) * 2, 2), 16) || 0) >> (i & 7)) & 1;
  const hwTxt = (g, kind) => ((HW && HW[g]) || []).filter(u => u.kind === kind).map(u => u.txt).join(", ");
  async function loadBus() {
    let b;
    try { b = await api("/api/bus"); } catch (e) { $("card-bus").classList.add("hidden"); $("card-iomod").classList.add("hidden"); return; }
    const io = b.role === "io";
    $("card-bus").classList.toggle("hidden", io); $("card-iomod").classList.toggle("hidden", !io);
    if (io) { renderIoMod(b); return; }
    busB = b;
    if (!busCfg) {
      try { busCfg = await api("/api/bus/config"); } catch (e) { return; }
      busCfg.modules = (busCfg.modules || []).map(m => ({ name: m.name || "", station: m.station, mac: m.mac || "", cat: m.cat || [], crc: m.crc || "" }));
      rows.forEach(r => { if (r.vt === "mod") r.det = fmtVal("mod", r.val); });   // voci del log già lette: il nome del modulo
      render();
      $("bus-period").value = busCfg.period; $("bus-hold").value = busCfg.hold;
    }
    $("bus-info").textContent = `${busCfg.modules.length} moduli` + (b.cycle_us !== undefined ? ` · giro ${b.cycle_us} µs (max ${b.cycle_max_us} µs)` : "") +
      (b.tx_busy !== undefined ? ` · frame non mandati: ${b.tx_busy} rete occupata, ${b.tx_err} errore` : "") +
      (b.gap_max_us ? ` · tra due giri al massimo ${(b.gap_max_us / 1000).toFixed(1).replace(".", ",")} ms` : "");
    if (!busEdit || !$("bus-mods").querySelector("tbody").children.length) busDraw(); else busDyn();
  }
  // stato di un modulo (dal PLC) per le celle che cambiano
  function modLive(c) {
    const m = busB && busB.modules.find(x => x.station === c.station);
    const mac = m && m.mac === c.mac ? m : null;
    const st = !c.mac ? ["nessun dispositivo", "muted"] : !mac ? ["da salvare", "warn"] : mac.cfg_bad ? ["configurazione cambiata", "bad"] : mac.gone ? ["non raggiungibile", "bad"] : !mac.acked ? ["non risponde", "bad"]
      : mac.valid ? ["RUN", "ok"] : [BUS_ST[mac.state] || "?", mac.state === 1 ? "bad" : "warn"];
    return { m: mac, st };
  }
  // picoPlc del modulo (dal modulo, nel frame IN): spento, acceso (pronto), in RUN (manca il PLC); — = non si sa
  const ppText = m => !m || !m.pplc ? "—" : m.pplc === "run" ? "in RUN" : m.pplc === "on" ? "acceso" : "spento";
  // impronta hardware: CRC del file della scheda del modulo (quello letto all'abbinamento; in rosso se ora il modulo ne ha un altro)
  const fpText = (c, m) => m && m.dev_crc && +("0x" + m.dev_crc) && c.crc && m.dev_crc !== c.crc
    ? `<span class="bad">${esc(m.dev_crc)}</span><span class="sub">era ${esc(c.crc)}</span>` : esc((m && +("0x" + m.dev_crc) ? m.dev_crc : c.crc) || "—");
  const PPLC_ON = false;                                 // picoPlc spento per ora (Denys 23-10-2026): colonna nascosta
  function busDraw() {
    { const th = document.querySelector('#bus-mods thead th[data-col="pplc"]'); if (th) th.classList.toggle("hidden", !PPLC_ON); }
    const devs = c => [`<option value="">— nessuno</option>`]
      .concat(c.mac && !(busB.found || []).some(f => f.mac === c.mac) ? [`<option value="${esc(c.mac)}" selected>${esc(c.mac)}</option>`] : [])
      .concat((busB.found || []).filter(f => f.role !== "plc").map(f => `<option value="${esc(f.mac)}"${f.mac === c.mac ? " selected" : ""}>${esc(f.name)} · ${esc(f.mac)}</option>`)).join("");
    const rows = busCfg.modules.map((c, k) => {
      const { m, st } = modLive(c), open = busOpen.has(c.station);
      let h = `<tr data-k="${k}"><td>${c.station}</td>` +
        `<td><input type="text" maxlength="16" data-f="name" value="${esc(c.name)}" style="width:110px" translate="no"></td>` +
        `<td><select data-f="mac">${devs(c)}</select></td>` +
        `<td class="${st[1]}" data-dyn="st">${esc(st[0])}</td>` +
        `<td data-dyn="fp" translate="no">${fpText(c, m)}</td>` +
        (PPLC_ON ? `<td data-dyn="pp">${ppText(m)}</td>` : "") +
        `<td data-layer="adv" data-dyn="rtt">${m && m.rtt_us ? `${m.rtt_us} µs<span class="sub">max ${m.rtt_max_us} µs</span>` : "—"}</td>` +
        `<td data-layer="adv" data-dyn="lost">${m ? `${m.lost}${m.late ? `<span class="sub">in ritardo ${m.late}</span>` : ""}${m.echo_bad ? `<span class="sub">eco ${m.echo_bad}</span>` : ""}` : ""}</td>` +
        `<td class="nowrap" data-layer="adv"><button data-tab="${k}">${open ? "▾" : "▸"} Configurazione ${c.cat.length} punti</button> <button data-del="${k}" title="Togli il modulo (poi Salva)">✕</button></td></tr>`;
      if (open) {                                        // configurazione del modulo: la manda il modulo (il suo file della scheda), qui solo da guardare
        const Lb = p => p.t === "real" ? (p.dir === "out" ? "AO" : "AI") : (p.dir === "out" ? "Q" : "I");
        h += `<tr class="bus-sub" data-layer="adv" data-k="${k}"><td colspan="${PPLC_ON ? 9 : 8}"><table class="bus-table"><thead><tr><th>Punto</th><th>Nome</th><th>Sul bus</th></tr></thead><tbody>` +
          (c.cat.map(p => `<tr><td translate="no">${esc(p.id)}</td><td translate="no">${esc(p.name || "")}</td><td>${Lb(p)}${p.i}</td></tr>`).join("")
            || `<tr><td colspan="3" class="muted">Configurazione non letta: «Leggi dal modulo».</td></tr>`) +
          `</tbody></table><div class="prog-actions"><button data-fetch="${k}" title="Chiede al modulo la sua configurazione (il suo file della scheda): serve dopo l'abbinamento e se la configurazione del modulo è cambiata">Leggi dal modulo</button>` +
          `<span class="muted small">${c.crc ? "CRC " + esc(c.crc) : ""}${m && m.cfg_bad ? " · il modulo ora ha " + esc(m.dev_crc) + ": configurazione cambiata, rileggila e controlla le tabelle I/O" : ""}</span></div></td></tr>`;
      }
      return h;
    });
    put($("bus-mods").querySelector("tbody"), rows.join("") || `<tr><td colspan="8" class="muted">Nessun modulo: «+ Nuovo modulo», poi «Cerca dispositivi» e abbina quello giusto.</td></tr>`);
    const found = busB.found || [];
    $("bus-found").classList.toggle("hidden", !found.length);
    put($("bus-found").querySelector("tbody"), found.map(f => {
      const bound = busCfg.modules.find(c => c.mac === f.mac), plc = f.role === "plc";
      const sel = plc ? `<span class="muted">PLC: non si abbina</span>`
        : `<select data-bind-sel="${esc(f.mac)}"><option value="">modulo…</option>${busCfg.modules.map((c, k) => `<option value="${k}">${esc(c.name)} · id ${c.station}</option>`).join("")}</select> <button data-bind="${esc(f.mac)}">Abbina</button>`;
      // nome di fabbrica della rete (uplc, uplc-io): «uLink»; un nome dato al modulo resta il suo
      const nm = !f.name || /^uplc(-io)?$/i.test(f.name) ? "uLink" : f.name;
      // versione «L0.3.60»: scheda con la libreria uLink (Arduino), senza pagina web né aggiornamento; AI e AO solo se ci sono
      const lib = /^L\d/.test(f.fw || ""), fw = lib ? "libreria " + f.fw.slice(1) : f.fw;
      const pts = `${f.n_di} I · ${f.n_do} Q${f.n_ai ? ` · ${f.n_ai} AI` : ""}${f.n_ao ? ` · ${f.n_ao} AO` : ""}`;
      return `<tr><td translate="no">${esc(nm)}</td><td class="mac" translate="no">${esc(f.mac)}</td><td>${f.chip ? esc(f.chip) : "—"}</td>` +
        `<td>${plc ? "PLC" : "modulo I/O"}</td><td class="nowrap">${esc(fw)}</td>` +
        `<td class="nowrap">${plc ? "—" : pts}</td><td translate="no">${plc ? "—" : f.crc ? esc(f.crc) : bound ? fpText(bound, modLive(bound).m) : "—"}</td><td>${bound ? esc(bound.name) : "—"}</td>` +
        `<td><button data-ident="${esc(f.mac)}" class="${identOn.has(f.mac) ? "primary" : ""}" aria-pressed="${identOn.has(f.mac)}">${identOn.has(f.mac) ? "Identifica: acceso" : "Identifica"}</button></td><td class="nowrap">${sel}</td></tr>`;
    }).join(""));
  }
  function busDyn() {                                    // in modifica: solo le celle che cambiano
    document.querySelectorAll("#bus-mods > tbody > tr[data-k]:not(.bus-sub)").forEach(tr => {
      const c = busCfg.modules[+tr.dataset.k]; if (!c) return;
      const { m, st } = modLive(c), q = s => tr.querySelector(`[data-dyn="${s}"]`);
      if (q("st")) { q("st").textContent = st[0]; q("st").className = st[1]; }
      if (q("pp")) q("pp").textContent = ppText(m);
      if (q("fp")) q("fp").innerHTML = fpText(c, m);
    });
  }
  // configurazione del modulo: la chiede il PLC al modulo (POST /api/bus/fetch), poi Salva
  async function busFetch(k) {
    const c = busCfg && busCfg.modules[k]; if (!c || !c.mac) return;
    $("bus-msg").textContent = `leggo la configurazione di ${c.name}…`;
    try {
      const j = await api(`/api/bus/fetch?mac=${encodeURIComponent(c.mac)}`, { method: "POST" });
      c.cat = j.cat || []; c.crc = j.crc || ""; busOpen.add(c.station);
      busChanged(`${c.name}: ${c.cat.length} punti letti dal modulo — Salva`); busDraw();
    } catch (e) { $("bus-msg").textContent = `${c.name}: ${e.message}`; }
  }
  function busChanged(msg) { busEdit = true; if (msg) $("bus-msg").textContent = msg; }
  async function identSend(mac, on) { try { await api(`/api/bus/identify?mac=${encodeURIComponent(mac)}&on=${on ? 1 : 0}`, { method: "POST" }); } catch (e) { $("bus-msg").textContent = e.message; } }
  function identTick() { identOn.forEach(mac => identSend(mac, true)); }
  function identStop() { identOn.forEach(mac => identSend(mac, false)); identOn.clear(); }
  function busInit() {
    $("bus-new").onclick = () => {
      if (!busCfg) return;
      let st = 0; while (busCfg.modules.some(c => c.station === st)) st++;
      if (st > 7) { $("bus-msg").textContent = "al massimo 8 moduli"; return; }
      let n = 1; while (busCfg.modules.some(c => c.name === "io" + n)) n++;
      busCfg.modules.push({ name: "io" + n, station: st, mac: "", stop: false, cat: [], crc: "" });
      busChanged("modulo aggiunto: dagli un nome (es. vasca), Cerca dispositivi, Abbina e Salva"); busDraw();
    };
    $("bus-find").onclick = async () => { $("bus-msg").textContent = "cerco…"; try { await api("/api/bus/discover", { method: "POST" }); } catch (e) { $("bus-msg").textContent = e.message; return; }
                                          setTimeout(async () => { await loadBus(); busDraw(); $("bus-msg").textContent = ""; }, 1200); };
    $("bus-rearm").onclick = async () => { try { await api("/api/bus/rearm", { method: "POST" }); $("bus-msg").textContent = "riarmo mandato"; } catch (e) { $("bus-msg").textContent = e.message; } };
    $("bus-undo").onclick = () => { busCfg = null; busEdit = false; $("bus-msg").textContent = ""; loadBus(); };
    $("bus-save").onclick = async () => {
      busCfg.period = +$("bus-period").value; busCfg.hold = +$("bus-hold").value;
      const bad = busCfg.modules.find(c => !/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(c.name));
      if (bad) { $("bus-msg").textContent = `nome «${bad.name}»: lettere, cifre e _ (è il nome della sua DB nel programma, es. vasca.Livello)`; return; }
      try { await api("/api/bus/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(busCfg) });
            busEdit = false; busCfg = null; $("bus-msg").textContent = "salvato: i moduli nuovi o cambiati ripartono dopo il riarmo"; loadBus(); }
      catch (e) { $("bus-msg").textContent = e.message; }
    };
    ["bus-period", "bus-hold"].forEach(id => $(id).addEventListener("input", () => busChanged()));
    const card = $("card-bus");
    card.addEventListener("input", e => {
      const tr = e.target.closest("tr[data-k]"); if (!tr || !busCfg) return;
      if (e.target.dataset.f === "name") busCfg.modules[+tr.dataset.k].name = e.target.value.trim();
      busChanged();
    });
    card.addEventListener("change", e => {
      const tr = e.target.closest("tr[data-k]"); if (!tr || !busCfg) return;
      if (e.target.dataset.f === "mac") { const c = busCfg.modules[+tr.dataset.k]; c.mac = e.target.value; c.cat = []; c.crc = ""; if (c.mac) busFetch(+tr.dataset.k); }
      busChanged();
    });
    card.addEventListener("click", e => {
      const t = e.target.closest("button"); if (!t || !busCfg) return;
      if (t.dataset.tab !== undefined) { const st = busCfg.modules[+t.dataset.tab].station; busOpen.has(st) ? busOpen.delete(st) : busOpen.add(st); busDraw(); }
      else if (t.dataset.del !== undefined) { const c = busCfg.modules.splice(+t.dataset.del, 1)[0]; busOpen.delete(c.station); busChanged(`${c.name} tolto: Salva per mandarlo al PLC`); busDraw(); }
      else if (t.dataset.fetch !== undefined) busFetch(+t.dataset.fetch);
      else if (t.dataset.ident) { const mac = t.dataset.ident, on = !identOn.has(mac);
        on ? identOn.add(mac) : identOn.delete(mac); identSend(mac, on); busDraw(); }
      else if (t.dataset.bind) {
        const mac = t.dataset.bind, k = card.querySelector(`[data-bind-sel="${CSS.escape(mac)}"]`).value;
        if (k === "") { $("bus-msg").textContent = "scegli il modulo"; return; }
        busCfg.modules.forEach(c => { if (c.mac === mac) c.mac = ""; });
        busCfg.modules[+k].mac = mac; busCfg.modules[+k].cat = []; busCfg.modules[+k].crc = "";
        busChanged(`${mac} abbinato a ${busCfg.modules[+k].name}: leggo la sua configurazione…`); busDraw(); busFetch(+k);
      }
    });
  }

  // ── Modulo I/O: la sua configurazione (dal suo file della scheda) e i valori sul bus ──
  let iomCat = null;
  async function renderIoMod(b) {
    $("bus-info-io").textContent = b.station === null || b.station === undefined ? "aspetta il PLC"
      : `${b.module || "modulo"} · id ${b.station} · PLC ${b.master}`;
    const kvs = [["Stato", BUS_ST[b.state] || b.state], ["Ultimo frame dal PLC", b.age_ms < 0 ? "mai" : `${b.age_ms} ms fa`],
      ["Tenuta", `${b.hold} ms`], ["Frame ricevuti", String(b.rx)], ["Frame scartati", String(b.drop)], ["Blocchi", String(b.locks)],
      ...(b.tx_busy !== undefined ? [["Risposte non mandate", `${b.tx_busy} rete occupata · ${b.tx_err} errore`]] : []),
      ["CRC della configurazione", b.crc || "—"]];
    if (b.ident) kvs.push(["Identifica", "il LED lampeggia"]);
    put($("bus-io"), kvs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(""));
    if (!iomCat) try { iomCat = (await api("/api/io/catalog")).points || []; } catch (e) { iomCat = []; }
    const L = p => p.t === "real" ? (p.dir === "out" ? "AO" : "AI") : (p.dir === "out" ? "Q" : "I");
    const counter = { I: 0, Q: 0, AI: 0, AO: 0 };
    const rows = iomCat.filter(p => p.dir !== "io" && !p.used && !p.error).map(p => {
      const l = L(p), i = counter[l]++;
      const v = l === "I" ? (bitAt(b.di, i) ? "●" : "○") : l === "Q" ? (bitAt(b.do, i) ? "●" : "○") : l === "AI" ? String((b.ai || [])[i] ?? "") : String((b.ao || [])[i] ?? "");
      return `<tr><td translate="no">${esc(p.id)}</td><td translate="no">${esc(p.name || "")}</td><td>${l}${i}</td><td class="bits">${esc(v)}</td></tr>`;
    });
    put($("iom-table").querySelector("tbody"), rows.join("") || `<tr><td colspan="4" class="muted">Nessun punto: il progetto MiaConfig del modulo non ha ingressi né uscite.</td></tr>`);
  }

  // ── Task, CPU e RAM (GET /api/plc/tasks): carico delle due CPU, RAM, stack libero di ogni task ──
  // parti a video adesso: livello della Diagnostica (Base, Avanzato, Debug). Le letture delle parti nascoste non partono
  const lvAdv = () => { const r = document.querySelector("#diag-overlay .diag-root"); return !!r && r.dataset.level === "adv"; };
  const lvDbg = () => { const r = document.querySelector("#diag-overlay .diag-root"); return !!r && r.dataset.dbg === "1"; };
  async function loadTasks() {
    if (!lvDbg()) return;                                // RAM e task: solo col Debug
    let t;
    try { t = await api("/api/plc/tasks"); } catch (e) { if (/404/.test(e.message)) { $("d-res").classList.add("hidden"); $("d-tasks").classList.add("hidden"); } return; }
    const pc = v => v === null || v === undefined ? "—" : `${String(v).replace(".", ",")} %`;
    const h = t.heap || {};
    $("d-res").textContent = `CPU0 ${pc(t.cpu && t.cpu[0])} · CPU1 ${pc(t.cpu && t.cpu[1])} · RAM libera ${kb1(h.free)} KB (minimo ${kb1(h.min)} KB) · blocco più grande ${kb1(h.block)} KB (minimo ${kb1(h.block_min)} KB)` +
      (h.iram_only_total !== undefined ? ` · IRAM libera ${kb1(h.iram_only_free)} KB di ${kb1(h.iram_only_total)} KB (minimo ${kb1(h.iram_only_min)} KB)` : "") + ` · task ${t.n_tasks}`;
    put($("d-tasks").querySelector("tbody"), (t.tasks || []).map(x =>
      `<tr><td translate="no">${esc(x.n)}</td><td>${x.core === null ? "0 e 1" : x.core}</td><td>${x.prio}</td><td class="${x.free < 512 ? "low" : ""}">${x.free} B</td></tr>`).join(""));
    $("d-res").classList.remove("hidden"); $("d-tasks").classList.remove("hidden");
  }

  // ── Data e ora del PLC (GET/POST /api/plc/clock): UTC sul PLC, qui con il fuso del PC ──
  // l'ora si legge dal PLC ogni 10 s e qui avanza ogni secondo (differenza con l'orologio del PC)
  let clockOff = null;
  async function loadClock() {
    let c;
    try { c = await api("/api/plc/clock"); } catch (e) { if (/404/.test(e.message)) $("d-clock-row").classList.add("hidden"); return; }
    $("d-clock-row").classList.remove("hidden");
    clockOff = c.valid ? c.unix * 1000 - Date.now() : null;
    showClock();
  }
  function showClock() {
    $("d-clock").textContent = clockOff !== null ? `Data e ora del PLC: ${new Date(Date.now() + clockOff).toLocaleString()}` : "Data e ora del PLC: non impostata";
  }

  // ── Azioni ────────────────────────────────────────
  // true = OK, "alt" = secondo pulsante (se c'è), false = Annulla
  // ── Livelli della Diagnostica: Base (l'utente), Avanzato (impostazioni tecniche), Debug (solo in Avanzato) ──
  // Primo smistamento, solo grafico: ogni parte ha il suo livello (data-layer), il selettore in alto mostra quelle del
  // livello scelto. Base spegne anche il Debug (fasi del Download e RAM sotto le barre dell'editor). Si ricorda nel browser
  // dall'elenco di Denys (23-10): @row = la riga, @box = il riquadro, @label = l'etichetta che lo contiene
  const LAYER_ADV = ["#card-boot", "#card-set", "#d-cyc", "#p-hw-box", "#p-nin@box", "#p-inwd@row", "#p-ulink", "#p-vm", "#p-netplc", "#n-editor@row",
    "#n-ap-ch", "label[for=n-ap-ch]", "#n-ap-auto@row", "#n-sta-ssid@row", "#n-sta-pass@row", "#n-sta-f", "#bus-period@label", "#bus-hold@label", "#iom-table"];
  const LAYER_DBG = ["#d-res", "#d-tasks"];
  const KV_ADV = new Set(["Memoria programma"]);       // righe dello Stato del PLC solo in Avanzato
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  function layerEl(sel) {
    const [id, up] = sel.split("@");
    const el = document.querySelector(id);
    return el && up ? el.closest(up === "row" ? ".set-row" : up === "box" ? ".p-box" : up) : el;
  }
  function setupLevels() {
    const root = document.querySelector("#diag-overlay .diag-root");
    if (!root) return;
    LAYER_ADV.forEach(s => { const e = layerEl(s); if (e) e.dataset.layer = "adv"; });
    LAYER_DBG.forEach(s => { const e = layerEl(s); if (e) e.dataset.layer = "dbg"; });
    { const e = $("p-dbg") && $("p-dbg").closest(".set-row"); if (e) e.classList.add("hidden"); }   // il Debug sta nel selettore in alto
    {   // in Base i tempi del ciclo semplici: ultimo, medio e massimo degli ultimi 6 s (calcolati qui nel browser)
      const t = document.createElement("table");
      t.id = "d-cyc-b"; t.dataset.layer = "base"; t.className = "hidden";
      t.innerHTML = "<thead><tr><th></th><th>ultimo</th><th>medio</th><th>max 6 s</th></tr></thead><tbody></tbody>";
      $("d-cyc").after(t);
    }
    {   // Moduli I/O: in Base id, modulo, dispositivo, stato e impronta hardware; il resto in Avanzato
      // colonne per data-col (index.html), mai per il testo: il testo cambia con la lingua
      const ths = [...document.querySelectorAll("#bus-mods thead th")];
      ths.forEach((th, i) => { if (["rtt", "persi"].includes(th.dataset.col) || i === ths.length - 1) th.dataset.layer = "adv"; });
      const st = ths.find(th => th.dataset.col === "stato"), im = document.createElement("th");
      im.textContent = "Impronta hardware"; im.title = "CRC del file della scheda del modulo (configuratore)";
      if (st) st.after(im);                              // senza la colonna: il selettore dei livelli deve comparire lo stesso
      const fh = document.querySelector('#bus-found thead th[data-col="io"]'), fi = document.createElement("th");   // dopo I/O
      fi.textContent = "Impronta hardware"; if (fh) fh.after(fi);
    }
    $("bus-period").min = 5; $("bus-hold").min = 100;
    const box = document.createElement("div");
    box.className = "d-level";
    box.innerHTML = `<button type="button" data-lv="base" title="Quello che serve per usare il PLC">Base</button>` +
      `<button type="button" data-lv="adv" title="Anche le impostazioni tecniche: avvio, ciclo, uLink, esecuzione del programma, rete del PLC">Avanzato</button>` +
      `<label title="Solo in Avanzato: RAM, task, log avanzato, fasi del Download e memoria sotto le barre dell'editor"><input type="checkbox" id="d-dbg"> Debug</label>` +
      `<button type="button" id="d-i18n-miss" class="hidden" title="Debug in una lingua diversa dall'italiano: i testi senza traduzione si vedono come text_missing«…». Scarica l'elenco">📋 Testi mancanti</button>`;
    root.querySelector(".diag-head .badges").before(box);
    const apply = lv => {
      const dbg = lv === "adv" && lsGet("espplc.debug") === "1";
      root.dataset.level = lv; root.dataset.dbg = dbg ? "1" : "0";
      box.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.lv === lv));
      $("d-dbg").checked = dbg; $("d-dbg").disabled = lv !== "adv";
      if ($("p-dbg")) $("p-dbg").value = dbg ? "1" : "0";
      { const L = window.EspI18n && window.EspI18n.lang(); $("d-i18n-miss").classList.toggle("hidden", !dbg || !L || L === "it"); }
      ["n-ap-ssid", "n-ap-ip"].forEach(id => { $(id).readOnly = lv === "base"; });   // in Base si vedono, si cambiano nome e password
      if (lv === "adv" && ready) loadAdv();               // dati delle parti appena comparse (in Base non si chiedono)
      if (dbg && ready) loadTasks();
    };
    box.querySelectorAll("button").forEach(b => b.onclick = () => {
      if (b.dataset.lv === "base" && lsGet("espplc.debug") === "1") { lsSet("espplc.debug", "0"); window.dispatchEvent(new Event("espplc-debug")); }   // Base spegne tutto
      apply(b.dataset.lv);
    });
    $("d-i18n-miss").onclick = () => {                 // elenco dei testi senza traduzione visti finora (per la tabella delle lingue)
      const m = window.EspI18n ? window.EspI18n.missing() : [];
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([m.join("\n") + "\n"], { type: "text/plain" }));
      a.download = `testi-mancanti-${window.EspI18n.lang()}.txt`;
      document.body.appendChild(a); a.click(); a.remove();
    };
    $("d-dbg").onchange = () => {
      lsSet("espplc.debug", $("d-dbg").checked ? "1" : "0");
      window.dispatchEvent(new Event("espplc-debug"));
      apply(root.dataset.level);
    };
    // all'apertura della pagina sempre Base, Debug spento: il livello non si ricorda (Denys 23-10)
    if (lsGet("espplc.debug") === "1") { lsSet("espplc.debug", "0"); window.dispatchEvent(new Event("espplc-debug")); }
    apply("base");
  }
  function confirmBox(title, body, ok, alt) {
    return new Promise(res => {
      $("confirm-title").textContent = title; $("confirm-body").textContent = body; $("confirm-ok").textContent = ok;
      $("confirm-alt").textContent = alt || ""; $("confirm-alt").classList.toggle("hidden", !alt);
      const done = v => { $("confirm-modal").classList.add("hidden"); res(v); };
      $("confirm-ok").onclick = () => done(true); $("confirm-cancel").onclick = () => done(false); $("confirm-alt").onclick = () => done("alt");
      $("confirm-modal").classList.remove("hidden");
    });
  }

  // ── Programma sul PLC: Backup, Restore, Cancella li fa l'editor (progetto, simboli, conferme) ──
  const editorCmd = (cmd, extra) => window.ESPPLC_DIAG_CMD ? window.ESPPLC_DIAG_CMD(Object.assign({ cmd }, extra || {}))
                                                          : Promise.resolve({ ok: false, msg: "non disponibile" });
  async function progCmd(cmd, extra) {
    $("p-prog-st").textContent = "…";
    const r = await editorCmd(cmd, extra);
    $("p-prog-st").textContent = r.msg || (r.ok ? "fatto" : "non riuscito");
    $("p-prog-st").className = "small " + (r.ok ? "muted" : "bad");
    if (cmd === "delete" && r.ok) load(true);
  }
  async function exportCsv() {
    await loadAllOlder();                                // nel file tutto il log, anche le voci non ancora lette
    const cell = v => /[";\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = ["#;Quando;Livello;Categoria;Evento;Dettaglio;id;sub;val"];
    rows.forEach(r => lines.push([r.seq, r.when, r.lvl, r.cat, r.ev, r.det, r.id, r.sub, r.val].map(cell).join(";")));
    const d = new Date(), p = n => String(n).padStart(2, "0");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
    a.download = `log-plc-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // Tendina a due righe per scelta (select.sel2): nome e, sotto, la spiegazione (title dell'option, tradotto da i18n).
  // Il select vero resta (nascosto) con valore, eventi e classi: .value impostato dal codice ridisegna il pulsante.
  function sel2(sel) {
    const wrap = document.createElement("div"); wrap.className = "sel2";
    sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "sel2-btn";
    const pop = document.createElement("div"); pop.className = "sel2-pop hidden";
    wrap.append(btn, pop);
    const two = o => `<span class="sel2-t">${esc(o.textContent)}</span>${o.title ? `<span class="sel2-d">${esc(o.title)}</span>` : ""}`;
    const draw = () => {
      const o = sel.options[sel.selectedIndex];
      btn.innerHTML = o ? two(o) : "";
      btn.disabled = sel.disabled;
      btn.classList.toggle("changed", sel.classList.contains("changed"));
    };
    btn.onclick = () => {
      pop.innerHTML = [...sel.options].map((o, i) => o.hidden ? "" : `<div class="sel2-o${i === sel.selectedIndex ? " on" : ""}" data-i="${i}">${two(o)}</div>`).join("");
      pop.classList.toggle("hidden");
    };
    pop.onclick = e => {
      const d = e.target.closest(".sel2-o"); if (!d) return;
      pop.classList.add("hidden");
      if (+d.dataset.i === sel.selectedIndex) return;
      sel.selectedIndex = +d.dataset.i; draw();
      sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true }));
    };
    document.addEventListener("click", e => { if (!wrap.contains(e.target)) pop.classList.add("hidden"); });
    const pv = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(sel, "value", { get() { return pv.get.call(this); }, set(v) { pv.set.call(this, v); draw(); } });
    new MutationObserver(draw).observe(sel, { attributes: true, attributeFilter: ["class", "disabled"] });
    draw();
  }

  // ── Impostazioni del PLC (GET/PUT /api/plc/settings, POST /api/plc/reboot) ──
  let SET = null, ed = null;
  const clone = x => JSON.parse(JSON.stringify(x));
  // Cosa c'è sulla scheda (board.json in SPIFFS, da boards/ del progetto): per GPIO l'elenco degli usi
  let HW = null, BRD = null;                           // BRD: elenchi e testi dei GPIO dal file della scheda
  async function loadBoard() {
    try {
      const r = await fetch("/api/fw/gui?name=board.json.gz");
      if (!r.ok) return;
      const j = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).json();
      HW = {};
      BRD = Array.isArray(j.gpio_in) ? { name: j.name, gpio_in: j.gpio_in, gpio_out: j.gpio_out || [], strap: j.strap || {} } : null;
      for (const u of j.uses || []) for (const [g, sig] of Object.entries(u.pins || {}))
        (HW[g] = HW[g] || []).push({ kind: u.kind, txt: u.name + (sig ? " " + sig : "") });
      // I/O del file della scheda con il commento del configuratore (Pulsante, Relè 1): accanto al GPIO negli elenchi
      const KIND = { gpi: "in", vpin: "in", gpo: "out", dac: "out", pwm: "out" };
      for (const o of j.io || []) if (o.pin >= 0 && o.name && (KIND[o.type] || o.type === "gpio"))
        for (const k of o.type === "gpio" ? ["in", "out"] : [KIND[o.type]]) (HW[o.pin] = HW[o.pin] || []).push({ kind: k, txt: o.name });
      if (ed) { renderSettings(); if (!setTouched) actMark("plc"); }
    } catch (e) { HW = null; BRD = null; }
  }
  // «Salva» e «Annulla modifiche» solo quando i campi della pagina sono diversi da quelli letti dal PLC: valori dei
  // campi all'ultima lettura (o Annulla) contro quelli di adesso. Moduli I/O: dalla prima modifica (busEdit)
  const actBase = {};
  const actFields = g => g === "plc" ? [...$("card-plc").querySelectorAll("input, select")]
    : [...$("card-net").querySelectorAll("input, select")];                          // rete: anche il riquadro «PLC» (si salva con la rete)
  const actSnap = g => actFields(g).filter(e => e.type !== "file").map(e => e.id + "=" + (e.type === "checkbox" ? e.checked : e.value)).join("");
  function actMark(g) { actBase[g] = actSnap(g); syncActs(); }
  function syncActs() {
    const on = { plc: actBase.plc !== undefined && actSnap("plc") !== actBase.plc, net: actBase.net !== undefined && actSnap("net") !== actBase.net, bus: busEdit };
    for (const [g, ids] of [["plc", ["p-save", "p-undo"]], ["net", ["n-save", "n-undo"]], ["bus", ["bus-save", "bus-undo"]]])
      ids.forEach(id => { if ($(id)) $(id).classList.toggle("hidden", !on[g]); });
  }
  async function loadSettings() {
    try { SET = await api("/api/plc/settings"); } catch (e) { $("p-msg").textContent = "impostazioni non disponibili: " + e.message; return; }
    ed = clone(SET.saved); setTouched = false;
    renderSettings(); actMark("plc");
    if (!HW) loadBoard();
  }
  // perché un GPIO va usato con attenzione per un ingresso ("in") o un'uscita ("out"); self = chi lo sta usando ora
  function gpioWhy(g, role, self) {
    const w = [];
    if (BRD) { if (BRD.strap[g]) w.push(BRD.strap[g]); }
    else if ((SET.board.gpio_warn || []).includes(g)) w.push("avvio");
    for (const u of (HW && HW[g]) || []) if (u.kind !== role) w.push(u.txt);
    if (ed) {
      ed.inputs.forEach((x, i) => { if (x === g && self !== "I" + i) w.push(`già I${i}`); });
      ed.outputs.forEach((x, i) => { if (x === g && self !== "Q" + i) w.push(`già Q${i}`); });
      if (ed.powerfail && ed.powerfail.gpio === g && self !== "pf") w.push("già mancanza tensione");
      if (ed.usb_guard && ed.usb_guard.gpio === g && self !== "ug") w.push("già protezione reset");
    }
    return w;
  }
  function gpioOpts(list, cur, role, self) {
    return `<option value="-1"${cur === -1 ? " selected" : ""}>—</option>` +
      list.map(g => {
        const w = gpioWhy(g, role, self), ok = ((HW && HW[g]) || []).filter(u => u.kind === role).map(u => u.txt);
        return `<option value="${g}"${g === cur ? " selected" : ""}>GPIO ${g}${ok.length ? " · " + ok.join(", ") : ""}${w.length ? " ⚠ " + w.join(", ") : ""}</option>`;
      }).join("");
  }
  // il select con il GPIO scelto: bordo giallo e spiegazione al passaggio del mouse se va usato con attenzione
  function gpioSel(attr, list, cur, role, self, changed) {
    const w = cur >= 0 ? gpioWhy(cur, role, self) : [];
    return `<select ${attr} class="${w.length ? "warn" : ""}${changed ? " changed" : ""}"${w.length ? ` title="⚠ ${w.join(", ").replace(/"/g, "&quot;")}"` : ""}>${gpioOpts(list, cur, role, self)}</select>`;
  }
  function pinWarn(el, g, role, self) {
    const w = g >= 0 ? gpioWhy(g, role, self) : [];
    el.classList.toggle("warn", w.length > 0); el.title = w.length ? "⚠ " + w.join(", ") : "";
  }
  // ── File della scheda (configuratore): catalogo dei punti del PLC, caricamento di un file nuovo (vale dal riavvio) ──
  async function loadHw() {
    let c;
    try { c = await api("/api/io/catalog"); } catch (e) { $("p-hw-box").classList.add("hidden"); return; }
    $("p-hw-box").classList.remove("hidden");
    $("p-hw-info").textContent = c.loaded ? `«${c.board}»: ${c.devices.filter(d => d.type !== "remote").length} dispositivi, ${c.points.length} punti` : (c.error || "nessun file della scheda");
    const bad = (c.devices || []).filter(d => d.error);
    // un dispositivo per riga: id (non si traduce) e motivo (si traduce)
    $("p-hw-dev").innerHTML = bad.map(d => `<li><span translate="no">${esc(d.id)}${d.chip ? " " + esc(d.chip) : ""}</span>: <span>${esc(d.error)}</span></li>`).join("");
  }
  async function uploadHw(file) {
    const msg = $("p-hw-msg");
    try {
      let j = JSON.parse(await file.text());
      if (j.format === "espplc-hw") {                      // progetto del configuratore (.mia, prima .hwplc): dentro c'è il file della scheda
        if (!j.board) throw new Error("progetto del configuratore senza file della scheda: aprilo nel configuratore e salvalo di nuovo");
        j = j.board;
      }
      if (j.format !== "espplc-board" || !Array.isArray(j.io)) throw new Error("non è un file della scheda: serve il .mia salvato dal configuratore");
      const txt = JSON.stringify(j);
      const gz = new Uint8Array(await new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      const fd = new FormData(); fd.append("f", new Blob([gz], { type: "application/octet-stream" }), "f.bin");
      const r = await fetch("/api/fw/file?name=board.json.gz", { method: "POST", body: fd, headers: { "X-EspPlc": "1" } });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.msg || "HTTP " + r.status); }
      msg.textContent = `«${j.name}» caricato: vale dal riavvio del PLC`;
      HW = null; loadBoard();                               // commenti dei pin dal file nuovo
      $("p-reboot").classList.remove("hidden");
    } catch (e) { msg.textContent = "⚠ " + e.message; }
  }
  function renderSettings() {
    const B = BRD ? Object.assign({}, SET.board, BRD) : SET.board, A = SET.active;
    $("p-board").textContent = "· " + B.name;
    $("p-reboot").classList.toggle("hidden", !SET.reboot_needed);
    { const c = ed.cycle || { boot: "last", input_wd_ms: 150 }, ac = A.cycle || c;
      $("p-boot").value = c.boot; $("p-inwd").value = c.input_wd_ms;
      $("p-boot").classList.toggle("changed", c.boot !== ac.boot); $("p-inwd").classList.toggle("changed", c.input_wd_ms !== ac.input_wd_ms);
      $("p-boot").disabled = $("p-inwd").disabled = !SET.active.cycle; }       // firmware di prima: niente
    { const u = ed.ulink || { mode: "auto" }, au = A.ulink || u;                // uLink: cosa fa il PLC con un modulo perso
      $("p-ulm").value = u.mode; $("p-ulm").classList.toggle("changed", u.mode !== au.mode);
      $("p-ulink").classList.toggle("hidden", !A.ulink || A.role === "io"); }
    renderVm();
    { const se = ed.serial || { mode: "log" }, ase = A.serial || se, ug = ed.usb_guard || { gpio: -1, isolate: 0 }, aug = A.usb_guard || ug;
      $("p-ser").value = se.mode; $("p-ser").classList.toggle("changed", se.mode !== ase.mode);
      $("p-ug").innerHTML = gpioOpts(B.gpio_out, ug.gpio, "out", "ug"); $("p-ug").classList.toggle("changed", ug.gpio !== aug.gpio);
      pinWarn($("p-ug"), ug.gpio, "out", "ug");
      $("p-ug-lvl").value = String(ug.isolate ? 1 : 0); $("p-ug-lvl").classList.toggle("changed", ug.isolate !== aug.isolate);
      $("p-ug-lvl").disabled = ug.gpio < 0;
      $("p-ser").disabled = $("p-ug").disabled = !A.serial;                       // firmware di prima: niente
      if (!A.serial) $("p-ug-lvl").disabled = true; }
    { const n = ed.net || { need: "none", wait_s: 30 }, an = A.net || { need: "none", wait_s: 30 };
      $("p-net").value = n.need; $("p-net-wait").value = n.wait_s;
      $("p-net").classList.toggle("changed", n.need !== an.need); $("p-net-wait").classList.toggle("changed", n.wait_s !== an.wait_s);
      $("p-net-wait").disabled = n.need === "none"; }
    { const io = (ed.role || "plc") === "io";
      $("p-role-box").classList.toggle("hidden", !A.role);                      // firmware di prima: niente
      $("p-role").value = ed.role || "plc"; $("p-role").classList.toggle("changed", (ed.role || "plc") !== (A.role || "plc"));
      $("p-role-note").textContent = io
        ? "Il programma non gira. La tabella dei punti si compila nel PLC (Diagnostica del PLC, Moduli I/O) e arriva al modulo dal bus. Nome in rete di fabbrica uplc-io, Ethernet 192.168.0.30."
        : "La scheda esegue il programma con i suoi ingressi e uscite, e comanda i moduli I/O remoti.";
      $("p-pplc-row").classList.toggle("hidden", !io || !A.pplc);               // picoPlc: solo da modulo I/O (firmware di prima: niente)
      { const p = !!(ed.pplc && ed.pplc.on); $("p-pplc").value = p ? "1" : "0"; $("p-pplc").classList.toggle("changed", p !== !!(A.pplc && A.pplc.on)); }
      const aio = A.role === "io";                                               // in uso da modulo: punti nella tabella del modulo
      $("p-in").closest(".p-box").classList.toggle("hidden", aio); $("p-out").closest(".p-box").classList.toggle("hidden", aio);
      $("p-in-t").textContent = io ? "Ingressi del modulo" : "Ingressi";
      $("p-out-t").textContent = io ? "Uscite del modulo" : "Uscite"; }
    $("p-nin").max = B.io_max_in; $("p-nout").max = B.io_max_out;
    $("p-nin").value = ed.inputs.length; $("p-nout").value = ed.outputs.length;
    $("p-in").innerHTML = ed.inputs.map((g, i) => `<label>I${i}${gpioSel(`data-in="${i}"`, B.gpio_in, g, "in", "I" + i, g !== A.inputs[i])}</label>`).join("") || '<span class="muted">nessuno</span>';
    $("p-out").innerHTML = ed.outputs.map((g, i) => `<label>Q${i}${gpioSel(`data-out="${i}"`, B.gpio_out, g, "out", "Q" + i, g !== A.outputs[i])}</label>`).join("") || '<span class="muted">nessuna</span>';
    $("p-pf").innerHTML = gpioOpts(B.gpio_in, ed.powerfail.gpio, "in", "pf");
    pinWarn($("p-pf"), ed.powerfail.gpio, "in", "pf");
    $("p-pf-lvl").value = ed.powerfail.active_low ? "1" : "0";
  }
  // Interprete (dal riavvio): standard, accu, codice macchina («VM + IRAM» tolta il 01-11-2026)
  function renderVm() {
    if (!SET || !ed) return;
    const A = SET.active, v = ed.vm || {}, av = A.vm || v;
    if (!mem && A.vm) { api("/api/plc/memory").then(m => { mem = m; memTs = Date.now(); renderVm(); }).catch(() => {}); }
    const vmSel = o => o.native ? "3" : o.accu ? "2" : "0";
    $("p-vm-iram").value = vmSel(v); $("p-vm-iram").classList.toggle("changed", vmSel(v) !== vmSel(av));
    const opt = val => [...$("p-vm-iram").options].find(o => o.value === val);
    opt("2").hidden = av.accu === undefined;                             // firmware di prima: niente VM accu
    opt("3").hidden = av.native === undefined;
    $("p-vm-stop").value = v.stop_free ? "1" : "0"; $("p-vm-stop").classList.toggle("changed", !!v.stop_free !== !!av.stop_free);
    $("p-vm-stop").closest(".set-row").classList.toggle("hidden", av.stop_free === undefined);   // firmware di prima: niente
    {   // Debug dell'editor (solo in questo browser, subito): fasi del Download e RAM / IRAM sotto le barre
      let on = false; try { on = localStorage.getItem("espplc.debug") === "1"; } catch (e) {}
      $("p-dbg").value = on ? "1" : "0";
      $("p-dbg").onchange = () => {
        try { localStorage.setItem("espplc.debug", $("p-dbg").value); } catch (e) {}
        window.dispatchEvent(new Event("espplc-debug"));
      };
    }
    const xa = mem && mem.vm_accu;
    $("p-vm").classList.toggle("hidden", !A.vm || A.role === "io");
    $("p-vm-note").textContent = xa && xa.native !== undefined
      ? `VM codice macchina: ${xa.native} pezzi in codice macchina (${xa.native_bytes} B di IRAM), ${xa.frags - xa.native} come elenchi; ${xa.ops} istruzioni tradotte (${xa.xcode} di ${xa.code} B di codice)`
      : xa
      ? `VM accu: ${xa.ops} istruzioni tradotte in ${xa.frags} pezzi (${xa.xcode} di ${xa.code} B di codice), elenchi IRAM ${xa.iram} B, RAM ${xa.ram} B`
      : "";
  }
  function collectSettings() {
    ed.net = { need: $("p-net").value, wait_s: parseInt($("p-net-wait").value, 10) || 30 };
    if (SET.active.role) ed.role = $("p-role").value;
    if (SET.active.pplc) ed.pplc = { on: $("p-pplc").value === "1" };
    if (SET.active.serial) { ed.serial = { mode: $("p-ser").value }; ed.usb_guard = { gpio: +$("p-ug").value, isolate: +$("p-ug-lvl").value }; }
    if (SET.active.ulink) ed.ulink = { mode: $("p-ulm").value };
    if (SET.active.vm) ed.vm = Object.assign({},
                                             SET.active.vm.stop_free !== undefined ? { stop_free: $("p-vm-stop").value === "1" } : {},
                                             SET.active.vm.accu !== undefined ? { accu: $("p-vm-iram").value === "2" } : {},
                                             SET.active.vm.native !== undefined ? { native: $("p-vm-iram").value === "3" } : {});
    if (SET.active.cycle) { const w = parseInt($("p-inwd").value, 10); ed.cycle = { boot: $("p-boot").value, input_wd_ms: Number.isFinite(w) ? w : 150 }; }
    document.querySelectorAll("#p-in select").forEach(x => { ed.inputs[+x.dataset.in] = +x.value; });
    document.querySelectorAll("#p-out select").forEach(x => { ed.outputs[+x.dataset.out] = +x.value; });
    ed.powerfail = { gpio: +$("p-pf").value, active_low: $("p-pf-lvl").value === "1" };
  }
  function resizeIo(key, n) {
    collectSettings();
    n = Math.max(0, Math.min(key === "inputs" ? SET.board.io_max_in : SET.board.io_max_out, n | 0));
    while (ed[key].length < n) ed[key].push(-1);
    ed[key].length = n;
    renderSettings();
  }
  async function saveSettings() {
    collectSettings();
    const msg = $("p-msg");
    try {
      const r = await fetch("/api/plc/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ed) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = "⚠ " + (j.msg || r.status); msg.style.color = "var(--bad)"; return; }
      msg.style.color = ""; msg.textContent = j.reboot_needed ? "salvate: valgono dal prossimo riavvio" : "salvate";
      await loadSettings(); setTimeout(loadAdv, 300);    // diagnostica avanzata: vale subito
    } catch (e) { msg.textContent = "⚠ " + e.message; }
  }
  // impostazioni cambiate qui e non ancora salvate: non si sovrascrivono con quelle del PLC
  let setTouched = false, netTouched = false;          // si toccano i campi → true; si rileggono → false
  const setDirty = () => setTouched, netDirty = () => netTouched;
  // Riavvio comandato: lo stato dopo il riavvio lo sceglie l'operatore (RUN o STOP). Il PLC non riparte
  // in RUN da solo se non l'hai deciso tu (un errore grave del firmware lo porta sempre in STOP).
  async function rebootPlc() {
    let st = "";
    try { st = (await api("/api/plc/status")).state || ""; } catch (e) {}
    const hasProg = st && st !== "no_program";
    const body = "Il PLC si ferma (uscite spente), si riavvia con le impostazioni salvate e ricarica il programma dalla flash." +
      (hasProg ? `\n\nOra è ${st === "running" ? "in RUN" : "in STOP"}. Dopo il riavvio:` : "");
    const c = hasProg ? await confirmBox("Riavviare il PLC?", body, st === "running" ? "Riavvia e riparti in RUN" : "Riavvia e resta in STOP",
                                         st === "running" ? "Riavvia e resta in STOP" : "Riavvia e riparti in RUN")
                      : await confirmBox("Riavviare il PLC?", body, "Riavvia");
    if (!c) return;
    const after = !hasProg ? "" : (c === true) === (st === "running") ? "run" : "stop";
    $("p-msg").textContent = "riavvio…" + (after ? (after === "run" ? " (poi RUN)" : " (poi STOP)") : "");
    try { await api("/api/plc/reboot" + (after ? "?after=" + after : ""), { method: "POST" }); } catch (e) {}
    for (let k = 0; k < 30; k++) {                       // aspetta che torni
      await new Promise(r => setTimeout(r, 1000));
      try { await api("/api/plc/status"); $("p-msg").textContent = "riavviato"; await loadSettings(); loadHw(); loadNet(); loadBoot(); load(true); return; } catch (e) {}
    }
    $("p-msg").textContent = "il PLC non risponde dopo il riavvio";
  }

  // ── Rete del PLC (GET/PUT /api/net/settings, GET /api/net/status) ──
  // Le password non arrivano mai dal PLC: campo vuoto = resta quella salvata.
  let NET = null, ned = null, NST = null;
  const IFF = [["ip", "IP"], ["mask", "maschera"], ["gw", "gateway"], ["dns", "DNS"], ["dns2", "DNS 2"]];
  const ifaceRows = k => `<div class="set-row"><label for="n-${k}-dhcp">Indirizzo</label><select id="n-${k}-dhcp">` +
    `<option value="1">automatico (DHCP)</option><option value="0">IP fisso</option></select></div>` +
    IFF.map(([f, t]) => `<div class="set-row"><label for="n-${k}-${f}">${t}</label><input type="text" id="n-${k}-${f}" class="n-ip" autocomplete="off"` +
      ` placeholder="${f === "mask" ? "255.255.255.0" : f === "ip" ? "192.168.1.50" : "facoltativo"}"></div>`).join("");
  async function loadNet() {
    try { NET = await api("/api/net/settings"); }
    catch (e) { $("n-info").textContent = "· non disponibile (" + e.message + ")"; return; }
    ned = clone(NET.saved); netTouched = false; renderNet(); actMark("net");
  }
  function netEnable() {
    const wifi = $("n-wifi-on").checked;               // WiFi spento: access point e router non partono
    ["n-ap-ssid", "n-ap-pass", "n-ap-ip", "n-ap-ch", "n-sta-on"].forEach(id => { $(id).disabled = !wifi; });
    $("n-ap-auto").disabled = !wifi || !$("n-sta-on").checked;
    for (const k of ["sta", "eth"]) {
      const on = $(`n-${k}-on`).checked && (k === "eth" || wifi), fixed = $(`n-${k}-dhcp`).value === "0";
      $(`n-${k}-dhcp`).disabled = !on;
      IFF.forEach(([f]) => { $(`n-${k}-${f}`).disabled = !on || !fixed; });
    }
    const st = $("n-sta-on").checked && wifi;
    $("n-sta-ssid").disabled = $("n-sta-open").disabled = !st;
    $("n-sta-pass").disabled = !st || $("n-sta-open").checked;
    const nm = $("n-name").value.trim() || "uplc";
    $("n-names").textContent = `Editor: http://${nm}.lan · http://${$("n-ap-ip").value.trim() || "?"} · http://${nm}.local`;
  }
  function renderNet() {
    $("n-reboot").classList.toggle("hidden", !NET.reboot_needed);
    $("n-wifi-on").checked = !!(ned.wifi && ned.wifi.on);
    $("n-name").value = ned.name;
    $("n-ap-ssid").value = ned.ap.ssid; $("n-ap-ip").value = ned.ap.ip;
    $("n-ap-pass").value = ""; $("n-ap-pass").placeholder = NET.ap_pass_default ? "di fabbrica: cambiala" : "invariata (scrivi per cambiarla)";
    $("n-ap-warn").classList.toggle("hidden", !NET.ap_pass_default);
    $("n-ap-auto").checked = ned.ap.auto !== false;
    $("n-editor").value = ned.editor || "all";
    $("n-ap-ch").innerHTML = Array.from({ length: 13 }, (_, i) => `<option value="${i + 1}"${i + 1 === ned.ap.channel ? " selected" : ""}>${i + 1}</option>`).join("");
    $("n-sta-on").checked = ned.sta.on; $("n-sta-ssid").value = ned.sta.ssid; $("n-sta-open").checked = false;
    $("n-sta-pass").value = ""; $("n-sta-pass").placeholder = ned.sta.pass_set ? "invariata (scrivi per cambiarla)" : "nessuna";
    for (const k of ["sta", "eth"]) {
      $(`n-${k}-on`).checked = ned[k].on; $(`n-${k}-dhcp`).value = ned[k].dhcp ? "1" : "0";
      IFF.forEach(([f]) => { $(`n-${k}-${f}`).value = ned[k][f] || ""; });
    }
    netEnable();
  }
  function collectNet() {
    const v = id => $(id).value.trim();
    const ifc = k => Object.assign({ on: $(`n-${k}-on`).checked, dhcp: $(`n-${k}-dhcp`).value === "1" },
      Object.fromEntries(IFF.map(([f]) => [f, v(`n-${k}-${f}`)])));
    const body = { wifi: { on: $("n-wifi-on").checked }, name: v("n-name"), editor: $("n-editor").value, ap: { ssid: $("n-ap-ssid").value, ip: v("n-ap-ip"), channel: +$("n-ap-ch").value, auto: $("n-ap-auto").checked },
                   sta: Object.assign(ifc("sta"), { ssid: $("n-sta-ssid").value }), eth: ifc("eth") };
    if ($("n-ap-pass").value) body.ap.pass = $("n-ap-pass").value;
    if ($("n-sta-open").checked) body.sta.open = true; else if ($("n-sta-pass").value) body.sta.pass = $("n-sta-pass").value;
    return body;
  }
  // WiFi da accendere: il WiFi prende circa 50 KB di RAM, il PLC ha una memoria di lavoro ridotta (dal riavvio)
  async function wifiWorkOk(body) {
    if (!body.wifi.on || (NET.saved.wifi && NET.saved.wifi.on)) return true;
    let m; try { m = await api("/api/plc/memory"); } catch (e) { return true; }
    if (!m.work_wifi_bytes) return true;                  // firmware di prima
    const kb = b => (b / 1024).toFixed(1).replace(".", ",") + " KB";
    if (m.work_used_bytes > m.work_wifi_bytes) {
      $("n-msg").style.color = "var(--bad)";
      $("n-msg").textContent = `⚠ con il WiFi la memoria di lavoro del PLC è ${kb(m.work_wifi_bytes)}: il programma ne usa ${kb(m.work_used_bytes)}`;
      return false;
    }
    if (m.work_total_bytes <= m.work_wifi_bytes) return true;
    return (await confirmBox("Ridurre la memoria del PLC?",
      `Il WiFi prende circa 50 KB di RAM: la memoria di lavoro del PLC passa da ${kb(m.work_total_bytes)} a ${kb(m.work_wifi_bytes)} ` +
      `(il programma ne usa ${kb(m.work_used_bytes)}). Vale dal prossimo riavvio.`, "Riduci e accendi il WiFi")) === true;
  }
  async function saveNet() {
    const msg = $("n-msg");
    if (setTouched) await saveSettings();                // anche le impostazioni del PLC del riquadro «PLC» (e le altre non salvate)
    try {
      const body = collectNet();
      if (!(await wifiWorkOk(body))) return;
      // editor su una sola interfaccia: se è quella che non sta usando questa pagina, dopo il salvataggio il PLC non risponde più da qui
      if (body.editor !== "all" && NST && !(window.EspUsb && EspUsb.on())) {
        const h = location.hostname, here = NST.eth && h === NST.eth.ip ? "eth" : (NST.sta && h === NST.sta.ip) || (NST.ap && h === NST.ap.ip) ? "wifi" : null;
        const T = { eth: "Ethernet", wifi: "WiFi" };
        if (here && here !== body.editor && !(await confirmBox(`Editor solo su ${T[body.editor]}?`,
            `Questo editor è collegato via ${T[here]}: dopo il salvataggio il PLC non gli risponde più. Resta la USB.`, "Salva"))) return;
      }
      const r = await fetch("/api/net/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = "⚠ " + (j.msg || r.status); msg.style.color = "var(--bad)"; return; }
      msg.style.color = ""; msg.textContent = j.reboot_needed ? "salvate: valgono dal prossimo riavvio" : "salvate (nessun cambiamento)";
      await loadNet();
    } catch (e) { msg.textContent = "⚠ " + e.message; }
  }
  // ── Log avanzato (GET/DELETE /api/plc/advlog, GET /api/plc/advlog/info) ──
  const kbs = b => (b / 1024).toFixed(b < 10240 ? 1 : 0).replace(".", ",") + " KB";
  async function loadAdv() {
    if (!lvAdv()) return;                                // log avanzato: solo in Avanzato
    let a; try { a = await api("/api/plc/advlog/info"); } catch (e) { $("p-adv").textContent = "log avanzato non disponibile"; $("p-adv-get").disabled = $("p-adv-del").disabled = true; return; }
    $("p-adv-get").disabled = $("p-adv-del").disabled = false;
    const wear = a.wear_pct < 0.01 ? "meno dello 0,01%" : a.wear_pct.toFixed(2).replace(".", ",") + "%";
    const parts = [`Log avanzato ${a.on ? "acceso" : "spento"}`, `file ${kbs(a.old + a.cur)} di ${kbs(a.file_max * 2)}`, `in memoria ${kbs(a.pending)}`,
      `scritti ${a.blocks} blocchi da 2 KB (${kbs(a.written)})`, `usura stimata della flash ${wear} (durata ~${Math.round(a.endurance / 1e9)} GB)`,
      `file del PLC ${kbs(a.fs_used)} su ${kbs(a.fs_total)}`];
    if (a.lost) parts.push(`${a.lost} byte persi (blocco pieno)`);
    if (a.skipped) parts.push(`${a.skipped} blocchi non scritti (spazio)`);
    if (a.on && SET && SET.adv_left_s) parts.splice(1, 0, `si spegne da solo tra ${Math.ceil(SET.adv_left_s / 60)} min`);
    put($("p-adv"), parts.map(t => `<span>${esc(t)}</span>`).join(" · "));
  }
  async function getAdv() {
    try {
      const r = await fetch("/api/plc/advlog");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const url = URL.createObjectURL(await r.blob()), a = document.createElement("a"), t = new Date(), p = n => String(n).padStart(2, "0");
      a.href = url; a.download = `uplc-log-avanzato-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.txt`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { $("p-adv").textContent = "⚠ log avanzato: " + e.message; }
  }
  async function delAdv() {
    if (!(await confirmBox("Cancellare il log avanzato?", "I file del log avanzato sul PLC e le righe in memoria si perdono.", "Cancella"))) return;
    try { await api("/api/plc/advlog", { method: "DELETE" }); } catch (e) {}
    loadAdv();
  }

  async function loadNetStatus() {
    let s; try { s = await api("/api/net/status"); } catch (e) { return; }
    NST = s;
    const on = (c, t) => `<span class="${c ? "ok" : "bad"}">${t}</span>`;
    const ap = s.ap || {}, st = s.sta || {}, et = s.eth || {};
    const rows = [
      // WiFi spento nelle impostazioni ma acceso adesso (RAM libera in STOP, WiFi acceso: solo in STOP): si dice com'è davvero
      ["Access point", s.wifi_on === false && !s.wifi_run ? '<span class="muted">WiFi spento</span>'
        : `${on(ap.on, ap.on ? "● attivo" : "○ spento")} · ${esc(ap.ssid || "")} · ${esc(ap.ip || "")} · ${ap.clients | 0} collegati · canale ${ap.channel || "?"}` +
          (s.wifi_on === false ? ' · <span class="muted">WiFi acceso solo in STOP (RAM libera in STOP)</span>' : "")],
      ["WiFi router", !st.on ? '<span class="muted">non usato</span>' : st.connected
        ? `${on(true, "● collegato")} a ${esc(st.ssid)} · ${esc(st.ip)} · segnale ${st.rssi} dBm` + (st.conflict ? ' · <span class="bad">⚠ il router dà indirizzi nella rete dell\'access point: cambia l\'IP del PLC</span>' : "")
        : `${on(false, "○ non collegato")} a ${esc(st.ssid)} (riprova ogni 30 s)`],
      ["Ethernet", !et.on ? '<span class="muted">non usata</span>' : et.connected
        ? `${on(true, "● collegata")} · ${esc(et.ip)} · ${et.mbps} Mbit/s` : on(false, et.link ? "○ cavo presente, indirizzo in attesa" : "○ cavo scollegato")],
    ];
    put($("n-status"), rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join(""));
    if ($("w-open")) {                                   // wizard: solo col WiFi acceso (prima si accende e si riavvia)
      const run = s.wifi_run !== undefined ? s.wifi_run : s.wifi_on !== false;
      $("w-open").disabled = !run;
      $("w-open").title = run ? "Cerca le reti, scegli quella del router e scrivi la password" : "WiFi spento: accendi «WiFi», salva le impostazioni di rete e riavvia il PLC";
    }
  }

  // ── Hardware (Base): un pallino per ogni parte del file della scheda e della rete. Verde va, giallo da guardare,
  //    rosso non risponde, grigio spento o non gestito. GET /api/hw/status ogni 3 s ──
  function setupHw() {
    const c = document.createElement("section");
    c.className = "card"; c.id = "card-hw";
    c.innerHTML = `<h2>Hardware <span id="hw-info" class="muted small"></span></h2><ul id="hw-list" class="hw-list"></ul>`;
    $("card-state").after(c);
  }
  const GPIO_T = ["gpi", "gpo", "gpio", "vpin"];
  const DEV_T = { shift_in: "registri d'ingresso", shift_out: "registri d'uscita", dac: "DAC", pwm: "PWM", ain: "ingresso analogico (ADC)", aout: "uscita analogica", bus: "chip" };
  const COM_T = { uart: "Seriale (UART / RS485)", can: "CAN", sd: "Scheda SD", lora: "LoRa" };
  async function loadHwStat() {
    if (!$("hw-list")) return;
    let h; try { h = await api("/api/hw/status"); } catch (e) { $("hw-info").textContent = "· non disponibile"; return; }
    const rows = [], net = h.net || {}, et = net.eth || {}, ap = net.ap || {}, st = net.sta || {};
    // solo pallino, nome e attiva / configurata / non attiva; il dettaglio (pin, IP, motivo) nel suggerimento
    const HW_ST = { ok: "attiva", cfg: "configurata", warn: "non attiva", bad: "non attiva" };
    const row = (c, name, txt) => rows.push(`<li title="${esc(txt)}"><span class="hw-dot ${c}"></span><span class="hw-n" translate="no">${esc(name)}</span><span class="hw-t">${HW_ST[c] || ""}</span></li>`);
    // un pallino solo per quello che è configurato: verde attivo, grigio configurato ma non attivo, giallo da guardare, rosso non risponde
    const cfg = h.cfg || null;                           // orologio, SD e WiFi dal file della scheda (se il file li dice)
    if (et.on) {
      if (et.driver === false) row("bad", "Ethernet", "il chip dell'Ethernet non risponde");
      else if (et.connected) row("ok", "Ethernet", `collegata · ${et.ip} · ${et.mbps} Mbit/s`);
      else row("warn", "Ethernet", et.link ? "cavo presente, indirizzo in attesa" : "cavo scollegato");
    }
    // uLink: PLC = moduli impostati (verde tutti in RUN, giallo una parte, grigio configurato ma nessuno attivo);
    // modulo I/O = il suo stato verso il PLC
    const ul = h.ulink;
    if (ul && ul.role === "plc") {
      const mod = k => k === 1 ? "1 modulo" : `${k} moduli`, conf = k => k === 1 ? "1 modulo configurato" : `${k} moduli configurati`;
      if (!ul.n) row("cfg", "uLink", "nessun modulo I/O abbinato (Impostazioni del PLC, uLink)");
      else if (!et.connected) row("cfg", "uLink", `${conf(ul.n)} · Ethernet scollegata`);
      else if (ul.run === ul.n) row("ok", "uLink", `${mod(ul.n)} in RUN`);
      else if (!ul.run) row("cfg", "uLink", `${conf(ul.n)}, nessuno in RUN` + (ul.bad ? ` · ${ul.bad} con la configurazione cambiata` : ""));
      else row("warn", "uLink", `${ul.run} di ${mod(ul.n)} in RUN` + (ul.bad ? ` · ${ul.bad} con la configurazione cambiata` : ""));
    } else if (ul && ul.role === "io") {
      const ST = ["RUN, comandato dal PLC", "BLOCCATO: uscite spente, aspetta il riarmo dal PLC", "RIARMO in corso", "configurato, nessun PLC lo comanda"];
      row(ul.state === 0 ? "ok" : ul.state === 2 ? "warn" : "cfg", "uLink", "modulo I/O · " + (ST[ul.state] || ""));
    }
    if (net.wifi_on !== false || net.wifi_run || (cfg && cfg.wifi)) {
      if (!net.wifi_run) row("cfg", "WiFi", "configurato, spento");
      else if (st.on && st.connected) row("ok", "WiFi", `collegato a ${st.ssid} · ${st.ip} · ${st.rssi} dBm`);
      else if (st.on) row("warn", "WiFi", `non collegato a ${st.ssid}` + (ap.on ? " · access point attivo" : ""));
      else row(ap.on ? "ok" : "cfg", "WiFi", ap.on ? `access point attivo · ${ap.ssid}` : "access point chiuso");
    }
    // orologio: il PLC lo cerca all'avvio sui GPIO dell'UEXT1
    const rp = h.rtc_pins || [], rtcCfg = cfg ? !!cfg.rtc : h.rtc;
    if (h.rtc) row("ok", "Orologio DS3231", `risponde · SDA GPIO${rp[0]}, SCL GPIO${rp[1]}`);
    else if (rtcCfg) row("warn", "Orologio DS3231", `non trovato all'avvio (SDA GPIO${rp[0]}, SCL GPIO${rp[1]}): controlla alimentazione e fili; se SDA e SCL sono invertiti scambiali e riavvia il PLC`);
    if (cfg && cfg.sd) row("cfg", "Scheda SD", "configurata");
    // file della scheda
    if (!h.loaded) row("warn", "File della scheda", h.error || "nessun file della scheda");
    const devs = h.devices || [];
    for (const b of h.buses || []) {
      const on = devs.filter(d => d.bus === b.id), p = b.pins || [], bad = on.filter(d => !d.ok);
      const rtcHere = !!h.rtc && b.type === "i2c" && p[0] === rp[0] && p[1] === rp[1];   // l'orologio risponde su questi pin: fili giusti
      const pins = b.type === "i2c" ? `SDA GPIO${p[0]}, SCL GPIO${p[1]}` : `SCK GPIO${p[0]}, MOSI GPIO${p[1]}, MISO GPIO${p[2]}`;
      const nm = `${b.type.toUpperCase()} ${b.id}`, rtcTxt = rtcHere ? " · orologio DS3231" : "";
      if (!on.length) { row(b.up || rtcHere ? "ok" : "cfg", nm, `${b.up || rtcHere ? "attiva" : "configurata"}${rtcTxt} · ${pins}`); continue; }
      const c = !b.up ? "bad" : bad.length === on.length ? "bad" : bad.length ? "warn" : "ok";
      const t = !b.up ? "bus non avviato" : bad.length === on.length && b.type === "i2c" && !rtcHere
        ? "nessun dispositivo risponde: controlla alimentazione e fili; se SDA e SCL sono invertiti scambiali" : bad.length ? `${on.length - bad.length} di ${on.length} dispositivi rispondono` : on.length === 1 ? "il dispositivo risponde" : `${on.length} dispositivi rispondono`;
      row(c, nm, `${t}${rtcTxt} · ${pins}`);
    }
    const gp = devs.filter(d => GPIO_T.includes(d.type));
    if (gp.length) row(gp.every(d => d.ok) ? "ok" : "bad", "GPIO", `${gp.length} ingressi e uscite` + (gp.some(d => !d.ok) ? ` · ${gp.filter(d => !d.ok).map(d => d.id + ": " + (d.error || "errore")).join(", ")}` : ""));
    for (const d of devs.filter(d => !GPIO_T.includes(d.type) && d.type !== "remote")) {
      const what = d.chip || DEV_T[d.type] || d.type;
      const where = d.bus ? ` · ${d.bus}${d.addr ? " " + d.addr : ""}` : "";
      row(d.ok ? "ok" : "bad", `${d.id}`, `${what}${where} · ${d.ok ? "risponde" : d.error || "non risponde"}`);
    }
    for (const c of h.com || []) row("cfg", COM_T[c.type] || c.type, `configurata · ${c.id}`);
    $("hw-info").textContent = h.loaded ? `· «${h.board}»` : "";
    put($("hw-list"), rows.join(""));
  }

  // ── Wizard del WiFi (Base), a passi: avviso → reti (trovate e salvate) → password → collegato (DHCP o statico) →
  //    riepilogo e «Salva connessione». Si prova senza salvare (POST /api/net/wiz), Annulla torna a com'era.
  //    Solo col WiFi già acceso; non dall'editor aperto attraverso il router (si scollegherebbe) ──
  const W = { step: "", net: null, nets: [], known: [], timer: 0, st: null, ip: null };
  const WIFI_BAD_PASS = [2, 14, 15, 202, 204];        // motivi di scollegamento: password sbagliata
  const ipOk = t => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(t) && t.split(".").every(x => +x <= 255);
  const maskOf = t => { const a = +t.split(".")[0]; return a < 128 ? "255.0.0.0" : a < 192 ? "255.255.0.0" : "255.255.255.0"; };   // classe A, B, C
  function setupWizard() {
    const h3 = $("n-sta-on").closest("h3");
    const b = document.createElement("div");
    b.className = "set-row"; b.dataset.layer = "base";
    b.innerHTML = `<button type="button" id="w-open">📶 Collega al router</button>`;
    h3.after(b);
    const m = document.createElement("div");
    m.id = "wifi-wiz"; m.className = "modal hidden";
    m.innerHTML = `<div class="modal-box w-box"><h3><button type="button" id="w-back" class="w-back hidden" title="Indietro">←</button><span id="w-title">Collega il PLC al router</span></h3>
      <div id="w-body"></div><p id="w-msg" class="w-msg"></p><div class="row right" id="w-btns"></div></div>`;
    document.body.appendChild(m);
    $("w-open").onclick = () => { m.classList.remove("hidden"); wGo("warn"); };
    $("w-back").onclick = () => wGo(W.step === "pass" ? "nets" : W.step === "ip" ? "nets" : W.step === "sum" ? "ip" : "nets");
    m.addEventListener("click", e => {
      const t = e.target.closest("[data-w]"); if (!t) return;
      const a = t.dataset.w;
      if (a === "cancel") wCancel();
      else if (a === "ok") wStart();
      else if (a === "rescan") wScan();
      else if (a === "confirm") wConfirm();
      else if (a === "connect") wTry();
      else if (a === "eye") { const p = $("w-pass"); p.type = p.type === "password" ? "text" : "password"; }
      else if (a === "tab") { W.ipTab = t.dataset.tab; wGo("ip"); }
      else if (a === "dhcp") wIp(true);
      else if (a === "static") wIp(false);
      else if (a === "save") wSave();
      else if (a === "net") { W.net = { ssid: t.dataset.ssid, open: t.dataset.open === "1", known: t.dataset.known === "1" }; wGo("nets"); }
    });
    m.addEventListener("input", e => {
      if (e.target.id === "w-sip") { const v = e.target.value.trim(); if (ipOk(v) && !$("w-smask").dataset.touched) $("w-smask").value = maskOf(v); }
      if (e.target.id === "w-smask") e.target.dataset.touched = "1";
      if (e.target.id === "w-sdns") $("w-dns2-row").classList.toggle("hidden", !ipOk(e.target.value.trim()));
      if (e.target.id === "w-son") ["w-sip", "w-smask", "w-sgw", "w-sdns", "w-sdns2"].forEach(id => { $(id).disabled = !e.target.checked; });
    });
  }
  const wPost = body => api("/api/net/wiz", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const wMsg = (t, bad) => { $("w-msg").textContent = t || ""; $("w-msg").classList.toggle("bad", !!bad); };
  const wBtn = (a, t, cls, dis) => `<button type="button" data-w="${a}"${cls ? ` class="${cls}"` : ""}${dis ? " disabled" : ""}>${esc(t)}</button>`;
  function wClose() { clearTimeout(W.timer); W.timer = 0; W.step = ""; $("wifi-wiz").classList.add("hidden"); }
  async function wCancel() {                               // Annulla: niente salvato, il PLC torna al router di prima
    const started = W.step !== "warn";
    wClose();
    if (started) { try { await wPost({ op: "cancel" }); } catch (e) {} loadNetStatus(); }
  }
  function wGo(step, msg, bad) {
    clearTimeout(W.timer); W.step = step;
    const put = (el, html) => { el.innerHTML = html; };   // qui sempre: put() salta un riquadro con un campo attivo (la password)
    $("w-back").classList.toggle("hidden", !["pass", "ip", "sum"].includes(step));
    const body = $("w-body"), btns = $("w-btns");
    const cancel = wBtn("cancel", "Annulla");
    if (step === "warn") {
      const viaSta = NST && NST.sta && NST.sta.ip && location.hostname === NST.sta.ip;
      put(body, `<p>Per il wizard il PLC si scollega dal router. «Annulla» rimette tutto com'era; le impostazioni si salvano solo alla fine.</p>` +
        (viaSta ? `<p class="bad">L'editor è aperto attraverso il router: si scollegherebbe. Apri l'editor dall'Ethernet o dall'access point del PLC.</p>` : ""));
      put(btns, cancel + wBtn("ok", "OK", "primary", viaSta));
    } else if (step === "nets") {
      const seen = new Set(W.nets.map(n => n.ssid));
      const bars = r => { const n = r >= -55 ? 4 : r >= -67 ? 3 : r >= -78 ? 2 : 1;      // 4 tacche, quelle spente in grigio
        return `<span class="w-sig">${[1, 2, 3, 4].map(k => `<i class="${k <= n ? "on" : ""}"></i>`).join("")}</span>`; };
      const sel = s => W.net && W.net.ssid === s ? " on" : "";
      put(body, `<div class="w-cap">Reti trovate</div><div class="w-list">` +
        (W.nets.map(n => `<button type="button" data-w="net" data-ssid="${esc(n.ssid)}" data-open="${n.open ? 1 : 0}" data-known="${W.known.includes(n.ssid) ? 1 : 0}" class="${sel(n.ssid)}">` +
          `<span class="w-ssid" translate="no">${esc(n.ssid)}</span><span class="w-c muted small">${W.known.includes(n.ssid) ? "salvata" : ""}</span>` +
          `<span class="w-c">${n.open ? '<span class="muted small">aperta</span>' : "🔒"}</span><span class="w-c">${bars(n.rssi)}</span><span class="w-c muted small">${n.rssi} dBm</span></button>`).join("")
          || `<div class="muted small">${W.timer || W.scanning ? "cerco le reti…" : "nessuna rete trovata"}</div>`) + `</div>` +
        `<div class="w-cap">Reti salvate</div><div class="w-list w-saved">` +
        (W.known.map(s => `<button type="button" data-w="net" data-ssid="${esc(s)}" data-open="0" data-known="1" class="${sel(s)}"${seen.has(s) ? "" : " disabled"}>` +
          `<span class="w-ssid" translate="no">${esc(s)}</span><span class="w-c muted small">${seen.has(s) ? "in zona" : "non trovata"}</span></button>`).join("")
          || `<div class="muted small">nessuna</div>`) + `</div>`);
      put(btns, cancel + wBtn("rescan", "Cerca di nuovo") + wBtn("confirm", "Conferma", "primary", !W.net));
    } else if (step === "pass") {
      put(body, `<p>Rete <b translate="no">${esc(W.net.ssid)}</b></p><div class="row"><label for="w-pass">Password</label>` +
        `<input type="password" id="w-pass" maxlength="63" autocomplete="new-password" placeholder="${W.net.known ? "vuota: quella salvata" : ""}">` +
        `<button type="button" data-w="eye" title="Mostra o nascondi la password">👁</button></div>`);
      put(btns, cancel + wBtn("connect", "Connetti", "primary"));
      setTimeout(() => $("w-pass") && $("w-pass").focus(), 0);
    } else if (step === "wait") {
      put(body, `<p>Mi collego a <b translate="no">${esc(W.net.ssid)}</b>…</p>`);
      put(btns, cancel);
    } else if (step === "ip") {
      const st = W.st || {}, tab = W.ipTab || "dhcp", s = W.ip || {};
      const v = k => esc(s[k] !== undefined ? s[k] : "");
      put(body, `<p class="ok">● Collegato a <b translate="no">${esc(W.net.ssid)}</b></p>` +
        `<div class="w-tabs">${["dhcp", "static"].map(t => `<button type="button" data-w="tab" data-tab="${t}" class="${tab === t ? "on" : ""}">${t === "dhcp" ? "DHCP" : "IP statico"}</button>`).join("")}</div>` +
        (tab === "dhcp"
          ? `<table class="w-kv"><tr><td>IP</td><td>${esc(st.ip || "")}</td></tr><tr><td>Maschera</td><td>${esc(st.mask || "")}</td></tr>` +
            `<tr><td>Gateway</td><td>${esc(st.gw || "")}</td></tr><tr><td>DNS</td><td>${esc(st.dns || "")}</td></tr>` +
            (st.dns2 && st.dns2 !== "0.0.0.0" ? `<tr><td>DNS 2</td><td>${esc(st.dns2)}</td></tr>` : "") + `</table>`
          : `<label class="w-flag"><input type="checkbox" id="w-son"${s.on ? " checked" : ""}> inserisci l'IP statico</label><table class="w-kv">` +
            `<tr><td><label for="w-sip">IP</label></td><td><input type="text" id="w-sip" class="n-ip" value="${v("ip")}"${s.on ? "" : " disabled"}></td></tr>` +
            `<tr><td><label for="w-smask">Maschera</label></td><td><input type="text" id="w-smask" class="n-ip" value="${v("mask")}"${s.mask ? ' data-touched="1"' : ""}${s.on ? "" : " disabled"}></td></tr>` +
            `<tr><td><label for="w-sgw">Gateway</label></td><td><input type="text" id="w-sgw" class="n-ip" value="${v("gw")}"${s.on ? "" : " disabled"}></td></tr>` +
            `<tr><td><label for="w-sdns">DNS</label></td><td><input type="text" id="w-sdns" class="n-ip" value="${v("dns")}"${s.on ? "" : " disabled"}></td></tr>` +
            `<tr id="w-dns2-row"${ipOk(s.dns || "") ? "" : ' class="hidden"'}><td><label for="w-sdns2">DNS 2</label></td><td><input type="text" id="w-sdns2" class="n-ip" value="${v("dns2")}"${s.on ? "" : " disabled"}></td></tr></table>`));
      put(btns, cancel + (tab === "dhcp" ? wBtn("dhcp", "Prosegui DHCP", "primary") : wBtn("static", "Prosegui statica", "primary", false)));
    } else if (step === "sum") {
      const st = W.st || {};
      const rows = [["Rete", W.net.ssid], ["Indirizzo", st.dhcp === false ? "IP statico" : "DHCP"], ["IP", st.ip], ["Maschera", st.mask], ["Gateway", st.gw],
        ["DNS", st.dns], ...(st.dns2 && st.dns2 !== "0.0.0.0" ? [["DNS 2", st.dns2]] : []), ["Canale", st.ch],
        ["Ricezione (RX)", st.rssi !== undefined ? `${st.rssi} dBm` : ""], ["Trasmissione (TX)", st.txp !== undefined ? `${st.txp} dBm` : ""]];
      put(body, `<p>Riepilogo della connessione</p><table class="w-kv">${rows.map(([k, x]) => `<tr><td>${esc(k)}</td><td translate="no">${esc(x === undefined ? "" : String(x))}</td></tr>`).join("")}</table>`);
      put(btns, cancel + wBtn("save", "Salva connessione", "primary"));
    }
    wMsg(msg, bad);
  }
  async function wStart() {
    try { await wPost({ op: "start" }); } catch (e) { wMsg(e.message, true); return; }
    W.net = null; W.ip = null; W.ipTab = "dhcp";
    wScan();
  }
  async function wScan() {
    W.nets = []; W.scanning = true; wGo("nets");
    const t0 = Date.now();
    const step = async () => {
      let j; try { j = await api("/api/net/scan"); } catch (e) { W.scanning = false; wGo("nets", e.message, true); return; }
      if (W.step !== "nets") return;
      if (j.state === "off") { W.scanning = false; wGo("nets", "WiFi spento: accendi «WiFi», salva le impostazioni di rete e riavvia il PLC.", true); return; }
      if (j.state === "scan") {
        if (Date.now() - t0 > 20000) { W.scanning = false; wGo("nets", "La ricerca non risponde: «Cerca di nuovo».", true); return; }
        W.timer = setTimeout(step, 1000); return;
      }
      W.scanning = false; W.timer = 0;
      W.nets = (j.nets || []).sort((a, b) => b.rssi - a.rssi); W.known = j.known || [];
      wGo("nets");
    };
    step();
  }
  function wConfirm() {
    if (!W.net) return;
    if (W.net.open) { wTry(); return; }
    wGo("pass");
  }
  async function wTry() {
    const body = { op: "try", ssid: W.net.ssid };
    if (!W.net.open) {
      const p = $("w-pass") ? $("w-pass").value : "";
      if (p) { if (p.length < 8) { wMsg("password: almeno 8 caratteri", true); return; } body.pass = p; }
      else if (!W.net.known) { wMsg("scrivi la password", true); return; }
    } else body.pass = "";
    wGo("wait");
    try { await wPost(body); } catch (e) { wGo(W.net.open ? "nets" : "pass", e.message, true); return; }
    const t0 = Date.now();
    const check = async () => {
      if (W.step !== "wait") return;
      let s = null; try { s = await api("/api/net/status"); } catch (e) {}
      const st = s && s.sta;
      if (st && st.connected && st.ssid === W.net.ssid) { W.st = st; W.ipTab = "dhcp"; wGo("ip"); return; }
      const r = st ? st.reason | 0 : 0;
      if (Date.now() - t0 > 6000 && r === 201) { wGo("nets", `Rete ${W.net.ssid} non trovata`, true); return; }
      if (Date.now() - t0 > 6000 && WIFI_BAD_PASS.includes(r)) { wGo(W.net.open ? "nets" : "pass", "Password sbagliata", true); return; }
      if (Date.now() - t0 > 30000) { wGo(W.net.open ? "nets" : "pass", `Non collegato a ${W.net.ssid}` + (r ? ` (motivo ${r})` : ""), true); return; }
      W.timer = setTimeout(check, 1000);
    };
    W.timer = setTimeout(check, 1500);
  }
  async function wIp(dhcp) {
    let body = { op: "ip", dhcp };
    if (!dhcp) {
      const g = id => $(id).value.trim();
      W.ip = { on: $("w-son").checked, ip: g("w-sip"), mask: g("w-smask"), gw: g("w-sgw"), dns: g("w-sdns"), dns2: g("w-sdns2") };
      if (!W.ip.on) { wMsg("spunta «inserisci l'IP statico»", true); return; }
      if (!ipOk(W.ip.ip)) { wMsg("IP non valido", true); return; }
      for (const k of ["mask", "gw", "dns", "dns2"]) if (W.ip[k] && !ipOk(W.ip[k])) { wMsg(`${k === "mask" ? "maschera" : k.toUpperCase()} non valido`, true); return; }
      if (!ipOk(W.ip.dns)) W.ip.dns2 = "";
      Object.assign(body, { ip: W.ip.ip, mask: W.ip.mask || maskOf(W.ip.ip), gw: W.ip.gw, dns: W.ip.dns, dns2: W.ip.dns2 });
    }
    try { await wPost(body); } catch (e) { wMsg(e.message, true); return; }
    setTimeout(async () => {
      let s = null; try { s = await api("/api/net/status"); } catch (e) {}
      if (s && s.sta) W.st = s.sta;
      wGo("sum");
    }, dhcp ? 300 : 1200);
  }
  async function wSave() {
    try { await wPost({ op: "save" }); } catch (e) { wMsg(e.message, true); return; }
    wMsg(`Connessione a ${W.net.ssid} salvata`);
    loadNetStatus(); if (!netDirty()) loadNet();
    W.timer = setTimeout(wClose, 1200);
  }

  // ── Avvio del PLC (GET /api/plc/boot): fasi e controlli ──
  // Le fasi sono quelle dell'accensione: STOP→RUN non le rifà. L'ultimo StartUp (accensione, STOP→RUN o
  // download completo) viene da /api/plc/status.
  let lastSu = null;
  async function loadBoot() {
    let b;
    try { b = await api("/api/plc/boot"); } catch (e) { $("b-info").textContent = "· non disponibile (" + e.message + ")"; return; }
    const sf = b.sf || [];
    $("b-info").textContent = b.done ? `${b.done_ms} ms` + (b.net ? ` · rete ${b.net.up ? "pronta" : "assente"}` : "") : "in corso…";
    $("b-sf").classList.toggle("hidden", !sf.length);
    const act = x => x.code === 10 ? ` <a class="sf-act" href="#card-err">errori del programma</a>`
                   : (x.code === 9 || x.code === 2) ? ` <a class="sf-act" href="#card-plc">impostazioni</a>` : "";
    put($("b-sf"), `<b>● SF — errore di sistema</b> (il PLC resta in RUN)<ul>` +
      sf.map(x => `<li>${esc(x.text)} <span class="muted">da ${Math.round(x.age_ms / 1000)} s</span>${act(x)}</li>`).join("") + "</ul>");
    put($("b-phases"), (b.phases || []).map(p => `<li>${esc(p.name)} <span class="muted">${p.ms} ms</span></li>`).join("") +
      (lastSu && lastSu.present && lastSu.count ? `<li>StartUp <span class="muted">${(lastSu.us / 1000).toFixed(2).replace(".", ",")} ms</span></li>` : ""));
    const SEV = { info: "ℹ", warn: "⚠", error: "●" };
    put($("b-checks").querySelector("tbody"), (b.checks || []).map(c =>
      `<tr class="lvl-${c.sev === "error" ? "err" : c.sev}"><td>${SEV[c.sev] || ""}</td><td>${esc(c.text)}</td></tr>`).join("") ||
      '<tr><td></td><td class="muted">nessun controllo segnalato</td></tr>');
  }

  // ── Apertura e chiusura della finestra ──
  // Pulsanti collegati una volta; letture e giri periodici solo con la finestra aperta.
  let ready = false, timers = [], shown = false;
  function init() {
    ready = true;
    $("d-close").onclick = close;
    document.addEventListener("keydown", e => { if (shown && e.key === "Escape" && $("confirm-modal").classList.contains("hidden")) close(); });
    // «errori del programma», «impostazioni» negli errori di sistema: si scorre alla scheda
    $("diag-overlay").addEventListener("click", e => {
      const a = e.target.closest && e.target.closest("a.sf-act");
      if (!a) return;
      e.preventDefault(); goto(a.getAttribute("href").slice(1));
    });
    $("d-refresh").onclick = () => load(true);
    // scorrendo verso le voci più vecchie: si legge subito il resto
    $("d-log").closest(".log-wrap").addEventListener("scroll", () => { if (nearEnd() && (olderLeft() || olderDirty)) loadAllOlder(); });
    $("p-backup").onclick = () => progCmd("backup");
    $("p-restore").onchange = e => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      progCmd("restore", { file: f });
    };
    $("p-delete").onclick = async () => {
      const c = await confirmBox("Cancellare il programma dal PLC?",
        "Il programma viene cancellato dalla RAM e dalla flash. Vuoi prima salvarne una copia su file?", "Salva e cancella", "Cancella senza salvare");
      if (c) progCmd("delete", { save: c === true });
    };
    $("d-level").onchange = render;
    $("d-filter").oninput = render;
    $("d-export").onclick = exportCsv;
    setupHw();
    setupWizard();
    setupLevels();
    syncActs();
    ["input", "change", "click"].forEach(ev => $("diag-overlay").addEventListener(ev, () => setTimeout(syncActs, 0)));
    $("d-logsize-apply").onclick = async () => {
      const bytes = +$("d-logsize").value;
      if (info && bytes < info.bytes && !(await confirmBox("Ridurre il log?",
          `Da ${info.bytes} a ${bytes} byte: restano solo le ${bytes / 16} voci più recenti.`, "Riduci"))) return;
      try { await api("/api/plc/log/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bytes }) }); }
      catch (e) { alert("impostazione non applicata: " + e.message); }
      load(true);
    };
    $("p-save").onclick = saveSettings;
    $("p-net").onchange = () => { collectSettings(); renderSettings(); };
    $("p-ug").onchange = () => { collectSettings(); renderSettings(); };
    // scelto un GPIO: si aggiornano i ⚠ (anche «già I…/Q…» sugli altri)
    $("card-plc").addEventListener("change", e => { if (e.target.dataset.in || e.target.dataset.out || e.target.id === "p-pf" || e.target.id === "p-role") { collectSettings(); renderSettings(); } });
    $("p-undo").onclick = () => { ed = clone(SET.saved); setTouched = false; renderSettings(); actMark("plc"); $("p-msg").textContent = ""; };
    $("p-reboot-btn").onclick = rebootPlc;
    $("p-hw-file").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadHw(f); };
    $("p-nin").onchange = () => resizeIo("inputs", +$("p-nin").value);
    $("p-nout").onchange = () => resizeIo("outputs", +$("p-nout").value);
    $("n-sta-f").innerHTML = ifaceRows("sta"); $("n-eth-f").innerHTML = ifaceRows("eth");
    $("card-net").addEventListener("input", netEnable); $("card-net").addEventListener("change", netEnable);
    ["input", "change"].forEach(ev => { $("card-net").addEventListener(ev, () => { netTouched = true; }); $("card-plc").addEventListener(ev, () => { setTouched = true; }); });
    $("n-save").onclick = saveNet;
    // impostazioni del PLC nella Rete del PLC (rete usata dal programma, mancanza tensione, protezione reset USB)
    ["input", "change"].forEach(ev => $("p-netplc").addEventListener(ev, () => { setTouched = true; }));
    $("p-netplc").addEventListener("change", e => { if (e.target.id === "p-pf") { collectSettings(); renderSettings(); } });
    // ingressi e uscite a schede
    document.querySelectorAll("#card-plc .p-tab").forEach(b => b.onclick = () => {
      document.querySelectorAll("#card-plc .p-tab").forEach(x => x.classList.toggle("active", x === b));
      document.querySelectorAll("#card-plc .p-pane").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.ptab));
    });
    // diagnostica avanzata (Log): vale subito, si salva da sola
    $("p-ser").onchange = async () => {
      const mode = $("p-ser").value;
      try {
        await api("/api/plc/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serial: { mode } }) });
        if (SET) { SET.saved.serial = { mode }; SET.active.serial = { mode }; if (ed) ed.serial = { mode }; }
        try { SET = Object.assign(SET || {}, { adv_left_s: (await api("/api/plc/settings")).adv_left_s }); } catch (e) {}
      } catch (e) { $("p-adv").textContent = "⚠ " + e.message; }
      setTimeout(loadAdv, 300);
    };
    busInit();
    document.querySelectorAll("select.sel2").forEach(sel2);
    $("n-undo").onclick = () => { ned = clone(NET.saved); netTouched = false; renderNet(); $("n-msg").textContent = "";
      if (SET) { ed = clone(SET.saved); setTouched = false; renderSettings(); actMark("plc"); } actMark("net"); };
    $("n-reboot-btn").onclick = rebootPlc;
    $("p-adv-get").onclick = getAdv; $("p-adv-del").onclick = delAdv;
    $("d-clock-set").onclick = async () => {
      try { await api("/api/plc/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unix: Math.floor(Date.now() / 1000) }) }); } catch (e) {}
      loadClock(); load(true);
    };
  }
  function goto(id) { const el = id && $(id); if (el) el.scrollIntoView({ block: "start" }); }
  function open(card) {
    if (!ready) init();
    $("diag-overlay").classList.remove("hidden");
    goto(card);
    if (shown) return;
    shown = true; gen = null;
    loadNet(); loadNetStatus();
    loadSettings(); loadBoot(); loadAdv(); loadHw();
    load(true); loadState(true); loadClock(); loadTasks(); loadBus(); loadHwStat();
    // v4.7: UN frame leggero al secondo (stato, ciclo, bit di aggiornamento); log, errori, avvio e impostazioni
    // si rileggono solo quando il loro bit cambia. Rete (collegamenti) ogni 5 s, data e ora ogni 10 s.
    timers = [
      setInterval(() => loadState(false), 1000),
      setInterval(() => loadOlder(LOG_STEP), 1000),     // log: le voci più vecchie a gradini
      setInterval(loadAdv, 15000),
      setInterval(loadClock, 10000),
      setInterval(showClock, 1000),
      setInterval(loadTasks, 2000),
      setInterval(loadBus, 1000),
      setInterval(syncActs, 400),                         // Salva / Annulla solo con modifiche
      setInterval(loadHwStat, 3000),                     // pallini dell'Hardware
      setInterval(identTick, 1000),                      // Identifica: il PLC lo manda finché lo chiediamo
      setInterval(() => { loadNetStatus(); if (!gen) { if ($("d-auto").checked) load(false); loadErrorsNow(); loadBoot(); } }, 5000),
      setInterval(() => { if (gen) loadBoot(); }, 15000),        // «da N s» degli errori di sistema
    ];
  }
  function close() {
    timers.forEach(clearInterval); timers = [];
    identStop();                                         // Identifica si spegne chiudendo
    shown = false;
    $("diag-overlay").classList.add("hidden");
  }
  // ── Analisi RAM (Denys 31-10-2026): RAM adesso, ultimi 10 s e ultimo minuto (min, media, max), minimo dall'avvio,
  //    stack di ogni task (GET /api/plc/tasks, un giro al secondo finché la finestra è aperta). Dall'editor e dalla Diagnostica ──
  let ramTimer = 0;
  async function ramLoad() {
    let t;
    try { t = await api("/api/plc/tasks"); }
    catch (e) { $("ram-when").textContent = "PLC non raggiungibile: " + e.message; return; }
    const kb = b => b === undefined || b === null ? "—" : kb1(b) + " KB";
    const h = t.heap || {}, hs = t.hist || {};
    const row = (name, x, total, lowAt) => {
      if (!x) return "";
      const c = v => v !== undefined && lowAt && v < lowAt ? ' class="low"' : "";
      const s10 = x.s10 || {}, m1 = x.m1 || {};
      return `<tr><td>${name}</td><td${c(x.now)}>${kb(x.now)}</td><td${c(s10.min)}>${kb(s10.min)}</td><td>${kb(s10.avg)}</td><td>${kb(s10.max)}</td>` +
             `<td${c(m1.min)}>${kb(m1.min)}</td><td>${kb(m1.avg)}</td><td>${kb(m1.max)}</td><td${c(x.boot_min)}>${kb(x.boot_min)}</td><td>${kb(total)}</td></tr>`;
    };
    $("ram-heap").querySelector("tbody").innerHTML = hs.free
      ? row("RAM libera", hs.free, h.total, 32768) + row("Blocco libero più grande", hs.block, null, 12288) +
        (h.iram_only_total ? row("IRAM libera", hs.iram, h.iram_only_total, 0) : "")
      : `<tr><td colspan="10" class="muted">Storico non disponibile: firmware senza Analisi RAM (RAM libera ${kb(h.free)}, minimo ${kb(h.min)})</td></tr>`;
    const tasks = (t.tasks || []).slice().sort((a, b) => a.n.localeCompare(b.n));
    const stackSum = tasks.reduce((a, x) => a + (x.stack || 0), 0);
    const pc = v => v === null || v === undefined ? "—" : `${String(v).replace(".", ",")} %`;
    // RAM dinamica per task: solo con «RAM per task» acceso in MiaConfig (CONFIG_HEAP_TASK_TRACKING)
    const th = t.task_heap ? new Map(t.task_heap.map(x => [x.n, x])) : null;
    $("ram-info").textContent = `CPU0 ${pc(t.cpu && t.cpu[0])}${t.cpu && t.cpu.length > 1 ? ` · CPU1 ${pc(t.cpu[1])}` : ""} · task ${t.n_tasks} · stack dei task noti ${kb(stackSum)}` +
      (hs.free_blocks !== undefined ? ` · pezzi liberi ${hs.free_blocks}, in uso ${hs.used_blocks}` : "") +
      (hs.n !== undefined ? ` · campioni ${hs.n} (ogni ${hs.ms} ms)` : "") +
      (th ? ` · costo di «RAM per task» circa ${kb(t.track_cost)} (stima dai pezzi)` : " · RAM dinamica per task: spenta (MiaConfig, Progetto → Diagnostica)");
    const dyn = x => { const h = th && th.get(x); return th ? (h ? `${kb(h.bytes)} (${h.blocks})` : "—") : ""; };
    $("ram-tasks").querySelector("tbody").innerHTML = tasks.map(x => {
      // stack noto e coerente (ESP-IDF a volte aggiunge byte al valore configurato: libero > stack = non si sa)
      const known = x.stack && x.free <= x.stack;
      const used = known ? x.stack - x.free : null, pct = known ? Math.round(100 * used / x.stack) : null;
      const bad = x.free < 512 || pct > 90, warn = !bad && pct > 75;
      return `<tr><td translate="no">${esc(x.n)}</td><td>${x.core === null ? "0 e 1" : x.core}</td><td>${x.prio}</td>` +
             `<td>${x.stack ? x.stack + " B" : "—"}</td><td>${used === null ? "—" : used + " B"}</td>` +
             `<td class="${bad ? "low" : warn ? "warn" : ""}">${pct === null ? "—" : pct + " %"}</td>` +
             `<td class="${x.free < 512 ? "low" : ""}">${x.free} B</td><td>${pc(x.cpu)}${/^IDLE/.test(x.n) ? " libera" : ""}</td><td>${dyn(x.n)}</td></tr>`;
    }).join("") + (th ? [...th.values()].filter(h => !tasks.some(x => x.n === h.n)).map(h =>
      `<tr><td translate="no">${esc(h.n)}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td>${kb(h.bytes)} (${h.blocks})</td></tr>`).join("") : "");
    $("ram-when").textContent = "letto alle " + new Date().toLocaleTimeString();
  }
  function ramOpen() {
    $("ram-modal").classList.remove("hidden");
    $("ram-close").onclick = ramClose;
    clearInterval(ramTimer);
    ramLoad(); ramTimer = setInterval(ramLoad, 1000);
  }
  function ramClose() { clearInterval(ramTimer); ramTimer = 0; $("ram-modal").classList.add("hidden"); }
  if ($("d-ram-btn")) $("d-ram-btn").addEventListener("click", ramOpen);

  window.EspDiag = { open, close, isOpen: () => shown, ram: ramOpen };
})();
