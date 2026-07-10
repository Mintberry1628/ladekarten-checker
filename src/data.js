/* ============================================================
   Ladekarten-Checker — Datenbasis
   Preisstand: 7. Juli 2026 (recherchiert). Alle Preise in €/kWh,
   Grundgebühren in €/Monat. Preise sind in der App editierbar.
   ============================================================ */

const PREISSTAND = "2026-07-10";

/* OpenChargeMap-API-Key: wird beim Build aus src/ocm-key.local.js eingebacken
   (Datei ist nicht Teil des öffentlichen Repos). Nutzer-Eingabe in den
   Einstellungen überschreibt diesen Standard. */
let OCM_KEY_STANDARD = "";

/* Zusätzliche Update-Quellen für tarife.json (neben dem eigenen Server).
   Die App holt sich automatisch den NEUESTEN Preisstand aller Quellen. */
const UPDATE_QUELLEN = [
  "https://mintberry.org/local/ladekarten/tarife.json",
  "https://raw.githubusercontent.com/Mintberry1628/ladekarten-checker/main/tarife.json",
];

const FAHRZEUG_DEFAULT = {
  name: "smart #5 Brabus",
  akkuNetto: 94,        // kWh nutzbar (100 kWh brutto, NMC, 800-V-System)
  dcMax: 400,           // kW Spitze; 10→80 % in ca. 18 min
  acMax: 22,            // kW Onboard-Lader (3-phasig)
  verbrauchStadt: 19.5, // kWh/100 km (WLTP 17,4 — wir rechnen bewusst konservativer)
  verbrauchLand: 21.5,
  verbrauchAB: 27.5,    // Autobahn ~130 km/h, leer; "beladen"-Zuschlag kommt on top
  winterZuschlag: 22,   // % Mehrverbrauch bei Kälte
  beladenZuschlag: 8,   // % Mehrverbrauch voll beladen (Leergewicht 2.378 kg, zul. 2.880 kg)
};

/* ---------- Ladenetze (Betreiber) ---------- */
const NETZE = [
  { id: "enbw",    name: "EnBW HyperNetz",        kurz: "EnBW",      typ: "AC+DC", info: "Größtes Schnellladenetz in DE, auch AT dicht abgedeckt." },
  { id: "aral",    name: "Aral pulse",            kurz: "Aral",      typ: "DC",    info: "Schnelllader an Tankstellen, oft stadtnah." },
  { id: "ionity",  name: "Ionity",                kurz: "Ionity",    typ: "DC",    geschlossen: true, info: "HPC direkt an Autobahnen, europaweit — Langstrecken-Standard. Nur Karten mit explizitem Ionity-Preis." },
  { id: "tesla",   name: "Tesla Supercharger",    kurz: "Tesla",     typ: "DC",    geschlossen: true, info: "Für Fremdmarken (CCS2) geöffnet — aber NUR per Tesla-App, keine Fremd-Ladekarten." },
  { id: "swm",     name: "SWM (Stadtwerke München)", kurz: "SWM",    typ: "AC+DC", info: "Städtische Ladesäulen in München, Ladenetz-Verbund." },
  { id: "qwello",  name: "Qwello (München)",      kurz: "Qwello",    typ: "AC",    info: "AC-Säulen am Straßenrand in München, Start per App." },
  { id: "lidl",    name: "Lidl / Kaufland",       kurz: "Lidl/KL",   typ: "DC",    geschlossen: true, info: "Schnelllader an Filialen — nur zu Öffnungszeiten, Start per Kaufland-App/Lidl Plus, keine Fremdkarten." },
  { id: "aldi",    name: "Aldi Süd",              kurz: "Aldi",      typ: "AC+DC", geschlossen: true, info: "Lader an Aldi-Süd-Filialen (z. B. München-Großhadern) — nur zu Öffnungszeiten, Start per App/QR oder Girocard direkt an der Säule, keine Fremdkarten." },
  { id: "ewego",   name: "EWE Go",                kurz: "EWE Go",    typ: "AC+DC", info: "Eigene Säulen v. a. im Nordwesten (auch NRW) + großes Roaming." },
  { id: "dc-fremd", name: "Sonstiger Schnelllader", kurz: "Andere DC", typ: "DC",  info: "Allego, E.ON, Pfalzwerke & Co. — läuft über Roaming-Preise." },
  { id: "ac-fremd", name: "Sonstige AC-Säule",    kurz: "Andere AC", typ: "AC",    info: "Beliebige fremde AC-Säule — läuft über Roaming-Preise." },
  { id: "schuko",  name: "Steckdose / Notladegerät", kurz: "Steckdose", typ: "AC",  info: "Haushalts-Steckdose (Familie, Hotel) mit deinem Schuko-Ladegerät (Mode 2)." },
];

/* ---------- Tarife / Ladekarten ----------
   preise: feste Preise je Netz { netzId: {ac, dc} }
   roaming: Fallback für alle anderen Netze
   null = an diesem Netz nicht (sinnvoll) nutzbar
   unsicher = Preis vor Nutzung in der Anbieter-App prüfen  */
