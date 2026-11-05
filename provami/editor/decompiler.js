// ============================================================
//  EspPlc — decompiler.js
//  Bytecode → IR v2 (ir.js), quando sul PLC non c'è il sorgente.
//
//  Simula lo stack con "punti del rung" invece che con valori:
//    ogni valore in cima allo stack sa a quale nodo di uscita appartiene.
//    DUP  = il nodo diventa punto di diramazione, nasce un ramo figlio
//    dopo il POP del figlio, le istruzioni successive vanno in un nuovo
//    ultimo ramo (così si ricostruiscono anche le diramazioni annidate).
//  Riconosce anche il bytecode vecchio (un LD per rung, senza POP).
//  Se trova qualcosa che l'editor non sa disegnare → { editable:false }.
// ============================================================
(function () {
  "use strict";

  const NS_NAME = { 0x01: "I", 0x02: "Q", 0x03: "M", 0x06: "T", 0x08: "SM" };
  const TIMER = { 0x50: "TON", 0x51: "TOF", 0x52: "TP" };
  const MAX_IDX = 255;
  const COIL = { 0x20: "coil", 0x21: "ncoil", 0x22: "set", 0x23: "reset" };
  const WBIT = { 0x10: ["MW", 16], 0x11: ["MI", 16], 0x12: ["MD", 32], 0x13: ["MDI", 32], 0x15: ["MB", 8] };   // v4.6: bit di parola
  // v3.1
  const OD_NS = { 0x10: "MW", 0x11: "MI", 0x12: "MD", 0x13: "MDI", 0x14: "MR", 0x15: "MB" };
  const CMP_TXT = ["==", "<>", "<", ">", "<=", ">="];
  const BOX = { 0x71: "MOVE", 0x72: "ADD", 0x73: "SUB", 0x74: "MUL", 0x75: "DIV", 0x76: "MOD", 0x77: "NEG", 0x78: "ABS", 0x79: "CONV",
                0x7A: "MATH", 0x7B: "MIN", 0x7C: "MAX", 0x7D: "LIMIT", 0x7E: "SCALE", 0x80: "AND", 0x81: "OR", 0x82: "XOR", 0x83: "INV",
                0x84: "SHL", 0x85: "SHR", 0x86: "ROL", 0x87: "ROR", 0x88: "SWAP",
                0x55: "CTU", 0x56: "CTD", 0x57: "CTUD" };                                       // v4.9 contatori
  // ingressi dei box (oltre a CONV, SCALE e MATH, che hanno la loro testata)
  const BOX_NIN = { 0x71: 1, 0x77: 1, 0x78: 1, 0x83: 1, 0x88: 1, 0x7D: 3 };   // gli altri: 2
  const EDGE_NS = { 0x07: "E", 0x03: "M" };
  const isBoxOp = op => !!BOX[op];
  const f32 = new DataView(new ArrayBuffer(4));

  // v3: sezione bytecode a blocchi = u16 n, u16 0, n voci {tipo, flag, numero, size, crc}, poi il codice
  function readTable(sec) {
    if (!sec || sec.length < 4) throw new Error("bytecode senza tabella dei blocchi");
    const n = sec[0] | (sec[1] << 8), tab = 4 + 12 * n;
    if (!n || tab > sec.length) throw new Error("tabella dei blocchi non valida");
    const out = []; let off = tab;
    for (let k = 0; k < n; k++) {
      const a = 4 + 12 * k;
      const size = (sec[a + 4] | (sec[a + 5] << 8) | (sec[a + 6] << 16) | (sec[a + 7] << 24)) >>> 0;
      if (off + size > sec.length) throw new Error("blocco oltre la fine");
      out.push({ type: sec[a], number: sec[a + 2] | (sec[a + 3] << 8), data: sec.subarray(off, off + size) });
      off += size;
    }
    if (out[0].type !== 0) throw new Error("il primo blocco non è il Main");
    return out;
  }

  function decompile(section) {
    const { series, contact, parallel } = EspIR;
    let bytes = null;
    let rungs = [];
    let stack = [];            // [{ root, node, branching }] | { pp: Parallel } (parallelo con corrente)
    let lastWasCoil = false;

    const fail = msg => { throw new Error(msg); };
    const top = () => stack.length ? stack[stack.length - 1] : fail("stack vuoto");
    const orWith = (a, b) => (a.items.length === 1 && a.items[0].type === "Parallel")
      ? (a.items[0].branches.push(b), a)
      : series([parallel([a, b])]);
    const plain = n => !n.coil && !n.outputs;
    const newValue = items => { const n = { series: series(items || []) }; return { root: n, node: n, branching: false }; };
    const valueTop = () => { const v = top(); if (v.pp) fail("valore atteso"); return v; };

    // Dopo una diramazione, le istruzioni successive (non DUP) vanno in un nuovo ultimo ramo.
    function descend(v) {
      if (!v.branching) return;
      const leaf = { series: series() };
      v.node.outputs.push(leaf);
      v.node = leaf; v.branching = false;
    }
    function finishRoot(v) {
      const r = v.root;
      if (!r.coil && !(r.outputs && r.outputs.length)) fail("network senza bobina");
      rungs.push(EspIR.tidyRung({ series: r.series,
        outputs: r.coil ? [{ series: series(), coil: r.coil }] : r.outputs }));
    }
    // bytecode vecchio: un LD subito dopo una bobina (senza POP) = nuovo rung
    function boundary() {
      if (lastWasCoil && stack.length === 1) finishRoot(stack.pop());
    }
    function operand(b, i) {
      const ns = NS_NAME[b[i]], idx = b[i + 1];
      if (!ns) fail(`area 0x${b[i].toString(16)} non supportata`);
      if (idx > MAX_IDX) fail("indice oltre 255");
      return { ns, idx };
    }
    // v4.6: operando a bit con indice a 16 bit (I/Q/M oltre 255, bit di parola, SM)
    function operand16(nsb, ix) {
      if (WBIT[nsb]) {
        const [ns, w] = WBIT[nsb], bit = ix & 31;
        if (bit >= w) fail("bit oltre la parola");
        return { ns, idx: ix >> 5, bit };
      }
      const ns = NS_NAME[nsb];
      if (!ns) fail(`area 0x${nsb.toString(16)} non supportata`);
      return { ns, idx: ix };
    }

    // v3.1: operando numerico in b[i] → { o, n (byte) }
    function od(b, i, T) {
      const a = b[i];
      if (a === 0x80) {
        if (i + 5 > b.length) fail("costante troncata");
        const raw = (b[i + 1] | (b[i + 2] << 8) | (b[i + 3] << 16) | (b[i + 4] << 24)) >>> 0;
        let k;
        if (T === 5) { f32.setUint32(0, raw, true); k = f32.getFloat32(0, true);
          // la scrittura decimale più corta che torna esattamente allo stesso float
          for (let pr = 1; pr <= 9; pr++) { const c = parseFloat(k.toPrecision(pr)); if (Math.fround(c) === k) { k = c; break; } } }
        else k = (T === 2 || T === 4 || T === 6) ? raw : (raw | 0);
        return { o: { k }, n: 5 };
      }
      if (!OD_NS[a] || i + 3 > b.length) fail("operando numerico non valido");
      return { o: { ns: OD_NS[a], idx: b[i + 1] | (b[i + 2] << 8) }, n: 3 };
    }
    const mem3 = (b, i) => { const ns = EDGE_NS[b[i]]; if (!ns) fail("memoria del fronte non valida"); return { ns, idx: b[i + 1] | (b[i + 2] << 8) }; };
    // contatto (anche fronte) o confronto nel modo LD / AND / OR
    function contactLike(item, mode, wasCoil) {
      if (mode === 0) {
        lastWasCoil = wasCoil; boundary(); lastWasCoil = false;
        stack.push(newValue([item]));
      } else if (mode === 1) {
        const v = valueTop(); descend(v);
        if (!plain(v.node)) fail("AND dopo una bobina");
        v.node.series.items.push(item);
      } else {
        const v = valueTop();
        if (v.pp || v.branching || !plain(v.node)) fail("OR dopo una diramazione");
        v.node.series = orWith(v.node.series, series([item]));
      }
    }

    // Legge un blocco da `i0` fino a END (Main) o RET (funzione)
    function parseBlock(i0, isMain) {
      rungs = []; stack = []; lastWasCoil = false;
      let i = i0;
      let prevOp = -1, curOp = -1, ended = false;
      while (i < bytes.length) {
        let op = bytes[i];
        prevOp = curOp; curOp = op;
        const wasCoil = lastWasCoil;
        lastWasCoil = false;
        if (op === 0x00) { i++; continue; }                        // NOP
        if (op === 0x01) {                                          // END (fine Main)
          if (!isMain) fail("END dentro una funzione");
          lastWasCoil = wasCoil; i++; ended = true; break;
        }
        if (op === 0x61) {                                          // RET (fine funzione)
          if (isMain) fail("RET nel Main");
          lastWasCoil = wasCoil; i++; ended = true; break;
        }
        if (op === 0x60) {                                          // CALL numero FC (v3)
          if (i + 3 > bytes.length) fail("CALL troncata");
          const target = bytes[i + 1] | (bytes[i + 2] << 8);
          i += 3;
          const v = valueTop(); descend(v);
          if (!plain(v.node)) fail("chiamata dopo una bobina");
          v.node.series.items.push({ type: "Call", _target: target });
          continue;
        }
        if (op === 0x53) {                                          // contatto con fronte P/N
          if (i + 8 > bytes.length) fail("fronte troncato");
          const mb = bytes[i + 1];
          if ((mb & 0x0F) > 2) fail("fronte non valido");
          const item = { type: "Contact", negated: false, op: operand16(bytes[i + 2], bytes[i + 3] | (bytes[i + 4] << 8)),
                         edge: (mb & 0x10) ? "N" : "P", mem: mem3(bytes, i + 5) };
          i += 8;
          contactLike(item, mb & 0x0F, wasCoil);
          continue;
        }
        if (op === 0x54) {                                          // P_TRIG / N_TRIG sulla corrente
          if (i + 5 > bytes.length) fail("fronte troncato");
          const item = { type: "Trig", edge: (bytes[i + 1] & 0x10) ? "N" : "P", mem: mem3(bytes, i + 2) };
          i += 5;
          const v = valueTop(); descend(v);
          if (!plain(v.node)) fail("fronte dopo una bobina");
          v.node.series.items.push(item);
          continue;
        }
        if (op === 0x70) {                                          // confronto
          const mode = bytes[i + 1], T = bytes[i + 2], c = bytes[i + 3];
          if (mode > 2 || !CMP_TXT[c]) fail("confronto non valido");
          const A = od(bytes, i + 4, T), B = od(bytes, i + 4 + A.n, T);
          i += 4 + A.n + B.n;
          contactLike({ type: "Compare", cmp: CMP_TXT[c], a: A.o, b: B.o }, mode, wasCoil);
          continue;
        }
        if (op === 0x1C) {                                          // v4.6 NOT
          i++;
          const v = valueTop(); descend(v);
          if (!plain(v.node)) fail("NOT dopo una bobina");
          v.node.series.items.push({ type: "Not" });
          continue;
        }
        if (op === 0x64) {                                          // v4.6 bobina RET
          i++;
          const v = stack.pop() || fail("RET su stack vuoto");
          if (v.pp) fail("RET inatteso");
          descend(v);
          if (v.node.coil || v.node.outputs) fail("RET inatteso");
          v.node.coil = { kind: "RET" };
          if (!stack.length) { if (!v.root) fail("RET inatteso"); finishRoot(v); }
          continue;
        }
        if (isBoxOp(op)) {                                          // box numerico (come una chiamata: ENO)
          const name = BOX[op];
          let item, p = i + 1;
          if (op >= 0x55 && op <= 0x57) {                           // v4.9 contatori: bit (ns 0 = nessuno), memorie, PV, CV
            const T = bytes[p++], names = op === 0x57 ? ["cd", "r", "ld"] : [op === 0x55 ? "r" : "ld"];
            item = { type: "Box", box: name };
            for (const f of names) { if (bytes[p]) item[f] = operand16(bytes[p], bytes[p + 1] | (bytes[p + 2] << 8)); p += 3; }
            item.mem = mem3(bytes, p); p += 3;
            if (op === 0x57) { item.memD = mem3(bytes, p); p += 3; }
            const A = od(bytes, p, T); p += A.n; const O = od(bytes, p, T); p += O.n;
            item.a = A.o; item.out = O.o;
          } else if (op === 0x7E) {                                 // SCALE
            const Ti = bytes[p], To = bytes[p + 1]; p += 2;
            const v = [];
            for (let k = 0; k < 6; k++) { const X = od(bytes, p, k < 3 ? Ti : To); v.push(X.o); p += X.n; }
            item = { type: "Box", box: "SCALE", a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], out: v[5] };
          } else if (op === 0x7A) {                                 // SQRT / SQR
            const T = bytes[p], fun = bytes[p + 1]; p += 2;
            if (fun > 1) fail("funzione matematica non supportata");
            const A = od(bytes, p, T); p += A.n; const O = od(bytes, p, T); p += O.n;
            item = { type: "Box", box: fun ? "SQR" : "SQRT", a: A.o, out: O.o };
          } else if (op >= 0x7B) {
            const T = bytes[p++], nin = BOX_NIN[op] || 2, f = ["a", "b", "c"];
            item = { type: "Box", box: name };
            for (let k = 0; k < nin; k++) { const X = od(bytes, p, T); item[f[k]] = X.o; p += X.n; }
            const O = od(bytes, p, T); p += O.n; item.out = O.o;
          } else if (op === 0x79) {
            const Ti = bytes[p], To = bytes[p + 1], tr = bytes[p + 2]; p += 3;
            const A = od(bytes, p, Ti); p += A.n; const O = od(bytes, p, To); p += O.n;
            item = { type: "Box", box: name, a: A.o, out: O.o, trunc: tr === 1 };
          } else {
            const T = bytes[p++];
            const A = od(bytes, p, T); p += A.n;
            let B = null;
            if (op >= 0x72 && op <= 0x76) { B = od(bytes, p, T); p += B.n; }
            const O = od(bytes, p, T); p += O.n;
            item = { type: "Box", box: name, a: A.o, out: O.o };
            if (B) item.b = B.o;
          }
          if (item.out.k !== undefined) fail("uscita costante");
          i = p;
          const v = valueTop(); descend(v);
          if (!plain(v.node)) fail("istruzione dopo una bobina");
          v.node.series.items.push(item);
          continue;
        }
        if (op === 0x16) {
          if (bytes[i + 1] === 0) {                                 // LDC 0 = inizio parallelo con corrente
            valueTop();
            stack.push({ pp: parallel([]) }); i += 2; continue;
          }
          if (bytes[i + 1] !== 1) fail("LDC non valido");
          lastWasCoil = wasCoil; boundary(); lastWasCoil = false;   // LDC 1
          stack.push(newValue()); i += 2; continue;
        }
        if (op === 0x1B) {                                          // OVER = nuovo ramo del parallelo con corrente
          i++;
          if (!top().pp) fail("OVER inatteso");
          stack.push(newValue());
          continue;
        }
        if (TIMER[op]) {                                            // TON TOF TP
          if (i + 6 > bytes.length) fail("timer troncato");
          const idx = bytes[i + 1];
          const pt = (bytes[i + 2] | (bytes[i + 3] << 8) | (bytes[i + 4] << 16) | (bytes[i + 5] << 24)) >>> 0;
          i += 6;
          const v = valueTop(); descend(v);
          if (!plain(v.node)) fail("timer dopo una bobina");
          v.node.series.items.push({ type: "Timer", kind: TIMER[op], op: { ns: "T", idx }, pt });
          v.lastTimerNode = v.node;
          continue;
        }
        if (op === 0x17 || op === 0x18) {                           // ANB / ORB
          i++;
          if (stack.length < 2) fail("ANB/ORB senza due valori");
          if (op === 0x18 && stack[stack.length - 2].pp) {          // fine ramo del parallelo con corrente
            const b = stack.pop();
            if (!plain(b.node)) fail("ramo con bobina");
            top().pp.branches.push(b.node.series);
            continue;
          }
          if (op === 0x17 && top().pp) {                            // fine parallelo con corrente
            const p = stack.pop().pp, v = valueTop();
            descend(v);
            if (!plain(v.node)) fail("parallelo dopo una bobina");
            v.node.series.items.push(p);
            continue;
          }
          const b = stack.pop(), a = top();
          if (a.pp || b.pp) fail("blocco non valido");
          if (!plain(b.node)) fail("blocco con bobina");
          if (op === 0x17) {
            descend(a);
            if (!plain(a.node)) fail("ANB dopo una bobina");
            a.node.series.items.push(...b.node.series.items);
          } else {
            if (a.branching || !plain(a.node)) fail("ORB dopo una diramazione");
            a.node.series = orWith(a.node.series, b.node.series);
          }
          continue;
        }
        if (op === 0x19) {                                          // DUP
          i++;
          const v = valueTop();
          if (v.node.coil) fail("DUP dopo una bobina");
          if (!v.branching) {
            if (v.node.outputs) fail("DUP inatteso");
            v.node.outputs = []; v.branching = true;
          }
          const child = { series: series() };
          v.node.outputs.push(child);
          stack.push({ root: null, node: child, branching: false });
          continue;
        }
        if (op === 0x1A) {                                          // POP
          i++;
          const v = stack.pop() || fail("POP su stack vuoto");
          if (v.pp) fail("POP inatteso");
          // timer seguito subito da POP = timer al posto della bobina
          const n = v.node, last = n.series.items[n.series.items.length - 1];
          if (prevOp >= 0x50 && prevOp <= 0x52 && plain(n) && last && last.type === "Timer") {
            n.series.items.pop();
            n.coil = { kind: last.kind, op: last.op, pt: last.pt };
          }
          // chiamata seguita subito da POP = chiamata al posto della bobina
          if (prevOp === 0x60 && plain(n) && last && last.type === "Call") {
            n.series.items.pop();
            n.coil = { kind: "CALL", _target: last._target };
          }
          // box numerico seguito subito da POP = box a fine network
          if (isBoxOp(prevOp) && plain(n) && last && last.type === "Box") {
            n.series.items.pop();
            const c = Object.assign({ kind: "BOX" }, last); delete c.type;
            n.coil = c;
          }
          if (!stack.length) { if (!v.root) fail("POP inatteso"); finishRoot(v); }
          continue;
        }
        if ((op >= 0x10 && op <= 0x15) || (op >= 0x20 && op <= 0x23) || (op >= 0x30 && op <= 0x35) || (op >= 0x40 && op <= 0x43)) {
          const w16 = op >= 0x30;
          if (i + (w16 ? 4 : 3) > bytes.length) fail("istruzione troncata");
          const o = w16 ? operand16(bytes[i + 1], bytes[i + 2] | (bytes[i + 3] << 8)) : operand(bytes, i + 1);
          i += w16 ? 4 : 3;
          if (w16) op -= 0x20;
          if (op <= 0x11) {                                         // LD LDN
            lastWasCoil = wasCoil; boundary(); lastWasCoil = false;
            stack.push(newValue([({ type: "Contact", negated: op === 0x11, op: o })]));
          } else if (op <= 0x13) {                                  // AND ANDN
            const v = valueTop(); descend(v);
            if (!plain(v.node)) fail("AND dopo una bobina");
            v.node.series.items.push(({ type: "Contact", negated: op === 0x13, op: o }));
          } else if (op <= 0x15) {                                  // OR ORN
            const v = valueTop();
            if (v.pp || v.branching || !plain(v.node)) fail("OR dopo una diramazione");
            v.node.series = orWith(v.node.series, series([({ type: "Contact", negated: op === 0x15, op: o })]));
          } else {                                                  // ST S R
            if (!COIL[op]) fail("bobina non supportata");
            const v = valueTop(); descend(v);
            const c = { kind: COIL[op], op: o };
            if (v.node.outputs) fail("bobina su una diramazione");
            if (v.node.coil) {
              // bytecode vecchio con più bobine sullo stesso risultato
              v.node.outputs = [{ series: series(), coil: v.node.coil }, { series: series(), coil: c }];
              delete v.node.coil; v.branching = true;
            } else v.node.coil = c;
            lastWasCoil = true;
          }
          continue;
        }
        fail(`istruzione 0x${op.toString(16)} non supportata dall'editor`);
      }
      if (lastWasCoil && stack.length === 1) finishRoot(stack.pop());
      if (stack.length) fail("programma incompleto");
      if (!ended && !isMain) fail("funzione senza RET");
      return { rungs, next: i };
    }

    const p = EspIR.emptyProgram();
    try {
      const table = readTable(section);
      const segs = rungs => rungs.map((r, n) => ({ id: n + 1, order: n, language: "LD", rungs: [r] }));
      table.forEach((e, k) => {
        bytes = e.data;
        const su = k === 1 && e.type === 2;                     // StartUp: subito dopo il Main, finisce con END
        if (k > 0 && e.type !== 1 && !su) fail("blocco di tipo sconosciuto");
        const b = parseBlock(0, k === 0 || su);
        if (k === 0) p.blocks[0].segments = segs(b.rungs);
        else if (su) p.blocks.push(EspIR.startupBlock(segs(b.rungs)));
        else p.blocks.push(EspIR.fcBlock(e.number, "FC" + e.number, segs(b.rungs)));
      });
      const nums = new Set(table.slice(1).filter(e => e.type === 1).map(e => e.number));
      const fix = x => {
        if (x.type === "Call") { if (!nums.has(x._target)) fail(`CALL verso FC${x._target} che non c'è`); x.fc = x._target; delete x._target; }
        else if (x.type === "Parallel") x.branches.forEach(b => b.items.forEach(fix));
      };
      const node = n => {
        n.series.items.forEach(fix);
        if (n.coil && n.coil.kind === "CALL") { if (!nums.has(n.coil._target)) fail("CALL non valida"); n.coil = { kind: "CALL", fc: n.coil._target }; }
        (n.outputs || []).forEach(node);
      };
      p.blocks.forEach(bl => bl.segments.forEach(sg => sg.rungs.forEach(node)));
      if (!p.blocks[0].segments.length) p.blocks[0].segments = [{ id: 1, order: 0, language: "LD", rungs: [] }];
    } catch (e) {
      return { editable: false, error: e.message };
    }
    return { editable: true, program: p };
  }

  window.decompileBytecode = decompile;
})();
