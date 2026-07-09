// CI-Prüfung: Ist die tarife.json im Repo gültig? (Schema + Preisspannen)
// Aufruf: node automation/pruefe-tarife.mjs [pfad]
import { readFileSync } from "node:fs";

const pfad = process.argv[2] || "tarife.json";
const js = JSON.parse(readFileSync(pfad, "utf8"));
const fehler = [];

if (!/^\d{4}-\d{2}-\d{2}$/.test(js.preisstand || "")) fehler.push("preisstand fehlt/ungültig");
if (!Array.isArray(js.tarife) || js.tarife.length < 15) fehler.push("weniger als 15 Tarife");
for (const id of ["maingau", "enbw-s", "ionity-motion", "tesla-app", "adhoc", "swm-flex"]) {
  if (!js.tarife.some(t => t.id === id)) fehler.push(`Kern-Tarif "${id}" fehlt`);
}
for (const t of js.tarife || []) {
  if (!t.id || !t.name || !["frei", "abo", "adhoc"].includes(t.kategorie)) { fehler.push(`${t.id || "?"}: Schema kaputt`); continue; }
  if (typeof t.grund !== "number" || t.grund < 0 || t.grund > 30) fehler.push(`${t.id}: Grundgebühr ${t.grund}`);
  const preise = [];
  for (const p of Object.values(t.preise || {})) { if (p.ac != null) preise.push(p.ac); if (p.dc != null) preise.push(p.dc); }
  if (t.roaming) { if (t.roaming.ac != null) preise.push(t.roaming.ac); if (t.roaming.dc != null) preise.push(t.roaming.dc); }
  for (const p of preise) if (typeof p !== "number" || p < 0.05 || p > 1.5) fehler.push(`${t.id}: Preis ${p} außerhalb 0,05–1,50`);
}
for (const a of js.aktionen || []) {
  if (!a.text || !/^\d{4}-\d{2}-\d{2}$/.test(a.bis || "")) fehler.push("Aktion ungültig: " + JSON.stringify(a).slice(0, 60));
}

if (fehler.length) { fehler.forEach(f => console.error("FEHLER: " + f)); process.exit(1); }
console.log(`OK: ${pfad} gültig (${js.tarife.length} Tarife, Preisstand ${js.preisstand}).`);