const TARIFE_DEFAULT = [
  {
    id: "maingau", name: "Maingau EinfachStromLaden", kategorie: "frei",
    bestellLink: "https://www.maingau-energie.de/e-mobilitaet",
    einmalKosten: 0,
    grund: 0, medium: "Karte + App", laender: "EU-weit (inkl. AT/SI/HR)",
    preise: { ionity: { dc: 0.62 } },
    roaming: { ac: 0.52, dc: 0.62 },
    blockier: "Standzeitgebühr 10 ct/min (AC nach 4 h, DC nach 1 h), gedeckelt bei 12 €/Ladevorgang.",
    blockierAbMin: { ac: 240, dc: 60 },
    hinweis: "Seit 1.7.2026 gestaffelte Preise je Säule: Niedrig 0,52 (AC) / 0,62 (DC) — Standard 0,72 — Hoch 0,82. Preis vor dem Laden in der App prüfen! Ionity bleibt in der Niedrigpreis-Stufe (0,62). Maingau-Energiekunden zahlen je 10 ct weniger.",
    basisEmpfehlung: true,
  },
  {
    id: "enbw-s", name: "EnBW mobility+ S", kategorie: "frei",
    bestellLink: "https://www.enbw.com/elektromobilitaet/produkte/ladetarife",
    einmalKosten: 9.90, einmalHinweis: "physische Karte 9,90 € — nur App: 0 €",
    grund: 0, medium: "Karte + App", laender: "DE, AT, CH u. a. (HyperNetz)",
    preise: { enbw: { ac: 0.51, dc: 0.51 }, ionity: { dc: 0.89, unsicher: true } },
    roaming: { ac: 0.69, dc: 0.69 },
    blockier: "Blockiergebühr nach 4 h Standzeit.",
    blockierAbMin: { ac: 240, dc: 240 },
    hinweis: "Sommeraktion Juli–Sept. 2026: 0,51 statt 0,56 an EnBW-Säulen. Roaming im HyperNetz 0,56–0,89 je Betreiber (hier mit 0,69 gerechnet — in der App je Säule prüfen).",
    basisEmpfehlung: true,
  },
  {
    id: "enbw-m", name: "EnBW mobility+ M", kategorie: "abo",
    bestellLink: "https://www.enbw.com/elektromobilitaet/produkte/ladetarife",
    einmalKosten: 9.90, einmalHinweis: "physische Karte 9,90 € — nur App: 0 €", bindung: "monatlich kündbar",
    grund: 5.99, medium: "Karte + App", laender: "DE, AT, CH u. a. (HyperNetz)",
    preise: { enbw: { ac: 0.41, dc: 0.41 }, ionity: { dc: 0.79, unsicher: true } },
    roaming: { ac: 0.60, dc: 0.60 }, roamingUnsicher: true,
    blockier: "Blockiergebühr nach 4 h Standzeit.",
    blockierAbMin: { ac: 240, dc: 240 },
    hinweis: "Sommeraktion Juli–Sept. 2026: 0,41 statt 0,46 an EnBW-Säulen. Monatlich kündbar. Roaming-Preise je Betreiber in der App prüfen.",
  },
  {
    id: "enbw-l", name: "EnBW mobility+ L", kategorie: "abo",
    bestellLink: "https://www.enbw.com/elektromobilitaet/produkte/ladetarife",
    einmalKosten: 9.90, einmalHinweis: "physische Karte 9,90 € — nur App: 0 €", bindung: "monatlich kündbar",
    grund: 11.99, medium: "Karte + App", laender: "DE, AT, CH u. a. (HyperNetz)",
    preise: { enbw: { ac: 0.34, dc: 0.34 }, ionity: { dc: 0.79, unsicher: true } },
    roaming: { ac: 0.55, dc: 0.55 }, roamingUnsicher: true,
    blockier: "Blockiergebühr nach 4 h Standzeit.",
    blockierAbMin: { ac: 240, dc: 240 },
    hinweis: "Sommeraktion: 0,34 statt 0,39 an EnBW-Säulen (EnBW-Strom-/Gaskunden sogar 0,30). Monatlich kündbar.",
  },
  {
    id: "swm-flex", name: "SWM Ladekarte Flex", kategorie: "frei",
    bestellLink: "https://www.swm.de/elektromobilitaet/oeffentliche-ladestationen/ladekarte-e-auto",
    einmalKosten: 11.90, einmalHinweis: "11,90 € je Kartenbestellung — auch Ersatz-/Zusatzkarte (Preisblatt swm.de, Stand 07/2026)",
    grund: 0, medium: "Karte + App", laender: "DE (Ladenetz-Verbund)",
    preise: { swm: { ac: 0.49, dc: 0.69 } },
    roaming: null,
    blockier: "Je Säule; an SWM-Säulen moderat.",
    hinweis: "Neu ab 1.7.2026. Für deine AC-Säulen ums Eck in München.",
    basisEmpfehlung: true,
  },
  {
    id: "swm-komfort", name: "SWM Ladekarte Komfort", kategorie: "abo",
    bestellLink: "https://www.swm.de/elektromobilitaet/oeffentliche-ladestationen/ladekarte-e-auto",
    einmalKosten: 11.90, einmalHinweis: "11,90 € je Kartenbestellung — auch Ersatz-/Zusatzkarte (Preisblatt swm.de, Stand 07/2026)", bindung: "monatlich kündbar",
    grund: 4.95, medium: "Karte + App", laender: "DE (Ladenetz-Verbund)",
    preise: { swm: { ac: 0.44, dc: 0.64 } },
    roaming: null,
    hinweis: "Neu ab 1.7.2026. Lohnt ab ~99 kWh/Monat an SWM-Säulen gegenüber Flex.",
  },
  {
    id: "swm-pro", name: "SWM Ladekarte Pro", kategorie: "abo",
    bestellLink: "https://www.swm.de/elektromobilitaet/oeffentliche-ladestationen/ladekarte-e-auto",
    einmalKosten: 11.90, einmalHinweis: "11,90 € je Kartenbestellung — auch Ersatz-/Zusatzkarte (Preisblatt swm.de, Stand 07/2026)", bindung: "monatlich kündbar",
    grund: 14.95, medium: "Karte + App", laender: "DE (Ladenetz-Verbund)",
    preise: { swm: { ac: 0.42, dc: 0.54 } },
    roaming: null,
    hinweis: "Neu ab 1.7.2026. Nur für Viellader an SWM-Säulen.",
  },
  {
    id: "aral-klassik", name: "Aral pulse Klassik", kategorie: "frei",
    bestellLink: "https://www.aral-pulse.de/",
    grund: 0, medium: "nur App", laender: "DE",
    preise: { aral: { ac: 0.47, dc: 0.62 } },
    roaming: null,
    hinweis: "Seit 1.7.2026 um 7 ct gesenkt. DC bis 50 kW sogar 0,52. Kostenlos, nur App-Registrierung.",
    basisEmpfehlung: true,
  },
  {
    id: "aral-extra", name: "Aral pulse Extra", kategorie: "abo",
    bestellLink: "https://www.aral-pulse.de/",
    bindung: "monatlich kündbar",
    grund: 2.99, medium: "nur App", laender: "DE",
    preise: { aral: { ac: 0.41, dc: 0.54 } },
    roaming: null,
    hinweis: "HPC 0,54, DC bis 50 kW 0,46, AC 0,41. Lohnt ab ~37 kWh/Monat an Aral pulse.",
  },
  {
    id: "adac-echarge", name: "ADAC e-Charge (Aral pulse)", kategorie: "frei",
    bestellLink: "https://www.adac.de/services/adac-e-charge/",
    einmalKosten: 0,
    grund: 0, medium: "Karte + App", laender: "DE + Roaming",
    voraussetzung: "ADAC-Mitgliedschaft erforderlich",
    preise: { aral: { ac: 0.55, dc: 0.55 } },
    roaming: { ac: 0.75, dc: 0.75 },
    hinweis: "Nur sinnvoll, wenn du eh ADAC-Mitglied bist — der Klassik-Tarif (App) ist an Aral inzwischen günstiger (AC 0,47), nur bei HPC ist e-Charge mit 0,55 vs. 0,62 vorn.",
  },
  {
    id: "ionity-motion", name: "Ionity Motion", kategorie: "abo",
    bestellLink: "https://ionity.eu/de/netzwerk-und-preise",
    bindung: "monatlich kündbar (Jahresvariante: 12 Monate)",
    grund: 5.99, jahresAlternative: "59,99 €/Jahr (Motion 365)", medium: "nur App", laender: "Europaweit an Ionity",
    preise: { ionity: { dc: 0.53 } },
    roaming: null,
    hinweis: "Seit 1.7.2026: 0,53 (vorher 0,49). Monatlich kündbar — ideal, um es nur für Reisemonate zu buchen.",
  },
  {
    id: "ionity-power", name: "Ionity Power", kategorie: "abo",
    bestellLink: "https://ionity.eu/de/netzwerk-und-preise",
    bindung: "monatlich kündbar",
    grund: 11.99, medium: "nur App", laender: "Europaweit an Ionity",
    preise: { ionity: { dc: 0.44, unsicher: true } },
    roaming: null,
    hinweis: "Preis nach der Erhöhung zum 1.7.2026 bitte in der Ionity-App prüfen (Abos starteten zuvor ab 0,39).",
  },
  {
    id: "ionity-go", name: "Ionity Go (App, ohne Abo)", kategorie: "frei",
    bestellLink: "https://ionity.eu/de/netzwerk-und-preise",
    grund: 0, medium: "nur App", laender: "Europaweit an Ionity",
    preise: { ionity: { dc: 0.66 } },
    roaming: null,
    hinweis: "Ohne Grundgebühr. Ad-hoc an der Säule (Ionity Direct) kostet 0,69.",
  },
  {
    id: "tesla-app", name: "Tesla-App (ohne Abo)", kategorie: "frei",
    bestellLink: "https://www.tesla.com/de_de/charging",
    grund: 0, medium: "nur App", laender: "Europaweit an Superchargern",
    preise: { tesla: { dc: 0.61, unsicher: true } },
    roaming: null,
    hinweis: "0,55–0,68 je Standort und Uhrzeit (morgens oft günstiger) — hier mit 0,61 gerechnet. Rund 240 Standorte in DE, Großteil für Fremdmarken offen.",
    basisEmpfehlung: true,
  },
  {
    id: "tesla-abo", name: "Tesla Supercharger-Mitgliedschaft", kategorie: "abo",
    bestellLink: "https://www.tesla.com/de_de/charging",
    bindung: "monatlich kündbar",
    grund: 9.99, jahresAlternative: "100 €/Jahr", medium: "nur App", laender: "Europaweit an Superchargern",
    preise: { tesla: { dc: 0.47, unsicher: true } },
    roaming: null,
    hinweis: "0,42–0,51 je Standort — hier mit 0,47 gerechnet. Monatlich kündbar, gut für Urlaubsmonate (Supercharger auch in SI/HR).",
  },
  {
    id: "ewego", name: "EWE Go", kategorie: "frei",
    bestellLink: "https://www.ewe-go.de/",
    einmalKosten: 0,
    grund: 0, medium: "Karte + App", laender: "DE + Roaming",
    preise: { ewego: { ac: 0.52, dc: 0.52 } },
    roaming: { ac: 0.62, dc: 0.62 },
    blockier: "Keine Blockiergebühr!",
    blockierAbMin: { ac: null, dc: null },
    hinweis: "Transparent und ohne jede Zusatzgebühr. Interessant Richtung NRW (Oberhausen!) und als Backup: 0,62 überall im Roaming.",
  },
  {
    id: "kaufland-app", name: "Lidl/Kaufland (Kaufland-App)", kategorie: "frei",
    bestellLink: "https://www.kaufland.de/services/e-laden.html",
    grund: 0, medium: "nur App", laender: "DE (nur eigene Filialen)",
    preise: { lidl: { ac: 0.29, dc: 0.47 } },
    roaming: null,
    hinweis: "DC 0,44, HPC ab 150 kW 0,47 — regelmäßig Aktionen (Juni 2026: 0,27!). Einmalig Kaufland Pay in der App freischalten. Perfekt: Laden beim Wocheneinkauf.",
    basisEmpfehlung: true,
  },
  {
    id: "aldi-app", name: "Aldi Süd (App/Girocard)", kategorie: "frei",
    bestellLink: "https://www.e-ladestation.aldi-sued.de/",
    einmalKosten: 0,
    grund: 0, medium: "nur App", laender: "DE (nur eigene Filialen, Süd-/Westdeutschland)",
    preise: { aldi: { ac: 0.29, dc: 0.47 } },
    roaming: null,
    blockier: "Keine Blockiergebühr — aber Laden nur zu Öffnungszeiten.",
    blockierAbMin: { ac: null, dc: null },
    hinweis: "AC 0,29 — DC 0,44 (ab 50 kW) bzw. 0,47 (HPC ab 150 kW). Keine Grundgebühr. ~1.800 Ladepunkte an über 700 Filialen (auch München-Großhadern). Zahlung per QR/App oder Girocard/Kreditkarte direkt an der Säule — geht also sogar ganz ohne Registrierung.",
    basisEmpfehlung: true,
  },
  {
    id: "qwello-app", name: "Qwello (App)", kategorie: "frei",
    bestellLink: "https://www.qwello.eu/de/",
    grund: 0, medium: "nur App", laender: "DE (München u. a.)",
    preise: { qwello: { ac: 0.55, unsicher: true } },
    roaming: null,
    hinweis: "AC-Säulen am Straßenrand in München. Preis + Standzeitgebühr vor dem Laden in der Qwello-App prüfen.",
  },
  {
    id: "electroverse", name: "Octopus Electroverse", kategorie: "frei",
    bestellLink: "https://electroverse.octopus.energy/de",
    einmalKosten: 0,
    grund: 0, medium: "Karte + App", laender: "EU-weit, sehr großes Roaming",
    preise: {}, roaming: { ac: null, dc: null }, preisVariabel: true,
    hinweis: "Kostenlose Allrounder-Karte, Preis je Säule (in der App sichtbar). Bester Plan B im Ausland (SI/HR), wenn die Haupt-App streikt — kostet nichts im Stand-by.",
    basisEmpfehlung: true,
  },
  {
    id: "smart-charge", name: "smart charge@street (Hello smart)", kategorie: "frei",
    bestellLink: "https://de.smart.com/",
    einmalKosten: null, einmalHinweis: "Karte über die Hello-smart-App bestellen — ggf. einmalige Aktivierungsgebühr, wird dort vor der Bestellung angezeigt",
    grund: 0, medium: "Karte + App", laender: "Europaweit (200.000+ Punkte)",
    preise: {}, roaming: { ac: null, dc: null }, preisVariabel: true,
    hinweis: "Der markeneigene Tarif zu deinem #5: Go-Tarif ≈ 5 % Rabatt ggü. Peak, Preis je Säule in der Hello-smart-App. Ionity-Pakete (Flex/Max) zubuchbar — vor Langstrecke Preise mit Ionity Motion vergleichen. Ggf. einmalige Aktivierungsgebühr.",
  },
  {
    id: "adhoc", name: "Ad-hoc (Kreditkarte/QR an der Säule)", kategorie: "adhoc",
    grund: 0, medium: "Girocard/Kreditkarte", laender: "Überall",
    preise: { ionity: { dc: 0.69 } },
    roaming: { ac: 0.64, dc: 0.79 },
    hinweis: "Der Notnagel ohne jede Registrierung — typisch 0,59–0,89. Seit AFIR (EU-Regel) muss jede neue DC-Säule über 50 kW Kartenzahlung anbieten. Ionity Direct: 0,69.",
  },
];

