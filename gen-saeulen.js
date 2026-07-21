/* Erzeugt saeulen-de.json aus dem Ladesäulenregister der Bundesnetzagentur.
   Warum: OpenChargeMap ist community-gepflegt und hinkt bei neuen Schnellladern
   hinterher (Beispiel Landsberger Str. 240, München: OCM 50 kW/Stand 2015 —
   real 150 kW seit 03/2024). Das amtliche Register kennt jede gemeldete
   Ladeeinrichtung mit Leistung, Ladepunkten und Inbetriebnahme-Datum.

   Lizenz der Quelldaten: CC BY 4.0, Bundesnetzagentur (Namensnennung in der App).
   Läuft monatlich in der GitHub-Action — lokal: node gen-saeulen.js
*/
const fs = require("fs");
const path = require("path");

const SEITE = "https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html";
const BASIS = "https://data.bundesnetzagentur.de/Bundesnetzagentur/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/";
const MIN_KW = 50;              // AC-Straßensäulen deckt OpenChargeMap gut ab — hier zählt DC
const ZIEL = path.join(__dirname, "saeulen-de.json");

// Zeile in Felder zerlegen (Semikolon, Anführungszeichen beachten)
function felder(zeile) {
  const out = []; let cur = "", q = false;
  for (const c of zeile) {
    if (c === '"') { q = !q; continue; }
    if (c === ";" && !q) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
const zahl = (s) => parseFloat(String(s || "").replace(",", ".")) || 0;

async function aktuelleCsvUrl() {
  const html = await (await fetch(SEITE)).text();
  const m = html.match(/Ladesaeulenregister_BNetzA_(\d{4}-\d{2}-\d{2})\.csv/);
  if (!m) throw new Error("Kein CSV-Link auf der BNetzA-Seite gefunden — Seitenaufbau geändert?");
  return { url: BASIS + m[0], stand: m[1] };
}

async function main() {
  let csv, stand;
  if (process.argv[2]) {                       // lokal: schon geladene Datei weiterverwenden
    csv = fs.readFileSync(process.argv[2], "utf8");
    stand = (csv.match(/Letzte Aktualisierung vom: (\d{2})\.(\d{2})\.(\d{4})/) || []).slice(1).reverse().join("-") || "";
  } else {
    const q = await aktuelleCsvUrl();
    stand = q.stand;
    console.log("Lade", q.url);
    csv = await (await fetch(q.url)).text();
  }

  const zeilen = csv.split(/\r?\n/);
  const kopf = zeilen.findIndex(z => z.startsWith("Ladeeinrichtungs-ID;"));
  if (kopf < 0) throw new Error("Kopfzeile nicht gefunden — Format geändert?");
  const H = felder(zeilen[kopf]);
  const I = (n) => {
    const i = H.indexOf(n);
    if (i < 0) throw new Error("Spalte fehlt: " + n);
    return i;
  };
  const iLat = I("Breitengrad"), iLng = I("Längengrad"), iKw = I("Nennleistung Ladeeinrichtung [kW]");
  const iOp = I("Betreiber"), iPkt = I("Anzahl Ladepunkte"), iStat = I("Status"), iSeit = I("Inbetriebnahmedatum");
  const iStr = I("Straße"), iNr = I("Hausnummer"), iPlz = I("Postleitzahl"), iOrt = I("Ort");

  /* Ein Standort = eine Adresse. Das Register führt jede Ladeeinrichtung einzeln
     (eine Tankstelle hat oft 2–4 Zeilen); für die Karte fassen wir sie zusammen:
     stärkste Leistung gewinnt, Ladepunkte werden addiert. */
  const orte = new Map();
  let roh = 0;
  for (let i = kopf + 1; i < zeilen.length; i++) {
    const z = zeilen[i];
    if (z.length < 20) continue;
    const c = felder(z);
    const lat = zahl(c[iLat]), lng = zahl(c[iLng]), kw = zahl(c[iKw]);
    if (!lat || !lng || kw < MIN_KW) continue;
    if (!/betrieb/i.test(c[iStat] || "")) continue;         // nur „In Betrieb“
    roh++;
    const adresse = ((c[iStr] || "") + " " + (c[iNr] || "")).trim().replace(/\s+/g, " ");
    const schluessel = (c[iPlz] || "") + "|" + adresse.toLowerCase();
    const jahr = +((c[iSeit] || "").slice(6)) || 0;
    const vorh = orte.get(schluessel);
    if (!vorh) {
      orte.set(schluessel, { lat, lng, kw, pkt: +c[iPkt] || 1, op: (c[iOp] || "").trim(), adresse, ort: (c[iOrt] || "").trim(), jahr });
    } else {
      vorh.pkt += +c[iPkt] || 1;
      if (kw > vorh.kw) { vorh.kw = kw; vorh.op = (c[iOp] || "").trim(); vorh.lat = lat; vorh.lng = lng; }
      if (jahr > vorh.jahr) vorh.jahr = jahr;
    }
  }

  // Betreiber- und Ortsnamen wiederholen sich stark -> als Tabelle, in den Daten nur der Index
  const betreiber = [], bIdx = new Map(), staedte = [], sIdx = new Map();
  const idx = (wert, liste, karte) => {
    if (!karte.has(wert)) { karte.set(wert, liste.length); liste.push(wert); }
    return karte.get(wert);
  };
  const liste = [...orte.values()]
    .sort((a, b) => a.lat - b.lat)                          // nach Breitengrad sortiert = schnelle Umkreissuche
    .map(o => [
      +o.lat.toFixed(5), +o.lng.toFixed(5), Math.round(o.kw), o.pkt,
      idx(o.op, betreiber, bIdx), idx(o.ort, staedte, sIdx), o.adresse, o.jahr,
    ]);

  const daten = {
    quelle: "Ladesäulenregister der Bundesnetzagentur (CC BY 4.0)",
    stand,
    minKw: MIN_KW,
    felder: ["lat", "lng", "kw", "ladepunkte", "betreiberIdx", "ortIdx", "adresse", "seitJahr"],
    betreiber, orte: staedte,
    saeulen: liste,
  };
  fs.writeFileSync(ZIEL, JSON.stringify(daten));
  console.log(`OK: ${liste.length} Standorte (aus ${roh} gemeldeten Ladeeinrichtungen ab ${MIN_KW} kW), Stand ${stand} — ${(fs.statSync(ZIEL).size / 1048576).toFixed(2)} MB`);
}

main().catch(e => { console.error("Fehlgeschlagen:", e.message); process.exit(1); });
