/* Erzeugt umfeld-de.json: vorberechnetes „Was gibt's hier?“ je Ladestandort.

   Warum vorberechnen: Die Live-Abfrage bei Overpass dauert 2–40 s pro Standort,
   die Gratis-Server sind zeitweise überlastet, und unterwegs (Bosnien) gibt es
   oft gar kein Netz. Vorberechnet erscheint das Umfeld sofort und offline.

   Nicht vorberechnet werden alle POIs Deutschlands (~600.000), sondern nur die
   VIER ZAHLEN je Ladestandort: Essen, WC, Markt, Spielplatz im 700-m-Umkreis.

   Ablauf (siehe .github/workflows/umfeld-update.yml):
     osmium tags-filter  -> nur die vier Kategorien aus den Länder-Auszügen
     osmium export       -> GeoJSON-Zeilen (eine pro Objekt)
     node gen-umfeld.js pois.geojsonseq [ladepunkte-ausland.geojsonseq …]

   Ankerpunkte: in Deutschland die Standorte aus saeulen-de.json (amtliches
   Register), im Ausland alle Ladestationen aus OpenStreetMap.
   Quelle der POIs: OpenStreetMap, ODbL — Namensnennung in der App.
*/
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const RADIUS_M = 700;
const ZIEL = path.join(__dirname, "umfeld-de.json");
const GRID = 0.01;                       // Rasterzelle ~1,1 km — Nachbarzellen reichen für 700 m

