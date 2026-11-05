// ============================================================
//  MiaPLC — sito-esempi.js  (SOLO per la copia dell'editor sul sito, provami/editor/)
//  «📂 Apri» mostra un menu: gli esempi del sito si aprono direttamente nell'editor,
//  «Dal computer…» apre il file come sempre.
//  ?esempio=<nome> nell'indirizzo apre subito quell'esempio (link dalla pagina Esempi).
//  Il progetto passa dall'input #file-open dell'editor: stesso caricamento di un file scelto a mano.
// ============================================================
(function () {
  "use strict";
  const BASE = "../../esempi/";
  const EX = {
    it: [["marcia-arresto", "Marcia e arresto motore"], ["semaforo", "Semaforo"], ["canzoncina", "La canzoncina dei relè"]],
    en: [["motor-start-stop", "Motor start / stop"], ["traffic-light", "Traffic light"], ["canzoncina", "The relay song (Italian comments)"]],
  };
  const T = {
    it: { title: "Esempi del sito", pc: "📁 Dal computer…", err: "Esempio non trovato: " },
    en: { title: "Website examples", pc: "📁 From your computer…", err: "Example not found: " },
  };
  const lang = () => { try { return localStorage.getItem("espplc.lang") === "en" ? "en" : "it"; } catch (e) { return "it"; } };

  async function openExample(name) {
    const input = document.getElementById("file-open");
    if (!input) return;
    try {
      const r = await fetch(BASE + encodeURIComponent(name) + ".miaplc", { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name + ".miaplc", { type: "application/json" }));
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { alertBox(T[lang()].err + name); }
  }

  function alertBox(txt) {
    const d = document.createElement("div");
    d.textContent = txt;
    d.style.cssText = "position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:99999;background:#3b1220;color:#fecaca;" +
      "border:1px solid #f87171;border-radius:8px;padding:10px 16px;font:14px system-ui,sans-serif";
    document.body.appendChild(d); setTimeout(() => d.remove(), 4000);
  }

  let menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function showMenu(anchor) {
    closeMenu();
    const L = lang(), r = anchor.getBoundingClientRect();
    menu = document.createElement("div");
    menu.className = "sito-esempi-menu";
    menu.style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom + 6}px;z-index:99999;min-width:260px;background:#13203a;` +
      "border:1px solid #2b4470;border-radius:10px;box-shadow:0 14px 40px rgba(0,0,0,.55);padding:6px;font:14px system-ui,sans-serif;color:#dbe7ff";
    const head = document.createElement("div");
    head.textContent = T[L].title;
    head.style.cssText = "padding:6px 10px 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8ea3c8";
    menu.appendChild(head);
    const item = (label, fn, sep) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label;
      b.style.cssText = "display:block;width:100%;text-align:left;background:none;border:0;color:inherit;padding:8px 10px;border-radius:6px;cursor:pointer;font:inherit" +
        (sep ? ";border-top:1px solid #2b4470;border-radius:0 0 6px 6px;margin-top:4px" : "");
      b.onmouseenter = () => b.style.background = "#1d3566"; b.onmouseleave = () => b.style.background = "none";
      b.onclick = e => { e.stopPropagation(); closeMenu(); fn(); };
      menu.appendChild(b);
    };
    EX[L].forEach(([n, t]) => item("🧪 " + t, () => openExample(n)));
    item(T[L].pc, () => document.getElementById("file-open").click(), true);
    document.body.appendChild(menu);
  }

  function hook() {
    const label = document.querySelector('label[for="file-open"]');
    if (!label) return;
    label.addEventListener("click", e => {
      if (e.target && e.target.id === "file-open") return;      // click dato da «Dal computer…»
      e.preventDefault(); e.stopPropagation();
      menu ? closeMenu() : showMenu(label);
    }, true);
    document.addEventListener("click", e => { if (menu && !menu.contains(e.target)) closeMenu(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
    const q = new URLSearchParams(location.search).get("esempio");
    if (q && /^[a-z0-9-]+$/.test(q)) setTimeout(() => openExample(q), 1200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook); else hook();
})();

// ── Tablet e schermi stretti (solo sito) ─────────────────────────────
//  - la barra in alto va a capo: senza, la pagina diventa più larga dello schermo e il riquadro
//    MOCK PLC (position:fixed) finisce fuori vista;
//  - su schermi touch ingressi, uscite e pulsanti del MOCK PLC più grandi, da toccare col dito;
//  - il riquadro sta sempre sopra la barra in basso (Compile … Run/Stop), anche quando va su più righe.
(function () {
  "use strict";
  const css = document.createElement("style");
  css.textContent =
    "header .badges{flex-wrap:wrap}" +
    ".sito-touch .mockp{width:300px;font-size:14px}" +
    ".sito-touch .mockp-hd{padding:10px 12px}" +
    ".sito-touch .mockp-bit{min-width:42px;padding:9px 6px;font-size:14px;touch-action:manipulation}" +
    ".sito-touch .mockp-row{gap:6px}.sito-touch .mockp-row>span.l{width:60px;font-size:13px}" +
    ".sito-touch .mockp-btns button{font-size:14px;padding:8px 11px;touch-action:manipulation}" +
    ".sito-touch .mockp select{font-size:14px;padding:6px}" +
    ".sito-touch .mockp-log{display:none}";
  document.head.appendChild(css);
  const touch = (navigator.maxTouchPoints || 0) > 0 || matchMedia("(pointer:coarse)").matches;
  if (touch) document.documentElement.classList.add("sito-touch");
  function place() {
    const p = document.querySelector(".mockp"), f = document.querySelector("footer");
    if (p && f) p.style.bottom = (Math.round(f.getBoundingClientRect().height) + 8) + "px";
  }
  window.addEventListener("resize", place);
  new MutationObserver(place).observe(document.body, { childList: true });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(place);
    const watch = () => { const f = document.querySelector("footer"); if (f) ro.observe(f); else setTimeout(watch, 300); };
    watch();
  }
  setTimeout(place, 500);
})();