/* ---------- Orte: leere Vorlagen — DU trägst deine Orte selbst ein ---------- */
const ORTE_DEFAULT = [
  { id: "heim-ac",  name: "Zuhause — Säule in der Nähe", netz: "swm", art: "ac", kwhMonat: 0,
    notiz: "Vorlage: Netz auswählen und deine geplanten kWh/Monat eintragen — erst dann rechnet die App damit." },
  { id: "heim-dc",  name: "Schnelllader in der Nähe", netz: "enbw", art: "dc", kwhMonat: 0,
    notiz: "Vorlage: für den schnellen Wochen-Ladestopp (20–30 min)." },
  { id: "einkauf",  name: "Einkaufen", netz: "lidl", art: "dc", kwhMonat: 0,
    notiz: "Vorlage: Laden während des Einkaufs — oft der günstigste DC-Strom." },
];

/* ---------- Reiseziele: KEINE Vorgaben — Trips entstehen über den Routen-Planer ---------- */
const TRIPS_DEFAULT = [];

/* ---------- Ladekurve smart #5 Brabus (Näherung) ----------
   [vonSoC, bisSoC, mittlere Ladeleistung kW] — kalibriert auf 10→80 % ≈ 18 min.
   Quelle: Herstellerangabe + Erfahrungswerte; bei kaltem Akku deutlich weniger. */