const km = (aLat, aLng, bLat, bLng) => {
  const R = 6371, p = Math.PI / 180;
  const dLa = (bLat - aLat) * p, dLo = (bLng - aLng) * p;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const zelle = (lat, lng) => Math.round(lat / GRID) + "|" + Math.round(lng / GRID);

// Ein GeoJSON-Objekt auf Punktkoordinaten bringen (Flächen -> erster Stützpunkt reicht,
// bei 700 m Umkreis ist die Ecke eines Gebäudes genau genug)
function punkt(g) {
  if (!g) return null;
  if (g.type === "Point") return [g.coordinates[1], g.coordinates[0]];
  const c = g.coordinates;
  if (g.type === "Polygon" && c[0] && c[0][0]) return [c[0][0][1], c[0][0][0]];
  if (g.type === "MultiPolygon" && c[0] && c[0][0] && c[0][0][0]) return [c[0][0][0][1], c[0][0][0][0]];
  if (g.type === "LineString" && c[0]) return [c[0][1], c[0][0]];
  return null;
}
function kategorie(t) {
  if (!t) return null;
  if (t.amenity === "toilets") return "wc";
  if (["restaurant", "fast_food", "cafe"].includes(t.amenity)) return "essen";
  if (["supermarket", "convenience", "bakery"].includes(t.shop)) return "markt";
  if (t.leisure === "playground") return "spiel";
  return null;
}
const anzeigeName = (t, kat) => t.name || (kat === "essen"
  ? ({ cafe: "Café", fast_food: "Imbiss", restaurant: "Restaurant" })[t.amenity] || "Essen"
  : ({ supermarket: "Supermarkt", convenience: "Kiosk", bakery: "Bäckerei" })[t.shop] || "Markt");

async function zeilenLesen(datei, jeZeile) {
  // Achtung: „GeoJSON Text Sequence“ (RFC 8142) stellt JEDER Zeile das
  // Trennzeichen RS (0x1E) voran — genau daran ist der erste Cloud-Lauf
  // gescheitert (0 POIs gelesen, Berechnung nach 1 Sekunde fertig).
  const rl = readline.createInterface({ input: fs.createReadStream(datei), crlfDelay: Infinity });
  let gelesen = 0, uebersprungen = 0;
  for await (const roh of rl) {
    const z = (roh || "").replace(/^[\x1e\s]+/, "");
    if (!z || z[0] !== "{") { if (roh && roh.trim()) uebersprungen++; continue; }
    let g;
    try { g = JSON.parse(z); } catch (e) { uebersprungen++; continue; }
    gelesen++;
    jeZeile(g);
  }
  return { gelesen, uebersprungen };
}

async function main() {
  const dateien = process.argv.slice(2);
  if (!dateien.length) throw new Error("Aufruf: node gen-umfeld.js pois.geojsonseq [ladepunkte-ausland.geojsonseq …]");
  const poiDatei = dateien[0], ankerDateien = dateien.slice(1);

  // 1) Ankerpunkte einsammeln: Deutschland aus dem Register, Ausland aus OSM
  const anker = [];
  const registerDatei = path.join(__dirname, "saeulen-de.json");
  if (fs.existsSync(registerDatei)) {
    const reg = JSON.parse(fs.readFileSync(registerDatei, "utf8"));
    for (const s of reg.saeulen) anker.push([s[0], s[1]]);
    console.log("Ankerpunkte aus dem Säulen-Register:", reg.saeulen.length);
  }
  for (const d of ankerDateien) {
    let n = 0;
    const st = await zeilenLesen(d, (g) => { const p = punkt(g.geometry); if (p) { anker.push(p); n++; } });
    console.log("Ankerpunkte (Ladestationen) aus", path.basename(d) + ":", n, `(${st.gelesen} Objekte gelesen, ${st.uebersprungen} übersprungen)`);
  }
  // Doppelte Anker (gleicher Standort) zusammenfassen — 60-m-Raster
  const gesehen = new Set();
  const ankerListe = anker.filter(([la, ln]) => {
    const k = la.toFixed(3) + "," + ln.toFixed(3);
    if (gesehen.has(k)) return false;
    gesehen.add(k); return true;
  });
  console.log("Ankerpunkte gesamt (ohne Dubletten):", ankerListe.length);

  // 2) POIs streamend einlesen und ins Raster einsortieren
  const raster = new Map();
  let poiAnz = 0, doppelt = 0;
  /* Wichtig: osmium export schreibt einen geschlossenen Weg ZWEIMAL — einmal als
     Linie, einmal als Fläche. Ungefiltert zählte Laim dadurch 94 statt echten 59
     Spielplätzen. Entdoppelt wird über die OSM-Objekt-ID (@id, kommt per
     --add-unique-id=type_id aus osmium); fehlt sie, hilfsweise über Koordinaten. */
  const schonDa = new Set();
  const poiStat = await zeilenLesen(poiDatei, (g) => {
    const kat = kategorie(g.properties);
    if (!kat) return;
    const p = punkt(g.geometry);
    if (!p) return;
    const id = g.properties["@id"] || g.id;
    const schluessel = id ? "id:" + id : kat + "|" + p[0].toFixed(6) + "|" + p[1].toFixed(6);
    if (schonDa.has(schluessel)) { doppelt++; return; }
    schonDa.add(schluessel);
    poiAnz++;
    const k = zelle(p[0], p[1]);
    if (!raster.has(k)) raster.set(k, []);
    raster.get(k).push([p[0], p[1], kat, kat === "wc" || kat === "spiel" ? "" : anzeigeName(g.properties, kat)]);
  });
  console.log("POIs eingelesen:", poiAnz, "in", raster.size, "Rasterzellen",
    `(${poiStat.gelesen} Objekte gelesen, ${doppelt} Doppelgeometrien verworfen, ${poiStat.uebersprungen} übersprungen)`);
  if (!poiAnz) throw new Error("Keine POIs erkannt — Eingabeformat prüfen (GeoJSON-Zeilen mit RS-Trennzeichen?)");

  // 3) Für jeden Ankerpunkt zählen, was im 700-m-Umkreis liegt
  const namen = [], nIdx = new Map();
  const nameIdx = (s) => {
    if (!s) return -1;
    if (!nIdx.has(s)) { nIdx.set(s, namen.length); namen.push(s); }
    return nIdx.get(s);
  };
  const rMax = RADIUS_M / 1000;
  const punkte = [];
  let mitTreffer = 0;
  for (const [la, ln] of ankerListe) {
    const z = { essen: 0, wc: 0, markt: 0, spiel: 0 };
    let essenName = "", marktName = "", essenDist = 9e9, marktDist = 9e9;
    const zl = Math.round(la / GRID), zn = Math.round(ln / GRID);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dn = -1; dn <= 1; dn++) {
        const liste = raster.get((zl + dz) + "|" + (zn + dn));
        if (!liste) continue;
        for (const [pla, pln, kat, name] of liste) {
          const d = km(la, ln, pla, pln);
          if (d > rMax) continue;
          z[kat]++;
          if (kat === "essen" && d < essenDist) { essenDist = d; essenName = name; }
          if (kat === "markt" && d < marktDist) { marktDist = d; marktName = name; }
        }
      }
    }
    if (z.essen || z.wc || z.markt || z.spiel) mitTreffer++;
    punkte.push([+la.toFixed(5), +ln.toFixed(5), z.essen, z.wc, z.markt, z.spiel, nameIdx(essenName), nameIdx(marktName)]);
  }
  punkte.sort((a, b) => a[0] - b[0]);        // nach Breitengrad -> Umkreissuche per Binärsuche

  const daten = {
    quelle: "OpenStreetMap-Mitwirkende (ODbL)",
    stand: new Date().toISOString().slice(0, 10),
    radius: RADIUS_M,
    felder: ["lat", "lng", "essen", "wc", "markt", "spiel", "essenNameIdx", "marktNameIdx"],
    namen,
    punkte,
  };
  fs.writeFileSync(ZIEL, JSON.stringify(daten));
  console.log(`OK: ${punkte.length} Ladestandorte vorberechnet, ${mitTreffer} davon mit mindestens einem Treffer ` +
    `(${Math.round(mitTreffer / punkte.length * 100)} %), ${namen.length} Namen — ${(fs.statSync(ZIEL).size / 1048576).toFixed(2)} MB`);
}

main().catch(e => { console.error("Fehlgeschlagen:", e.message); process.exit(1); });
