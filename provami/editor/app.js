// EspPlc Editor — vanilla JS, SVG inline, nessun framework.
// Ladder bool con aree I / Q / M, network numerati, rami paralleli annidati
// (OR che si richiudono) e uscite parallele (diramazioni a T).
// Formato del programma: vedi ir.js.

(function () {
  "use strict";
  // niente correttore ortografico in tutto l'editor (commenti, titoli, simboli): spellcheck si eredita dall'elemento <html>
  document.documentElement.spellcheck = false;
  // testo scritto dall'utente dentro un testo dell'interfaccia: la traduzione non lo tocca (vedi i18n.js)
  const U = v => (v === undefined || v === null || v === "" ? v : "\u2068" + v + "\u2069");
  // Testi dell'utente nelle altre lingue (project.texts, foglio «user» delle lingue): con l'editor in una lingua
  // diversa dall'italiano si vede e si scrive la colonna di quella lingua; vuota = il testo italiano del progetto.
  const uiLang = () => (window.EspI18n && EspI18n.lang()) || "it";
  function ut(id, orig) {
    const l = uiLang(), m = l !== "it" && project.texts && project.texts[l];
    return (m && m[id]) || orig;
  }
  function setUt(id, v, orig) {                          // false = lingua italiana: si scrive il progetto
    const l = uiLang();
    if (l === "it") return false;
    project.texts = project.texts || {};
    const m = project.texts[l] = project.texts[l] || {};
    if (v && v !== orig) m[id] = v; else delete m[id];
    if (!Object.keys(m).length) delete project.texts[l];
    if (!Object.keys(project.texts).length) delete project.texts;
    return true;
  }
  // tutti i testi scritti nel progetto, con il loro id (foglio «user»)
  function userTexts() {
    const out = [], add = (id, it) => { if (it) out.push({ id, it, cols: Object.fromEntries(Object.entries(project.texts || {}).map(([l, m]) => [l, m[id] || ""])) }); };
    for (const b of project.blocks) {
      if (b.type === "fc") add(`fc:${b.number}`, b.name && b.name !== "FC" + b.number ? b.name : "");
      for (const sg of b.segments) { add(`net:${b.id}:${sg.id}:t`, sg.title); add(`net:${b.id}:${sg.id}:c`, sg.comment); }
      if (b.iface) for (const d of ["in", "out", "inout", "temp"]) for (const v of b.iface[d] || []) add(`if:${b.number}:${v.name}`, v.comment);
    }
    for (const sy of EspSymbols.list()) add(`sym:${sy.key}`, sy.comment);
    for (const d of project.dbs || []) for (const f of d.fields || []) add(`db:${d.number}:${f.name}`, f.comment);
    for (const m of project.modules || []) {
      if (m.type === "data") for (const dir of ["tx", "rx"]) for (const r of m[dir] || []) add(`exp:${dir}:${r.name}`, r.comment);
      if (m.type === "hmi") (m.rows || []).forEach((r, i) => { add(`hmi:${i}:n`, r.name); add(`hmi:${i}:u`, r.unit); });
    }
    return out;
  }
  window.ESPPLC_USERTEXTS = {
    list: userTexts,
    set(cols) {                                          // { en: { id: testo } } dal foglio «user»: sostituisce le colonne lette
      const ids = new Set(userTexts().map(x => x.id));
      let n = 0;
      project.texts = project.texts || {};
      for (const [l, m] of Object.entries(cols)) {
        const o = {};
        for (const [id, v] of Object.entries(m)) if (ids.has(id)) { o[id] = v; n++; }
        if (Object.keys(o).length) project.texts[l] = o; else delete project.texts[l];
      }
      if (!Object.keys(project.texts).length) delete project.texts;
      markTextDirty("traduzioni dei testi del progetto importate");
      return n;
    },
  };
  window.addEventListener("espplc-lang", () => { if (typeof render === "function") { render(); renderBlocks(); } });

  // Il server web del PLC serve una richiesta per volta e ogni richiesta apre una connessione nuova:
  // sul WiFi una risposta può metterci più di un secondo. Con 800 ms e 3 errori di fila l'editor
  // segnava OFFLINE di continuo (prima prova sulla scheda). Ora: attesa 3 s per risposta, OFFLINE
  // solo se per 5 s non risponde niente, e Online una richiesta di stato ogni 500 ms.
  // stato del PLC: 500 ms in rete; via USB 150 ms (risposta in pochi ms, il PLC non ne risente)
  const POLL_MS   = (window.EspUsb && window.EspUsb.on()) ? 150 : 500;
  const POLL_LIVE = (window.EspUsb && window.EspUsb.on()) ? 150 : 250;   // v4.7: giro Online
  const POLL_IDLE = (window.EspUsb && window.EspUsb.on()) ? 500 : 1000;  // v4.7: giro senza Online
  const FETCH_TO  = 3000;
  const OFFLINE_AFTER = 2;                     // poll falliti di fila…
  const OFFLINE_MS    = 5000;                  // …e nessuna risposta da almeno 5 s → banner OFFLINE
  const NS_RANGE  = { I: 1023, Q: 1023, M: 1023, T: 255, SM: 5 };   // oltre 255 il compilatore usa gli indici a 16 bit
  // v4.6: bit di una parola (MW3.5): area numerica → bit per parola
  const WBIT = { MB: 8, MW: 16, MI: 16, MD: 32, MDI: 32 };
  const SM_TXT = ["primo ciclo dopo il passaggio in RUN", "sempre 1", "sempre 0", "clock 10 Hz", "clock 2 Hz", "clock 1 Hz"];
  const TIMER_KINDS = { TON: 1, TOF: 1, TP: 1 };
  const isTimerObj = t => !!t && (t.type === "Timer" || (t.kind in TIMER_KINDS));
  const TIMER_DEFAULT_PT = 1000;
  const NS_WRITE  = { Q: 1, M: 1, MB: 1, MW: 1, MI: 1, MD: 1, MDI: 1, DB: 1, L: 1 };   // aree ammesse come bobina (anche i bit di parola)
  const SVG_NS    = "http://www.w3.org/2000/svg";
  const SNAP_PX   = 6;           // trascinando: quanto fuori da una zona tratteggiata si può ancora rilasciare
  const HOLD_MS   = 4000;                      // messaggi importanti restano visibili
  const DEBUG     = new URLSearchParams(location.search).has("debug");
  const EDITOR_VERSION = "4.9.32.4";                         // versione dell'editor (VERSIONI.md)
  window.ESPPLC_EDITOR_VERSION = EDITOR_VERSION;
  const { series: mkSeries, contact: mkContact, parallel: mkParallel } = EspIR;

  // Stato del PLC: "fault" = STOP per un errore (si riparte con RUN)
  const STATE_TXT = { running: "RUN", stopped: "STOP", fault: "STOP (errore)", no_program: "NESSUN PROGRAMMA" };
  const FAULT_TEXT = {
    PLC_OK: "",
    PLC_ERR_SCAN_OVERRUN: "Scan overrun",
    PLC_ERR_INSTRUCTION_LIMIT: "Limite istruzioni",
    PLC_ERR_ARRAY_INDEX: "Indice di un array fuori dai limiti",
    PLC_ERR_INVALID_OPCODE: "Istruzione non valida (firmware da aggiornare?)",
    PLC_ERR_STACK_OVERFLOW: "Stack overflow",
    PLC_ERR_DIV_ZERO: "Divisione per zero",
    PLC_ERR_INVALID_IO_REF: "Riferimento I/O non valido",
    PLC_ERR_BYTECODE_CHECKSUM_FAIL: "CRC programma errato (o programma troppo grande per il PLC)",
    PLC_ERR_VERSION_MISMATCH: "Versione programma errata",
    PLC_ERR_NVS_LOAD_FAIL: "Caricamento da flash fallito",
    PLC_ERR_PROGRAM_TOO_LARGE: "Programma troppo grande per il PLC",
    PLC_ERR_BAD_BLOCKS: "Tabella dei blocchi non valida",
    PLC_ERR_OVERFLOW: "Overflow (risultato fuori dal campo del tipo)",
    PLC_ERR_INPUT_TIMEOUT: "Ingressi non riletti in tempo (controllo del ciclo)",
    PLC_ERR_ULINK: "uLink fault: modulo I/O perso o con la configurazione cambiata",
    PLC_ERR_IO_HW: "Tabelle I/O fatte per un'altra scheda: Tabelle I/O, Compile e Download",
  };

  // ── v3.1: numeri, confronti, fronti ───────────────────
  const NUM_NS = ["MB", "MW", "MI", "MD", "MDI", "MR"];
  const NUM_T  = { MB: "BYTE", MW: "WORD", MI: "INT", MD: "UDINT", MDI: "DINT", MR: "REAL" };
  const NUM_MAX = { MB: 256, MW: 256, MI: 256, MD: 128, MDI: 128, MR: 128 };
  // CONV: cosa si può perdere passando da un tipo all'altro (testo per il popup e il tooltip del box)
  const T_RANGE = { BYTE: [0, 255], WORD: [0, 65535], INT: [-32768, 32767], UDINT: [0, 4294967295],
                    DINT: [-2147483648, 2147483647], REAL: [-3.4e38, 3.4e38], SINT: [-128, 127] };
  const fmtInt = v => v.toLocaleString("it-IT");
  function convNotes(ti, to, k) {
    const out = [], [c, d] = T_RANGE[to], rng = t => t === "REAL" ? "−3,4·10³⁸ a +3,4·10³⁸ (con decimali)" : `${fmtInt(T_RANGE[t][0])} a ${fmtInt(T_RANGE[t][1])}`;
    const keep = "OUT resta com'era e ENO = 0 (usa ENO per accorgertene)";
    if (k !== undefined) {                                   // costante: si sa già se ci sta
      if (to !== "REAL" && (Math.round(k) < c || Math.round(k) > d))
        out.push(`⚠ ${fmtNum(k, !Number.isInteger(k))} non ci sta in ${to} (da ${rng(to)}): la conversione non si fa, ${keep}.`);
      if (to !== "REAL" && !Number.isInteger(k)) out.push("I decimali si perdono: 2,5 → 3 se arrotonda, 2,7 → 2 se tronca.");
      return out;
    }
    const [a, b] = T_RANGE[ti];
    if (to !== "REAL" && (a < c || b > d)) {
      const ex = [];
      if (a < c) ex.push(ti === "REAL" ? "−999.333,22" : fmtInt(c === 0 ? -1 : c - 1));
      if (b > d) ex.push(ti === "REAL" && d < 1e6 ? "1.000.000" : fmtInt(d + 1));
      out.push(`⚠ Si possono perdere valori: ${ti} va da ${rng(ti)}, ${to} solo da ${rng(to)}` +
               `${a < 0 && c === 0 ? " (senza segno: i negativi non ci stanno)" : ""}. ` +
               `Un valore che non ci sta (es. ${ex.join(" o ")}) NON viene convertito: niente numeri a caso, ${keep}.`);
    }
    if (ti === "REAL" && to !== "REAL") out.push("I decimali si perdono: 2,5 → 3 se arrotonda, 2,7 → 2 se tronca.");
    if (to === "REAL" && (ti === "DINT" || ti === "UDINT")) out.push("Un REAL tiene circa 7 cifre: oltre 16.777.216 le ultime cifre cambiano (16.777.217 → 16.777.216).");
    return out;
  }
  const BOX_IN = { MOVE: 1, ADD: 2, SUB: 2, MUL: 2, DIV: 2, MOD: 2, NEG: 1, ABS: 1, CONV: 1,
                   MIN: 2, MAX: 2, LIMIT: 3, SQRT: 1, SQR: 1, SCALE: 5,                         // v4.6
                   AND: 2, OR: 2, XOR: 2, INV: 1, SHL: 2, SHR: 2, ROL: 2, ROR: 2, SWAP: 1,
                   CTU: 1, CTD: 1, CTUD: 1 };                                                   // v4.9 contatori: a = PV, out = CV
  const isCounter = b => !!b && (b.box === "CTU" || b.box === "CTD" || b.box === "CTUD");
  const CNT_BITS = { CTU: ["r"], CTD: ["ld"], CTUD: ["cd", "r", "ld"] };                       // bit d'ingresso di ogni contatore
  const BOX_TXT = { MOVE: "Copia", ADD: "Somma", SUB: "Sottrazione", MUL: "Moltiplicazione", DIV: "Divisione",
                    MOD: "Resto", NEG: "Cambio segno", ABS: "Valore assoluto", CONV: "Conversione",
                    MIN: "Il minore", MAX: "Il maggiore", LIMIT: "Limite", SQRT: "Radice quadrata", SQR: "Quadrato", SCALE: "Scala lineare",
                    AND: "AND bit a bit", OR: "OR bit a bit", XOR: "XOR bit a bit", INV: "Inverti i bit", SHL: "Scorri a sinistra",
                    SHR: "Scorri a destra", ROL: "Ruota a sinistra", ROR: "Ruota a destra", SWAP: "Scambia i byte",
                    CTU: "Contatore avanti", CTD: "Contatore indietro", CTUD: "Contatore avanti e indietro" };
  const BOX_SYM = { ADD: "+", SUB: "−", MUL: "×", DIV: "/", MOD: "mod", AND: "AND", OR: "OR", XOR: "XOR", SHL: "<<", SHR: ">>", ROL: "rol", ROR: "ror" };
  // nomi degli ingressi (popup); gli altri: IN / IN1, IN2
  const BOX_PINS = { CTU: ["PV"], CTD: ["PV"], CTUD: ["PV"], LIMIT: ["MN", "IN", "MX"], SCALE: ["IN", "IN_MIN", "IN_MAX", "OUT_MIN", "OUT_MAX"], SHL: ["IN", "N"], SHR: ["IN", "N"], ROL: ["IN", "N"], ROR: ["IN", "N"] };
  const BOX_F = ["a", "b", "c", "d", "e"];
  const BOX_INT = { AND: 1, OR: 1, XOR: 1, INV: 1, SHL: 1, SHR: 1, ROL: 1, ROR: 1, SWAP: 1 };   // solo interi
  const CMP_LIST = ["==", "<>", "<", ">", "<=", ">="];
  // v4.8: campi dei DB { ns: "DB", db, f } ("Dati.Vel") e variabili dell'interfaccia della FC aperta { ns: "L", v } ("#vel")
  const isMemOp = o => !!o && (o.ns === "DB" || o.ns === "L");
  const dbOf = n => (project.dbs || []).find(d => d.number === n) || null;
  function memVar(o, blk) {
    if (!isMemOp(o)) return null;
    syncStructs();
    if (o.ns === "DB") { const d = dbOf(o.db), f = d && EspIR.memberOf(d.fields, o.f); return f ? Object.assign({ db: d }, f, o.bit != null ? { type: "BOOL", of: f.type } : {}) : null; }
    const f = ((blk || program) && (blk || program).iface) || {};
    for (const dir of EspIR.DIRS) { const v = EspIR.memberOf(f[dir] || [], o.v); if (v) return Object.assign({ dir }, v); }
    return null;
  }
  const memType = o => { const m = memVar(o); return m ? m.type : ""; };
  // v5.2: strutture del progetto in ir.js (layout, campi «nome.campo»); typeName: come si mostra un tipo
  let structsFor;
  function syncStructs(force) { if (force || structsFor !== project.structs) { EspIR.useStructs(project); structsFor = project.structs; } }
  const typeName = t => EspIR.isStruct(t) ? EspIR.structLabel(t) : t;
  // variabili «di foglia» di una lista (campi delle strutture espansi, senza quelli nascosti _…) → [{ path, v }]
  function leafVars(list, pre) {
    const out = [];
    for (const v of list || []) {
      if (v.name[0] === "_") continue;
      const path = (pre || "") + v.name, fs = EspIR.isStruct(v.type) ? EspIR.structFields(v.type) : null;
      out.push({ path, v });
      if (fs) out.push(...leafVars(fs, path + "."));
    }
    return out;
  }
  // percorso scritto dall'utente ("mot.vel", senza badare alle maiuscole) → { path con i nomi giusti, v } o null
  function findPath(list, txt) {
    let v = null, path = "", cur = list;
    for (const seg of String(txt).split(".")) {
      v = (cur || []).find(x => x.name.toLowerCase() === seg.toLowerCase());
      if (!v) return null;
      path += (path ? "." : "") + v.name;
      cur = EspIR.isStruct(v.type) ? EspIR.structFields(v.type) : null;
    }
    return v ? { path, v } : null;
  }
  // nome del DB: «SDB» (System DB) per quelli dell'hardware (scheda e dispositivi, dal 1000 in su), «DB» per quelli dell'utente
  const dbTag = n => (dbOf(n) && dbOf(n).hw ? "SDB" : "DB") + n;
  const memText = o => o.ns === "L" ? "#" + o.v : (dbOf(o.db) ? dbOf(o.db).name : "DB" + o.db) + "." + o.f + (o.bit != null ? "." + o.bit : "");
  // Indirizzo assoluto di un campo di DB come nei PLC: DB1.DBX1.3, DB1.DBB4, DB1.DBW4, DB1.DBD8 (offset nel DB)
  let dbLayCache = null, dbLayFor = null;
  const dbLay = () => { if (dbLayFor !== project.dbs || !dbLayCache) { dbLayCache = EspIR.layoutDbs(project); dbLayFor = project.dbs; } return dbLayCache; };
  function memAbs(o) {
    if (!o || o.ns !== "DB") return o ? memText(o) : "";
    const d = dbLay().dbs.get(o.db), v = d && d.vars.get(o.f);
    if (!v) return memText(o);
    if (o.bit != null) return `${dbTag(o.db)}.DBX${v.off + (o.bit >> 3)}.${o.bit & 7}`;
    if (v.type === "BOOL") return `${dbTag(o.db)}.DBX${v.off}.${v.bit}`;
    if (v.struct) return `${dbTag(o.db)}.DBB${v.off}`;            // struttura / TIMER: dal suo primo byte
    const w = EspIR.TYPE_W[v.type];
    return `${dbTag(o.db)}.DB${w === 1 ? "B" : w === 2 ? "W" : "D"}${v.off}`;
  }
  // simbolo del campo: "Dati".Campo1.3 (# per le variabili della FC)
  const memSym = o => o.ns === "L" ? "#" + o.v : `"${dbOf(o.db) ? dbOf(o.db).name : "DB" + o.db}".${o.f}${o.bit != null ? "." + o.bit : ""}`;
  // secondo le Etichette: { name, addr } (uno dei due può mancare)
  function memLabel(o) {
    if (o.ns === "L") return { addr: memSym(o) };
    const m = EspSymbols.mode();
    return m === "addr" ? { addr: memAbs(o) } : m === "sym" ? { name: memSym(o) } : { name: memSym(o), addr: memAbs(o) };
  }
  const opKey = o => !o ? "" : o.ns === "L" ? "#" + o.v : o.ns === "DB" ? `DB${o.db}.${o.f}${o.bit != null ? "." + o.bit : ""}` : o.ns + o.idx;
  const isNumVar = o => !!o && ((NUM_NS.includes(o.ns) && Number.isInteger(o.idx)) || (isMemOp(o) && !!EspIR.TYPE_T[memType(o)]));
  const numT = o => !o ? "" : isMemOp(o) ? (EspIR.baseType(memType(o)) || "?") : NUM_T[o.ns];   // tipo della VM: USINT = BYTE, TIME = DINT
  // "#nome", "Dati.Vel", "\"Dati\".Vel", "DB1.Vel" → { o, type } | { err } | null (non è un riferimento a DB o FC)
  function parseMemRef(txt) {
    const t = String(txt || "").trim();
    syncStructs();
    let m = /^#\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(t);
    if (m) {
      if (!program || program.type !== "fc") return { err: `#${m[1]}: le variabili con # ci sono solo dentro una FC` };
      const f = program.iface || {};
      for (const dir of EspIR.DIRS) { const r = findPath(f[dir] || [], m[1]); if (r) return { o: { ns: "L", v: r.path }, type: r.v.type }; }
      return { err: `#${m[1]} non è nell'interfaccia di ${EspIR.blockLabel(program)}` };
    }
    m = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\.\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:\.(\d{1,2}))?$/.exec(t);
    if (!m) return null;
    const dn = m[1] || m[2];
    const d = /^DB\d+$/i.test(dn) && dbOf(+dn.slice(2)) || (project.dbs || []).find(x => x.name.toLowerCase() === dn.toLowerCase());
    if (!d) return { err: `il DB «${U(dn)}» non esiste` };
    const fp = findPath(d.fields, m[3]), f = fp && Object.assign({}, fp.v, { name: fp.path });
    if (!f) return { err: `${d.name} non ha il campo ${m[3]}` };
    if (m[4] !== undefined) {                            // bit di un campo numerico: Merker.MW3.5
      const b = +m[4], w = (EspIR.TYPE_W[f.type] || 0) * 8;
      if (!w || b >= w) return { err: `${d.name}.${f.name}: ${f.type === "BOOL" ? "è già un BOOL" : `bit da 0 a ${w - 1}`}` };
      return { o: { ns: "DB", db: d.number, f: f.name, bit: b }, type: "BOOL" };
    }
    return { o: { ns: "DB", db: d.number, f: f.name }, type: f.type };
  }
  // operandi proponibili (campi dei DB e variabili della FC aperta) per le liste dei campi di testo
  function memOptions(want) {
    syncStructs();
    const out = [], ok = ty => want === "bool" ? ty === "BOOL" : want === "num" ? !!EspIR.TYPE_T[ty] : want === "timer" ? ty === "TIMER" : !EspIR.isStruct(ty);
    if (program && program.type === "fc") for (const dir of EspIR.DIRS) for (const { path, v } of leafVars((program.iface && program.iface[dir]) || []))
      if (ok(v.type)) out.push(`<option value="#${escapeHtml(path)}">${dir.toUpperCase()} ${typeName(v.type)}${v.comment ? " — " + U(escapeHtml(v.comment)) : ""}</option>`);
    for (const d of project.dbs || []) for (const { path, v } of leafVars(d.fields))
      if (ok(v.type)) out.push(`<option value="${escapeHtml(d.name + "." + path)}">DB${d.number} ${typeName(v.type)}${v.comment ? " — " + U(escapeHtml(v.comment)) : ""}</option>`);
    return out.join("");
  }
  const isKonst  = o => !!o && typeof o.k === "number";
  const isBoxObj = t => !!t && (t.type === "Box" || t.kind === "BOX");
  const isEdgeContact = c => !!c && c.type === "Contact" && !!c.edge;
  const areaMax = ns => NUM_MAX[ns];
  // numero come si scrive (REAL: la forma più corta che torna allo stesso float)
  function fmtNum(v, real) {
    if (typeof v !== "number" || !isFinite(v)) return String(v);
    if (!real || Number.isInteger(v)) return String(v);
    for (let p = 1; p <= 9; p++) { const c = parseFloat(v.toPrecision(p)); if (Math.fround(c) === Math.fround(v)) return String(c); }
    return String(v);
  }
  // operando nel box: simbolo (secondo le Etichette) o indirizzo; costante come numero
  function odText(o) {
    if (isKonst(o)) return fmtNum(o.k, !Number.isInteger(o.k));
    if (isMemOp(o)) { const l = memLabel(o); return l.name || l.addr; }
    if (!isNumVar(o)) return "?";
    const name = EspSymbols.nameOf(o), mode = EspSymbols.mode();
    return !name || mode === "addr" ? o.ns + o.idx : mode === "sym" ? `"${name}"` : `"${name}" ${o.ns}${o.idx}`;
  }
  let liveNum = new Map();          // "MW3" → valore (Online)
  const odVal = o => isKonst(o) ? o.k : isNumVar(o) ? liveNum.get(opKey(o)) : undefined;
  function cmpVal(c) {
    const a = odVal(c.a), b = odVal(c.b);
    if (a === undefined || b === undefined) return false;
    switch (c.cmp) { case "==": return a === b; case "<>": return a !== b; case "<": return a < b;
                     case ">": return a > b; case "<=": return a <= b; default: return a >= b; }
  }
  function boxExpr(b, val) {
    const t = val ? (o => { const v = odVal(o); return v === undefined ? "?" : fmtNum(v, isNumVar(o) ? numT(o) === "REAL" : !Number.isInteger(v)); }) : odText;
    const A = t(b.a), B = t(b.b), O = t(b.out);
    const bt = o => o ? (isMemOp(o) ? memText(o) : (EspSymbols.nameOf(o) || varKey(o))) : "";
    switch (b.box) {
      case "CTU": return `${O} ↑ ${A}` + (b.r ? `  R ${bt(b.r)}` : "");
      case "CTD": return `${O} ↓ 0` + (b.ld ? `  LD ${bt(b.ld)}` : "") + `  PV ${A}`;
      case "CTUD": return `${O} ↕ ${A}` + (b.cd ? `  CD ${bt(b.cd)}` : "") + (b.r ? `  R ${bt(b.r)}` : "") + (b.ld ? `  LD ${bt(b.ld)}` : "");
      case "MOVE": case "CONV": return `${A} → ${O}`;
      case "NEG": return `−${A} → ${O}`;
      case "ABS": return `|${A}| → ${O}`;
      case "MIN": case "MAX": return `${b.box.toLowerCase()}(${A}, ${B}) → ${O}`;
      case "LIMIT": return `${A} ≤ ${B} ≤ ${t(b.c)} → ${O}`;
      case "SQRT": return `√${A} → ${O}`;
      case "SQR": return `${A}² → ${O}`;
      case "INV": return `~${A} → ${O}`;
      case "SWAP": return `swap ${A} → ${O}`;
      case "SCALE": return `${A} ${B}..${t(b.c)} → ${t(b.d)}..${t(b.e)} → ${O}`;
      default: return `${A} ${BOX_SYM[b.box] || b.box} ${B} → ${O}`;
    }
  }
  const boxType = b => isNumVar(b.out) ? numT(b.out) : isNumVar(b.a) ? numT(b.a) : "";
  // sopra il box solo il tipo: il nome (SCALE, ADD, ==…) è già scritto dentro
  const boxTitle = b => b.box === "CONV" || b.box === "SCALE"
    ? `${isNumVar(b.a) ? numT(b.a) + " " : ""}→ ${boxType(b) || "?"}${b.trunc ? " (tronca)" : ""}` : boxType(b);
  const cmpType = c => isNumVar(c.a) ? numT(c.a) : isNumVar(c.b) ? numT(c.b) : "";
  // Primo bit libero della memoria nascosta dei fronti (area E)
  function freeEdgeIdx(also) {
    const used = new Set(also || []);
    EspIR.eachElement(project, it => {
      if (it.mem && it.mem.ns === "E") used.add(it.mem.idx);
      if (it.memD && it.memD.ns === "E") used.add(it.memD.idx);                    // v4.9: CD del contatore avanti e indietro
    });
    for (let i = 0; i < 512; i++) if (!used.has(i)) return i;
    return 0;
  }

  // ── Stato ─────────────────────────────────────────────
  // Progetto = Main + funzioni. `program` è il BLOCCO aperto nell'editor
  // (ha .segments = i suoi network); compilazione, download e undo lavorano
  // sull'intero `project`.
  let project       = EspIR.emptyProgram();
  let program       = project.blocks[0];
  let liveStatus    = null;
  let liveMemory    = null;
  const liveBits    = { I: new Uint8Array(128), Q: new Uint8Array(128), M: new Uint8Array(128), T: new Uint8Array(32), SM: new Uint8Array(1) };
  let liveTimers    = new Map();   // idx → { et, pt, q } dal PLC
  let lastBlob      = null;
  let editorDirty   = false;     // modifiche non ancora scaricate sul PLC
  let dropZones     = [];
  let lastDropTs    = 0;
  let lastLiveSig   = "";
  let lastStructSig = "";
  let liveMonitoring = false;    // toggle "Online"
  let pollFailures  = 0, lastPollOk = Date.now();
  let statusHoldUntil = 0;
  // Dove si trova ogni elemento (ricostruito a ogni render):
  //   item   → { series, index }       serie che lo contiene e posizione
  //   series → { parallel, branch }    se è un ramo di un parallelo
  //   series/coil → { rung, segIdx, rungIdx, out }
  let parentOf = new WeakMap();

  const emptyProgram     = () => EspIR.emptyProgram();
  // Pazienza USB: secondi di pagina ferma tollerati dal PLC. Prima di disegnare un programma nuovo al massimo
  // (60 s, finché non si misura), poi 5 s + 3 volte il disegno più lento degli ultimi (programmi enormi: di più)
  const paintMs = [];
  function bracePaint() { return window.EspUsb && EspUsb.setPatience ? EspUsb.setPatience(60) : Promise.resolve(); }
  function notePaint(ms) {
    paintMs.push(ms); if (paintMs.length > 10) paintMs.shift();
    if (window.EspUsb && EspUsb.setPatience) EspUsb.setPatience(5 + 3 * Math.max(...paintMs) / 1000);
  }
  function setProject(p, keepBlock) {
    const cur = program && program.id;
    project = EspIR.migrate(p);
    // v4.8: MB, MW, MI, MD, MDI, MR non ci sono più: diventano campi di un DB «Merker» (nomi e commenti dai simboli)
    const cv = EspIR.convertAreas(project, k => EspSymbols.get(k));
    if (cv) setTimeout(() => setStatusLine(`${cv.count} variabili numeriche (MW, MR, …) spostate nel DB${cv.db} «${U(cv.name)}»: Compile + Download per caricarlo`, "warn"), 0);
    program = (keepBlock && project.blocks.find(b => b.id === cur)) || project.blocks[0];
    EspIR.setFcMode(project.settings && project.settings.fcMode);   // impostazioni del programma: FC per numero o per nome
    netBlocks = [];
    if (typeof renderBlocks === "function") renderBlocks();
  }
  const allSegments = () => project.blocks.flatMap(b => b.segments.map((sg, n) => ({ sg, n, b })));
  const normalizeProgram = p => EspIR.migrate(p);

  // ── Modal di conferma ────────────────────────────────
  function confirmAction(title, body, okLabel = "OK") {
    return confirmModal(title, body, okLabel, null).then(v => v === "ok");
  }
  // Ritorna "ok" | "alt" | "cancel"
  function confirmModal(title, body, okLabel, altLabel) {
    return new Promise(resolve => {
      const m = document.getElementById("confirm-modal");
      document.getElementById("confirm-title").textContent = title;
      document.getElementById("confirm-body").textContent  = body;
      const ok = document.getElementById("confirm-ok");
      const alt = document.getElementById("confirm-alt");
      const cn = document.getElementById("confirm-cancel");
      ok.textContent = okLabel;
      if (altLabel) { alt.textContent = altLabel; alt.classList.remove("hidden"); }
      else alt.classList.add("hidden");
      const done = v => { m.classList.add("hidden"); ok.onclick = alt.onclick = cn.onclick = null; resolve(v); };
      ok.onclick = () => done("ok");
      alt.onclick = () => done("alt");
      cn.onclick = () => done("cancel");
      m.classList.remove("hidden");
    });
  }

  // configurazione hardware di un modulo I/O cambiata (CRC del file della scheda diverso da quello abbinato, «hwb» nel
  // frame leggero): un avviso per ogni cambio
  let hwSeen = 0;
  async function hwCheck(s) {
    const m = s.g ? s.g.hwb | 0 : 0;
    if (m === hwSeen) return;
    hwSeen = m;
    if (!m) return;
    let who = "";
    try { const j = await fetchJson("/api/bus"); who = (j.modules || []).filter(x => x.cfg_bad).map(x => `${x.name || "id " + x.station}: era ${x.crc}, ora ${x.dev_crc}`).join(" · "); } catch (e) {}
    const r = await confirmModal("Configurazione hardware cambiata",
      `Il file della scheda di un modulo I/O è diverso da quello abbinato (${who || "moduli " + m.toString(2)}). I suoi ingressi e le sue uscite restano fermi finché non rileggi la configurazione (Diagnostica, Avanzato, Moduli I/O, «Leggi dal modulo») e controlli le tabelle I/O.`,
      "Apri la Diagnostica");
    if (r === "ok") openDiag("card-bus");
  }

  function dropDedup() {
    const now = performance.now();
    if (now - lastDropTs < 100) return true;
    lastDropTs = now;
    return false;
  }

  const varKey = op => !op ? "" : isMemOp(op) ? opKey(op) : `${op.ns}${op.idx}${op.bit != null ? "." + op.bit : ""}`;
  const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Fetch / codifiche ────────────────────────────────
  // Il PLC ha risposto (a qualsiasi richiesta): via OFFLINE subito. Durante un Download il giro di lettura è
  // fermo e il banner restava acceso mentre il PLC rispondeva (si caricava "offline")
  function plcAnswered() {
    pollFailures = 0; lastPollOk = Date.now();
    document.getElementById("offline-banner").classList.add("hidden");
    if (document.getElementById("badge-state").textContent === "OFFLINE" && liveStatus) showState(liveStatus);
  }
  async function fetchJson(path, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || FETCH_TO);
    try {
      const r = await fetch(path, { signal: ctl.signal });
      plcAnswered();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  // POST con tempo massimo (default 15 s): il PLC che non risponde non blocca l'editor
  // Download: il PLC scrive in flash ogni blocco (con 100 FC qualche secondo, anche con il PLC in RUN)
  const DL_TIMEOUT = 60000;
  async function postJson(path, opts = {}, timeoutMs = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(path, Object.assign({ method: "POST", signal: ctl.signal }, opts));
      plcAnswered();
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    } catch (e) {
      throw e.name === "AbortError" ? new Error("il PLC non risponde") : e;
    } finally { clearTimeout(t); }
  }

  // Diagnostica: finestra grande dentro l'editor (diag.js), con ogni collegamento
  const diagOpen = () => !!(window.EspDiag && EspDiag.isOpen());
  function openDiag(card) { if (window.EspDiag) EspDiag.open(card); }
  // POST del Download con l'avanzamento dell'invio (XMLHttpRequest: fetch non dice quanto ha mandato).
  // onProg(inviati, totale), onSent() = tutto inviato, ora lavora il PLC. Col PLC simulato (fetch
  // intercettato) si usa fetch e l'invio risulta subito completo.
  function postProgress(path, body, contentType, timeoutMs, onProg, onSent) {
    if (window.EspUsb && EspUsb.on()) return EspUsb.post(path, body, contentType, timeoutMs, onProg, onSent);   // USB: pacchetti
    if (window.__mockPlc || typeof XMLHttpRequest === "undefined") {
      const len = body && (body.length || body.size) || 1;
      onProg && onProg(len, len); onSent && onSent();
      return postJson(path, Object.assign({ body }, contentType ? { headers: { "Content-Type": contentType } } : {}), timeoutMs);
    }
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", path);
      x.timeout = timeoutMs;
      if (contentType) x.setRequestHeader("Content-Type", contentType);
      x.upload.onprogress = e => { if (e.lengthComputable && onProg) onProg(e.loaded, e.total); };
      x.upload.onload = () => { onSent && onSent(); };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, j }); };
      x.onerror = () => reject(new Error("errore di rete"));
      x.ontimeout = () => reject(new Error("il PLC non risponde"));
      x.send(body);
    });
  }
  // Finestra del Download: blocchi, invio in %, installazione (secondi), esito
  // Barra unica e continua: invio 0–45 %, installazione 45–100 % per fasi (il PLC dice fase e millesimi).
  // La barra segue l'obiettivo con un movimento morbido e, tra un aggiornamento e l'altro, avanza piano
  // verso la fine della fase in corso (senza raggiungerla): niente salti né fermi.
  const DL_SEND = 0.45;
  // ordine del PLC: controllo del Download, flash (blocchi), controllo del programma, memoria (RAM dalla flash), scambio, pulizia
  const DL_PH = { 1: [0.45, 0.6, "controllo"], 3: [0.6, 0.85, "flash"], 2: [0.85, 0.9, "memoria"], 4: [0.9, 0.92, "scambio"],
                  5: [0.92, 0.99, "pulizia"], 6: [0.99, 0.995, "fine"] };
  // Debug (Diagnostica → Debug, solo in questo browser): RAM per fase nella finestra del Download, RAM e IRAM sotto le barre
  const dbgOn = () => { try { return localStorage.getItem("espplc.debug") === "1"; } catch (e) { return false; } };
  const kbd = b => (b / 1024).toFixed(1).replace(".", ",");
  const DL_PHN = ["ricezione", "controllo", "memoria", "flash", "scambio", "pulizia", "fine"];
  async function dlDebug() {                             // fasi dell'ultimo Download: RAM, blocco più grande e IRAM minimi
    const el = document.getElementById("dl-dbg");
    el.classList.toggle("hidden", !dbgOn());
    if (!dbgOn()) return;
    el.textContent = "debug: lettura…";
    let m; try { m = await fetchJson("/api/plc/memory", 3000); } catch (e) { el.textContent = "debug: PLC non raggiungibile"; return; }
    const d = m.dbg;
    if (!d || !d.dl) { el.textContent = "debug: il firmware non dà le fasi del Download"; return; }
    el.innerHTML = `<b>Debug: minimi per fase</b><table><tr><th>fase</th><th>RAM KB</th><th>blocco KB</th><th>IRAM KB</th></tr>` +
      [0, 1, 3, 2, 4, 5, 6].map(i => { const x = d.dl[i];                      // nell'ordine del PLC: la flash prima della memoria
        return x ? `<tr><td>${DL_PHN[i]}</td><td>${kbd(x[0])}</td><td>${kbd(x[1])}</td><td>${kbd(x[2])}</td></tr>` : ""; }).join("") + `</table>` +
      (d.heap !== undefined ? `<div>adesso: RAM ${kbd(d.heap)} KB (minima dall'avvio ${kbd(d.heap_min)} KB), blocco ${kbd(d.block)} KB, IRAM ${kbd(d.iram)} KB</div>` : "");
  }
  const DL = (() => {
    const $ = id => document.getElementById(id);
    let timer = 0, t0 = 0, finished = true;
    let target = 0, shown = 0, limit = 0, raf = 0, phaseName = "";
    const draw = () => {
      raf = 0;
      if (target > shown) shown += Math.max(0.0008, (target - shown) * 0.12);   // segue l'obiettivo, morbida
      if (shown > target || (finished && target - shown < 0.0005)) shown = target;   // a fine Download arriva al 100 %
      if (limit > target) target += (limit - target) * 0.006;                   // avanza piano nella fase
      $("dl-bar").style.width = (shown * 100).toFixed(2) + "%";
      $("dl-pct").textContent = Math.floor(shown * 100) + " %";
      if (!finished || shown < target) raf = requestAnimationFrame(draw);
    };
    const go = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const aim = (t, lim) => { target = Math.max(target, t); limit = Math.max(target, lim === undefined ? target : lim); go(); };
    const step = (n, cls) => { const e = $("dl-s" + n); e.className = cls || ""; };
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    return {
      open(title, intro, names) {
        finished = false;
        $("dl-title").textContent = title;
        $("dl-what").innerHTML = `<span class="muted">${esc(intro)}</span>` + names.slice(0, 60).map(n => `<span class="blk">${esc(n)}</span>`).join("") +
          (names.length > 60 ? `<span class="muted">… e altri ${names.length - 60}</span>` : "");
        $("dl-close").disabled = true;
        $("dl-close").onclick = () => $("dl-modal").classList.add("hidden");
        $("dl-modal").classList.remove("passive");
        $("dl-result").textContent = "Esito";
        $("dl-dbg").classList.add("hidden");
        step(1); step(2); step(3);
        $("dl-modal").classList.remove("hidden");
      },
      send(total) {                                   // (anche di nuovo: download completo dopo un rifiuto)
        clearInterval(timer);
        step(1, "run"); step(2); $("dl-time").textContent = "";
        target = shown = limit = 0; phaseName = ""; go();
        $("dl-bytes").textContent = total ? `0 / ${total} B` : "";
      },
      progress(l, t) {
        const f = Math.min(1, l / (t || 1));
        aim(DL_SEND * f, DL_SEND * Math.min(1, f + 0.08));   // un pezzo per volta: avanza verso il prossimo
        $("dl-bytes").textContent = `${l} / ${t} B`;
      },
      installing() {
        step(1, "ok"); step(2, "run");
        aim(DL_SEND, DL_PH[1][1]);
        t0 = Date.now(); clearInterval(timer);
        const tick = () => { $("dl-time").textContent = (phaseName ? phaseName + " · " : "") + `${((Date.now() - t0) / 1000).toFixed(1)} s`; };
        tick(); timer = setInterval(tick, 100);
      },
      installStep(ph, pm) {                            // dal PLC: fase 1..6 e millesimi
        const r = DL_PH[ph];
        if (!r) return;
        phaseName = r[2];
        aim(r[0] + (r[1] - r[0]) * Math.min(1, (pm || 0) / 1000), r[1]);
      },
      finish(ok, msg) {
        if (finished) return;
        finished = true; clearInterval(timer);
        if (ok) { target = limit = 1; go(); }
        if ($("dl-s2").className === "run") step(2, ok ? "ok" : "err");
        else if ($("dl-s1").className === "run") step(1, "err");
        step(3, ok ? "ok" : "err"); $("dl-result").textContent = msg || (ok ? "fatto" : "non riuscito");
        $("dl-close").disabled = false;
        $("dl-modal").classList.add("passive");         // finito: l'editor si usa subito (la finestra non blocca più)
        if (dbgOn()) dlDebug();                         // debug: la finestra resta aperta con le fasi
        else if (ok) setTimeout(() => { if (finished) $("dl-modal").classList.add("hidden"); }, 2500);
      },
    };
  })();

  // live=true → messaggio del monitor, non sovrascrive un messaggio recente.
  let lastStatusMsg = "";
  function setStatusLine(msg, kind, live) {
    if (live && performance.now() < statusHoldUntil) return;
    if (!live) { statusHoldUntil = performance.now() + HOLD_MS; lastStatusMsg = msg; }
    const el = document.getElementById("status");
    el.textContent = msg;
    el.title = msg;
    el.className = kind || "muted";
    if (DEBUG) console.log("[EspPlc:status]", kind || "", msg);
  }

  function b64decode(s) {
    if (!s) return new Uint8Array(0);
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  // FC eseguite nell'ultima scansione (vedi liveFcExec): Set dei numeri di FC, null = sconosciuto
  function fcExecSet(s) {
    if (typeof s.fc_exec_b64 === "string") {
      const b = b64decode(s.fc_exec_b64), set = new Set();
      for (let i = 0; i < b.length; i++)
        if (b[i]) for (let k = 0; k < 8; k++) if (b[i] & (1 << k)) set.add(i * 8 + k);
      return set;
    }
    return Array.isArray(s.fc_exec) ? new Set(s.fc_exec) : null;
  }
  function u8ToBase64(u8) {
    if (!u8 || !u8.length) return "";
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function hexToBytes(hex) {
    if (!hex) return new Uint8Array(0);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  // v3: sorgente a blocchi (testata del progetto + un gzip per blocco) → progetto; null se illeggibile
  const srcToProject = u8 => EspBlocks.sourceToProject(u8);

  // ── Valutazione live ─────────────────────────────────
  function readBit(op) {
    if (!liveStatus || !op) return false;
    if (isMemOp(op) && op.bit != null) { const v = liveNum.get(`DB${op.db}.${op.f}`); return v !== undefined && ((Number(v) >>> op.bit) & 1) === 1; }
    if (isMemOp(op)) return !!liveNum.get(opKey(op));                                                                         // v4.8: BOOL di un DB
    if (op.bit != null) { const v = liveNum.get(op.ns + op.idx); return v !== undefined && ((Number(v) >>> op.bit) & 1) === 1; }   // bit di parola
    if (!liveBits[op.ns]) return false;
    const a = liveBits[op.ns];
    return !!(a[op.idx >> 3] & (1 << (op.idx & 7)));
  }
  const contactVal = c => c.edge ? false : readBit(c.op) !== !!c.negated;   // fronte: impulso di una scansione
  // Funzioni eseguite nell'ultima scansione: status.fc_exec_b64 (un bit per FC, FC0..FC1023,
  // bit n = FCn) oppure status.fc_exec (numeri delle FC). Senza nessuno dei due: null = sconosciuto,
  // tutto viene mostrato.
  let liveFcExec = null;          // Set di numeri di FC, o null
  let liveFcEno = null;           // v4.8: FC con ENO = 1 nell'ultima chiamata (Set), null = non si sa
  const fcEnoOn = n => !liveFcEno || liveFcEno.has(n);
  function blockExecuted(b) {
    if (!b || b.type === "main") return true;
    if (b.type === "startup") return false;          // gira una volta sola (pochi µs): Online resta grigio, con ora e durata
    if (!liveStatus || liveStatus.state !== "running") return false;
    if (!liveFcExec) return true;
    return liveFcExec.has(b.number);
  }
  // ── Online / Offline per blocco (v3): CRC di ogni blocco, editor e PLC ──
  let editorBlk = null;           // Map "main:0"/"fc:N" → { crc, scrc } dell'editor (null = non compila)
  let plcBlk = null, plcBlkFor = null, plcBlkRaw = null;   // idem dal PLC (/api/plc/blocks), per CRC del programma
  const bkey = b => EspBlocks.blkKey(b.type, b.number);
  async function refreshPlcBlocks(force) {
    const s = liveStatus;
    const want = s && s.crc32 !== undefined ? s.crc32 >>> 0 : null;
    if (!force && want === plcBlkFor) return;
    plcBlkFor = want;
    plcBlk = null; plcBlkRaw = null;                 // finché non arriva la tabella nuova: "non si sa" (niente valori live sbagliati)
    if (want === null) return;
    try { plcBlkRaw = await fetchJson("/api/plc/blocks", 4000); plcBlk = EspBlocks.plcBlockMap(plcBlkRaw); }
    catch (e) { plcBlk = null; plcBlkRaw = null; plcBlkFor = null; }
    updateExecDots(); updateSync();
  }
  // Blocco uguale sul PLC? true / false / null (non si sa)
  function blockSame(b) {
    if (!b || !editorBlk || !plcBlk || devTab) return null;     // scheda di un modulo: il confronto col PLC non vale
    const e = editorBlk.get(bkey(b)), p = plcBlk.get(bkey(b));
    if (!(e && p && e.crc === p.crc)) return false;
    for (const [k, x] of editorBlk) if (x.partOf === b.id) { const q = plcBlk.get(k); if (!q || q.crc !== x.crc) return false; }   // pezzi
    return true;
  }
  // il blocco a video è cambiato: esce da Online solo lui (gli altri blocchi uguali al PLC continuano a mostrare i valori)
  function dropEditorBlk() { if (editorBlk && program) { editorBlk = new Map(editorBlk); editorBlk.delete(bkey(program)); } editorBc = null; }
  const programSame = () => editorBc !== null && liveStatus && liveStatus.bc_crc32 !== undefined && editorBc === (liveStatus.bc_crc32 >>> 0);
  const blockLiveOk = b => programSame() || blockSame(b) === true;
  const showLive   = () => !!(liveMonitoring && liveStatus && blockLiveOk(program) && blockExecuted(program));
  const liveActive = () => showLive() && liveStatus.state === "running";

  // ── Layout ───────────────────────────────────────────
  // Ogni elemento ha a sinistra 20 px di filo ("lead"): lì stanno le zone
  // di inserimento, così zone di livelli diversi non si sovrappongono.
  // Misure lette dalle impostazioni grafiche (view.js, finestra "⚙ Grafica").
  const RAIL_L = 40;
  let LEAD, BOX_W, BOX_H, ROW_H, PAR_TAIL, EMPTY_W, COIL_W, COIL_AREA, ZONE_H, TOP_PAD, LABEL_DY, SYM_DY, TMR_W, LABEL_SIZE, SYM_LINE;
  let NAME_LINES = 1;            // righe del nome più lungo del blocco a video (nomi a capo prima del punto)
  function applyGeometry() {
    const v = EspView.get();
    LEAD = v.lead; BOX_W = v.contactW; BOX_H = v.contactH; PAR_TAIL = v.parTail; COIL_W = v.coilW;
    // "Simbolo + indirizzo": il nome sta su una riga in più sopra l'indirizzo
    SYM_LINE = (EspSymbols.mode() === "both" && (EspSymbols.named() > 0 || (project && (project.dbs || []).length))) ? v.labelSize + 3 : 0;
    const nameX = (NAME_LINES - 1) * (v.labelSize + 3);      // righe in più dei nomi lunghi
    ROW_H = Math.max(v.rowH, BOX_H + Math.ceil(v.labelSize * 1.3) + 14 + SYM_LINE + nameX);   // le righe non si sovrappongono mai
    EMPTY_W = Math.max(44, LEAD * 2);
    TMR_W = Math.max(v.timerW, BOX_W);                       // box timer
    LABEL_SIZE = v.labelSize;
    COIL_AREA = Math.max(COIL_W, TMR_W) + 70;                // filo + bobina/timer + barra destra
    ZONE_H = BOX_H + 8;                                      // altezza zone di rilascio
    LABEL_DY = BOX_H / 2 + 4 + Math.ceil(v.labelSize * 0.25); // indirizzo sopra il riquadro (con le "gambe" delle lettere)
    TOP_PAD = LABEL_DY + v.labelSize + 8 + SYM_LINE + nameX; // spazio sopra la prima riga di un rung
    SYM_DY = v.symSize * 0.38;
  }
  applyGeometry();
  const measureCache = new WeakMap();
  // ── Larghezze dal testo: indirizzi e nomi simbolici si vedono SEMPRE interi ──
  // Ogni elemento è largo quanto serve alla sua etichetta (minimo la misura standard).
  let measSvg = null;
  const twCache = new Map();
  function tw(str, cls, fsPx) {
    const key = cls + "|" + (fsPx || LABEL_SIZE) + "|" + str;
    if (twCache.has(key)) return twCache.get(key);
    if (!measSvg) {
      measSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      measSvg.setAttribute("style", "position:absolute;left:-9999px;top:-9999px;width:10px;height:10px;visibility:hidden");
      document.body.appendChild(measSvg);
    }
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("class", cls); if (fsPx) t.style.fontSize = fsPx + "px";
    t.textContent = str; measSvg.appendChild(t);
    const w = t.getComputedTextLength ? t.getComputedTextLength() : str.length * (fsPx || LABEL_SIZE) * 0.6;
    measSvg.removeChild(t);
    if (twCache.size > 4000) twCache.clear();
    twCache.set(key, w);
    return w;
  }
  // larghezza dell'etichetta di un operando (indirizzo e/o "nome")
  function labelW(op) {
    if (!op) return 0;
    const nw = s => Math.max(...nameLines(s).map(r => tw(r, "elt-label symname")));
    if (isMemOp(op)) { const l = memLabel(op); return Math.max(l.name ? nw(l.name) : 0, l.addr ? tw(l.addr, l.name ? "elt-label addr2" : "elt-label") : 0); }
    const addr = varKey(op), name = EspSymbols.nameOf(op), mode = EspSymbols.mode();
    if (!name || mode === "addr") return tw(addr, "elt-label");
    if (mode === "sym") return nw(`"${name}"`);
    return Math.max(nw(`"${name}"`), tw(addr, "elt-label addr2"));
  }
  // Nome lungo a capo prima del punto (fuori dagli apici), righe riempite fino a «Caratteri per riga»
  // (Grafica → Ladder → Nomi lunghi): "DbDatiProd".valore.cassa.ok con 15 → "DbDatiProd" / .valore.cassa / .ok.
  // Oltre «Righe al massimo» il resto va intero sull'ultima riga: mai tagliato
  function nameLines(s) {
    const v = EspView.get(), max = v.nameChars || 20, nl = v.nameLines || 3;
    if (!s || s.length <= max) return [s];
    const parts = [];
    let q = false, cur = "";
    for (const ch of s) {
      if (ch === "." && !q && cur) { parts.push(cur); cur = ""; }
      if (ch === '"') q = !q;
      cur += ch;
    }
    parts.push(cur);
    const out = [];
    for (const p of parts) {
      if (out.length && out[out.length - 1].length + p.length <= max) out[out.length - 1] += p; else out.push(p);
    }
    while (out.length > nl) { const r = out.pop(); out[out.length - 1] += r; }
    return out;
  }
  // nome mostrato sopra un elemento ("" = solo l'indirizzo)
  function opName(op) {
    if (!op) return "";
    if (isMemOp(op)) return memLabel(op).name || "";
    const name = EspSymbols.nameOf(op);
    return name && EspSymbols.mode() !== "addr" ? `"${name}"` : "";
  }
  // righe del nome più lungo nel blocco a video: se cambiano, cambia lo spazio sopra le righe del ladder
  function updateNameLines() {
    let n = 1;
    if (program) EspIR.eachElement({ blocks: [program] }, it => { if (it.op) n = Math.max(n, nameLines(opName(it.op)).length); });
    // riga del simbolo: dipende anche dai DB del progetto (la HWDB creata dopo l'apertura: nome e indirizzo uno sopra l'altro)
    const symOn = EspSymbols.mode() === "both" && (EspSymbols.named() > 0 || !!(project && (project.dbs || []).length));
    if (n !== NAME_LINES || symOn !== (SYM_LINE > 0)) { NAME_LINES = n; applyGeometry(); }
  }
  const exprFs = () => Math.max(8, Math.round(LABEL_SIZE * 0.95));
  // larghezza del riquadro di un elemento (senza il filo "lead" a sinistra); funziona
  // sia in linea (type) sia come elemento finale (kind)
  function eltW(n) {
    const T = n.type || (n.kind === "CALL" ? "Call" : n.kind === "BOX" ? "Box" : (n.kind === "TON" || n.kind === "TOF" || n.kind === "TP") ? "Timer" : "Coil");
    switch (T) {
      case "Contact": return Math.max(BOX_W, Math.ceil(labelW(n.op)) + 10);
      case "Trig":    return BOX_W;
      case "Not":     return BOX_W;
      case "Slot":    return BOX_W;
      case "Timer":   return Math.max(TMR_W, Math.ceil(labelW(n.op)) + 10);
      case "Call": {
        const fb = project.blocks.find(b => b.type === "fc" && b.number === n.fc);
        const lab = fb ? (fb.name && fb.name !== "FC" + fb.number ? fb.name : "FC" + fb.number) : "FC" + n.fc + " mancante";
        const g = callGeom(n);
        return Math.max(TMR_W, Math.ceil(tw(lab, "elt-label")) + 10, g ? g.w : 0);
      }
      case "Compare":
        return Math.max(boxGeom(n).w, Math.ceil(tw(cmpType(n), "elt-label")) + 8);
      case "Box":
        return Math.max(boxGeom(n).w, Math.ceil(tw(boxTitle(n), "elt-label")) + 8);
      default: return COIL_W;
    }
  }
  function measure(node) {
    if (measureCache.has(node)) return measureCache.get(node);
    let m;
    if (node.type === "Contact" || node.type === "Timer" || node.type === "Call" || node.type === "Box" ||
        node.type === "Compare" || node.type === "Trig" || node.type === "Not" || node.type === "Slot")
      m = { w: LEAD + eltW(node), h: node.type === "Call" ? callRowsN(node) : node.type === "Box" || node.type === "Compare" ? boxRowsN(node) : 1 };
    else if (node.type === "Parallel") {
      const bs = node.branches.map(measure), cols = parCols(node);
      const bw = node.branches.map(b => b.items.length ? b.items.reduce((s, it, i) => s + cols[i], 0) : EMPTY_W);
      m = { w: LEAD + Math.max(...bw) + PAR_TAIL, h: bs.reduce((s, b) => s + b.h, 0) };
    } else if (node.type === "Open") {
      m = { w: 0, h: 1 };                       // ramo aperto: sulla linea non occupa niente (la serie lo misura sotto)
    } else {                                   // Series
      if (!node.items.length) m = { w: EMPTY_W, h: 1 };
      else {
        const ms = node.items.map(measure);
        m = { w: ms.reduce((s, x) => s + x.w, 0), h: Math.max(...ms.map(x => x.h)) };
        node.items.forEach((it, i) => {         // ramo aperto: sotto gli elementi dopo di lui, freccia in fondo
          if (it.type !== "Open") return;
          const rest = ms.slice(i + 1), restW = rest.reduce((s, x) => s + x.w, 0), row = Math.max(1, ...rest.map(x => x.h));
          const b = measure(it.branch);
          openRow.set(it, row);
          m.w += Math.max(0, b.w + OPEN_ARROW - restW);
          m.h = Math.max(m.h, row + b.h);
        });
      }
    }
    measureCache.set(node, m);
    return m;
  }
  // Parallelo: colonne allineate fra i rami (l'elemento i di ogni ramo nella stessa colonna, larga quanto il più largo)
  function parCols(p) {
    const n = Math.max(0, ...p.branches.map(b => b.items.length)), cols = [];
    for (let i = 0; i < n; i++) cols.push(Math.max(...p.branches.map(b => b.items[i] ? measure(b.items[i]).w : 0)));
    return cols;
  }
  const openRow = new WeakMap(), OPEN_END = 24, OPEN_ARROW = 34 + OPEN_END;   // riga del ramo aperto, zona in fondo + freccia
  function clearMeasure(node) {
    if (!node) return;
    measureCache.delete(node);
    if (node.type === "Open") { clearMeasure(node.branch); return; }
    if (node.type === "Parallel") node.branches.forEach(clearMeasure);
    else if (node.type === "Series") node.items.forEach(clearMeasure);
  }

  // ── Progetto: nome e ID, Annulla/Ripeti, bozza automatica ──
  // plcJson = il progetto come è sul PLC (o null): serve a sapere se l'editor
  // è diverso dal PLC anche dopo Annulla/Ripeti.
  let hist = [], histIdx = -1, plcJson = null;
  const projJson = () => EspIR.toJSON(project);
  const blkOf = n => netBlocks[n] || {};
  function hasFresh(p) { let f = false; JSON.stringify(p, (k, v) => { if (k === "_fresh" && v) f = true; return v; }); return f; }
  const histDepth = () => Math.max(10, (EspView.get().undoDepth | 0) || 100);
  function resetHistory() { hist = [{ json: projJson(), block: program.id }]; histIdx = 0; updateUndoBtns(); scheduleBc(); }
  function pushHistory() {
    if (hasFresh(project)) return;                  // elemento appena inserito, popup ancora aperto
    const json = projJson();
    if (hist[histIdx] && hist[histIdx].json === json) return;
    hist = hist.slice(0, histIdx + 1);
    hist.push({ json, block: program.id });
    const d = histDepth();
    if (hist.length > d + 1) hist.splice(0, hist.length - d - 1);
    histIdx = hist.length - 1;
    updateUndoBtns();
    saveDraftSoon();
    scheduleBc();
  }
  function applyHistory(i, focusBlock) {
    closeMenus();
    histIdx = i;
    const h = hist[i];
    project = JSON.parse(h.json);
    program = project.blocks.find(b => b.id === focusBlock) || project.blocks.find(b => b.id === (program && program.id)) || project.blocks[0];
    netBlocks = [];
    editorDirty = h.json !== plcJson;
    lastBlob = null;
    document.getElementById("btn-download").disabled = false;   // il Download compila da solo
    markStructChanged();
    if (liveMonitoring) dropEditorBlk();                 // Online resta: il blocco si riconfronta col PLC dopo la compilazione
    if (symPageOpen) closeSymPage();
    if (dbPage != null) { if (dbOf(dbPage)) renderDbPage(); else closeDbPage(); }
    if (modPage) renderModPage();
    renderBlocks(); render(); updateUndoBtns(); saveDraftSoon(); scheduleBc();
  }
  const pickerOpen = () => !document.getElementById("picker").classList.contains("hidden");
  // La modifica da annullare/ripetere è in un altro blocco? Prima si chiede.
  // → id del blocco da mostrare, oppure null = lascia stare
  let histAsking = false;
  async function askHistBlock(blockId, verb) {
    if (!blockId || blockId === program.id || !project.blocks.some(b => b.id === blockId)) return program.id;
    const b = project.blocks.find(x => x.id === blockId);
    histAsking = true;
    // Ci si sposta sempre nel blocco della modifica: così si vede dove avviene.
    const ok = await confirmAction(`${verb}: la modifica è in ${EspIR.blockLabel(b)}`,
      `La modifica da ${verb.toLowerCase() === "annulla" ? "annullare" : "ripetere"} è in ${EspIR.blockLabel(b)}, ` +
      `non nel blocco aperto (${EspIR.blockLabel(program)}).`,
      `Vai in ${EspIR.blockLabel(b)} e ${verb.toLowerCase()}`);
    histAsking = false;
    return ok ? blockId : null;
  }
  async function undo() {
    if (pickerOpen() || histAsking) return;
    if (histIdx <= 0) { setStatusLine("niente da annullare", "muted"); return; }
    const where = await askHistBlock(hist[histIdx].block, "Annulla");
    if (!where) { setStatusLine("annulla: niente di fatto"); return; }
    applyHistory(histIdx - 1, where);
    setStatusLine(`annullato — ancora ${histIdx} ${histIdx === 1 ? "passo" : "passi"} indietro, ${hist.length - 1 - histIdx} avanti (Ctrl+Y)`);
  }
  async function redo() {
    if (pickerOpen() || histAsking) return;
    if (histIdx >= hist.length - 1) { setStatusLine("niente da ripetere", "muted"); return; }
    const where = await askHistBlock(hist[histIdx + 1].block, "Ripeti");
    if (!where) { setStatusLine("ripeti: niente di fatto"); return; }
    applyHistory(histIdx + 1, where);
    setStatusLine(`ripetuto — ancora ${hist.length - 1 - histIdx} avanti`);
  }
  function updateUndoBtns() {
    const u = document.getElementById("btn-undo"), r = document.getElementById("btn-redo");
    if (!u) return;
    u.disabled = histIdx <= 0; r.disabled = histIdx >= hist.length - 1;
    u.title = `Annulla (Ctrl+Z) — ${Math.max(0, histIdx)} passi disponibili, max ${histDepth()} (⚙ Grafica → Editor)`;
    r.title = `Ripeti (Ctrl+Y) — ${Math.max(0, hist.length - 1 - histIdx)} passi`;
  }
  // Bozza: ogni modifica non scaricata sul PLC resta nel browser; alla
  // riapertura dell'editor si può riprendere.
  const DRAFT_KEY = "espplc.draft";
  let draftTimer = 0;
  function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 600); }
  // La bozza è di una scheda (sid): un secondo editor aperto nel browser non cancella né
  // sovrascrive quella di un altro (la cancella solo chi l'ha scritta, o chi sceglie «Scarta»).
  function draftOwner() { try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); return d ? d.sid || null : undefined; } catch (e) { return null; } }
  // la scheda che ha la bozza dice "ci sono" ogni 2 s: una bozza di una scheda chiusa non blocca le altre
  const ALIVE_KEY = "espplc.draft.alive";
  // 90 s: una scheda in secondo piano il browser la sveglia anche solo una volta al minuto; chiudendo la
  // scheda la bozza si libera subito (pagehide)
  function ownerAlive(sid) { try { const a = JSON.parse(localStorage.getItem(ALIVE_KEY) || "null"); return !!a && a.sid === sid && Date.now() - a.t < 90000; } catch (e) { return false; } }
  let leaving = false;                                   // pagehide arriva prima di visibilitychange: non riscrivere
  const aliveBeat = () => { if (draftMine && editorDirty && !leaving) try { localStorage.setItem(ALIVE_KEY, JSON.stringify({ sid: SID, t: Date.now() })); } catch (e) {} };
  setInterval(aliveBeat, 2000);
  document.addEventListener("visibilitychange", aliveBeat);
  window.addEventListener("pageshow", () => { leaving = false; });
  window.addEventListener("pagehide", () => { leaving = true; try { const a = JSON.parse(localStorage.getItem(ALIVE_KEY) || "null"); if (a && a.sid === SID) localStorage.removeItem(ALIVE_KEY); } catch (e) {} });
  function saveDraft() {
    if (devTab) return;                                    // programma di un modulo: niente bozza al posto di quella del PLC
    try {
      const o = draftOwner();
      // niente da salvare: progetto uguale al PLC, o diverso solo per quello che l'editor ha fatto da solo (HWDB
      // automatica): se no, scartata la bozza, l'editor la rifaceva e la richiedeva a ogni avvio (Denys 01-11-2026)
      if (!editorDirty || (autoJson && projJson() === autoJson)) { if (o === SID) localStorage.removeItem(DRAFT_KEY); return; }
      if (o && o !== SID && !draftMine && ownerAlive(o)) return;    // bozza di un'altra scheda aperta: non si tocca
      draftMine = true;
      localStorage.setItem(ALIVE_KEY, JSON.stringify({ sid: SID, t: Date.now() }));
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ sid: SID, saved: Date.now(), block: program.id, json: projJson() }));
    } catch (e) {}
  }
  let draftMine = false;
  let autoJson = null;                                  // progetto subito dopo le modifiche automatiche (HWDB): non è una bozza
  // modifiche fatte da chi usa l'editor: un progetto appena aperto (baseJson) o con la sola HWDB creata da sola (autoJson)
  // è diverso dal PLC ma non ha niente da perdere, quindi Apri, Nuovo e chiusura della pagina non chiedono conferma
  let baseJson = null;                                  // progetto appena aperto o nuovo, prima di ogni modifica
  const userDirty = () => { if (!editorDirty) return false; const j = projJson(); return j !== autoJson && j !== baseJson; };
  function clearDraft(force) {
    clearTimeout(draftTimer);
    try { const o = draftOwner(); if (force || !o || o === SID || !ownerAlive(o)) localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    draftMine = false;                                   // la prossima modifica riprende la bozza (se è libera)
  }
  async function offerDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) {}
    if (!d || !d.json) return;
    // modulo I/O (senza picoPlc): il programma non gira qui, nessuna domanda; la bozza resta com'è
    let st = liveStatus;
    if (!st) { try { st = await fetchJson("/api/plc/status", FETCH_TO); } catch (e) {} }
    if (st && st.role === "io" && !(PPLC_ON && st.pplc)) return;
    if (d.sid && d.sid !== SID && ownerAlive(d.sid)) {    // è di un altro editor ancora aperto: non si tocca
      setStatusLine("c'è una bozza non scaricata in un altro editor aperto (un'altra scheda)", "warn");
      return;
    }
    if (d.json === projJson()) { clearDraft(); return; }
    let p; try { p = JSON.parse(d.json); } catch (e) { clearDraft(); return; }
    // bozza senza niente dentro (solo network vuoti, nessun DB né FC): niente da recuperare, nessuna domanda
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];
    const hasCode = blocks.some(b => b.type !== "main" || (b.segments || []).some(sg => (sg.rungs || []).some(r =>
      (r.series && r.series.items && r.series.items.length) || (r.outputs && r.outputs.length))));
    if (!hasCode && !(p.modules || []).length) { clearDraft(true); return; }
    const when = new Date(d.saved).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
    const same = p.uid && project.uid && p.uid === project.uid;
    const v = await confirmModal("Bozza non scaricata",
      `C'è una bozza del progetto «${U(p.name) || "senza nome"}» del ${when}, con modifiche che non sono sul PLC` +
      (plcJson ? (same ? " (stesso progetto del PLC, versione diversa)." : " (sul PLC c'è un altro progetto).") : ".") +
      `\n\nRiaprirla? Sul PLC non cambia niente finché non fai Download.`,
      "Riapri la bozza", "Scarta la bozza");
    if (v === "alt") { clearDraft(true); setStatusLine("bozza scartata"); return; }
    if (v !== "ok") return;
    draftMine = true;                                     // riaperta qui: da ora la bozza è di questa scheda
    setProject(p);
    program = project.blocks.find(b => b.id === d.block) || project.blocks[0];
    afterLoad();
    editorDirty = projJson() !== plcJson;
    setRecovered(false);
    renderBlocks();
    setStatusLine(`bozza riaperta (${when}) — Compile + Download per mandarla al PLC`, "warn");
  }
  // Nome del progetto nel titolo in alto; l'ID si vede passando col mouse
  function renderProjName() {
    const e = document.getElementById("proj-name");
    if (!e) return;
    e.textContent = project.name || "senza nome";
    e.title = `Progetto «${U(project.name) || "senza nome"}»` + (project.uid ? ` · ID ${project.uid}` : " · senza ID (lo riceve al primo Salva o Download)") +
              "\nClic per rinominare";
  }
  function ensureUid() {
    if (project.uid) return;
    project.uid = EspIR.newUid();
    if (!project.name) project.name = "Progetto";
    hist.forEach(h => { const j = JSON.parse(h.json); j.uid = project.uid; j.name = j.name || project.name; h.json = JSON.stringify(j); });
    renderProjName();
  }
  async function renameProject() {
    const v = await askText("Nome del progetto", "Nome:", project.name || "", "L'ID del progetto non cambia: il PLC lo riconosce lo stesso.");
    if (v === null || v.trim() === (project.name || "")) return;
    project.name = v.trim().slice(0, 60) || "Progetto";
    renderProjName();
    markTextDirty("nome del progetto cambiato");
  }
  // Modifica solo di testi (nome, titoli, commenti): il bytecode non cambia,
  // quindi si resta Online; il sorgente sul PLC si aggiorna al prossimo Download.
  function markTextDirty(what) {
    editorDirty = projJson() !== plcJson;
    lastBlob = null;
    document.getElementById("btn-download").disabled = false;   // il Download compila da solo
    pushHistory();
    setStatusLine(`${what} — Download per salvarlo anche sul PLC`);
  }
  function setSegText(n, field, v) {
    const seg = program.segments[n];
    if (!seg) return;
    v = v.trim();
    if (setUt(`net:${program.id}:${seg.id}:${field === "title" ? "t" : "c"}`, v, seg[field] || "")) {   // colonna della lingua scelta
      markTextDirty(field === "title" ? `titolo del Network ${n + 1} cambiato` : `commento del Network ${n + 1} cambiato`);
      render(); return;
    }
    if ((seg[field] || "") === v) return;
    if (v) seg[field] = v; else delete seg[field];
    markTextDirty(field === "title" ? `titolo del Network ${n + 1} cambiato` : `commento del Network ${n + 1} cambiato`);
    render();
  }
  async function newProject() {
    if (userDirty() && !(await confirmAction("Nuovo progetto?",
        "Le modifiche non scaricate sul PLC si perdono (se ti servono: prima 💾 Salva).", "Sì, nuovo"))) return;
    const name = await askText("Nuovo progetto", "Nome del progetto:", "",
      "Es. Nastro linea 2. Il progetto riceve un ID nuovo: così il PLC lo distingue dagli altri.");
    if (name === null) return;
    setProject(EspIR.emptyProgram(name.trim().slice(0, 60) || "Progetto"));
    if (liveMonitoring) setOnline(false);
    afterLoad();
    editorDirty = true;
    setRecovered(false);
    saveDraftSoon();
    setStatusLine(`nuovo progetto «${U(project.name)}» (ID ${project.uid})`);
    await ioAutoHwdb();
  }

  // ── File di progetto (.miaplc, prima .espplc.json): progetto + simboli, in JSON ──
  const fileStamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  const safeName = n => (n || "progetto").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "progetto";
  function downloadFile(name, data, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function projectDoc(origin, proj, extra) {
    return Object.assign({ format: "espplc-project", version: 2, saved: new Date().toISOString(), origin,
                           project: proj, symbols: JSON.parse(EspSymbols.exportJSON(true)).symbols }, extra || {});
  }
  function saveProjectFile() {
    ensureUid();
    const name = `${safeName(project.name)}-${fileStamp()}.miaplc`;
    downloadFile(name, JSON.stringify(projectDoc("editor", JSON.parse(projJson())), null, 1), "application/json");
    setStatusLine(`progetto salvato: ${name} (${EspSymbols.count()} simboli inclusi)`);
  }
  // Apri / Restore: .miaplc o .espplc.json (progetto o backup del PLC), IR puro, vecchio .bin
  async function openFile(file) {
    if (userDirty() && !(await confirmAction("Sostituire il progetto nell'editor?",
        "Hai modifiche non scaricate sul PLC: aprendo un file le perdi (resta la bozza fino alla prossima modifica).", "Sì, apri"))) return;
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4C && head[2] === 0x43 && head[3] === 0x31) return restoreBin(file);   // "PLC1"
    let doc;
    try { doc = JSON.parse(await file.text()); } catch (e) { setStatusLine(`${file.name}: non è un file di progetto (${e.message})`, "err"); return; }
    let proj = null, symbols = null, origin = "editor", plcRaw = null;
    if (doc && doc.format === "espplc-project") { proj = doc.project; symbols = doc.symbols; origin = doc.origin || "editor"; plcRaw = doc.plc || null; }
    else if (doc && doc.format === "espplc-ir") proj = doc;
    else { setStatusLine(`${file.name}: formato sconosciuto`, "err"); return; }
    // i simboli sono del progetto: aprendo un progetto la tabella diventa la sua (vuota se il file non ne ha).
    // Unire la tabella di un altro programma non ha senso (per unire c'è l'importazione nella tabella dei simboli)
    {
      const rows = symbols && Object.keys(symbols).length
        ? EspSymbols.parse(JSON.stringify({ format: "espplc-symbols", version: 1, symbols })).rows : [];
      const r = EspSymbols.merge(rows, true);
      if (r.errors.length) setStatusLine(`simboli: ${r.errors.length} righe scartate`, "warn");
    }
    if (!proj && plcRaw && plcRaw.bytecode_hex) {
      const bc = hexToBytes(plcRaw.bytecode_hex), src = b64decode(plcRaw.source_b64gz || "");
      const r = decompileBytecode(bc);
      if (!r.editable) {
        lastBlob = buildWireBlob(bc, src);
        document.getElementById("btn-download").disabled = false;
        setStatusLine(`${file.name}: backup senza sorgente leggibile — si può solo riscaricare sul PLC (Download)`, "warn");
        return;
      }
      proj = r.program;
    }
    if (!proj) { setStatusLine(`${file.name}: nessun progetto nel file`, "err"); return; }
    await bracePaint();
    setProject(proj);
    afterLoad();
    editorDirty = projJson() !== plcJson;
    setRecovered(false);
    saveDraftSoon();
    const what = origin === "plc" ? "backup del PLC" : "progetto";
    setStatusLine(`${what} «${U(project.name) || "senza nome"}» aperto da ${file.name}` +
                  (editorDirty ? " — Compile + Download per mandarlo al PLC" : " — uguale al PLC"), editorDirty ? "warn" : null);
    await ioAutoHwdb();                                   // progetto senza HWDB (es. gli esempi del sito): la crea dai punti della scheda
  }

  // ── Editor ↔ PLC: programma (CRC bytecode) e testi (CRC sorgente) ──
  // SID = questa scheda del browser: il PLC sa chi è collegato e chi ha fatto l'ultimo Download.
  const SID = EspIR.newUid();
  window.ESPPLC_SID = SID;                               // la Diagnostica aperta da qui legge lo stato con questo SID
  const textsOf = p => JSON.stringify([p.name || "", p.uid || "", p.blocks.map(b =>
    [b.id, b.name || "", b.segments.map(sg => [sg.title || "", sg.comment || ""])])]);
  let plcSrc = { crc: null, texts: null };   // sorgente sul PLC: CRC (status.src_crc32) e testi
  let lastCompiled = null;                   // { src, texts } dell'ultimo Compile
  let editorBc = null, editorBcFor = null, bcTimer = 0;
  const hex8 = n => n == null ? "—" : (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
  function scheduleBc() { clearTimeout(bcTimer); bcTimer = setTimeout(refreshEditorBc, 300); }
  async function refreshEditorBc() {
    const json = projJson();
    if (json === editorBcFor) return;
    editorBcFor = json;
    try {
      const r = await compileIR(project);
      const ok = !(r.errors && r.errors.length);
      editorBc = ok ? crc32(r.bytecode) >>> 0 : null;
      if (ok && r.blocks) { editorWork = workOf(r); renderWorkBar(); }   // barra «Lavoro» sempre col programma dell'editor
      if (devTab && devKnown[devTab] === undefined && ok) devKnown[devTab] = editorBc;   // appena letto dal modulo: è il suo
      editorBlk = ok ? new Map(r.blocks.map(b => [bkey({ type: b.type === 0 ? "main" : b.type === 2 ? "startup" : b.type === 3 ? "db" : b.type === 4 ? "mod" : "fc", number: b.number }), { crc: b.crc, scrc: b.scrc, lcrc: b.lcrc, base: b.base, partOf: b.partOf }]))
        : (dropEditorBlk(), editorBlk);                // non compila (es. un «?» da riempire): fuori da Online solo il blocco a video
    }
    catch (e) { editorBc = null; editorBlk = null; }
    updateExecDots();
    if (liveMonitoring) { markStructChanged(); render(); }
    updateSync();
  }
  let textsFetchFor = null;
  function updateSync() {
    const b = document.getElementById("badge-sync");
    const s = liveStatus;
    if (!b) return;
    if (devTab) {                                      // scheda di un modulo: confronto con quello che il modulo ha avuto
      const k = devKnown[devTab], same = editorBc !== null && k !== undefined && k === editorBc;
      b.classList.remove("hidden");
      b.textContent = same ? `✓ ${devTab} = editor` : `≠ ${devTab}`;
      b.className = "badge sync " + (same ? "ok" : "warn");
      b.title = same ? `Il programma di ${devTab} è uguale a quello dell'editor (ultimo Download o lettura dal modulo).`
                     : `Il programma dell'editor è diverso da quello mandato a ${devTab}: Download per mandarlo.`;
      return;
    }
    if (!s || (s.bc_crc32 === undefined && s.state !== "no_program")) { b.classList.add("hidden"); return; }
    b.classList.remove("hidden");
    if (s.bc_crc32 === undefined) { b.textContent = "PLC vuoto"; b.className = "badge sync warn"; b.title = "Sul PLC non c'è nessun programma"; return; }
    const plcBc = s.bc_crc32 >>> 0, plcSrcCrc = s.src_crc32 === undefined ? null : s.src_crc32 >>> 0;
    const pOk = editorBc !== null && editorBc === plcBc;
    let t = "?";
    if (plcSrcCrc !== null && plcSrc.crc === plcSrcCrc) t = plcSrc.texts === null ? "none" : (textsOf(project) === plcSrc.texts ? "ok" : "diff");
    else if (plcSrcCrc !== null && textsFetchFor !== plcSrcCrc) {
      textsFetchFor = plcSrcCrc;                       // una lettura del sorgente per ogni versione
      plcIdentity().then(updateSync);
    }
    // Un solo stato, detto a parole: uguale / solo testi da scaricare / diverso (quali blocchi)
    const d = blocksDiff();
    const codeDiff = d ? d.filter(x => !/testi diversi$/.test(x)).map(x => x.split(":")[0]) : null;
    if (pOk && t !== "diff") {
      b.textContent = "✓ PLC = editor";
      b.className = "badge sync ok";
    } else if (pOk) {
      b.textContent = "✓ PLC = editor · testi da scaricare";
      b.className = "badge sync info";
    } else {
      b.textContent = "≠ PLC" + (codeDiff && codeDiff.length ? ": " + codeDiff.slice(0, 3).join(", ") + (codeDiff.length > 3 ? ` +${codeDiff.length - 3}` : "") : "");
      b.className = "badge sync warn";
    }
    b.title = (pOk ? "Il programma sul PLC è uguale a quello dell'editor." : "Il programma sul PLC è DIVERSO da quello dell'editor: Download per caricare i blocchi segnati con ≠.") +
              ({ ok: "", diff: "\nNome del progetto, nomi delle FC, titoli o commenti diversi: il Download li aggiorna sul PLC (il programma non cambia).",
                 none: "\nIl PLC non ha i testi (programma senza sorgente).", "?": "" }[t]) +
              "\nI testi dell'editor non si perdono: questo indicatore confronta soltanto, non cambia niente." +
              `\n\nCRC programma: editor ${editorBc === null ? "non compila" : hex8(editorBc)} · PLC ${hex8(plcBc)}` +
              `\nSorgente sul PLC: CRC ${hex8(plcSrcCrc)}` + blocksDiffText();
  }
  // Elenco dei blocchi diversi tra editor e PLC (per il tooltip e il Download)
  function blocksDiff() {
    if (!editorBlk || !plcBlk || devTab) return null;
    const out = [];
    for (const b of project.blocks) {
      const e = editorBlk.get(bkey(b)), p = plcBlk.get(bkey(b));
      if (!p) out.push(`${EspIR.blockLabel(b)}: non c'è sul PLC`);
      else if (e && e.crc !== p.crc) out.push(`${EspIR.blockLabel(b)}: programma diverso`);
      else if (e && e.scrc !== p.scrc) out.push(`${EspIR.blockLabel(b)}: testi diversi`);
    }
    for (const d of project.dbs || []) {                 // v4.8: DB
      const e = editorBlk.get("db:" + d.number), p = plcBlk.get("db:" + d.number);
      if (!p) out.push(`DB${d.number}: non c'è sul PLC`);
      else if (e && e.crc !== p.crc) out.push(`DB${d.number}: diverso`);
    }
    for (const [k, e] of editorBlk) {                    // moduli: esposizione dati e Dati HMI
      if (!k.startsWith("mod:")) continue;
      const p = plcBlk.get(k);
      if (!p) out.push(`${blkName(k)}: non c'è sul PLC`);
      else if (e.crc !== p.crc) out.push(`${blkName(k)}: diverso`);
    }
    for (const k of plcBlk.keys()) if (!editorBlk.has(k)) out.push(`${blkName(k)}: solo sul PLC`);
    return out;
  }
  function blocksDiffText() {
    const d = blocksDiff();
    return d && d.length ? "\n\nBlocchi diversi:\n" + d.slice(0, 12).join("\n") + (d.length > 12 ? `\n… e altri ${d.length - 12}` : "") : "";
  }
  // Altri editor collegati allo stesso PLC
  // (solo per l'avviso prima del Download: l'indicatore fisso in alto è stato tolto, compariva e spariva)
  const otherClients = () => ((liveStatus && liveStatus.clients) || []).filter(c => c.sid !== SID && c.age < 10000);
  // Nome di una postazione: l'IP; sullo stesso PC (simulatore, 127.0.0.1) la scheda del browser
  // (dalla USB il PLC dà «USB» o 0.0.0.0: niente indirizzo)
  const who = c => c.ip === "127.0.0.1" ? `un'altra scheda del browser (${(c.sid || "").slice(0, 4)})`
    : !c.ip || c.ip === "0.0.0.0" || c.ip === "USB" ? "un editor collegato via USB" : c.ip;

  // Un altro PC ha cambiato il programma o i testi: avviso che resta finché non lo chiudi
  let seenBc, seenSrc;
  function watchRemote(s, byOther) {
    const bc = s.bc_crc32 === undefined ? null : s.bc_crc32 >>> 0, src = s.src_crc32 === undefined ? null : s.src_crc32 >>> 0;
    if (seenBc !== undefined && byOther && byOther.age_s < 60) {
      if (bc !== seenBc) showRemoteNote(`${who(byOther)} ha caricato un altro programma sul PLC (${byOther.age_s} s fa). ` +
        (editorBc === bc ? "È uguale a quello dell'editor." : "L'editor ora è diverso dal PLC: Upload from cpu per vederlo, o Download per rimettere il tuo."));
      else if (src !== seenSrc) showRemoteNote(`${who(byOther)} ha aggiornato sul PLC nome/titoli/commenti (${byOther.age_s} s fa); il programma è lo stesso.`);
    }
    seenBc = bc; seenSrc = src;
  }
  function showRemoteNote(msg) {
    const n = document.getElementById("remote-note");
    n.querySelector("span").textContent = "⚠ " + msg;
    n.classList.remove("hidden");
    setStatusLine(msg, "warn");
  }

  // ── Render ────────────────────────────────────────────
  // Ogni segmento del programma è un "network" numerato, disegnato nel suo
  // rettangolo con barra di scorrimento orizzontale propria.
  let netBlocks = [];            // [{ el, scroller, svg, title, count }]

  function ensureNetworkBlocks() {
    const list = document.getElementById("networks");
    const segs = program.segments;
    if (netBlocks.length === segs.length && netBlocks.every(b => b.el.isConnected)) return;
    list.innerHTML = "";
    unwatchNets();
    netBlocks = segs.map((_, n) => {
      const el = document.createElement("div");
      el.className = "network";
      el.innerHTML =
        `<div class="net-head"><span class="net-title" translate="no"></span>` +
        `<input class="net-ttl" maxlength="${EspIR.TITLE_MAX}" placeholder="titolo del network…" title="Titolo del network (Invio = conferma, Esc = annulla)">` +
        `<span class="net-count muted"></span>` +
        `<span class="net-tools">` +
        `<button class="icon" data-a="com" title="Commento del network">💬</button>` +
        `<button class="icon" data-a="up" title="Sposta su">▲</button>` +
        `<button class="icon" data-a="down" title="Sposta giù">▼</button>` +
        `<button class="icon danger" data-a="del" title="Elimina network">✕</button></span></div>` +
        `<textarea class="net-com hidden" rows="2" maxlength="${EspIR.COMMENT_MAX}" placeholder="commento del network…"></textarea>` +
        `<div class="net-scroll"><svg class="ladder" translate="no" xmlns="${SVG_NS}"></svg></div>`;
      const ttl = el.querySelector(".net-ttl"), com = el.querySelector(".net-com");
      const textKeys = (inp, field, multi) => inp.addEventListener("keydown", e => {
        if (e.key === "Escape") { const sg = program.segments[n]; inp.value = ut(`net:${program.id}:${sg.id}:${field === "title" ? "t" : "c"}`, sg[field] || ""); inp.blur(); }
        if (e.key === "Enter" && (!multi || e.ctrlKey)) { e.preventDefault(); inp.blur(); }
      });
      textKeys(ttl, "title", false); textKeys(com, "comment", true);
      ttl.addEventListener("change", () => setSegText(n, "title", ttl.value));
      com.addEventListener("change", () => setSegText(n, "comment", com.value));
      com.addEventListener("blur", () => { if (!com.value.trim()) { blkOf(n).comOpen = false; com.classList.add("hidden"); } });
      el.querySelector('[data-a="com"]').onclick = () => {
        const b = blkOf(n); b.comOpen = true; com.classList.remove("hidden"); com.focus(); };
      const svg = el.querySelector("svg");
      setupSvgDrop(svg);
      setupSel(svg);
      // tasto destro: «aggiungi network sopra / sotto» solo sulla riga d'intestazione del network; sul ladder
      // incolla e ricerca
      const pasteItem = () => ({ label: "📋 Incolla nel network", disabled: netPasteWhy(n), run: () => pasteInNet(n) });
      svg.addEventListener("contextmenu", e => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, null, [pasteItem(), { label: "🔍 Cerca / riferimenti incrociati…", run: () => openXref("") }]);
      });
      el.querySelector(".net-head").addEventListener("contextmenu", e => {
        if (e.defaultPrevented || (e.target.closest("input, textarea") && document.activeElement === e.target)) return;   // titolo in scrittura: menu del testo
        e.preventDefault();
        showMenu(e.clientX, e.clientY, null, [
          { label: "＋ Aggiungi network sopra", run: () => insertNetwork(n) },
          { label: "＋ Aggiungi network sotto", run: () => insertNetwork(n + 1) }, pasteItem(), "-",
          { label: "📄 Copia network", run: () => copyNet(n) },
          { label: "📋 Incolla network sopra", disabled: netClipWhy(), run: () => pasteNet(n) },
          { label: "📋 Incolla network sotto", disabled: netClipWhy(), run: () => pasteNet(n + 1) }]);
      });
      // scorrimento orizzontale: niente ridisegno (prima tutto il blocco a ogni passo: scorreva a scatti). Solo la zona del
      // network vuoto segue scrollLeft, e un network vuoto non scorre
      el.querySelector('[data-a="up"]').onclick   = () => moveNetwork(n, -1);
      el.querySelector('[data-a="down"]').onclick = () => moveNetwork(n, +1);
      el.querySelector('[data-a="del"]').onclick  = () => deleteNetwork(n);
      list.appendChild(el);
      watchNet(el, n);
      return { el, svg, scroller: el.querySelector(".net-scroll"), ttl, com, comOpen: false,
               comBtn: el.querySelector('[data-a="com"]'),
               title: el.querySelector(".net-title"), count: el.querySelector(".net-count") };
    });
  }

  function render() {
    const t0 = performance.now();
    renderNow();
    notePaint(performance.now() - t0);
  }
  // Online: valori nuovi dal PLC con lo stesso programma a video → si ridisegnano solo i network a vista (gli altri non
  // hanno valori nuovi: si chiedono solo quelli a vista). Prima tutto il blocco a ogni lettura, ogni 0,5 s
  let fullProg = null, fullStruct = null;
  function renderLive() {
    if (!netIo || program !== fullProg || lastStructSig !== fullStruct || netBlocks.length !== program.segments.length) return render();
    const t0 = performance.now();
    execNote();
    const redo = new Set();
    program.segments.forEach((seg, n) => { if (visNets.has(n) && netBlocks[n]) redo.add(netBlocks[n].svg); });
    dropZones = dropZones.filter(d => !redo.has(d.svg));
    selHits = selHits.filter(h => !redo.has(h.svg));
    if (flashRect && redo.has(flashRect.ownerSVGElement)) flashRect = null;
    const clearNode = nd => { clearMeasure(nd.series); (nd.outputs || []).forEach(clearNode); };
    program.segments.forEach((seg, n) => { if (netBlocks[n] && redo.has(netBlocks[n].svg)) { seg.rungs.forEach(clearNode); renderNetwork(n, seg, netBlocks[n]); } });
    notePaint(performance.now() - t0);
  }
  // v5.1: FC in testo (ST, C): al posto dei network un'area di testo con i numeri di riga e gli errori
  const TEXT_START_ST = "// Variabili: interfaccia qui sopra (#nome). DB: \"Nome\".campo. Bit: I0, Q0, M0. Simboli: \"Nome\"\n" +
                        "// Esempio: avvio, stop e output (BOOL) nell'interfaccia, poi togli i //\n// IF #avvio THEN\n//     #output := TRUE;\n// ELSIF #stop THEN\n//     #output := FALSE;\n// END_IF;\n";
  const TEXT_START_C = "// Variabili: interfaccia qui sopra (nome). DB: \"Nome\".campo. Bit: I0, Q0, M0. Simboli: Nome\n" +
                       "// Esempio: avvio, stop e output (BOOL) nell'interfaccia, poi togli i //\n// if (avvio) {\n//     output = true;\n// } else if (stop) {\n//     output = false;\n// }\n";
  let textEdBlock = null;
  // larghezza di un carattere del testo (carattere a larghezza fissa): per mettere il completamento sotto il cursore
  let acCw = 0;
  function acCharW(cs) {
    if (acCw) return acCw;
    const c = document.createElement("canvas").getContext("2d");
    c.font = `${cs.fontSize} ${cs.fontFamily}`;
    acCw = c.measureText("MMMMMMMMMM").width / 10 || 7.8;
    return acCw;
  }
  // Modelli delle FC in testo (Denys 02-11-2026): nella colonna Istruzioni al posto del ladder, clic o trascinamento nel
  // testo; anche nel completamento automatico. §…§ = la parte da scrivere, che resta selezionata
  const TEXT_SNIPS = {
    ST: [["IF", "IF §condizione§ THEN\n    \nEND_IF;"], ["IF … ELSE", "IF §condizione§ THEN\n    \nELSE\n    \nEND_IF;"],
         ["IF … ELSIF … ELSE", "IF §condizione§ THEN\n    \nELSIF condizione THEN\n    \nELSE\n    \nEND_IF;"],
         ["CASE", "CASE §#n§ OF\n    1:\n        \n    2, 3:\n        \nELSE\n    \nEND_CASE;"],
         ["FOR", "FOR §#i§ := 0 TO 9 DO\n    \nEND_FOR;"], ["FOR … BY", "FOR §#i§ := 10 TO 0 BY -1 DO\n    \nEND_FOR;"],
         ["WHILE", "WHILE §condizione§ DO\n    \nEND_WHILE;"], ["REPEAT", "REPEAT\n    \nUNTIL §condizione§\nEND_REPEAT;"],
         ["Assegnazione", "§destinazione§ := valore;"], ["EXIT", "EXIT;"], ["CONTINUE", "CONTINUE;"], ["RETURN", "RETURN;"],
         ["Commento", "// §commento§"], ["Commento a blocco", "(* §commento§ *)"]],
    C: [["if", "if (§condizione§) {\n    \n}"], ["if … else", "if (§condizione§) {\n    \n} else {\n    \n}"],
        ["if … else if … else", "if (§condizione§) {\n    \n} else if (condizione) {\n    \n} else {\n    \n}"],
        ["switch", "switch (§n§) {\n    case 1:\n        \n        break;\n    case 2:\n    case 3:\n        \n        break;\n    default:\n        \n        break;\n}"],
        ["for", "for (§i§ = 0; i < 10; i++) {\n    \n}"], ["while", "while (§condizione§) {\n    \n}"], ["do … while", "do {\n    \n} while (§condizione§);"],
        ["Assegnazione", "§destinazione§ = valore;"], ["break", "break;"], ["continue", "continue;"], ["return", "return;"],
        ["Commento", "// §commento§"], ["Commento a blocco", "/* §commento§ */"]],
  };
  // modello nel testo al posto di [from, to): righe con il rientro della riga dove va, la parte da scrivere selezionata
  function textSnipPut(ta, body, from, to) {
    const ls = ta.value.lastIndexOf("\n", from - 1) + 1, ind = (/^[ \t]*/.exec(ta.value.slice(ls)) || [""])[0];
    let t = body.replace(/\n/g, "\n" + ind);
    const a = t.indexOf("§"), b = t.indexOf("§", a + 1);
    t = t.replace(/§/g, "");
    ta.focus();
    ta.setRangeText(t, from, to, "end");
    if (a >= 0 && b > a) ta.setSelectionRange(from + a, from + b - 1);
    ta.dispatchEvent(new Event("input"));
  }
  // Commento sul testo che c'è: «Commento» mette o toglie // all'inizio di ogni riga di [from, to) (dopo il rientro);
  // «Commento a blocco» chiude [from, to) fra (* *) o /* */, o li toglie se c'erano già
  function textComment(ta, lang, block, from, to) {
    const v = ta.value;
    if (block) {
      const [o, c] = lang === "ST" ? ["(*", "*)"] : ["/*", "*/"], t = v.slice(from, to), tt = t.trim();
      let r;
      if (tt.startsWith(o) && tt.endsWith(c)) {          // già chiuso: si toglie (con lo spazio dopo e prima)
        const i = t.indexOf(o), j = t.lastIndexOf(c);
        r = t.slice(0, i) + t.slice(i + 2, j).replace(/^ /, "").replace(/ $/, "") + t.slice(j + 2);
      } else r = o + " " + t + " " + c;
      ta.focus(); ta.setRangeText(r, from, to, "select");
    } else {
      const a = v.lastIndexOf("\n", from - 1) + 1, e0 = v.indexOf("\n", Math.max(from, to - 1)), b = e0 < 0 ? v.length : e0;
      const lines = v.slice(a, b).split("\n"), on = lines.every(l => !l.trim() || /^\s*\/\//.test(l));
      const r = lines.map(l => !l.trim() ? l : on ? l.replace(/^(\s*)\/\/ ?/, "$1") : l.replace(/^(\s*)/, "$1// ")).join("\n");
      ta.focus(); ta.setRangeText(r, a, b, "select");
    }
    ta.dispatchEvent(new Event("input"));
  }
  // clic o trascinamento di un modello: i commenti si mettono sul testo selezionato (o sulla riga dove si lascia)
  function textSnipUse(ta, lang, name, body, from, to, line) {
    const cm = name === "Commento" ? 1 : name === "Commento a blocco" ? 2 : 0;
    if (cm && (from !== to || line)) {
      if (line && from === to) {                         // la riga dove si lascia, senza il rientro
        const v = ta.value, a = v.lastIndexOf("\n", from - 1) + 1, e = v.indexOf("\n", from);
        from = a + (/^[ \t]*/.exec(v.slice(a)) || [""])[0].length; to = e < 0 ? v.length : e;
      }
      if (to > from) return textComment(ta, lang, cm === 2, from, to);
    }
    textSnipPut(ta, body, from, to);
  }
  // colonna Istruzioni: ladder per i blocchi a network, modelli del linguaggio per le FC in testo
  function renderTextPalette(lang) {
    const box = document.getElementById("pal-text"), lad = document.getElementById("pal-root");
    if (lad) lad.classList.toggle("hidden", !!lang);
    if (!box) return;
    box.classList.toggle("hidden", !lang);
    if (!lang || box.dataset.lang === lang) return;
    box.dataset.lang = lang;
    const list = box.querySelector(".pal-text-items");
    list.innerHTML = "";
    for (const [name, body] of TEXT_SNIPS[lang] || []) {
      const it = document.createElement("div");
      it.className = "pal-item pal-snip"; it.draggable = true;
      it.title = "Clic: nel testo dove c'è il cursore, o trascina nel testo\n\n" + body.replace(/§/g, "");
      it.innerHTML = `<code translate="no">${escapeHtml(name)}</code>`;
      it.onclick = () => { const ta = document.querySelector("#text-fc textarea"); if (ta) textSnipUse(ta, lang, name, body, ta.selectionStart, ta.selectionEnd, false); };
      it.addEventListener("dragstart", e => { e.dataTransfer.setData("text/x-espplc-snip", JSON.stringify([name, body])); e.dataTransfer.setData("text/plain", body.replace(/§/g, "")); });
      list.appendChild(it);
    }
  }
  function renderTextFc() {
    const box = document.getElementById("text-fc");
    const on = !!(program && EspIR.TEXT_LANGS.includes(program.language));
    box.classList.toggle("hidden", !on);
    document.getElementById("networks").classList.toggle("hidden", on);
    renderTextPalette(on ? program.language : null);
    if (!on) { textEdBlock = null; return false; }
    if (textEdBlock !== program) {
      textEdBlock = program;
      box.innerHTML = `<div class="text-head"><b>${program.language === "ST" ? "ST — testo strutturato" : "C"}</b>` +
        `<span class="muted small">${program.language === "ST" ? "IF … THEN … ELSIF … ELSE … END_IF;  FOR #i := 0 TO 9 DO … END_FOR;  CASE #n OF 1: …; END_CASE;  WHILE … DO … END_WHILE;"
                                                            : "if (…) { } else { }  for (i = 0; i < 10; i++) { }  switch (n) { case 1: …; break; }  while (…) { }"}</span></div>` +
        `<div class="text-ed"><pre class="text-lines" aria-hidden="true"></pre><textarea spellcheck="false" translate="no" wrap="off"></textarea></div>` +
        `<div class="text-errs"></div>`;
      const ta = box.querySelector("textarea"), lines = box.querySelector(".text-lines");
      ta.value = program.text || "";
      const blk = program;
      let t = 0;
      const check = () => {
        const n = ta.value.split("\n").length;
        lines.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
        const r = EspText.parse(ta.value, { lang: blk.language });
        const errs = box.querySelector(".text-errs");
        errs.innerHTML = "";
        for (const e of r.errors) {
          const d = document.createElement("div");
          d.className = "text-err"; d.textContent = `riga ${e.line}, col. ${e.col}: ${e.msg}`;
          d.onclick = () => { const at = ta.value.split("\n").slice(0, e.line - 1).reduce((s, l) => s + l.length + 1, 0) + e.col - 1; ta.focus(); ta.setSelectionRange(at, at); };
          errs.appendChild(d);
        }
      };
      // completamento automatico (Denys 01-11-2026): mentre scrivi, i nomi dell'interfaccia, dei campi dei DB, dei simboli
      // (I, Q, M, T, SM con un nome) e le parole del linguaggio che cominciano così; ↑ ↓ per scegliere, Invio o Tab
      // per mettere, Esc per chiudere
      const ac = document.createElement("div");
      ac.className = "text-ac hidden";
      box.querySelector(".text-ed").appendChild(ac);
      let acList = [], acSel = 0, acFrom = 0;
      const st = blk.language === "ST";
      const KW = st ? ["IF", "THEN", "ELSIF", "ELSE", "END_IF", "CASE", "OF", "END_CASE", "FOR", "TO", "BY", "DO", "END_FOR", "WHILE",
                       "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT", "EXIT", "CONTINUE", "RETURN", "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE"]
                    : ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "true", "false"];
      const cands = () => {
        const out = [];
        for (const v of EspIR.layoutIface(blk).vars.values())
          out.push({ t: (st ? "#" : "") + v.name, d: `${v.type}${v.arr ? `[${v.arr.lo}..${v.arr.hi}]` : ""} · ${DIR_TXT[v.dir] || v.dir}` });
        for (const d of project.dbs || []) for (const f of d.fields || [])
          out.push({ t: `"${d.name}".${f.name}`, d: `${f.type}${Number.isInteger(f.lo) ? `[${f.lo}..${f.hi}]` : ""} · DB${d.number}` });
        if (window.EspSymbols) for (const s of EspSymbols.list())
          if (s.name && ["I", "Q", "M", "T", "SM"].includes(s.ns) && s.bit == null) out.push({ t: st ? `"${s.name}"` : s.name, d: s.key + (s.comment ? " · " + s.comment : "") });
        for (const [name, body] of TEXT_SNIPS[blk.language] || []) if (/^[A-Za-z]/.test(name) && name !== "Assegnazione" && !name.startsWith("Commento"))
          out.push({ t: name, d: "modello: " + body.split("\n")[0].replace(/§/g, ""), snip: body });
        for (const k of KW) out.push({ t: k, d: "" });
        return out;
      };
      const acHide = () => { ac.classList.add("hidden"); acList = []; };
      const acShow = () => {
        const a = ta.selectionStart;
        if (a !== ta.selectionEnd) return acHide();
        let s = a;
        while (s > 0 && /[A-Za-z0-9_#"]/.test(ta.value[s - 1])) s--;
        const pre = ta.value.slice(s, a);
        if (!pre || /^\d/.test(pre)) return acHide();
        const low = pre.toLowerCase();
        acList = cands().filter(c => c.t.toLowerCase().startsWith(low) && (c.t.length > pre.length || c.snip)).slice(0, 12);
        if (!acList.length) return acHide();
        acFrom = s; acSel = 0;
        ac.innerHTML = acList.map((c, i) => `<div class="ac-item${i ? "" : " sel"}" data-i="${i}"><b translate="no">${escapeHtml(c.t)}</b>` +
                                            `${c.d ? `<span class="muted small">${escapeHtml(c.d)}</span>` : ""}</div>`).join("");
        const before = ta.value.slice(0, a).split("\n"), cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight) || 19.5, cw = acCharW(cs);
        ac.style.top = (parseFloat(cs.paddingTop) + before.length * lh - ta.scrollTop) + "px";
        ac.style.left = (lines.offsetWidth + parseFloat(cs.paddingLeft) + before[before.length - 1].length * cw - ta.scrollLeft) + "px";
        ac.classList.remove("hidden");
      };
      const acPut = i => {
        const c = acList[i];
        if (!c) return;
        if (c.snip) { const to = ta.selectionStart; acHide(); textSnipPut(ta, c.snip, acFrom, to); return; }
        ta.setRangeText(c.t, acFrom, ta.selectionStart, "end");
        acHide();
        ta.dispatchEvent(new Event("input"));
      };
      const acMove = d => {
        acSel = (acSel + d + acList.length) % acList.length;
        ac.querySelectorAll(".ac-item").forEach((x, i) => x.classList.toggle("sel", i === acSel));
      };
      ac.addEventListener("mousedown", e => { const it = e.target.closest(".ac-item"); if (it) { e.preventDefault(); acPut(+it.dataset.i); } });
      ta.addEventListener("input", e => {
        blk.text = ta.value; clearTimeout(t); t = setTimeout(() => { check(); markEditDirty(); }, 300);
        if (e.isTrusted) acShow(); else acHide();
      });
      ta.addEventListener("drop", e => {                 // modello trascinato dalla colonna Istruzioni: dove lo si lascia
        const raw = e.dataTransfer.getData("text/x-espplc-snip");
        if (!raw) return;
        e.preventDefault();
        const [name, body] = JSON.parse(raw);
        const c = document.caretPositionFromPoint && document.caretPositionFromPoint(e.clientX, e.clientY);
        const at = c && c.offsetNode === ta ? c.offset : ta.selectionStart;
        textSnipUse(ta, blk.language, name, body, at, at, true);
      });
      ta.addEventListener("scroll", () => { lines.scrollTop = ta.scrollTop; acHide(); });
      ta.addEventListener("blur", () => setTimeout(acHide, 150));
      ta.addEventListener("keydown", e => {
        if (acList.length) {
          if (e.key === "ArrowDown") { e.preventDefault(); acMove(1); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); acMove(-1); return; }
          if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acPut(acSel); return; }
          if (e.key === "Escape") { e.preventDefault(); acHide(); return; }
        }
        if (e.key !== "Tab") return;                       // Tab: 4 spazi (non esce dal testo)
        e.preventDefault();
        const a = ta.selectionStart;
        ta.setRangeText("    ", a, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input"));
      });
      check();
    }
    return true;
  }
  // FC di sistema del Modbus (FC900…, generate dalla pagina Modbus a ogni Conferma): servono solo come box MB_… nel
  // ladder. Se ne vede l'interfaccia; i network solo con il firmware in modalità sviluppatore (memoria: dev), e sempre
  // con l'avviso che si rigenerano
  const sysFc = b => !!b && EspIR.isMbFc(b);
  function renderSysFcNote() {
    const box = document.getElementById("sys-fc-note"), on = sysFc(program);
    if (!box) return false;
    box.classList.toggle("hidden", !on);
    if (!on) return false;
    const dev = !!(liveMemory && liveMemory.dev);
    box.textContent = `FC di sistema del Modbus: la crea la pagina Modbus a ogni Conferma e nel ladder si usa come box ${program.name} ` +
      `(REQ → DONE, BUSY, ERR, STATUS). ` + (dev ? "Modalità sviluppatore: i network si vedono, ma le modifiche si perdono alla prossima Conferma."
                                                : "I network si vedono solo con il firmware in modalità sviluppatore (MiaConfig).");
    return !dev;
  }
  function renderNow() {
    const sysHidden = renderSysFcNote();
    document.getElementById("networks").classList.toggle("sys-hidden", sysHidden);
    document.getElementById("btn-add-net").classList.toggle("sys-hidden", sysFc(program));
    if (sysHidden) { execNote(); updateNameLines(); renderIface(); return; }
    if (renderTextFc()) { execNote(); updateNameLines(); renderIface(); return; }
    ensureNetworkBlocks();
    fullProg = program; fullStruct = lastStructSig;
    execNote();
    flashRect = null;
    dropZones = [];
    selHits = []; lastZone = null;
    if (sel && !program.segments.some(sg => sg.rungs.length)) sel = null;
    parentOf = new WeakMap();
    updateNameLines();
    const clearNode = nd => { clearMeasure(nd.series); (nd.outputs || []).forEach(clearNode); };
    tipSeen = false;
    renderIface();
    program.segments.forEach((seg, n) => { seg.rungs.forEach(clearNode);
                                           renderNetwork(n, seg, netBlocks[n]); });
    if (tipNode && !tipSeen) hideTip();
  }
  // nota sopra i network: blocco diverso dal PLC, non eseguito, PLC non in RUN
  function execNote() {
    // blocco diverso dal PLC: solo Offline, disegnato come senza Online (niente grigio, niente nota: Denys 24-10-2026)
    const offline = !!(liveMonitoring && liveStatus && !blockLiveOk(program));
    const notExec = !offline && !!(liveMonitoring && liveStatus && !blockExecuted(program));
    const note = document.getElementById("exec-note");
    if (note) {
      note.classList.toggle("hidden", !notExec);
      if (notExec && program.type === "startup") note.textContent = startupNote();
      else if (notExec) note.textContent = liveStatus.state !== "running"
        ? `PLC non in RUN: ${EspIR.blockLabel(program)} non viene eseguita, i network restano grigi.`
        : `${EspIR.blockLabel(program)} non è stata eseguita nell'ultima scansione (nessuna chiamata attiva): i network restano grigi.`;
    }
    document.getElementById("networks").classList.toggle("not-exec", notExec);
  }

  function renderNetwork(segIdx, seg, blk) {
    const svg = blk.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const rungs = seg.rungs;
    blk.title.textContent = `Network ${segIdx + 1}`;
    const tT = ut(`net:${program.id}:${seg.id}:t`, seg.title || ""), tC = ut(`net:${program.id}:${seg.id}:c`, seg.comment || "");
    if (document.activeElement !== blk.ttl) blk.ttl.value = tT;
    if (document.activeElement !== blk.com) blk.com.value = tC;
    blk.com.classList.toggle("hidden", !(tC || blk.comOpen));
    blk.comBtn.classList.toggle("on", !!tC);
    blk.comBtn.title = tC ? "Commento: " + U(tC) : "Aggiungi un commento al network";
    blk.count.textContent = rungs.length ? "" : "vuoto";
    blk.el.querySelector('[data-a="up"]').disabled   = segIdx === 0;
    blk.el.querySelector('[data-a="down"]').disabled = segIdx === program.segments.length - 1;

    // misure di ogni rung (le uscite possono diramarsi ancora: albero)
    // zona degli elementi finali: larga quanto la bobina con l'etichetta più lunga, o il box finale più largo
    let coilLab = 0, endW = 0;
    const scanEnd = n => { if (n.coil) { if (n.coil.op && !isTimerObj(n.coil) && n.coil.kind !== "BOX" && n.coil.kind !== "CALL") coilLab = Math.max(coilLab, labelW(n.coil.op));
                                         else endW = Math.max(endW, eltW(n.coil)); }
                           (n.outputs || []).forEach(scanEnd); };
    rungs.forEach(scanEnd);
    const coilHalf = Math.max(COIL_W / 2 + 10, Math.ceil(coilLab / 2) + 8);
    const endArea = Math.max(COIL_AREA, coilHalf * 2 + 60, endW + 70);
    const lay = rungs.map(r => { measPad = 0; const m = measureNode(r, false); return { need: RAIL_L + m.w + endArea + 40, rows: m.rows, pad: Math.max(0, measPad) }; });
    // larghezza visibile per difetto: clientWidth è arrotondato e con lo zoom del browser (o di Windows) supera di una
    // frazione di px quella vera, e compariva la barra di scorrimento orizzontale (che col mouse sopra si accende di blu)
    const visible = Math.floor(blk.scroller.getBoundingClientRect().width) || 800;
    const W = Math.max(visible, ...lay.map(l => Math.ceil(l.need)));
    const railR = W - 40, xCoil = railR - coilHalf;
    let y = 4;
    const rungH = (rows, pad) => TOP_PAD + (rows - 1) * ROW_H + BOX_H / 2 + 14 + (pad || 0);
    const rungTops = lay.map(l => { const t = y; y += rungH(l.rows, l.pad); return t; });
    const H = rungs.length ? y + 4 : y + rungH(1) + 4;
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const liveOn = liveActive();
    line(svg, RAIL_L, 6, RAIL_L, H - 8, liveOn ? "rail rail-on" : "rail");
    line(svg, railR,  6, railR,  H - 8, "rail");

    rungs.forEach((r, rIdx) => {
      const top = rungTops[rIdx];
      const rowY = row => top + TOP_PAD + row * ROW_H;
      drawNode({ svg, rowY, xCoil, railR, where: { rung: r, segIdx, rungIdx: rIdx } }, r, null, RAIL_L, 0, liveOn, false);
    });

    // Un network = un rung. Network vuoto: solo la linea tra
    // le barre, dove si trascina il primo contatto o la prima bobina.
    if (!rungs.length) {
      const yy = y + TOP_PAD;
      lineWire(svg, RAIL_L, yy, railR, yy, false);
      const visW = blk.scroller.clientWidth || W;
      const zx = blk.scroller.scrollLeft + RAIL_L + 10, zw = Math.min(visW, W) - RAIL_L - 70;
      addDropzone(svg, zx, yy - ZONE_H / 2, zw, ZONE_H, { kind: "new-rung", segIdx, accepts: "both" });
      text(svg, zx + zw / 2, yy - ZONE_H / 2 - 6, window.EspI18n ? EspI18n.t("trascina qui un contatto o una bobina") : "trascina qui un contatto o una bobina", "elt-label hint");   // il ladder è translate="no"
    }
  }

  // Nodo di uscita: la sua serie, poi bobina oppure diramazione verso i figli.
  // inline = unico figlio: una serie vuota non si disegna (niente zone doppie).
  function measureNode(n, inline) {
    const s = measure(n.series);
    const sw = inline && !n.series.items.length ? 0 : s.w;
    if (n.coil) return { w: sw, rows: Math.max(1, s.h, n.coil.kind === "CALL" ? callRowsN(n.coil) : n.coil.kind === "BOX" ? boxRowsN(n.coil) : 1) };
    const kids = (n.outputs || []).map(k => measureNode(k, n.outputs.length === 1));
    if (!kids.length) return { w: sw, rows: Math.max(1, s.h) };
    if (kids.length === 1) return { w: sw + kids[0].w, rows: Math.max(s.h, kids[0].rows) };
    return { w: sw + 10 + Math.max(...kids.map(k => k.w)),
             rows: Math.max(s.h, kids.reduce((a, k) => a + k.rows, 0)) };
  }
  function drawNode(c, n, parent, x, row, en, inline) {
    const { svg, rowY } = c;
    const y = rowY(row);
    const where = Object.assign({ node: n, parent }, c.where);
    let out = en, xe = x;
    // dove arriva la serie: davanti all'elemento finale, oppure al punto di diramazione delle uscite, che sta a destra
    // vicino alle bobine (i rami delle bobine orientati a destra); il filo fino a lì è una zona di rilascio sola
    const kids = n.outputs || [];
    const endX = k => !k.coil ? null : (k.coil.kind === "CALL" || k.coil.kind === "BOX" || isTimerObj(k.coil)) ? c.railR - 10 - eltW(k.coil) : c.xCoil - COIL_W / 2;
    const hasSer = !(inline && !n.series.items.length), xe0 = hasSer ? x + measure(n.series).w : x;
    let xb = null;
    if (!n.coil && kids.length > 1) {
      const ends = kids.map(endX).filter(v => v !== null);
      const lim = (ends.length ? Math.min(...ends) : c.xCoil - COIL_W / 2) - 24;
      xb = Math.max(xe0 + 10, lim - Math.max(...kids.map(k => measureNode(k, false).w)));
    }
    if (hasSer) {
      const xTo = Math.max(xe0, n.coil ? endX(n) : xb !== null ? xb : xe0);
      out = drawSeries({ svg, rowY, where, accepts: "both" }, n.series, x, row, en, xTo);
      xe = xTo;
    }
    if (n.coil && n.coil.kind === "CALL") {                     // chiamata al posto della bobina
      const w = eltW(n.coil), xt = c.railR - 10 - w;
      lineWire(svg, xe, y, xt, y, out);
      drawCall(svg, n.coil, xt, y, Object.assign({ leaf: n }, where), out, w);
      return;
    }
    if (n.coil && n.coil.kind === "BOX") {                      // box numerico al posto della bobina
      const w = eltW(n.coil), xt = c.railR - 10 - w;
      lineWire(svg, xe, y, xt, y, out);
      drawBox(svg, n.coil, xt, y, Object.assign({ leaf: n }, where), out, w);
      return;
    }
    if (n.coil && isTimerObj(n.coil)) {                         // timer al posto della bobina
      const w = eltW(n.coil), xt = c.railR - 10 - w;
      lineWire(svg, xe, y, xt, y, out);
      drawTimer(svg, n.coil, xt, y, Object.assign({ leaf: n }, where), w);
      return;
    }
    if (n.coil) {
      lineWire(svg, xe, y, c.xCoil - COIL_W / 2, y, out);
      drawCoil(svg, n.coil, Object.assign({ leaf: n }, where), c.xCoil, y, out);
      lineWire(svg, c.xCoil + COIL_W / 2, y, c.railR, y, out);
      return;
    }
    if (kids.length === 1) { drawNode(c, kids[0], n, xe, row, out, true); return; }
    if (!kids.length) {
      const zw = Math.max(COIL_W, TMR_W), zx = c.railR - 10 - zw;
      // Network incompleto: la fine è aperta, si completa con una bobina, un timer, una FC o un box
      svg.appendChild(el("line", { x1: xe, y1: y, x2: zx, y2: y, class: "wire open-end" }));
      addDropzone(svg, zx, y - ZONE_H / 2, zw, ZONE_H, { kind: "open-end", node: n, accepts: "end", where });
      text(svg, zx + zw / 2, y - ZONE_H / 2 - 6, window.EspI18n ? EspI18n.t("bobina, timer, FC o box") : "bobina, timer, FC o box", "elt-label hint");
      return;
    }
    if (xb === null || xb < xe) xb = xe + 10;                   // punto di diramazione
    lineWire(svg, xe, y, xb, y, out);
    let r = row;
    const rows = kids.map(k => { const rr = r; r += measureNode(k, false).rows; return rr; });
    lineWire(svg, xb, y, xb, rowY(rows[rows.length - 1]), out);
    kids.forEach((k, i) => drawNode(c, k, n, xb, rows[i], out, false));
  }

  // Disegna una serie a partire da x sulla riga `row`; `en` = corrente in
  // ingresso. Allunga il filo fino a xTo. Ritorna la corrente in uscita.
  function drawSeries(ctx, s, x, row, en, xTo) {
    const { svg, rowY } = ctx;
    const y = rowY(row), cols = ctx.cols || null;              // cols: colonne del parallelo (solo per i suoi rami)
    if (!s.items.length) {
      const w = cols && cols.length ? Math.max(EMPTY_W, cols[0]) : EMPTY_W;
      lineWire(svg, x, y, x + w, y, en);
      addDropzone(svg, x + 6, y - ZONE_H / 2, w - 12, ZONE_H,
                  { kind: "gap", series: s, index: 0, accepts: ctx.accepts, where: ctx.where });
      if (xTo > x + w) lineWire(svg, x + w, y, xTo, y, en);
      return en;
    }
    let cur = en, prevEnd = x;                                   // prevEnd: dove finisce il riquadro dell'elemento prima
    const zones = [], opens = [], ends = [];
    s.items.forEach((it, i) => {
      parentOf.set(it, { series: s, index: i });
      if (it.type === "Open") { opens.push({ o: it, i, x, en: cur }); return; }   // disegnato dopo, sotto la linea
      const slot = cols ? cols[i] : measure(it).w;               // spazio dell'elemento (filo LEAD compreso)
      const ew = it.type === "Parallel" ? 0 : (it.type === "Contact" || it.type === "Slot" || it.type === "Not" || it.type === "Trig") ? slot - LEAD : eltW(it);
      lineWire(svg, x, y, x + LEAD, y, cur);
      let bx = x + LEAD, be;                                     // inizio e fine del riquadro disegnato
      if (it.type === "Contact" || it.type === "Slot") {
        // contatto (o segnaposto) della misura standard, centrato nella sua colonna
        const x0 = x + LEAD + (ew - BOX_W) / 2;
        if (x0 > x + LEAD) lineWire(svg, x + LEAD, y, x0, y, cur);
        if (it.type === "Slot") drawSlot(svg, it, x0, y);
        else { drawContact(svg, it, x0, y); cur = cur && contactVal(it); }
        bx = x0; be = x0 + BOX_W;
        if (be < x + LEAD + ew) lineWire(svg, be, y, x + LEAD + ew, y, cur);
      } else if (it.type === "Timer") {
        drawTimer(svg, it, x + LEAD, y, null, ew); be = x + LEAD + ew;
        cur = readBit(it.op);                                     // dopo il box la corrente è Q (TOF/TP: anche con EN spento)
      } else if (it.type === "Call") {
        drawCall(svg, it, x + LEAD, y, null, cur, ew); be = x + LEAD + ew;
        cur = cur && fcEnoOn(it.fc);                              // v4.8: dopo il box la corrente è l'ENO della FC
      } else if (it.type === "Compare") {
        drawCompare(svg, it, x + LEAD, y, ew, cur); be = x + LEAD + ew;
        cur = cur && cmpVal(it);
      } else if (it.type === "Box") {
        drawBox(svg, it, x + LEAD, y, null, cur, ew); be = x + LEAD + ew;   // ENO ≈ EN
      } else if (it.type === "Trig") {
        drawTrig(svg, it, x + LEAD, y); be = x + LEAD + BOX_W;
        cur = false;                                              // impulso di una scansione: non si vede
      } else if (it.type === "Not") {
        drawNot(svg, it, x + LEAD, y, cur); be = x + LEAD + BOX_W;
        cur = !cur;
      } else {
        cur = drawParallel(ctx, it, x + LEAD, row, cur);
        bx = x + LEAD - 6; be = x + measure(it).w;                // la zona si ferma prima della barra del parallelo
      }
      // selezione (Maiusc+clic): dove sta l'elemento; riquadro azzurro se è selezionato
      if (it.type !== "Slot") {
        const rows = it.type === "Parallel" ? measure(it).rows : 1;
        const h = { svg, series: s, index: i, x0: bx, x1: be, y0: y - BOX_H / 2 - 4, y1: y + (rows - 1) * ROW_H + BOX_H / 2 + 4 };
        selHits.push(h);
        if (sel && sel.series === s && i >= sel.a && i <= sel.b)
          svg.appendChild(el("rect", { x: h.x0 - 3, y: h.y0 - 2, width: h.x1 - h.x0 + 6, height: h.y1 - h.y0 + 4, rx: 5, class: "sel-box" }));
      }
      // zona di rilascio fra l'elemento prima e questo: tutto lo spazio libero, alta come le altre
      zones.push([prevEnd + 4, bx - 4, i, (it.type === "Contact" || it.type === "Compare") ? { x0: bx, x1: be } : null]);
      ends.push({ i, x: Math.min(be, x + slot) });
      const end = x + slot;
      if (be < end && it.type !== "Contact" && it.type !== "Slot" && it.type !== "Parallel") lineWire(svg, be, y, end, y, cur);
      prevEnd = Math.min(be, end); x = end;                       // fine elemento
    });
    zones.forEach(([z0, z1, i, next]) => addDropzone(svg, Math.min(z0, z1 - 8), y - ZONE_H / 2, Math.max(8, z1 - z0), ZONE_H,
                                               { kind: "gap", series: s, index: i, accepts: ctx.accepts, where: ctx.where, next }));
    // zona "in fondo alla serie": tutto il filo fino a dove la serie finisce
    const xEnd = x;
    const endW = Math.max(16, (xTo > xEnd ? xTo : xEnd + 24) - prevEnd - 8);
    addDropzone(svg, prevEnd + 4, y - ZONE_H / 2, endW, ZONE_H,
                { kind: "gap", series: s, index: s.items.length, accepts: ctx.accepts, where: ctx.where });
    if (xTo > xEnd) lineWire(svg, xEnd, y, xTo, y, cur);
    opens.forEach(op => drawOpen(ctx, s, op, row, ends));
    return cur;
  }
  // Ramo parallelo aperto: parte dalla linea e scende sotto gli elementi dopo; finisce con la freccia.
  // Si chiude trascinando la freccia su un punto della linea (o col tasto destro sulla freccia); con una bobina in fondo
  // diventa un'uscita. Aperto e senza niente in fondo: Compile lo segnala
  function drawOpen(ctx, s, op, row, ends) {
    const { svg, rowY } = ctx, o = op.o;
    const r = row + (openRow.get(o) || 1), y = rowY(row), yb = rowY(r);
    const n0 = svg.children.length;
    parentOf.set(o.branch, { open: o });
    lineWire(svg, op.x, y, op.x, yb, op.en);
    const bw = measure(o.branch).w;
    const xa = op.x + bw + OPEN_END;                              // la zona in fondo al ramo, poi la freccia
    drawSeries(Object.assign({}, ctx, { cols: null, accepts: "both", where: Object.assign({}, ctx.where, { open: o, openSeries: s }) }), o.branch, op.x, r, op.en, xa);
    const pts = ends.filter(e => e.i > op.i).map(e => ({ x: e.x + 3, y, j: e.i }));   // dove si può chiudere: dopo ogni elemento
    const g = el("g", { class: "open-arrow" });
    const aw = OPEN_ARROW - OPEN_END;
    g.appendChild(el("line", { x1: xa, y1: yb, x2: xa + aw - 8, y2: yb, class: "wire" }));
    g.appendChild(el("path", { d: `M${xa + aw - 16} ${yb - 7} L${xa + aw - 6} ${yb} L${xa + aw - 16} ${yb + 7}`, class: "wire" }));
    g.appendChild(el("rect", { x: xa - 2, y: yb - 12, width: aw + 4, height: 24, class: "open-grab" }));
    const tt = el("title", {}); tt.textContent = pts.length ? "ramo aperto: trascina la freccia sulla linea dove chiuderlo (o tasto destro)" : "ramo aperto: mettici una bobina in fondo"; g.appendChild(tt);
    svg.appendChild(g);
    if (!o._ghost) {
      if (openDrag && openDrag.o === o) openDragMarks(svg, pts);  // il disegno è stato rifatto durante il trascinamento
      g.addEventListener("mousedown", e => { if (e.button === 0 && pts.length) { e.preventDefault(); openDragStart(svg, s, o, pts); } });
      g.addEventListener("contextmenu", e => {
        e.preventDefault(); e.stopPropagation();
        const lab = it => it.type === "Contact" || it.type === "Timer" ? varKey(it.op) : it.type === "Compare" ? "confronto " + it.cmp : it.type === "Box" ? it.box : it.type === "Call" ? "FC" + it.fc : it.type === "Parallel" ? "parallelo" : it.type;
        showMenu(e.clientX, e.clientY, null, [
          ...pts.map(p => ({ label: `⤴ Chiudi il ramo dopo ${lab(s.items[p.j])}`, run: () => openClose(s, op.i, p.j) })),
          ...(pts.length ? ["-"] : []),
          { label: "✕ Elimina il ramo aperto", danger: true, run: () => edit(() => { s.items.splice(op.i, 1); }) }]);
      });
    }
    if (o._ghost) {                                              // anteprima del trascinamento
      [...svg.children].slice(n0).forEach(c => c.classList.add("par-ghost"));
      o._geo = { svg, x: op.x, xR: xa + aw, y: yb };
    }
  }
  // chiude il ramo aperto (in s alla posizione i) dopo l'elemento j: diventa il parallelo dei contatti i+1..j
  function openClose(s, i, j) {
    edit(() => {
      const o = s.items[i], main = s.items.slice(i + 1, j + 1);
      s.items.splice(i, j - i + 1, mkParallel([mkSeries(main), mkSeries(o.branch.items)]));
    });
  }
  // trascinamento della freccia: il punto della linea più vicino si accende, al rilascio il ramo si chiude lì.
  // Lo stato sta fuori dal disegno: se il disegno si rifà durante il trascinamento (Online, il giro di stato dopo una
  // modifica), drawOpen rimette i punti nel disegno nuovo e il calcolo continua lì
  let openDrag = null;                                           // { s, o, svg, pts, marks, best }
  function openDragMarks(svg, pts) {
    const D = openDrag;
    D.marks.forEach(m => m.remove());
    D.svg = svg; D.pts = pts;
    D.marks = pts.map((p, k) => { const c = el("circle", { cx: p.x, cy: p.y, r: 7, class: "close-pt" + (k === D.best ? " on" : "") }); svg.appendChild(c); return c; });
  }
  function openDragStart(svg, s, o, pts) {
    openDrag = { s, o, svg, pts, marks: [], best: -1 };
    openDragMarks(svg, pts);
    const move = e => {
      const D = openDrag; if (!D) return;
      const p = svgPoint(e, D.svg);
      let d = Infinity; D.best = -1;
      D.pts.forEach((q, k) => { const dd = Math.hypot(p.x - q.x, p.y - q.y); if (dd < d) { d = dd; D.best = k; } });
      if (d > 90) D.best = -1;
      D.marks.forEach((m, k) => m.classList.toggle("on", k === D.best));
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      const D = openDrag; openDrag = null;
      D.marks.forEach(m => m.remove());
      const i = D.s.items.indexOf(D.o);
      if (D.best >= 0 && i >= 0) openClose(D.s, i, D.pts[D.best].j);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }
  // Uscita «?» (uscita parallela nuova): si sostituisce trascinandoci sopra bobina, timer, FC o box, oppure con un
  // clic e un tasto: B bobina, / negata, S set, R reset, T timer TON
  function drawCoilSlot(svg, coil, where, x, y) {
    parentOf.set(coil, where);
    const rect = el("rect", { x: x - COIL_W / 2, y: y - BOX_H / 2, width: COIL_W, height: BOX_H, class: "coil-box unset slot", rx: 8 });
    if (coil === slotSel) rect.classList.add("editing");
    rect.addEventListener("click", e => { e.stopPropagation(); slotSel = coil; render(); openSlotMenu(e.clientX, e.clientY, coil); });
    rect.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); openCoilMenu(e.clientX, e.clientY, coil); });
    rect.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    rect.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation(); clearCandidates();
      if (dropDedup()) return;
      slotPut(coil, e.dataTransfer.getData("element-type"));
    });
    svg.appendChild(rect);
    text(svg, x, y + SYM_DY, "?", "elt-sym slot-q");
    const tt = el("title", {}); tt.textContent = "da scegliere: trascina qui una bobina, un timer, una FC o un box, oppure clic e B, /, S, R, T"; rect.appendChild(tt);
  }
  // Segnaposto («?»): elemento ancora da scegliere (ramo parallelo nuovo). Si sostituisce trascinandoci sopra un
  // elemento dal menu, oppure con un clic e un tasto: A contatto NA, C contatto NC, P / N fronte, > confronto, ! NOT
  function drawSlot(svg, sl, x, y) {
    const rect = el("rect", { x, y: y - BOX_H / 2, width: BOX_W, height: BOX_H, class: "contact-box unset slot", rx: 4 });
    if (sl === slotSel) rect.classList.add("editing");
    rect.addEventListener("click", e => { e.stopPropagation(); slotSel = sl; render(); openSlotMenu(e.clientX, e.clientY, sl); });
    rect.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); openContactMenu(e.clientX, e.clientY, sl); });
    rect.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    rect.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation(); clearCandidates();
      if (dropDedup()) return;
      const elt = e.dataTransfer.getData("element-type");
      if (parDrop(elt)) return;
      slotPut(sl, elt);
    });
    svg.appendChild(rect);
    text(svg, x + BOX_W / 2, y + SYM_DY, "?", "elt-sym slot-q");
    const tt = el("title", {}); tt.textContent = "da scegliere: trascina qui un elemento, oppure clic e A, C, P, N, >, !"; rect.appendChild(tt);
  }
  // Parallelo: barra sinistra a x, rami uno sotto l'altro, barra destra.
  function drawParallel(ctx, p, x, row, en) {
    const { svg, rowY } = ctx;
    const m = measure(p);
    const inner = m.w - LEAD - PAR_TAIL;          // larghezza del ramo più lungo
    const xR = x + inner + PAR_TAIL - Math.min(8, PAR_TAIL / 3);   // barra destra
    let r = row, any = false, n0 = 0;
    const rows = [];
    const bctx = Object.assign({}, ctx, { accepts: "contact", cols: parCols(p) });   // nei rami solo contatti, colonne allineate
    p.branches.forEach((b, bi) => {
      if (p._ghost && bi === p.branches.length - 1) n0 = svg.children.length;   // da qui: il ramo provvisorio
      parentOf.set(b, { parallel: p, branch: bi });
      rows.push(r);
      const out = drawSeries(bctx, b, x, r, en, xR);
      any = any || out;
      r += measure(b).h;
    });
    const out = en && any;
    lineWire(svg, x, rowY(row), x, rowY(rows[rows.length - 1]), en);
    lineWire(svg, xR, rowY(row), xR, rowY(rows[rows.length - 1]), out);
    lineWire(svg, xR, rowY(row), x + inner + PAR_TAIL, rowY(row), out);
    if (p._ghost) {                                              // anteprima del parallelo trascinando
      [...svg.children].slice(n0).forEach(c => c.classList.add("par-ghost"));
      p._geo = { svg, x, xR, y: rowY(rows[rows.length - 1]) };
    }
    return out;
  }

  function drawContact(svg, contact, x, y) {
    const live = showLive() && contactVal(contact);
    const rect = el("rect", { x, y: y - BOX_H / 2, width: BOX_W, height: BOX_H, class: "contact-box", rx: 4 });
    const editing = (!pickerForCoil && contact === pickerTarget) || contact === forceNode || contact === ctxNode;
    if (live) rect.classList.add("live");
    if (contact.unset) rect.classList.add("unset");
    if (editing) rect.classList.add("editing");
    else if (sameAsForce(contact.op)) rect.classList.add("same-ref");
    if (contact === flashNode) { rect.classList.add("flash"); flashRect = rect; }
    rect.addEventListener("click", () => openPicker(contact, false));
    rect.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      if (liveMonitoring) openForceMenu(e.clientX, e.clientY, contact, contact.op);
      else openContactMenu(e.clientX, e.clientY, contact);
    });
    svg.appendChild(rect);
    const xa = x + BOX_W * 0.37, xb = x + BOX_W * 0.63, hh = BOX_H * 0.3;
    line(svg, xa, y - hh, xa, y + hh, "wire");
    line(svg, xb, y - hh, xb, y + hh, "wire");
    if (contact.negated) line(svg, xa, y + hh, xb, y - hh, "wire");
    if (contact.edge) text(svg, x + BOX_W / 2, y + SYM_DY, contact.edge, "elt-sym edge-sym");
    opLabel(svg, x + BOX_W / 2, y, contact.op, editing, contact.unset ? "unset" : contact._fresh);
    opTip(rect, contact, contact.op, contact.edge ? `fronte ${contact.edge === "P" ? "di salita" : "di discesa"} · memoria ${contact.mem ? (contact.mem.ns === "E" ? "automatica (E" + contact.mem.idx + ")" : "M" + contact.mem.idx) : "automatica"}`
                                            : contact.negated ? "contatto NC" : "contatto NA");
  }

  // Box timer (in linea o, con `where`, al posto della bobina)
  //   T5 sopra, dentro: tipo e PT; Online: verde con Q=1 e barra del tempo trascorso.
  function drawTimer(svg, t, x, y, where, w) {
    w = w || TMR_W;
    const q = showLive() && readBit(t.op);
    const editing = t === pickerTarget || t === forceNode || t === ctxNode;
    const top = y - BOX_H / 2;
    const rect = el("rect", { x, y: top, width: w, height: BOX_H, class: "timer-box", rx: 4 });
    if (q) rect.classList.add("live");
    if (t.unset) rect.classList.add("unset");
    if (editing) rect.classList.add("editing");
    else if (sameAsForce(t.op)) rect.classList.add("same-ref");
    if (t === flashNode) { rect.classList.add("flash"); flashRect = rect; }
    rect.addEventListener("click", () => openPicker(t, !!where));
    rect.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      if (liveMonitoring) openForceMenu(e.clientX, e.clientY, t, t.op);
      else if (where) openCoilMenu(e.clientX, e.clientY, t);
      else openContactMenu(e.clientX, e.clientY, t);
    });
    svg.appendChild(rect);
    const fs = Math.max(8, Math.round(LABEL_SIZE * 0.95));
    const small = el("text", { x: x + 6, y: top + fs + 1, class: "timer-kind" });
    small.textContent = t.kind; small.style.fontSize = fs + "px"; svg.appendChild(small);
    const inl = el("text", { x: x + 4, y: y + fs * 0.35 + 2, class: "timer-pin" }); inl.textContent = "IN";
    inl.style.fontSize = Math.max(7, fs - 3) + "px";
    const qtx = el("text", { x: x + w - 4, y: y + fs * 0.35 + 2, class: "timer-pin end" }); qtx.textContent = "Q";
    qtx.style.fontSize = Math.max(7, fs - 3) + "px";
    if (BOX_H >= 30) { svg.appendChild(inl); svg.appendChild(qtx); }
    // tempo: PT, oppure in Online "trascorso / PT"
    const info = showLive() && (isMemOp(t.op) ? (t.op.ns === "DB" && liveNum.has(opKey({ ns: "DB", db: t.op.db, f: t.op.f + ".ET" }))
        ? { et: liveNum.get(opKey({ ns: "DB", db: t.op.db, f: t.op.f + ".ET" })), q: !!liveNum.get(opKey({ ns: "DB", db: t.op.db, f: t.op.f + ".Q" })) } : null)
      : liveTimers.get(t.op.idx));
    let ptText = t.ptOp ? memText(t.ptOp) : formatPT(t.pt);
    if (info && (info.et > 0 || info.q)) ptText = `${formatPT(info.et)} / ${t.ptOp ? memText(t.ptOp) : formatPT(t.pt)}`;
    const pt = el("text", { x: x + w / 2, y: top + BOX_H - 4, class: "timer-pt" });
    pt.textContent = (t._fresh || t.unset) && editing ? "PT ?" : ptText; pt.style.fontSize = fs + "px"; svg.appendChild(pt);
    { const len = pt.getComputedTextLength ? pt.getComputedTextLength() : 0;   // PT da una variabile: testo intero, più piccolo
      if (len > w - 6) pt.style.fontSize = Math.max(6, fs * (w - 6) / len) + "px"; }
    if (info && t.pt > 0 && info.et > 0) {
      const bw = Math.min(1, info.et / t.pt) * (w - 4);
      svg.appendChild(el("rect", { x: x + 2, y: top + BOX_H - 3, width: bw, height: 2, class: "timer-bar" }));
    }
    opLabel(svg, x + w / 2, y, t.op, editing, t._fresh || t.unset, w + LEAD - 4);
    opTip(rect, t, t.op, `timer ${t.kind} · PT ${t.ptOp ? memText(t.ptOp) : formatPT(t.pt)}`);
    if (where) {
      parentOf.set(t, where);
      // bobina o timer trascinati sopra: sostituiscono l'elemento finale
      const meta = { kind: "coil", coil: t, accepts: "end", where };
      rect.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      rect.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation(); clearCandidates();
        if (dropDedup()) return;
        const elt = e.dataTransfer.getData("element-type");
        if (!accepts(meta, elt)) { setStatusLine("qui si può rilasciare una bobina o un timer", "warn"); return; }
        onDropPalette(elt, meta);
      });
      dropZones.push({ svg, rect, meta, cx: x + w / 2, cy: y });
    }
  }

  // Box chiamata funzione: sopra il nome del blocco, dentro FCn con EN/ENO.
  // Clic = scegli la funzione, doppio clic = apri la funzione.
  function drawCall(svg, c, x, y, where, en, w) {
    w = w || TMR_W;
    const fb = project.blocks.find(b => b.type === "fc" && b.number === c.fc);
    const editing = c === pickerTarget || c === ctxNode || c === callTarget;
    const top = y - BOX_H / 2, g = callGeom(c);
    const x0 = x, w0 = w;
    if (g) { x = x0 + g.lw + Math.max(0, (w0 - g.w) / 2); w = g.boxW; }      // il box tra gli operandi
    const rect = el("rect", { x, y: top, width: w, height: g ? g.boxPx : BOX_H, class: "call-box", rx: 4 });
    if (showLive() && en) rect.classList.add("live");
    if (editing) rect.classList.add("editing");
    if (c === flashNode) { rect.classList.add("flash"); flashRect = rect; }
    // clic = popup (dopo una breve attesa), doppio clic = apre la funzione
    let clickTimer = 0;
    rect.addEventListener("click", e => {
      if (e.detail > 1) return;
      clickTimer = setTimeout(() => fcParams(fb).length ? openCallDialog(c) : openPicker(c, !!where), 260);
    });
    rect.addEventListener("dblclick", e => { e.preventDefault(); clearTimeout(clickTimer); if (fb) setBlock(fb.id); });
    rect.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      if (liveMonitoring) openForceMenu(e.clientX, e.clientY, c, null);
      else if (where) openCoilMenu(e.clientX, e.clientY, c);
      else openContactMenu(e.clientX, e.clientY, c);
    });
    const eno = !!en && fcEnoOn(c.fc);                  // v4.8: ENO vero della FC (Online)
    if (showLive() && en && !eno) rect.classList.add("eno-off");
    if (g) { lineWire(svg, x0, y, x, y, en); lineWire(svg, x + w, y, x0 + w0, y, eno); }   // EN e ENO
    svg.appendChild(rect);
    const fs = Math.max(8, Math.round(LABEL_SIZE * 0.95));
    const t1 = el("text", { x: x + w / 2, y: y + fs * 0.35, class: "call-title" });
    t1.textContent = (EspIR.isFB(fcOf(c.fc)) ? "FB" : "FC") + c.fc; t1.style.fontSize = (fs + 1) + "px"; svg.appendChild(t1);
    if (g) {
      const pin = (p, i, left) => {
        const py = top + BOX_H + i * g.pinH + g.pinH / 2 + 2, bx = left ? x : x + w;
        svg.appendChild(el("line", { x1: left ? bx - 8 : bx, y1: py, x2: left ? bx : bx + 8, y2: py, class: "wire" }));
        const pn = el("text", { x: left ? bx + 4 : bx - 4, y: py + g.pfs * 0.35, class: "timer-pin" + (left ? "" : " end") });
        pn.textContent = g.pinName(p); pn.style.fontSize = g.pfs + "px"; svg.appendChild(pn);
        const av = g.a[p.name], isVar = !!av && typeof av.k !== "number" && typeof av.k !== "boolean";
        const val = isVar && showLive() ? (p.type === "BOOL" ? readBit(av) : odVal(av)) : undefined;
        const ot = el("text", { x: left ? bx - 10 : bx + 10, y: py + g.fs * 0.35, class: "num-expr call-op" + (g.a[p.name] ? "" : " unset") });
        ot.style.fontSize = g.fs + "px"; ot.style.textAnchor = left ? "end" : "start";
        ot.textContent = g.opTxt(p) + (val !== undefined ? ` = ${typeof val === "boolean" ? (val ? 1 : 0) : fmtNum(val, numT(g.a[p.name]) === "REAL")}` : "");
        svg.appendChild(ot);
        if (isVar) { ot.style.pointerEvents = "all"; opTip(ot, g.a[p.name], g.a[p.name], `${p.name} · ${DIR_TXT[p.dir]} ${p.type}`); }
      };
      g.L.forEach((p, i) => pin(p, i, true));
      g.R.forEach((p, i) => pin(p, i, false));
    }
    if (BOX_H >= 30) {
      const pinY = top + BOX_H - 4, pfs = Math.max(7, fs - 3) + "px";
      const en1 = el("text", { x: x + 4, y: pinY, class: "timer-pin" }); en1.textContent = "EN"; en1.style.fontSize = pfs; svg.appendChild(en1);
      const en2 = el("text", { x: x + w - 4, y: pinY, class: "timer-pin end" }); en2.textContent = "ENO"; en2.style.fontSize = pfs; svg.appendChild(en2);
    }
    const lab = fb ? (fb.name && fb.name !== "FC" + fb.number ? fb.name : "FC" + fb.number) : "FC" + c.fc + " mancante";
    text(svg, x + w / 2, y - LABEL_DY, lab, "elt-label" + (editing ? " editing" : "") + (fb ? "" : " missing"));
    if (g) { x = x0; w = w0; }
    if (where) {
      parentOf.set(c, where);
      const meta = { kind: "coil", coil: c, accepts: "end", where };
      rect.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      rect.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation(); clearCandidates();
        if (dropDedup()) return;
        const elt = e.dataTransfer.getData("element-type");
        if (!accepts(meta, elt)) { setStatusLine("qui si può rilasciare una bobina, un timer o una funzione", "warn"); return; }
        onDropPalette(elt, meta);
      });
      dropZones.push({ svg, rect, meta, cx: x + w / 2, cy: y });
    }
  }

  // ── v3.1: confronto (come un contatto), box numerico (EN/ENO), fronte sulla corrente ──
  function numRect(svg, node, x, y, w, cls, onClick) {
    const editing = node === npTarget || node === ctxNode || node === forceNode || node === pickerTarget;
    const rect = el("rect", { x, y: y - BOX_H / 2, width: w, height: BOX_H, class: cls, rx: 4 });
    if (node.unset) rect.classList.add("unset");
    if (editing) rect.classList.add("editing");
    if (node === flashNode) { rect.classList.add("flash"); flashRect = rect; }
    rect.addEventListener("click", onClick);
    svg.appendChild(rect);
    return { rect, editing };
  }
  function numMenu(e, node, where) {
    e.preventDefault(); e.stopPropagation(); hideTip();
    if (liveMonitoring) openNumForceMenu(e.clientX, e.clientY, node);
    else if (where) openCoilMenu(e.clientX, e.clientY, node);
    else openContactMenu(e.clientX, e.clientY, node);
  }
  // un menu aperto: niente commento flottante sopra
  const menuOpen = () => !document.getElementById("ctxmenu").classList.contains("hidden") || !document.getElementById("forcemenu").classList.contains("hidden");
  function numTip(rect, node, head, body) {
    rect._tip = true;
    rect.addEventListener("mousedown", hideTip);
    rect.addEventListener("mouseenter", ev => {
      if (!EspSymbols.floatTip() || menuOpen()) return;
      const t = document.getElementById("optip");
      const ops = [node.a, node.b, node.c, node.d, node.e, node.out].filter(isNumVar);
      const rows = ops.map(o => { const mm = isMemOp(o), sy = mm ? memVar(o) : EspSymbols.get(o.ns + o.idx), v = liveNum.get(opKey(o));
        return `<div class="tt-com"><b>${escapeHtml(mm ? (o.ns === "DB" ? memAbs(o) + " " + memSym(o) : memSym(o)) : o.ns + o.idx)}</b> ${numT(o)}${!mm && sy && sy.name ? ` "${escapeHtml(sy.name)}"` : ""}` +
               `${sy && sy.comment ? " — " + U(escapeHtml(sy.comment)) : ""}${showLive() && v !== undefined ? ` · Online: <b>${fmtNum(v, numT(o) === "REAL")}</b>` : ""}</div>`; }).join("");
      t.innerHTML = `<div class="tt-head"><b>${escapeHtml(head)}</b></div>${rows}<div class="tt-kind">${escapeHtml(body)}</div>`;
      t.classList.remove("hidden"); placeTip(ev.clientX, ev.clientY);
    });
    rect.addEventListener("mousemove", ev => placeTip(ev.clientX, ev.clientY));
    rect.addEventListener("mouseleave", hideTip);
  }
  // box tra le colonne degli operandi (come drawCall): titolo nel box, sotto i pin; → { rect, editing, x, w } del box
  function pinBox(svg, n, x0, y, w0, cls, onClick, enIn, enOut, pinTop) {
    const g = boxGeom(n), top = y - BOX_H / 2;
    const x = x0 + g.lw + Math.max(0, (w0 - g.w) / 2), w = g.boxW;
    const editing = n === npTarget || n === ctxNode || n === forceNode || n === pickerTarget;
    const rect = el("rect", { x, y: top, width: w, height: g.boxPx, class: cls, rx: 4 });
    if (n.unset) rect.classList.add("unset");
    if (editing) rect.classList.add("editing");
    if (n === flashNode) { rect.classList.add("flash"); flashRect = rect; }
    rect.addEventListener("click", onClick);
    lineWire(svg, x0, y, x, y, enIn); lineWire(svg, x + w, y, x0 + w0, y, enOut);   // corrente che entra ed esce
    svg.appendChild(rect);
    const t1 = el("text", { x: x + w / 2, y: y + g.fs * 0.35, class: "call-title" });
    t1.textContent = g.title; t1.style.fontSize = (g.fs + 1) + "px"; svg.appendChild(t1);
    const pin = ([name, o], i, left) => {
      const py = top + BOX_H + i * g.pinH + g.pinH / 2 + 2, bx = left ? x : x + w;
      svg.appendChild(el("line", { x1: left ? bx - 8 : bx, y1: py, x2: left ? bx : bx + 8, y2: py, class: "wire" }));
      const pn = el("text", { x: left ? bx + 4 : bx - 4, y: py + g.pfs * 0.35, class: "timer-pin" + (left ? "" : " end") });
      pn.textContent = name; pn.style.fontSize = g.pfs + "px"; svg.appendChild(pn);
      const v = showLive() && o && !isKonst(o) ? (isNumVar(o) ? odVal(o) : readBit(o)) : undefined;
      const ot = el("text", { x: left ? bx - 10 : bx + 10, y: py + g.fs * 0.35, class: "num-expr call-op" + (o ? "" : " unset") });
      ot.style.fontSize = g.fs + "px"; ot.style.textAnchor = left ? "end" : "start";
      ot.textContent = (pinOpText(o) || "?") + (v !== undefined ? ` = ${typeof v === "boolean" ? (v ? 1 : 0) : fmtNum(v, isNumVar(o) && numT(o) === "REAL")}` : "");
      svg.appendChild(ot);
    };
    g.L.forEach((p, i) => pin(p, i, true));
    g.R.forEach((p, i) => pin(p, i, false));
    if (pinTop && BOX_H >= 30) {                         // EN/ENO (o CU/Q dei contatori) in alto nel box
      const pinY = top + BOX_H - 4, pfs = g.pfs + "px";
      const a1 = el("text", { x: x + 4, y: pinY, class: "timer-pin" }); a1.textContent = pinTop[0]; a1.style.fontSize = pfs; svg.appendChild(a1);
      const a2 = el("text", { x: x + w - 4, y: pinY, class: "timer-pin end" }); a2.textContent = pinTop[1]; a2.style.fontSize = pfs; svg.appendChild(a2);
    }
    return { rect, editing, x, w };
  }
  function drawCompare(svg, c, x, y, w, en) {
    w = w || TMR_W;
    const on = showLive() && !!en && cmpVal(c);
    const { rect, editing, x: bx, w: bw } = pinBox(svg, c, x, y, w, "cmp-box", () => openNumPicker(c, false), en, on, null);
    if (on) rect.classList.add("live");
    rect.addEventListener("contextmenu", e => numMenu(e, c, null));
    text(svg, bx + bw / 2, y - LABEL_DY, cmpType(c), "elt-label" + (editing ? " editing" : ""));
    numTip(rect, c, `Confronto ${c.cmp} (${cmpType(c) || "tipo?"})`, "vero se la condizione è soddisfatta: come un contatto");
  }
  function liveLine(svg, cx, y, txt, w) {
    const t = text(svg, cx, y + BOX_H / 2 + Math.max(10, LABEL_SIZE), txt, "num-live");
    fitText(t, (w || TMR_W) + LEAD);
  }
  function drawBox(svg, b, x, y, where, en, w) {
    w = w || TMR_W;
    const pinTop = isCounter(b) ? (b.box === "CTD" ? ["CD", "Q"] : b.box === "CTUD" ? ["CU", "QU"] : ["CU", "Q"]) : ["EN", "ENO"];
    const { rect, editing, x: bx, w: bw } = pinBox(svg, b, x, y, w, "num-box", () => openNumPicker(b, !!where), en, en, pinTop);
    if (showLive() && en) rect.classList.add("live");
    rect.addEventListener("contextmenu", e => numMenu(e, b, where));
    const ty = boxType(b);
    text(svg, bx + bw / 2, y - LABEL_DY, boxTitle(b), "elt-label" + (editing ? " editing" : ""));   // sopra il box, non sopra box + operandi
    numTip(rect, b, `${b.box} — ${BOX_TXT[b.box] || ""} (${ty || "tipo?"})`, b.box === "CONV" && isNumVar(b.out)
      ? ["esegue con EN = 1", ...convNotes(isNumVar(b.a) ? numT(b.a) : "REAL", numT(b.out), isNumVar(b.a) ? undefined : b.a && b.a.k)].join(". ")
      : (BOX_NOTE[b.box] || "esegue con EN = 1"));
    if (where) {
      parentOf.set(b, where);
      const meta = { kind: "coil", coil: b, accepts: "end", where };
      rect.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
      rect.addEventListener("drop", e => {
        e.preventDefault(); e.stopPropagation(); clearCandidates();
        if (dropDedup()) return;
        const elt = e.dataTransfer.getData("element-type");
        if (!accepts(meta, elt)) { setStatusLine("qui si può rilasciare una bobina, un timer, una funzione o un box", "warn"); return; }
        onDropPalette(elt, meta);
      });
      dropZones.push({ svg, rect, meta, cx: x + w / 2, cy: y });
    }
  }
  const WRAP = "fuori dal campo del tipo il valore ricomincia (es. INT 32767 + 1 = −32768), ENO = 0, nessun errore; REAL infinito: ENO = 0";
  const DIV0 = "IN2 = 0: OUT invariato, ENO = 0, avviso in diagnostica e SF finché si ripete";
  const BOX_NOTE = {
    MOVE: "esegue con EN = 1: OUT = IN, stesso tipo (per cambiare tipo: CONV)",
    ADD: "esegue con EN = 1: OUT = IN1 + IN2; " + WRAP, SUB: "esegue con EN = 1: OUT = IN1 − IN2; " + WRAP,
    MUL: "esegue con EN = 1: OUT = IN1 × IN2; " + WRAP,
    DIV: "esegue con EN = 1: OUT = IN1 / IN2; negli interi il risultato è troncato verso lo zero (7 / 2 = 3). " + DIV0,
    MOD: "esegue con EN = 1: resto di IN1 / IN2 col segno di IN1 (−7 mod 2 = −1), solo interi. " + DIV0,
    NEG: "esegue con EN = 1: OUT = −IN (INT, DINT, REAL). Il minimo del tipo non ha opposto (INT −32768): ricomincia, ENO = 0",
    ABS: "esegue con EN = 1: OUT = valore assoluto di IN (INT, DINT, REAL). Il minimo del tipo (INT −32768): ricomincia, ENO = 0",
    CTU: "conta i fronti di salita di CU (la corrente che arriva): CV + 1 · R = 1: CV = 0 · Q = CV ≥ PV. Si ferma al massimo del tipo. CV in un DB ritentivo: il conteggio resta allo spegnimento",
    CTD: "conta all'indietro i fronti di salita di CD (la corrente che arriva): CV − 1 · LD = 1: CV = PV · Q = CV ≤ 0. Si ferma al minimo del tipo",
    CTUD: "CU (la corrente) conta avanti, il bit CD indietro (fronti di salita) · R = 1: CV = 0, poi LD = 1: CV = PV · QU = CV ≥ PV (per QD usa un confronto CV ≤ 0)",
    MIN: "esegue con EN = 1: OUT = il minore", MAX: "esegue con EN = 1: OUT = il maggiore",
    LIMIT: "esegue con EN = 1: OUT = IN tenuto tra MN e MX. Va messo nell'ultimo punto prima di usare il valore: se dopo un altro segmento riscrive la variabile, il limite non vale più. MN > MX: OUT invariato, ENO = 0",
    SQRT: "esegue con EN = 1; IN negativo: OUT invariato, ENO = 0", SQR: "esegue con EN = 1; troppo grande: ENO = 0",
    SCALE: "esegue con EN = 1: OUT = (IN − IN_MIN) · (OUT_MAX − OUT_MIN) / (IN_MAX − IN_MIN) + OUT_MIN; verso un intero arrotonda. IN fuori da IN_MIN..IN_MAX: OUT limitato, ENO = 0; IN_MIN = IN_MAX: OUT invariato, ENO = 0",
    AND: "esegue con EN = 1: bit per bit", OR: "esegue con EN = 1: bit per bit", XOR: "esegue con EN = 1: bit per bit", INV: "esegue con EN = 1: ogni bit invertito",
    SHL: "esegue con EN = 1: entrano zeri a destra; N ≥ numero di bit: 0", SHR: "esegue con EN = 1: INT e DINT col segno, gli altri entrano zeri; N ≥ numero di bit: 0 (o −1 se negativo)",
    ROL: "esegue con EN = 1: i bit che escono rientrano dall'altra parte", ROR: "esegue con EN = 1: i bit che escono rientrano dall'altra parte",
    SWAP: "esegue con EN = 1: WORD/INT ab → ba, DWORD/DINT abcd → dcba (dati da e verso altri apparecchi)",
  };
  function drawTrig(svg, t, x, y) {
    const { rect, editing } = numRect(svg, t, x, y, BOX_W, "trig-box", () => openNumPicker(t, false));
    rect.addEventListener("contextmenu", e => numMenu(e, t, null));
    text(svg, x + BOX_W / 2, y + SYM_DY, t.edge, "elt-sym edge-sym");
    text(svg, x + BOX_W / 2, y - LABEL_DY, `${t.edge}_TRIG`, "elt-label" + (editing ? " editing" : ""));
    numTip(rect, t, `${t.edge}_TRIG — fronte ${t.edge === "P" ? "di salita" : "di discesa"} della corrente`,
           `vero per una scansione quando la corrente che arriva ${t.edge === "P" ? "passa da 0 a 1" : "passa da 1 a 0"} · memoria ${t.mem ? (t.mem.ns === "E" ? "automatica" : "M" + t.mem.idx) : "automatica"}`);
  }

  // v4.6: NOT (inverte la corrente)
  function drawNot(svg, t, x, y, en) {
    const { rect } = numRect(svg, t, x, y, BOX_W, "trig-box", () => {});
    if (showLive() && !en) rect.classList.add("live");
    rect.addEventListener("contextmenu", e => numMenu(e, t, null));
    text(svg, x + BOX_W / 2, y + SYM_DY, "NOT", "elt-sym edge-sym");
    numTip(rect, t, "NOT — inverte la corrente", "la corrente che arriva viene invertita: 1 → 0, 0 → 1");
  }

  function drawCoil(svg, coil, where, x, yMid, en) {
    if (coil.kind === "SLOT") { drawCoilSlot(svg, coil, where, x, yMid); return; }
    const live = showLive() && readBit(coil.op);
    const rect = el("rect", { x: x - COIL_W / 2, y: yMid - BOX_H / 2, width: COIL_W, height: BOX_H, class: "coil-box", rx: 8 });
    const editing = (pickerForCoil && coil === pickerTarget) || coil === forceNode || coil === ctxNode;
    if (live) rect.classList.add("live");
    if (coil.unset) rect.classList.add("unset");
    if (editing) rect.classList.add("editing");
    else if (sameAsForce(coil.op)) rect.classList.add("same-ref");
    if (coil === flashNode) { rect.classList.add("flash"); flashRect = rect; }
    parentOf.set(coil, where);           // { leaf, parent, node, rung, segIdx, rungIdx }
    const isRet = coil.kind === "RET";
    if (isRet && showLive() && en) rect.classList.add("live");
    rect.addEventListener("click", e => { if (!isRet) openPicker(coil, true); else { e.stopPropagation(); openRetMenu(e.clientX, e.clientY, coil); } });
    rect.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      if (liveMonitoring && !isRet) openForceMenu(e.clientX, e.clientY, coil, coil.op);
      else openCoilMenu(e.clientX, e.clientY, coil);
    });
    svg.appendChild(rect);
    const rm = isRet ? (coil.ret || "ret") : "";
    const sym = coil.kind === "set" ? "(S)" : coil.kind === "reset" ? "(R)" : coil.kind === "ncoil" ? "(/)" : rm === "eno" ? "(ENO)" : rm === "enon" ? "(/ENO)" : isRet ? "(RET)" : "()";
    text(svg, x, yMid + SYM_DY, sym, "elt-sym");
    if (isRet) {
      text(svg, x, yMid - LABEL_DY, RET_TXT[rm], "elt-label");
      numTip(rect, coil, RET_TXT[rm], rm === "eno" ? "ENO della chiamata = corrente" : rm === "enon" ? "ENO della chiamata = corrente invertita" : "fine blocco");
    } else {
      opLabel(svg, x, yMid, coil.op, editing, coil.unset ? "unset" : coil._fresh, COIL_W + 90);
      opTip(rect, coil, coil.op, coil.kind === "set" ? "bobina SET" : coil.kind === "reset" ? "bobina RESET" : coil.kind === "ncoil" ? "bobina negata (scrive la corrente invertita)" : "bobina");
    }
    // Una bobina trascinata sopra una bobina ne cambia il tipo. Il rilascio
    // si gestisce sul rettangolo stesso (una zona sopra ruberebbe i clic).
    const meta = { kind: "coil", coil, accepts: "end", where };
    rect.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    rect.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation();
      clearCandidates();
      if (dropDedup()) return;
      const elt = e.dataTransfer.getData("element-type");
      if (!accepts(meta, elt)) { setStatusLine("su una bobina: un’altra bobina ne cambia il tipo; timer, FC e box vanno davanti", "warn"); return; }
      onDropPalette(elt, meta);
    });
    dropZones.push({ svg, rect, meta, cx: x, cy: yMid });
  }

  function addDropzone(svg, x, y, w, h, meta, invisible) {
    const r = el("rect", { x, y, width: Math.max(4, w), height: h, class: "dropzone" + (invisible ? " ghost" : "") });
    r.addEventListener("dragover",  e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    r.addEventListener("drop", e => {
      e.preventDefault(); e.stopPropagation();
      clearCandidates();
      if (dropDedup()) return;
      const elt = e.dataTransfer.getData("element-type");
      if (parDrop(elt)) return;
      if (!accepts(meta, elt)) { setStatusLine(refuseMsg(meta, elt), "warn"); return; }
      onDropPalette(elt, meta);
    });
    r.addEventListener("mouseenter", () => { lastZone = meta; });   // Ctrl+V incolla qui
    r.addEventListener("contextmenu", e => {                    // tasto destro su una zona: incolla lì
      e.preventDefault(); e.stopPropagation();
      showMenu(e.clientX, e.clientY, null, [{ label: "📋 Incolla qui", disabled: zonePasteWhy(meta), run: () => zonePaste(meta) }]);
    });
    svg.appendChild(r);
    dropZones.push({ svg, rect: r, meta, cx: x + w / 2, cy: y + h / 2 });
  }
  const isCoilElt  = elt => /^coil/.test(elt || "");
  const isTimerElt = elt => /^timer-/.test(elt || "");
  const isCallElt  = elt => /^call-/.test(elt || "");
  const isBoxElt   = elt => /^box-/.test(elt || "");
  const isTrigElt  = elt => /^trig-/.test(elt || "");
  // accepts: "both" = linee (contatti, timer, bobine), "contact" = dentro i rami
  // (contatti e timer), "end" = sopra una bobina/timer finale (bobine e timer)
  function accepts(meta, elt) {
    if (!elt) return true;
    if (meta.accepts === "both") return true;
    if (meta.accepts === "end") return isCoilElt(elt) || isTimerElt(elt) || isCallElt(elt) || isBoxElt(elt);
    return !isCoilElt(elt);
  }
  function refuseMsg(meta, elt) {
    return isCoilElt(elt)
      ? "la bobina va su una linea (principale o di un'uscita) per aprire una diramazione, non dentro un ramo parallelo"
      : "qui si può rilasciare una bobina o un timer";
  }

  function el(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function line(svg, x1, y1, x2, y2, cls) { svg.appendChild(el("line", { x1, y1, x2, y2, class: cls })); }
  function lineWire(svg, x1, y1, x2, y2, on) {
    svg.appendChild(el("line", { x1, y1, x2, y2, class: "wire" + (on ? " wire-on" : "") }));
  }
  function text(svg, x, y, content, cls) {
    const t = el("text", { x, y, class: cls });
    t.textContent = content;
    svg.appendChild(t);
    return t;
  }
  // Testo più lungo di maxW px: carattere più piccolo (fino a ¾) e poi stretto a misura; sempre intero, mai i puntini
  function fitText(t, maxW) {
    if (!maxW || !t.getComputedTextLength) return;
    const w = t.getComputedTextLength();
    if (w <= maxW) return;
    const fs0 = parseFloat(t.style.fontSize || getComputedStyle(t).fontSize) || LABEL_SIZE;
    t.style.fontSize = Math.max(fs0 * 0.75, fs0 * maxW / w) + "px";
    if (t.getComputedTextLength() > maxW) { t.setAttribute("textLength", maxW); t.setAttribute("lengthAdjust", "spacingAndGlyphs"); }
  }
  // Etichetta sopra un elemento: simbolo e/o indirizzo (menu "Etichette" in alto)
  function opLabel(svg, cx, y, op, editing, fresh, maxW) {
    const cls = "elt-label" + (editing ? " editing" : "");
    if ((fresh && editing) || fresh === "unset") return text(svg, cx, y - LABEL_DY, "?", cls);   // "unset": senza indirizzo
    if (isMemOp(op)) {
      const l = memLabel(op);
      if (!l.name) return text(svg, cx, y - LABEL_DY, l.addr, cls);
      if (!l.addr) return symText(svg, cx, y - LABEL_DY, l.name, cls + " symname");
      symText(svg, cx, y - LABEL_DY - SYM_LINE, l.name, cls + " symname");
      return text(svg, cx, y - LABEL_DY, l.addr, cls + " addr2");
    }
    const addr = varKey(op), name = EspSymbols.nameOf(op), mode = EspSymbols.mode();
    if (!name || mode === "addr") return text(svg, cx, y - LABEL_DY, addr, cls);
    if (mode === "sym") return symText(svg, cx, y - LABEL_DY, `"${name}"`, cls + " symname");
    symText(svg, cx, y - LABEL_DY - SYM_LINE, `"${name}"`, cls + " symname");
    text(svg, cx, y - LABEL_DY, addr, cls + " addr2");
  }
  // nome di un simbolo: l'ultima riga sta a y, quelle prima salgono; nome fra gli apici e punti coi loro colori
  function symText(svg, cx, y, s, cls) {
    const rows = nameLines(s);
    let t = null;
    rows.forEach((r, i) => {
      t = el("text", { x: cx, y: y - (rows.length - 1 - i) * (LABEL_SIZE + 3), class: cls });
      for (const m of r.matchAll(/"[^"]*"?|\.|[^".]+/g)) {
        const sp = el("tspan", {});
        if (m[0][0] === '"') sp.setAttribute("class", "sym-db"); else if (m[0] === ".") sp.setAttribute("class", "sym-dot");
        sp.textContent = m[0]; t.appendChild(sp);
      }
      svg.appendChild(t);
    });
    return t;
  }
  // Commento flottante: con Etichette "… + commento flottante", passando col
  // mouse su un elemento compare un riquadro con indirizzo, nome, commento
  // completo, tipo di elemento e (Online) il valore. Segue il cursore.
  let tipNode = null, tipInfo = null, tipSeen = false;
  function tipHtml(op, extra) {
    const mm = isMemOp(op), key = mm ? memAbs(op) : varKey(op), sy = mm ? (memVar(op) || {}) : EspSymbols.get(key);
    let h = mm ? `<div class="tt-head"><b>${escapeHtml(key)}</b>${op.ns === "DB" ? ` <span class="tt-name">${escapeHtml(memSym(op))}</span>` : ""} · ${escapeHtml(memType(op) || "")}</div>`
               : `<div class="tt-head"><b>${escapeHtml(key)}</b>${sy && sy.name ? ` <span class="tt-name">"${escapeHtml(sy.name)}"</span>` : ""}</div>`;
    const syc = sy && sy.comment ? (mm ? sy.comment : ut(`sym:${key}`, sy.comment)) : "";
    h += syc ? `<div class="tt-com" translate="no">${escapeHtml(syc)}</div>` : `<div class="tt-com none">nessun commento</div>`;
    const nv = isNumVar(op) ? odVal(op) : undefined;
    const live = !showLive() ? "" : isNumVar(op) ? (nv === undefined ? "" : ` · Online: <b>${fmtNum(nv, numT(op) === "REAL")}</b>`)
                                 : ` · Online: <b class="${readBit(op) ? "on" : ""}">${readBit(op) ? 1 : 0}</b>`;
    if (extra || live) h += `<div class="tt-kind">${escapeHtml(extra || "")}${live}</div>`;
    return h;
  }
  function placeTip(x, y) {
    const t = document.getElementById("optip");
    t.style.left = "0px"; t.style.top = "0px";            // misura a larghezza piena (vicino al bordo destro si stringeva e poi si allargava)
    const r = t.getBoundingClientRect();
    t.style.left = Math.max(4, Math.min(x + 14, window.innerWidth - r.width - 8)) + "px";
    t.style.top  = (y + 18 + r.height > window.innerHeight - 8 ? y - r.height - 10 : y + 18) + "px";
  }
  function hideTip() { tipNode = null; tipInfo = null; document.getElementById("optip").classList.add("hidden"); }
  // il ridisegno Online sostituisce l'elemento sotto il mouse: uscendo in fretta il mouseleave non arriva e il
  // riquadro restava aperto (anche cambiando pagina). Ogni movimento fuori da un elemento con commento lo chiude.
  document.addEventListener("mousemove", e => {
    if (!e.target || !e.target._tip) { if (!document.getElementById("optip").classList.contains("hidden")) hideTip(); }
  }, true);
  document.addEventListener("mouseout", e => { if (!e.relatedTarget) hideTip(); });   // fuori dalla finestra
  function opTip(rect, node, op, extra) {
    if (!op || !EspSymbols.floatTip()) return;
    rect._tip = true;
    const show = (e) => {
      if (menuOpen()) return;
      const t = document.getElementById("optip");
      tipNode = node; tipInfo = { op, extra }; tipSeen = true;
      t.innerHTML = tipHtml(op, extra); t.classList.remove("hidden");
      if (e) { tipInfo.x = e.clientX; tipInfo.y = e.clientY; }
      placeTip(tipInfo.x, tipInfo.y);
    };
    rect.addEventListener("mouseenter", show);
    rect.addEventListener("mousemove", e => { if (tipNode === node) { tipInfo.x = e.clientX; tipInfo.y = e.clientY; placeTip(e.clientX, e.clientY); } else show(e); });
    rect.addEventListener("mouseleave", hideTip);
    rect.addEventListener("mousedown", hideTip);
    rect.addEventListener("contextmenu", hideTip);
    // ridisegno (Online) con il mouse fermo sopra: aggiorna il riquadro
    if (tipNode === node && tipInfo) { const x = tipInfo.x, y = tipInfo.y; show(null); tipInfo.x = x; tipInfo.y = y; placeTip(x, y); }
  }

  // ── Riferimenti incrociati ──────────────────────────
  // Tasto destro → "Riferimenti di …" oppure 🔍 Cerca: tabella di dove è
  // usato un operando (I/O/M/T) o una funzione. Clic su una riga = vai lì.
  let flashNode = null, flashRect = null;
  const KIND_TXT = { coil: "bobina", ncoil: "bobina negata", set: "SET", reset: "RESET" };
  function collectRefs() {
    const out = [];
    project.blocks.forEach(b => {
      if (b.type === "fc") out.push({ key: "FC" + b.number, b, n: -1, use: b.name && b.name !== "FC" + b.number ? `definizione «${U(b.name)}»` : "definizione", node: null, def: true });
      b.segments.forEach((sg, n) => {
        const add = (key, use, node, extra) => out.push(Object.assign({ key, b, n, use, node }, extra || {}));
        // operandi collegati ai parametri della chiamata (le costanti e le # locali restano fuori)
        const args = c => { const a = c.args || {}; fcParams(fcOf(c.fc)).forEach(p => { const o = a[p.name]; if (o && o.ns && o.ns !== "L") add(varKey(o), p.dir === "in" ? `ingresso ${p.name} di FC${c.fc}` : p.dir === "out" ? `uscita ${p.name} di FC${c.fc}` : `ingresso/uscita ${p.name} di FC${c.fc}`, c, p.dir === "in" ? {} : { write: true }); }); };
        const ser = s => s.items.forEach(it => {
          if (it.type === "Parallel") it.branches.forEach(ser);
          else if (it.type === "Call") { add("FC" + it.fc, "chiamata (in linea)", it, { call: true }); args(it); }
          else if (isTimerObj(it)) add(varKey(it.op), `timer ${it.kind} ${formatPT(it.pt)} (in linea)`, it, { write: true });
          else if (it.type === "Compare") { [it.a, it.b].filter(isNumVar).forEach(o => add(opKey(o), `confronto ${it.cmp}`, it)); }
          else if (it.type === "Box") numRefs(it, add, "");
          else if (it.type === "Trig") { if (it.mem && it.mem.ns === "M") add("M" + it.mem.idx, `memoria ${it.edge}_TRIG`, it, { write: true }); }
          else if (it.op) {
            add(varKey(it.op), it.edge ? `fronte ${it.edge} ⎯|${it.edge}|⎯` : it.negated ? "contatto NC ⎯|/|⎯" : "contatto NA ⎯| |⎯", it);
            if (it.edge && it.mem && it.mem.ns === "M") add("M" + it.mem.idx, `memoria del fronte ${it.edge} di ${varKey(it.op)}`, it, { write: true });
          }
        });
        const nd = x => {
          ser(x.series);
          const c = x.coil;
          if (c) {
            if (c.kind === "CALL") { add("FC" + c.fc, "chiamata (fine network)", c, { call: true }); args(c); }
            else if (c.kind === "BOX") numRefs(c, add, " (fine network)");
            else if (isTimerObj(c)) add(varKey(c.op), `timer ${c.kind} ${formatPT(c.pt)}`, c, { write: true });
            else if (c.op) add(varKey(c.op), KIND_TXT[c.kind] || c.kind, c, { write: true, plain: c.kind === "coil" });
          }
          (x.outputs || []).forEach(nd);
        };
        sg.rungs.forEach(nd);
      });
    });
    return out;
  }
  function numRefs(b, add, sfx) {
    if (isCounter(b)) (CNT_BITS[b.box] || []).forEach(f => { if (b[f]) add(varKey(b[f]), `${b.box} ${f.toUpperCase()}${sfx}`, b); });
    [b.a, b.b, b.c, b.d, b.e].filter(isNumVar).forEach(o => add(opKey(o), `${b.box} ingresso${sfx}`, b));
    if (isNumVar(b.out)) add(opKey(b.out), `${b.box} uscita${sfx}`, b, { write: true });
  }
  const NS_ORDER = { I: 0, Q: 1, M: 2, T: 3, SM: 4, MB: 5, MW: 6, MI: 7, MD: 8, MDI: 9, MR: 10, FC: 11 };
  function keySort(a, b) {
    const pa = /^([A-Z]+)(\d+)(?:\.(\d+))?$/.exec(a) || [a, a, 0], pb = /^([A-Z]+)(\d+)(?:\.(\d+))?$/.exec(b) || [b, b, 0];
    const oa = NS_ORDER[pa[1]] ?? 9, ob = NS_ORDER[pb[1]] ?? 9;
    return oa - ob || (+pa[2]) - (+pb[2]) || (+(pa[3] ?? -1)) - (+(pb[3] ?? -1)) || a.localeCompare(b);
  }
  const refKeyOf = n => !n ? "" : n.type === "Call" || n.kind === "CALL" ? "FC" + n.fc
    : (n.type === "Box" || n.kind === "BOX") ? (isNumVar(n.out) ? opKey(n.out) : "")
    : n.type === "Compare" ? (isNumVar(n.a) ? opKey(n.a) : isNumVar(n.b) ? opKey(n.b) : "")
    : n.op && typeof n.op === "object" ? varKey(n.op) : "";
  let xrefRows = [];
  // chiave → testo (DB1.Vel → Dati.Vel)
  const keyText = k => { const m = /^DB(\d+)\.(.+)$/.exec(k); return m && dbOf(+m[1]) ? dbOf(+m[1]).name + "." + m[2] : k; };
  function openXref(query) {
    const m = document.getElementById("xref-modal"), q = document.getElementById("xref-q");
    closeMenus();
    q.value = query || "";
    m.classList.remove("hidden");
    renderXref();
    setTimeout(() => { q.focus(); q.select(); }, 0);
  }
  function renderXref() {
    const raw = document.getElementById("xref-q").value.trim();
    const Q = raw.toUpperCase().replace(/^O(?=\d|$)/, "Q");          // O = Q dei progetti di prima
    // solo gli operandi globali: le variabili # sono locali della FC (una FC chiamata 1000 volte non riempie l'elenco)
    const all = collectRefs().filter(r => !r.key.startsWith("#"));
    let hits;
    if (!Q) hits = all;
    else if (/^(FC|MDI|MB|MW|MI|MD|MR|[IQMT])\d+$/.test(Q)) hits = all.filter(r => r.key === Q);        // operando esatto
    else if (/^(FC|MDI|MB|MW|MI|MD|MR|[IQMT])$/.test(Q)) hits = all.filter(r => (/^([A-Z]+)/.exec(r.key) || [])[1] === Q);   // tutta l'area
    else if (EspSymbols.lookup(raw)) hits = all.filter(r => r.key === EspSymbols.lookup(raw).key);   // nome esatto
    else {
      const low = raw.toLowerCase();
      const names = new Set(project.blocks.filter(b => b.type === "fc" && (b.name || "").toLowerCase().includes(low)).map(b => "FC" + b.number));
      EspSymbols.list().forEach(sy => { if (sy.name.toLowerCase().includes(low) || sy.comment.toLowerCase().includes(low)) names.add(sy.key); });
      hits = all.filter(r => r.key.startsWith(Q) || names.has(r.key) || keyText(r.key).toLowerCase().includes(low));
    }
    const groups = new Map();
    hits.forEach(r => { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r); });
    const keys = [...groups.keys()].sort(keySort);
    const tb = document.querySelector("#xref-table tbody");
    tb.innerHTML = ""; xrefRows = [];
    const td = (txt, cls) => { const c = document.createElement("td"); c.textContent = txt; if (cls) c.className = cls; return c; };
    for (const k of keys) {
      const rs = groups.get(k);
      const uses = rs.filter(r => !r.def);
      const warns = [];
      const coils = uses.filter(r => r.plain);
      if (coils.length > 1) warns.push(`⚠ ${coils.length} bobine normali`);
      if (k.startsWith("FC") && !uses.some(r => r.call)) warns.push("⚠ mai chiamata");
      if (/^FC\d+$/.test(k) && !rs.some(r => r.def)) warns.push("⚠ funzione mancante");
      const g = document.createElement("tr"); g.className = "group";
      const sy = EspSymbols.get(k);
      const head = `${keyText(k)}${sy && sy.name ? `  "${U(sy.name)}"` : ""}${sy && sy.comment ? "  · " + U(sy.comment) : ""}`, wt = warns.length ? "   " + warns.join("  ") : "";
      const gc = td(uses.length === 1 ? `${head} — 1 uso${wt}` : `${head} — ${uses.length} usi${wt}`);
      gc.colSpan = 4; g.appendChild(gc); tb.appendChild(g);
      for (const r of rs) {
        const tr = document.createElement("tr");
        tr.appendChild(td(k, "key"));
        tr.appendChild(td(EspIR.blockLabel(r.b)));
        tr.appendChild(td(r.n >= 0 ? String(r.n + 1) : "—"));
        tr.appendChild(td(r.use, (r.plain && coils.length > 1) ? "warn" : ""));
        tr.addEventListener("click", () => {
          tb.querySelectorAll("tr.sel").forEach(x => x.classList.remove("sel"));
          tr.classList.add("sel"); gotoRef(r);
        });
        tb.appendChild(tr);
      }
    }
    if (!keys.length) {
      const tr = document.createElement("tr"); const c = td(Q ? `Nessun riferimento per «${U(raw)}»` : "Programma vuoto", "muted");
      c.colSpan = 4; tr.appendChild(c); tb.appendChild(tr);
    }
    const nUse = hits.filter(r => !r.def).length;
    document.getElementById("xref-count").textContent = `${keys.length} operandi · ${nUse} usi`;
  }
  function gotoRef(r) {
    // si va sempre al blocco: chiude quello che c'è al suo posto (DB, tabella dei simboli, moduli), come aprire un blocco dall'albero
    if (r.b !== program || dbPage != null || modPage || symPageOpen) setBlock(r.b.id);
    flashNode = r.node;
    render();
    const target = flashRect || (r.n >= 0 && netBlocks[r.n] && netBlocks[r.n].el);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    setStatusLine(`${r.key}: ${EspIR.blockLabel(r.b)}${r.n >= 0 ? " network " + (r.n + 1) : ""} — ${r.use}`);
  }
  // Il lampeggio resta finché la finestra Cerca è aperta
  function closeXref() {
    document.getElementById("xref-modal").classList.add("hidden");
    if (flashNode) { flashNode = null; render(); }
  }

  // ── Tabella dei simboli ─────────────────────────────
  // Pagina al posto dei network (🏷 Simboli). Celle modificabili; "Usi" apre
  // i riferimenti incrociati. Import / export CSV dai pulsanti in alto.
  let symPageOpen = false, symEditing = false, symMsg = null;
  // Aree e tipi di dato della tabella dei simboli (come una tabella delle variabili)
  const SYM_AREAS = ["I", "Q", "M", "T"];          // v4.8: i numeri stanno nei DB (nome e commento nella tabella del DB)
  const SYM_TYPE = { I: "BOOL", Q: "BOOL", M: "BOOL", T: "TIMER", MB: "BYTE", MW: "WORD", MI: "INT", MD: "UDINT", MDI: "DINT", MR: "REAL" };
  // quanti indirizzi ha il PLC per area (I/O dalle impostazioni, aree numeriche in uso); senza PLC: i massimi
  function symAreaLen(ns) {
    const m = liveMemory || {};
    if (ns === "I") return Number.isInteger(m.io_in) ? m.io_in : 32;
    if (ns === "Q") return Number.isInteger(m.io_out) ? m.io_out : 32;
    if (ns === "M" || ns === "T") return 256;                      // simboli: M0..M255, T0..T255
    return areaMax(ns);
  }
  const symExtra = new Set();          // operandi aggiunti a mano, ancora senza nome
  function openSymPage(focusKey) {
    closeMenus();
    if (dbPage != null) { dbPage = null; document.getElementById("canvas-wrap").classList.remove("db-mode"); renderBlocks(); }
    if (modPage) { modPage = false; document.getElementById("canvas-wrap").classList.remove("mod-mode"); }
    symPageOpen = true;
    document.getElementById("canvas-wrap").classList.add("sym-mode");
    document.getElementById("btn-syms").classList.add("online-active");
    renderSymPage(focusKey);
  }
  function closeSymPage() {
    if (!symPageOpen) return;
    symPageOpen = false; symExtra.clear(); symMsg = null;
    document.getElementById("canvas-wrap").classList.remove("sym-mode");
    document.getElementById("btn-syms").classList.remove("online-active");
    netBlocks = []; render();
  }
  function renderSymPage(focusKey) {
    const uses = new Map();
    collectRefs().forEach(r => { if (!r.def && !r.key.startsWith("FC")) uses.set(r.key, (uses.get(r.key) || 0) + 1); });
    const keys = new Set(EspSymbols.list().map(s => s.key));
    symExtra.forEach(k => keys.add(k));
    uses.forEach((_, k) => keys.add(k));
    const view = document.getElementById("sym-view").value;
    const area = document.getElementById("sym-area").value;
    const type = document.getElementById("sym-type").value;
    const f = document.getElementById("sym-filter").value.trim().toLowerCase();
    const nsOf = k => EspSymbols.parseKey(k).ns;
    // "Tutti" / "Solo liberi": tutti gli indirizzi delle aree scelte (quanti ne ha il PLC)
    if (view !== "named") {
      for (const ns of SYM_AREAS) {
        if ((area && ns !== area) || (type && SYM_TYPE[ns] !== type)) continue;
        const n = symAreaLen(ns);
        for (let i = 0; i < n; i++) keys.add(ns + i);
      }
    }
    const list = [...keys].filter(k => EspSymbols.parseKey(k)).sort(EspSymbols.keyCmp).filter(k => {   // DB, #locali: non sono simboli
      const ns = nsOf(k), sy = EspSymbols.get(k);
      if (area && ns !== area) return false;
      if (type && SYM_TYPE[ns] !== type) return false;
      if (view === "free" && ((sy && sy.name) || uses.has(k))) return false;
      if (!f) return true;
      return k.toLowerCase().includes(f) || (sy && (sy.name.toLowerCase().includes(f) || sy.comment.toLowerCase().includes(f)));
    });
    const SHOW_MAX = 600, shown = list.slice(0, SHOW_MAX);
    const tb = document.querySelector("#sym-table tbody");
    tb.innerHTML = "";
    const cell = (tr, cls) => { const c = document.createElement("td"); if (cls) c.className = cls; tr.appendChild(c); return c; };
    for (const k of shown) {
      const sy = EspSymbols.get(k) || { name: "", comment: "" };
      const n = uses.get(k) || 0;
      const tr = document.createElement("tr");
      tr.dataset.key = k;
      if (!sy.name) tr.classList.add("unnamed");
      cell(tr, "key").textContent = k;
      cell(tr, "type muted").textContent = SYM_TYPE[nsOf(k)];
      const mk = (field, max, ph) => {
        const inp = document.createElement("input");
        inp.type = "text"; inp.maxLength = max; inp.value = sy[field]; inp.placeholder = ph;
        inp.dataset.f = field; inp.dataset.orig = sy[field];
        inp.addEventListener("keydown", e => {
          if (e.key === "Enter") inp.blur();
          if (e.key === "Escape") { inp.value = inp.dataset.orig; inp.classList.remove("bad"); inp.title = ""; inp.blur(); }
        });
        inp.addEventListener("change", () => saveSymRow(tr));
        cell(tr).appendChild(inp);
        return inp;
      };
      mk("name", EspSymbols.NAME_MAX, "nome");
      mk("comment", EspSymbols.COMMENT_MAX, "commento");
      const cu = cell(tr, "uses");
      if (n) {
        const a = document.createElement("a"); a.href = "#"; a.textContent = n;
        a.title = `Riferimenti incrociati di ${k}`;
        a.addEventListener("click", e => { e.preventDefault(); openXref(k); });
        cu.appendChild(a);
      } else { cu.textContent = "—"; cu.title = "non usato nel programma"; cu.classList.add("muted"); }
      const cd = cell(tr, "del");
      if (EspSymbols.get(k)) {
        const b = document.createElement("button");
        b.className = "icon danger"; b.textContent = "✕"; b.title = `Elimina il simbolo di ${k}`;
        b.addEventListener("click", () => { symEditing = true; EspSymbols.remove(k); symEditing = false; symExtra.delete(k); renderSymPage(); });
        cd.appendChild(b);
      }
      tb.appendChild(tr);
    }
    if (!list.length) {
      const tr = document.createElement("tr"); const c = cell(tr, "muted"); c.colSpan = 6;
      c.textContent = keys.size ? "Nessun operando corrisponde al filtro" : "Nessun simbolo: + Aggiungi, oppure ⭳ Importa un CSV";
      tb.appendChild(tr);
    }
    if (list.length > SHOW_MAX) {
      const tr = document.createElement("tr"); const c = cell(tr, "muted"); c.colSpan = 6;
      c.textContent = `mostrati ${SHOW_MAX} di ${list.length}: scegli un'area o un tipo, o scrivi nel filtro`;
      tb.appendChild(tr);
    }
    const unnamed = [...uses.keys()].filter(k => !EspSymbols.nameOf(EspSymbols.parseKey(k))).length;
    document.getElementById("sym-count").textContent =
      `${EspSymbols.count()} simboli · ${unnamed} operandi usati senza nome · ${list.length} in elenco`;
    const box = document.getElementById("sym-msg");
    box.classList.toggle("hidden", !symMsg);
    if (symMsg) {
      box.className = "sym-msg" + (symMsg.errors.length ? " warn" : "");
      box.innerHTML = `<b>${escapeHtml(symMsg.title)}</b>` +
        (symMsg.errors.length ? `<ul>${symMsg.errors.slice(0, 20).map(x => `<li>${escapeHtml(x)}</li>`).join("")}` +
          (symMsg.errors.length > 20 ? `<li>… e altri ${symMsg.errors.length - 20}</li>` : "") + "</ul>" : "") +
        `<button class="icon" title="Chiudi">✕</button>`;
      box.querySelector("button").onclick = () => { symMsg = null; box.classList.add("hidden"); };
    }
    if (focusKey) {
      const tr = tb.querySelector(`tr[data-key="${focusKey}"]`);
      if (tr) { tr.scrollIntoView({ block: "center" }); const i = tr.querySelector('input[data-f="name"]'); i.focus(); i.select(); }
    }
  }
  // Stato del salvataggio dei simboli sul PLC (badge in alto + pagina simboli)
  const SYM_SYNC_TXT = {
    loading:  ["🏷 lettura simboli…", "muted"],
    pending:  ["🏷 salvataggio simboli…", "muted"],
    ok:       ["", ""],
    error:    ["⚠ Simboli non salvati sul PLC", "warn"],
    offline:  ["⚠ Simboli dalla copia nel browser", "warn"],
    nofw:     ["⚠ Simboli solo nel browser", "warn"],
    toolarge: ["⚠ Simboli troppo grandi per il PLC", "bad"],
  };
  function showSymSync(st, msg) {
    const b = document.getElementById("badge-sym");
    const [txt, cls] = SYM_SYNC_TXT[st] || ["", ""];
    b.textContent = txt; b.className = "badge sym " + cls; b.classList.toggle("hidden", !txt);
    b.title = (msg || "") + (st === "error" || st === "offline" ? " — clic per riprovare" : "");
    const note = document.getElementById("sym-sync");
    if (note) note.textContent = st === "ok" ? "✓ salvati sul PLC" : (txt + (msg ? ": " + msg : ""));
    if (st === "error" || st === "toolarge") setStatusLine("simboli: " + (txt.replace(/^⚠ /, "")) + (msg ? " (" + msg + ")" : ""), "warn");
  }
  function saveSymRow(tr) {
    const k = tr.dataset.key;
    const ni = tr.querySelector('input[data-f="name"]'), ci = tr.querySelector('input[data-f="comment"]');
    symEditing = true;
    const err = EspSymbols.set(k, ni.value, ci.value);
    symEditing = false;
    [ni, ci].forEach(i => { i.classList.toggle("bad", !!err); i.title = err || ""; });
    if (err) { setStatusLine(`${k}: ${err}`, "err"); return; }
    ni.dataset.orig = ni.value.trim(); ci.dataset.orig = ci.value.trim();
    tr.classList.toggle("unnamed", !ni.value.trim());
    setStatusLine(ni.value.trim() || ci.value.trim() ? `${k} = "${ni.value.trim()}" salvato` : `simbolo di ${k} eliminato`);
  }
  async function addSymRow() {
    const v = await askText("Nuovo simbolo", "Operando:", "", "es. M10, I3, Q0, T2, MW5, MR0 — poi scrivi nome e commento nella tabella");
    if (v === null) return;
    const p = EspSymbols.parseKey(v);
    if (!p) { setStatusLine(`«${U(v)}» non è un operando valido (I, Q, M, T, MB, MW, MI, MD, MDI, MR)`, "err"); return; }
    symExtra.add(p.key);
    document.getElementById("sym-filter").value = ""; document.getElementById("sym-area").value = ""; document.getElementById("sym-type").value = "";
    renderSymPage(p.key);
  }
  function exportSymbols() {
    if (!EspSymbols.count()) { setStatusLine("nessun simbolo da esportare", "warn"); return; }
    const d = new Date(), pad = n => String(n).padStart(2, "0");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([EspSymbols.exportCSV()], { type: "text/csv;charset=utf-8" }));
    a.download = `simboli-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatusLine(`esportati ${EspSymbols.count()} simboli in ${a.download}`);
  }
  async function importSymbols(file) {
    const txt = await file.text();
    const p = EspSymbols.parse(txt);
    if (!p.rows.length) { setStatusLine(`${file.name}: ` + (p.errors[0] || "nessun simbolo trovato"), "err"); return; }
    let replace = false;
    if (EspSymbols.count()) {
      const v = await confirmModal("Importa simboli",
        `${file.name}: ${p.rows.length} righe.\n\nUnisci: gli operandi presenti nel file vengono sovrascritti, gli altri simboli restano.\n` +
        `Sostituisci tutto: la tabella diventa quella del file.`, "Unisci", "Sostituisci tutto");
      if (v === "cancel") return;
      replace = v === "alt";
    }
    const r = EspSymbols.merge(p.rows, replace);
    const title = `${file.name}: ${r.added} nuovi, ${r.updated} aggiornati, ${r.unchanged} uguali` +
                  (r.errors.length ? `, ${r.errors.length} righe scartate` : "");
    symMsg = { title, errors: p.errors.concat(r.errors) };
    setStatusLine(title, r.errors.length ? "warn" : null);
    openSymPage();
  }

  // ── Blocchi: Main e funzioni ─────────────────────────
  function setBlock(id) {
    const b = project.blocks.find(x => x.id === id);
    if (!b) return;
    closeMenus();
    program = b; netBlocks = [];
    if (modPage) { modPage = false; document.getElementById("canvas-wrap").classList.remove("mod-mode"); }
    if (dbPage != null) { dbPage = null; document.getElementById("canvas-wrap").classList.remove("db-mode"); }
    if (symPageOpen) { symPageOpen = false; symExtra.clear(); symMsg = null;
      document.getElementById("canvas-wrap").classList.remove("sym-mode");
      document.getElementById("btn-syms").classList.remove("online-active"); }
    render(); renderBlocks();
    document.getElementById("canvas-wrap").scrollTop = 0;
    setStatusLine(b.type === "main" ? "Main" : b.type === "startup" ? "StartUp — eseguito una volta all'avvio e a ogni STOP→RUN, prima del Main"
                                     : `${EspIR.blockLabel(b)} — eseguita quando viene chiamata`);
  }
  function callersOf(num) {
    const out = [];
    project.blocks.forEach(b => b.segments.forEach((sg, n) => {
      let hit = false;
      const vis = s => s.items.forEach(it => { if (it.type === "Call" && it.fc === num) hit = true; else if (it.type === "Parallel") it.branches.forEach(vis); });
      const node = nd => { vis(nd.series); if (nd.coil && nd.coil.kind === "CALL" && nd.coil.fc === num) hit = true; (nd.outputs || []).forEach(node); };
      sg.rungs.forEach(node);
      if (hit) out.push(`${EspIR.blockLabel(b)} network ${n + 1}`);
    }));
    return out;
  }
  // StartUp Online: gira una volta sola in pochi µs → niente stato dei contatti, solo quando e quanto
  function startupNote() {
    const su = liveStatus && liveStatus.startup;
    const base = "StartUp gira una volta sola, all'avvio e a ogni STOP→RUN (o dopo un download completo), prima del primo ciclo del Main: Online i network restano grigi.";
    if (!su || !su.count) return `StartUp non ancora eseguito dall'accensione del PLC. ${base}`;
    const t = new Date(Date.now() - (su.ago_ms | 0));
    const hh = n => String(n).padStart(2, "0");
    const when = `${hh(t.getHours())}:${hh(t.getMinutes())}:${hh(t.getSeconds())}`;
    const err = su.fault ? ` — finito in ERRORE: ${Object.values(FAULT_TEXT)[su.fault] || "codice " + su.fault}` : "";   // FAULT_TEXT è nell'ordine dei codici
    return `StartUp eseguito alle ${when} in ${su.us} µs (${su.count} ${su.count === 1 ? "volta" : "volte"} dall'accensione)${err}. ${base}`;
  }
  const blkName = k => k === "main:0" ? "Main" : k === "startup:0" ? "StartUp" : k === "mod:1" ? "Esposizione dati" : k === "mod:2" ? "Dati HMI"
    : k.replace("fc:", "FC").replace("db:", "DB");
  function addStartup() {
    if (project.blocks.some(b => b.type === "startup")) { setBlock("startup"); return; }
    const b = EspIR.startupBlock();
    project.blocks.splice(1, 0, b);                 // subito dopo il Main (stesso ordine del PLC)
    markEditDirty();
    setBlock(b.id);
  }
  // ── Albero dei blocchi: «Programma» → cartelle (padre/figlio) → Main, StartUp, FC ──
  // Le cartelle sono solo dell'editor (project.folders, project.place): non cambiano il bytecode.
  const TREE_LS = "espplc.tree.closed.";
  let treeClosed = null, treeClosedUid = null, treeShown = null;
  function closedSet() {
    const uid = project.uid || "";
    if (treeClosed && treeClosedUid === uid) return treeClosed;
    treeClosedUid = uid;
    try { treeClosed = new Set(JSON.parse(localStorage.getItem(TREE_LS + uid) || "[]")); } catch (e) { treeClosed = new Set(); }
    return treeClosed;
  }
  function saveClosed() { try { localStorage.setItem(TREE_LS + (project.uid || ""), JSON.stringify([...closedSet()])); } catch (e) {} }
  const folderList = () => project.folders || [];
  const folderOf = id => folderList().find(f => f.id === id) || null;
  const placeOf = b => { const f = project.place && project.place[b.id]; return f && folderOf(f) ? f : null; };
  function setPlace(blockId, folderId) {
    if (!project.place) project.place = {};
    if (folderId) project.place[blockId] = folderId; else delete project.place[blockId];
    if (!Object.keys(project.place).length) delete project.place;
  }
  const folderPath = id => { const p = []; for (let f = folderOf(id); f; f = folderOf(f.parent)) p.unshift(f.name); return p.join(" / "); };
  const isInside = (id, anc) => { for (let f = folderOf(id); f; f = folderOf(f.parent)) if (f.id === anc) return true; return false; };
  // Blocchi di sistema nelle loro cartelle (Denys 02-11-2026): FC e DB del Modbus in «Sys_Modbus», SDB in «Sys_DB»
  // (la cartella si crea se manca). Una volta sola per blocco (project.sysPlaced): spostato altrove, resta dove è
  const isSysFolder = f => /^sys_/i.test(f.name || "");
  function sysFolders() {
    const want = [];
    for (const b of project.blocks) if (EspIR.isMbFc(b)) want.push([b.id, "Sys_Modbus"]);
    for (const d of project.dbs || []) {
      if (d.number === EspIR.MODBUS_DB) want.push(["db" + d.number, "Sys_Modbus"]);
      else if (d.hw) want.push(["db" + d.number, "Sys_DB"]);
    }
    const done = new Set(project.sysPlaced || []), now = new Set(want.map(w => w[0]));
    for (const [key, name] of want) {
      if (done.has(key)) continue;
      done.add(key);
      if (project.place && project.place[key] && folderOf(project.place[key])) continue;   // già in una cartella dell'utente
      let f = folderList().find(x => !x.parent && x.name.toLowerCase() === name.toLowerCase());
      if (!f) {
        const n = folderList().reduce((m, x) => Math.max(m, +x.id.slice(1) || 0), 0) + 1;
        f = { id: "f" + n, name, parent: null };
        (project.folders = project.folders || []).push(f);
      }
      setPlace(key, f.id);
    }
    const keep = [...done].filter(k => now.has(k));             // tolti (Modbus spento): se tornano, di nuovo nella cartella
    if (keep.length) project.sysPlaced = keep; else delete project.sysPlaced;
  }
  function renderBlocks() {
    renderStructs();
    const tree = document.getElementById("block-tree");
    if (!tree) return;
    sysFolders();
    tree.innerHTML = "";
    treeOrder = [];
    const closed = closedSet();
    if (treeShown !== program) {                           // blocco appena aperto: le sue cartelle si aprono
      treeShown = program;
      for (let f = folderOf(placeOf(program)); f; f = folderOf(f.parent)) closed.delete(f.id);
      closed.delete("root");
    }
    const row = (el, depth, key) => {
      el.style.paddingLeft = (6 + depth * 14) + "px"; tree.appendChild(el);
      if (key) { el.dataset.key = key; treeOrder.push(key); if (treeSel.has(key)) el.classList.add("sel"); }
    };
    // tasto destro su un elemento della selezione: menu della selezione
    const ctx = (el, key, fn) => el.addEventListener("contextmenu", e => {
      e.preventDefault(); e.stopPropagation();
      if (treeSel.size > 1 && treeSel.has(key)) openSelMenu(e.clientX, e.clientY); else fn(e);
    });
    // rilascio di un blocco o di una cartella su una cartella (o sulla radice)
    const dropTarget = (el, folderId) => {
      el.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("espplc-tree")) { e.preventDefault(); el.classList.add("drop-over"); } });
      el.addEventListener("dragleave", () => el.classList.remove("drop-over"));
      el.addEventListener("drop", e => {
        el.classList.remove("drop-over");
        const v = e.dataTransfer.getData("espplc-tree"); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        moveTreeItem(v, folderId);
      });
    };
    const drag = (el, v, call) => {
      el.draggable = true;
      el.addEventListener("dragstart", e => {
        const multi = treeSel.size > 1 && treeSel.has(v);            // più elementi selezionati: si spostano tutti
        if (!multi && treeSel.size) { treeSel.clear(); tree.querySelectorAll(".sel").forEach(x => x.classList.remove("sel")); }
        e.dataTransfer.setData("espplc-tree", multi ? "multi" : v);
        if (call && !multi) { dragElt = call; e.dataTransfer.setData("element-type", call); }   // FC nel network = chiamata
        e.dataTransfer.effectAllowed = call && !multi ? "copyMove" : "move";
      });
      if (call) el.addEventListener("dragend", () => { dragElt = ""; clearCandidates(); });
    };
    // radice
    const root = document.createElement("div");
    root.className = "block-item folder root";
    const rootOpen = !closed.has("root");
    root.innerHTML = `<span class="bi-icon">${rootOpen ? "▾" : "▸"}</span><span class="bi-name">Programma</span><span class="bi-count"></span>`;
    root.querySelector(".bi-count").textContent = project.blocks.length === 1 ? "1 blocco" : project.blocks.length + " blocchi";
    root.title = "Clic: apri / chiudi. Tasto destro: nuova cartella, nuova funzione, espandi / comprimi. Trascina qui un blocco o una cartella per toglierli dalle cartelle.";
    root.addEventListener("click", () => { if (closed.has("root")) closed.delete("root"); else closed.add("root"); saveClosed(); renderBlocks(); });
    root.addEventListener("contextmenu", e => { e.preventDefault(); openFolderMenu(e.clientX, e.clientY, null); });
    dropTarget(root, null);
    row(root, 0);
    const level = (parent, depth) => {
      blockRows(parent, depth, b => b.type !== "fc");          // Main e StartUp in cima, poi le cartelle, poi le FC e i DB;
      const subs = folderList().filter(f => (f.parent || null) === parent).sort((a, b) => a.name.localeCompare(b.name, "it", { numeric: true }));
      folderRows(subs.filter(f => !isSysFolder(f)), depth);
      blockRows(parent, depth, b => b.type === "fc");
      dbRows(parent, depth);
      folderRows(subs.filter(isSysFolder), depth);             // le cartelle «sys_» in fondo
    };
    const folderRows = (list, depth) => {
      list.forEach(f => {
          const d = document.createElement("div");
          const open = !closed.has(f.id);
          const n = project.blocks.filter(b => placeOf(b) === f.id || isInside(placeOf(b), f.id)).length
                  + (project.dbs || []).filter(x => placeOfDb(x) === f.id || isInside(placeOfDb(x), f.id)).length;
          d.className = "block-item folder";
          d.dataset.folder = f.id;
          d.innerHTML = `<span class="bi-icon">${open ? "▾" : "▸"}</span><span class="bi-name" translate="no"></span><span class="bi-count"></span>`;
          d.querySelector(".bi-name").textContent = "📁 " + f.name;
          d.querySelector(".bi-count").textContent = n ? String(n) : "";
          d.title = "Clic: apri / chiudi. Tasto destro: nuova cartella, nuova funzione, rinomina, elimina. Trascina per spostarla.";
          // chiudendo una cartella si chiudono anche quelle dentro (Denys 05-11-2026): riaprendola, tutto chiuso sotto
          d.addEventListener("click", e => { if (treeClick(e, "folder:" + f.id)) return;
            if (closed.has(f.id)) closed.delete(f.id);
            else { closed.add(f.id); for (const x of folderList()) if (isInside(x.id, f.id)) closed.add(x.id); }
            saveClosed(); renderBlocks(); });
          ctx(d, "folder:" + f.id, e => openFolderMenu(e.clientX, e.clientY, f));
          drag(d, "folder:" + f.id); dropTarget(d, f.id);
          row(d, depth, "folder:" + f.id);
          if (open) level(f.id, depth + 1);
        });
    };
    const dbRows = (parent, depth) => {                      // v4.8: DB
      for (const db of project.dbs || []) {
        if (placeOfDb(db) !== parent) continue;
        const key = "db:" + db.number, d = document.createElement("div");
        d.className = "block-item db" + (db.hw ? " hw" : "") + (dbPage === db.number ? " active" : "");
        d.innerHTML = `<span class="bi-exec"></span><span class="bi-icon">${db.hw ? "SDB" : "DB"}</span><span class="bi-name" translate="no"></span><span class="bi-count"></span>`;
        d.dataset.db = db.number;
        d.querySelector(".bi-name").textContent = `${dbTag(db.number)} ${db.name}`;
        d.querySelector(".bi-count").textContent = db.fields.length + (db.retain ? " · R" : "");
        d.title = d.dataset.tip = `Dati globali: negli operandi ${db.name}.campo${db.retain ? " · ritentivo" : ""} (tasto destro: rinomina, numero, sposta, elimina)`;
        d.addEventListener("click", e => { if (!treeClick(e, key)) openDbPage(db.number); });
        ctx(d, key, e => openDbMenu(e.clientX, e.clientY, db));
        drag(d, key);
        row(d, depth, key);
      }
    };
    const blockRows = (parent, depth, which) => {
      for (const b of project.blocks) {
        if (placeOf(b) !== parent || !which(b)) continue;
        const d = document.createElement("div");
        d.className = "block-item" + (b.type === "main" ? " main" : b.type === "startup" ? " startup" : "") + (b === program && dbPage == null && !modPage ? " active" : "");
        d.innerHTML = `<span class="bi-exec"></span><span class="bi-icon">${b.type === "main" ? "M" : b.type === "startup" ? "S" : EspIR.isFB(b) ? "FB" : "FC"}</span><span class="bi-name" translate="no"></span><span class="bi-count"></span>`;
        d.dataset.id = b.id;
        d.querySelector(".bi-name").textContent = EspIR.blockLabel(b);
        d.querySelector(".bi-count").textContent = b.segments.length + " nw";
        d.title = d.dataset.tip = b.type === "main" ? "Programma principale: eseguito a ogni scansione (trascina in una cartella per spostarlo)"
                                    : b.type === "startup" ? "StartUp: eseguito UNA volta all'avvio e a ogni STOP→RUN, prima del primo ciclo del Main (tasto destro: sposta / elimina)"
                                    : "Funzione: eseguita quando viene chiamata. Trascinala in un network per chiamarla, in una cartella per spostarla (tasto destro: rinomina / sposta / elimina)";
        d.addEventListener("click", e => { if (!treeClick(e, "block:" + b.id)) setBlock(b.id); });
        ctx(d, "block:" + b.id, e => {
          if (b.type === "fc") openBlockMenu(e.clientX, e.clientY, b);
          else if (b.type === "startup") openStartupMenu(e.clientX, e.clientY, b);
          else showMenu(e.clientX, e.clientY, null, [{ label: "↗ Apri", run: () => setBlock(b.id) }, ...moveItems(b)]);
        });
        drag(d, "block:" + b.id, b.type === "fc" ? "call-" + b.number : null);
        row(d, depth, "block:" + b.id);
      }
    };
    if (rootOpen) level(null, 1);
    for (const k of [...treeSel]) if (!treeOrder.includes(k) && !treeItemName(k)) treeSel.delete(k);   // elementi che non ci sono più
    renderFcPalette();
    { const sb = document.getElementById("btn-add-su"); if (sb) sb.classList.toggle("hidden", !rootOpen || project.blocks.some(b => b.type === "startup")); }
    { const fb = document.getElementById("btn-add-fc"); if (fb) fb.classList.toggle("hidden", !rootOpen); }
    { const db = document.getElementById("btn-add-db"); if (db) db.classList.toggle("hidden", !rootOpen); }
    document.getElementById("block-title").textContent = dbPage != null && dbOf(dbPage) ? `${dbTag(dbPage)} ${dbOf(dbPage).name}` : EspIR.blockLabel(program);
    renderProjName();
    updateExecDots();
  }
  // Selezione di più elementi dell'albero: clic, Ctrl+clic, Maiusc+clic, riquadro col mouse
  const treeSel = new Set();          // "block:<id>", "db:<n>", "folder:<id>"
  let treeAnchor = null, treeOrder = [];
  const placeOfDb = d => { const f = project.place && project.place["db" + d.number]; return f && folderOf(f) ? f : null; };
  const treeItemName = v => {
    const [k, id] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)];
    if (k === "block") { const b = project.blocks.find(x => x.id === id); return b ? EspIR.blockLabel(b) : ""; }
    if (k === "db") { const d = dbOf(+id); return d ? `${dbTag(d.number)} ${d.name}` : ""; }
    const f = folderOf(id); return f ? "📁 " + f.name : "";
  };
  // clic su un elemento: con Ctrl / Maiusc seleziona (true), senza apre (false)
  function treeClick(e, key) {
    if (e.ctrlKey || e.metaKey) {
      if (!treeSel.size && treeAnchor && treeAnchor !== key) treeSel.add(treeAnchor);
      if (treeSel.has(key)) treeSel.delete(key); else treeSel.add(key);
      treeAnchor = key; renderBlocks(); return true;
    }
    if (e.shiftKey) {
      const i = treeOrder.indexOf(treeAnchor), j = treeOrder.indexOf(key);
      if (i < 0) { treeSel.clear(); treeSel.add(key); treeAnchor = key; }
      else { treeSel.clear(); for (let k = Math.min(i, j); k <= Math.max(i, j); k++) treeSel.add(treeOrder[k]); }
      renderBlocks(); return true;
    }
    treeSel.clear(); treeAnchor = key;
    return false;
  }
  function clearTreeSel() { if (treeSel.size) { treeSel.clear(); renderBlocks(); } }
  // riquadro col mouse: si parte da uno spazio vuoto dell'albero (Ctrl: aggiunge alla selezione)
  function initTreeLasso() {
    const tree = document.getElementById("block-tree");
    tree.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.target.closest(".block-item")) return;
      e.preventDefault();
      const r0 = tree.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, keep = (e.ctrlKey || e.metaKey) ? new Set(treeSel) : new Set();
      const box = document.createElement("div");
      box.className = "tree-lasso";
      tree.appendChild(box);
      const move = ev => {
        const L = Math.min(x0, ev.clientX), T = Math.min(y0, ev.clientY), R = Math.max(x0, ev.clientX), B = Math.max(y0, ev.clientY);
        Object.assign(box.style, { left: (L - r0.left + tree.scrollLeft) + "px", top: (T - r0.top + tree.scrollTop) + "px", width: (R - L) + "px", height: (B - T) + "px" });
        treeSel.clear(); keep.forEach(k => treeSel.add(k));
        tree.querySelectorAll(".block-item[data-key]").forEach(it => {
          const q = it.getBoundingClientRect(), hit = q.bottom > T && q.top < B && q.right > L && q.left < R;
          if (hit) treeSel.add(it.dataset.key);
          it.classList.toggle("sel", treeSel.has(it.dataset.key));
        });
      };
      const up = () => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        box.remove();
        if (treeSel.size) treeAnchor = [...treeSel][treeSel.size - 1];
        renderBlocks();
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && treeSel.size && !document.querySelector(".modal:not(.hidden)")) clearTreeSel(); });
  }
  function moveSelection(folderId) {
    let n = 0;
    for (const v of [...treeSel]) if (moveTreeItem(v, folderId, true)) n++;
    treeSel.clear();
    if (n) { markEditDirty(); setStatusLine(`${n} ${n === 1 ? "elemento" : "elementi"} → ${folderId ? folderPath(folderId) : "Programma"}`); }
    renderBlocks();
  }
  function openSelMenu(x, y) {
    const list = folderList().map(f => ({ id: f.id, path: folderPath(f.id) })).sort((a, c) => a.path.localeCompare(c.path, "it", { numeric: true }));
    showMenu(x, y, null, [
      { label: `${treeSel.size} elementi selezionati`, disabled: " " },
      "-",
      ...[{ id: null, path: "Programma (fuori dalle cartelle)" }, ...list].map(f => ({ label: `📁 Sposta in: ${f.path}`, run: () => moveSelection(f.id) })),
      "-",
      { label: "Deseleziona", run: clearTreeSel },
    ]);
  }
  // sposta "block:<id>", "db:<n>", "folder:<id>" o la selezione ("multi") nella cartella folderId (null = radice)
  function moveTreeItem(v, folderId, quiet) {
    if (v === "multi") { moveSelection(folderId); return true; }
    const [kind, id] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)];
    if (kind === "db") {
      const d = dbOf(+id);
      if (!d || placeOfDb(d) === folderId) return false;
      setPlace("db" + d.number, folderId);
      if (quiet) return true;
      setStatusLine(`${dbTag(d.number)} ${d.name} → ${folderId ? folderPath(folderId) : "Programma"}`);
    } else if (kind === "block") {
      const b = project.blocks.find(x => x.id === id);
      if (!b || placeOf(b) === folderId) return false;
      setPlace(b.id, folderId);
      if (quiet) return true;
      setStatusLine(`${EspIR.blockLabel(b)} → ${folderId ? folderPath(folderId) : "Programma"}`);
    } else if (kind === "folder") {
      const f = folderOf(id);
      if (!f || f.id === folderId || (f.parent || null) === folderId) return false;
      if (folderId && isInside(folderId, f.id)) { if (!quiet) setStatusLine("una cartella non può andare dentro una sua sottocartella", "warn"); return false; }
      f.parent = folderId;
      if (quiet) return true;
      setStatusLine(`📁 ${f.name} → ${folderId ? folderPath(folderId) : "Programma"}`);
    } else return false;
    markEditDirty(); renderBlocks();
    return true;
  }
  // voci "Sposta in …" del menu di un blocco
  function moveItems(b) {
    const cur = placeOf(b), list = folderList().map(f => ({ id: f.id, path: folderPath(f.id) })).sort((a, c) => a.path.localeCompare(c.path, "it", { numeric: true }));
    if (!list.length) return [];
    return ["-", ...[{ id: null, path: "Programma (fuori dalle cartelle)" }, ...list].filter(x => x.id !== cur)
      .map(x => ({ label: `📁 Sposta in: ${x.path}`, run: () => moveTreeItem("block:" + b.id, x.id) }))];
  }
  async function newFolder(parent) {
    const name = await askText("Nuova cartella", parent ? `Cartella dentro «${U(folderPath(parent.id))}»:` : "Cartella dentro «Programma»:", "", "Es. Nastri, Allarmi, Comunicazioni. Solo per ordinare i blocchi: il PLC non la vede.");
    if (name === null) return;
    const n = folderList().reduce((m, f) => Math.max(m, +f.id.slice(1) || 0), 0) + 1;
    if (!project.folders) project.folders = [];
    project.folders.push({ id: "f" + n, name: name.trim().slice(0, EspIR.FOLDER_NAME_MAX) || "Cartella", parent: parent ? parent.id : null });
    closedSet().delete(parent && parent.id); saveClosed();
    markEditDirty(); renderBlocks();
  }
  function setAllFolders(open) {
    const c = closedSet();
    folderList().forEach(f => { if (open) c.delete(f.id); else c.add(f.id); });
    if (open) c.delete("root"); else c.add("root");
    saveClosed(); renderBlocks();
  }
  const folderAllItems = () => ["-", { label: "▾ Espandi tutto", run: () => setAllFolders(true) },
                                     { label: "▸ Comprimi tutto", run: () => setAllFolders(false) }];
  function openFolderMenu(x, y, f) {
    const items = [
      { label: "📁 Nuova cartella" + (f ? " qui dentro" : ""), run: () => newFolder(f) },
      { label: "＋ Nuova funzione" + (f ? " qui dentro" : ""), run: () => addFunction(f ? f.id : null) },
      { label: "＋ Nuovo DB", run: () => addDb() },
    ];
    if (f) {
      const kids = folderList().filter(x => x.parent === f.id), blks = project.blocks.filter(b => placeOf(b) === f.id);
      items.push(
        { label: "✎ Rinomina", run: async () => {
            const v = await askText("Rinomina cartella", "Nome:", f.name);
            if (v === null || !v.trim()) return;
            f.name = v.trim().slice(0, EspIR.FOLDER_NAME_MAX); markEditDirty(); renderBlocks(); } },
        "-",
        { label: "✕ Elimina cartella (il contenuto sale di un livello)", danger: true, run: async () => {
            if ((kids.length || blks.length) && !(await confirmAction(`Eliminare la cartella «${U(f.name)}»?`,
                `${blks.length} blocchi e ${kids.length} cartelle passano in «${f.parent ? folderPath(f.parent) : "Programma"}». I blocchi non si cancellano.`, "Sì, elimina la cartella"))) return;
            kids.forEach(k => { k.parent = f.parent || null; });
            blks.forEach(b => setPlace(b.id, f.parent || null));
            project.folders.splice(project.folders.indexOf(f), 1);
            if (!project.folders.length) delete project.folders;
            markEditDirty(); renderBlocks(); } });
    }
    items.push({ label: "📋 Incolla FC" + (f ? " qui dentro" : ""), disabled: clip && clip.fc ? null : "negli appunti non c'è una FC: tasto destro su una FC → Copia FC",
                 run: () => pasteFc(f ? f.id : null) });
    if (!f) items.push("-", ...progSettingsItems());
    items.push(...folderAllItems());
    showMenu(x, y, null, items);
  }
  // ── Impostazioni del programma (nel progetto: project.settings) ──
  // Gestione FC per numero («FC12 Carico12», Rinumera) o per nome (si vede solo il nome, unico; il numero lo tiene l'editor)
  const fcByName = () => !!(project.settings && project.settings.fcMode === "name");
  function progSettingsItems() {
    const set = m => {
      if (m === "name") {
        const seen = new Map(), dup = [];
        for (const b of project.blocks) if (b.type === "fc") { const k = (b.name || "").toLowerCase(); if (seen.has(k)) dup.push(b.name); seen.set(k, b); }
        if (dup.length) { setStatusLine(`per nome: nomi ripetuti (${dup.join(", ")}), rinominali prima`, "warn"); return; }
        project.settings = { fcMode: "name" };
      } else delete project.settings;
      EspIR.setFcMode(m);
      markEditDirty(); renderBlocks(); render();
      setStatusLine(m === "name" ? "FC per nome: nell'elenco e nei box solo il nome; il numero lo tiene l'editor" : "FC per numero: «FC12 Carico12»");
    };
    return [
      { label: (fcByName() ? "○" : "●") + " Gestione FC per numero", run: () => set("num") },
      { label: (fcByName() ? "●" : "○") + " Gestione FC per nome", run: () => set("name") },
      { label: "# Rinumera tutte le FC in ordine (1, 2, 3…)", run: renumberAll },
    ];
  }
  // Rinumera: le chiamate seguono da sole; anche testi tradotti, interfaccia e cartella. Serve il Download completo
  function renumberFcs(map) {                                   // Map numero vecchio → nuovo
    if (![...map].some(([a, b]) => a !== b)) return false;
    const idMap = new Map([...map].map(([a, b]) => ["fc" + a, "fc" + b]));
    const places = {};
    for (const b of project.blocks) if (b.type === "fc" && map.has(b.number)) {
      const o = b.number, n = map.get(o);
      if (project.place && project.place[b.id]) { places["fc" + n] = project.place[b.id]; delete project.place[b.id]; }
      if (b.name === "FC" + o) b.name = "FC" + n;
      b.number = n; b.id = "fc" + n;
    }
    if (Object.keys(places).length) project.place = Object.assign(project.place || {}, places);
    project.blocks.forEach(b => walkSegs(b.segments, it => { if (isCallIt(it) && map.has(it.fc)) it.fc = map.get(it.fc); }));
    for (const l of Object.keys(project.texts || {})) {
      const m = project.texts[l], out = {};
      for (const [k, v] of Object.entries(m)) {
        let nk = k, x;
        if ((x = /^fc:(\d+)$/.exec(k)) && map.has(+x[1])) nk = "fc:" + map.get(+x[1]);
        else if ((x = /^net:(fc\d+):(.*)$/.exec(k)) && idMap.has(x[1])) nk = `net:${idMap.get(x[1])}:${x[2]}`;
        else if ((x = /^if:(\d+):(.*)$/.exec(k)) && map.has(+x[1])) nk = `if:${map.get(+x[1])}:${x[2]}`;
        out[nk] = v;
      }
      project.texts[l] = out;
    }
    const head = project.blocks.filter(b => b.type !== "fc"), fcs = project.blocks.filter(b => b.type === "fc").sort((a, b) => a.number - b.number);
    project.blocks.splice(0, project.blocks.length, ...head, ...fcs);
    netBlocks = [];
    markEditDirty(); renderBlocks(); render();
    return true;
  }
  async function askRenumber(b) {
    const v = await askText("Rinumera funzione", `Nuovo numero per ${EspIR.blockLabel(b)} (1-1023):`, String(b.number),
      "Le chiamate a questa FC cambiano da sole. Sul PLC i blocchi cambiano: serve il Download completo.");
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1 || n > 1023 || String(n) !== v.trim()) { setStatusLine("numero da 1 a 1023", "warn"); return; }
    if (n === b.number) return;
    const other = project.blocks.find(x => x.type === "fc" && x.number === n);
    if (other) { setStatusLine(`FC${n} c'è già (${EspIR.blockLabel(other)})`, "warn"); return; }
    const o = b.number;
    renumberFcs(new Map([[o, n]]));
    setStatusLine(`FC${o} → FC${n}: chiamate aggiornate. Compile + Download completo per il PLC`, "warn");
  }
  function renumberAll() {
    const fcs = project.blocks.filter(b => b.type === "fc").sort((a, b) => a.number - b.number);
    const map = new Map(fcs.map((b, i) => [b.number, i + 1]));
    if (!renumberFcs(map)) { setStatusLine("le FC sono già numerate in ordine (1, 2, 3…)"); return; }
    setStatusLine(`${fcs.length} FC rinumerate da 1 a ${fcs.length}: chiamate aggiornate. Compile + Download completo per il PLC`, "warn");
  }
  // FC intera dagli appunti: numero libero, nome «… copia» (unico), stessi network e interfaccia
  function pasteFc(folderId) {
    if (!clip || !clip.fc) return;
    const src = jclone(clip.fc);
    const used = new Set(project.blocks.filter(b => b.type === "fc").map(b => b.number));
    let n = 1; while (used.has(n)) n++;
    if (n > 1023) { setStatusLine("FC finite (al massimo 1023)", "warn"); return; }
    const names = new Set(project.blocks.filter(b => b.type === "fc").map(b => (b.name || "").toLowerCase()));
    let nm = src.name && src.name !== "FC" + src.number ? src.name + " copia" : "FC" + n;
    for (let k = 2; names.has(nm.toLowerCase()); k++) nm = `${src.name} copia ${k}`;
    const b = EspIR.fcBlock(n, nm, src.segments, src.iface);
    const fx = pasteFix(fn => walkSegs(b.segments, fn), n);
    if (fx.err) { setStatusLine(fx.err, "warn"); return; }
    project.blocks.push(b);
    if (folderId) setPlace(b.id, folderId);
    markEditDirty(); renderBlocks();
    setBlock(b.id);
    setStatusLine(`incollata ${EspIR.blockLabel(b)}${fx.notes.length ? " — " + fx.notes.join("; ") : ""}`, fx.notes.length ? "warn" : undefined);
  }
  // Pallino accanto ai blocchi in Online: ● eseguito nell'ultima scansione, ○ no
  function updateExecDots() {
    [["mod-data", "mod:1"], ["mod-hmi", "mod:2"]].forEach(([id, k]) => {      // moduli diversi dal PLC: ≠ sul pulsante
      const el = document.getElementById(id); if (!el) return;
      const e = editorBlk && editorBlk.get(k), p = plcBlk && plcBlk.get(k);
      const diff = !!(editorBlk && plcBlk && (e || p) && (!e || !p || e.crc !== p.crc));
      el.classList.toggle("mod-diff", diff);
    });
    document.querySelectorAll("#block-tree .block-item").forEach(d => {
      const sp = d.querySelector(".bi-exec"); if (!sp) return;
      if (d.dataset.db) {                                // v4.8: DB, uguale o diverso dal PLC
        const same = blockSame({ type: "db", number: +d.dataset.db });
        d.classList.toggle("blk-diff", same === false);
        d.title = same === false ? "Diverso dal PLC: Download per caricarlo" : (d.dataset.tip || "");
        const off = !liveMonitoring || !liveStatus || same !== false;
        sp.textContent = off ? "" : "≠"; sp.className = "bi-exec" + (off ? "" : " diff");
        sp.title = off ? "" : "Offline: questo DB è diverso da quello sul PLC, i valori attuali non si vedono";
        return;
      }
      const b = project.blocks.find(x => x.id === d.dataset.id);
      const same = b ? blockSame(b) : null;
      d.classList.toggle("blk-diff", same === false);
      d.title = same === false ? "Diverso dal PLC: Download per caricarlo (solo i blocchi cambiati)" : (d.dataset.tip || "");
      if (!liveMonitoring || !liveStatus || !b) { sp.textContent = ""; sp.className = "bi-exec"; sp.title = ""; return; }
      if (!blockLiveOk(b)) { sp.textContent = "≠"; sp.className = "bi-exec diff"; sp.title = "Offline: questo blocco è diverso da quello sul PLC"; return; }
      if (b.type === "startup") { sp.textContent = "◷"; sp.className = "bi-exec su"; sp.title = startupNote(); return; }
      const on = blockExecuted(b);
      sp.textContent = on ? "●" : "○";
      sp.className = "bi-exec " + (on ? "on" : "off");
      sp.title = on ? "eseguita nell'ultima scansione" : "non eseguita nell'ultima scansione";
    });
  }
  // «Funzioni di sistema»: le istruzioni Modbus (FC generate dalla tabella Modbus); le FC dell'utente dall'albero dei blocchi
  function renderFcPalette() {
    const g = document.querySelector('details.pal-group[data-group="funzioni-sistema"]');
    if (!g) return;
    g.querySelectorAll(".pal-item").forEach(x => x.remove());
    const fcs = (project.blocks || []).filter(b => EspIR.isMbFc(b)).sort((a, b) => a.number - b.number);
    const empty = g.querySelector(".pal-empty");
    if (empty) empty.textContent = fcs.length ? "" : "nessuna per ora (Modbus: Moduli → ⇆ Modbus; le tue FC si trascinano dall'albero dei blocchi)";
    const TIP = { MB_: "Richiesta Modbus del master: REQ (fronte) → DONE, BUSY, ERR, STATUS", MBS_: "Registri dello slave: DR = un master ha scritto, ACK lo azzera",
                  MBC_: "Rete Modbus: ON accesa, 0 spenta" };
    for (const b of fcs) {
      const d = document.createElement("div");
      d.className = "pal-item"; d.draggable = true; d.dataset.elt = "call-" + b.number;
      d.title = (TIP[(b.name.match(/^MB[SC]?_/) || ["MB_"])[0]] || "") + " — si chiama con un network senza contatti";
      d.innerHTML = `<svg viewBox="0 0 60 30"><line x1="0" y1="15" x2="10" y2="15"/><rect x="10" y="3" width="40" height="24" rx="3"/><line x1="50" y1="15" x2="60" y2="15"/>` +
                    `<text x="30" y="19" text-anchor="middle" font-size="8">${escapeHtml(b.name.split("_")[0])}</text></svg><span translate="no">${escapeHtml(b.name)}</span>`;
      g.appendChild(d); bindPalItem(d);
    }
  }
  function askText(title, label, value, hint) {
    return new Promise(resolve => {
      const m = document.getElementById("input-modal"), inp = document.getElementById("input-text");
      document.getElementById("input-title").textContent = title;
      document.getElementById("input-label").textContent = label;
      document.getElementById("input-hint").textContent = hint || "";
      inp.value = value || "";
      const ok = document.getElementById("input-ok"), cn = document.getElementById("input-cancel");
      const done = v => { m.classList.add("hidden"); ok.onclick = cn.onclick = inp.onkeydown = null; resolve(v); };
      ok.onclick = () => done(inp.value);
      cn.onclick = () => done(null);
      inp.onkeydown = e => { if (e.key === "Enter") done(inp.value); if (e.key === "Escape") done(null); };
      m.classList.remove("hidden");
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    });
  }
  // v5.1: linguaggio della FC nuova (Denys 01-11-2026): Ladder, ST (testo strutturato, IEC 61131-3) o C (stesse istruzioni)
  function askLanguage(n) {
    return new Promise(resolve => {
      const m = document.getElementById("confirm-modal");
      document.getElementById("confirm-title").textContent = `Nuova funzione FC${n}`;
      const body = document.getElementById("confirm-body");
      body.textContent = "In che linguaggio la scrivi?";
      const row = document.createElement("div");
      row.className = "lang-pick";
      const opts = [["LD", "Ladder", "contatti e bobine, a network"], ["ST", "ST — testo strutturato", "IEC 61131-3: IF … THEN … END_IF;"],
                    ["C", "C", "sintassi del C: if (…) { … }"]];
      const ok = document.getElementById("confirm-ok"), alt = document.getElementById("confirm-alt"), cn = document.getElementById("confirm-cancel");
      ok.classList.add("hidden"); alt.classList.add("hidden");
      const done = v => { m.classList.add("hidden"); ok.classList.remove("hidden"); row.remove(); cn.onclick = null; resolve(v); };
      for (const [k, t, d] of opts) {
        const btn = document.createElement("button");
        btn.className = "btn"; btn.innerHTML = `<b>${t}</b><span class="muted small">${d}</span>`;
        btn.onclick = () => done(k);
        row.appendChild(btn);
      }
      body.appendChild(row);
      cn.onclick = () => done(null);
      m.classList.remove("hidden");
    });
  }
  async function addFunction(folderId) {
    const n = project.blocks.filter(b => b.type === "fc").reduce((m, b) => Math.max(m, b.number), 0) + 1;
    const lang = await askLanguage(n);
    if (!lang) return;
    const name = await askText("Nuova funzione", `Nome di FC${n}:`, "", "Facoltativo, es. Nastro, Pompa, Allarmi. Per chiamarla trascinala dall'albero dei blocchi in un network.");
    if (name === null) return;
    const b = EspIR.fcBlock(n, name.trim() || "FC" + n);
    if (lang !== "LD") { b.language = lang; b.text = lang === "ST" ? TEXT_START_ST : TEXT_START_C; }
    project.blocks.push(b);
    if (typeof folderId === "string") setPlace(b.id, folderId);
    markEditDirty();
    setBlock(b.id);
  }
  function openStartupMenu(x, y, b) {
    showMenu(x, y, null, [
      { label: "↗ Apri", run: () => setBlock(b.id) },
      ...moveItems(b),
      "-",
      { label: "✕ Elimina StartUp", danger: true,
        run: async () => {
          if (!(await confirmAction("Eliminare StartUp?", `Contiene ${b.segments.length} network. Al prossimo avvio il PLC parte direttamente dal Main.`, "Sì, elimina"))) return;
          project.blocks.splice(project.blocks.indexOf(b), 1);
          setPlace(b.id, null);
          if (program === b) program = project.blocks[0];
          netBlocks = [];
          markEditDirty(); renderBlocks(); render(); } },
    ]);
  }
  function openBlockMenu(x, y, b) {
    const callers = callersOf(b.number);
    showMenu(x, y, null, [
      { label: "↗ Apri", run: () => setBlock(b.id) },
      { label: "✎ Rinomina", run: async () => {
          const v = await askText("Rinomina funzione", `Nome di FC${b.number}:`, b.name === "FC" + b.number ? "" : b.name);
          if (v === null) return;
          const nm = v.trim() || "FC" + b.number;
          const dup = project.blocks.find(x => x !== b && x.type === "fc" && (x.name || "").toLowerCase() === nm.toLowerCase());
          if (dup) { setStatusLine(`«${nm}» c'è già (FC${dup.number}): il nome di una FC deve essere unico`, "warn"); return; }
          b.name = nm;
          markEditDirty(); renderBlocks(); render(); } },
      { label: "# Rinumera…", run: () => askRenumber(b) },
      { label: "📄 Copia FC", run: () => { setClip({ fc: jclone(b) }); setStatusLine(`copiata ${EspIR.blockLabel(b)}: tasto destro nell'elenco dei blocchi → Incolla FC`); } },
      ...moveItems(b),
      "-",
      { label: `✕ Elimina FC${b.number}`, danger: true,
        disabled: callers.length ? `chiamata da: ${callers.join(", ")} — elimina prima le chiamate` : null,
        run: async () => {
          if (!(await confirmAction(`Eliminare ${EspIR.blockLabel(b)}?`, `Contiene ${b.segments.length} network.`, "Sì, elimina"))) return;
          project.blocks.splice(project.blocks.indexOf(b), 1);
          setPlace(b.id, null);
          if (program === b) program = project.blocks[0];
          netBlocks = [];
          markEditDirty(); renderBlocks(); render(); } },
    ]);
  }

  // ── Network: aggiungi / sposta / elimina ─────────────
  function addNetwork() {
    // Nessun limite fisso di network: il firmware non usa il numero di network,
    // conta lo spazio (barra Memoria e controllo al Download).
    const id = program.segments.reduce((m, s) => Math.max(m, s.id | 0), 0) + 1;
    program.segments.push({ id, order: program.segments.length, language: "LD", rungs: [] });
    renumberSegments();
    markEditDirty(); render();
    const last = netBlocks[netBlocks.length - 1];
    if (last) last.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  // network vuoto nella posizione «at» (0 = in cima); i network da lì in giù scendono di uno
  function insertNetwork(at) {
    const id = program.segments.reduce((m, s) => Math.max(m, s.id | 0), 0) + 1;
    at = Math.max(0, Math.min(at, program.segments.length));
    program.segments.splice(at, 0, { id, order: at, language: "LD", rungs: [] });
    renumberSegments();
    netBlocks = [];
    markEditDirty(); render();
    const nb = netBlocks[at];
    if (nb) nb.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function moveNetwork(n, dir) {
    const m = n + dir, segs = program.segments;
    if (m < 0 || m >= segs.length) return;
    [segs[n], segs[m]] = [segs[m], segs[n]];
    renumberSegments();
    netBlocks = [];
    markEditDirty(); render();
  }
  async function deleteNetwork(n) {
    const seg = program.segments[n];
    const outs = [];
    seg.rungs.forEach(r => EspIR.eachLeaf(r, l => outs.push(l.coil.kind === "CALL" ? "FC" + l.coil.fc : l.coil.kind === "BOX" ? l.coil.box : l.coil.kind === "RET" ? "RET" : varKey(l.coil.op))));
    if (seg.rungs.length &&
        !(await confirmAction(`Eliminare il Network ${n + 1}?`,
          `Bobine: ${outs.join(", ") || "—"}`, "Sì, elimina"))) return;
    program.segments.splice(n, 1);
    if (!program.segments.length) program.segments.push({ id: 1, order: 0, language: "LD", rungs: [] });
    renumberSegments();
    netBlocks = [];
    markEditDirty(); render();
  }
  function renumberSegments() { program.segments.forEach((s, i) => { s.order = i; }); }

  // ── Drag & drop con aggancio alla zona più vicina ────
  let dragElt = "";              // tipo trascinato (dataTransfer non è leggibile durante dragover)
  // tasto destro fuori da un oggetto: niente (nemmeno il menu del browser), tranne nei campi di testo
  document.addEventListener("contextmenu", e => {
    if (e.defaultPrevented || e.target.closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
  });
  function setupPalette() {
    const root = document.getElementById("pal-root");
    if (root) root.addEventListener("contextmenu", e => {
      if (e.target.closest(".pal-item")) return;
      e.preventDefault();
      const all = open => { document.querySelectorAll("details.pal-group, details.pal-root").forEach(d => { d.open = open; }); };
      showMenu(e.clientX, e.clientY, null, [{ label: "▾ Espandi tutti i gruppi", run: () => all(true) }, { label: "▸ Comprimi tutti i gruppi", run: () => all(false) }]);
    });
    const tree = document.getElementById("block-tree");
    if (tree) tree.addEventListener("contextmenu", e => {
      if (e.target.closest(".block-item")) return;
      e.preventDefault();
      openFolderMenu(e.clientX, e.clientY, null);                 // come su «Programma»: anche Incolla FC e impostazioni
    });
    document.querySelectorAll("details.pal-group, details.pal-root").forEach(d => {
      try { const v = localStorage.getItem("espplc.pal." + d.dataset.group); if (v !== null) d.open = v === "1"; } catch (e) {}
      d.addEventListener("toggle", () => {
        try { localStorage.setItem("espplc.pal." + d.dataset.group, d.open ? "1" : "0"); } catch (e) {}
        if (!d.open) d.querySelectorAll("details[open]").forEach(c => { c.open = false; });   // chiuso il padre, chiusi anche i figli
      });
    });
    document.querySelectorAll(".pal-item").forEach(bindPalItem);
  }
  function bindPalItem(item) {
    item.addEventListener("dragstart", e => {
      dragElt = item.dataset.elt; document.body.classList.add("dragging");   // zone «visibili trascinando»
      e.dataTransfer.setData("element-type", item.dataset.elt);
      e.dataTransfer.effectAllowed = "copy";
    });
    item.addEventListener("dragend", () => { dragElt = ""; clearCandidates(); parClear(); document.body.classList.remove("dragging"); });
  }
  function clearCandidates() { dropZones.forEach(d => d.rect.classList.remove("candidate")); }
  function setupSvgDrop(svg) {
    svg.addEventListener("dragenter", e => e.preventDefault());
    svg.addEventListener("dragover", e => {
      e.preventDefault(); lastOverTs = performance.now(); throttledHighlight(e, svg);
      e.dataTransfer.dropEffect = dropHere ? "copy" : "none";    // fuori dalle zone: divieto, come fra un network e l'altro
    });
    // uscita dal network: si decide poco dopo (Chrome manda dragleave anche passando da un pezzo del disegno all'altro, e
    // l'anteprima del parallelo rifà il disegno); se nel frattempo arriva un dragover il trascinamento è ancora qui
    svg.addEventListener("dragleave", () => {
      setTimeout(() => {
        if (performance.now() - lastOverTs < 120) return;
        dropZones.forEach(d => d.svg === svg && d.rect.classList.remove("candidate")); parClear();
      }, 150);
    });
    svg.addEventListener("drop", e => {
      e.preventDefault();
      clearCandidates();
      if (dropDedup()) return;
      const elt = e.dataTransfer.getData("element-type");
      if (!elt) return;
      if (parDrop(elt)) return;
      const z = nearestZone(e, svg, elt);
      if (z) onDropPalette(elt, z.meta);
      else setStatusLine("rilascia più vicino a una zona tratteggiata");
    });
  }
  let lastHighlightTs = 0, lastOverTs = 0, dropHere = true;
  function throttledHighlight(e, svg) {
    const now = performance.now();
    if (now - lastHighlightTs < 60) return;
    lastHighlightTs = now;
    const z = parTrack(svg, nearestZone(e, svg, dragElt), svgPoint(e, svg));
    dropZones.forEach(d => d.rect.classList.toggle("candidate", d === z));
    dropHere = !!z || !!(parDw && parDw.ghost);                  // sul ramo provvisorio (o vicino) si rilascia lo stesso
  }
  function svgPoint(evt, svg) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    return ctm ? pt.matrixTransform(ctm.inverse()) : pt;
  }
  // Parallelo trascinando, con l'anteprima vera: un contatto (confronto, fronte, NOT) tenuto fermo 2 s sulla zona davanti a
  // un contatto mette nel network un ramo aperto provvisorio («fantasma», trasparente) che parte da lì e scende sotto il
  // contatto, e ridisegna con le regole normali. Rilasciato sul fantasma diventa il ramo aperto vero (si chiude dopo,
  // trascinando la freccia), sulla zona blu si inserisce come sempre, fuori sparisce. Il programma non cambia finché non
  // si rilascia (niente annulla, niente «modificato»)
  const PAR_DWELL = () => EspView.get().parDwell || 2000;      // impostazione grafica (Menu e testi → Editor)
  let parDw = null;                                              // { z, t0 } poi { ghost: { series, index, k, par, hot } }
  const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const rectOf = r => ({ x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") });
  const contactish = t => !!t && (t.type === "Contact" || t.type === "Compare");
  function parUnghost(G) { const i = G.series.items.indexOf(G.par); if (i >= 0) G.series.items.splice(i, 1); }   // torna com'era
  function parGhost(G) {
    const sl = { type: "Slot", unset: true, _ghost: true };
    G.par = { type: "Open", branch: mkSeries([sl]), _ghost: true };
    G.series.items.splice(G.index, 0, G.par);
    G.hot = false;
    render();
  }
  function parHot(G, h) {
    G.hot = h;
    const svg = G.par._geo && G.par._geo.svg;
    if (svg) svg.querySelectorAll(".par-ghost").forEach(n => n.classList.toggle("hot", h));
  }
  function parClear() {
    const d = parDw; parDw = null;
    if (d && d.ghost && d.ghost.par) { parUnghost(d.ghost); render(); }
  }
  function parTrack(svg, z, p) {
    if (parDw && parDw.ghost) {
      const G = parDw.ghost, geo = G.par._geo;
      if (!geo || geo.svg !== svg) return z;
      if (p.y >= geo.y - ROW_H / 2 && p.y <= geo.y + ROW_H / 2 && p.x >= geo.x - 4 && p.x <= geo.xR + 8) {   // sul ramo provvisorio
        if (!G.hot) parHot(G, true);
        return null;
      }
      const blue = dropZones.find(d => d.svg === svg && d.meta.kind === "gap" && d.meta.series === G.series && d.meta.index === G.index + 1);
      const br = blue ? rectOf(blue.rect) : null;
      if (br && inRect(p, br)) { if (G.hot) parHot(G, false); return blue; }
      // fra la zona blu e il ramo provvisorio (scendendo col mouse) l'anteprima resta: si annulla solo fuori da quest'area
      const x0 = Math.min(br ? br.x : geo.x, geo.x) - 12, y0 = (br ? br.y : geo.y - ROW_H) - 8;
      if (inRect(p, { x: x0, y: y0, w: geo.xR + 12 - x0, h: geo.y + ROW_H / 2 - y0 })) { if (G.hot) parHot(G, false); return null; }
      parClear();
      return z;
    }
    const ok = z && z.meta.kind === "gap" && contactish(z.meta.series.items[z.meta.index]) && /^contact-|^cmp$|^not$|^trig-/.test(dragElt || "");
    if (!ok) { parDw = null; return z; }
    if (!parDw || parDw.z !== z) { parDw = { z, t0: performance.now() }; return z; }
    if (performance.now() - parDw.t0 >= PAR_DWELL()) {
      parDw = { ghost: { series: z.meta.series, index: z.meta.index, par: null, hot: false } };
      parGhost(parDw.ghost);
      return null;
    }
    return z;
  }
  function parDrop(elt) {
    const d = parDw; parDw = null;
    if (!d || !d.ghost || !d.ghost.par) return false;
    const G = d.ghost;
    parUnghost(G);
    if (!elt) { render(); return false; }
    if (!G.hot) {                                                // non sul ramo provvisorio: si inserisce davanti, come sempre
      render();                                                  // (il disegno è rifatto: la zona si cerca in quello nuovo)
      const z = dropZones.find(q => q.meta.kind === "gap" && q.meta.series === G.series && q.meta.index === G.index);
      if (z && accepts(z.meta, elt)) onDropPalette(elt, z.meta);
      return true;
    }
    const sl = mkSlot();
    takeUndo();
    G.series.items.splice(G.index, 0, { type: "Open", branch: mkSeries([sl]) });   // ramo aperto: si chiude dopo
    markEditDirty(); render();
    slotPut(sl, elt);                                            // l'elemento trascinato al posto del «?»
    return true;
  }
  function nearestZone(evt, svg, elt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    const p = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
    // la zona sotto il mouse (distanza dal rettangolo, non dal centro: anche quella lunga in fondo al ramo si accende);
    // fra più zone, la più vicina; fuori da tutte (oltre SNAP_PX) niente: il puntatore diventa il divieto
    let best = null, bestD = Infinity, bestC = Infinity;
    for (const d of dropZones) {
      if (d.svg !== svg || !accepts(d.meta, elt)) continue;
      const r = rectOf(d.rect);
      const dist = Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.w), Math.max(r.y - p.y, 0, p.y - r.y - r.h));
      const c = Math.hypot(p.x - d.cx, p.y - d.cy);
      if (dist < bestD || (dist === bestD && c < bestC)) { bestD = dist; bestC = c; best = d; }
    }
    return (best && bestD <= SNAP_PX) ? best : null;
  }

  const newCoil = elt => elt === "coil-ret" ? { kind: "RET" }
    : ({ kind: elt === "coil-set" ? "set" : elt === "coil-reset" ? "reset" : elt === "coil-neg" ? "ncoil" : "coil", op: { ns: "Q", idx: 0 }, _fresh: true });

  // Primo numero di timer non ancora usato nel programma
  function freeTimerIdx() {
    const used = new Set();
    const visit = s => s.items.forEach(it => {
      if (it.type === "Timer") used.add(it.op.idx);
      else if (it.type === "Parallel") it.branches.forEach(visit);
    });
    const node = n => { visit(n.series); if (n.coil && isTimerObj(n.coil)) used.add(n.coil.op.idx); (n.outputs || []).forEach(node); };
    allSegments().forEach(({ sg }) => sg.rungs.forEach(node));
    for (let i = 0; i <= 255; i++) if (!used.has(i)) return i;
    return 0;
  }
  function newContactFor(elt) {
    const c = Object.assign(mkContact("I", 0, elt === "contact-nc"), { _fresh: true });
    if (elt === "contact-p" || elt === "contact-n") { c.edge = elt === "contact-n" ? "N" : "P"; c.mem = { ns: "E", idx: freeEdgeIdx() }; }
    return c;
  }
  const newTimer = (elt, inline) => Object.assign(inline ? { type: "Timer" } : {},
    { kind: elt.slice(6), op: { ns: "T", idx: freeTimerIdx() }, pt: TIMER_DEFAULT_PT, _fresh: true });

  function newBox(box) {
    const b = { type: "Box", box };
    BOX_F.slice(0, BOX_IN[box]).forEach(f => { b[f] = null; });
    b.out = null; b._fresh = true;
    return b;
  }
  function onDropPalette(elt, meta) {
    if (!elt) return;
    if (isCoilElt(elt) && meta.kind === "gap" && meta.where && meta.where.open && meta.series === meta.where.open.branch
        && meta.index === meta.series.items.length) {               // bobina in fondo a un ramo aperto: un'uscita
      const o = meta.where.open, s = meta.where.openSeries, n = meta.where.node, i = s ? s.items.indexOf(o) : -1;
      if (!n || s !== n.series || i < 0) { setStatusLine("una bobina in fondo al ramo va solo sui rami della linea principale: chiudi il ramo", "warn"); return; }
      takeUndo();
      s.items.splice(i, 1);
      const cl = newCoil(elt); toUnset(cl);
      EspIR.splitAt(n, i, { series: mkSeries(o.branch.items), coil: cl });
      markEditDirty(); render(); setStatusLine(cl.kind === "RET" ? "RET inserito" : UNSET_MSG);
      return;
    }
    const undo = takeUndo();
    // Fine aperta di un network: solo la BOBINA chiude il network; timer, FC e box si
    // mettono in linea (da sinistra a destra) e il network resta aperto: dopo si può
    // continuare con altri elementi o chiuderlo con una bobina (un network che finisce
    // con un timer, una FC o un box è già completo).
    if (meta.kind === "open-end") {
      const n = meta.node;
      let target, picker = null;
      if (isCoilElt(elt)) { target = newCoil(elt); n.outputs = [{ series: mkSeries(), coil: target }]; picker = target.kind === "RET" ? null : () => openPicker(target, true, undo); }
      else if (elt === "not") { target = { type: "Not" }; n.series.items.push(target); }
      else if (isTimerElt(elt)) { target = newTimer(elt, true); n.series.items.push(target); picker = () => openPicker(target, false, undo); }
      else if (isCallElt(elt)) {
        const fc = parseInt(elt.slice(5), 10);
        if (program.type === "fc" && program.number === fc) { setStatusLine("una funzione non può chiamare se stessa", "warn"); return; }
        target = { type: "Call", fc }; n.series.items.push(target);
      } else if (isBoxElt(elt)) {
        const box = elt.slice(4);
        target = newBox(box);
        n.series.items.push(target);
        picker = () => openNumPicker(target, false, undo);
      } else if (elt === "cmp" || isTrigElt(elt) || elt.startsWith("contact")) {
        // contatti, confronti, fronti in fondo alla linea: in linea anche loro
        target = elt === "cmp" ? { type: "Compare", cmp: "==", a: null, b: null, _fresh: true }
               : isTrigElt(elt) ? { type: "Trig", edge: elt === "trig-n" ? "N" : "P", mem: { ns: "E", idx: freeEdgeIdx() } }
               : newContactFor(elt);
        n.series.items.push(target);
        picker = target.type === "Compare" ? () => openNumPicker(target, false, undo)
               : target.type === "Contact" ? () => openPicker(target, false, undo) : null;
      } else return;
      if (picker) toUnset(target);
      markEditDirty(); render();
      if (picker) setStatusLine(UNSET_MSG); else setStatusLine(target.type === "Call" ? `chiamata FC${target.fc} inserita` : target.type === "Not" ? "NOT inserito" : target.kind === "RET" ? "RET inserito" : "inserito");
      return;
    }
    // v4.6: NOT (inverte la corrente): in linea, senza popup
    if (elt === "not") {
      const t = { type: "Not" };
      if (meta.kind === "new-rung") {
        const rungs = program.segments[meta.segIdx].rungs;
        if (rungs.length) return;
        rungs.push(EspIR.rung(mkSeries([t]), []));
      } else if (meta.kind === "gap") meta.series.items.splice(meta.index, 0, t);
      else if (meta.kind === "coil") {
        const leaf = meta.where && meta.where.leaf;
        if (!leaf || leaf.coil !== meta.coil) return;
        leaf.series.items.push(t);
      } else return;
      markEditDirty(); render(); setStatusLine("NOT inserito: inverte la corrente");
      return;
    }
    // v3.1: box numerici, confronto, fronte sulla corrente
    if (isBoxElt(elt) || elt === "cmp" || isTrigElt(elt)) {
      let target = null, forCoil = false;
      const box = elt.slice(4);
      const mkBox = () => newBox(box);
      if (meta.kind === "new-rung") {
        const rungs = program.segments[meta.segIdx].rungs;
        if (rungs.length) return;
        if (isBoxElt(elt)) target = mkBox();                       // in linea, network aperto: dopo si continua
        else if (elt === "cmp") target = { type: "Compare", cmp: "==", a: null, b: null, _fresh: true };
        else target = { type: "Trig", edge: elt === "trig-n" ? "N" : "P", mem: { ns: "E", idx: freeEdgeIdx() } };
        rungs.push(EspIR.rung(mkSeries([target]), []));
        if (target.type === "Trig") { markEditDirty(); render(); setStatusLine(`${target.edge}_TRIG inserito (memoria automatica)`); return; }
      } else if (meta.kind === "gap") {
        if (isBoxElt(elt)) target = mkBox();
        else if (elt === "cmp") target = { type: "Compare", cmp: "==", a: null, b: null, _fresh: true };
        else target = { type: "Trig", edge: elt === "trig-n" ? "N" : "P", mem: { ns: "E", idx: freeEdgeIdx() } };
        meta.series.items.splice(meta.index, 0, target);
        if (target.type === "Trig") { markEditDirty(); render(); setStatusLine(`${target.edge}_TRIG inserito (memoria automatica)`); return; }
      } else if (meta.kind === "coil") {                           // sull'elemento finale: va DAVANTI, in linea
        const leaf = meta.where && meta.where.leaf;
        if (!leaf || leaf.coil !== meta.coil) return;
        if (isBoxElt(elt)) target = mkBox();
        else if (elt === "cmp") target = { type: "Compare", cmp: "==", a: null, b: null, _fresh: true };
        else target = { type: "Trig", edge: elt === "trig-n" ? "N" : "P", mem: { ns: "E", idx: freeEdgeIdx() } };
        leaf.series.items.push(target);
        if (target.type === "Trig") { markEditDirty(); render(); setStatusLine(`${target.edge}_TRIG inserito (memoria automatica)`); return; }
      } else return;
      toUnset(target);
      markEditDirty(); render();
      setStatusLine(UNSET_MSG);
      return;
    }
    const isEdgeElt = elt === "contact-p" || elt === "contact-n";
    const isContact = elt === "contact-no" || elt === "contact-nc" || isEdgeElt;
    const isTimer = isTimerElt(elt);
    let target = null, forCoil = false;

    if (isCallElt(elt)) {                          // chiamata funzione: niente popup, la FC è già scelta
      const fc = parseInt(elt.slice(5), 10);
      if (program.type === "fc" && program.number === fc) { setStatusLine("una funzione non può chiamare se stessa", "warn"); return; }
      if (meta.kind === "new-rung") {
        const rungs = program.segments[meta.segIdx].rungs;
        if (rungs.length) return;
        rungs.push(EspIR.rung(mkSeries([{ type: "Call", fc }]), []));   // in linea, network aperto
      } else if (meta.kind === "gap") {
        meta.series.items.splice(meta.index, 0, { type: "Call", fc });
      } else if (meta.kind === "coil") {                           // sull'elemento finale: va DAVANTI, in linea
        const leaf = meta.where && meta.where.leaf;
        if (!leaf || leaf.coil !== meta.coil) return;
        leaf.series.items.push({ type: "Call", fc });
      } else return;
      markEditDirty(); render();
      setStatusLine(`chiamata FC${fc} inserita — doppio clic sul box per aprire la funzione`);
      return;
    }

    if (meta.kind === "new-rung") {
      const rungs = program.segments[meta.segIdx].rungs;
      if (rungs.length) return;                    // un solo rung per network
      if (isTimer) {                               // network vuoto: timer in linea, network aperto
        target = newTimer(elt, true);
        rungs.push(EspIR.rung(mkSeries([target]), []));
      } else if (isContact) {
        target = newContactFor(elt);
        rungs.push(EspIR.rung(mkSeries([target]), []));          // fine aperta: la bobina (o FC, box…) si mette dopo
      } else {
        target = newCoil(elt); forCoil = true;
        rungs.push(EspIR.rung(mkSeries(), [{ series: mkSeries(), coil: target }]));
      }
    } else if (meta.kind === "gap" && isContact) {
      target = newContactFor(elt);
      meta.series.items.splice(meta.index, 0, target);
    } else if (meta.kind === "gap" && isTimer) {         // timer in linea
      target = newTimer(elt, true);
      meta.series.items.splice(meta.index, 0, target);
    } else if (meta.kind === "gap") {
      // bobina su una linea (parte comune o un'uscita): si apre una diramazione
      // in quel punto; quello che c'era dopo diventa il primo ramo, senza copie.
      const n = meta.where && meta.where.node;
      if (!n || meta.series !== n.series) { setStatusLine(refuseMsg(meta, elt), "warn"); return; }
      target = newCoil(elt); forCoil = true;
      EspIR.splitAt(n, meta.index, { series: mkSeries(), coil: target });
    } else if (meta.kind === "coil") {
      target = meta.coil; forCoil = true;
      const wasTimer = isTimerObj(target);
      if (isTimer && wasTimer) {                   // timer su timer: cambia solo il tipo
        target.kind = elt.slice(6);
        markEditDirty(); render(); setStatusLine(`timer ${varKey(target.op)} → ${target.kind}`); return;
      }
      const leaf = meta.where && meta.where.leaf;
      if (isTimer) {                               // timer sull'elemento finale: va DAVANTI, in linea
        if (!leaf || leaf.coil !== target) return;
        target = newTimer(elt, true); forCoil = false;
        leaf.series.items.push(target);
      } else if (wasTimer || target.kind === "CALL" || target.kind === "BOX") {
        // bobina dopo un timer / una FC / un box finale: l'elemento passa in linea e la bobina va in fondo
        if (!leaf || leaf.coil !== target) return;
        leaf.series.items.push(EspIR.effectToInline(target));
        target = leaf.coil = newCoil(elt);
      } else {                                     // bobina su bobina: cambia solo il tipo
        const nk = newCoil(elt).kind;
        if (nk === "RET") { delete target.op; target.kind = "RET"; markEditDirty(); render(); setStatusLine("bobina → RET"); return; }
        const wasRet = target.kind === "RET";
        target.kind = nk;
        if (wasRet) { target.op = { ns: "Q", idx: 0 }; target.unset = true; markEditDirty(); render(); setStatusLine(UNSET_MSG); return; }
        markEditDirty(); render();
        setStatusLine(`bobina ${varKey(target.op)} → ${({ coil: "normale", ncoil: "negata" })[target.kind] || target.kind.toUpperCase()}`);
        return;
      }
    } else return;

    toUnset(target);
    markEditDirty(); render();
    if (target && target.kind === "RET") { setStatusLine("RET inserito: con corrente esce dalla funzione"); return; }
    setStatusLine(UNSET_MSG);
  }
  // Elemento trascinato dalla tavolozza: resta nel network senza indirizzo (alone giallo), senza popup;
  // si configura col clic. Il Download lo rifiuta finché non è configurato.
  function toUnset(t) { if (t && t._fresh) { delete t._fresh; t.unset = true; } }
  const UNSET_MSG = "inserito senza indirizzo: clic sull'elemento per configurarlo";

  // ── Annulla inserimento ──────────────────────────────
  // Prima di inserire un elemento nuovo si salva una copia del programma:
  // se nel picker si preme Annulla (o Esc), si torna esattamente a prima.
  function takeUndo() {
    return { json: EspIR.toJSON(project), block: program.id, dirty: editorDirty, blob: lastBlob };
  }
  function restoreUndo(u) {
    project = JSON.parse(u.json);                  // l'inserimento annullato non entra nella cronologia
    program = project.blocks.find(b => b.id === u.block) || project.blocks[0];
    netBlocks = [];
    renderBlocks();
    editorDirty = u.dirty;
    lastBlob = u.blob;
    document.getElementById("btn-download").disabled = false;
    markStructChanged();
    updateUndoBtns();
  }

  // ── Picker operando ──────────────────────────────────
  let pickerTarget = null, pickerForCoil = false, pickerUndo = null;

  let pickerTimer = false, pickerCall = false;
  function openPicker(target, forCoil, undo) {
    closeMenus();
    pickerTimer = isTimerObj(target);
    pickerCall = EspIR.isCall(target);
    if (pickerTimer || pickerCall) forCoil = false;
    document.getElementById("row-call").classList.toggle("hidden", !pickerCall);
    document.getElementById("row-ns").classList.toggle("hidden", pickerCall);
    document.getElementById("row-idx").classList.toggle("hidden", pickerCall);
    document.getElementById("row-sym").classList.toggle("hidden", pickerCall);
    document.getElementById("row-sym-hint").classList.toggle("hidden", pickerCall);
    if (pickerCall) {
      const sel = document.getElementById("call-fc");
      const fcs = project.blocks.filter(b => b.type === "fc" && !(program.type === "fc" && b.number === program.number));
      sel.innerHTML = fcs.map(b => `<option value="${b.number}">${escapeHtml(EspIR.blockLabel(b))}</option>`).join("");
      sel.value = String(target.fc);
    }
    pickerTarget = target; pickerForCoil = forCoil; pickerUndo = undo || null;
    const op = target.op;
    const fresh = !!(target._fresh || target.unset);
    document.querySelectorAll('input[name="ns"]').forEach(r => {
      r.checked = pickerTimer ? r.value === "T" : (!fresh && op && r.value === op.ns);
      const show = pickerTimer ? r.value === "T" : forCoil ? (r.value in NS_WRITE) : true;
      r.parentElement.style.display = show ? "" : "none";
    });
    document.getElementById("row-ctype").classList.toggle("hidden", forCoil || pickerTimer || pickerCall);
    document.getElementById("row-ckind").classList.toggle("hidden", !forCoil);
    document.getElementById("row-tkind").classList.toggle("hidden", !pickerTimer);
    document.getElementById("row-pt").classList.toggle("hidden", !pickerTimer);
    if (pickerTimer) {
      document.querySelectorAll('input[name="tkind"]').forEach(r => { r.checked = r.value === target.kind; });
      document.getElementById("pt").value = target.ptOp ? memText(target.ptOp) : formatPT(target.pt);
    } else if (!forCoil) document.querySelectorAll('input[name="ctype"]').forEach(r => {
      r.checked = target.edge ? r.value === target.edge.toLowerCase() : !target.edge && ((r.value === "nc") === !!target.negated) && (r.value === "no" || r.value === "nc");
    });
    else document.querySelectorAll('input[name="ckind"]').forEach(r => { r.checked = r.value === (target.kind || "coil"); });
    // memoria del fronte (contatto P / N)
    const em = target.mem || { ns: "E", idx: 0 };
    document.querySelectorAll('input[name="emem"]').forEach(r => { r.checked = r.value === em.ns; });
    document.getElementById("emem-idx").value = em.ns === "M" ? em.idx : "";
    updateEdgeRow();
    document.getElementById("picker-title").textContent =
      pickerCall ? "Chiamata funzione" : pickerTimer ? "Configura timer" : forCoil ? "Configura bobina" : "Configura contatto";
    const idx = document.getElementById("idx");
    idx.value = (fresh && !pickerTimer) || isMemOp(op) ? "" : (op ? op.idx + (op.bit != null ? "." + op.bit : "") : "");
    // simboli proponibili: solo delle aree ammesse qui
    const okNs = ns => pickerTimer ? ns === "T" : forCoil ? (ns in NS_WRITE) : true;
    document.getElementById("sym-list").innerHTML = EspSymbols.list().filter(sy => sy.name && okNs(sy.ns))
      .map(sy => `<option value="${escapeHtml(sy.name)}">${sy.key}${sy.comment ? " — " + U(escapeHtml(sy.comment)) : ""}</option>`).join("") + memOptions(pickerTimer ? "timer" : "bool");
    document.getElementById("sym-name").value = pickerTimer && isMemOp(op) ? memText(op) : (fresh && !pickerTimer) || isMemOp(op) ? "" : EspSymbols.nameOf(op);
    attachSuggest(document.getElementById("sym-name"), pickerTimer ? "none" : "bool");
    { const lr = document.querySelector('input[name="ns"][value="L"]'); if (lr && !pickerTimer && program.type !== "fc") lr.parentElement.style.display = "none"; }
    if (!pickerTimer && !pickerCall) { fillMemRow(op); }
    memRowVis();
    symTyped = false;
    updateRangeHint(); updatePickerOk();
    render();                                   // evidenzia l'elemento in modifica
    document.getElementById("picker").classList.remove("hidden");
    // il cursore va nella ricerca del simbolo (la chiamata non ce l'ha: scelta della FC)
    setTimeout(() => { const f = document.getElementById(pickerCall ? "call-fc" : "sym-name"); f.focus(); if (f.select) f.select(); }, 0);
  }
  function selectedNs() { return document.querySelector('input[name="ns"]:checked')?.value; }
  // v4.8: area DB o # nel popup: DB, campo e (campo numerico) bit
  const isMemNs = ns => ns === "DB" || ns === "L";
  function fillMemRow(op) {
    const ns = selectedNs(), dbSel = document.getElementById("pk-db"), fSel = document.getElementById("pk-f");
    const isDb = ns === "DB";
    dbSel.style.display = document.getElementById("pk-db-lab").style.display = isDb ? "" : "none";
    if (isDb) {
      const cur = op && op.ns === "DB" ? op.db : +dbSel.value;
      dbSel.innerHTML = (project.dbs || []).map(d => `<option value="${d.number}">DB${d.number} ${escapeHtml(d.name)}</option>`).join("");
      if (dbOf(cur)) dbSel.value = String(cur);
      const d = dbOf(+dbSel.value);
      fSel.innerHTML = d ? d.fields.map(f => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)} · ${f.type}</option>`).join("") : "";
      if (op && op.ns === "DB" && d && d.fields.some(f => f.name === op.f)) fSel.value = op.f;
    } else if (ns === "L") {
      const f = (program && program.iface) || {};
      fSel.innerHTML = EspIR.DIRS.flatMap(dir => (f[dir] || []).filter(v => v.type === "BOOL").map(v => `<option value="${escapeHtml(v.name)}">#${escapeHtml(v.name)} · ${DIR_TXT[dir]}</option>`)).join("");
      if (op && op.ns === "L") fSel.value = op.v;
    }
    updateBitRow(op);
  }
  function updateBitRow(op) {
    const ns = selectedNs(), d = ns === "DB" ? dbOf(+document.getElementById("pk-db").value) : null;
    const f = d && d.fields.find(x => x.name === document.getElementById("pk-f").value);
    const w = f && f.type !== "BOOL" ? EspIR.TYPE_W[f.type] * 8 : 0, bit = document.getElementById("pk-bit");
    document.getElementById("pk-bit-w").style.display = w ? "" : "none";
    bit.max = Math.max(0, w - 1);
    if (op && op.ns === "DB" && op.bit != null) bit.value = op.bit;
    else if (op) bit.value = "";
    const hint = document.getElementById("pk-hint");
    hint.textContent = ns === "DB" && !(project.dbs || []).length ? "nessun DB: «+ Nuovo DB» nell'albero dei blocchi"
      : ns === "L" && !document.getElementById("pk-f").options.length ? (program.type === "fc" ? "nessuna variabile BOOL nell'interfaccia" : "solo dentro una FC")
      : w ? `0..${w - 1}` : "";
  }
  function memPickerAddr() {
    const ns = selectedNs(), fv = document.getElementById("pk-f").value;
    if (!fv) return null;
    if (ns === "L") return { ns: "L", v: fv };
    const d = dbOf(+document.getElementById("pk-db").value), f = d && d.fields.find(x => x.name === fv);
    if (!f) return null;
    if (f.type === "BOOL") return { ns: "DB", db: d.number, f: f.name };
    const raw = document.getElementById("pk-bit").value.trim(), b = +raw, w = EspIR.TYPE_W[f.type] * 8;
    return raw !== "" && Number.isInteger(b) && b >= 0 && b < w ? { ns: "DB", db: d.number, f: f.name, bit: b } : null;
  }
  function memRowVis() {
    const m = isMemNs(selectedNs()) && !pickerCall;
    document.getElementById("row-mem").classList.toggle("hidden", !m);
    document.getElementById("row-idx").classList.toggle("hidden", m || pickerCall);
  }
  function onMemRowChange(e) {
    const inp = document.getElementById("sym-name");
    if (parseMemRef(inp.value)) { inp.value = ""; symTyped = false; }
    if (e && e.target.id === "pk-db") fillMemRow(null); else updateBitRow(null);
    updatePickerOk();
  }
  function updateEdgeRow() {
    const ct = document.querySelector('input[name="ctype"]:checked')?.value;
    const show = !pickerForCoil && !pickerTimer && !pickerCall && (ct === "p" || ct === "n");
    document.getElementById("row-emem").classList.toggle("hidden", !show);
    const m = document.querySelector('input[name="emem"]:checked')?.value === "M";
    document.getElementById("emem-idx").disabled = !m;
    const h = document.getElementById("emem-hint");
    h.textContent = m ? "il merker viene scritto a ogni scansione con il valore dell'operando" : "un bit nascosto (non consuma merker)";
  }
  // Simbolo nel popup: scrivendo un nome esistente si scelgono area e indice;
  // un nome nuovo viene dato all'operando scelto quando si preme OK.
  let symTyped = false;
  // indirizzo scelto nel popup: indice, o parola.bit per le aree numeriche (MW 3.5)
  function pickerAddr() {
    { const r = parseMemRef(document.getElementById("sym-name").value); if (r && r.o && r.type === (pickerTimer ? "TIMER" : "BOOL")) return r.o; }   // timer: variabile TIMER
    if (isMemNs(selectedNs())) return memPickerAddr();
    const ns = selectedNs(), raw = document.getElementById("idx").value.trim();
    if (!ns) return null;
    if (ns in WBIT) {
      const m = /^(\d{1,4})[.,](\d{1,2})$/.exec(raw);
      if (!m) return null;
      const w = +m[1], b = +m[2];
      return w < areaMax(ns) && b < WBIT[ns] ? { ns, idx: w, bit: b } : null;
    }
    if (!/^\d{1,4}$/.test(raw)) return null;
    const n = +raw;
    return n <= NS_RANGE[ns] ? { ns, idx: n } : null;
  }
  function onSymInput() {
    symTyped = true;
    const mr = !pickerTimer && parseMemRef(document.getElementById("sym-name").value);
    if (mr && mr.o && mr.type === "BOOL") {             // campo di un DB o variabile della FC: si scelgono area, campo e bit
      const radio = document.querySelector(`input[name="ns"][value="${mr.o.ns}"]`);
      if (radio) radio.checked = true;
      document.getElementById("idx").value = "";
      fillMemRow(mr.o); memRowVis();
    }
    const p = EspSymbols.lookup(document.getElementById("sym-name").value);
    const radio = p && document.querySelector(`input[name="ns"][value="${p.ns}"]`);
    if (p && radio && radio.parentElement.style.display !== "none") {
      radio.checked = true;
      document.getElementById("idx").value = p.idx + (p.bit != null ? "." + p.bit : "");
      updateRangeHint();
    }
    updatePickerOk();
  }
  function onAddrInput() {
    const inp = document.getElementById("sym-name");
    if (parseMemRef(inp.value)) { inp.value = ""; symTyped = false; }
    // un nome esistente (o nessun nome scritto a mano) segue l'operando scelto
    if (!symTyped || !inp.value.trim() || EspSymbols.lookup(inp.value)) { inp.value = EspSymbols.nameOf(pickerAddr()); symTyped = false; }
    updatePickerOk();
  }
  // → messaggio d'errore o null; scrive il suggerimento sotto il campo
  function checkPickerSym() {
    const hint = document.getElementById("sym-hint");
    const name = document.getElementById("sym-name").value.trim();
    const a = pickerAddr(), key = a ? varKey(a) : "";
    let err = null, msg = "";
    const mr = !EspSymbols.lookup(name) ? parseMemRef(name) : null;
    if (mr && pickerTimer) {                                   // v5.2: timer con lo stato in una variabile TIMER
      if (mr.err) err = mr.err;
      else if (mr.type !== "TIMER") err = `${memText(mr.o)} è ${typeName(mr.type)}: qui serve un TIMER (o un timer T)`;
      else msg = `${memText(mr.o)} · TIMER: non usa nessun T`;
    } else if (mr) {
      if (mr.err) err = mr.err;
      else if (mr.type !== "BOOL") err = `${memText(mr.o)} è ${mr.type}: qui serve un BOOL`;
      else if (pickerForCoil && mr.o.ns === "L" && memVar(mr.o) && memVar(mr.o).dir === "in") msg = `${memText(mr.o)} (IN): scriverlo cambia solo la copia dentro la FC`;
      else msg = `${memText(mr.o)} · BOOL${memVar(mr.o) && memVar(mr.o).comment ? " — " + U(memVar(mr.o).comment) : ""}`;
    } else if (name && a && isMemOp(a)) {
      err = "i campi dei DB e le variabili # hanno già il loro nome: lascia vuoto il simbolo";
    } else if (name) {
      const p = EspSymbols.lookup(name);
      if (p && (!a || p.key !== key)) err = `"${name}" è ${p.key}: qui non si può usare`;
      else if (p) { const sy = EspSymbols.get(p.key); msg = `"${U(sy.name)}" = ${p.key}${sy.comment ? " — " + U(sy.comment) : ""}`; }
      else if ((err = EspSymbols.checkName(name, key))) {}
      else if (a) msg = EspSymbols.nameOf(a) ? `rinomina ${key}: "${EspSymbols.nameOf(a)}" → "${name}"` : `nuovo simbolo: ${key} = "${name}"`;
      else msg = "scegli area e indice per il nuovo simbolo";
    } else if (a && EspSymbols.nameOf(a)) msg = `${key} ha il nome "${EspSymbols.nameOf(a)}" (resta: si elimina dalla tabella simboli)`;
    hint.textContent = err || msg;
    hint.style.color = err ? "var(--bad)" : "";
    return err;
  }
  function updatePickerOk() {
    if (pickerCall) { document.getElementById("picker-ok").disabled = !document.getElementById("call-fc").value; return; }
    let ok = !!pickerAddr();
    if (checkPickerSym()) ok = false;
    if (pickerTimer) {
      const pt = parsePT(document.getElementById("pt").value), po = pt == null ? timerPtOp() : null;
      const pv = document.getElementById("pt-preview");
      pv.textContent = po && po.err ? po.err : po ? `= ${memText(po)} (${memType(po)})` : pt == null ? "formato non valido" : `= ${pt} ms`;
      pv.style.color = pt == null && !(po && !po.err) ? "var(--bad)" : "";
      ok = ok && (pt != null || !!(po && !po.err));
    }
    document.getElementById("picker-ok").disabled = !ok;
  }
  // PT del timer da una variabile TIME / DINT (solo con il timer in una variabile TIMER) → operando, { err } o null
  function timerPtOp() {
    const r = parseMemRef(document.getElementById("pt").value);
    if (!r) return null;
    if (r.err) return r;
    if (!isMemOp(pickerAddr() || {})) return { err: "il PT da una variabile solo con il timer in una variabile TIMER" };
    return EspIR.baseType(r.type) === "DINT" ? r.o : { err: `${memText(r.o)} è ${typeName(r.type)}: il PT è TIME (o DINT, in ms)` };
  }
  function updateRangeHint() {
    const ns = selectedNs() || "I";
    if (isMemNs(ns)) return;
    document.getElementById("idx-range").textContent = (ns in WBIT) ? `parola.bit: 0..${areaMax(ns) - 1} . 0..${WBIT[ns] - 1} (es. 3.5)`
      : ns === "SM" ? "0 primo ciclo · 1 sempre 1 · 2 sempre 0 · 3 clock 10 Hz · 4 clock 2 Hz · 5 clock 1 Hz" : `(0..${NS_RANGE[ns]})`;
  }
  // cancelled=true → Annulla/Esc: se l'elemento era appena inserito, si
  // ripristina il programma com'era prima dell'inserimento.
  function closePicker(cancelled) {
    if (pickerTarget) { delete pickerTarget._fresh; if (cancelled !== true) delete pickerTarget.unset; }   // Annulla: resta senza indirizzo
    document.getElementById("picker").classList.add("hidden");
    if (cancelled === true && pickerUndo) {
      restoreUndo(pickerUndo);
      setStatusLine("inserimento annullato");
    }
    pickerTarget = null; pickerUndo = null;
    render();
  }
  function commitPicker() {
    if (document.getElementById("picker-ok").disabled) return;
    if (pickerCall) {
      pickerTarget.fc = parseInt(document.getElementById("call-fc").value, 10);
      pickerUndo = null; closePicker(false); markEditDirty(); render(); return;
    }
    pickerTarget.op = pickerAddr();
    const symName = document.getElementById("sym-name").value.trim();
    if (symName && !EspSymbols.lookup(symName) && !isMemOp(pickerTarget.op)) {
      const old = EspSymbols.get(varKey(pickerTarget.op));
      EspSymbols.set(varKey(pickerTarget.op), symName, old ? old.comment : "");
    }
    if (pickerTimer) {
      pickerTarget.kind = document.querySelector('input[name="tkind"]:checked')?.value || pickerTarget.kind;
      const pt = parsePT(document.getElementById("pt").value);
      if (pt != null) { pickerTarget.pt = pt; delete pickerTarget.ptOp; }
      else { pickerTarget.ptOp = timerPtOp(); pickerTarget.pt = 0; }
    } else if (pickerForCoil) pickerTarget.kind = document.querySelector('input[name="ckind"]:checked')?.value || "coil";
    else if (!pickerTimer) {
      const ct = document.querySelector('input[name="ctype"]:checked')?.value;
      pickerTarget.negated = ct === "nc";
      if (ct === "p" || ct === "n") {
        pickerTarget.edge = ct.toUpperCase();
        const mns = document.querySelector('input[name="emem"]:checked')?.value || "E";
        if (mns === "M") pickerTarget.mem = { ns: "M", idx: Math.max(0, Math.min(255, parseInt(document.getElementById("emem-idx").value, 10) || 0)) };
        else if (!pickerTarget.mem || pickerTarget.mem.ns !== "E") pickerTarget.mem = { ns: "E", idx: freeEdgeIdx() };
      } else { delete pickerTarget.edge; delete pickerTarget.mem; }
    }
    pickerUndo = null;
    closePicker(false);
    markEditDirty();
    render();
  }

  // ── v3.1: popup di confronto, box numerico, fronte sulla corrente ──
  //  Operando: MW3 / mi0 / MR5 (area + indice), una costante (12, -5, 2.5 o 2,5) o un nome della tabella simboli.
  let npTarget = null, npUndo = null, npForCoil = false;
  function parseNumOp(txt) {
    const t = String(txt || "").trim();
    if (!t) return { err: "vuoto" };
    const m = /^%?(MDI|MB|MW|MI|MD|MR)\s*(\d{1,5})$/i.exec(t);
    if (m) return { err: `${m[1].toUpperCase()}${m[2]}: le aree numeriche non ci sono più, i numeri stanno nei DB (es. Merker.${m[1].toUpperCase()}${m[2]})` };
    if (/^[+-]?(\d+([.,]\d*)?|[.,]\d+)(e[+-]?\d+)?$/i.test(t)) return { o: { k: parseFloat(t.replace(",", ".")) } };
    const p = EspSymbols.lookup(t);
    if (p && NUM_NS.includes(p.ns)) return { err: `"${t}" è ${p.key}: le aree numeriche non ci sono più, i numeri stanno nei DB` };
    if (p) return { err: `"${t}" è ${p.key}: un bit, qui serve un valore numerico` };
    const r = parseMemRef(t);
    if (r) return r.err ? r : r.type === "BOOL" ? { err: `${memText(r.o)} è un BOOL: qui serve un valore numerico` } : { o: r.o };
    return { err: "scrivi un campo di un DB (Dati.Vel), una variabile della FC (#vel) o un numero" };
  }
  const bitField = o => !o ? "" : isMemOp(o) ? memText(o) : (EspSymbols.nameOf(o) || varKey(o));
  const odField = o => !o ? "" : isKonst(o) ? fmtNum(o.k, !Number.isInteger(o.k)) : isMemOp(o) ? memText(o) : (EspSymbols.nameOf(o) || (o.ns + o.idx));
  function openNumPicker(target, forCoil, undo) {
    closeMenus();
    npTarget = target; npForCoil = !!forCoil; npUndo = undo || null;
    const isCmp = target.type === "Compare", isTrig = target.type === "Trig", isBox = isBoxObj(target);
    const sel = document.getElementById("np-op");
    document.getElementById("np-title").textContent = isCmp ? "Confronto" : isTrig ? `Fronte sulla corrente (${target.edge}_TRIG)` : isCounter(target) ? "Contatore" : "Istruzione numerica (EN / ENO)";
    document.getElementById("np-op-label").textContent = isCmp ? "Condizione:" : "Istruzione:";
    sel.innerHTML = isCmp ? CMP_LIST.map(c => `<option value="${c}">A ${c} B</option>`).join("")
                          : Object.keys(BOX_IN).map(b => `<option value="${b}">${b} — ${BOX_TXT[b]}</option>`).join("");
    sel.value = isCmp ? target.cmp : (target.box || "MOVE");
    document.getElementById("np-row-op").classList.toggle("hidden", isTrig);
    BOX_F.forEach(f => { document.getElementById("np-" + f).value = odField(target[f]); attachSuggest(document.getElementById("np-" + f), "num"); });
    attachSuggest(document.getElementById("np-out"), "num");
    document.getElementById("np-out").value = odField(target.out);
    ["r", "ld", "cd"].forEach(f => { const i = document.getElementById("np-" + f); i.value = bitField(target[f]); attachSuggest(i, "bool"); });
    document.querySelectorAll('input[name="np-trunc"]').forEach(r => { r.checked = r.value === (target.trunc ? "1" : "0"); });
    const mem = target.mem || { ns: "E", idx: 0 };
    document.querySelectorAll('input[name="np-mem"]').forEach(r => { r.checked = r.value === mem.ns; });
    document.getElementById("np-mem-idx").value = mem.ns === "M" ? mem.idx : "";
    document.getElementById("np-sym").innerHTML = memOptions("num");
    updateNumPicker();
    render();
    document.getElementById("numpicker").classList.remove("hidden");
    setTimeout(() => { const f = isTrig ? null : document.getElementById("np-a"); if (f) { f.focus(); f.select(); } }, 0);
  }
  // Controlla i campi; → { ok, fields } e scrive i suggerimenti
  function updateNumPicker() {
    const t = npTarget; if (!t) return { ok: false };
    const isCmp = t.type === "Compare", isTrig = t.type === "Trig";
    const op = document.getElementById("np-op").value;
    const nIn = isCmp ? 2 : isTrig ? 0 : BOX_IN[op];
    const show = (id, v) => document.getElementById(id).classList.toggle("hidden", !v);
    show("np-row-a", !isTrig); show("np-row-b", nIn >= 2); show("np-row-c", nIn >= 3); show("np-row-d", nIn >= 4); show("np-row-e", nIn >= 5);
    show("np-row-out", !isCmp && !isTrig);
    const cnt = !isCmp && !isTrig && (op === "CTU" || op === "CTD" || op === "CTUD");
    ["r", "ld", "cd"].forEach(x => show("np-row-" + x, cnt && CNT_BITS[op].includes(x)));
    document.getElementById("np-out-label").textContent = cnt ? "CV:" : "OUT:";
    const pins = !isCmp && BOX_PINS[op];
    if (pins) pins.forEach((p, i) => { document.getElementById(`np-${BOX_F[i]}-label`).textContent = p + ":"; });
    show("np-row-trunc", op === "CONV" && !isCmp && !isTrig); show("np-row-mem", isTrig);
    if (!pins) {
      document.getElementById("np-a-label").textContent = isCmp ? "A:" : nIn === 2 ? "IN1:" : "IN:";
      document.getElementById("np-b-label").textContent = isCmp ? "B:" : "IN2:";
    }
    document.getElementById("np-op-hint").textContent = isCmp ? "vero quando la condizione è soddisfatta" : isTrig ? "" : ({
      MOVE: "OUT = IN", ADD: "OUT = IN1 + IN2", SUB: "OUT = IN1 − IN2", MUL: "OUT = IN1 × IN2", DIV: "OUT = IN1 / IN2 (interi: verso lo zero)",
      MOD: "OUT = resto di IN1 / IN2 (solo interi)", NEG: "OUT = −IN", ABS: "OUT = |IN|", CONV: "IN nel tipo di OUT",
      MIN: "OUT = il minore", MAX: "OUT = il maggiore", LIMIT: "OUT = IN tenuto tra MN e MX", SQRT: "OUT = √IN (REAL)", SQR: "OUT = IN² (REAL)",
      SCALE: "IN da IN_MIN..IN_MAX a OUT_MIN..OUT_MAX", AND: "OUT = IN1 AND IN2 (bit)", OR: "OUT = IN1 OR IN2 (bit)", XOR: "OUT = IN1 XOR IN2 (bit)",
      INV: "OUT = bit di IN invertiti", SHL: "OUT = IN << N", SHR: "OUT = IN >> N", ROL: "OUT = IN ruotato a sinistra di N", ROR: "OUT = IN ruotato a destra di N",
      SWAP: "OUT = byte di IN rovesciati",
      CTU: "CV + 1 a ogni fronte di salita della corrente (CU) · Q = CV ≥ PV", CTD: "CV − 1 a ogni fronte di salita della corrente (CD) · Q = CV ≤ 0",
      CTUD: "corrente (CU) avanti, CD indietro · QU = CV ≥ PV" }[op] || "");
    const msg = document.getElementById("np-msg");
    const okBtn = document.getElementById("np-ok");
    if (isTrig) {
      const m = document.querySelector('input[name="np-mem"]:checked')?.value === "M";
      document.getElementById("np-mem-idx").disabled = !m;
      msg.textContent = m ? "il merker viene scritto a ogni scansione con la corrente che arriva" : "memoria automatica: un bit nascosto, non consuma merker";
      okBtn.disabled = m && !(parseInt(document.getElementById("np-mem-idx").value, 10) >= 0);
      return { ok: !okBtn.disabled };
    }
    const f = {};
    const one = (id, need, allowConst) => {
      const r = parseNumOp(document.getElementById(id).value);
      const h = document.getElementById(id + "-hint");
      if (!need) { h.textContent = ""; return null; }
      if (r.err) { h.textContent = r.err === "vuoto" ? "" : "⚠ " + r.err; h.style.color = r.err === "vuoto" ? "" : "var(--bad)"; return undefined; }
      if (isKonst(r.o) && !allowConst) { h.textContent = "⚠ qui serve una variabile"; h.style.color = "var(--bad)"; return undefined; }
      h.style.color = ""; h.textContent = isKonst(r.o) ? "costante" : isMemOp(r.o) ? `${memText(r.o)} · ${memType(r.o)}` : `${r.o.ns}${r.o.idx} · ${NUM_T[r.o.ns]}` + (EspSymbols.nameOf(r.o) ? ` "${EspSymbols.nameOf(r.o)}"` : "");
      return r.o;
    };
    BOX_F.forEach((x, i) => { f[x] = one("np-" + x, i < nIn, true); });
    f.out = one("np-out", !isCmp, false);
    let err = null;
    if (cnt) {                                                  // bit dei contatori: vuoto = nessuno (0)
      for (const x of CNT_BITS[op]) {
        const h = document.getElementById("np-" + x + "-hint"), r = parseArg({ type: "BOOL", dir: "inout" }, document.getElementById("np-" + x).value);
        h.style.color = r.err ? "var(--bad)" : ""; h.textContent = r.err ? "⚠ " + r.err : r.o ? (isMemOp(r.o) ? memText(r.o) : varKey(r.o)) : "nessuno (0)";
        if (r.err) err = `${x.toUpperCase()}: ${r.err}`; else f[x] = r.o || null;
      }
      if (!err && [f.a, f.out].every(v => v !== undefined) && [f.a, f.out].filter(isNumVar).some(v => numT(v) === "REAL")) err = "i contatori contano solo con numeri interi (INT, DINT, WORD, UDINT, BYTE)";
      if (!err && f.out === null) err = "manca la variabile del conteggio (CV)";
    }
    const typeErr = list => {                                  // stesso tipo, costanti nel campo → messaggio o null; ty in typeErr.ty
      const vars = list.filter(isNumVar);
      if (!vars.length) return "serve almeno un operando variabile";
      const ty = numT(vars[0]);
      if (vars.some(v => numT(v) !== ty)) return `tipi diversi (${vars.map(v => odText(v) + " " + numT(v)).join(", ")}): usa CONV per cambiare tipo`;
      const R = ty === "REAL" ? null : T_RANGE[ty];
      const bad = list.filter(isKonst).find(k => R ? (!Number.isInteger(k.k) || k.k < R[0] || k.k > R[1]) : !isFinite(Math.fround(k.k)));
      if (bad) return `${bad.k} non sta in un ${ty}${R ? ` (intero ${R[0]}..${R[1]})` : ""}`;
      typeErr.ty = ty; return null;
    };
    if ([f.a, f.b, f.c, f.d, f.e, f.out].includes(undefined)) err = "completa gli operandi";
    else if (!isCmp && op === "SCALE") {
      const e1 = typeErr([f.a, f.b, f.c]), t1 = typeErr.ty, e2 = e1 ? null : typeErr([f.d, f.e, f.out]), t2 = typeErr.ty;
      if (e1 || e2) err = (e1 ? "IN, IN_MIN, IN_MAX: " + e1 : "OUT_MIN, OUT_MAX, OUT: " + e2);
      else if (isKonst(f.b) && isKonst(f.c) && f.b.k === f.c.k) err = "IN_MIN e IN_MAX uguali";
      else msg.textContent = `SCALE da ${t1} a ${t2}`;
    } else {
      const list = isCmp ? [f.a, f.b] : op === "CONV" ? null : [...BOX_F.slice(0, nIn).map(x => f[x]), f.out].filter(Boolean);
      if (list) {
        const vars = list.filter(isNumVar);
        const ty = vars.length ? numT(vars[0]) : null;
        if (!vars.length) err = "serve almeno un operando variabile";
        else if (vars.some(v => numT(v) !== ty)) err = `tipi diversi (${vars.map(v => odText(v) + " " + numT(v)).join(", ")}): usa CONV per cambiare tipo`;
        else {
          const R = ty === "REAL" ? null : T_RANGE[ty];
          const bad = list.filter(isKonst).find(k => R ? (!Number.isInteger(k.k) || k.k < R[0] || k.k > R[1]) : !isFinite(Math.fround(k.k)));
          if (bad) err = `${bad.k} non sta in un ${ty}${R ? ` (intero ${R[0]}..${R[1]})` : ""}`;
          else if (op === "MOD" && ty === "REAL" && !isCmp) err = "MOD solo con numeri interi";
          else if ((op === "NEG" || op === "ABS") && !isCmp && (ty === "WORD" || ty === "UDINT" || ty === "BYTE")) err = `${op} non ha senso su ${ty} (senza segno)`;
          else if (!isCmp && (op === "DIV" || op === "MOD") && isKonst(f.b) && f.b.k === 0) err = "divisione per zero";
          else if (!isCmp && (op === "SQRT" || op === "SQR") && ty !== "REAL") err = `${op} solo con REAL (usa CONV)`;
          else if (!isCmp && BOX_INT[op] && ty === "REAL") err = `${op} solo con numeri interi`;
          else if (!isCmp && op === "SWAP" && ty === "BYTE") err = "SWAP su un BYTE non cambia niente";
          else if (!isCmp && op === "LIMIT" && isKonst(f.a) && isKonst(f.c) && f.a.k > f.c.k) err = "MN maggiore di MX";
          else msg.textContent = isCmp ? `confronto tra ${ty}` : `${op} ${ty}`;
        }
      } else if (f.a && f.out) {
        const ti = isNumVar(f.a) ? numT(f.a) : null, to = numT(f.out);
        const notes = convNotes(ti || "REAL", to, ti ? undefined : f.a.k);
        msg.innerHTML = escapeHtml(`da ${ti || "costante"} a ${to}` + (notes.length ? "" : ": nessuna perdita")) +
          notes.map(t => `<div class="np-note${/^⚠/.test(t) ? " warn" : ""}">${escapeHtml(t)}</div>`).join("");
      }
    }
    if (err) { msg.textContent = "⚠ " + err; msg.style.color = "var(--bad)"; } else msg.style.color = "";
    okBtn.disabled = !!err;
    return { ok: !err, f, op };
  }
  function closeNumPicker(cancelled) {
    if (npTarget) { delete npTarget._fresh; if (cancelled !== true) delete npTarget.unset; }
    document.getElementById("numpicker").classList.add("hidden");
    if (cancelled === true && npUndo) { restoreUndo(npUndo); setStatusLine("inserimento annullato"); }
    npTarget = null; npUndo = null;
    render();
  }
  function commitNumPicker() {
    const r = updateNumPicker();
    if (!r.ok) return;
    const t = npTarget;
    if (t.type === "Trig") {
      const m = document.querySelector('input[name="np-mem"]:checked')?.value === "M";
      if (m) t.mem = { ns: "M", idx: Math.min(255, parseInt(document.getElementById("np-mem-idx").value, 10) || 0) };
      else if (!t.mem || t.mem.ns !== "E") t.mem = { ns: "E", idx: freeEdgeIdx() };
    } else if (t.type === "Compare") {
      t.cmp = r.op; t.a = r.f.a; t.b = r.f.b;
    } else {
      t.box = r.op; t.out = r.f.out;
      BOX_F.forEach((x, i) => { if (i < BOX_IN[r.op]) t[x] = r.f[x]; else delete t[x]; });
      ["r", "ld", "cd"].forEach(x => { if (isCounter(t) && CNT_BITS[r.op].includes(x) && r.f[x]) t[x] = r.f[x]; else delete t[x]; });
      if (isCounter(t)) {                                       // memorie dei fronti (automatiche, come i contatti P)
        if (!t.mem || t.mem.ns !== "E") t.mem = { ns: "E", idx: freeEdgeIdx() };
        if (r.op === "CTUD") { if (!t.memD || t.memD.ns !== "E") t.memD = { ns: "E", idx: freeEdgeIdx([t.mem.idx]) }; } else delete t.memD;
      } else { delete t.mem; delete t.memD; }
      if (r.op === "CONV") t.trunc = document.querySelector('input[name="np-trunc"]:checked')?.value === "1"; else delete t.trunc;
    }
    npUndo = null;
    closeNumPicker(false);
    markEditDirty(); render();
  }

  // Online, tasto destro su un confronto o un box: "Modifica valore" degli operandi variabili
  function openNumForceMenu(x, y, node) {
    const vars = [node.a, node.b, node.c, node.d, node.e, node.out].filter(isNumVar).filter(o => o.ns !== "L").filter((o, i, a) => a.findIndex(z => opKey(z) === opKey(o)) === i);
    const items = vars.map(o => {
      const k = opKey(o), v = liveNum.get(k), nm = isMemOp(o) ? memText(o) : k;
      return { label: `✎ Modifica ${nm}${!isMemOp(o) && EspSymbols.nameOf(o) ? ` "${EspSymbols.nameOf(o)}"` : ""} (ora ${v === undefined ? "?" : fmtNum(v, numT(o) === "REAL")})`, run: () => editNumValue(o) };
    });
    if (!items.length) items.push({ label: "nessun valore da modificare", disabled: "solo costanti o fronte" });
    showMenu(x, y, node, items);
  }
  async function editNumValue(o) {
    if (isMemOp(o)) return editDbValue(o);                     // aree numeriche di prima: non ci sono più
  }
  // v4.7: Online leggero — si chiedono al PLC SOLO gli operandi dei network che si vedono nel blocco
  // aperto (più un margine di 300 px per lo scorrimento): bit (I, O, M, T) per byte, valori nei DB,
  // timer. Scorrendo, i network che entrano a vista si leggono subito (una lettura in più).
  const visNets = new Set();      // indici dei network a vista
  let netIo = null, visTimer = 0;
  // network entrati a vista: lettura subito e ridisegno anche con gli stessi valori (erano disegnati con quelli di prima)
  function onVisChange() { clearTimeout(visTimer); visTimer = setTimeout(() => { if (liveMonitoring) { lastLiveSig = ""; pollStatus(); } }, 60); }
  function watchNet(el, n) {
    el.dataset.net = n;
    if (typeof IntersectionObserver === "undefined") { visNets.add(n); return; }
    if (!netIo) netIo = new IntersectionObserver(es => {
      let ch = false;
      for (const e of es) {
        const k = +e.target.dataset.net;
        if (e.isIntersecting) { if (!visNets.has(k)) { visNets.add(k); ch = true; } }
        else if (visNets.delete(k)) ch = true;
      }
      if (ch) onVisChange();
    }, { rootMargin: "300px 0px" });
    netIo.observe(el);
  }
  function unwatchNets() { if (netIo) netIo.disconnect(); visNets.clear(); }
  const BIT_NS = ["I", "Q", "M", "T"];
  function liveOperands() {
    const timers = new Set(), bytes = { I: new Set(), Q: new Set(), M: new Set(), T: new Set() };
    const bit = o => { if (o && o.bit == null && bytes[o.ns] && Number.isInteger(o.idx)) bytes[o.ns].add(o.idx >> 3); };
    const dbOps = new Map();
    const add = o => { if (o && o.ns === "DB") dbOps.set(opKey(o), o); };
    const tmr = x => {
      if (isTimerObj(x) && x.op && Number.isInteger(x.op.idx)) timers.add(x.op.idx);
      if (isTimerObj(x) && x.op && x.op.ns === "DB") ["ET", "Q"].forEach(k => add({ ns: "DB", db: x.op.db, f: x.op.f + "." + k }));   // timer in un DB
    };
    const addAll = x => { [x.a, x.b, x.c, x.d, x.e, x.out, x.op].forEach(add); if (x.args) Object.values(x.args).forEach(add); bit(x.op); };
    const ser = s => s.items.forEach(it => { if (it.type === "Parallel") it.branches.forEach(ser); else { tmr(it); addAll(it); } });
    const node = n => { ser(n.series); if (n.coil) { tmr(n.coil); addAll(n.coil); } (n.outputs || []).forEach(node); };
    // solo i network a vista, e solo se il blocco è Online (modificato o diverso dal PLC: non si chiede niente)
    if (program && blockLiveOk(program)) program.segments.forEach((sg, i) => { if (!netIo || visNets.has(i)) sg.rungs.forEach(node); });
    // byte → intervalli: I0-1,M3,M10 (al PLC le uscite si chiedono come O)
    const b = [];
    for (const ns of BIT_NS) {
      const v = [...bytes[ns]].sort((x, y) => x - y);
      for (let i = 0; i < v.length; ) { let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; b.push((ns === "Q" ? "O" : ns) + v[i] + (j > i ? "-" + v[j] : "")); i = j + 1; }
    }
    const fcMax = project.blocks.reduce((m, x) => x.type === "fc" && Number.isInteger(x.number) ? Math.max(m, x.number) : m, -1);
    return { timers: [...timers], b: b.join(","), fx: fcMax, dbOps: [...dbOps.values()] };
  }

  // Tipo di un campo di un DB o di una variabile di una FC (Denys 02-11-2026): l'array è un tipo della tendina; scelto,
  // sulla stessa riga compaiono gli indici (min..max) e il tipo degli elementi. v.type = tipo degli elementi, v.lo / v.hi
  // v5.2: anche TIMER e le strutture del progetto (inStruct: campo di una struttura, dentro solo tipi semplici e TIMER)
  // localOk (campo di un DB): «Struttura» = struttura fatta sul momento, i suoi campi sotto la riga (Denys 04-11-2026)
  function typeCell(td, v, arrOk, msg, changed, inStruct, localOk) {
    syncStructs();
    const isArr = Number.isInteger(v.lo);
    const opts = (list, cur) => list.map(t => `<option${t === cur ? " selected" : ""}>${t}</option>`).join("");
    const opt = (val, lab, cur) => `<option value="${val}"${val === cur ? " selected" : ""}>${escapeHtml(lab)}</option>`;
    const sts = inStruct ? [] : (project.structs || []).filter(x => !x.local), cur = isArr ? "ARRAY" : v.type;
    const loc = localOk && isLocalStruct(v.type);
    td.classList.add("type-cell");
    td.innerHTML = `<select class="t-kind">${opts(EspIR.TYPES, cur)}${opt("TIMER", "TIMER", cur)}` +
      (arrOk || isArr ? opt("ARRAY", "ARRAY", cur) : "") +
      (localOk ? opt(loc ? v.type : "+L", "Struttura", cur) : "") +
      (sts.length ? `<optgroup label="Strutture">${sts.map(st => opt(st.id, st.name || st.id, cur)).join("")}</optgroup>` : "") +
      (inStruct || localOk ? "" : opt("+S", "＋ Nuova struttura", cur)) + `</select>` +
      (isArr ? `<input class="t-arr" size="7" value="${v.lo}..${v.hi}" title="Indici: minimo..massimo (es. 1..10), al più 4096 elementi">` +
               `<span class="muted">di</span><select class="t-elem" title="Tipo degli elementi">${opts(EspIR.TYPES.filter(t => t !== "BOOL"), v.type)}</select>` : "");
    td.querySelector(".t-kind").addEventListener("change", e => {
      let k = e.target.value;
      if (k === "+S") {                                  // struttura nuova della palette: nome, poi la sua pagina
        newStructAsk().then(st => { if (!st) { changed(); return; } v.type = st.id; delete v.lo; delete v.hi; delete v.init; delete v.def; changed(); openStructPage(st.id); });
        return;
      }
      if (k === "+L") k = newLocalStruct().id;           // struttura sul momento: i campi sotto la riga del DB
      if (k === "ARRAY") { v.lo = 0; v.hi = 9; if (v.type === "BOOL" || EspIR.isStruct(v.type)) v.type = "INT"; }
      else { v.type = k; delete v.lo; delete v.hi; if (EspIR.isStruct(k)) { delete v.init; delete v.def; } }
      msg(""); changed();
    });
    const ai = td.querySelector(".t-arr");
    if (ai) ai.addEventListener("change", () => {
      const m = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(ai.value);
      if (!m || +m[2] < +m[1] || +m[2] - +m[1] >= 4096) { msg("array: min..max, es. 0..9 o 1..10 (al più 4096 elementi)"); ai.value = `${v.lo}..${v.hi}`; return; }
      v.lo = +m[1]; v.hi = +m[2]; msg(""); changed();
    });
    const es = td.querySelector(".t-elem");
    if (es) es.addEventListener("change", () => { v.type = es.value; msg(""); changed(); });
  }
  // ── v4.8: DB e interfaccia delle FC ──────────────────
  const T_BYTES = { BOOL: 1, BYTE: 1, WORD: 2, INT: 2, DINT: 4, UDINT: 4, REAL: 4, SINT: 1, USINT: 1, UINT: 2, TIME: 4 };
  function dbDecode(bytes, at, v) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (EspIR.baseType(v.type)) {
      case "SINT": return dv.getInt8(at);
      case "BOOL": return ((bytes[at] >> v.bit) & 1) === 1;
      case "BYTE": return dv.getUint8(at);   case "WORD": return dv.getUint16(at, true); case "INT": return dv.getInt16(at, true);
      case "DINT": return dv.getInt32(at, true); case "UDINT": return dv.getUint32(at, true); default: return dv.getFloat32(at, true);
    }
  }
  function dbEncode(type, x) {
    const b = new Uint8Array(T_BYTES[type]), dv = new DataView(b.buffer);
    ({ SINT: () => dv.setInt8(0, x), BYTE: () => dv.setUint8(0, x), WORD: () => dv.setUint16(0, x, true), INT: () => dv.setInt16(0, x, true), DINT: () => dv.setInt32(0, x, true),
       UDINT: () => dv.setUint32(0, x, true), REAL: () => dv.setFloat32(0, x, true) })[EspIR.baseType(type)]();
    return b;
  }
  const toHex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  const fmtVal = (type, v) => type === "TIME" && typeof v === "number" ? "T#" + (v < 0 ? "-" + formatPT(-v) : formatPT(v)) : fmtNum(v, type === "REAL");
  async function dbReadRange(off, len) {
    const out = new Uint8Array(len);
    for (let p = 0; p < len; p += 2048) {
      const n = Math.min(2048, len - p), j = await fetchJson(`/api/plc/db?off=${off + p}&len=${n}`, FETCH_TO);
      out.set(hexToBytes(j.hex).subarray(0, n), p);
    }
    return out;
  }
  async function dbWriteBytes(off, bytes) {
    for (let p = 0; p < bytes.length; p += 64) {
      const r = await postJson("/api/plc/db", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ off: off + p, hex: toHex(bytes.subarray(p, p + 64)) }) });
      if (!r.ok) throw new Error((r.j && r.j.msg) || "HTTP " + r.status);
    }
  }
  // DB uguale sul PLC: stesso blocco, oppure stessa struttura (cambiati solo i valori iniziali: i valori attuali valgono)
  const dbOnPlc = n => {
    if (blockSame({ type: "db", number: n }) === true) return true;
    const e = editorBlk && editorBlk.get(bkey({ type: "db", number: n })), p = plcBlk && plcBlk.get(bkey({ type: "db", number: n }));
    return !!(e && p && e.lcrc !== undefined && p.lcrc !== undefined && e.lcrc === p.lcrc && e.base === p.base);
  };
  // Online: valori dei campi dei DB usati nei network a vista (e del DB aperto nella tabella)
  async function liveDbInto(map) {
    const want = new Map();
    for (const o of liveOperands().dbOps) { if (!want.has(o.db)) want.set(o.db, []); want.get(o.db).push(o.f); }
    if (dbPage != null && dbOf(dbPage)) want.set(dbPage, leafVars(dbOf(dbPage).fields).map(x => x.path));
    { const mf = mbLiveFields(); if (mf.length) want.set(EspIR.MODBUS_DB, [...(want.get(EspIR.MODBUS_DB) || []), ...mf]); }
    const L = EspIR.layoutDbs(project);
    for (const [n, fields] of want) {
      const d = L.dbs.get(n);
      if (!d || !d.size || !dbOnPlc(n)) continue;
      const vs = fields.map(f => d.vars.get(f)).filter(v => v && !v.struct);
      if (!vs.length) continue;
      const lo = Math.min(...vs.map(v => v.off)), hi = Math.max(...vs.map(v => v.off + T_BYTES[v.type]));
      try { const b = await dbReadRange(d.base + lo, hi - lo); for (const v of vs) map.set(`DB${n}.${v.name}`, dbDecode(b, v.off - lo, v)); } catch (e) {}
    }
    if (dbPage != null) renderDbValues();
    if (modPage && modKind === "modbus") renderMbValues();
    // FC aperta: i suoi dati locali dell'ultima chiamata (IN, OUT, IN_OUT, TEMP)
    if (program && program.type === "fc" && program.iface && dbPage == null) {
      try {
        const j = await fetchJson(`/api/plc/fcdata?fc=${program.number}`, FETCH_TO), b = hexToBytes(j.hex), lay = EspIR.layoutIface(program);
        if (b.length >= lay.size) for (const v of lay.vars.values()) if (!v.struct) map.set("#" + v.name, dbDecode(b, v.off, v));
      } catch (e) {}
    }
  }
  // valore scritto da tastiera → numero del tipo, o messaggio d'errore
  function parseTyped(type, txt) {
    const s = String(txt).trim().replace(",", ".");
    if (type === "BOOL") { if (/^(1|true|vero)$/i.test(s)) return { v: true }; if (/^(0|false|falso)$/i.test(s)) return { v: false }; return { err: "BOOL: 0 / 1 (o TRUE / FALSE)" }; }
    if (type === "TIME" && !/^[+-]?\d+$/.test(s)) { const ms = parsePT(s); return ms == null ? { err: "TIME: T#5s, 1m30s, 250ms o i ms" } : { v: ms }; }
    type = EspIR.baseType(type);
    const v = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : NaN;
    if (!isFinite(v)) return { err: `«${U(txt)}» non è un numero` };
    const lim = T_RANGE[type];
    if (type === "REAL") return isFinite(Math.fround(v)) ? { v: Math.fround(v) } : { err: "fuori dal campo di un REAL (±3.4e38)" };
    if (!Number.isInteger(v) || v < lim[0] || v > lim[1]) return { err: `non sta in un ${type} (intero ${lim[0]}..${lim[1]})` };
    return { v };
  }
  // bit di un DB: { off (nell'area dei DB), bit } — BOOL o bit di un campo numerico
  function dbBitAddr(o) {
    const L = EspIR.layoutDbs(project).dbs.get(o.db), v = L && L.vars.get(o.f);
    if (!v) return null;
    return o.bit != null ? { off: L.base + v.off + (o.bit >> 3), bit: o.bit & 7 } : v.type === "BOOL" ? { off: L.base + v.off, bit: v.bit } : null;
  }
  async function writeDbBit(o, val) {
    const at = dbBitAddr(o);
    if (!at) return;
    if (!dbOnPlc(o.db)) { setStatusLine(`${memText(o)}: il DB${o.db} sul PLC è diverso da quello dell'editor (Download)`, "warn"); return; }
    try {
      const q = await postJson("/api/plc/db", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ off: at.off, bit: at.bit, value: val }) });
      if (!q.ok) throw new Error((q.j && q.j.msg) || "HTTP " + q.status);
      setStatusLine(`${memText(o)} = ${val ? 1 : 0} scritto nel PLC`);
      pollStatus();
    } catch (e) { setStatusLine(`${memText(o)}: ` + e.message, "err"); }
  }
  async function editDbValue(o) {
    if (o.bit != null) { const cur = readBit(o); return writeDbBit(o, !cur); }
    const m = memVar(o), L = EspIR.layoutDbs(project).dbs.get(o.db), v = L && L.vars.get(o.f);
    if (!m || !v) return;
    if (!dbOnPlc(o.db)) { setStatusLine(`${memText(o)}: il DB${o.db} sul PLC è diverso da quello dell'editor (Download)`, "warn"); return; }
    const cur = liveNum.get(opKey(o));
    const txt = await askText(`Modifica ${memText(o)}`, `Nuovo valore di ${memText(o)} (${m.type}):`, cur === undefined ? "" : m.type === "BOOL" ? (cur ? "1" : "0") : fmtVal(m.type, cur),
      `Scritto nel PLC tra due scansioni; se il programma scrive ${memText(o)}, alla scansione dopo lo cambia di nuovo.`);
    if (txt == null) return;
    const r = parseTyped(m.type, txt);
    if (r.err) { setStatusLine(`${memText(o)}: ${r.err}`, "err"); return; }
    try {
      if (m.type === "BOOL") {
        const q = await postJson("/api/plc/db", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ off: L.base + v.off, bit: v.bit, value: r.v }) });
        if (!q.ok) throw new Error((q.j && q.j.msg) || "HTTP " + q.status);
      } else await dbWriteBytes(L.base + v.off, dbEncode(m.type, r.v));
      setStatusLine(`${memText(o)} = ${m.type === "BOOL" ? (r.v ? 1 : 0) : fmtNum(r.v, m.type === "REAL")} scritto nel PLC`);
      pollStatus();
    } catch (e) { setStatusLine(`${memText(o)}: ` + e.message, "err"); }
  }
  // cambia i riferimenti in tutto il progetto: fn(op) → nuovo operando o undefined (resta)
  function remapOps(fn, onlyBlock) {
    const fix = x => {
      if (!x || typeof x !== "object") return;
      for (const k of ["op", "a", "b", "c", "d", "e", "out", "ptOp"]) if (x[k] && typeof x[k] === "object") { const n = fn(x[k]); if (n) x[k] = n; }
      if (x.args) for (const k of Object.keys(x.args)) { const n = fn(x.args[k]); if (n) x.args[k] = n; }
    };
    for (const b of project.blocks) {
      if (onlyBlock && b !== onlyBlock) continue;
      EspIR.eachElement({ blocks: [b] }, fix);
    }
  }

  // ── Tabella del DB ──
  let dbPage = null;                  // numero del DB aperto nella tabella (null = nessuno)
  function openDbPage(n, stId) {                      // stId: la pagina della struttura (stessa tabella)
    closeMenus();
    if (symPageOpen) closeSymPage();
    if (modPage) { modPage = false; document.getElementById("canvas-wrap").classList.remove("mod-mode"); }
    dbPage = stId ? null : n; stPage = stId || null; dbMsg("");
    document.getElementById("canvas-wrap").classList.add("db-mode");
    renderDbPage(); renderBlocks();
    document.getElementById("canvas-wrap").scrollTop = 0;
    if (liveMonitoring) pollStatus();
  }
  function closeDbPage() {
    if (dbPage == null && stPage == null) return;
    dbPage = null; stPage = null;
    document.getElementById("canvas-wrap").classList.remove("db-mode");
    netBlocks = []; render(); renderBlocks();
  }
  function dbMsg(t, kind) {
    const m = document.getElementById("db-msg");
    m.classList.toggle("hidden", !t); m.className = "sym-msg" + (t ? "" : " hidden") + (kind === "warn" ? " warn" : "");
    m.textContent = t || "";
  }
  async function addDb() {
    // DB dell'utente da 1 a 999: dal 1000 in su sono le DB dell'hardware (HWDB e DB dei dispositivi)
    let n = (project.dbs || []).filter(d => !d.hw && d.number < EspIR.HWDB_NUMBER).reduce((m, d) => Math.max(m, d.number), 0) + 1;
    while (dbOf(n) && n < EspIR.HWDB_NUMBER) n++;
    if (n >= EspIR.HWDB_NUMBER) { n = 1; while (dbOf(n) && n < EspIR.HWDB_NUMBER) n++; }
    if (n >= EspIR.HWDB_NUMBER) { setStatusLine(`DB dell'utente: numeri da 1 a ${EspIR.HWDB_NUMBER - 1} tutti usati`, "err"); return; }
    const name = await askText("Nuovo DB", `Nome di DB${n}:`, "Dati" + (n > 1 ? n : ""), "Lettere, cifre e _ (es. Nastro, Ricetta). Negli operandi: Nome.Campo (es. Nastro.Velocita).");
    if (name === null) return;
    const nm = name.trim() || "DB" + n;
    if (!EspIR.NAME_RE.test(nm)) { setStatusLine("nome del DB: lettere, cifre e _ (non all'inizio una cifra)", "err"); return; }
    if ((project.dbs || []).some(d => d.name.toLowerCase() === nm.toLowerCase())) { setStatusLine(`c'è già un DB «${U(nm)}»`, "err"); return; }
    if (!project.dbs) project.dbs = [];
    project.dbs.push({ number: n, name: nm, retain: false, fields: [] });
    project.dbs.sort((a, b) => a.number - b.number);
    markEditDirty();
    openDbPage(n);
  }
  function deleteDb(d) {
    project.dbs.splice(project.dbs.indexOf(d), 1);
    if (!project.dbs.length) delete project.dbs;
    setPlace("db" + d.number, null);
    if (dbPage === d.number) closeDbPage();
    markEditDirty(); renderBlocks();
    setStatusLine(`DB${d.number} eliminato: gli operandi che lo usano danno errore al Compile`);
  }
  function openDbMenu(x, y, d) {
    const cur = placeOfDb(d), list = folderList().map(f => ({ id: f.id, path: folderPath(f.id) })).sort((a, c) => a.path.localeCompare(c.path, "it", { numeric: true }));
    showMenu(x, y, null, [
      { label: "↗ Apri", run: () => openDbPage(d.number) },
      ...(d.hw || Number.isInteger(d.inst) ? [] : [
        { label: "✎ Rinomina", run: async () => {
            const v = await askText("Rinomina DB", `Nome di DB${d.number}:`, d.name);
            if (v === null) return;
            const e = dbRename(d, v); if (e) setStatusLine(e, "warn"); } },
        { label: "# Cambia numero", run: async () => {
            const v = await askText("Numero del DB", `Numero di «${U(d.name)}»:`, String(d.number), `Da 1 a ${EspIR.HWDB_NUMBER - 1}: gli operandi che lo usano si aggiornano.`);
            if (v === null) return;
            const e = dbRenumber(d, v); if (e) setStatusLine(e, "warn"); } }]),
      ...(list.length ? ["-", ...[{ id: null, path: "Programma (fuori dalle cartelle)" }, ...list].filter(f => f.id !== cur)
        .map(f => ({ label: `📁 Sposta in: ${f.path}`, run: () => moveTreeItem("db:" + d.number, f.id) }))] : []),
      "-",
      { label: `✕ Elimina DB${d.number}`, danger: true, run: async () => {
          if (!(await confirmAction(`Eliminare DB${d.number} «${U(d.name)}»?`, `Ha ${d.fields.length} campi.`, "Sì, elimina"))) return;
          deleteDb(d); } },
    ]);
  }
  // ── Righe della tabella (DB e pagina della struttura) ──
  //  Frecce tutte a sinistra: le strutture si aprono e si chiudono (stato nel browser). Le strutture fatte sul momento
  //  (local) si scrivono qui, sotto la riga; quelle della palette e i TIMER si vedono soltanto
  const ST_CLOSED_LS = "miaplc.stclosed";
  const stClosed = (() => { try { return new Set(JSON.parse(localStorage.getItem(ST_CLOSED_LS) || "[]")); } catch (e) { return new Set(); } })();
  const saveStClosed = () => { try { localStorage.setItem(ST_CLOSED_LS, JSON.stringify([...stClosed].slice(-500))); } catch (e) {} };
  const isLocalStruct = t => !!(project.structs || []).find(x => x.id === t && x.local);
  const structOf = id => (project.structs || []).find(x => x.id === id) || null;
  // pg: { kind: "db" | "st", d?, st?, lay (Map percorso → posizione), key, off(path, lv) → testo, rerender }
  // owner = id della struttura che ha questi campi (null: campi del DB)
  function fieldRows(tb, pg, list, depth, pre, owner) {
    list.forEach((f, i) => {
      const path = pre + f.name, lv = pg.lay.get(path), struct = EspIR.isStruct(f.type);
      const loc = struct && isLocalStruct(f.type), ck = pg.key + ":" + path, open = struct && !stClosed.has(ck);
      const tr = document.createElement("tr");
      tr.dataset.f = path;
      if (depth) tr.className = "st-mem edit";
      tr.innerHTML = `<td class="f-namec"><div class="nm-wrap"><span class="st-tog"></span><input class="f-name" maxlength="24" translate="no"></div></td>
        <td class="f-typec"></td>
        <td class="f-initc"></td><td class="f-cur num"></td>
        <td class="f-off muted"></td>
        <td><input class="f-com" maxlength="120"></td>
        <td class="del"><button class="icon f-up" title="Su">↑</button><button class="icon f-down" title="Giù">↓</button><button class="icon f-del" title="Elimina il campo">✕</button></td>`;
      tr.querySelector(".f-namec").style.paddingLeft = (4 + depth * 18) + "px";
      tr.querySelector(".f-off").textContent = lv ? pg.off(path, lv) : "";
      const tg = tr.querySelector(".st-tog");
      if (struct) {
        tg.textContent = open ? "▾" : "▸"; tg.classList.add("on");
        tg.title = open ? "Chiudi la struttura" : "Apri la struttura";
        tg.onclick = () => { if (open) stClosed.add(ck); else stClosed.delete(ck); saveStClosed(); pg.rerender(); };
      }
      const ni = tr.querySelector(".f-name"); ni.value = f.name;
      ni.addEventListener("change", () => {
        const nv = ni.value.trim();
        if (nv === f.name) return;
        if (!EspIR.NAME_RE.test(nv)) { dbMsg("nome del campo: lettere, cifre e _ (max 24, non all'inizio una cifra)", "warn"); ni.value = f.name; return; }
        if (list.some(x => x !== f && x.name.toLowerCase() === nv.toLowerCase())) { dbMsg(`c'è già un campo ${nv}`, "warn"); ni.value = f.name; return; }
        const old = f.name; dbMsg("");
        if (owner) remapStructField(owner, old, nv);    // campo di una struttura: anche negli operandi che ci passano
        else remapOps(o => o.ns === "DB" && o.db === pg.d.number && (o.f === old || o.f.startsWith(old + ".")) ? Object.assign({}, o, { f: nv + o.f.slice(old.length) }) : undefined);
        f.name = nv;
        if (struct && stClosed.delete(ck)) { stClosed.add(pg.key + ":" + pre + nv); saveStClosed(); }
        markEditDirty(); pg.rerender(); if (owner) { renderStructs(true); render(); }
      });
      typeCell(tr.querySelector(".f-typec"), f, !(pg.d && pg.d.hw), t => dbMsg(t, t ? "warn" : undefined), () => {
        if (f.init !== undefined) f.init = EspIR.cleanVal(f.type, f.init);
        if (f.init === 0 || f.init === false) delete f.init;
        pruneLocalStructs(); markEditDirty(); pg.rerender(); if (pg.kind === "st") renderStructs(true);
      }, !!owner, pg.kind === "db" && !owner);
      const ic = tr.querySelector(".f-initc");
      if (struct) ic.innerHTML = `<span class="muted">${f.type === "TIMER" ? "timer" : "struttura"}</span>`;
      else if (f.type === "BOOL") {
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!f.init;
        cb.addEventListener("change", () => { if (cb.checked) f.init = true; else delete f.init; markEditDirty(); });
        ic.appendChild(cb);
      } else {
        const ii = document.createElement("input"); ii.className = "f-init"; ii.value = fmtVal(f.type, f.init !== undefined ? f.init : 0);
        ii.addEventListener("change", () => {
          const r = parseTyped(f.type, ii.value || "0");
          if (r.err) { ii.classList.add("bad"); dbMsg(`${f.name}: ${r.err}`, "warn"); return; }
          ii.classList.remove("bad"); dbMsg("");
          if (r.v) f.init = r.v; else delete f.init;
          markEditDirty();
        });
        ic.appendChild(ii);
      }
      const ci = tr.querySelector(".f-com"); ci.value = f.comment || "";
      ci.addEventListener("change", () => { const c = ci.value.trim(); if (c) f.comment = c; else delete f.comment; markEditDirty(); });
      tr.querySelector(".f-up").disabled = i === 0;
      tr.querySelector(".f-down").disabled = i === list.length - 1;
      tr.querySelector(".f-up").onclick = () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); markEditDirty(); pg.rerender(); };
      tr.querySelector(".f-down").onclick = () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); markEditDirty(); pg.rerender(); };
      tr.querySelector(".f-del").onclick = () => { list.splice(i, 1); pruneLocalStructs(); markEditDirty(); pg.rerender(); if (pg.kind === "st") renderStructs(true); };
      if (pg.kind === "db") tr.querySelector(".f-cur").addEventListener("click", () => { if (liveMonitoring && !struct) editDbValue({ ns: "DB", db: pg.d.number, f: path }); });
      tb.appendChild(tr);
      if (!open) return;
      const st = loc && structOf(f.type);
      if (st) {                                          // struttura sul momento: i campi si scrivono qui
        fieldRows(tb, pg, st.fields, depth + 1, path + ".", st.id);
        const ar = document.createElement("tr"); ar.className = "st-mem st-addrow";
        ar.innerHTML = `<td colspan="7"><button class="ghost st-add">+ campo</button></td>`;
        ar.firstChild.style.paddingLeft = (4 + (depth + 1) * 18 + 18) + "px";
        ar.querySelector(".st-add").onclick = () => {
          let k = st.fields.length + 1; while (st.fields.some(x => x.name.toLowerCase() === "campo" + k)) k++;
          st.fields.push({ name: "campo" + k, type: "INT" }); markEditDirty(); pg.rerender();
          const r = tb.querySelector(`tr[data-f="${CSS.escape(path + ".campo" + k)}"] .f-name`); if (r) { r.focus(); r.select(); }
        };
        tb.appendChild(ar);
      } else roRows(tb, pg, EspIR.structFields(f.type) || [], depth + 1, path + ".");
    });
  }
  // campi di una struttura della palette o di un TIMER: solo da vedere (si cambiano nella pagina della struttura)
  function roRows(tb, pg, list, depth, pre) {
    for (const m of list) {
      if (m.name[0] === "_") continue;
      const path = pre + m.name, lv = pg.lay.get(path), struct = EspIR.isStruct(m.type), ck = pg.key + ":" + path, open = struct && !stClosed.has(ck);
      const mr = document.createElement("tr");
      mr.className = "st-mem"; mr.dataset.f = path;
      mr.innerHTML = `<td class="muted st-mname"><span class="st-tog"></span><span class="st-mn"></span></td><td class="muted">${escapeHtml(typeName(m.type))}</td><td class="muted">${struct ? "" : m.type === "BOOL" ? (m.init ? "1" : "0") : fmtVal(m.type, m.init || 0)}</td>` +
        `<td class="f-cur num"></td><td class="f-off muted"></td><td class="muted">${escapeHtml(m.comment || "")}</td><td></td>`;
      mr.firstChild.style.paddingLeft = (4 + depth * 18) + "px";
      mr.querySelector(".st-mn").textContent = "." + m.name;
      mr.querySelector(".f-off").textContent = lv && !lv.struct ? pg.off(path, lv) : "";
      if (struct) {
        const tg = mr.querySelector(".st-tog"); tg.textContent = open ? "▾" : "▸"; tg.classList.add("on");
        tg.onclick = () => { if (open) stClosed.add(ck); else stClosed.delete(ck); saveStClosed(); pg.rerender(); };
      }
      if (pg.kind === "db" && !struct) mr.querySelector(".f-cur").addEventListener("click", () => { if (liveMonitoring) editDbValue({ ns: "DB", db: pg.d.number, f: path }); });
      tb.appendChild(mr);
      if (open) roRows(tb, pg, EspIR.structFields(m.type) || [], depth + 1, path + ".");
    }
  }
  // strutture sul momento: una per variabile (copiata se due la usano, es. dopo un copia e incolla), via se non usata più
  function pruneLocalStructs() {
    const list = project.structs || [];
    if (!list.some(x => x.local)) return;
    const seen = new Set(), vars = [];
    for (const d of project.dbs || []) vars.push(...d.fields);
    for (const b of project.blocks) if (b.iface) for (const x of EspIR.DIRS) vars.push(...(b.iface[x] || []));
    for (const st of list) if (!st.local) vars.push(...st.fields);
    for (const v of vars) {
      if (!isLocalStruct(v.type)) continue;
      if (seen.has(v.type)) { const c = newLocalStruct(structOf(v.type).fields); v.type = c.id; }
      seen.add(v.type);
    }
    const keep = (project.structs || []).filter(x => !x.local || seen.has(x.id));
    if (keep.length !== (project.structs || []).length) { if (keep.length) project.structs = keep; else delete project.structs; }
    syncStructs(true);
  }
  function newLocalStruct(fields) {
    const n = (project.structs || []).reduce((m, x) => Math.max(m, +x.id.slice(1)), 0) + 1;
    const st = { id: "S" + n, local: true, fields: fields ? JSON.parse(JSON.stringify(fields)) : [{ name: "campo1", type: "INT" }] };
    (project.structs = project.structs || []).push(st);
    syncStructs(true);
    return st;
  }
  function pageCols(key) { if (window.MiaDbCols) window.MiaDbCols(key); }
  function renderDbPage() {
    if (stPage != null) { renderStructPage(); return; }
    const d = dbOf(dbPage);
    if (!d) { closeDbPage(); return; }
    pruneLocalStructs();
    const L = EspIR.layoutDbs(project), lay = L.dbs.get(d.number);
    const pageEl = document.getElementById("db-page");
    pageEl.classList.remove("st-mode");
    document.getElementById("db-title").textContent = dbTag(d.number);
    pageEl.classList.toggle("hwdb", !!d.hw);   // DB dell'hardware: solo campi, indirizzi e valori
    { const lim = plcLimits() || {}, area = lim.dbSize || EspIR.DB_SIZE, one = Math.min(lim.dbMax || area, 0xFFFF);
      document.getElementById("db-info").textContent = `${lay ? lay.size : 0} / ${one} byte · DB in tutto ${L.size} / ${area} byte`; }
    const nm = document.getElementById("db-name"), num = document.getElementById("db-num");
    if (document.activeElement !== nm) nm.value = d.name;
    if (document.activeElement !== num) num.value = d.number;
    document.getElementById("db-retain").checked = !!d.retain;
    if (d.hw || Number.isInteger(d.inst)) {              // HWDB: generata dalle tabelle I/O; DB d'istanza di una FB
      dbMsg(d.sys ? "Variabili di sistema: le scrive il PLC a ogni scansione, nel programma si leggono (Sistema.tick_ms, Sistema.rssi…)"
            : Number.isInteger(d.inst) ? `Memoria di una chiamata della FB${d.inst}: i campi sono le sue STATIC e si cambiano nell'interfaccia della FB. Qui gli indirizzi e i valori attuali`
            : "Generata dalle Tabelle I/O: nomi e punti si cambiano lì. Qui gli indirizzi e i valori attuali");
      setTimeout(() => document.querySelectorAll("#db-page input:not(.f-cur input), #db-page select, #db-add, #db-add2, #db-page .del button, #db-page .st-add").forEach(x => { x.disabled = true; }), 0);
    } else {                                             // DB normale: riattiva quello che una HWDB aperta prima aveva spento
      document.querySelectorAll("#db-name, #db-num, #db-retain, #db-add, #db-add2").forEach(x => { x.disabled = false; });
    }
    const tb = document.querySelector("#db-table tbody");
    tb.innerHTML = "";
    const pg = { kind: "db", d, key: "db" + d.number, lay: lay ? lay.vars : new Map(), rerender: renderDbPage,
                 off: (path, v) => v.struct ? `DBB${v.off} · ${v.size} byte` : memAbs({ ns: "DB", db: d.number, f: path }).replace(/^DB\d+\./, "") };
    fieldRows(tb, pg, d.fields, 0, "", null);
    if (!d.fields.length) tb.innerHTML = `<tr><td colspan="7" class="muted">Nessun campo: «+ Campo» per aggiungerne uno.</td></tr>`;
    renderDbValues();
    pageCols(pg.key);
  }
  // ── Pagina della struttura (Denys 04-11-2026): come il DB, con i campi della struttura della palette ──
  let stPage = null;                                     // id della struttura aperta nella pagina (null = nessuna)
  function openStructPage(id) {
    if (!structOf(id)) return;
    openDbPage(null, id);
  }
  function renderStructPage() {
    const st = structOf(stPage);
    if (!st) { closeDbPage(); return; }
    syncStructs(true);
    const lay = EspIR.layoutVars(st.fields, undefined, false, true), u = structUses(st.id);
    const pageEl = document.getElementById("db-page");
    pageEl.classList.add("st-mode"); pageEl.classList.remove("hwdb");
    document.getElementById("db-title").textContent = st.id;
    document.getElementById("db-info").textContent = `${lay.size} byte · ` + (u.length ? "usata in " + u.join(", ") : "non usata");
    document.getElementById("db-sync").textContent = "";
    dbMsg("");
    const nm = document.getElementById("db-name");
    if (document.activeElement !== nm) nm.value = st.name || "";
    document.querySelectorAll("#db-name, #db-add, #db-add2").forEach(x => { x.disabled = false; });
    const tb = document.querySelector("#db-table tbody");
    tb.innerHTML = "";
    const pg = { kind: "st", st, key: st.id, lay: lay.vars, rerender: renderStructPage,
                 off: (path, v) => v.struct ? `+${v.off} · ${v.size} byte` : v.type === "BOOL" ? `+${v.off}.${v.bit}` : `+${v.off}` };
    fieldRows(tb, pg, st.fields, 0, "", st.id);
    if (!st.fields.length) tb.innerHTML = `<tr><td colspan="7" class="muted">Nessun campo: «+ Campo» per aggiungerne uno.</td></tr>`;
    pageCols(pg.key);
  }
  function renderDbValues() {
    const d = dbOf(dbPage);
    if (!d) return;
    const on = liveMonitoring && dbOnPlc(d.number);
    document.getElementById("db-sync").textContent = !liveMonitoring ? "" : on ? "Online" : "diverso dal PLC: Download per vedere i valori";
    document.querySelectorAll("#db-table tbody tr").forEach(tr => {
      const c = tr.querySelector(".f-cur"); if (!c) return;
      const f = memVar({ ns: "DB", db: d.number, f: tr.dataset.f }), v = on ? liveNum.get(`DB${d.number}.${tr.dataset.f}`) : undefined;
      if (f && EspIR.isStruct(f.type)) { c.textContent = ""; return; }
      c.textContent = v === undefined ? "—" : f && f.type === "BOOL" ? (v ? "1" : "0") : fmtVal(f && f.type, v);
      c.classList.toggle("editable", on);
      c.title = on ? "Clic: modifica il valore nel PLC" : "";
    });
  }
  function dbInitImage(d) {
    const lay = EspIR.layoutDbs(project).dbs.get(d.number), img = new Uint8Array(lay.size);
    for (const v of lay.vars.values()) {
      if (v.struct) continue;                           // strutture: i loro campi
      const x = EspIR.cleanVal(v.type, v.v.init);
      if (v.type === "BOOL") { if (x) img[v.off] |= 1 << v.bit; }
      else img.set(dbEncode(v.type, x), v.off);
    }
    return { lay, img };
  }
  async function dbLoadActualToInit() {
    const d = dbOf(dbPage); if (!d) return;
    if (!dbOnPlc(d.number)) { dbMsg(`DB${d.number} sul PLC è diverso da quello dell'editor: prima Compile e Download.`, "warn"); return; }
    const lay = EspIR.layoutDbs(project).dbs.get(d.number);
    try {
      const b = await dbReadRange(lay.base, lay.size);
      const take = (list, pre) => { for (const f of list) {          // anche i campi delle strutture sul momento
        const v = lay.vars.get(pre + f.name); if (!v) continue;
        if (v.struct) { const st = isLocalStruct(f.type) && structOf(f.type); if (st) take(st.fields, pre + f.name + "."); continue; }
        const x = dbDecode(b, v.off, v); if (x) f.init = f.type === "REAL" ? Math.fround(x) : x; else delete f.init; } };
      take(d.fields, "");
      markEditDirty(); renderDbPage();
      dbMsg("Valori attuali del PLC copiati nei valori iniziali (Download per mandarli al PLC).");
    } catch (e) { dbMsg("lettura dal PLC non riuscita: " + e.message, "warn"); }
  }
  async function dbLoadInitToActual() {
    const d = dbOf(dbPage); if (!d) return;
    if (!dbOnPlc(d.number)) { dbMsg(`DB${d.number} sul PLC è diverso da quello dell'editor: prima Compile e Download.`, "warn"); return; }
    if (!(await confirmAction(`Valori iniziali nel PLC?`, `Tutti i campi di DB${d.number} «${U(d.name)}» prendono subito il valore iniziale, anche con il PLC in RUN.`, "Sì, scrivi"))) return;
    const { lay, img } = dbInitImage(d);
    try { await dbWriteBytes(lay.base, img); dbMsg("Valori iniziali scritti nel PLC."); pollStatus(); }
    catch (e) { dbMsg("scrittura nel PLC non riuscita: " + e.message, "warn"); }
  }
  function dbZeroInit() {
    const d = dbOf(dbPage); if (!d) return;
    const zero = list => list.forEach(f => { delete f.init; const st = isLocalStruct(f.type) && structOf(f.type); if (st) zero(st.fields); });
    zero(d.fields);
    markEditDirty(); renderDbPage();
    dbMsg("Valori iniziali a 0 (Download per mandarli al PLC).");
  }
  // nome e numero del DB: dalla pagina del DB o dal menu dell'albero (tasto destro). → testo dell'errore, "" = fatto
  function dbRename(d, nv) {
    nv = String(nv || "").trim();
    if (!d || nv === d.name) return "";
    if (!EspIR.NAME_RE.test(nv)) return "nome del DB: lettere, cifre e _ (max 24, non all'inizio una cifra)";
    if (project.dbs.some(x => x !== d && x.name.toLowerCase() === nv.toLowerCase())) return `c'è già un DB «${U(nv)}»`;
    d.name = nv; markEditDirty(); renderDbPageIfOpen(); renderBlocks();
    return "";
  }
  function dbRenumber(d, n) {
    n = parseInt(n, 10);
    if (!d || n === d.number) return "";
    if (!(n >= 1 && n < EspIR.HWDB_NUMBER)) return `numero del DB: da 1 a ${EspIR.HWDB_NUMBER - 1}, dal ${EspIR.HWDB_NUMBER} in su sono le DB dell'hardware`;
    if (dbOf(n)) return `c'è già un DB${n}`;
    const old = d.number; d.number = n; project.dbs.sort((a, b) => a.number - b.number);
    if (project.place && project.place["db" + old]) { setPlace("db" + n, project.place["db" + old]); setPlace("db" + old, null); }
    remapOps(o => o.ns === "DB" && o.db === old ? { ns: "DB", db: n, f: o.f } : undefined);
    if (dbPage === old) dbPage = n;
    markEditDirty(); renderDbPageIfOpen(); renderBlocks();
    return "";
  }
  function dbSetName() {
    const inp = document.getElementById("db-name");
    if (stPage != null) {                                // pagina della struttura: il suo nome
      const st = structOf(stPage), e = st ? structRename(st, inp.value) : "";
      if (e) { dbMsg(e, "warn"); inp.value = st.name || ""; } else dbMsg("");
      return;
    }
    const d = dbOf(dbPage), e = dbRename(d, inp.value);
    if (e) { dbMsg(e, "warn"); inp.value = d.name; } else dbMsg("");
  }
  function dbSetNumber() {
    const d = dbOf(dbPage), inp = document.getElementById("db-num"), e = dbRenumber(d, inp.value);
    if (e) { dbMsg(e, "warn"); inp.value = d.number; } else dbMsg("");
  }
  function dbAddField() {
    const d = stPage != null ? structOf(stPage) : dbOf(dbPage); if (!d) return;
    let k = d.fields.length + 1; while (d.fields.some(f => f.name.toLowerCase() === "campo" + k)) k++;
    d.fields.push({ name: (stPage != null ? "campo" : "Campo") + k, type: "INT" });
    if (stPage != null) renderStructs(true);
    markEditDirty(); renderDbPage();
    const rows = document.querySelectorAll("#db-table .f-name"); const last = rows[rows.length - 1];
    if (last) { last.focus(); last.select(); }
  }

  // ── v5.2 (P01): strutture del progetto, nella palette dopo le Istruzioni ──
  //  Generate: quelle con un nome (tendina per nome); Altro: solo con l'id (es. usate una volta sola). Campi nome / tipo
  function newStruct(name) {
    const n = (project.structs || []).reduce((m, x) => Math.max(m, +x.id.slice(1)), 0) + 1;
    const st = Object.assign({ id: "S" + n }, name ? { name } : {}, { fields: [{ name: "campo1", type: "INT" }] });
    (project.structs = project.structs || []).push(st);
    syncStructs(true); markEditDirty(); renderStructs(true);
    return st;
  }
  // nome della struttura: lettere, cifre e _, non TIMER né S1, S2…, non ripetuto → testo dell'errore, "" = valido
  function structNameErr(st, v) {
    if (!EspIR.NAME_RE.test(v) || v === "TIMER" || EspIR.STRUCT_RE.test(v)) return "nome della struttura: lettere, cifre e _ (non TIMER né S1, S2…)";
    if ((project.structs || []).some(x => x !== st && (x.name || "").toLowerCase() === v.toLowerCase())) return `c'è già una struttura ${v}`;
    return "";
  }
  // «＋ Nuova struttura» (Denys 04-11-2026): il nome, poi si apre nella pagina come un DB e si popola lì
  async function newStructAsk() {
    const v = await askText("Nuova struttura", "Nome della struttura:", "", "Lettere, cifre e _ (es. Motore, Ricetta). Si usa come tipo nei DB e nelle FC.");
    if (v === null) return null;
    const nm = v.trim(), e = structNameErr(null, nm);
    if (e) { setStatusLine(e, "warn"); return null; }
    return newStruct(nm);
  }
  function structRename(st, v) {
    v = String(v || "").trim();
    if (v === (st.name || "")) return "";
    const e = v ? structNameErr(st, v) : "nome della struttura: lettere, cifre e _ (non TIMER né S1, S2…)";
    if (e) return e;
    st.name = v; markEditDirty(); renderStructs(true); renderDbPageIfOpen(); renderIface(true);
    return "";
  }
  function deleteStruct(st) {
    const u = structUses(st.id);
    if (u.length) { setStatusLine(`${st.name || st.id} è usata in ${u.join(", ")}: prima cambia il tipo lì`, "warn"); return; }
    const list = project.structs;
    list.splice(list.indexOf(st), 1); if (!list.length) delete project.structs;
    if (stPage === st.id) closeDbPage();
    syncStructs(true); markEditDirty(); renderStructs(true);
  }
  function openStructMenu(x, y, st) {
    showMenu(x, y, null, [
      { label: "↗ Apri", run: () => openStructPage(st.id) },
      { label: "✎ Rinomina", run: async () => {
          const v = await askText("Rinomina struttura", `Nome di ${st.id}:`, st.name || "");
          if (v === null) return;
          const e = structRename(st, v); if (e) setStatusLine(e, "warn"); } },
      "-",
      { label: `✕ Elimina ${st.name || st.id}`, danger: true, run: () => deleteStruct(st) },
    ]);
  }
  // dove si usa una struttura: DB, FC, altre strutture → testi
  function structUses(id) {
    const out = [];
    for (const d of project.dbs || []) if (d.fields.some(f => f.type === id)) out.push(dbTag(d.number));
    for (const b of project.blocks) if (b.iface && EspIR.DIRS.some(x => (b.iface[x] || []).some(v => v.type === id))) out.push(EspIR.blockLabel(b));
    return out;
  }
  // campo della struttura rinominato: anche negli operandi che ci passano (DB.var.campo, #var.campo)
  function remapStructField(id, old, nv) {
    const fix = (list, path) => {
      const segs = path.split("."), out = [];
      let cur = list;
      for (let i = 0; i < segs.length; i++) {
        const v = (cur || []).find(x => x.name === segs[i]);
        if (!v) return null;
        out.push(segs[i]);
        if (i + 1 < segs.length && v.type === id && segs[i + 1] === old) { segs[i + 1] = nv; }
        cur = EspIR.isStruct(v.type) ? EspIR.structFields(v.type) : null;
      }
      return segs.join(".");
    };
    for (const b of project.blocks) {
      const vars = b.iface ? EspIR.DIRS.flatMap(x => b.iface[x] || []) : [];
      remapOps(o => {
        if (o.ns === "DB" && o.f.includes(".")) { const d = dbOf(o.db), n = d && fix(d.fields, o.f); return n && n !== o.f ? Object.assign({}, o, { f: n }) : undefined; }
        if (o.ns === "L" && o.v.includes(".")) { const n = fix(vars, o.v); return n && n !== o.v ? { ns: "L", v: n } : undefined; }
      }, b);
    }
  }
  // palette, Strutture: clic = la sua pagina (come un DB), tasto destro = apri / rinomina / elimina
  function renderStructs(force) {
    const box = document.getElementById("struct-list");
    if (!box || (!force && box.contains(document.activeElement))) return;
    syncStructs(true);
    const list = (project.structs || []).filter(x => !x.local);
    box.innerHTML = list.length ? "" : `<div class="muted small st-empty">Nessuna struttura: «＋ Nuova struttura» qui sotto.</div>`;
    for (const st of list) {
      const d = document.createElement("div");
      d.className = "block-item st-item" + (stPage === st.id ? " active" : "");
      d.innerHTML = `<span class="bi-icon">S</span><span class="bi-name" translate="no"></span><span class="bi-count"></span>`;
      d.querySelector(".bi-name").textContent = st.name || st.id;
      d.querySelector(".bi-count").textContent = `${st.name ? st.id + " · " : ""}${EspIR.layoutVars(st.fields, undefined, false, true).size} B`;
      d.title = "Clic: apri la struttura. Tasto destro: rinomina, elimina";
      d.addEventListener("click", () => openStructPage(st.id));
      d.addEventListener("contextmenu", e => { e.preventDefault(); openStructMenu(e.clientX, e.clientY, st); });
      box.appendChild(d);
    }
  }
  function renderDbPageIfOpen() { if (dbPage != null || stPage != null) renderDbPage(); }

  // ── Interfaccia della FC aperta: IN, OUT, IN_OUT, TEMP ──
  const DIR_TXT = { in: "IN", out: "OUT", inout: "IN_OUT", static: "STATIC", temp: "TEMP" };
  let ifaceSig = null;
  function ifaceOpen() { try { return localStorage.getItem("espplc.iface.closed") !== "1"; } catch (e) { return true; } }
  function renderIface(force) {
    const box = document.getElementById("iface");
    if (!box) return;
    const fc = program && program.type === "fc";
    box.classList.toggle("hidden", !fc);
    if (!fc) { ifaceSig = null; return; }
    const sig = program.id + "|" + JSON.stringify(program.iface || {}) + "|" + ifaceOpen();
    if (!force && (sig === ifaceSig || box.contains(document.activeElement))) return;
    ifaceSig = sig;
    const f = program.iface || {}, lay = EspIR.layoutIface(program), open = ifaceOpen();
    const n = EspIR.DIRS.reduce((s, d) => s + (f[d] || []).length, 0);
    box.innerHTML = `<div class="iface-head"><span class="iface-tog">${open ? "▾" : "▸"}</span> Interfaccia <span class="muted">${n} variabili · ${lay.size} byte di dati locali</span></div>`;
    box.querySelector(".iface-head").onclick = () => { try { localStorage.setItem("espplc.iface.closed", open ? "1" : "0"); } catch (e) {} renderIface(true); };
    if (!open) return;
    if (sysFc(program)) setTimeout(() => box.querySelectorAll("input, select, button.v-add, button.v-del").forEach(x => { x.disabled = true; }), 0);   // generata: sola lettura
    const t = document.createElement("table");
    t.className = "iface-table";
    const txt = EspIR.TEXT_LANGS.includes(program.language);   // v5.1: array [min..max] solo nelle FC in testo
    t.innerHTML = `<thead><tr><th></th><th>Nome</th><th>Tipo</th><th>Default</th><th>Commento</th><th></th></tr></thead>`;
    const tb = document.createElement("tbody");
    for (const dir of EspIR.DIRS) {
      const list = f[dir] || [];
      const hr = document.createElement("tr");
      hr.className = "iface-sec";
      hr.innerHTML = `<td colspan="5"><b>${DIR_TXT[dir]}</b> <span class="muted">${{ in: "valori in ingresso (costanti ammesse; non collegati = default)", out: "risultati, copiati fuori alla fine (solo con EN = 1)",
        inout: "letti all'inizio e riscritti alla fine: vanno collegati a una variabile",
        static: "memoria della FB: resta da una chiamata all'altra, ogni chiamata ha la sua (DB d'istanza)", temp: "di lavoro, a 0 a ogni chiamata" }[dir]}</span></td><td><button class="icon v-add" title="Aggiungi">＋</button></td>`;
      hr.querySelector(".v-add").onclick = async () => {
        if (dir === "static" && !EspIR.isFB(program) && !(await confirmAction("La FC diventa una FB",
            "Con le variabili STATIC ogni chiamata ha la sua memoria: un DB d'istanza creato da solo, che resta da un ciclo all'altro.", "Sì, diventa FB"))) return;
        let k = 1; const all = EspIR.DIRS.flatMap(x => f[x] || []);
        while (all.some(v => v.name.toLowerCase() === (dir + k).toLowerCase())) k++;
        if (!program.iface) program.iface = {};
        (program.iface[dir] = program.iface[dir] || []).push({ name: dir + k, type: dir === "temp" ? "INT" : "BOOL" });
        markEditDirty(); renderIface(true); if (dir === "static") renderBlocks();
        const ins = box.querySelectorAll(`tr[data-dir="${dir}"] .v-name`); const last = ins[ins.length - 1]; if (last) { last.focus(); last.select(); }
      };
      tb.appendChild(hr);
      list.forEach((v, i) => {
        const tr = document.createElement("tr");
        tr.dataset.dir = dir;
        const lv = lay.vars.get(v.name);
        tr.innerHTML = `<td class="muted">${lv ? lv.off + (v.type === "BOOL" ? "." + lv.bit : "") : ""}</td><td><input class="v-name" maxlength="24" translate="no"></td>
          <td class="v-typec"></td>
          <td>${(dir === "in" || dir === "static") && !EspIR.isStruct(v.type) ? `<input class="v-def">` : ""}</td><td><input class="v-com" maxlength="120"></td><td><button class="icon v-del" title="Elimina">✕</button></td>`;
        typeCell(tr.querySelector(".v-typec"), v, txt && dir !== "static", t => { if (t) setStatusLine(t, "warn"); }, () => {
          if (v.def !== undefined) v.def = EspIR.cleanVal(v.type, v.def);
          markEditDirty(); renderIface(true); render();
        });
        const ni = tr.querySelector(".v-name"); ni.value = v.name;
        ni.addEventListener("change", () => {
          const nv = ni.value.trim();
          if (nv === v.name) return;
          const all = EspIR.DIRS.flatMap(x => (program.iface && program.iface[x]) || []);
          if (!EspIR.NAME_RE.test(nv) || all.some(x => x !== v && x.name.toLowerCase() === nv.toLowerCase())) {
            setStatusLine(EspIR.NAME_RE.test(nv) ? `c'è già una variabile ${nv}` : "nome: lettere, cifre e _ (max 24, non all'inizio una cifra)", "warn"); ni.value = v.name; return; }
          const old = v.name; v.name = nv;
          remapOps(o => o.ns === "L" && (o.v === old || o.v.startsWith(old + ".")) ? { ns: "L", v: nv + o.v.slice(old.length) } : undefined, program);
          for (const b of project.blocks) EspIR.eachElement({ blocks: [b] }, x => {          // chiamate: il parametro cambia nome
            if (x && x.args && (x.type === "Call" || x.kind === "CALL") && x.fc === program.number && old in x.args) { x.args[nv] = x.args[old]; delete x.args[old]; }
          });
          markEditDirty(); renderIface(true); render();
        });
        const di = tr.querySelector(".v-def");
        if (di) {
          di.value = v.def === undefined ? "" : v.type === "BOOL" ? (v.def ? "TRUE" : "FALSE") : fmtVal(v.type, v.def);
          di.placeholder = v.type === "BOOL" ? "FALSE" : "0";
          di.addEventListener("change", () => {
            if (!di.value.trim()) { delete v.def; markEditDirty(); return; }
            const r = parseTyped(v.type, di.value);
            if (r.err) { di.classList.add("bad"); setStatusLine(`${v.name}: ${r.err}`, "warn"); return; }
            di.classList.remove("bad"); v.def = r.v; markEditDirty();
          });
        }
        const ci = tr.querySelector(".v-com"); ci.value = v.comment || "";
        ci.addEventListener("change", () => { const c = ci.value.trim(); if (c) v.comment = c; else delete v.comment; markEditDirty(); });
        tr.querySelector(".v-del").onclick = async () => {
          if (dir === "static" && list.length === 1 && !(await confirmAction("La FB torna FC",
              "Le chiamate perdono la loro memoria (i DB d'istanza si cancellano); dove il blocco usa ancora le STATIC compare l'errore.", "Sì, torna FC"))) return;
          list.splice(i, 1); if (!list.length) delete program.iface[dir];
          if (!Object.keys(program.iface).length) delete program.iface;
          markEditDirty(); renderIface(true); render(); if (dir === "static") renderBlocks();
        };
        tb.appendChild(tr);
      });
    }
    t.appendChild(tb);
    box.appendChild(t);
  }

  // ── Chiamata con parametri ──
  const fcOf = n => project.blocks.find(b => b.type === "fc" && b.number === n) || null;
  const fcParams = fb => fb ? EspIR.layoutIface(fb).params.filter(p => p.dir !== "static") : [];   // STATIC: nel DB d'istanza, non sul box
  // operando accanto al pin, secondo le Etichette
  function argShow(o) {
    if (o && isMemOp(o)) { const l = memLabel(o); return l.name || l.addr; }
    if (o && typeof o.k !== "number" && typeof o.k !== "boolean" && EspSymbols.mode() === "addr") return varKey(o);
    return argText(o);
  }
  function argText(o) {
    if (!o) return "";
    if (typeof o.k === "boolean") return o.k ? "TRUE" : "FALSE";
    if (isKonst(o)) return fmtNum(o.k, !Number.isInteger(o.k));
    if (isMemOp(o)) return memText(o);
    return EspSymbols.nameOf(o) || varKey(o);
  }
  // Box di chiamata come un blocco: IN e IN_OUT a sinistra, OUT a destra, uno per riga sotto EN / ENO;
  // gli operandi fuori dal box, accanto al loro pin. → null se la FC non ha parametri
  function callGeom(c) {
    const ps = fcParams(fcOf(c.fc));
    if (!ps.length) return null;
    const a = c.args || {}, L = ps.filter(p => p.dir !== "out"), R = ps.filter(p => p.dir === "out");
    const fs = exprFs(), pfs = Math.max(7, fs - 2), pinH = Math.max(14, pfs + 8);
    const opTxt = p => a[p.name] ? argShow(a[p.name]) : p.dir === "in" ? (p.v.def === undefined ? (p.type === "BOOL" ? "FALSE" : "0") : p.type === "BOOL" ? (p.v.def ? "TRUE" : "FALSE") : fmtNum(p.v.def, p.type === "REAL")) : "";
    const opW = list => Math.max(0, ...list.map(p => tw(opTxt(p), "num-expr", fs)));
    const pinName = p => p.name + (p.dir === "inout" ? " ⇄" : "");
    const nw = list => Math.max(0, ...list.map(p => tw(pinName(p), "timer-pin", pfs)));
    const lw = Math.ceil(opW(L)) + 14, rw = Math.ceil(opW(R)) + 14;
    const boxW = Math.max(TMR_W, Math.ceil(nw(L) + nw(R)) + 28, Math.ceil(tw("FC" + c.fc, "call-title", fs + 1)) + 50);
    const rows = Math.max(L.length, R.length);
    return { L, R, a, fs, pfs, pinH, lw, rw, boxW, w: lw + boxW + rw, rows, boxPx: BOX_H + rows * pinH + 4, opTxt, pinName };
  }
  // Box numerici e confronti come le FC: nel box il nome, sotto un pin per operando, ingressi a sinistra e uscite a destra
  const BOX_UNARY = { MOVE: 1, CONV: 1, NEG: 1, ABS: 1, SQRT: 1, SQR: 1, INV: 1, SWAP: 1 };
  function boxPins(n) {
    if (n.cmp) return { L: [["IN1", n.a], ["IN2", n.b]], R: [] };
    let L;
    if (isCounter(n)) {
      L = [["PV", n.a]];
      if (n.box === "CTUD") L.push(["CD", n.cd]);
      L.push(["R", n.r]);
      if (n.box !== "CTU") L.push(["LD", n.ld]);
      return { L, R: [["CV", n.out]] };
    }
    if (BOX_PINS[n.box]) L = BOX_PINS[n.box].map((p, i) => [p, n[BOX_F[i]]]);
    else if (BOX_UNARY[n.box]) L = [["IN", n.a]];
    else L = [["IN1", n.a], ["IN2", n.b]];
    return { L, R: [["OUT", n.out]] };
  }
  const pinOpText = o => !o ? "" : isKonst(o) || isNumVar(o) ? odText(o) : isMemOp(o) ? memText(o) : (EspSymbols.nameOf(o) || varKey(o));
  function boxGeom(n) {
    const { L, R } = boxPins(n);
    const fs = exprFs(), pfs = Math.max(7, fs - 2), pinH = Math.max(14, pfs + 8);
    const opW = list => Math.max(0, ...list.map(([, o]) => tw(pinOpText(o) || "?", "num-expr", fs)));
    const nw = list => Math.max(0, ...list.map(([p]) => tw(p, "timer-pin", pfs)));
    const title = n.cmp ? n.cmp : n.box;
    const lw = Math.ceil(opW(L)) + 14, rw = R.length ? Math.ceil(opW(R)) + 14 : 0;
    const boxW = Math.max(BOX_W + 16, Math.ceil(nw(L) + nw(R)) + 28, Math.ceil(tw(title, "call-title", fs + 1)) + 50);
    const rows = Math.max(L.length, R.length);
    return { L, R, fs, pfs, pinH, lw, rw, boxW, w: lw + boxW + rw, rows, boxPx: BOX_H + rows * pinH + 4, title };
  }
  // Box e chiamate si allungano verso il basso: righe intere se arrivano alla riga dopo, altrimenti solo i pixel che
  // escono dal fondo del rung (measPad: un box con un ingresso e un'uscita, MOVE, NEG… non resta tagliato)
  let measPad = 0;
  function rowsFor(g) {
    const need = BOX_H / 2 + g.rows * g.pinH + 4 + 6;               // sotto il centro della riga: pin e operandi
    const n = 1 + Math.max(0, Math.ceil((need - ROW_H / 2) / ROW_H));
    measPad = Math.max(measPad, need - ((n - 1) * ROW_H + BOX_H / 2 + 14));
    return n;
  }
  function boxRowsN(n) { return rowsFor(boxGeom(n)); }
  // righe del ladder occupate da una chiamata (il box si allunga verso il basso)
  function callRowsN(c) {
    const g = callGeom(c);
    return g ? rowsFor(g) : 1;
  }
  function callExpr(c) {
    const ps = fcParams(fcOf(c.fc)), a = c.args || {};
    return ps.filter(p => a[p.name]).map(p => `${p.name}${p.dir === "in" ? "=" : p.dir === "out" ? "→" : "⇄"}${argText(a[p.name])}`).join("  ");
  }
  // testo → operando per un parametro p: { o } | { err } | {} (vuoto)
  function parseArg(p, txt) {
    const t = String(txt || "").trim();
    if (!t) return {};
    if (p.type === "BOOL") {
      if (/^(true|false)$/i.test(t) || t === "1" || t === "0") return p.dir === "in" ? { o: { k: /^(true|1)$/i.test(t) } } : { err: "qui serve un bit, non una costante" };
      const k = EspSymbols.parseKey(t) || EspSymbols.lookup(t);
      if (k && (k.bit != null || !NUM_NS.includes(k.ns))) return { o: k.bit != null ? { ns: k.ns, idx: k.idx, bit: k.bit } : { ns: k.ns, idx: k.idx } };
      const r = parseMemRef(t);
      if (r && r.err) return r;
      if (r) return r.type === "BOOL" ? { o: r.o } : { err: `${memText(r.o)} è ${r.type}: qui serve un BOOL` };
      return { err: "scrivi un bit (I0, M5, Dati.Avvio, #abil) o TRUE / FALSE" };
    }
    if (EspIR.isStruct(p.type)) {                         // v5.2: struttura, dello stesso tipo
      const m = parseMemRef(t);
      if (!m || m.err) return m || { err: `qui serve una variabile ${typeName(p.type)}` };
      return m.type === p.type ? { o: m.o } : { err: `${memText(m.o)} è ${typeName(m.type)}: qui serve ${typeName(p.type)}` };
    }
    const r = parseNumOp(t);
    if (r.err) return r;
    if (isKonst(r.o)) {
      if (p.dir !== "in") return { err: "qui serve una variabile, non una costante" };
      const q = parseTyped(p.type, t);
      return q.err ? q : { o: { k: q.v } };
    }
    if (numT(r.o) !== EspIR.baseType(p.type)) return { err: `${odText(r.o)} è ${memType(r.o) || numT(r.o)}: qui serve un ${p.type} (usa CONV prima)` };
    return { o: r.o };
  }
  let callTarget = null;
  function openCallDialog(c) {
    closeMenus();
    callTarget = c;
    const sel = document.getElementById("cd-fc");
    const fcs = project.blocks.filter(b => b.type === "fc" && !(program.type === "fc" && b.number === program.number));
    sel.innerHTML = fcs.map(b => `<option value="${b.number}">${escapeHtml(EspIR.blockLabel(b))}</option>`).join("");
    sel.value = String(c.fc);
    document.getElementById("cd-dl-bool").innerHTML = EspSymbols.list().filter(sy => sy.name && !NUM_NS.includes(sy.ns))
      .map(sy => `<option value="${escapeHtml(sy.name)}">${sy.key}</option>`).join("") + memOptions("bool");
    document.getElementById("cd-dl-num").innerHTML = memOptions("num");
    callRows();
    render();
    document.getElementById("call-modal").classList.remove("hidden");
    setTimeout(() => { const f = document.querySelector("#cd-rows input"); if (f) f.focus(); }, 0);
  }
  function callRows() {
    const fb = fcOf(+document.getElementById("cd-fc").value), rows = document.getElementById("cd-rows"), a = (callTarget && callTarget.args) || {};
    const ps = fcParams(fb);
    rows.innerHTML = ps.length ? "" : `<div class="muted">${fb ? EspIR.blockLabel(fb) + " non ha parametri (Interfaccia della FC)." : ""}</div>`;
    for (const p of ps) {
      const r = document.createElement("div");
      r.className = "row";
      r.innerHTML = `<label class="cd-lab" translate="no"></label><input type="text" autocomplete="off" style="flex:1 1 auto" list="${p.type === "BOOL" ? "cd-dl-bool" : "cd-dl-num"}"><span class="muted np-hint"></span>`;
      const lab = r.querySelector("label");
      lab.textContent = `${p.name} · ${DIR_TXT[p.dir]} ${p.type}`;
      if (p.v.comment) { const c = document.createElement("div"); c.className = "cd-com"; c.setAttribute("translate", "no"); c.textContent = p.v.comment; lab.appendChild(c); lab.title = U(p.v.comment); }
      const inp = r.querySelector("input");
      inp.dataset.p = p.name;
      inp.value = a[p.name] ? argText(a[p.name]) : "";
      inp.placeholder = p.dir === "in" ? `non collegato = ${p.v.def === undefined ? (p.type === "BOOL" ? "FALSE" : "0") : p.type === "BOOL" ? (p.v.def ? "TRUE" : "FALSE") : fmtNum(p.v.def, p.type === "REAL")}`
                      : p.dir === "out" ? "non collegato = scartato" : "va collegato a una variabile";
      inp.addEventListener("input", checkCallDialog);
      attachSuggest(inp, p.type === "BOOL" ? "bool" : "num");
      inp.addEventListener("keydown", e => { if (e.key === "Enter") commitCallDialog(); if (e.key === "Escape") closeCallDialog(); });
      rows.appendChild(r);
    }
    checkCallDialog();
  }
  function checkCallDialog() {
    const fb = fcOf(+document.getElementById("cd-fc").value), out = {};
    let ok = !!fb;
    for (const p of fcParams(fb)) {
      const inp = document.querySelector(`#cd-rows input[data-p="${p.name}"]`), h = inp.parentElement.querySelector(".np-hint");
      const r = parseArg(p, inp.value);
      if (r.err) { h.textContent = "⚠ " + r.err; h.style.color = "var(--bad)"; ok = false; continue; }
      if (!r.o && p.dir === "inout") { h.textContent = "da collegare"; h.style.color = "var(--bad)"; ok = false; continue; }
      h.style.color = ""; h.textContent = r.o && isKonst(r.o) ? "costante" : "";
      if (r.o) out[p.name] = r.o;
    }
    document.getElementById("cd-ok").disabled = !ok;
    return ok ? { fc: fb.number, args: out } : null;
  }
  function closeCallDialog() {
    document.getElementById("call-modal").classList.add("hidden");
    callTarget = null; render();
  }
  function commitCallDialog() {
    const r = checkCallDialog();
    if (!r || !callTarget) return;
    callTarget.fc = r.fc;
    if (Object.keys(r.args).length) callTarget.args = r.args; else delete callTarget.args;
    closeCallDialog(); markEditDirty(); render();
  }

  // ── Suggerimenti mentre si scrive un operando: DB → «Nome.» → campi → (campo numerico, solo bit) «.bit»; #variabili; simboli ──
  //  kind: "bool" (contatti, bobine, parametri BOOL) o "num" (box, confronti, parametri numerici)
  let acBox = null, acInp = null, acItems = [], acSel = 0;
  function acList(t, kind) {
    const out = [], low = t.toLowerCase(), okT = ty => kind === "bool" ? true : ty !== "BOOL";
    const okF = ty => kind === "num" ? ty !== "BOOL" : true;          // bool: anche i numerici (poi il bit); any: tutti
    let m = /^#\s*([A-Za-z0-9_]*)$/.exec(t);
    if (m) {
      if (kind === "any" || kind === "anyw") return out;
      const f = (program && program.type === "fc" && program.iface) || {};
      for (const dir of EspIR.DIRS) for (const { path, v } of leafVars(f[dir] || [])) {
        const st = EspIR.isStruct(v.type);
        if ((st || (kind === "bool" ? v.type === "BOOL" : v.type !== "BOOL")) && path.toLowerCase().startsWith(m[1].toLowerCase()) && (st || !path.slice(m[1].length).includes(".")))
          out.push({ text: "#" + path + (st ? "." : ""), label: "#" + path + (st ? "." : ""), det: `${DIR_TXT[dir]} ${typeName(v.type)}`, more: st });
      }
      return out;
    }
    m = /^#\s*([A-Za-z0-9_.]*)$/.exec(t);
    if (m) {
      const f = (program && program.type === "fc" && program.iface) || {};
      for (const dir of EspIR.DIRS) for (const { path, v } of leafVars(f[dir] || [])) {
        const st = EspIR.isStruct(v.type), rest = path.slice(m[1].length);
        if (!path.toLowerCase().startsWith(m[1].toLowerCase()) || rest.includes(".") || !(st || (kind === "bool" ? v.type === "BOOL" : v.type !== "BOOL"))) continue;
        out.push({ text: "#" + path + (st ? "." : ""), label: path.split(".").pop() + (st ? "." : ""), det: `${DIR_TXT[dir]} ${typeName(v.type)}${v.comment ? " — " + U(v.comment) : ""}`, more: st });
      }
      return out;
    }
    m = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\.\s*([A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.?)$/.exec(t);
    if (m && m[3].includes(".")) {                                     // v5.2: dentro una struttura (Dati.mot.)
      const dn = m[1] || m[2];
      const d = /^DB\d+$/i.test(dn) && dbOf(+dn.slice(2)) || (project.dbs || []).find(x => x.name.toLowerCase() === dn.toLowerCase());
      if (!d) return out;
      const cut = m[3].lastIndexOf("."), head = findPath(d.fields, m[3].slice(0, cut)), pre = m[3].slice(cut + 1).toLowerCase();
      const fs = head && EspIR.isStruct(head.v.type) ? EspIR.structFields(head.v.type) : null;
      for (const f of fs || []) {
        if (f.name[0] === "_" || !f.name.toLowerCase().startsWith(pre)) continue;
        const st = EspIR.isStruct(f.type);
        if (!st && !okF(f.type)) continue;
        out.push({ text: `${d.name}.${head.path}.${f.name}${st ? "." : ""}`, label: f.name + (st ? "." : ""), det: typeName(f.type) + (f.comment ? " — " + U(f.comment) : ""), more: st });
      }
      return out;
    }
    m = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\.\s*([A-Za-z0-9_]*)(?:\.(\d*))?$/.exec(t);
    if (m) {
      const dn = m[1] || m[2];
      const d = /^DB\d+$/i.test(dn) && dbOf(+dn.slice(2)) || (project.dbs || []).find(x => x.name.toLowerCase() === dn.toLowerCase());
      if (!d) return out;
      if (m[4] !== undefined) {                                        // bit di un campo numerico
        const f = d.fields.find(x => x.name.toLowerCase() === m[3].toLowerCase());
        if (!f || f.type === "BOOL" || kind === "num") return out;
        for (let b = 0; b < EspIR.TYPE_W[f.type] * 8; b++) if (String(b).startsWith(m[4])) out.push({ text: `${d.name}.${f.name}.${b}`, label: `${f.name}.${b}`, det: `bit ${b} di ${f.type}` });
        return out;
      }
      for (const f of d.fields) {
        if (EspIR.isStruct(f.type) && f.name.toLowerCase().startsWith(m[3].toLowerCase())) {   // struttura: si continua con «.»
          out.push({ text: `${d.name}.${f.name}.`, label: f.name + ".", det: typeName(f.type) + (f.comment ? " — " + U(f.comment) : ""), more: true });
          continue;
        }
        if (!okF(f.type) || !f.name.toLowerCase().startsWith(m[3].toLowerCase())) continue;
        const toBit = kind === "bool" && f.type !== "BOOL";
        out.push({ text: `${d.name}.${f.name}${toBit ? "." : ""}`, label: f.name + (toBit ? "." : ""), det: f.type + (toBit ? " · scegli il bit" : "") + (f.comment ? " — " + U(f.comment) : ""), more: toBit });
      }
      return out;
    }
    if (!/^[A-Za-z_]*$/.test(t)) return out;
    for (const d of project.dbs || [])
      if (d.name.toLowerCase().startsWith(low) && d.fields.some(f => okT(f.type)))
        out.push({ text: d.name + ".", label: d.name + ".", det: `${dbTag(d.number)} · ${d.fields.length} campi`, more: true });
    if ((kind === "bool" || kind === "num") && program && program.type === "fc" && program.iface && (!t || "#".startsWith(low)))
      out.push({ text: "#", label: "#", det: "variabili della FC", more: true });
    const symOk = sy => kind === "bool" ? !NUM_NS.includes(sy.ns) : kind === "any" ? (sy.ns === "I" || sy.ns === "Q" || sy.ns === "M") && sy.bit == null : kind === "anyw" ? sy.ns === "M" && sy.bit == null : false;
    if (kind !== "num" && t)
      for (const sy of EspSymbols.list()) if (sy.name && symOk(sy) && sy.name.toLowerCase().startsWith(low) && out.length < 40)
        out.push({ text: sy.name, label: sy.name, det: sy.key + (sy.comment ? " — " + sy.comment : "") });
    return out;
  }
  function acClose() { if (acBox) acBox.classList.add("hidden"); acInp = null; acItems = []; }
  function acShow(inp, kind) {
    if (kind === "none") { acClose(); return; }
    const t = inp.value.slice(0, inp.selectionStart ?? inp.value.length).trim();
    acItems = acList(t, kind);
    if (!acItems.length || (acItems.length === 1 && acItems[0].text === t)) { acClose(); return; }
    if (!acBox) { acBox = document.createElement("div"); acBox.className = "ac-pop hidden"; document.body.appendChild(acBox); }
    acInp = inp; acSel = 0;
    acBox.innerHTML = acItems.slice(0, 40).map((it, i) => `<div class="ac-it${i ? "" : " on"}" data-i="${i}"><b translate="no">${escapeHtml(it.label)}</b><span>${escapeHtml(it.det || "")}</span></div>`).join("");
    acBox.querySelectorAll(".ac-it").forEach(el => el.addEventListener("mousedown", e => { e.preventDefault(); acPick(+el.dataset.i); }));
    const r = inp.getBoundingClientRect();
    Object.assign(acBox.style, { left: r.left + "px", top: (r.bottom + 2) + "px", minWidth: r.width + "px" });
    acBox.classList.remove("hidden");
  }
  function acPick(i) {
    const it = acItems[i], inp = acInp;
    if (!it || !inp) return;
    inp.value = it.text;
    inp.setSelectionRange(it.text.length, it.text.length);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    if (it.more) acShow(inp, inp.dataset.ac); else acClose();
  }
  function attachSuggest(inp, kind) {
    if (!inp || inp.dataset.ac) { if (inp) inp.dataset.ac = kind; return; }
    inp.dataset.ac = kind;
    inp.removeAttribute("list");
    // la tendina si apre dal primo carattere scritto, non sul campo vuoto
    inp.addEventListener("input", () => { if (inp.value.trim()) acShow(inp, inp.dataset.ac); else acClose(); });
    inp.addEventListener("blur", () => setTimeout(() => { if (acInp === inp) acClose(); }, 100));
    inp.addEventListener("keydown", e => {
      if (acInp !== inp || !acBox || acBox.classList.contains("hidden")) return;
      const n = Math.min(acItems.length, 40);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { acSel = (acSel + (e.key === "ArrowDown" ? 1 : n - 1)) % n; }
      else if (e.key === "Enter" || e.key === "Tab") { acPick(acSel); }
      else if (e.key === "Escape") { acClose(); }
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (acBox) acBox.querySelectorAll(".ac-it").forEach((el, i) => { el.classList.toggle("on", i === acSel); if (i === acSel) el.scrollIntoView({ block: "nearest" }); });
    }, true);
  }
  // ── v4.8: Moduli → Esposizione dati: TX (letti da fuori, GET /api/data/exposure) e RX (scritti da fuori, POST /api/data/exposure) ──
  // Stessa pagina per i Dati HMI (modulo 2, pannello operatore): tabella unica, scrittura sì/no per riga
  let modPage = false, modTab = "tx", modKind = "data";
  const dataMod = (create) => {
    let m = (project.modules || []).find(x => x.type === "data");
    if (!m && create) { m = { number: 1, type: "data", tx: [], rx: [] }; (project.modules = project.modules || []).push(m); }
    return m || null;
  };
  const hmiMod = (create) => {
    let m = (project.modules || []).find(x => x.type === "hmi");
    if (!m && create) { m = { number: 2, type: "hmi", rows: [] }; (project.modules = project.modules || []).push(m); }
    return m || null;
  };
  const ioMod = (create) => {
    let m = (project.modules || []).find(x => x.type === "io");
    if (!m && create) { m = { number: 3, type: "io", bi: [], bo: [], ri: [], ro: [] }; (project.modules = project.modules || []).push(m); }
    return m || null;
  };
  const mbMod = (create) => {
    let m = (project.modules || []).find(x => x.type === "modbus");
    if (!m && create) { m = { number: 5, type: "modbus", nets: [], reqs: [], maps: [] }; (project.modules = project.modules || []).push(m); }
    return m || null;
  };
  const curMod = create => modKind === "hmi" ? hmiMod(create) : modKind === "io" ? ioMod(create) : modKind === "modbus" ? mbMod(create) : dataMod(create);
  // testo → operando per una riga: bit I / Q / M (anche col nome del simbolo) o campo di un DB
  function parseDataOp(t, dir) {
    t = String(t || "").trim();
    if (!t) return { err: "vuoto" };
    const r = parseMemRef(t);
    if (r) {
      if (r.err) return r;
      if (r.o.ns === "L") return { err: "le variabili # esistono solo dentro la FC" };
      return { o: r.o, type: r.type };
    }
    const k = EspSymbols.parseKey(t) || EspSymbols.lookup(t);
    if (k && (k.ns === "I" || k.ns === "Q" || k.ns === "M") && k.bit == null) {
      if (dir === "rx" && k.ns !== "M") return { err: "da fuori si scrivono solo M e campi dei DB" };
      return { o: { ns: k.ns, idx: k.idx }, type: "BOOL" };
    }
    return { err: "scrivi I, Q, M (es. M5) o un campo di un DB (es. Dati.Vel, Dati.Cnt.3)" };
  }
  const dataOpText = o => !o ? "" : isMemOp(o) ? memText(o) : varKey(o);
  const dataOpType = o => !o ? "" : isMemOp(o) ? (memType(o) || "?") : "BOOL";
  // picoPlc (modulo 4): il programma del progetto gira sul modulo I/O quando manca il PLC; qui quando parte, le uscite
  // al passaggio e quando torna al PLC. Vanno al modulo col Download
  function openPplc() {
    closeMenus();
    const m = (project.modules || []).find(x => x.type === "pplc");
    const $ = id => document.getElementById(id);
    $("pp-on").value = m ? "1" : "0";
    $("pp-lost").value = m ? m.lost : 1000;
    $("pp-keep").value = m && m.keep === false ? "0" : "1";
    $("pp-back").value = m ? m.back : 1000;
    const done = () => { $("pplc-modal").classList.add("hidden"); $("pp-ok").onclick = $("pp-cancel").onclick = null; };
    $("pp-cancel").onclick = done;
    $("pp-ok").onclick = () => {
      project.modules = (project.modules || []).filter(x => x.type !== "pplc");
      if ($("pp-on").value === "1") {
        const n = (id, lo, hi, d) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
        project.modules.push({ number: 4, type: "pplc", lost: n("pp-lost", 100, 60000, 1000), keep: $("pp-keep").value === "1", back: n("pp-back", 0, 60000, 1000) });
      }
      markEditDirty(); done();
      setStatusLine("picoPlc: parametri cambiati — Compile e Download per mandarli al modulo");
    };
    // l'invio al modulo è il Download della sua scheda (PLC | io1 | io2…): qui solo i parametri
    $("pp-msg").textContent = ""; $("pp-send-row").classList.add("hidden");
    $("pplc-modal").classList.remove("hidden");
  }
  // Programma di questo progetto al modulo I/O: compilato qui, mandato a pezzi da 2 KB al PLC (POST /api/bus/pplc), che lo
  // passa al modulo sul bus; poi si aspetta l'installazione nel modulo
  async function sendPplc(mod) {
    const msg = document.getElementById("pp-msg");
    const say = (t, bad) => { msg.textContent = t; msg.style.color = bad ? "var(--bad)" : ""; setStatusLine(t, bad ? "err" : null); };
    if (!(project.modules || []).some(x => x.type === "pplc")) { say("prima «Programma pPlc: Sì» e OK", true); return; }
    const r = await compileIR(project, {});
    if (r.errors && r.errors.length) { say("errori: " + r.errors.join(" · "), true); return; }
    const blob = buildWireBlob(r.bytecode, r.source_gzip), crc = (crc32(blob) >>> 0).toString(16);
    const url = off => `/api/bus/pplc?m=${encodeURIComponent(mod)}&total=${blob.length}&crc=${crc}&off=${off}`;
    try {
      for (let off = 0, tries = 0; off < blob.length; ) {
        const part = blob.subarray(off, off + 2048);
        say(`invio a ${mod}: ${off} / ${blob.length} B`);
        const res = await postJson(url(off), { body: u8ToBase64(part), headers: { "Content-Type": "text/plain" } }, 20000);
        if (!res.ok) { say(`invio non riuscito: ${res.j.msg || res.status}`, true); return; }
        if (res.j.st === 5) { say(`${mod}: picoPlc spento nel modulo (editor collegato al modulo → Diagnostica → Ruolo della scheda → picoPlc: Acceso, poi riavvio)`, true); return; }
        if (res.j.st === 2) { say(`${mod}: il modulo non accetta il programma (memoria del modulo o CRC)`, true); return; }
        if (res.j.next === off + part.length) { off += part.length; tries = 0; }
        else if (++tries > 3) { say("invio non riuscito: il modulo perde i pezzi", true); return; }
        else off = res.j.next;                                // pezzo perso: si riparte da dove il modulo è arrivato
      }
      for (let k = 0; k < 40; k++) {                         // installazione nel modulo (in flash)
        say(`${mod}: installazione…`);
        const res = await postJson(url(blob.length), { body: "" });
        if (res.j && res.j.st === 3) {
          say(`${mod}: programma pPlc installato (${blob.length} B)`);
          devKnown[mod] = crc32(r.bytecode) >>> 0;
          if (devTab === mod) { editorDirty = false; renderDevTabs(); updateSync(); }
          return true;
        }
        if (!res.ok || (res.j && res.j.st === 4)) { say(`${mod}: installazione non riuscita${res.j && res.j.fault === 255 ? " (pPlc in RUN)" : res.j && res.j.fault ? " (errore " + res.j.fault + ")" : ""}`, true); return; }
        await new Promise(z => setTimeout(z, 500));
      }
      say(`${mod}: nessuna risposta dall'installazione`, true);
    } catch (e) { say("invio non riuscito: " + e.message, true); }
  }
  // ── Schede dei dispositivi: PLC | io1 | io2 … ──
  // Collegati a un PLC con moduli I/O sul bus: la scheda di un modulo apre il suo programma pPlc dalla copia nel PLC
  // (GET /api/bus/pplc) e il Download lo manda al modulo passando dal PLC. Ogni scheda tiene il suo stato (devStates)
  // picoPlc spento per ora (Denys 23-10-2026): niente schede dei moduli né finestra picoPlc
  const PPLC_ON = false;
  let devTab = "", devMods = [], devTabsAsked = false;
  const devKnown = {};                                 // CRC del bytecode che il modulo ha (Download riuscito o programma letto)
  async function refreshDevTabs() {
    const box = document.getElementById("dev-tabs");
    if (!box) return;
    if (!PPLC_ON || !liveStatus || liveStatus.role === "io") { devMods = []; renderDevTabs(); return; }
    try { const j = await fetchJson("/api/bus"); devMods = (j.modules || []).filter(x => x.pplc === "on" || x.pplc === "run").map(x => x.name).filter(Boolean); } catch (e) { devMods = []; }
    renderDevTabs();
  }
  // «◉ picoPlc» solo dove c'è un pPlc (scheda di un modulo, o editor collegato a un modulo col picoPlc); lì niente Esposizione dati e Dati HMI
  function showPplcBtn() {
    const pp = PPLC_ON && (!!devTab || !!(liveStatus && liveStatus.role === "io" && liveStatus.pplc));
    const b = document.getElementById("mod-pplc");
    if (b) b.classList.toggle("hidden", !pp);
    // nel pPlc niente esposizione dati né pannello HMI: è il programma di ripiego del modulo
    // e solo i moduli del progetto della scheda (mods del PLC: 1 esposizione dati, 2 pannello HMI; senza = firmware di prima, tutti)
    const mods = liveStatus && typeof liveStatus.mods === "number" ? liveStatus.mods : 3;
    for (const [id, bit] of [["mod-data", 1], ["mod-hmi", 2]]) { const x = document.getElementById(id); if (x) x.classList.toggle("hidden", pp || !(mods & bit)); }
  }
  showPplcBtn();                                       // all'avvio: nascosto finché non si sa con cosa si parla
  function renderDevTabs() {
    const box = document.getElementById("dev-tabs");
    if (!box) return;
    box.classList.toggle("hidden", !devMods.length && !devTab);
    box.textContent = "";
    for (const n of ["", ...devMods]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "dev-tab" + (n === devTab ? " on" : "");
      const dirty = n === devTab ? editorDirty : !!(devStates[n] && devStates[n].dirty);
      b.textContent = (n || "PLC") + (dirty ? " •" : "");
      b.title = n ? `programma pPlc del modulo ${n} (copia nel PLC, Download passando dal PLC)` : "programma del PLC";
      b.onclick = () => switchDev(n);
      box.appendChild(b);
    }
    document.body.classList.toggle("dev-mod", !!devTab);
    showPplcBtn();
  }
  // Ogni scheda è un oggetto con la sua memoria nel browser: progetto, blocco aperto, modifiche, cronologia (Annulla).
  // Cambiando scheda si mette da parte quella lasciata e si riprende quella scelta com'era; la prima volta il modulo
  // si legge (copia nel PLC o modulo)
  const devStates = {};
  async function switchDev(name) {
    if (name === devTab) return;
    if (liveMonitoring) setOnline(false);
    devStates[devTab] = { json: EspIR.toJSON(project), block: program.id, dirty: editorDirty, plcJson, hist, histIdx };
    const s = devStates[name];
    if (!s && name) { await loadDev(name); return; }
    devTab = name;
    if (s) {
      setProject(JSON.parse(s.json)); program = project.blocks.find(b => b.id === s.block) || program; afterLoad();
      editorDirty = s.dirty; plcJson = s.plcJson; hist = s.hist; histIdx = s.histIdx; updateUndoBtns();
    }
    renderDevTabs(); renderBlocks(); render(); updateSync();
    setStatusLine(name ? `scheda ${name}${editorDirty ? " (modifiche non mandate al modulo)" : ""}` : "scheda PLC");
  }
  // fromModule: Upload, il programma che il modulo ha adesso (passando dal PLC); senza: la copia nel PLC, se c'è, se no il modulo
  async function loadDev(name, fromModule) {
    setStatusLine(`${name}: lettura del programma pPlc dal PLC…`);
    let pj = null, from = "copia";
    const fromMod = async () => {
      setStatusLine(`${name}: lettura del programma dal modulo…`);
      const r = await fetch(`/api/bus/pplc/src?m=${encodeURIComponent(name)}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).msg || "HTTP " + r.status);
      const j = await srcToProject(b64decode((await r.text()).trim()));
      if (!j) throw new Error("sorgente del modulo incompleto");
      from = "modulo";
      return j;
    };
    try {
      const r = fromModule ? { ok: false, status: 404 } : await fetch(`/api/bus/pplc?m=${encodeURIComponent(name)}`);
      if (r.ok) {
        const txt = (await r.text()).trim();
        let blob = null;
        try { blob = b64decode(txt); } catch (e) {}
        const dv = blob && blob.length >= 20 ? new DataView(blob.buffer, blob.byteOffset, blob.length) : null;
        const bcl = dv && dv.getUint32(0, true) === 0x31434C50 ? dv.getUint32(8, true) : -1;
        if (bcl < 0 || 20 + bcl > blob.length)                // copia nel PLC illeggibile: si parte da un progetto nuovo
          setTimeout(() => setStatusLine(`${name}: copia nel PLC non valida (${txt.length} caratteri: «${txt.slice(0, 24)}»): progetto nuovo`, "warn"), 50);
        else pj = await srcToProject(blob.subarray(20 + bcl));
      } else if (r.status !== 404) throw new Error("HTTP " + r.status);
      if (!pj) pj = await fromMod();                           // nessuna copia nel PLC (programma caricato direttamente sul modulo)
    } catch (e) { setStatusLine(`${name}: lettura non riuscita (${e.message})`, "err"); return; }
    devTab = name;
    delete devKnown[name];                             // il programma letto è quello del modulo (o la sua copia): si ricalcola
    if (pj) setProject(pj);
    else { setProject(EspIR.emptyProgram(`${name} pPlc`)); project.modules = [{ number: 4, type: "pplc", lost: 1000, keep: true, back: 1000 }]; }
    afterLoad();
    renderDevTabs(); renderBlocks(); render();
    setStatusLine(!pj ? `${name}: nessun programma pPlc nel PLC né nel modulo, progetto nuovo — Download lo manda al modulo`
      : from === "modulo" ? `${name}: programma letto dal modulo — Download lo manda al modulo e ne tiene la copia nel PLC`
      : `${name}: programma pPlc dalla copia nel PLC — Download lo manda al modulo`);
  }
  function openModPage(kind) {
    closeMenus();
    modKind = kind === "hmi" ? "hmi" : kind === "io" ? "io" : kind === "modbus" ? "modbus" : "data";
    const hmi = modKind === "hmi", io = modKind === "io", mb = modKind === "modbus";
    document.getElementById("mod-title").textContent = hmi ? "Dati HMI" : io ? "Tabelle I/O" : mb ? "Modbus" : "Esposizione dati";
    document.querySelectorAll("#mod-page .mod-tab:not(.io-tab), #mod-dl-tx, #mod-dl-rx").forEach(b => b.classList.toggle("hidden", hmi || io || mb));
    document.querySelectorAll("#io-devs").forEach(b => b.classList.toggle("hidden", !io && !mb));
    document.querySelectorAll("#mod-cat").forEach(b => b.classList.toggle("hidden", !io));
    if (mb && !MB_TABS.includes(mbTab)) mbTab = "devs";
    document.getElementById("mod-add").textContent = "+ Valore";        // Modbus: «+ Dispositivo» / «+ Registri» (renderMbPage)
    document.getElementById("mb-map").innerHTML = "";
    document.getElementById("mod-add").classList.toggle("hidden", io);   // tabelle I/O: le righe sono i punti dei dispositivi
    document.getElementById("mod-onoff").classList.toggle("hidden", io);
    if (EspIR.IO_LISTS.includes(modTab)) modTab = "tx";
    document.getElementById("mod-dl-hmi").classList.toggle("hidden", !hmi);
    document.getElementById("mod-per-l").classList.toggle("hidden", !hmi);
    if (symPageOpen) closeSymPage();
    if (dbPage != null) { dbPage = null; document.getElementById("canvas-wrap").classList.remove("db-mode"); }
    modPage = true;
    document.getElementById("canvas-wrap").classList.add("mod-mode");
    renderModPage(); renderBlocks(); modReadPlcVer();
  }
  function closeModPage() {
    if (!modPage) return;
    modPage = false;
    document.getElementById("canvas-wrap").classList.remove("mod-mode");
    netBlocks = []; render(); renderBlocks();
  }
  const fmtStamp = s => { const d = new Date(s); return isNaN(d) ? "—" : d.toLocaleString("it-IT"); };
  let modPlcVer = null;                                  // versione sul PLC (GET /api/data/exposure), null = non letta
  async function modReadPlcVer() {
    modPlcVer = null;
    if (modKind === "modbus") return;                     // Modbus: la versione è quella del programma (Compile e Download)
    if (modKind === "io") {
      try { const j = await fetchJson("/api/io/values", FETCH_TO); modPlcVer = j.stamp || 0; } catch (e) {}
      if (!(ioMod(false) || {}).catalog) ioLoadCatalog(true);
    } else if (modKind === "hmi") {                      // versione nella testata di config.bin (byte 8..11)
      try {
        const r = await fetch("/api/hmi/config.bin");
        if (r.status === 404) modPlcVer = 0;
        else if (r.ok) { const b = new DataView(await r.arrayBuffer()); modPlcVer = b.byteLength >= 12 ? b.getUint32(8, true) : 0; }
      } catch (e) {}
    } else try { const j = await fetchJson("/api/data/exposure", FETCH_TO); modPlcVer = j.version || 0; } catch (e) {}
    if (modPage) renderModState();
  }
  function renderModState() {
    const m = curMod(false), ed = !!(m && m.editing);
    const ob = document.getElementById("mod-onoff");
    ob.textContent = m && m.off ? "○ Disattivato" : "● Attivo";
    ob.classList.toggle("off", !!(m && m.off));
    document.getElementById("mod-edit").classList.toggle("hidden", ed);
    document.getElementById("mod-ok").classList.toggle("hidden", !ed);
    document.getElementById("mod-cancel").classList.toggle("hidden", !ed);
    document.getElementById("mod-add").disabled = !ed;
    const plc = modPlcVer == null ? "?" : modPlcVer ? fmtStamp(modPlcVer * 1000) : "nessuna";
    const mine = m && m.stamp ? fmtStamp(m.stamp) : "mai confermata";
    const same = m && m.stamp && modPlcVer === Math.floor(Date.parse(m.stamp) / 1000);
    document.getElementById("mod-ver").textContent = ed ? "in modifica: «✓ Conferma» genera la versione nuova"
      : `versione ${mine} · sul PLC ${plc}${modPlcVer != null && m && m.stamp && !same ? " (diversa: Compile e Download)" : ""}`;
  }
  // selettore attivo / disattivato: la tabella resta nel programma, il PLC non la rende accessibile (Download)
  function modOnOff() {
    const m = curMod(true);
    if (m.off) delete m.off; else m.off = true;
    markEditDirty(); renderModPage();
    const what = modKind === "hmi" ? (m.off ? "Dati HMI disattivati" : "Dati HMI attivi") : (m.off ? "esposizione dati disattivata" : "esposizione dati attiva");
    setStatusLine(`${what} — Download per mandarlo al PLC`);
  }
  function modEdit() {
    const m = curMod(true);
    m.prev = JSON.parse(JSON.stringify(modKind === "hmi" ? { rows: m.rows } : modKind === "io" ? { bi: m.bi, bo: m.bo, ri: m.ri, ro: m.ro }
      : modKind === "modbus" ? { nets: m.nets, reqs: m.reqs, maps: m.maps, devs: m.devs } : { tx: m.tx, rx: m.rx }));
    m.editing = true;
    markEditDirty(); renderModPage();
  }
  function modCancel() {
    const m = curMod(false); if (!m) return;
    if (m.prev) Object.assign(m, m.prev);
    delete m.prev; delete m.editing;
    markEditDirty(); renderModPage();
    setStatusLine(modKind === "hmi" ? "modifiche dei Dati HMI annullate" : "modifiche dell'esposizione dati annullate");
  }
  // riga dei Dati HMI → testo dell'errore, "" = valida
  function hmiRowErr(r, i) {
    const t = `${i} «${U(r.name)}»`;
    if (!r.name.trim()) return `${t}: nome vuoto`;
    const p = parseDataOp(dataOpText(r.op), "tx");
    if (p.err) return `${t}: ${p.err}`;
    if (r.w && p.o.ns !== "M" && p.o.ns !== "DB") return `${t}: si scrivono solo M e campi dei DB`;
    if (r.min !== undefined && r.max !== undefined && r.min > r.max) return `${t}: minimo più grande del massimo`;
    return "";
  }
  function modConfirm() {
    const m = curMod(false); if (!m) return;
    if (modKind === "modbus") {
      const e = mbCheck(m);
      if (e) { setStatusLine(e, "err"); return; }
      delete m.prev; delete m.editing;
      m.stamp = new Date().toISOString();
      if (mbCaps) m.caps = { ...mbCaps };               // porta e id dello slave del progetto MiaConfig, anche per un Compile senza PLC
      EspIR.modbusSync(project);
      markEditDirty(); renderModPage(); renderBlocks();
      setStatusLine(`Modbus confermato: DB Modbus aggiornata (${(m.devs || []).length} dispositivi, ${(m.reqs || []).length} registri, ${(m.maps || []).length} gruppi dello slave) — Compile e Download per mandarlo al PLC`);
      return;
    }
    if (modKind === "io") {
      ioFillDefaults(m);
      const e = ioCheck(m);
      if (e) { setStatusLine(e, "err"); return; }
      delete m.prev; delete m.editing;
      m.stamp = new Date().toISOString();
      if (m.cathw) m.hw = m.cathw;                       // fatte per la scheda dei punti letti
      hwdbSync(m);
      markEditDirty(); renderModPage(); renderBlocks();
      setStatusLine(`Tabelle I/O confermate: DB dei dispositivi aggiornate, versione ${fmtStamp(m.stamp)} — Compile e Download per mandarle al PLC`);
      return;
    }
    if (modKind === "hmi") {
      for (let i = 0; i < m.rows.length; i++) { const e = hmiRowErr(m.rows[i], i); if (e) { setStatusLine(e, "err"); return; } }
      delete m.prev; delete m.editing;
      m.stamp = new Date().toISOString();
      markEditDirty(); renderModPage();
      setStatusLine(`Dati HMI confermati: versione ${fmtStamp(m.stamp)} — Compile e Download per mandarli al PLC`);
      return;
    }
    for (const dir of ["tx", "rx"]) {
      const seen = new Set();
      for (const r of m[dir]) {
        const t = `${dir.toUpperCase()} «${U(r.name)}»`;
        if (!EspIR.DATA_NAME_RE.test(r.name)) { setStatusLine(`${t}: nome non valido (lettere, cifre, _ . -, max 32)`, "err"); return; }
        if (seen.has(r.name)) { setStatusLine(`${t}: nome ripetuto`, "err"); return; }
        seen.add(r.name);
        const p = parseDataOp(dataOpText(r.op), dir);
        if (p.err) { setStatusLine(`${t}: ${p.err}`, "err"); return; }
      }
    }
    delete m.prev; delete m.editing;
    m.stamp = new Date().toISOString();
    markEditDirty(); renderModPage();
    setStatusLine(`esposizione dati confermata: versione ${fmtStamp(m.stamp)} — Compile e Download per mandarla al PLC`);
  }
  // ── Tabelle I/O (modulo 3): punti della scheda (catalogo dal PLC) ↔ campi della HWDB, generata alla conferma ──
  const IO_TITLE = { bi: "bit, ingresso", bo: "bit, uscita", ri: "real, ingresso", ro: "real, uscita" };
  const IO_RAW = { "0-10V": [0, 10], "0-20mA": [0, 20], "4-20mA": [4, 20] };
  async function ioLoadCatalog(quiet) {
    let j;
    try { j = await fetchJson("/api/io/catalog", FETCH_TO); } catch (e) { if (!quiet) setStatusLine("punti della scheda: PLC non raggiungibile", "warn"); return; }
    const m = ioMod(true);
    m.catalog = (j.points || []).map(p => Object.assign({ id: p.id, t: p.t, dir: p.dir }, p.modes ? { modes: true } : {}, p.error ? { err: p.error } : {}, p.used ? { used: true } : {},
                                                       Number.isInteger(p.i) ? { i: p.i } : {}, Number.isInteger(p.o) ? { o: p.o } : {},   // posto nei blocchi della DB
                                                       p.dev ? { dev: p.dev } : {}, p.name ? { name: p.name } : {}));
    m.board = j.board || "";
    let hw = j.hw_id;                                    // firmware di prima: l'impronta da /api/fw/info
    if (hw === undefined) try { hw = (await fetchJson("/api/fw/info", FETCH_TO)).hw_id; } catch (e) {}
    if (typeof hw === "string" && hw) m.cathw = hw; else delete m.cathw;
    markEditDirty();
    if (!quiet || modPage) setStatusLine(j.error ? `punti della scheda: ${j.error}` : `punti della scheda «${U(m.board)}»: ${m.catalog.length}`, j.error ? "warn" : undefined);
    if (modPage && modKind === "io") renderModPage();
  }
  // punti adatti a una lista: tipo (bit/real) e verso (ingresso/uscita; io va bene per tutti e due)
  // nome di un punto senza nome: il suo id con «_» al posto dei punti (gpi.34 → gpi_34: «HWDB.gpi.34» sarebbe il bit 34 di gpi)
  const ioDefName = id => String(id).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24);
  // nome dal commento del configuratore (MiaConfig): «Relè 1» → Rele_1; non valido → quello dell'id
  const ioNameOf = p => {
    const n = String(p.name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "").slice(0, 24);
    return EspIR.NAME_RE.test(n) ? n : ioDefName(p.id);
  };
  // ogni punto d'ingresso o d'uscita del catalogo ha la sua riga (campo della DB): senza nome prende quello dell'id.
  // I GPIO (ingresso o uscita) restano da scegliere: un nome nella sezione giusta
  function ioFillDefaults(m) {
    for (const p of m.catalog || []) {
      if (p.used || p.dir === "io") continue;
      const k = EspIR.IO_LISTS.find(k => ioFits(p, k));
      if (!k) continue;
      const list = m[k] = m[k] || [];
      if (list.some(r => r.res === p.id && (r.dev || "") === (p.dev || ""))) continue;
      let name = ioNameOf(p);                            // nome già usato nello stesso dispositivo: quello dell'id
      if (EspIR.IO_LISTS.some(k => (m[k] || []).some(r => (r.dev || "") === (p.dev || "") && r.name.toLowerCase() === name.toLowerCase())))
        name = ioDefName(p.id);
      list.push(Object.assign({ name, res: p.id }, p.dev ? { dev: p.dev } : {}));
    }
  }
  const ioFits = (p, k) => p.t === (k[0] === "r" ? "real" : "bit") && (p.dir === "io" || p.dir === (k[1] === "i" ? "in" : "out")) && !p.used;
  function ioCheck(m) {
    const cat = m.catalog || [];
    const names = new Map(), pts = new Set();
    for (const k of EspIR.IO_LISTS) for (const r of m[k] || []) {
      const dev = r.dev || "", t = `Tabelle I/O, ${dev || "scheda del PLC"} · ${IO_TITLE[k]} «${U(r.name)}»`;
      if (!EspIR.NAME_RE.test(r.name)) return `${t}: nome come un campo di un DB (lettere, cifre e _, max 24)`;
      const key = dev + "\u0000" + r.name.toLowerCase();
      if (names.has(key)) return `${t}: nome ripetuto nello stesso dispositivo`;
      names.set(key, 1);
      if (!r.res) return `${t}: scegli il punto`;
      if (pts.has(r.res)) return `${t}: punto ${r.res} usato due volte`;
      pts.add(r.res);
      const p = cat.find(x => x.id === r.res);
      if (cat.length && !p) return `${t}: il punto ${r.res} non c'è più (configurazione del dispositivo cambiata?)`;
      if (p && !ioFits(p, k)) return `${t}: il punto ${r.res} non è ${IO_TITLE[k]}`;
      if (r.raw && r.eng && r.raw[0] === r.raw[1]) return `${t}: grezzo minimo e massimo uguali`;
    }
    for (const dev of new Set(EspIR.IO_LISTS.flatMap(k => (m[k] || []).map(r => r.dev || ""))))
      if (dev && !EspIR.NAME_RE.test(dev)) return `Tabelle I/O: il nome del dispositivo «${U(dev)}» non va bene come nome di una DB`;
    return "";
  }
  // Una DB per dispositivo, generata alla conferma: scheda del PLC → HWDB (DB1000), modulo → DB col suo nome (DB1001…).
  // Nel programma: HWDB.Start, vasca.Livello. Un campo per riga, BOOL o REAL, commento con il punto
  function hwdbSync(m) {
    const by = new Map();
    for (const k of EspIR.IO_LISTS) for (const r of m[k] || []) {
      const dev = r.dev || "";
      if (!by.has(dev)) by.set(dev, []);
      by.get(dev).push({ name: r.name, type: k[0] === "r" ? "REAL" : "BOOL", comment: `${r.res}${r.unit ? " · " + r.unit : ""}${r.comment ? " · " + r.comment : ""}`.slice(0, 120) });
    }
    m.devdb = m.devdb || {};
    for (const d of Object.keys(m.devdb)) if (!by.has(d)) delete m.devdb[d];
    const used = new Set(Object.values(m.devdb));
    used.add(EspIR.SYS_DB_NUMBER);
    for (const dev of by.keys()) if (dev && !m.devdb[dev]) { let n = EspIR.HWDB_NUMBER + 1; while (used.has(n)) n++; m.devdb[dev] = n; used.add(n); }
    project.dbs = (project.dbs || []).filter(d => !d.hw || d.sys);   // la SDB «Sistema» resta
    for (const [dev, fields] of by) project.dbs.push({ number: dev ? m.devdb[dev] : EspIR.HWDB_NUMBER, name: dev || "HWDB", retain: false, hw: true, fields });
    project.dbs.sort((a, b) => a.number - b.number);
  }
  // HWDB mancante (progetto nuovo o PLC appena installato): l'editor la crea da solo dai punti del file della scheda
  // e la conferma. All'apertura solo con il PLC fermo (in RUN il programma sul PLC resta quello che è: la HWDB sposta
  // gli indirizzi dei DB dopo di lei e l'Online direbbe «diverso»); al Compile sempre (forDownload, Denys 04-11-2026):
  // un programma arriva sul PLC solo da un Download, e così ha sempre la HWDB della scheda
  async function ioAutoHwdb(forDownload) {
    if ((project.dbs || []).some(d => d.hw && d.number === EspIR.HWDB_NUMBER)) return;
    const m0 = ioMod(false);
    if (m0 && m0.editing) return;
    if (!forDownload) try { if ((await fetchJson("/api/plc/status", FETCH_TO)).state === "running") return; } catch (e) { return; }
    await ioLoadCatalog(true);
    const m = ioMod(false);
    if (!m || !(m.catalog || []).length) return;
    ioFillDefaults(m);
    const e = ioCheck(m);
    if (e) { setStatusLine("HWDB non creata: " + e, "warn"); return; }
    m.stamp = new Date().toISOString();
    if (m.cathw) m.hw = m.cathw;
    hwdbSync(m);
    markEditDirty(); renderBlocks();
    autoJson = projJson();                                // fatta dall'editor: diversa dal PLC, ma non una bozza (dopo markEditDirty e renderBlocks, che sistemano il progetto: cartella Sys_DB)
    if (modPage && modKind === "io") renderModPage();
    const n = EspIR.IO_LISTS.reduce((a, k) => a + (m[k] || []).filter(r => !r.dev).length, 0);
    setStatusLine(`HWDB creata dai punti della scheda: ${n} campi — Compile e Download per mandarla al PLC`);
  }
  // Scheda cambiata (Denys 04-11-2026: firmware di un altro progetto caricato sul PLC): al Compile le tabelle della
  // scheda del PLC si rifanno dai punti nuovi. Restano le righe dei punti che ci sono ancora (nome e opzioni), via quelle
  // dei punti spariti, i punti nuovi con il loro nome; impronta nuova nelle tabelle. I moduli uLink restano come sono
  async function ioRealign() {
    const m0 = ioMod(false);
    if (!m0 || m0.editing || !(project.dbs || []).some(d => d.hw && d.number === EspIR.HWDB_NUMBER)) return;
    await ioLoadCatalog(true);
    const m = ioMod(false), cat = (m && m.catalog) || [];
    if (!m || !cat.length || !m.cathw) return;
    const ids = new Set(cat.filter(p => !p.dev).map(p => p.id));
    let gone = 0;
    for (const k of EspIR.IO_LISTS) {
      const before = (m[k] || []).length;
      m[k] = (m[k] || []).filter(r => r.dev || ids.has(r.res));
      gone += before - m[k].length;
    }
    if (m.hw === m.cathw && !gone) return;
    const was = EspIR.IO_LISTS.reduce((a, k) => a + (m[k] || []).filter(r => !r.dev).length, 0);
    ioFillDefaults(m);
    const now = EspIR.IO_LISTS.reduce((a, k) => a + (m[k] || []).filter(r => !r.dev).length, 0);
    const e = ioCheck(m);
    if (e) { setStatusLine("Tabelle I/O non riallineate: " + e, "warn"); return; }
    const old = m.hw;
    m.hw = m.cathw; m.stamp = new Date().toISOString();
    hwdbSync(m);
    markEditDirty(); renderBlocks();
    if (modPage && modKind === "io") renderModPage();
    setStatusLine(`Tabelle I/O riallineate alla scheda «${U(m.board)}»${old && old !== m.hw ? ` (impronta ${old} → ${m.hw})` : ""}: ` +
                  `tolti ${gone} punti che non ci sono più, aggiunti ${now - was} — Download per mandarle al PLC`, "warn");
  }
  // dispositivi: la scheda del PLC ("") e i moduli, dal catalogo e dalle righe
  let ioDev = "";
  function ioDevs(m) {
    const s = new Set([""]);
    for (const p of (m && m.catalog) || []) if (p.dev) s.add(p.dev);
    for (const k of EspIR.IO_LISTS) for (const r of (m && m[k]) || []) if (r.dev) s.add(r.dev);
    return [...s];
  }
  function renderIoPage() {
    const m = ioMod(false), ed = !!(m && m.editing), cat = (m && m.catalog) || [];
    renderModState();
    const devs = ioDevs(m);
    if (!devs.includes(ioDev)) ioDev = "";
    const bar = document.getElementById("io-devs");
    bar.innerHTML = devs.map(d => `<button class="mod-tab${d === ioDev ? " on" : ""}" data-dev="${escapeHtml(d)}" translate="no">${d ? escapeHtml(d) : "Scheda del PLC"}</button>`).join("");
    bar.querySelectorAll("button").forEach(b => b.onclick = () => { ioDev = b.dataset.dev; renderModPage(); });
    const nRows = d => EspIR.IO_LISTS.reduce((t, k) => t + ((m && m[k]) || []).filter(r => (r.dev || "") === d).length, 0);
    document.getElementById("mod-info").textContent = devs.map(d => `${d || "scheda"} ${nRows(d)}`).join(" · ");
    const changed = m && m.hw && m.cathw && m.hw !== m.cathw;   // tabelle fatte per un'altra scheda
    document.getElementById("mod-hint").textContent = (changed ? `⚠ Scheda cambiata: tabelle per l'impronta ${m.hw}, sul PLC ${m.cathw}. Al Compile si rifanno dai punti nuovi (restano i nomi dei punti che ci sono ancora). ` : "") +
      (m && m.board ? `Scheda «${m.board}». ` : "Punti non letti: «⟳ Punti dal PLC». ") +
      `Ogni punto è un campo della DB del dispositivo (${ioDev ? ioDev : "HWDB"}), generata alla conferma; nel programma ${ioDev ? ioDev : "HWDB"}.<nome>. Senza nome prende quello del punto (gpi.34 → gpi_34); i GPIO si usano dandogli un nome nella sezione d'ingresso o d'uscita.`;
    document.querySelector("#mod-table thead").innerHTML = "";
    const tb = document.querySelector("#mod-table tbody");
    tb.innerHTML = "";
    const numOf = v => { v = String(v).trim().replace(",", "."); return v === "" ? undefined : isFinite(+v) ? +v : NaN; };
    const mine = p => (p.dev || "") === ioDev;
    let any = false;
    for (const k of EspIR.IO_LISTS) {
      const real = k[0] === "r", isOut = k[1] === "o", list = m ? (m[k] = m[k] || []) : [];
      // punti del dispositivo adatti a questa sezione, più le righe con un punto che non c'è più nel catalogo
      const pts = cat.filter(p => mine(p) && ioFits(p, k)).map(p => ({ p, r: list.find(r => r.res === p.id) }));
      for (const r of list) if ((r.dev || "") === ioDev && !pts.some(x => x.p.id === r.res)) pts.push({ p: { id: r.res, gone: true }, r });
      if (!pts.length) continue;
      any = true;
      const head = document.createElement("tr");
      head.className = "io-sec";
      head.innerHTML = `<th colspan="2">${IO_TITLE[k][0].toUpperCase() + IO_TITLE[k].slice(1)}</th><th>Nome</th><th>Commento</th>` + (real
        ? `<th>Segnale</th><th>Grezzo min</th><th>Grezzo max</th><th>Valore min</th><th>Valore max</th><th>Unità</th>${isOut ? "" : "<th>Media</th>"}<th>Se manca</th>`
        : `<th>Invertito</th>${isOut ? "" : "<th>Filtro ms</th><th>Se manca</th>"}`);
      tb.appendChild(head);
      for (const { p, r } of pts) {
        const tr = document.createElement("tr");
        const fail = `<select class="d-fail"><option value="">0</option><option value="hold"${r && r.fail === "hold" ? " selected" : ""}>ultimo valore</option><option value="sf"${r && r.fail === "sf" ? " selected" : ""}>0 ed errore SF</option></select>`;
        tr.innerHTML = `<td class="d-type" translate="no">${escapeHtml(p.id)}</td><td class="muted">${p.gone ? "⚠ non più nel dispositivo" : escapeHtml(p.name || "") + (p.err ? " ⚠ " + escapeHtml(p.err) : "")}</td>` +
          `<td><input class="d-name" maxlength="24" translate="no"></td><td><input class="d-com" maxlength="120"></td>` + (real
          ? `<td>${p.modes ? `<select class="d-mode"><option value="">—</option>${EspIR.IO_MODES.map(x => `<option${r && r.mode === x ? " selected" : ""}>${x}</option>`).join("")}</select>` : "—"}</td>` +
            `<td><input class="d-r0"></td><td><input class="d-r1"></td><td><input class="d-e0"></td><td><input class="d-e1"></td><td><input class="d-unit" maxlength="12"></td>` +
            (isOut ? "" : `<td><input class="d-avg" type="number" min="1" max="100"></td>`) + `<td>${fail}</td>`
          : `<td><input type="checkbox" class="d-inv"></td>` + (isOut ? "" : `<td><input class="d-filt" type="number" min="0" max="60000"></td><td>${fail}</td>`));
        const q = c => tr.querySelector(c);
        q(".d-name").value = r ? r.name : ""; q(".d-com").value = r && r.comment || "";
        if (!r && p.dir !== "io" && !p.gone) q(".d-name").placeholder = ioDefName(p.id);   // senza nome: alla conferma prende questo
        if (q(".d-inv")) q(".d-inv").checked = !!(r && r.inv);
        if (q(".d-filt")) q(".d-filt").value = r && r.filt || "";
        if (real) {
          const raw = (r && r.raw) || [], eng = (r && r.eng) || [];
          q(".d-r0").value = raw[0] ?? ""; q(".d-r1").value = raw[1] ?? ""; q(".d-e0").value = eng[0] ?? ""; q(".d-e1").value = eng[1] ?? "";
          q(".d-unit").value = r && r.unit || ""; if (q(".d-avg")) q(".d-avg").value = r && r.avg || "";
        }
        tr.querySelectorAll("input, select").forEach(x => { x.disabled = !ed || (!r && !x.classList.contains("d-name")); });
        // il nome crea la riga, il nome vuoto la toglie; gli altri campi valgono solo con il nome
        q(".d-name").addEventListener("change", e => {
          const v = e.target.value.trim(), i = list.indexOf(r);
          if (!v && p.dir !== "io") { if (r) r.name = ioDefName(p.id); else list.push(Object.assign({ name: ioDefName(p.id), res: p.id }, ioDev ? { dev: ioDev } : {})); }   // nome vuoto: quello dell'id
          else if (!v) { if (i >= 0) list.splice(i, 1); }
          else if (r) r.name = v;
          else list.push(Object.assign({ name: v, res: p.id }, ioDev ? { dev: ioDev } : {}));
          markEditDirty(); renderModPage();
        });
        if (r) {
          const ch = (sel, f) => { const el = q(sel); if (el) el.addEventListener("change", () => { f(el); markEditDirty(); }); };
          ch(".d-com", el => { const c = el.value.trim(); if (c) r.comment = c; else delete r.comment; });
          ch(".d-inv", el => { if (el.checked) r.inv = true; else delete r.inv; });
          ch(".d-filt", el => { const v = parseInt(el.value, 10); if (v > 0) r.filt = Math.min(60000, v); else delete r.filt; });
          ch(".d-fail", el => { if (el.value) r.fail = el.value; else delete r.fail; });
          ch(".d-unit", el => { const u = el.value.trim(); if (u) r.unit = u; else delete r.unit; });
          ch(".d-avg", el => { const v = parseInt(el.value, 10); if (v > 1) r.avg = Math.min(100, v); else delete r.avg; });
          ch(".d-mode", el => { if (el.value) { r.mode = el.value; if (!r.raw || !r.raw.some(x => x)) r.raw = IO_RAW[r.mode].slice(); } else delete r.mode; renderModPage(); });
          const pair = (a, b, key) => [a, b].forEach((sel, j) => ch(sel, el => {
            const v = numOf(el.value);
            if (Number.isNaN(v)) { el.classList.add("bad"); setStatusLine("scrivi un numero (o lascia vuoto)", "warn"); return; }
            el.classList.remove("bad");
            const cur = r[key] || [0, 0]; cur[j] = v === undefined ? 0 : v;
            if (!cur[0] && !cur[1]) delete r[key]; else r[key] = cur;
          }));
          if (real) { pair(".d-r0", ".d-r1", "raw"); pair(".d-e0", ".d-e1", "eng"); }
        }
        tb.appendChild(tr);
      }
    }
    if (!any) tb.innerHTML = `<tr><td colspan="12" class="muted">${cat.length ? "Nessun punto in questo dispositivo." : "Punti non letti: «⟳ Punti dal PLC» (il PLC li prende dal file della scheda e dai moduli abbinati)."}</td></tr>`;
  }
  // ── Modbus (modulo 5, Denys 01-11-2026; dispositivi 02-11-2026): il ruolo (master, slave) lo decide il progetto MiaConfig
  //    (memoria del PLC: modbus.master / .slave / .port / .id). Master: dispositivi (IP, porta, id, tempo massimo) con i loro
  //    registri, scritti con l'indirizzo vero (40001, 400001, 30001, 10001, 1); slave: gruppi di registri e la mappa degli
  //    indirizzi con i valori online. Alla conferma diventano reti e richieste del firmware (EspIR.modbusExpand) → DB «Modbus»
  const MB_TABS = ["devs", "maps"], MB_TAB_T = { devs: "Dispositivi (master)", maps: "Registri dello slave" };
  const MB_FC_T = { 1: "FC1 leggi coil", 2: "FC2 leggi ingressi", 3: "FC3 leggi holding", 4: "FC4 leggi input", 5: "FC5 scrivi 1 coil",
                    6: "FC6 scrivi 1 registro", 15: "FC15 scrivi coil", 16: "FC16 scrivi registri" };
  const MB_TABLE_T = ["coil", "ingressi discreti", "holding", "input"];
  let mbTab = "devs", mbCaps = null;                     // mbCaps: dal PLC; null = firmware di prima (master e slave)
  const mbOpen = new WeakSet();                          // dispositivi aperti (solo a video)
  const mbHas = t => { const c = mbCaps || (mbMod(false) || {}).caps; return !c || (t === "devs" ? c.master : c.slave); };
  const mbTabs = () => MB_TABS.filter(mbHas);
  const mbBitsT = t => t === 0 || t === 1;
  function mbCheck(m) {
    const fields = new Set(), devs = m.devs || [], combos = new Set();
    const ip4 = t => /^\d{1,3}(\.\d{1,3}){3}$/.test(t || "") && t.split(".").every(x => +x <= 255);
    for (const d of devs) {
      const t = `Modbus, dispositivo «${U(d.name || "")}»`;
      if (!EspIR.NAME_RE.test(d.name || "")) return `${t}: nome come un campo di un DB (lettere, cifre e _)`;
      if (devs.filter(x => x.name.toLowerCase() === d.name.toLowerCase()).length > 1) return `${t}: nome ripetuto`;
      if (!ip4(d.ip)) return `${t}: indirizzo IP`;
      if (!(d.port >= 1 && d.port <= 65535)) return `${t}: porta da 1 a 65535`;
      if (!(d.id >= 0 && d.id <= 247)) return `${t}: id da 0 a 247`;
      if (!(d.timeout >= 50 && d.timeout <= 10000)) return `${t}: tempo massimo da 50 a 10000 ms`;
      combos.add(`${d.port}|${d.timeout}`);
      if (!(d.regs || []).length) return `${t}: nessun registro (+ Registro)`;
      for (const g of d.regs) {
        const tg = `Modbus, ${U(d.name)} · registro «${U(g.name || "")}»`, full = `${d.name}_${g.name}`;
        if (!EspIR.NAME_RE.test(g.name || "")) return `${tg}: nome come un campo di un DB (lettere, cifre e _)`;
        if (full.length > 18) return `${tg}: dispositivo e registro insieme al più 18 caratteri (${full})`;
        if (fields.has(full.toLowerCase())) return `${tg}: nome ripetuto`;
        fields.add(full.toLowerCase());
        const p = EspIR.mbParseReg(g.reg);
        if (p.err) return `${tg}: ${p.err}`;
        if (g.w && !EspIR.mbFcOf(p.table, true, g.qty)) return `${tg}: ${MB_TABLE_T[p.table]} si leggono soltanto`;
        const max = mbBitsT(p.table) ? 1968 : g.w ? 123 : 125;
        if (!(g.qty >= 1 && g.qty <= max)) return `${tg}: quantità da 1 a ${max}`;
        if (p.addr + g.qty > 65536) return `${tg}: oltre l'ultimo indirizzo`;
        if (!(g.period === 0 || (g.period >= 10 && g.period <= 60000))) return `${tg}: ogni quanto, da 10 a 60000 ms (0 = solo su richiesta del programma)`;
      }
    }
    if (combos.size + ((m.maps || []).length ? 1 : 0) > 4) return "Modbus: al più 4 combinazioni diverse di porta e tempo massimo (lo slave conta per una)";
    if (devs.reduce((a, d) => a + (d.regs || []).length, 0) > 64) return "Modbus: al più 64 registri dei dispositivi";
    for (const x of m.maps || []) {
      const t = `Modbus, registri dello slave «${U(x.name || "")}»`;
      if (!EspIR.NAME_RE.test(x.name || "") || x.name.length > 18) return `${t}: nome come un campo di un DB (lettere, cifre e _, max 18)`;
      if (fields.has(x.name.toLowerCase())) return `${t}: nome ripetuto`;
      fields.add(x.name.toLowerCase());
      if (!(x.qty >= 1 && x.qty <= 1000)) return `${t}: quantità da 1 a 1000`;
      if ((x.start || 0) + x.qty > 65536) return `${t}: oltre l'ultimo indirizzo`;
    }
    const tmp = JSON.parse(JSON.stringify(m)); EspIR.modbusExpand(tmp);
    const nf = EspIR.modbusFields(tmp).length;
    if (nf > 1000) return `Modbus: troppi campi nella DB Modbus (${nf})`;
    return "";
  }
  const mbFree = (list, pre) => { let k = list.length + 1; while (list.some(x => x.name === pre + k)) k++; return pre + k; };
  const mbNextIp = (ip, devs) => {
    const a = String(ip || "").split(".").map(Number);
    if (a.length !== 4 || a.some(x => !(x >= 0 && x <= 255))) return ip;
    do { a[3] = a[3] >= 254 ? 1 : a[3] + 1; } while (devs.some(d => d.ip === a.join(".")) && a[3] !== +String(ip).split(".")[3]);
    return a.join(".");
  };
  function mbAddRow() {
    const m = mbMod(true);
    if (!m.editing) return;
    EspIR.modbusDevs(m);
    if (mbTab === "devs") {
      const d = { name: mbFree(m.devs, "Disp"), ip: mbNextIp("192.168.0.19", m.devs), port: 502, id: 1, timeout: 500,
                  regs: [{ name: "Reg1", reg: "40001", w: false, qty: 1, period: 500 }] };
      m.devs.push(d); mbOpen.add(d);
    } else (m.maps = m.maps || []).push({ name: mbFree(m.maps || [], "Registri"), net: "Slave", table: 2, start: 0, qty: 10 });
    markEditDirty(); renderModPage();
  }
  // copia del dispositivo con l'IP dopo (10 inverter uguali: uno, poi Duplica e si cambia l'IP)
  function mbDup(d) {
    const m = mbMod(false);
    if (!m || !m.editing) return;
    const base = d.name.replace(/\d+$/, "") || "Disp", c = JSON.parse(JSON.stringify(d));
    c.name = mbFree(m.devs, base); c.ip = mbNextIp(d.ip, m.devs);
    m.devs.splice(m.devs.indexOf(d) + 1, 0, c); mbOpen.add(c);
    markEditDirty(); renderModPage();
    setStatusLine(`«${d.name}» duplicato in «${c.name}» (${c.ip}): cambia l'IP se serve`);
  }
  // esempio (Denys): 3 inverter su Modbus TCP, per ognuno stato e parametri letti, comandi e velocità scritti
  function mbExample() {
    const m = mbMod(true);
    if (!m.editing) return;
    EspIR.modbusDevs(m);
    for (let k = 1; k <= 3; k++) {
      const d = { name: mbFree(m.devs, "Inv"), ip: `192.168.0.${20 + k}`, port: 502, id: 1, timeout: 300, regs: [
        { name: "stato", reg: "40001", w: false, qty: 6, period: 200, comment: "stato, frequenza, corrente, tensione, potenza, allarme" },
        { name: "cmd", reg: "40101", w: true, qty: 2, period: 200, comment: "parola di comando, riferimento di frequenza" }] };
      m.devs.push(d);
    }
    mbTab = "devs";
    markEditDirty(); renderModPage();
    setStatusLine("esempio di 3 inverter aggiunto: cambia IP e registri con quelli del manuale degli inverter, poi ✓ Conferma");
  }
  // testo della funzione e degli indirizzi di un registro: «FC3 leggi holding · 40001–40006»
  function mbRegInfo(g) {
    const p = EspIR.mbParseReg(g.reg);
    if (p.err) return { t: p.err, bad: true };
    const fc = EspIR.mbFcOf(p.table, !!g.w, g.qty || 1);
    if (!fc) return { t: `${MB_TABLE_T[p.table]}: solo lettura`, bad: true };
    const q = fc === 5 || fc === 6 ? 1 : g.qty || 1;
    return { t: `${MB_FC_T[fc]} · ${EspIR.mbRegText(p.table, p.addr)}${q > 1 ? "–" + EspIR.mbRegText(p.table, p.addr + q - 1) : ""}`, table: p.table, addr: p.addr, q };
  }
  const mbRange = x => EspIR.mbRegText(x.table, x.start || 0) + ((x.qty || 1) > 1 ? "–" + EspIR.mbRegText(x.table, (x.start || 0) + (x.qty || 1) - 1) : "");
  function renderMbPage() {
    const m = mbMod(false), ed = !!(m && m.editing);
    if (m) EspIR.modbusDevs(m);
    const tabs = mbTabs();
    if (!tabs.includes(mbTab)) mbTab = tabs[0] || "devs";
    renderModState();
    const devs = (m && m.devs) || [], maps = (m && m.maps) || [];
    const bar = document.getElementById("io-devs");
    bar.innerHTML = tabs.map(t => `<button class="mod-tab${t === mbTab ? " on" : ""}" data-mbtab="${t}">${MB_TAB_T[t]} (${(t === "devs" ? devs : maps).length})</button>`).join("") +
      (mbHas("devs") ? `<button id="mb-ex" class="mod-tab" title="Aggiunge 3 inverter con i registri di stato e dei comandi"${ed ? "" : " disabled"}>+ Esempio 3 inverter</button>` : "");
    bar.querySelectorAll("[data-mbtab]").forEach(b => b.onclick = () => { mbTab = b.dataset.mbtab; renderModPage(); });
    const ex = document.getElementById("mb-ex"); if (ex) ex.onclick = mbExample;
    document.getElementById("mod-add").textContent = mbTab === "devs" ? "+ Dispositivo" : "+ Registri";
    const c = mbCaps || (m && m.caps);
    document.getElementById("mod-info").textContent = (mbTab === "devs" ? `${devs.length} dispositivi · ${devs.reduce((a, d) => a + (d.regs || []).length, 0)} registri`
      : `${maps.length} gruppi di registri` + (c && c.slave ? ` · porta ${c.port}, id ${c.id} (da MiaConfig)` : "")) + (tabs.length ? "" : "Modbus non nel progetto MiaConfig della scheda");
    document.getElementById("mod-hint").textContent = {
      devs: "Ogni dispositivo si apre con ▸: i suoi registri con l'indirizzo vero (40001 o 400001 holding, 30001 input, 10001 ingressi, 1 coil), leggi o scrivi, ogni quanto. I valori nella DB Modbus: <dispositivo>_<registro>_0…, esito in _esito (0 ok, 1-11 eccezione, 256 tempo scaduto, 257 non collegato, 258 risposta non valida, 259 WiFi non permesso).",
      maps: "Registri che il PLC offre ai master: tabella, primo indirizzo vero, quantità. Sotto, ogni indirizzo con il suo campo della DB Modbus e, online, il valore (registri: WORD; coil e ingressi: BYTE, 8 per byte)."
    }[mbTab];
    const head = mbTab === "devs" ? ["", "Nome", "IP", "Porta", "Id", "Tempo max ms", "Registri", ""] : ["Nome", "Tabella", "Primo indirizzo", "Quantità", "Indirizzi", ""];
    document.querySelector("#mod-table thead").innerHTML = "<tr>" + head.map(h => `<th>${h}</th>`).join("") + "</tr>";
    const tb = document.querySelector("#mod-table tbody");
    const sel = (opts, v) => `<select${ed ? "" : " disabled"}>` + opts.map(([k, t]) => `<option value="${escapeHtml(String(k))}"${String(k) === String(v) ? " selected" : ""}>${escapeHtml(t)}</option>`).join("") + "</select>";
    const inp = (v, w, num) => `<input${num ? ' type="number"' : ""} value="${escapeHtml(String(v ?? ""))}" style="width:${w}"${ed ? "" : " disabled"}>`;
    const NUM = new Set(["port", "timeout", "id", "qty", "period", "table", "start"]);
    // each input/select of a row, in order, writes its key of the object
    const bind = (tr, obj, keys, after) => tr.querySelectorAll("td:not(.del) input, td:not(.del) select").forEach((el, k) => {
      el.onchange = () => {
        const key = keys[k];
        if (key === "start") { const p = EspIR.mbParseReg(el.value); obj.start = p.err ? Math.max(0, Number(el.value) || 0) : p.addr; if (!p.err) obj.table = p.table; }
        else if (key === "w") obj.w = el.value === "1";
        else obj[key] = NUM.has(key) ? Number(el.value) : el.value.trim();
        markEditDirty();
        if (after) after(key); else renderModPage();
      };
    });
    tb.innerHTML = "";
    const mapBox = document.getElementById("mb-map");
    mapBox.innerHTML = "";
    if (mbTab === "devs") devs.forEach((d, i) => {
      const open = mbOpen.has(d), tr = document.createElement("tr");
      tr.className = "mb-dev";
      tr.innerHTML = `<td><button class="icon mb-tog" title="${open ? "Chiudi" : "Apri i registri"}">${open ? "▾" : "▸"}</button></td>` +
        [inp(d.name, "9em"), inp(d.ip, "9em"), inp(d.port, "5em", true), inp(d.id, "4em", true), inp(d.timeout, "6em", true)].map(x => `<td>${x}</td>`).join("") +
        `<td class="muted">${(d.regs || []).length}</td><td class="del"><button class="icon mb-dup" title="Duplica: stesso dispositivo con l'IP dopo"${ed ? "" : " disabled"}>⧉</button><button class="icon d-del" title="Elimina il dispositivo"${ed ? "" : " disabled"}>✕</button></td>`;
      bind(tr, d, ["name", "ip", "port", "id", "timeout"], key => { if (key === "name") renderModPage(); });
      tr.querySelector(".mb-tog").onclick = () => { if (open) mbOpen.delete(d); else mbOpen.add(d); renderModPage(); };
      tr.querySelector(".mb-dup").onclick = () => mbDup(d);
      tr.querySelector(".d-del").onclick = () => { devs.splice(i, 1); markEditDirty(); renderModPage(); };
      tb.appendChild(tr);
      if (!open) return;
      const sub = document.createElement("tr");
      sub.className = "mb-regs";
      sub.innerHTML = `<td></td><td colspan="7"><table class="mb-sub"><thead><tr><th>Registro</th><th>Indirizzo</th><th>Verso</th><th>Quantità</th><th>Ogni ms</th><th>Funzione</th><th>Commento</th><th>Esito</th><th>Valori</th><th></th></tr></thead><tbody></tbody></table></td>`;
      const sb = sub.querySelector("tbody");
      (d.regs || []).forEach((g, k) => {
        const r = document.createElement("tr"), info = mbRegInfo(g), f = `${d.name}_${g.name}`;
        r.innerHTML = [inp(g.name, "8em"), inp(g.reg, "6em"), sel([["0", "leggi"], ["1", "scrivi"]], g.w ? "1" : "0"), inp(g.qty, "4em", true),
                       inp(g.period, "5em", true)].map(x => `<td>${x}</td>`).join("") +
          `<td class="mb-fc${info.bad ? " bad" : ""}">${escapeHtml(info.t)}</td><td class="mb-com">${inp(g.comment || "", "100%")}</td>` +
          `<td class="num mb-val" data-mbf="${escapeHtml(f)}_esito" data-n="1"></td><td class="num mb-val" data-mbf="${escapeHtml(f)}_0" data-n="${info.bad ? 0 : mbBitsT(info.table) ? Math.ceil(info.q / 8) : info.q}"></td>` +
          `<td class="del"><button class="icon d-del" title="Elimina il registro"${ed ? "" : " disabled"}>✕</button></td>`;
        r.querySelectorAll("td:not(.del):not(.mb-val) input, td:not(.del):not(.mb-val) select").forEach((el, j) => {
          const key = ["name", "reg", "w", "qty", "period", "comment"][j];
          el.onchange = () => {
            if (key === "w") g.w = el.value === "1"; else g[key] = NUM.has(key) ? Number(el.value) : el.value.trim();
            if (key === "comment" && !g.comment) delete g.comment;
            markEditDirty();
            const ni = mbRegInfo(g), fc = r.querySelector(".mb-fc");
            fc.textContent = ni.t; fc.classList.toggle("bad", !!ni.bad);
          };
        });
        r.querySelector(".d-del").onclick = () => { d.regs.splice(k, 1); markEditDirty(); renderModPage(); };
        sb.appendChild(r);
      });
      if (ed) {
        const add = document.createElement("tr");
        add.innerHTML = `<td colspan="10"><button class="ghost mb-addreg">+ Registro</button></td>`;
        add.querySelector("button").onclick = () => {
          const last = (d.regs || [])[d.regs.length - 1], p = last && EspIR.mbParseReg(last.reg);
          const reg = last && !p.err ? EspIR.mbRegText(p.table, Math.min(65535, p.addr + (last.qty || 1))) : "40001";
          (d.regs = d.regs || []).push({ name: mbFree(d.regs, "Reg"), reg, w: false, qty: 1, period: last ? last.period : 500 });
          markEditDirty(); renderModPage();
        };
        sb.appendChild(add);
      }
      tb.appendChild(sub);
    });
    else {
      maps.forEach((x, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = [inp(x.name, "9em"), sel(MB_TABLE_T.map((t, k) => [k, t]), x.table), inp(EspIR.mbRegText(x.table, x.start || 0), "7em"), inp(x.qty, "5em", true)]
          .map(c => `<td>${c}</td>`).join("") + `<td class="muted">${mbRange(x)}</td><td class="del"><button class="icon d-del" title="Elimina"${ed ? "" : " disabled"}>✕</button></td>`;
        bind(tr, x, ["name", "table", "start", "qty"]);
        tr.querySelector(".d-del").onclick = () => { maps.splice(i, 1); markEditDirty(); renderModPage(); };
        tb.appendChild(tr);
      });
      // map of the addresses: one row per register (bits: one row per byte, 8 addresses)
      if (maps.length) {
        const rows = [];
        for (const x of maps) {
          const bits = mbBitsT(x.table), n = bits ? Math.ceil((x.qty || 1) / 8) : x.qty || 1;
          for (let k = 0; k < n && rows.length < 1000; k++) {
            const a = (x.start || 0) + (bits ? k * 8 : k), last = bits ? Math.min(a + 7, (x.start || 0) + (x.qty || 1) - 1) : a;
            rows.push(`<tr><td>${EspIR.mbRegText(x.table, a)}${last > a ? "–" + EspIR.mbRegText(x.table, last) : ""}</td><td class="muted">${MB_TABLE_T[x.table]}</td>` +
                      `<td translate="no">Modbus.${escapeHtml(x.name)}_${k}</td><td class="muted">${bits ? "BYTE" : "WORD"}</td><td class="num mb-val" data-mbf="${escapeHtml(x.name)}_${k}" data-n="1"${bits ? ' data-bits="1"' : ""}></td></tr>`);
          }
        }
        mapBox.innerHTML = `<h3>Mappa degli indirizzi</h3><table id="mb-map-t"><thead><tr><th>Indirizzo</th><th>Tabella</th><th>Campo</th><th>Tipo</th><th>Valore</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
      }
    }
    if (mbTab === "devs" && !devs.length) tb.innerHTML = `<tr><td colspan="8" class="muted">${ed ? "«+ Dispositivo» per aggiungerne uno, o «+ Esempio 3 inverter»" : "Nessun dispositivo: ✎ Modifica per cominciare"}.</td></tr>`;
    if (mbTab === "maps" && !maps.length) tb.innerHTML = `<tr><td colspan="6" class="muted">${ed ? "«+ Registri» per aggiungere un gruppo" : "Nessun registro: ✎ Modifica per cominciare"}.</td></tr>`;
    if (!tabs.length) tb.innerHTML = `<tr><td colspan="8" class="muted">Il progetto MiaConfig di questa scheda non ha il Modbus TCP.</td></tr>`;
    renderMbValues();
  }
  // Online: valori dei campi della DB Modbus a video (registri dei dispositivi aperti, mappa dello slave)
  const mbLiveFields = () => {
    if (!modPage || modKind !== "modbus") return [];
    const out = [];
    document.querySelectorAll("#mod-page .mb-val").forEach(c => { const f = c.dataset.mbf, n = +c.dataset.n || 0, base = f.replace(/_0$/, "");
      if (n <= 1) out.push(f); else for (let k = 0; k < n; k++) out.push(`${base}_${k}`); });
    return out;
  };
  function renderMbValues() {
    const on = liveMonitoring && dbOnPlc(EspIR.MODBUS_DB);
    document.querySelectorAll("#mod-page .mb-val").forEach(c => {
      const f = c.dataset.mbf, n = +c.dataset.n || 0, base = f.replace(/_0$/, ""), vs = [];
      for (let k = 0; k < n; k++) { const v = on ? liveNum.get(`DB${EspIR.MODBUS_DB}.${n <= 1 ? f : base + "_" + k}`) : undefined; vs.push(v === undefined ? "—" : c.dataset.bits ? v.toString(2).padStart(8, "0") : String(v)); }
      c.textContent = on && n ? vs.join(" ") : "";
    });
  }
  function renderModPage() {
    if (modKind === "io") { renderIoPage(); return; }
    if (modKind === "modbus") { renderMbPage(); return; }
    if (modKind === "hmi") { renderHmiPage(); return; }
    document.querySelector("#mod-table thead").innerHTML = "<tr><th>Nome nel JSON</th><th>Operando</th><th>Tipo</th><th>Commento</th><th></th></tr>";
    const m = dataMod(false), list = (m && m[modTab]) || [], ed = !!(m && m.editing);
    renderModState();
    document.querySelectorAll("#mod-page .mod-tab").forEach(b => b.classList.toggle("on", b.dataset.tab === modTab));
    document.getElementById("mod-info").textContent = `TX ${(m && m.tx.length) || 0} · RX ${(m && m.rx.length) || 0}`;
    document.getElementById("mod-hint").textContent = modTab === "tx"
      ? "Valori che il PLC espone: GET http://<ip del PLC>/api/data/exposure → {\"data\": {\"nome\": valore, …}, \"state\": \"run\"}"
      : "Valori che si scrivono da fuori: POST http://<ip del PLC>/api/data/exposure con {\"nome\": valore, …} (solo M e campi dei DB), scritti tra due scansioni";
    const tb = document.querySelector("#mod-table tbody");
    tb.innerHTML = "";
    list.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><input class="d-name" maxlength="32" translate="no"></td><td><input class="d-op" translate="no"></td>
        <td class="d-type"></td><td><input class="d-com" maxlength="120"></td>
        <td class="del"><button class="icon d-up" title="Su">↑</button><button class="icon d-down" title="Giù">↓</button><button class="icon d-del" title="Elimina">✕</button></td>`;
      const ni = tr.querySelector(".d-name"), oi = tr.querySelector(".d-op"), ci = tr.querySelector(".d-com"), ty = tr.querySelector(".d-type");
      ni.value = r.name; oi.value = dataOpText(r.op); ci.value = r.comment || ""; ty.textContent = dataOpType(r.op);
      [ni, oi, ci].forEach(x => { x.disabled = !ed; });
      tr.querySelectorAll("button").forEach(b => { b.disabled = b.disabled || !ed; });
      attachSuggest(oi, modTab === "rx" ? "anyw" : "any");
      ni.addEventListener("change", () => {
        const v = ni.value.trim();
        if (!EspIR.DATA_NAME_RE.test(v) || list.some(x => x !== r && x.name === v)) { ni.classList.add("bad"); setStatusLine(EspIR.DATA_NAME_RE.test(v) ? `c'è già un campo «${U(v)}»` : "nome: lettere, cifre, _ . - (max 32)", "warn"); return; }
        ni.classList.remove("bad"); r.name = v; markEditDirty();
      });
      oi.addEventListener("change", () => {
        const p = parseDataOp(oi.value, modTab);
        if (p.err) { oi.classList.add("bad"); setStatusLine(p.err, "warn"); return; }
        oi.classList.remove("bad"); r.op = p.o; ty.textContent = p.type;
        if (/^campo\d+$/.test(r.name)) {                       // nome ancora quello automatico: quello dell'operando
          const base = (isMemOp(p.o) ? p.o.f + (p.o.bit != null ? "_" + p.o.bit : "") : (EspSymbols.nameOf(p.o) || varKey(p.o))).replace(/[^A-Za-z0-9_.\-]/g, "_").slice(0, 32);
          if (EspIR.DATA_NAME_RE.test(base) && !list.some(x => x !== r && x.name === base)) { r.name = base; ni.value = base; }
        }
        markEditDirty();
      });
      ci.addEventListener("change", () => { const c = ci.value.trim(); if (c) r.comment = c; else delete r.comment; markEditDirty(); });
      tr.querySelector(".d-up").disabled = i === 0;
      tr.querySelector(".d-down").disabled = i === list.length - 1;
      tr.querySelector(".d-up").onclick = () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); markEditDirty(); renderModPage(); };
      tr.querySelector(".d-down").onclick = () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); markEditDirty(); renderModPage(); };
      tr.querySelector(".d-del").onclick = () => { list.splice(i, 1); markEditDirty(); renderModPage(); };
      tb.appendChild(tr);
    });
    if (!list.length) tb.innerHTML = `<tr><td colspan="5" class="muted">Nessun valore: «+ Valore» per aggiungerne uno.</td></tr>`;
  }
  // Dati HMI: nome, operando, tipo, scrittura, unità, minimo, massimo, decimali
  function renderHmiPage() {
    const m = hmiMod(false), list = (m && m.rows) || [], ed = !!(m && m.editing);
    renderModState();
    document.getElementById("mod-per").value = (m && m.period) || 500;
    document.getElementById("mod-info").textContent = `${list.length} valori · scrivibili ${list.filter(r => r.w).length}`;
    document.getElementById("mod-hint").textContent = "Pannello operatore: file di configurazione GET http://<ip del PLC>/api/hmi/config.bin, valori per indice sulla porta TCP 5050 (scrittura solo M e campi dei DB)";
    document.querySelector("#mod-table thead").innerHTML = "<tr><th>#</th><th>Nome</th><th>Operando</th><th>Tipo</th><th>Scrittura</th><th>Unità</th><th>Minimo</th><th>Massimo</th><th>Decimali</th><th></th></tr>";
    const tb = document.querySelector("#mod-table tbody");
    tb.innerHTML = "";
    const numOf = v => { v = String(v).trim().replace(",", "."); return v === "" ? undefined : isFinite(+v) ? +v : NaN; };
    list.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="d-type">${i}</td><td><input class="d-name" maxlength="32"></td><td><input class="d-op" translate="no"></td><td class="d-type d-t"></td>
        <td><input type="checkbox" class="d-w"></td><td><input class="d-unit" maxlength="12"></td><td><input class="d-min"></td><td><input class="d-max"></td>
        <td><input class="d-dec" type="number" min="0" max="6"></td>
        <td class="del"><button class="icon d-up" title="Su">↑</button><button class="icon d-down" title="Giù">↓</button><button class="icon d-del" title="Elimina">✕</button></td>`;
      const q = c => tr.querySelector(c);
      const ni = q(".d-name"), oi = q(".d-op"), ty = q(".d-t"), wi = q(".d-w"), ui = q(".d-unit"), mi = q(".d-min"), xi = q(".d-max"), di = q(".d-dec");
      ni.value = r.name; oi.value = dataOpText(r.op); ty.textContent = dataOpType(r.op); wi.checked = !!r.w; ui.value = r.unit || "";
      mi.value = r.min !== undefined ? r.min : ""; xi.value = r.max !== undefined ? r.max : ""; di.value = r.dec !== undefined ? r.dec : "";
      [ni, oi, wi, ui, mi, xi, di].forEach(x => { x.disabled = !ed; });
      tr.querySelectorAll("button").forEach(b => { b.disabled = !ed; });
      attachSuggest(oi, "any");
      const chk = () => { const e = hmiRowErr(r, i); tr.classList.toggle("bad", !!e); if (e) setStatusLine(e, "warn"); };
      ni.addEventListener("change", () => { r.name = ni.value.trim(); markEditDirty(); chk(); });
      oi.addEventListener("change", () => {
        const p = parseDataOp(oi.value, "tx");
        if (p.err) { oi.classList.add("bad"); setStatusLine(p.err, "warn"); return; }
        oi.classList.remove("bad"); r.op = p.o; ty.textContent = p.type;
        if (/^campo\d+$/.test(r.name)) { r.name = (isMemOp(p.o) ? p.o.f + (p.o.bit != null ? "." + p.o.bit : "") : (EspSymbols.nameOf(p.o) || varKey(p.o))).slice(0, 32); ni.value = r.name; }
        markEditDirty(); chk();
      });
      wi.addEventListener("change", () => { if (wi.checked) r.w = true; else delete r.w; markEditDirty(); chk(); });
      ui.addEventListener("change", () => { const u = ui.value.trim(); if (u) r.unit = u; else delete r.unit; markEditDirty(); });
      [[mi, "min"], [xi, "max"]].forEach(([el, k]) => el.addEventListener("change", () => {
        const v = numOf(el.value);
        if (Number.isNaN(v)) { el.classList.add("bad"); setStatusLine("scrivi un numero (o lascia vuoto)", "warn"); return; }
        el.classList.remove("bad"); if (v === undefined) delete r[k]; else r[k] = v; markEditDirty(); chk();
      }));
      di.addEventListener("change", () => { const v = parseInt(di.value, 10); if (v >= 0 && v <= 6) r.dec = v; else { delete r.dec; di.value = ""; } markEditDirty(); });
      q(".d-up").disabled = !ed || i === 0;
      q(".d-down").disabled = !ed || i === list.length - 1;
      q(".d-up").onclick = () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); markEditDirty(); renderModPage(); };
      q(".d-down").onclick = () => { list.splice(i + 1, 0, list.splice(i, 1)[0]); markEditDirty(); renderModPage(); };
      q(".d-del").onclick = () => { list.splice(i, 1); markEditDirty(); renderModPage(); };
      tb.appendChild(tr);
    });
    if (!list.length) tb.innerHTML = `<tr><td colspan="10" class="muted">Nessun valore: «+ Valore» per aggiungerne uno.</td></tr>`;
  }
  function modAddRow() {
    if (modKind === "modbus") { mbAddRow(); return; }
    const m = curMod(true), list = modKind === "hmi" ? m.rows : m[modTab];
    if (!m.editing) return;
    if (modKind === "io") {
      const pre = { bi: "In", bo: "Out", ri: "AIn", ro: "AOut" }[modTab];
      const all = new Set(EspIR.IO_LISTS.flatMap(x => (m[x] || []).map(r => r.name.toLowerCase())));
      let k = list.length + 1; while (all.has((pre + k).toLowerCase())) k++;
      list.push({ name: pre + k, res: "" });
      markEditDirty(); renderModPage();
      return;
    }
    let k = list.length + 1; while (list.some(x => x.name === "campo" + k)) k++;
    list.push({ name: "campo" + k, op: modKind === "hmi" || modTab === "rx" ? { ns: "M", idx: 0 } : { ns: "I", idx: 0 } });
    markEditDirty(); renderModPage();
    const ops = document.querySelectorAll("#mod-table .d-op"), last = ops[ops.length - 1];
    if (last) { last.focus(); last.select(); }
  }
  // tx.json / rx.json come sono sul PLC: generati alla conferma, arrivati col Download
  async function modDownload(dir) {
    if (dir === "hmi") {                                 // config.bin del pannello
      let r;
      try { r = await fetch("/api/hmi/config.bin"); } catch (e) { setStatusLine("config.bin: PLC non raggiungibile", "err"); return; }
      if (r.status === 404) { setStatusLine("config.bin: sul PLC non ci sono i Dati HMI (Compile e Download)", "warn"); return; }
      if (!r.ok) { setStatusLine(`config.bin: HTTP ${r.status}`, "err"); return; }
      const b = new Uint8Array(await r.arrayBuffer());
      downloadFile(`${safeName(project.name || "progetto")}-hmi-config.bin`, b, "application/octet-stream");
      setStatusLine(`config.bin dal PLC: ${b.length >= 8 ? b[6] | b[7] << 8 : 0} valori, ${b.length} B`);
      return;
    }
    let r;
    try { r = await fetch(`/api/data/exposure/plc${dir}.json`); } catch (e) { setStatusLine(`${dir}.json: PLC non raggiungibile`, "err"); return; }
    if (r.status === 404) { setStatusLine(`${dir}.json: sul PLC non c'è l'esposizione dati (Compile e Download)`, "warn"); return; }
    if (!r.ok) { setStatusLine(`${dir}.json: HTTP ${r.status}`, "err"); return; }
    const txt = await r.text();
    let doc = {}; try { doc = JSON.parse(txt); } catch (e) {}
    downloadFile(`${safeName(doc.project || project.name || "progetto")}-plc${dir}.json`, txt, "application/json");
    setStatusLine(`plc${dir}.json dal PLC: ${(doc.fields || []).length} campi, versione ${fmtStamp(doc.confirmed)}`);
  }
  // ── Menu contestuali (offline): rami, uscite, eliminazione ──
  let ctxNode = null;
  function showMenu(x, y, node, items) {
    closeMenus(); hideTip();
    const m = document.getElementById("ctxmenu");
    m.innerHTML = "";
    for (const it of items) {
      if (it === "-") { m.appendChild(Object.assign(document.createElement("hr"))); continue; }
      const d = document.createElement("div");
      d.textContent = it.label;
      if (it.danger) d.className = "danger";
      if (it.info) d.className = "info";                       // solo testo (es. le cause di SF)
      else if (it.disabled) { d.className = "disabled"; d.title = it.disabled; }
      else d.addEventListener("click", ev => { ev.stopPropagation(); closeMenus(); it.run(); });
      m.appendChild(d);
    }
    ctxNode = node;
    render();
    m.classList.remove("hidden");
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth  - r.width  - 8) + "px";
    m.style.top  = Math.min(y, window.innerHeight - r.height - 8) + "px";
  }
  function closeMenus() {
    const had = ctxNode || forceNode;
    document.getElementById("ctxmenu").classList.add("hidden");
    document.getElementById("forcemenu").classList.add("hidden");
    ctxNode = null; forceNode = null; forceOp = null;
    if (had) render();
  }
  // Modifica strutturale con annulla-inserimento se apre un contatto nuovo
  function edit(fn) {
    const undo = takeUndo();
    const fresh = fn();
    markEditDirty(); render();
    if (fresh) openPicker(fresh, false, undo);
  }
  const freshContact = () => Object.assign(mkContact("I", 0, false), { _fresh: true });
  const mkSlot = () => ({ type: "Slot", unset: true });           // ramo parallelo nuovo: elemento da scegliere, niente popup
  let slotSel = null;
  const SLOT_KEYS = { a: "contact-no", c: "contact-nc", p: "contact-p", n: "contact-n", ">": "cmp", "<": "cmp", "=": "cmp", "!": "not" };
  const SLOT_COIL_KEYS = { b: "coil", "/": "coil-neg", s: "coil-set", r: "coil-reset", t: "timer-TON" };
  function slotPut(sl, elt) {
    if (sl.kind === "SLOT") {                                      // uscita «?»
      const w = parentOf.get(sl), leaf = w && w.leaf;
      if (!leaf || !elt || leaf.coil !== sl) return;
      if (!(isCoilElt(elt) || isTimerElt(elt) || isCallElt(elt) || isBoxElt(elt))) { setStatusLine("al posto dell'uscita vanno bobine, timer, FC o box", "warn"); return; }
      slotSel = null;
      if (isCoilElt(elt)) { takeUndo(); leaf.coil = newCoil(elt); toUnset(leaf.coil); markEditDirty(); render(); setStatusLine(leaf.coil.kind === "RET" ? "RET inserito" : UNSET_MSG); return; }
      delete leaf.coil; leaf.outputs = [];                          // timer, FC, box: come in fondo a un network aperto
      onDropPalette(elt, { kind: "open-end", node: leaf, accepts: "end", where: w });
      return;
    }
    const pos = parentOf.get(sl);
    if (!pos || !elt) return;
    if (!/^contact-|^cmp$|^not$|^trig-/.test(elt)) { setStatusLine("nel ramo parallelo vanno contatti, confronti, fronti o NOT", "warn"); return; }
    slotSel = null;
    pos.series.items.splice(pos.index, 1);                         // il segnaposto lascia il posto all'elemento
    onDropPalette(elt, { kind: "gap", series: pos.series, index: pos.index, accepts: "contact", where: null });
  }
  function openSlotMenu(x, y, sl) {
    if (sl.kind === "SLOT") {
      const C = [["coil", "( ) Bobina", "B"], ["coil-neg", "(/) Bobina negata", "/"], ["coil-set", "(S) Set", "S"], ["coil-reset", "(R) Reset", "R"], ["timer-TON", "TON Timer", "T"]];
      showMenu(x, y, sl, C.map(([e, t, k]) => ({ label: `${t}   (${k})`, run: () => slotPut(sl, e) })));
      return;
    }
    const L = [["contact-no", "⊣⊢ Contatto NA", "A"], ["contact-nc", "⊣/⊢ Contatto NC", "C"], ["contact-p", "P Fronte di salita", "P"],
               ["contact-n", "N Fronte di discesa", "N"], ["cmp", "> Confronto", ">"], ["not", "NOT", "!"]];
    showMenu(x, y, sl, L.map(([e, t, k]) => ({ label: `${t}   (${k})`, run: () => slotPut(sl, e) })));
  }
  document.addEventListener("keydown", e => {
    if (!slotSel || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Escape") { slotSel = null; render(); return; }
    const elt = (slotSel.kind === "SLOT" ? SLOT_COIL_KEYS : SLOT_KEYS)[e.key.toLowerCase()];
    if (!elt) return;
    e.preventDefault(); closeMenus(); slotPut(slotSel, elt);
  });

  // ── Copia e incolla di un elemento (contatto, confronto, fronte, timer, FC, box, bobina) ──
  // Negli appunti dell'editor: un elemento in linea { line } o una bobina { coil } (timer, FC e box finali
  // si copiano in linea). Gli operandi restano quelli dell'originale; i fronti con memoria automatica ne
  // prendono una nuova dell'area E (due fronti con la stessa memoria non funzionano).
  let clip = null;
  const clipName = n => n.type === "Call" || n.kind === "CALL" ? "FC" + n.fc : n.type === "Box" || n.kind === "BOX" ? n.box
    : n.type === "Compare" ? "confronto " + n.cmp : n.type === "Trig" ? n.edge + "_TRIG" : n.type === "Not" ? "NOT"
    : n.kind === "RET" ? "RET" : n.op ? (isMemOp(n.op) ? memText(n.op) : varKey(n.op)) : "elemento";
  const jclone = n => { const x = JSON.parse(JSON.stringify(n)); delete x._fresh; return x; };
  function copyLine(n) { setClip({ line: jclone(n) }); setStatusLine(`copiato: ${clipName(n)}`); }
  function copyEnd(c) {
    setClip(EspIR.EFFECT_COIL(c.kind) ? { line: jclone(EspIR.effectToInline(c)) } : { coil: jclone(c) });
    setStatusLine(`copiato: ${clipName(c)}`);
  }
  // Appunti anche fra schede del browser (un altro progetto aperto): l'ultima copia sta in localStorage
  const CLIP_LS = "espplc.clip";
  function setClip(c) {
    clip = c;
    if (document.body) document.body.classList.toggle("has-clip", !!c);   // zone «visibili con qualcosa da incollare»
    try { localStorage.setItem(CLIP_LS, JSON.stringify({ t: Date.now(), c })); } catch (e) {}
  }
  window.addEventListener("storage", e => {
    if (e.key !== CLIP_LS || !e.newValue) return;
    try { clip = JSON.parse(e.newValue).c || null; document.body.classList.toggle("has-clip", !!clip); } catch (x) {}
  });
  try { const v = JSON.parse(localStorage.getItem(CLIP_LS) || "null"); if (v && v.c && Date.now() - v.t < 86400000) clip = v.c; } catch (e) {}
  // ogni elemento (e bobina) di un pezzo di programma: serie, rami del parallelo, rami aperti, uscite
  function walkItems(items, fn) {
    items.forEach(it => { fn(it); if (it.type === "Parallel") it.branches.forEach(b => walkItems(b.items, fn)); else if (it.type === "Open" && it.branch) walkItems(it.branch.items, fn); });
  }
  function walkNode(nd, fn) { walkItems(nd.series.items, fn); if (nd.coil) fn(nd.coil); (nd.outputs || []).forEach(o => walkNode(o, fn)); }
  function walkSegs(segs, fn) { segs.forEach(sg => sg.rungs.forEach(r => walkNode(r, fn))); }
  const isCallIt = it => it.type === "Call" || it.kind === "CALL";
  // Controllo della destinazione di quello che si incolla: niente FC che chiama se stessa; fronti con una memoria nuova;
  // timer già usati nel progetto con un numero libero (i contatti del timer copiati lo seguono). → { err } o { notes }
  function pasteFix(walk, intoFc) {
    let err = null;
    const notes = [], missing = new Set();
    walk(it => {
      if (!isCallIt(it)) return;
      if (intoFc != null && it.fc === intoFc) err = "una funzione non può chiamare se stessa";
      if (!project.blocks.some(b => b.type === "fc" && b.number === it.fc)) missing.add("FC" + it.fc);
    });
    if (err) return { err };
    const eUsed = [], tUsed = new Set(), tMap = new Map();
    project.blocks.forEach(b => walkSegs(b.segments, it => { if (isTimerObj(it) && it.op && Number.isInteger(it.op.idx)) tUsed.add(it.op.idx); }));
    walk(it => {
      for (const k of ["mem", "memD"]) if (it[k] && it[k].ns === "E") { it[k] = { ns: "E", idx: freeEdgeIdx(eUsed) }; eUsed.push(it[k].idx); }
      if (isTimerObj(it) && it.op && Number.isInteger(it.op.idx)) {
        const o = it.op.idx;
        if (!tMap.has(o)) {
          let nn = o;
          if (tUsed.has(o)) { nn = 0; while (nn <= 255 && tUsed.has(nn)) nn++; }
          tMap.set(o, nn); tUsed.add(nn);
        }
        it.op.idx = tMap.get(o);
      }
    });
    walk(it => { if (!isTimerObj(it) && it.op && it.op.ns === "T" && tMap.has(it.op.idx)) it.op.idx = tMap.get(it.op.idx); });
    const ch = [...tMap].filter(([a, b]) => a !== b).map(([a, b]) => `T${a} → T${b}`);
    if (ch.length) notes.push("timer già usati, rinumerati: " + ch.join(", "));
    if (missing.size) notes.push([...missing].join(", ") + " non c'è in questo progetto");
    return { notes };
  }
  function pasteWhy(coilHere) {
    if (!clip) return "niente da incollare: prima «Copia» col tasto destro su un elemento";
    if (clip.net) return "negli appunti c'è un network: tasto destro sull'intestazione di un network → Incolla network";
    if (clip.fc) return "negli appunti c'è una FC: tasto destro nell'elenco dei blocchi → Incolla FC";
    if (clip.lines) return clip.lines.some(it => isCallIt(it) && program.type === "fc" && program.number === it.fc) ? "una funzione non può chiamare se stessa" : null;
    const n = clip.line || clip.coil;
    if ((n.type === "Call" || n.kind === "CALL") && program.type === "fc" && program.number === n.fc) return "una funzione non può chiamare se stessa";
    if (clip.coil && !coilHere) return "una bobina si incolla col tasto destro su una bobina (uscita parallela) o su un network senza bobina";
    return null;
  }
  // put riceve l'elemento, oppure (più elementi) l'elenco
  function paste(put) {
    const items = (clip.lines || [clip.line || clip.coil]).map(jclone);
    const fx = pasteFix(fn => walkItems(items, fn), program.type === "fc" ? program.number : null);
    if (fx.err) { setStatusLine(fx.err, "warn"); return; }
    edit(() => { put(clip.lines ? items : items[0]); });
    const n = items[0], memM = items.find(x => x.mem && x.mem.ns === "M");
    const what = clip.lines ? `${items.length} elementi` : clipName(n);
    const warn = memM ? ` — il fronte usa la stessa memoria M${memM.mem.idx} dell'originale: cambiala` : "";
    setStatusLine(`incollato: ${what}${warn}${fx.notes.length ? " — " + fx.notes.join("; ") : ""}`, memM || fx.notes.length ? "warn" : undefined);
  }
  // Incolla in una zona di rilascio (le aree tratteggiate): un elemento nella linea in quel punto; una bobina apre
  // lì un'uscita (sulla parte comune o un'uscita) o chiude un network aperto
  const zoneCoilOk = m => m.kind === "open-end" || (m.kind === "gap" && m.where && m.where.node && m.series === m.where.node.series);
  function zonePasteWhy(m) {
    if (m.kind === "new-rung") return netPasteWhy(m.segIdx);
    if (m.kind !== "gap" && m.kind !== "open-end") return "qui non si incolla";
    return pasteWhy(zoneCoilOk(m));
  }
  function zonePaste(m) {
    if (m.kind === "new-rung") { pasteInNet(m.segIdx); return; }
    const coil = !!clip.coil;
    if (m.kind === "open-end") paste(n => { if (coil) m.node.outputs = [{ series: mkSeries(), coil: n }]; else m.node.series.items.push(n); });
    else if (coil) paste(n => EspIR.splitAt(m.where.node, m.index, { series: mkSeries(), coil: n }));
    else paste(n => m.series.items.splice(m.index, 0, ...(Array.isArray(n) ? n : [n])));
  }
  // nel network n: in fondo alla linea (network vuoto o aperto) o, se è una bobina, come elemento finale
  function netPasteWhy(n) {
    const r = program.segments[n] && program.segments[n].rungs[0];
    if (r && r.outputs && r.outputs.length) return pasteWhy(true) || "il network finisce con una bobina: incolla col tasto destro su un elemento";
    return pasteWhy(true);
  }
  function pasteInNet(n) {
    paste(x => {
      const sg = program.segments[n];
      let r = sg.rungs[0];
      if (!r) { r = EspIR.rung(mkSeries(), []); sg.rungs.push(r); }
      if (clip.coil) r.outputs = [{ series: mkSeries(), coil: x }];
      else r.series.items.push(...(Array.isArray(x) ? x : [x]));
    });
  }
  // Più elementi vicini della stessa linea: Maiusc+clic sul primo e sull'ultimo (riquadro azzurro), poi Ctrl+C o
  // tasto destro → Copia; Ctrl+V incolla nella zona sotto il mouse
  let sel = null, selHits = [], lastZone = null;              // sel: { series, anchor, a, b }
  const selCount = () => sel ? sel.b - sel.a + 1 : 0;
  function copySel() {
    if (!sel) return;
    setClip({ lines: sel.series.items.slice(sel.a, sel.b + 1).map(jclone) });
    setStatusLine(`copiati ${selCount()} elementi: Ctrl+V o tasto destro su una zona tratteggiata → Incolla qui`);
  }
  function deleteSel() {
    if (!sel) return;
    const s = sel; sel = null;
    edit(() => { s.series.items.splice(s.a, s.b - s.a + 1); });
  }
  function selHitAt(svg, e) {
    const p = svgPoint(e, svg);
    return selHits.find(h => h.svg === svg && p.x >= h.x0 - 2 && p.x <= h.x1 + 2 && p.y >= h.y0 && p.y <= h.y1) || null;
  }
  function setupSel(svg) {
    svg.addEventListener("click", e => {
      if (!e.shiftKey) { if (sel) { sel = null; setTimeout(render, 0); } return; }
      const h = selHitAt(svg, e);
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      if (sel && sel.series === h.series) { sel.a = Math.min(sel.anchor, h.index); sel.b = Math.max(sel.anchor, h.index); }
      else sel = { series: h.series, anchor: h.index, a: h.index, b: h.index };
      render();
      setStatusLine(`${selCount()} elementi selezionati: Ctrl+C per copiare, tasto destro per il menu, Esc per togliere`);
    }, true);
    svg.addEventListener("contextmenu", e => {
      if (!sel) return;
      const h = selHitAt(svg, e);
      if (!h || h.series !== sel.series || h.index < sel.a || h.index > sel.b) return;
      e.preventDefault(); e.stopPropagation();
      showMenu(e.clientX, e.clientY, null, [
        { label: `📄 Copia selezione (${selCount()})`, run: copySel },
        { label: `✕ Elimina selezione (${selCount()})`, danger: true, run: deleteSel }]);
    }, true);
  }
  // ── Network interi: copia, incolla sopra / sotto (anche in un'altra FC, nel Main, in un altro progetto) ──
  function copyNet(n) {
    setClip({ net: jclone(program.segments[n]) });
    setStatusLine(`copiato il network ${n + 1}: tasto destro sull'intestazione di un network → Incolla network sopra / sotto`);
  }
  const netClipWhy = () => clip && clip.net ? null : "negli appunti non c'è un network: tasto destro sull'intestazione → Copia network";
  function pasteNet(at) {
    if (netClipWhy()) return;
    const sg = jclone(clip.net);
    const fx = pasteFix(fn => walkSegs([sg], fn), program.type === "fc" ? program.number : null);
    if (fx.err) { setStatusLine(fx.err, "warn"); return; }
    sg.id = program.segments.reduce((m, s) => Math.max(m, s.id | 0), 0) + 1;
    at = Math.max(0, Math.min(at, program.segments.length));
    program.segments.splice(at, 0, sg);
    renumberSegments();
    netBlocks = [];
    markEditDirty(); render();
    setStatusLine(`incollato il network ${at + 1}${fx.notes.length ? " — " + fx.notes.join("; ") : ""}`, fx.notes.length ? "warn" : undefined);
  }

  function openContactMenu(x, y, c) {
    const pos = parentOf.get(c);                      // { series, index }
    const openFc = c.type === "Call" ? project.blocks.find(b => b.type === "fc" && b.number === c.fc) : null;
    const inBranch = pos && parentOf.get(pos.series); // { parallel, branch } se in un ramo
    const par = inBranch && inBranch.parallel;
    const parPos = par && parentOf.get(par);          // posizione del parallelo nella sua serie
    const rk = refKeyOf(c);
    const items = [
      ...(rk ? [{ label: `🔍 Riferimenti di ${rk}`, run: () => openXref(rk) }] : []),
      ...(openFc ? [{ label: `↗ Apri ${EspIR.blockLabel(openFc)}`, run: () => setBlock(openFc.id) }] : []),
      ...(rk || openFc ? ["-"] : []),
      { label: "⤵ Ramo parallelo (OR) da qui", run: () => edit(() => {                 // aperto: si chiude dopo
          pos.series.items.splice(pos.index, 0, { type: "Open", branch: mkSeries([mkSlot()]) }); }) },   // «?» da scegliere, niente popup
    ];
    if (par) {
      const b0 = par.branches[0];
      const next = parPos.series.items[parPos.index + 1], prev = parPos.series.items[parPos.index - 1];
      items.push(
        { label: "＋ Aggiungi ramo a questo parallelo", run: () => edit(() => { par.branches.push(mkSeries([mkSlot()])); }) },
        "-",
        { label: "⇤ Apri il ramo un elemento prima", disabled: prev ? null : "non c'è niente prima del ramo",
          run: () => edit(() => { parPos.series.items.splice(parPos.index - 1, 1); b0.items.unshift(prev); }) },
        { label: "⇥ Apri il ramo un elemento dopo", disabled: b0.items.length > 1 ? null : "il ramo principale ha un solo elemento",
          run: () => edit(() => { const f = b0.items.shift(); parPos.series.items.splice(parPos.index, 0, f); }) },
        { label: "⇤ Chiudi il ramo un elemento prima", disabled: b0.items.length > 1 ? null : "il ramo principale ha un solo elemento",
          run: () => edit(() => { const l = b0.items.pop(); parPos.series.items.splice(parPos.index + 1, 0, l); }) },
        { label: "⇥ Chiudi il ramo un elemento dopo", disabled: next ? null : "non c'è niente dopo il ramo",
          run: () => edit(() => { parPos.series.items.splice(parPos.index + 1, 1); b0.items.push(next); }) },
      );
    }
    items.push("-", { label: "⧉ Copia", run: () => copyLine(c) });   // incolla: tasto destro sulle zone tratteggiate
    items.push("-", { label: c.type === "Timer" ? "✕ Elimina timer" : c.type === "Call" ? "✕ Elimina chiamata" : c.type === "Box" ? `✕ Elimina ${c.box}`
                            : c.type === "Compare" ? "✕ Elimina confronto" : c.type === "Trig" ? `✕ Elimina ${c.edge}_TRIG` : c.type === "Not" ? "✕ Elimina NOT" : c.type === "Slot" ? "✕ Elimina «?»" : "✕ Elimina contatto", danger: true, run: () => edit(() => {
      pos.series.items.splice(pos.index, 1); }) });
    showMenu(x, y, c, items);
  }

  const RET_TXT = { ret: "RET", eno: "ENO", enon: "ENO negato" };
  function openRetMenu(x, y, coil) {
    const cur = coil.ret || "ret";
    const set = v => { if (v === "ret") delete coil.ret; else coil.ret = v; markEditDirty(); render(); setStatusLine(`bobina → ${RET_TXT[v]}`); };
    showMenu(x, y, coil, [
      { label: (cur === "ret" ? "● " : "○ ") + "RET — con corrente esce dalla FC", run: () => set("ret") },
      { label: (cur === "eno" ? "● " : "○ ") + "ENO — l'ENO della chiamata = corrente", run: () => set("eno") },
      { label: (cur === "enon" ? "● " : "○ ") + "ENO negato — l'ENO della chiamata = corrente invertita", run: () => set("enon") },
    ]);
  }
  function openCoilMenu(x, y, coil) {
    const w = parentOf.get(coil);                     // { leaf, parent, rung, segIdx, rungIdx }
    const leaves = [];
    EspIR.eachLeaf(w.rung, l => leaves.push(l));
    const openFc = coil.kind === "CALL" ? project.blocks.find(b => b.type === "fc" && b.number === coil.fc) : null;
    const rk = refKeyOf(coil);
    showMenu(x, y, coil, [
      ...(rk ? [{ label: `🔍 Riferimenti di ${rk}`, run: () => openXref(rk) }] : []),
      ...(openFc ? [{ label: `↗ Apri ${EspIR.blockLabel(openFc)}`, run: () => setBlock(openFc.id) }] : []),
      ...(rk || openFc ? ["-"] : []),
      { label: "⤵ Aggiungi uscita parallela (prima di questa bobina)", run: () => {
          takeUndo();
          EspIR.splitAt(w.leaf, w.leaf.series.items.length, { series: mkSeries(), coil: { kind: "SLOT", unset: true } });   // «?», niente popup
          markEditDirty(); render(); } },
      "-",
      { label: "⧉ Copia", run: () => copyEnd(coil) },
      ...(clip && clip.coil ? [{ label: "📋 Incolla come uscita parallela", disabled: pasteWhy(true),
            run: () => paste(n => EspIR.splitAt(w.leaf, w.leaf.series.items.length, { series: mkSeries(), coil: n })) }] : []),
      "-",
      leaves.length > 1
        ? (() => {
            // timer, FC e box hanno ENO come la bobina: se l'uscita ne ha uno in fondo, resta lui come elemento finale
            const its = w.leaf.series.items || [], last = its[its.length - 1];
            const eff = last && (last.type === "Box" || last.type === "Timer" || last.type === "Call") && coil.kind !== "CALL" && coil.kind !== "BOX" && !isTimerObj(coil);
            return eff
              ? { label: `✕ Togli la bobina (resta ${last.type === "Box" ? last.box : last.type === "Call" ? "FC" + last.fc : last.kind} come fine dell'uscita)`, danger: true,
                  run: () => edit(() => { w.leaf.coil = EspIR.inlineToCoil(its.pop()); }) }
              : { label: "✕ Elimina questa uscita", danger: true,
                  run: () => edit(() => { const p = w.parent; p.outputs.splice(p.outputs.indexOf(w.leaf), 1); }) };
          })()
        : { label: "✕ Togli l'elemento finale (il network resta aperto)", danger: true,
            run: () => edit(() => {
              const r = w.rung;
              r.series.items.push(...(w.leaf.series.items || []));      // i contatti dell'uscita restano
              r.outputs = [];
            }) },
      "-",
      { label: `✕ Elimina Network ${w.segIdx + 1}`, danger: true, run: () => deleteNetwork(w.segIdx, true) },
    ]);
  }

  // ── Online: scrittura di un bit M dal tasto destro ───
  let forceNode = null, forceOp = null;
  const sameAsForce = op => !!(forceOp && op && op.ns === forceOp.ns && op.idx === forceOp.idx && op.bit === forceOp.bit);

  function writersOf(op) {
    const out = [];
    allSegments().forEach(({ sg, n, b }) => sg.rungs.forEach(r => EspIR.eachLeaf(r, o => {
      if (o.coil.op && o.coil.op.ns === op.ns && o.coil.op.idx === op.idx && o.coil.op.bit === op.bit)
        out.push({ where: `${EspIR.blockLabel(b)} network ${n + 1}`,
                   kind: o.coil.kind === "set" ? "SET" : o.coil.kind === "reset" ? "RESET" : "bobina" });
    })));
    return out;
  }

  function openForceMenu(x, y, node, op) {
    closeMenus(); hideTip();
    const m = document.getElementById("forcemenu");
    const key = varKey(op);
    if (!op || (op.ns !== "M" && !(op.ns === "DB" && memType(op) === "BOOL"))) {
      m.innerHTML = `<div class="fm-head"><b>${escapeHtml(isMemOp(op) ? memText(op) : key || "?")}</b></div>
        <div class="fm-note">Da Online si possono comandare i merker <b>M</b> e i BOOL dei DB.</div>`;
    } else {
      const cur = readBit(op);
      const w = writersOf(op);
      const coil = w.filter(x => x.kind === "bobina");
      let note;
      if (coil.length)
        note = `⚠ ${key} è scritto da una bobina normale (${coil.map(c => c.where).join(", ")}): ` +
               `alla scansione successiva il PLC lo riscrive, il comando dura un solo ciclo.`;
      else if (w.length)
        note = `${key} è comandato solo da ${w.map(c => c.kind + " (" + c.where + ")").join(", ")}: ` +
               `il valore scritto resta finché un SET/RESET non lo cambia.`;
      else
        note = `Nessuna bobina scrive ${key}: il valore scritto resta.`;
      m.innerHTML =
        `<div class="fm-head">Comanda <b class="fm-key">${key}</b>` +
        (EspSymbols.nameOf(op) ? ` <span class="fm-sym">"${escapeHtml(EspSymbols.nameOf(op))}"</span>` : "") +
        `<span class="fm-cur ${cur ? "on" : ""}">ora ${cur ? "1" : "0"}</span></div>` +
        `<div class="fm-item" data-v="1"><span class="fm-dot on"></span>SET TRUE &nbsp;→ <b>${key} = 1</b></div>` +
        `<div class="fm-item" data-v="0"><span class="fm-dot"></span>SET FALSE → <b>${key} = 0</b></div>` +
        `<div class="fm-note${coil.length ? " warn" : ""}">${note}</div>`;
      m.querySelectorAll(".fm-item").forEach(it =>
        it.addEventListener("click", ev => { ev.stopPropagation(); const v = +it.dataset.v; closeMenus(); if (op.ns === "DB") writeDbBit(op, !!v); else writeM(op.idx, v); }));
    }
    const rk = refKeyOf(node);
    if (rk) {
      const xr = document.createElement("div");
      xr.className = "fm-item fm-xref"; xr.textContent = `🔍 Riferimenti di ${rk}`;
      xr.addEventListener("click", ev => { ev.stopPropagation(); openXref(rk); });
      m.appendChild(xr);
    }
    forceNode = node; forceOp = op;
    render();
    m.classList.remove("hidden");
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth  - r.width  - 8) + "px";
    m.style.top  = Math.min(y, window.innerHeight - r.height - 8) + "px";
  }

  async function writeM(idx, value) {
    try {
      const r = await postJson("/api/plc/mem/m", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idx, value }) });
      if (r.status === 404 && !r.j.idx && r.j.msg !== "bad index")
        setStatusLine("il firmware non ha ancora POST /api/plc/mem/m (vedi start.md)", "err");
      else if (!r.ok) setStatusLine(`M${idx} ← ${value}: ` + (r.j.msg || r.status), "err");
      else setStatusLine(`M${idx} ← ${value} inviato`);
      pollStatus();
    } catch (e) { setStatusLine(`M${idx}: ` + e.message, "err"); }
  }

  // ── Stato modifiche ──────────────────────────────────
  function markStructChanged() { lastStructSig = String(performance.now()); }
  function markEditDirty() {
    EspIR.fbSync(project);                               // FB: un DB d'istanza per chiamata, campi = le STATIC
    dbLayCache = null;
    if (!EspIR.TEXT_LANGS.includes(program.language)) program.segments.forEach(seg => { seg.rungs = seg.rungs.map(EspIR.tidyRung); });
    editorDirty = true;
    pushHistory();
    if (devMods.length) renderDevTabs();                // «•» sulla scheda con modifiche
    lastBlob = null;
    document.getElementById("btn-download").disabled = false;   // il Download compila da solo
    markStructChanged();
    if (liveMonitoring) {                                // Online resta: esce solo il blocco modificato, fino al Download
      dropEditorBlk(); render();
      setStatusLine(`modificato — ${EspIR.blockLabel(program)} fuori da Online fino al Download, gli altri blocchi restano Online`, "warn");
    } else {
      setStatusLine("modificato — Download per scaricarlo (compila da solo)");
    }
  }
  function setOnline(v) {
    liveMonitoring = v;
    if (!v) closeMenus();
    document.getElementById("btn-online").classList.toggle("online-active", v);
    updateExecDots();
  }

  // ── Compile / Download / Upload ──────────────────────
  // Limiti dichiarati dal firmware (v2.5, /api/plc/memory); senza, valgono i default
  // limiti del PLC collegato; senza PLC quelli dell'ultimo PLC visto (P4: DB fino a 2 MB anche compilando da solo)
  const plcLimits = () => {
    if (!(liveMemory && liveMemory.vm_version)) { try { return JSON.parse(localStorage.getItem("espplc.limits") || "null"); } catch (e) { return null; } }
    const l = { vm: liveMemory.vm_version, instrMax: liveMemory.instr_max, callDepth: liveMemory.call_depth,
                vmStack: liveMemory.vm_stack, ops: liveMemory.ops, ioIn: liveMemory.io_in, ioOut: liveMemory.io_out,
                dbSize: liveMemory.db_size, dbMax: liveMemory.db_max, retainDbMax: liveMemory.retain_db_max };
    try { localStorage.setItem("espplc.limits", JSON.stringify(l)); } catch (e) {}
    return l;
  };
  // titolo della scheda del browser (Denys 02-11-2026): «MIA Editor <chip> <IP>» («MIA uLink …» per un modulo I/O), con più PLC aperti
  // si riconosce subito quale è quale. Una volta per collegamento, da /api/fw/info
  let titleAsked = false, titleRole = null;
  async function plcTitle(role) {
    titleAsked = true; titleRole = role;
    let inf;
    try { inf = await fetchJson("/api/fw/info", FETCH_TO); } catch (e) { titleAsked = false; return; }
    const usb = window.EspUsb && EspUsb.on && EspUsb.on();
    const chip = String(inf.chip || "esp32").toUpperCase().replace(/^ESP32(?=.)/, "");   // ESP32P4 → P4, ESP32 resta ESP32
    document.title = `MIA ${role === "io" ? "uLink" : "Editor"} ${chip} ${usb ? "USB" : location.hostname}`;   // modulo I/O: «MIA uLink»
  }
  async function compile() {
    ensureUid();
    await ioAutoHwdb(true);                              // la HWDB della scheda c'è sempre nel programma che va al PLC
    await ioRealign();                                   // ... ed è quella della scheda che c'è adesso
    EspIR.fbSync(project);                               // DB d'istanza delle FB anche per un progetto appena aperto
    const r = await compileIR(project, { limits: plcLimits() });
    if (r.errors && r.errors.length) {
      setStatusLine("errori: " + r.errors.join(" · "), "err");
      lastBlob = null;
      document.getElementById("btn-download").disabled = false;   // il Download compila da solo
      return null;
    }
    lastBlob = buildWireBlob(r.bytecode, r.source_gzip);
    lastCompiled = { src: r.source_gzip, texts: textsOf(project), r, blob: lastBlob, project: JSON.parse(projJson()) };
    // controllo dimensioni con i limiti letti dal PLC (/api/plc/memory): meglio
    // dirlo qui che ricevere dal firmware un "CRC errato"
    if (liveMemory) {
      const big = [], M = liveMemory, tier = M.tier_kb ? ` (taglia ${M.tier_kb} KB)` : "";
      if (M.bytecode_max_bytes && r.bytecode.length > M.bytecode_max_bytes)
        big.push(`bytecode ${r.bytecode.length} B > max ${M.bytecode_max_bytes} B${tier}`);
      if (M.partition_total_bytes && lastBlob.length > M.partition_total_bytes)
        big.push(`programma + sorgente ${lastBlob.length} B > spazio ${M.partition_total_bytes} B${tier}`);
      if (big.length) {
        setStatusLine("programma troppo grande per il PLC: " + big.join(", "), "err");
        lastBlob = null;
        document.getElementById("btn-download").disabled = false;   // il Download compila da solo
        return null;
      }
    }
    const M = liveMemory || {};
    const { ram, ir } = workOf(r), work = ram + ir;
    // il codice deve stare nella memoria di lavoro che il PLC ha in RUN (col WiFi 12 KB): se no errore qui, il programma
    // non arriva al PLC
    if (M.work_total_bytes && ram > M.work_total_bytes) {
      setStatusLine(`programma troppo grande per la memoria di lavoro del PLC: ${ram} B in RAM, il massimo è ${M.work_total_bytes} B`, "err");
      lastBlob = null;
      document.getElementById("btn-download").disabled = false;   // il Download compila da solo
      return null;
    }
    editorWork = { ram, ir };                            // barra «Lavoro»: il programma dell'editor (anche col PLC in STOP)
    renderWorkBar();
    const dl = `Download ${r.bytecode.length} B di blocchi + ${r.source_gzip.length} B di sorgente (flash) · max ${r.instrWorst} istruzioni/scan`;
    const size = ir ? `${work} B di codice: ${ram} B nella memoria di lavoro (RAM), ${ir} B di FC nella IRAM · ${dl}`
                    : `${work} B di codice nella memoria di lavoro (RAM) · ${dl}`;
    if (r.warnings.length) setStatusLine(`compilato con avvisi: ${r.warnings.join(", ")} — ${size}`, "warn");
    else setStatusLine("compilato: " + size);
    document.getElementById("btn-download").disabled = false;
    return r;
  }

  // Preparazione del Download (programma sul PLC, blocchi, conferma): le letture di stato aspettano. Il server di
  // rete risponde a una richiesta alla volta e il programma intero (/api/plc/program, con 50 KB oltre 200 KB di
  // testo) le teneva in coda oltre 3 s: OFFLINE per qualche secondo mentre compariva la conferma.
  let dlPrep = false;
  async function downloadToCpu() {
    if (devTab) { await sendPplc(devTab); return; }        // scheda di un modulo: al modulo passando dal PLC
    dlPrep = true;
    try { return await downloadToCpuRun(); } finally { dlPrep = false; }
  }
  // Download (Denys 25-10-2026, manuale/download-fasi-e-problemi-20261025.xlsx): prima tutti i controlli senza domande
  // (compila, spazio dei file, memoria), poi una sola scelta «Download» / «Download completo», poi l'invio con
  // l'avanzamento nella finestra del Download, alla fine «RUN». Nessun'altra finestra: un problema va nella riga di stato
  async function downloadToCpuRun() {
    // 1) compila: errori e incongruenze (blob già pronto: Restore, backup senza sorgente)
    if (!lastBlob && !(await compile())) return;
    // 2) controlli: programma sul PLC, blocchi cambiati, spazio dei file, memoria
    setStatusLine("controllo del programma sul PLC…");
    const id = await plcIdentity();
    let plcState = liveStatus && liveStatus.state;                // RUN o STOP di adesso, non dell'ultima lettura
    try { plcState = (await fetchJson("/api/plc/status", FETCH_TO)).state || plcState; } catch (e) {}
    const running = plcState === "running";
    // v4.7: gli editor collegati non viaggiano nel frame leggero: una lettura adesso
    if (liveApi) try { const c = await fetchJson(`/api/plc/live?sid=${SID}&c=1`, FETCH_TO); if (liveStatus) liveStatus.clients = c.clients || []; } catch (e) {}
    const others = otherClients();
    try { liveMemory = await fetchJson("/api/plc/memory"); modbusCaps(liveMemory); } catch (e) {}   // memoria di adesso (e "upload")
    const M = liveMemory || {};
    const comp = lastCompiled && lastCompiled.blob === lastBlob ? lastCompiled : null;
    const cr = comp && comp.r;
    // un altro progetto non si carica mai in RUN: STOP prima, il PLC resta in STOP dopo e si avvia con RUN
    const otherProject = !!(id && id.exists && id.uid && project.uid && id.uid !== project.uid);
    let patch = null;
    if (cr && id && id.exists && !otherProject) {
      try { await refreshPlcBlocks(true); patch = plcBlkRaw ? buildPatchBlob(cr, plcBlkRaw) : null; } catch (e) { patch = null; }
      if (patch && liveStatus && liveStatus.crc32 !== undefined &&
          (liveStatus.crc32 >>> 0) === new DataView(lastBlob.buffer, lastBlob.byteOffset).getUint32(16, true)) {
        editorDirty = false; plcJson = projJson(); clearDraft();
        setStatusLine("il PLC ha già questo programma: niente da caricare");
        return;
      }
    }
    try {   // il codice del Download passa da un file temporaneo del PLC
      const fi = await fetchJson("/api/fw/info", 3000);
      const free = (fi.fs_total || 0) - (fi.fs_used || 0), need = lastBlob.length + 16384;
      if (fi.fs_total && free < need) {
        setStatusLine(`spazio dei file del PLC finito: liberi ${Math.round(free / 1024)} KB, il Download ne vuole ${Math.round(need / 1024)} KB (riavvia il PLC: libera i file temporanei)`, "err");
        return;
      }
    } catch (e) {}
    // solo i blocchi cambiati in RUN: i nuovi stanno accanto al programma in funzione (RAM libera + IRAM libera)
    const what = patch ? patch.changed.map(c => c.label + (c.code ? "" : " (solo testi)"))
                          .concat(patch.removed.map(k => blkName(k) + " (tolta)"))
                          .concat(patch.projChanged ? ["nome del progetto"] : []) : [];
    let noPatch = "";
    if (!patch) noPatch = otherProject ? "sul PLC c'è un altro progetto" : !(id && id.exists) ? "sul PLC non c'è un programma" : "il programma sul PLC è diverso";
    else if (running && M.work_total_bytes) {
      const need = patch.changed.reduce((t, c) => t + (c.size || 0), 0);
      const room = M.work_total_bytes - (M.work_used_bytes || 0);
      if (need > room) noPatch = `i blocchi cambiati (${need} B) non stanno accanto al programma in funzione (liberi ${room} B)`;
      // Main e StartUp stanno solo nella RAM, in un pezzo solo
      else if (M.work_free_max_bytes && patch.changed.some(c => c.size > M.work_free_max_bytes && c.type !== 1))
        noPatch = `un blocco cambiato è più grande del pezzo di RAM libera più grande (${M.work_free_max_bytes} B)`;
    }
    if (noPatch) patch = null;
    // 3) la scelta: «Download» (solo i blocchi cambiati) o «Download completo»
    const suNote = patch && patch.changed.some(c => c.label === "StartUp" && c.code) ? " StartUp è cambiato: gira al prossimo STOP→RUN." : "";
    // Download completo (Denys 01-11-2026): sempre STOP, il programma di prima cancellato del tutto (memoria di lavoro, flash,
    // sorgente) come se non ci fosse, poi il nuovo: nessun bisogno di spazio per due programmi insieme
    const fullStop = !patch;
    // la valutazione sceglie: solo i blocchi cambiati quando si può, altrimenti tutto; un pulsante solo (Denys 31-10-2026)
    let body = otherProject ? `Sul PLC: «${U(id.name) || "senza nome"}» (ID ${id.uid}). Stai scaricando: «${U(project.name)}» (ID ${project.uid}).\n\n` : "";
    body += patch ? `Blocchi cambiati: ${what.join(", ") || "nessuno"}.` + (running ? " Il PLC resta in RUN, timer e merker restano." + suNote : "")
                  : `Programma completo: ${project.blocks.length} ${project.blocks.length === 1 ? "blocco" : "blocchi"} (${noPatch}). ` +
                    "Il PLC va in STOP (uscite spente), il programma di adesso viene cancellato (memoria, flash e sorgente) e si carica il nuovo; il PLC resta in STOP.";
    if (others.length) body += "\n\n" + (others.length === 1 ? "C'è un altro editor collegato: " : `Ci sono altri ${others.length} editor collegati: `) +
                               others.map(c => who(c) + (c.on ? " (Online)" : " (editor aperto)")).join(", ") + ".";
    if ((await confirmModal("Download", body, "Download", null)) === "cancel") { setStatusLine("download annullato"); return; }
    // 4) invio al PLC, ricezione, installazione, esito: solo l'avanzamento nella finestra del Download
    if (fullStop) {
      setStatusLine("STOP del PLC e cancellazione del programma per il Download completo…");
      try { const s = await postJson("/api/plc/stop"); if (!s.ok) throw new Error("STOP non riuscito"); }
      catch (e) { setStatusLine("download annullato: il PLC non è andato in STOP (" + e.message + ")", "err"); return; }
      if (id && id.exists) try {
        const r = await fetch("/api/plc/program", { method: "DELETE" });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).msg || "HTTP " + r.status);
      } catch (e) { setStatusLine("download annullato: programma di prima non cancellato (" + e.message + "), il PLC è in STOP", "err"); return; }
      try { showState(await fetchJson("/api/plc/status")); } catch (e) {}
    }
    setStatusLine(patch ? `download dei blocchi cambiati (${what.join(", ")})…` : "download completo…");
    dlActive = true;
    let dlOk = false, endState = null;
    DL.open(patch ? "Download dei blocchi cambiati" : "Download completo",
            patch ? (what.length ? "Blocchi da caricare:" : "Nessun blocco cambiato") : `Programma completo: ${project.blocks.length} ${project.blocks.length === 1 ? "blocco" : "blocchi"}`,
            patch ? what : project.blocks.map(b => EspIR.blockLabel(b)));
    try {
      // Come lo vuole il PLC (/api/plc/memory → upload):
      //  "form": file binario in un modulo multipart, il PLC lo riceve a pezzi (firmware uPLC, core 2.x):
      //          niente base64 in una String da ~87 KB (con 64 KB di programma il PLC si riavviava);
      //  altrimenti base64 come text/plain (arg("plain") tronca i corpi binari al primo 0x00).
      // In rete, se il PLC lo sa fare (/api/plc/memory → upload_parts): un pezzo alla volta, il successivo
      // solo dopo la risposta. Nella RAM del PLC c'è un pezzo solo, anche nella rete; il Download dura di più.
      const postParts = async (url, blob, P) => {
        const first = url.split("?")[1] || "", sid = (first.match(/(?:^|&)sid=[^&]*/) || [""])[0].replace(/^&/, "");
        for (let off = 0; off < blob.length; off += P) {
          const part = blob.subarray(off, Math.min(blob.length, off + P));
          const fd = new FormData();
          fd.append("prog", new Blob([part], { type: "application/octet-stream" }), "part.bin");
          const r = await postProgress(`/api/plc/program/part?${sid}&off=${off}`, fd, null, 10000);
          if (!r.ok) return r;
          DL.progress(off + part.length, blob.length);
        }
        DL.installing();
        return postProgress(url + (url.includes("?") ? "&" : "?") + "parts=1", "", "text/plain", DL_TIMEOUT);
      };
      // Installazione in un task del PLC (?async=1): risponde subito 202, l'esito si chiede finché c'è.
      // Il PLC intanto risponde a tutti (prima rete e USB restavano ferme per secondi con un programma grande).
      const waitInstall = async r => {
        const t0 = Date.now();
        while (r && r.status === 202 && Date.now() - t0 < DL_TIMEOUT) {
          await new Promise(res => setTimeout(res, 400));
          try { const x = await fetch("/api/plc/program/result"); r = { ok: x.ok, status: x.status, j: await x.json().catch(() => ({})) }; }
          catch (e) { r = { ok: false, status: 202, j: {} }; }   // collegamento perso un attimo: si riprova
          if (r.status === 202 && r.j && r.j.phase) DL.installStep(r.j.phase, r.j.pm);
        }
        if (r && r.status === 202) throw new Error("il PLC non dà l'esito del Download");
        return r;
      };
      const asyncUrl = url => url + (url.includes("?") ? "&" : "?") + "async=1";
      const post = async (url, blob) => waitInstall(await postSend(asyncUrl(url), blob));
      const postSend = (url, blob) => {
        DL.send(blob.length);
        if (M.upload === "form" && M.upload_parts && !(window.EspUsb && EspUsb.on())) return postParts(url, blob, M.upload_parts);
        const prog = (l, t) => DL.progress(l, t), sent = () => DL.installing();
        if (M.upload === "form") {
          const fd = new FormData();
          fd.append("prog", new Blob([blob], { type: "application/octet-stream" }), "prog.bin");
          return postProgress(url, fd, null, DL_TIMEOUT, prog, sent);
        }
        return postProgress(url, u8ToBase64(blob), "text/plain", DL_TIMEOUT, prog, sent);
      };
      let r, how;
      if (patch) {
        r = await post(`/api/plc/program/patch?sid=${SID}${identQuery()}`, patch.blob);
        how = `caricati solo i blocchi cambiati: ${what.join(", ")}` + (suNote ? " — StartUp girerà al prossimo STOP→RUN" : "");
      } else {
        r = await post(`/api/plc/program/test?sid=${SID}${identQuery()}${fullStop ? "&stop=1&stay=1" : ""}`, lastBlob);
        how = otherProject ? "download di un altro progetto" : "download completo";
      }
      if (!r.ok) {
        // niente domande a metà: resta il programma di prima, si dice perché e cosa fare
        // 409: per i blocchi cambiati il programma di base non è più quello; negli altri casi (scheda modulo I/O,
        // Download da un altro collegamento) il testo del PLC dice il motivo vero
        const why = r.status === 409 && (patch || !(r.j && r.j.msg)) ? "il programma sul PLC è cambiato nel frattempo (un altro editor?): serve il Download completo"
                  : r.status === 507 ? (patch ? "memoria del PLC insufficiente per i blocchi cambiati accanto al programma in funzione: serve il Download completo"
                                              : "memoria del PLC insufficiente con il programma in funzione: metti il PLC in STOP e rifai il Download completo")
                  : (FAULT_TEXT[r.j && r.j.msg] || (r.j && r.j.msg) || r.status);
        setStatusLine("download non riuscito, resta il programma di prima: " + why, "err");
        return;
      }
      // firmware di prima (programma in RAM finché non si salva): anche lì il Download va subito in flash.
      // Memoria non letta: si chiede lo stesso (il firmware nuovo risponde 200 senza fare niente).
      let saved = true;
      if (!M.direct_flash) {
        try { saved = (await postJson("/api/plc/program/persist")).ok; } catch (e) { saved = false; }
      }
      editorDirty = false;
      plcJson = projJson();
      onlineBcCrc = crc32(lastBlob.subarray(20, 20 + new DataView(lastBlob.buffer, lastBlob.byteOffset).getUint32(8, true))) >>> 0;
      if (comp) plcSrc = { crc: crc32(comp.src) >>> 0, texts: comp.texts };
      clearDraft();
      dlActive = false;
      pollMemory();                                   // barre della memoria subito aggiornate
      endState = r.j && r.j.state;
      const endMsg = `${how} — PLC ${endState === "running" ? "in RUN" : endState === "stopped" ? "in STOP" : endState || ""}, ` +
                     (saved ? "salvato in flash" : "⚠ NON salvato in flash: dopo un riavvio torna il programma di prima");
      setStatusLine(endMsg, endState === "running" && saved ? null : "warn");
      dlOk = saved; DL.finish(saved, endMsg);
      pollStatus();
    } catch (e) { setStatusLine("download: " + e.message, "err"); }
    finally { dlActive = false; DL.finish(dlOk, lastStatusMsg); }
    // 5) RUN: il PLC non va mai in RUN da solo
    if (endState === "stopped" && await confirmAction("RUN", `Il PLC ha il programma di «${U(project.name)}» ed è in STOP.`, "RUN")) await runPlc();
  }

  // Legge il programma dal PLC. kind: "source" | "bytecode" | "empty" | "error"
  async function loadProgramFromCpu() {
    try {
      let p;
      try { p = await fetchJson("/api/plc/program", 30000); }   // programma + sorgente: lento con un programma grande (8 s non bastavano)
      catch (e) { if (/404/.test(e.message)) return { ok: false, kind: "empty" }; throw e; }
      if (p.source_size > 0 && p.source_b64gz) {
        const srcBytes = b64decode(p.source_b64gz);
        const pj = await srcToProject(srcBytes);
        if (!pj) return { ok: false, kind: "error", msg: "sorgente sul PLC illeggibile" };
        await bracePaint();
        setProject(pj, true);
        plcSrc = { crc: crc32(srcBytes) >>> 0, texts: textsOf(project) };
        setRecovered(false);
        return { ok: true, kind: "source" };
      }
      if (p.bytecode_size > 0) {
        const r = decompileBytecode(hexToBytes(p.bytecode_hex));
        if (!r.editable) return { ok: false, kind: "error", msg: "decompilazione fallita: " + r.error };
        await bracePaint();
        setProject(r.program, true);
        setRecovered(true);
        plcSrc = { crc: 0, texts: null };
        return { ok: true, kind: "bytecode" };
      }
      return { ok: false, kind: "empty" };
    } catch (e) { return { ok: false, kind: "error", msg: e.message }; }
  }
  function setRecovered(v) { document.getElementById("badge-recovered").classList.toggle("hidden", !v); }
  function afterLoad() {
    netBlocks = [];
    lastBlob = null; editorDirty = false;
    document.getElementById("btn-download").disabled = false;   // il Download compila da solo
    resetHistory(); renderProjName();
    markStructChanged(); render();
    baseJson = projJson();                               // dopo render(), che sistema il progetto (cartella Sys_DB)
  }

  async function uploadFromCpu() {
    if (devTab) {                                          // modulo: di nuovo dalla copia nel PLC
      if (editorDirty && !(await confirmAction("Sovrascrivere l'editor?", `Le modifiche al programma pPlc di ${devTab} non mandate al modulo si perdono.`, "Sì, sovrascrivi"))) return;
      return loadDev(devTab, true);
    }
    if (!(await (editorDirty
        ? confirmAction("Sovrascrivere l'editor?", "Hai modifiche non scaricate sul PLC: caricando dal PLC le perdi.", "Sì, sovrascrivi")
        : confirmAction("Caricare dal PLC?", "Il progetto aperto nell'editor viene sostituito da quello del PLC.", "Sì, carica")))) return;
    setStatusLine("lettura dal PLC…");
    const r = await loadProgramFromCpu();
    if (!r.ok) {
      setStatusLine(r.kind === "empty" ? "nessun programma sul PLC" : "upload fallito: " + (r.msg || "?"),
                    r.kind === "empty" ? "muted" : "err");
      return;
    }
    afterLoad();
    plcJson = projJson();
    clearDraft();
    setStatusLine(r.kind === "source" ? `programma caricato dal PLC: «${U(project.name) || "senza nome"}»` : "ricostruito dal bytecode (nessun sorgente)");
  }

  // Identità del programma sul PLC: ID e nome del progetto dal sorgente
  // → { exists, uid, name } | null se non si riesce a leggere
  // ID e nome del progetto mandati con il Download: il PLC li tiene per /api/plc/ident
  const identQuery = () => project.uid ? `&pid=${encodeURIComponent(project.uid)}&pname=${encodeURIComponent(project.name || "")}` : "";
  // ID e nome del progetto sul PLC. Prima la richiesta leggera (/api/plc/ident: quello che l'editor ha detto al
  // PLC nell'ultimo Download, se il programma è ancora quello); altrimenti tutto il programma come prima.
  async function plcIdentity() {
    try {
      const q = await fetchJson("/api/plc/ident", 3000);
      if (q.exists === false) return { exists: false };
      if (q.known) return { exists: true, uid: q.uid || null, name: q.name || "" };
    } catch (e) {}
    try {
      const p = await fetchJson("/api/plc/program", 30000);
      let uid = null, name = "";
      if (p.source_size > 0 && p.source_b64gz) {
        const srcBytes = b64decode(p.source_b64gz);
        const j = await srcToProject(srcBytes);
        if (j) { try { uid = j.uid || null; name = j.name || "";
                       plcSrc = { crc: crc32(srcBytes) >>> 0, texts: textsOf(EspIR.migrate(j)) }; } catch (e) {} }
      }
      return { exists: true, uid, name };
    } catch (e) { return /404/.test(e.message) ? { exists: false } : null; }
  }
  function mismatchText(id) {
    if (!id) return "il programma sul PLC è diverso da quello dell'editor";
    if (!id.exists) return "sul PLC non c'è nessun programma: Download prima di andare Online";
    const plcN = id.name ? `«${U(id.name)}»` : "senza nome";
    if (id.uid && project.uid && id.uid === project.uid)
      return `sul PLC c'è un'altra versione di questo progetto (${plcN}): Download per mandare questa, oppure Upload from cpu per aprire quella`;
    if (id.uid && project.uid)
      return `sul PLC c'è un ALTRO progetto: ${plcN} (ID ${id.uid.slice(0, 8)}…) — nell'editor «${U(project.name)}» (ID ${project.uid.slice(0, 8)}…)`;
    return "il programma sul PLC è diverso da quello dell'editor (progetto senza ID)";
  }
  let onlineBcCrc = null;               // CRC del bytecode visto andando Online
  async function toggleOnline() {
    if (devTab) { setStatusLine(`${devTab}: Online solo collegati al modulo`, "warn"); return; }
    if (liveMonitoring) { setOnline(false); setStatusLine("Online: OFF"); markStructChanged(); render(); return; }
    const s = liveStatus;
    let note = "";
    if (s && s.bc_crc32 !== undefined) {
      // Firmware con bc_crc32: Online solo se il bytecode è lo stesso del PLC
      const r = await compileIR(project);
      if (r.errors && r.errors.length) { setStatusLine("il programma dell'editor non compila: Online non possibile", "warn"); return; }
      const mine = crc32(r.bytecode) >>> 0;
      if (mine !== (s.bc_crc32 >>> 0)) {
        // v3: Online per blocco — basta che il blocco aperto sia uguale a quello sul PLC
        await refreshPlcBlocks(true);
        const id = await plcIdentity();
        const same = id && id.exists && (!id.uid || !project.uid || id.uid === project.uid) && blockSame(program) === true;
        if (!same) { setStatusLine(mismatchText(id), "warn"); return; }
        const d = blocksDiff() || [];
        note = ` — solo i blocchi uguali al PLC (diversi: ${d.map(x => x.split(":")[0]).join(", ")})`;
        onlineBcCrc = null;
      } else {
        onlineBcCrc = mine;
        if (editorDirty) note = " (nome/titoli/commenti non ancora scaricati)";
      }
    } else if (!s || s.state === "no_program") {
      setStatusLine("sul PLC non c'è nessun programma: Download prima di andare Online", "warn"); return;
    } else if (editorDirty) {
      setStatusLine("editor ≠ PLC — Compile + Download (o Upload from cpu) prima di andare Online", "warn");
      return;
    }
    setOnline(true);
    setStatusLine("Online: ON" + note);
    markStructChanged(); render();
  }

  // SF: clic sul badge → le cause, con l'azione per ognuna
  let lastSf = [];
  function openSfMenu() {
    const b = document.getElementById("badge-sf").getBoundingClientRect();
    const items = [{ label: "Errore di sistema (SF) — il PLC resta in RUN", info: true }];
    lastSf.forEach(x => items.push({ label: "● " + x.text, info: true }));
    items.push("-");
    if (lastSf.some(x => x.code === 10)) items.push({ label: "⚠ Errori del programma in corso (dove e quale istruzione)", run: () => openDiag("card-err") });
    if (lastSf.some(x => x.code === 9 || x.code === 2)) items.push({ label: "⚙ Impostazioni del PLC (rete, GPIO)", run: () => openDiag("card-plc") });
    items.push({ label: "↗ Apri la diagnostica", run: () => openDiag("") });
    showMenu(b.left, b.bottom + 4, null, items);
  }
  async function runPlc() {
    if (devTab) { setStatusLine(`${devTab}: RUN e STOP del pPlc li decide il modulo (manca il PLC / PLC tornato)`, "warn"); return; }
    try {
      const r = await postJson("/api/plc/run");
      if (!r.ok) throw new Error(r.j.msg || r.status);
      setStatusLine(r.j.state === "running" ? "PLC in RUN" : "nessun programma da eseguire", r.j.state === "running" ? null : "warn");
      pollStatus();
      // se l'errore c'è ancora, il PLC riparte e torna in STOP per errore alla prima scansione
      if (r.j.state === "running") setTimeout(async () => {
        try { const s = await fetchJson("/api/plc/status", 3000);
              if (s.state === "fault") setStatusLine(`RUN: il PLC è ripartito ma è tornato in STOP per errore — ${FAULT_TEXT[s.fault] || s.fault}`, "err"); } catch (e) {}
      }, 500);
    } catch (e) { setStatusLine("run: " + e.message, "err"); }
  }
  async function stopPlc() {
    if (devTab) { setStatusLine(`${devTab}: RUN e STOP del pPlc li decide il modulo (manca il PLC / PLC tornato)`, "warn"); return; }
    if (!(await confirmAction("Fermare il PLC?", "Lo scan si ferma e le uscite vanno in stato sicuro (spente).", "Sì, ferma"))) return;
    try {
      const r = await postJson("/api/plc/stop");
      if (!r.ok) throw new Error(r.j.msg || r.status);
      setStatusLine("PLC in STOP");
      pollStatus();
    } catch (e) { setStatusLine("stop: " + e.message, "err"); }
  }

  async function deleteProgram(asked) {
    const choice = asked || await confirmModal("Cancellare il programma dal PLC?",
      "Il programma viene cancellato dalla RAM e dalla flash. Vuoi prima salvarne una copia su file?",
      "Salva e cancella", "Cancella senza salvare");
    if (choice === "cancel") return false;
    if (choice === "ok" && !(await doBackup())) {
      if (!(await confirmAction("Backup non riuscito",
          "Non è stato possibile leggere il programma dal PLC. Cancellare comunque?", "Cancella"))) return false;
    }
    try {
      const r = await fetch("/api/plc/program", { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setStatusLine("cancellazione fallita: " + (j.msg || r.status), "err"); return false; }
      setProject(emptyProgram());
      setRecovered(false);
      setOnline(false);
      afterLoad();
      plcJson = null;
      plcSrc = { crc: null, texts: null };
      setStatusLine("programma cancellato dal PLC");
      pollStatus();
      return true;
    } catch (e) { setStatusLine("cancellazione: " + e.message, "err"); return false; }
  }

  // Comandi dalla Diagnostica: Backup, Restore, Cancella programma. Li fa l'editor: ha il progetto,
  // i simboli e le conferme. → { ok, msg }
  // Programma dell'ultimo Compile (blocchi compilati, progetto, CRC): la Diagnostica, se il CRC è quello del PLC,
  // trova «FCn network m · istruzione» da qui invece di scaricare il programma dal PLC e ricompilarlo
  window.ESPPLC_EDITOR_PROG = () => lastCompiled && lastCompiled.blob && lastCompiled.r && lastCompiled.r.blocks
    ? { crc: new DataView(lastCompiled.blob.buffer, lastCompiled.blob.byteOffset).getUint32(16, true) >>> 0, r: lastCompiled.r, project: lastCompiled.project }
    : null;
  window.ESPPLC_DIAG_CMD = async d => {
    let ok = false;
    try {
      if (d.cmd === "backup") ok = await doBackup();
      else if (d.cmd === "delete") ok = await deleteProgram(d.save ? "ok" : "alt");
      else if (d.cmd === "restore" && d.file) {
        if (window.EspDiag) EspDiag.close();
        if (/\.(miaplc\.bkp|miaulink\.bkp|bkesplc)$/i.test(d.file.name) && window.EspFw) { await EspFw.openFile(d.file); setStatusLine("backup del PLC: controlla e premi «Avvia»"); }   // immagine del PLC
        else await openFile(d.file);
        ok = true;
      }
    } catch (x) { setStatusLine(x.message, "err"); }
    return { ok, msg: lastStatusMsg };
  };

  // ── Backup / Restore ──
  // Backup = immagine del PLC in un file .bkesplc (firmware.js): firmware, editor, impostazioni, simboli,
  // programma e valori dei DB. Si ricarica con «Aggiorna firmware» (stesso PLC) o con il Recupero (scheda nuova).
  async function doBackup() {
    if (!window.EspFw || !EspFw.backup) { setStatusLine("backup non disponibile in questo editor", "err"); return false; }
    try {
      const r = await EspFw.backup(t => setStatusLine("backup del PLC: " + t + "…"));
      setStatusLine(`backup del PLC salvato: ${r.name} (${Math.round(r.bytes / 1024)} KB)`);
      return true;
    } catch (e) { setStatusLine("backup non riuscito: " + e.message, "err"); return false; }
  }

  async function restoreBin(file) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.length < 20) throw new Error("file troppo corto");
      const dv = new DataView(buf.buffer);
      if (dv.getUint32(0, true) !== 0x31434C50) throw new Error("magic non valido");
      if (dv.getUint16(4, true) !== 3) throw new Error(`versione ${dv.getUint16(4, true)} non supportata (serve il formato 3 a blocchi)`);
      const bcLen = dv.getUint32(8, true), srcLen = dv.getUint32(12, true);
      if (20 + bcLen + srcLen !== buf.length) throw new Error("lunghezze incoerenti");
      if (srcLen === 0) {
        const r = decompileBytecode(buf.subarray(20, 20 + bcLen));
        if (!r.editable) throw new Error("nessun sorgente e decompilazione fallita: " + r.error);
        await bracePaint();
        setProject(r.program); setRecovered(true);
      } else {
        const pj = await srcToProject(buf.subarray(20 + bcLen));
        if (!pj) throw new Error("sorgente illeggibile");
        await bracePaint();
        setProject(pj); setRecovered(false);
      }
      afterLoad();
      editorDirty = projJson() !== plcJson;
      saveDraftSoon();
      // Il file è già un blob valido: si può scaricare subito.
      lastBlob = buf;
      document.getElementById("btn-download").disabled = false;
      setStatusLine(`restore OK: ${bcLen} B bytecode, ${srcLen} B sorgente — Download per inviarlo al PLC`);
    } catch (e) { setStatusLine("restore fallito: " + e.message, "err"); }
  }

  // ── Polling ─────────────────────────────────────────
  // Una sola richiesta di stato alla volta: il WebServer dell'ESP32 serve un
  // client per volta, con un PLC lento le richieste si accumulerebbero.
  let pollBusy = false, memBusy = false;
  // Download in corso: si parla col PLC solo per il Download (niente stato, valori, memoria)
  let dlActive = false;
  // Risorse: ogni 500 ms di base; 1 s se il PLC risponde lento (> 250 ms, media), 1,5 s se molto
  // lento (> 600 ms). Il firmware v4.2 tiene il server web sulla CPU0 e il PLC da solo sulla CPU1:
  // il carico del PLC non rallenta più l'editor, conta il tempo di risposta (rete, server occupato;
  // col firmware di prima cresce anche col carico del PLC). Priorità: stato e bit sempre, valori
  // numerici a giro alterno quando si rallenta, memoria ogni 5 s (10 s quando si rallenta).
  let pollEvery = POLL_MS, pollRtt = 0, valTick = 0, clockChecked = false;
  // PLC senza data e ora (niente DS3231, niente rete): gliela dà il PC al collegamento, così il log ha la data
  async function syncClock() {
    try {
      const c = await fetchJson("/api/plc/clock", 3000);
      if (c && c.valid === false)
        await fetch("/api/plc/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unix: Math.floor(Date.now() / 1000) }) });
    } catch (e) {}                                  // firmware di prima: niente orologio
  }
  // v4.7: un giro comincia quando il precedente è finito. Online: ogni POLL_LIVE (rete 250 ms, USB 150 ms),
  // più lento solo se il PLC risponde lento (al massimo 1 s); senza Online ogni POLL_IDLE (rete 1 s, USB 500 ms).
  // Così un cambio si vede in media entro 1 s e al massimo in 3 s (FETCH_TO).
  function pollPace() {
    if (!liveMonitoring) { pollEvery = POLL_IDLE; return; }
    pollEvery = pollRtt > 600 ? 1000 : pollRtt > 250 ? 500 : POLL_LIVE;
  }
  // v4.7: una richiesta piccola per giro (/api/plc/live): stato, bit di aggiornamento e, Online, i soli
  // operandi a vista. Firmware di prima (senza /live): /status + /values come prima.
  let liveApi = true, seenGen = null, seenProg = undefined, seenOkAt = 0, seenScans = null;
  async function pollStatus() {
    if (pollBusy || dlActive || dlPrep || diagOpen()) return;
    pollBusy = true;
    try { await (liveApi ? pollLiveOnce() : pollStatusOnce()); } finally { pollBusy = false; }
  }
  function pollFailed() {
    if (++pollFailures >= OFFLINE_AFTER && Date.now() - lastPollOk >= OFFLINE_MS) {
      document.getElementById("offline-banner").classList.remove("hidden");
      const b = document.getElementById("badge-state");
      b.textContent = "OFFLINE"; b.className = "badge state-fault";
    }
  }
  function hexInto(dst, at, hex) {
    for (let i = 0; i + 1 < hex.length && at + (i >> 1) < dst.length; i += 2) dst[at + (i >> 1)] = parseInt(hex.substr(i, 2), 16);
  }
  async function pollLiveOnce() {
    const t0 = Date.now();
    let url = `/api/plc/live?sid=${SID}`, s;
    if (liveMonitoring) {
      const o = liveOperands();
      url += `&on=1&b=${o.b}&t=${o.timers.join(",")}` + (o.fx >= 0 ? `&x=${o.fx}` : "");
    }
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), FETCH_TO);
      let r;
      try { r = await fetch(url, { signal: ctl.signal }); } finally { clearTimeout(to); }
      if (r.status === 404) { liveApi = false; return pollStatusOnce(); }   // firmware di prima
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      s = await r.json();
    } catch (e) { pollFailed(); return; }
    pollFailures = 0; lastPollOk = Date.now();
    if (!clockChecked) { clockChecked = true; syncClock(); }
    if (!titleAsked || titleRole !== (s.role || "plc")) plcTitle(s.role || "plc");
    { const rtt = lastPollOk - t0; pollRtt = pollRtt ? Math.round(pollRtt * 0.7 + rtt * 0.3) : rtt; }
    if (EspSymbols.syncState().state === "offline") EspSymbols.init();   // PLC tornato: rileggi i simboli
    document.getElementById("offline-banner").classList.add("hidden");
    if (s.clients === undefined && liveStatus && liveStatus.clients) s.clients = liveStatus.clients;   // dall'ultima lettura completa
    liveStatus = s;
    if (!devTabsAsked) { devTabsAsked = true; refreshDevTabs(); }   // schede dei moduli: una volta, appena collegati
    showState(s);
    hwCheck(s);
    if (liveMonitoring) {
      if (s.b) for (const k in s.b) { const ns = k[0] === "O" ? "Q" : k.replace(/\d+$/, ""), at = +k.slice(ns.length); if (liveBits[ns]) hexInto(liveBits[ns], at, s.b[k]); }
      liveBits.SM[0] = s.sm | 0;
      liveNum = new Map();
      await liveDbInto(liveNum);
      liveTimers = new Map((s.timers || []).map(t => [t.i, t]));
      if (typeof s.fx === "string") {
        const set = new Set();
        for (let i = 0; i + 1 < s.fx.length; i += 2) { const v = parseInt(s.fx.substr(i, 2), 16); if (v) for (let k = 0; k < 8; k++) if (v & (1 << k)) set.add((i >> 1) * 8 + k); }
        liveFcExec = set;
      } else liveFcExec = null;
      if (typeof s.fe === "string") {
        const set = new Set();
        for (let i = 0; i + 1 < s.fe.length; i += 2) { const v = parseInt(s.fe.substr(i, 2), 16); if (v) for (let k = 0; k < 8; k++) if (v & (1 << k)) set.add((i >> 1) * 8 + k); }
        liveFcEno = set;
      } else liveFcEno = null;
    }
    // programma cambiato (Download da qui o da un altro editor): memoria e blocchi si rileggono solo ora
    const prog = s.crc32 === undefined ? null : s.crc32 >>> 0;
    // PLC riavviato (scansioni ripartite) o tornato raggiungibile: limiti della memoria riletti (WiFi → lavoro ridotto)
    const now = Date.now(), back = seenOkAt && now - seenOkAt > 4000, restarted = seenScans != null && s.scan_count != null && s.scan_count < seenScans;
    if ((seenProg !== undefined && prog !== seenProg) || back || restarted) pollMemory();
    seenProg = prog; seenOkAt = now; seenScans = s.scan_count != null ? s.scan_count : seenScans;
    seenGen = s.g || null;
    afterPoll(s);
    const sig = (liveMonitoring ? "L:" + s.state + "|" + JSON.stringify(s.b || null) + "|" + JSON.stringify([...liveNum]) + "|" +
                 JSON.stringify(s.timers || []) + "|" + (s.fx || "") + "|" + (s.fe || "") + "|" + (s.sm | 0) : "S") + "|" + lastStructSig;
    if (sig !== lastLiveSig) { lastLiveSig = sig; renderLive(); }
    onlineLine(s);
  }
  // stato, errore e SF in alto (stesso per /live e /status)
  // Modulo I/O remoto (ruolo nelle impostazioni): il programma non gira, l'editor non lascia scriverlo né scaricarlo
  function showRole(io) {
    const was = document.body.classList.contains("role-io");
    document.body.classList.toggle("role-io", io);
    let b = document.getElementById("role-io-banner");
    if (io && !b) {
      b = document.createElement("div"); b.id = "role-io-banner";
      b.innerHTML = `<h2>modulo I/O: il programma non gira qui</h2>` +
        `<p>Ingressi e uscite di questa scheda li comanda il PLC sul bus.</p>` +
        `<div><button type="button" class="primary" data-card="card-iomod">Modulo I/O</button> <button type="button" data-card="">Diagnostica</button></div>`;
      b.querySelectorAll("button").forEach(x => { x.onclick = () => openDiag(x.dataset.card || undefined); });
      document.querySelector("main").before(b);
    }
    if (b) b.classList.toggle("hidden", !io);
    if (io && !was && window.EspDiag && !EspDiag.isOpen()) openDiag("card-iomod");   // appena si scopre il modulo: la sua configurazione
  }
  function showState(s) {
    if (!s || typeof s.state !== "string") return;          // risposta a metà (PLC che si riavvia, USB occupata): resta lo stato di prima
    const badge = document.getElementById("badge-state");
    const ioOnly = s.role === "io" && !(PPLC_ON && s.pplc);   // modulo I/O col picoPlc: l'editor carica il suo programma
    showPplcBtn();
    showRole(ioOnly);
    badge.textContent = ioOnly ? "MODULO I/O" : (PPLC_ON && s.pplc ? "pPlc " : "") + (STATE_TXT[s.state] || s.state.toUpperCase());
    badge.className = "badge state-" + (ioOnly ? "io" : s.state);
    document.getElementById("btn-run").classList.toggle("is-run", s.state === "running");
    document.getElementById("btn-stop").classList.toggle("is-stop", s.state === "stopped" || s.state === "no_program");
    document.getElementById("btn-stop").classList.toggle("is-fault", s.state === "fault");
    const fb = document.getElementById("badge-fault");
    const ft = (s.fault && s.fault !== "PLC_OK") ? (FAULT_TEXT[s.fault] || s.fault) : "";
    fb.textContent = ft; fb.title = s.fault || ""; fb.classList.toggle("hidden", !ft);
    {   // SF: errori di sistema attivi (rete del PLC assente, dispositivo del bus mancante…): il PLC resta in RUN
      const sf = Array.isArray(s.sf) ? s.sf : [], sb = document.getElementById("badge-sf");
      lastSf = sf;
      sb.classList.toggle("hidden", !sf.length);
      sb.textContent = sf.length > 1 ? `● SF ${sf.length}` : "● SF";
      sb.title = "Errore di sistema (come il LED rosso SF):\n" + sf.map(x => "• " + x.text).join("\n") + "\n\nClic: cause e azioni";
    }
  }
  function afterPoll(s) {
    const byOther = s.last_dl && s.last_dl.sid !== SID ? s.last_dl : null;
    if (liveMonitoring && onlineBcCrc !== null && s.bc_crc32 !== undefined && (s.bc_crc32 >>> 0) !== onlineBcCrc) {
      // v3: si resta Online; i blocchi diversi dal PLC diventano Offline (≠ nell'albero)
      onlineBcCrc = null;
      setStatusLine(byOther ? `${who(byOther)} ha cambiato il programma sul PLC: Online solo sui blocchi ancora uguali`
                            : "il programma sul PLC è cambiato: Online solo sui blocchi ancora uguali", "warn");
    }
    watchRemote(s, byOther);
    refreshPlcBlocks();
    pollPace();
    updateSync();
    updateExecDots();
  }
  function onlineLine(s) {
    if (!liveMonitoring) return;
    setStatusLine(`Online · ${s.state} · scansioni ${s.scan_count}${liveMemory && liveMemory.scan_interval_ms ? ` (una ogni ${liveMemory.scan_interval_ms} ms)` : ""} · esecuzione ${s.scan_avg_us} µs (max ultimi 6 s ${s.scan_max_us})` +
                  (pollEvery > POLL_LIVE ? ` · aggiornamento ogni ${pollEvery / 1000} s (il PLC risponde in ${pollRtt} ms)` : ""),
                  s.state === "running" ? null : "warn", true);
  }
  // Firmware senza /live: lo stato completo (tutte le aree) e i valori a parte
  async function pollStatusOnce() {
    let s;
    const t0 = Date.now();
    try { s = await fetchJson(`/api/plc/status?sid=${SID}&on=${liveMonitoring ? 1 : 0}&t=${liveMonitoring ? liveOperands().timers.join(",") : ""}`); }
    catch (e) { pollFailed(); return; }
    pollFailures = 0; lastPollOk = Date.now();
    if (!clockChecked) { clockChecked = true; syncClock(); }
    if (!titleAsked || titleRole !== (s.role || "plc")) plcTitle(s.role || "plc");
    { const rtt = lastPollOk - t0; pollRtt = pollRtt ? Math.round(pollRtt * 0.7 + rtt * 0.3) : rtt; }
    if (EspSymbols.syncState().state === "offline") EspSymbols.init();
    document.getElementById("offline-banner").classList.add("hidden");
    liveStatus = s;
    if (!devTabsAsked) { devTabsAsked = true; refreshDevTabs(); }   // schede dei moduli: una volta, appena collegati
    showState(s);
    // Aree complete (firmware B1.6+); fallback sulle maschere 8 bit.
    if (s.i_bits_b64) liveBits.I = b64decode(s.i_bits_b64); else liveBits.I[0] = s.inputs_mask | 0;
    if (s.q_bits_b64) liveBits.Q = b64decode(s.q_bits_b64); else liveBits.Q[0] = s.outputs_mask | 0;
    if (s.m_bits_b64) liveBits.M = b64decode(s.m_bits_b64);
    if (s.t_bits_b64) liveBits.T = b64decode(s.t_bits_b64);
    liveBits.SM[0] = s.sm | 0;                                  // v4.6: bit di sistema
    liveTimers = new Map((s.timers || []).map(t => [t.i, t]));
    liveFcExec = fcExecSet(s);
    afterPoll(s);
    if (liveMonitoring) {
      liveNum = new Map();
      await liveDbInto(liveNum);
    }
    const sig = (liveMonitoring ? "L:" + s.state + "|" + (s.i_bits_b64 || s.inputs_mask) + "|" +
                 (s.q_bits_b64 || s.outputs_mask) + "|" + (s.m_bits_b64 || "") + "|" + (s.t_bits_b64 || "") + "|" +
                 JSON.stringify(s.timers || []) + "|" + (s.fc_exec_b64 || JSON.stringify(s.fc_exec || null)) + "|" + JSON.stringify([...liveNum]) : "S") + "|" + lastStructSig;
    if (sig !== lastLiveSig) { lastLiveSig = sig; renderLive(); }
    onlineLine(s);
  }

  async function pollMemory(tries = 0) {
    if (memBusy || dlActive || dlPrep || diagOpen()) return;
    // una richiesta per volta al PLC: se lo stato è in lettura si riprova poco dopo (prima si saltava
    // e le barre della memoria restavano vecchie per molti secondi)
    if (pollBusy) { if (tries < 10) setTimeout(() => pollMemory(tries + 1), 300); return; }
    memBusy = true;
    try { await pollMemoryOnce(); } finally { memBusy = false; }
  }
  // debug: sotto le barre della memoria RAM e IRAM libere adesso e minime dall'avvio
  function memDebug() {
    const el = document.getElementById("mem-dbg"), d = liveMemory && liveMemory.dbg, on = dbgOn();
    el.classList.toggle("hidden", !on);
    if (!on) return;
    el.textContent = !d || d.heap === undefined ? "debug: il firmware non dà RAM e IRAM"
      : `RAM libera ${kbd(d.heap)} KB (minima ${kbd(d.heap_min)} KB) · blocco più grande ${kbd(d.block)} KB · IRAM libera ${kbd(d.iram)} KB (minima ${kbd(d.iram_min)} KB)`;
  }
  window.addEventListener("espplc-debug", () => { memDebug(); if (dbgOn()) pollMemory(); });
  setInterval(() => { if (dbgOn() && !dlActive) pollMemory(); }, 5000);   // debug: valori ogni 5 s
  // memoria del PLC ogni 3 s (Denys 24-10-2026), solo con le barre a vista, la pagina in primo piano e il PLC collegato
  setInterval(() => {
    const bar = document.getElementById("bar-work-row");
    if (dlActive || document.hidden || !liveStatus || !bar || !bar.offsetParent || dbgOn()) return;
    pollMemory();
  }, 3000);
  // Barra «Lavoro»: quanto pesa il programma dell'editor (ultimo Compile o Download), sulla memoria di lavoro del PLC.
  // Barra «Lavoro»: il programma dell'editor, dall'ultima compilazione (anche quella automatica in sottofondo). Prima
  // della prima compilazione quello che il PLC ha in RAM adesso (in STOP con «Libera RAM» il codice è fuori: 0)
  let editorWork = null;
  // memoria di lavoro (RAM): solo il codice di Main, StartUp e FC; DB, tabelle e sorgente restano in flash
  // (ir: codice nella IRAM, sempre 0 da quando «VM + IRAM» è tolta, 01-11-2026)
  function workOf(r) {
    return { ram: r.blocks.filter(b => b.type <= 2).reduce((t, b) => t + b.size, 0), ir: 0 };
  }
  function renderWorkBar() {
    const M = liveMemory;
    if (!M || !(M.work_total_bytes > 0)) return;
    const ram = editorWork ? editorWork.ram : (M.work_used_bytes || 0);
    setBar("bar-storage", "lbl-storage", ram, M.work_total_bytes, "B");
    document.getElementById("bar-work-row").title = (editorWork ? "Programma dell'editor (ultimo Compile o Download). " : "Programma in RAM sul PLC adesso. ") +
      `Memoria di lavoro (RAM): il codice dei blocchi. ` +
      `Sul PLC libero in un pezzo solo: ${M.work_free_max_bytes} B (i buchi lasciati dai blocchi cambiati si chiudono da soli)`;
  }
  // Modbus solo se la libreria è nel firmware del PLC (MiaConfig la mette con un modulo Modbus TCP): «modbus»: false
  // nella memoria → niente pagina Modbus. Firmware che non lo dice: la pagina resta
  function modbusCaps(M) {
    const b = document.getElementById("mod-modbus");
    if (b && M) b.classList.toggle("hidden", M.modbus === false);
    if (M && M.modbus && typeof M.modbus === "object") {                // parti del progetto MiaConfig (firmware 0.3.45)
      const c = { master: !!M.modbus.master, slave: !!M.modbus.slave, port: M.modbus.port || 502, id: M.modbus.id || 1 };
      const was = JSON.stringify(mbCaps); mbCaps = c;
      if (was !== JSON.stringify(c) && modPage && modKind === "modbus") renderModPage();
    }
  }
  async function pollMemoryOnce() {
    let M;
    try { M = await fetchJson("/api/plc/memory"); } catch (e) { return; }
    // risposta senza i numeri (PLC che si riavvia, modulo I/O, errore del collegamento): restano quelli di prima, mai «undefined»
    if (!M || (M.work_total_bytes === undefined && M.bytecode_max_bytes === undefined)) return;
    liveMemory = M;
    modbusCaps(M);
    if (M.work_total_bytes) {
      renderWorkBar();
      setBar("bar-source", "lbl-source", 20 + (M.bytecode_used_bytes || 0) + (M.source_used_bytes || 0), M.partition_total_bytes, "B");
      memDebug();
    } else {
      setBar("bar-storage", "lbl-storage", M.bytecode_used_bytes || 0, M.bytecode_max_bytes, "B");
      setBar("bar-source",  "lbl-source",  M.source_used_bytes   || 0, M.source_max_bytes,   "B");
    }
  }
  // v4.6: tabella dei simboli compressa (quello che occupa sul PLC) / spazio riservato
  if (window.EspSymbols && EspSymbols.onSize) EspSymbols.onSize((b, max) => {
    setBar("bar-sym", "lbl-sym", b, max, "B");
    document.getElementById("bar-sym-row").title = `Tabella dei simboli: ${EspSymbols.count()} simboli, ${(b / 1024).toFixed(1)} KB compressi ` +
      `su ${max / 1024} KB riservati sul PLC (nomi e commenti; non entra nel programma)`;
  });
  function setBar(barId, lblId, used, max, unit) {
    const p = max > 0 ? Math.min(100, 100 * used / max) : 0;
    const b = document.getElementById(barId);
    b.style.width = p.toFixed(1) + "%";
    b.className = "bar-fill " + (p < 70 ? "" : p < 90 ? "warn" : "bad");
    document.getElementById(lblId).textContent = `${used} / ${max} ${unit}`;
  }

  // ── Popup trascinabili ──────────────────────────────
  // Si trascinano tenendo premuto il titolo. La posizione resta quella
  // scelta finché non si ricarica la pagina (doppio clic sul titolo = centro).
  function makeDraggable(modal) {
    const box = modal.querySelector(".modal-box");
    const handle = box && box.querySelector("h3");
    if (!handle) return;                                 // finestre senza titolo da trascinare (Diagnostica)
    let dx = 0, dy = 0, drag = null;
    const apply = () => { box.style.transform = `translate(${dx}px, ${dy}px)`; };
    handle.title = "Trascina per spostare · doppio clic per ricentrare";
    handle.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, dx, dy };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener("pointermove", e => {
      if (!drag) return;
      const r = box.getBoundingClientRect();
      // limiti: il popup resta sempre intero dentro la finestra
      const baseL = r.left - dx, baseT = r.top - dy;   // posizione senza spostamento
      let nx = drag.dx + e.clientX - drag.x, ny = drag.dy + e.clientY - drag.y;
      nx = Math.max(-baseL, Math.min(window.innerWidth  - baseL - r.width,  nx));
      ny = Math.max(-baseT, Math.min(window.innerHeight - baseT - r.height, ny));
      dx = nx; dy = ny; apply();
    });
    const end = () => { drag = null; };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("dblclick", () => { dx = dy = 0; apply(); });
  }

  // ── Boot ────────────────────────────────────────────
  async function boot() {
    setupPalette();
    document.querySelectorAll(".modal").forEach(makeDraggable);
    const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);

    on("picker-cancel", "click", () => closePicker(true));
    on("picker-ok", "click", commitPicker);
    on("idx", "input", onAddrInput);
    on("sym-name", "input", onSymInput);
    on("sym-name", "keydown", e => { if (e.key === "Enter") commitPicker(); if (e.key === "Escape") closePicker(true); });
    on("pt", "input", updatePickerOk);
    on("pt", "keydown", e => { if (e.key === "Enter") commitPicker(); if (e.key === "Escape") closePicker(true); });
    on("idx", "keydown", e => { if (e.key === "Enter") commitPicker(); if (e.key === "Escape") closePicker(true); });
    document.querySelectorAll('input[name="ns"]').forEach(r =>
      r.addEventListener("change", () => { updateRangeHint(); if (isMemNs(r.value)) fillMemRow(null); memRowVis(); onAddrInput(); }));
    on("pk-db", "change", onMemRowChange);
    on("pk-f", "change", onMemRowChange);
    on("pk-bit", "input", onMemRowChange);
    on("pk-bit", "keydown", e => { if (e.key === "Enter") commitPicker(); if (e.key === "Escape") closePicker(true); });
    document.querySelectorAll('input[name="ctype"], input[name="emem"]').forEach(r => r.addEventListener("change", updateEdgeRow));
    // v3.1: popup numerico
    on("np-cancel", "click", () => closeNumPicker(true));
    on("np-ok", "click", commitNumPicker);
    on("np-op", "change", updateNumPicker);
    ["np-a", "np-b", "np-c", "np-d", "np-e", "np-out", "np-mem-idx", "np-r", "np-ld", "np-cd"].forEach(id => {
      on(id, "input", updateNumPicker);
      on(id, "keydown", e => { if (e.key === "Enter") commitNumPicker(); if (e.key === "Escape") closeNumPicker(true); });
    });
    document.querySelectorAll('input[name="np-mem"], input[name="np-trunc"]').forEach(r => r.addEventListener("change", updateNumPicker));

    document.addEventListener("click", e => {
      if (!e.target.closest("#ctxmenu") && !e.target.closest("#forcemenu")) closeMenus();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

    on("btn-add-net",  "click", addNetwork);
    on("btn-add-fc",   "click", () => addFunction(null));
    on("btn-add-db",   "click", () => addDb());
    on("btn-add-struct", "click", async () => { const st = await newStructAsk(); if (st) openStructPage(st.id); });
    on("mod-data",     "click", () => openModPage("data"));
    on("mod-hmi",      "click", () => openModPage("hmi"));
    on("mod-io",       "click", () => openModPage("io"));
    on("mod-modbus",   "click", () => openModPage("modbus"));
    on("mod-pplc",     "click", openPplc);
    on("mod-cat",      "click", () => ioLoadCatalog(false));
    on("mod-dl-hmi",   "click", () => modDownload("hmi"));
    on("mod-back",     "click", closeModPage);
    on("mod-add",      "click", modAddRow);
    on("mod-edit",     "click", modEdit);
    on("mod-onoff",    "click", modOnOff);
    on("mod-per",      "change", () => {                 // tempo di aggiornamento del pannello: 250 ms – 1 s
      const el = document.getElementById("mod-per"), v = Math.round(+el.value / 50) * 50;
      if (!(v >= 250 && v <= 1000)) { el.value = (hmiMod(false) || {}).period || 500; setStatusLine("aggiornamento: da 250 a 1000 ms", "warn"); return; }
      const m = hmiMod(true); el.value = v;
      if (v === 500) delete m.period; else m.period = v;
      markEditDirty();
      setStatusLine(`Dati HMI: aggiornamento ogni ${v} ms — Download per mandarlo al PLC`);
    });
    on("mod-ok",       "click", modConfirm);
    on("mod-cancel",   "click", modCancel);
    on("mod-dl-tx",    "click", () => modDownload("tx"));
    on("mod-dl-rx",    "click", () => modDownload("rx"));
    document.querySelectorAll("#mod-page .mod-tab").forEach(b => b.addEventListener("click", () => { modTab = b.dataset.tab; renderModPage(); }));
    initTreeLasso();
    on("db-back",      "click", closeDbPage);
    on("db-add",       "click", dbAddField);
    on("db-add2",      "click", dbAddField);                 // lo stesso sotto la tabella: il campo nuovo compare lì
    // niente menu del browser col tasto destro (come nel pannello HMI): restano i menu dell'editor; nei campi di testo sì (copia, incolla)
    document.addEventListener("contextmenu", e => { if (!e.target.closest("input, textarea, [contenteditable]")) e.preventDefault(); });
    on("db-zero",      "click", dbZeroInit);
    on("db-get",       "click", dbLoadActualToInit);
    on("db-put",       "click", dbLoadInitToActual);
    on("db-name",      "change", dbSetName);
    on("db-num",       "change", dbSetNumber);
    on("db-retain",    "change", e => { const d = dbOf(dbPage); if (!d) return; d.retain = e.target.checked; markEditDirty(); renderBlocks(); });
    on("cd-fc",        "change", callRows);
    on("cd-ok",        "click", commitCallDialog);
    on("cd-cancel",    "click", closeCallDialog);
    on("btn-add-su",   "click", addStartup);
    on("btn-xref",     "click", () => openXref(""));
    on("btn-syms",     "click", () => symPageOpen ? closeSymPage() : openSymPage());
    on("btn-syms-export", "click", exportSymbols);
    on("file-syms",    "change", e => { const f = e.target.files[0]; if (f) importSymbols(f); e.target.value = ""; });
    on("sym-back",     "click", closeSymPage);
    on("sym-add",      "click", addSymRow);
    on("sym-clear",    "click", async () => {
      if (!EspSymbols.count()) return;
      if (await confirmAction("Svuotare la tabella dei simboli?",
          `Si eliminano tutti i ${EspSymbols.count()} simboli (consiglio: prima ⭱ Esporta).`, "Svuota")) EspSymbols.clear(); });
    on("sym-filter",   "input", () => renderSymPage());
    on("sym-area",     "change", () => renderSymPage());
    on("sym-view",     "change", () => renderSymPage());
    on("sym-type",     "change", () => renderSymPage());
    const lm = document.getElementById("lbl-mode");
    lm.value = EspSymbols.rawMode();
    lm.addEventListener("change", () => EspSymbols.setMode(lm.value));
    EspSymbols.onSync(showSymSync);
    document.getElementById("badge-sym").addEventListener("click", () => {
      const st = EspSymbols.syncState().state;
      if (st === "error" || st === "offline") EspSymbols.retry();
    });
    let symRedraw = false;                         // più simboli cambiati di fila = un solo ridisegno
    EspSymbols.onChange(() => {
      if (symRedraw) return;
      symRedraw = true;
      queueMicrotask(() => {
        symRedraw = false;
        if (!EspSymbols.floatTip()) hideTip();
        applyGeometry();
        if (symPageOpen && !symEditing) renderSymPage();
        if (!document.getElementById("xref-modal").classList.contains("hidden")) renderXref();
        if (!symPageOpen) render();
      });
    });
    on("xref-q",       "input", renderXref);
    on("xref-q",       "keydown", e => { if (e.key === "Escape") closeXref(); });
    on("xref-close",   "click", closeXref);
    on("call-fc",      "change", updatePickerOk);
    on("btn-compile",  "click", compile);
    on("btn-download", "click", downloadToCpu);
    on("btn-upload",   "click", uploadFromCpu);
    on("btn-online",   "click", toggleOnline);
    on("btn-run",      "click", runPlc);
    on("badge-sf",     "click", e => { e.stopPropagation(); openSfMenu(); });
    on("btn-stop",     "click", stopPlc);
    on("file-open",    "change", e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ""; });
    on("btn-diag",     "click", e => { e.preventDefault(); openDiag(""); });
    on("btn-ram",      "click", e => { e.preventDefault(); window.EspDiag && EspDiag.ram(); });
    if (/[?&]diag\b/.test(location.search)) setTimeout(() => openDiag(location.hash.slice(1)), 0);   // vecchio indirizzo diag.html
    on("btn-new",      "click", newProject);
    on("btn-save",     "click", saveProjectFile);
    on("btn-undo",     "click", undo);
    on("btn-redo",     "click", redo);
    on("proj-name",    "click", renameProject);
    document.querySelector("#remote-note button").onclick = () => document.getElementById("remote-note").classList.add("hidden");
    document.addEventListener("keydown", e => { if (e.key === "Escape" && sel) { sel = null; render(); } });
    document.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector(".modal:not(.hidden)")) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === "s") { e.preventDefault(); saveProjectFile(); }
      else if (k === "c" && sel) { e.preventDefault(); copySel(); }
      else if (k === "v" && clip && lastZone && !zonePasteWhy(lastZone)) { e.preventDefault(); zonePaste(lastZone); }
      else if (k === "v" && clip && lastZone) { e.preventDefault(); setStatusLine(zonePasteWhy(lastZone), "warn"); }
    });

    let resizeRaf = 0;                                   // un ridisegno per fotogramma, non uno per evento
    window.addEventListener("resize", () => { if (!resizeRaf) resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; render(); }); });
    EspView.onChange(() => { applyGeometry(); render(); });
    window.addEventListener("beforeunload", e => { if (userDirty() && !window.ESPPLC_RELOAD) { e.preventDefault(); e.returnValue = ""; } });   // ricarica dopo l'aggiornamento: la bozza resta

    setStatusLine("connessione…");
    const r = await loadProgramFromCpu();
    if (r.ok) { afterLoad(); plcJson = projJson(); } else { resetHistory(); renderProjName(); }
    await EspSymbols.init();
    renderBlocks();
    render();
    pollMemory(); pollStatus();
    // stato: ogni pollEvery in Online (rete 500 ms … 1,5 s secondo la risposta del PLC), la metà delle
    // volte altrimenti; via USB sempre ogni 150 ms (300–600 ms se risponde lento); memoria ogni 5 s (10 s quando si rallenta)
    // v4.7: un giro alla volta (il successivo dopo la risposta); la memoria NON si legge a tempo:
    // solo all'avvio, dopo un Download e quando il programma sul PLC cambia (CRC in /live)
    const statusLoop = async () => {
      try { pollPace(); await pollStatus(); }
      catch (e) { if (DEBUG) console.warn("[EspPlc] stato:", e); }        // un errore non ferma le letture
      finally { setTimeout(statusLoop, pollEvery); }
    };
    setTimeout(statusLoop, pollEvery);
    setStatusLine(`editor ${EDITOR_VERSION} · ` + (r.ok ? `programma letto dal PLC: «${U(project.name) || "senza nome"}»` : "ready"));
    await offerDraft();
    await ioAutoHwdb();
    // USB collegata dopo l'avvio (porta scelta a mano): si legge il programma come all'avvio,
    // se l'editor non ha niente di suo
    let usbLoaded = r.ok;
    window.addEventListener("espplc-usb", async e => {
      if (e.detail.state !== "on") return;
      const n = window.EspUsb.note();
      if (n) setStatusLine("USB: " + n, "warn");
      if (usbLoaded || editorDirty) return;
      usbLoaded = true;
      const r2 = await loadProgramFromCpu();
      if (!r2.ok) return;
      afterLoad(); plcJson = projJson(); clearDraft();
      await EspSymbols.init(); renderBlocks(); render();
      setStatusLine(`USB: programma letto dal PLC: «${U(project.name) || "senza nome"}»`);
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
