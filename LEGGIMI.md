# Sito miaplc.it

Sito statico (HTML + CSS, nessun framework), in italiano e inglese (`/en/`).

```
index.html  wiki.html  esempi.html  provami.html      pagine in italiano
en/                                                 le stesse pagine in inglese
assets/css/style.css   assets/img/                  stile e immagini
esempi/*.espplc.json                                progetti di esempio (IT ed EN)
provami/editor/                                     copia dell'editor con il PLC simulato (dev/mock-*.js)
CNAME  robots.txt  sitemap.xml  favicon.png
```

## Modificare i testi

Header e footer sono comuni a tutte le pagine: si cambiano in `../sito-build/build.py`.
Il corpo di ogni pagina sta in `../sito-build/pages/` (italiano) e `../sito-build/pages/en/` (inglese). Poi:

    python ../sito-build/build.py .

Si può anche modificare direttamente l'HTML qui, ma alla prossima build viene riscritto.

## Aggiornare il simulatore

Dalla cartella Miaplc:

    python sito-build/aggiorna-editor.py MiaPlc/gui sito

Copia l'editor in `provami/editor/` e aggiunge `sito-esempi.js` (solo sul sito): «📂 Apri» mostra gli esempi
del sito e li apre direttamente; `?esempio=<nome>` nell'indirizzo apre subito un esempio (link della pagina Esempi).
Per aggiungere un esempio: metti il file in `esempi/` e il nome nella lista `EX` di `sito-build/editor-sito/sito-esempi.js`.
Il simulatore parte solo con `?mock` nell'indirizzo (già nei link del sito).

## Pubblicare con GitHub Pages (gratis, con miaplc.it)

1. Crea il repository `miaplc/miaplc.github.io` (pubblico) e carica il contenuto di questa cartella.
2. Settings → Pages → Source: «Deploy from a branch», branch `main`, cartella `/ (root)`.
3. Custom domain: `www.miaplc.it` (il file `CNAME` c'è già), poi «Enforce HTTPS».
4. DNS dal registrar di miaplc.it:
   - `www`  CNAME  `miaplc.github.io.`
   - `@` (dominio nudo) A → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - lascia stare i record MX di ImprovMX: la posta non cambia.
5. miaplc.eu: redirect verso `https://www.miaplc.it` dal pannello del registrar (come già fatto).

Alternative equivalenti: Cloudflare Pages o Netlify (trascini la cartella, poi colleghi il dominio).

## Da completare

- Repository GitHub pubblici: finché sono privati il link a github.com/miaplc mostra una pagina vuota.
