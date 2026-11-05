// ============================================================
//  EspPlc — dev/mock-config.js
//  Configurazione del PLC simulato usato per testare l'editor su PC.
//  Modifica questi valori e ricarica la pagina. Non va su SPIFFS.
// ============================================================
window.ESPPLC_MOCK_CONFIG = {
  // Ingressi fisici simulati: I0 .. I(inputs-1)
  inputs: 6,

  // Uscite fisiche simulate: Q0 .. Q(outputs-1)
  outputs: 4,

  // Ingressi a pulsante (attivi solo mentre tieni premuto il mouse).
  // Gli altri sono interruttori (un clic accende, un clic spegne).
  // Esempio: [0, 1] → I0 e I1 pulsanti, I2..I5 interruttori.
  pushButtons: [],

  // Taglia memoria PLC (come TOTAL_MEMORY_PLC nel firmware): 16, 32, 64, 128.
  // Valore iniziale: si cambia anche dal pannello del mock (menu "Taglia").
  // 64 = come env:esp32-evb-plc16k in platformio.ini.
  tierKB: 64,

  // Memoria di caricamento (flash: codice + sorgente) in KB, come il firmware uPLC (PLC_LOAD_MEM = 256 KB
  // con la partizione da 640 KB). 0 = quella della taglia.
  loadKB: 256,

  // Periodo di scan simulato (firmware: PLC_SCAN_INTERVAL_MS = 10). Il simulatore fa davvero una scansione
  // per periodo (anche a 1 ms = 1000 al secondo). Il tempo di esecuzione mostrato (µs) è una STIMA
  // (90 µs + 1,7 µs per istruzione): quello vero si misura sul PLC.
  scanMs: 1,

  // Ritardo di risposta HTTP simulato, in ms [min, max]
  latencyMs: [15, 45],
};