const LADEKURVE = [
  [0, 10, 200],
  [10, 40, 340],
  [40, 60, 260],
  [60, 80, 150],
  [80, 90, 80],
  [90, 100, 40],
];

/* ---------- Betreiber-Erkennung (OpenChargeMap → unsere Netze) ---------- */
const OPERATOR_MAP = [
  { netz: "enbw", muster: ["enbw"] },
  { netz: "aral", muster: ["aral", "bp pulse"] },
  { netz: "ionity", muster: ["ionity"] },
  { netz: "tesla", muster: ["tesla"] },
  { netz: "swm", muster: ["stadtwerke münchen", "stadtwerke muenchen", "swm"] },
  { netz: "qwello", muster: ["qwello"] },
  { netz: "lidl", muster: ["lidl", "kaufland", "schwarz"] },
  { netz: "aldi", muster: ["aldi"] },
  { netz: "ewego", muster: ["ewe"] },
];
function opZuNetz(opName) {
  const s = (opName || "").toLowerCase();
  for (const o of OPERATOR_MAP) if (o.muster.some(m => s.includes(m))) return o.netz;
  return null;
}

/* ---------- Netz-Abdeckung nach Ländern ----------
   Wo gibt es EIGENE Säulen des Netzes (dort gilt der Säulen-Bestpreis)?
   "EU" = praktisch überall auf der Route außer Bosnien. */
