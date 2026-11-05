// ============================================================
//  EspPlc — dev/mock-plc.js
//  PLC simulato per aprire l'editor in Chrome su PC, senza ESP32.
//  Configurazione I/O: dev/mock-config.js
//
//  Intercetta window.fetch per /api/plc/* e risponde come plc_rest.cpp:
//  stessi endpoint, campi JSON e codici HTTP. La VM è un port 1:1 di
//  EspPlcLib/src/plc_vm.cpp, limiti compresi (stack fisso da 16 senza pop
//  tra i rung, 10000 istruzioni per scan).
//
//  index.html              → MOCK (default, solo aperto dal PC: file://)
//  pagina servita dal PLC  → niente simulatore: parla con il PLC (anche se questo file ci fosse)
//  index.html?device=IP    → le chiamate /api/* vanno a http://IP
//                            (serve CORS nel firmware, oggi assente)
//  index.html?mock         → torna al MOCK
//
//  Stato (RAM, flash, run/stop, ingressi) in localStorage: sopravvive al
//  refresh. Pulsante "Reboot" = riavvio ESP (RAM ← flash).
//  Questo file NON va caricato su SPIFFS.
// ============================================================
(function () {
  "use strict";

  const CFG = Object.assign({ inputs: 6, outputs: 4, pushButtons: [], tierKB: 16,
                              scanMs: 10, latencyMs: [15, 45] }, window.ESPPLC_MOCK_CONFIG || {});
  const K = k => "espplc.mock2." + k;
  function lsGet(k) { try { return localStorage.getItem(K(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(K(k), v); } catch (e) {} }

  // ── v3.1: impostazioni del PLC (come plc_settings.cpp) e scheda (boards/esp32.h) ──
  const BOARD = { id: "esp32", name: "ESP32 (classico) — simulato",
    io_max_in: 32, io_max_out: 32,
    gpio_in: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39],
    gpio_out: [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33],
    gpio_warn: [0, 2, 5, 12, 15] };
  // come firmware/uPLC: I0..I3 = 34, 35, 36, 39; Q0, Q1 = 32, 33; il resto non collegato (25, 26… servono all'Ethernet)
  const DEF_IN = [34, 35, 36, 39, -1, -1, -1, -1, -1, -1, -1, -1].slice(0, Math.max(0, Math.min(12, CFG.inputs | 0)));
  const DEF_OUT = [32, 33, -1, -1, -1, -1, -1, -1].slice(0, Math.max(0, Math.min(8, CFG.outputs | 0)));
  const defaultSettings = () => ({ format: "espplc-settings", version: 1,
    inputs: DEF_IN.slice(), outputs: DEF_OUT.slice(), powerfail: { gpio: -1, active_low: true },
    net: { need: "none", wait_s: 30 }, cycle: { boot: "last", input_wd_ms: 150 },
    serial: { mode: "editor" }, usb_guard: { gpio: -1, isolate: 0 }, vm: { iram: false, stop_free: false, accu: false, native: false } });
  const CYC_DEF = () => ({ boot: "last", input_wd_ms: 150 });
  const SER_DEF = () => ({ mode: "editor" }), UG_DEF = () => ({ gpio: -1, isolate: 0 });   // v4.3: seriale USB
  const NET_DEF = () => ({ need: "none", wait_s: 30 });
  // "areas" e "retain" (aree numeriche, tolte) si scartano, come nel firmware
  function loadSettings(k) { try { const j = JSON.parse(lsGet(k) || "null"); if (j && Array.isArray(j.inputs)) { delete j.areas; delete j.retain; return j; } } catch (e) {} return null; }
  let setSaved = loadSettings("settings") || defaultSettings();
  let setActive = loadSettings("settings.active") || JSON.parse(JSON.stringify(setSaved));
  // ── uPLC: impostazioni di rete (come firmware/uPLC/src/net_settings.cpp) ──
  const AP_PASS_DEFAULT = "miaplc1234";
  // rete di fabbrica come firmware/uPLC/platformio.ini: Ethernet accesa, WiFi spento
  const netDefaults = () => ({ wifi: { on: false }, name: "uplc", ap: { ssid: "miaplc-CDEF", pass: AP_PASS_DEFAULT, ip: "10.10.10.1", channel: 6 },
    sta: { on: false, ssid: "", pass: "", dhcp: true, ip: "", mask: "", gw: "", dns: "" },
    eth: { on: true, dhcp: false, ip: "192.168.0.10", mask: "255.255.255.0", gw: "192.168.0.1", dns: "192.168.0.1" } });
  const netLoad = k => { try { const v = JSON.parse(lsGet(k) || "null"); return v && v.ap ? Object.assign({ wifi: { on: false } }, v) : null; } catch (e) { return null; } };
  let netSaved = netLoad("netset") || netDefaults();
  let netActive = netLoad("netset.active") || JSON.parse(JSON.stringify(netSaved));
  const ipNum4 = t => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t); if (!m) return null;
    const b = m.slice(1).map(Number); return b.some(x => x > 255) ? null : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; };
  const maskOk = m => m !== 0 && ((~m >>> 0) & ((~m >>> 0) + 1)) === 0;
  const overlap = (a, ma, b, mb) => { const m = (ma & mb) >>> 0; return ((a & m) >>> 0) === ((b & m) >>> 0); };
  const printable = s => /^[\x20-\x7E]*$/.test(s);
  function netParse(d, s) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return "serve un oggetto JSON";
    if (d.wifi && typeof d.wifi === "object" && d.wifi.on !== undefined) {
      if (typeof d.wifi.on !== "boolean") return 'WiFi: "on" deve essere true o false';
      s.wifi.on = d.wifi.on;
    }
    if (d.name !== undefined) {
      if (typeof d.name !== "string" || !/^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/.test(d.name))
        return "nome: 1..24 caratteri, solo lettere minuscole, cifre e '-' (es. uplc, linea-2)";
      s.name = d.name;
    }
    const ap = d.ap;
    if (ap && typeof ap === "object") {
      if (ap.ssid !== undefined) { if (typeof ap.ssid !== "string" || ap.ssid.length > 32 || !printable(ap.ssid)) return "access point: nome della rete (SSID) da 1 a 32 caratteri"; s.ap.ssid = ap.ssid; }
      if (typeof ap.pass === "string" && ap.pass) { if (ap.pass.length < 8 || ap.pass.length > 63 || !printable(ap.pass)) return "access point: password da 8 a 63 caratteri"; s.ap.pass = ap.pass; }
      if (ap.ip !== undefined) { if (typeof ap.ip !== "string" || ipNum4(ap.ip) === null) return "access point: IP non valido (es. 10.10.10.1)"; s.ap.ip = ap.ip; }
      if (ap.channel !== undefined) { if (!Number.isInteger(ap.channel) || ap.channel < 1 || ap.channel > 13) return "access point: canale da 1 a 13"; s.ap.channel = ap.channel; }
    }
    const iface = (o, f, nm) => {
      if (!o || typeof o !== "object") return null;
      if (o.on !== undefined) { if (typeof o.on !== "boolean") return `${nm}: "on" deve essere true o false`; f.on = o.on; }
      if (o.dhcp !== undefined) { if (typeof o.dhcp !== "boolean") return `${nm}: "dhcp" deve essere true o false`; f.dhcp = o.dhcp; }
      for (const k of ["ip", "mask", "gw", "dns"]) if (o[k] !== undefined) {
        if (typeof o[k] !== "string" || (o[k] !== "" && ipNum4(o[k]) === null)) return `${nm}: ${k} non valido (es. 192.168.1.50)`;
        f[k] = o[k];
      }
      return null;
    };
    const st = d.sta;
    if (st && typeof st === "object") {
      if (st.ssid !== undefined) { if (typeof st.ssid !== "string" || st.ssid.length > 32 || !printable(st.ssid)) return "WiFi verso il router: nome della rete (SSID) fino a 32 caratteri"; s.sta.ssid = st.ssid; }
      if (typeof st.pass === "string" && st.pass) { if (st.pass.length < 8 || st.pass.length > 63 || !printable(st.pass)) return "WiFi verso il router: password da 8 a 63 caratteri (vuota = rete aperta)"; s.sta.pass = st.pass; }
      if (st.open === true) s.sta.pass = "";
      const w = iface(st, s.sta, "WiFi verso il router"); if (w) return w;
    }
    { const w = iface(d.eth, s.eth, "Ethernet"); if (w) return w; }
    if (!s.ap.ssid) return "access point: manca il nome della rete (SSID)";
    if (s.ap.pass.length < 8) return "access point: password da 8 a 63 caratteri";
    const a = ipNum4(s.ap.ip), b0 = a >>> 24, b1 = (a >>> 16) & 255, b3 = a & 255;
    if (!(b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168)) || b3 < 1 || b3 > 254)
      return "access point: usa un IP privato che finisce tra 1 e 254 (es. 10.10.10.1, 192.168.50.1)";
    // con il WiFi spento access point e client non partono: niente controlli fra le reti
    const sta = s.wifi.on && s.sta.on;
    if (sta && !s.sta.ssid) return "WiFi verso il router: manca il nome della rete (SSID)";
    const stat = (f, nm) => {
      if (!f.on || f.dhcp) return null;
      const ip = ipNum4(f.ip || ""), m = ipNum4(f.mask || "");
      if (!ip) return `${nm}: con IP fisso serve l'indirizzo`;
      if (!m || !maskOk(m)) return `${nm}: maschera non valida (es. 255.255.255.0)`;
      const host = (ip & ~m) >>> 0;
      if (host === 0 || host === (~m >>> 0)) return `${nm}: l'indirizzo è quello della rete o di broadcast`;
      if (f.gw && !overlap(ip, m, ipNum4(f.gw), m)) return `${nm}: il gateway non è nella stessa rete`;
      return null;
    };
    for (const [f, nm] of [[sta ? s.sta : { on: false }, "WiFi verso il router"], [s.eth, "Ethernet"]]) { const w = stat(f, nm); if (w) return w; }
    const m24 = 0xFFFFFF00;
    if (sta && !s.sta.dhcp && overlap(ipNum4(s.sta.ip), ipNum4(s.sta.mask), a, m24)) return "WiFi verso il router: stessa rete dell'access point del PLC, cambia uno dei due";
    if (s.wifi.on && s.eth.on && !s.eth.dhcp && overlap(ipNum4(s.eth.ip), ipNum4(s.eth.mask), a, m24)) return "Ethernet: stessa rete dell'access point del PLC, cambia uno dei due";
    if (sta && !s.sta.dhcp && s.eth.on && !s.eth.dhcp && overlap(ipNum4(s.sta.ip), ipNum4(s.sta.mask), ipNum4(s.eth.ip), ipNum4(s.eth.mask)))
      return "WiFi verso il router ed Ethernet nella stessa rete: usane una sola o due reti diverse";
    return null;
  }
  // nelle risposte niente password, solo "impostata sì/no" (come il firmware)
  const netPublic = s => { const c = JSON.parse(JSON.stringify(s)); c.ap.pass_set = !!c.ap.pass; delete c.ap.pass; c.ap.mask = "255.255.255.0";
    c.sta.pass_set = !!c.sta.pass; delete c.sta.pass; return c; };
  const netRebootNeeded = () => JSON.stringify(netSaved) !== JSON.stringify(netActive);
  function netStatus() {
    const n = netActive, up = plcNet, w = n.wifi.on, sta = w && n.sta.on;   // "Rete PLC" del pannello = cavo / router presenti
    return { wifi_on: w, ap: { on: w, ssid: n.ap.ssid, ip: w ? n.ap.ip : "0.0.0.0", clients: w ? 1 : 0, channel: sta && up ? 1 : n.ap.channel },
      sta: Object.assign({ on: sta, ssid: n.sta.ssid, connected: sta && up },
        sta && up ? { ip: n.sta.dhcp ? "192.168.1.73" : n.sta.ip, gw: n.sta.gw || "192.168.1.1", rssi: -58, conflict: false } : {}),
      eth: Object.assign({ on: n.eth.on, connected: n.eth.on && up }, n.eth.on ? { link: up } : {},
        n.eth.on && up ? { ip: n.eth.dhcp ? "192.168.0.41" : n.eth.ip, mbps: 100 } : {}),
      urls: [].concat(w ? [`http://${n.name}.lan`, `http://${n.ap.ip}`] : [], n.eth.on && up ? [`http://${n.eth.dhcp ? "192.168.0.41" : n.eth.ip}`] : [],
        w || n.eth.on ? [`http://${n.name}.local`] : []), name: n.name };
  }
  // → null se va bene, altrimenti il motivo (stessi controlli del firmware)
  function checkSettings(d, base) {
    const s = JSON.parse(JSON.stringify(base));
    if (Array.isArray(d.outputs)) {
      if (d.outputs.length > BOARD.io_max_out) return { err: `al massimo ${BOARD.io_max_out} uscite` };
      const used = new Set();
      for (let i = 0; i < d.outputs.length; i++) {
        const g = d.outputs[i];
        if (g !== -1 && !BOARD.gpio_out.includes(g)) return { err: `Q${i}: GPIO ${g} non usabile come uscita` };
        if (g >= 0 && used.has(g)) return { err: `Q${i}: GPIO ${g} già usato da un'altra uscita` };
        used.add(g);
      }
      s.outputs = d.outputs.slice();
    }
    if (Array.isArray(d.inputs)) {
      if (d.inputs.length > BOARD.io_max_in) return { err: `al massimo ${BOARD.io_max_in} ingressi` };
      for (let i = 0; i < d.inputs.length; i++) { const g = d.inputs[i]; if (g !== -1 && !BOARD.gpio_in.includes(g)) return { err: `I${i}: GPIO ${g} non usabile come ingresso` }; }
      s.inputs = d.inputs.slice();
    }
    for (let i = 0; i < s.inputs.length; i++) if (s.inputs[i] >= 0 && s.outputs.includes(s.inputs[i])) return { err: `I${i}: GPIO ${s.inputs[i]} è anche un'uscita` };
    if (d.powerfail) {                                     // un campo che manca resta com'era (come il firmware)
      const g = d.powerfail.gpio ?? s.powerfail.gpio;
      if (g !== -1 && !BOARD.gpio_in.includes(g)) return { err: `mancanza tensione: GPIO ${g} non usabile come ingresso` };
      s.powerfail = { gpio: g, active_low: d.powerfail.active_low ?? s.powerfail.active_low };
    }
    {   // controlli sul risultato finale, anche coi campi non inviati
      const g = s.powerfail.gpio;
      if (g >= 0 && s.outputs.includes(g)) return { err: `mancanza tensione: GPIO ${g} è un'uscita` };
      const k = s.inputs.indexOf(g);
      if (g >= 0 && k >= 0) return { err: `mancanza tensione: GPIO ${g} è già l'ingresso I${k}` };
    }
    if (d.vm && typeof d.vm.iram === "boolean") s.vm = { iram: d.vm.iram, stop_free: !!d.vm.stop_free, accu: !!d.vm.accu, native: !!d.vm.native };   // VM + IRAM, RAM libera in STOP (dal riavvio)
    delete s.sw_err_stop;                                  // v3.1, non più usato: div 0 non ferma mai il PLC
    s.net = Object.assign(NET_DEF(), s.net || {});
    if (d.net) {                                           // rete usata dal programma del PLC (come il firmware)
      if (d.net.need !== undefined) { if (!["none", "eth", "wifi", "any"].includes(d.net.need)) return { err: "rete del PLC: none, eth, wifi o any" }; s.net.need = d.net.need; }
      if (d.net.wait_s !== undefined) { const w = d.net.wait_s; if (!Number.isInteger(w) || w < 1 || w > 600) return { err: "attesa della rete: da 1 a 600 s" }; s.net.wait_s = w; }
    }
    s.cycle = Object.assign(CYC_DEF(), s.cycle || {});
    if (d.cycle) {                                         // v4.2: stato al riavvio e controllo del ciclo (valgono subito)
      if (d.cycle.boot !== undefined) { if (!["last", "run"].includes(d.cycle.boot)) return { err: "stato al riavvio: last o run" }; s.cycle.boot = d.cycle.boot; }
      if (d.cycle.input_wd_ms !== undefined) { const w = d.cycle.input_wd_ms;
        if (!Number.isInteger(w) || w < 10 || w > 1000) return { err: "controllo del ciclo: da 10 a 1000 ms" }; s.cycle.input_wd_ms = w; }
    }
    s.serial = Object.assign(SER_DEF(), s.serial || {});
    if (d.serial && d.serial.mode !== undefined) { if (!["log", "editor"].includes(d.serial.mode)) return { err: "seriale: log o editor" }; s.serial.mode = d.serial.mode; }
    s.usb_guard = Object.assign(UG_DEF(), s.usb_guard || {});
    if (d.usb_guard) {
      if (d.usb_guard.gpio !== undefined) { const g = d.usb_guard.gpio;
        if (g !== -1 && !BOARD.gpio_out.includes(g)) return { err: `protezione reset USB: GPIO ${g} non usabile come uscita` }; s.usb_guard.gpio = g; }
      if (d.usb_guard.isolate !== undefined) { if (d.usb_guard.isolate !== 0 && d.usb_guard.isolate !== 1) return { err: "protezione reset USB: livello 0 o 1" }; s.usb_guard.isolate = d.usb_guard.isolate; }
    }
    { const ug = s.usb_guard.gpio;
      if (ug >= 0 && s.outputs.includes(ug)) return { err: `protezione reset USB: GPIO ${ug} è già un'uscita del PLC` };
      const k = s.inputs.indexOf(ug);
      if (ug >= 0 && k >= 0) return { err: `protezione reset USB: GPIO ${ug} è già l'ingresso I${k}` };
      if (ug >= 0 && ug === s.powerfail.gpio) return { err: `protezione reset USB: GPIO ${ug} è la mancanza tensione` }; }
    return { s };
  }
  const rebootFields = x => JSON.stringify([x.inputs, x.outputs, x.powerfail, Object.assign(NET_DEF(), x.net || {}),
                                            Object.assign(UG_DEF(), x.usb_guard || {})]);
  const rebootNeeded = () => rebootFields(setActive) !== rebootFields(setSaved);
  let N_IN = setActive.inputs.length, N_OUT = setActive.outputs.length;
  function lsDel(k) { try { localStorage.removeItem(K(k)); } catch (e) {} }

  const qs = new URLSearchParams(location.search);
  // Pagina servita da un PLC vero (http://uplc.lan, http://10.10.10.1…): il simulatore non parte,
  // l'editor parla con il PLC. Solo aprendo i file dal PC (file://) o con ?mock parte il PLC simulato.
  // Collegamento USB scelto nell'editor (usb.js): niente simulatore, si torna con ?mock
  { let conn = null; try { conn = localStorage.getItem("espplc.conn"); } catch (e) {}
    if (!qs.has("mock") && (qs.has("usb") || conn === "usb")) return; }
  if (/^https?:$/.test(location.protocol || "") && !qs.has("mock") && !lsGet("device")) return;
  if (qs.has("mock")) lsDel("device");
  if (qs.get("device")) lsSet("device", qs.get("device").replace(/^https?:\/\//, "").replace(/\/+$/, ""));
  const DEVICE = lsGet("device");
  const realFetch = window.fetch.bind(window);

  // ── Modalità DEVICE: solo riscrittura URL ────────────
  if (DEVICE) {
    window.fetch = (input, init) => {
      const url = (typeof input === "string") ? input : (input && input.url) || "";
      return realFetch(url.startsWith("/api/") ? "http://" + DEVICE + url : input, init);
    };
    document.addEventListener("DOMContentLoaded", () => buildPanel(null));
    return;
  }

  // ── Modalità MOCK ────────────────────────────────────
  // Taglia memoria: dal pannello (salvata nel browser) oppure da mock-config.js
  const TIER = [16, 32, 64, 128].includes(+lsGet("tier")) ? +lsGet("tier") : CFG.tierKB;
  const TIERS = { 8: [8192, 4096, 16], 16: [16384, 8192, 30], 32: [32768, 24576, 80],
                  64: [65536, 51200, 120], 128: [131072, 102400, 150] };
  const [TIER_PART, BYTECODE_MAX, SEGMENTS_MAX] = TIERS[TIER] || TIERS[16];
  // memoria di caricamento (flash): come il firmware uPLC (PLC_LOAD_MEM), di default quella della taglia
  const PARTITION_MAX = (+CFG.loadKB > 0 ? Math.max(+CFG.loadKB * 1024, TIER_PART) : TIER_PART);
  const HEADER_SIZE = 20, MAGIC = 0x31434C50, PATCH_MAGIC = 0x50434C50, VERSION = 3;
  const MAX_INSTR = 0, VM_STACK = 16;                       // 0 = nessun limite di istruzioni (come il firmware)
  // Istruzioni della VM v2.5 (come EspPlc::supportedOps)
  const SUPPORTED_OPS = [0x00, 0x01, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B,
    0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x40, 0x41, 0x42, 0x43, 0x50, 0x51, 0x52, 0x60, 0x61,
    0x53, 0x54, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
    0x1C, 0x64, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88,     // v4.6
    0x62, 0x65, 0x63,                                                                                           // v4.8 FRAME; CALLP (pezzi)
    0x55, 0x56, 0x57];                                                                                          // v4.9 contatori
  const MAX_IDX = { 1: 1023, 2: 1023, 3: 1023, 6: 255 };      // I, O(=Q firmware), M, T
  const ROLLBACK_SCANS = 100;

  const defaultState = () => ({ ram: null, nvs: null, state: "no_program", fault: "PLC_OK",
                                dirty: false, last_persist_unix: 0, last_test_unix: 0 });
  let S = load("state", defaultState);
  let inputs = load("inputs", () => ({ i: 0 })).i >>> 0;
  let offline = lsGet("offline") === "1";
  const log = [];

  function load(k, def) {
    try { return Object.assign(def(), JSON.parse(lsGet(k) || "null") || {}); } catch (e) { return def(); }
  }
  const saveState  = () => lsSet("state", JSON.stringify(S));
  const saveInputs = () => lsSet("inputs", JSON.stringify({ i: inputs }));

  const mem = { i: new Uint8Array(128), q: new Uint8Array(128), m: new Uint8Array(128),
                t: new Uint8Array(32), tm: newTimers() };          // t = Q dei timer, tm = stato
  // memoria dei fronti E, DB e stack L (i numeri stanno nei DB: le aree numeriche MW…MB non ci sono più)
  const DB_SIZE = 8192, LS_SIZE = 4096;                   // v4.8: come PLC_DB_SIZE / PLC_LSTACK_SIZE del firmware
  function ensureMem(mm) {
    if (!mm.e) mm.e = new Uint8Array(64);
    if (!mm.db) mm.db = new Uint8Array(DB_SIZE);                       // v4.8: dati dei DB
    if (!mm.ls) mm.ls = new Uint8Array(LS_SIZE);                       // v4.8: dati locali delle FC (stack L)
    return mm;
  }
  ensureMem(mem);
  // Stato di un timer IEC (stessa logica del firmware, plc_vm.cpp)
  function newTimers() { return Array.from({ length: 256 }, () => ({ start: 0, prev: false, run: false, q: false, kind: 0, pt: 0 })); }
  function resetTimers(mm) { mm.t.fill(0); mm.tm = newTimers(); }
  const stats = { scan_count: 0, scan_avg_us: 0, scan_max_us: 0, scan_overrun_count: 0, rollback: 0 };
  let prog = null;

  // ── util ─────────────────────────────────────────────
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function fcExecBits(list) {
    const b = new Uint8Array(1024 / 8);
    for (const fc of list) if (fc < 1024) b[fc >> 3] |= 1 << (fc & 7);
    return b;
  }
  function b64enc(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // Port di b64_decode_into(): ignora = \r \n spazio tab, altro → errore.
  function b64decStrict(str) {
    const out = []; let acc = 0, bits = 0;
    for (const c of str) {
      if (c === "=" || c === "\r" || c === "\n" || c === " " || c === "\t") continue;
      const v = B64.indexOf(c);
      if (v < 0) return null;
      acc = ((acc << 6) | v) & 0xFFFFFF; bits += 6;
      if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xFF); }
    }
    return out.length ? new Uint8Array(out) : null;
  }
  const hex = u8 => Array.from(u8, b => (b < 16 ? "0" : "") + b.toString(16)).join("");
  const getBit = (a, i) => !!(a[i >> 3] & (1 << (i & 7)));
  function setBit(a, i, v) { if (v) a[i >> 3] |= (1 << (i & 7)); else a[i >> 3] &= ~(1 << (i & 7)); }
  const nowUnix = () => Math.floor(Date.now() / 1000);

  let _crc = null;
  function crc32(u8) {
    if (!_crc) {
      _crc = new Uint32Array(256);
      for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crc[i] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = (_crc[(c ^ u8[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ── parse blob (PROGRAM_FORMAT.md §1.3) ──────────────
  function parseBlob(u8) {
    if (u8.length < HEADER_SIZE) return { fault: "PLC_ERR_BYTECODE_CHECKSUM_FAIL" };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const h = { magic: dv.getUint32(0, true), version: dv.getUint16(4, true), num_segments: dv.getUint16(6, true),
                total_bytecode: dv.getUint32(8, true), source_size: dv.getUint32(12, true), crc32: dv.getUint32(16, true) };
    if (h.magic !== MAGIC || h.version !== VERSION) return { fault: "PLC_ERR_VERSION_MISMATCH" };
    if (h.total_bytecode > BYTECODE_MAX || u8.length > PARTITION_MAX) return { fault: "PLC_ERR_PROGRAM_TOO_LARGE" };   // v2.5
    if (u8.length !== HEADER_SIZE + h.total_bytecode + h.source_size) return { fault: "PLC_ERR_BYTECODE_CHECKSUM_FAIL" };
    const tmp = new Uint8Array(u8); new DataView(tmp.buffer).setUint32(16, 0, true);
    if (crc32(tmp) !== h.crc32) return { fault: "PLC_ERR_BYTECODE_CHECKSUM_FAIL" };
    const p = { header: h, bytecode: u8.slice(HEADER_SIZE, HEADER_SIZE + h.total_bytecode),
                source: u8.slice(HEADER_SIZE + h.total_bytecode) };
    try { indexProg(p); } catch (e) { return { fault: "PLC_ERR_BAD_BLOCKS" }; }
    return p;
  }
  // ── v3: tabella dei blocchi (come plc_program_index nel firmware) ──
  function readSection(sec, isCode) {
    if (sec.length < 4) throw new Error("corta");
    const dv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
    const n = dv.getUint16(0, true), tab = 4 + 12 * n;
    if (tab > sec.length || (isCode && !n)) throw new Error("tabella");
    const out = []; let off = tab, prev = -1, prevDb = -1, prevMod = -1;
    for (let k = 0; k < n; k++) {
      const a = 4 + 12 * k;
      const e = { type: sec[a], flags: sec[a + 1], number: dv.getUint16(a + 2, true), size: dv.getUint32(a + 4, true), crc: dv.getUint32(a + 8, true), off: off - tab };
      if (e.flags) throw new Error("flag");
      if (isCode) {
        const su = k === 1 && e.type === 2 && e.number === 0;           // StartUp subito dopo il Main
        const db = k > 0 && e.type === 3 && prevMod < 0;                // v4.8: DB in fondo, dopo le FC, poi i moduli
        const mod = k > 0 && e.type === 4;
        if (k === 0 ? e.type !== 0 : !(su || db || mod || (e.type === 1 && prevDb < 0 && prevMod < 0))) throw new Error("tipo");
        if (mod) { if (e.number <= prevMod) throw new Error("ordine"); prevMod = e.number; }
        else if (db) { if (e.number <= prevDb) throw new Error("ordine"); prevDb = e.number; }
        else if (k > 0 && !su) { if (e.number <= prev) throw new Error("ordine"); prev = e.number; }
        if (!e.size) throw new Error("vuoto");
      } else if (e.type !== 0 && e.type !== 1 && e.type !== 2 && e.type !== 0xFF && e.type !== 0xFE) throw new Error("tipo");
      if (off + e.size > sec.length) throw new Error("oltre");
      e.data = sec.subarray(off, off + e.size);
      if (crc32(e.data) !== e.crc) throw new Error("crc");
      off += e.size; out.push(e);
    }
    if (off !== sec.length) throw new Error("coda");
    return { entries: out, tab };
  }
  function indexProg(p) {
    const t = readSection(p.bytecode, true);
    p.blocks = t.entries;
    p.code = p.bytecode.subarray(t.tab);
    p.fcOff = new Map(t.entries.slice(1).filter(e => e.type === 1).map(e => [e.number, e.off]));
    p.fcEnd = new Map(t.entries.slice(1).filter(e => e.type === 1).map(e => [e.number, e.off + e.size]));   // fine dei pezzi (CALLP)
    p.suOff = t.entries.length > 1 && t.entries[1].type === 2 ? t.entries[1].off : -1;   // StartUp
    const d0 = t.entries.find(e => e.type === 3 || e.type === 4);
    p.codeEnd = d0 ? d0.off : p.code.length;                            // v4.8: i DB non hanno codice
    p.dbs = t.entries.filter(e => e.type === 3).map(e => dbParse(e));
    if (p.dbs.some(d => !d)) throw new Error("DB");
    const me = t.entries.find(e => e.type === 4 && e.number === 1);     // v4.8: esposizione dati
    p.xchg = me ? xchgParse(me.data) : [];
    p.xchgVer = me && me.data[0] === 2 ? (me.data[4] | (me.data[5] << 8) | (me.data[6] << 16) | (me.data[7] << 24)) >>> 0 : 0;
    if (!p.xchg) throw new Error("modulo");
    p.srcBlocks = p.source.length ? readSection(p.source, false).entries : [];
    return p;
  }
  // v4.8: DB (come plc_db.cpp): testata, campi, valori iniziali
  function dbParse(e) {
    const c = e.data, dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    if (c.length < 8 || c[0] !== 1) return null;
    const d = { number: e.number, flags: c[1], base: dv.getUint16(2, true), size: dv.getUint16(4, true), nf: dv.getUint16(6, true), fields: [] };
    if (c.length !== 8 + 8 * d.nf + d.size || d.base + d.size > DB_SIZE) return null;
    for (let k = 0; k < d.nf; k++) { const a = 8 + 8 * k; d.fields.push({ crc: dv.getUint32(a, true), t: c[a + 4], bit: c[a + 5], off: dv.getUint16(a + 6, true) }); }
    d.init = c.subarray(8 + 8 * d.nf);
    return d;
  }
  // v4.8: esposizione dati (come plc_xchg.cpp)
  function xchgParse(c) {
    if (c.length < 4 || (c[0] !== 1 && c[0] !== 2)) return null;
    const n = c[2] | (c[3] << 8), out = []; let p = c[0] === 2 ? 8 : 4;
    for (let i = 0; i < n; i++) {
      if (p + 7 > c.length) return null;
      const e = { dir: c[p], type: c[p + 1], area: c[p + 2], bit: c[p + 3], idx: c[p + 4] | (c[p + 5] << 8), nlen: c[p + 6] };
      if (p + 7 + e.nlen > c.length) return null;
      e.name = new TextDecoder().decode(c.subarray(p + 7, p + 7 + e.nlen)); p += 7 + e.nlen;
      out.push(e);
    }
    return p === c.length ? out : null;
  }
  const T_OF = { 1: "INT", 2: "WORD", 3: "DINT", 4: "UDINT", 5: "REAL", 6: "BYTE" };
  function xchgGet(e) {
    if (e.area < 3) { const a = [mem.i, mem.q, mem.m][e.area]; return !!(a[e.idx >> 3] & (1 << (e.idx & 7))); }
    if (!e.type) return !!((mem.db[e.idx] >> e.bit) & 1);
    return rawGet({ buf: mem.db, at: e.idx }, e.type);
  }
  let dbLive = null;                                   // DB in memoria adesso (null = all'accensione)
  function dbApply(p) {
    const old = dbLive ? mem.db.slice() : null;
    mem.db.fill(0);
    for (const d of (p && p.dbs) || []) {
      mem.db.set(d.init, d.base);
      const o = old && dbLive.find(x => x.number === d.number);
      if (!o) continue;
      for (const f of d.fields) {
        const g = o.fields.find(x => x.crc === f.crc && x.t === f.t);
        if (!g) continue;
        const to = d.base + f.off, from = o.base + g.off;
        if (f.t === 0) { const v = (old[from] >> g.bit) & 1; mem.db[to] = v ? mem.db[to] | (1 << f.bit) : mem.db[to] & ~(1 << f.bit); }
        else mem.db.set(old.subarray(from, from + T_W[f.t]), to);
      }
    }
    dbLive = (p && p.dbs) || [];
  }
  // Memoria di lavoro come nel firmware (uPLC): solo il codice dei blocchi, compattata da sola.
  // localStorage espplc.mock2.heap = dimensione simulata (prove), altrimenti come il bytecode massimo.
  const workSize = () => +(lsGet("heap") || 0) || BYTECODE_MAX;
  const codeSize = p => p ? p.blocks.reduce((s, e) => s + e.size, 0) : 0;
  // byte di codice nuovi: i blocchi uguali a quelli già sul PLC (stesso tipo, numero, CRC) restano dove sono
  function workNeed(bc, old) {
    const dv = new DataView(bc.buffer, bc.byteOffset, bc.byteLength), n = dv.getUint16(0, true);
    let need = 0;
    for (let k = 0; k < n; k++) {
      const a = 4 + 12 * k, type = bc[a], number = dv.getUint16(a + 2, true), size = dv.getUint32(a + 4, true), crc = dv.getUint32(a + 8, true);
      if (!(old && old.blocks.some(o => o.type === type && o.number === number && o.crc === crc))) need += size;
    }
    return need;
  }
  // Patch 'PLCP' (EspPlc::loadPatch): → { prog } | { res: "base"|"nomem"|"bad"|"noprog", fault }
  function applyPatch(u8, old) {
    if (u8.length < HEADER_SIZE) return { res: "bad", fault: "PLC_ERR_BYTECODE_CHECKSUM_FAIL" };
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const h = { magic: dv.getUint32(0, true), version: dv.getUint16(4, true), num_segments: dv.getUint16(6, true),
                total_bytecode: dv.getUint32(8, true), source_size: dv.getUint32(12, true), crc32: dv.getUint32(16, true) };
    if (h.magic !== PATCH_MAGIC || h.version !== VERSION) return { res: "bad", fault: "PLC_ERR_VERSION_MISMATCH" };
    if (u8.length !== HEADER_SIZE + h.total_bytecode + h.source_size) return { res: "bad", fault: "PLC_ERR_BYTECODE_CHECKSUM_FAIL" };
    const tmp = new Uint8Array(u8); new DataView(tmp.buffer).setUint32(16, 0, true);
    if (crc32(tmp) !== h.crc32) return { res: "bad", fault: "PLC_ERR_BYTECODE_CHECKSUM_FAIL" };
    if (!old) return { res: "noprog" };
    const find = (list, e) => list.find(o => o.type === e.type && o.number === e.number && o.crc === e.crc);
    function build(sec, oldList) {
      if (!sec.length) return new Uint8Array(0);
      const sdv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
      const n = sdv.getUint16(0, true), tab = 4 + 12 * n;
      if (tab > sec.length) throw "bad";
      const parts = []; let data = tab, base = false;
      const table = new Uint8Array(sec.subarray(0, tab)), tdv = new DataView(table.buffer);
      for (let k = 0; k < n; k++) {
        const a = 4 + 12 * k;
        const e = { type: sec[a], flags: sec[a + 1], number: sdv.getUint16(a + 2, true), size: sdv.getUint32(a + 4, true), crc: sdv.getUint32(a + 8, true) };
        if (e.flags & 1) {
          if (e.size) throw "bad";
          const o = find(oldList, e);
          if (!o) { base = true; continue; }
          parts.push(o.data); table[a + 1] = e.flags & ~1; tdv.setUint32(a + 4, o.size, true);
        } else {
          if (data + e.size > sec.length) throw "bad";
          parts.push(sec.subarray(data, data + e.size)); data += e.size;
        }
      }
      if (data !== sec.length) throw "bad";
      if (base) throw "base";
      const out = new Uint8Array(tab + parts.reduce((x, y) => x + y.length, 0));
      out.set(table, 0); let o = tab; for (const pp of parts) { out.set(pp, o); o += pp.length; }
      return out;
    }
    let bc, src;
    try {
      bc = build(u8.subarray(HEADER_SIZE, HEADER_SIZE + h.total_bytecode), old.blocks);
      src = build(u8.subarray(HEADER_SIZE + h.total_bytecode), old.srcBlocks || []);
    } catch (e) { return e === "base" ? { res: "base" } : { res: "bad", fault: "PLC_ERR_BAD_BLOCKS" }; }
    if (!bc.length) return { res: "bad", fault: "PLC_ERR_BAD_BLOCKS" };
    if (bc.length > BYTECODE_MAX || HEADER_SIZE + bc.length + src.length > PARTITION_MAX) return { res: "bad", fault: "PLC_ERR_PROGRAM_TOO_LARGE" };
    // memoria di lavoro: i blocchi nuovi devono starci accanto a quelli del programma attuale
    if (workNeed(bc, old) > workSize() - codeSize(old)) return { res: "nomem" };
    const blob = new Uint8Array(HEADER_SIZE + bc.length + src.length), bdv = new DataView(blob.buffer);
    bdv.setUint32(0, MAGIC, true); bdv.setUint16(4, VERSION, true); bdv.setUint16(6, h.num_segments, true);
    bdv.setUint32(8, bc.length, true); bdv.setUint32(12, src.length, true);
    blob.set(bc, HEADER_SIZE); blob.set(src, HEADER_SIZE + bc.length);
    bdv.setUint32(16, crc32(blob), true);
    const r = parseBlob(blob);
    if (r.fault) return { res: "bad", fault: r.fault };
    return { prog: r, blob };
  }
  // per runScanOn (test): sezione bytecode → programma indicizzato (cache)
  const _idx = new WeakMap();
  function progOf(section) {
    let p = _idx.get(section);
    if (!p) { p = indexProg({ bytecode: section, source: new Uint8Array(0) }); _idx.set(section, p); }
    return p;
  }
  function reloadProg() {
    prog = null;
    if (S.ram) { const r = parseBlob(b64decStrict(S.ram) || new Uint8Array(0)); if (!r.fault) prog = r; }
    if (prog) dbApply(prog);
  }

  // ── VM (port di plc_vm_run_scan) ─────────────────────
  const AREA = { 1: "i", 2: "q", 3: "m", 6: "t" };
  let vmMem = mem;                                   // area su cui lavora runScan
  // v4.6: bit di sistema (SM0 primo ciclo, SM1 sempre 1, SM2 sempre 0, SM3/4/5 clock 10/2/1 Hz)
  let firstScan = false;
  const sysBits = () => (firstScan ? 1 : 0) | 2 | (((scanNow / 50) & 1) << 3) | (((scanNow / 250) & 1) << 4) | (((scanNow / 500) & 1) << 5);
  // v4.8: DB (0x16), dati locali della FC in corso (0x17, L) e della FC chiamata / appena tornata (0x18, LN): byte
  let fp = 0, fsz = 0, fpend = 0;                       // pezzo dello stack L della chiamata in corso, prossimo pezzo
  // Online di una FC (/api/plc/fcdata): dati locali copiati alla fine di ogni sua chiamata
  let watchFc = -1, watchBuf = new Uint8Array(0), watchSeq = 0;
  function watchCopy(fc) { if (fc === watchFc && fsz && vmMem === mem) { watchBuf = vmMem.ls.slice(fp, fp + fsz); watchSeq++; } }
  const isMemNs = a => a >= 0x16 && a <= 0x18;
  const T_W = { 1: 2, 2: 2, 3: 4, 4: 4, 5: 4, 6: 1 };
  function memRef(a, off, w) {
    if (a === 0x16) { if (off + w > DB_SIZE) throw "PLC_ERR_INVALID_IO_REF"; return { buf: vmMem.db, at: off }; }
    if (a === 0x17) { if (off + w > fsz) throw "PLC_ERR_INVALID_IO_REF"; return { buf: vmMem.ls, at: fp + off }; }
    const at = fp + fsz + off;
    if (at + w > LS_SIZE) throw "PLC_ERR_INVALID_IO_REF";
    return { buf: vmMem.ls, at };
  }
  const dvOf = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  function rawGet(r, T) {
    const d = dvOf(r.buf);
    switch (T) { case 1: return d.getInt16(r.at, true); case 2: return d.getUint16(r.at, true); case 3: return d.getInt32(r.at, true);
                 case 4: return d.getUint32(r.at, true); case 5: return d.getFloat32(r.at, true); default: return d.getUint8(r.at); }
  }
  function rawSet(r, T, v) {
    const d = dvOf(r.buf);
    switch (T) { case 1: d.setInt16(r.at, v, true); break; case 2: d.setUint16(r.at, v, true); break; case 3: d.setInt32(r.at, v, true); break;
                 case 4: d.setUint32(r.at, v >>> 0, true); break; case 5: d.setFloat32(r.at, v, true); break; default: d.setUint8(r.at, v); }
  }
  function readOp(ns, idx) {
    if (isMemNs(ns)) { const r = memRef(ns, idx >> 3, 1); return ((r.buf[r.at] >> (idx & 7)) & 1) === 1; }
    if (ns === 8) { if (idx > 5) throw "PLC_ERR_INVALID_IO_REF"; return ((sysBits() >> idx) & 1) === 1; }
    if (ns === 7) { if (idx >= 512) throw "PLC_ERR_INVALID_IO_REF"; return getBit(vmMem.e, idx); }   // E: memoria dei fronti
    if (!AREA[ns] || idx > MAX_IDX[ns]) throw "PLC_ERR_INVALID_IO_REF";
    return getBit(vmMem[AREA[ns]], idx);
  }
  function writeOp(ns, idx, v) {
    if (isMemNs(ns)) { const r = memRef(ns, idx >> 3, 1), m = 1 << (idx & 7); r.buf[r.at] = v ? (r.buf[r.at] | m) : (r.buf[r.at] & ~m); return; }
    if (ns === 7) { if (idx >= 512) throw "PLC_ERR_INVALID_IO_REF"; setBit(vmMem.e, idx, v); return; }
    if (ns === 1 || ns === 6 || !AREA[ns] || idx > MAX_IDX[ns]) throw "PLC_ERR_INVALID_IO_REF";   // I, T read-only
    setBit(vmMem[AREA[ns]], idx, v);
  }
  // ── v3.1: istruzioni numeriche (come plc_vm.cpp) ──
  const RANGE = { 1: [-32768, 32767], 2: [0, 65535], 3: [-2147483648, 2147483647], 4: [0, 4294967295], 6: [0, 255] };
  const inRange = (T, v) => v >= RANGE[T][0] && v <= RANGE[T][1];
  const _f32 = new DataView(new ArrayBuffer(4));
  function odSize(code, p, n) {
    if (p >= n) return 0;
    const a = code[p];
    if (a === 0x80) return p + 5 <= n ? 5 : 0;
    if (a >= 0x10 && a <= 0x18) return p + 3 <= n ? 3 : 0;          // 0x10..0x15: aree di prima (errore in esecuzione)
    return 0;
  }
  function opLen(code, pc, n) {
    const op = code[pc];
    let head = 0, nod = 0;
    if (op === 0x70) { head = 4; nod = 2; }
    else if (op === 0x71 || op === 0x77 || op === 0x78) { head = 2; nod = 2; }
    else if (op >= 0x72 && op <= 0x76) { head = 2; nod = 3; }
    else if (op === 0x79) { head = 4; nod = 2; }
    else if (op === 0x7A) { head = 3; nod = 2; }                                      // v4.6
    else if (op === 0x7B || op === 0x7C || (op >= 0x80 && op <= 0x82) || (op >= 0x84 && op <= 0x87)) { head = 2; nod = 3; }
    else if (op === 0x7D) { head = 2; nod = 4; }
    else if (op === 0x7E) { head = 3; nod = 6; }
    else if (op === 0x83 || op === 0x88) { head = 2; nod = 2; }
    else if (op === 0x55 || op === 0x56) { head = 8; nod = 2; }                    // v4.9 CTU / CTD
    else if (op === 0x57) { head = 17; nod = 2; }                                  // v4.9 CTUD
    else {
      const s = op === 0x53 ? 8 : op === 0x54 ? 5 : (op >= 0x50 && op <= 0x52) ? 6 : op === 0x16 ? 2 : (op === 0x60 || op === 0x62 || op === 0x63) ? 3
              : ((op >= 0x10 && op <= 0x15) || (op >= 0x20 && op <= 0x23)) ? 3 : isBit16(op) ? 4
              : (op <= 0x01 || (op >= 0x17 && op <= 0x1C) || op === 0x61 || op === 0x64) ? 1 : op === 0x65 ? 2 : 0;
      return s && pc + s <= n ? s : 0;
    }
    let p = pc + head;
    if (p > n) return 0;
    for (let k = 0; k < nod; k++) { const z = odSize(code, p, n); if (!z) return 0; p += z; }
    return p - pc;
  }
  // → { v, p } ; lancia il fault
  function odRead(code, n, p, T) {
    const z = odSize(code, p, n);
    if (!z) throw "PLC_ERR_INVALID_OPCODE";
    const a = code[p];
    if (a === 0x80) {
      const raw = (code[p + 1] | (code[p + 2] << 8) | (code[p + 3] << 16) | (code[p + 4] << 24)) >>> 0;
      let v;
      if (T === 5) { _f32.setUint32(0, raw, true); v = _f32.getFloat32(0, true); }
      else if (T === 4 || T === 2 || T === 6) v = raw; else v = raw | 0;
      if (T !== 5 && !inRange(T, v)) throw "PLC_ERR_INVALID_OPCODE";
      return { v, p: p + 5 };
    }
    if (!isMemNs(a)) throw "PLC_ERR_INVALID_OPCODE";                    // aree numeriche di prima (tolte)
    return { v: rawGet(memRef(a, code[p + 1] | (code[p + 2] << 8), T_W[T]), T), p: p + 3 };   // v4.8: il tipo lo dà l'istruzione
  }
  function odDest(code, n, p, T) {
    const z = odSize(code, p, n);
    if (!z || !isMemNs(code[p])) throw "PLC_ERR_INVALID_OPCODE";        // costante o area di prima
    return { ref: memRef(code[p], code[p + 1] | (code[p + 2] << 8), T_W[T]), T, p: p + 3 };
  }
  const stDest = (D, v) => rawSet(D.ref, D.T, v);
  // Overflow (come plc_vm.cpp): non è un errore, il risultato ricomincia, ENO = 0
  class Ov { constructor(v) { this.v = v; } }
  function wrapInt(T, z) {
    const b = BigInt(z);
    return T === 1 ? Number(BigInt.asIntN(16, b)) : T === 2 ? Number(BigInt.asUintN(16, b)) : T === 6 ? Number(BigInt.asUintN(8, b))
         : T === 3 ? Number(BigInt.asIntN(32, b)) : Number(BigInt.asUintN(32, b));
  }
  // → valore, oppure lancia "PLC_ERR_DIV_ZERO" / Ov(valore ricominciato) / grave
  function numBox(op, T, x, y) {
    const F = Math.fround;
    if (T === 5) {
      let z;
      switch (op) {
        case 0x71: return x;
        case 0x72: z = F(x + y); break;
        case 0x73: z = F(x - y); break;
        case 0x74: z = F(x * y); break;
        case 0x75: if (y === 0) throw "PLC_ERR_DIV_ZERO"; z = F(x / y); break;
        case 0x77: z = -x; break;
        case 0x78: z = Math.abs(x); break;
        default: throw "PLC_ERR_INVALID_OPCODE";
      }
      if (!isFinite(z)) throw new Ov(z);                 // REAL: ±inf scritto, ENO = 0
      return z;
    }
    let z;
    switch (op) {
      case 0x71: z = x; break;
      case 0x72: z = x + y; break;
      case 0x73: z = x - y; break;
      case 0x74: { const bz = BigInt(x) * BigInt(y); z = Number(bz);       // esatto anche oltre 2^53
                   if (!(bz >= BigInt(RANGE[T][0]) && bz <= BigInt(RANGE[T][1]))) throw new Ov(wrapInt(T, bz)); break; }
      case 0x75: if (y === 0) throw "PLC_ERR_DIV_ZERO"; z = Math.trunc(x / y); break;
      case 0x76: if (y === 0) throw "PLC_ERR_DIV_ZERO"; z = x % y; if (Object.is(z, -0)) z = 0; break;
      case 0x77: if (T === 2 || T === 4 || T === 6) throw "PLC_ERR_INVALID_OPCODE"; z = -x; break;
      case 0x78: if (T === 2 || T === 4 || T === 6) throw "PLC_ERR_INVALID_OPCODE"; z = Math.abs(x); break;
      default: throw "PLC_ERR_INVALID_OPCODE";
    }
    if (!inRange(T, z)) throw new Ov(wrapInt(T, z));
    return z;
  }
  function numConv(Ti, To, trunc, x) {
    if (To === 5) return Math.fround(x);
    let z = x;
    if (Ti === 5) {
      if (!isFinite(x)) throw "PLC_ERR_OVERFLOW";
      z = trunc ? Math.trunc(x) : Math.sign(x) * Math.round(Math.abs(x));
    }
    if (!inRange(To, z)) throw "PLC_ERR_OVERFLOW";
    return z;
  }
  // v4.6: MIN … SWAP (come num_box2 di plc_vm.cpp). → valore, o lancia Keep (OUT invariato, ENO = 0)
  class Keep {}
  const TBITS = { 1: 16, 2: 16, 3: 32, 4: 32, 6: 8 };
  function numBox2(op, T, x, y, z) {
    if (T === 5) {
      if (op === 0x7B) return x < y ? x : y;
      if (op === 0x7C) return x > y ? x : y;
      if (op === 0x7D) { if (x > z) throw new Keep(); return y < x ? x : y > z ? z : y; }
      throw "PLC_ERR_INVALID_OPCODE";
    }
    if (op === 0x7B) return x < y ? x : y;
    if (op === 0x7C) return x > y ? x : y;
    if (op === 0x7D) { if (x > z) throw new Keep(); return y < x ? x : y > z ? z : y; }
    const W = TBITS[T], mask = W === 32 ? 0xFFFFFFFFn : (1n << BigInt(W)) - 1n;
    const u = BigInt(x) & mask, v = BigInt(y) & mask;
    let r;
    switch (op) {
      case 0x80: r = u & v; break;
      case 0x81: r = u | v; break;
      case 0x82: r = u ^ v; break;
      case 0x83: r = ~u & mask; break;
      case 0x88: r = W === 16 ? ((u & 0xFFn) << 8n) | (u >> 8n)
                 : W === 32 ? ((u & 0xFFn) << 24n) | ((u & 0xFF00n) << 8n) | ((u >> 8n) & 0xFF00n) | (u >> 24n) : u; break;
      case 0x84: case 0x85: case 0x86: case 0x87: {
        if (y < 0) throw new Keep();
        if (op === 0x86 || op === 0x87) {
          let n = y % W; if (op === 0x87) n = (W - n) % W;
          const N = BigInt(n);
          r = n ? (((u << N) | (u >> BigInt(W - n))) & mask) : u;
        } else if (op === 0x84) r = y >= W ? 0n : ((u << BigInt(y)) & mask);
        else if (T === 1 || T === 3) r = (BigInt(x) >> BigInt(y >= W ? W - 1 : y)) & mask;
        else r = y >= W ? 0n : (u >> BigInt(y));
        break;
      }
      default: throw "PLC_ERR_INVALID_OPCODE";
    }
    return wrapInt(T, r);
  }
  function numMath(T, fun, x) {
    if (T !== 5 || fun > 1) throw "PLC_ERR_INVALID_OPCODE";
    if (fun === 0) { if (x < 0 || !isFinite(x)) throw new Keep(); return Math.fround(Math.sqrt(x)); }
    const z = Math.fround(x * x);
    if (!isFinite(z)) throw new Ov(z);
    return z;
  }
  // → { v, out } (out = IN fuori campo: limitato, ENO = 0); lancia Keep
  function numScale(Ti, To, a) {
    let [x, x0, x1, y0, y1] = a;
    if (x1 === x0 || !isFinite(x) || !isFinite(x0) || !isFinite(x1)) throw new Keep();
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    let out = false;
    if (x < lo) { x = lo; out = true; }
    if (x > hi) { x = hi; out = true; }
    const y = (x - x0) * (y1 - y0) / (x1 - x0) + y0;
    let v;
    if (To === 5) { v = Math.fround(y); if (!isFinite(v)) throw new Keep(); }
    else { v = Math.sign(y) * Math.round(Math.abs(y)); if (Object.is(v, -0)) v = 0; if (!inRange(To, v)) throw new Keep(); }
    return { v, out };
  }
  const numCmp = (c, x, y) => c === 0 ? x === y : c === 1 ? x !== y : c === 2 ? x < y : c === 3 ? x > y : c === 4 ? x <= y : x >= y;
  const isBit16 = op => (op >= 0x30 && op <= 0x35) || (op >= 0x40 && op <= 0x43);
  // Timer IEC. IN = valore in cima allo stack, ritorna Q. now = ms di inizio scansione.
  //  TON: Q=1 se IN è 1 da almeno PT; IN=0 azzera.
  //  TOF: Q=1 con IN; dopo la discesa di IN resta 1 per PT.
  //  TP : fronte di salita di IN → Q=1 per PT, non riarmabile.
  function timerStep(t, kind, IN, pt, now) {
    const el = () => (now - t.start) >>> 0;
    if (kind === 0x50) {                                   // TON
      if (IN) { if (!t.prev) t.start = now; t.q = el() >= pt; t.run = !t.q; }
      else { t.q = false; t.run = false; }
    } else if (kind === 0x51) {                            // TOF
      if (IN) { t.q = true; t.run = false; }
      else {
        if (t.prev) { t.start = now; t.run = true; }
        if (t.run && el() >= pt) t.run = false;
        t.q = t.run;
      }
    } else {                                               // TP
      if (IN && !t.prev && !t.run) { t.start = now; t.run = true; }
      if (t.run && el() >= pt) t.run = false;
      t.q = t.run;
    }
    t.prev = IN; t.kind = kind; t.pt = pt;
    return t.q;
  }
  function timerET(t, now) {
    const el = Math.min((now - t.start) >>> 0, t.pt);
    if (t.kind === 0x50) return t.prev ? el : 0;
    if (t.kind === 0x51) return t.run ? el : 0;
    return t.run ? el : (t.prev && t.pt ? t.pt : 0);
  }

  let scanNow = 0;
  const CALL_DEPTH = 8;
  let lastFcExec = [];            // numeri delle FC eseguite nell'ultima scansione
  const fcEno = {};               // v4.8: ENO dell'ultima chiamata di ogni FC
  function runScan(p, startPc) {
    const code = p.code, fcOff = p.fcOff;
    const stack = [], calls = [], entered = []; let instr = 0, pc = startPc || 0; const n = code.length;
    fp = 0; fsz = 0; fpend = 0;
    let opPc = 0, eno = true;                           // v4.8: ENO della FC in corso
    const F = f => ({ fault: f, instr, pc: opPc });
    const unwindParts = () => { while (calls.length && calls[calls.length - 1].part) calls.pop(); };   // RET in un pezzo: esce dal blocco
    while (pc < n) {
      const top = calls[calls.length - 1];
      if (top && top.part && pc >= top.end) { calls.pop(); pc = top.pc; continue; }   // fine di un pezzo: si torna dopo la CALLP
      if (++instr > MAX_INSTR && MAX_INSTR) return F("PLC_ERR_INSTRUCTION_LIMIT");
      opPc = pc;
      let op = code[pc++];
      if (op === 0x00) continue;
      if (op === 0x01) break;
      if (op === 0x16) {
        if (pc + 1 > n) return F("PLC_ERR_INVALID_OPCODE");
        const v = code[pc++];
        if (v > 1) return F("PLC_ERR_INVALID_OPCODE");
        if (stack.length >= VM_STACK) return F("PLC_ERR_STACK_OVERFLOW");
        stack.push(v !== 0); continue;
      }
      if (op === 0x61) {                                  // RET: fine funzione
        unwindParts();
        if (!calls.length) break;                         // (fuori da una chiamata = fine)
        const c = calls.pop(); watchCopy(c.fc); if (vmMem === mem) fcEno[c.fc] = eno; pc = c.pc; stack.length = c.sp; fp = c.fp; fsz = c.fsz;
        if (stack.length) stack[stack.length - 1] = eno;  // v4.8: ENO della chiamata
        eno = c.eno; continue;
      }
      if (op === 0x62) {                                  // v4.8 FRAME n16: prepara (a zero) i dati locali della prossima FC
        if (pc + 2 > n) return F("PLC_ERR_INVALID_OPCODE");
        const sz = code[pc] | (code[pc + 1] << 8); pc += 2;
        const at = fp + fsz;
        if (at + sz > LS_SIZE) return F("PLC_ERR_STACK_OVERFLOW");
        vmMem.ls.fill(0, at, at + sz); fpend = sz;
        continue;
      }
      if (op === 0x65) {                                  // v4.8 bobina ENO (neg: ENO negato)
        if (pc + 1 > n) return F("PLC_ERR_INVALID_OPCODE");
        const neg = code[pc++];
        if (neg > 1) return F("PLC_ERR_INVALID_OPCODE");
        if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
        const b = stack.pop();
        if (calls.length) eno = neg ? !b : b;
        continue;
      }
      if (op === 0x1C) {                                  // v4.6 NOT
        if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
        stack[stack.length - 1] = !stack[stack.length - 1]; continue;
      }
      if (op === 0x64) {                                  // v4.6 RET condizionato (bobina RET)
        if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
        if (!stack.pop()) continue;
        unwindParts();
        if (!calls.length) break;
        const c = calls.pop(); watchCopy(c.fc); if (vmMem === mem) fcEno[c.fc] = eno; pc = c.pc; stack.length = c.sp; fp = c.fp; fsz = c.fsz;
        if (stack.length) stack[stack.length - 1] = eno;  // v4.8: ENO della chiamata
        eno = c.eno; continue;
      }
      if (op === 0x63) {                                  // CALLP: pezzo di un blocco grande, sempre, stessi dati locali
        if (pc + 2 > n) return F("PLC_ERR_INVALID_OPCODE");
        const nr = code[pc] | (code[pc + 1] << 8); pc += 2;
        if (calls.length >= CALL_DEPTH) return F("PLC_ERR_STACK_OVERFLOW");
        const t = fcOff.get(nr);
        if (t === undefined) return F("PLC_ERR_INVALID_OPCODE");
        calls.push({ pc, part: true, end: p.fcEnd.get(nr) }); pc = t;
        continue;
      }
      if (op === 0x60) {                                  // CALL numero FC (v3): salta se EN = top = 1
        if (pc + 2 > n) return F("PLC_ERR_INVALID_OPCODE");
        const fc = code[pc] | (code[pc + 1] << 8); pc += 2;
        if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
        if (stack[stack.length - 1]) {
          if (calls.length >= CALL_DEPTH) return F("PLC_ERR_STACK_OVERFLOW");
          const t = fcOff.get(fc);
          if (t === undefined) return F("PLC_ERR_INVALID_OPCODE");
          calls.push({ pc, sp: stack.length, fp, fsz, fc, eno }); pc = t; eno = true;
          fp += fsz; fsz = fpend; fpend = 0;              // v4.8: i dati locali preparati da FRAME diventano quelli della FC
          if (!entered.includes(fc)) entered.push(fc);
        }
        fpend = 0;
        continue;
      }
      // ── v4.9: contatori (come plc_vm.cpp): CU / CD = corrente; Q al posto di CU ──
      if (op >= 0x55 && op <= 0x57) {
        const at = pc - 1, len = opLen(code, at, n);
        if (!len) return F("PLC_ERR_INVALID_OPCODE");
        if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
        const T = code[pc];
        if (T < 1 || T > 6 || T === 5) return F("PLC_ERR_INVALID_OPCODE");
        try {
          const bitIn = q => code[q] ? !!readOp(code[q], code[q + 1] | (code[q + 2] << 8)) : false;
          const rise = (q, IN) => {
            const mns = code[q], mi = code[q + 1] | (code[q + 2] << 8);
            if (mns !== 7 && mns !== 3) throw "PLC_ERR_INVALID_OPCODE";
            const prev = readOp(mns, mi); writeOp(mns, mi, IN); return IN && !prev;
          };
          const cu = stack[stack.length - 1];
          let cd = false, r = false, ld = false, up = false, dn = false, p = pc + 1;
          if (op === 0x57) { cd = bitIn(p); r = bitIn(p + 3); ld = bitIn(p + 6); up = rise(p + 9, cu); dn = rise(p + 12, cd); p += 15; }
          else { if (op === 0x55) r = bitIn(p); else ld = bitIn(p); if (op === 0x55) up = rise(p + 3, cu); else dn = rise(p + 3, cu); p += 6; }
          const PV = odRead(code, n, p, T), CV = odRead(code, n, PV.p, T), D = odDest(code, n, PV.p, T);
          const lo = (T === 2 || T === 4 || T === 6) ? 0 : T === 1 ? -32768 : -2147483648;
          const hi = T === 1 ? 32767 : T === 2 ? 65535 : T === 6 ? 255 : T === 3 ? 2147483647 : 4294967295;
          let cv = CV.v;
          if (r) cv = 0;
          else if (ld) cv = PV.v;
          else { if (up && cv < hi) cv++; if (dn && cv > lo) cv--; }
          stDest(D, cv);
          stack[stack.length - 1] = op === 0x56 ? cv <= 0 : cv >= PV.v;
        } catch (f) { return F(typeof f === "string" ? f : "PLC_ERR_INVALID_OPCODE"); }
        pc = at + len; continue;
      }
      // ── v3.1: fronti, confronti, box numerici ──
      if (op === 0x53 || op === 0x54 || (op >= 0x70 && op <= 0x88)) {
        const at = pc - 1, len = opLen(code, at, n);
        if (!len) return F("PLC_ERR_INVALID_OPCODE");
        try {
          if (op === 0x53 || op === 0x54) {
            const mb = code[pc], mode = mb & 0x0F, fall = (mb & 0x10) !== 0;
            let IN, mp;
            if (op === 0x53) {
              if (mode > 2) return F("PLC_ERR_INVALID_OPCODE");
              IN = readOp(code[pc + 1], code[pc + 2] | (code[pc + 3] << 8)); mp = pc + 4;
            } else {
              if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
              IN = stack[stack.length - 1]; mp = pc + 1;
            }
            const mns = code[mp], midx = code[mp + 1] | (code[mp + 2] << 8);
            if (mns !== 7 && mns !== 3) return F("PLC_ERR_INVALID_OPCODE");
            const prev = readOp(mns, midx);
            writeOp(mns, midx, IN);
            const res = fall ? (!IN && prev) : (IN && !prev);
            if (op === 0x54) stack[stack.length - 1] = res;
            else if (mode === 0) { if (stack.length >= VM_STACK) return F("PLC_ERR_STACK_OVERFLOW"); stack.push(res); }
            else { if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW"); const t = stack.length - 1; stack[t] = mode === 1 ? (stack[t] && res) : (stack[t] || res); }
            pc = at + len; continue;
          }
          if (op === 0x70) {
            const mode = code[pc], T = code[pc + 1], c = code[pc + 2];
            if (mode > 2 || T < 1 || T > 6 || c > 5) return F("PLC_ERR_INVALID_OPCODE");
            const A = odRead(code, n, pc + 3, T), B = odRead(code, n, A.p, T);
            const res = numCmp(c, A.v, B.v);
            if (mode === 0) { if (stack.length >= VM_STACK) return F("PLC_ERR_STACK_OVERFLOW"); stack.push(res); }
            else { if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW"); const t = stack.length - 1; stack[t] = mode === 1 ? (stack[t] && res) : (stack[t] || res); }
            pc = at + len; continue;
          }
          if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
          if (!stack[stack.length - 1]) { pc = at + len; continue; }     // EN = 0
          let D, r, keep = op === 0x79, scaleOut = false;
          try {
            if (op === 0x7E) {                                // v4.6 SCALE
              const Ti = code[pc], To = code[pc + 1];
              if (Ti < 1 || Ti > 6 || To < 1 || To > 6) return F("PLC_ERR_INVALID_OPCODE");
              let q = pc + 2; const v = [];
              for (let k = 0; k < 5; k++) { const A = odRead(code, n, q, k < 3 ? Ti : To); v.push(A.v); q = A.p; }
              D = odDest(code, n, q, To);
              const R = numScale(Ti, To, v); r = R.v; scaleOut = R.out;
            } else if (op === 0x7A) {                         // v4.6 SQRT / SQR
              const T = code[pc], fun = code[pc + 1];
              if (T < 1 || T > 6) return F("PLC_ERR_INVALID_OPCODE");
              const A = odRead(code, n, pc + 2, T); D = odDest(code, n, A.p, T);
              r = numMath(T, fun, A.v);
            } else if (op >= 0x7B) {                          // v4.6 MIN … SWAP
              const T = code[pc];
              if (T < 1 || T > 6) return F("PLC_ERR_INVALID_OPCODE");
              const nin = (op === 0x83 || op === 0x88) ? 1 : op === 0x7D ? 3 : 2;
              const A = odRead(code, n, pc + 1, T), B = nin >= 2 ? odRead(code, n, A.p, T) : null, C = nin >= 3 ? odRead(code, n, B.p, T) : null;
              D = odDest(code, n, (C || B || A).p, T);
              r = numBox2(op, T, A.v, B ? B.v : 0, C ? C.v : 0);
            } else if (op === 0x79) {
              const Ti = code[pc], To = code[pc + 1], tr = code[pc + 2];
              if (Ti < 1 || Ti > 6 || To < 1 || To > 6 || tr > 1) return F("PLC_ERR_INVALID_OPCODE");
              const A = odRead(code, n, pc + 3, Ti); D = odDest(code, n, A.p, To);
              r = numConv(Ti, To, tr, A.v);
            } else {
              const T = code[pc];
              if (T < 1 || T > 6) return F("PLC_ERR_INVALID_OPCODE");
              const two = op >= 0x72 && op <= 0x76;
              const A = odRead(code, n, pc + 1, T), B = two ? odRead(code, n, A.p, T) : null;
              D = odDest(code, n, two ? B.p : A.p, T);
              r = numBox(op, T, A.v, two ? B.v : 0);
            }
            stDest(D, r);
            if (scaleOut) stack[stack.length - 1] = false;
          } catch (f) {
            if (f instanceof Keep) { stack[stack.length - 1] = false; pc = at + len; continue; }   // OUT invariato, ENO = 0
            if (f instanceof Ov) {                           // overflow: box → risultato ricominciato; CONV → invariato
              if (!keep) stDest(D, f.v);
              stack[stack.length - 1] = false; pc = at + len; continue;
            }
            if (f === "PLC_ERR_OVERFLOW") { stack[stack.length - 1] = false; pc = at + len; continue; }   // CONV fuori campo
            if (f !== "PLC_ERR_DIV_ZERO") throw f;
            // errore software: diagnostica; STOP (default) oppure ENO = 0 e risultato invariato
            if (p.blocks) { const L = locate(p, at); diagReport(FAULT_CODE[f], L.blk, L.off, true); }
            stack[stack.length - 1] = false;
          }
          pc = at + len; continue;
        } catch (f) { return F(String(f)); }
      }
      if (op === 0x1B) {                                  // OVER
        if (stack.length < 2 || stack.length >= VM_STACK) return F("PLC_ERR_STACK_OVERFLOW");
        stack.push(stack[stack.length - 2]); continue;
      }
      if (op >= 0x50 && op <= 0x52) {                     // TON TOF TP  idx PT32
        if (pc + 5 > n) return F("PLC_ERR_INVALID_OPCODE");
        const idx = code[pc], pt = (code[pc + 1] | (code[pc + 2] << 8) | (code[pc + 3] << 16) | (code[pc + 4] << 24)) >>> 0;
        pc += 5;
        if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
        const q = timerStep(vmMem.tm[idx], op, stack[stack.length - 1], pt, scanNow);
        setBit(vmMem.t, idx, q);
        stack[stack.length - 1] = q;
        continue;
      }
      // Blocchi e diramazioni (1 byte, nessun operando) — proposta firmware v2.2
      if (op >= 0x17 && op <= 0x1A) {
        if (op === 0x17 || op === 0x18) {                 // ANB / ORB
          if (stack.length < 2) return F("PLC_ERR_STACK_OVERFLOW");
          const b = stack.pop(), t = stack.length - 1;
          stack[t] = (op === 0x17) ? (stack[t] && b) : (stack[t] || b);
        } else if (op === 0x19) {                         // DUP
          if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
          if (stack.length >= VM_STACK) return F("PLC_ERR_STACK_OVERFLOW");
          stack.push(stack[stack.length - 1]);
        } else {                                          // POP
          if (!stack.length) return F("PLC_ERR_STACK_OVERFLOW");
          stack.pop();
        }
        continue;
      }
      let ns, idx;
      if (isBit16(op)) {
        if (pc + 3 > n) return F("PLC_ERR_INVALID_OPCODE");
        ns = code[pc++]; idx = code[pc++] | (code[pc++] << 8); op -= 0x20;
      } else {
        if (pc + 2 > n) return F("PLC_ERR_INVALID_OPCODE");
        ns = code[pc++]; idx = code[pc++];
      }
      try {
        const top = stack.length - 1;
        switch (op) {
          case 0x10: case 0x11:
            if (stack.length >= VM_STACK) return F("PLC_ERR_STACK_OVERFLOW");
            { const v = readOp(ns, idx); stack.push(op === 0x11 ? !v : v); } break;
          case 0x12: case 0x13: case 0x14: case 0x15: {
            if (top < 0) return F("PLC_ERR_STACK_OVERFLOW");
            let v = readOp(ns, idx); if (op === 0x13 || op === 0x15) v = !v;
            stack[top] = (op <= 0x13) ? (stack[top] && v) : (stack[top] || v); break;
          }
          case 0x20: case 0x21:
            if (top < 0) return F("PLC_ERR_STACK_OVERFLOW");
            writeOp(ns, idx, op === 0x21 ? !stack[top] : stack[top]); break;
          case 0x22: case 0x23:
            if (top < 0) return F("PLC_ERR_STACK_OVERFLOW");
            if (stack[top]) writeOp(ns, idx, op === 0x22); break;
          default: return F("PLC_ERR_INVALID_OPCODE");
        }
      } catch (f) { return F(String(f)); }
    }
    if (vmMem === mem) lastFcExec = entered;
    return { fault: null, instr, entered };
  }

  function applyInputs() {
    for (let i = 0; i < N_IN; i++) setBit(mem.i, i, !!(inputs & (1 << i)));
  }
  const safeState = () => { for (let i = 0; i < N_OUT; i++) setBit(mem.q, i, false); };

  // Fasi di avvio, controlli ed errori di sistema SF (come plc_boot.cpp): GET /api/plc/boot,
  // "sf" in /api/plc/status. Il PLC va in RUN, SF resta acceso finché la causa c'è.
  let bootReport = null, netWatch = null, sfList = [], bootQuiet = false;   // quiet: apertura della pagina (niente voci nel log)
  // plcNet = la rete usata dal programma del PLC ha l'IP (separata da "offline", che spegne l'API)
  let plcNet = lsGet("plcnet") !== "0";
  function setSf(code, on, text) {
    const k = sfList.findIndex(x => x.code === code);
    if (on && k < 0) { sfList.push({ code, text, since: performance.now() }); if (!bootQuiet) logAdd(1, 10, code); }
    else if (on) sfList[k].text = text;
    else if (k >= 0) { sfList.splice(k, 1); logAdd(1, 11, code); }
  }
  const sfJson = () => sfList.map(x => ({ code: x.code, text: x.text, age_ms: Math.round(performance.now() - x.since) }));
  function netLoop() {                                     // PlcBoot::loop
    if (performance.now() - (netLoop.t || 0) > 250) {   // errori del programma in corso → SF (si spegne da solo)
      netLoop.t = performance.now();
      if (!diagDirty) diag = null;                       // rilegge (un'altra scheda può averla cambiata)
      diagTick();
      const n = diagLoad().filter(x => x.active).length;
      if (n) setSf(10, true, `errore nel programma in corso: ${n} (Errori del programma)`); else setSf(10, false);
    }
    if (!netWatch) return;
    const now = performance.now();
    if (plcNet) {
      if (!netWatch.seen) { netWatch.seen = true; netWatch.first = Math.round(now - netWatch.t0);
        bootReport.checks.push({ code: 0, sev: "info", phase: "PLC", text: `rete del PLC (${netWatch.need}) pronta dopo ${netWatch.first} ms` }); }
      setSf(9, false);
    } else if (netWatch.seen || now - netWatch.t0 >= netWatch.grace)
      setSf(9, true, netWatch.seen ? `rete del PLC (${netWatch.need}) caduta` : `rete del PLC (${netWatch.need}) assente dopo ${netWatch.grace / 1000} s`);
  }
  function makeBootReport() {
    const ETH = [0, 18, 19, 21, 22, 23, 25, 26, 27];
    const nn = Object.assign(NET_DEF(), setActive.net || {});
    const ph = [["MCU", 0], ["Impostazioni e I/O", 212], ["Bus I2C / SPI", 248], ["Comunicazione", 251], ["PLC", 433]];
    const checks = [{ code: 0, sev: "info", phase: "Bus I2C / SPI", text: "nessun dispositivo I2C / SPI configurato" }];
    sfList = [];
    (netActive.eth.on ? setActive.inputs.concat(setActive.outputs) : []).filter(g => ETH.includes(g)).forEach(g => {
      const text = `GPIO ${g} e' un I/O del PLC ma serve all'Ethernet`, sev = nn.need === "eth" ? "error" : "warn";
      checks.push({ code: 2, sev, phase: "Comunicazione", text });
      if (sev === "error") setSf(2, true, text); else if (!bootQuiet) logAdd(1, 9, 2);
    });
    if (netActive.wifi.on && netActive.ap.pass === AP_PASS_DEFAULT) {
      checks.push({ code: 12, sev: "warn", phase: "Impostazioni e I/O", text: "access point con la password di fabbrica: cambiala nelle impostazioni di rete" });
      if (!bootQuiet) logAdd(1, 9, 12);
    }
    if ((nn.need === "eth" && !netActive.eth.on) || (nn.need === "wifi" && !(netActive.wifi.on && netActive.sta.on)) || (nn.need === "any" && !netActive.eth.on && !(netActive.wifi.on && netActive.sta.on))) {
      const text = "il PLC usa una rete che nelle impostazioni di rete e' spenta";
      checks.push({ code: 9, sev: "error", phase: "Impostazioni e I/O", text }); setSf(9, true, text);
    }
    if (!prog) checks.push({ code: 0, sev: "info", phase: "PLC", text: "nessun programma in flash: aspetta un Download" });
    netWatch = nn.need === "none" ? null
      : { need: { eth: "Ethernet", wifi: "WiFi", any: "Ethernet o WiFi" }[nn.need], grace: nn.wait_s * 1000, t0: performance.now(), seen: false };
    const R = { phases: ph.map(([name, ms]) => ({ name, ms })), checks, done: true, plc_run: !!prog, done_ms: 441 };
    Object.defineProperty(R, "sf", { enumerable: true, get: sfJson });
    if (netWatch) Object.defineProperty(R, "net", { enumerable: true,
      get: () => Object.assign({ need: netWatch.need, grace_s: netWatch.grace / 1000, up: plcNet }, netWatch.seen ? { first_ms: netWatch.first } : {}) });
    return R;
  }
  // StartUp: una scansione al passaggio in RUN (avvio, STOP→RUN, reset fault)
  // e dopo un download completo; non dopo la patch in RUN (come plc_task.cpp)
  let wasRunning = false, suPending = false, faultOn = false;
  const su = { count: 0, at: 0, us: 0, fault: 0 };
  // Il timer del browser non scende sotto ~4 ms (e in una scheda in secondo piano molto di più):
  // con un setInterval per scansione, a 1 ms si arrivava a ~250-330 scansioni al secondo invece di 1000.
  // Ora a ogni giro si fanno TUTTE le scansioni dovute dall'ultimo giro, ognuna col suo istante
  // (scanNow = l'istante in cui la farebbe il PLC vero): cadenza giusta e timer giusti.
  let nextScanAt = 0;
  const SCAN_BACKLOG_MS = 1000;                            // più indietro di così (scheda in pausa): si riparte da ora
  function scanTick() {
    applyInputs();
    netLoop();
    const now = performance.now(), per = Math.max(1, CFG.scanMs);
    if (!nextScanAt || now - nextScanAt > SCAN_BACKLOG_MS) nextScanAt = now;
    while (nextScanAt <= now) { scanOnce(nextScanAt); nextScanAt += per; }
  }
  function scanOnce(at) {
    const runningNow = S.state === "running" && !!prog;
    const first = runningNow && (!wasRunning || suPending);
    wasRunning = runningNow; suPending = false;
    if (!runningNow) return;
    if (faultOn) {                                         // errore che persiste: subito di nuovo STOP per errore
      stats.scan_overrun_count++; S.state = "fault"; S.fault = "PLC_ERR_SCAN_OVERRUN"; resetTimers(mem); safeState(); saveState();
      logAdd(3, 1, stats.scan_count); wasRunning = false; return;
    }
    scanNow = Math.floor(at) >>> 0;
    const doSu = first && prog.suOff >= 0;
    if (first) firstScan = true;                           // SM0: StartUp e primo Main
    const r = runScan(prog, doSu ? prog.suOff : 0);
    if (!doSu) firstScan = false;
    const us = Math.round(90 + r.instr * 1.7 + Math.random() * 25);
    if (doSu) { su.count++; su.at = performance.now(); su.us = us; su.fault = FAULT_CODE[r.fault] || 0; logAdd(2, 6, us); }
    stats.scan_count++;
    stats.scan_avg_us = stats.scan_avg_us ? Math.round(stats.scan_avg_us + (us - stats.scan_avg_us) / 8) : us;
    statScan(us);                                          // min / max recenti e dell'ora, come il firmware
    if (stats.rollback > 0) stats.rollback--;
    if (r.fault && !r.reported) { const L = locate(prog, r.pc); diagReport(FAULT_CODE[r.fault] || 0, L.blk, L.off, false); }
    diagFlush();
    if (r.fault) { S.state = "fault"; S.fault = r.fault; safeState(); saveState(); pushLog("VM fault: " + r.fault); wasRunning = false;
                   logAdd(3, FAULT_CODE[r.fault] || 0, stats.scan_count); }
  }

  const FAULT_CODE = { PLC_OK: 0, PLC_ERR_SCAN_OVERRUN: 1, PLC_ERR_INSTRUCTION_LIMIT: 2, PLC_ERR_INVALID_OPCODE: 3,
    PLC_ERR_STACK_OVERFLOW: 4, PLC_ERR_DIV_ZERO: 5, PLC_ERR_INVALID_IO_REF: 6, PLC_ERR_BYTECODE_CHECKSUM_FAIL: 7,
    PLC_ERR_VERSION_MISMATCH: 8, PLC_ERR_NVS_LOAD_FAIL: 9, PLC_ERR_PROGRAM_TOO_LARGE: 10, PLC_ERR_BAD_BLOCKS: 11,
    PLC_ERR_OVERFLOW: 12 };
  // ── Log a ricircolo (come EspPlcLib/plc_log + plc_logstore.cpp) ──
  // Voce = [seq, t, id, sub, val]; t = secondi unix. Salvato nel browser = "SPIFFS".
  const LOG_MIN = 512, LOG_MAX = 32768, LOG_DEF = 2048;
  function logLoad() {
    let L = null;
    try { L = JSON.parse(lsGet("plclog") || "null"); } catch (e) {}
    return L && Array.isArray(L.e) ? L : { cap: LOG_DEF / 16, seq: 0, e: [] };
  }
  function logAdd(id, sub, val) {
    const L = logLoad(), t = Math.floor(Date.now() / 1000);
    // più schede = più PLC simulati sullo stesso log: lo stesso evento SF/errore entro 3 s è uno solo
    if ((id === 1 || id === 9) && L.e.slice(-8).some(x => x[2] === id && x[3] === sub && x[4] === (val >>> 0) && t - x[1] <= 3)) return;
    L.e.push([++L.seq, Math.floor(Date.now() / 1000), id, sub, (val >>> 0)]);
    if (L.e.length > L.cap) L.e.splice(0, L.e.length - L.cap);
    lsSet("plclog", JSON.stringify(L));
  }
  // ── Diagnostica errori del programma (come plc_diag.cpp) ──
  const DIAG_MAX = 16, DIAG_REPEAT_S = 60;
  let diag = null, diagDirty = false;
  function diagLoad() { if (!diag) { try { diag = JSON.parse(lsGet("diag") || "[]"); } catch (e) { diag = []; } } return diag; }
  // come plc_diag.cpp: sw = errore software (il PLC continua) → "in corso" finché si ripete, poi "terminato"
  const DIAG_ACTIVE_MS = 2000;
  function diagReport(code, blk, off, sw) {
    const D = diagLoad(), now = Math.floor(Date.now() / 1000), where = ((blk << 16) | (off & 0xFFFF)) >>> 0;
    let e = D.find(x => x.code === code && x.blk === blk && x.off === off), sub = -1;
    if (!e) {
      if (D.length >= DIAG_MAX) { let k = 0; D.forEach((x, i) => { if ((x.active ? 1 : 0) < (D[k].active ? 1 : 0) || (!!x.active === !!D[k].active && x.last < D[k].last)) k = i; }); D.splice(k, 1); }
      e = { code, blk, off, count: 0, first: now, last: now, logged: now }; D.push(e); sub = code;
    } else if (sw && !e.active) { e.logged = now; sub = code; }
    else if (sw && now - e.logged >= DIAG_REPEAT_S) { e.logged = now; sub = code | 0x100; }
    else if (!sw) { e.logged = now; sub = code; }
    e.count++; e.last = now; e.last_ms = Date.now(); e.sw = !!sw; e.active = !!sw; diagDirty = true;
    if (sub >= 0) logAdd(9, sub, where);
  }
  function diagTick() {                              // plc_diag_tick: errori che non si ripetono più → terminati
    const D = diagLoad(), t = Date.now();
    for (const e of D) if (e.active && t - (e.last_ms || 0) >= DIAG_ACTIVE_MS) {
      e.active = false; diagDirty = true; logAdd(9, e.code | 0x200, ((e.blk << 16) | (e.off & 0xFFFF)) >>> 0);
    }
  }
  let diagSaved = 0;
  function diagFlush(force) {                       // al massimo una scrittura al secondo
    if (!diagDirty || (!force && Date.now() - diagSaved < 1000)) return;
    diagDirty = false; diagSaved = Date.now(); lsSet("diag", JSON.stringify(diag));
  }
  function locate(p, pc) {
    let k = 0;
    p.blocks.forEach((b, i) => { if (b.off <= pc) k = i; });
    return { blk: k === 0 ? 0 : p.blocks[k].type === 2 ? 0xFFFF : p.blocks[k].number, off: pc - p.blocks[k].off };
  }
  const ipNum = ip => ip.split(".").reduce((a, x, i) => a + (+x << (8 * i)), 0) >>> 0;   // come IPAddress → uint32 (little endian)

  // ── JSON come plc_rest.cpp ───────────────────────────
  // CRC del solo bytecode (status.bc_crc32): calcolato una volta per programma
  let bcCrcFor = null, bcCrc = 0, srcCrc = 0;
  function progCrc() {
    if (!prog) return {};
    if (bcCrcFor !== prog) { bcCrc = crc32(prog.bytecode); srcCrc = crc32(prog.source); bcCrcFor = prog; }
    return { crc32: prog.header.crc32, bc_crc32: bcCrc, src_crc32: srcCrc };
  }
  // Postazioni collegate (come plc_rest.cpp): ?sid=…&on=… nel polling di /status.
  // Condivise tra le schede del browser (localStorage) = più PC sullo stesso PLC.
  // Nel simulatore ogni editor è sullo stesso PC: IP 127.0.0.1 (niente indirizzi inventati)
  const fakeIp = () => "127.0.0.1";
  function clientsJson(q) {
    let cl = {};
    try { cl = JSON.parse(lsGet("clients") || "{}") || {}; } catch (e) {}
    const now = Date.now();
    const sid = q && (q.get("sid") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 16);
    if (sid) { cl[sid] = { ip: fakeIp(sid), on: q.get("on") === "1" ? 1 : 0, t: now }; }
    for (const k of Object.keys(cl)) if (now - cl[k].t > 10000) delete cl[k];
    if (sid) lsSet("clients", JSON.stringify(cl));
    const out = { clients: Object.entries(cl).map(([k, c]) => ({ sid: k, ip: c.ip, on: c.on, age: now - c.t })) };
    if (S.last_dl) out.last_dl = { sid: S.last_dl.sid, ip: S.last_dl.ip, age_s: Math.floor((now - S.last_dl.t) / 1000) };
    return out;
  }
  // v4.2: statistiche come il firmware: secondi a giro (ultimi 6) e minuti a giro (ultima ora)
  const ST = { sec: [], min: [], s0: -1e9, m0: -1e9, perLast: 0, lastUs: 0 };
  function stAdvance(now) {
    const s = Math.floor(now / 1000), m = Math.floor(now / 60000);
    for (let k = Math.min(6, s - ST.s0); k > 0; k--) ST.sec.unshift({ mn: Infinity, mx: 0, sum: 0, cmx: 0, cmn: Infinity });   // secondi passati (anche vuoti)
    for (let k = Math.min(60, m - ST.m0); k > 0; k--) ST.min.unshift({ mx: 0, cmx: 0 });
    ST.s0 = s; ST.m0 = m; ST.sec.length = Math.min(ST.sec.length, 6); ST.min.length = Math.min(ST.min.length, 60);
  }
  function statScan(us) {
    stAdvance(performance.now());
    const b = ST.sec[0], h = ST.min[0];
    ST.lastUs = us; b.mn = Math.min(b.mn, us); b.mx = Math.max(b.mx, us); b.sum += us; h.mx = Math.max(h.mx, us);
    const per = Math.round(Math.max(CFG.scanMs * 1000, us + 1000) + Math.random() * 300);          // ciclo: lettura ingressi → lettura ingressi
    ST.perLast = per; b.cmx = Math.max(b.cmx, per); b.cmn = Math.min(b.cmn, per); h.cmx = Math.max(h.cmx, per);
    stats.scan_max_us = Math.max(...ST.sec.map(x => x.mx));
  }
  function cycleJson() {
    stAdvance(performance.now());
    const mn = Math.min(...ST.sec.map(x => x.mn)), run = S.state === "running";
    return { last_us: run ? ST.lastUs : 0, min_us: isFinite(mn) ? mn : 0, max_us: Math.max(0, ...ST.sec.map(x => x.mx)),
             max_h_us: Math.max(0, ...ST.min.map(x => x.mx)), per_us: run ? ST.perLast : 0,
             per_min_us: (v => isFinite(v) ? v : 0)(Math.min(...ST.sec.map(x => x.cmn))), per_max_us: Math.max(0, ...ST.sec.map(x => x.cmx)), per_max_h_us: Math.max(0, ...ST.min.map(x => x.cmx)),
             load: loadPct(), wd_ms: (setActive.cycle || CYC_DEF()).input_wd_ms,
             // v4.8 (plc_core.cpp): nessuna scrittura in flash nel simulatore; statistiche dall'apertura della pagina
             flash: 0, since_ms: Math.round(performance.now()), temp_c: Math.round((48 + 4 * Math.sin(performance.now() / 60000)) * 10) / 10, max_h_nf_us: Math.max(0, ...ST.min.map(x => x.mx)), per_max_h_nf_us: Math.max(0, ...ST.min.map(x => x.cmx)) };
  }
  const loadPct = () => ST.sec[1] ? Math.min(100, Math.floor(ST.sec[1].sum / 10000)) : 0;
  function statusJson(q) {
    return Object.assign(progCrc(), {
      state: S.state, running: S.state === "running", fault: S.fault, dirty: S.dirty,
      scan_count: stats.scan_count, scan_avg_us: stats.scan_avg_us, scan_max_us: stats.scan_max_us,
      scan_overrun_count: stats.scan_overrun_count, load: loadPct(),
      last_persist_unix: S.last_persist_unix, last_test_unix: S.last_test_unix,
      rollback_window_scans: stats.rollback,
      inputs_mask: mem.i[0], outputs_mask: mem.q[0],
      i_bits_b64: b64enc(mem.i), q_bits_b64: b64enc(mem.q), m_bits_b64: b64enc(mem.m),
      t_bits_b64: b64enc(mem.t), sm: sysBits(),
      // funzioni eseguite nell'ultima scansione (v3: numeri delle FC)
      fc_exec_b64: b64enc(fcExecBits(S.state === "running" ? lastFcExec : [])),   // un bit per FC (FC0..FC1023), come il firmware
      // StartUp: quando è stato eseguito l'ultima volta e quanto è durato
      startup: Object.assign({ present: !!prog && prog.suOff >= 0, count: su.count },
                             su.count ? { ago_ms: Math.round(performance.now() - su.at), us: su.us, fault: su.fault } : {}),
      // timer usati dal programma: tempo trascorso / preimpostato (ms) e Q
      // ?t=1,5,201: solo i timer dei blocchi Online dell'editor (senza t: tutti), come il firmware
      timers: usedTimers().filter(i => !q || !q.has("t") || q.get("t").split(",").includes(String(i))).map(i => ({ i, et: timerET(mem.tm[i], scanNow), pt: mem.tm[i].pt, q: mem.tm[i].q ? 1 : 0 })),
    }, sfList.length ? { sf: sfJson() } : {}, q && q.has("cyc") ? { cycle: cycleJson() } : {});
  }
  function usedTimers() {
    const out = [];
    if (!prog) return out;
    const c = prog.code.subarray(0, prog.codeEnd), seen = new Set();
    for (let pc = 0; pc < c.length;) {
      const op = c[pc], l = opLen(c, pc, c.length);
      if (!l) break;
      if (op >= 0x50 && op <= 0x52 && !seen.has(c[pc + 1])) { seen.add(c[pc + 1]); out.push(c[pc + 1]); }
      pc += l;
    }
    return out.sort((a, b) => a - b);
  }
  function memoryJson() {
    const bc = prog ? prog.bytecode.length : 0, src = prog ? prog.source.length : 0;
    return { tier_kb: TIER, partition_total_bytes: PARTITION_MAX, bytecode_max_bytes: BYTECODE_MAX,
             segments_max: SEGMENTS_MAX, bytecode_used_bytes: bc, source_used_bytes: src, upload: "form",
             source_max_bytes: PARTITION_MAX - HEADER_SIZE - bc,
             segments_used: prog ? prog.header.num_segments : 0,
             work_total_bytes: workSize(), work_used_bytes: codeSize(prog), work_free_max_bytes: workSize() - codeSize(prog), work_wifi_bytes: 25600, work_reduced: false,
             iram_code_bytes: setActive.vm && setActive.vm.iram ? 12288 : 0, iram_code_avail: 12288, iram_code_used: 0, iram_free_boot: 26292, ...(setActive.vm && (setActive.vm.accu || setActive.vm.native) ? { vm_accu: Object.assign({ blocks: 3, frags: 41, ops: 388, code: 2410, xcode: 1530, iram: 5120, ram: 0 }, setActive.vm.native ? { native: 37, native_bytes: 9820 } : {}) } : {}), dbg: { heap: 98304, heap_min: 61440, block: 45056, iram: 26292, iram_min: 26292, dl_seq: 1, dl: [[90112, 40960, 26292], [70000, 36000, 26292], [52000, 30000, 14000], [48000, 28000, 14000], [60000, 30000, 14000], [62000, 31000, 14000], null] },
             direct_flash: true,
             scan_avg_us: stats.scan_avg_us, scan_max_us: stats.scan_max_us,
             scan_overrun_count: stats.scan_overrun_count,
             // v2.5: limiti della VM, come EspPlc::vmVersion()/instrMax()/… nel firmware
             vm_version: "4.6", instr_max: MAX_INSTR, call_depth: 8, vm_stack: VM_STACK,
             scan_interval_ms: CFG.scanMs, max_scan_us: 250000, ops: SUPPORTED_OPS, db_size: DB_SIZE, lstack_size: LS_SIZE,
             io_in: N_IN, io_out: N_OUT };
  }
  const simple = (code, msg) => [code, { ok: code >= 200 && code < 300, msg }];
  // v4.7: frame leggero, come on_live() del firmware (plc_rest.cpp)
  const gens = { set: 0, net: 0 };
  const hexOf = (u8, a, b) => Array.from(u8.slice(a, b + 1), x => x.toString(16).padStart(2, "0")).join("");
  function liveJson(q) {
    const st = Object.assign(statusJson(q), clientsJson(q));
    const on = !!q && q.get("on") === "1", c = !!q && q.get("c") === "1";
    const o = { state: st.state, load: st.load };
    for (const k of ["crc32", "bc_crc32", "src_crc32", "last_dl", "sf", "usb_guard"]) if (st[k] !== undefined) o[k] = st[k];
    if (st.fault && st.fault !== "PLC_OK") o.fault = st.fault;
    const D = diagLoad();
    o.g = { log: logLoad().seq, dg: D.reduce((h, x) => (h * 31 + x.code * 7 + x.blk + x.off * 3 + x.count + (x.active ? 1 : 0)) >>> 0, D.length),
            set: gens.set, net: gens.net, boot: (st.sf || []).map(x => x.code).join(".").length + (st.sf || []).length };
    if (on || c) { o.scan_count = st.scan_count; o.scan_avg_us = st.scan_avg_us; o.scan_max_us = st.scan_max_us; o.startup = st.startup; }
    if (c) { o.scan_overrun_count = st.scan_overrun_count; o.cycle = cycleJson(); o.clients = st.clients || []; }
    if (on) {
      o.sm = st.sm;
      const A = { I: mem.i, O: mem.q, Q: mem.q, M: mem.m, T: mem.t }, b = {};
      String(q.get("b") || "").split(",").forEach(r => {
        const m = /^([IOQMT])(\d+)(?:-(\d+))?$/.exec(r); if (!m) return;
        const top = m[1] === "T" ? 31 : 127, f = +m[2], t = Math.min(top, m[3] === undefined ? f : +m[3]);
        if (f <= top && t >= f) b[m[1] + f] = hexOf(A[m[1]], f, t);
      });
      if (Object.keys(b).length) o.b = b;
      if (q.get("t")) o.timers = st.timers;
      if (q.has("x")) { const n = Math.min(1023, +q.get("x")); o.fx = hexOf(fcExecBits(S.state === "running" ? lastFcExec : []), 0, n >> 3);
                        o.fe = hexOf(fcExecBits(Object.keys(fcEno).filter(k => fcEno[k]).map(Number)), 0, n >> 3); }
    }
    return o;
  }

  // ── bus dei moduli I/O (come bus_master.cpp): impostazioni in localStorage, due dispositivi «trovati» ──
  let busFound = [], busIdent = {};
  const busCfgGet = () => { try { return JSON.parse(lsGet("bus") || "null") || { period: 5, hold: 100, good: 3, modules: [] }; } catch (e) { return { period: 5, hold: 100, good: 3, modules: [] }; } };
  function busJson() {
    const c = busCfgGet(), now = Date.now();
    return { role: "plc", period: c.period, hold: c.hold, good: c.good, eth_driver: true, cycle_us: 14, cycle_max_us: 90, gap_max_us: 5200, mac: "24:0a:c4:17:5a:e7",
      modules: c.modules.map(m => ({ station: m.station, mac: m.mac || "", name: m.name, n_di: (m.cat || []).filter(p => p.t === "bit" && p.dir === "in").length,
        n_do: (m.cat || []).filter(p => p.t === "bit" && p.dir === "out").length, crc: m.crc || "", dev_crc: m.crc || "", cfg_bad: false, gone: false, stop: !!m.stop,
        acked: !!m.mac, valid: !!m.mac, state: m.mac ? 0 : 3, rtt_us: m.mac ? 560 : 0, rtt_max_us: 900, tx: 1000, rx: 1000, lost: 0, late: 0, echo_bad: 0, dev_drop: 0,
        age_ms: 2, di: "0500000000000000", echo: "0100000000000000", i_from: 64 + 64 * m.station, q_from: 64 + 64 * m.station, pplc: m.mac ? "on" : undefined })),
      found: busFound.map(f => Object.assign({}, f, { ident: (busIdent[f.mac] || 0) > now })) };
  }
  // posto di ogni punto nei blocchi della DB (i = ingresso, o = uscita), per dispositivo, come il firmware (io_hw.cpp):
  // senza gli indici l'editor non sa dove mettere i punti e il Compile dà «punti senza posizione»
  function ioIdx(points) {
    const n = new Map();
    for (const p of points) {
      const c = n.get(p.dev || "") || { bi: 0, bo: 0, ri: 0, ro: 0 }, r = p.t === "real" ? "r" : "b";
      n.set(p.dev || "", c);
      if (p.dir === "in" || p.dir === "io") p.i = c[r + "i"]++;
      if (p.dir === "out" || p.dir === "io") p.o = c[r + "o"]++;
    }
    return points;
  }
  function route(method, path, body, q) {
    switch (method + " " + path) {
      case "GET /api/io/catalog": return [200, { board: "Scheda di prova", loaded: true, devices: [],
        points: ioIdx([{ id: "gpi.34", t: "bit", dir: "in" }, { id: "gpi.35", t: "bit", dir: "in" }, { id: "gpo.32", t: "bit", dir: "out" },
                 { id: "gpio.4", t: "bit", dir: "io" }, { id: "sin0.0", t: "bit", dir: "in" }, { id: "sin0.1", t: "bit", dir: "in" },
                 { id: "sout0.1", t: "bit", dir: "out" }, { id: "vpin.36", t: "real", dir: "in" }, { id: "ach0", t: "real", dir: "in", modes: true },
                 { id: "xadc0.0", t: "real", dir: "in", used: true }, { id: "xdac0.0", t: "real", dir: "out", error: "driver da fare" },
                 { id: "pwm.25", t: "real", dir: "out" }].concat(busCfgGet().modules.filter(m => m.mac).flatMap(m => (m.cat || []).map(p =>
                 ({ id: m.name + "." + p.id, t: p.t, dir: p.dir, dev: m.name, name: p.name }))))) }];
      case "GET /api/io/values": return [200, { stamp: 0, rows: [] }];
      case "GET /api/bus": return [200, busJson()];
      case "GET /api/bus/config": return [200, busCfgGet()];
      case "POST /api/bus/config": { let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "JSON non valido"); }
        if ((d.modules || []).some(m => !m.name)) return simple(400, "modulo senza nome");
        lsSet("bus", JSON.stringify(d)); return [200, { ok: true }]; }
      case "POST /api/bus/discover":
        busFound = [{ mac: "24:0a:c4:17:51:ff", name: "uplc-io", fw: "0.2.0", n_di: 6, n_do: 4, station: null, state: 3, role: "io", age_ms: 10 },
                    { mac: "24:0a:c4:11:22:33", name: "uplc", fw: "0.2.0", n_di: 0, n_do: 0, station: null, state: 255, role: "plc", age_ms: 12 }];
        return [200, { ok: true }];
      case "POST /api/bus/fetch": return [200, { crc: "1a2b3c4d", cat: [
        { id: "gpi.34", name: "Pulsante", t: "bit", dir: "in", i: 0 }, { id: "gpi.35", name: "", t: "bit", dir: "in", i: 1 },
        { id: "gpo.32", name: "Relè 1", t: "bit", dir: "out", i: 0 }, { id: "gpo.33", name: "Relè 2", t: "bit", dir: "out", i: 1 },
        { id: "vpin.36", name: "Livello", t: "real", dir: "in", i: 0 }] }];
      case "POST /api/bus/rearm": return [200, { ok: true, rearmed: 1 }];
      case "POST /api/bus/identify": busIdent[q.get ? q.get("mac") : q.mac] = (q.get ? q.get("on") : q.on) === "0" ? 0 : Date.now() + 2500; return [200, { ok: true }];
      case "GET /api/plc/status": return [200, Object.assign(statusJson(q), clientsJson(q))];
      case "GET /api/plc/memory": return [200, memoryJson()];
      case "GET /api/plc/live": return [200, liveJson(q)];
      case "GET /api/fw/info": return [200, { version: "sim", env: "uplc", fs_total: 774400, fs_used: 176128 + JSON.stringify(log || []).length, plc_running: S.state === "running" }];
      case "GET /api/plc/program":
        if (!prog) return simple(404, "no program");
        return [200, { version: prog.header.version, num_segments: prog.header.num_segments,
                       bytecode_size: prog.bytecode.length, source_size: prog.source.length,
                       crc32: prog.header.crc32, dirty: S.dirty, bytecode_hex: hex(prog.bytecode),
                       source_b64gz: prog.source.length ? b64enc(prog.source) : "" }];
      case "DELETE /api/plc/program":
        S.ram = S.nvs = null; S.state = "no_program"; S.fault = "PLC_OK"; S.dirty = false;
        logAdd(4, 3, 0);
        prog = null; resetTimers(mem); safeState(); saveState();
        return simple(200, "deleted");
      case "GET /api/plc/boot":
        return [200, bootReport];
      case "GET /api/plc/settings":
        return [200, { active: setActive, saved: setSaved, reboot_needed: rebootNeeded(), board: BOARD }];
      case "PUT /api/plc/settings":
      case "POST /api/plc/settings": {
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "bad json"); }
        const r = checkSettings(d || {}, setSaved);
        if (r.err) return simple(400, r.err);
        setSaved = r.s; lsSet("settings", JSON.stringify(setSaved));
        setActive.cycle = Object.assign(CYC_DEF(), setSaved.cycle); setActive.serial = Object.assign(SER_DEF(), setSaved.serial); lsSet("settings.active", JSON.stringify(setActive));   // subito
        logAdd(7, 4, 0); gens.set++;
        return [200, { ok: true, reboot_needed: rebootNeeded() }];
      }
      case "GET /api/plc/clock":                         // v4.5: data e ora (il simulatore usa quella del PC)
        return [200, { unix: Math.floor(Date.now() / 1000), valid: true, src: "pc", rtc: false }];
      case "POST /api/plc/clock": {
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "bad json"); }
        if (!(d && d.unix > 1600000000)) return simple(400, "data non valida");
        logAdd(1, 2, 2);
        return [200, { ok: true, rtc: false }];
      }
      case "POST /api/plc/reboot":
        logAdd(1, 6, 2);
        { const after = q && q.get("after");            // v4.5: scelta dell'operatore (stop | run)
          if (after === "stop" && prog) { S.state = "stopped"; safeState(); saveState(); }
          setTimeout(() => api.reboot(after === "stop" || after === "run" ? after : ""), 50); }
        return [200, { ok: true, msg: "riavvio" }];
      case "GET /api/net/settings":
        return [200, { active: netPublic(netActive), saved: netPublic(netSaved), reboot_needed: netRebootNeeded(),
                       ap_pass_default: netSaved.wifi.on && netSaved.ap.pass === AP_PASS_DEFAULT, domain: "lan" }];
      case "PUT /api/net/settings":
      case "POST /api/net/settings": {
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "bad json"); }
        const n = JSON.parse(JSON.stringify(netSaved)), w = netParse(d, n);
        if (w) return simple(400, w);
        netSaved = n; lsSet("netset", JSON.stringify(netSaved));
        logAdd(7, 4, 1); gens.net++;
        return [200, { ok: true, reboot_needed: netRebootNeeded() }];
      }
      case "GET /api/net/status":
        return [200, netStatus()];
      case "GET /api/plc/db": {                         // v4.8: area dei DB
        const off = +(q && q.get("off")) || 0, len = +(q && q.get("len")) || 0;
        if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len <= 0 || len > 2048 || off + len > DB_SIZE) return simple(400, "bad range");
        return [200, { off, hex: [...mem.db.subarray(off, off + len)].map(x => x.toString(16).padStart(2, "0")).join("") }];
      }
      case "GET /api/data/exposure": {                           // v4.8: esposizione dati, i TX
        const data = {};
        for (const e of (prog && prog.xchg) || []) if (e.dir === 0) { const v = xchgGet(e); data[e.name] = typeof v === "number" && !isFinite(v) ? null : v; }
        return [200, { data, state: S.state === "running" ? "run" : S.state === "no_program" ? "no_program" : S.state === "fault" ? "fault" : "stop", version: (prog && prog.xchgVer) || 0 }];
      }
      case "GET /api/data/exposure/plctx.json": case "GET /api/data/exposure/plcrx.json": {   // v4.8: come sono sul PLC (sorgente, tipo 0xFE)
        const n = path.endsWith("tx.json") ? 0 : 1;
        const d = prog && (prog.srcBlocks || []).find(e => e.type === 0xFE && e.number === n);
        if (!d) return simple(404, "esposizione dati non presente: Compile e Download");
        return [200, JSON.parse(new TextDecoder().decode(d.data))];
      }
      case "GET /api/hmi/config.bin": {                          // Dati HMI: file di configurazione del pannello (sorgente 0xFE, numero 2)
        const d = prog && (prog.srcBlocks || []).find(e => e.type === 0xFE && e.number === 2);
        if (!d) return simple(404, "Dati HMI non presenti: Compile e Download");
        return [200, { _bin: d.data }];
      }
      case "POST /api/data/exposure": {                          // v4.8: esposizione dati, gli RX
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "JSON non valido"); }
        if (!d || typeof d !== "object" || Array.isArray(d)) return simple(400, "JSON non valido");
        const rx = ((prog && prog.xchg) || []).filter(e => e.dir === 1), todo = [];
        const R = { 1: [-32768, 32767], 2: [0, 65535], 3: [-2147483648, 2147483647], 4: [0, 4294967295], 6: [0, 255] };
        for (const [k, v0] of Object.entries(d)) {
          const e = rx.find(x => x.name === k);
          if (!e) return [400, { ok: false, field: k, msg: "campo non scrivibile (non è in RX)" }];
          const v = typeof v0 === "boolean" ? (v0 ? 1 : 0) : v0;
          const ok = typeof v === "number" && (e.type === 0 ? v === 0 || v === 1 : e.type === 5 ? isFinite(Math.fround(v)) : Number.isInteger(v) && v >= R[e.type][0] && v <= R[e.type][1]);
          if (!ok) return [400, { ok: false, field: k, msg: "valore del tipo sbagliato o fuori campo" }];
          todo.push([e, v]);
        }
        for (const [e, v] of todo) {
          if (e.area === 2) { mem.m[e.idx >> 3] = v ? mem.m[e.idx >> 3] | (1 << (e.idx & 7)) : mem.m[e.idx >> 3] & ~(1 << (e.idx & 7)); continue; }
          if (!e.type) mem.db[e.idx] = v ? mem.db[e.idx] | (1 << e.bit) : mem.db[e.idx] & ~(1 << e.bit);
          else rawSet({ buf: mem.db, at: e.idx }, e.type, v);
        }
        return [200, { ok: true, written: todo.length }];
      }
      case "GET /api/plc/fcdata": {                     // v4.8: dati locali dell'ultima chiamata della FC
        const fc = +(q && q.get("fc"));
        if (!Number.isInteger(fc) || fc < 0 || fc > 65535) return simple(400, "bad fc");
        let hex = "";
        if (watchFc !== fc) { watchFc = fc; watchBuf = new Uint8Array(0); }
        else hex = [...watchBuf].map(x => x.toString(16).padStart(2, "0")).join("");
        return [200, { fc, seq: watchSeq, hex }];
      }
      case "POST /api/plc/db": {
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "bad json"); }
        const off = d && d.off;
        if (!Number.isInteger(off) || off < 0 || off >= DB_SIZE) return simple(400, "bad off");
        if (d.bit !== undefined) {
          if (!Number.isInteger(d.bit) || d.bit < 0 || d.bit > 7) return simple(400, "bad bit");
          mem.db[off] = d.value ? mem.db[off] | (1 << d.bit) : mem.db[off] & ~(1 << d.bit);
          return [200, { ok: true }];
        }
        const h = typeof d.hex === "string" ? d.hex : "";
        if (!h || h.length % 2 || h.length > 128 || !/^[0-9a-fA-F]+$/.test(h) || off + h.length / 2 > DB_SIZE) return simple(400, "bad hex");
        for (let i = 0; i < h.length / 2; i++) mem.db[off + i] = parseInt(h.substr(2 * i, 2), 16);
        return [200, { ok: true }];
      }
      case "GET /api/plc/diag": {
        if (diagDirty) diagFlush(true); else diag = null;   // riletto: può averlo scritto un'altra scheda
        const D = diagLoad().slice().reverse();
        return [200, { now: Math.floor(Date.now() / 1000),
                       entries: D.map(x => ({ code: x.code, blk: x.blk, off: x.off, count: x.count, first: x.first, last: x.last, active: !!x.active, sw: !!x.sw })) }];
      }
      case "GET /api/plc/blocks": {
        if (!prog) return [200, { crc32: 0, blocks: [] }];
        const pr = prog.srcBlocks.find(e => e.type === 0xFF);
        return [200, { crc32: prog.header.crc32, proj_scrc: pr ? pr.crc : 0,
          blocks: prog.blocks.map(e => { const sb = prog.srcBlocks.find(x => x.type === e.type && x.number === e.number);
            return { t: e.type === 0 ? "main" : e.type === 2 ? "startup" : e.type === 3 ? "db" : e.type === 4 ? "mod" : "fc", n: e.number, size: e.size, crc: e.crc, scrc: sb ? sb.crc : 0, ssize: sb ? sb.size : 0 }; }) }];
      }
      case "POST /api/plc/program/patch": {
        if (!body.length) return simple(400, "empty body");
        if (body.length > PARTITION_MAX * 2) return simple(413, "payload too large");
        const bin = b64decStrict(body);
        if (!bin) return simple(400, "bad base64");
        const r = applyPatch(bin, prog);
        const RES = { base: 1, nomem: 2, bad: 3, noprog: 4 };
        if (!r.prog) {
          logAdd(4, 8, RES[r.res] || 3);
          if (r.res === "base" || r.res === "noprog") return simple(409, "il programma sul PLC e' cambiato: serve il download completo");
          if (r.res === "nomem") return simple(507, "memoria insufficiente: serve STOP e download completo");
          return simple(422, r.fault);
        }
        S.ram = S.nvs = b64enc(r.blob); prog = r.prog; S.dirty = false;   // subito in flash; RUN/STOP e timer restano
        dbApply(prog);
        { const sid = (q && q.get("sid") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 16);
          S.last_dl = { sid, ip: "127.0.0.1", t: Date.now() };
          }
        S.last_test_unix = nowUnix(); stats.rollback = ROLLBACK_SCANS; saveState();
        return [200, statusJson()];
      }
      case "POST /api/plc/program/test": {
        // come il firmware (loadFull): in RUN dopo solo se era in RUN prima e senza ?stay=1, mai da STOP a RUN da solo
        const wasRun = S.state === "running" && !(q && q.get("stay") === "1");
        if (q && q.get("stop") === "1" && prog) {      // v3: STOP e libera la RAM prima del download completo
          if (S.state !== "stopped") logAdd(2, 2, 1);
          prog = null; S.ram = null; S.state = "no_program"; resetTimers(mem); safeState();
        }
        if (!body.length) return simple(400, "empty body");
        if (body.length > PARTITION_MAX * 2) return simple(413, "payload too large");
        const bin = b64decStrict(body);
        if (!bin) return simple(400, "bad base64");
        const r = parseBlob(bin);
        if (r.fault) { logAdd(4, 5, FAULT_CODE[r.fault] || 0); logAdd(3, FAULT_CODE[r.fault] || 0, stats.scan_count); return simple(422, r.fault); }
        if (codeSize(r) > workSize()) { logAdd(4, 5, FAULT_CODE.PLC_ERR_PROGRAM_TOO_LARGE || 10); return simple(422, "PLC_ERR_PROGRAM_TOO_LARGE"); }
        if (workNeed(r.bytecode, prog) > workSize() - codeSize(prog)) return simple(507, "memoria insufficiente: serve STOP");
        S.ram = S.nvs = b64enc(bin); prog = r; S.dirty = false; S.fault = "PLC_OK"; S.state = wasRun ? "running" : "stopped";   // subito in flash
        dbApply(prog);
        suPending = true;                                // download completo → StartUp prima del Main
        { const sid = (q && q.get("sid") || "").replace(/[^0-9A-Za-z]/g, "").slice(0, 16);
          S.last_dl = { sid, ip: "127.0.0.1", t: Date.now() };
          }
        resetTimers(mem);
        S.last_test_unix = nowUnix(); stats.rollback = ROLLBACK_SCANS; saveState();
        return [200, statusJson()];
      }
      case "POST /api/plc/program/persist":              // il Download è già in flash (editor di prima)
        return S.ram ? simple(200, "persisted") : simple(404, "no program");
      case "GET /api/plc/log": {
        const L = logLoad(), g = k => q && q.has(k) ? +q.get(k) : null;
        let after = g("after") || 0, upto = Infinity, n = g("n") || Infinity;   // ?tail=K, ?before=S&n=K come il firmware
        if (g("tail") !== null) after = Math.max(0, L.seq - g("tail"));
        if (g("before") !== null) { upto = g("before"); const k = n === Infinity ? 64 : n; after = Math.max(0, upto - k - 1); }
        return [200, { cap: L.cap, bytes: L.cap * 16, count: L.e.length, last: L.seq,
                       up: Math.floor(performance.now() / 1000), unix: Math.floor(Date.now() / 1000), boot: +(lsGet("boot") || 0),
                       entries: L.e.filter(x => x[0] > after && x[0] < upto).slice(0, n) }];
      }
      case "POST /api/plc/log/config": {
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "bad json"); }
        const b = d && d.bytes;
        if (!Number.isInteger(b) || b < LOG_MIN || b > LOG_MAX) return simple(400, "bytes 512..32768");
        const L = logLoad(); L.cap = Math.floor(b / 16); if (L.e.length > L.cap) L.e.splice(0, L.e.length - L.cap);
        lsSet("plclog", JSON.stringify(L)); logAdd(1, 4, L.cap * 16);
        return [200, { ok: true, bytes: L.cap * 16, cap: L.cap }];
      }
      case "POST /api/plc/run":
        if (S.fault !== "PLC_OK") logAdd(2, 4, FAULT_CODE[S.fault] || 0);
        if (prog) { if (S.state !== "running") { resetTimers(mem); logAdd(2, 1, 1); } S.state = "running"; S.fault = "PLC_OK"; } else S.state = "no_program";
        saveState(); return [200, statusJson()];
      case "POST /api/plc/mem/m": {
        // Proposta firmware (vedi start.md): scrive un merker M da GUI.
        let d; try { d = JSON.parse(body || ""); } catch (e) { return simple(400, "bad json"); }
        const idx = d && d.idx, v = d && d.value;
        if (!Number.isInteger(idx) || idx < 0 || idx > MAX_IDX[3]) return simple(400, "bad index");
        if (v !== 0 && v !== 1 && v !== true && v !== false) return simple(400, "value must be 0 or 1");
        setBit(mem.m, idx, !!v);
        return [200, { ok: true, idx, value: v ? 1 : 0 }];
      }
      // Tabella dei simboli: file /symbols.json su SPIFFS (plc_rest.cpp, on_symbols_*)
      case "GET /api/plc/symbols": {
        const f = lsGet("spiffs.symbols");
        try { if (f) return [200, JSON.parse(f)]; } catch (e) {}
        return [200, { format: "espplc-symbols", version: 1, symbols: {} }];
      }
      case "PUT /api/plc/symbols":
      case "POST /api/plc/symbols": {
        if (!body.length) return simple(400, "empty body");
        if (body.length > 32768) return simple(413, "payload too large");
        let d; try { d = JSON.parse(body); } catch (e) { return simple(400, "bad json"); }
        if (!d || d.format !== "espplc-symbols") return simple(400, "not a symbols file");
        lsSet("spiffs.symbols", body);
        logAdd(7, 3, body.length);
        return [200, { ok: true, size: body.length }];
      }
      case "POST /api/plc/stop":
        if (prog && S.state !== "stopped") logAdd(2, 2, 1);
        if (prog) S.state = "stopped";
        resetTimers(mem);
        safeState(); saveState(); return [200, statusJson()];
    }
    return [404, { ok: false, msg: "not found" }];
  }

  // WebServer.arg("plain"): un body binario viene troncato al primo 0x00.
  async function bodyAsPlain(b) {
    if (b == null) return "";
    if (typeof b === "string") return b;
    if (typeof FormData !== "undefined" && b instanceof FormData) {    // Download come il firmware uPLC: file binario
      const f = b.get("prog");
      return f ? b64enc(new Uint8Array(await f.arrayBuffer())) : "";
    }
    let u8;
    if (b instanceof ArrayBuffer) u8 = new Uint8Array(b);
    else if (ArrayBuffer.isView(b)) u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    else if (b instanceof Blob) u8 = new Uint8Array(await b.arrayBuffer());
    else return String(b);
    let s = "";
    for (const c of u8) { if (c === 0) break; s += String.fromCharCode(c); }
    return s;
  }
  function pushLog(line) {
    log.unshift(new Date().toTimeString().slice(0, 8) + "  " + line);
    if (log.length > 8) log.pop();
  }

  window.fetch = async function (input, init) {
    init = init || {};
    const url = (typeof input === "string") ? input : (input && input.url) || "";
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const query = new URLSearchParams(url.split("?")[1] || "");
    if (!path.startsWith("/api/")) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    // picoPlc: copia nel PLC del programma di ogni modulo (base64) e invio a pezzi (come bus_master.cpp)
    if (path === "/api/bus/pplc") {
      const m = query.get("m") || "", key = "pplc." + m;
      if (method === "GET") { const t = lsGet(key); return t ? new Response(t, { status: 200, headers: { "Content-Type": "text/plain" } }) : new Response(JSON.stringify({ ok: false }), { status: 404 }); }
      const total = +query.get("total"), off = +query.get("off"), txt = (init.body || "").trim();
      const J = o => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
      if (!txt) { const done = (lsGet(key + ".tmp") || "").length >= 0 && off === total; if (done) { lsSet(key, btoa(lsGet(key + ".raw") || "")); } return J({ ok: true, next: total, st: done ? 3 : 1, fault: 0 }); }
      const raw = atob(txt), prev = off ? (lsGet(key + ".raw") || "") : "";
      lsSet(key + ".raw", prev.slice(0, off) + raw);
      return J({ ok: true, next: off + raw.length, st: off + raw.length >= total ? 1 : 0, fault: 0 });
    }
    // v4.6: simboli compressi, un file per area (come plc_rest.cpp)
    if (path === "/api/plc/symbols/file" || path === "/api/plc/symbols/parts" || (path === "/api/plc/symbols" && query.get("part"))) {
      const J = (c, o, t) => new Response(t || JSON.stringify(o), { status: c, headers: { "Content-Type": t ? "application/gzip" : "application/json" } });
      let parts = {}; try { parts = JSON.parse(lsGet("spiffs.symparts") || "{}"); } catch (e) {}
      const save = () => lsSet("spiffs.symparts", JSON.stringify(parts));
      const tot = ex => Object.entries(parts).filter(([k]) => k !== ex).reduce((t, [, v]) => t + v.size, 0);
      const part = query.get("part");
      if (path.endsWith("/parts")) return J(200, { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.size])), legacy: lsGet("spiffs.symbols") ? 1 : 0, max: 774400 - 454656 });
      if (method === "GET") {
        if (!parts[part]) return J(404, { ok: false, msg: "area senza simboli" });
        const gz = await new Response(new Blob([parts[part].json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
        return new Response(gz, { status: 200, headers: { "Content-Type": "application/gzip" } });
      }
      if (method === "DELETE") { delete parts[part]; save(); lsDel("spiffs.symbols"); return J(200, { ok: true, part }); }
      const f = init.body instanceof FormData ? [...init.body.values()].find(v => v instanceof Blob) : null;
      try {
        const txt = await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).text();
        if (tot(part) + f.size > 774400 - 454656) return J(400, { ok: false, msg: "simboli oltre lo spazio del PLC (312 KB compressi, il resto è del sistema)" });
        const d = JSON.parse(txt);
        if (!d || d.format !== "espplc-symbols") throw new Error("formato");
        parts[part] = { size: f.size, json: txt }; save(); lsDel("spiffs.symbols");
        pushLog(`POST /symbols/file?part=${part} → 200 (${f.size} B compressi)`);
        return J(200, { ok: true, part, size: f.size, total: tot(), max: 774400 - 454656 });
      } catch (e) { return J(400, { ok: false, msg: "non è una tabella compressa (gzip)" }); }
    }
    // log avanzato (come plc_advlog.cpp): testo finto, acceso con la diagnostica avanzata
    if (path === "/api/plc/advlog" || path === "/api/plc/advlog/info") {
      const on = (setActive.serial || SER_DEF()).mode === "log", txt = lsGet("advlog") || "";
      if (path.endsWith("/info")) {
        const fs = 774400, end = fs * 100000 / 2, w = (txt.length >> 11) * 2048;
        return new Response(JSON.stringify({ on, cur: txt.length & ~2047, old: 0, pending: txt.length & 2047, block: 2048, file_max: 32768,
          blocks: txt.length >> 11, written: w, lost: 0, skipped: 0, fs_total: fs, fs_used: 420000, endurance: end, wear_pct: w * 100 / end }), { status: 200 });
      }
      if (method === "DELETE") { lsDel("advlog"); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response("# uPLC (simulato) - log avanzato\n" + txt, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // tabella delle lingue (/plc/lang.json.gz): come i file dell'editor sul PLC (plc_fw.cpp)
    if ((path === "/api/fw/gui" || path === "/api/fw/file") && query.get("name") === "lang.json.gz") {
      if (method === "GET") {
        const t = lsGet("spiffs.lang");
        if (!t) return new Response(JSON.stringify({ ok: false, msg: "file non trovato" }), { status: 404 });
        return new Response(await new Response(new Blob([t]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(), { status: 200, headers: { "Content-Type": "application/gzip" } });
      }
      const f = init.body instanceof FormData ? [...init.body.values()].find(v => v instanceof Blob) : null;
      const txt = await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).text();
      lsSet("spiffs.lang", txt);
      pushLog(`POST /fw/file?name=lang.json.gz → 200 (${f.size} B compressi)`);
      return new Response(JSON.stringify({ ok: true, name: "lang.json.gz", bytes: f.size }), { status: 200 });
    }
    const body = await bodyAsPlain(init.body);
    const [lo, hi] = CFG.latencyMs;
    await new Promise((res, rej) => {
      const t = setTimeout(res, offline ? 900 : lo + Math.random() * (hi - lo));
      if (init.signal) init.signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
    });
    if (offline) throw new TypeError("Failed to fetch");
    const [code, obj] = route(method, path, body, query);
    if (!(method === "GET" && (path === "/api/plc/status" || path === "/api/plc/memory" || path === "/api/plc/live")))
      pushLog(`${method} ${path.replace("/api/plc", "")} → ${code}${obj.msg ? " " + obj.msg : ""}`);
    if (obj._bin) return new Response(new Uint8Array(obj._bin), { status: code, headers: { "Content-Type": "application/octet-stream" } });
    return new Response(JSON.stringify(obj), { status: code, headers: { "Content-Type": "application/json" } });
  };

  // ── Azioni del pannello ──────────────────────────────
  function resetStats() { Object.assign(stats, { scan_count: 0, scan_avg_us: 0, scan_max_us: 0, scan_overrun_count: 0, rollback: 0 }); }
  const api = {
    setInput(i, v) { inputs = v ? (inputs | (1 << i)) >>> 0 : (inputs & ~(1 << i)) >>> 0; saveInputs(); applyInputs(); },
    toggleInput(i) { api.setInput(i, !(inputs & (1 << i))); },
    reboot(after) {
      wasRunning = false; su.count = 0;                      // riavvio = passaggio in RUN: StartUp (contatore dall'accensione)
      netWatch = null;
      // v3.1: all'avvio valgono le impostazioni salvate
      setActive = JSON.parse(JSON.stringify(setSaved)); lsSet("settings.active", JSON.stringify(setActive));
      netActive = JSON.parse(JSON.stringify(netSaved)); lsSet("netset.active", JSON.stringify(netActive));
      N_IN = setActive.inputs.length; N_OUT = setActive.outputs.length;
      mem.e.fill(0); mem.i.fill(0); diag = []; diagDirty = true; diagFlush(true);
      const old = document.querySelector(".mockp"); if (old) { old.remove(); buildPanel(api); }
      // v4.2: «ultimo stato»: se prima era in STOP (anche per errore) resta in STOP; «run»: sempre RUN
      const wasRun = S.state === "running" || S.state === "no_program";
      const bootRun = after ? after === "run" : ((setActive.cycle || CYC_DEF()).boot === "run" || wasRun);
      if (dbLive) dbLive = dbLive.filter(d => d.flags & 1);       // v4.8: DB ritentivi tenuti, gli altri ai valori iniziali
      const nret = dbLive ? dbLive.length : 0;
      S.ram = S.nvs; S.dirty = false; S.fault = "PLC_OK"; reloadProg();
      S.state = prog ? (bootRun ? "running" : "stopped") : "no_program";
      mem.q.fill(0); mem.m.fill(0); resetTimers(mem); resetStats(); saveState();
      lsSet("boot", String(+(lsGet("boot") || 0) + 1));       // v4.5: numero dell'avvio (log → «boot»)
      logAdd(1, 1, 3);                                       // avvio dopo riavvio software
      if (nret) logAdd(1, 8, nret);                          // ritentiva ripristinata (DB)
      logAdd(4, prog ? 4 : 6, prog ? prog.header.crc32 : 0);
      if (prog) logAdd(2, bootRun ? 1 : 2, bootRun ? 0 : (after ? 4 : 2));  // RUN anche con SF; STOP se era in STOP o scelto
      bootReport = makeBootReport();
      saveState();
      pushLog("reboot (RAM ← flash)");
    },
    // selettore RUN / STOP sul PLC: stessa cosa dei pulsanti dell'editor (POST /api/plc/run|stop)
    run()  { const r = route("POST", "/api/plc/run", "", null); pushLog("RUN → " + (r[1] && r[1].state)); },
    stop() { const r = route("POST", "/api/plc/stop", "", null); pushLog("STOP → " + (r[1] && r[1].state)); },
    // errore che persiste: a ogni RUN il PLC torna in STOP per errore alla prima scansione
    setFault(v) { faultOn = !!v; pushLog(faultOn ? "errore attivo (persiste finché non lo togli)" : "errore tolto: RUN riparte"); if (faultOn) api.injectFault(); },
    get faultOn() { return faultOn; },
    injectFault() {
      if (S.state !== "running") { pushLog("errore non simulato: PLC non in RUN"); return; }
      stats.scan_overrun_count++; S.state = "fault"; S.fault = "PLC_ERR_SCAN_OVERRUN"; resetTimers(mem); safeState(); saveState();
      logAdd(5, 1, 31234); logAdd(3, 1, stats.scan_count);
      pushLog("errore simulato: STOP per errore (scansione troppo lunga)");
    },
    setPlcNet(v) { plcNet = !!v; lsSet("plcnet", plcNet ? "1" : "0"); pushLog(plcNet ? "rete del PLC: pronta" : "rete del PLC: assente"); },
    setOffline(v) { offline = !!v; lsSet("offline", offline ? "1" : "0"); pushLog(offline ? "rete: OFFLINE" : "rete: online");
                    if (offline) logAdd(6, 2, 0); else logAdd(6, 1, ipNum("127.0.0.1")); },
    resetAll() {
      S = defaultState(); inputs = 0; saveState(); saveInputs(); reloadProg(); lsDel("spiffs.symbols"); lsDel("spiffs.symparts"); lsDel("spiffs.lang");
      lsDel("plclog"); logAdd(1, 1, 1); logAdd(4, 6, 0);         // come un'accensione con flash vuota
      lsDel("diag"); diag = null; diagDirty = false;
      lsDel("settings"); lsDel("settings.active"); setSaved = defaultSettings(); setActive = defaultSettings();
      mem.i.fill(0); mem.q.fill(0); mem.m.fill(0); resetTimers(mem); resetStats();
      mem.e.fill(0);
      pushLog("mock azzerato (RAM e flash vuote)");
    },
    get state() { return S; }, get mem() { return mem; }, get stats() { return stats; },
    get inputs() { return inputs; }, get offline() { return offline; }, get plcNet() { return plcNet; }, get log() { return log; },
    config: CFG,
    faultCode: name => FAULT_CODE[name] ?? -1,
    // per i test: esegue una scansione su un'area di memoria esterna
    runScanOn(code, memObj, nowMs, startup) {
      if (!memObj.t) memObj.t = new Uint8Array(32);
      if (!memObj.tm) memObj.tm = newTimers();
      ensureMem(memObj);
      const saved = scanNow; vmMem = memObj; scanNow = (nowMs || 0) >>> 0;
      try { const p = progOf(code); return runScan(p, startup && p.suOff >= 0 ? p.suOff : 0); } finally { vmMem = mem; scanNow = saved; }
    },
  };
  window.__mockPlc = api;
  // simulatore (Denys 05-11-2026): nella Diagnostica niente impostazioni che sul simulatore non servono (app.css, html.sim)
  document.documentElement.classList.add("sim");

  window.addEventListener("storage", e => {
    if (e.key === K("state"))   { S = load("state", defaultState); reloadProg(); }
    if (e.key === K("inputs"))  inputs = load("inputs", () => ({ i: 0 })).i >>> 0;
    if (e.key === K("offline")) offline = lsGet("offline") === "1";
  });

  reloadProg();
  bootQuiet = true; bootReport = makeBootReport(); bootQuiet = false;
  if (S.state === "running" && !prog) S.state = "no_program";
  if (!lsGet("plclog")) { logAdd(1, 1, 1); logAdd(4, prog ? 4 : 6, prog ? prog.header.crc32 : 0); }   // prima accensione
  setInterval(scanTick, Math.max(1, Math.min(CFG.scanMs, 4)));
  document.addEventListener("DOMContentLoaded", () => buildPanel(api));

  // ── Pannello di test ─────────────────────────────────
  function buildPanel(m) {
    if (window.ESPPLC_NO_PANEL) return;               // la Diagnostica non ha il pannellino
    const css = document.createElement("style");
    css.textContent = `
      .mockp{position:fixed;right:12px;bottom:56px;z-index:500;width:250px;background:#10141b;
        border:1px solid #4dd2ff;border-radius:8px;color:#d6dbe6;box-shadow:0 4px 18px rgba(0,0,0,.5);
        font:12px/1.35 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
      .mockp.min .mockp-body{display:none}
      .mockp-hd{display:flex;justify-content:space-between;gap:6px;padding:6px 8px;cursor:pointer;user-select:none}
      .mockp:not(.min) .mockp-hd{border-bottom:1px solid #2a3145}
      .mockp-hd b{color:#4dd2ff}
      .mockp-body{padding:8px;display:flex;flex-direction:column;gap:7px}
      .mockp-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
      .mockp-row>span.l{width:52px;flex:0 0 52px;color:#8a93a6;font-size:11px}
      .mockp-cells{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px}   /* a capo: sotto il primo, non sotto la scritta */
      .mockp-row:has(>.mockp-cells){flex-wrap:nowrap;align-items:flex-start}
      .mockp-row:has(>.mockp-cells)>span.l{padding-top:3px}
      .mockp-bit{min-width:30px;padding:2px 4px;text-align:center;border-radius:4px;background:#262d3d;
        border:1px solid #2a3145;font-size:10px;color:#8a93a6;user-select:none}
      .mockp-bit.btn{cursor:pointer}.mockp-bit.btn:hover{border-color:#4dd2ff}
      .mockp-bit.push{border-style:dashed}
      .mockp-bit.on{background:#4ade80;color:#052;border-color:#4ade80}
      .mockp-bit.out.on{background:#fbbf24;color:#321;border-color:#fbbf24}
      .mockp-st{font-size:11px;color:#8a93a6;white-space:pre-line}
      .mockp-btns{display:flex;flex-wrap:wrap;gap:4px}
      .mockp-btns button{font:11px inherit;padding:3px 7px;background:#262d3d;color:#d6dbe6;
        border:1px solid #2a3145;border-radius:4px;cursor:pointer}
      .mockp-btns button:hover{background:#4dd2ff;color:#001a26}
      .mockp select{font:11px inherit;background:#262d3d;color:#d6dbe6;border:1px solid #2a3145;border-radius:4px;padding:2px 4px}
      .mockp-btns button.act{background:#f87171;color:#200;border-color:#f87171}
      .mockp-log{font:10px/1.35 ui-monospace,Consolas,monospace;color:#8a93a6;background:#0b0e13;
        border-radius:4px;padding:4px 6px;max-height:96px;overflow:auto;white-space:pre}
      .mockp-gl,.mockp-gt,.mockp-gc{position:absolute;z-index:2}
      .mockp-gl{left:-3px;top:10px;bottom:10px;width:7px;cursor:ew-resize}
      .mockp-gt{top:-3px;left:10px;right:10px;height:7px;cursor:ns-resize}
      .mockp-gc{left:-4px;top:-4px;width:14px;height:14px;cursor:nwse-resize}
      .mockp-gl:hover,.mockp-gt:hover,.mockp-gc:hover{background:#4dd2ff;opacity:.5;border-radius:4px}
      .mockp.sized{display:flex;flex-direction:column}
      .mockp.sized .mockp-body{flex:1;min-height:0}
      .mockp.sized .mockp-log{flex:1;min-height:40px;max-height:none}
      .mockp.sized.min{height:auto!important}`;
    document.head.appendChild(css);
    const p = document.createElement("div");
    p.className = "mockp" + (lsGet("panelMin") === "1" ? " min" : "");
    p.setAttribute("translate", "no");                     // pannello di prova: resta in italiano
    document.body.appendChild(p);
    const toggleMin = () => { p.classList.toggle("min"); lsSet("panelMin", p.classList.contains("min") ? "1" : "0"); };

    if (!m) {
      p.innerHTML = `<div class="mockp-hd"><b>📡 DEVICE ${DEVICE}</b></div>
        <div class="mockp-body"><div class="mockp-st">Le chiamate /api/* vanno al device.
Se non risponde: il firmware non manda header CORS.</div>
        <div class="mockp-btns"><button id="mockp-back">Torna al mock</button></div></div>`;
      p.querySelector(".mockp-hd").onclick = toggleMin;
      p.querySelector("#mockp-back").onclick = () => { lsDel("device"); location.search = "?mock"; };
      return;
    }

    const push = new Set((CFG.pushButtons || []).map(Number));
    const cells = (g, n, cls) => Array.from({ length: n }, (_, i) =>
      `<span class="mockp-bit ${cls}${g === "i" && push.has(i) ? " push" : ""}" data-g="${g}" data-i="${i}"` +
      `${g === "i" ? ` title="${push.has(i) ? "pulsante: tieni premuto" : "interruttore: clic"}"` : ""}>${g === "i" ? "I" : "Q"}${i}</span>`).join("");
    p.innerHTML = `
      <div class="mockp-hd" title="Clic per comprimere/espandere"><b>🧪 MOCK PLC</b><span id="mockp-sum" class="mockp-st"></span></div>
      <div class="mockp-body">
        <div class="mockp-row"><span class="l">Ingressi</span><div class="mockp-cells">${cells("i", N_IN, "btn")}</div></div>
        <div class="mockp-row"><span class="l">Uscite</span><div class="mockp-cells">${cells("o", N_OUT, "out")}</div></div>
        <div id="mockp-st" class="mockp-st"></div>
        <div class="mockp-btns">
          <button id="mockp-run" title="Selettore RUN del PLC (come RUN dall'editor): riparte; se l'errore c'è ancora torna in STOP per errore">RUN</button>
          <button id="mockp-stop" title="Selettore STOP del PLC: uscite spente">STOP</button>
          <button id="mockp-reboot" title="Riavvio ESP: RAM ← flash, M azzerati">Reboot</button>
          <button id="mockp-fault" title="Errore che PERSISTE (es. scansione troppo lunga): il PLC va in STOP per errore e ci torna a ogni RUN finché non si toglie (clic di nuovo)">Errore</button>
          <button id="mockp-off" title="Simula ESP32 non raggiungibile">Offline</button>
          <button id="mockp-pnet" title="Rete usata dal programma del PLC (Modbus TCP…): pronta / assente. Conta all'avvio se nelle impostazioni il PLC usa la rete.">Rete PLC</button>
          <button id="mockp-reset" title="Cancella RAM e flash">Reset mock</button>
        </div>
        <div class="mockp-row"><span class="l">Taglia</span>
          <select id="mockp-tier" title="Memoria programma del PLC simulato (TOTAL_MEMORY_PLC)">
            ${[16, 32, 64, 128].map(t => `<option value="${t}"${t === TIER ? " selected" : ""}>${t} KB</option>`).join("")}
          </select></div>
        <div id="mockp-log" class="mockp-log"></div>
      </div>`;
    p.querySelector(".mockp-hd").onclick = toggleMin;
    // grandezza (Denys 05-11-2026): si tira il bordo sinistro, quello in alto o l'angolo in alto a sinistra; il pannello
    // resta attaccato in basso a destra e i pulsanti vanno a capo da soli. Grandezza ricordata nel browser, doppio clic
    // su un bordo = quella di partenza
    { const W0 = 250, sz = (() => { try { return JSON.parse(lsGet("panel") || "null"); } catch (e) { return null; } })();
      // altezza minima: tutto il pannello senza tagli (i pulsanti a capo dipendono dalla larghezza) e qualche riga di registro
      const minH = () => {
        const hd = p.querySelector(".mockp-hd"), body = p.querySelector(".mockp-body"), log = p.querySelector(".mockp-log");
        if (!body) return 160;
        const cs = getComputedStyle(body), gap = parseFloat(cs.rowGap) || 0;
        let h = (hd ? hd.offsetHeight : 0) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2;
        const kids = [...body.children];
        kids.forEach((c, i) => { h += (c === log ? 56 : c.offsetHeight) + (i ? gap : 0); });
        return Math.ceil(h);
      };
      const apply = (w, h) => {
        p.style.width = Math.max(W0, Math.min(window.innerWidth - 24, w)) + "px";
        if (h) { p.style.height = Math.min(window.innerHeight - 70, Math.max(minH(), h)) + "px"; p.classList.add("sized"); }
        else { p.style.height = ""; p.classList.remove("sized"); }
      };
      if (sz && sz.w) apply(sz.w, sz.h);
      for (const [cls, dx, dy, tip] of [["mockp-gl", 1, 0, "Trascina per allargare (doppio clic: grandezza di partenza)"],
                                        ["mockp-gt", 0, 1, "Trascina per allungare (doppio clic: grandezza di partenza)"],
                                        ["mockp-gc", 1, 1, "Trascina per allargare e allungare (doppio clic: grandezza di partenza)"]]) {
        const g = document.createElement("div"); g.className = cls; g.title = tip; p.appendChild(g);
        g.addEventListener("pointerdown", e => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          const r = p.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, h0 = p.classList.contains("sized") ? r.height : 0;
          const move = ev => apply(dx ? r.width + (x0 - ev.clientX) : r.width, dy ? r.height + (y0 - ev.clientY) : h0);
          const up = () => {
            document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
            const b = p.getBoundingClientRect();
            lsSet("panel", JSON.stringify({ w: Math.round(b.width), h: p.classList.contains("sized") ? Math.round(b.height) : 0 }));
          };
          document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
        });
        g.addEventListener("dblclick", e => { e.stopPropagation(); apply(W0, 0); lsDel("panel"); });
      }
    }
    p.querySelectorAll('.mockp-bit[data-g="i"]').forEach(e => {
      const i = +e.dataset.i;
      if (push.has(i)) {
        e.onmousedown = () => m.setInput(i, true);
        e.onmouseup = e.onmouseleave = () => { if (m.inputs & (1 << i)) m.setInput(i, false); };
      } else e.onclick = () => m.toggleInput(i);
    });
    p.querySelector("#mockp-run").onclick    = () => m.run();
    p.querySelector("#mockp-stop").onclick   = () => m.stop();
    p.querySelector("#mockp-reboot").onclick = () => m.reboot();
    p.querySelector("#mockp-fault").onclick  = () => m.setFault(!m.faultOn);
    p.querySelector("#mockp-off").onclick    = () => m.setOffline(!m.offline);
    p.querySelector("#mockp-pnet").onclick   = () => m.setPlcNet(!m.plcNet);
    p.querySelector("#mockp-reset").onclick  = () => m.resetAll();
    p.querySelector("#mockp-tier").onchange = e => {
      const t = +e.target.value;
      if (!confirm(`Taglia del PLC simulato: ${t} KB.\nLa pagina si ricarica; il programma in RAM/flash resta se ci sta.`)) { e.target.value = TIER; return; }
      lsSet("tier", String(t)); location.reload();
    };

    const all = [...p.querySelectorAll(".mockp-bit")];
    setInterval(() => {
      for (const c of all) {
        const i = +c.dataset.i;
        c.classList.toggle("on", c.dataset.g === "i" ? !!(m.inputs & (1 << i)) : getBit(m.mem.q, i));
      }
      const s = m.state, sz = x => x ? (b64decStrict(x) || []).length + " B" : "—";
      p.querySelector("#mockp-sum").textContent = s.state + (m.offline ? " · OFFLINE" : "");
      p.querySelector("#mockp-st").textContent =
        `stato: ${s.state}   fault: ${s.fault.replace("PLC_ERR_", "")}\n` +
        `RAM: ${sz(s.ram)}   flash: ${sz(s.nvs)}   scan: ${m.stats.scan_count}`;
      p.querySelector("#mockp-off").classList.toggle("act", m.offline);
      p.querySelector("#mockp-fault").classList.toggle("act", m.faultOn);
      p.querySelector("#mockp-pnet").classList.toggle("act", !m.plcNet);
      p.querySelector("#mockp-log").textContent = m.log.join("\n") || "(nessuna chiamata)";
    }, 150);
  }
})();
