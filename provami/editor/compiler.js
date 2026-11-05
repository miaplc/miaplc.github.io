// ============================================================
//  EspPlc — compiler.js
//  IR v2 (ir.js) → bytecode per la VM EspPlc.
//
//  Istruzioni usate:
//    LD/LDN   ns idx   push valore / negato
//    AND/ANDN ns idx   top = top AND valore
//    OR/ORN   ns idx   top = top OR valore
//    LDC 1             push TRUE (rung senza contatti)
//    ANB               b=pop, top = top AND b     (blocco parallelo in serie)
//    ORB               b=pop, top = top OR  b     (ramo con più contatti)
//    DUP               push copia del top         (diramazione verso più uscite)
//    POP               scarta il top              (fine uscita / fine rung)
//    ST/S/R   ns idx   bobina / set / reset (non tolgono il top)
//    OVER              push copia del penultimo valore (corrente di sinistra
//                      dentro un ramo parallelo che contiene timer)
//    LDC 0             push FALSE (accumulatore OR dei rami "con corrente")
//    TON/TOF/TP idx PT  top = Q del timer idx con IN = top  (6 byte, PT in ms LE)
//    NOT               top = !top                 (v4.6: contatto NOT)
//    STN      ns idx   bobina negata              RETC: bobina RET (pop; se 1 esce dalla FC)
//    *16      ns idx16 I/Q/M oltre 255, bit di una parola (ns = area, idx = parola·32 + bit),
//                      bit di sistema SM0..SM5 (ns 0x08)
//
//  Timer: IN = corrente che arriva al box. Per questo un parallelo che
//  contiene timer viene calcolato "con corrente":
//    [pw] LDC 0 { OVER <ramo in AND> ORB }… ANB   → pw ∧ (pw∧r1 ∨ pw∧r2 …)
//  così ogni timer nel ramo vede la corrente di sinistra.
//  I paralleli di soli contatti restano nella forma compatta (LD…OR/ORB, ANB).
//
//  Funzioni:
//    CALL n16          se top = 1 chiama la FC numero n (formato v3: per numero,
//                      non per indirizzo), il top resta (ENO = EN). 3 byte.
//    RET               fine funzione: torna dopo la CALL. 1 byte.
//    FRAME n16         v4.8: prepara a zero n byte di dati locali per la prossima CALL (FC con interfaccia).
//                      Parametri: IN/IN_OUT copiati nel pezzo nuovo (area LN) prima della CALL, OUT/IN_OUT
//                      copiati fuori dopo (solo con EN = 1). Dentro la FC il pezzo è l'area L.
//  v4.8: operandi DB (0x16, offset nell'area dei DB), L (0x17, dati locali della FC in corso), LN (0x18, della FC
//  chiamata): byte, il tipo lo dà l'istruzione; bit con le istruzioni a 16 bit, idx = (byte << 3) | bit.
//
//  Formato v3 (a blocchi): sezione bytecode = u16 n, u16 0, n voci da 12 byte
//  {u8 tipo (0 Main, 1 FC), u8 flag, u16 numero, u32 size, u32 crc32} e poi il
//  codice dei blocchi di seguito: [Main … END][FC a … RET][FC b … RET]…, FC in
//  ordine di numero. Sezione sorgente: stessa tabella, una voce 0xFF con la testata
//  del progetto (JSON gzip senza i blocchi) e una voce gzip per ogni blocco.
//  Ogni blocco ha il suo CRC: il Download manda solo quelli cambiati (patch 'PLCP').
//  v4.8: in fondo i DB (tipo 3, per numero, nessun testo: la definizione è nella testata del progetto):
//  u8 1, u8 flag (bit 0 ritentivo), u16 base, u16 size, u16 nf, nf × { u32 crc32(nome), u8 tipo (0 BOOL), u8 bit,
//  u16 offset }, size byte di valori iniziali. Al Download i campi con stesso nome e tipo tengono il valore.
//  Ogni rung lascia lo stack com'era, quindi una funzione non tocca i valori del chiamante.
//
//  Ogni rung lascia lo stack vuoto (POP finale): lo stack non cresce con
//  il numero di rung.
//
//  Esporta: compileIR(program) → {bytecode, source_gzip, hex, errors, warnings, blocks, proj}
//           buildWireBlob(bytecode, source_gzip, numBlocks) → Uint8Array ('PLC1')
//           buildPatchBlob(r, plcBlocks) → { blob ('PLCP'), changed[] } | null
//           EspBlocks.parseSection / sourceToProject / gunzipText
// ============================================================
(function () {
  "use strict";

  // Limiti della VM. Valori di default = firmware v2.4/v2.5; se il PLC li dichiara
  // (/api/plc/memory: instr_max, call_depth, vm_stack, ops) valgono quelli.
  const LIM_DEF = { instrMax: 10000, callDepth: 8, vmStack: 16 };
  let LIM = Object.assign({}, LIM_DEF);
  const OP = {
    NOP: 0x00, END: 0x01,
    LD: 0x10, LDN: 0x11, AND: 0x12, ANDN: 0x13, OR: 0x14, ORN: 0x15,
    LDC: 0x16, ANB: 0x17, ORB: 0x18, DUP: 0x19, POP: 0x1A, OVER: 0x1B,
    TON: 0x50, TOF: 0x51, TP: 0x52, TMR: 0x58,                                                                  // TMR: v5.2
    EDGE: 0x53, TRIG: 0x54, CTU: 0x55, CTD: 0x56, CTUD: 0x57,
    CALL: 0x60, RET: 0x61, FRAME: 0x62, ENO: 0x65, CALLP: 0x63,
    CMP: 0x70, MOVE: 0x71, ADD: 0x72, SUB: 0x73, MUL: 0x74, DIV: 0x75, MOD: 0x76, NEG: 0x77, ABS: 0x78, CONV: 0x79,
    NOT: 0x1C, RETC: 0x64, MATH: 0x7A, MIN: 0x7B, MAX: 0x7C, LIMIT: 0x7D, SCALE: 0x7E,                      // v4.6
    AND_W: 0x80, OR_W: 0x81, XOR_W: 0x82, INV: 0x83, SHL: 0x84, SHR: 0x85, ROL: 0x86, ROR: 0x87, SWAP: 0x88,
    ST: 0x20, STN: 0x21, S: 0x22, R: 0x23,
    JMP: 0x66, JMPC: 0x67, JMPCN: 0x68,                                                                         // v5.1
  };
  // I = ingressi, Q = uscite (area 0x02 del firmware; O = Q nei progetti di prima), M = merker.
  const NS = { I: 0x01, Q: 0x02, O: 0x02, M: 0x03, T: 0x06, SM: 0x08 };   // T = Q dei timer, SM = bit di sistema (sola lettura)
  const RANGE = { I: 1023, Q: 1023, O: 1023, M: 1023, T: 255, SM: 5 };     // oltre 255: istruzioni a indice 16 bit
  // v4.6: bit di una parola (MW3.5): area numerica + bit
  const WBIT_NS = { MB: 0x15, MW: 0x10, MI: 0x11, MD: 0x12, MDI: 0x13 }, WBIT_W = { MB: 8, MW: 16, MI: 16, MD: 32, MDI: 32 };
  const TIMER_KINDS = { TON: 1, TOF: 1, TP: 1 };
  const PT_MAX = 0x7FFFFFFF;                           // ~24,8 giorni in ms

  const COIL_OP = { coil: OP.ST, ncoil: OP.STN, set: OP.S, reset: OP.R };

  // ── v3.1: aree numeriche, tipi, fronti ────────────────
  //  Operando numerico: { ns: "MB"|"MW"|"MI"|"MD"|"MDI"|"MR", idx } oppure costante { k: numero }.
  //  Il tipo lo dà l'area: MB = BYTE, MI = INT, MW = WORD, MDI = DINT, MD = UDINT, MR = REAL.
  const GONE = "area MB/MW/MI/MD/MDI/MR non più nel PLC, usa un campo di DB";
  const NUM = { MB: { od: 0x15, T: 6, max: 256 }, MW: { od: 0x10, T: 2, max: 256 }, MI: { od: 0x11, T: 1, max: 256 }, MD: { od: 0x12, T: 4, max: 128 },
                MDI: { od: 0x13, T: 3, max: 128 }, MR: { od: 0x14, T: 5, max: 128 } };
  const T_NAME = { 1: "INT", 2: "WORD", 3: "DINT", 4: "UDINT", 5: "REAL", 6: "BYTE", 7: "SINT" };
  const T_RANGE = { 1: [-32768, 32767], 2: [0, 65535], 3: [-2147483648, 2147483647], 4: [0, 4294967295], 6: [0, 255], 7: [-128, 127] };
  const CMP_CODE = { "==": 0, "<>": 1, "<": 2, ">": 3, "<=": 4, ">=": 5 };
  const BOX_OPS = { MOVE: 1, ADD: 2, SUB: 2, MUL: 2, DIV: 2, MOD: 2, NEG: 1, ABS: 1, CONV: 1,   // numero di ingressi
                    MIN: 2, MAX: 2, LIMIT: 3, SQRT: 1, SQR: 1, SCALE: 5,                         // v4.6
                    AND: 2, OR: 2, XOR: 2, INV: 1, SHL: 2, SHR: 2, ROL: 2, ROR: 2, SWAP: 1 };
  const BOX_CODE = { AND: OP.AND_W, OR: OP.OR_W, XOR: OP.XOR_W };      // gli altri: OP[nome]
  const BOX_INT = { AND: 1, OR: 1, XOR: 1, INV: 1, SHL: 1, SHR: 1, ROL: 1, ROR: 1, SWAP: 1 };   // solo interi
  const BOX_FIELDS = ["a", "b", "c", "d", "e"];
  const EDGE_BITS = 512;
  let AREA_N = {};                                      // dimensioni in uso (dal PLC) o il massimo
  // v4.8: DB (area da 8 KB) e dati locali della FC che si sta compilando
  let DBL = { size: 0, dbs: new Map() }, CUR = null;    // CUR = layoutIface del blocco in corso (null: Main, StartUp)
  const MEM_OD = { DB: 0x16, L: 0x17, LN: 0x18 };
  // operando nel codice: DB oltre i 64 KB (P4) con i bit alti nel codice d'area (numerico 0x20 + h, bit 0x40 + h)
  const numEnc = (od, off) => od === 0x16 && off > 0xFFFF ? [0x20 + (off >> 16), off & 0xFF, (off >> 8) & 0xFF] : [od, off & 0xFF, (off >> 8) & 0xFF];
  const bitEnc = (od, off, bit) => od === 0x16 && off > 8191 ? [0x40 + (off >> 13), ((off & 8191) << 3) | bit] : [od, (off << 3) | bit];
  // operando DB / L / LN → { od, off, bit?, type } (null = non esiste)
  // struct = true: anche una struttura intera ({ struct: true, size }), per i parametri delle FC e i timer nel DB
  function memVar(o, struct) {
    if (!o || typeof o !== "object") return null;
    if (o.ns === "DB") {
      const d = DBL.dbs.get(o.db), v = d && d.vars.get(o.f);
      if (!v || v.arr) return null;                                    // array: solo nelle FC in testo (con l'indice)
      if (v.struct) return struct && o.bit == null ? { od: 0x16, off: d.base + v.off, type: v.type, struct: true, size: v.size } : null;
      if (o.bit != null) {                                            // bit di un campo numerico (Merker.MW3.5)
        if (v.type === "BOOL" || !Number.isInteger(o.bit) || o.bit < 0 || o.bit >= EspIR.TYPE_W[v.type] * 8) return null;
        return { od: 0x16, off: d.base + v.off + (o.bit >> 3), bit: o.bit & 7, type: "BOOL" };
      }
      return { od: 0x16, off: d.base + v.off, bit: v.bit, type: v.type };
    }
    if (o.ns === "L") {
      const v = CUR && CUR.vars.get(o.v);
      if (v && v.struct) return struct ? { od: 0x17, off: v.off, type: v.type, struct: true, size: v.size } : null;
      return v && !v.arr ? { od: 0x17, off: v.off, bit: v.bit, type: v.type } : null;
    }
    if (o.ns === "LN" && Number.isInteger(o.off)) return { od: 0x18, off: o.off, bit: o.bit, type: o.type };
    return null;
  }
  const isNumVar = o => !!o && typeof o === "object" && (((o.ns in NUM) && Number.isInteger(o.idx)) || (() => { const m = memVar(o); return !!m && m.type !== "BOOL"; })());
  const isConst = o => !!o && typeof o === "object" && (typeof o.k === "number" || typeof o.k === "boolean");
  const numT = o => (o.ns in NUM) ? NUM[o.ns].T : EspIR.TYPE_T[memVar(o).type];
  const memKey = o => o.ns === "DB" ? `DB${o.db}.${o.f}${o.bit != null ? "." + o.bit : ""}` : o.ns === "L" ? `#${o.v}` : "LN";
  const numKey = o => isNumVar(o) ? ((o.ns in NUM) ? o.ns + o.idx : memKey(o)) : isConst(o) ? String(o.k) : "?";
  // effetto sulla corrente: devono vedere la corrente di sinistra (compilati "con corrente")
  const isEffect = it => it.type === "Timer" || it.type === "Call" || it.type === "Box" || it.type === "Trig";
  // la serie che comincia con uno di questi parte dalla corrente della barra (LDC 1)
  const needsPower = it => isEffect(it) || it.type === "Not";
  // come un contatto (LD / AND / OR): contatti, anche con fronte, e confronti
  const isContactLike = it => it.type === "Contact" || it.type === "Compare";
  const f32 = new DataView(new ArrayBuffer(4));
  function odBytes(o, T, ctx, what) {
    if (isConst(o)) {
      const k = o.k;
      if (T === 5) {
        if (!isFinite(Math.fround(k))) { ctx.errors.push(`${ctx.tag}: ${what}: costante ${k} fuori dal campo di un REAL (±3.4e38)`); return null; }
        f32.setFloat32(0, k, true);
      } else {
        if (!Number.isInteger(k) || k < T_RANGE[T][0] || k > T_RANGE[T][1]) {
          ctx.errors.push(`${ctx.tag}: ${what}: ${k} non sta in un ${T_NAME[T]} (${T_RANGE[T][0]}..${T_RANGE[T][1]})`); return null; }
        f32.setUint32(0, k >>> 0, true);
      }
      return [0x80, f32.getUint8(0), f32.getUint8(1), f32.getUint8(2), f32.getUint8(3)];
    }
    if (!isNumVar(o)) { ctx.errors.push(`${ctx.tag}: ${what}: operando mancante${o && (o.ns === "DB" || o.ns === "L") ? " o non numerico (" + memKey(o) + ")" : ""}`); return null; }
    if (o.ns in MEM_OD) {
      const m = memVar(o);
      if (EspIR.TYPE_T[m.type] !== T) { ctx.errors.push(`${ctx.tag}: ${what}: ${numKey(o)} è ${m.type}, qui serve ${T_NAME[T]} (usa CONV)`); return null; }
      return numEnc(m.od, m.off);
    }
    ctx.errors.push(`${ctx.tag}: ${what}: ${numKey(o)}: ${GONE}`); return null;
  }
  // Tipo comune degli operandi variabili (null = errore già segnalato)
  function commonType(list, ctx, what) {
    const vars = list.filter(isNumVar);
    if (!vars.length) { ctx.errors.push(`${ctx.tag}: ${what}: serve almeno un operando variabile (campo di DB o variabile #)`); return null; }
    const T = numT(vars[0]);
    for (const v of vars) if (numT(v) !== T) {
      ctx.errors.push(`${ctx.tag}: ${what}: tipi diversi (${vars.map(x => numKey(x) + " " + T_NAME[numT(x)]).join(", ")}) — usa CONV`); return null; }
    return T;
  }
  const EDGE_NS = { E: 0x07, M: 0x03 };

  const mkS = items => ({ type: "Series", items });
  function opOk(op) {
    if (op && (op.ns in MEM_OD)) { const m = memVar(op); return !!m && m.type === "BOOL"; }
    if (op && (op.ns in WBIT_NS)) return false;
    return op && (op.ns in NS) && Number.isInteger(op.idx) && op.idx >= 0 && op.idx <= RANGE[op.ns] && op.bit == null;
  }
  const key = op => (op.ns in MEM_OD) ? memKey(op) : `${op.ns}${op.idx}${op.bit != null ? "." + op.bit : ""}`;
  // [ns, idx16] di un operando a bit (idx16 > 255 o bit di parola → istruzioni a 16 bit)
  const bitRef = o => (o.ns in MEM_OD) ? (m => bitEnc(m.od, m.off, m.bit))(memVar(o))
                    : (o.ns in WBIT_NS) ? [WBIT_NS[o.ns], (o.idx << 5) | o.bit] : [NS[o.ns], o.idx];

  function compileRung(r, ctx) {
    const out = ctx.out;
    let depth = 0;
    const push = () => { depth++; if (depth > ctx.maxDepth) ctx.maxDepth = depth; if (depth > LIM.vmStack) ctx.overflow = true; };
    const pop  = () => { depth--; };
    const emit3 = (op, o) => {
      if (o.ns === "I" || o.ns === "Q") ctx.ioUsed.add(o.ns + o.idx);
      const [ns, ix] = bitRef(o);
      if (ix > 255 || (o.ns in WBIT_NS) || (o.ns in MEM_OD)) out.push(op + 0x20, ns, ix & 0xFF, (ix >> 8) & 0xFF);   // LD16 … R16
      else out.push(op, ns, ix);
    };

    function contactOk(c) {
      if (!opOk(c.op)) { ctx.errors.push(`${ctx.tag}: contatto ${c.op ? key(c.op) : "?"} ${c.op && c.op.ns in WBIT_NS ? GONE : "non valido"}`); return false; }
      return true;
    }
    function memBytes(m) {
      if (!m || !(m.ns in EDGE_NS) || !Number.isInteger(m.idx) || m.idx < 0 || m.idx > (m.ns === "E" ? EDGE_BITS - 1 : RANGE.M)) {
        ctx.errors.push(`${ctx.tag}: memoria del fronte non valida`); return null; }
      const k = m.ns + m.idx;
      if (!ctx.edgeMem.has(k)) ctx.edgeMem.set(k, []);
      ctx.edgeMem.get(k).push(ctx.tag);
      return [EDGE_NS[m.ns], m.idx & 0xFF, (m.idx >> 8) & 0xFF];
    }
    // Contatto (anche con fronte P/N) o confronto, in modo 0 = LD, 1 = AND, 2 = OR
    const MODE_OP = [[OP.LD, OP.LDN], [OP.AND, OP.ANDN], [OP.OR, OP.ORN]];
    function emitContactLike(it, mode) {
      if (it.type === "Compare") {
        if (!(it.cmp in CMP_CODE)) { ctx.errors.push(`${ctx.tag}: confronto non valido`); return; }
        const T = commonType([it.a, it.b], ctx, "confronto");
        if (T == null) return;
        const a = odBytes(it.a, T, ctx, "confronto"), b = odBytes(it.b, T, ctx, "confronto");
        if (a && b) out.push(OP.CMP, mode, T, CMP_CODE[it.cmp], ...a, ...b);
        return;
      }
      if (!contactOk(it)) return;
      if (it.edge) {
        if (it.op.ns === "I" || it.op.ns === "Q") ctx.ioUsed.add(it.op.ns + it.op.idx);
        const mb = memBytes(it.mem);
        const [ens, eix] = bitRef(it.op);
        if (mb) out.push(OP.EDGE, mode | (it.edge === "N" ? 0x10 : 0), ens, eix & 0xFF, (eix >> 8) & 0xFF, ...mb);
        return;
      }
      emit3(MODE_OP[mode][it.negated ? 1 : 0], it.op);
    }
    function emitTrig(t) {
      const mb = memBytes(t.mem);
      if (mb) out.push(OP.TRIG, t.edge === "N" ? 0x10 : 0, ...mb);
    }
    // v4.9: contatori. Box { box: CTU|CTD|CTUD, a = PV, out = CV, r / ld / cd = bit (o niente), mem = fronte di CU (o CD), memD = fronte di CD }
    function emitCounter(b) {
      const op = b.box;
      if (!isNumVar(b.out)) { ctx.errors.push(`${ctx.tag}: ${op}: manca la variabile del conteggio (CV)`); return; }
      if (!isNumVar(b.a) && !isConst(b.a)) { ctx.errors.push(`${ctx.tag}: ${op}: manca il valore di preimpostazione (PV)`); return; }
      const T = commonType([b.a, b.out], ctx, op);
      if (T == null) return;
      if (T === 5) { ctx.errors.push(`${ctx.tag}: ${op} solo con numeri interi (INT, DINT, WORD, UDINT, BYTE)`); return; }
      const bit = (o, w) => {
        if (!o) return [0, 0, 0];
        if (!opOk(o)) { ctx.errors.push(`${ctx.tag}: ${op} ${w}: ${key(o)} non valido`); return null; }
        if (o.ns === "I" || o.ns === "Q") ctx.ioUsed.add(o.ns + o.idx);
        const [ns, ix] = bitRef(o);
        return [ns, ix & 0xFF, (ix >> 8) & 0xFF];
      };
      const m1 = memBytes(b.mem), m2 = op === "CTUD" ? memBytes(b.memD) : [];
      const pv = odBytes(b.a, T, ctx, op + " PV"), cv = odBytes(b.out, T, ctx, op + " CV");
      const bits = op === "CTUD" ? [bit(b.cd, "CD"), bit(b.r, "R"), bit(b.ld, "LD")] : [bit(op === "CTU" ? b.r : b.ld, op === "CTU" ? "R" : "LD")];
      if (m1 && m2 && pv && cv && bits.every(Boolean)) out.push(OP[op], T, ...bits.flat(), ...m1, ...m2, ...pv, ...cv);
    }
    // Box con EN/ENO (MOVE, ADD, …, CONV)
    function emitBox(b) {
      const op = b.box;
      if (op === "CTU" || op === "CTD" || op === "CTUD") return emitCounter(b);
      if (!(op in BOX_OPS)) { ctx.errors.push(`${ctx.tag}: istruzione ${op} sconosciuta`); return; }
      if (!isNumVar(b.out)) { ctx.errors.push(`${ctx.tag}: ${op}: manca l'uscita (OUT) o non è un'area numerica`); return; }
      if (op === "CONV") {
        if (!isNumVar(b.a) && !isConst(b.a)) { ctx.errors.push(`${ctx.tag}: CONV: manca l'ingresso`); return; }
        const k = b.a.k;
        const Ti = isNumVar(b.a) ? numT(b.a)
                 : !Number.isInteger(k) ? 5
                 : (k >= -2147483648 && k <= 2147483647) ? 3 : (k >= 0 && k <= 4294967295) ? 4 : 5;
        const To = numT(b.out);
        const a = odBytes(b.a, Ti, ctx, "CONV IN"), o = odBytes(b.out, To, ctx, "CONV OUT");
        if (a && o) out.push(OP.CONV, Ti, To, b.trunc ? 1 : 0, ...a, ...o);
        return;
      }
      if (op === "SCALE") {                                   // IN, IN_MIN, IN_MAX di un tipo; OUT_MIN, OUT_MAX, OUT dell'altro
        const Ti = commonType([b.a, b.b, b.c], ctx, "SCALE IN"), To = commonType([b.d, b.e, b.out], ctx, "SCALE OUT");
        if (Ti == null || To == null) return;
        const bs = [[b.a, Ti, "IN"], [b.b, Ti, "IN_MIN"], [b.c, Ti, "IN_MAX"], [b.d, To, "OUT_MIN"], [b.e, To, "OUT_MAX"], [b.out, To, "OUT"]]
          .map(([o, T, w]) => odBytes(o, T, ctx, "SCALE " + w));
        if (bs.every(Boolean)) out.push(OP.SCALE, Ti, To, ...bs.flat());
        if (isConst(b.b) && isConst(b.c) && b.b.k === b.c.k) ctx.errors.push(`${ctx.tag}: SCALE: IN_MIN e IN_MAX uguali`);
        return;
      }
      const ins = BOX_FIELDS.slice(0, BOX_OPS[op]).map(f => b[f]);
      const T = commonType([...ins, b.out], ctx, op);
      if (T == null) return;
      if ((op === "SQRT" || op === "SQR") && T !== 5) { ctx.errors.push(`${ctx.tag}: ${op} solo con REAL (usa CONV)`); return; }
      if (BOX_INT[op] && T === 5) { ctx.errors.push(`${ctx.tag}: ${op} solo con numeri interi (BYTE, WORD, INT, DINT, UDINT)`); return; }
      if (op === "SWAP" && T === 6) { ctx.errors.push(`${ctx.tag}: SWAP su un BYTE non cambia niente`); return; }
      if (op === "MOD" && T === 5) { ctx.errors.push(`${ctx.tag}: MOD solo con numeri interi`); return; }
      if ((op === "NEG" || op === "ABS") && (T === 2 || T === 4 || T === 6)) { ctx.errors.push(`${ctx.tag}: ${op} non ha senso su ${T_NAME[T]} (senza segno)`); return; }
      const bs = ins.map((x, i) => odBytes(x, T, ctx, `${op} IN${i + 1}`));
      const o = odBytes(b.out, T, ctx, `${op} OUT`);
      if (bs.every(Boolean) && o) {
        if (op === "SQRT" || op === "SQR") out.push(OP.MATH, T, op === "SQRT" ? 0 : 1, ...bs.flat(), ...o);
        else out.push(BOX_CODE[op] || OP[op], T, ...bs.flat(), ...o);
      }
      if (op === "LIMIT" && isConst(b.a) && isConst(b.c) && b.a.k > b.c.k) ctx.errors.push(`${ctx.tag}: LIMIT: MN maggiore di MX`);
      if (op === "DIV" || op === "MOD") { const d = ins[1]; if (isConst(d) && d.k === 0) ctx.errors.push(`${ctx.tag}: ${op} per zero`); }
    }
    function timerOk(t) {
      const tv = t.op && (t.op.ns in MEM_OD) ? memVar(t.op, true) : null;   // v5.2: variabile TIMER (DB o interfaccia)
      if (t.op && (t.op.ns in MEM_OD)) {
        if (!(t.kind in TIMER_KINDS) || !tv || tv.type !== "TIMER") { ctx.errors.push(`${ctx.tag}: ${memKey(t.op)} non è una variabile TIMER`); return false; }
        if (LIM.vm && !(parseFloat(LIM.vm) >= 5.2)) { ctx.errors.push(`${ctx.tag}: timer in un DB: serve la VM 5.2 del PLC (adesso ${LIM.vm}) — aggiorna il firmware`); return false; }
        if (t.op.ns === "L" && CUR && (CUR.vars.get(t.op.v) || {}).dir === "temp") ctx.warnings.push(`${ctx.tag}: #${t.op.v} è TEMP: il timer riparte da zero a ogni chiamata (mettilo in STATIC o in un DB)`);
        if (t.ptOp && !isNumVar(t.ptOp)) { ctx.errors.push(`${ctx.tag}: PT del timer ${memKey(t.op)}: serve una variabile TIME o DINT`); return false; }
      } else if (!(t.kind in TIMER_KINDS) || !t.op || t.op.ns !== "T" || !opOk(t.op)) {
        ctx.errors.push(`${ctx.tag}: timer ${t.op ? key(t.op) : "?"} non valido`); return false; }
      if (t.ptOp && !tv) { ctx.errors.push(`${ctx.tag}: timer ${key(t.op)}: il PT da una variabile solo con i timer in un DB`); return false; }
      if (!t.ptOp && (!Number.isInteger(t.pt) || t.pt < 0 || t.pt > PT_MAX)) {
        ctx.errors.push(`${ctx.tag}: tempo del timer ${key(t.op)} non valido`); return false; }
      const k = key(t.op);
      if (!ctx.timers.has(k)) ctx.timers.set(k, []);
      ctx.timers.get(k).push(ctx.tag);
      if (!ctx.timerKinds) ctx.timerKinds = new Map();
      if (!ctx.timerKinds.has(k)) ctx.timerKinds.set(k, new Set());
      ctx.timerKinds.get(k).add(t.kind);
      return true;
    }
    function emitTimer(t) {
      if (!timerOk(t)) return;
      if (t.op.ns in MEM_OD) {                                 // v5.2: OP_TMR [tipo][variabile TIMER][PT DINT]
        const tv = memVar(t.op, true), p = odBytes(t.ptOp || { k: t.pt }, 3, ctx, "PT del timer");
        if (p) out.push(OP.TMR, { TON: 0, TOF: 1, TP: 2 }[t.kind], ...numEnc(tv.od, tv.off), ...p);
        return;
      }
      const pt = t.pt >>> 0;
      out.push(OP[t.kind], t.op.idx, pt & 0xFF, (pt >>> 8) & 0xFF, (pt >>> 16) & 0xFF, (pt >>> 24) & 0xFF);
    }
    // Timer e chiamate hanno effetti: in un parallelo devono vedere la corrente di sinistra
    const hasTimer = s => s.items.some(it => isEffect(it) ||
      (it.type === "Parallel" && it.branches.some(hasTimer)));
    // v4.8: FC con interfaccia: FRAME, IN/IN_OUT nel pezzo nuovo (LN), CALL, OUT/IN_OUT fuori (solo con EN = 1)
    function emitCall(it) {
      const fc = it.fc, lay = ctx.ifaces.get(fc), args = (it.args && typeof it.args === "object") ? it.args : {};
      const call = () => { out.push(OP.CALL, fc & 0xFF, (fc >> 8) & 0xFF); ctx.callSites.push({ pos: out.length - 3, depth, fc, tag: ctx.tag }); };
      if (!lay || !lay.size) {
        const extra = Object.keys(args);
        if (extra.length) ctx.errors.push(`${ctx.tag}: FC${fc} non ha parametri (${extra.join(", ")})`);
        call(); return;
      }
      for (const k of Object.keys(args)) if (!lay.vars.has(k) || lay.vars.get(k).dir === "temp" || lay.vars.get(k).dir === "static") ctx.errors.push(`${ctx.tag}: FC${fc} non ha il parametro ${k}`);
      // FB: le STATIC si leggono e si riscrivono nel DB d'istanza della chiamata (EspIR.fbSync), come un IN_OUT
      const inst = Number.isInteger(it.inst) ? it.inst : null;
      if (lay.params.some(p => p.dir === "static") && (inst == null || !DBL.dbs.has(inst))) ctx.errors.push(`${ctx.tag}: FB${fc}: la chiamata non ha il suo DB d'istanza`);
      const argOf = p => p.dir === "static" ? (inst != null ? { ns: "DB", db: inst, f: p.name } : null) : args[p.name];
      const what = p => `FC${fc} ${p.name}`;
      const ln = p => ({ ns: "LN", off: p.off, bit: p.bit, type: p.type });
      // struttura (v5.2): stesso tipo, copiata 4 byte alla volta (MOVE UDINT, la coda 2 o 1), in = verso la FC chiamata
      const structCopy = (a, l, p, into) => {
        const m = a && (a.ns in MEM_OD) ? memVar(a, true) : null;
        if (!m || !m.struct || m.type !== p.type) { if (into ? (a || p.dir !== "in") : p.dir === "out") ctx.errors.push(`${ctx.tag}: ${what(p)}: serve una variabile ${EspIR.structLabel(p.type)}`); return; }
        for (let k = 0, w; k < p.size; k += w) {             // a byte (Denys 04-11-2026): la coda con 2 o 1 byte
          w = p.size - k >= 4 ? 4 : p.size - k >= 2 ? 2 : 1;
          const s = into ? numEnc(m.od, m.off + k) : numEnc(0x18, l.off + k), d = into ? numEnc(0x18, l.off + k) : numEnc(m.od, m.off + k);
          out.push(OP.MOVE, EspIR.TYPE_T[w === 4 ? "UDINT" : w === 2 ? "WORD" : "BYTE"], ...s, ...d);
        }
      };
      out.push(OP.FRAME, lay.size & 0xFF, (lay.size >> 8) & 0xFF);
      for (const p of lay.params) {
        if (p.dir === "out") continue;
        let a = argOf(p);
        if (p.dir === "static" && a == null) continue;
        if (p.struct) { structCopy(a, ln(p), p, true); continue; }
        if (a == null) {
          if (p.dir === "inout") { ctx.errors.push(`${ctx.tag}: ${what(p)} (IN_OUT) va collegato a una variabile`); continue; }
          a = { k: p.v.def != null ? p.v.def : 0 };                       // IN non collegato: il suo default
        }
        if (p.type === "BOOL") {
          if (isConst(a)) out.push(OP.LDC, a.k ? 1 : 0);
          else if (opOk(a)) emit3(OP.LD, a);
          else { ctx.errors.push(`${ctx.tag}: ${what(p)}: serve un bit o TRUE/FALSE`); continue; }
          push(); emit3(OP.ST, ln(p)); out.push(OP.POP); pop();
        } else {
          const s = odBytes(isConst(a) && typeof a.k === "boolean" ? { k: a.k ? 1 : 0 } : a, p.T, ctx, what(p)), d = odBytes(ln(p), p.T, ctx, what(p));
          if (s && d) out.push(OP.MOVE, p.T, ...s, ...d);
        }
      }
      // EN resta sotto l'ENO per copiare fuori gli OUT anche con ENO = 0: DUP CALL OVER … POP ANB (→ EN ∧ ENO = ENO)
      out.push(OP.DUP); push();
      call();
      out.push(OP.OVER); push();
      for (const p of lay.params) {
        if (p.dir === "in") continue;
        const a = argOf(p);
        if (a == null) continue;                                          // OUT non collegato: si scarta
        if (isConst(a)) { ctx.errors.push(`${ctx.tag}: ${what(p)}: un'uscita non può essere una costante`); continue; }
        if (p.struct) { structCopy(a, ln(p), p, false); continue; }
        if (p.type === "BOOL") {
          if (!opOk(a) || a.ns === "I" || a.ns === "SM" || a.ns === "T") { ctx.errors.push(`${ctx.tag}: ${what(p)}: serve un bit scrivibile`); continue; }
          // a = OUT solo con EN = 1:  EN∧OUT → S a,  EN∧¬OUT → R a
          out.push(OP.DUP); push(); emit3(OP.AND, ln(p)); emit3(OP.S, a); out.push(OP.POP); pop();
          out.push(OP.DUP); push(); emit3(OP.ANDN, ln(p)); emit3(OP.R, a); out.push(OP.POP); pop();
        } else {
          const s = odBytes(ln(p), p.T, ctx, what(p)), d = odBytes(a, p.T, ctx, what(p));
          if (s && d) out.push(OP.MOVE, p.T, ...s, ...d);
        }
      }
      out.push(OP.POP); pop(); out.push(OP.ANB); pop();
    }

    // Calcola la serie e lascia UN valore in cima allo stack (corrente = barra sinistra).
    function pushSeries(s) {
      const first = s.items[0];
      if (!first || needsPower(first) || (first.type === "Parallel" && hasTimer(mkS([first])))) {
        out.push(OP.LDC, 1); push();          // la corrente parte dalla barra: TRUE
        andSeries(s);
        return;
      }
      s.items.forEach((it, i) => {
        if (isContactLike(it)) {
          if (i === 0) { emitContactLike(it, 0); push(); }
          else emitContactLike(it, 1);
        } else if (it.type === "Timer") {
          emitTimer(it);
        } else if (it.type === "Call") {
          emitCall(it);
        } else if (it.type === "Box") {
          emitBox(it);
        } else if (it.type === "Trig") {
          emitTrig(it);
        } else if (it.type === "Not") {
          out.push(OP.NOT);
        } else if (hasTimer(mkS([it]))) {
          parallelWithPower(it);
        } else {
          pushParallel(it);
          if (i > 0) { out.push(OP.ANB); pop(); }
        }
      });
    }
    // Parallelo di soli contatti: calcola l'OR dei rami e lascia UN valore in cima.
    function pushParallel(p) {
      p.branches.forEach((b, i) => {
        if (!b.items.length) ctx.warnings.push(`${ctx.tag}: ramo parallelo vuoto (sempre vero)`);
        if (i === 0) { pushSeries(b); return; }
        if (b.items.length === 1 && isContactLike(b.items[0])) {
          emitContactLike(b.items[0], 2);
        } else { pushSeries(b); out.push(OP.ORB); pop(); }
      });
    }
    // Parallelo con timer: ogni ramo riceve la corrente che arriva al parallelo.
    //   [pw] LDC 0 { OVER andSeries(ramo) ORB }… ANB   → [pw ∧ OR(pw∧ramo)]
    function parallelWithPower(p) {
      out.push(OP.LDC, 0); push();
      p.branches.forEach(b => {
        out.push(OP.OVER); push();
        andSeries(b);
        out.push(OP.ORB); pop();
      });
      out.push(OP.ANB); pop();
    }
    // Mette in AND la serie col valore già in cima (la corrente che arriva).
    function andSeries(s) {
      s.items.forEach(it => {
        if (isContactLike(it)) emitContactLike(it, 1);
        else if (it.type === "Timer") emitTimer(it);
        else if (it.type === "Call") emitCall(it);
        else if (it.type === "Box") emitBox(it);
        else if (it.type === "Trig") emitTrig(it);
        else if (it.type === "Not") out.push(OP.NOT);
        else if (hasTimer(mkS([it]))) parallelWithPower(it);
        else { pushParallel(it); out.push(OP.ANB); pop(); }
      });
    }

    // Uscite (anche annidate): ogni uscita tranne l'ultima parte da una copia
    // (DUP) del valore del punto di diramazione; ogni bobina chiude con POP.
    // Un'uscita che si dirama ancora non ha POP proprio: lo consuma la sua
    // ultima sotto-uscita.
    function emitOutputs(list) {
      list.forEach((o, k) => {
        const last = k === list.length - 1;
        if (!last) { out.push(OP.DUP); push(); }
        andSeries(o.series);
        if (o.coil && (o.coil.kind in TIMER_KINDS)) {          // timer al posto della bobina
          emitTimer(o.coil);
          out.push(OP.POP); pop();
        } else if (o.coil && o.coil.kind === "CALL") {         // chiamata funzione a fine rung
          emitCall(o.coil);
          out.push(OP.POP); pop();
        } else if (o.coil && o.coil.kind === "BOX") {          // box numerico a fine rung
          emitBox(o.coil);
          out.push(OP.POP); pop();
        } else if (o.coil && o.coil.kind === "RET" && (o.coil.ret === "eno" || o.coil.ret === "enon")) {   // bobina ENO: ENO della chiamata
          if (!CUR) ctx.warnings.push(`${ctx.tag}: la bobina ENO conta solo dentro una FC`);
          out.push(OP.ENO, o.coil.ret === "enon" ? 1 : 0); pop();
        } else if (o.coil && o.coil.kind === "RET") {          // bobina RET: esce dalla FC (nel Main: fine scansione)
          out.push(OP.RETC); pop();
        } else if (o.coil) {
          const c = o.coil;
          if (c.op && c.op.ns === "T") { ctx.errors.push(`${ctx.tag}: ${key(c.op)} è un timer, non si scrive con una bobina`); return; }
          if (!opOk(c.op)) { ctx.errors.push(`${ctx.tag}: bobina ${c.op ? key(c.op) : "?"} non valida`); return; }
          if (c.op.ns === "I") { ctx.errors.push(`${ctx.tag}: ${key(c.op)} è un ingresso, non si può scrivere`); return; }
          if (c.op.ns === "SM") { ctx.errors.push(`${ctx.tag}: ${key(c.op)} è un bit di sistema, si può solo leggere`); return; }
          emit3(COIL_OP[c.kind] || OP.ST, c.op);
          out.push(OP.POP); pop();
          if (c.kind === "coil" || c.kind === "ncoil") {
            const k2 = key(c.op);
            if (!ctx.coils.has(k2)) ctx.coils.set(k2, []);
            ctx.coils.get(k2).push(ctx.tag);
          }
        } else if (o.outputs && o.outputs.length) {
          emitOutputs(o.outputs);
        } else {
          ctx.errors.push(`${ctx.tag}: uscita senza bobina`);
        }
      });
    }

    // Network aperto che finisce con un timer, una FC o un box: è completo
    if ((!r.outputs || !r.outputs.length) && r.series.items.length) {
      const last = r.series.items[r.series.items.length - 1];
      if (last.type === "Timer" || last.type === "Call" || last.type === "Box") {
        r = { series: { type: "Series", items: r.series.items.slice(0, -1) }, outputs: [{ series: { type: "Series", items: [] }, coil: EspIR.inlineToCoil(last) }] };
      }
    }
    if (!r.series.items.length && (!r.outputs || !r.outputs.length)) return;   // network vuoto: niente codice
    if (!r.outputs || !r.outputs.length) { ctx.errors.push(`${ctx.tag}: incompleto — manca l'elemento finale (bobina, timer, FC o box)`); return; }
    pushSeries(r.series);
    emitOutputs(r.outputs);
    if (ctx.overflow) ctx.errors.push(`${ctx.tag}: troppi rami annidati (stack VM ${LIM.vmStack})`);
  }

  // Lunghezza dell'istruzione in code[i] (anche quelle a lunghezza variabile)
  function opLenAt(code, i) {
    const op = code[i], odz = p => code[p] === 0x80 ? 5 : code[p] === 0x19 ? 8 + (code[p + 8] === 0x80 ? 5 : 3) : 3;   // 0x19: elemento di array
    const walk = (head, n) => { let p = i + head; for (let k = 0; k < n; k++) p += odz(p); return p - i; };
    if (op === OP.CMP) return walk(4, 2);
    if (op === OP.MOVE || op === OP.NEG || op === OP.ABS) return walk(2, 2);
    if (op >= OP.ADD && op <= OP.MOD) return walk(2, 3);
    if (op === OP.CONV) return walk(4, 2);
    if (op === OP.MATH) return walk(3, 2);
    if (op === OP.MIN || op === OP.MAX || (op >= 0x80 && op <= 0x82) || (op >= 0x84 && op <= 0x87)) return walk(2, 3);
    if (op === OP.LIMIT) return walk(2, 4);
    if (op === OP.SCALE) return walk(3, 6);
    if (op === OP.INV || op === OP.SWAP) return walk(2, 2);
    if ((op >= 0x30 && op <= 0x35) || (op >= 0x40 && op <= 0x43)) return 4;
    if (op === OP.EDGE) return 8;
    if (op === OP.TRIG) return 5;
    if (op === OP.CTU || op === OP.CTD) return walk(8, 2);
    if (op === OP.CTUD) return walk(17, 2);
    if (op === OP.TMR) return walk(2, 2);
    return (op >= 0x10 && op <= 0x15) || (op >= 0x20 && op <= 0x23) || op === OP.CALL || op === OP.FRAME || (op >= OP.JMP && op <= OP.JMPCN) ? 3
         : op === OP.LDC || op === OP.ENO ? 2 : (op >= 0x50 && op <= 0x52) ? 6 : 1;
  }

  // ── CRC32 / util ─────────────────────────────────────
  let _crcTable = null;
  function crc32(bytes) {
    if (!_crcTable) {
      _crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        _crcTable[i] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = (_crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const toHex = b => Array.from(b, x => (x < 16 ? "0" : "") + x.toString(16)).join("");

  async function gzipBytes(text) {
    const enc = new TextEncoder().encode(text);
    if (typeof CompressionStream === "undefined") return enc;
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter(); w.write(enc); w.close();
    const reader = cs.readable.getReader();
    const chunks = []; let total = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
    const out = new Uint8Array(total);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // ── v5.1: FC scritte in testo (ST, C): l'albero di testo.js → istruzioni (salti, elementi di array) ─────────────
  // Variabili di lavoro dei calcoli dopo l'interfaccia, nei dati locali della FC (frame più grande: lay.size cresce).
  // A ogni istruzione lo stack dei bit torna com'era all'ingresso; i box hanno EN = 1 (LDC 1 … POP).
  const T_ORDER = { 6: 1, 7: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 4 };     // BYTE, SINT < INT, WORD < DINT, UDINT < REAL (allargamenti senza perdite)
  const WIDEN_OK = (from, to) => from === to || to === 5 || (T_ORDER[from] < T_ORDER[to] && !((from === 1 || from === 7) && (to === 4 || to === 2 || to === 6)));
  function compileText(block, ctx, lay) {
    const out = ctx.out, label = EspIR.blockLabel(block);
    const ast = EspText.parse(block.text || "", { lang: block.language });
    if (!ast.ok) { for (const e of ast.errors) ctx.errors.push(`${label} riga ${e.line}, col. ${e.col}: ${e.msg}`); return; }
    if (LIM.vm && !(parseFloat(LIM.vm) >= 5.1)) ctx.errors.push(`${label}: le FC in testo servono la VM 5.1 del PLC (adesso ${LIM.vm}) — aggiorna il firmware`);
    const W = { 1: 2, 2: 2, 3: 4, 4: 4, 5: 4, 6: 1, 7: 1 };
    let pos = { line: 1, col: 1 };
    const err = (msg, p) => { const q = p || pos; ctx.errors.push(`${label} riga ${q.line}, col. ${q.col}: ${msg}`); throw new Error("testo"); };
    // variabili di lavoro: dopo l'interfaccia, riusate a ogni istruzione
    let tmp = lay.size, tmpMax = lay.size;
    const tAlloc = T => { const w = W[T] || 1; tmp = Math.ceil(tmp / w) * w; const o = tmp; tmp += w; tmpMax = Math.max(tmpMax, tmp); return { od: 0x17, off: o, T }; };
    const bAlloc = () => { const o = tmp++; tmpMax = Math.max(tmpMax, tmp); return { od: 0x17, off: o, bit: 0 }; };
    let depth = 0;
    const push = () => { depth++; if (depth > ctx.maxDepth) ctx.maxDepth = depth; };
    const pop = () => { depth--; };
    const k32 = (T, v, p) => { const b = odBytes({ k: v }, T, { errors: { push: m => err(m.replace(/^[^:]*: /, ""), p) }, tag: "" }, "costante"); return b; };
    // ── operandi ──
    const dbOf = r => {
      if (typeof r.db === "number") return DBL.dbs.get(r.db) ? r.db : null;
      for (const [n, d] of DBL.dbs) if (d.db.name === r.db) return n;
      return null;
    };
    // simbolo della tabella dei simboli ("Nome"; in C anche un nome che non è dell'interfaccia) → il suo operando
    function viaSym(r) {
      if (r.ns !== "SYM" && !(r.ns === "L" && block.language === "C" && !lay.vars.has(r.v))) return r;
      const name = r.ns === "SYM" ? r.name : r.v;
      const s = typeof EspSymbols !== "undefined" ? EspSymbols.lookup(name) : null;
      if (!s) err(r.ns === "SYM" ? `"${name}": non è nella tabella dei simboli` : `${name}: non è nell'interfaccia della FC né nella tabella dei simboli`, r.pos);
      if (!(s.ns in NS) || s.bit != null) err(`${name} (${s.key}): nelle FC in testo i simboli di I, Q, M, T, SM; i numeri stanno nei DB`, r.pos);
      if (r.index) err(`${name}: un simbolo non è un array`, r.pos);
      return { ns: s.ns, idx: s.idx, pos: r.pos };
    }
    // Ref → { kind: "bit", ns, ix } | { kind: "num", T, bytes } (bytes: operando, anche elemento di array)
    function operand(r) {
      r = viaSym(r);
      if (r.ns === "I" || r.ns === "Q" || r.ns === "M" || r.ns === "T" || r.ns === "SM") {
        if (r.idx > RANGE[r.ns]) err(`${r.ns}${r.idx}: oltre ${r.ns}${RANGE[r.ns]}`, r.pos);
        if (r.ns === "I" || r.ns === "Q") ctx.ioUsed.add(r.ns + r.idx);
        return { kind: "bit", ns: NS[r.ns], ix: r.idx, ro: r.ns === "I" || r.ns === "T" || r.ns === "SM", name: r.ns + r.idx };
      }
      let v, od, base;
      if (r.ns === "L") { v = lay.vars.get(r.v); od = 0x17; base = 0; if (!v) err(`#${r.v}: non è nell'interfaccia della FC`, r.pos); }
      else { const n = dbOf(r); if (n == null) err(`DB ${typeof r.db === "number" ? r.db : '"' + r.db + '"'} non trovato`, r.pos);
             const d = DBL.dbs.get(n); v = d.vars.get(r.f); od = 0x16; base = d.base; if (!v) err(`${d.db.name}.${r.f}: campo non trovato`, r.pos); }
      const name = r.ns === "L" ? "#" + r.v : `${r.db}.${r.f}`;
      if (v.struct) err(`${name}: è una struttura (${EspIR.structLabel(v.type)}): scrivi uno dei suoi campi (${name}.…)`, r.pos);
      if (v.type === "BOOL") {
        if (r.index) err(`${name}: non è un array`, r.pos);
        const [bns, bix] = bitEnc(od, base + v.off, v.bit);
        return { kind: "bit", ns: bns, ix: bix, ro: false, name };
      }
      const off = base + v.off;
      if (!v.arr) { if (r.index) err(`${name}: non è un array`, r.pos); return { kind: "num", T: v.T, bytes: numEnc(od, off), name }; }
      if (!r.index) err(`${name}: è un array, serve l'indice (${name}[${v.arr.lo}])`, r.pos);
      const w = W[v.T], a = v.arr;
      if (r.index.k === "num") {                          // indice costante: l'indirizzo subito, controllato qui
        if (r.index.real || r.index.v < a.lo || r.index.v > a.hi) err(`${name}[${r.index.v}]: indice fuori da ${a.lo}..${a.hi}`, r.index.pos);
        const o = off + (r.index.v - a.lo) * w;
        return { kind: "num", T: v.T, bytes: numEnc(od, o), name };
      }
      // indice calcolato: (indice - lo) in una variabile di lavoro DINT (o la variabile stessa se è già intera e lo = 0)
      let ib, iT;
      const ie = r.index;
      const simple = ie.k === "ref" && !ie.r.index && a.lo === 0 && (() => { const x = operand(ie.r); return x.kind === "num" && x.T !== 5 ? x : null; })();
      if (simple) { ib = simple.bytes; iT = simple.T; }
      else {
        const t = tAlloc(3);
        numInto(a.lo === 0 ? ie : { k: "bin", op: "-", a: ie, b: { k: "num", v: a.lo, real: false, pos: ie.pos }, pos: ie.pos }, 3, [t.od, t.off & 0xFF, t.off >> 8]);
        ib = [t.od, t.off & 0xFF, t.off >> 8]; iT = 3;
      }
      return { kind: "num", T: v.T, bytes: [0x19, ...numEnc(od, off), w, a.n & 0xFF, a.n >> 8, iT, ...ib], name };
    }
    // tipo di un operando senza scrivere codice: "BOOL" o il codice del tipo
    function refType(r) {
      r = viaSym(r);
      if (r.ns === "I" || r.ns === "Q" || r.ns === "M" || r.ns === "T" || r.ns === "SM") return "BOOL";
      let v;
      if (r.ns === "L") v = lay.vars.get(r.v);
      else { const n = dbOf(r); v = n == null ? null : DBL.dbs.get(n).vars.get(r.f); }
      if (!v || v.struct) return operand(r);              // non esiste o struttura: l'errore con il suo testo
      return v.type === "BOOL" ? "BOOL" : v.T;
    }
    // ── tipi ──
    function typeOf(e) {                                  // tipo numerico (null = una costante intera che si adatta), "BOOL"
      switch (e.k) {
        case "num": return e.real ? 5 : null;
        case "bool": return "BOOL";
        case "ref": return refType(e.r);
        case "un": return e.op === "NOT" ? (typeOf(e.e) === "BOOL" ? "BOOL" : typeOf(e.e)) : typeOf(e.e);
        case "bin": {
          if (["=", "<>", "<", ">", "<=", ">=", "OR", "AND", "XOR"].includes(e.op) && (["OR", "AND", "XOR"].includes(e.op) ? typeOf(e.a) === "BOOL" : true)) return "BOOL";
          const a = typeOf(e.a), b = typeOf(e.b);
          if (a === "BOOL" || b === "BOOL") err(`«${e.op}» su un BOOL`, e.pos);
          if (a == null) return b;
          if (b == null) return a;
          return T_ORDER[a] >= T_ORDER[b] ? a : b;
        }
      }
      return null;
    }
    // ── valori numerici ──
    // operando di tipo T per e: costante, variabile (convertita se più stretta) o calcolato in una variabile di lavoro
    function numOd(e, T) {
      if (e.k === "num") {
        if (e.real && T !== 5) err(`${e.v}: un REAL dove serve un ${T_NAME[T]}`, e.pos);
        return k32(T, e.v, e.pos);
      }
      if (e.k === "ref") {
        const o = operand(e.r);
        if (o.kind !== "num") err(`${o.name}: è un BOOL, qui serve un numero`, e.pos);
        if (o.T === T) return o.bytes;
        if (!WIDEN_OK(o.T, T)) err(`${o.name} è ${T_NAME[o.T]}, qui serve ${T_NAME[T]}: perderebbe valori (usa una variabile ${T_NAME[o.T]})`, e.pos);
        const t = tAlloc(T), tb = [t.od, t.off & 0xFF, t.off >> 8];
        box([OP.CONV, o.T, T, 0, ...o.bytes, ...tb]);
        return tb;
      }
      const t = tAlloc(T), tb = [t.od, t.off & 0xFF, t.off >> 8];
      numInto(e, T, tb);
      return tb;
    }
    function box(bytes) { out.push(OP.LDC, 1); push(); out.push(...bytes); out.push(OP.POP); pop(); }
    // e (tipo T) → dst (operando)
    function numInto(e, T, dst) {
      pos = e.pos || pos;
      const t = typeOf(e);
      if (t === "BOOL") err("qui serve un numero, non una condizione", e.pos);
      if (e.k === "num" || e.k === "ref") { box([OP.MOVE, T, ...numOd(e, T), ...dst]); return; }
      if (t != null && t !== T && !WIDEN_OK(t, T)) err(`il calcolo è ${T_NAME[t]}, qui serve ${T_NAME[T]}: perderebbe valori`, e.pos);
      const CT = t == null ? T : t;                       // calcolo nel tipo degli operandi, poi CONV se serve
      const into = CT === T ? dst : (() => { const x = tAlloc(CT); return [x.od, x.off & 0xFF, x.off >> 8]; })();
      if (e.k === "un") {
        if (e.op === "NEG") { if (CT === 4 || CT === 2 || CT === 6) err("meno davanti a un numero senza segno", e.pos); box([OP.NEG, CT, ...numOd(e.e, CT), ...into]); }
        else box([OP.INV, CT, ...numOd(e.e, CT), ...into]);   // NOT / ~ su un intero: bit a bit
      } else {
        const opc = { "+": OP.ADD, "-": OP.SUB, "*": OP.MUL, "/": OP.DIV, MOD: OP.MOD, AND: OP.AND_W, OR: OP.OR_W, XOR: OP.XOR_W, BAND: OP.AND_W, BOR: OP.OR_W }[e.op];
        if (!opc) err(`«${e.op}» non dà un numero`, e.pos);
        if (CT === 5 && (opc === OP.MOD || opc >= OP.AND_W)) err(`«${e.op}» solo sugli interi`, e.pos);
        const save = tmp;
        const a = numOd(e.a, CT), b = numOd(e.b, CT);
        box([opc, CT, ...a, ...b, ...into]);
        tmp = Math.max(save, tmp);
      }
      if (into !== dst) box([OP.CONV, CT, T, 0, ...into, ...dst]);
    }
    // ── condizioni: un valore sullo stack dei bit ──
    const bitOp = (op, o) => { if (o.ix > 255 || o.ns >= 0x16) out.push(op + 0x20, o.ns, o.ix & 0xFF, (o.ix >> 8) & 0xFF); else out.push(op, o.ns, o.ix); };
    function cond(e) {
      pos = e.pos || pos;
      switch (e.k) {
        case "bool": out.push(OP.LDC, e.v ? 1 : 0); push(); return;
        case "ref": { const o = operand(e.r); if (o.kind !== "bit") err(`${o.name}: è un numero, qui serve una condizione (es. ${o.name} <> 0)`, e.pos); bitOp(OP.LD, o); push(); return; }
        case "un": if (e.op !== "NOT") break; cond(e.e); out.push(OP.NOT); return;
        case "bin": {
          if (e.op === "AND" || e.op === "OR") { cond(e.a); cond(e.b); out.push(e.op === "AND" ? OP.ANB : OP.ORB); pop(); return; }
          if (e.op === "XOR") {                            // (a AND NOT b) OR (NOT a AND b), con a e b nelle variabili di lavoro
            const ta = bAlloc(), tb = bAlloc(), A = { ns: 0x17, ix: ta.off << 3 }, B = { ns: 0x17, ix: tb.off << 3 };
            cond(e.a); bitOp(OP.ST, A); out.push(OP.POP); pop();
            cond(e.b); bitOp(OP.ST, B); out.push(OP.POP); pop();
            bitOp(OP.LD, A); push(); bitOp(OP.ANDN, B); bitOp(OP.LDN, A); push(); bitOp(OP.AND, B); out.push(OP.ORB); pop();
            return;
          }
          if (e.op in CMP_ALIAS) {
            const ta = typeOf(e.a), tb = typeOf(e.b);
            if (ta === "BOOL" || tb === "BOOL") {           // confronto fra condizioni: = è XOR negato, <> è XOR
              if (e.op !== "=" && e.op !== "<>") err("le condizioni si confrontano solo con = e <>", e.pos);
              cond({ k: "bin", op: "XOR", a: e.a, b: e.b, pos: e.pos }); if (e.op === "=") out.push(OP.NOT); return;
            }
            const T = ta == null && tb == null ? 3 : ta == null ? tb : tb == null ? ta : (T_ORDER[ta] >= T_ORDER[tb] ? ta : tb);
            const save = tmp;
            const a = numOd(e.a, T), b = numOd(e.b, T);
            out.push(OP.CMP, 0, T, CMP_CODE[CMP_ALIAS[e.op]], ...a, ...b); push();
            tmp = Math.max(save, tmp);
            return;
          }
        }
      }
      err("qui serve una condizione (TRUE/FALSE, un bit, un confronto)", e.pos);
    }
    // ── salti ──
    const jmp = op => { out.push(op, 0, 0); return out.length - 2; };
    const fix = (at, to) => { const o = to - (at + 2); if (o < -32768 || o > 32767) err("FC troppo lunga per un salto"); out[at] = o & 0xFF; out[at + 1] = (o >> 8) & 0xFF; };
    const jmpTo = (op, to) => fix(jmp(op), to);
    const loops = [];                                     // { brk: [posizioni], cont: [posizioni] } del ciclo in corso
    // ── istruzioni ──
    function stmts(list) { for (const s of list) stmt(s); }
    function store(r, e) {
      const o = operand(r);
      if (o.kind === "bit") {
        if (o.ro) err(`${o.name}: si legge soltanto`, r.pos);
        cond(e); bitOp(OP.ST, o); out.push(OP.POP); pop();
      } else numInto(e, o.T, o.bytes);
    }
    function stmt(s) {
      pos = s.pos || pos;
      tmp = lay.size;                                     // variabili di lavoro: di nuovo libere a ogni istruzione
      switch (s.k) {
        case "nop": return;
        case "block": stmts(s.body); return;
        case "assign": store(s.to, s.e); return;
        case "if": {
          const ends = [];
          for (const arm of s.arms) {
            tmp = lay.size;
            cond(arm.c); const nx = jmp(OP.JMPCN); pop();
            stmts(arm.body);
            if (arm !== s.arms[s.arms.length - 1] || s.els) ends.push(jmp(OP.JMP));
            fix(nx, out.length);
          }
          if (s.els) stmts(s.els);
          for (const e of ends) fix(e, out.length);
          return;
        }
        case "case": {
          const T = typeOf(s.e);
          if (T === "BOOL" || T === 5) err("CASE: su un numero intero", s.e.pos);
          const CT = T == null ? 3 : T;
          const sel = s.e.k === "ref" && !s.e.r.index ? numOd(s.e, CT) : (() => { const t = tAlloc(CT); const b = [t.od, t.off & 0xFF, t.off >> 8]; numInto(s.e, CT, b); return b; })();
          const keep = tmp, ends = [], save = lay.size;
          lay.size = keep;                                // il selettore resta valido dentro i rami
          const sw = block.language === "C" ? { brk: [], cont: null } : null;   // C: break inside a case leaves the switch
          if (sw) loops.push(sw);
          for (const arm of s.arms) {
            tmp = keep;
            arm.labels.forEach((l, i) => {
              if (l.lo === l.hi) { out.push(OP.CMP, 0, CT, CMP_CODE["=="], ...sel, ...k32(CT, l.lo, s.pos)); push(); }
              else { out.push(OP.CMP, 0, CT, CMP_CODE[">="], ...sel, ...k32(CT, l.lo, s.pos)); push();
                     out.push(OP.CMP, 1, CT, CMP_CODE["<="], ...sel, ...k32(CT, l.hi, s.pos)); }
              if (i) { out.push(OP.ORB); pop(); }
            });
            const nx = jmp(OP.JMPCN); pop();
            stmts(arm.body);
            ends.push(jmp(OP.JMP));
            fix(nx, out.length);
          }
          if (s.els) stmts(s.els);
          lay.size = save;
          if (sw) { loops.pop(); ends.push(...sw.brk); }
          for (const e of ends) fix(e, out.length);
          return;
        }
        case "for": {
          const v = operand(s.v);
          if (v.kind !== "num" || v.T === 5) err("FOR: la variabile del ciclo è un intero", s.v.pos);
          let by = 1;
          if (s.by) { if (s.by.k !== "num" || s.by.real || s.by.v === 0) err("FOR … BY: un numero intero diverso da 0", s.by.pos); by = s.by.v; }
          numInto(s.from, v.T, v.bytes);
          tmp = lay.size;
          const lim = s.to.k === "num" ? k32(v.T, s.to.v, s.to.pos) : (() => { const t = tAlloc(v.T); const b = [t.od, t.off & 0xFF, t.off >> 8]; numInto(s.to, v.T, b); return b; })();
          const keep = tmp;
          const top = out.length;
          out.push(OP.CMP, 0, v.T, CMP_CODE[by > 0 ? "<=" : ">="], ...v.bytes, ...lim); push();
          const ex = jmp(OP.JMPCN); pop();
          loops.push({ brk: [ex], cont: [] });
          const save = lay.size; lay.size = keep;          // il limite resta valido dentro il ciclo
          stmts(s.body);
          lay.size = save;
          const L = loops.pop();
          L.cont.forEach(c => fix(c, out.length));
          tmp = keep;
          // ENO of the step: 0 = past the range of the type (FOR #i := 32760 TO 32767): the loop is over, no wrap-around
          out.push(OP.LDC, 1); push(); out.push(by > 0 ? OP.ADD : OP.SUB, v.T, ...v.bytes, ...k32(v.T, Math.abs(by), s.pos), ...v.bytes);
          jmpTo(OP.JMPC, top); pop();
          L.brk.forEach(b => fix(b, out.length));
          return;
        }
        case "while": {
          const top = out.length;
          cond(s.c); const ex = jmp(OP.JMPCN); pop();
          loops.push({ brk: [ex], cont: [] });
          stmts(s.body);
          const L = loops.pop();
          L.cont.forEach(c => fix(c, top));
          jmpTo(OP.JMP, top);
          L.brk.forEach(b => fix(b, out.length));
          return;
        }
        case "repeat": {
          const top = out.length;
          loops.push({ brk: [], cont: [] });
          stmts(s.body);
          const L = loops.pop();
          L.cont.forEach(c => fix(c, out.length));
          tmp = lay.size;
          cond(s.c); jmpTo(OP.JMPCN, top); pop();
          L.brk.forEach(b => fix(b, out.length));
          return;
        }
        case "exit": if (!loops.length) err(block.language === "C" ? "break fuori da un ciclo o da uno switch" : "EXIT fuori da un ciclo", s.pos); loops[loops.length - 1].brk.push(jmp(OP.JMP)); return;
        case "continue": {                                // the innermost loop (a C switch has no continue)
          const L = loops.filter(l => l.cont).pop();
          if (!L) err(block.language === "C" ? "continue fuori da un ciclo" : "CONTINUE fuori da un ciclo", s.pos);
          L.cont.push(jmp(OP.JMP)); return;
        }
        case "return": out.push(OP.RET); return;
      }
      err(`istruzione non gestita: ${s.k}`, s.pos);
    }
    try { stmts(ast.stmts); } catch (e) { if (e.message !== "testo") throw e; }
    lay.size = Math.ceil(tmpMax / 4) * 4;                  // frame con le variabili di lavoro
    if (lay.size > EspIR.FRAME_MAX) ctx.errors.push(`${label}: dati locali ${lay.size} byte con le variabili di lavoro (max ${EspIR.FRAME_MAX})`);
  }
  const CMP_ALIAS = { "=": "==", "<>": "<>", "<": "<", ">": ">", "<=": "<=", ">=": ">=" };

  // opts.limits = { instrMax, callDepth, vmStack, ops: [codici], vm: "2.5" } dal PLC (facoltativo)
  async function compileIR(programIn, opts) {
    const L = (opts && opts.limits) || {};
    LIM = {
      instrMax:  Number.isFinite(L.instrMax) && L.instrMax >= 0 ? L.instrMax : LIM_DEF.instrMax,   // 0 = nessun limite
      callDepth: L.callDepth > 0 ? L.callDepth : LIM_DEF.callDepth,
      vmStack:   L.vmStack   > 0 ? L.vmStack   : LIM_DEF.vmStack,
      vm:        typeof L.vm === "string" ? L.vm : null,
    };
    AREA_N = (L.areas && typeof L.areas === "object") ? L.areas : {};
    const project = EspIR.migrate(JSON.parse(EspIR.toJSON(programIn)));
    // Fronti senza memoria (progetti importati): la prima libera dell'area E, in ordine di programma
    {
      const edges = [], used = new Set();
      EspIR.eachElement(project, it => { if ((it.type === "Contact" && it.edge) || it.type === "Trig") edges.push(it); });
      edges.forEach(e => { if (e.mem && e.mem.ns === "E") used.add(e.mem.idx); });
      let nx = 0;
      edges.forEach(e => { if (!e.mem) { while (used.has(nx)) nx++; e.mem = { ns: "E", idx: nx }; used.add(nx); } });
    }
    const ctx = { out: [], errors: [], warnings: [], coils: new Map(), timers: new Map(),
                  maxDepth: 0, tag: "", callSites: [], edgeMem: new Map(), ioUsed: new Set(), ifaces: new Map() };
    const fcs = new Map(project.blocks.filter(b => b.type === "fc").map(b => [b.number, b]));
    // v4.8: DB nell'area da 8 KB, dati locali di ogni FC (max 1 KB)
    DBL = EspIR.layoutDbs(project);
    // area dei DB, un DB, i ritentivi: dal PLC (P4: 2 MB, 32 KB, 64 KB) o come il firmware di sempre (8 KB)
    const dbArea = L.dbSize || EspIR.DB_SIZE, dbOne = Math.min(L.dbMax || dbArea, 0xFFFF), dbRet = L.retainDbMax || dbArea;
    const kb = n => n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} byte`;
    if (DBL.size > dbArea) ctx.errors.push(`DB: ${DBL.size} byte, oltre l'area dei DB (${kb(dbArea)})`);
    for (const l of DBL.dbs.values()) if (l.size > dbOne) ctx.errors.push(`DB${l.db.number} ${l.db.name || ""}: ${l.size} byte, al più ${kb(dbOne)} per un DB`);
    { const r = [...DBL.dbs.values()].filter(l => l.db.retain).reduce((a, l) => a + l.size, 0);
      if (r > dbRet) ctx.errors.push(`DB ritentivi: ${r} byte in tutto, al più ${kb(dbRet)}`); }
    // v5.2: SINT e strutture con tipi che il PLC non conosce
    if (LIM.vm && !(parseFloat(LIM.vm) >= 5.2)) {
      const sint = [...DBL.dbs.values()].some(l => [...l.vars.values()].some(v => v.type === "SINT")) ||
                   [...fcs.values()].some(f => [...EspIR.layoutIface(f).vars.values()].some(v => v.type === "SINT"));
      if (sint) ctx.errors.push(`tipo SINT: serve la VM 5.2 del PLC (adesso ${LIM.vm}) — aggiorna il firmware`);
    }
    for (const [n, l] of DBL.dbs) for (const v of l.vars.values()) if (v.struct && !EspIR.structFields(v.type)) ctx.errors.push(`DB${n}.${v.name}: la struttura ${v.type} non c'è più`);
    for (const f of fcs.values()) {
      const l = EspIR.layoutIface(f);
      ctx.ifaces.set(f.number, l);
      if (l.size > EspIR.FRAME_MAX) ctx.errors.push(`${EspIR.blockLabel(f)}: dati locali ${l.size} byte (max ${EspIR.FRAME_MAX})`);
    }
    const code = new Map();                     // block id → { out, maxDepth, sites }
    let mainRungs = 0, totalNets = 0;
    // v5.1: FC in testo per prime: le loro variabili di lavoro ingrandiscono i dati locali (FRAME di chi le chiama)
    for (const block of project.blocks) {
      if (block.type !== "fc" || !EspIR.TEXT_LANGS.includes(block.language)) continue;
      ctx.out = []; ctx.maxDepth = 0; ctx.callSites = []; ctx.tag = EspIR.blockLabel(block);
      CUR = ctx.ifaces.get(block.number);
      compileText(block, ctx, CUR);
      ctx.out.push(OP.RET);
      totalNets++;
      code.set(block.id, { out: ctx.out, maxDepth: ctx.maxDepth, sites: ctx.callSites, block, nets: [0] });
    }

    for (const block of project.blocks) {
      if (code.has(block.id)) continue;
      ctx.out = []; ctx.maxDepth = 0; ctx.callSites = [];
      CUR = block.type === "fc" ? ctx.ifaces.get(block.number) : null;
      const label = EspIR.blockLabel(block);
      const nets = [];                            // offset d'inizio di ogni network (diagnostica: offset → network)
      block.segments.forEach((seg, n) => {
        nets.push(ctx.out.length);
        totalNets++;
        seg.rungs.forEach((r, i) => {
          ctx.tag = seg.rungs.length > 1 ? `${label} network ${n + 1} riga ${i + 1}` : `${label} network ${n + 1}`;
          ctx.overflow = false;
          if (block.type === "main") mainRungs++;
          // elementi messi senza indirizzo (alone giallo nell'editor): niente Download finché non sono configurati
          let un = 0;
          EspIR.eachElement({ blocks: [{ type: "main", segments: [{ rungs: [r] }] }] }, it => { if (it.unset) un++; });
          if (un) ctx.errors.push(un === 1 ? `${ctx.tag}: 1 elemento da configurare (alone giallo: clic per configurarlo)`
                                           : `${ctx.tag}: ${un} elementi da configurare (alone giallo: clic per configurarli)`);
          let slot = false, open = 0;                              // segnaposto «?» o ramo aperto: niente codice
          EspIR.eachElement({ blocks: [{ type: "main", segments: [{ rungs: [r] }] }] }, it => { if (it.type === "Slot" || it.kind === "SLOT") slot = true; if (it.type === "Open") open++; });
          if (open) { ctx.errors.push(`${ctx.tag}: ramo parallelo aperto: chiudilo (trascina la freccia sulla linea) o finiscilo con una bobina`); slot = true; }
          if (!slot) compileRung(r, ctx);
        });
      });
      ctx.out.push(block.type === "fc" ? OP.RET : OP.END);          // Main e StartUp finiscono con END
      code.set(block.id, { out: ctx.out, maxDepth: ctx.maxDepth, sites: ctx.callSites, block, nets });
    }
    if (!mainRungs) ctx.errors.push("programma vuoto: il Main non ha network");

    // chiamate: funzione esistente, niente ricorsione, stack sommato
    for (const { sites } of code.values())
      for (const s of sites) if (!fcs.has(s.fc)) ctx.errors.push(`${s.tag}: la funzione FC${s.fc} non esiste`);
    const eff = new Map(), visiting = new Set();
    function effDepth(id, path) {
      if (eff.has(id)) return eff.get(id);
      if (visiting.has(id)) { ctx.errors.push(`ricorsione: ${path.join(" → ")} — una funzione non può richiamare se stessa`); return 0; }
      visiting.add(id);
      const cb = code.get(id);
      let d = cb.maxDepth;
      for (const s of cb.sites) {
        const f = fcs.get(s.fc);
        if (f) d = Math.max(d, s.depth + effDepth(f.id, path.concat(EspIR.blockLabel(f))));
      }
      visiting.delete(id);
      eff.set(id, d);
      return d;
    }
    const callLevels = new Map();
    function callDepth(id, lvl, seen) {
      if (seen.has(id)) return 0;
      let m = lvl;
      for (const s of code.get(id).sites) { const f = fcs.get(s.fc); if (f) m = Math.max(m, callDepth(f.id, lvl + 1, new Set([...seen, id]))); }
      return m;
    }
    for (const [id, cb] of code) effDepth(id, [EspIR.blockLabel(cb.block)]);
    if (!ctx.errors.length) {
      for (const root of ["main", "startup"]) {                   // StartUp: stessi limiti del Main
        if (!code.has(root)) continue;
        const nm = root === "main" ? "" : " (StartUp)";
        if ((eff.get(root) || 0) > LIM.vmStack) ctx.errors.push(`stack VM insufficiente${nm}: servono ${eff.get(root)} livelli (max ${LIM.vmStack}), troppi rami annidati lungo le chiamate`);
        const lv = callDepth(root, 0, new Set());
        if (lv > LIM.callDepth) ctx.errors.push(`troppe chiamate annidate${nm}: ${lv} (max ${LIM.callDepth})`);
        // v4.8: dati locali lungo la catena di chiamate più pesante
        const lsUse = (id, seen) => {
          if (seen.has(id)) return 0;
          const cb = code.get(id), own = cb.block.type === "fc" ? ctx.ifaces.get(cb.block.number).size : 0;
          let m = 0;
          for (const s of cb.sites) { const f = fcs.get(s.fc); if (f) m = Math.max(m, lsUse(f.id, new Set([...seen, id]))); }
          return own + m;
        };
        const ls = lsUse(root, new Set());
        if (ls > EspIR.LS_SIZE) ctx.errors.push(`dati locali delle FC${nm}: ${ls} byte lungo le chiamate, oltre lo stack L (${EspIR.LS_SIZE} byte)`);
      }
    }

    for (const [k, where] of ctx.coils)
      if (where.length > 1) ctx.warnings.push(`bobina ${k} scritta ${where.length} volte (${where.join(", ")})`);
    // I/O oltre quelli collegati nelle impostazioni del PLC (se il PLC li dichiara)
    if (Number.isInteger(L.ioIn) || Number.isInteger(L.ioOut)) {
      const miss = [...ctx.ioUsed].filter(k => { const n = +k.slice(1); return k[0] === "I" ? (Number.isInteger(L.ioIn) && n >= L.ioIn) : (Number.isInteger(L.ioOut) && n >= L.ioOut); });
      if (miss.length) ctx.warnings.push(`${miss.join(", ")}: non collegati a nessun GPIO (il PLC ha ${L.ioIn} ingressi e ${L.ioOut} uscite — impostazioni del PLC)`);
    }
    for (const [k, where] of ctx.edgeMem)
      if (where.length > 1) ctx.warnings.push(`⚠ memoria del fronte ${k} usata ${where.length} volte (${where.join(", ")}): i fronti si disturbano`);
    for (const [k, where] of ctx.timers) {
      const kinds = ctx.timerKinds && ctx.timerKinds.get(k);
      if (kinds && kinds.size > 1)
        ctx.warnings.push(`⚠ timer ${k} usato come ${[...kinds].join(" e ")} (${where.join(", ")}): lo stesso timer con tipi diversi dà un comportamento imprevedibile`);
      else if (where.length > 1)
        ctx.warnings.push(`timer ${k} usato ${where.length} volte (${where.join(", ")}): condividono lo stesso stato`);
    }
    // Istruzioni per scansione nel caso peggiore (tutte le chiamate attive):
    // il firmware va in fault oltre PLC_MAX_INSTRUCTIONS_PER_SCAN (default 10000).
    const nInstr = out => { let n = 0; for (let i = 0; i < out.length; i += (opLenAt(out, i) || 1)) n++; return n; };
    const worst = new Map();
    function worstInstr(id, seen) {
      if (worst.has(id)) return worst.get(id);
      if (seen.has(id)) return 0;
      const cb = code.get(id);
      let n = nInstr(cb.out);
      for (const st of cb.sites) { const f = fcs.get(st.fc); if (f) n += worstInstr(f.id, new Set([...seen, id])); }
      worst.set(id, n);
      return n;
    }
    const instrWorst = ctx.errors.length ? 0 : Math.max(worstInstr("main", new Set()), code.has("startup") ? worstInstr("startup", new Set()) : 0);
    if (!LIM.instrMax) {}                              // firmware senza limite di istruzioni: conta il tempo del ciclo
    else if (instrWorst > LIM.instrMax)
      ctx.warnings.push(`⚠ fino a ${instrWorst} istruzioni per scansione con tutte le funzioni chiamate: oltre il limite del firmware (${LIM.instrMax}) il PLC va in fault`);
    else if (instrWorst > LIM.instrMax * 0.8)
      ctx.warnings.push(`fino a ${instrWorst} istruzioni per scansione: vicino al limite del firmware (${LIM.instrMax})`);
    // Istruzioni che il firmware del PLC non conosce → errore qui, non fault sul PLC
    if (!ctx.errors.length && Array.isArray(L.ops) && L.ops.length) {
      const known = new Set(L.ops), names = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k])), miss = new Set();
      for (const cb of code.values()) for (let i = 0; i < cb.out.length; i += (opLenAt(cb.out, i) || 1)) if (!known.has(cb.out[i])) miss.add(cb.out[i]);
      if (miss.size) ctx.errors.push(`il firmware del PLC${L.vm ? " (VM " + L.vm + ")" : ""} non conosce: ${[...miss].map(o => names[o] || "0x" + o.toString(16)).join(", ")} — aggiorna il firmware`);
    }
    // StartUp gira una volta sola: un timer lì non arriva mai a fine tempo
    {
      const su = project.blocks.find(b => b.type === "startup"), tm = new Set();
      if (su) EspIR.eachElement({ blocks: [su] }, (it, w) => {
        if (it.type === "Timer" || (w.coil && /^(TON|TOF|TP)$/.test(it.kind || ""))) tm.add((it.op ? "T" + it.op.idx : "timer") + " " + (it.kind || ""));
      });
      if (tm.size) ctx.warnings.push(`StartUp: ${[...tm].join(", ")} — StartUp gira una volta sola (all'avvio e a ogni STOP→RUN): il timer non arriva mai a fine tempo. Mettilo nel Main.`);
    }
    const called = new Set(); for (const { sites } of code.values()) sites.forEach(s => called.add(s.fc));
    for (const f of fcs.values()) if (!called.has(f.number)) ctx.warnings.push(`${EspIR.blockLabel(f)} non è chiamata da nessuna parte`);
    if ((project.modules || []).some(m => m.type === "pplc") && project.blocks.some(b => b.type === "fc"))
      ctx.errors.push("picoPlc: niente FC (solo contatti, bobine, confronti, matematica e timer)");
    if (ctx.errors.length) return { bytecode: null, errors: ctx.errors, warnings: ctx.warnings };

    // Blocchi grandi a pezzi (Denys 24-10-2026): un blocco più grande di PART_MAX resta coi primi network, gli altri vanno
    // in pezzi (FC nascoste, numero 0x8000 | proprietario << 4 | k: Main 0, StartUp 1024, FC il suo numero) chiamati in
    // fila con CALLP: stessi dati locali e stesso ENO, RET esce dal blocco intero. Ogni pezzo sta dove c'è posto (RAM o
    // IRAM), mai un pezzo di RAM grande come il blocco. Il taglio è fra un network e l'altro (lo stack è vuoto)
    const PART_MAX = 4096, partBlocks = [];
    let splitAny = false;
    for (const [id, cb] of [...code]) {
      const out = cb.out;
      if (out.length <= PART_MAX) continue;
      const owner = cb.block.type === "main" ? 0 : cb.block.type === "startup" ? 1024 : cb.block.number;
      const term = out[out.length - 1], body = out.slice(0, out.length - 1);
      const st = cb.nets.concat([body.length]), N = cb.nets.length, groups = [];
      let s = 0;
      for (let i = 0; i < N; i++) {
        const lim = groups.length ? PART_MAX : PART_MAX - 3 * 16 - 1;   // il primo gruppo resta nel blocco con le CALLP
        if (i > s && st[i + 1] - st[s] > lim) { groups.push([s, i]); s = i; }
      }
      groups.push([s, N]);
      if (groups.length < 2) continue;
      if (groups.length > 16) { ctx.errors.push(`${EspIR.blockLabel(cb.block)}: troppo grande (${out.length} byte, al massimo 16 pezzi da ${PART_MAX})`); continue; }
      splitAny = true;
      const head = body.slice(st[groups[0][0]], st[groups[0][1]]);
      groups.slice(1).forEach(([a, b], j) => {
        const num = 0x8000 | (owner << 4) | (j + 1);
        head.push(OP.CALLP, num & 0xFF, num >> 8);
        const nets = [];
        for (let i = 0; i < a; i++) nets.push(-1);                    // diagnostica: indice del network nel blocco intero
        for (let i = a; i < b; i++) nets.push(st[i] - st[a]);
        code.set("part:" + num, { out: body.slice(st[a], st[b]), maxDepth: cb.maxDepth, sites: [], nets,
                                  block: { id: "part:" + num, type: "part", number: num, owner: cb.block } });
        partBlocks.push({ id: "part:" + num, type: "part", number: num, owner: cb.block });
      });
      head.push(term);
      cb.out = head;
      cb.nets = cb.nets.slice(0, groups[0][1]);
    }
    if (splitAny) for (const root of ["main", "startup"]) {          // un pezzo è una chiamata in più nella catena
      if (!code.has(root)) continue;
      const lv = callDepth(root, 0, new Set()) + 1;
      if (lv > LIM.callDepth) ctx.errors.push(`troppe chiamate annidate${root === "main" ? "" : " (StartUp)"}: ${lv} con i pezzi dei blocchi grandi (max ${LIM.callDepth})`);
    }
    if (ctx.errors.length) return { bytecode: null, errors: ctx.errors, warnings: ctx.warnings };

    // v3: Main, poi le FC in ordine di numero (migrate le ordina); ogni blocco col suo CRC
    const order = [project.blocks.find(b => b.type === "main"),
                   ...project.blocks.filter(b => b.type === "startup"),         // StartUp subito dopo il Main (tipo 2)
                   ...project.blocks.filter(b => b.type === "fc").sort((a, b) => a.number - b.number),
                   ...partBlocks.sort((a, b) => a.number - b.number)];      // pezzi dei blocchi grandi: numeri da 0x8000
    const { blocks: _omit, ...head } = project;
    const projSrc = await gzipBytes(JSON.stringify(head));
    const blocks = [];
    const enc = new TextEncoder();
    // v4.8: modulo 1 «esposizione dati» dopo i DB: { u8 2, u8 flag (bit0 accesso disattivato), u16 n, u32 versione, n × { u8 verso, u8 tipo, u8 area, u8 bit, u16 indice, u8 lung, nome } }
    const xchg = { tx: [], rx: [] };
    let modBlk = null;
    const dm = (project.modules || []).find(m => m.type === "data");
    const docs = [];
    if (dm && dm.editing) ctx.errors.push("Esposizione dati in modifica: «✓ Conferma» o «Annulla» prima del Compile");
    else if (dm && !dm.stamp && ((dm.tx || []).length || (dm.rx || []).length)) ctx.errors.push("Esposizione dati: tabelle mai confermate (✎ Modifica e poi ✓ Conferma)");
    else if (dm) {
      const ents = [];
      for (const dir of ["tx", "rx"]) {
        const seen = new Set();
        for (const r of dm[dir] || []) {
          const tag = `Esposizione dati ${dir.toUpperCase()} «${r.name}»`;
          if (!EspIR.DATA_NAME_RE.test(r.name)) { ctx.errors.push(`${tag}: nome non valido (lettere, cifre, _ . -, max 32)`); continue; }
          if (seen.has(r.name)) { ctx.errors.push(`${tag}: nome ripetuto`); continue; }
          seen.add(r.name);
          const o = r.op;
          let e = null;
          if (o && (o.ns === "I" || o.ns === "Q" || o.ns === "M") && o.bit == null && Number.isInteger(o.idx) && o.idx >= 0 && o.idx <= 1023)
            e = { type: 0, T: "BOOL", area: o.ns === "I" ? 0 : o.ns === "Q" ? 1 : 2, bit: 0, idx: o.idx };
          else if (o && o.ns === "DB") {
            const m = memVar(o);
            if (m && m.off > 0xFFFF) { ctx.errors.push(`${tag}: ${memKey(o)} oltre i primi 64 KB dei DB (si espongono solo quelli)`); continue; }
            if (m) e = m.type === "BOOL" ? { type: 0, T: "BOOL", area: 3, bit: m.bit, idx: m.off } : { type: EspIR.TYPE_T[m.type], T: m.type, area: 3, bit: 0, idx: m.off };
          }
          if (!e) { ctx.errors.push(`${tag}: operando non valido (I, Q, M o un campo di un DB)`); continue; }
          if (dir === "rx" && (e.area === 0 || e.area === 1)) { ctx.errors.push(`${tag}: da fuori si scrivono solo M e campi dei DB`); continue; }
          const nb = new TextEncoder().encode(r.name);
          ents.push([dir === "tx" ? 0 : 1, e.type, e.area, e.bit, e.idx & 0xFF, e.idx >> 8, nb.length, ...nb]);
          xchg[dir].push({ name: r.name, type: e.T, comment: r.comment || "" });
        }
      }
      if (ents.length) {
        // versione 2: data della conferma (secondi dal 1970); tx.json e rx.json nel sorgente (solo flash, testo)
        const st = Math.floor(Date.parse(dm.stamp || 0) / 1000) >>> 0;
        const u8 = new Uint8Array([2, dm.off ? 1 : 0, ents.length & 0xFF, ents.length >> 8, st & 0xFF, (st >> 8) & 0xFF, (st >> 16) & 0xFF, st >>> 24, ...ents.flat()]);
        modBlk = { id: "mod1", type: "mod", number: 1, _mod: u8 };
        const RANGE = { BOOL: [false, true], BYTE: [0, 255], WORD: [0, 65535], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], UDINT: [0, 4294967295], REAL: [-3.4e38, 3.4e38] };
        ["tx", "rx"].forEach((dir, n) => {
          const doc = { format: "espplc-data", version: 1, dir: "plc" + dir, project: project.name || "", confirmed: dm.stamp || "", stamp: st,
                        method: dir === "tx" ? "GET" : "POST", path: "/api/data/exposure",
                        fields: xchg[dir].map(f => Object.assign({ name: f.name, type: f.type, range: RANGE[f.type] }, f.comment ? { comment: f.comment } : {})) };
          docs.push({ type: 0xFE, number: n, data: new TextEncoder().encode(JSON.stringify(doc, null, 1)) });
        });
      }
    }
    // Dati HMI (modulo 2): { u8 2, u8 flag (bit0 accesso disattivato), u16 n, u32 versione, u16 tempo di aggiornamento (ms), u32 versione, n × { u8 flag, u8 tipo, u8 area, u8 bit, u16 indice, [f32 min, f32 max] } }
    // e il file di configurazione del pannello (config.bin, sorgente 0xFE numero 2)
    let hmiBlk = null;
    const hm = (project.modules || []).find(m => m.type === "hmi");
    if (hm && hm.editing) ctx.errors.push("Dati HMI in modifica: «✓ Conferma» o «Annulla» prima del Compile");
    else if (hm && !hm.stamp && (hm.rows || []).length) ctx.errors.push("Dati HMI: tabella mai confermata (✎ Modifica e poi ✓ Conferma)");
    else if (hm && (hm.rows || []).length) {
      const mod = [], cfg = [];
      const f32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; };
      hm.rows.forEach((r, i) => {
        const tag = `Dati HMI ${i} «${r.name}»`;
        const o = r.op;
        let e = null;
        if (o && (o.ns === "I" || o.ns === "Q" || o.ns === "M") && o.bit == null && Number.isInteger(o.idx) && o.idx >= 0 && o.idx <= 1023)
          e = { type: 0, area: o.ns === "I" ? 0 : o.ns === "Q" ? 1 : 2, bit: 0, idx: o.idx };
        else if (o && o.ns === "DB") {
          const m = memVar(o);
          if (m && m.off > 0xFFFF) { ctx.errors.push(`${tag}: ${memKey(o)} oltre i primi 64 KB dei DB`); return; }
          if (m) e = m.type === "BOOL" ? { type: 0, area: 3, bit: m.bit, idx: m.off } : { type: EspIR.TYPE_T[m.type], area: 3, bit: 0, idx: m.off };
        }
        if (!r.name.trim()) { ctx.errors.push(`${tag}: nome vuoto`); return; }
        if (!e) { ctx.errors.push(`${tag}: operando non valido (I, Q, M o un campo di un DB)`); return; }
        if (r.w && e.area < 2) { ctx.errors.push(`${tag}: si scrivono solo M e campi dei DB`); return; }
        const lim = r.min !== undefined && r.max !== undefined;
        if (lim && r.min > r.max) { ctx.errors.push(`${tag}: minimo più grande del massimo`); return; }
        const fl = (r.w ? 1 : 0) | (lim ? 2 : 0);
        mod.push(fl, e.type, e.area, e.bit, e.idx & 0xFF, e.idx >> 8, ...(r.w && lim ? f32(r.min) : []), ...(r.w && lim ? f32(r.max) : []));
        const nb = enc.encode(r.name).slice(0, 40), ub = enc.encode(r.unit || "").slice(0, 12);
        cfg.push(e.type, e.area, e.bit, fl, e.idx & 0xFF, e.idx >> 8, ...f32(lim ? r.min : 0), ...f32(lim ? r.max : 0), r.dec || 0,
                 nb.length, ...nb, ub.length, ...ub);
      });
      if (!ctx.errors.length) {
        const n = hm.rows.length, st = Math.floor(Date.parse(hm.stamp || 0) / 1000) >>> 0;
        const le32 = v => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, v >>> 24];
        const per = Math.min(1000, Math.max(250, hm.period || 500));
        hmiBlk = { id: "mod2", type: "mod", number: 2, _mod: new Uint8Array([2, hm.off ? 1 : 0, n & 0xFF, n >> 8, ...le32(st), per & 0xFF, per >> 8, ...mod]) };
        const body = new Uint8Array(cfg), c = crc32(body) >>> 0;
        docs.push({ type: 0xFE, number: 2, data: new Uint8Array([0x48, 0x4D, 0x49, 0x31, 1, 0, n & 0xFF, n >> 8, ...le32(st), ...le32(c), per & 0xFF, per >> 8, 0, 0, ...body]) });
      }
    }
    // Tabelle I/O (modulo 3, io_hw.cpp), versione 2: un descrittore per dispositivo, i punti a blocchi nella sua DB.
    //   { u8 2, u8 flag (bit0 spente), u16 dispositivi, u32 versione, per dispositivo:
    //     { u8 tipo (0 scheda del PLC, 1 modulo uLink), u8 lunghezza, nome del modulo, u16 offset dei blocchi bit in, bit out,
    //       real in, real out (nell'area dei DB), u8 quanti bit in, bit out, real in, real out, u8 se manca (0 zero, 1 ultimo
    //       valore, 2 zero ed errore SF), uscite usate dalle tabelle (bit out: (n+7)/8 byte, real out: (n+7)/8 byte; le altre
    //       restano al programma, es. Q64+ dei moduli), u8 opzioni, opzioni: { u8 blocco (0 bi, 1 bo, 2 ri, 3 ro), u8 indice, u8 flag (bit0
    //       invertito, bit1-2 segnale), u8 media, u16 filtro ms, solo real: f32 grezzo min, max, ingegneria min, max } } }
    //   Nomi e id dei punti restano qui nel progetto: nel PLC solo indirizzi (in RAM pochi byte per dispositivo).
    let ioBlk = null;
    const iom = (project.modules || []).find(m => m.type === "io");
    const ioRows = iom ? EspIR.IO_LISTS.reduce((t, k) => t + (iom[k] || []).length, 0) : 0;
    if (iom && iom.editing) ctx.errors.push("Tabelle I/O in modifica: «✓ Conferma» o «Annulla» prima del Compile");
    else if (iom && !iom.stamp && ioRows) ctx.errors.push("Tabelle I/O: mai confermate (✎ Modifica e poi ✓ Conferma)");
    else if (iom && ioRows) {
      const f32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...b]; };
      const u16 = v => [v & 0xFF, (v >> 8) & 0xFF];
      const enc = new TextEncoder(), devs = new Map();
      for (const k of EspIR.IO_LISTS) for (const r of iom[k] || []) {
        const dev = r.dev || "";
        if (!devs.has(dev)) devs.set(dev, []);
        devs.get(dev).push({ k, r });
      }
      const out = [];
      for (const [dev, rows] of devs) {
        const num = dev ? (iom.devdb || {})[dev] : EspIR.HWDB_NUMBER, L = DBL.dbs.get(num), db = dev || "HWDB";
        const nores = rows.find(x => !x.r.res);
        if (nores) { ctx.errors.push(`Tabelle I/O «${nores.r.name}»: scegli il punto della scheda`); continue; }
        if (L && !L.blk && rows.some(({ k, r }) => !L.db.fields.some(f => f.name === r.name && f.type === (k[0] === "r" ? "REAL" : "BOOL")))) {
          const x = rows.find(({ k, r }) => !L.db.fields.some(f => f.name === r.name && f.type === (k[0] === "r" ? "REAL" : "BOOL")));
          ctx.errors.push(`Tabelle I/O «${x.r.name}»: manca nella DB ${db} (apri le tabelle I/O e conferma)`); continue;
        }
        if (!L) { ctx.errors.push(`Tabelle I/O, ${db}: manca la DB del dispositivo (apri le tabelle I/O e conferma)`); continue; }
        if (!L.blk) { ctx.errors.push(`Tabelle I/O, ${db}: punti senza posizione (apri le tabelle I/O, «Leggi i punti» e conferma)`); continue; }
        const b = L.blk, opts = [], ubo = new Array((b.nbo + 7) >> 3).fill(0), uro = new Array((b.nro + 7) >> 3).fill(0);
        let fail = 0;
        for (const { k, r } of rows) {
          const tag = `Tabelle I/O «${r.name}»`, v = L.vars.get(r.name);
          if (!v || v.v.type !== (k[0] === "r" ? "REAL" : "BOOL")) { ctx.errors.push(`${tag}: manca nella DB ${db} (apri le tabelle I/O e conferma)`); continue; }
          if (r.fail === "sf") fail = 2; else if (r.fail === "hold" && fail === 0) fail = 1;
          const real = k[0] === "r", kind = EspIR.IO_LISTS.indexOf(k);
          const idx = real ? (v.off - (k === "ri" ? b.ori : b.oro)) / 4 : (v.off - (k === "bi" ? b.obi : b.obo)) * 8 + v.bit;
          if (k === "bo") ubo[idx >> 3] |= 1 << (idx & 7); else if (k === "ro") uro[idx >> 3] |= 1 << (idx & 7);
          const mode = Math.max(0, EspIR.IO_MODES.indexOf(r.mode || "") + 1);
          const raw = r.raw || [0, 0], eng = r.eng || [0, 0];
          const scaled = real && raw[0] !== raw[1] && eng[0] !== eng[1] && !(raw[0] === eng[0] && raw[1] === eng[1]);
          if (!(r.inv || r.filt || mode || (r.avg || 0) > 1 || scaled)) continue;      // punto senza opzioni: solo il blocco
          opts.push(kind, idx, (r.inv ? 1 : 0) | (mode << 1), r.avg || 0, ...u16(r.filt || 0));
          if (real) opts.push(...f32(scaled ? raw[0] : 0), ...f32(scaled ? raw[1] : 0), ...f32(scaled ? eng[0] : 0), ...f32(scaled ? eng[1] : 0));
        }
        const nm = enc.encode(dev).slice(0, 16), base = L.base;
        let cnt = 0; for (let p = 0; p < opts.length; ) { cnt++; p += 6 + (opts[p] >= 2 ? 16 : 0); }
        if (cnt > 255) { ctx.errors.push(`Tabelle I/O, ${db}: troppi punti con opzioni (al massimo 255)`); continue; }
        out.push(dev ? 1 : 0, nm.length, ...nm, ...u16(base + b.obi), ...u16(base + b.obo), ...u16(base + b.ori), ...u16(base + b.oro),
                 b.nbi, b.nbo, b.nri, b.nro, fail, ...ubo, ...uro, cnt, ...opts);
      }
      if (!ctx.errors.length) {
        const st = Math.floor(Date.parse(iom.stamp || 0) / 1000) >>> 0;
        // versione 3: dopo la data l'impronta della scheda (10 caratteri): sul PLC di un'altra scheda le tabelle non valgono
        const hw = typeof iom.hw === "string" && /^[0-9A-F]{1,10}$/.test(iom.hw) ? [...iom.hw.padEnd(10, "\0")].map(c => c.charCodeAt(0)) : null;
        ioBlk = { id: "mod3", type: "mod", number: 3, _mod: new Uint8Array([hw ? 3 : 2, iom.off ? 1 : 0, ...u16(devs.size), st & 0xFF, (st >> 8) & 0xFF, (st >> 16) & 0xFF, st >>> 24,
                                                                          ...(hw || []), ...out]) };
      }
    }
    // Modbus (modulo 5, firmware uplc_modbus): { u8 2, u8 flag (bit0 spento), u16 nreti, u16 nrichieste, u16 nmappe,
    //   u16 offset degli stati, reti × 20, richieste × 32, mappe × 12 } — i dati nella DB «Modbus» (EspIR.modbusSync).
    //   Bit di un campo: u16 offset + u8 bit; versione 2 (01-11-2026): comandi dal programma (_on, _addr, _qty, _req, _busy, _done, _err, _dr)
    let mbBlk = null;
    const mbm = (project.modules || []).find(m => m.type === "modbus");
    if (mbm && mbm.editing) ctx.errors.push("Modbus in modifica: «✓ Conferma» o «Annulla» prima del Compile");
    else if (mbm && ((mbm.reqs || []).length || (mbm.maps || []).length)) {
      const u16 = v => [v & 0xFF, (v >> 8) & 0xFF], nets = mbm.nets || [];
      const ip4 = t => { const a = String(t || "").split(".").map(Number); return a.length === 4 && a.every(x => Number.isInteger(x) && x >= 0 && x <= 255) ? a : null; };
      const fieldOff = f => { const v = memVar({ ns: "DB", db: EspIR.MODBUS_DB, f }); return v && v.off <= 0xFFFF ? v.off : null; };   // DB Modbus: nei primi 64 KB (layoutDbs)
      const bitAt = f => { const v = memVar({ ns: "DB", db: EspIR.MODBUS_DB, f: f.slice(0, 24) }); return v ? [...u16(v.off), v.bit || 0] : [0xFF, 0xFF, 0]; };
      const offAt = f => { const v = fieldOff(f.slice(0, 24)); return u16(v == null ? 0xFFFF : v); };
      const out = [];
      for (const n of nets) {
        const baud = n.baud || 9600;
        out.push(n.type === "rtu" ? 1 : 0, n.role === "slave" ? 1 : 0, 0, 0, 0, 0, ...u16(n.port || 502), n.id || 1, 0, ...u16(n.timeout || 500), ...u16(baud & 0xFFFF), ...u16(baud >>> 16),
                 ...bitAt(`${n.name}_on`), 0);
      }
      for (const r of mbm.reqs || []) {
        const tag = `Modbus «${r.name}»`, ip = ip4(r.ip), d = fieldOff(`${r.name}_0`.slice(0, 24));
        const ni = nets.findIndex(n => n.name === r.net);
        if (!EspIR.NAME_RE.test(r.name || "")) ctx.errors.push(`${tag}: nome come un campo di un DB`);
        else if (ni < 0 || nets[ni].role === "slave") ctx.errors.push(`${tag}: scegli una rete master`);
        else if (nets[ni].type !== "rtu" && !ip) ctx.errors.push(`${tag}: indirizzo IP del dispositivo non valido`);
        else if (!EspIR.MB_FC.includes(r.fc)) ctx.errors.push(`${tag}: funzione ${r.fc} non prevista (1 2 3 4 5 6 15 16)`);
        else if (!(r.qty >= 1 && r.qty <= (r.fc <= 2 || r.fc === 15 ? 1968 : 123))) ctx.errors.push(`${tag}: quantità fuori dai limiti Modbus`);
        else if (d == null) ctx.errors.push(`${tag}: manca nella DB Modbus (conferma la tabella Modbus)`);
        else out.push(ni, r.id || 1, r.fc, 0, ...(ip || [0, 0, 0, 0]), ...u16(r.addr || 0), ...u16(r.qty), ...u16(r.period ?? 100), ...u16(d),
                      ...offAt(`${r.name}_addr`), ...offAt(`${r.name}_qty`), ...bitAt(`${r.name}_req`), ...bitAt(`${r.name}_busy`), ...bitAt(`${r.name}_done`), ...bitAt(`${r.name}_err`));
      }
      for (const x of mbm.maps || []) {
        const tag = `Modbus slave «${x.name}»`, d = fieldOff(`${x.name}_0`.slice(0, 24)), ni = nets.findIndex(n => n.name === x.net);
        if (ni < 0 || nets[ni].role !== "slave") ctx.errors.push(`${tag}: scegli una rete slave`);
        else if (d == null) ctx.errors.push(`${tag}: manca nella DB Modbus (conferma la tabella Modbus)`);
        else out.push(ni, x.table, ...u16(x.start || 0), ...u16(x.qty || 1), ...u16(d), ...bitAt(`${x.name}_dr`), 0);
      }
      const r0 = (mbm.reqs || [])[0], stb = r0 ? fieldOff(`${r0.name}_esito`.slice(0, 24)) : 0xFFFF;
      if (!ctx.errors.length)
        mbBlk = { id: "mod5", type: "mod", number: 5, _mod: new Uint8Array([2, mbm.off ? 1 : 0, ...u16(nets.length), ...u16((mbm.reqs || []).length),
                                                                             ...u16((mbm.maps || []).length), ...u16(stb == null ? 0xFFFF : stb), ...out]) };
    }
    if (ctx.errors.length) return { bytecode: null, errors: ctx.errors, warnings: ctx.warnings };
    // v4.8: DB in fondo, in ordine di numero. Area oltre i 64 KB (P4): intestazione 2 con la base a 32 bit
    const far = DBL.size > 0x10000;
    for (const [num, l] of far ? [...DBL.dbs].sort((a, b) => a[0] - b[0]) : DBL.dbs) {
      const vars = [...l.vars.values()].filter(v => !v.struct), H = far ? 10 : 8;   // strutture: i loro campi
      const u8 = new Uint8Array(H + 8 * vars.length + l.size), dv = new DataView(u8.buffer);
      u8[0] = far ? 2 : 1; u8[1] = l.db.retain ? 1 : 0;
      if (far) { dv.setUint32(2, l.base, true); dv.setUint16(6, l.size, true); dv.setUint16(8, vars.length, true); }
      else { dv.setUint16(2, l.base, true); dv.setUint16(4, l.size, true); dv.setUint16(6, vars.length, true); }
      const init = H + 8 * vars.length;
      vars.forEach((v, k) => {
        const a = H + 8 * k;
        dv.setUint32(a, crc32(enc.encode(v.name)) >>> 0, true);
        u8[a + 4] = v.type === "BOOL" ? 0 : v.T; u8[a + 5] = v.bit || 0; dv.setUint16(a + 6, v.off, true);
        const x = EspIR.cleanVal(v.type, v.v.init);
        if (v.type === "BOOL") { if (x) u8[init + v.off] |= 1 << v.bit; }
        else for (let e = 0, w = EspIR.TYPE_W[v.type]; e < (v.arr ? v.arr.n : 1); e++) {   // array: ogni elemento con il valore iniziale
          const o = init + v.off + e * w;
          ({ 1: () => dv.setInt16(o, x, true), 2: () => dv.setUint16(o, x, true), 3: () => dv.setInt32(o, x, true),
             4: () => dv.setUint32(o, x, true), 5: () => dv.setFloat32(o, x, true), 6: () => dv.setUint8(o, x), 7: () => dv.setInt8(o, x) })[v.T]();
        }
      });
      order.push({ id: "db" + num, type: "db", number: num, _db: u8, _label: l.db.name });
    }
    if (modBlk) order.push(modBlk);                  // i moduli dopo i DB, in ordine di numero
    if (hmiBlk) order.push(hmiBlk);
    if (ioBlk) order.push(ioBlk);
    if (mbBlk) order.push(mbBlk);
    // picoPlc del modulo I/O (modulo 4, bus_slave.cpp): { u8 1, u8 flag (bit0 uscite spente nel passaggio), u16 ms senza PLC, u16 ms di ritorno }
    const ppm = (project.modules || []).find(m => m.type === "pplc");
    if (ppm) {
      const lost = Math.max(100, Math.min(60000, ppm.lost | 0 || 1000)), back = Math.max(0, Math.min(60000, ppm.back == null ? 1000 : ppm.back | 0));
      order.push({ id: "mod4", type: "mod", number: 4, _mod: new Uint8Array([1, ppm.keep === false ? 1 : 0, lost & 0xFF, lost >> 8, back & 0xFF, back >> 8]) });
    }
    for (const b of order) {
      if (b.type === "mod") {
        blocks.push({ id: b.id, label: b.number === 2 ? "Dati HMI" : "Esposizione dati", type: 4, number: b.number, db: true,
                      size: b._mod.length, crc: crc32(b._mod) >>> 0, code: b._mod, src: null, scrc: 0, nets: [] });
        continue;
      }
      if (b.type === "db") {
        // struttura (come db_layout_crc nel firmware: dimensione, numero di campi, campi; non i valori iniziali)
        const nf = b._db[6] | b._db[7] << 8, lay = new Uint8Array(4 + 8 * nf);
        lay.set(b._db.subarray(4, 8), 0); lay.set(b._db.subarray(8, 8 + 8 * nf), 4);
        blocks.push({ id: b.id, label: "DB" + b.number + " " + b._label, type: 3, number: b.number, db: true,
                      size: b._db.length, crc: crc32(b._db) >>> 0, lcrc: crc32(lay) >>> 0, base: b._db[0] === 2 ? (b._db[2] | b._db[3] << 8 | b._db[4] << 16 | b._db[5] << 24) >>> 0 : b._db[2] | b._db[3] << 8, code: b._db, src: null, scrc: 0, nets: [] });
        continue;
      }
      const codeU8 = new Uint8Array(code.get(b.id).out);
      if (b.type === "part") {                     // pezzo: niente sorgente (sta nel blocco proprietario)
        blocks.push({ id: b.id, label: EspIR.blockLabel(b.owner) + " (pezzo " + (b.number & 15) + ")", type: 1, number: b.number,
                      size: codeU8.length, crc: crc32(codeU8) >>> 0, code: codeU8, src: null, scrc: 0, part: true, partOf: b.owner.id,
                      nets: code.get(b.id).nets });
        continue;
      }
      const src = await gzipBytes(JSON.stringify(b));
      blocks.push({ id: b.id, label: EspIR.blockLabel(b), type: b.type === "main" ? 0 : b.type === "startup" ? 2 : 1, number: b.type === "fc" ? b.number : 0,
                    size: codeU8.length, crc: crc32(codeU8) >>> 0, code: codeU8, src, scrc: crc32(src) >>> 0,
                    nets: code.get(b.id).nets });
    }
    const bytecode = buildSection(blocks.map(b => ({ type: b.type, number: b.number, data: b.code })));
    const source_gzip = buildSection([{ type: 0xFF, number: 0, data: projSrc },
                                      ...blocks.filter(b => !b.db && !b.part).map(b => ({ type: b.type, number: b.number, data: b.src })), ...docs]);
    return { bytecode, source_gzip, hex: toHex(bytecode), errors: [], warnings: ctx.warnings, xchg, docs,
             maxStack: eff.get("main") || 0, networks: totalNets, instrWorst,
             blocks, proj: { src: projSrc, scrc: crc32(projSrc) >>> 0 } };
  }

  // ── v3: sezioni a blocchi ─────────────────────────────
  // entries: [{ type, number, data: Uint8Array } | { type, number, keep: true, crc }]
  function buildSection(entries) {
    const n = entries.length, tab = 4 + 12 * n;
    const size = tab + entries.reduce((a, e) => a + (e.keep ? 0 : e.data.length), 0);
    const u8 = new Uint8Array(size), dv = new DataView(u8.buffer);
    dv.setUint16(0, n, true);
    let off = tab;
    entries.forEach((e, k) => {
      const at = 4 + 12 * k;
      u8[at] = e.type; u8[at + 1] = e.keep ? 1 : 0;
      dv.setUint16(at + 2, e.number, true);
      dv.setUint32(at + 4, e.keep ? 0 : e.data.length, true);
      dv.setUint32(at + 8, e.keep ? e.crc >>> 0 : crc32(e.data), true);
      if (!e.keep) { u8.set(e.data, off); off += e.data.length; }
    });
    return u8;
  }
  // → [{ type, flags, number, size, crc, data }]; lancia un errore se il formato non torna
  function parseSection(u8) {
    if (!u8 || u8.length < 4) throw new Error("sezione a blocchi troppo corta");
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint16(0, true), tab = 4 + 12 * n;
    if (tab > u8.length) throw new Error("tabella dei blocchi troncata");
    const out = [];
    let off = tab;
    for (let k = 0; k < n; k++) {
      const at = 4 + 12 * k;
      const e = { type: u8[at], flags: u8[at + 1], number: dv.getUint16(at + 2, true),
                  size: dv.getUint32(at + 4, true), crc: dv.getUint32(at + 8, true) };
      if (off + e.size > u8.length) throw new Error("blocco oltre la fine");
      e.data = u8.subarray(off, off + e.size);
      off += e.size;
      out.push(e);
    }
    if (off !== u8.length) throw new Error("byte in più dopo i blocchi");
    return out;
  }
  async function gunzipText(u8) {
    if (typeof DecompressionStream === "undefined") return null;
    const ds = new DecompressionStream("gzip");
    const w = ds.writable.getWriter(); w.write(u8); w.close();
    const reader = ds.readable.getReader();
    const chunks = []; let total = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
    const out = new Uint8Array(total);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return new TextDecoder().decode(out);
  }
  // Sezione sorgente v3 → progetto (oggetto JSON, non ancora migrato); null se illeggibile
  async function sourceToProject(u8) {
    try {
      const ents = parseSection(u8);
      let head = null; const blocks = [];
      for (const e of ents) {
        if (e.type === 0xFE) continue;                     // v4.8: tx.json / rx.json (testo, non fanno parte del progetto)
        const txt = await gunzipText(e.data);
        if (txt == null) return null;
        const j = JSON.parse(txt);
        if (e.type === 0xFF) head = j; else blocks.push(j);
      }
      if (!head) return null;
      return Object.assign({}, head, { blocks });
    } catch (e) { return null; }
  }
  // Blocchi del PLC (/api/plc/blocks) → mappa "main:0" / "fc:N" → { crc, scrc }
  const blkKey = (type, number) => (type === 0 || type === "main" ? "main:0" : type === 2 || type === "startup" ? "startup:0" : type === 3 || type === "db" ? "db:" + number : type === 4 || type === "mod" ? "mod:" + number : "fc:" + number);
  function plcBlockMap(pb) {
    const m = new Map();
    for (const b of (pb && pb.blocks) || []) m.set(blkKey(b.t, b.n), Object.assign({ crc: b.crc >>> 0, scrc: b.scrc >>> 0, size: b.size }, b.lcrc !== undefined ? { lcrc: b.lcrc >>> 0, base: b.base } : {}));
    return m;
  }
  // Patch 'PLCP' con i soli blocchi cambiati rispetto al PLC. null = niente da tenere (meglio il completo).
  function buildPatchBlob(r, pb) {
    if (!pb || !Array.isArray(pb.blocks) || !pb.blocks.length) return null;
    const m = plcBlockMap(pb), changed = [];
    let kept = 0;
    const bc = [], src = [];
    const projKeep = (pb.proj_scrc >>> 0) === r.proj.scrc;
    src.push(projKeep ? { type: 0xFF, number: 0, keep: true, crc: r.proj.scrc } : { type: 0xFF, number: 0, data: r.proj.src });
    for (const b of r.blocks) {
      const o = m.get(blkKey(b.type, b.number));
      const kc = !!o && o.crc === b.crc, ks = !!o && o.scrc === b.scrc && o.scrc !== 0;
      bc.push(kc ? { type: b.type, number: b.number, keep: true, crc: b.crc } : { type: b.type, number: b.number, data: b.code });
      if (b.db) { if (kc) kept++; else changed.push({ label: b.label, code: true, text: false }); continue; }
      // pezzo di un blocco grande: niente sorgente (sta nel blocco proprietario), come nel Download completo
      if (b.part) { if (kc) kept++; else changed.push({ label: b.label, code: true, text: false, size: b.size, type: b.type }); continue; }
      src.push(ks ? { type: b.type, number: b.number, keep: true, crc: b.scrc } : { type: b.type, number: b.number, data: b.src });
      if (kc) kept++;
      if (!kc || !ks) changed.push({ label: b.label, code: !kc, text: !ks, size: kc ? 0 : b.size, type: b.type });
    }
    for (const d of r.docs || []) src.push(d);            // v4.8: tx.json / rx.json, piccoli: sempre mandati
    const removed = [...m.keys()].filter(k => !r.blocks.some(b => blkKey(b.type, b.number) === k));
    // nessun blocco uguale e anche il progetto (nomi, elenco dei blocchi) diverso: è un altro programma → download completo.
    // Progetto uguale (es. solo il Main, cambiato): blocchi cambiati in RUN, timer e merker restano.
    if (!kept && !projKeep) return null;
    const blob = wireBlob(0x50434C50, buildSection(bc), buildSection(src), r.blocks.length);
    return { blob, changed, removed, projChanged: !projKeep };
  }

  function wireBlob(magic, bytecode, sourceGz, numBlocks) {
    const HEADER = 20;
    const u8 = new Uint8Array(HEADER + bytecode.length + sourceGz.length);
    const dv = new DataView(u8.buffer);
    dv.setUint32(0, magic, true);
    dv.setUint16(4, 3, true);                   // versione formato: v3 a blocchi
    dv.setUint16(6, numBlocks || 1, true);
    dv.setUint32(8, bytecode.length, true);
    dv.setUint32(12, sourceGz.length, true);
    u8.set(bytecode, HEADER);
    u8.set(sourceGz, HEADER + bytecode.length);
    dv.setUint32(16, crc32(u8), true);
    return u8;
  }
  function buildWireBlob(bytecode, sourceGz, numBlocks) {
    let n = numBlocks;
    try { n = new DataView(bytecode.buffer, bytecode.byteOffset).getUint16(0, true); } catch (e) {}
    return wireBlob(0x31434C50, bytecode, sourceGz, n);          // "PLC1"
  }

  window.buildPatchBlob = buildPatchBlob;
  window.EspBlocks = { buildSection, parseSection, sourceToProject, gunzipText, plcBlockMap, blkKey };
  window.compileIR = compileIR;
  window.buildWireBlob = buildWireBlob;
  window.crc32 = crc32;
  window.ESPPLC_OP = OP;
  window.ESPPLC_NUM = { NUM, T_NAME, T_RANGE, CMP_CODE, BOX_OPS, EDGE_BITS, opLenAt };

  // ── Tempo del timer: "500ms", "2s", "2.5s", "1m30s", "1h", "T#2s500ms", numero = ms ──
  function parsePT(txt) {
    let s = String(txt || "").trim().toLowerCase().replace(/^t#/, "").replace(/,/g, ".").replace(/_/g, "");
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const re = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g;
    let total = 0, used = 0, m;
    while ((m = re.exec(s))) { total += parseFloat(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]]; used += m[0].length; }
    if (used !== s.replace(/\s+/g, "").length && used !== s.length) return null;
    total = Math.round(total);
    return (total >= 0 && total <= PT_MAX) ? total : null;
  }
  function formatPT(ms) {
    if (ms == null) return "?";
    if (ms < 1000) return ms + "ms";
    if (ms < 60000) return (ms / 1000).toString().replace(/(\.\d{0,3})\d*$/, "$1") + "s";
    const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = (ms % 60000) / 1000;
    return (h ? h + "h" : "") + (m ? m + "m" : "") + (s ? (s % 1 ? s.toFixed(1) : s) + "s" : "");
  }
  window.parsePT = parsePT;
  window.formatPT = formatPT;
})();