const NETZ_LAENDER = {
  enbw: ["DE", "AT", "CH"],
  aral: ["DE"], swm: ["DE"], lidl: ["DE"], aldi: ["DE"], ewego: ["DE"], qwello: ["DE"],
  ionity: "EU",
  tesla: "EU",
};
function netzDecktLand(netzId, land) {
  const l = NETZ_LAENDER[netzId];
  if (l === "EU") return land !== "BA";
  if (Array.isArray(l)) return l.includes(land);
  return land === "DE";
}

/* ---------- Länder-Wissen für Trips ---------- */
const LAENDER = {
  DE: {
    name: "Deutschland", flagge: "DE",
    laden: "Dichtes Netz: Ionity/EnBW/Aral an der Autobahn. Mit deinem Karten-Setup keine Planung nötig.",
    planB: "Ad-hoc mit Kreditkarte geht an fast jedem neuen Schnelllader (AFIR-Pflicht).",
    extras: [],
  },
  AT: {
    name: "Österreich", flagge: "AT",
    laden: "Gut ausgebaut. EnBW mobility+ und Ionity Motion funktionieren hier ganz normal.",
    planB: "SMATRICS-App oder ad-hoc mit Karte.",
    extras: [
      "Digitale Vignette VOR der Fahrt kaufen (asfinag.at — Achtung: nur offizielle Seite, Drittanbieter kosten mehr).",
      "A10 Tauern- & A11 Karawankentunnel: zusätzliche Streckenmaut (extra zur Vignette).",
    ],
  },
  SI: {
    name: "Slowenien", flagge: "SI",
    laden: "Ionity an der A1/A2; lokale Säulen über Petrol OneCharge oder Electroverse.",
    planB: "Electroverse-Karte oder ad-hoc.",
    extras: ["E-Vinjeta online kaufen (evinjeta.dars.si) — Kennzeichen genau prüfen, Fehler = Strafe."],
  },
  HR: {
    name: "Kroatien", flagge: "HR",
    laden: "ELEN-App (HEP) = größtes Netz, funktioniert mit Kreditkarte ohne physische Karte. Ionity + Tesla Supercharger an der A1/A3.",
    planB: "Electroverse; EnBW mobility+ roamt in HR (teurer). Tipp bei ELEN: Ladevorgang erst in der App starten, dann Stecker einstecken.",
    extras: ["Streckenmaut an Mautstationen (Karte/bar) — kein Vignettenkauf nötig."],
  },
  BA: {
    name: "Bosnien-Herzegowina", flagge: "BA",
    laden: "SEHR dünnes Ladenetz! Letzte verlässliche Schnelllader in Kroatien nutzen und mit vollem Akku über die Grenze. Vor der Reise Säulen auf PlugShare recherchieren und Screenshots offline speichern.",
    planB: "Dein Schuko-Ladegerät (Unterkunft, Familie) ist in BiH deine wichtigste Energiequelle. An 230 V lädt es ~2,3 kW: über Nacht (~10 h) ≈ 100–110 km Reichweite.",
    extras: [
      "Grüne Versicherungskarte PHYSISCH mitführen (BiH ist nicht EU) — rechtzeitig bei der Kfz-Versicherung anfordern und prüfen, dass BiH nicht ausgeschlossen ist!",
      "Kein EU-Datenroaming in BiH: vorab eSIM/Datenpaket buchen, sonst bist du an der Säule offline.",
      "Maut auf A1-Abschnitten (bar/Karte zahlbar).",
      "Lade-Apps brauchen oft lokale Registrierung — Kreditkarte + PlugShare-Recherche vorab sind Pflicht.",
    ],
  },
};

