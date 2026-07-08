// Erzeugt tarife.json aus src/data.js — die Datei, die die App beim Start
// vom eigenen Server lädt, um Tarif-Updates zu verteilen.
// Aufruf: node gen-tarife.js  (macht build.sh automatisch)
const fs = require("fs");
const src = fs.readFileSync(require("path").join(__dirname, "src", "data.js"), "utf8");
const out = new Function(src + "\nreturn { preisstand: PREISSTAND, tarife: TARIFE_DEFAULT };")();
fs.writeFileSync(require("path").join(__dirname, "tarife.json"), JSON.stringify(out, null, 1));
console.log("tarife.json geschrieben (Preisstand " + out.preisstand + ", " + out.tarife.length + " Tarife)");
