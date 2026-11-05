// Lingua dell'interfaccia (editor e Diagnostica).
// Il sorgente è in italiano: qui si traducono i testi della pagina mentre compaiono (testi, title,
// placeholder, alert/confirm/prompt), con la tabella di lang.js (italiano + inglese) e, se caricata,
// quella sul PLC (/plc/lang.json.gz: inglese + 1 lingua a scelta; l'italiano c'è sempre).
// La tabella si scambia come foglio di calcolo (.xlsx) o .csv: colonna id, poi en (riferimento), it e una colonna per
// lingua (intestazione = codice, es. de, fr, pt-BR, la sigla del paese come ua, o il nome della lingua).
// Si importa un file con quante lingue si vuole: se ne tiene 1 oltre all'inglese (riferimento).
// I testi scritti dall'utente (titoli, commenti, simboli, ladder) hanno translate="no" e restano come sono.
(function () {
  "use strict";
  const D = window.ESPPLC_LANG_DEFAULT || { en: [], it: [] };
  const N = D.it.length;
  const LS_LANG = "espplc.lang", LS_TAB = "espplc.lang.table";
  const LS_ALL = "espplc.lang.all";                      // tutte le lingue dell'ultimo file importato (solo nel browser, per l'esportazione)
  const FILE = "lang.json.gz", MAX_LANGS = 2;                // inglese + 1 a scelta (l'italiano è la lingua della pagina)
  const ATTRS = ["title", "placeholder", "aria-label", "label"];   // label: gruppi delle tendine (optgroup)
  const LETTERS = /[A-Za-zÀ-ÿ]{2}/;

  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };

  // ── Tabella ────────────────────────────────────────────
  let tab = null;            // { format, version, langs: ["en", "de", …], cols: { en: […], de: […] } } allineate a D.it
  let lang = "it", want = "it";                         // lingua mostrata e lingua scelta in questo browser
  const exact = new Map(), pats = [];
  D.it.forEach((s, i) => {
    exact.set(s, i);
    if (!s.includes("{}")) return;
    const lits = s.split("{}"), lit = lits.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (!LETTERS.test(lit)) return;
    pats.push({ id: i, lit, len: lits.join("").length, re: new RegExp("^" + lits.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)") + "$") });
  });
  pats.sort((a, b) => b.len - a.len);                    // vince la voce più precisa (più testo fisso)
  let cache = new Map();
  // testi senza traduzione: si raccolgono qui (EspI18n.missing()); con il Debug acceso (Diagnostica → Avanzato → Debug)
  // si vedono sulla pagina come text_missing«testo», così si trova subito dove manca un pezzo.
  // Non sono testi: sigle e nomi senza spazi (CTU, I0, HWDB, Clock_1Hz, 192.168.4.1)
  const missing = new Set();
  let check = false;
  //   né testi già tradotti (arrivano a volte già nella lingua scelta), né "nomi" tra virgolette, né misure («212 ms», «1 nw»)
  let outs = null;
  const isOut = c => { if (!outs) { outs = new Set(D.en); const col = tab && tab.cols[lang]; if (col) col.forEach(x => x && outs.add(x)); } return outs.has(c); };
  const isText = c => !/^["«].*["»]$/.test(c) && !isOut(c) &&
    (/ /.test(c) ? /[a-zà-ù]{3}/.test(c) : !/[0-9_.:#\/]/.test(c) && c !== c.toUpperCase() && /[a-zà-ù]{3}/.test(c));

  function word(id) {
    const c = tab && tab.cols[lang];
    return (c && c[id]) || (tab && tab.cols.en && tab.cols.en[id]) || D.en[id] || D.it[id];
  }
  function look(c) {
    const id = exact.get(c);
    if (id !== undefined) return word(id);
    for (const p of pats) {
      if (!c.includes(p.lit)) continue;
      const m = p.re.exec(c);
      if (!m) continue;
      let k = 1;
      return word(p.id).replace(/\{\}/g, () => (k < m.length ? core(m[k++]) : ""));
    }
    return null;
  }
  // testo senza spazi ai bordi: voce intera, voce con valori ({}), oppure a pezzi (righe, « · », «etichetta: resto»)
  function core(c) {
    if (!LETTERS.test(c)) return c;
    let r = cache.get(c);
    if (r !== undefined) return r;
    if (!exact.has(c) && isOut(c)) { cache.set(c, c); return c; }        // già nella lingua scelta (testo tradotto passato di nuovo)
    const cc = c.replace(/\s+/g, " "), pm = /^([^\p{L}\p{N}«"(]+)([\s\S]+)$/u.exec(cc);   // «⚠ voce»: prima la voce intera (non un pezzo con «{}»)
    r = pm && exact.has(pm[2]) ? pm[1] + word(exact.get(pm[2])) : look(cc);
    if (r == null) {
      if (c.includes("\n")) r = c.split("\n").map(tr).join("\n");
      else if (c.includes(" · ")) r = c.split(" · ").map(core).join(" · ");
      else if (c.includes(" — ")) r = c.split(" — ").map(core).join(" — ");          // «CTU — Contatore avanti», «testo — Download per…»
      else if (c.includes(" ⚠ ")) r = c.split(" ⚠ ").map(core).join(" ⚠ ");
      else {
        r = c;
        const p = /^([^\p{L}\p{N}«"(]+)([\s\S]+)$/u.exec(c);              // segni davanti: «— », «· », «● »
        if (p) { const t = core(p[2]); if (t !== p[2]) r = p[1] + t; }
        const ps = r === c ? c.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý«"])/) : [];  // frase per frase
        if (ps.length > 1) r = ps.map(core).join(" ");
        const q = r === c ? /^(.+?) (\([^()]*\))$/.exec(c) : null;       // «testo (nota)»
        if (q) { const t = core(q[1]) + " " + core(q[2]); if (t !== c) r = t; }
        const k = r === c ? c.indexOf(": ") : -1;                       // «etichetta: resto»
        const h = k > 0 ? look(c.slice(0, k + 1)) : null, h2 = k > 0 && h == null ? look(c.slice(0, k)) : null;
        if (h != null) r = h + " " + core(c.slice(k + 2)); else if (h2 != null) r = h2 + ": " + core(c.slice(k + 2));
        if (r === c && isText(c)) { missing.add(c); if (check) r = "text_missing«" + c + "»"; }
      }
    }
    if (cache.size > 8000) cache = new Map();
    cache.set(c, r);
    return r;
  }
  // Testo scritto dall'utente (nomi, commenti) dentro un testo dell'interfaccia: arriva racchiuso tra U+2068 e U+2069
  // (isolatori invisibili, vedi U() in app.js) e resta com'è anche se è uguale a una voce della tabella («commento»)
  const UMARK = /\u2068[\s\S]*?\u2069/g;
  function tr(s) {
    if (lang === "it" || s == null) return s;
    s = String(s);
    if (s.includes("\u2068")) {
      const keep = [];
      const t = tr0(s.replace(UMARK, x => "\u2068" + (keep.push(x) - 1) + "\u2069"));
      return t.replace(/\u2068(\d+)\u2069/g, (x, i) => keep[+i] !== undefined ? keep[+i] : x);
    }
    return tr0(s);
  }
  function tr0(s) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m[2]) return s;
    const t = core(m[2]);
    return t === m[2] ? s : m[1] + t + m[3];
  }

  // ── Pagina ─────────────────────────────────────────────
  const SKIP = "script,style,textarea,[translate=no],[contenteditable=true]";
  const tOrig = new WeakMap(), aOrig = new WeakMap();
  function doText(n) {
    const v = n.nodeValue, o = tOrig.get(n);
    const src = o && v === o[1] ? o[0] : v;
    const t = tr(src);
    if (t !== src) tOrig.set(n, [src, t]); else tOrig.delete(n);
    if (t !== v) n.nodeValue = t;
  }
  function doAttr(e, a) {
    const v = e.getAttribute(a);
    if (v == null) return;
    const m = aOrig.get(e) || {}, o = m[a];
    const src = o && v === o[1] ? o[0] : v;
    const t = tr(src);
    if (t !== src) { m[a] = [src, t]; aOrig.set(e, m); } else delete m[a];
    if (t !== v) e.setAttribute(a, t);
  }
  // title, placeholder e aria-label si traducono anche dentro textarea e [translate=no] (es. il segnaposto del commento
  // del network, il title del nome del progetto): sono testi dell'interfaccia, il testo dell'utente dentro è tra U+2068/U+2069
  const ASKIP = "script,style", ASEL = ATTRS.map(a => `[${a}]`).join(",");
  function walk(root) {
    if (root.nodeType === 3) { if (root.parentElement && !root.parentElement.closest(SKIP)) doText(root); return; }
    if (root.nodeType !== 1 || root.closest(ASKIP)) return;
    for (const e of [root, ...root.querySelectorAll(ASEL)]) if (!e.closest(ASKIP)) for (const a of ATTRS) if (e.hasAttribute(a)) doAttr(e, a);
    if (root.closest(SKIP)) return;
    const w = document.createTreeWalker(root, 5, { acceptNode: n => (n.nodeType === 1 && n.matches(SKIP) ? 2 : 1) });
    for (let n = root; n; n = w.nextNode()) if (n.nodeType === 3) doText(n);
  }
  const mo = new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === "childList") r.addedNodes.forEach(walk);
      else if (r.type === "characterData") { const p = r.target.parentElement; if (p && !p.closest(SKIP)) doText(r.target); }
      else if (!r.target.closest(ASKIP)) doAttr(r.target, r.attributeName);
    }
  });
  function apply() {
    mo.disconnect();
    cache = new Map();
    check = lang !== "it" && lsGet("espplc.debug") === "1";
    outs = null;
    document.documentElement.lang = lang;
    walk(document.documentElement);                      // in italiano rimette i testi originali
    if (lang !== "it") mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    fill();
  }
  const A = window.alert, C = window.confirm, P = window.prompt;
  window.alert = m => A.call(window, tr(m));
  window.confirm = m => C.call(window, tr(m));
  window.prompt = (m, d) => P.call(window, tr(m), d);

  // ── Lingue disponibili ─────────────────────────────────
  const CODES = "en it de fr es pt nl pl cs sk sl hr sr bs hu ro bg el tr ru uk be lt lv et fi sv da no nb nn is ga mt sq mk ar he fa hi bn ur ta zh ja ko th vi id ms tl sw ca eu gl af".split(" ");
  function dn(code, inLang) { try { return new Intl.DisplayNames([inLang], { type: "language" }).of(code); } catch (e) { return null; } }
  function nameOf(code) { const n = dn(code, code) || code; return n.charAt(0).toUpperCase() + n.slice(1); }
  let names = null;
  const ALIAS = { ua: "uk", ch: "zh", cn: "zh", jp: "ja", gr: "el", cz: "cs", dk: "da", se: "sv", kr: "ko", br: "pt-BR" };
  function codeOf(h) {
    h = String(h || "").trim();
    if (!h) return null;
    const par = /\(([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\)\s*$/.exec(h);
    if (par) h = par[1];
    let c = h.replace("_", "-");
    const al = ALIAS[c.toLowerCase()];                   // sigle di paese scritte al posto della lingua (ua, ch, cn…)
    if (al) return al;
    if (/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(c)) {
      const p = c.split("-");
      c = p[0].toLowerCase() + (p[1] ? "-" + (p[1].length === 2 ? p[1].toUpperCase() : p[1]) : "");
      if (CODES.includes(p[0].toLowerCase()) || (dn(c, "en") && dn(c, "en").toLowerCase() !== c.toLowerCase())) return c;
    }
    if (!names) {
      names = new Map();
      for (const k of CODES) for (const l of ["en", "it", k]) { const n = dn(k, l); if (n) names.set(n.toLowerCase(), k); }
    }
    return names.get(h.toLowerCase()) || null;
  }
  function langs() { return ["it", "en"].concat(((tab && tab.langs) || []).filter(l => l !== "en" && l !== "it").slice(0, MAX_LANGS - 1)); }   // tabella di prima con 2 lingue: vale la prima

  // ── Tabella da/verso file ──────────────────────────────
  function setTable(t, save) {
    tab = t && t.format === "espplc-lang" && t.cols ? t : null;
    if (save) lsSet(LS_TAB, tab ? JSON.stringify(tab) : null);
    lang = langs().includes(want) ? want : "it";        // la lingua scelta torna appena c'è la sua tabella
    apply();
  }
  // tabella attuale: id | en-US | it-IT | lingue sul PLC | colonne vuote. Intestazioni lingua-paese come nei
  // progetti di altri strumenti (en-US, it-IT, de-DE, uk-UA, zh-CN…); all'importazione en-US e it-IT valgono come en e it
  const EMPTY_COLS = 3;
  // dopo le lingue sul PLC, quelle dell'ultimo file importato che non sono state installate (tenute nel browser)
  const allCols = () => { try { const a = JSON.parse(lsGet(LS_ALL) || "null"); return a && a.cols ? a.cols : {}; } catch (e) { return {}; } };
  function rows() {
    const all = allCols(), inst = langs().filter(l => l !== "it" && l !== "en");
    const ex = inst.concat(Object.keys(all).filter(l => l !== "it" && l !== "en" && !inst.includes(l)));
    const pad = new Array(EMPTY_COLS).fill("");
    const head = ["id", "en-US", "it-IT"].concat(ex, pad);
    const cell = (l, i) => (tab && tab.cols[l] && tab.cols[l][i]) || (all[l] && all[l][i]) || "";
    const body = D.it.map((s, i) => [String(i), cell("en", i) || D.en[i] || "", s].concat(ex.map(l => cell(l, i)), pad));
    return [head].concat(body);
  }
  // Foglio «user»: i testi scritti nel progetto (dall'editor: ESPPLC_USERTEXTS.list() → [{ id, it, cols: { en: … } }]).
  // Colonne come «system»: id | en-US | it-IT. Il selettore della lingua prende la colonna: quello che c'è in en-US
  // compare con l'editor in inglese, in qualunque lingua sia scritto.
  function userRows() {
    const L = window.ESPPLC_USERTEXTS ? window.ESPPLC_USERTEXTS.list() : [];
    const head = ["id", "en-US", "it-IT"].concat(new Array(EMPTY_COLS).fill(""));
    return [head].concat(L.map(x => [x.id, (x.cols && x.cols.en) || "", x.it].concat(new Array(EMPTY_COLS).fill(""))));
  }
  // righe del foglio «user» → { en: { id: testo } } (solo le colonne di lingua riconosciute, italiano escluso)
  function userParse(R) {
    const head = R[0] || [], out = {};
    let idCol = -1; const cols = {};
    head.forEach((h, j) => {                             // en-US → en, it-IT → it (come nel foglio system)
      if (/^\s*id\s*$/i.test(h)) { idCol = j; return; }
      const c0 = codeOf(h), c = c0 && String(c0).slice(0, 2).toLowerCase();
      if (c && c !== "it" && !(c in cols)) cols[c] = j;
    });
    if (idCol < 0) return out;
    for (const r of R.slice(1)) {
      const id = String(r[idCol] || "").trim();
      if (!id) continue;
      for (const [c, j] of Object.entries(cols)) { const v = String(r[j] == null ? "" : r[j]).trim(); if (v) (out[c] = out[c] || {})[id] = v; }
    }
    return out;
  }
  // da righe lette (.csv/.xlsx) a colonne allineate alla tabella di serie
  function parseRows(R) {
    const head = R[0] || [], cols = {}, bad = [];
    let idCol = -1;
    head.forEach((h, j) => {
      if (/^\s*id\s*$/i.test(h)) { idCol = j; return; }
      const c = codeOf(h);
      if (c && !(c in cols)) cols[c] = j; else if (String(h).trim()) bad.push(String(h).trim());
    });
    for (const [b, v] of [["en", "en-US"], ["it", "it-IT"]])   // riferimento e sorgente anche come en-US, it-IT
      if (!(b in cols) && v in cols) { cols[b] = cols[v]; delete cols[v]; }
    if (!("en" in cols)) throw new Error("manca la colonna en-US (inglese, il riferimento)");
    const byEn = new Map();                              // stesso inglese per più voci italiane: vale per tutte
    D.en.forEach((s, i) => { if (s) byEn.set(s, (byEn.get(s) || []).concat(i)); });
    const out = {}, cnt = {};
    for (const c of Object.keys(cols)) { out[c] = new Array(N).fill(""); cnt[c] = 0; }
    for (const r of R.slice(1)) {
      const en = String(r[cols.en] || "").trim(), k = idCol >= 0 ? Number(String(r[idCol]).trim()) : NaN;
      const okId = String(r[idCol] || "").trim() !== "" && Number.isInteger(k) && k >= 0 && k < N;
      // inglese uguale a quello di serie: vale il testo; inglese cambiato nel file: vale l'id
      const ids = okId && (D.en[k] === en || !byEn.has(en)) ? [k] : byEn.get(en) || [];
      for (const i of ids)
        for (const [c, j] of Object.entries(cols)) {
          const v = String(r[j] == null ? "" : r[j]).trim();
          if (v && !out[c][i]) { out[c][i] = v; cnt[c]++; }
        }
    }
    return { cols: out, cnt, bad };
  }
  function csvParse(t) {
    t = t.replace(/^﻿/, "");
    const first = t.split("\n")[0], sep = [";", "\t", ","].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a));
    const R = [];
    let row = [], f = "", q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === sep) { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(f); R.push(row); row = []; f = ""; }
      else f += ch;
    }
    if (f || row.length) { row.push(f); R.push(row); }
    return R.filter(r => r.some(x => x !== ""));
  }
  function csvMake(R) {
    return "﻿" + R.map(r => r.map(v => (/[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(";")).join("\r\n") + "\r\n";
  }

  // ── .xlsx (zip di file XML) ──────────────────────────
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {                                  // senza compressione: i fogli di calcolo lo aprono lo stesso
    const enc = new TextEncoder(), parts = [], dir = [];
    let off = 0;
    for (const [name, text] of files) {
      const nb = enc.encode(name), d = enc.encode(text), crc = crc32(d);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, nb.length, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true); c.setUint32(20, d.length, true); c.setUint32(24, d.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), nb, d);
      dir.push(new Uint8Array(c.buffer), nb);
      off += 30 + nb.length + d.length;
    }
    const size = dir.reduce((t, x) => t + x.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, size, true); e.setUint32(16, off, true);
    return new Blob(parts.concat(dir, [new Uint8Array(e.buffer)]), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  async function unzip(buf) {                            // nome → testo (solo i file che servono)
    const b = new Uint8Array(buf), v = new DataView(buf), out = new Map();
    let e = b.length - 22;
    while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("non è un file .xlsx");
    let p = v.getUint32(e + 16, true);
    for (let k = v.getUint16(e + 10, true); k > 0; k--) {
      const meth = v.getUint16(p + 10, true), cs = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true);
      const xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (!/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name)) continue;
      const s = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true), d = b.subarray(s, s + cs);
      if (meth === 0) out.set(name, new TextDecoder().decode(d));
      else if (meth === 8) out.set(name, await new Response(new Blob([d]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text());
    }
    return out;
  }
  const xml = t => new DOMParser().parseFromString(t, "application/xml");
  const tags = (n, t) => [...n.getElementsByTagNameNS("*", t)];
  const textOf = n => tags(n, "t").map(x => x.textContent).join("");
  // tutti i fogli: nome → righe (nell'ordine della cartella)
  async function xlsxSheets(buf) {
    const F = await unzip(buf), out = new Map();
    const ss = F.has("xl/sharedStrings.xml") ? tags(xml(F.get("xl/sharedStrings.xml")), "si").map(textOf) : [];
    let list = [];
    try {
      const wb = xml(F.get("xl/workbook.xml")), rel = xml(F.get("xl/_rels/workbook.xml.rels"));
      for (const s0 of tags(wb, "sheet")) {
        const rid = s0.getAttribute("r:id") || s0.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        const r = tags(rel, "Relationship").find(x => x.getAttribute("Id") === rid);
        if (r) list.push([s0.getAttribute("name") || "", "xl/" + r.getAttribute("Target").replace(/^\/?xl\//, "").replace(/^\//, "")]);
      }
    } catch (e) {}
    if (!list.length) list = [...F.keys()].filter(k => k.startsWith("xl/worksheets/")).map((k, i) => ["sheet" + (i + 1), k]);
    for (const [name, path] of list) if (F.has(path)) out.set(name.trim().toLowerCase(), sheetRows(xml(F.get(path)), ss));
    if (!out.size) throw new Error("nessun foglio nel file");
    return out;
  }
  function sheetRows(doc, ss) {
    const R = [];
    for (const row of tags(doc, "row")) {
      const r = [];
      let j = 0;
      for (const c of tags(row, "c")) {
        const ref = c.getAttribute("r");
        if (ref) { j = 0; for (const ch of ref.replace(/\d+$/, "")) j = j * 26 + ch.charCodeAt(0) - 64; j--; }
        const t = c.getAttribute("t"), vv = tags(c, "v")[0];
        r[j++] = t === "s" ? ss[Number(vv && vv.textContent)] || "" : t === "inlineStr" ? textOf(c) : vv ? vv.textContent : "";
      }
      R.push(Array.from(r, x => (x == null ? "" : x)));
    }
    return R.filter(r => r.some(x => x !== ""));
  }
  async function xlsxRows(buf) {
    const F = await unzip(buf);
    let sheet = "xl/worksheets/sheet1.xml";
    try {                                                // il primo foglio della cartella
      const wb = xml(F.get("xl/workbook.xml")), rel = xml(F.get("xl/_rels/workbook.xml.rels"));
      const s0 = tags(wb, "sheet")[0], rid = s0 && (s0.getAttribute("r:id") || s0.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
      const r = tags(rel, "Relationship").find(x => x.getAttribute("Id") === rid);
      if (r) sheet = "xl/" + r.getAttribute("Target").replace(/^\/?xl\//, "").replace(/^\//, "");
    } catch (e) {}
    if (!F.has(sheet)) sheet = [...F.keys()].find(k => k.startsWith("xl/worksheets/"));
    if (!sheet) throw new Error("nessun foglio nel file");
    const ss = F.has("xl/sharedStrings.xml") ? tags(xml(F.get("xl/sharedStrings.xml")), "si").map(textOf) : [];
    const R = [];
    for (const row of tags(xml(F.get(sheet)), "row")) {
      const r = [];
      let j = 0;
      for (const c of tags(row, "c")) {
        const ref = c.getAttribute("r");
        if (ref) { j = 0; for (const ch of ref.replace(/\d+$/, "")) j = j * 26 + ch.charCodeAt(0) - 64; j--; }
        const t = c.getAttribute("t"), vv = tags(c, "v")[0];
        r[j++] = t === "s" ? ss[Number(vv && vv.textContent)] || "" : t === "inlineStr" ? textOf(c) : vv ? vv.textContent : "";
      }
      R.push(Array.from(r, x => (x == null ? "" : x)));
    }
    return R.filter(r => r.some(x => x !== ""));
  }
  function xlsxMake(sheets) {                            // [[nome, righe], …]: un foglio per elemento
    if (sheets.length && !Array.isArray(sheets[0][1])) sheets = [["Testi", sheets]];
    const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const col = j => (j >= 26 ? String.fromCharCode(64 + Math.floor(j / 26)) : "") + String.fromCharCode(65 + (j % 26));
    const sheet = R => {
      const rowsX = R.map((r, i) => `<row r="${i + 1}">` + r.map((v, j) => `<c r="${col(j)}${i + 1}" t="inlineStr"${i ? "" : ' s="1"'}><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join("") + "</row>").join("");
      const n = R[0].length, cols = R[0].map((h, j) => `<col min="${j + 1}" max="${j + 1}" width="${h === "id" ? 14 : h ? 60 : 30}" customWidth="1"/>`).join("");
      return H + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${col(n - 1)}${R.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rowsX}</sheetData></worksheet>`;
    };
    const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const ov = sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
    const sh = sheets.map(([nm], k) => `<sheet name="${esc(nm)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("");
    const rl = sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("");
    return zip([
      ["[Content_Types].xml", H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + ov + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ["_rels/.rels", H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ["xl/workbook.xml", H + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sh + '</sheets></workbook>'],
      ["xl/_rels/workbook.xml.rels", H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rl + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ["xl/styles.xml", H + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ...sheets.map(([, R], k) => [`xl/worksheets/sheet${k + 1}.xml`, sheet(R)]),
    ]);
  }

  // ── PLC ────────────────────────────────────────────────
  async function gzip(text) {
    const cs = new CompressionStream("gzip"), w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(text)); w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  async function loadPlc() {                             // vale quello che c'è sul PLC (404 = nessuna tabella)
    try {
      const r = await fetch("/api/fw/gui?name=" + FILE);
      if (r.status === 404 || r.status === 204) { if (tab) setTable(null, true); return "none"; }
      if (!r.ok) return "error";
      const raw = new Uint8Array(await r.arrayBuffer());
      const txt = raw[0] === 0x1F && raw[1] === 0x8B ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(raw);
      const t = JSON.parse(txt);
      const same = JSON.stringify(t) === JSON.stringify(tab);
      if (!same) setTable(t && t.langs && t.langs.length ? t : null, true);
      return "ok";
    } catch (e) { return "error"; }
  }
  async function savePlc(t) {
    const gz = await gzip(JSON.stringify(t)), fd = new FormData();
    fd.append("f", new Blob([gz], { type: "application/gzip" }), FILE);
    const r = await fetch("/api/fw/file?name=" + FILE, { method: "POST", headers: { "X-EspPlc": "1" }, body: fd });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) {} throw new Error(j.msg || "HTTP " + r.status); }
    return gz.length;
  }

  // ── Selettore e finestra «Lingue» ──────────────────────
  const sels = [];
  function fill() {
    for (const s of sels) {
      s.innerHTML = "";
      for (const l of langs()) { const o = new Option(nameOf(l), l); o.setAttribute("translate", "no"); s.add(o); }
      s.add(new Option("Lingue…", "*"));
      s.value = lang;
    }
  }
  function mount(slot) {
    if (!slot) return;
    const s = document.createElement("select");
    s.className = "lang-sel"; s.title = "Lingua dell'interfaccia";
    s.onchange = () => { if (s.value === "*") { s.value = lang; openDlg(); } else set(s.value); };
    slot.appendChild(s); sels.push(s); fill();
  }
  function set(l) {
    lang = langs().includes(l) ? l : "it";
    want = lang;
    lsSet(LS_LANG, lang);
    apply();
    window.dispatchEvent(new Event("espplc-lang"));      // testi del progetto nella lingua scelta (editor)
  }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  let dlg = null, found = null;
  function openDlg() {
    if (!dlg) {
      dlg = document.createElement("div");
      dlg.className = "modal lang-dlg";
      dlg.innerHTML =
        `<div class="modal-box"><h3>Lingue</h3>` +
        `<div class="row muted small" data-k="info"></div>` +
        `<div class="row"><button data-k="xlsx">⭱ Esporta .xlsx</button><button data-k="csv">⭱ Esporta .csv</button>` +
        `<label class="btn-label">⭳ Importa (.xlsx o .csv)<input type="file" data-k="file" accept=".xlsx,.csv,.txt" hidden></label>` +
        `<button data-k="reset" title="Toglie dal PLC le lingue importate: restano italiano e inglese">Tabella di serie</button></div>` +
        `<div data-k="pick" class="hidden"><div class="row" data-k="found"></div><div class="lang-list" data-k="list"></div>` +
        `<div class="row"><button data-k="send">Carica sul PLC</button></div></div>` +
        `<div class="row small" data-k="msg"></div>` +
        `<div class="row right"><button data-k="close">Chiudi</button></div></div>`;
      document.body.appendChild(dlg);
      const q = k => dlg.querySelector(`[data-k="${k}"]`);
      q("close").onclick = () => dlg.classList.add("hidden");
      q("xlsx").onclick = () => download(xlsxMake([["user", userRows()], ["system", rows()]]), `espplc-lingue-${stamp()}.xlsx`);
      q("csv").onclick = () => {                         // un foglio solo: colonna «tipo» (user, poi system)
        const u = userRows(), sy = rows();
        const R = [["tipo"].concat(sy[0])].concat(u.slice(1).map(r => ["user"].concat(r)), sy.slice(1).map(r => ["system"].concat(r)));
        download(new Blob([csvMake(R)], { type: "text/csv;charset=utf-8" }), `espplc-lingue-${stamp()}.csv`);
      };
      q("file").onchange = async e => {
        const f = e.target.files[0]; e.target.value = "";
        if (!f) return;
        try {
          let R, U = null;
          if (/\.xlsx$/i.test(f.name)) {                // fogli «user» e «system»; senza nomi: il primo è system
            const S = await xlsxSheets(await f.arrayBuffer());
            R = S.get("system") || [...S.values()].find((x, i) => ![...S.keys()][i].match(/^user$/i)) || [];
            U = S.get("user") || null;
          } else {
            const C = csvParse(await f.text()), h = (C[0] || []).map(x => String(x).trim().toLowerCase());
            if (h[0] === "tipo") {
              const pick = t => [C[0].slice(1)].concat(C.slice(1).filter(r => String(r[0]).trim().toLowerCase() === t).map(r => r.slice(1)));
              R = pick("system"); U = pick("user");
            } else R = C;
          }
          if (U && U.length > 1 && window.ESPPLC_USERTEXTS) {
            const n = window.ESPPLC_USERTEXTS.set(userParse(U));
            msg(`testi del progetto: ${n} traduzioni prese dal foglio user`);
          }
          found = R.length > 1 ? parseRows(R) : null;
          if (!found) { q("pick").classList.add("hidden"); return; }
          lsSet(LS_ALL, JSON.stringify({ cols: found.cols }));   // tutte le colonne restano per l'esportazione
          showFound();
        } catch (x) { found = null; q("pick").classList.add("hidden"); msg(`${f.name}: ${x.message}`, "err"); }
      };
      q("send").onclick = async () => {
        const pick = ["en"].concat([...dlg.querySelectorAll("input[data-l]:checked")].map(x => x.dataset.l).filter(l => l !== "en"));
        const t = { format: "espplc-lang", version: 1, langs: pick, cols: {} };
        for (const l of pick) t.cols[l] = found.cols[l];
        await send(t, `${pick.length} lingue sul PLC`);
      };
      q("reset").onclick = () => send({ format: "espplc-lang", version: 1, langs: [], cols: {} }, "tabella di serie sul PLC");
    }
    dlg.classList.remove("hidden");
    info();
    loadPlc().then(info);
  }
  function msg(t, cls) { const m = dlg.querySelector('[data-k="msg"]'); m.textContent = t; m.className = "row small " + (cls || ""); }
  function info(st) {
    const ex = langs().filter(l => l !== "it" && l !== "en");
    const t = [ex.length ? `Sul PLC: inglese + ${ex.map(nameOf).join(", ")}` : "Italiano e inglese (tabella di serie)"];
    const more = Object.keys(allCols()).filter(l => l !== "it" && l !== "en" && !ex.includes(l));
    if (more.length) t.push(`nell'esportazione anche: ${more.map(nameOf).join(", ")}`);
    if (st === "error") t.push("PLC non raggiungibile: tabella dalla copia nel browser");
    dlg.querySelector('[data-k="info"]').textContent = t.join(" · ");
  }
  function showFound() {
    const q = k => dlg.querySelector(`[data-k="${k}"]`), ls = Object.keys(found.cols).filter(l => l !== "it");
    const t = [`Trovate ${ls.length} lingue: inglese più al massimo ${MAX_LANGS - 1} a scelta`];
    if (found.bad.length) t.push(`colonne non riconosciute: ${found.bad.join(", ")}`);
    q("found").textContent = t.join(" · ");
    const list = q("list");
    list.innerHTML = "";
    for (const l of ls) {
      const lab = document.createElement("label"), cb = document.createElement("input"), sp = document.createElement("span");
      cb.type = "checkbox"; cb.dataset.l = l;
      if (l === "en") { cb.checked = true; cb.disabled = true; }
      sp.setAttribute("translate", "no");
      sp.textContent = `${nameOf(l)} (${l}) · ${found.cnt[l]}/${N}`;
      cb.onchange = () => {
        const n = list.querySelectorAll("input:checked").length;
        list.querySelectorAll("input:not(:checked)").forEach(x => { x.disabled = n >= MAX_LANGS; });
      };
      lab.append(cb, sp); list.appendChild(lab);
    }
    q("pick").classList.remove("hidden");
  }
  async function send(t, ok) {
    msg("invio al PLC…");
    try {
      const n = await savePlc(t);
      setTable(t.langs.length ? t : null, true);
      if (found) dlg.querySelector('[data-k="pick"]').classList.add("hidden");
      found = null;
      info(); msg(`${ok} · ${Math.round(n / 102.4) / 10} KB compressi`, "ok");
    } catch (x) {
      setTable(t.langs.length ? t : null, true);   // resta nel browser: si riprova con PLC collegato
      info(); msg(`salvata solo nel browser: ${x.message}`, "err");
    }
  }

  // ── Avvio ──────────────────────────────────────────────
  try { const t = JSON.parse(lsGet(LS_TAB) || "null"); if (t && t.format === "espplc-lang") tab = t; } catch (e) {}
  want = lsGet(LS_LANG) || (() => {                     // prima volta: l'italiano se il browser lo ha tra le sue lingue, altrimenti l'inglese
    try { const L = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "it"];
          return L.some(x => String(x).toLowerCase().startsWith("it")) ? "it" : "en"; } catch (e) { return "it"; }
  })();
  lang = langs().includes(want) ? want : "it";
  const css = document.createElement("style");
  css.textContent = ".lang-sel{max-width:9em}.lang-dlg .lang-list{display:flex;flex-direction:column;gap:4px;max-height:40vh;overflow:auto;margin:6px 0}" +
    ".lang-dlg .modal-box{max-width:min(640px,92vw)}.lang-dlg .err{color:var(--bad,#e55)}.lang-dlg .ok{color:var(--ok,#4c4)}";
  document.head.appendChild(css);
  function start() {
    mount(document.getElementById("lang-slot"));
    apply();
    loadPlc();
    // editor aperto da file: la tabella arriva quando si collega la USB
    window.addEventListener("espplc-usb", e => { if (e.detail && e.detail.state === "on") setTimeout(loadPlc, 500); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.addEventListener("espplc-debug", () => { if ((lang !== "it" && lsGet("espplc.debug") === "1") !== check) apply(); });
  window.EspI18n = { missing: () => [...missing].sort(), t: tr, lang: () => lang, set, langs, open: openDlg, codeOf, _parse: parseRows, _csv: csvParse, _xlsx: xlsxRows, _sheets: xlsxSheets, _rows: rows, _urows: userRows, _make: xlsxMake };
})();