/* ---------- Wissen / Checklisten ---------- */
const WISSEN = [
  {
    id: "app-hilfe", titel: "❓ So funktioniert diese App",
    html: `
      <p><b>Der rote Faden:</b> Du pflegst einmal, <i>wo</i> du lädst und <i>welche Karten du hast</i> — die App rechnet daraus alles Weitere automatisch.</p>
      <ul class="dots">
        <li><b>Start:</b> Deine Kommandozentrale. Zeigt Monatskosten, automatische To-dos (einrichten/abonnieren/kündigen — immer mit Rechenbeispiel) und Warnungen. Hier auch: Daten exportieren/importieren fürs zweite Gerät.</li>
        <li><b>Orte:</b> Wo du regelmäßig lädst und wie viel (kWh/Monat). Jede Änderung rechnet sofort alles neu.</li>
        <li><b>Tarife:</b> Alle Karten & Abos mit Preisen (editierbar). Markiere mit „Hab ich“, was du besitzt. Der Chart zeigt, ab wie viel kWh/Monat sich ein Abo lohnt.</li>
        <li><b>Trips:</b> Oben Start + Ziel eingeben → die App plant die echte Route, setzt Ladestopps passend zu deinem #5 und empfiehlt die günstigste Karten-Kombi für genau diese Fahrt (inkl. „1 Monat Abo, dann kündigen“). Jeder Stopp lässt sich per Teilen ans Auto-Navi schicken. Dazu: Vorbereitungs-Checkliste mit Terminen.</li>
        <li><b>Fahren:</b> Für unterwegs. Oben: „Wie weit komme ich?“ (Akku-% oder Rest-km + dein Tempo). Mitte: Säulen in der Nähe finden → Maps/Teilen. Dann: „Ich stehe an Säule X — welche Karte nehme ich?“ mit Ausfallkette, Blockiergebühr-Timer und Lade-Logbuch (macht die App mit jeder Ladung präziser).</li>
        <li><b>Wissen:</b> Du bist hier. Kabel-Checkliste, erste Ladung, Plan B, Winter u. v. m.</li>
      </ul>
      <p><b>Typischer Ablauf vor einer großen Fahrt:</b> Trips → Route planen → empfohlene Karte/Abo einrichten (To-do auf Start) → Checkliste abhaken → losfahren → im Fahrmodus Stopps ans Navi teilen.</p>`
  },
  {
    id: "kabel", titel: "Kabel & Ausrüstung — was gehört ins Auto?",
    html: `
      <ul class="dots">
        <li><b>Typ-2-Ladekabel (Mode 3), 3-phasig 32 A / 22 kW:</b> Pflicht! Die meisten AC-Säulen haben <b>kein</b> festes Kabel. Dein #5 lädt AC mit vollen 22 kW — also kein dünneres 11-kW-Kabel kaufen. Prüfe, ob eins beim Auto dabei ist.</li>
        <li><b>Schuko-Notladegerät (Mode 2):</b> dein Plan B an jeder Haushaltssteckdose (Eltern, Hotel, Bosnien). Beim Kauf achten auf: <b>einstellbaren Ladestrom (6–10 A)</b> und <b>Temperaturfühler im Stecker</b> — z. B. die einfachen Marken-Ladeziegel ab ~150 €. Lädt ~2,3 kW ≈ 12 km pro Stunde, über Nacht ~100 km.</li>
        <li><b>Regel für fremde Schuko-Steckdosen:</b> auf max. 10 A stellen (im Zweifel 6–8 A), Stecker nach 30 min auf Wärme prüfen. Alte Leitungen (Altbau, Bosnien) sind der häufigste Brandherd.</li>
        <li><b>Verlängerung (falls nötig):</b> nur schwere Gummileitung ≥ 2,5 mm², Trommel IMMER voll abrollen.</li>
        <li><b>DC/CCS:</b> Kabel hängt immer fest an der Säule — dafür brauchst du nichts.</li>
        <li><b>Kleinkram:</b> Arbeitshandschuhe (dreckige Kabel), Taschenlampe, Kartenetui für Ladekarten in der Mittelkonsole.</li>
      </ul>`
  },
  {
    id: "erste-ladung", titel: "Deine erste Ladung — Schritt für Schritt",
    html: `
      <ol>
        <li>Säule in der App des Betreibers (oder EnBW-App) raussuchen — zeigt Preis + ob frei.</li>
        <li>Am DC-Lader: erst Karte/App autorisieren <i>oder</i> erst einstecken — die Säule sagt dir die Reihenfolge. Bei Problemen: andere Reihenfolge probieren.</li>
        <li>Stecker fest bis zum Klick einstecken. Das Auto verriegelt automatisch.</li>
        <li>Warten bis die Ladung wirklich läuft (Anzeige im Auto!), erst dann weggehen.</li>
        <li>Beenden: in App/Karte stoppen → Auto entriegelt den Stecker. Zieht er nicht: Auto aufschließen, ggf. Entriegelung im Display.</li>
        <li><b>Beim Smart wichtig:</b> Ladeziel im Auto auf 80 % für den Alltag stellen; 100 % nur direkt vor Langstrecken.</li>
      </ol>`
  },
  {
    id: "vorkonditionierung", titel: "Schnellladen: Akku-Vorkonditionierung nutzen",
    html: `
      <p>Dein 800-V-Akku lädt die vollen 400 kW nur, wenn er <b>warm</b> ist. Gib den Schnelllader als Ziel ins <b>Auto-Navi</b> ein — dann heizt der #5 den Akku rechtzeitig vor. Ohne Vorkonditionierung (besonders im Winter) lädst du statt 18 min auch mal 40+ min.</p>
      <p>Faustregel Ladehub 10→80 % (66 kWh): warm ≈ 18–22 min, kalt ohne Vorkonditionierung deutlich länger.</p>`
  },
  {
    id: "blockier", titel: "Blockiergebühren — die versteckten Kosten",
    html: `
      <p>Fast alle Anbieter berechnen nach einer Standzeit extra (meist ~10 ct/min):</p>
      <ul class="dots">
        <li><b>DC:</b> oft schon nach 45–60 min → beim Schnellladen in der Nähe bleiben, bei 80 % ist eh Schluss mit schnell.</li>
        <li><b>AC:</b> meist nach 3–4 h; manche Städte auch nachts pausiert — steht im Tarif-Detail.</li>
        <li><b>EWE Go</b> hat gar keine Blockiergebühr, <b>Maingau</b> deckelt bei 12 €/Vorgang.</li>
      </ul>
      <p>Übernacht-Laden an AC nur dort, wo die Gebühr nachts pausiert oder keine anfällt — sonst wird die Nacht teurer als der Strom.</p>`
  },
  {
    id: "adhoc-afir", titel: "Plan B ist Gesetz: Ad-hoc-Laden",
    html: `
      <p>Seit der EU-Verordnung AFIR muss jede <b>neue DC-Säule über 50 kW Kartenzahlung</b> (Girocard/Kreditkarte oder QR-Code) anbieten. Heißt für dich: Selbst wenn alle Apps und Karten streiken, kommst du an fast jedem modernen Schnelllader mit der normalen Kreditkarte weiter — nur eben zum teuersten Preis (0,59–0,89 €/kWh).</p>
      <p>Deine Ausfall-Kette an jeder Säule: 1) Hauptkarte → 2) Zweitkarte/App → 3) Ad-hoc QR/Kreditkarte → 4) Hotline des Betreibers (Nummer klebt auf der Säule) → 5) nächster Standort (nie unter 10 % ansteuern).</p>`
  },
  {
    id: "winter", titel: "Winter: rechne mit 20–30 % Mehrverbrauch",
    html: `
      <p>Kälte kostet Reichweite (Heizung + kalter Akku). Der Trip-Planer hat dafür den Winter-Schalter. Zusätzlich:</p>
      <ul class="dots">
        <li>Vorklimatisieren, solange das Auto noch an der Säule hängt (per Hello-smart-App).</li>
        <li>Sitz-/Lenkradheizung statt voller Innenraumheizung spart am meisten.</li>
        <li>Vorkonditionierung vor DC-Stopps ist im Winter Pflicht (siehe oben).</li>
      </ul>`
  },
  {
    id: "akku", titel: "Akku-Pflege beim #5 (NMC)",
    html: `
      <ul class="dots">
        <li>Alltag: Ladeziel 80 %, laden wenn < 20 % — das hält den Akku jung.</li>
        <li>100 % nur direkt vor der Abfahrt auf Langstrecke, nicht tagelang voll stehen lassen.</li>
        <li>DC-Schnellladen ist okay und schadet bei diesem Akku im normalen Umfang nicht — Komfort geht vor.</li>
      </ul>`
  },
  {
    id: "ziel-ans-auto", titel: "Ladesäule ans Navi senden (smart #5 / Google Maps)",
    html: `
      <p>Im <b>Fahrmodus</b> hat jede gefundene Säule zwei Knöpfe:</p>
      <ul class="dots">
        <li><b>🗺 Google Maps:</b> öffnet die Navigation direkt zur Säule.</li>
        <li><b>📤 Teilen:</b> öffnet das Android-Teilen-Menü — dort <b>Hello smart</b> auswählen, dann landet das Ziel im Navi deines #5. (Genau so ist es beim smart gedacht: Ziel aus einer Karten-App ans Auto teilen.) Alternativ an Google Maps oder WhatsApp teilen.</li>
      </ul>
      <p>Am PC (Doppelklick-Variante) gibt es kein Teilen-Menü — dort kopiert der Knopf den Link in die Zwischenablage.</p>`
  },
  {
    id: "ladefuchs", titel: "Ladefuchs & Chargeprice: der Live-Preischeck",
    html: `
      <p>Die App, die an jeder Säule <b>alle Preis-Kombinationen</b> (eigene Karte, Fremdkarte/Roaming, Ad-hoc, mit/ohne Abo) zeigt, heißt <b>Ladefuchs</b> (kostenlos, Android/iOS) — die Daten kommen von <b>Chargeprice</b>. Diese Live-Daten sind lizenzpflichtig und lassen sich nicht in eine private App einbetten.</p>
      <p><b>Arbeitsteilung:</b> Diese App hier plant mit <i>deinen</i> Tarifen, Orten und Trips (Break-even, Abo-Timing, Checklisten) und verlinkt für den Spot-Check an einer unbekannten Säule direkt auf chargeprice.app/Ladefuchs. Vor dem Laden an einer fremden Säule: 10 Sekunden Ladefuchs-Blick.</p>`
  },
  {
    id: "abrp", titel: "ABRP als Ergänzung für die Live-Routenführung",
    html: `
      <p><b>A Better Routeplanner (ABRP)</b> ist der Spezialist für Live-Langstrecken-Routing: Höhenprofil, Wetter, Verkehr, Ladekurven, Belegung der Säulen in Echtzeit, optional Live-SoC per OBD-Dongle. Das ist mit Karten- und Wetterdiensten verbunden und als Offline-Eigenbau nicht sinnvoll nachbaubar.</p>
      <p><b>Was diese App davon übernommen hat:</b> das Verbrauchsmodell nach Tempo, die Ladekurve deines #5 (10→80 % ≈ 18 min), Etappen-/Stopp-Planung und das Reichweiten-Cockpit („Schaffe ich es bis Säule X?“).</p>
      <p><b>Empfohlene Kombi auf großer Fahrt:</b> ABRP (oder das Auto-Navi) führt dich zur Säule — diese App sagt dir, <b>mit welcher Karte du dort am günstigsten lädst</b>, was ABRP nicht gut kann. Fürs Fahrzeugprofil in ABRP: smart #5 Brabus auswählen, max. Ladeziel 80 %.</p>`
  },
  {
    id: "sichern", titel: "Profil-Sicherung auf dem Pi (mehrere Nutzer)",
    html: `
      <p>Jedes Gerät hat seinen <b>eigenen</b> Speicherstand — du, dein Schwager auf dem iPhone, jeder für sich. Zusätzlich kann jeder sein Profil unter eigenem Namen auf deinem Home Assistant sichern und auf einem neuen Gerät wieder laden (Start → „Daten &amp; Updates“ → Profilname + ☁-Knöpfe).</p>
      <p><b>Einmalige Einrichtung in Home Assistant</b> — in die <code>configuration.yaml</code> (File editor) einfügen, dann HA neu starten:</p>
      <pre>shell_command:
  lkc_profil_speichern: >-
    mkdir -p /config/www/ladekarten &&
    echo {{ b64 }} | base64 -d >
    /config/www/ladekarten/profil-{{ profil }}.json

automation lkc:
  - alias: "Ladekarten-Profil sichern"
    trigger:
      - platform: webhook
        webhook_id: lkc-profil-sichern
        local_only: false
    action:
      - service: shell_command.lkc_profil_speichern
        data:
          profil: "{{ trigger.json.profil | regex_replace('[^a-z0-9-]','') }}"
          b64: "{{ trigger.json.b64 | regex_replace('[^A-Za-z0-9+/=]','') }}"</pre>
      <p class="small">Tipp: Die <code>webhook_id</code> kannst du in einen eigenen Geheimnamen ändern — dann in der App unter dem Profilnamen-Feld dieselbe ID eintragen.</p>`
  },
  {
    id: "preise", titel: "Preise: aktualisieren sich von selbst",
    html: `
      <p><b>Du musst hier nichts tun:</b> Jeden <b>Montag</b> recherchiert ein Cloud-Dienst (GitHub + Gemini) automatisch alle Tarife neu, prüft sie auf Plausibilität und stellt sie bereit — die App übernimmt neue Stände bei jedem Öffnen von selbst. Auf der <b>Start</b>-Seite kannst du zusätzlich jederzeit per Knopf „Jetzt nach Tarif-Updates suchen“ sofort prüfen.</p>
      <p>Geprüft werden dabei nicht nur die kWh-Preise, sondern auch <b>Kartengebühren</b> (einmalige Kosten), Bindungsfristen, laufende <b>Aktionen</b> und die Bestell-Links zu den Anbietern.</p>
      <p><b>Deine Eingaben gehen bei Updates nie verloren:</b> Orte, Karten, Trips und Logbuch liegen im Browser-Speicher deines Geräts — eine neue App-Version liest sie einfach weiter. Vor jeder internen Daten-Umstellung legt die App zusätzlich automatisch eine Sicherungskopie an.</p>
      <p>Deine eigenen Preis-Änderungen (unter <b>Tarife → Preise ändern</b>) sind geschützt und werden nie automatisch überschrieben. Als doppeltes Netz warnt die App, falls der Preisstand je älter als 60 Tage würde (z. B. wenn der Cloud-Dienst länger ausfällt — dann bekommst du auch eine E-Mail von GitHub).</p>
      <p>Schnell-Check vor Ort: EnBW-App (zeigt Preise aller Säulen), Ladefuchs, chargeprice.app.</p>`
  },
];
