// ============================================================
//  EspPlc — ir.js
//  Formato del programma dell'editor (IR v2) e conversione dal v1.
//
//  PROGETTO (v3)
//  project = { format: "espplc-ir", version: 3,
//              uid: "a1b2c3d4e5f60718",            // identità del progetto: nasce con "Nuovo progetto"
//              name: "Nastro linea 2",             // e non cambia più (serve a riconoscerlo sul PLC)
//              blocks: [ Block, ... ] }            // blocks[0] = Main, poi le funzioni
//  Block   = { id: "main"|"startup"|"fc<n>", type: "main"|"startup"|"fc", number: 0|0|n, name,
//              (StartUp, facoltativo, uno solo: gira una volta a ogni passaggio
//               in RUN prima del primo ciclo del Main; può chiamare le FC, non si chiama)
//              segments: [ { id, order, language: "LD", title?, comment?, rungs: [Rung] } ] }   // segment = network
//  (i file v1/v2 senza blocchi diventano il Main)
//  folders = [ { id: "f1", name: "Nastri", parent: null | "f2" } ]   // cartelle dell'albero dei blocchi (solo editor)
//  place   = { "fc3": "f1", "db2": "f1", … }                            // blocco o DB → cartella (assente = sotto «Programma»)
//
//  Rung    = { series: Series, outputs: [Output, ...] }
//            `series` è la parte comune a sinistra. Con una sola uscita tutti
//            i contatti stanno qui. Con più uscite, dal punto di diramazione
//            parte un ramo per ogni uscita (diramazione a T).
//  Output  = { series: Series, coil: { kind: "coil"|"set"|"reset", op: {ns, idx} } }   // foglia
//          | { series: Series, outputs: [Output, ...] }    // l'uscita si dirama ancora (annidata)
//  Series  = { type: "Series", items: [Item, ...] }          // AND in serie; vuota = filo
//  Item    = Contact | Parallel | Timer | Call
//  Call    = { type: "Call", fc: n }                   // chiamata funzione FCn: EN = corrente, ENO = EN
//  (a fine rung, al posto della bobina: coil = { kind: "CALL", fc: n })
//  Contact = { type: "Contact", negated: bool, op: {ns, idx} }
//            ns: I, Q, M (0..1023), T, SM (bit di sistema 0..5), oppure MB/MW/MI/MD/MDI con op.bit (MW3.5)
//  Not     = { type: "Not" }                           // v4.6: inverte la corrente
//  Box     = { type: "Box", box, a, b?, c?, d?, e?, out }   // ingressi secondo il box (LIMIT: a=MN b=IN c=MX;
//            SCALE: a=IN b=IN_MIN c=IN_MAX d=OUT_MIN e=OUT_MAX)
//  bobina: kind "coil" | "ncoil" (negata) | "set" | "reset" | "RET" (senza op: fine condizionata;
//          ret: "eno" = ENO della chiamata uguale alla corrente, "enon" = ENO negato)
//  Parallel= { type: "Parallel", branches: [Series, Series, ...] }   // OR, si richiude
//  Open    = { type: "Open", branch: Series }           // ramo parallelo aperto (solo nell'editor): parte da qui
//            e scende sotto gli elementi dopo; chiuso diventa un Parallel, con una bobina in fondo un'uscita. Compile lo rifiuta
//
//  v4.8 — DB e interfaccia delle FC:
//  dbs     = [ { number, name, retain: bool, fields: [ { name, type, init, comment } ] } ]   // DB globali (8 KB in tutto)
//  Block.iface (solo FC) = { in: [Var], out: [Var], inout: [Var], temp: [Var] },  Var = { name, type, def?, comment? }
//            type: BOOL | BYTE | WORD | INT | DINT | UDINT | REAL.  IN non collegato alla chiamata = def (o 0).
//  operandi: { ns: "DB", db: n, f: "campo" } (campo di un DB), { ns: "L", v: "nome" } (variabile dell'interfaccia)
//  Call    = { type: "Call", fc: n, args?: { nome: operando | { k: costante } } }
//  modules = [ { number: 1, type: "data", tx: [Dato], rx: [Dato], stamp?: ISO della conferma, editing?: true, prev?: {tx, rx} } ]
//            v4.8 esposizione dati, Dato = { name, op, comment? }. In modifica (editing) il Compile si rifiuta.
//            off: true = accesso disattivato (tabella nel programma, il PLC risponde 403), anche per i Dati HMI
//            { number: 2, type: "hmi", rows: [Riga], period?: ms 250..1000 (500), stamp?, editing?, prev?: {rows} }  Dati HMI,
//            Riga = { name, op, w?: scrivibile (solo M e DB), unit?, min?, max?, dec? }; l'indice è la posizione
//  texts   = { en: { id: testo } }  testi dell'utente nelle altre lingue (foglio «user» delle lingue); in italiano
//            valgono quelli scritti nel progetto. id: net:<blocco>:<network>:t|c, fc:<n>, sym:<chiave>, db:<n>:<campo>,
//            if:<fc>:<variabile>, exp:<tx|rx>:<nome>, hmi:<indice>:n|u
//  I campi che iniziano con "_" sono solo dell'editor e non vengono salvati.
// ============================================================
(function () {
  "use strict";

  const series   = (items) => ({ type: "Series", items: items || [] });
  const contact  = (ns, idx, negated) => ({ type: "Contact", negated: !!negated, op: { ns, idx } });
  const parallel = (branches) => ({ type: "Parallel", branches });
  const coil     = (kind, ns, idx) => ({ kind, op: { ns, idx } });
  const rung     = (s, outputs) => ({ series: s || series(), outputs: outputs || [] });

  const emptySegments = () => [{ id: 1, order: 0, language: "LD", rungs: [] }];
  const mainBlock = segs => ({ id: "main", type: "main", number: 0, name: "Main", segments: segs || emptySegments() });
  const startupBlock = segs => ({ id: "startup", type: "startup", number: 0, name: "StartUp", segments: segs || emptySegments() });
  const fcBlock = (n, name, segs, iface) => Object.assign({ id: "fc" + n, type: "fc", number: n, name: name || ("FC" + n), segments: segs || emptySegments() },
                                                        iface ? { iface } : {});
  // ── v4.8: tipi, interfaccia delle FC, DB ──
  // v5.2 (P01, Denys 03-11-2026): SINT, USINT, UINT, TIME. Nella VM USINT = BYTE, UINT = WORD, TIME = DINT (ms); SINT ha il suo codice
  const TYPES = ["BOOL", "SINT", "USINT", "BYTE", "INT", "UINT", "WORD", "DINT", "UDINT", "TIME", "REAL"];
  const TYPE_W = { BOOL: 0, SINT: 1, USINT: 1, BYTE: 1, WORD: 2, UINT: 2, INT: 2, DINT: 4, UDINT: 4, TIME: 4, REAL: 4 };
  const TYPE_T = { INT: 1, WORD: 2, UINT: 2, DINT: 3, TIME: 3, UDINT: 4, REAL: 5, BYTE: 6, USINT: 6, SINT: 7 };   // codice del tipo nel bytecode (BOOL: bit)
  const BASE_T = { USINT: "BYTE", UINT: "WORD", TIME: "DINT" };
  const baseType = t => BASE_T[t] || t;                 // tipo della VM: per i controlli fra tipi (USINT e BYTE vanno insieme)
  // Strutture (v5.2): project.structs = [{ id: "S1", name?, fields }]; il tipo di una variabile è l'id (il nome si mostra).
  // TIMER: struttura fissa del timer con lo stato in una variabile (OP_TMR, 16 byte come PLC_TMRV_* del firmware); _campi nascosti
  const STRUCT_RE = /^S\d{1,4}$/;
  const TIMER_FIELDS = [{ name: "PT", type: "TIME", comment: "tempo impostato" }, { name: "ET", type: "TIME", comment: "tempo trascorso" },
    { name: "_start", type: "UDINT" }, { name: "IN", type: "BOOL", comment: "ingresso" }, { name: "_run", type: "BOOL" },
    { name: "Q", type: "BOOL", comment: "uscita" }, { name: "_kind", type: "BYTE" }];
  const isStruct = t => t === "TIMER" || STRUCT_RE.test(t || "");
  let STRUCTS = new Map();                              // id → struttura del progetto in uso (useStructs, layoutDbs)
  function useStructs(project) { STRUCTS = new Map(((project && project.structs) || []).map(s => [s.id, s])); }
  const structFields = t => t === "TIMER" ? TIMER_FIELDS : ((STRUCTS.get(t) || {}).fields || null);
  // local: struttura fatta sul momento per una sola variabile di un DB (Denys 04-11-2026), non nella palette
  const structLabel = t => t === "TIMER" ? "TIMER" : (s => s && s.name ? s.name : s && s.local ? "Struttura" : t)(STRUCTS.get(t));
  // variabile di una lista, anche un campo di una struttura ("mot.vel", "t_pompa.Q") → la sua definizione, o null
  function memberOf(list, path) {
    const parts = String(path || "").split(".");
    let v = (list || []).find(x => x.name === parts[0]);
    for (let i = 1; v && i < parts.length; i++) { const fs = isStruct(v.type) ? structFields(v.type) : null; v = fs && fs.find(x => x.name === parts[i]); }
    return v || null;
  }
  // STATIC (Denys 02-11-2026): con almeno una variabile STATIC la FC è una FB. Nel blocco sono come IN_OUT; a ogni
  // chiamata il compilatore le collega da solo ai campi del suo DB d'istanza (fbSync): la VM non cambia
  const DIRS = ["in", "out", "inout", "static", "temp"];
  const TEXT_LANGS = ["ST", "C"];                     // v5.1: FC scritte in testo (block.language, block.text) invece dei network
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/;
  const DB_SIZE = 8192, LS_SIZE = 4096, FRAME_MAX = 1024;     // come il firmware: DB, stack L, dati locali di una FC
  const typeRange = { BYTE: [0, 255], WORD: [0, 65535], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], UDINT: [0, 4294967295],
                      SINT: [-128, 127], USINT: [0, 255], UINT: [0, 65535], TIME: [-2147483648, 2147483647] };
  function cleanVal(type, v) {
    if (type === "BOOL") return v === true || v === 1 || v === "1" || v === "TRUE" || v === "true";
    const x = Number(v);
    if (!isFinite(x)) return 0;
    if (type === "REAL") return Math.fround(x);
    const r = typeRange[type];
    if (!r) return 0;                                   // struttura: niente valore
    return Math.min(r[1], Math.max(r[0], Math.trunc(x)));
  }
  // variabili con nome valido, tipo noto, senza doppioni (nel gruppo `seen`)
  // inStruct: campi di una struttura (dentro, solo i tipi semplici e TIMER)
  function cleanVars(list, seen, withDef, inStruct) {
    const out = [];
    for (const v of Array.isArray(list) ? list : []) {
      if (!v || typeof v.name !== "string" || !NAME_RE.test(v.name) || seen.has(v.name.toLowerCase())) continue;
      if (!TYPES.includes(v.type) && !(isStruct(v.type) && !(inStruct && v.type !== "TIMER"))) continue;
      seen.add(v.name.toLowerCase());
      const o = { name: v.name, type: v.type }, st = isStruct(v.type);
      if (!st && withDef && v[withDef] !== undefined && v[withDef] !== null && v[withDef] !== "") o[withDef] = cleanVal(v.type, v[withDef]);
      if (typeof v.comment === "string" && v.comment.trim()) o.comment = v.comment.trim().slice(0, 120);
      // v5.1: array [lo..hi] (indici liberi), non di BOOL né di strutture
      if (!st && v.type !== "BOOL" && Number.isInteger(v.lo) && Number.isInteger(v.hi) && v.hi >= v.lo && v.hi - v.lo < 4096) { o.lo = v.lo; o.hi = v.hi; }
      out.push(o);
    }
    return out;
  }
  function cleanIface(f) {
    if (!f || typeof f !== "object") return null;
    const seen = new Set(), o = {};
    for (const d of DIRS) { const l = cleanVars(f[d], seen, d === "in" || d === "static" ? "def" : null); if (l.length) o[d] = l; }
    return Object.keys(o).length ? o : null;
  }
  function cleanStructs(list) {
    const out = [], ids = new Set(), names = new Set();
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || !STRUCT_RE.test(s.id) || ids.has(s.id)) continue;
      ids.add(s.id);
      const nm = typeof s.name === "string" ? s.name.trim() : "", name = NAME_RE.test(nm) && !names.has(nm.toLowerCase()) && nm !== "TIMER" ? nm : "";
      if (name) names.add(name.toLowerCase());
      out.push(Object.assign({ id: s.id }, name ? { name } : {}, s.local ? { local: true } : {}, { fields: cleanVars(s.fields, new Set(), "init", true) }));
    }
    return out;
  }
  function cleanDbs(list) {
    const out = [], nums = new Set();
    for (const d of Array.isArray(list) ? list : []) {
      if (!d || !Number.isInteger(d.number) || d.number < 1 || d.number > 65535 || nums.has(d.number)) continue;
      nums.add(d.number);
      const name = typeof d.name === "string" ? d.name.trim().slice(0, 40) : "";
      out.push(Object.assign({ number: d.number, name: name || ("DB" + d.number), retain: !!d.retain, fields: cleanVars(d.fields, new Set(), "init") },
                             d.hw ? { hw: true } : {}, d.sys ? { sys: true } : {}, Number.isInteger(d.inst) ? { inst: d.inst } : {}));   // HWDB: generata dalle tabelle I/O; sys: SDB «Sistema»; inst: DB d'istanza di una FB
    }
    return out.sort((a, b) => a.number - b.number);
  }
  // v4.8: moduli. Esposizione dati: nome nel JSON (lettere, cifre, _ . -), operando, commento
  const DATA_NAME_RE = /^[A-Za-z0-9_.\-]{1,32}$/;
  function cleanModules(list) {
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (m && m.type === "hmi" && !out.some(x => x.number === 2)) { out.push(cleanHmi(m)); continue; }
      if (m && m.type === "io" && !out.some(x => x.number === 3)) { out.push(cleanIo(m)); continue; }
      if (m && m.type === "pplc" && !out.some(x => x.number === 4)) {   // picoPlc del modulo I/O: parametri del passaggio
        const ms = (v, lo, hi, d) => Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : d;
        out.push({ number: 4, type: "pplc", lost: ms(m.lost, 100, 60000, 1000), keep: m.keep !== false, back: ms(m.back, 0, 60000, 1000) });
        continue;
      }
      if (m && m.type === "modbus" && !out.some(x => x.number === 5)) {   // Modbus: reti, richieste, mappe (controlli nel compilatore)
        const arr = l => (Array.isArray(l) ? l : []).filter(r => r && typeof r === "object").slice(0, 64).map(r => Object.assign({}, r));
        const o = { number: 5, type: "modbus", nets: arr(m.nets), reqs: arr(m.reqs), maps: arr(m.maps) };
        // dispositivi con i loro registri e parti del progetto MiaConfig (4.9.12): restano nel file
        if (Array.isArray(m.devs)) o.devs = arr(m.devs).map(d => Object.assign(d, { regs: arr(d.regs) }));
        if (m.caps && typeof m.caps === "object") o.caps = { master: !!m.caps.master, slave: !!m.caps.slave, port: +m.caps.port || 502, id: +m.caps.id || 1 };
        if (m.off) o.off = true;
        if (typeof m.stamp === "string" && !isNaN(Date.parse(m.stamp))) o.stamp = m.stamp;
        if (m.editing) o.editing = true;
        out.push(o);
        continue;
      }
      if (!m || m.type !== "data" || out.some(x => x.number === 1)) continue;
      const rows = l => (Array.isArray(l) ? l : []).filter(r => r && typeof r.name === "string" && r.op && typeof r.op === "object")
        .slice(0, 256).map(r => Object.assign({ name: r.name.slice(0, 32), op: r.op }, typeof r.comment === "string" && r.comment.trim() ? { comment: r.comment.trim().slice(0, 120) } : {}));
      const o = { number: 1, type: "data", tx: rows(m.tx), rx: rows(m.rx) };
      if (m.off) o.off = true;
      if (typeof m.stamp === "string" && !isNaN(Date.parse(m.stamp))) o.stamp = m.stamp;
      if (m.editing) { o.editing = true; if (m.prev && typeof m.prev === "object") o.prev = { tx: rows(m.prev.tx), rx: rows(m.prev.rx) }; }
      out.push(o);
    }
    return out;
  }
  // Testi dell'utente nelle altre lingue: { en: { "net:main:1:t": "…", … }, … } (id: vedi userTexts in app.js)
  function cleanTexts(t) {
    if (!t || typeof t !== "object") return null;
    const out = {};
    for (const [l, m] of Object.entries(t)) {
      if (!/^[a-z]{2}$/.test(l) || l === "it" || !m || typeof m !== "object") continue;
      const o = {};
      for (const [k, v] of Object.entries(m)) if (typeof k === "string" && k.length <= 80 && typeof v === "string" && v.trim()) o[k] = v.slice(0, 500);
      if (Object.keys(o).length) out[l] = o;
    }
    return Object.keys(out).length ? out : null;
  }
  // Dati HMI (modulo 2): tabella unica, Riga = { name, op, w?: scrivibile, unit?, min?, max?, dec? }
  // v5: tabelle I/O (modulo 3): bit e real, ingressi e uscite; ogni riga = un campo della HWDB e un punto del catalogo
  const IO_LISTS = ["bi", "bo", "ri", "ro"], IO_MODES = ["0-10V", "0-20mA", "4-20mA"], HWDB_NUMBER = 1000;
  function cleanIo(m) {
    const num = v => typeof v === "number" && isFinite(v) ? v : undefined;
    const rows = (l, real) => (Array.isArray(l) ? l : []).filter(r => r && typeof r.name === "string").slice(0, 128).map(r => {
      const o = { name: r.name.slice(0, 24), res: typeof r.res === "string" ? r.res.slice(0, 31) : "" };
      if (!real && r.inv) o.inv = true;
      if (!real && Number.isInteger(r.filt) && r.filt > 0 && r.filt <= 60000) o.filt = r.filt;
      if (real && IO_MODES.includes(r.mode)) o.mode = r.mode;
      if (real && Array.isArray(r.raw) && r.raw.length === 2 && r.raw.every(x => num(x) !== undefined)) o.raw = r.raw.slice();
      if (real && Array.isArray(r.eng) && r.eng.length === 2 && r.eng.every(x => num(x) !== undefined)) o.eng = r.eng.slice();
      if (real && typeof r.unit === "string" && r.unit.trim()) o.unit = r.unit.trim().slice(0, 12);
      if (real && Number.isInteger(r.avg) && r.avg > 1 && r.avg <= 100) o.avg = r.avg;
      if (r.fail === "hold" || r.fail === "sf") o.fail = r.fail;
      if (typeof r.comment === "string" && r.comment.trim()) o.comment = r.comment.trim().slice(0, 120);
      if (typeof r.dev === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(r.dev)) o.dev = r.dev;   // modulo I/O (nome = nome della sua DB)
      return o;
    });
    const pack = x => ({ bi: rows(x.bi, false), bo: rows(x.bo, false), ri: rows(x.ri, true), ro: rows(x.ro, true) });
    const o = Object.assign({ number: 3, type: "io" }, pack(m));
    if (m.off) o.off = true;
    if (typeof m.stamp === "string" && !isNaN(Date.parse(m.stamp))) o.stamp = m.stamp;
    if (m.editing) { o.editing = true; if (m.prev && typeof m.prev === "object") o.prev = pack(m.prev); }
    if (Array.isArray(m.catalog)) o.catalog = m.catalog.filter(p => p && typeof p.id === "string").slice(0, 512)
      .map(p => Object.assign({ id: p.id.slice(0, 40), t: p.t === "real" ? "real" : "bit", dir: ["in", "out", "io"].includes(p.dir) ? p.dir : "in" }, p.modes ? { modes: true } : {},
                              Number.isInteger(p.i) && p.i >= 0 && p.i < 256 ? { i: p.i } : {}, Number.isInteger(p.o) && p.o >= 0 && p.o < 256 ? { o: p.o } : {},
                              typeof p.dev === "string" ? { dev: p.dev.slice(0, 16) } : {}, typeof p.name === "string" && p.name ? { name: p.name.slice(0, 16) } : {}));
    if (typeof m.board === "string") o.board = m.board.slice(0, 60);
    // impronta hardware (Denys 04-11-2026): hw = scheda per cui sono fatte le tabelle, cathw = quella dei punti letti
    for (const k of ["hw", "cathw"]) if (typeof m[k] === "string" && /^[0-9A-F]{1,10}$/.test(m[k])) o[k] = m[k];
    if (m.devdb && typeof m.devdb === "object") {        // DB di ogni modulo: numero
      o.devdb = {};
      for (const [k, v] of Object.entries(m.devdb)) if (/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(k) && Number.isInteger(v) && v > HWDB_NUMBER && v <= 65535) o.devdb[k] = v;
    }
    return o;
  }
  function cleanHmi(m) {
    const num = v => typeof v === "number" && isFinite(v) ? v : undefined;
    const rows = l => (Array.isArray(l) ? l : []).filter(r => r && typeof r.name === "string" && r.op && typeof r.op === "object").slice(0, 256).map(r => {
      const o = { name: r.name.slice(0, 32), op: r.op };
      if (r.w) o.w = true;
      if (typeof r.unit === "string" && r.unit.trim()) o.unit = r.unit.trim().slice(0, 12);
      if (num(r.min) !== undefined) o.min = r.min;
      if (num(r.max) !== undefined) o.max = r.max;
      if (Number.isInteger(r.dec) && r.dec >= 0 && r.dec <= 6) o.dec = r.dec;
      return o;
    });
    const o = { number: 2, type: "hmi", rows: rows(m.rows) };
    if (m.off) o.off = true;
    if (Number.isInteger(m.period) && m.period >= 250 && m.period <= 1000) o.period = m.period;
    if (typeof m.stamp === "string" && !isNaN(Date.parse(m.stamp))) o.stamp = m.stamp;
    if (m.editing) { o.editing = true; if (m.prev && typeof m.prev === "object") o.prev = { rows: rows(m.prev.rows) }; }
    return o;
  }
  // SDB2000 «Sistema»: variabili di sistema scritte dal PLC a ogni scansione (firmware sys_db.cpp: stessi campi, stesse
  // posizioni), in ogni programma, di sola lettura. Campi fissi: si rimettono così anche se il progetto li ha cambiati.
  const SYS_DB_NUMBER = 2000;
  const SYS_FIELDS = [
    ["tick_us", "UDINT", "µs dall'accensione (ricomincia dopo circa 71 minuti)"], ["tick_ms", "UDINT", "ms dall'accensione"],
    ["uptime_s", "UDINT", "secondi dall'accensione"], ["unix", "UDINT", "ora: secondi dal 1970 (0 = non nota)"],
    ["scan_us", "UDINT", "esecuzione della scansione prima (µs)"], ["scan_max_us", "UDINT", "esecuzione: massimo degli ultimi 6 s (µs)"],
    ["cycle_us", "UDINT", "ciclo: da una scrittura delle uscite alla successiva (µs)"], ["scan_count", "UDINT", "scansioni dall'avvio"],
    ["heap_free", "UDINT", "RAM libera (byte)"], ["heap_min", "UDINT", "RAM libera: minimo dall'accensione (byte)"],
    ["cpu0", "REAL", "carico della CPU 0: rete e USB (%)"], ["cpu1", "REAL", "carico della CPU 1: PLC (%)"],
    ["rssi", "INT", "segnale WiFi verso il router (dBm, 0 = non collegato)"],
    ["editors", "BYTE", "editor collegati (ultimi 10 s)"], ["load", "BYTE", "tempo del programma nell'ultimo secondo (%)"],
    ["ulink_ok", "BYTE", "moduli uLink in RUN: bit n = modulo con id n"], ["ulink_n", "BYTE", "moduli uLink impostati"],
    ["eth", "BOOL", "Ethernet collegata"], ["wifi", "BOOL", "WiFi verso il router collegato"], ["ap", "BOOL", "access point del PLC aperto"],
    ["hmi", "BOOL", "pannello HMI collegato"], ["sf", "BOOL", "errore di sistema (SF) acceso"],
    ["first_scan", "BOOL", "primo giro dopo l'avvio o un programma nuovo"],
    ["reqMalloc", "UDINT", "prova della RAM (solo firmware experimental_malloc): byte da tenere occupati, scritto dal programma, solo in RUN"],
    ["actMalloc", "UDINT", "prova della RAM: byte presi davvero (0 negli altri firmware)"]];
  function withSysDb(dbs) {
    const fields = SYS_FIELDS.map(([name, type, comment]) => ({ name, type, comment }));
    const out = (dbs || []).filter(d => d.number !== SYS_DB_NUMBER);
    out.push({ number: SYS_DB_NUMBER, name: "Sistema", retain: false, hw: true, sys: true, fields });
    return out.sort((a, b) => a.number - b.number);
  }
  // Posizione delle variabili: BOOL a bit (8 per byte, di seguito), gli altri a byte, uno dopo l'altro (Denys 04-11-2026:
  // niente buchi; il firmware legge a qualunque byte). align = allineati alla loro larghezza, come prima: solo i DB fissi
  // (Sistema, Modbus, hardware), che il firmware scrive a offset suoi. TIMER: 16 byte fissi (PLC_TMRV_SIZE).
  // inner = campi di una struttura: dimensione esatta (il DB intero e i dati della FC si arrotondano a 4)
  function layoutVars(list, dir, align, inner) {
    let off = 0, bitOff = 0, bit = 8;
    const vars = new Map();
    for (const v of list) {
      if (isStruct(v.type)) {                           // struttura: allineata a 4, i suoi campi come «nome.campo»
        bit = 8; if (align) off = Math.ceil(off / 4) * 4;
        const fs = structFields(v.type), sub = fs ? layoutVars(fs, undefined, align || v.type === "TIMER", true) : { size: 0, vars: new Map() };
        if (v.type === "TIMER") sub.size = 16;          // come PLC_TMRV_SIZE del firmware
        vars.set(v.name, { name: v.name, type: v.type, struct: true, off, size: sub.size, dir: v._dir || dir, v });
        for (const [k, x] of sub.vars) vars.set(v.name + "." + k, Object.assign({}, x, { name: v.name + "." + k, off: off + x.off, member: true, dir: v._dir || dir }));
        off += sub.size;
        continue;
      }
      if (v.type === "BOOL") {
        if (bit >= 8) { bitOff = off; off += 1; bit = 0; }
        vars.set(v.name, { name: v.name, type: "BOOL", off: bitOff, bit: bit++, dir: v._dir || dir, v });
        continue;
      }
      bit = 8;
      const w = TYPE_W[v.type];
      if (align) off = Math.ceil(off / w) * w;
      const arr = Number.isInteger(v.lo) && Number.isInteger(v.hi) && v.hi >= v.lo ? { lo: v.lo, hi: v.hi, n: v.hi - v.lo + 1 } : null;
      vars.set(v.name, Object.assign({ name: v.name, type: v.type, T: TYPE_T[v.type], off, dir: v._dir || dir, v }, arr ? { arr } : {}));
      off += w * (arr ? arr.n : 1);
    }
    return { size: inner && !align ? off : Math.ceil(off / 4) * 4, vars };
  }
  // Interfaccia di una FC → { size, vars: Map(nome → { off, bit?, type, T?, dir }), params: [in, out, inout in ordine] }
  function layoutIface(block) {
    const f = (block && block.iface) || {}, list = [];
    for (const d of DIRS) for (const v of f[d] || []) list.push(Object.assign({ _dir: d }, v));
    const lay = layoutVars(list);
    lay.params = [...lay.vars.values()].filter(x => x.dir !== "temp" && !x.member);
    return lay;
  }
  // DB di un dispositivo (tabelle I/O): immagine a blocchi come il frame uLink, ogni punto al suo posto fisso
  // (indice del punto nel catalogo: i = ingresso, o = uscita). Blocchi: bit in, bit out, real in, real out:
  //   bi a 0, bo dopo (byte interi), ri allineati a 4, ro dopo. Il firmware copia i blocchi (io_hw.cpp), senza righe.
  // → { size, vars, blk: { nbi, nbo, nri, nro, obi, obo, ori, oro } }, oppure null (catalogo senza indici)
  function hwLayout(project, d) {
    const m = ((project && project.modules) || []).find(x => x.type === "io");
    if (!m || !Array.isArray(m.catalog)) return null;
    const dev = d.number === HWDB_NUMBER ? "" : (Object.entries(m.devdb || {}).find(([, n]) => n === d.number) || [""])[0];
    if (d.number !== HWDB_NUMBER && !dev) return null;
    const cat = m.catalog.filter(p => (p.dev || "") === dev), byId = new Map(cat.map(p => [p.id, p]));
    const n = { bi: 0, bo: 0, ri: 0, ro: 0 };
    for (const p of cat) {
      const r = p.t === "real" ? "r" : "b";
      if (Number.isInteger(p.i)) n[r + "i"] = Math.max(n[r + "i"], p.i + 1);
      if (Number.isInteger(p.o)) n[r + "o"] = Math.max(n[r + "o"], p.o + 1);
    }
    const blk = { nbi: n.bi, nbo: n.bo, nri: n.ri, nro: n.ro, obi: 0, obo: Math.ceil(n.bi / 8) };
    blk.ori = Math.ceil((blk.obo + Math.ceil(n.bo / 8)) / 4) * 4; blk.oro = blk.ori + 4 * n.ri;
    const vars = new Map();
    for (const k of IO_LISTS) for (const r of m[k] || []) {
      if ((r.dev || "") !== dev) continue;
      const p = byId.get(r.res), idx = p && (k[1] === "i" ? p.i : p.o), f = d.fields.find(x => x.name === r.name);
      if (!f || !Number.isInteger(idx)) return null;
      if (k[0] === "b") vars.set(f.name, { name: f.name, type: "BOOL", off: (k === "bi" ? blk.obi : blk.obo) + (idx >> 3), bit: idx & 7, dir: "db", v: f });
      else vars.set(f.name, { name: f.name, type: "REAL", T: TYPE_T.REAL, off: (k === "ri" ? blk.ori : blk.oro) + 4 * idx, dir: "db", v: f });
    }
    return { size: blk.oro + 4 * n.ro, vars, blk };
  }
  // Tutti i DB nell'area da 8 KB, in ordine di numero → { size, dbs: Map(numero → { base, size, vars, db }) }
  // DB in fila nell'area dei DB. Oltre i 64 KB (P4, area fino a 2 MB): prima i DB del sistema (I/O, Modbus, Sistema),
  // che il firmware raggiunge con indirizzi a 16 bit; sotto i 64 KB l'ordine di sempre (programmi uguali di prima)
  function layoutDbs(project) {
    useStructs(project);
    const dbs = new Map(), list = (project && project.dbs) || [];
    const lays = list.map(d => (d.hw && hwLayout(project, d)) || layoutVars(d.fields, "db", !!d.hw || d.number === MODBUS_DB || d.number === SYS_DB_NUMBER));
    let order = list;
    if (lays.reduce((a, l) => a + l.size, 0) > 0x10000) {
      const sys = d => !!d.hw || d.number === HWDB_NUMBER || d.number === MODBUS_DB || d.number === SYS_DB_NUMBER;
      order = [...list.filter(sys), ...list.filter(d => !sys(d))];
    }
    let base = 0;
    for (const d of order) {
      const l = lays[list.indexOf(d)];
      dbs.set(d.number, Object.assign({ base, size: l.size, vars: l.vars, db: d }, l.blk ? { blk: l.blk } : {}));
      base += l.size;
    }
    return { size: base, dbs };
  }
  // Identità del progetto: 16 cifre esadecimali casuali
  function newUid() {
    const a = new Uint8Array(8);
    const c = (typeof crypto !== "undefined" && crypto) || (typeof window !== "undefined" && window.crypto);
    if (c && c.getRandomValues) c.getRandomValues(a);
    else for (let i = 0; i < 8; i++) a[i] = Math.floor(Math.random() * 256);
    return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  const TITLE_MAX = 80, COMMENT_MAX = 500;
  function emptyProgram(name) {
    return { format: "espplc-ir", version: 3, uid: newUid(), name: name || "Progetto", blocks: [mainBlock()] };
  }

  // ── Conversione IR v1 (espressioni And/Or/Contact/True) → v2 ──
  function v1ExprToSeries(e) {
    const s = series();
    (function walk(x) {
      if (!x || x.type === "True") return;
      if (x.type === "Contact") { s.items.push(contact(x.op.ns, x.op.idx, x.negated)); return; }
      if (x.type === "And") { walk(x.left); walk(x.right); return; }
      if (x.type === "Or") {
        const br = [];
        (function flat(y) { if (y && y.type === "Or") { flat(y.left); flat(y.right); } else br.push(v1ExprToSeries(y)); })(x);
        s.items.push(parallel(br));
      }
    })(e);
    return s;
  }
  function v1StmtToRung(st) {
    const t = st.target || { ns: "Q", idx: 0 };
    const kind = st.type === "Latch" ? (st.mode === "S" ? "set" : "reset") : "coil";
    return rung(v1ExprToSeries(st.expr), [{ series: series(), coil: coil(kind, t.ns, t.idx) }]);
  }

  // Timer / FC / box: forma "in linea" (nella serie) ↔ forma "elemento finale" (al posto della bobina).
  // Il bytecode è lo stesso; nell'editor solo la BOBINA sta in fondo, il resto va da sinistra a destra.
  const EFFECT_COIL = k => k === "CALL" || k === "BOX" || k === "TON" || k === "TOF" || k === "TP";
  function effectToInline(c) {
    if (c.kind === "CALL") return Object.assign({ type: "Call", fc: c.fc }, c.args ? { args: c.args } : {}, Number.isInteger(c.inst) ? { inst: c.inst } : {});
    if (c.kind === "BOX") { const { kind, ...r } = c; return Object.assign({ type: "Box" }, r); }
    return Object.assign({ type: "Timer", kind: c.kind, op: c.op, pt: c.pt }, c.ptOp ? { ptOp: c.ptOp } : {});   // ptOp: PT da una variabile (timer in un DB)
  }
  function inlineToCoil(it) {
    if (it.type === "Call") return Object.assign({ kind: "CALL", fc: it.fc }, it.args ? { args: it.args } : {}, Number.isInteger(it.inst) ? { inst: it.inst } : {});
    if (it.type === "Box") { const { type, ...r } = it; return Object.assign({ kind: "BOX" }, r); }
    return Object.assign({ kind: it.kind, op: it.op, pt: it.pt }, it.ptOp ? { ptOp: it.ptOp } : {});
  }
  // Rung con una sola uscita che finisce con timer / FC / box → in linea, network aperto (si può continuare)
  function openTrailingEffect(r) {
    const o = r.outputs && r.outputs.length === 1 ? r.outputs[0] : null;
    if (!o || !o.coil || !EFFECT_COIL(o.coil.kind)) return r;
    r.series.items.push(...o.series.items, effectToInline(o.coil));
    r.outputs = [];
    return r;
  }

  // Un network = un rung: un segmento con più rung viene
  // diviso in più network consecutivi, nello stesso ordine di esecuzione.
  function migrateSegments(segs) {
    const out = [];
    const push = (rungs, seg) => {
      const s = { id: out.length + 1, order: out.length, language: "LD", rungs };
      const t = seg && typeof seg.title === "string" ? seg.title.trim().slice(0, TITLE_MAX) : "";
      const c = seg && typeof seg.comment === "string" ? seg.comment.trim().slice(0, COMMENT_MAX) : "";
      if (t) s.title = t;
      if (c) s.comment = c;
      out.push(s);
    };
    (segs || []).forEach(seg => {
      const rungs = (Array.isArray(seg.rungs) ? seg.rungs : (seg.statements || []).map(v1StmtToRung)).map(tidyRung).map(openTrailingEffect);
      if (!rungs.length) push([], seg);
      else rungs.forEach((r, i) => push([r], i === 0 ? seg : null));
    });
    if (!out.length) push([]);
    return out;
  }
  // Cartelle dell'albero dei blocchi: nomi corti, padre esistente, niente giri; posti solo di blocchi che ci sono
  const FOLDER_NAME_MAX = 40;
  function migrateTree(p, out) {
    const src = Array.isArray(p.folders) ? p.folders : [];
    const fs = [], ids = new Set();
    for (const f of src) {
      if (!f || typeof f.id !== "string" || !/^f\d{1,6}$/.test(f.id) || ids.has(f.id)) continue;
      const name = typeof f.name === "string" ? f.name.trim().slice(0, FOLDER_NAME_MAX) : "";
      fs.push({ id: f.id, name: name || "Cartella", parent: typeof f.parent === "string" ? f.parent : null });
      ids.add(f.id);
    }
    const byId = new Map(fs.map(f => [f.id, f]));
    for (const f of fs) {
      if (f.parent && !byId.has(f.parent)) f.parent = null;
      for (let x = f.parent, n = 0; x; x = byId.get(x) && byId.get(x).parent, n++)       // giro → alla radice
        if (x === f.id || n > fs.length) { f.parent = null; break; }
    }
    const place = {}, blk = new Set(out.blocks.map(b => b.id).concat((out.dbs || []).map(d => "db" + d.number)));   // DB: "db<n>"
    if (p.place && typeof p.place === "object")
      for (const [k, v] of Object.entries(p.place)) if (blk.has(k) && byId.has(v)) place[k] = v;
    if (fs.length) out.folders = fs;
    if (Object.keys(place).length) out.place = place;
    // blocchi di sistema già messi una volta nella loro cartella «Sys_…» (app.js sysFolders): lì non si rimettono
    const sp = Array.isArray(p.sysPlaced) ? p.sysPlaced.filter(k => typeof k === "string" && blk.has(k)) : [];
    if (sp.length) out.sysPlaced = sp;
  }
  // Accetta un programma v1, v2 o v3 e restituisce un progetto v3 pulito.
  // uscite: Q (O nei progetti di prima)
  const outsToQ = x => Array.isArray(x) ? x.map(outsToQ) : x && typeof x === "object"
    ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "ns" && v === "O" ? "Q" : outsToQ(v)])) : x;
  function migrate(p) {
    if (!p) return emptyProgram();
    p = outsToQ(p);
    const id = { uid: typeof p.uid === "string" && /^[0-9a-f]{8,32}$/.test(p.uid) ? p.uid : null,
                 name: typeof p.name === "string" ? p.name.trim().slice(0, 60) : "" };
    if (Array.isArray(p.blocks)) {
      const main = p.blocks.find(b => b.type === "main") || mainBlock();
      const su = p.blocks.find(b => b.type === "startup");
      const fcs = p.blocks.filter(b => b.type === "fc" && Number.isInteger(b.number) && b.number > 0)
                          .sort((a, b) => a.number - b.number)
                          .filter((b, i, arr) => i === 0 || arr[i - 1].number !== b.number);
      const out = { format: "espplc-ir", version: 3, uid: id.uid, name: id.name,
               blocks: [mainBlock(migrateSegments(main.segments)),
                        ...(su ? [startupBlock(migrateSegments(su.segments))] : []),
                        ...fcs.map(b => Object.assign(fcBlock(b.number, b.name, migrateSegments(b.segments), cleanIface(b.iface)),
                                                      TEXT_LANGS.includes(b.language) ? { language: b.language, text: String(b.text || "") } : {}))] };
      const st = cleanStructs(p.structs);
      if (st.length) out.structs = st;
      useStructs(out);
      out.dbs = withSysDb(cleanDbs(p.dbs));
      const mods = cleanModules(p.modules);
      if (mods.length) out.modules = mods;
      const tx = cleanTexts(p.texts);
      if (tx) out.texts = tx;
      if (p.settings && p.settings.fcMode === "name") out.settings = { fcMode: "name" };   // impostazioni del programma
      migrateTree(p, out);
      return out;
    }
    if (!Array.isArray(p.segments)) return emptyProgram();
    return { format: "espplc-ir", version: 3, uid: id.uid, name: id.name, blocks: [mainBlock(migrateSegments(p.segments))] };
  }

  // ── Pulizia della struttura dopo una modifica ─────────
  // - un parallelo con un solo ramo si "srotola" nella serie che lo contiene
  // - i rami vuoti vengono tolti
  // - un parallelo dentro un ramo che contiene solo quel parallelo si appiattisce
  function tidySeries(s) {
    const items = [];
    for (const it of s.items) {
      if (it.type === "Parallel") {
        const br = [];
        for (const b of it.branches) {
          tidySeries(b);
          if (!b.items.length) continue;
          // ramo che contiene solo un parallelo → i suoi rami salgono di livello
          if (b.items.length === 1 && b.items[0].type === "Parallel") br.push(...b.items[0].branches);
          else br.push(b);
        }
        if (br.length === 0) continue;
        if (br.length === 1) { items.push(...br[0].items); continue; }
        it.branches = br;
        items.push(it);
      } else if (it.type === "Open") {                    // ramo parallelo aperto (editor): vuoto sparisce
        tidySeries(it.branch);
        if (it.branch.items.length) items.push(it);
      } else items.push(it);
    }
    s.items = items;
    return s;
  }
  // Nodo di uscita (anche il rung stesso ha la forma di un nodo senza bobina):
  // - sotto-uscite senza bobina e senza figli vengono tolte
  // - un nodo con un solo figlio si fonde con il figlio (niente diramazioni inutili)
  function tidyNode(n) {
    n.series = tidySeries(n.series || series());
    if (n.outputs) {
      n.outputs = n.outputs.map(tidyNode).filter(c => c.coil || (c.outputs && c.outputs.length));
      if (n.outputs.length === 1) {
        const c = n.outputs[0];
        n.series.items.push(...c.series.items);
        tidySeries(n.series);
        delete n.outputs;
        if (c.coil) n.coil = c.coil; else n.outputs = c.outputs;
      } else if (!n.outputs.length) delete n.outputs;
    }
    return n;
  }
  function tidyRung(r) {
    const root = tidyNode({ series: r.series || series(), outputs: r.outputs || [] });
    r.series = root.series;
    // il rung ha sempre una lista di uscite; con una sola uscita i contatti stanno nella parte comune
    r.outputs = root.coil ? [{ series: series(), coil: root.coil }] : (root.outputs || []);
    return r;
  }

  // Apre una diramazione nel nodo `n` alla posizione `index` della sua serie,
  // con una nuova uscita `leaf` in fondo. Quello che c'era dopo quel punto
  // (contatti + bobina o diramazioni) diventa il primo ramo, senza copie.
  function splitAt(n, index, leaf) {
    const tail = n.series.items.splice(index);
    if (!tail.length && n.outputs && n.outputs.length > 1) { n.outputs.push(leaf); return; }
    const first = { series: series(tail) };
    if (n.coil) { first.coil = n.coil; delete n.coil; }
    else first.outputs = n.outputs || [];
    n.outputs = [first, leaf];
  }

  // Visita tutte le bobine (foglie) sotto un nodo: fn(leaf, parent)
  function eachLeaf(n, fn, parent) {
    if (n.coil) fn(n, parent);
    (n.outputs || []).forEach(c => eachLeaf(c, fn, n));
  }

  // JSON senza i campi temporanei dell'editor ("_fresh" ecc.)
  const toJSON = p => JSON.stringify(p, (k, v) => k.startsWith("_") ? undefined : v);

  // Visita tutti i contatti di una serie (anche dentro i paralleli)
  function eachContact(s, fn) {
    for (const it of s.items) {
      if (it.type === "Contact") fn(it);
      else if (it.type === "Parallel") it.branches.forEach(b => eachContact(b, fn));
    }
  }

  // v3.1: visita ogni elemento del progetto (in ordine di programma): elementi delle serie
  // (anche nei paralleli) e bobine/box finali. fn(elemento, { block, coil: bool })
  function eachElement(project, fn) {
    const ser = (s, b) => (s.items || []).forEach(it => {
      if (it.type === "Parallel") it.branches.forEach(x => ser(x, b));
      else fn(it, { block: b, coil: false });
    });
    const node = (n, b) => { ser(n.series, b); if (n.coil) fn(n.coil, { block: b, coil: true }); (n.outputs || []).forEach(x => node(x, b)); };
    const rank = b => b.type === "main" ? -2 : b.type === "startup" ? -1 : b.number;
    const blocks = [...project.blocks].sort((a, b) => rank(a) - rank(b));
    blocks.forEach(b => b.segments.forEach(sg => sg.rungs.forEach(r => node(r, b))));
  }

  // v4.8: aree numeriche (MB, MW, MI, MD, MDI, MR) → campi di un DB «Merker» (ritentivo). MW3.5 → Merker.MW3.5.
  // info(chiave) → { name, comment } dalla tabella dei simboli (facoltativo): il nome diventa il nome del campo.
  // → { db, name, count } oppure null se il progetto non usa le aree numeriche.
  const AREA_T = { MB: "BYTE", MW: "WORD", MI: "INT", MD: "UDINT", MDI: "DINT", MR: "REAL" };
  const OP_KEYS = ["op", "a", "b", "c", "d", "e", "out"];
  const isArea = o => !!o && typeof o === "object" && !!AREA_T[o.ns] && Number.isInteger(o.idx);
  function convertAreas(p, info) {
    const used = new Map();
    const visit = it => {
      for (const k of OP_KEYS) if (isArea(it[k])) used.set(it[k].ns + it[k].idx, it[k]);
      if (it.args) for (const a of Object.values(it.args)) if (isArea(a)) used.set(a.ns + a.idx, a);
    };
    eachElement(p, visit);
    for (const m of p.modules || []) for (const r of [...(m.tx || []), ...(m.rx || [])]) if (isArea(r.op)) used.set(r.op.ns + r.op.idx, r.op);
    if (!used.size) return null;
    const ORDER = Object.keys(AREA_T);
    const list = [...used.values()].sort((x, y) => ORDER.indexOf(x.ns) - ORDER.indexOf(y.ns) || x.idx - y.idx);
    const dbs = p.dbs || (p.dbs = []);
    let n = 1; while (dbs.some(d => d.number === n)) n++;
    let name = "Merker", k = 2; while (dbs.some(d => d.name.toLowerCase() === name.toLowerCase())) name = "Merker" + k++;
    const fields = [], fname = new Map(), seen = new Set();
    for (const u of list) {
      const key = u.ns + u.idx, s = (info && info(key)) || {};
      let nm = s.name && NAME_RE.test(s.name) && !seen.has(s.name.toLowerCase()) && !(used.has(s.name.toUpperCase()) && s.name.toUpperCase() !== key) ? s.name : key;
      for (let j = 2; seen.has(nm.toLowerCase()); j++) nm = key + "_" + j;
      seen.add(nm.toLowerCase()); fname.set(key, nm);
      const f = { name: nm, type: AREA_T[u.ns] }, com = s.comment || (s.name && s.name !== nm ? s.name : "");
      if (com) f.comment = String(com).slice(0, 120);
      fields.push(f);
    }
    dbs.push({ number: n, name, retain: true, fields });
    dbs.sort((x, y) => x.number - y.number);
    const conv = o => { if (!isArea(o)) return o; const r = { ns: "DB", db: n, f: fname.get(o.ns + o.idx) }; if (o.bit != null) r.bit = o.bit; return r; };
    eachElement(p, it => {
      for (const kk of OP_KEYS) if (it[kk]) it[kk] = conv(it[kk]);
      if (it.args) for (const a of Object.keys(it.args)) it.args[a] = conv(it.args[a]);
    });
    for (const m of p.modules || []) for (const r of [...(m.tx || []), ...(m.rx || [])]) r.op = conv(r.op);
    return { db: n, name, count: fields.length };
  }

  const isCall = t => !!t && (t.type === "Call" || t.kind === "CALL");
  // impostazioni del programma (project.settings.fcMode): FC per numero («FC12 Carico12») o per nome («Carico12»)
  let fcMode = "num";
  const setFcMode = m => { fcMode = m === "name" ? "name" : "num"; };
  const blockLabel = b => b.type === "main" ? "Main" : b.type === "startup" ? "StartUp"
    : (k => b.name && b.name !== "FC" + b.number ? (fcMode === "name" ? b.name : `${k}${b.number} ${b.name}`) : `${k}${b.number}`)(isFB(b) ? "FB" : "FC");

  // ── Modbus (modulo 5, 01-11-2026; il 4 è il picoPlc): reti, richieste del master, mappe dello slave → DB «Modbus» (numero 1100) generata:
  //    richiesta «Inv1_stato» con 4 registri → Inv1_stato_0 … Inv1_stato_3 (WORD; coil e ingressi: BYTE, 8 per byte);
  //    mappa dello slave «Esposti» → Esposti_0 …; in fondo lo stato di ogni richiesta: <nome>_esito, <nome>_ok (WORD)
  const MODBUS_DB = 1100, MB_FC = [1, 2, 3, 4, 5, 6, 15, 16];
  const mbBits = fc => fc === 1 || fc === 2 || fc === 5 || fc === 15;
  function modbusFields(m) {
    const f = [], words = (bits, q) => bits ? Math.ceil(q / 8) : q;
    for (const r of (m && m.reqs) || []) {
      const bits = mbBits(r.fc), n = words(bits, r.fc === 5 || r.fc === 6 ? 1 : r.qty || 1);
      for (let k = 0; k < n; k++) f.push({ name: `${r.name}_${k}`.slice(0, 24), type: bits ? "BYTE" : "WORD", comment: `${r.ip || ""} id ${r.id} FC${r.fc} ${(r.addr || 0) + (bits ? k * 8 : k)}` });
    }
    for (const x of (m && m.maps) || []) {
      const bits = x.table === 0 || x.table === 1, n = words(bits, x.qty || 1);
      for (let k = 0; k < n; k++) f.push({ name: `${x.name}_${k}`.slice(0, 24), type: bits ? "BYTE" : "WORD", comment: `slave ${["coil", "ingressi", "holding", "input"][x.table]} ${(x.start || 0) + (bits ? k * 8 : k)}` });
    }
    for (const r of (m && m.reqs) || []) {
      f.push({ name: `${r.name}_esito`.slice(0, 24), type: "WORD", comment: "0 ok, 1..11 eccezione, 256 tempo scaduto, 257 collegamento, 258 risposta non valida, 259 WiFi non permesso" });
      f.push({ name: `${r.name}_ok`.slice(0, 24), type: "WORD", comment: "risposte buone" });
    }
    // comando dal programma (box MB_MASTER o contatti e bobine): indirizzo e quantità cambiabili, REQ, BUSY, DONE, ERR
    for (const r of (m && m.reqs) || []) {
      f.push({ name: `${r.name}_addr`, type: "WORD", init: r.addr || 0, comment: "primo indirizzo (dal programma)" },
             { name: `${r.name}_qty`, type: "WORD", init: r.qty || 1, comment: "quantità (dal programma, al massimo quella della tabella)" },
             { name: `${r.name}_req`, type: "BOOL", comment: "fronte di salita: richiesta (con «Ogni ms» = 0 solo così)" },
             { name: `${r.name}_busy`, type: "BOOL", comment: "richiesta in corso" },
             { name: `${r.name}_done`, type: "BOOL", comment: "ultima richiesta riuscita" },
             { name: `${r.name}_err`, type: "BOOL", comment: "ultima richiesta non riuscita (codice in _esito)" });
    }
    for (const x of (m && m.maps) || []) f.push({ name: `${x.name}_dr`.slice(0, 24), type: "BOOL", comment: "un master ha scritto (il programma lo rimette a 0)" });
    for (const n of (m && m.nets) || []) f.push({ name: `${n.name}_on`.slice(0, 24), type: "BOOL", init: true, comment: "rete accesa (box MB_CONFIG)" });
    return f;
  }
  // Istruzioni Modbus del programma (Denys 01-11-2026, «box macro» senza toccare la VM): FC generate da 900 in su, una per
  // richiesta (MB_<nome>: REQ → DONE, BUSY, ERR, STATUS), per registri dello slave (MBS_<nome>: ACK → DR) e per rete
  // (MBC_<nome>: ON). Leggono e scrivono i campi della DB Modbus; si trascinano da «Funzioni di sistema» e si chiamano
  // con una rung senza contatti (sempre). Rigenerate a ogni conferma della tabella Modbus.
  const MB_FC_FIRST = 900, MB_FC_LAST = 999;
  const isMbFc = b => b && b.type === "fc" && b.number >= MB_FC_FIRST && b.number <= MB_FC_LAST && /^MB[SC]?_/.test(b.name || "");
  function mbFcs(m) {
    const db = f => ({ ns: "DB", db: MODBUS_DB, f: f.slice(0, 24) }), L = v => ({ ns: "L", v });
    const r1 = (from, to, kind) => ({ series: { type: "Series", items: [{ type: "Contact", negated: false, op: from }] },
                                      outputs: [{ series: { type: "Series", items: [] }, coil: { kind: kind || "coil", op: to } }] });
    const move = (from, to) => ({ series: { type: "Series", items: [] }, outputs: [{ series: { type: "Series", items: [] }, coil: { kind: "BOX", box: "MOVE", a: from, out: to } }] });
    const seg = rungs => [{ id: 1, order: 0, language: "LD", rungs }];
    const out = []; let n = MB_FC_FIRST;
    const STATUS_T = "0 ok, 1-11 eccezione, 256 tempo, 257 non collegato, 258 risposta non valida, 259 WiFi non permesso";
    // dispositivi (Denys 02-11-2026): una FC per dispositivo, MB_<dispositivo>. REQ fa partire tutti i suoi registri;
    // DONE = tutti riusciti, BUSY / ERR = almeno uno, STATUS = esito del primo registro con errore (0 = tutto bene).
    // Un registro da solo: i suoi campi della DB Modbus (<dispositivo>_<registro>_req, _done…)
    const ct = op => ({ type: "Contact", negated: false, op });
    const coil = (items, to) => ({ series: { type: "Series", items }, outputs: [{ series: { type: "Series", items: [] }, coil: { kind: "coil", op: to } }] });
    const any = names => names.length === 1 ? [ct(db(names[0]))] : [{ type: "Parallel", branches: names.map(f => ({ type: "Series", items: [ct(db(f))] })) }];
    if (m && m.devs) {
      for (const d of m.devs) {
        const regs = (d.regs || []).map(g => `${d.name}_${g.name}`);
        if (!regs.length) continue;
        const rungs = [...regs.map(r => r1(L("REQ"), db(`${r}_req`))),
          coil(regs.map(r => ct(db(`${r}_done`))), L("DONE")), coil(any(regs.map(r => `${r}_busy`)), L("BUSY")), coil(any(regs.map(r => `${r}_err`)), L("ERR")),
          move({ k: 0 }, L("STATUS")),
          ...regs.slice().reverse().map(r => ({ series: { type: "Series", items: [ct(db(`${r}_err`))] },        // il primo con errore vince
                                                outputs: [{ series: { type: "Series", items: [] }, coil: { kind: "BOX", box: "MOVE", a: db(`${r}_esito`), out: L("STATUS") } }] }))];
        out.push(fcBlock(n++, `MB_${d.name}`.slice(0, 24), seg(rungs),
          { in: [{ name: "REQ", type: "BOOL", comment: "fronte di salita: partono tutti i registri del dispositivo" }],
            out: [{ name: "DONE", type: "BOOL", comment: "tutti i registri riusciti" }, { name: "BUSY", type: "BOOL", comment: "almeno un registro in corso" },
                  { name: "ERR", type: "BOOL", comment: "almeno un registro con errore" }, { name: "STATUS", type: "WORD", comment: "esito del primo registro con errore: " + STATUS_T }] }));
      }
    } else for (const r of (m && m.reqs) || []) out.push(fcBlock(n++, `MB_${r.name}`.slice(0, 24), seg([
      r1(L("REQ"), db(`${r.name}_req`)), r1(db(`${r.name}_done`), L("DONE")), r1(db(`${r.name}_busy`), L("BUSY")),
      r1(db(`${r.name}_err`), L("ERR")), move(db(`${r.name}_esito`), L("STATUS"))]),
      { in: [{ name: "REQ", type: "BOOL", comment: "fronte di salita: parte la richiesta" }],
        out: [{ name: "DONE", type: "BOOL" }, { name: "BUSY", type: "BOOL" }, { name: "ERR", type: "BOOL" }, { name: "STATUS", type: "WORD", comment: "0 ok, 1-11 eccezione, 256 tempo, 257 non collegato, 258 risposta non valida, 259 WiFi non permesso" }] }));
    for (const x of (m && m.maps) || []) out.push(fcBlock(n++, `MBS_${x.name}`.slice(0, 24), seg([
      r1(db(`${x.name}_dr`), L("DR")), r1(L("ACK"), db(`${x.name}_dr`), "reset")]),
      { in: [{ name: "ACK", type: "BOOL", comment: "1: DR torna a 0" }], out: [{ name: "DR", type: "BOOL", comment: "un master ha scritto" }] }));
    for (const x of (m && m.nets) || []) out.push(fcBlock(n++, `MBC_${x.name}`.slice(0, 24), seg([r1(L("ON"), db(`${x.name}_on`))]),
      { in: [{ name: "ON", type: "BOOL", comment: "rete accesa" }] }));
    return out.filter(b => b.number <= MB_FC_LAST);
  }
  // Registri con l'indirizzo vero (Denys 02-11-2026): 1-9999 / 000001 coil, 10001 / 100001 ingressi, 30001 / 300001 input,
  // 40001 / 400001 holding (5 cifre fino a 9999, 6 cifre fino a 65536). Tabelle: 0 coil, 1 ingressi discreti, 2 holding, 3 input
  const MB_BASE = [0, 1, 4, 3];
  function mbParseReg(t) {
    const s = String(t ?? "").trim();
    if (!/^\d{1,6}$/.test(s)) return { err: "registro: un numero come 40001, 400001, 30001, 10001 o 1" };
    const six = s.length === 6, v = +s, base = six ? Math.floor(v / 100000) : s.length === 5 ? Math.floor(v / 10000) : 0;
    const n = six ? v % 100000 : s.length === 5 ? v % 10000 : v, table = MB_BASE.indexOf(base);
    if (table < 0) return { err: `registro ${s}: deve cominciare con 0, 1, 3 o 4 (coil, ingressi, input, holding)` };
    if (n < 1 || n > (six ? 65536 : 9999)) return { err: `registro ${s}: fuori dai limiti` };
    return { table, addr: n - 1 };
  }
  const mbRegText = (table, addr) => {
    const b = MB_BASE[table] || 0, n = (addr || 0) + 1;
    return n <= 9999 ? (b ? String(b * 10000 + n) : String(n).padStart(5, "0")) : String(b * 100000 + n).padStart(6, "0");
  };
  // funzione Modbus da tabella e verso: ingressi discreti e input si leggono soltanto
  const mbFcOf = (table, w, qty) => w ? (table === 0 ? (qty > 1 ? 15 : 5) : table === 2 ? (qty > 1 ? 16 : 6) : 0)
                                         : [1, 2, 3, 4][table];
  const mbTableOfFc = fc => ({ 1: 0, 5: 0, 15: 0, 2: 1, 3: 2, 6: 2, 16: 2, 4: 3 })[fc] ?? 2;
  // progetti di prima (reti e richieste): richieste raggruppate per dispositivo (IP, id, rete) → m.devs
  function modbusDevs(m) {
    if (!m || m.devs) return;
    const devs = [];
    for (const r of m.reqs || []) {
      const n = (m.nets || []).find(x => x.name === r.net) || {};
      const key = `${r.ip}|${r.id}|${n.port || 502}|${n.timeout || 500}`;
      let d = devs.find(x => x.key === key);
      const us = (r.name || "").indexOf("_"), dn = us > 0 ? r.name.slice(0, us) : "";
      if (!d) { d = { key, name: dn || `Disp${devs.length + 1}`, ip: r.ip, id: r.id, port: n.port || 502, timeout: n.timeout || 500, regs: [] }; devs.push(d); }
      d.regs.push({ name: (us > 0 && dn === d.name ? r.name.slice(us + 1) : r.name) || `Reg${d.regs.length + 1}`, reg: mbRegText(mbTableOfFc(r.fc), r.addr),
                    w: [5, 6, 15, 16].includes(r.fc), qty: r.qty || 1, period: r.period ?? 500, ...(r.comment ? { comment: r.comment } : {}) });
    }
    devs.forEach(d => delete d.key);
    m.devs = devs;
  }
  // dispositivi e registri → reti e richieste del firmware (formato di sempre): una rete master per ogni porta / tempo
  // massimo diversi (al più 4 reti in tutto), lo slave con porta e id del progetto MiaConfig (m.caps, dal PLC)
  function modbusExpand(m) {
    if (!m || !m.devs) return;
    const caps = m.caps || {}, nets = [], reqs = [];
    for (const d of m.devs) {
      let n = nets.find(x => x.port === (d.port || 502) && x.timeout === (d.timeout || 500));
      if (!n) { n = { name: nets.length ? `Master${nets.length + 1}` : "Master", type: "tcp", role: "master", port: d.port || 502, id: 1, timeout: d.timeout || 500 }; nets.push(n); }
      for (const g of d.regs || []) {
        const p = mbParseReg(g.reg), t = p.err ? 2 : p.table;
        reqs.push({ name: `${d.name}_${g.name}`, net: n.name, ip: d.ip, id: d.id, fc: mbFcOf(t, !!g.w, g.qty || 1) || 3, addr: p.err ? 0 : p.addr,
                    qty: g.qty || 1, period: g.period ?? 500, ...(g.comment ? { comment: g.comment } : {}) });
      }
    }
    if ((m.maps || []).length) {
      nets.push({ name: "Slave", type: "tcp", role: "slave", port: caps.port || 502, id: caps.id || 1, timeout: 500 });
      for (const x of m.maps) x.net = "Slave";
    }
    m.nets = nets; m.reqs = reqs;
  }
  // FB: DB d'istanza 3000…3999, uno per chiamata (il numero resta sulla chiamata: i valori seguono la chiamata anche
  // se si spostano i network). Campi = le STATIC della FB, valore iniziale = il loro default
  const FB_DB_FIRST = 3000, FB_DB_LAST = 3999;
  const isFB = b => !!b && b.type === "fc" && !!(b.iface && (b.iface.static || []).length);
  function fbSync(project) {
    const fbs = new Map((project.blocks || []).filter(isFB).map(b => [b.number, b]));
    const used = new Set(), calls = [];
    eachElement(project, it => { if (isCall(it) && fbs.has(it.fc)) calls.push(it); else if (isCall(it)) delete it.inst; });
    for (const c of calls) {                              // numeri già dati e non ripetuti (una rung copiata ne prende uno nuovo)
      if (Number.isInteger(c.inst) && c.inst >= FB_DB_FIRST && c.inst <= FB_DB_LAST && !used.has(c.inst)) used.add(c.inst);
      else c.inst = null;
    }
    let nx = FB_DB_FIRST;
    for (const c of calls) if (c.inst == null) { while (used.has(nx)) nx++; c.inst = nx; used.add(nx); }
    const old = new Map((project.dbs || []).filter(d => Number.isInteger(d.inst)).map(d => [d.number, d]));
    const dbs = (project.dbs || []).filter(d => !Number.isInteger(d.inst));
    const k = new Map();
    for (const c of calls.sort((a, b) => a.inst - b.inst)) {
      const fb = fbs.get(c.fc), n = (k.get(c.fc) || 0) + 1;
      k.set(c.fc, n);
      const base = (fb.name && fb.name !== "FC" + fb.number ? fb.name : "FB" + fb.number).slice(0, 18);
      const fields = fb.iface.static.map(v => Object.assign({ name: v.name, type: v.type }, Number.isInteger(v.lo) ? { lo: v.lo, hi: v.hi } : {},
                                                            v.def !== undefined ? { init: v.def } : {}, v.comment ? { comment: v.comment } : {}));
      const o = old.get(c.inst);
      dbs.push({ number: c.inst, name: `${base}_${n}`, retain: !!(o && o.retain), inst: fb.number, fields });
    }
    project.dbs = dbs.sort((a, b) => a.number - b.number);
  }
  function modbusSync(project) {
    const m = (project.modules || []).find(x => x.type === "modbus");
    if (m) { modbusDevs(m); modbusExpand(m); }
    project.dbs = (project.dbs || []).filter(d => d.number !== MODBUS_DB);
    project.blocks = (project.blocks || []).filter(b => !isMbFc(b));
    if (m && ((m.reqs || []).length || (m.maps || []).length)) {
      project.dbs.push({ number: MODBUS_DB, name: "Modbus", retain: false, fields: modbusFields(m) });
      project.dbs.sort((a, b) => a.number - b.number);
      project.blocks.push(...mbFcs(m));
    }
  }

  window.EspIR = { baseType, STRUCT_RE, TIMER_FIELDS, isStruct, useStructs, structFields, structLabel, memberOf, cleanStructs, TEXT_LANGS, hwLayout, MODBUS_DB, MB_FC, isFB, fbSync, FB_DB_FIRST, modbusSync, modbusFields, modbusDevs, modbusExpand, mbParseReg, mbRegText, mbFcOf, isMbFc, SYS_DB_NUMBER, withSysDb, cleanModules, DATA_NAME_RE, IO_LISTS, IO_MODES, HWDB_NUMBER, convertAreas, AREA_T, TYPES, TYPE_W, TYPE_T, DIRS, NAME_RE, DB_SIZE, LS_SIZE, FRAME_MAX, cleanVal, cleanIface, cleanDbs, layoutVars, layoutIface, layoutDbs,
                   newUid, FOLDER_NAME_MAX, TITLE_MAX, COMMENT_MAX, series, contact, parallel, coil, rung, emptyProgram, migrate, mainBlock, startupBlock, fcBlock, effectToInline, inlineToCoil, EFFECT_COIL, isCall, blockLabel,
                   tidySeries, tidyNode, tidyRung, splitAt, eachLeaf, toJSON, eachContact, eachElement, setFcMode };
})();
