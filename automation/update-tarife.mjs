// ============================================================
// Automatisches Tarif-Update für den Ladekarten-Checker
// Läuft monatlich in GitHub Actions (kostenlos, kein PC nötig).
//
// Ablauf:
//  1. Liest die aktuelle tarife.json
//  2. Lässt Gemini (mit Google-Suche) jeden Tarif gegen aktuelle
//     Quellen prüfen und die JSON aktualisieren
//  3. Validiert das Ergebnis streng (Schema, Preisspannen,
//     Plausibilität) — bei Zweifeln schlägt der Lauf fehl und
//     GitHub verschickt automatisch eine E-Mail
//  4. Schreibt tarife.json mit neuem Preisstand
//
// Benötigt: Umgebungsvariable GEMINI_API_KEY
// Modell:   gemini-2.5-flash (per GEMINI_MODEL übersteuerbar)
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
if (!KEY) { console.error("FEHLER: GEMINI_API_KEY fehlt (GitHub-Secret setzen)."); process.exit(1); }

const alt = JSON.parse(readFileSync(join(ROOT, "tarife.json"), "utf8"));
const heute = new Date().toISOString().slice(0, 10);

const prompt = `Du bist ein präziser Rechercheur für deutsche E-Auto-Ladetarife.
Unten steht eine JSON-Datenbank mit Ladetarifen (Preisstand ${alt.preisstand}).
Prüfe HEUTE (${heute}) per Google-Suche für JEDEN Tarif die aktuellen Konditionen:
Preise (€/kWh, AC/DC, je Netz), Grundgebühren (€/Monat), Blockiergebühren, Bedingungen.
Gute Quellen: electrive.net, ecomento.de, offizielle Anbieterseiten.

Regeln:
1. Gib die VOLLSTÄNDIGE aktualisierte JSON zurück — exakt dasselbe Schema, alle Felder erhalten.
2. Ändere NUR Werte, die du durch Suchergebnisse belegen kannst. Im Zweifel: alten Wert
   behalten und im Feld "hinweis" notieren, dass eine Prüfung ansteht.
3. Preise, die je Standort/Zeit variieren, mit "unsicher": true markieren.
4. Neue relevante Anbieter (besonders ohne Grundgebühr, Netz in DE/AT) als neue Einträge
   im selben Schema ergänzen; eingestellte Tarife entfernen und ihre IDs im Feld
   "entfernt" (Array auf oberster Ebene) auflisten.
5. Setze "preisstand" auf "${heute}".
6. Aktualisiere "hinweis"-Texte, wenn sich Bedingungen geändert haben (kurz, deutsch).
7. Antworte AUSSCHLIESSLICH mit der JSON — kein Text davor oder danach.

Aktuelle Datenbank:
${JSON.stringify(alt)}`;

console.log(`Frage ${MODEL} mit Google-Suche an ...`);
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
  }),
});
if (!res.ok) { console.error("FEHLER: Gemini-API " + res.status + " — " + (await res.text()).slice(0, 500)); process.exit(1); }
const antwort = await res.json();
const text = (antwort.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
const start = text.indexOf("{"), ende = text.lastIndexOf("}");
if (start < 0 || ende <= start) { console.error("FEHLER: Keine JSON in der Antwort."); process.exit(1); }

let neu;
try { neu = JSON.parse(text.slice(start, ende + 1)); }
catch (e) { console.error("FEHLER: Antwort ist keine gültige JSON: " + e.message); process.exit(1); }

// ---------- Strenge Validierung (Sicherheitsnetz) ----------
const fehler = [];
if (neu.preisstand !== heute) fehler.push(`preisstand ist "${neu.preisstand}", erwartet "${heute}"`);
if (!Array.isArray(neu.tarife) || neu.tarife.length < 15) fehler.push("weniger als 15 Tarife — unplausibel");
const pflicht = ["maingau", "enbw-s", "ionity-motion", "tesla-app", "adhoc", "swm-flex"];
for (const id of pflicht) if (!neu.tarife.some(t => t.id === id) && !(neu.entfernt || []).includes(id)) {
  fehler.push(`Kern-Tarif "${id}" fehlt ohne Entfernungs-Vermerk`);
}
for (const t of neu.tarife || []) {
  if (!t.id || !t.name || !["frei", "abo", "adhoc"].includes(t.kategorie)) { fehler.push(`Tarif "${t.id || t.name}": Schema kaputt`); continue; }
  if (typeof t.grund !== "number" || t.grund < 0 || t.grund > 30) fehler.push(`${t.id}: Grundgebühr ${t.grund} außerhalb 0–30 €`);
  const preise = [];
  for (const p of Object.values(t.preise || {})) { if (p.ac != null) preise.push(p.ac); if (p.dc != null) preise.push(p.dc); }
  if (t.roaming) { if (t.roaming.ac != null) preise.push(t.roaming.ac); if (t.roaming.dc != null) preise.push(t.roaming.dc); }
  for (const p of preise) if (typeof p !== "number" || p < 0.05 || p > 1.5) fehler.push(`${t.id}: Preis ${p} außerhalb 0,05–1,50 €/kWh`);
  // Sprünge > 0,30 €/kWh gegenüber dem alten Stand: manuell prüfen lassen
  const altT = alt.tarife.find(x => x.id === t.id);
  if (altT) {
    const altPreise = [];
    for (const p of Object.values(altT.preise || {})) { if (p.ac != null) altPreise.push(p.ac); if (p.dc != null) altPreise.push(p.dc); }
    const altMin = Math.min(...altPreise, Infinity), neuMin = Math.min(...preise, Infinity);
    if (isFinite(altMin) && isFinite(neuMin) && Math.abs(altMin - neuMin) > 0.30) {
      fehler.push(`${t.id}: Preissprung ${altMin} → ${neuMin} €/kWh (> 0,30) — bitte manuell prüfen`);
    }
  }
}
if (fehler.length) {
  console.error("VALIDIERUNG FEHLGESCHLAGEN — tarife.json bleibt unverändert:");
  fehler.forEach(f => console.error(" - " + f));
  process.exit(1);
}

// ---------- Änderungsbericht + schreiben ----------
let aenderungen = 0;
for (const t of neu.tarife) {
  const a = alt.tarife.find(x => x.id === t.id);
  if (!a) { console.log(`NEU: ${t.id} (${t.name})`); aenderungen++; continue; }
  if (JSON.stringify(a.preise) !== JSON.stringify(t.preise) || a.grund !== t.grund ||
    JSON.stringify(a.roaming) !== JSON.stringify(t.roaming)) {
    console.log(`GEÄNDERT: ${t.id} — Grund ${a.grund}→${t.grund}, Preise ${JSON.stringify(a.preise)} → ${JSON.stringify(t.preise)}`);
    aenderungen++;
  }
}
for (const id of neu.entfernt || []) { console.log(`ENTFERNT: ${id}`); aenderungen++; }
writeFileSync(join(ROOT, "tarife.json"), JSON.stringify(neu, null, 1));
console.log(`OK: tarife.json geschrieben (Preisstand ${neu.preisstand}, ${neu.tarife.length} Tarife, ${aenderungen} Änderungen).`);
