// MiaPLC — calcolatori della pagina Prestazioni (IT/EN).
// Tutti i numeri di partenza sono in DATI qui sotto: misurati sulla scheda dove indicato, il resto è stima.
(function () {
  "use strict";
  const EN = document.documentElement.lang === "en";

  // ── Dati di partenza ────────────────────────────────────────────────
  const DATI = {
    esp32: {
      bit: 0.79,          // µs, network «contatto → bobina» (misurato, VM interprete, 240 MHz)
      box: 1.4,           // µs, box numerico (ADD DINT misurato 1,36–1,46 µs)
      call: 0.3,          // µs, chiamata FC (stima dal documento interprete)
      par: 0.25,          // µs per parametro della FC (stima)
      fisso: 130,         // µs, parte fissa del ciclo (misurata: «scansione vuota»)
      lavoroWifi: 11702,  // byte, memoria di lavoro con WiFi + Ethernet (misurata)
      lavoroEth: 40000,   // byte, memoria di lavoro senza WiFi: il massimo sull'ESP32 (PLC_WORK_MAX, MiaPlc-idf 0.3.24)
      db: 8192,           // byte, area DB
      busMod: 0.16,       // ms di bus per modulo µLink (8 moduli ≈ 1,3 ms)
      modOggi: 8,         // moduli µLink nel firmware normale
      modMax: 15,         // moduli con ingressi/uscite nel programma (aree I/Q da 1024 bit)
      ioBit: 1024, real: Infinity, nativo: 1,
      speed: 1,
    },
    p4: {
      bit: 0.79, box: 1.4, call: 0.3, par: 0.25, fisso: 130,
      speed: 1.5,         // P4 almeno 1,5× l'ESP32 con la stessa VM (stima prudente: 1,5–2,2×)
      nativo: 5.4,        // codice macchina contro VM sul P4: 209,7 → 38,9 ms (misurato su programma grande)
      lavoroWifi: 7989150, lavoroEth: 7989150,   // byte, memoria di lavoro misurata (≈ 7,6 MB)
      db: 2097152,        // byte, area DB del P4 (2 MB)
      busMod: 0.083,      // ms per modulo: 192 moduli inviati in 16 ms (misura di prova)
      modOggi: 8,         // firmware normale
      modMax: 1000,       // configurazione estesa del P4 (in sviluppo): 1000 schede I/O
      ioBit: 131072,      // aree I/O da 128 kbit (in sviluppo)
      real: 131072,       // area REAL da 128k valori (in sviluppo)
    },
  };

  // Memoria: i byte di ogni esempio sono il DOPPIO del conto fatto sul programma (Denys 11-11-2026): margine prudente,
  // e il P4 mostra lo stesso quanto spazio ha. I tempi restano quelli del conto.
  // Stanza d'hotel: 10 pulsanti, 10 luci, clima (sonda, valvola, ventilatore)
  const STANZA = { di: 10, do: 12, rung: 23, box: 3, par: 26, codice: 214, dati: 48 };
  const STANZE_PER_MODULO = Math.floor(63 / STANZA.do);  // modulo µLink: 63 ingressi + 63 uscite utili
  const FC_STANZA = 1200;                                  // byte, la FC «Stanza» scritta una volta

  // Ettaro: 2 settori (valvola, timer, soglia umidità) + 1 sonda
  const ETTARO = { rung: 10, box: 8, par: 24, codice: 204, dati: 112, valvole: 2 };
  const IMPIANTO = { codice: 8192, dati: 2048, tempo: 400 };  // stazione: pompe, dosatori, fanghi, agitatori

  // Nastro trasportatore di un impianto bagagli: 4 fotocellule, motore marcia/velocità,
  // inseguimento delle valigie (coda di posizioni), intasamenti, deviatori
  const NASTRO = { rung: 20, box: 10, par: 15, codice: 126, dati: 128, di: 4, do: 2 };
  const NASTRI_PER_MODULO = Math.floor(63 / NASTRO.di);   // 15
  const FC_NASTRO = 2400;
  const OBIETTIVO_MS = 20;
  const MAX = 200;                                         // fondo dei cursori (Denys 11-11-2026: niente numeri esagerati)                                 // a 2 m/s in 20 ms la valigia fa 4 cm

  const fmtN = (n, d = 0) => n.toLocaleString(EN ? "en-GB" : "it-IT", { maximumFractionDigits: d, minimumFractionDigits: d });
  const ms = us => us >= 1000 ? fmtN(us / 1000, us >= 100000 ? 0 : 1) + " ms" : fmtN(us) + " µs";
  const tondo = n => n >= 10000 ? Math.round(n / 100) * 100 : n;        // niente falsa precisione sui numeri grandi
  const kb = b => b >= 1048576 ? fmtN(b / 1048576, 1) + " MB" : fmtN(b / 1024, 1) + " KB";

  function tempoUs(D, n) { return (n.rung * D.bit + n.box * D.box + D.call + n.par * D.par) / D.speed; }
  function periodoBus(D, moduli) {                      // ms: il bus occupato al massimo al 60 %
    return Math.max(5, Math.ceil(moduli * D.busMod / 0.6));
  }

  // ── Hotel ────────────────────────────────────────────────────────────
  function hotel(D, stanze, wifi) {
    const ciclo = D.fisso + stanze * tempoUs(D, STANZA) / 1;
    const codice = FC_STANZA + stanze * STANZA.codice;
    const dati = stanze * STANZA.dati;
    const lavoro = wifi ? D.lavoroWifi : D.lavoroEth;
    const moduli = Math.ceil(stanze / STANZE_PER_MODULO);
    const periodo = periodoBus(D, moduli);
    const maxMem = Math.min(Math.floor((lavoro - FC_STANZA) / STANZA.codice), Math.floor(D.db / STANZA.dati));
    return { ciclo, codice, dati, lavoro, moduli, periodo, maxMem, sonde: stanze, sondeOk: stanze <= D.real,
      maxOggi: D.modOggi * STANZE_PER_MODULO, maxBus: Math.min(D.modMax * STANZE_PER_MODULO, D.real),
      reazione: 2 * periodo + ciclo / 1000 };
  }

  // ── Nastri ───────────────────────────────────────────────────────────
  function nastri(D, n, nativo) {
    const f = nativo ? D.nativo : 1;
    const ciclo = D.fisso + n * tempoUs(D, NASTRO) / f;
    const codice = FC_NASTRO + n * NASTRO.codice, dati = n * NASTRO.dati;
    const moduli = Math.ceil(n / NASTRI_PER_MODULO), periodo = periodoBus(D, moduli);
    const agg = Math.max(periodo, ciclo / 1000);
    return { ciclo, codice, dati, moduli, periodo, agg, cm: agg * 2 / 10 };
  }
  function maxNastri(D, nativo) {
    let n = 5;
    while (n < 20000) {
      const r = nastri(D, n + 5, nativo);
      if (r.agg > OBIETTIVO_MS || r.codice > D.lavoroEth || r.dati > D.db || r.moduli > D.modMax) break;
      n += 5;
    }
    return n;
  }

  // ── Irrigazione ──────────────────────────────────────────────────────
  function campo(D, ettari, wifi) {
    const ciclo = D.fisso + IMPIANTO.tempo / D.speed + ettari * tempoUs(D, ETTARO);
    const codice = IMPIANTO.codice + ettari * ETTARO.codice;
    const dati = IMPIANTO.dati + ettari * ETTARO.dati;
    const lavoro = wifi ? D.lavoroWifi : D.lavoroEth;
    const maxCodice = Math.floor((lavoro - IMPIANTO.codice) / ETTARO.codice);
    const maxDati = Math.floor((D.db - IMPIANTO.dati) / ETTARO.dati);
    return { ciclo, codice, dati, lavoro, maxCodice, maxDati, max: Math.min(maxCodice, maxDati),
      sonde: ettari, maxSonde: D.real,
      valvole: ettari * ETTARO.valvole, maxValvole: D.modMax * 63 };
  }

  const T = EN ? {
    cycle: "program cycle", mem: "PLC work memory", data: "PLC DB data", mods: "µLink modules", refresh: "all rooms refreshed every",
    react: "button → light, at worst", ok: "fits", over: "too much", rooms: "rooms", ha: "hectares",
    limitMods: m => `I/O limit: ${m} modules`, valves: "valves", maxRam: "RAM runs out at about",
    testing: "beyond 15 modules: P4 extended configuration (in development)", dbFull: "DB area full",
    probes: "analog probes (REAL)", probesFull: "analog values (REAL) full", slow: "slow for lights: split over more buses or PLCs",
    probeLimit: n => `but the probes stop at ${n} hectares (REAL area)`,
    roomy: n => `memory to spare: well over ${n} hectares`,
    upd: "all conveyors refreshed every", bag: "a bag at 2 m/s moves", tracking: "tracking within 4 cm", tooSlow: "over 20 ms: split into zones",
    conv: "conveyors", vm: "VM", native: "machine code",
    wifiOn: "WiFi on", wifiOff: "Ethernet only",
  } : {
    cycle: "ciclo del programma", mem: "memoria di lavoro del PLC", data: "dati nei DB del PLC", mods: "moduli µLink", refresh: "tutte le stanze aggiornate ogni",
    react: "pulsante → luce, al peggio", ok: "ci sta", over: "troppo", rooms: "stanze", ha: "ettari",
    limitMods: m => `limite I/O: ${m} moduli`, valves: "valvole", maxRam: "la RAM finisce a circa",
    testing: "oltre 15 moduli: configurazione estesa del P4 (in sviluppo)", dbFull: "area DB piena",
    probes: "sonde analogiche (REAL)", probesFull: "valori analogici (REAL) finiti", slow: "lento per le luci: meglio dividere su più bus o PLC",
    probeLimit: n => `ma le sonde finiscono a ${n} ettari (area REAL)`,
    roomy: n => `memoria in abbondanza: ben oltre ${n} ettari`,
    upd: "tutti i nastri aggiornati ogni", bag: "una valigia a 2 m/s si sposta di", tracking: "inseguimento entro 4 cm", tooSlow: "oltre 20 ms: meglio dividere in zone",
    conv: "nastri", vm: "VM", native: "codice macchina",
    wifiOn: "WiFi acceso", wifiOff: "solo Ethernet",
  };

  // «usato / totale» con la percentuale accanto
  function quota(a, b, f) {
    const p = b > 0 ? a / b * 100 : 0;
    const t = p >= 100 ? fmtN(p, 0) : p >= 10 ? fmtN(p, 0) : p >= 1 ? fmtN(p, 1) : p > 0 ? "<1" : "0";
    return `${f(a)} / ${f(b)} <i class="pct${p > 100 ? " over" : p > 80 ? " warn" : ""}">${t} %</i>`;
  }
  function riga(label, val, ok) {
    return `<div class="kv${ok === false ? " bad" : ""}"><span>${label}</span><b>${val}</b></div>`;
  }
  function barra(usato, totale) {
    const p = Math.min(100, usato / totale * 100);
    return `<div class="meter"><i style="width:${p.toFixed(1)}%" class="${p > 90 ? "hot" : ""}"></i></div>`;
  }

  function disegnaHotel() {
    const el = document.getElementById("calc-hotel"); if (!el) return;
    const n = +el.querySelector("input[type=range]").value;
    const wifi = el.querySelector("input[type=checkbox]").checked;
    el.querySelector(".n").textContent = fmtN(n);
    ["esp32", "p4"].forEach(k => {
      const D = DATI[k], r = hotel(D, n, wifi), box = el.querySelector(`[data-b="${k}"]`);
      const memOk = r.codice <= r.lavoro && r.dati <= D.db && r.sondeOk, modOk = r.moduli <= D.modMax;
      box.innerHTML =
        riga(T.cycle, ms(r.ciclo)) +
        riga(T.mem, quota(r.codice, r.lavoro, kb), r.codice <= r.lavoro) + barra(r.codice, r.lavoro) +
        riga(T.data, quota(r.dati, D.db, kb), r.dati <= D.db) +
        riga(T.mods, quota(r.moduli, D.modMax, fmtN), modOk) +
        riga(T.refresh, `${fmtN(Math.max(r.periodo, r.ciclo / 1000), 0)} ms`) +
        riga(T.react, `~${fmtN(r.reazione, 0)} ms`) +
        `<p class="verdict ${memOk && modOk ? "ok" : "no"}">${memOk && modOk ? "✓ " + T.ok : "✕ " + (!modOk ? T.limitMods(D.modMax) : r.codice > r.lavoro ? T.mem : !r.sondeOk ? T.probesFull : T.dbFull)}</p>` +
        (memOk && modOk && r.reazione > 100 ? `<p class="small" style="margin:6px 0 0;color:#fde68a">⚠ ${T.slow}</p>` : "") +
        (memOk && modOk && r.moduli > 15 ? `<p class="small mut" style="margin:6px 0 0">${T.testing}</p>` : "");
    });
  }

  function disegnaCampo() {
    const el = document.getElementById("calc-campo"); if (!el) return;
    const n = +el.querySelector("input[type=range]").value;
    const wifi = el.querySelector("input[type=checkbox]").checked;
    el.querySelector(".n").textContent = fmtN(n);
    ["esp32", "p4"].forEach(k => {
      const D = DATI[k], r = campo(D, n, wifi), box = el.querySelector(`[data-b="${k}"]`);
      const memOk = r.codice <= r.lavoro && r.dati <= D.db;
      box.innerHTML =
        riga(T.cycle, ms(r.ciclo)) +
        riga(T.mem, quota(r.codice, r.lavoro, kb), r.codice <= r.lavoro) + barra(r.codice, r.lavoro) +
        riga(T.data, quota(r.dati, D.db, kb), r.dati <= D.db) + barra(r.dati, D.db) +
        riga(T.valves, fmtN(r.valvole)) +
        (isFinite(r.maxSonde) ? riga(T.probes, quota(r.sonde, r.maxSonde, fmtN), r.sonde <= r.maxSonde) : "") +
        `<p class="verdict ${memOk && r.sonde <= r.maxSonde ? "ok" : "no"}">${r.max > MAX ? "✓ " + T.roomy(fmtN(MAX)) : `${T.maxRam} <b>${fmtN(tondo(r.max))} ${T.ha}</b>`}</p>` +
        (r.maxSonde < r.max ? `<p class="small" style="margin:6px 0 0;color:#fde68a">⚠ ${T.probeLimit(fmtN(r.maxSonde))}</p>` : "");
    });
  }

  function disegnaNastri() {
    const el = document.getElementById("calc-nastri"); if (!el) return;
    const n = +el.querySelector("input[type=range]").value;
    const nat = el.querySelector("input[type=checkbox]").checked;
    el.querySelector(".n").textContent = fmtN(n);
    ["esp32", "p4"].forEach(k => {
      const D = DATI[k], r = nastri(D, n, nat && k === "p4"), box = el.querySelector(`[data-b="${k}"]`);
      const memOk = r.codice <= D.lavoroEth && r.dati <= D.db, modOk = r.moduli <= D.modMax, tOk = r.agg <= OBIETTIVO_MS;
      box.innerHTML =
        riga(T.cycle, ms(r.ciclo)) +
        riga(T.mem, quota(r.codice, D.lavoroEth, kb), r.codice <= D.lavoroEth) + barra(r.codice, D.lavoroEth) +
        riga(T.data, quota(r.dati, D.db, kb), r.dati <= D.db) +
        riga(T.mods, quota(r.moduli, D.modMax, fmtN), modOk) +
        riga(T.upd, `${fmtN(r.agg, 0)} ms`, tOk) +
        riga(T.bag, `${fmtN(r.cm, 1)} cm`) +
        `<p class="verdict ${memOk && modOk && tOk ? "ok" : "no"}">${!modOk ? "✕ " + T.limitMods(D.modMax) : !memOk ? "✕ " + (r.dati > D.db ? T.dbFull : T.mem) : tOk ? "✓ " + T.tracking : "✕ " + T.tooSlow}</p>`;
    });
  }

  function lega(id, fn) {
    const el = document.getElementById(id); if (!el) return;
    el.querySelectorAll("input").forEach(i => i.addEventListener("input", fn));
    fn();
  }
  lega("calc-hotel", disegnaHotel);
  lega("calc-campo", disegnaCampo);
  lega("calc-nastri", disegnaNastri);

  // Tabella riassuntiva: 200 stanze, 200 ettari, 200 nastri per scheda; se non ci stanno, fin dove si arriva e perché
  const T2 = EN ? { fits: "fits", upd: "refreshed every", mem: "memory used", stops: n => `stops at ${n}`, why: { mem: "work memory", db: "DB area", mods: "I/O modules", slow: "too slow" }, wifi: "WiFi on" }
               : { fits: "ci sta", upd: "aggiornati ogni", mem: "memoria usata", stops: n => `si ferma a ${n}`, why: { mem: "memoria di lavoro", db: "area dei DB", mods: "moduli I/O", slow: "troppo lento" }, wifi: "WiFi acceso" };
  function cella(prova) {
    let ok = 0, perche = "";
    for (let n = 5; n <= MAX; n += 5) { const p = prova(n); if (p.no) { perche = p.no; break; } ok = n; }
    const r = prova(ok || 5);
    if (ok === MAX) return `✓ ${MAX} ${r.cosa}: ${T2.fits}<br><small>${T2.upd} ${fmtN(r.agg, 0)} ms · ${T2.mem} ${r.mem < 1 ? "&lt;1" : fmtN(r.mem, 0)} %</small>`;
    return `✕ ${T2.stops(ok)} ${r.cosa}<br><small>${T2.why[perche] || perche}</small>`;
  }
  const tab = document.getElementById("tab-limiti");
  if (tab) {
    const rows = ["esp32", "p4"].map(k => {
      const D = DATI[k];
      const h = cella(n => { const r = hotel(D, n, false), agg = Math.max(r.periodo, r.ciclo / 1000);
        return { cosa: T.rooms, agg, mem: 100 * r.codice / r.lavoro,
                 no: r.codice > r.lavoro ? "mem" : r.dati > D.db ? "db" : r.moduli > D.modMax ? "mods" : r.reazione > 100 ? "slow" : "" }; });
      const c = cella(n => { const r = campo(D, n, true);
        return { cosa: T.ha, agg: Math.max(5, r.ciclo / 1000), mem: 100 * r.codice / r.lavoro,
                 no: r.codice > r.lavoro ? "mem" : r.dati > D.db ? "db" : "" }; });
      const z = cella(n => { const r = nastri(D, n, k === "p4");
        return { cosa: T.conv, agg: r.agg, mem: 100 * r.codice / D.lavoroEth,
                 no: r.codice > D.lavoroEth ? "mem" : r.dati > D.db ? "db" : r.moduli > D.modMax ? "mods" : r.agg > OBIETTIVO_MS ? "slow" : "" }; });
      return `<tr><td><b>${k === "p4" ? "ESP32-P4" : "ESP32"}</b></td><td>${h}</td><td>${c}<br><small>(${T2.wifi})</small></td><td>${z}</td></tr>`;
    });
    tab.querySelector("tbody").innerHTML = rows.join("");
  }
})();
