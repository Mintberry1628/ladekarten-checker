/* ============================================================
   Ladekarten-Checker — Datenbasis
   Preisstand: 7. Juli 2026 (recherchiert). Alle Preise in €/kWh,
   Grundgebühren in €/Monat. Preise sind in der App editierbar.
   ============================================================ */

const PREISSTAND = "2026-07-07";

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
  { id: "ewego",   name: "EWE Go",                kurz: "EWE Go",    typ: "AC+DC", info: "Eigene Säulen v. a. im Nordwesten (auch NRW) + großes Roaming." },
  { id: "dc-fremd", name: "Sonstiger Schnelllader", kurz: "Andere DC", typ: "DC",  info: "Allego, E.ON, Pfalzwerke & Co. — läuft über Roaming-Preise." },
  { id: "ac-fremd", name: "Sonstige AC-Säule",    kurz: "Andere AC", typ: "AC",    info: "Beliebige fremde AC-Säule — läuft über Roaming-Preise." },
  { id: "schuko",  name: "Steckdose / NRGkick",   kurz: "Steckdose", typ: "AC",    info: "Haushalts- oder CEE-Steckdose (Familie, Hotel) mit deinem NRGkick." },
];

/* ---------- Tarife / Ladekarten ----------
   preise: feste Preise je Netz { netzId: {ac, dc} }
   roaming: Fallback für alle anderen Netze
   null = an diesem Netz nicht (sinnvoll) nutzbar
   unsicher = Preis vor Nutzung in der Anbieter-App prüfen  */
