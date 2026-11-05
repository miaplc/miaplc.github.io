// ============================================================
//  EspPlc — usb.js
//  Collegamento dell'editor con il PLC:
//    SIMULATORE  PLC simulato nel browser (dev/mock-plc.js, solo editor aperto dal PC)
//    USB         cavo USB, seriale dal browser (Web Serial). Solo editor aperto dal PC
//                (file o localhost): la pagina servita dal PLC in rete non può usare la seriale.
//    RETE        pagina servita dal PLC (http://uplc.lan, http://10.10.10.1…)
//
//  In USB le richieste /api/* dell'editor viaggiano in pacchetti sulla seriale e il PLC le
//  passa agli STESSI gestori dell'API web (firmware: serial_link.cpp). Il resto dell'editor
//  non cambia: questo file sostituisce solo il trasporto (window.fetch per /api/*).
//
//  Pacchetto:  A5 5A | tipo | seq | lunghezza (2 B, LE) | dati ≤ 2048 | CRC-16/CCITT-FALSE (2 B, LE)
//  Velocità: si parte a 115200, HELLO propone la più alta, il PLC risponde e passa a quella;
//  il browser riapre la porta alla velocità nuova e conferma (SPEED_OK). Se non si parlano si
//  scende alla successiva.
// ============================================================
(function () {
  "use strict";

  const LS = "espplc.conn";
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const qs = new URLSearchParams(location.search);
  const isHttp = /^https?:$/.test(location.protocol || "");
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname || "");
  const servedByPlc = isHttp && !isLocalHost;
  const hasSerial = !!navigator.serial;
  const hasSim = !!window.__mockPlc;
  const single = !!window.ESPPLC_SINGLE;              // editor in un file solo, scaricato dal PLC

  // ── Modalità ────────────────────────────────────────
  let mode;
  if (servedByPlc) mode = "net";
  else if (qs.has("usb")) mode = "usb";
  else if (hasSim) mode = "sim";
  else if (lsGet("espplc.mock2.device")) mode = "net";  // editor dal PC verso un PLC in rete (?device=IP)
  else if (isHttp && lsGet(LS) !== "usb") mode = "net"; // localhost: server di prova
  else mode = "usb";                                    // file dal PC senza simulatore
  if (!servedByPlc && (qs.has("mock") || qs.has("usb"))) lsSet(LS, mode);

  function switchMode(m) {
    if (m === mode) return;
    lsSet(LS, m);
    const q = new URLSearchParams(location.search);
    q.delete("mock"); q.delete("usb"); q.delete("device");
    if (m === "sim") q.set("mock", "");
    if (m === "usb") q.set("usb", "");
    const s = q.toString().replace(/=(&|$)/g, "$1");
    location.href = location.pathname + (s ? "?" + s : "") + location.hash;
  }

  // ── Pacchetti ───────────────────────────────────────
  const T = { HELLO: 0x01, SPEED_OK: 0x02, PING: 0x03, REQ: 0x10, BODY: 0x11, ABORT: 0x12,
              HELLO_ACK: 0x81, SPEED_ACK: 0x82, ACK: 0x83, NAK: 0x84, PONG: 0x85, RESP: 0x90, RDATA: 0x91, REND: 0x92 };
  const NAK_CRC = 1, NAK_TOO_BIG = 3;
  const PROTO = 1, MAX_DATA = 2048, BAUD_SAFE = 115200;
  const BAUDS = [921600, 460800, 230400, 115200];
  const METHODS = ["GET", "POST", "PUT", "DELETE"];

  function crc16(d, crc = 0xFFFF) {
    for (let i = 0; i < d.length; i++) {
      crc ^= d[i] << 8;
      for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
  }
  function frame(type, seq, data) {
    const n = data ? data.length : 0;
    const f = new Uint8Array(8 + n);
    f[0] = 0xA5; f[1] = 0x5A; f[2] = type; f[3] = seq & 255; f[4] = n & 255; f[5] = n >> 8;
    if (n) f.set(data, 6);
    const c = crc16(f.subarray(2, 6 + n));
    f[6 + n] = c & 255; f[7 + n] = c >> 8;
    return f;
  }
  const put32 = (p, o, v) => { p[o] = v & 255; p[o + 1] = (v >>> 8) & 255; p[o + 2] = (v >>> 16) & 255; p[o + 3] = (v >>> 24) & 255; };
  const get32 = (p, o) => (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)) >>> 0;

  // Lettura: cerca A5 5A, intestazione, dati, CRC (come feed() nel firmware). I byte fuori dai
  // pacchetti sono testo (log del PLC prima che l'editor lo spenga): vanno a onText.
  function Parser(onFrame, onText, onBad) {
    const rx = new Uint8Array(8 + MAX_DATA);
    let n = 0;
    this.reset = () => { n = 0; };
    // pacchetto rovinato: si rileggono i byte dopo il suo A5 (dentro può esserci il pacchetto buono successivo)
    const bad = () => { const back = rx.slice(1, n); n = 0; this.feed(back); };
    this.feed = data => {
      for (let i = 0; i < data.length; i++) {
        const b = data[i];
        if (n === 0) { if (b === 0xA5) rx[n++] = b; else onText(b); continue; }
        if (n === 1) { if (b === 0x5A) rx[n++] = b; else { onText(0xA5); n = 0; if (b === 0xA5) rx[n++] = b; else onText(b); } continue; }
        rx[n++] = b;
        if (n < 6) continue;
        const len = rx[4] | (rx[5] << 8);
        if (len > MAX_DATA) { onBad(); bad(); continue; }
        if (n < 8 + len) continue;
        const c = rx[6 + len] | (rx[7 + len] << 8);
        if (crc16(rx.subarray(2, 6 + len)) !== c) { onBad(rx[2], rx[3]); bad(); continue; }
        n = 0;
        onFrame(rx[2], rx[3], rx.slice(6, 6 + len));
      }
    };
  }

  // ── Trasporto USB ───────────────────────────────────
  const U = {
    port: null, reader: null, writer: null, readDone: null, baud: 0,
    state: "off",            // off | connecting | on | lost
    info: null,              // { proto, baud, uptime, reset, version, at }
    msg: "",                 // ultimo messaggio per l'utente
    seq: 0, gen: 0, waits: [], busy: 0, lastTx: 0, lastRx: 0, bad: 0, closing: false,
    text: "", onText: null, listeners: [],
  };
  const parser = new Parser(onFrame, onTextByte, () => { U.bad++; });
  const nextSeq = () => (U.seq = (U.seq + 1) & 255);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function onTextByte(b) {
    if (b === 10) { const line = U.text.replace(/\r$/, ""); U.text = ""; if (U.onText) U.onText(line); return; }
    if (U.text.length < 400) U.text += String.fromCharCode(b);
  }
  function onFrame(type, seq, data) {
    U.lastRx = Date.now();
    for (const w of U.waits.slice()) if (w.match(type, seq, data)) { /* gestito */ }
  }
  // Aspetta un pacchetto: match(type, seq, data) → true quando è quello giusto
  function waitFrame(pred, ms) {
    return new Promise((resolve, reject) => {
      const w = { match: (t, s, d) => { if (!pred(t, s, d)) return false; done(); resolve({ type: t, seq: s, data: d }); return true; } };
      const timer = setTimeout(() => { done(); reject(new Error("timeout")); }, ms);
      function done() { clearTimeout(timer); const i = U.waits.indexOf(w); if (i >= 0) U.waits.splice(i, 1); }
      U.waits.push(w);
    });
  }
  async function send(type, seq, data) {
    if (!U.writer) throw new Error("porta chiusa");
    U.lastTx = Date.now();
    await U.writer.write(frame(type, seq, data));
  }
  function emit() {
    for (const f of U.listeners) { try { f(U.state, U); } catch (e) {} }
    window.dispatchEvent(new CustomEvent("espplc-usb", { detail: { state: U.state } }));
  }
  function setState(s, msg, why) { U.state = s; U.why = why || ""; if (msg !== undefined) U.msg = msg; emit(); }   // why: porta aperta ma senza risposta, porta al firmware, cavo

  async function openAt(b) {
    await U.port.open({ baudRate: b, bufferSize: 16384 });
    U.baud = b; parser.reset();
    U.writer = U.port.writable.getWriter();
    const port = U.port;
    // errori non gravi (break, framing, parità, buffer pieno: capitano al cambio di velocità) → si riprende a leggere
    U.readDone = (async () => {
      while (port.readable && !U.closing) {
        const r = U.reader = port.readable.getReader();
        try { for (;;) { const { value, done } = await r.read(); if (done) break; if (value) parser.feed(value); } }
        catch (e) {
          if (/Break|Framing|Parity|BufferOverrun/.test(e.name)) continue;
          if (!U.closing) lost("lettura interrotta: " + e.message);
          return;
        }
        finally { try { r.releaseLock(); } catch (e) {} }
        if (U.closing) return;
      }
    })();
  }
  async function closePort() {
    U.closing = true;
    try { if (U.reader) await U.reader.cancel(); } catch (e) {}
    try { await U.readDone; } catch (e) {}
    try { if (U.writer) U.writer.releaseLock(); } catch (e) {}
    U.reader = U.writer = null;
    try { await U.port.close(); } catch (e) {}
    U.baud = 0; U.closing = false;
  }
  async function reopen(b) { await closePort(); await openAt(b); }

  // HELLO alla velocità aperta ora: → info o null
  async function hello(want, tries) {
    for (let i = 0; i < tries; i++) {
      const s = nextSeq();
      const p = new Uint8Array(6); p[0] = PROTO; put32(p, 1, want); p[5] = patience;   // [5]: secondi di silenzio tollerati (firmware vecchio: ignorato)
      const w = waitFrame((t, q) => t === T.HELLO_ACK && q === s, 500);
      w.catch(() => {});
      try { await send(T.HELLO, s, p); const f = await w; const d = f.data;
        return { proto: d[0], baud: get32(d, 1), uptime: get32(d, 5), reset: d[9],
                 version: new TextDecoder().decode(d.subarray(10)), at: Date.now() };
      } catch (e) { w.catch(() => {}); }
    }
    return null;
  }
  async function speedOk() {
    for (let i = 0; i < 3; i++) {
      const s = nextSeq();
      const w = waitFrame((t, q) => t === T.SPEED_ACK && q === s, 250);
      w.catch(() => {});
      try { await send(T.SPEED_OK, s, null); await w; return true; } catch (e) { w.catch(() => {}); }
    }
    return false;
  }
  // Collegamento: 115200, HELLO con la velocità voluta, riapertura alla velocità concordata,
  // conferma. Se la velocità alta non regge (cavo lungo, chip lento) si scende.
  async function handshake(maxBaud) {
    const wants = BAUDS.filter(b => b <= maxBaud);
    for (const want of wants) {
      if (U.baud !== BAUD_SAFE) await reopen(BAUD_SAFE);
      let info = await hello(want, 3);
      if (!info) {
        // il PLC è ancora alla velocità alta di un collegamento di pochi secondi fa?
        for (const b of BAUDS.filter(x => x !== BAUD_SAFE)) {
          await reopen(b);
          info = await hello(b, 1);
          if (info) return info;
        }
        return null;
      }
      if (info.baud === BAUD_SAFE) return info;
      await reopen(info.baud);
      if (await speedOk()) return info;
      await reopen(BAUD_SAFE);
      await sleep(1100);                              // il PLC torna da solo a 115200 dopo 1 s
    }
    return null;
  }

  let keepTimer = 0, keepFails = 0, connectP = null, prevInfo = null, wantMax = 921600;
  // Pazienza: secondi senza pacchetti prima che il PLC consideri l'editor scollegato (5 s; di più se la
  // pagina resta ferma a lungo, ad esempio a disegnare un programma enorme). Va al PLC con HELLO e PING.
  let patience = 5;
  function setPatience(sec) {
    const v = Math.max(5, Math.min(60, Math.round(sec)));
    if (v === patience) return Promise.resolve();
    patience = v;
    if (U.state !== "on") return Promise.resolve();
    U.lastTx = Date.now();
    return send(T.PING, nextSeq(), new Uint8Array([v])).catch(() => {});   // la PONG non serve: basta che parta
  }
  function keepalive() {
    clearInterval(keepTimer);
    keepTimer = setInterval(async () => {
      if (U.state !== "on") return;
      // richieste in corso ma niente dal PLC da 5 s o più (pazienza; non durante un Download: il PLC installa)
      if (U.busy) { if (!U.upload && !U.sent && Date.now() - U.lastRx > patience * 1000) lost("il PLC non risponde"); return; }
      if (Date.now() - U.lastTx < 1500) return;
      const s = nextSeq();
      const w = waitFrame((t, q) => t === T.PONG && q === s, 1200);
      w.catch(() => {});
      try { await send(T.PING, s, new Uint8Array([patience])); await w; keepFails = 0; }
      catch (e) { w.catch(() => {}); if (++keepFails >= 2) lost("il PLC non risponde"); }
    }, 1000);
  }
  function lost(why) {
    if (U.state !== "on") return;
    keepFails = 0;
    setState("lost", "collegamento perso: " + why);
    reconnectSoon(1000);
  }
  let reconnTimer = 0;
  function reconnectSoon(ms) {
    clearTimeout(reconnTimer);
    reconnTimer = setTimeout(async () => {
      if (U.state === "on" || U.state === "connecting" || U.state === "off" || U.held) return;
      const ok = await connect(null, true).catch(() => false);
      if (!ok && U.state === "lost") reconnectSoon(2000);
    }, ms);
  }
  // Rilevo un riavvio del PLC dal tempo di accensione: prima del collegamento era acceso da X ms
  function rebootNote(info) {
    const r = { rebooted: false, justStarted: info.uptime < 4000 };
    if (prevInfo) {
      const expected = prevInfo.uptime + (info.at - prevInfo.at);
      r.rebooted = info.uptime + 3000 < expected;
    }
    return r;
  }

  // Collega: port = porta scelta (null = l'ultima già autorizzata). quiet = senza aprire finestre.
  async function connect(port, quiet) {
    if (connectP) return connectP;
    connectP = (async () => {
      try {
        if (!hasSerial) { setState("off", "questo browser non ha la seriale (Web Serial)"); return false; }
        if (!port) port = U.port;
        if (!port && U.chooseNext) { setState("off", "scollegato: «Collega…» per scegliere la porta"); return false; }
        if (!port) { const ps = await navigator.serial.getPorts(); if (ps.length === 1) port = ps[0]; else if (ps.length > 1) port = ps.find(p => p === U.lastPort) || ps[0]; }
        if (!port) { setState("off", "nessuna porta scelta"); return false; }
        if (U.port && U.port !== port && U.baud) await closePort();
        U.port = port; U.lastPort = port;
        setState("connecting", "collegamento…");
        if (U.baud) await closePort();
        try { await openAt(BAUD_SAFE); }
        catch (e) { setState(quiet ? "lost" : "off", "porta non apribile (occupata da un altro programma o scheda?): " + e.message); return false; }
        const info = await handshake(wantMax);
        if (!info) { await closePort(); setState(quiet ? "lost" : "off", "il PLC non risponde sulla porta (firmware senza USB, porta sbagliata o PLC spento)", "noresp"); return false; }
        const rb = rebootNote(info);
        U.info = info; prevInfo = info;
        U.note = rb.rebooted ? "il PLC si è riavviato" : rb.justStarted ? "il PLC si è appena acceso: forse si è riavviato aprendo la porta (vedi ? → riavvio)" : "";
        U.lastRx = Date.now();
        U.gen++;
        keepalive();
        setState("on", `USB ${info.baud}`);
        return true;
      } finally { connectP = null; }
    })();
    return connectP;
  }
  // Porta prestata al recupero del firmware (modalità di caricamento del micro): niente pacchetti,
  // niente ricollegamento automatico finché non torna con resume()
  async function release() {
    clearInterval(keepTimer); clearTimeout(reconnTimer);
    U.held = true;
    if (connectP) await connectP.catch(() => {});
    if (U.baud) await closePort();
    setState("off", "porta usata per il firmware", "held");
    return U.port;
  }
  async function resume(port) {
    U.held = false;
    if (port) U.port = port;
    return connect(port || U.port, false);
  }
  // Scollega chiesto da chi usa l'editor: al prossimo «Collega…» si sceglie di nuovo la porta (non l'ultima)
  async function disconnect() {
    clearInterval(keepTimer); clearTimeout(reconnTimer);
    setState("off", "scollegato");
    if (U.baud) await closePort();
    U.port = null; U.chooseNext = true;
  }
  async function choosePort() {
    if (!hasSerial) throw new Error("seriale non disponibile in questo browser");
    const p = await navigator.serial.requestPort();
    U.chooseNext = false;
    return connect(p, false);
  }
  if (hasSerial) {
    // cavo staccato: si chiude; ricollegato (stessa scheda): si ricollega da solo
    navigator.serial.addEventListener("disconnect", e => {
      if (mode !== "usb" || !U.port || (e.port || e.target) !== U.port || U.state === "off") return;
      clearInterval(keepTimer); clearTimeout(reconnTimer);
      setState("lost", "cavo scollegato", "cable");
      closePort();
    });
    navigator.serial.addEventListener("connect", e => {
      if (mode !== "usb" || U.state !== "lost" || U.held) return;
      setTimeout(() => { if (U.state === "lost") connect(e.port || e.target, true).then(ok => { if (!ok) reconnectSoon(2000); }); }, 800);
    });
  }

  // ── Richieste (una alla volta, come l'API web vista dal PLC) ──
  let queue = Promise.resolve();
  function request(m, url, body, upload, opt) {
    const p = queue.then(() => doRequest(m, url, body, upload, opt || {}));
    queue = p.catch(() => {});
    return p;
  }
  function abortErr() { return new DOMException("annullata", "AbortError"); }
  async function sendWaitAck(type, seq, data, ms, signal) {
    for (let i = 0; i < 4; i++) {
      if (signal && signal.aborted) throw abortErr();
      const w = waitFrame((t, q) => (t === T.ACK || t === T.NAK) && q === seq, ms);
      w.catch(() => {});
      await send(type, seq, data);
      let f;
      try { f = await w; } catch (e) { continue; }                       // perso: si rimanda
      if (f.type === T.ACK) return 0;
      if (f.data[0] === NAK_CRC) continue;                              // rovinato: si rimanda
      return f.data[0] || 5;
    }
    throw new Error("il PLC non conferma");
  }
  async function doRequest(m, url, body, upload, opt) {
    if (U.state !== "on") {
      if (connectP) await connectP.catch(() => {});
      else if (U.state === "off" && !U.tried) { U.tried = true; await connect(null, true).catch(() => {}); }
    }
    if (U.state !== "on") throw new TypeError("Failed to fetch (USB: PLC non collegato)");
    const signal = opt.signal, gen = U.gen;
    if (signal && signal.aborted) throw abortErr();
    U.busy++; if (upload) U.upload = true;
    try {
      const ub = new TextEncoder().encode(url);
      const len = body ? body.length : 0;
      const p = new Uint8Array(6 + ub.length);
      p[0] = m; p[1] = upload ? 1 : 0; put32(p, 2, len); p.set(ub, 6);
      const rseq = nextSeq();
      // risposta: RESP [stato][tipo], RDATA…, REND (seq = quello della REQ)
      let status = 0, type = "", parts = [], size = 0, finish, fail;
      const done = new Promise((res, rej) => { finish = res; fail = rej; });
      done.catch(() => {});
      const coll = { match: (t, s, d) => {
        if (s !== rseq || (t !== T.RESP && t !== T.RDATA && t !== T.REND)) return false;
        if (t === T.RESP) { status = d[0] | (d[1] << 8); type = new TextDecoder().decode(d.subarray(2)); parts = []; size = 0; }
        else if (t === T.RDATA) { parts.push(d); size += d.length; }
        else finish();
        return true;
      } };
      U.waits.push(coll);
      const tout = opt.timeout || (upload ? 60000 : 20000);
      let tm = 0;                                        // parte dopo l'invio: a 115200 un firmware ci mette minuti
      const onAbort = () => fail(abortErr());
      if (signal) signal.addEventListener("abort", onAbort);
      try {
        const nak = await sendWaitAck(T.REQ, rseq, p, 1000, signal);
        if (nak) return { status: nak === NAK_TOO_BIG ? 413 : 400, type: "application/json",
                          data: new TextEncoder().encode(JSON.stringify({ ok: false, msg: nak === NAK_TOO_BIG ? "richiesta troppo grande per la USB" : "richiesta rifiutata dal PLC (USB)" })) };
        for (let off = 0; off < len; ) {
          const k = Math.min(MAX_DATA, len - off);
          const s = nextSeq();
          let nk;
          try { nk = await sendWaitAck(T.BODY, s, body.subarray(off, off + k), 3000, signal); }
          catch (e) { if (e.name === "AbortError") { send(T.ABORT, nextSeq(), null).catch(() => {}); } throw e; }
          if (nk) throw new Error("il PLC ha rifiutato i dati (" + nk + ")");
          off += k;
          if (opt.onProg) opt.onProg(off, len);
        }
        U.sent = true;
        if (opt.onSent) opt.onSent();
        tm = setTimeout(() => fail(new Error("il PLC non risponde")), tout);
        await done;
        U.lastRx = Date.now();
        const data = new Uint8Array(size);
        let o = 0; for (const x of parts) { data.set(x, o); o += x.length; }
        return { status, type, data };
      } finally {
        clearTimeout(tm);
        if (signal) signal.removeEventListener("abort", onAbort);
        const i = U.waits.indexOf(coll); if (i >= 0) U.waits.splice(i, 1);
      }
    } catch (e) {
      if (/non conferma/.test(e.message)) {
        if (gen === U.gen) lost("il PLC non conferma le richieste");
        // partita sul collegamento di prima (già ricollegato nel frattempo): quello nuovo non si tocca e una lettura si rifà
        else if (m === 0 && !opt.again) return await doRequest(m, url, body, upload, Object.assign({}, opt, { again: true }));
      }
      throw e;
    } finally { U.busy--; U.upload = false; U.sent = false; }
  }
  function toResponse(r) {
    const st = r.status >= 200 && r.status <= 599 ? r.status : 500;
    return new Response(st === 204 ? null : r.data, { status: st, headers: { "Content-Type": r.type || "application/octet-stream" } });
  }
  async function bodyBytes(b) {
    if (b == null) return { bytes: null, upload: false };
    if (typeof FormData !== "undefined" && b instanceof FormData) {   // Download: il file del modulo, in binario
      for (const [, v] of b) if (v instanceof Blob) return { bytes: new Uint8Array(await v.arrayBuffer()), upload: true };
      return { bytes: null, upload: true };
    }
    if (typeof b === "string") return { bytes: new TextEncoder().encode(b), upload: false };
    if (b instanceof Blob) return { bytes: new Uint8Array(await b.arrayBuffer()), upload: false };
    if (b instanceof ArrayBuffer) return { bytes: new Uint8Array(b), upload: false };
    if (ArrayBuffer.isView(b)) return { bytes: new Uint8Array(b.buffer, b.byteOffset, b.byteLength), upload: false };
    return { bytes: new TextEncoder().encode(String(b)), upload: false };
  }

  if (mode === "usb") {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (!url.startsWith("/api/")) return realFetch(input, init);
      init = init || {};
      const m = METHODS.indexOf(String(init.method || "GET").toUpperCase());
      if (m < 0) throw new TypeError("metodo non gestito sulla USB");
      const { bytes, upload } = await bodyBytes(init.body);
      return toResponse(await request(m, url, bytes, upload, { signal: init.signal }));
    };
  }

  // Download con avanzamento (come postProgress in app.js) → { ok, status, j }
  async function post(path, body, contentType, timeoutMs, onProg, onSent) {
    const { bytes, upload } = await bodyBytes(body);
    const r = await request(1, path, bytes, upload, { timeout: timeoutMs, onProg, onSent });
    let j = {}; try { j = JSON.parse(new TextDecoder().decode(r.data)); } catch (e) {}
    return { ok: r.status >= 200 && r.status < 300, status: r.status, j };
  }

  // ── Editor in un file solo (dalla pagina servita dal PLC) ──
  const getText = async u => { const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error(u + ": HTTP " + r.status); return r.text(); };
  // dal PLC via USB: i file dell'editor come sono sulla scheda (compressi), da /api/fw/gui
  const getGz = async u => {
    const r = await fetch("/api/fw/gui?name=" + encodeURIComponent(u.replace(/^.*\//, "") + ".gz"));
    if (!r.ok) throw new Error(u + ": " + (r.status === 404 ? "non c'è sul PLC" : "HTTP " + r.status));
    return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  };
  // una pagina con i suoi .css e .js dentro (niente dev/: simulatore e prove)
  async function inlinePage(name, get) {
    get = get || getText;
    let html = await get(name);
    const css = [], js = {};
    html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (_, h) => { css.push(h); return ""; });
    const srcs = [];
    html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g, (_, s) => { srcs.push(s); return ""; });
    const cssText = {};
    for (const h of css) cssText[h] = await get(h);
    for (const s of srcs) if (!/^dev\//.test(s)) js[s] = await get(s);
    const safe = t => t.replace(/<\/(script|style)/gi, "<\\/$1");
    html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*>/g, (_, h) => `<style>/* ${h} */\n${cssText[h].replace(/<\/style/gi, "<\\/style")}\n</style>`);
    html = html.replace(/[ \t]*<!--[^>]*-->\s*(?=<script\s+src="dev\/)/g, "");
    html = html.replace(/[ \t]*<script\s+src="([^"]+)"\s*><\/script>\n?/g, (_, s) => /^dev\//.test(s) ? "" :
      `<script>/* ${s} */\n${safe(js[s])}\n</script>\n`);
    return html;
  }
  // L'editor in un file solo, preso dal PLC: in rete dalla pagina, in USB dai file della scheda.
  // Dentro c'è l'impronta dell'editor del PLC: all'apertura si vede se il PLC ne ha uno diverso.
  async function buildSingleFile() {
    let info = null;
    try { const r = await fetch("/api/fw/info"); if (r.ok) info = await r.json(); } catch (e) {}
    if (info) lastInfo = info;
    const get = mode === "usb" ? getGz : getText;
    let html = await inlinePage("index.html", get);       // la Diagnostica è dentro (diag.js)
    const pre = `<head>\n  <script>window.ESPPLC_SINGLE = 1;\n  window.ESPPLC_GUI_ID = ${JSON.stringify(info && info.gui_id || "")};` +
      ` window.ESPPLC_FW_VER = ${JSON.stringify(info && info.version || "")};</script>`;
    html = html.replace(/<head>/, () => pre);
    lastBuildVer = info && info.version || "";
    return html;
  }
  let lastBuildVer = "";
  // Salvataggio: con la finestra «Salva con nome» del sistema (scrittura diretta del file, niente
  // avviso «file pericoloso» dei download .html; si può anche sovrascrivere l'editor vecchio).
  // Dove il browser non la offre (pagina servita dal PLC in rete: non è «sicura») → download.
  // → { name, n } oppure null se annullato
  let lastInfo = null;
  const fileName = v => "espplc-editor" + (v ? "-" + v.replace(/[^0-9A-Za-z._-]/g, "") : "") + ".html";
  // Il file dell'editor scelto con «Salva con nome» si ricorda (IndexedDB): le volte dopo si riscrive con un clic
  // e la pagina si ricarica da sola con l'editor nuovo, senza scegliere cartelle né riaprire file.
  const myFile = () => { try { return decodeURIComponent(location.pathname.split("/").pop() || ""); } catch (e) { return ""; } };
  function idb(fn) {
    return new Promise((res, rej) => {
      const q = indexedDB.open("espplc", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("h");
      q.onerror = () => rej(q.error);
      q.onsuccess = () => { const t = q.result.transaction("h", "readwrite"), st = t.objectStore("h"); const r = fn(st);
        t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); };
    });
  }
  const savedHandle = () => idb(st => st.get("editor")).catch(() => null);
  const rememberHandle = h => idb(st => st.put(h, "editor")).catch(() => {});
  async function writeTo(handle, html) {
    const w = await handle.createWritable();
    await w.write(new Blob([html], { type: "text/html" }));
    await w.close();
  }
  async function downloadSingleFile(onNote) {
    let handle = null;
    const known = window.showSaveFilePicker ? await savedHandle() : null;
    if (known && known.name === myFile()) {              // lo stesso file aperto ora: si riscrive (il browser chiede il permesso una volta)
      try { if ((await known.requestPermission({ mode: "readwrite" })) === "granted") handle = known; } catch (e) {}
    }
    if (!handle && window.showSaveFilePicker) {          // subito: serve il clic dell'utente
      // la pagina sa il percorso del suo file, ma il browser non lascia aprire la finestra in quella cartella:
      // il percorso completo va negli appunti, incollato nel nome del file la finestra salva proprio lì
      const full = location.protocol === "file:" ? decodeURIComponent(location.pathname).replace(/^\/([A-Za-z]:)/, "$1").replace(/\//g, "\\") : "";
      if (full) { try { await navigator.clipboard.writeText(full); if (onNote) onNote(`percorso copiato: nella finestra incollalo nel nome del file (Ctrl+V) → ${full}`); } catch (e) {} }
      try {
        handle = await window.showSaveFilePicker({ suggestedName: myFile() || fileName(lastInfo && lastInfo.version), startIn: known || "downloads",
          types: [{ description: "Editor MiaPLC", accept: { "text/html": [".html"] } }] });
      } catch (e) { if (e.name === "AbortError") return null; handle = null; }
    }
    const html = await buildSingleFile();
    if (handle) {
      await writeTo(handle, html);
      await rememberHandle(handle);
      const self = single && handle.name === myFile();
      if (self) { window.ESPPLC_RELOAD = true; setTimeout(() => location.reload(), 800); }
      return { name: handle.name, n: html.length, self };
    }
    // senza «Salva con nome» (pagina in rete, http): un .zip con dentro l'editor. Un .html scaricato
    // da una pagina http il browser lo segnala come pericoloso, lo zip no.
    const inner = fileName(lastBuildVer);
    const zip = await zipOne(inner, new TextEncoder().encode(html));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    a.download = inner.replace(/\.html$/, ".zip");
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { name: a.download, n: zip.length, inner };
  }

  // .zip con un file solo (compresso se il browser sa farlo, altrimenti memorizzato)
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function zipOne(name, data) {
    let method = 0, body = data;
    try {
      const s = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      body = new Uint8Array(await new Response(s).arrayBuffer()); method = 8;
    } catch (e) { body = data; method = 0; }
    const nm = new TextEncoder().encode(name), crc = crc32(data), d = new Date();
    const dtime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const ddate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const out = new Uint8Array(30 + nm.length + body.length + 46 + nm.length + 22);
    const v = new DataView(out.buffer);
    let o = 0;
    const hdr = central => {                                  // testata locale (30 B) o centrale (46 B)
      v.setUint32(o, central ? 0x02014b50 : 0x04034b50, true); o += 4;
      if (central) { v.setUint16(o, 20, true); o += 2; }       // creato con
      v.setUint16(o, 20, true); v.setUint16(o + 2, 0x0800, true); v.setUint16(o + 4, method, true);   // versione, UTF-8, metodo
      v.setUint16(o + 6, dtime, true); v.setUint16(o + 8, ddate, true); v.setUint32(o + 10, crc, true);
      v.setUint32(o + 14, body.length, true); v.setUint32(o + 18, data.length, true);
      v.setUint16(o + 22, nm.length, true); v.setUint16(o + 24, 0, true); o += 26;
      if (central) { o += 10; v.setUint32(o, 0, true); o += 4; }  // commento, disco, attributi = 0; posizione della locale = 0
      out.set(nm, o); o += nm.length;
    };
    hdr(false); out.set(body, o); o += body.length;
    const cd = o; hdr(true); const cdLen = o - cd;
    v.setUint32(o, 0x06054b50, true); v.setUint16(o + 8, 1, true); v.setUint16(o + 10, 1, true);
    v.setUint32(o + 12, cdLen, true); v.setUint32(o + 16, cd, true);
    return out;
  }

  window.EspUsb = {
    mode: () => mode, servedByPlc, hasSerial, hasSim, single, switchMode,
    state: () => U.state, info: () => U.info, message: () => U.msg, note: () => U.note || "",
    on: () => mode === "usb", connected: () => U.state === "on",
    connect: () => connect(null, false), choosePort, disconnect, request, post, release, resume,
    onChange(f) { U.listeners.push(f); }, onText(f) { U.onText = f; },
    checkGui: () => checkGui(),                         // editor del PLC diverso da questo file? (banner)
    setMaxBaud(b) { wantMax = b; }, setPatience, badFrames: () => U.bad,
    buildSingleFile, downloadSingleFile,
    port: () => U.port, _crc16: crc16, _frame: frame, _Parser: Parser,
  };

  // ── Interfaccia: pulsante «Collegamento», finestra, informativa ──
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const MODE_TXT = { sim: "SIMULATORE", usb: "USB", net: "RETE" };
  function badgeText() {
    if (mode !== "usb") return "🔌 " + MODE_TXT[mode];
    if (U.state === "on") return `🔌 USB · ${U.info ? U.info.baud : ""}`;
    if (U.state === "connecting") return "🔌 USB · collegamento…";
    if (U.why === "held") return "🔌 USB · scrittura del firmware";
    if (U.why === "noresp") return "🔌 USB · scheda collegata, il firmware non risponde";
    if (U.why === "cable") return "🔌 USB · cavo staccato";
    return "🔌 USB · scollegato";
  }
  function refreshUi() {
    const b = document.getElementById("btn-conn");
    if (b) {
      b.textContent = badgeText();
      b.className = "badge conn conn-" + mode + (mode === "usb" ? " st-" + U.state : "");
      b.title = "Collegamento con il PLC: " + MODE_TXT[mode] + (U.msg && mode === "usb" ? " — " + U.msg : "") + ". Clic per cambiare.";
    }
    const bb = document.getElementById("banner-usb");
    if (bb) bb.classList.toggle("hidden", !(mode === "usb" && U.state !== "on" && U.state !== "connecting"));
    const m = document.getElementById("conn-modal");
    if (m && !m.classList.contains("hidden")) fillModal();
  }
  U.listeners.push(refreshUi);

  const CONN_DESC = { sim: "PLC simulato nel browser, senza scheda", usb: "cavo USB tra PC e scheda", net: "pagina aperta dall'indirizzo del PLC" };
  function fillModal() {
    const $ = id => document.getElementById(id);
    const dis = { sim: !hasSim && (servedByPlc || single) ? (servedByPlc ? "solo con l'editor aperto dal PC" : "il simulatore non è in questo file") : "",
                  usb: servedByPlc ? "solo con l'editor aperto dal PC (scaricalo qui sotto)" : !hasSerial ? "questo browser non ha la seriale (Web Serial)" : "",
                  net: !servedByPlc && !lsGet("espplc.mock2.device") && !isHttp ? "apri l'indirizzo del PLC nel browser" : "" };
    // segnalazione del collegamento in uso; gli altri si scelgono con un clic solo se si può
    for (const k of ["sim", "usb", "net"]) {
      const r = $("conn-" + k), on = mode === k;
      r.classList.toggle("on", on);
      r.disabled = !on && !!dis[k];
      r.title = CONN_DESC[k] + (on ? " — in uso" : dis[k] ? " — " + dis[k] : " — clic per passare a questo");
    }
    const usb = mode === "usb";
    $("conn-usb-box").classList.toggle("hidden", !usb);
    if (usb) {
      const i = U.info;
      $("conn-usb-st").innerHTML = U.state === "on"
        ? `<b class="ok">collegato</b> · ${i.baud} baud · firmware ${esc(i.version || "?")} · acceso da ${Math.round(i.uptime / 1000)} s` +
          (U.note ? `<br><span class="warn">⚠ ${esc(U.note)}</span>` : "")
        : `<b>${U.state === "connecting" ? "collegamento…" : "non collegato"}</b>` + (U.msg ? ` · <span class="muted">${esc(U.msg)}</span>` : "");
      $("conn-go").textContent = U.state === "on" ? "Scollega" : "Collega…";
      $("conn-go").disabled = U.state === "connecting";
      $("conn-speed").value = String(wantMax);
    }
    $("conn-single").classList.toggle("hidden", !(servedByPlc || (mode === "usb" && U.state === "on")));
  }
  function buildUi() {
    const badges = document.querySelector("header .badges");
    if (!badges || document.getElementById("btn-conn")) return;
    const b = document.createElement("button");
    b.id = "btn-conn"; b.type = "button";
    const diag = document.getElementById("btn-diag");
    badges.insertBefore(b, diag || badges.firstChild);
    b.onclick = openModal;

    const ban = document.createElement("div");
    ban.id = "banner-usb"; ban.className = "banner banner-usb hidden";
    ban.innerHTML = `PLC non collegato via USB <button type="button" id="banner-usb-go">Collega USB</button> <button type="button" id="banner-usb-info" title="Cosa serve e problemi frequenti">?</button>`;
    const off = document.getElementById("offline-banner");          // prima: con questo visibile l'altro si nasconde (CSS)
    if (off) off.parentNode.insertBefore(ban, off); else document.body.insertBefore(ban, document.body.firstChild);
    ban.querySelector("#banner-usb-go").onclick = () => doConnect();
    ban.querySelector("#banner-usb-info").onclick = openInfo;
    const bg = document.createElement("div");
    bg.id = "banner-gui"; bg.className = "banner banner-gui hidden";
    bg.innerHTML = `<span class="t"></span> <button type="button" class="go">⟳ Aggiorna l'editor dal PLC</button> <button type="button" class="x" title="Non ora">✕</button> <span class="st"></span>`;
    ban.parentNode.insertBefore(bg, ban);
    bg.querySelector(".go").onclick = async () => {
      bg.querySelector(".st").textContent = "preparazione…";
      try { const r = await downloadSingleFile(t => { bg.querySelector(".st").textContent = t; });
            bg.querySelector(".st").textContent = !r ? "annullato" : r.inner ? `scaricato ${r.name}: dentro c'è ${r.inner}, aprilo al posto di questo`
              : r.self ? "editor aggiornato: ricarico la pagina…" : `salvato ${r.name} (${Math.round(r.n / 1024)} KB): chiudi questo file e apri quello nuovo`; }
      catch (e) { bg.querySelector(".st").textContent = "non riuscito: " + e.message; }
    };
    bg.querySelector(".x").onclick = () => { bg.dataset.dismissed = bg.dataset.gid || ""; bg.classList.add("hidden"); };

    const m = document.createElement("div");
    m.id = "conn-modal"; m.className = "modal hidden";
    m.innerHTML = `<div class="modal-box conn-box">
      <h3>Collegamento con il PLC</h3>
      <div class="conn-modes">
        <button type="button" class="conn-mode" id="conn-sim">Simulatore</button>
        <button type="button" class="conn-mode" id="conn-usb">USB</button>
        <button type="button" class="conn-mode" id="conn-net">Rete</button>
      </div>
      <div id="conn-usb-box" class="conn-usb hidden">
        <div id="conn-usb-st"></div>
        <div class="row"><button id="conn-go" class="primary">Collega…</button>
          <label class="muted">velocità massima <select id="conn-speed">${BAUDS.map(x => `<option value="${x}">${x}</option>`).join("")}</select></label>
          <button id="conn-info" title="Driver, browser, riavvio della scheda, problemi frequenti">? Informazioni</button></div>
      </div>
      <div id="conn-single" class="conn-single hidden">
        <button id="conn-dl">⭳ Scarica l'editor per il PC</button>
        <span class="muted">per lavorare offline e collegarsi con la USB</span>
        <div id="conn-dl-st" class="muted"></div>
      </div>
      <div class="row right"><button id="conn-close">Chiudi</button></div>
    </div>`;
    document.body.appendChild(m);
    const $ = id => document.getElementById(id);
    for (const k of ["sim", "usb", "net"]) $("conn-" + k).onclick = () => {
      if (k !== mode) switchMode(k);
    };
    $("conn-go").onclick = () => U.state === "on" ? disconnect() : doConnect();
    $("conn-speed").onchange = e => { wantMax = +e.target.value; lsSet("espplc.usb.max", String(wantMax)); };
    $("conn-info").onclick = openInfo;
    $("conn-close").onclick = () => m.classList.add("hidden");
    $("conn-dl").onclick = async () => {
      $("conn-dl-st").textContent = "preparazione…";
      try { const r = await downloadSingleFile();
            $("conn-dl-st").textContent = !r ? "annullato" : r.inner ? `scaricato ${r.name} (${Math.round(r.n / 1024)} KB): estrai ${r.inner} e aprilo dal PC. Se il browser lo blocca (pagina http): nei download scegli «Conserva», oppure usa dist/${r.inner} che prepara la compilazione` : `salvato ${r.name} (${Math.round(r.n / 1024)} KB) — aprilo al posto di questo`; }
      catch (e) { $("conn-dl-st").textContent = "non riuscito: " + e.message; }
    };

    const inf = document.createElement("div");
    inf.id = "usb-info"; inf.className = "modal hidden";
    inf.innerHTML = `<div class="modal-box info-box">
      <h3>USB: cosa serve e problemi frequenti</h3>
      <div class="info-body">
      <p><b>Browser</b>: serve un browser per computer con la seriale web (Web Serial). Se il pulsante USB è grigio il browser non la ha: usane un altro.</p>
      <p><b>Editor aperto dal PC</b>: la USB funziona con l'editor aperto da file sul PC (scaricalo dal PLC: Collegamento → «Scarica l'editor per il PC») o da un server locale. Dalla pagina servita dal PLC in rete il browser non permette la seriale.</p>
      <p><b>Driver</b>: la scheda ha un chip USB-seriale. Con il chip <b>CH340</b> serve il driver CH341SER, con il <b>CP2102</b> il driver CP210x (VCP). Se nella finestra di scelta non compare nessuna porta: installa il driver, scollega e ricollega il cavo. Usa un cavo dati (alcuni cavi caricano soltanto).</p>
      <p><b>Porta occupata</b>: una porta seriale la può usare un programma alla volta. Chiudi monitor seriali, programmi di caricamento firmware e altre schede dell'editor collegate in USB.</p>
      <p><b>Riavvio della scheda</b>: su molte schede aprire la porta può riavviare il micro (il circuito di reset automatico usato per caricare il firmware). Con il PLC in RUN fermerebbe la macchina. Rimedio: nel progetto MiaConfig della scheda, modulo «Protezione reset USB», scegli un'uscita che comanda il circuito che isola il reset: mentre il PLC è in RUN il reset dalla USB è escluso, in STOP torna possibile (serve per caricare il firmware). Se dopo il collegamento compare «il PLC si è appena acceso», il riavvio c'è stato.</p>
      <p><b>Log di testo</b>: mentre l'editor è collegato il PLC spegne i messaggi di testo sulla seriale (si mescolerebbero ai pacchetti). Tornano 5 s dopo lo scollegamento. In Diagnostica si può scegliere «solo editor» per tenerli sempre spenti.</p>
      <p><b>Velocità</b>: si parte sempre a 115200 e si sale fino a 921600. Se il collegamento cade spesso abbassa la velocità massima.</p>
      <p><b>Diagnostica</b>: in USB si apre in una finestra grande dentro l'editor (la porta seriale la usa un programma alla volta); «✕ Chiudi» torna all'editor.</p>
      </div>
      <div class="row right"><button id="usb-info-close" class="primary">Chiudi</button></div>
    </div>`;
    document.body.appendChild(inf);
    $("usb-info-close").onclick = () => inf.classList.add("hidden");
    refreshUi();
  }
  // Editor in un file solo collegato in USB: se il PLC ha un editor diverso (firmware aggiornato) lo dice
  async function checkGui() {
    if (!single || mode !== "usb" || U.state !== "on") return;
    let info = null;
    try { const r = await fetch("/api/fw/info"); if (r.ok) info = await r.json(); } catch (e) { return; }
    lastInfo = info;
    const ban = document.getElementById("banner-gui");
    if (!ban || !info || !info.gui_id) return;
    const mine = window.ESPPLC_GUI_ID || "";
    const differs = info.gui_id !== mine && ban.dataset.dismissed !== info.gui_id;
    ban.querySelector(".t").textContent = mine
      ? `Sul PLC c'è un editor diverso da questo file (firmware ${info.version}).`
      : `Sul PLC c'è l'editor del firmware ${info.version}: questo file non sa di quale versione è.`;
    ban.classList.toggle("hidden", !differs);
    ban.dataset.gid = info.gui_id;
  }
  U.listeners.push(st => { if (st === "on") setTimeout(checkGui, 300); });
  function openModal() { if (!lastInfo) fetch("/api/fw/info").then(r => r.ok ? r.json() : null).then(j => { if (j) lastInfo = j; }).catch(() => {}); fillModal(); document.getElementById("conn-modal").classList.remove("hidden"); }
  function openInfo() { document.getElementById("usb-info").classList.remove("hidden"); }
  async function doConnect() {
    try {
      // porta già autorizzata: si apre senza chiedere; altrimenti la finestra di scelta del browser
      const ps = hasSerial && !U.chooseNext ? await navigator.serial.getPorts() : [];
      if (ps.length && (U.port || ps.length === 1)) { await connect(U.port || ps[0], false); if (U.state === "on") return; }
      await choosePort();
    } catch (e) { if (e.name !== "NotFoundError") setState(U.state === "on" ? "on" : "off", e.message); }
  }

  { const mx = +lsGet("espplc.usb.max"); if (BAUDS.includes(mx)) wantMax = mx; }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildUi); else buildUi();
  // USB: porta già autorizzata in passato → collegamento automatico all'apertura
  if (mode === "usb" && hasSerial && !window.ESPPLC_USB_NOAUTO) { U.tried = true; connect(null, true).then(ok => { if (!ok && U.state === "lost") setState("off", undefined, U.why); }); }
})();
