// Wiki: guida dei programmi a tendine. Un indirizzo con #… apre le tendine che lo contengono;
// «Apri tutto» / «Chiudi tutto»; ricerca nella guida (apre solo le tendine che contengono la parola).
(function () {
  var en = (document.documentElement.lang || "").slice(0, 2) === "en";
  function openTo(el) {
    for (var d = el; d; d = d.parentElement) if (d.tagName === "DETAILS") d.open = true;
  }
  function fromHash() {
    var id = decodeURIComponent((location.hash || "").slice(1));
    if (!id) return;
    var el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    openTo(el);
    var stop = false;
    ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (ev) {
      window.addEventListener(ev, function () { stop = true; }, { once: true, passive: true });
    });
    var go = function () { if (!stop) el.scrollIntoView({ block: "start" }); };
    // le immagini sopra si caricano dopo e spostano la pagina: si riallinea qualche volta
    setTimeout(go, 0); setTimeout(go, 500); setTimeout(go, 1500);
    if (document.readyState !== "complete") window.addEventListener("load", go, { once: true });
  }
  window.addEventListener("hashchange", fromHash);

  function init() {
    fromHash();
    var g = document.getElementById("guida-tendine");
    if (!g) return;
    var all = function () { return g.querySelectorAll("details"); };
    var tools = document.createElement("div");
    tools.className = "guide-tools";
    var q = document.createElement("input");
    q.type = "search";
    q.placeholder = en ? "Search the guide…" : "Cerca nella guida…";
    q.setAttribute("aria-label", q.placeholder);
    q.className = "guide-q";
    var bOpen = document.createElement("button"), bClose = document.createElement("button");
    bOpen.type = bClose.type = "button";
    bOpen.textContent = en ? "Open all" : "Apri tutto";
    bClose.textContent = en ? "Close all" : "Chiudi tutto";
    var info = document.createElement("span");
    info.className = "guide-info";
    tools.appendChild(q); tools.appendChild(bOpen); tools.appendChild(bClose); tools.appendChild(info);
    g.parentNode.insertBefore(tools, g);
    bOpen.onclick = function () { all().forEach(function (d) { d.open = true; }); info.textContent = ""; };
    bClose.onclick = function () { all().forEach(function (d) { d.open = false; }); info.textContent = ""; };
    var t = 0;
    q.addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var w = q.value.trim().toLowerCase();
        g.querySelectorAll("mark.gq").forEach(function (m) { m.replaceWith(document.createTextNode(m.textContent)); });
        g.normalize();
        if (w.length < 2) { info.textContent = ""; return; }
        all().forEach(function (d) { d.open = false; });
        var n = 0, first = null;
        var walk = document.createTreeWalker(g, NodeFilter.SHOW_TEXT, null);
        var hits = [];
        while (walk.nextNode()) if (walk.currentNode.nodeValue.toLowerCase().indexOf(w) >= 0) hits.push(walk.currentNode);
        hits.forEach(function (node) {
          var v = node.nodeValue, i = v.toLowerCase().indexOf(w);
          if (i < 0) return;
          var m = document.createElement("mark");
          m.className = "gq";
          var after = node.splitText(i);
          after.splitText(w.length);
          m.textContent = after.nodeValue;
          after.parentNode.replaceChild(m, after);
          openTo(m);
          n++;
          if (!first) first = m;
        });
        info.textContent = n ? (n + (en ? " found" : " trovati")) : (en ? "nothing found" : "nessun risultato");
        if (first) first.scrollIntoView({ block: "center" });
      }, 250);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
