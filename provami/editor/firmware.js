// ============================================================
//  EspPlc — firmware.js
//  Firmware del PLC dall'editor (Collegamento → Firmware), con il pacchetto .espplc che prepara
//  la compilazione (firmware/uPLC/tools/pack_fw.py):
//
//  AGGIORNA (USB o rete, PLC in STOP): firmware nello slot libero + file dell'editor, poi riavvio.
//    Stesse richieste dell'API in USB e in rete. Impostazioni, simboli, log e programma restano.
//  RECUPERO / PRIMA INSTALLAZIONE (solo USB): il micro va in modalità di caricamento (DTR/RTS,
//    o tasto BOOT) e il browser scrive bootloader, partizioni, boot_app0 e firmware con il
//    protocollo del bootloader in ROM. Poi il PLC riparte, l'editor si ricollega e manda i file
//    dell'editor. Le impostazioni restano, a meno di scegliere di cancellarle.
// ============================================================
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const hex = (n, w) => "0x" + (n >>> 0).toString(16).padStart(w || 5, "0");
  const kb = n => (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";

  // ── Pacchetto ───────────────────────────────────────
  function parsePackage(buf) {
    const u8 = new Uint8Array(buf);
    const magic = new TextDecoder().decode(u8.subarray(0, 8));
    if (magic !== "ESPPLCPK") throw new Error("non è un pacchetto del firmware (.miaplc.fw)");
    const hl = u8[8] | (u8[9] << 8) | (u8[10] << 16) | (u8[11] << 24);
    const head = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)));
    if (head.format !== "espplc-fw" && head.format !== "espplc-bk") throw new Error("formato del pacchetto sconosciuto");
    const base = 12 + hl;
    const blob = x => u8.subarray(base + x.off, base + x.off + x.size);
    const parts = (head.parts || []).map(p => Object.assign({}, p, { data: blob(p) }));
    const files = (head.files || []).map(f => ({ name: f.name, data: blob(f) }));
    const app = parts.find(p => p.name === "app");
    if (!app || app.data[0] !== 0xE9) throw new Error("pacchetto senza firmware valido");
    // backup (.bkesplc): file dei dati, programma, valori dei DB
    const data = (head.data || []).map(f => ({ name: f.name, data: blob(f) }));
    const program = head.program ? JSON.parse(new TextDecoder().decode(blob(head.program))) : null;
    const db = head.db ? blob(head.db) : null;
    return { head, parts, files, app, data, program, db, backup: head.format === "espplc-bk" };
  }

  // ── MD5 (per controllare la flash dopo il recupero) ──
  function md5(u8) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const n = u8.length, total = ((n + 8) >> 6) + 1, W = new Uint32Array(total * 16);
    for (let i = 0; i < n; i++) W[i >> 2] |= u8[i] << ((i % 4) * 8);
    W[n >> 2] |= 0x80 << ((n % 4) * 8);
    W[total * 16 - 2] = (n * 8) >>> 0; W[total * 16 - 1] = Math.floor(n / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < W.length; o += 16) {
      let a = a0, b = b0, c = c0, d = d0;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const t = d; d = c; c = b;
        const x = (a + f + K[i] + W[o + g]) >>> 0, s = S[(i >> 4) * 4 + (i % 4)];
        b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0; a = t;
      }
      a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
    }
    return [a0, b0, c0, d0].map(v => [0, 8, 16, 24].map(s => ((v >>> s) & 255).toString(16).padStart(2, "0")).join("")).join("");
  }
  async function deflate(u8) {
    const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  // ── Bootloader in ROM (recupero) ────────────────────
  // Pacchetti SLIP (C0 … C0, DB DC = C0, DB DD = DB). Comando: 00 op lunghezza(2) checksum(4) dati;
  // risposta: 01 op lunghezza(2) valore(4) dati… stato(4: 0 = ok, poi codice d'errore).
  const OP = { FLASH_BEGIN: 0x02, SYNC: 0x08, READ_REG: 0x0A, SPI_SET_PARAMS: 0x0B, SPI_ATTACH: 0x0D,
               DEFL_BEGIN: 0x10, DEFL_DATA: 0x11, MD5: 0x13 };
  const CHIP_MAGIC_REG = 0x40001000, BLOCK = 0x400;
  // valori del registro CHIP_MAGIC_REG per ogni micro (come esptool); senza "chip" nel pacchetto: esp32
  const CHIP_MAGIC = { esp32: [0x00f01d83], esp32c3: [0x6921506f, 0x1b31506f, 0x4881606f, 0x4361606f] };
  const u32s = (...v) => { const b = new Uint8Array(v.length * 4); v.forEach((x, i) => { b[i * 4] = x & 255; b[i * 4 + 1] = (x >>> 8) & 255; b[i * 4 + 2] = (x >>> 16) & 255; b[i * 4 + 3] = (x >>> 24) & 255; }); return b; };
  function Rom(port, log) {
    let enc = false;                                                 // ROM dei micro dopo l'ESP32: FLASH_BEGIN/DEFL_BEGIN con la parola «cifrato»
    const beginArgs = (...v) => enc ? u32s(...v, 0) : u32s(...v);
    let reader = null, writer = null, readDone = null, buf = [], inFrame = false, escNext = false;
    const frames = [], waiters = [];
    function onByte(b) {
      if (b === 0xC0) {
        if (inFrame && buf.length) { const f = Uint8Array.from(buf); buf = []; inFrame = false; deliver(f); }
        else { inFrame = true; buf = []; }
        return;
      }
      if (!inFrame) return;                                          // testo del micro all'avvio
      if (escNext) { buf.push(b === 0xDC ? 0xC0 : b === 0xDD ? 0xDB : b); escNext = false; }
      else if (b === 0xDB) escNext = true;
      else buf.push(b);
    }
    function deliver(f) {
      if (f[0] !== 0x01 || f.length < 8) return;
      for (let i = 0; i < waiters.length; i++) if (waiters[i].op === f[1]) { const w = waiters.splice(i, 1)[0]; w.res(f); return; }
      frames.push(f);
    }
    function wait(op, ms) {
      const i = frames.findIndex(f => f[1] === op);
      if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { op, res: f => { clearTimeout(t); res(f); } };
        const t = setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); rej(new Error("il micro non risponde")); }, ms);
        waiters.push(w);
      });
    }
    function slip(pkt) {
      const o = [0xC0];
      for (const b of pkt) { if (b === 0xC0) o.push(0xDB, 0xDC); else if (b === 0xDB) o.push(0xDB, 0xDD); else o.push(b); }
      o.push(0xC0);
      return Uint8Array.from(o);
    }
    async function cmd(op, data, chk, ms) {
      const p = new Uint8Array(8 + data.length);
      p[0] = 0; p[1] = op; p[2] = data.length & 255; p[3] = data.length >> 8;
      p.set(u32s(chk || 0), 4); p.set(data, 8);
      const w = wait(op, ms || 3000);
      await writer.write(slip(p));
      const f = await w;
      const len = f[2] | (f[3] << 8), body = f.subarray(8, 8 + len);
      const value = (f[4] | (f[5] << 8) | (f[6] << 16) | (f[7] << 24)) >>> 0;
      if (body.length >= 4 && body[body.length - 4] !== 0) throw new Error(`il bootloader rifiuta il comando ${hex(op, 2)} (errore ${hex(body[body.length - 3], 2)})`);
      return { value, body: body.subarray(0, Math.max(0, body.length - 4)) };
    }
    const sig = s => port.setSignals(s).catch(() => {});
    return {
      async open() {
        await port.open({ baudRate: 115200, bufferSize: 65536 });
        writer = port.writable.getWriter();
        reader = port.readable.getReader();
        const r = reader;
        readDone = (async () => {
          try { for (;;) { const { value, done } = await r.read(); if (done) break; if (value) for (const b of value) onByte(b); } }
          catch (e) {} finally { try { r.releaseLock(); } catch (e) {} }
        })();
      },
      async close() {
        try { if (reader) await reader.cancel(); } catch (e) {}
        try { await readDone; } catch (e) {}
        try { if (writer) writer.releaseLock(); } catch (e) {}
        try { await port.close(); } catch (e) {}
      },
      // reset con IO0 basso: circuito automatico delle schede (RTS → EN, DTR → IO0)
      async resetToBootloader() {
        await sig({ dataTerminalReady: false, requestToSend: true }); await sleep(100);
        await sig({ dataTerminalReady: true, requestToSend: false }); await sleep(60);
        await sig({ dataTerminalReady: false, requestToSend: false });
      },
      async hardReset() {
        await sig({ dataTerminalReady: false, requestToSend: true }); await sleep(120);
        await sig({ dataTerminalReady: false, requestToSend: false });
      },
      async sync(auto, tries) {
        const data = new Uint8Array(36); data.set([0x07, 0x07, 0x12, 0x20]); data.fill(0x55, 4);
        for (let t = 0; t < tries; t++) {
          if (auto) await this.resetToBootloader();
          for (let i = 0; i < 5; i++) {
            try {
              frames.length = 0;
              await cmd(OP.SYNC, data, 0, 120);
              await sleep(80); frames.length = 0;                      // le altre risposte al SYNC
              return true;
            } catch (e) {}
          }
          log(`nessuna risposta dal bootloader (tentativo ${t + 1}/${tries})`);
        }
        return false;
      },
      async chip() { return (await cmd(OP.READ_REG, u32s(CHIP_MAGIC_REG))).value; },
      setChip(name) { enc = name !== "esp32"; },
      async attach(flashSize) {
        await cmd(OP.SPI_ATTACH, new Uint8Array(8));
        await cmd(OP.SPI_SET_PARAMS, u32s(0, flashSize, 64 * 1024, 4096, 256, 0xFFFF));
      },
      async erase(addr, size) {
        await cmd(OP.FLASH_BEGIN, beginArgs(size, 0, BLOCK, addr), 0, Math.max(5000, 40000 * size / 1048576));
      },
      async write(addr, data, onProg) {
        const comp = await deflate(data);
        const blocks = Math.ceil(comp.length / BLOCK), writeSize = Math.ceil(data.length / BLOCK) * BLOCK;
        await cmd(OP.DEFL_BEGIN, beginArgs(writeSize, blocks, BLOCK, addr), 0, Math.max(5000, 40000 * writeSize / 1048576));
        for (let i = 0; i < blocks; i++) {
          const blk = comp.subarray(i * BLOCK, Math.min(comp.length, (i + 1) * BLOCK));
          let c = 0xEF; for (const b of blk) c ^= b;
          const p = new Uint8Array(16 + blk.length); p.set(u32s(blk.length, i, 0, 0)); p.set(blk, 16);
          await cmd(OP.DEFL_DATA, p, c, 10000);
          if (onProg) onProg(i + 1, blocks);
        }
        return comp.length;
      },
      async md5(addr, size) {
        const r = await cmd(OP.MD5, u32s(addr, size, 0, 0), 0, 10000 + 10000 * size / 1048576);
        return r.body.length >= 32 ? new TextDecoder().decode(r.body.subarray(0, 32)).toLowerCase()
                                   : Array.from(r.body.subarray(0, 16), b => b.toString(16).padStart(2, "0")).join("");
      },
    };
  }

  // ── Invio di un file al PLC (USB: pacchetti; rete: modulo con avanzamento) ──
  function upload(url, data, onProg, timeoutMs) {
    const fd = new FormData();
    fd.append("f", new Blob([data], { type: "application/octet-stream" }), "f.bin");
    if ((window.EspUsb && EspUsb.on()) || window.__mockPlc || typeof XMLHttpRequest === "undefined")
      return window.EspUsb && EspUsb.on() ? EspUsb.post(url, fd, null, timeoutMs, onProg)
        : fetch(url, { method: "POST", body: fd, headers: { "X-EspPlc": "1" } }).then(async r => { onProg && onProg(data.length, data.length); return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }; });
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", url); x.timeout = timeoutMs;
      x.setRequestHeader("X-EspPlc", "1");               // il PLC accetta firmware e file solo dall'editor
      x.upload.onprogress = e => { if (e.lengthComputable && onProg) onProg(e.loaded, e.total); };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} resolve({ ok: x.status >= 200 && x.status < 300, status: x.status, j }); };
      x.onerror = () => reject(new Error("errore di rete"));
      x.ontimeout = () => reject(new Error("il PLC non risponde"));
      x.send(fd);
    });
  }
  async function getJson(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 3000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; } return await r.json(); }
    finally { clearTimeout(t); }
  }
  const post = (url, ms) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 5000);
    return fetch(url, { method: "POST", signal: ctl.signal }).then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, status: r.status, j }))).finally(() => clearTimeout(t)); };

  // Tabella delle partizioni del pacchetto diversa da quella del PLC → «Aggiorna» non basta (serve il recupero)
  function tableDiff(pt, plc) {
    if (!pt || !plc || !plc.length) return "";
    const key = x => `${x.name}@${x.addr}+${x.size}`;
    const a = pt.map(key).sort().join(","), b = plc.map(key).sort().join(",");
    if (a === b) return "";
    const ch = pt.filter(x => { const y = plc.find(z => z.name === x.name); return !y || y.addr !== x.addr || y.size !== x.size; })
                 .map(x => `${x.name} ${kb(x.size)}`);
    return ch.join(", ") || "partizioni diverse";
  }
  // ── Finestra ────────────────────────────────────────
  let pkg = null, busy = false, plcInfo = null, lastOk = false;
  let webChanged = false;                                // file dell'editor riscritti sul PLC in questo aggiornamento
  let fwSent = null;                                     // pacchetto il cui firmware è già sul PLC (file dell'editor non finiti)
  // Barra fluida come quella del Download: segue i progressi con un movimento morbido e, tra un aggiornamento e
  // l'altro, avanza alla velocità misurata fino a un secondo più avanti (senza superarlo): niente salti né fermi.
  const FB = (() => {
    let target = 0, shown = 0, limit = 0, raf = 0, rate = 0, lastF = 0, lastT = 0, on = false;
    const draw = () => {
      raf = 0;
      if (limit > target) target = Math.min(limit, target + rate / 60);
      if (target > shown) shown += Math.max(0.0008, (target - shown) * 0.15);
      if (shown > target || target - shown < 0.0005) shown = target;
      $("fw-bar").style.width = (shown * 100).toFixed(2) + "%";
      $("fw-pct").textContent = on ? Math.floor(shown * 100 + 1e-6) + " %" : "";
      if (on && (shown < target || limit > target)) raf = requestAnimationFrame(draw);
    };
    return {
      set(f) {                                           // f 0..1; -1 = barra vuota (nuova fase)
        const now = performance.now();
        if (f < 0 || f < lastF) { target = shown = limit = rate = lastF = 0; lastT = now; on = f >= 0; }
        else {
          on = true;
          if (lastT && f > lastF && now > lastT) rate = (f - lastF) / ((now - lastT) / 1000) * 0.7 + rate * 0.3;
          lastF = f; lastT = now;
          target = Math.max(target, f);
          limit = f >= 1 ? 1 : Math.min(0.995, f + rate);
        }
        if (!raf) raf = requestAnimationFrame(draw);
      },
    };
  })();
  const ui = {
    step(t) { $("fw-step").textContent = t; this.log(t); },
    log(t) { const l = $("fw-log"); l.textContent += new Date().toLocaleTimeString() + "  " + t + "\n"; l.scrollTop = l.scrollHeight; },
    bar(done, tot) { FB.set(tot ? Math.min(1, done / tot) : -1); },
    result(ok, t) { lastOk = ok; const r = $("fw-result"); r.className = ok ? "ok" : "bad"; r.textContent = (ok ? "✓ " : "✗ ") + t; this.log(t); },
  };
  function buildUi() {
    const cm = $("conn-modal");
    if (!cm || $("conn-fw")) return;
    const sec = document.createElement("div");
    sec.id = "conn-fw"; sec.className = "conn-fw";
    sec.innerHTML = `<div class="row"><b>Firmware</b> <span id="conn-fw-ver" class="muted"></span></div>
      <div class="row"><button id="conn-fw-upd" title="Firmware ed editor nuovi (PLC in STOP): impostazioni, simboli, log e programma restano">⭱ Aggiorna firmware…</button>
        <button id="conn-fw-rec" title="Scheda nuova o firmware che non parte: scrive tutto con il micro in modalità di caricamento (solo USB)">🛠 Recupero / prima installazione…</button></div>`;
    const before = cm.querySelector(".modal-box > .row.right");
    before.parentNode.insertBefore(sec, before);
    $("conn-fw-upd").onclick = () => openFw("update");
    $("conn-fw-rec").onclick = () => openFw("recovery");
    $("btn-conn") && $("btn-conn").addEventListener("click", refreshVer);

    const m = document.createElement("div");
    m.id = "fw-modal"; m.className = "modal hidden";
    m.innerHTML = `<div class="modal-box fw-box">
      <h3 id="fw-title">Firmware</h3>
      <div class="row"><label class="btn-label" for="fw-file">📂 Scegli il pacchetto (.miaplc.fw) o il backup (.miaplc.bkp)<input type="file" id="fw-file" accept=".fw,.bkp,.miaplc,.espplc,.bkesplc" hidden></label>
        <span id="fw-pkg" class="muted">nessun pacchetto scelto</span></div>
      <div id="fw-cmp" class="fw-cmp"></div>
      <label id="fw-wipe-row" class="hidden"><input type="checkbox" id="fw-wipe"> cancella anche impostazioni, simboli, log e programma del PLC (scheda come nuova)</label>
      <div id="fw-note" class="muted fw-note"></div>
      <div class="fw-prog"><div id="fw-step" class="fw-step">—</div>
        <div class="bar-track"><div id="fw-bar" class="bar-fill"></div></div><span id="fw-pct" class="muted"></span></div>
      <div id="fw-result"></div>
      <pre id="fw-log" class="fw-log"></pre>
      <div class="row right"><button id="fw-close">Chiudi</button><button id="fw-go" class="primary" disabled>Avvia</button></div>
    </div>`;
    document.body.appendChild(m);
    $("fw-file").onchange = async e => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      try { pkg = parsePackage(await f.arrayBuffer()); pkg.fileName = f.name; }
      catch (x) { pkg = null; $("fw-pkg").textContent = x.message; $("fw-go").disabled = true; return; }
      showPkg();
    };
    $("fw-close").onclick = () => { if (!busy) m.classList.add("hidden"); };
    $("fw-go").onclick = () => (m.dataset.kind === "recovery" ? runRecovery() : runUpdate());
  }
  async function refreshVer() {
    const el = $("conn-fw-ver");
    if (!el) return;
    try { plcInfo = await getJson("/api/fw/info", 3000); el.textContent = `sul PLC: ${plcInfo.version} (${plcInfo.env}) · avviato da ${plcInfo.running}`; }
    catch (e) { plcInfo = null; el.textContent = e.status === 404 ? "sul PLC: firmware senza aggiornamento dall'editor (usa il recupero via USB)" : "sul PLC: non collegato"; }
    const usbOk = window.EspUsb && EspUsb.hasSerial && !EspUsb.servedByPlc;
    $("conn-fw-rec").disabled = !usbOk;
    $("conn-fw-rec").title = usbOk ? "Scheda nuova o firmware che non parte: scrive tutto con il micro in modalità di caricamento (solo USB)"
      : "solo con l'editor aperto dal PC e un browser con la seriale (USB)";
  }
  function openFw(kind) {
    const m = $("fw-modal");
    m.dataset.kind = kind;
    $("fw-title").textContent = kind === "recovery" ? "Recupero / prima installazione (USB)" : "Aggiorna firmware";
    $("fw-wipe-row").classList.toggle("hidden", kind !== "recovery");
    $("fw-wipe").checked = false; $("fw-wipe").disabled = false;
    $("fw-note").innerHTML = kind === "recovery"
      ? "Per schede nuove o con un firmware che non parte. Il micro va in modalità di caricamento dal cavo USB (se non ci va: tieni premuto <b>BOOT</b>, premi e rilascia <b>RESET/EN</b>, rilascia BOOT e riprova). Il PLC si ferma. Ci vogliono 1–2 minuti."
      : "Il PLC va in STOP; firmware ed editor nuovi, poi il PLC si riavvia. Impostazioni, simboli, log e programma restano. Sulla rete o via USB.";
    $("fw-log").textContent = ""; $("fw-result").textContent = ""; $("fw-step").textContent = "—"; ui.bar(0, 0);
    if (pkg) showPkg(); else { $("fw-go").disabled = true; $("fw-pkg").textContent = "nessun pacchetto scelto"; $("fw-cmp").innerHTML = ""; }
    m.classList.remove("hidden");
    refreshVer().then(() => { if (pkg) showPkg(); });
  }
  function showPkg() {
    const h = pkg.head, kind = $("fw-modal").dataset.kind;
    $("fw-go").classList.remove("hidden");
    $("fw-pkg").textContent = pkg.backup ? `${pkg.fileName}: backup del PLC${h.name ? " «" + h.name + "»" : ""} del ${h.built || "?"}, firmware ${h.version}, scheda ${h.env}`
                                         : `${pkg.fileName}: versione ${h.version}, scheda ${h.env}, ${h.built || ""}`;
    let cmp = `<div>firmware ${kb(pkg.app.size)} · ${pkg.files.length} file dell'editor (${kb(pkg.files.reduce((t, f) => t + f.data.length, 0))})` +
              (h.recovery ? " · bootloader e partizioni" : "") + "</div>" +
              (pkg.backup ? `<div>backup: ${pkg.data.length} file dei dati (impostazioni, simboli) · ${pkg.program ? "programma" : "nessun programma"}${pkg.db ? " · valori dei DB" : ""}: si riscrivono sul PLC</div>` : "");
    let ok = true;
    if (kind === "recovery" && !h.recovery) { cmp += `<div class="bad">questo pacchetto non ha bootloader e partizioni: serve per il recupero un pacchetto completo</div>`; ok = false; }
    if (plcInfo) {
      cmp += `<div>sul PLC: ${esc(plcInfo.version)} (${esc(plcInfo.env)})${plcInfo.version === h.version ? " — stessa versione" : ""}</div>`;
      if (plcInfo.env !== h.env) cmp += `<div class="warn">⚠ il pacchetto è per la scheda «${esc(h.env)}», il PLC è «${esc(plcInfo.env)}»: I/O e impostazioni potrebbero non corrispondere</div>`;
      if (kind === "update" && pkg.app.size > (plcInfo.slot_bytes || Infinity)) { cmp += `<div class="bad">firmware più grande dello slot (${kb(plcInfo.slot_bytes)})</div>`; ok = false; }
      const td = tableDiff(h.table, plcInfo.table);
      if (td && kind === "update") { cmp += `<div class="bad">il pacchetto cambia le partizioni (${esc(td)}): serve il Recupero via USB. Prima fai il Backup del programma: impostazioni, simboli, log e programma si perdono</div>`; ok = false; }
      if (td && kind === "recovery") cmp += `<div class="warn">⚠ il pacchetto cambia le partizioni (${esc(td)}): dopo il recupero impostazioni, simboli, log e programma ripartono da zero. Prima fai il Backup del programma</div>`;
      if (kind === "recovery") { $("fw-wipe").checked = $("fw-wipe").checked || !!td; $("fw-wipe").disabled = !!td; }   // partizioni nuove: dati cancellati
    } else if (kind === "update") { cmp += `<div class="bad">PLC non collegato o firmware senza aggiornamento dall'editor: collegati, oppure usa il recupero (USB)</div>`; ok = false; }
    $("fw-cmp").innerHTML = cmp;
    $("fw-go").disabled = !ok || busy;
  }
  function begin() { busy = true; lastOk = false; $("fw-go").disabled = true; $("fw-close").disabled = true; $("fw-log").textContent = ""; $("fw-result").textContent = ""; ui.bar(0, 0); }
  // riuscito: resta solo «Chiudi»; «Avvia» torna scegliendo di nuovo un pacchetto
  function end() { busy = false; $("fw-close").disabled = false; if (lastOk) { pkg = null; $("fw-go").classList.add("hidden"); } $("fw-go").disabled = !pkg; }
  // conferma con la finestra dell'editor (#confirm-modal), sopra questa
  // altLabel: terzo pulsante, risponde "alt"
  function confirmBox(t, okLabel, altLabel) {
    return new Promise(resolve => {
      const m = $("confirm-modal"), ok = $("confirm-ok"), alt = $("confirm-alt"), cn = $("confirm-cancel");
      if (!m) { resolve(window.confirm(t)); return; }
      $("confirm-title").textContent = $("fw-title").textContent;
      $("confirm-body").textContent = t;
      ok.textContent = okLabel || "Continua";
      alt.textContent = altLabel || ""; alt.classList.toggle("hidden", !altLabel);
      const done = v => { m.classList.add("hidden"); alt.classList.add("hidden"); ok.onclick = alt.onclick = cn.onclick = null; resolve(v); };
      ok.onclick = () => done(true); alt.onclick = () => done("alt"); cn.onclick = () => done(false);
      m.classList.remove("hidden");
    });
  }

  // CRC-32 (come zlib e come /api/fw/files del PLC)
  let crcTab = null;
  function crc32(d) {
    if (!crcTab) crcTab = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    let c = 0xFFFFFFFF;
    for (let i = 0; i < d.length; i++) c = crcTab[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  // Firmware + file dell'editor + riavvio, con il PLC in STOP. Si mandano solo i file diversi da quelli sul PLC
  // (stessa dimensione e stesso CRC = uguale); firmware di prima senza /api/fw/files: tutti.
  async function filesTodo() {
    let have = null;
    try { have = new Map((await getJson("/api/fw/files", 10000)).files.map(x => [x.name, x])); } catch (e) {}
    const todo = pkg.files.filter(f => { const h = have && have.get(f.name); return !(h && h.bytes === f.data.length && (h.crc >>> 0) === crc32(f.data)); });
    // file messi da parte o di prima, avanzati dagli aggiornamenti del 24-10: un firmware senza la pulizia all'avvio li tiene
    const left = have ? [...have.values()].filter(x => /^[+-]/.test(x.name) && x.bytes > 0) : [];
    return { have, todo, left };
  }
  // Controllo prima di cominciare (Denys 25-10-2026): spazio dei file per il file più grande da scrivere (si scrive accanto
  // al vecchio, poi lo sostituisce), con un margine. I file avanzati si svuotano (un file vuoto con lo stesso nome)
  async function checkSpace(inf) {
    const { todo, left } = await filesTodo();
    if (!todo.length || !inf.fs_total) return null;
    for (const x of left) {
      const r = await upload("/api/fw/file?name=" + encodeURIComponent(x.name), new Uint8Array(0), null, 10000).catch(() => null);
      if (r && r.ok) ui.log(`${x.name}: file avanzato da un aggiornamento di prima, svuotato (${kb(x.bytes)})`);
    }
    const now = left.length ? await getJson("/api/fw/info", 3000).catch(() => inf) : inf;
    const free = now.fs_total - now.fs_used, big = Math.max(...todo.map(f => f.data.length)), need = big + 32768;
    return free < need ? `spazio dei file del PLC insufficiente: liberi ${kb(free)}, per i file dell'editor ne servono ${kb(need)} (il più grande ${kb(big)} + margine). Niente è stato cambiato` : null;
  }
  async function sendFiles() {
    const { have, todo } = await filesTodo();
    if (have) ui.log(`file dell'editor: ${todo.length} da aggiornare, ${pkg.files.length - todo.length} già uguali sul PLC`);
    webChanged = webChanged || todo.length > 0;
    const tot = todo.reduce((t, f) => t + f.data.length, 0);
    let done = 0;
    for (const f of todo) {
      ui.step(`file dell'editor: ${f.name}`);
      // 3 tentativi per file: dopo un errore si aspetta che il PLC risponda e si rimanda solo questo file
      for (let k = 1; ; k++) {
        let err;
        try {
          const r = await upload("/api/fw/file?name=" + encodeURIComponent(f.name), f.data, (l) => ui.bar(done + Math.min(l, f.data.length), tot), 30000);
          if (r.ok) break;
          err = r.j.msg || "HTTP " + r.status;
        } catch (e) { err = e.message; }
        if (k >= 3) throw new Error(`${f.name}: non caricato dopo 3 tentativi (${err})`);
        ui.log(`${f.name}: ${err} · tentativo ${k + 1}/3`);
        await waitPlc(10000);
      }
      done += f.data.length; ui.bar(done, tot);
    }
  }
  async function waitPlc(ms) {
    const t0 = Date.now();
    await sleep(1500);
    while (Date.now() - t0 < ms) {
      try { return await getJson("/api/fw/info", 2000); } catch (e) {}
      await sleep(1000);
    }
    return null;
  }
  // impronta del firmware: SHA-256 negli ultimi 32 byte dell'immagine (come la legge il PLC)
  const appSha = d => d.length > 32 ? Array.from(d.subarray(d.length - 32), b => b.toString(16).padStart(2, "0")).join("") : "";
  // era in RUN e l'operazione ha richiesto STOP: alla fine si chiede se ripartire
  async function askRun(wasRun) {
    if (!wasRun) return;
    let st = null;
    try { st = (await getJson("/api/plc/status", 3000)).state; } catch (e) { return; }
    if (st === "running") return;
    if (!await confirmBox("Per questa operazione il PLC è stato messo in STOP. Prima era in RUN.\nRimetterlo in RUN?", "Sì, RUN")) return;
    const r = await post("/api/plc/run").catch(() => null);
    ui.log(r && r.ok && r.j.state === "running" ? "PLC di nuovo in RUN" : "RUN non riuscito: " + (r ? (r.j.msg || r.j.state || r.status) : "nessuna risposta"));
  }
  async function runUpdate() {
    begin(); webChanged = false;
    let wasRun = false;
    try {
      const inf = await getJson("/api/fw/info", 3000).catch(e => { throw new Error(e.status === 404 ? "il firmware del PLC non ha l'aggiornamento dall'editor: usa il recupero (USB)" : "PLC non collegato"); });
      { const td = tableDiff(pkg.head.table, inf.table);
        if (td) throw new Error(`il pacchetto cambia le partizioni (${td}): serve il Recupero via USB (prima il Backup del programma)`); }
      // PLC (uplc) e il vecchio pacchetto del modulo I/O (uplc-io) hanno le stesse partizioni: uno può diventare l'altro, ma lo si chiede
      const what = e => e === "uplc-io" ? "modulo I/O" : /^uplc/.test(e) ? "PLC" : `scheda «${e}»`;
      if (inf.env !== pkg.head.env && !await confirmBox(`Il pacchetto è per ${what(pkg.head.env)} (${pkg.head.env}), qui c'è ${what(inf.env)} (${inf.env}). Aggiornare lo stesso?`)) { end(); return; }
      { const sp = await checkSpace(inf); if (sp) throw new Error(sp); }
      if (inf.plc_running) {
        wasRun = true;
        if (!await confirmBox("Il PLC è in RUN: per aggiornare va in STOP (le uscite si spengono). Continuare?")) { end(); return; }
        ui.step("PLC in STOP");
        const r = await post("/api/plc/stop");
        if (!r.ok) throw new Error("STOP non riuscito: " + (r.j.msg || r.status));
      }
      const sameFw = inf.app_sha && inf.app_sha === appSha(pkg.app.data);
      // firmware uguale a quello in esecuzione (impronta in fondo all'immagine): solo i file dell'editor, niente riavvio
      if (sameFw && !pkg.backup) {
        ui.log("firmware uguale a quello sul PLC: non si riscrive");
        await sendFiles();
        ui.result(true, "firmware uguale: aggiornati solo i file dell'editor" + (window.EspUsb && EspUsb.servedByPlc && webChanged ? " — la pagina si ricarica da sola" : ""));
        refreshVer();
        await askRun(wasRun);
        end(); reloadEditor(); return;
      }
      if (fwSent === pkg) ui.log("firmware già caricato: si riprovano solo i file dell'editor");
      else if (sameFw) ui.log("firmware uguale a quello sul PLC: non si riscrive");
      else {
        ui.step(`firmware ${pkg.head.version} nello slot ${inf.next} (${kb(pkg.app.size)})`);
        const t0 = Date.now();
        const r = await upload("/api/fw/app", pkg.app.data, (l, t) => ui.bar(l, t || pkg.app.size), 120000);
        if (!r.ok) throw new Error(r.j.msg || "firmware rifiutato (HTTP " + r.status + ")");
        ui.log(`firmware inviato in ${((Date.now() - t0) / 1000).toFixed(1)} s, controllato dal PLC`);
        fwSent = pkg;
      }
      // file non caricati con il firmware nuovo già nello slot: niente domande a metà (Denys 25-10-2026), ci si ferma qui
      try { await sendFiles(); }
      catch (e) {
        ui.log(e.message);
        throw new Error(`file dell'editor non caricati (${e.message}): il firmware nuovo è nello slot e vale dal riavvio. ` +
                        "Il PLC resta in STOP con l'editor di prima, RUN rifiutato fino al riavvio. «Avvia» riprova solo i file");
      }
      if (pkg.backup) await restoreBackup(pkg);
      fwSent = null;
      ui.step("riavvio del PLC"); ui.bar(0, 0);
      await post("/api/plc/reboot?after=stop").catch(() => {});   // resta in STOP: alla fine si chiede se RUN
      const now = await waitPlc(45000);
      if (!now) throw new Error("il PLC non risponde dopo il riavvio (se non riparte: recupero via USB)");
      if (pkg.backup) await restoreDb(pkg.db);
      if (now.version === pkg.head.version) ui.result(true, (pkg.backup ? `backup caricato: firmware ${now.version}, impostazioni, simboli e programma del backup` : `aggiornato: firmware ${now.version}, avviato da ${now.running}`) +
                                                      (window.EspUsb && EspUsb.servedByPlc && webChanged ? " — la pagina si ricarica da sola" : ""));
      else ui.result(false, `il PLC è ripartito con la versione ${now.version} (non ${pkg.head.version}): il firmware nuovo non è partito`);
      refreshVer();
      await askRun(wasRun);
      if (now.version === pkg.head.version) { end(); reloadEditor(); return; }
    } catch (e) { ui.result(false, e.message); }
    end();
  }
  // editor servito dal PLC e aggiornato: la pagina si ricarica da sola con i file nuovi (no-cache: riletti dal PLC)
  function reloadEditor() {
    if (window.EspUsb && EspUsb.single && webChanged && EspUsb.checkGui) {   // editor in un file (USB): subito il banner per aggiornarlo
      [500, 3000].forEach(ms => setTimeout(() => EspUsb.checkGui(), ms));
      return;
    }
    if (!(window.EspUsb && EspUsb.servedByPlc) || !webChanged) return;   // solo se i file dell'editor sono cambiati
    ui.log("ricarico la pagina con l'editor nuovo…");
    window.ESPPLC_RELOAD = true;                         // modifiche dell'editor: restano nella bozza, niente domanda
    setTimeout(() => location.reload(), 1500);
  }

  // Recupero: modalità di caricamento, scrittura e controllo, riavvio, poi i file dell'editor
  async function runRecovery() {
    const wipe = $("fw-wipe").checked;
    if (!await confirmBox("Recupero: il PLC si ferma e il firmware viene riscritto" + (wipe ? ", impostazioni, simboli, log e programma vengono CANCELLATI" : "") + ". Continuare?")) return;
    begin();
    let port = null, rom = null, wasRun = false;
    try {
      if (window.EspUsb && EspUsb.connected()) {
        try { wasRun = (await getJson("/api/plc/status", 3000)).state === "running"; } catch (e) {}
        ui.step("PLC in STOP (la protezione del reset si stacca)");
        await post("/api/plc/stop", 3000).catch(() => {});
        await sleep(300);
      }
      port = window.EspUsb ? await EspUsb.release() : null;
      if (!port) {
        const ps = await navigator.serial.getPorts();
        port = ps.length === 1 ? ps[0] : await navigator.serial.requestPort();
      }
      rom = Rom(port, t => ui.log(t));
      await rom.open();
      ui.step("micro in modalità di caricamento");
      let ok = await rom.sync(true, 3);
      if (!ok) {
        ui.log("il reset dal cavo non porta il micro in caricamento (protezione del reset attiva, o scheda senza circuito automatico)");
        if (await confirmBox("Il micro non entra in modalità di caricamento da solo.\nTieni premuto BOOT, premi e rilascia RESET/EN, poi rilascia BOOT e premi OK.")) ok = await rom.sync(false, 3);
      }
      if (!ok) throw new Error("il micro non entra in modalità di caricamento");
      const magic = await rom.chip();
      const chipName = pkg.head.chip || "esp32";
      if (!(CHIP_MAGIC[chipName] || []).includes(magic)) {
        const other = Object.keys(CHIP_MAGIC).find(k => CHIP_MAGIC[k].includes(magic));
        throw new Error(`micro diverso da quello del pacchetto (${chipName}): ${other || hex(magic, 8)}`);
      }
      rom.setChip(chipName);
      ui.log("micro riconosciuto: " + chipName);
      await rom.attach(4 * 1024 * 1024);
      if (wipe) {
        for (const p of (pkg.head.table || []).filter(x => x.type === "data" && x.name !== "otadata")) {
          ui.step(`cancello ${p.name} (${hex(p.addr)}, ${kb(p.size)})`);
          await rom.erase(p.addr, p.size);
        }
      }
      const parts = pkg.parts.slice().sort((a, b) => a.addr - b.addr);
      const tot = parts.reduce((t, p) => t + p.size, 0);
      let done = 0;
      const t0 = Date.now();
      for (const p of parts) {
        ui.step(`scrivo ${p.name} a ${hex(p.addr)} (${kb(p.size)})`);
        const comp = await rom.write(p.addr, p.data, (i, n) => ui.bar(done + p.size * i / n, tot));
        ui.log(`${p.name}: ${kb(comp)} compressi`);
        const m = await rom.md5(p.addr, p.size);
        const want = p.md5 || md5(p.data);
        if (m !== want) throw new Error(`${p.name}: controllo fallito (MD5 ${m} invece di ${want})`);
        done += p.size; ui.bar(done, tot);
        ui.log(`${p.name}: controllato (MD5)`);
      }
      ui.log(`scritto e controllato in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      ui.step("riavvio del micro");
      await rom.hardReset();
      await rom.close(); rom = null;
      if (window.EspUsb && EspUsb.on()) {
        ui.step("collegamento con il PLC");
        await sleep(1500);
        let on = false;                                 // dopo la cancellazione il PLC formatta i file all'avvio: più attesa
        for (let i = 0; i < (wipe ? 15 : 5) && !on; i++) { on = await EspUsb.resume(port).catch(() => false); if (!on) await sleep(1500); }
        if (!on) throw new Error("scritto, ma il PLC non risponde sulla USB dopo il riavvio: premi RESET sulla scheda e ricollega");
        const inf = await waitPlc(10000);
        if (inf) ui.log(`PLC ripartito: firmware ${inf.version}`);
        await sendFiles();
        if (pkg.backup) {                               // backup: dati e programma, riavvio, valori dei DB
          await restoreBackup(pkg);
          ui.step("riavvio del PLC"); ui.bar(0, 0);
          await post("/api/plc/reboot?after=stop").catch(() => {});
          if (!(await waitPlc(45000))) throw new Error("backup scritto, ma il PLC non risponde dopo il riavvio: premi RESET e ricollega");
          await restoreDb(pkg.db);
          ui.result(true, `recupero dal backup riuscito: firmware ${pkg.head.version}, impostazioni, simboli e programma del backup`);
        } else
          ui.result(true, `recupero riuscito: firmware ${inf ? inf.version : pkg.head.version}` + (wipe ? ", PLC come nuovo" : ", impostazioni e programma conservati"));
        if (!wipe || pkg.backup) await askRun(wasRun);
      } else {
        ui.result(true, "firmware scritto e controllato; per i file dell'editor collegati e usa «Aggiorna firmware»");
      }
      refreshVer();
    } catch (e) {
      ui.result(false, e.message);
      if (rom) { try { await rom.hardReset(); } catch (x) {} await rom.close(); }
      if (window.EspUsb && EspUsb.on() && port) EspUsb.resume(port).catch(() => {});
    }
    end();
  }


  // ── Backup del PLC (.bkesplc) ───────────────────────
  // Stesso contenitore del pacchetto .espplc, con il firmware in esecuzione letto dalla flash, bootloader,
  // tabella delle partizioni, file dell'editor, file dei dati (impostazioni, simboli), programma e valori dei DB.
  // Si carica con «Aggiorna firmware» sullo stesso PLC (le partizioni non si riscrivono) o con il Recupero (scheda nuova).
  const BOOT_APP0 = (() => { const b = new Uint8Array(8192).fill(0xFF); b.set([1, 0, 0, 0], 0); b.set([0x9a, 0x98, 0x43, 0x47], 28); b.set([0, 0, 0, 0], 4096); return b; })();
  const hexOf = u8 => Array.from(u8, b => b.toString(16).padStart(2, "0")).join("");
  const fromHex = h => { const o = new Uint8Array((h || "").length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const fromB64 = s => { const t = atob(s || ""), o = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) o[i] = t.charCodeAt(i); return o; };
  async function getBin(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 60000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) { let m = ""; try { m = (await r.json()).msg || ""; } catch (e) {} throw new Error(`${url}: ${m || "HTTP " + r.status}`); }
      return new Uint8Array(await r.arrayBuffer());
    } finally { clearTimeout(t); }
  }
  // tabella delle partizioni (voci da 32 byte che cominciano con AA 50)
  function readTable(pt) {
    const out = [], dv = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
    for (let o = 0; o + 32 <= pt.length && pt[o] === 0xAA && pt[o + 1] === 0x50; o += 32)
      out.push({ name: String.fromCharCode(...pt.subarray(o + 12, o + 28)).replace(/[\0\xff][\s\S]*$/, ""), type: pt[o + 2] === 0 ? "app" : "data",
                 subtype: String(pt[o + 3]), addr: dv.getUint32(o + 4, true), size: dv.getUint32(o + 8, true) });
    return out;
  }
  async function makeBackup(log) {
    const inf = await getJson("/api/fw/info", 5000);
    log("firmware in esecuzione");
    const app = await getBin("/api/fw/image?part=app", 180000);
    if (app[0] !== 0xE9) throw new Error("immagine del firmware non valida");
    if (inf.app_sha && hexOf(app.subarray(app.length - 32)) !== inf.app_sha) throw new Error("firmware letto male (impronta diversa): riprova");
    log("bootloader e tabella delle partizioni");
    const boot = await getBin("/api/fw/image?part=boot"), pt = await getBin("/api/fw/image?part=ptable");
    const table = readTable(pt), a0 = table.find(t => t.type === "app");
    if (!a0) throw new Error("tabella delle partizioni illeggibile");
    const files = [], data = [];
    for (const f of (await getJson("/api/fw/files?names=1", 10000)).files) { log("editor: " + f.name); files.push({ name: f.name, data: await getBin("/api/fw/gui?name=" + encodeURIComponent(f.name)) }); }
    for (const f of (await getJson("/api/fw/files?data=1", 10000)).files) { log("dati: " + f.name); data.push({ name: f.name, data: await getBin("/api/fw/gui?data=1&name=" + encodeURIComponent(f.name)) }); }
    log("programma");
    let prog = null;
    try { prog = await getJson("/api/plc/program", 20000); } catch (e) { if (e.status !== 404) throw e; }
    log("valori dei DB");
    let db = null;
    try {
      db = new Uint8Array(8192);
      for (let off = 0; off < db.length; off += 2048) db.set(fromHex((await getJson(`/api/plc/db?off=${off}&len=2048`, 5000)).hex).subarray(0, 2048), off);
    } catch (e) { db = null; }
    let name = "";
    try { name = (await getJson("/api/plc/ident", 3000)).name || ""; } catch (e) {}
    const enc = new TextEncoder(), blobs = [];
    let off = 0;
    const add = d => { blobs.push(d); const o = off; off += d.length; return o; };
    const parts = [["bootloader", 0x1000, boot], ["partitions", 0x8000, pt], ["boot_app0", 0xe000, BOOT_APP0], ["app", a0.addr, app]]
      .map(([n, addr, d]) => ({ name: n, addr, off: add(d), size: d.length, md5: md5(d) }));
    const pj = prog ? enc.encode(JSON.stringify({ crc32: prog.crc32, bytecode_hex: prog.bytecode_hex || "", source_b64gz: prog.source_b64gz || "" })) : null;
    const head = { format: "espplc-bk", v: 1, version: inf.version, env: inf.env, chip: inf.chip || "esp32",
      built: new Date().toLocaleString(), name, recovery: true, parts, table,
      files: files.map(f => ({ name: f.name, off: add(f.data), size: f.data.length })),
      data: data.map(f => ({ name: f.name, off: add(f.data), size: f.data.length })),
      program: pj ? { off: add(pj), size: pj.length } : null, db: db ? { off: add(db), size: db.length } : null };
    const hj = enc.encode(JSON.stringify(head)), out = new Uint8Array(12 + hj.length + off);
    out.set(enc.encode("ESPPLCPK"), 0);
    new DataView(out.buffer).setUint32(8, hj.length, true);
    out.set(hj, 12);
    let p = 12 + hj.length;
    for (const b of blobs) { out.set(b, p); p += b.length; }
    return { data: out, head };
  }
  // Backup dalla Diagnostica (o da chi lo chiede): file .miaplc.bkp scaricato (modulo I/O µLink: .miaulink.bkp). → { name, bytes }
  async function backup(log) {
    const r = await makeBackup(log || (() => {}));
    const d = new Date(), p = n => String(n).padStart(2, "0");
    const safe = (r.head.name || r.head.env || "plc").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "plc";
    const name = `backup-${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${r.head.env === "uplc-io" ? ".miaulink.bkp" : ".miaplc.bkp"}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.data], { type: "application/octet-stream" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return { name, bytes: r.data.length };
  }
  // Caricamento del backup, PLC in STOP: file dei dati e programma (prima del riavvio)
  async function restoreBackup(p) {
    for (const f of p.data) {
      ui.step(`dati del PLC: ${f.name}`);
      const r = await upload("/api/fw/file?data=1&name=" + encodeURIComponent(f.name), f.data, null, 30000);
      if (!r.ok) throw new Error(`${f.name}: ${r.j.msg || "HTTP " + r.status}`);
    }
    if (p.program && p.program.bytecode_hex) {
      ui.step("programma");
      const blob = window.buildWireBlob(fromHex(p.program.bytecode_hex), fromB64(p.program.source_b64gz));
      const r = await upload("/api/plc/program/test?stop=1", blob, (l, t) => ui.bar(l, t || blob.length), 120000);
      if (!r.ok) throw new Error("programma non caricato: " + (r.j.msg || "HTTP " + r.status));
      ui.log(`programma caricato (${kb(blob.length)})`);
    }
  }
  // Dopo il riavvio (PLC in STOP): valori dei DB, solo i pezzi diversi da quelli di adesso
  async function restoreDb(db) {
    if (!db) return;
    ui.step("valori dei DB");
    let n = 0;
    for (let off = 0; off < db.length; off += 2048) {
      let cur;
      try { cur = fromHex((await getJson(`/api/plc/db?off=${off}&len=2048`, 5000)).hex); } catch (e) { break; }
      for (let k = 0; k < 2048; k += 64) {
        const want = db.subarray(off + k, off + k + 64), now = cur.subarray(k, k + 64);
        if (want.every((v, i) => v === now[i])) continue;
        const r = await fetch("/api/plc/db", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ off: off + k, hex: hexOf(want) }) });
        if (!r.ok) throw new Error("valori dei DB non rimessi (HTTP " + r.status + ")");
        n++;
      }
    }
    ui.log(n ? `valori dei DB rimessi (${n} pezzi da 64 byte)` : "valori dei DB già uguali");
  }
  async function openFile(file) {
    pkg = parsePackage(await file.arrayBuffer()); pkg.fileName = file.name;
    openFw("update");
  }

  window.EspFw = { parsePackage, md5, deflate, Rom, open: openFw, backup, openFile };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUi); else buildUi();
})();