const TARIFE_DEFAULT = [
  {
    id: "maingau", name: "Maingau EinfachStromLaden", kategorie: "frei",
    grund: 0, medium: "Karte + App", laender: "EU-weit (inkl. AT/SI/HR)",
    preise: { ionity: { dc: 0.62 } },
    roaming: { ac: 0.52, dc: 0.62 },
    blockier: "Standzeitgebühr 10 ct/min (AC nach 4 h, DC nach 1 h), gedeckelt bei 12 €/Ladevorgang.",
    hinweis: "Seit 1.7.2026 gestaffelte Preise je Säule: Niedrig 0,52 (AC) / 0,62 (DC) — Standard 0,72 — Hoch 0,82. Preis vor dem Laden in der App prüfen! Ionity bleibt in der Niedrigpreis-Stufe (0,62). Maingau-Energiekunden zahlen je 10 ct weniger.",
    basisEmpfehlung: true,
  },
  {
    id: "enbw-s", name: "EnBW mobility+ S", kategorie: "frei",
    grund: 0, medium: "Karte + App", laender: "DE, AT, CH u. a. (HyperNetz)",
    preise: { enbw: { ac: 0.51, dc: 0.51 }, ionity: { dc: 0.89, unsicher: true } },
    roaming: { ac: 0.69, dc: 0.69 },
    blockier: "Blockiergebühr nach 4 h Standzeit.",
    hinweis: "Sommeraktion Juli–Sept. 2026: 0,51 statt 0,56 an EnBW-Säulen. Roaming im HyperNetz 0,56–0,89 je Betreiber (hier mit 0,69 gerechnet — in der App je Säule prüfen).",
    basisEmpfehlung: true,
  },
  {
    id: "enbw-m", name: "EnBW mobility+ M", kategorie: "abo",
    grund: 5.99, medium: "Karte + App", laender: "DE, AT, CH u. a. (HyperNetz)",
    preise: { enbw: { ac: 0.41, dc: 0.41 }, ionity: { dc: 0.79, unsicher: true } },
    roaming: { ac: 0.60, dc: 0.60 }, roamingUnsicher: true,
    blockier: "Blockiergebühr nach 4 h Standzeit.",
    hinweis: "Sommeraktion Juli–Sept. 2026: 0,41 statt 0,46 an EnBW-Säulen. Monatlich kündbar. Roaming-Preise je Betreiber in der App prüfen.",
  },
  {
    id: "enbw-l", name: "EnBW mobility+ L", kategorie: "abo",
    grund: 11.99, medium: "Karte + App", laender: "DE, AT, CH u. a. (HyperNetz)",
    preise: { enbw: { ac: 0.34, dc: 0.34 }, ionity: { dc: 0.79, unsicher: true } },
    roaming: { ac: 0.55, dc: 0.55 }, roamingUnsicher: true,
    blockier: "Blockiergebühr nach 4 h Standzeit.",
    hinweis: "Sommeraktion: 0,34 statt 0,39 an EnBW-Säulen (EnBW-Strom-/Gaskunden sogar 0,30). Monatlich kündbar.",
  },
  {
    id: "swm-flex", name: "SWM Ladekarte Flex", kategorie: "frei",
    grund: 0, medium: "Karte + App", laender: "DE (Ladenetz-Verbund)",
    preise: { swm: { ac: 0.49, dc: 0.69 } },
    roaming: null,
    blockier: "Je Säule; an SWM-Säulen moderat.",
    hinweis: "Neu ab 1.7.2026. Für deine AC-Säulen ums Eck in München.",
    basisEmpfehlung: true,
  },
  {
    id: "swm-komfort", name: "SWM Ladekarte Komfort", kategorie: "abo",
    grund: 4.95, medium: "Karte + App", laender: "DE (Ladenetz-Verbund)",
    preise: { swm: { ac: 0.44, dc: 0.64 } },
    roaming: null,
    hinweis: "Neu ab 1.7.2026. Lohnt ab ~99 kWh/Monat an SWM-Säulen gegenüber Flex.",
  },
  {
    id: "swm-pro", name: "SWM Ladekarte Pro", kategorie: "abo",
    grund: 14.95, medium: "Karte + App", laender: "DE (Ladenetz-Verbund)",
    preise: { swm: { ac: 0.42, dc: 0.54 } },
    roaming: null,
    hinweis: "Neu ab 1.7.2026. Nur für Viellader an SWM-Säulen.",
  },
  {
    id: "aral-klassik", name: "Aral pulse Klassik", kategorie: "frei",
    grund: 0, medium: "nur App", laender: "DE",
    preise: { aral: { ac: 0.47, dc: 0.62 } },
    roaming: null,
    hinweis: "Seit 1.7.2026 um 7 ct gesenkt. DC bis 50 kW sogar 0,52. Kostenlos, nur App-Registrierung.",
    basisEmpfehlung: true,
  },
  {
    id: "aral-extra", name: "Aral pulse Extra", kategorie: "abo",
    grund: 2.99, medium: "nur App", laender: "DE",
    preise: { aral: { ac: 0.41, dc: 0.54 } },
    roaming: null,
    hinweis: "HPC 0,54, DC bis 50 kW 0,46, AC 0,41. Lohnt ab ~37 kWh/Monat an Aral pulse.",
  },
  {
    id: "adac-echarge", name: "ADAC e-Charge (Aral pulse)", kategorie: "frei",
    grund: 0, medium: "Karte + App", laender: "DE + Roaming",
    voraussetzung: "ADAC-Mitgliedschaft erforderlich",
    preise: { aral: { ac: 0.55, dc: 0.55 } },
    roaming: { ac: 0.75, dc: 0.75 },
    hinweis: "Nur sinnvoll, wenn du eh ADAC-Mitglied bist — der Klassik-Tarif (App) ist an Aral inzwischen günstiger (AC 0,47), nur bei HPC ist e-Charge mit 0,55 vs. 0,62 vorn.",
  },
  {
    id: "ionity-motion", name: "Ionity Motion", kategorie: "abo",
    grund: 5.99, jahresAlternative: "59,99 €/Jahr (Motion 365)", medium: "nur App", laender: "Europaweit an Ionity",
    preise: { ionity: { dc: 0.53 } },
    roaming: null,
    hinweis: "Seit 1.7.2026: 0,53 (vorher 0,49). Monatlich kündbar — ideal, um es nur für Reisemonate zu buchen.",
  },
  {
    id: "ionity-power", name: "Ionity Power", kategorie: "abo",
    grund: 11.99, medium: "nur App", laender: "Europaweit an Ionity",
    preise: { ionity: { dc: 0.44, unsicher: true } },
    roaming: null,
    hinweis: "Preis nach der Erhöhung zum 1.7.2026 bitte in der Ionity-App prüfen (Abos starteten zuvor ab 0,39).",
  },
  {
    id: "ionity-go", name: "Ionity Go (App, ohne Abo)", kategorie: "frei",
    grund: 0, medium: "nur App", laender: "Europaweit an Ionity",
    preise: { ionity: { dc: 0.66 } },
    roaming: null,
    hinweis: "Ohne Grundgebühr. Ad-hoc an der Säule (Ionity Direct) kostet 0,69.",
  },
  {
    id: "tesla-app", name: "Tesla-App (ohne Abo)", kategorie: "frei",
    grund: 0, medium: "nur App", laender: "Europaweit an Superchargern",
    preise: { tesla: { dc: 0.61, unsicher: true } },
    roaming: null,
    hinweis: "0,55–0,68 je Standort und Uhrzeit (morgens oft günstiger) — hier mit 0,61 gerechnet. Rund 240 Standorte in DE, Großteil für Fremdmarken offen.",
    basisEmpfehlung: true,
  },
  {
    id: "tesla-abo", name: "Tesla Supercharger-Mitgliedschaft", kategorie: "abo",
    grund: 9.99, jahresAlternative: "100 €/Jahr", medium: "nur App", laender: "Europaweit an Superchargern",
    preise: { tesla: { dc: 0.47, unsicher: true } },
    roaming: null,
    hinweis: "0,42–0,51 je Standort — hier mit 0,47 gerechnet. Monatlich kündbar, gut für Urlaubsmonate (Supercharger auch in SI/HR).",
  },
  {
    id: "ewego", name: "EWE Go", kategorie: "frei",
    grund: 0, medium: "Karte + App", laender: "DE + Roaming",
    preise: { ewego: { ac: 0.52, dc: 0.52 } },
    roaming: { ac: 0.62, dc: 0.62 },
    blockier: "Keine Blockiergebühr!",
    hinweis: "Transparent und ohne jede Zusatzgebühr. Interessant Richtung NRW (Oberhausen!) und als Backup: 0,62 überall im Roaming.",
  },
  {
    id: "kaufland-app", name: "Lidl/Kaufland (Kaufland-App)", kategorie: "frei",
    grund: 0, medium: "nur App", laender: "DE (nur eigene Filialen)",
    preise: { lidl: { ac: 0.29, dc: 0.47 } },
    roaming: null,
    hinweis: "DC 0,44, HPC ab 150 kW 0,47 — regelmäßig Aktionen (Juni 2026: 0,27!). Einmalig Kaufland Pay in der App freischalten. Perfekt: Laden beim Wocheneinkauf.",
    basisEmpfehlung: true,
  },
  {
    id: "qwello-app", name: "Qwello (App)", kategorie: "frei",
    grund: 0, medium: "nur App", laender: "DE (München u. a.)",
    preise: { qwello: { ac: 0.55, unsicher: true } },
    roaming: null,
    hinweis: "AC-Säulen am Straßenrand in München. Preis + Standzeitgebühr vor dem Laden in der Qwello-App prüfen.",
  },
  {
    id: "electroverse", name: "Octopus Electroverse", kategorie: "frei",
    grund: 0, medium: "Karte + App", laender: "EU-weit, sehr großes Roaming",
    preise: {}, roaming: { ac: null, dc: null }, preisVariabel: true,
    hinweis: "Kostenlose Allrounder-Karte, Preis je Säule (in der App sichtbar). Bester Plan B im Ausland (SI/HR), wenn die Haupt-App streikt — kostet nichts im Stand-by.",
    basisEmpfehlung: true,
  },
  {
    id: "smart-charge", name: "smart charge@street (Hello smart)", kategorie: "frei",
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

/* ---------- Orte (Voreinstellung für Nino) ---------- */
const ORTE_DEFAULT = [
  { id: "heim-ac",  name: "Zuhause München — AC ums Eck", netz: "swm", art: "ac", kwhMonat: 80,
    notiz: "Kein eigener Stellplatz: SWM-/Qwello-Säulen in der Nähe. Über Nacht ist AC entspannter & günstiger als DC." },
  { id: "heim-dc",  name: "Zuhause München — Schnelllader", netz: "enbw", art: "dc", kwhMonat: 50,
    notiz: "EnBW-Hub oder Aral pulse für den schnellen Wochen-Ladestopp (20–30 min)." },
  { id: "einkauf",  name: "Einkaufen (Lidl/Kaufland)", netz: "lidl", art: "dc", kwhMonat: 40,
    notiz: "Laden während des Wocheneinkaufs — meist der günstigste DC-Strom überhaupt." },
  { id: "arbeit",   name: "Arbeit", netz: "ac-fremd", art: "ac", kwhMonat: 0,
    notiz: "Kein Laden möglich. Falls sich das ändert: kWh hier eintragen." },
  { id: "eltern",   name: "Eltern", netz: "schuko", art: "ac", kwhMonat: 30,
    notiz: "NRGkick an Steckdose/CEE — bei längeren Besuchen füllt sich der Akku nebenbei." },
];

/* ---------- Reiseziele (Voreinstellung) ---------- */
const TRIPS_DEFAULT = [
  {
    id: "fojnica", ziel: "Fojnica (Bosnien)", hinKm: 920,
    laender: ["DE", "AT", "SI", "HR", "BA"],
    tageVorOrt: 14, kmVorOrt: 300, datum: "",
    zielLaden: "schuko",
    // Streckenanteile fürs DC-Laden (BA zählt zu HR: letzter Ladestopp vor der Grenze)
    anteile: { DE: 0.32, AT: 0.20, SI: 0.15, HR: 0.33 },
    routeNotiz: "München → Salzburg → Villach → Ljubljana → Zagreb → Banja Luka → Fojnica. Distanz bitte einmal mit deinem Navi abgleichen.",
  },
  {
    id: "oberhausen", ziel: "Oberhausen (NRW)", hinKm: 615,
    laender: ["DE"],
    tageVorOrt: 3, kmVorOrt: 100, datum: "",
    zielLaden: "ewego",
    routeNotiz: "München → Nürnberg → Würzburg → Frankfurt → Köln → Oberhausen (A9/A3). Ionity + EnBW liegen direkt an der Strecke; vor Ort ist EWE Go in NRW gut vertreten.",
  },
];

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
  aral: ["DE"], swm: ["DE"], lidl: ["DE"], ewego: ["DE"], qwello: ["DE"],
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
    planB: "Dein NRGkick an Schuko/CEE (Unterkunft, Familie, Werkstätten) ist in BiH deine wichtigste Energiequelle. Über Nacht an 230 V ≈ +25–35 km Reichweite pro Stunde Fahrt… pro ~10 h Laden ≈ 100–130 km.",
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
        <li><b>Fahren:</b> Für unterwegs. Oben: „Wie weit komme ich?“ (Akku-% oder Rest-km + dein Tempo). Mitte: Säulen in der Nähe finden → Maps/Teilen. Unten: „Ich stehe an Säule X — welche Karte nehme ich?“ mit Ausfallkette.</li>
        <li><b>Wissen:</b> Du bist hier. Kabel-Checkliste, erste Ladung, Plan B, Winter u. v. m.</li>
      </ul>
      <p><b>Typischer Ablauf vor einer großen Fahrt:</b> Trips → Route planen → empfohlene Karte/Abo einrichten (To-do auf Start) → Checkliste abhaken → losfahren → im Fahrmodus Stopps ans Navi teilen.</p>`
  },
  {
    id: "kabel", titel: "Kabel & Ausrüstung — was gehört ins Auto?",
    html: `
      <ul class="dots">
        <li><b>Typ-2-Ladekabel (Mode 3), 3-phasig 32 A / 22 kW:</b> Pflicht! Die meisten AC-Säulen haben <b>kein</b> festes Kabel. Dein #5 lädt AC mit vollen 22 kW — also kein dünneres 11-kW-Kabel kaufen. Prüfe, ob eins beim Auto dabei ist.</li>
        <li><b>NRGkick (hast du):</b> deine Geheimwaffe. Dazu gehören die Adapter: <b>Schuko</b>, <b>CEE blau 16 A</b> (Camping), <b>CEE rot 16 A und 32 A</b> (Kraftstrom, lädt bis 11/22 kW). Für Bosnien unbezahlbar.</li>
        <li><b>Regel für fremde Schuko-Steckdosen:</b> auf max. 10 A drosseln, Stecker nach 30 min auf Wärme prüfen. Alte Leitungen (Altbau, Bosnien) sind der häufigste Brandherd.</li>
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
    id: "preise", titel: "Preise pflegen",
    html: `
      <p>Ladepreise ändern sich alle paar Monate (zuletzt: Maingau-Staffelung, SWM-Reform und Ionity-Erhöhung zum 1.7.2026, EnBW-Sommeraktion). Alle Preise dieser App sind unter <b>Tarife</b> editierbar. Die App erinnert dich, wenn der Preisstand älter als 60 Tage ist.</p>
      <p>Schnell-Check: EnBW-App (zeigt Preise aller Säulen), ladetarif-vergleich.herrmittmann.de.</p>`
  },
];
