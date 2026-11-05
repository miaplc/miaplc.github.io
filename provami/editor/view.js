// ============================================================
//  EspPlc — view.js
//  Impostazioni grafiche dell'editor (misure del ladder, testo, interfaccia).
//
//  - Parametri in un oggetto separato dal programma PLC.
//  - Profili con nome (es. "1920x1080"), al massimo 5, salvati nel browser.
//  - Esporta / importa come file JSON:  view-<nome>.json
//      { "format": "espplc-view", "version": 1, "name": "1920x1080", "params": { ... } }
//  - In futuro: stesso formato su SPIFFS. Basta sostituire `store` con uno
//    che usi (proposta) GET /plc/view/list, GET/PUT/DELETE /plc/view/<nome>.json.
//
//  API: EspView.get() → parametri correnti
//       EspView.onChange(fn)
//       EspView.open()  → apre la finestra
// ============================================================
(function () {
  "use strict";

  const DEFAULTS = {
    // area centrale (ladder)
    contactW: 60, contactH: 36, lead: 20, rowH: 72, parTail: 24, coilW: 40, timerW: 90,
    wireW: 2, labelSize: 11, symSize: 13, nameChars: 20, nameLines: 3, symDb: "", symDot: "",
    // menu e testi dell'interfaccia
    uiFont: 14, titleFont: 16, btnFont: 14, btnPad: 5, menuFont: 13, modalFont: 13,
    paletteW: 250, palIcon: 60, dbComW: 300,
    // editor
    undoDepth: 100, parDwell: 2000, zoneShow: "always", zoneColor: "",
    // colori: "" = quello del tema
    theme: "dark", liveOn: "", wire: "", editing: "", ladSym: "", ladAddr: "", ladCom: "", ladOp: "",
  };
  const SWATCHES = ["#4ade80", "#f87171", "#fb923c", "#facc15", "#38bdf8", "#a78bfa", "#f472b6"];
  // tab: "ladder" = area centrale, "ui" = menu e testi, "col" = tema e colori
  const PARAMS = [
    { tab: "ladder", group: "Elementi" },
    { tab: "ladder", key: "contactW",  label: "Larghezza contatto",              min: 36, max: 140, step: 2,   unit: "px" },
    { tab: "ladder", key: "contactH",  label: "Altezza contatto / bobina",       min: 20, max: 70,  step: 2,   unit: "px" },
    { tab: "ladder", key: "coilW",     label: "Larghezza bobina",                min: 26, max: 100, step: 2,   unit: "px" },
    { tab: "ladder", key: "timerW",    label: "Larghezza box timer",             min: 60, max: 180, step: 2,   unit: "px" },
    { tab: "ladder", key: "wireW",     label: "Spessore fili",                   min: 1,  max: 5,   step: 0.5, unit: "px" },
    { tab: "ladder", group: "Distanze" },
    { tab: "ladder", key: "lead",      label: "Distanza tra contatti",           min: 10, max: 80,  step: 2,   unit: "px" },
    { tab: "ladder", key: "rowH",      label: "Distanza tra righe (OR, uscite)", min: 40, max: 160, step: 2,   unit: "px",
      hint: "minimo automatico: altezza contatto + testo indirizzo" },
    { tab: "ladder", key: "parTail",   label: "Spazio chiusura ramo OR",         min: 12, max: 80,  step: 2,   unit: "px" },
    { tab: "ladder", group: "Testi nel ladder" },
    { tab: "ladder", key: "labelSize", label: "Indirizzi (I0, O1…)",             min: 8,  max: 24,  step: 1,   unit: "px" },
    { tab: "ladder", key: "symSize",   label: "Simbolo bobina ( ) (S) (R)",      min: 9,  max: 28,  step: 1,   unit: "px" },
    { tab: "ladder", group: "Nomi lunghi (a capo prima del punto)" },
    { tab: "ladder", key: "nameChars", label: "Caratteri per riga",              min: 15, max: 60,  step: 1,   unit: "car.",
      hint: "\"DbDatiProd\".valore.cassa.ok con 15: \"DbDatiProd\" / .valore.cassa / .ok" },
    { tab: "ladder", key: "nameLines", label: "Righe al massimo",                min: 1,  max: 6,   step: 1,   unit: "righe",
      hint: "oltre, il resto del nome sta intero sull'ultima riga" },
    { tab: "ladder", key: "symDb",     label: "Colore del nome fra gli apici", kind: "color" },
    { tab: "ladder", key: "symDot",    label: "Colore dei punti", kind: "color" },
    { tab: "ui", group: "Testi" },
    { tab: "ui", key: "uiFont",    label: "Testo generale",                      min: 11, max: 22,  step: 1,   unit: "px" },
    { tab: "ui", key: "titleFont", label: "Titolo in alto",                      min: 12, max: 28,  step: 1,   unit: "px" },
    { tab: "ui", key: "menuFont",  label: "Menu tasto destro",                   min: 11, max: 22,  step: 1,   unit: "px" },
    { tab: "ui", key: "modalFont", label: "Finestre (popup)",                    min: 11, max: 22,  step: 1,   unit: "px" },
    { tab: "ui", group: "Pulsanti e palette" },
    { tab: "ui", key: "btnFont",   label: "Testo pulsanti",                      min: 11, max: 22,  step: 1,   unit: "px" },
    { tab: "ui", key: "btnPad",    label: "Altezza pulsanti (margine)",          min: 2,  max: 16,  step: 1,   unit: "px" },
    { tab: "ui", key: "paletteW",  label: "Larghezza colonna palette",           min: 150, max: 700, step: 10, unit: "px" },
    { tab: "ui", key: "palIcon",   label: "Icone palette",                       min: 40, max: 100, step: 2,   unit: "px" },
    { tab: "ui", group: "Editor" },
    { tab: "ui", key: "undoDepth", label: "Annulla / Ripeti: passi memorizzati",  min: 10, max: 500, step: 10,  unit: "passi",
      hint: "Ctrl+Z / Ctrl+Y. Ogni passo è una copia del progetto in memoria del browser" },
    { tab: "ui", key: "parDwell",  label: "Parallelo trascinando: attesa",        min: 500, max: 5000, step: 100, unit: "ms",
      hint: "Quanto tenere fermo un contatto sulla zona davanti a un altro contatto prima che si apra il ramo parallelo" },
    { tab: "ui", key: "zoneShow",  label: "Zone di inserimento (rettangoli tratteggiati)", kind: "sel",
      opts: [["always", "Sempre visibili"], ["drag", "Visibili trascinando o con qualcosa da incollare"], ["never", "Non visibili"]] },
    { tab: "ui", key: "zoneColor", label: "Zone di inserimento: colore", kind: "color" },
    { tab: "col", group: "Tema" },
    { tab: "col", key: "theme",   label: "Tema", kind: "sel", opts: [["dark", "Scuro"], ["light", "Chiaro"]] },
    { tab: "col", group: "Ladder" },
    { tab: "col", key: "liveOn",  label: "Online: contatti e fili attivi", kind: "color" },
    { tab: "col", key: "wire",    label: "Fili e contatti", kind: "color" },
    { tab: "col", key: "editing", label: "Elemento in modifica", kind: "color" },
    { tab: "col", group: "Testi del ladder" },
    { tab: "col", key: "ladSym",  label: "Simboli (nomi)", kind: "color" },
    { tab: "col", key: "ladAddr", label: "Indirizzi e titoli dei box", kind: "color" },
    { tab: "col", key: "ladOp",   label: "Operandi dei box e delle FC", kind: "color" },
    { tab: "col", key: "ladCom",  label: "Commenti dei network", kind: "color" },
  ];
  const KEYS = PARAMS.filter(p => p.key).map(p => p.key);

  // ── Archivio (oggi: browser; domani: SPIFFS) ─────────
  const LS = "espplc.view.";
  const lsGet = k => { try { return localStorage.getItem(LS + k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(LS + k, v); } catch (e) {} };
  const MAX_PROFILES = 5;
  const store = {
    all()        { try { return JSON.parse(lsGet("presets") || "{}") || {}; } catch (e) { return {}; } },
    list()       { return Object.keys(store.all()).sort(); },
    load(name)   { return store.all()[name] || null; },
    save(name, p){ const a = store.all(); a[name] = p; lsSet("presets", JSON.stringify(a)); },
    full(name)   { return !(name in store.all()) && store.list().length >= MAX_PROFILES; },
    remove(name) { const a = store.all(); delete a[name]; lsSet("presets", JSON.stringify(a)); },
  };

  function sanitize(p) {
    const out = {};
    for (const d of PARAMS) {
      if (!d.key) continue;
      if (d.kind === "sel") { const v = p && p[d.key]; out[d.key] = d.opts.some(o => o[0] === v) ? v : DEFAULTS[d.key]; continue; }
      if (d.kind === "color") { const v = String((p && p[d.key]) || ""); out[d.key] = /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : ""; continue; }
      let v = Number(p && p[d.key]);
      if (!Number.isFinite(v)) v = DEFAULTS[d.key];
      out[d.key] = Math.min(d.max, Math.max(d.min, v));
    }
    return out;
  }

  let cur = sanitize(Object.assign({}, DEFAULTS, safeJson(lsGet("current"))));
  let curName = lsGet("currentName") || "default";
  let modified = lsGet("modified") === "1";
  const listeners = [];
  function safeJson(s) { try { return JSON.parse(s || "null") || {}; } catch (e) { return {}; } }

  function applyCss() {
    const r = document.documentElement.style;
    r.setProperty("--label-size", cur.labelSize + "px");
    r.setProperty("--sym-size",   cur.symSize + "px");
    r.setProperty("--wire-w",     cur.wireW + "px");
    r.setProperty("--ui-font",    cur.uiFont + "px");
    r.setProperty("--palette-w",  cur.paletteW + "px");
    r.setProperty("--db-com-w",   cur.dbComW + "px");
    r.setProperty("--title-font", cur.titleFont + "px");
    r.setProperty("--btn-font",   cur.btnFont + "px");
    r.setProperty("--btn-pad",    cur.btnPad + "px");
    r.setProperty("--menu-font",  cur.menuFont + "px");
    r.setProperty("--modal-font", cur.modalFont + "px");
    r.setProperty("--pal-icon",   cur.palIcon + "px");
    if (cur.zoneColor) r.setProperty("--zone-color", cur.zoneColor); else r.removeProperty("--zone-color");
    const zones = () => ["always", "drag", "never"].forEach(k => document.body.classList.toggle("zones-" + k, cur.zoneShow === k));
    if (document.body) zones(); else document.addEventListener("DOMContentLoaded", zones);
    if (window.EspTheme) window.EspTheme.apply(cur);
  }
  function persist() {
    lsSet("current", JSON.stringify(cur));
    lsSet("currentName", curName);
    lsSet("modified", modified ? "1" : "0");
  }
  function emit() { applyCss(); persist(); listeners.forEach(f => { try { f(cur); } catch (e) { console.error(e); } }); refreshUi(); }
  function set(partial, name) {
    cur = sanitize(Object.assign({}, cur, partial));
    if (name !== undefined) { curName = name; modified = false; } else modified = true;
    emit();
  }

  // ── File ─────────────────────────────────────────────
  function fileName(n) { return "view-" + String(n || "default").replace(/[^\w.\-]+/g, "_") + ".json"; }
  function exportFile() {
    const name = document.getElementById("vw-name").value.trim() || curName;
    const doc = { format: "espplc-view", version: 1, name, params: cur };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
    a.download = fileName(name);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    msg(`esportato ${fileName(name)}`);
  }
  async function importFile(f) {
    try {
      const doc = JSON.parse(await f.text());
      if (!doc || doc.format !== "espplc-view" || !doc.params) throw new Error("non è un file di impostazioni MiaPLC");
      const name = doc.name || f.name.replace(/^view-|\.json$/g, "");
      if (store.full(name)) { set(doc.params); msg(`importato, non salvato: già ${MAX_PROFILES} profili, eliminane uno`, true); return; }
      store.save(name, sanitize(doc.params));
      set(doc.params, name);
      msg(`importato nel profilo "${name}"`);
    } catch (e) { msg("importazione fallita: " + e.message, true); }
  }

  // ── Finestra ─────────────────────────────────────────
  function msg(t, err) {
    const el = document.getElementById("vw-msg");
    if (el) { el.textContent = t; el.style.color = err ? "var(--bad)" : "var(--muted)"; }
  }
  function build() {
    const m = document.createElement("div");
    m.id = "view-modal"; m.className = "modal hidden";
    const rows = { ladder: "", ui: "", col: "" };
    for (const d of PARAMS) {
      if (d.group) { rows[d.tab] += `<div class="vw-group">${d.group}</div>`; continue; }
      if (d.kind === "sel") {
        rows[d.tab] += `<div class="vw-row"><label for="vw-${d.key}">${d.label}</label>` +
          `<select id="vw-${d.key}">${d.opts.map(o => `<option value="${o[0]}">${o[1]}</option>`).join("")}</select></div>`;
        continue;
      }
      if (d.kind === "color") {
        rows[d.tab] += `<div class="vw-row vw-color"><label for="vw-${d.key}">${d.label}</label><span class="vw-sw">` +
          SWATCHES.map(c => `<button type="button" class="sw" data-key="${d.key}" data-c="${c}" style="background:${c}"></button>`).join("") +
          `</span><input type="color" id="vw-${d.key}"><button type="button" class="vw-def" data-key="${d.key}">Tema</button></div>`;
        continue;
      }
      rows[d.tab] += `<div class="vw-row" title="${d.hint || ""}"><label for="vw-${d.key}">${d.label}</label>` +
              `<input type="range" id="vw-${d.key}" min="${d.min}" max="${d.max}" step="${d.step}">` +
              `<input type="number" id="vw-${d.key}-n" min="${d.min}" max="${d.max}" step="${d.step}"><span class="muted">${d.unit}</span></div>`;
    }
    m.innerHTML = `<div class="modal-box view-box">
      <h3 id="vw-title">Impostazioni grafiche</h3>
      <div class="vw-presets">
        <label>Profilo</label>
        <select id="vw-preset"></select>
        <input type="text" id="vw-name" placeholder="nome, es. 1920x1080" maxlength="40">
        <button id="vw-save" title="Salva le impostazioni correnti con questo nome">Salva profilo</button>
        <button id="vw-del" class="danger" title="Elimina il profilo selezionato">Elimina</button>
      </div>
      <div class="vw-tabs">
        <button class="vw-tab active" data-tab="ladder">Ladder (area centrale)</button>
        <button class="vw-tab" data-tab="ui">Menu e testi</button>
        <button class="vw-tab" data-tab="col">Colori</button>
      </div>
      <div class="vw-params" data-tab="ladder">${rows.ladder}</div>
      <div class="vw-params hidden" data-tab="ui">${rows.ui}</div>
      <div class="vw-params hidden" data-tab="col">${rows.col}</div>
      <div id="vw-msg" class="muted"></div>
      <div class="row right">
        <button id="vw-export" title="Scarica view-&lt;nome&gt;.json">Esporta file…</button>
        <label class="btn-label" for="vw-import">Importa file…<input type="file" id="vw-import" accept=".json,application/json" hidden></label>
        <button id="vw-default">Default</button>
        <button id="vw-close" class="primary">Chiudi</button>
      </div>
    </div>`;
    document.body.appendChild(m);

    for (const d of PARAMS) {
      if (!d.key) continue;
      if (d.kind) {
        const el = document.getElementById("vw-" + d.key);
        el.addEventListener(d.kind === "color" ? "input" : "change", () => set({ [d.key]: el.value }));
        continue;
      }
      const r = document.getElementById("vw-" + d.key), n = document.getElementById("vw-" + d.key + "-n");
      r.addEventListener("input", () => { set({ [d.key]: +r.value }); });
      n.addEventListener("change", () => { set({ [d.key]: +n.value }); });
    }
    m.querySelectorAll(".sw").forEach(b => b.addEventListener("click", () => set({ [b.dataset.key]: b.dataset.c })));
    m.querySelectorAll(".vw-def").forEach(b => b.addEventListener("click", () => set({ [b.dataset.key]: "" })));
    m.querySelectorAll(".vw-tab").forEach(t => t.addEventListener("click", () => {
      m.querySelectorAll(".vw-tab").forEach(x => x.classList.toggle("active", x === t));
      m.querySelectorAll(".vw-params").forEach(p => p.classList.toggle("hidden", p.dataset.tab !== t.dataset.tab));
    }));
    document.getElementById("vw-preset").addEventListener("change", e => {
      const name = e.target.value;
      if (name === "default") set(DEFAULTS, "default");
      else { const p = store.load(name); if (p) set(p, name); }
      document.getElementById("vw-name").value = name === "default" ? "" : name;
      msg(`profilo "${name}" applicato`);
    });
    document.getElementById("vw-save").addEventListener("click", () => {
      const name = document.getElementById("vw-name").value.trim();
      if (!name) { msg("scrivi un nome per il profilo", true); return; }
      if (name === "default") { msg('"default" è riservato', true); return; }
      if (store.full(name)) { msg(`al massimo ${MAX_PROFILES} profili: eliminane uno`, true); return; }
      store.save(name, cur); curName = name; modified = false; persist(); refreshUi();
      msg(`profilo "${name}" salvato`);
    });
    document.getElementById("vw-del").addEventListener("click", () => {
      const name = document.getElementById("vw-preset").value;
      if (name === "default") { msg("il default non si elimina", true); return; }
      store.remove(name);
      if (curName === name) { curName = "default"; modified = true; persist(); }
      refreshUi(); msg(`profilo "${name}" eliminato`);
    });
    document.getElementById("vw-export").addEventListener("click", exportFile);
    document.getElementById("vw-import").addEventListener("change", e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
    document.getElementById("vw-default").addEventListener("click", () => { set(DEFAULTS, "default"); msg("valori di default"); });
    document.getElementById("vw-close").addEventListener("click", close);
    m.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  }
  function refreshUi() {
    if (!document.getElementById("view-modal")) return;
    const cs = getComputedStyle(document.documentElement);
    const VAR = { liveOn: "--live-on", wire: "--wire", editing: "--editing" };
    for (const d of PARAMS) {
      if (!d.key) continue;
      const k = d.key, el = document.getElementById("vw-" + k);
      if (d.kind === "color") {
        el.value = cur[k] || toHex(cs.getPropertyValue(VAR[k]).trim()) || "#000000";
        document.querySelectorAll(`.sw[data-key="${k}"]`).forEach(b => b.classList.toggle("on", b.dataset.c === cur[k]));
        document.querySelector(`.vw-def[data-key="${k}"]`).classList.toggle("on", !cur[k]);
        continue;
      }
      el.value = cur[k];
      if (!d.kind) document.getElementById("vw-" + k + "-n").value = cur[k];
    }
    const sel = document.getElementById("vw-preset");
    const names = ["default", ...store.list()];
    sel.innerHTML = names.map(n => `<option value="${n.replace(/"/g, "&quot;")}">${n.replace(/</g, "&lt;")}</option>`).join("");
    sel.value = names.includes(curName) ? curName : "default";
    document.getElementById("vw-title").textContent =
      `Impostazioni grafiche — ${curName}${modified ? " (modificato)" : ""}`;
    const btn = document.getElementById("btn-view");
    if (btn) btn.title = `Impostazioni grafiche (${curName}${modified ? ", modificato" : ""})`;
  }
  // colore CSS calcolato (#rgb, #rrggbb, rgb()) → #rrggbb per <input type=color>
  function toHex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    if (/^#[0-9a-f]{3}$/i.test(c)) return "#" + c.slice(1).split("").map(x => x + x).join("");
    const m = c.match(/rgba?\((\d+)\D+(\d+)\D+(\d+)/);
    return m ? "#" + [m[1], m[2], m[3]].map(x => (+x).toString(16).padStart(2, "0")).join("") : "";
  }
  function open() {
    refreshUi();
    const nm = document.getElementById("vw-name");
    if (!nm.value) nm.value = curName === "default" ? "" : curName;
    msg("");
    document.getElementById("view-modal").classList.remove("hidden");
  }
  function close() { document.getElementById("view-modal").classList.add("hidden"); }

  applyCss();
  document.addEventListener("DOMContentLoaded", () => {
    build(); refreshUi();
    const b = document.getElementById("btn-view");
    if (b) b.addEventListener("click", open);
  });

  window.EspView = { get: () => cur, set, onChange: f => listeners.push(f), open, DEFAULTS, PARAMS };
  // Colonne allargabili trascinando il loro bordo destro (colonna dei blocchi, Commento dei DB): durante il trascinamento
  // cambia solo la misura a schermo, al rilascio si salva nel profilo grafico, come dalla finestra Grafica
  function resizer(id, key, cssVar) {
    const h = document.getElementById(id);
    if (!h) return;
    const lim = PARAMS.find(p => p.key === key);
    const clamp = w => Math.round(Math.min(lim.max, Math.max(lim.min, w)));
    let x0 = 0, w0 = 0, w = 0;
    const move = e => { w = clamp(w0 + e.clientX - x0); document.documentElement.style.setProperty(cssVar, w + "px"); };
    const up = () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      h.classList.remove("drag"); document.body.classList.remove("col-resizing");
      if (w && w !== cur[key]) set({ [key]: w });
    };
    h.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      x0 = e.clientX; w0 = cur[key]; w = 0;
      h.classList.add("drag"); document.body.classList.add("col-resizing");
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
    });
    h.addEventListener("dblclick", () => set({ [key]: DEFAULTS[key] }));   // doppio clic: larghezza di partenza
  }
  // Colonne del DB e della pagina della struttura (Nome, Tipo, Valore iniziale, Valore attuale, Offset): di base larghe
  // quanto il testo più lungo (nei limiti dello schermo); trascinando il bordo destro dell'intestazione si allargano o si
  // stringono, doppio clic = di nuovo larghe quanto il testo. Le larghezze trascinate restano nel browser, per ogni DB
  // (numero) e struttura. Il Commento prende lo spazio che resta
  const DBCOL_LS = "miaplc.dbcols2", DBCOL_N = 5, DBCOL_MIN = 50, DBCOL_DEL = 96, DBCOL_COM = 160;
  let colKey = null, colW = null, colAuto = true;
  const colStore = () => { try { const v = JSON.parse(localStorage.getItem(DBCOL_LS) || "null"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } };
  const colSave = () => { try { const v = colStore(); v[colKey] = colW.slice(); localStorage.setItem(DBCOL_LS, JSON.stringify(v)); } catch (e) {} };
  const colUnsave = () => { try { const v = colStore(); delete v[colKey]; localStorage.setItem(DBCOL_LS, JSON.stringify(v)); } catch (e) {} };
  let measCtx = null;
  function textW(el, t) {
    if (!measCtx) measCtx = document.createElement("canvas").getContext("2d");
    const cs = getComputedStyle(el);                       // font vuoto nei campi: dalle sue parti
    measCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return measCtx.measureText(t).width;
  }
  // larghezza che serve al contenuto di una cella (campi, tendine, testo), senza tagli
  function cellW(td) {
    const cs = getComputedStyle(td), pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    let w = 0;
    const ctl = td.querySelectorAll("input:not([type=checkbox]), select");
    if (ctl.length) {
      const first = ctl[0].getBoundingClientRect().left - td.getBoundingClientRect().left - parseFloat(cs.paddingLeft);
      w = Math.max(0, first);                              // freccia e rientro delle strutture
      ctl.forEach(c => {
        const t = c.tagName === "SELECT" ? (c.selectedOptions[0] || {}).text || "" : c.value || c.placeholder || "";
        w += textW(c, t) + (c.tagName === "SELECT" ? 34 : 16) + 6;
      });
      td.querySelectorAll(":scope > span").forEach(sp => { w += textW(sp, sp.textContent) + 6; });
    } else {
      const sp = td.querySelector(".st-mn");
      w = (sp ? sp.getBoundingClientRect().left - td.getBoundingClientRect().left - parseFloat(cs.paddingLeft) + textW(sp, sp.textContent) : textW(td, td.textContent.trim())) + 4;
    }
    return Math.ceil(w + pad);
  }
  function colFit(ths) {
    const tb = document.querySelector("#db-table tbody"), w = [];
    for (let i = 0; i < DBCOL_N; i++) {
      const th = ths[i];
      let m = textW(th, th.textContent.trim()) + 24;
      if (getComputedStyle(th).display !== "none")
        for (const tr of tb.rows) { const td = tr.cells[i]; if (td && td.colSpan === 1 && tr.cells.length >= DBCOL_N) m = Math.max(m, cellW(td)); }
      w.push(Math.max(DBCOL_MIN, Math.ceil(m)));
    }
    const tbl = document.getElementById("db-table"), avail = Math.max(DBCOL_N * DBCOL_MIN, tbl.clientWidth - DBCOL_DEL - DBCOL_COM);
    const sum = w.reduce((a, b) => a + b, 0);
    if (sum > avail) for (let i = 0; i < DBCOL_N; i++) w[i] = Math.max(DBCOL_MIN, Math.floor(w[i] * avail / sum));
    return w;
  }
  function colApply() {
    const ths = [...document.querySelectorAll("#db-table thead th")];
    if (colAuto) colW = colFit(ths);
    ths.slice(0, DBCOL_N).forEach((th, i) => { th.style.width = colW[i] + "px"; });
  }
  // dalla pagina del DB a ogni disegno della tabella: key = "db3", "S2"…
  window.MiaDbCols = key => {
    if (key !== colKey) {
      colKey = key;
      const v = colStore()[key];
      colAuto = !(Array.isArray(v) && v.length === DBCOL_N);
      colW = colAuto ? null : v.slice();
    }
    colApply();
  };
  function dbCols() {
    const ths = [...document.querySelectorAll("#db-table thead th")].slice(0, DBCOL_N);
    ths.forEach((th, i) => {
      const h = document.createElement("div");
      h.className = "col-resizer"; h.title = "Trascina per allargare o stringere la colonna (doppio clic: larga quanto il testo)";
      th.appendChild(h);
      let x0 = 0, w0 = 0;
      const move = e => { colW[i] = Math.round(Math.max(DBCOL_MIN, Math.min(1200, w0 + e.clientX - x0))); colApply(); };
      const up = () => {
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
        h.classList.remove("drag"); document.body.classList.remove("col-resizing"); colSave();
      };
      h.addEventListener("pointerdown", e => {
        if (e.button !== 0 || !colW) return;
        e.preventDefault(); e.stopPropagation();
        colAuto = false; x0 = e.clientX; w0 = th.getBoundingClientRect().width;
        h.classList.add("drag"); document.body.classList.add("col-resizing");
        document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
      });
      h.addEventListener("dblclick", () => { colAuto = true; colUnsave(); colApply(); });
    });
    window.addEventListener("resize", () => { if (colKey && colAuto) colApply(); });
  }
  const resizers = () => { resizer("palette-resizer", "paletteW", "--palette-w"); dbCols(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resizers); else resizers();
})();
