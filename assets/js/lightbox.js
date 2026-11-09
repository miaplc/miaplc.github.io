// Immagini a grandezza piena sopra la pagina, nella stessa scheda (regola per tutte le immagini del sito, Denys 09-11-2026).
// Clic sull'immagine; si chiude con ✕, toccando fuori dall'immagine, con Esc o con «indietro» del telefono.
// Escluse le immagini decorative (alt vuoto), quelle in header e footer e quelle dentro un link a un'altra pagina.
(function () {
  var en = (document.documentElement.lang || "").slice(0, 2) === "en";
  var IMG = /\.(png|jpe?g|webp|gif|svg)([?#]|$)/i;
  var box = null, pushed = false;

  function ok(img) {
    if (!img.getAttribute("alt") || img.closest("header, footer")) return false;
    var a = img.closest("a");
    return !a || IMG.test(a.getAttribute("href") || "");
  }
  function caption(img) {
    var f = img.closest("figure"), c = f && f.querySelector("figcaption");
    return (c && c.textContent.trim()) || img.getAttribute("alt") || "";
  }
  function shut() {
    if (!box) return;
    box.remove(); box = null;
    document.documentElement.classList.remove("lb-open");
  }
  function close() {
    if (pushed) { pushed = false; history.back(); }       // toglie la voce aggiunta all'apertura (popstate chiude)
    else shut();
  }
  function open(src, img) {
    shut();
    box = document.createElement("div");
    box.className = "lb";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    var x = document.createElement("button");
    x.className = "lb-x"; x.type = "button"; x.textContent = "✕";
    x.setAttribute("aria-label", en ? "Close" : "Chiudi");
    var im = document.createElement("img");
    im.className = "lb-img"; im.src = src; im.alt = img.getAttribute("alt") || "";
    box.appendChild(x); box.appendChild(im);
    var t = caption(img);
    if (t) { var p = document.createElement("p"); p.className = "lb-cap"; p.textContent = t; box.appendChild(p); }
    box.addEventListener("click", function (e) { if (e.target !== im) close(); });
    document.body.appendChild(box);
    document.documentElement.classList.add("lb-open");
    x.focus();
    try { history.pushState({ lb: 1 }, ""); pushed = true; } catch (e) { pushed = false; }
  }

  document.addEventListener("click", function (e) {
    var img = e.target && e.target.closest ? e.target.closest("main img") : null;
    if (!img || !ok(img)) return;
    e.preventDefault();
    var a = img.closest("a");
    open(a ? a.href : (img.currentSrc || img.src), img);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && box) close(); });
  window.addEventListener("popstate", function () { if (box) { pushed = false; shut(); } });

  function mark() {
    var l = document.querySelectorAll("main img");
    for (var i = 0; i < l.length; i++) if (ok(l[i])) l[i].classList.add("lb-zoom");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mark); else mark();
})();
