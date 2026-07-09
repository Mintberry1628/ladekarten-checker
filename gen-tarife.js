// Erzeugt tarife.json aus src/data.js — die Datei, die die App beim Start
// vom eigenen Server lädt, um Tarif-Updates zu verteilen.
// Aufruf: node gen-tarife.js  (macht build.sh automatisch)
const fs = require("fs");
const pfad = require("path").join(__dirname, "tarife.json");
const src = fs.readFileSync(require("path").join(__dirname, "src", "data.js"), "utf8");
const out = new Function(src + "\nreturn { preisstand: PREISSTAND, tarife: TARIFE_DEFAULT };")();
// Schutz: Der Cloud-Bot (GitHub Actions) schreibt tarife.json mit neuerem Preisstand —
// ein lokaler Build darf diesen frischeren Stand nicht mit älteren Daten überschreiben.
try {
  const alt = JSON.parse(fs.readFileSync(pfad, "utf8"));
  if (alt.preisstand && alt.preisstand > out.preisstand) {
    console.log("tarife.json unverändert gelassen — vorhandener Stand " + alt.preisstand +
      " ist neuer als data.js (" + out.preisstand + ").");
    process.exit(0);
  }
} catch (e) { /* keine/kaputte Datei -> neu schreiben */ }
fs.writeFileSync(pfad, JSON.stringify(out, null, 1));
console.log("tarife.json geschrieben (Preisstand " + out.preisstand + ", " + out.tarife.length + " Tarife)");
