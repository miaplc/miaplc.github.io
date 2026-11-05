// ============================================================
//  EspPlc — theme.js
//  Tema chiaro / scuro e colori scelti in Grafica → Colori. Si carica in <head> (editor e Diagnostica),
//  prima che la pagina si disegni. Un cambio in una finestra vale subito anche nelle altre.
// ============================================================
(function () {
  "use strict";
  var KEY = "espplc.view.current";
  var COLORS = { liveOn: "--live-on", wire: "--wire", editing: "--editing", ladSym: "--lad-sym", ladAddr: "--lad-addr", ladOp: "--lad-op", ladCom: "--lad-com", symDb: "--sym-db", symDot: "--sym-dot" };
  function apply(p) {
    var r = document.documentElement;
    p = p || {};
    r.setAttribute("data-theme", p.theme === "light" ? "light" : "dark");
    for (var k in COLORS) {
      if (/^#[0-9a-f]{6}$/i.test(p[k] || "")) r.style.setProperty(COLORS[k], p[k]);
      else r.style.removeProperty(COLORS[k]);
    }
  }
  var cur = {};
  try { cur = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { cur = {}; }
  apply(cur);
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    try { apply(JSON.parse(e.newValue || "{}")); } catch (x) { /* valore non valido: resta il tema di prima */ }
  });
  window.EspTheme = { apply: apply };
})();
