/* ============================================================
   Ladekarten-Checker — Logik & Ansichten
   ============================================================ */
"use strict";

const DATA_VERSION = 7;
const LS_KEY = "lkc-state-v1";

/* ---------- Hilfen ---------- */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (x, dec) => (x == null || isNaN(x)) ? "–" : x.toLocaleString("de-DE", { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec }) + " €";
const ct = (x) => (x == null || isNaN(x)) ? "–" : x.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €/kWh";
const n1 = (x) => x.toLocaleString("de-DE", { maximumFractionDigits: 1 });
const n0 = (x) => Math.round(x).toLocaleString("de-DE");
const netzName = (id) => { const n = NETZE.find(n => n.id === id); return n ? n.name : id; };
const netzKurz = (id) => { const n = NETZE.find(n => n.id === id); return n ? n.kurz : id; };
const uid = () => "id" + Math.random().toString(36).slice(2, 9);
const heute = () => new Date().toISOString().slice(0, 10);
const datumDE = (iso) => { if (!iso) return "–"; const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const addTage = (iso, t) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + t); return d.toISOString().slice(0, 10); };

/* ---------- Zustand ---------- */
let state = null;

function defaultState() {
  return {
    version: DATA_VERSION,
    fahrzeug: { ...FAHRZEUG_DEFAULT },
    tarife: JSON.parse(JSON.stringify(TARIFE_DEFAULT)),
    orte: JSON.parse(JSON.stringify(ORTE_DEFAULT)),
    trips: JSON.parse(JSON.stringify(TRIPS_DEFAULT)),
    karten: { maingau: true },           // tarifId -> hat der Nutzer die Karte/App schon?
    abos: {},                            // tarifId -> aktives Abo?
    checks: {},                          // checklisten-häkchen
    hinweiseWeg: {},                     // dauerhaft ausgeblendete Einmal-Tipps
    settings: {
      schukoPreis: 0.38, preiseGeprueft: PREISSTAND, introWeg: false,
      ocmKey: (typeof OCM_KEY_STANDARD !== "undefined" ? OCM_KEY_STANDARD : ""), puffer: 15, nurMeineKarten: false,
      suchKw: 0,                                        // Säulen-Finder: Wunsch-Mindestleistung (0 = alles)
      ankunftSoc: 20, beladen: true,
      updateUrl: "https://mintberry.org/local/ladekarten/tarife.json",
      profilName: "", webhookId: "lkc-profil-sichern",  // Pi-Sicherung (je Nutzer eigenes Profil)
      einfach: false,                                   // Einfacher Modus (z. B. für Familie)
      ghToken: "",                                      // optional: löst Neu-Recherche auf GitHub aus
    },
    fahrt: { modus: "soc", soc: 60, restKm: 250, tempo: 130, winter: false },
    planer: { start: "", ziel: "" },     // Routen-Planer: bewusst KEINE Vorgaben
    adressen: [],                        // gespeicherte Adressen (Heim, Arbeit, Urlaub …)
    favoriten: [],                       // gemerkte Ladesäulen
    letzteSuche: null,                   // letztes Säulen-Suchergebnis (offline nutzbar)
    logbuch: [],                         // erfasste Ladungen -> Statistik + Kalibrierung
    kalib: { ladeFaktor: 1, verbrauchFaktor: 1 },  // gelernt aus dem Logbuch
    aktionen: [],                        // zeitlich begrenzte Anbieter-Aktionen (aus tarife.json)
    aenderungsLog: null,                 // letzte Update-Änderungen mit Quellen
    ladeTimer: null,                     // laufender Blockiergebühr-Timer
    timerVorschlag: null,                // letzte Timer-Dauer -> Logbuch-Vorbefüllung
    preisAlarm: null,                    // Preisänderungen bei DEINEN Karten (aus dem Update)
    routenVerlauf: [],                   // zuletzt geplante Strecken (eigene Historie, keine Vorgaben)
    tab: "start",
    driveNetz: "enbw",
    chartKontext: "dc-autobahn",
  };
}

function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* kaputt -> neu */ }
  if (!s || !s.tarife) { state = defaultState(); return; }
  // Neue Standard-Tarife/Felder nach App-Update einpflegen, Nutzer-Edits behalten
  if ((s.version || 0) < DATA_VERSION) {
    // Sicherheitsnetz: vor jeder Daten-Umstellung bleibt der komplette alte
    // Stand als Kopie im Browser-Speicher liegen — nichts geht verloren
    try { localStorage.setItem(LS_KEY + "-sicherung", JSON.stringify(s)); } catch (e) { /* voll */ }
    const alt = s.tarife || [];
    s.tarife = JSON.parse(JSON.stringify(TARIFE_DEFAULT)).map(def => {
      const old = alt.find(t => t.id === def.id);
      return (old && old.editiert) ? old : def;
    });
    alt.forEach(t => { if (t.eigen && !s.tarife.find(x => x.id === t.id)) s.tarife.push(t); });
    // Alte fest hinterlegte Beispiel-Trips entfernen (Wunsch: keine Vorgaben)
    s.trips = (s.trips || []).filter(tr => !["fojnica", "oberhausen"].includes(tr.id));
    s.version = DATA_VERSION;
  }
  const d = defaultState();
  state = Object.assign(d, s);
  state.settings = Object.assign(defaultState().settings, s.settings || {});
  state.fahrt = Object.assign(defaultState().fahrt, s.fahrt || {});
  state.fahrzeug = Object.assign({ ...FAHRZEUG_DEFAULT }, s.fahrzeug || {});
  state.favoriten = s.favoriten || [];
  state.kalib = Object.assign({ ladeFaktor: 1, verbrauchFaktor: 1 }, s.kalib || {});
  // Alte Trips: Winter-Bool -> neue Kälte-Automatik ("auto" | "an" | "aus")
  (state.trips || []).forEach(tr => { if (tr.kaelte == null) tr.kaelte = tr.winter ? "an" : "auto"; });
  // Eingebauter OCM-Key greift, solange der Nutzer keinen eigenen eingetragen hat
  if (!state.settings.ocmKey && typeof OCM_KEY_STANDARD !== "undefined" && OCM_KEY_STANDARD) {
    state.settings.ocmKey = OCM_KEY_STANDARD;
  }
}

function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* voll/privat */ } }

/* ---------- Weniger Text: ⓘ-Erklärungen & Einmal-Tipps ----------
   Grundprinzip „Antwort zuerst“: sichtbar sind Zahlen, Pillen, Knöpfe.
   Erklärungen öffnen sich erst auf Tipp aufs ⓘ; Einmal-Tipps lassen sich
   dauerhaft wegklicken (state.hinweiseWeg). */
const offeneInfos = new Set();
const iBtn = (id) => `<button class="infobtn ${offeneInfos.has(id) ? "on" : ""}" type="button" data-info="${id}" aria-label="Erklärung anzeigen">i</button>`;
const iBox = (id, html) => offeneInfos.has(id) ? `<div class="infobox">${html}</div>` : "";
function tipp(id, html) {
  if (state.hinweiseWeg[id]) return "";
  return `<div class="card flat alert info tipp"><button class="tippx" type="button" data-tippweg="${id}" aria-label="Tipp dauerhaft ausblenden">✕</button>${html}</div>`;
}

/* ---------- Preis-Engine ---------- */
// Preis eines Tarifs an einem Netz für AC/DC. null = dort nicht nutzbar.
function tarifPreis(tarif, netzId, art) {
  if (netzId === "schuko") return null; // Steckdose läuft über settings.schukoPreis
  if (tarif.preisVariabel) return null;
  const fest = tarif.preise && tarif.preise[netzId];
  if (fest && fest[art] != null) return { preis: fest[art], unsicher: !!fest.unsicher };
  if (fest && fest[art] == null && (fest.ac != null || fest.dc != null)) return null; // Netz nur für andere Stromart
  // Geschlossene Systeme (Tesla, Lidl/Kaufland, Ionity): kein generisches Roaming,
  // dort funktionieren nur Tarife mit explizit hinterlegtem Preis
  const netz = NETZE.find(n => n.id === netzId);
  if (netz && netz.geschlossen) return null;
  if (tarif.roaming && tarif.roaming[art] != null) return { preis: tarif.roaming[art], unsicher: !!tarif.roamingUnsicher };
  return null;
}

// Bester Preis an einem Netz aus einer Tarif-Menge
function besterPreis(netzId, art, tarifIds) {
  if (netzId === "schuko") return { preis: state.settings.schukoPreis, tarif: null, name: "Haushaltsstrom (Schuko-Lader)" };
  let best = null;
  for (const t of state.tarife) {
    if (tarifIds && !tarifIds.includes(t.id)) continue;
    const p = tarifPreis(t, netzId, art);
    if (p && (best == null || p.preis < best.preis)) best = { preis: p.preis, unsicher: p.unsicher, tarif: t, name: t.name };
  }
  return best;
}

// Alle nutzbaren Tarife an einem Netz, sortiert nach Preis
function preiseAnNetz(netzId, art) {
  const out = [];
  for (const t of state.tarife) {
    const p = tarifPreis(t, netzId, art);
    if (p) out.push({ tarif: t, preis: p.preis, unsicher: p.unsicher, grund: t.grund || 0 });
  }
  out.sort((a, b) => a.preis - b.preis);
  return out;
}

/* ---------- Monats-Engine ---------- */
// Kosten eines Karten-Sets über alle Orte + Grundgebühren der Abos im Set
function setKosten(tarifIds) {
  let strom = 0, grund = 0;
  const detail = [];
  for (const ort of state.orte) {
    if (!ort.kwhMonat) continue;
    const b = besterPreis(ort.netz, ort.art, tarifIds);
    const preis = b ? b.preis : 0.79;
    strom += preis * ort.kwhMonat;
    detail.push({ ort, preis, tarifName: b ? b.name : "Ad-hoc", tarifId: b && b.tarif ? b.tarif.id : null, kosten: preis * ort.kwhMonat, unsicher: b && b.unsicher });
  }
  for (const id of tarifIds) {
    const t = state.tarife.find(x => x.id === id);
    if (t && t.grund) grund += t.grund;
  }
  return { strom, grund, gesamt: strom + grund, detail };
}

// Empfehlung: kostenlose Karten + Abos, die sich rechnen (Greedy)
function monatsAnalyse() {
  const freiIds = state.tarife.filter(t => (t.kategorie === "frei" || t.kategorie === "adhoc") && !t.preisVariabel).map(t => t.id);
  const aboIds = state.tarife.filter(t => t.kategorie === "abo").map(t => t.id);
  let set = [...freiIds];
  let kosten = setKosten(set);
  const abosGewaehlt = [];
  let verbessert = true;
  while (verbessert) {
    verbessert = false;
    let bestAbo = null, bestSaving = 0.009, bestKosten = null;
    for (const id of aboIds) {
      if (set.includes(id)) continue;
      const k = setKosten([...set, id]);
      const saving = kosten.gesamt - k.gesamt;
      if (saving > bestSaving) { bestSaving = saving; bestAbo = id; bestKosten = k; }
    }
    if (bestAbo) {
      set.push(bestAbo);
      abosGewaehlt.push({ id: bestAbo, ersparnis: bestSaving });
      kosten = bestKosten;
      verbessert = true;
    }
  }
  // Break-even je gewähltes Abo: Grundgebühr / mittlerer Preisvorteil an den Orten, wo es zieht
  for (const a of abosGewaehlt) {
    const t = state.tarife.find(x => x.id === a.id);
    const setOhne = set.filter(id => id !== a.id);
    let vorteilSum = 0, kwhSum = 0;
    for (const ort of state.orte) {
      if (!ort.kwhMonat) continue;
      const mit = besterPreis(ort.netz, ort.art, set);
      const ohne = besterPreis(ort.netz, ort.art, setOhne);
      if (mit && ohne && mit.tarif && mit.tarif.id === a.id && ohne.preis > mit.preis) {
        vorteilSum += (ohne.preis - mit.preis) * ort.kwhMonat;
        kwhSum += ort.kwhMonat;
      }
    }
    a.vorteilProKwh = kwhSum ? vorteilSum / kwhSum : 0;
    a.breakEvenKwh = a.vorteilProKwh > 0 ? (t.grund / a.vorteilProKwh) : null;
    a.kwhBetroffen = kwhSum;
  }
  const kwhGesamt = state.orte.reduce((s, o) => s + (+o.kwhMonat || 0), 0);
  const kmGeschaetzt = kwhGesamt / ((state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2) * 100;
  return { set, kosten, abosGewaehlt, kwhGesamt, kmGeschaetzt };
}

// Was kostet die Beschaffung einer Karte einmalig? (Text für Empfehlungen)
function kartenKostenText(t) {
  if (t.kategorie === "adhoc") return "keine Karte nötig — Girocard/Kreditkarte an der Säule reicht";
  if ((t.medium || "").includes("nur App")) return "nur App — 0 € Beschaffung";
  if (t.einmalKosten === 0) return "Karte kostenlos" + (t.einmalHinweis ? ` (${t.einmalHinweis})` : "");
  if (t.einmalKosten != null) return `Karte einmalig ${eur(t.einmalKosten)}${t.einmalHinweis ? " — " + t.einmalHinweis : ""}`;
  return t.einmalHinweis || "Kartengebühr noch nicht belegt — das wöchentliche Update trägt sie nach, sobald der Anbieter sie ausweist";
}
// Läuft für diesen Anbieter gerade eine Aktion? (aus dem wöchentlichen Update)
function tarifAktion(t) {
  return (state.aktionen || []).find(a => a.bis >= heute() && a.anbieter && t.name.toLowerCase().includes(a.anbieter.toLowerCase()));
}

// Aktionsliste: bestellen / abonnieren / kündigen
function aktionen(analyse) {
  const acts = [];
  // Karten NUR empfehlen, wenn sie an deinen eingetragenen Orten wirklich den
  // besten Preis liefern — sonst kommt die Empfehlung erst mit einer geplanten Route
  const gebraucht = new Set();
  for (const d of analyse.kosten.detail) if (d.tarifId) gebraucht.add(d.tarifId);
  for (const id of gebraucht) {
    const t = state.tarife.find(x => x.id === id);
    if (t && t.kategorie === "frei" && !state.karten[t.id]) {
      acts.push({ typ: "bestellen", tarif: t });
    }
  }
  for (const a of analyse.abosGewaehlt) {
    const t = state.tarife.find(x => x.id === a.id);
    if (!state.abos[t.id]) {
      acts.push({ typ: "abonnieren", tarif: t, ersparnis: a.ersparnis, breakEven: a.breakEvenKwh, vorteil: a.vorteilProKwh, kwh: a.kwhBetroffen });
    }
  }
  // Abo-Wächter: Abos, die ein anstehender Trip noch braucht, NICHT zur Kündigung
  // vorschlagen — sonst mit konkretem Kündigungs-Datum erinnern
  const tripAbos = new Set();
  for (const tr of state.trips) {
    if (tr.datum && tr.datum < heute()) continue;
    try { const b = tripAnalyse(tr).best; if (b && b.abo && b.tarif) tripAbos.add(b.tarif.id); } catch (e) { /* Trip unvollständig */ }
  }
  const monatsEnde = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0);
  for (const id of Object.keys(state.abos)) {
    if (!state.abos[id]) continue;
    const t = state.tarife.find(x => x.id === id);
    if (t && !analyse.abosGewaehlt.find(a => a.id === id)) {
      if (tripAbos.has(id)) continue; // wird für einen geplanten Trip gebraucht
      acts.push({ typ: "kuendigen", tarif: t, text: `Rechnet sich bei deinem aktuellen Ladeprofil nicht und kein geplanter Trip braucht es — spart ${eur(t.grund)}/Monat. Monatlich kündbar: am besten zum ${monatsEnde.toLocaleDateString("de-DE")}.` });
    }
  }
  return acts;
}

/* ---------- Trip-Engine ---------- */
function tripAnalyse(trip) {
  const f = state.fahrzeug;
  const kFaktor = kaelteFaktor(trip);
  const beladenFaktor = state.settings.beladen ? 1 + (f.beladenZuschlag || 8) / 100 : 1;
  const vAB = f.verbrauchAB * kFaktor * beladenFaktor * (state.kalib.verbrauchFaktor || 1);
  const vLokal = ((f.verbrauchStadt + f.verbrauchLand) / 2) * kFaktor * (state.kalib.verbrauchFaktor || 1);
  const akku = f.akkuNetto;
  // Ankunfts-Reserve (Standard 20 %), fürs Planen auf sinnvollen Bereich begrenzt
  const res = Math.min(0.5, Math.max(0.05, state.settings.ankunftSoc / 100));
  const kmVoll = (akku * (1 - res)) / vAB * 100;              // 100 % -> Reserve
  const kmHub = (akku * Math.max(0.1, 0.8 - res)) / vAB * 100; // 80 % -> Reserve (Folge-Etappen)
  const stopsProRichtung = trip.hinKm <= kmVoll ? 0 : Math.ceil((trip.hinKm - kmVoll) / kmHub);
  // Höhenprofil (falls beim Routen-Planen ermittelt): Bergauf kostet ~7,2 kWh/1000 m
  // bei 2,6 t, bergab kommen ~60 % per Rekuperation zurück. Rückweg = gespiegelt.
  let hoeheHin = 0, hoeheRueck = 0;
  if (trip.hoehe && trip.hoehe.aufstieg != null) {
    hoeheHin = (trip.hoehe.aufstieg * 7.2 - trip.hoehe.abstieg * 4.3) / 1000;
    hoeheRueck = (trip.hoehe.abstieg * 7.2 - trip.hoehe.aufstieg * 4.3) / 1000;
    const deckel = trip.hinKm * vAB / 100 * 0.2; // Schätzung auf ±20 % der Streckenenergie begrenzen
    hoeheHin = Math.max(-deckel, Math.min(deckel, hoeheHin));
    hoeheRueck = Math.max(-deckel, Math.min(deckel, hoeheRueck));
  }
  const kWhStrecke = trip.hinKm * vAB / 100;
  const kWhHin = kWhStrecke + hoeheHin, kWhRueck = kWhStrecke + hoeheRueck;
  const dcHin = Math.max(0, kWhHin - akku * (1 - res));
  const dcRueckVoll = Math.max(0, kWhRueck - akku * (1 - res));
  // Rückfahrt: Start voll nur, wenn vor Ort geladen werden kann
  const zielLadenGeht = !!trip.zielLaden;
  const dcUnterwegs = dcHin + (zielLadenGeht ? dcRueckVoll : kWhRueck);
  const kWhVorOrt = trip.kmVorOrt * vLokal / 100 + (zielLadenGeht ? akku * (1 - res) : 0); // lokal fahren + Akku für Rückfahrt füllen
  const kWhAbfahrt = akku * 0.8; // vor Abfahrt von ~20 auf 100 % in München

  // Streckenanteile je Land (für Netze, die nicht die ganze Route abdecken)
  let anteile = trip.anteile;
  if (!anteile) {
    const lands = (trip.laender || ["DE"]).filter(l => l !== "BA");
    anteile = {};
    (lands.length ? lands : ["DE"]).forEach(l => { anteile[l] = 1 / (lands.length || 1); });
  }
  const deckung = (netzId) => Object.entries(anteile).reduce((s, [land, a]) => s + (netzDecktLand(netzId, land) ? a : 0), 0);
  // Lücken-Füller: beste europaweite 0-€-Option (Maingau/Ionity Go/Ad-hoc)
  const luecke = besterPreis("ionity", "dc", ["maingau", "ionity-go", "adhoc"]) || { preis: 0.79, name: "Ad-hoc" };

  // Lade-Strategien für die DC-kWh unterwegs (Autobahn = Ionity/EnBW/Tesla)
  const monate = 1; // Abos monatlich kündbar -> 1 Monat für den Trip
  const kandidaten = [];
  const defs = [
    { id: "maingau", netz: "ionity", label: "Maingau an Ionity (0-€-Karte)" },
    { id: "ionity-go", netz: "ionity", label: "Ionity Go App (ohne Abo)" },
    { id: "ionity-motion", netz: "ionity", label: "Ionity Motion (1 Monat Abo)" },
    { id: "ionity-power", netz: "ionity", label: "Ionity Power (1 Monat Abo)" },
    { id: "enbw-s", netz: "enbw", label: "EnBW S an EnBW-Säulen" },
    { id: "enbw-l", netz: "enbw", label: "EnBW L (1 Monat Abo), EnBW-Säulen" },
    { id: "tesla-app", netz: "tesla", label: "Tesla Supercharger (ohne Abo)" },
    { id: "tesla-abo", netz: "tesla", label: "Tesla-Mitgliedschaft (1 Monat)" },
    { id: "adhoc", netz: "ionity", label: "Ad-hoc mit Kreditkarte (Notnagel)" },
  ];
  for (const d of defs) {
    const t = state.tarife.find(x => x.id === d.id);
    if (!t) continue;
    const p = tarifPreis(t, d.netz, "dc");
    if (!p) continue;
    const cov = d.id === "adhoc" ? 1 : deckung(d.netz);
    if (cov <= 0.05) continue;
    const kwhCov = dcUnterwegs * cov, kwhRest = dcUnterwegs - kwhCov;
    // Blockiergebühr ehrlich einrechnen: liegt ein geplanter Stopp über der
    // Gratis-Standzeit des Tarifs, kostet das ~0,10 €/min (hin + zurück)
    const grenzeB = t.blockierAbMin ? t.blockierAbMin.dc : null;
    const blockMin = (grenzeB == null || !trip.stopps) ? 0 :
      trip.stopps.reduce((s, st) => s + Math.max(0, (st.ladeMin || 0) - grenzeB), 0) * 2;
    const blockKosten = blockMin * 0.10;
    kandidaten.push({
      label: d.label + (cov < 0.999 ? ` — deckt ${Math.round(cov * 100)} % der Strecke, Rest über ${luecke.name.split(" ")[0]}` : ""),
      tarif: t, netz: d.netz, preis: p.preis, unsicher: p.unsicher,
      grund: (t.grund || 0) * monate, cov, kwhCov, kwhRest, lueckePreis: luecke.preis,
      blockMin, blockKosten,
      kosten: (t.grund || 0) * monate + p.preis * kwhCov + luecke.preis * kwhRest + blockKosten,
      abo: t.kategorie === "abo", besitzt: besitzt(t),
    });
  }
  kandidaten.sort((a, b) => a.kosten - b.kosten);
  // Filter "nur meine Karten": Abos zählen trotzdem als buchbar-Empfehlung, außer der Filter ist an
  const bestGesamt = kandidaten[0];
  const anzeige = state.settings.nurMeineKarten ? kandidaten.filter(k => k.besitzt) : kandidaten;
  const best = anzeige[0];
  const bestOhneAbo = anzeige.find(k => !k.abo);
  const tipp = (state.settings.nurMeineKarten && bestGesamt && best && bestGesamt.kosten < best.kosten - 0.5) ? bestGesamt : null;

  // Kosten vor Ort + Abfahrt: nur mit Karten rechnen, die du hast (oder die der Plan empfiehlt)
  const heimIds = state.tarife.filter(besitzt).map(t => t.id);
  if (best && best.tarif) heimIds.push(best.tarif.id);
  const heimBest = besterPreis("enbw", "dc", heimIds) || besterPreis("enbw", "dc", null);
  const kostenAbfahrt = kWhAbfahrt * (heimBest ? heimBest.preis : 0.6);
  let vorOrtPreis, vorOrtName;
  if (trip.zielLaden === "schuko") { vorOrtPreis = state.settings.schukoPreis; vorOrtName = "Steckdose/Notlader"; }
  else if (trip.zielLaden) { const b = besterPreis(trip.zielLaden, "dc", null) || besterPreis(trip.zielLaden, "ac", null); vorOrtPreis = b ? b.preis : 0.6; vorOrtName = netzName(trip.zielLaden); }
  else { vorOrtPreis = 0.7; vorOrtName = "unterwegs (DC)"; }
  const kostenVorOrt = kWhVorOrt * vorOrtPreis;

  return {
    vAB, vLokal, kmVoll, kmHub, stopsProRichtung, kWhStrecke, dcUnterwegs, kWhVorOrt, kWhAbfahrt,
    kandidaten: anzeige, tipp, best, bestOhneAbo, kostenAbfahrt, kostenVorOrt, vorOrtPreis, vorOrtName, heimBest,
    gesamt: (best ? best.kosten : 0) + kostenAbfahrt + kostenVorOrt,
    gesamtKm: 2 * trip.hinKm + (+trip.kmVorOrt || 0),
  };
}

// Länder-Check einer Karten-Empfehlung: Wo auf der Route gilt sie, wo nicht?
function laenderCheck(k, trip) {
  const anteile = trip.anteile || { DE: 1 };
  const teile = Object.entries(anteile).map(([land, a]) => {
    const ok = k.tarif.id === "adhoc" || netzDecktLand(k.netz, land);
    const name = (LAENDER[land] && LAENDER[land].name) || land;
    return `${name} (${Math.round(a * 100)} % der Strecke) ${ok ? "✓" : "✗"}`;
  });
  const fehlt = Object.keys(anteile).some(l => !(k.tarif.id === "adhoc" || netzDecktLand(k.netz, l)));
  return teile.join(" · ") + (fehlt ? ` — auf den ✗-Abschnitten rechnet die App automatisch mit der günstigsten 0-€-Alternative (${ct(k.lueckePreis)}), das steckt schon im Gesamtpreis.` : "");
}
// Mehr-Länder-Fahrten: welche Karte ist in welchem Land am günstigsten?
function landBesteText(trip, ana) {
  const anteile = trip.anteile || {};
  if (Object.keys(anteile).length < 2) return "";
  const teile = [];
  for (const land of Object.keys(anteile)) {
    const kand = ana.kandidaten.filter(k => k.tarif.id === "adhoc" || netzDecktLand(k.netz, land));
    if (!kand.length) continue;
    const best = kand.slice().sort((a, b) => a.preis - b.preis)[0];
    teile.push(`<b>${esc((LAENDER[land] && LAENDER[land].name) || land)}:</b> ${esc(best.label.split(" — ")[0])} (${ct(best.preis)})`);
  }
  return teile.length ? `<p class="small">🌍 <b>Pro Land am günstigsten:</b> ${teile.join(" · ")}. Die Gesamt-Empfehlung oben verrechnet das bereits über die Strecken-Anteile — ein Abo empfiehlt sie nur, wenn es unterm Strich günstiger ist als kostenlose Karten + Ad-hoc.</p>` : "";
}

// Checkliste für einen Trip (mit Terminen, wenn Datum gesetzt)
function tripCheckliste(trip, ana) {
  const items = [];
  const d = trip.datum;
  const w = (tage) => d ? `bis ${datumDE(addTage(d, -tage))}` : `${tage} Tag${tage === 1 ? "" : "e"} vorher`;
  const dat = (tage) => d ? addTage(d, -tage) : null;
  if (trip.laender.includes("BA")) {
    items.push({ when: w(21), datum: dat(21), text: "Grüne Versicherungskarte bei der Kfz-Versicherung anfordern und prüfen, dass Bosnien (BIH) NICHT ausgeschlossen ist. Physisch mitführen!" });
    items.push({ when: w(7), datum: dat(7), text: "eSIM/Datenpaket für Bosnien buchen (kein EU-Roaming!) — sonst offline an der Ladesäule." });
    items.push({ when: w(7), datum: dat(7), text: "PlugShare: Lader entlang der Route in Bosnien checken, Screenshots offline speichern." });
  }
  if (trip.laender.includes("AT")) items.push({ when: w(7), datum: dat(7), text: "Digitale Vignette Österreich kaufen (asfinag.at) + an Sondermaut Tauern/Karawanken denken." });
  if (trip.laender.includes("SI")) items.push({ when: w(7), datum: dat(7), text: "E-Vinjeta Slowenien kaufen (evinjeta.dars.si) — Kennzeichen doppelt prüfen." });
  if (ana.best && ana.best.abo) items.push({ when: w(2), datum: dat(2), text: `${ana.best.tarif.name} abschließen (${eur(ana.best.grund)}, monatlich kündbar) — spart auf diesem Trip ${eur((ana.bestOhneAbo ? ana.bestOhneAbo.kosten : 0) - ana.best.kosten)} ggü. der besten 0-€-Option.` });
  items.push({ when: w(2), datum: dat(2), text: "Backup-Apps aufs Handy + einloggen + Zahlungsmittel hinterlegen: Ionity, EnBW, Tesla, Electroverse" + (trip.laender.includes("HR") ? ", ELEN (Kroatien)" : "") + "." });
  items.push({ when: w(1), datum: d ? addTage(d, -1) : null, text: "Ladeziel im Auto auf 100 % stellen und vollladen (Abfahrt mit vollem Akku spart den teuersten Stopp)." });
  items.push({ when: w(1), datum: d ? addTage(d, -1) : null, text: "Packen: Typ-2-Kabel, Schuko-Ladegerät, ggf. schwere Verlängerung (voll abrollen!), Handschuhe." });
  if (trip.laender.includes("BA")) items.push({ when: "Unterwegs", text: "Letzten Schnelllader in Kroatien auf 100 % nutzen, dann erst über die Grenze nach Bosnien." });
  items.push({ when: "Unterwegs", text: "Schnelllader immer im Auto-Navi als Ziel setzen → Akku-Vorkonditionierung = volle Ladeleistung." });
  if (ana.best && ana.best.abo) {
    const endeIso = d ? addTage(d, (+trip.tageVorOrt || 0) + 2) : null;
    items.push({ when: "Danach", datum: endeIso, text: `${ana.best.tarif.name} wieder kündigen (${endeIso ? datumDE(endeIso) : "nach der Rückkehr"}) — sonst läuft die Grundgebühr weiter.` });
  }
  return items;
}

// Checklisten-Termine als Kalenderdatei (.ics) — Handy erinnert auch ohne App
function icsExport(trip, items) {
  const mitDatum = items.filter(i => i.datum);
  if (!mitDatum.length) { alert("Erst ein Abfahrtsdatum setzen — dann bekommen die Punkte Termine."); return; }
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ladekarten-Checker//DE\r\n";
  mitDatum.forEach((i, n) => {
    const tag = i.datum.replace(/-/g, "");
    const text = i.text.replace(/[\r\n]+/g, " ").replace(/([,;\\])/g, "\\$1");
    ics += "BEGIN:VEVENT\r\nUID:lkc-" + trip.id + "-" + n + "@ladekarten\r\nDTSTAMP:" + stamp +
      "\r\nDTSTART;VALUE=DATE:" + tag + "\r\nSUMMARY:🔌 " + text.slice(0, 70) +
      "\r\nDESCRIPTION:" + text + " (Trip: " + trip.ziel.replace(/([,;\\])/g, "\\$1") + ")" +
      "\r\nBEGIN:VALARM\r\nTRIGGER:PT9H\r\nACTION:DISPLAY\r\nDESCRIPTION:Erinnerung\r\nEND:VALARM\r\nEND:VEVENT\r\n";
  });
  ics += "END:VCALENDAR\r\n";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = "trip-" + trip.id + ".ics";
  a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- Lade-Logbuch: Statistik + Kalibrierung ---------- */
function logbuchKalibrieren() {
  const l = state.logbuch;
  // Ladegeschwindigkeit: echte Ø-kW je DC-Ladung vs. Modell im selben SoC-Fenster
  const faktoren = l.filter(e => e.kwh > 5 && e.minuten > 3 && e.kwh / (e.minuten / 60) >= 50)
    .map(e => {
      const echteKw = e.kwh / (e.minuten / 60);
      // Mit SoC-Angaben: Modell im exakt gleichen Fenster (präziseste Kalibrierung),
      // sonst Annahme typisches Fenster 20->80 %
      const von = e.socVon != null ? e.socVon : 20, bis = e.socBis != null ? e.socBis : 80;
      const modellKw = ((bis - von) / 100 * state.fahrzeug.akkuNetto) / ((ladezeitMin(von, bis) * (state.kalib.ladeFaktor || 1)) / 60);
      return echteKw / modellKw;
    });
  if (faktoren.length >= 2) {
    faktoren.sort((a, b) => a - b);
    const median = faktoren[Math.floor(faktoren.length / 2)];
    state.kalib.ladeFaktor = Math.max(0.5, Math.min(1.3, median));
  }
}
function logbuchStatistik() {
  const l = state.logbuch;
  if (!l.length) return null;
  const monat = heute().slice(0, 7);
  const imMonat = l.filter(e => (e.datum || "").startsWith(monat));
  const summe = (arr, f) => arr.reduce((s, e) => s + (+e[f] || 0), 0);
  const kwhM = summe(imMonat, "kwh"), eurM = summe(imMonat, "kosten");
  const kwhG = summe(l, "kwh"), eurG = summe(l, "kosten"), kmG = summe(l, "km");
  return {
    anz: l.length, kwhM, eurM, kwhG, eurG, kmG,
    schnittM: kwhM ? eurM / kwhM : null,
    schnittG: kwhG ? eurG / kwhG : null,
    ersparnisAdhoc: kwhG * 0.79 - eurG,
    verbrauchEcht: kmG > 50 ? kwhG / kmG * 100 : null,
    benzinVergleich: kmG > 50 ? kmG * 0.08 * 1.80 - eurG : null,
  };
}

/* ---------- Fahr-Physik & Ladekurve ---------- */
// Besitzt der Nutzer diesen Tarif? (Ad-hoc geht immer)
function besitzt(t) {
  return t.id === "adhoc" ? true : (t.kategorie === "abo" ? !!state.abos[t.id] : !!state.karten[t.id]);
}
// Verbrauch (kWh/100 km) je Ziel-Tempo — Grundlast + Luftwiderstand, kalibriert am 130-km/h-Wert
function verbrauchBeiTempo(v, winterOderFaktor) {
  const c130 = state.fahrzeug.verbrauchAB;
  const a = c130 * 0.3876, b = (c130 * 0.6124) / (130 * 130);
  let c = a + b * v * v;
  if (winterOderFaktor === true) c *= 1 + state.fahrzeug.winterZuschlag / 100;
  else if (typeof winterOderFaktor === "number") c *= winterOderFaktor;
  if (state.settings.beladen) c *= 1 + (state.fahrzeug.beladenZuschlag || 8) / 100;
  return c * (state.kalib.verbrauchFaktor || 1);
}
// Kälte-Faktor eines Trips: "auto" nutzt Wetterdaten (falls geholt) oder die Jahreszeit
function kaelteFaktor(trip) {
  const wz = state.fahrzeug.winterZuschlag / 100;
  if (trip.kaelte === "an") return 1 + wz;
  if (trip.kaelte === "aus") return 1;
  if (trip.wetter && trip.wetter.tempMin != null) {
    const t = trip.wetter.tempMin;
    if (t >= 12) return 1;
    if (t <= 0) return 1 + wz;
    return 1 + wz * (12 - t) / 12;
  }
  const monat = trip.datum ? +trip.datum.slice(5, 7) : (new Date().getMonth() + 1);
  if ([12, 1, 2].includes(monat)) return 1 + wz;
  if ([11, 3].includes(monat)) return 1 + wz * 0.6;
  if ([10, 4].includes(monat)) return 1 + wz * 0.3;
  return 1;
}
// Beschreibung der Kälte-Annahme für die Anzeige
function kaelteText(trip) {
  const f = kaelteFaktor(trip);
  const proz = Math.round((f - 1) * 100);
  if (trip.kaelte === "an") return `Kälte manuell AN (+${proz} %)`;
  if (trip.kaelte === "aus") return "Kälte manuell AUS";
  if (trip.wetter && trip.wetter.tempMin != null) {
    return `Wetter: min. ${Math.round(trip.wetter.tempMin)} °C${trip.datum ? " am " + datumDE(trip.datum) : ""} → +${proz} % (Stand ${new Date(trip.wetter.stand).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })})`;
  }
  return `Jahreszeit-Schätzung → +${proz} % (Datum setzen für echte Wetterdaten)`;
}
// Wettervorhersage (Open-Meteo, kostenlos/ohne Key) für Trips mit Datum + Koordinaten
async function wetterHolen(trip) {
  try {
    if (!trip.datum || !trip.stopps || !trip.stopps.length) return;
    const tage = Math.round((new Date(trip.datum) - new Date()) / 864e5);
    if (tage < 0 || tage > 15) { trip.wetter = null; save(); return; } // Vorhersage reicht ~16 Tage
    const mitte = trip.stopps[Math.floor(trip.stopps.length / 2)];
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${mitte.lat}&longitude=${mitte.lng}&daily=temperature_2m_min&timezone=UTC&start_date=${trip.datum}&end_date=${trip.datum}`);
    const js = await r.json();
    const t = js.daily && js.daily.temperature_2m_min && js.daily.temperature_2m_min[0];
    if (t != null) { trip.wetter = { tempMin: t, stand: new Date().toISOString() }; save(); render(); }
  } catch (e) { /* offline — Jahreszeit-Schätzung greift */ }
}
// DC-Ladezeit in Minuten von SoC a → b (warmer Akku, Näherung laut LADEKURVE,
// korrigiert um den aus deinem Logbuch gelernten Faktor)
function ladezeitMin(von, bis) {
  return ladezeitMitLimit(von, bis, 9999);
}
// Ladezeit begrenzt auf die Leistung der SÄULE: eine 50-kW-Säule lädt den #5
// eben nur mit 50 kW, egal was der Akku könnte.
function ladezeitMitLimit(von, bis, saeuleKw) {
  const akku = state.fahrzeug.akkuNetto;
  // Deckel: das Minimum aus Säulen-Leistung und dem, was DEIN Auto kann (dcMax)
  const limit = Math.min(saeuleKw && saeuleKw > 0 ? saeuleKw : 9999, state.fahrzeug.dcMax || 9999);
  let min = 0;
  for (const [s0, s1, kw] of LADEKURVE) {
    const lo = Math.max(von, s0), hi = Math.min(bis, s1);
    if (hi > lo) min += ((hi - lo) / 100 * akku) / Math.min(kw, limit) * 60;
  }
  return min / (state.kalib.ladeFaktor || 1);
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const STRASSEN_FAKTOR = 1.25; // Luftlinie → realistische Straßen-km
// Reichweiten-Cockpit: verfügbare Energie & sichere Reichweite aus den Fahrt-Eingaben
function fahrtRechnung() {
  const fa = state.fahrt, f = state.fahrzeug;
  const vMix = (f.verbrauchStadt + f.verbrauchLand) / 2;
  const energie = fa.modus === "restkm"
    ? Math.min(f.akkuNetto, fa.restKm * vMix / 100)   // Anzeige-km → kWh (Bordcomputer rechnet gemischt)
    : f.akkuNetto * fa.soc / 100;
  const socEff = energie / f.akkuNetto * 100;
  const verbrauch = verbrauchBeiTempo(fa.tempo, fa.winter);
  const maxKm = energie / verbrauch * 100;
  const res = state.settings.ankunftSoc / 100;
  const sicherKm = Math.max(0, (energie - f.akkuNetto * res) / verbrauch * 100 * (1 - state.settings.puffer / 100));
  return { energie, socEff, verbrauch, maxKm, sicherKm };
}

/* ---------- Säulen-Suche (OpenChargeMap + Nominatim) ---------- */
let sucheStatus = "";
const mapsUrl = (st) => `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}`;
async function sucheSaeulen(lat, lng) {
  const key = (state.settings.ocmKey || "").trim();
  if (!key) { sucheStatus = "kein-key"; render(); return; }
  sucheStatus = "lädt"; render();
  // Wunsch-Leistung: gibt es in der Nähe nichts, weitet die App den Radius
  // selbst aus (bis 300 km) — du musst nicht suchen
  const minKw = +state.settings.suchKw || 0;
  const radien = minKw ? [30, 80, 160, 300] : [30];
  try {
    let js = [], radius = radien[0];
    for (const r of radien) {
      radius = r;
      const url = "https://api.openchargemap.io/v3/poi/?output=json&distanceunit=km&distance=" + r + "&maxresults=30&verbose=false&includecomments=true" +
        (minKw ? "&minpowerkw=" + minKw : "") +
        "&latitude=" + lat + "&longitude=" + lng + "&key=" + encodeURIComponent(key);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      js = (await resp.json()).filter(p => p.AddressInfo);
      if (minKw) js = js.filter(p => Math.max(0, ...(p.Connections || []).map(c => c.PowerKW || 0)) >= minKw);
      if (js.length) break;
      await sleep(300);
    }
    state.letzteSuche = {
      lat, lng, zeit: new Date().toISOString(), minKw, radius,
      stationen: js.map(p => {
        // Defekt-Radar: Betriebsstatus + letzter Nutzerkommentar von OpenChargeMap
        const komm = (p.UserComments || [])[0];
        return {
          id: "ocm" + p.ID,
          name: p.AddressInfo.Title || "Ladepunkt",
          op: (p.OperatorInfo && p.OperatorInfo.Title) || "",
          lat: p.AddressInfo.Latitude, lng: p.AddressInfo.Longitude,
          adresse: [p.AddressInfo.AddressLine1, p.AddressInfo.Town].filter(Boolean).join(", "),
          kw: Math.max(0, ...(p.Connections || []).map(c => c.PowerKW || 0)),
          anz: (p.Connections || []).reduce((s, c) => s + (c.Quantity || 1), 0),
          defekt: p.StatusType && p.StatusType.IsOperational === false,
          status: p.StatusType ? (p.StatusType.IsOperational === false ? "außer Betrieb" : "in Betrieb") : "",
          statusAm: (p.DateLastStatusUpdate || p.DateLastVerified || "").slice(0, 10),
          kommentar: komm ? { text: (komm.Comment || komm.CheckinStatusType && komm.CheckinStatusType.Title || "").slice(0, 120), am: (komm.DateCreated || "").slice(0, 10) } : null,
        };
      }),
    };
    sucheStatus = "";
    save(); render();
  } catch (e) {
    sucheStatus = "fehler:Abfrage fehlgeschlagen (" + e.message + "). Hinweis: Im claude.ai-Link sind externe Abfragen gesperrt — nutze die Version auf deiner Domain oder dem PC.";
    render();
  }
}
function standortSuche() {
  if (!navigator.geolocation) { sucheStatus = "fehler:Kein Standortzugriff in diesem Browser."; render(); return; }
  sucheStatus = "ortung"; render();
  navigator.geolocation.getCurrentPosition(
    p => sucheSaeulen(p.coords.latitude, p.coords.longitude),
    e => { sucheStatus = "fehler:Standort nicht verfügbar (" + e.message + "). Alternativ: Adresse eingeben."; render(); },
    { timeout: 10000, maximumAge: 60000 }
  );
}
async function adresseSuche(q) {
  if (!q) return;
  sucheStatus = "lädt"; render();
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q));
    const js = await r.json();
    if (!js.length) { sucheStatus = "fehler:Adresse nicht gefunden."; render(); return; }
    sucheSaeulen(+js[0].lat, +js[0].lon);
  } catch (e) { sucheStatus = "fehler:Adresssuche fehlgeschlagen (" + e.message + ")."; render(); }
}
async function stationTeilen(st) {
  const url = mapsUrl(st);
  const text = st.name + (st.op ? " (" + st.op + ")" : "") + (st.adresse ? " — " + st.adresse : "");
  if (navigator.share) {
    try { await navigator.share({ title: st.name, text, url }); return; } catch (e) { /* abgebrochen */ }
  }
  try { await navigator.clipboard.writeText(text + "\n" + url); alert("Link kopiert — in Google Maps oder Hello smart einfügen."); }
  catch (e) { prompt("Link zum Kopieren:", url); }
}

/* ---------- Routen-Planer (Nominatim + OSRM + OpenChargeMap) ---------- */
let routeStatus = "";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function geocode(q) {
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q));
  const js = await r.json();
  if (!js.length) return null;
  const teile = js[0].display_name.split(",").map(x => x.trim());
  // Aussagekräftiges Label: Anfang + Land, damit man Fehl-Treffer sofort erkennt
  const label = teile.slice(0, 2).join(", ") + (teile.length > 3 ? " (" + teile[teile.length - 1] + ")" : "");
  return { lat: +js[0].lat, lng: +js[0].lon, label, kurz: teile.slice(0, 2).join(",") };
}
async function landBei(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&lat=${lat}&lon=${lng}`);
    const js = await r.json();
    return js.address && js.address.country_code ? js.address.country_code.toUpperCase() : null;
  } catch (e) { return null; }
}
// Punkt auf der Route bei Kilometer x (coords = [[lon,lat],...], cum = kumulierte km)
function punktBeiKm(coords, cum, km) {
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= km) return { lat: coords[i][1], lng: coords[i][0] };
  }
  const l = coords[coords.length - 1];
  return { lat: l[1], lng: l[0] };
}
// Beste Säule nahe eines Streckenpunkts (braucht OCM-Key; sonst null).
// Dein #5 lädt bis 400 kW — deshalb: erst nach HPC ≥ 150 kW suchen und
// ≥ 300 kW stark bevorzugen; nur wenn nichts da ist (dünnes Netz, Balkan),
// mit 50 kW zufriedengeben.
// Harte Prioritäten (Ninos Vorgabe): 400er > 350er > 300er Lader. Nur wenn es
// die dort wirklich nicht gibt: 150+, und als allerletzte Rettung <150 kW.
async function ocmBesteSaeule(lat, lng, radiusKm) {
  const key = (state.settings.ocmKey || "").trim();
  if (!key) return null;
  const abfrage = async (minKw, dist) => {
    const url = "https://api.openchargemap.io/v3/poi/?output=json&distanceunit=km&distance=" + dist + "&maxresults=12&verbose=false&minpowerkw=" + minKw +
      "&latitude=" + lat + "&longitude=" + lng + "&key=" + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) return [];
    const js = await r.json();
    return js.filter(p => p.AddressInfo).map(p => ({
      id: "ocm" + p.ID,
      name: p.AddressInfo.Title || "Ladepunkt",
      op: (p.OperatorInfo && p.OperatorInfo.Title) || "",
      lat: p.AddressInfo.Latitude, lng: p.AddressInfo.Longitude,
      adresse: [p.AddressInfo.AddressLine1, p.AddressInfo.Town].filter(Boolean).join(", "),
      kw: Math.max(0, ...(p.Connections || []).map(c => c.PowerKW || 0)),
      anz: (p.Connections || []).reduce((s, c) => s + (c.Quantity || 1), 0),
      status: p.StatusType ? (p.StatusType.IsOperational === false ? "außer Betrieb" : "in Betrieb") : "",
      statusAm: (p.DateLastStatusUpdate || p.DateLastVerified || "").slice(0, 10),
      dist: haversineKm(lat, lng, p.AddressInfo.Latitude, p.AddressInfo.Longitude),
    })).filter(k => k.kw >= minKw);
  };
  const dist = radiusKm || 15;
  try {
    // Stufenweise: erst nur echte HPC (300+), dann 150+, dann weiter Radius, dann alles
    let kand = await abfrage(300, dist);
    if (!kand.length) { await sleep(250); kand = await abfrage(150, dist); }
    if (!kand.length) { await sleep(250); kand = await abfrage(150, dist + 10); }
    if (!kand.length) { await sleep(250); kand = await abfrage(50, dist + 10); }
    if (!kand.length) return null;
    const meineIds = state.tarife.filter(besitzt).map(t => t.id);
    kand.forEach(k => {
      const netz = opZuNetz(k.op);
      const b = netz ? besterPreis(netz, "dc", meineIds) : null;
      const stufe = k.kw >= 400 ? 10 : k.kw >= 350 ? 8 : k.kw >= 300 ? 6 : k.kw >= 150 ? 3 : 0;
      k.score = stufe                                       // Leistung dominiert alles
        - k.dist / 6                                        // Umweg bestraft
        + (b ? 1.2 : 0)                                     // Netz einer deiner Karten
        + (k.anz >= 4 ? 0.5 : 0)                            // viele Ladepunkte = weniger Wartezeit
        + (!k.op || /unknown/i.test(k.op) ? -1.5 : 0);      // unbekannter Betreiber = unsicher
      // Begründung mitliefern — in der App per „Warum diese Säule?“ nachlesbar
      k.warum = [
        `Leistung ${Math.round(k.kw)} kW → +${stufe} (Stufen: 400er = 10, 350er = 8, 300er = 6, ab 150 = 3)`,
        `Umweg ≈ ${k.dist.toFixed(1)} km → −${(k.dist / 6).toFixed(1)}`,
        b ? `Netz passt zu deiner Karte (${b.name}) → +1,2` : "keine deiner Karten passt dort → +0",
        `${k.anz || "?"} Ladepunkte → ${k.anz >= 4 ? "+0,5 (Warteschlange unwahrscheinlich)" : "+0"}`,
      ];
      if (!k.op || /unknown/i.test(k.op)) k.warum.push("Betreiber unbekannt → −1,5 (Risiko)");
    });
    kand.sort((a, b) => b.score - a.score);
    return kand[0];
  } catch (e) { return null; }
}
async function routePlanen(altIndex) {
  const startQ = ($("#route-start") || {}).value || state.planer.start || "";
  const zielQ = ($("#route-ziel") || {}).value || state.planer.ziel || "";
  state.planer = Object.assign({}, state.planer, { start: startQ.trim(), ziel: zielQ.trim() });
  if (!state.planer.start || !state.planer.ziel) { routeStatus = "fehler:Bitte Start und Ziel eingeben."; render(); return; }
  save();
  try {
    routeStatus = "1/5 Adressen suchen …"; render();
    const a = await geocode(state.planer.start);
    await sleep(1100); // Nominatim-Fair-Use: max. 1 Anfrage/Sekunde
    const b = await geocode(state.planer.ziel);
    if (!a || !b) { routeStatus = "fehler:" + (!a ? "Start" : "Ziel") + " nicht gefunden — Adresse präzisieren (Ort, Land)."; render(); return; }

    routeStatus = "2/5 Route berechnen …"; render();
    const rr = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson&alternatives=true`);
    const rjs = await rr.json();
    if (!rjs.routes || !rjs.routes.length) { routeStatus = "fehler:Keine Route gefunden."; render(); return; }
    // Alternativ-Routen merken (nur Eckdaten), gewählte Route verwenden
    state.planer.alts = rjs.routes.map((r, i) => ({ i, km: Math.round(r.distance / 1000), min: Math.round(r.duration / 60) }));
    state.planer.altGewaehlt = Math.min(altIndex || 0, rjs.routes.length - 1);
    const route = rjs.routes[state.planer.altGewaehlt];
    const distKm = route.distance / 1000, fahrzeitMin = route.duration / 60;
    const coords = route.geometry.coordinates;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));
    // Kompakte Routen-Geometrie ([lat,lng]) mitspeichern: fürs Kartenbild und
    // damit „Stopp verschieben“ später den echten Streckenpunkt kennt
    const geoSchritt = Math.max(1, Math.ceil(coords.length / 220));
    const geo = coords.filter((_, i) => i % geoSchritt === 0 || i === coords.length - 1)
      .map(c => [+c[1].toFixed(4), +c[0].toFixed(4)]);

    routeStatus = "3/5 Länder auf der Route erkennen …"; render();
    const laenderZaehl = {};
    for (const fr of [0.08, 0.28, 0.5, 0.72, 0.92]) {
      await sleep(1100);
      const p = punktBeiKm(coords, cum, distKm * fr);
      const land = await landBei(p.lat, p.lng);
      if (land) laenderZaehl[land] = (laenderZaehl[land] || 0) + 1;
    }
    const laender = Object.keys(laenderZaehl).length ? Object.keys(laenderZaehl) : ["DE"];
    let anteile = {};
    const sum = Object.values(laenderZaehl).reduce((s, x) => s + x, 0) || 1;
    for (const [l, n] of Object.entries(laenderZaehl)) anteile[l] = n / sum;
    // Bosnien hat kaum DC — dessen Anteil dem letzten Land davor (meist HR) zuschlagen
    if (anteile.BA) {
      const ziel = anteile.HR != null ? "HR" : Object.keys(anteile).find(l => l !== "BA");
      if (ziel) { anteile[ziel] = (anteile[ziel] || 0) + anteile.BA; delete anteile.BA; }
    }

    // Höhenprofil (Open-Meteo Elevation, kostenlos): kumulierter Auf-/Abstieg der Hinfahrt
    routeStatus = "4/5 Höhenprofil holen …"; render();
    let hoehe = null;
    try {
      const n = Math.min(40, coords.length);
      const schritt = Math.max(1, Math.floor(coords.length / n));
      const probe = coords.filter((_, i) => i % schritt === 0);
      const he = await fetch("https://api.open-meteo.com/v1/elevation?latitude=" +
        probe.map(c => c[1].toFixed(3)).join(",") + "&longitude=" + probe.map(c => c[0].toFixed(3)).join(","));
      const hjs = await he.json();
      if (hjs.elevation && hjs.elevation.length > 2) {
        let auf = 0, ab = 0;
        for (let i = 1; i < hjs.elevation.length; i++) {
          const dh = hjs.elevation[i] - hjs.elevation[i - 1];
          if (dh > 0) auf += dh; else ab -= dh;
        }
        hoehe = { aufstieg: Math.round(auf), abstieg: Math.round(ab), stand: new Date().toISOString() };
      }
    } catch (e) { /* ohne Höhendaten weiter — Puffer fängt es ab */ }

    routeStatus = "5/5 Ladestopps & Säulen suchen …"; render();
    const f = state.fahrzeug;
    const res = Math.min(0.5, Math.max(0.05, state.settings.ankunftSoc / 100));
    const verbrauch = verbrauchBeiTempo(state.fahrt.tempo, state.fahrt.winter);
    const stopps = [];
    let covered = 0, soc = 100;
    for (let i = 0; i < 8; i++) {
      const reichKm = (soc - res * 100) / 100 * f.akkuNetto / verbrauch * 100;
      if (covered + reichKm >= distKm) break;
      let stopKm = covered + reichKm * 0.92; // 8 % Marge für Umweg/Abweichung
      // Säule suchen — findet sich am Wunschpunkt nichts, Stopp schrittweise VORVERLEGEN
      // (lieber früher laden als in ein Loch fahren, z. B. Richtung Bosnien)
      let saeule = null, p = null;
      for (const zurueck of [0, 40, 80, 120]) {
        const km = stopKm - zurueck;
        if (km <= covered + 30) break;
        p = punktBeiKm(coords, cum, km);
        saeule = await ocmBesteSaeule(p.lat, p.lng);
        if (saeule) { stopKm = km; break; }
        await sleep(250);
      }
      if (!p) p = punktBeiKm(coords, cum, stopKm);
      // Nutze exakte Säulenposition für die Rechnung, wenn gefunden
      const ankunftSoc = soc - (stopKm - covered) * verbrauch / f.akkuNetto;
      const restKm = distKm - stopKm;
      const brauchtSoc = restKm * verbrauch / f.akkuNetto + res * 100;
      const zielSoc = Math.min(brauchtSoc > 80 ? 80 : Math.min(95, brauchtSoc + 3), 100);
      stopps.push(Object.assign({
        id: "stop" + i, name: "Geplanter Ladestopp", op: "", kw: 0, adresse: "",
        lat: p.lat, lng: p.lng,
      }, saeule || {}, {
        platzhalter: !saeule,           // WICHTIG: nur Platzhalter, wenn KEINE Säule gefunden
        posKm: stopKm,
        ankunftSoc: Math.round(ankunftSoc), zielSoc: Math.round(zielSoc),
        ladeMin: Math.round(ladezeitMitLimit(ankunftSoc, zielSoc, saeule ? saeule.kw : 0)),
        kwh: Math.round((zielSoc - ankunftSoc) / 100 * f.akkuNetto),
      }));
      soc = zielSoc; covered = stopKm;
      await sleep(300);
    }
    // Stopps OHNE Säule (echte Infrastruktur-Löcher, z. B. Bosnien): am Stopp
    // davor fest auf 100 % laden und deutlich warnen
    for (let i = 0; i < stopps.length; i++) {
      if (stopps[i].platzhalter && i > 0) {
        stopps[i - 1].zielFest = 100;
        stopps[i].ohneSaeule = true;
      }
    }
    const ankunftFinal = Math.round(soc - (distKm - covered) * verbrauch / f.akkuNetto);

    // Route als Trip anlegen/aktualisieren — dort passiert die Karten- & Kosten-Empfehlung
    const tripId = "route-" + (a.label + "-" + b.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    let trip = state.trips.find(t => t.id === tripId);
    if (!trip) {
      trip = { id: tripId, tageVorOrt: 0, kmVorOrt: 0, datum: "", zielLaden: "schuko" };
      state.trips.unshift(trip);
    }
    state.planer.startErkannt = a.label;
    state.planer.zielErkannt = b.label;
    Object.assign(trip, {
      ziel: (a.kurz || a.label) + " → " + (b.kurz || b.label),
      hinKm: Math.round(distKm), laender, anteile, stopps, hoehe, geo,
      startCoord: { lat: a.lat, lng: a.lng }, zielCoord: { lat: b.lat, lng: b.lng },
      fahrzeitMin: Math.round(fahrzeitMin), ankunftFinal,
      kaelte: trip.kaelte || "auto",
      geplantAm: new Date().toISOString(),
      routeNotiz: "Echte Route (" + n0(distKm) + " km, ~" + Math.floor(fahrzeitMin / 60) + " h " + Math.round(fahrzeitMin % 60) + " min reine Fahrzeit). Geplant mit " + n1(verbrauch) + " kWh/100 km bei " + state.fahrt.tempo + " km/h" + (state.settings.beladen ? ", beladen" : "") + ", Ankunft je Etappe ≥ " + state.settings.ankunftSoc + " %." + (hoehe ? " Höhenprofil: +" + n0(hoehe.aufstieg) + " m / −" + n0(hoehe.abstieg) + " m." : ""),
    });
    stoppsNeuBerechnen(trip); // rechnet zielFest (100 %-Regel) & Säulen-kW-Limits sauber ein
    // Eigene Routen-Historie: zuletzt geplante Strecken als 1-Tipp-Chips (keine Vorgaben)
    state.routenVerlauf = [{ start: state.planer.start, ziel: state.planer.ziel }]
      .concat((state.routenVerlauf || []).filter(v => v.start !== state.planer.start || v.ziel !== state.planer.ziel))
      .slice(0, 6);
    routeStatus = "";
    save(); render();
    routeKarte(trip);                          // erzeugt die Kachel-Liste der Karte …
    tilesCachen(routeKarte.letzteUrls || []);  // … und legt sie offline ab (Bosnien!)
    wetterHolen(trip); // asynchron, aktualisiert die Kälte-Automatik sobald da
  } catch (e) {
    routeStatus = "fehler:Planung fehlgeschlagen (" + e.message + "). Hinweis: Im claude.ai-Link sind externe Abfragen gesperrt — nutze die App über mintberry.org oder am PC.";
    render();
  }
}

// Punkt auf der gespeicherten Trip-Geometrie ([lat,lng]-Liste) bei Kilometer x
function tripPunktBeiKm(trip, km) {
  const g = trip.geo;
  if (!g || g.length < 2) return null;
  let cum = 0;
  for (let i = 1; i < g.length; i++) {
    cum += haversineKm(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]);
    if (cum >= km) return { lat: g[i][0], lng: g[i][1] };
  }
  return { lat: g[g.length - 1][0], lng: g[g.length - 1][1] };
}
// Umkehrfunktion: welcher Routen-km liegt einem Punkt (z. B. der Säule) am nächsten?
function tripKmBeiPunkt(trip, lat, lng) {
  const g = trip.geo;
  if (!g || g.length < 2) return null;
  let cum = 0, bestD = Infinity, bestKm = 0;
  for (let i = 1; i < g.length; i++) {
    cum += haversineKm(g[i - 1][0], g[i - 1][1], g[i][0], g[i][1]);
    const d = haversineKm(lat, lng, g[i][0], g[i][1]);
    if (d < bestD) { bestD = d; bestKm = cum; }
  }
  return bestKm;
}

/* „25 km früher/später“: Die App verschiebt den Stopp auf der echten Route,
   sucht dort AUTOMATISCH die beste Säule (gleiche Kriterien wie beim Planen)
   und zieht Folgestopps vor, wenn einer sonst unter die Reserve fallen würde. */
let verschiebeLauf = false;
async function stoppVerschieben(trip, st, deltaKm) {
  verschiebeLauf = true; render();
  try {
    const idx = trip.stopps.indexOf(st);
    const prevKm = idx > 0 ? trip.stopps[idx - 1].posKm : 0;
    const nextKm = idx < trip.stopps.length - 1 ? trip.stopps[idx + 1].posKm : trip.hinKm;
    const neuKm = Math.max(prevKm + 15, Math.min(nextKm - 15, st.posKm + deltaKm));
    await stoppNeuSuchen(trip, st, neuKm);
    await stoppKetteReparieren(trip);
  } catch (e) { /* offline o. Ä. — Position bleibt verschoben, Warnpille zeigt es */ }
  verschiebeLauf = false;
  save(); render();
}
// Säule an einer (neuen) Strecken-Position suchen und in den Stopp übernehmen
async function stoppNeuSuchen(trip, st, neuKm) {
  st.posKm = neuKm;
  const p = tripPunktBeiKm(trip, neuKm);
  if (p) { st.lat = p.lat; st.lng = p.lng; }
  // Eng um den Wunschpunkt suchen (12 km), damit nicht wieder dieselbe
  // Säule 25 km weiter gewählt wird; ohne Treffer weitet die Suche selbst aus
  const s = await ocmBesteSaeule(st.lat, st.lng, 12);
  if (s) {
    Object.assign(st, {
      name: s.name, op: s.op, kw: s.kw, adresse: s.adresse, lat: s.lat, lng: s.lng,
      anz: s.anz, warum: s.warum, score: s.score, status: s.status, statusAm: s.statusAm,
    });
    // Rechenposition auf den echten Routen-km der Säule einrasten
    const snap = tripKmBeiPunkt(trip, s.lat, s.lng);
    if (snap != null && Math.abs(snap - neuKm) < 60) st.posKm = Math.max(5, Math.min(trip.hinKm - 5, snap));
    st.platzhalter = false; st.angepasst = false; st.autoNeu = true;
  } else {
    st.platzhalter = true; st.angepasst = true; st.autoNeu = false;
    Object.assign(st, { name: "Geplanter Ladestopp", op: "", kw: 0, adresse: "", warum: null });
  }
  stoppsNeuBerechnen(trip);
}
// Folgestopps reparieren: Wer rechnerisch unter der Reserve ankäme, wird
// automatisch so weit vorgezogen, dass es wieder passt — inkl. neuer Säule
async function stoppKetteReparieren(trip) {
  const f = state.fahrzeug;
  const res = Math.min(0.5, Math.max(0.05, state.settings.ankunftSoc / 100));
  const verbrauch = verbrauchBeiTempo(state.fahrt.tempo, kaelteFaktor(trip));
  for (let runde = 0; runde < 4; runde++) {
    stoppsNeuBerechnen(trip);
    const st = trip.stopps.find(x => x.kritisch);
    if (!st) break;
    const idx = trip.stopps.indexOf(st);
    const prevKm = idx > 0 ? trip.stopps[idx - 1].posKm : 0;
    const socStart = idx > 0 ? trip.stopps[idx - 1].zielSoc : 100;
    const reichKm = (socStart - res * 100) / 100 * f.akkuNetto / verbrauch * 100;
    const zielKm = Math.max(prevKm + 15, prevKm + reichKm * 0.92);
    if (zielKm >= st.posKm - 5) break; // näher ran geht nicht — Warnung bleibt sichtbar
    await sleep(300);
    await stoppNeuSuchen(trip, st, zielKm);
  }
}

// Stopp verschoben -> SoC-Kette des Trips neu durchrechnen (ohne neue Säulensuche)
function stoppsNeuBerechnen(trip) {
  if (!trip.stopps || !trip.stopps.length) return;
  const f = state.fahrzeug;
  const res = Math.min(0.5, Math.max(0.05, state.settings.ankunftSoc / 100));
  const verbrauch = verbrauchBeiTempo(state.fahrt.tempo, kaelteFaktor(trip));
  trip.stopps.sort((a, b) => a.posKm - b.posKm);
  let soc = 100, prev = 0;
  for (const st of trip.stopps) {
    const ankunft = soc - (st.posKm - prev) * verbrauch / f.akkuNetto;
    const restKm = trip.hinKm - st.posKm;
    const braucht = restKm * verbrauch / f.akkuNetto + res * 100;
    const ziel = st.zielFest || Math.min(braucht > 80 ? 80 : Math.min(95, braucht + 3), 100);
    st.ankunftSoc = Math.round(ankunft);
    st.zielSoc = Math.round(ziel);
    st.ladeMin = Math.round(ladezeitMitLimit(Math.max(0, ankunft), ziel, st.kw));
    st.kwh = Math.round(Math.max(0, ziel - ankunft) / 100 * f.akkuNetto);
    st.kritisch = ankunft < res * 100 - 3;
    soc = ziel; prev = st.posKm;
  }
  trip.ankunftFinal = Math.round(soc - (trip.hinKm - prev) * verbrauch / f.akkuNetto);
}

/* ---------- Selbsttest: sind alle Dienste erreichbar? ---------- */
async function selbsttest() {
  const ziel = $("#selbsttest-out");
  if (!ziel) return;
  const zeile = (name, ok, info) => `<li>${ok ? "🟢" : "🔴"} <b>${esc(name)}</b> — ${esc(info)}</li>`;
  ziel.innerHTML = "<li>⏳ teste …</li>";
  const ergebnisse = [];
  const key = (state.settings.ocmKey || "").trim();
  const tests = [
    ["Tarif-Quelle GitHub", async () => {
      const r = await fetch(UPDATE_QUELLEN[1] || UPDATE_QUELLEN[0], { cache: "no-store" });
      const js = await r.json(); return "erreichbar, Preisstand " + datumDE(js.preisstand);
    }],
    ["Säulen-Daten (OpenChargeMap)", async () => {
      if (!key) throw new Error("kein Key");
      const r = await fetch("https://api.openchargemap.io/v3/poi/?output=json&maxresults=1&latitude=48.1&longitude=11.5&key=" + encodeURIComponent(key));
      if (!r.ok) throw new Error("HTTP " + r.status);
      return "Key funktioniert";
    }],
    ["Routing (OSRM)", async () => {
      const r = await fetch("https://router.project-osrm.org/route/v1/driving/11.5,48.1;11.6,48.2?overview=false");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return "erreichbar";
    }],
    ["Adress-Suche (Nominatim)", async () => {
      const r = await fetch("https://nominatim.openstreetmap.org/status?format=json");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return "erreichbar";
    }],
    ["Wetter (Open-Meteo)", async () => {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=48.1&longitude=11.5&daily=temperature_2m_min&forecast_days=1");
      if (!r.ok) throw new Error("HTTP " + r.status);
      return "erreichbar";
    }],
  ];
  for (const [name, fn] of tests) {
    try { ergebnisse.push(zeile(name, true, await fn())); }
    catch (e) { ergebnisse.push(zeile(name, false, e.message)); }
    ziel.innerHTML = ergebnisse.join("") + "<li>⏳ …</li>";
  }
  const sw = ("serviceWorker" in navigator) ? await navigator.serviceWorker.getRegistration() : null;
  ergebnisse.push(zeile("Offline-Modus (Service Worker)", !!sw, sw ? "aktiv — App startet auch ohne Netz" : "nicht aktiv (nur über HTTPS/mintberry)"));
  ergebnisse.push(zeile("Preisstand", (new Date() - new Date(state.settings.preiseGeprueft)) / 864e5 < 14, "Stand " + datumDE(state.settings.preiseGeprueft)));
  ziel.innerHTML = ergebnisse.join("");
}

/* ---------- Benachrichtigung (Blockier-Timer) ----------
   Erlaubnis wird erst beim Timer-Start erfragt (kontextbezogen, Best Practice) —
   zuverlässig, solange die App im Hintergrund geöffnet ist. */
async function benachrichtige(titel, text) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) reg.showNotification(titel, { body: text, tag: "lkc-timer", vibrate: [200, 100, 200] });
    else new Notification(titel, { body: text });
  } catch (e) { /* nicht unterstützt — die Anzeige in der App bleibt */ }
}

/* ---------- Monats-Rückblick (aus dem Logbuch) ---------- */
function monatsReport() {
  const l = state.logbuch;
  if (!l.length) return null;
  const d = new Date(); d.setDate(0);                       // letzter Tag des Vormonats
  const vm = d.toISOString().slice(0, 10).slice(0, 7);
  const d2 = new Date(d); d2.setDate(0);
  const vvm = d2.toISOString().slice(0, 10).slice(0, 7);
  const im = (m) => l.filter(e => (e.datum || "").startsWith(m));
  const s = (arr, f) => arr.reduce((x, e) => x + (+e[f] || 0), 0);
  const cur = im(vm);
  if (!cur.length) return null;
  const kwh = s(cur, "kwh"), eurS = s(cur, "kosten");
  const vorher = im(vvm);
  return {
    monat: vm, anz: cur.length, kwh, eur: eurS,
    schnitt: kwh ? eurS / kwh : null,
    vsAdhoc: kwh * 0.79 - eurS,
    trend: vorher.length ? eurS - s(vorher, "kosten") : null,
  };
}

/* ---------- Sprachausgabe (Fahrmodus) ---------- */
function sprechen(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "de-DE"; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch (e) { alert(text); }
}

/* ---------- Profil-Sicherung auf dem Pi (je Nutzer eigener Stand) ---------- */
function profilName() {
  return (state.settings.profilName || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
}
async function profilSichern() {
  const name = profilName();
  if (!name) { alert("Bitte zuerst einen Profilnamen eintragen (z. B. nino)."); return; }
  try {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(state))));
    const r = await fetch("/api/webhook/" + encodeURIComponent(state.settings.webhookId || "lkc-profil-sichern"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profil: name, b64 }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    alert("✓ Profil „" + name + "“ auf dem Pi gesichert.");
  } catch (e) {
    alert("Sichern fehlgeschlagen (" + e.message + "). Läuft die App über mintberry.org und ist die Home-Assistant-Automatisierung eingerichtet? (Wissen → Profil-Sicherung)");
  }
}
async function profilLaden() {
  const name = profilName();
  if (!name) { alert("Bitte zuerst einen Profilnamen eintragen."); return; }
  try {
    const r = await fetch("/local/ladekarten/profil-" + name + ".json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const js = await r.json();
    if (!js.tarife || !js.orte) throw new Error("Datei unvollständig");
    if (!confirm("Profil „" + name + "“ vom Pi laden und die Daten auf DIESEM Gerät ersetzen?")) return;
    localStorage.setItem(LS_KEY, JSON.stringify(js));
    loadState(); render();
    alert("✓ Profil geladen.");
  } catch (e) {
    alert("Laden fehlgeschlagen (" + e.message + "). Wurde dieses Profil schon einmal gesichert?");
  }
}

/* ---------- Tarif-Updates (tarife.json neben der App) ---------- */
let updateInfo = null;
let updateCheck = "";   // "" | "läuft" | "aktuell" (für den manuellen Update-Knopf)
async function checkTarifUpdate(manuell) {
  if (manuell) { updateCheck = "läuft"; render(); }
  // Alle bekannten Quellen abfragen und den NEUESTEN Preisstand übernehmen:
  // tarife.json neben der App, die eingestellte Update-URL und die
  // fest hinterlegten Quellen (z. B. GitHub, automatisch monatlich aktualisiert).
  const quellen = new Set();
  if (/^https?:$/.test(location.protocol)) quellen.add("tarife.json");
  const u = (state.settings.updateUrl || "").trim();
  if (u) quellen.add(u);
  (typeof UPDATE_QUELLEN !== "undefined" ? UPDATE_QUELLEN : []).forEach(q => quellen.add(q));
  let bestes = null;
  for (const q of quellen) {
    try {
      const r = await fetch(q, { cache: "no-store" });
      if (!r.ok) continue;
      const js = await r.json();
      if (js && js.preisstand && Array.isArray(js.tarife) &&
        (!bestes || js.preisstand > bestes.preisstand)) bestes = js;
    } catch (e) { /* Quelle nicht erreichbar — nächste probieren */ }
  }
  if (bestes && bestes.preisstand > state.settings.preiseGeprueft) {
    // Vollautomatisch übernehmen (eigene Preis-Änderungen bleiben geschützt),
    // auf der Startseite erscheint nur noch eine Erfolgsnotiz.
    updateInfo = bestes;
    updateHinweis = bestes.preisstand;
    updateCheck = "";
    applyTarifUpdate();
  } else if (manuell) {
    updateCheck = "aktuell";
    render();
  }
}
let updateHinweis = null;
function applyTarifUpdate() {
  if (!updateInfo) return;
  // Persönlicher Preis-Alarm: Betrifft eine Änderung DEINE Karten/Abos?
  const minPreis = (t) => {
    const ps = [];
    for (const p of Object.values(t.preise || {})) { if (p.ac != null) ps.push(p.ac); if (p.dc != null) ps.push(p.dc); }
    if (t.roaming) { if (t.roaming.ac != null) ps.push(t.roaming.ac); if (t.roaming.dc != null) ps.push(t.roaming.dc); }
    return ps.length ? Math.min(...ps) : null;
  };
  const alarme = [];
  for (const neu of updateInfo.tarife) {
    const altT = state.tarife.find(t => t.id === neu.id);
    if (!altT || altT.editiert || !besitzt(altT)) continue;
    const a = minPreis(altT), n = minPreis(neu);
    if (a != null && n != null && Math.abs(n - a) >= 0.005) alarme.push({ name: neu.name, alt: a, neu: n, feld: "€/kWh (Bestpreis)" });
    else if ((altT.grund || 0) !== (neu.grund || 0)) alarme.push({ name: neu.name, alt: altT.grund || 0, neu: neu.grund || 0, feld: "€/Monat Grundgebühr" });
  }
  if (alarme.length) state.preisAlarm = { stand: updateInfo.preisstand, liste: alarme.slice(0, 6) };
  for (const neu of updateInfo.tarife) {
    const i = state.tarife.findIndex(t => t.id === neu.id);
    if (i >= 0) { if (!state.tarife[i].editiert) state.tarife[i] = neu; }
    else state.tarife.push(neu);
  }
  if (Array.isArray(updateInfo.entfernt)) {
    state.tarife = state.tarife.filter(t => !updateInfo.entfernt.includes(t.id) || t.editiert);
  }
  state.settings.preiseGeprueft = updateInfo.preisstand;
  // Aktionen (befristete Angebote) und belegte Änderungen aus dem Update übernehmen
  if (Array.isArray(updateInfo.aktionen)) state.aktionen = updateInfo.aktionen;
  if (Array.isArray(updateInfo.aenderungen) && updateInfo.aenderungen.length) {
    state.aenderungsLog = { stand: updateInfo.preisstand, liste: updateInfo.aenderungen.slice(0, 20) };
  }
  updateInfo = null; save(); render();
}

/* ---------- Break-even-Chart (SVG-Liniendiagramm) ---------- */
const CHART_KONTEXTE = [
  { id: "dc-autobahn", label: "Langstrecke: Ionity an der Autobahn", netz: "ionity", art: "dc" },
  { id: "dc-enbw", label: "Schnellladen: EnBW-Säulen", netz: "enbw", art: "dc" },
  { id: "dc-aral", label: "Schnellladen: Aral pulse", netz: "aral", art: "dc" },
  { id: "dc-tesla", label: "Schnellladen: Tesla Supercharger", netz: "tesla", art: "dc" },
  { id: "ac-swm", label: "AC in München: SWM-Säulen", netz: "swm", art: "ac" },
];

function breakEvenChart(kontextId) {
  const ctx = CHART_KONTEXTE.find(c => c.id === kontextId) || CHART_KONTEXTE[0];
  let linien = preiseAnNetz(ctx.netz, ctx.art);
  // Deckungsgleiche Linien (gleicher Preis + Grundgebühr) nur einmal zeigen
  const gesehen = new Set();
  linien = linien.filter(l => {
    const k = (l.grund || 0).toFixed(2) + "|" + l.preis.toFixed(3);
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
  // max. 5 Serien: günstigste Abos + günstigste freie + ad-hoc als Referenz
  const frei = linien.filter(l => !l.grund).slice(0, 2);
  const abos = linien.filter(l => l.grund > 0).slice(0, 2);
  const adhoc = linien.find(l => l.tarif.id === "adhoc");
  let auswahl = [...frei, ...abos];
  if (adhoc && !auswahl.includes(adhoc)) auswahl.push(adhoc);
  auswahl = auswahl.slice(0, 5);

  const maxKwh = 250, W = 680, H = 320, padL = 46, padR = 150, padT = 16, padB = 34;
  const maxY = Math.max(...auswahl.map(l => l.grund + l.preis * maxKwh)) * 1.05;
  const X = kwh => padL + (kwh / maxKwh) * (W - padL - padR);
  const Y = c => H - padB - (c / maxY) * (H - padT - padB);
  const farben = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s5)", "var(--s4)"];

  let grid = "";
  for (let c = 0; c <= maxY; c += 25) {
    grid += `<line x1="${padL}" y1="${Y(c)}" x2="${W - padR}" y2="${Y(c)}" stroke="var(--grid)" stroke-width="1"/>`;
    grid += `<text x="${padL - 6}" y="${Y(c) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${c}</text>`;
  }
  for (let k = 0; k <= maxKwh; k += 50) {
    grid += `<text x="${X(k)}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="var(--muted)">${k}</text>`;
  }
  // Linien + Direktbeschriftungen (mit Kollisions-Auflösung: min. 13 px Abstand)
  const yEnds = auswahl.map((l, i) => ({ i, y: Y(l.grund + l.preis * maxKwh) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < yEnds.length; k++) if (yEnds[k].y - yEnds[k - 1].y < 13) yEnds[k].y = yEnds[k - 1].y + 13;
  const yLabel = []; yEnds.forEach(e => { yLabel[e.i] = e.y; });
  let paths = "", labels = "";
  auswahl.forEach((l, i) => {
    paths += `<path d="M ${X(0)} ${Y(l.grund)} L ${X(maxKwh)} ${Y(l.grund + l.preis * maxKwh)}" stroke="${farben[i]}" stroke-width="2" fill="none"/>`;
    labels += `<text x="${W - padR + 8}" y="${yLabel[i] + 4}" font-size="11" font-weight="600" fill="${farben[i]}">${esc(kurzName(l.tarif))}</text>`;
  });
  // Break-even-Punkte: Abos vs. beste freie Linie — Marker in der FARBE der Abo-Linie,
  // plus Klartext-Liste (auch wenn der Punkt außerhalb des Diagramms liegt)
  let marker = "";
  const beListe = [];
  const besteFrei = frei[0];
  if (besteFrei) {
    auswahl.forEach((l, i) => {
      if (!l.grund) return;
      if (l.preis >= besteFrei.preis) {
        beListe.push({ farbe: farben[i], text: `${l.tarif.name}: lohnt sich hier NIE (pro kWh nicht günstiger als ${kurzName(besteFrei.tarif)})` });
        return;
      }
      const kStar = l.grund / (besteFrei.preis - l.preis);
      beListe.push({ farbe: farben[i], text: `${l.tarif.name}: lohnt ab ${Math.round(kStar)} kWh/Monat (gegenüber ${kurzName(besteFrei.tarif)})${kStar >= maxKwh ? " — liegt außerhalb des Diagramms" : ""}` });
      if (kStar > 0 && kStar < maxKwh) {
        const cStar = l.grund + l.preis * kStar;
        marker += `<circle cx="${X(kStar)}" cy="${Y(cStar)}" r="6" fill="${farben[i]}" stroke="var(--card)" stroke-width="2.5"/>` +
          `<text x="${X(kStar)}" y="${Y(cStar) - 11}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${farben[i]}">${Math.round(kStar)} kWh</text>`;
      }
    });
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monatskosten je nach Lademenge">
    ${grid}
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--hairline)" stroke-width="1"/>
    ${paths}${marker}${labels}
    <text x="${padL}" y="${H - 4}" font-size="10" fill="var(--muted)">kWh pro Monat →</text>
    <text x="12" y="${padT}" font-size="10" fill="var(--muted)">€/Monat</text>
    <rect class="hover-rect" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/>
  </svg>`;
  const legende = auswahl.map((l, i) => `<span><span class="dot" style="background:${farben[i]}"></span>${esc(l.tarif.name)} (${l.grund ? eur(l.grund, 2) + "/Mon. + " : ""}${ct(l.preis)})${l.unsicher ? " ⚠" : ""}</span>`).join("");
  let tabelle = `<div class="tblwrap"><table><tr><th>Tarif</th><th class="num">50 kWh</th><th class="num">100 kWh</th><th class="num">150 kWh</th><th class="num">200 kWh</th></tr>`;
  for (const l of auswahl) {
    tabelle += `<tr><td>${esc(l.tarif.name)}</td>` + [50, 100, 150, 200].map(k => `<td class="num">${eur(l.grund + l.preis * k)}</td>`).join("") + `</tr>`;
  }
  tabelle += `</table></div>`;
  return { svg, legende, tabelle, beListe, ctx, auswahl, maxKwh, geom: { W, H, padL, padR, padT, padB, maxY } };
}
function kurzName(t) {
  return t.name.replace("EnBW mobility+ ", "EnBW ").replace(" EinfachStromLaden", "").replace(" (Kaufland-App)", "").replace("Ionity ", "Ionity ").replace(" Supercharger-Mitgliedschaft", "-Abo").replace("Ad-hoc (Kreditkarte/QR an der Säule)", "Ad-hoc").replace(" (Aral pulse)", "").slice(0, 24);
}

/* ============================================================
   ANSICHTEN
   ============================================================ */
const TABS = [
  { id: "start", label: "Start", icon: "M3 11.5 12 4l9 7.5M5.5 10v9h13v-9" },
  { id: "orte", label: "Orte", icon: "M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" },
  { id: "tarife", label: "Tarife", icon: "M4 6h16v12H4zM4 10h16M8 14h4" },
  { id: "trips", label: "Trips", icon: "M4 17c3-6 6 2 9-4s5-2 7-6M5 20h14" },
  { id: "fahren", label: "Fahren", icon: "M12 3a9 9 0 1 0 9 9M12 12l6-6M12 12h.01" },
  { id: "wissen", label: "Wissen", icon: "M12 4c-2-1.5-5-1.5-7 0v14c2-1.5 5-1.5 7 0 2-1.5 5-1.5 7 0V4c-2-1.5-5-1.5-7 0v14" },
];

function render() {
  renderNav();
  const main = $("#main");
  const fn = { start: viewStart, orte: viewOrte, tarife: viewTarife, trips: viewTrips, fahren: viewFahren, wissen: viewWissen }[state.tab] || viewStart;
  const scrollVorher = window.scrollY;
  main.innerHTML = `<div class="tabpane wrap">${fn()}</div>`;
  bindDynamic();
  // Nur beim Tab-Wechsel nach oben springen — sonst Leseposition behalten
  if (render.letzterTab !== state.tab) window.scrollTo(0, 0);
  else window.scrollTo(0, scrollVorher);
  render.letzterTab = state.tab;
}

function renderNav() {
  // Einfacher Modus: nur Start, Fahren, Wissen (z. B. für Familie/Schwager)
  const sichtbar = state.settings.einfach ? TABS.filter(t => ["start", "fahren", "wissen"].includes(t.id)) : TABS;
  if (!sichtbar.find(t => t.id === state.tab)) state.tab = "start";
  // To-do-Zähler am Start-Tab: sehen, dass etwas ansteht — ohne zu lesen
  let badge = 0;
  try { badge = aktionen(monatsAnalyse()).length + (state.preisAlarm ? 1 : 0); } catch (e) { /* Startphase */ }
  const bd = (t) => t.id === "start" && badge ? `<span class="badge">${badge}</span>` : "";
  const mk = (t) => `<button data-tab="${t.id}" class="${state.tab === t.id ? "on" : ""}" aria-label="${t.label}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg>${t.label}${bd(t)}</button>`;
  const bar = $("#tabbar");
  bar.innerHTML = sichtbar.map(mk).join("");
  bar.style.gridTemplateColumns = `repeat(${sichtbar.length}, 1fr)`;
  $("#topnav").innerHTML = sichtbar.map(t => `<button data-tab="${t.id}" class="${state.tab === t.id ? "on" : ""}">${t.label}${bd(t)}</button>`).join("");
  // Fahrzeug-Zeile im Kopf folgt dem Profil
  const sub = $("#fzgsub");
  if (sub) sub.textContent = state.fahrzeug.name;
}

/* ---------- Start / Dashboard ---------- */
function viewStart() {
  const ana = monatsAnalyse();
  const acts = aktionen(ana);
  let html = "";

  // ---------- Kontext zuerst: Was ist JETZT wichtig? ----------
  // Läuft gerade eine Ladung? Timer-Status ganz oben, egal wo gestartet
  if (state.ladeTimer) {
    const minL = Math.floor((Date.now() - state.ladeTimer.start) / 60000);
    const restL = state.ladeTimer.grenze == null ? null : state.ladeTimer.grenze - minL;
    html += `<div class="card alert ${restL != null && restL <= 10 ? "crit" : "good"}"><p>⏱ <b>Laden läuft — ${minL} min</b>${restL != null ? (restL > 0 ? ` · noch ${restL} min bis zur Blockiergebühr` : " · <b>Blockiergebühr läuft!</b>") : ""}</p>
      <div class="btnrow"><button class="btn small primary" data-tab="fahren">Zum Timer</button></div></div>`;
  }
  // Heute unterwegs? Live-Ansicht mit dem nächsten Stopp
  const heuteTrip = state.trips.find(t => t.datum === heute() && t.stopps && t.stopps.length);
  if (heuteTrip) {
    const lIdx = Math.min(heuteTrip.liveStopp || 0, heuteTrip.stopps.length);
    const lSt = heuteTrip.stopps[lIdx];
    html += `<div class="card alert info"><h3>🚗 Heute: ${esc(heuteTrip.ziel)} ${iBtn("live-notfall")}</h3>
      ${iBox("live-notfall", "Wenn's an der Säule hakt: 1) Zweitkarte/App probieren · 2) Ad-hoc per QR/Kreditkarte · 3) Hotline auf der Säule anrufen · 4) unter 10 % Akku: nächsten Standort ansteuern, nicht warten. Säulen in der Nähe zeigt dir jederzeit der Fahrmodus.")}` +
      (lSt ? `<p><b>Nächster Stopp ${lIdx + 1}/${heuteTrip.stopps.length}:</b> ${esc(lSt.name)} — km ${n0(lSt.posKm)}, Ankunft ~${lSt.ankunftSoc} %, laden auf ${lSt.zielSoc} % (~${lSt.ladeMin} min)</p>
      <div class="btnrow">
        <a class="btn small primary" href="${mapsUrl(lSt)}" target="_blank" rel="noopener">🗺 Navigation</a>
        <button class="btn small" data-action="station-teilen" data-id="${esc(heuteTrip.id + "-" + lSt.id)}">📤 Ans Auto</button>
        <button class="btn small ghost" data-action="live-weiter" data-id="${esc(heuteTrip.id)}">✓ Stopp erledigt</button>
      </div>` : `<p>✅ Alle Ladestopps erledigt — Ankunft mit ~${heuteTrip.ankunftFinal != null ? heuteTrip.ankunftFinal : "?"} % Akku. Gute Fahrt!</p>
      <div class="btnrow"><button class="btn small ghost" data-action="live-reset" data-id="${esc(heuteTrip.id)}">↺ Stopps zurücksetzen</button></div>`) + `</div>`;
  }
  // Trip morgen/übermorgen: Countdown + offene Vorbereitung
  const nT = state.trips.filter(t => t.datum && t.datum > heute()).sort((a, b) => a.datum.localeCompare(b.datum))[0];
  if (nT) {
    const tg = Math.ceil((new Date(nT.datum) - new Date()) / 864e5);
    const clN = tripCheckliste(nT, tripAnalyse(nT));
    const offen = clN.filter((x, i) => !state.checks[nT.id + "-" + i]).length;
    html += `<div class="card alert info"><p>🧳 <b>${tg === 1 ? "Morgen" : "In " + tg + " Tagen"}: ${esc(nT.ziel)}</b>${offen ? ` — noch <b>${offen}</b> Punkt${offen === 1 ? "" : "e"} auf der Checkliste` : " — Checkliste komplett ✓"}</p>
      <div class="btnrow"><button class="btn small primary" data-tab="trips">Zum Trip</button></div></div>`;
  }

  // Erster Start: 3 kurze Fragen statt Erklärtext — danach ist alles vorbefüllt
  if (!state.settings.introWeg) {
    const schritt = state.settings.onboarding || 1;
    if (schritt === 1) {
      const startKarten = ["maingau", "enbw-s", "kaufland-app", "aldi-app", "electroverse", "tesla-app"];
      html += `<div class="card alert info"><h3>👋 Los geht's — Frage 1 von 3</h3>
        <p><b>Welche Lade-Karten oder -Apps hast du schon?</b></p>
        ${startKarten.map(kid => { const t = state.tarife.find(x => x.id === kid); return t ? `<label style="display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer"><input type="checkbox" data-obkarte="${t.id}" ${state.karten[t.id] ? "checked" : ""}> <span class="small">${esc(t.name)}</span></label>` : ""; }).join("")}
        <div class="btnrow"><button class="btn small primary" data-action="ob-weiter">Weiter →</button><button class="btn small ghost" data-action="intro-weg">Überspringen</button></div></div>`;
    } else if (schritt === 2) {
      html += `<div class="card alert info"><h3>Frage 2 von 3</h3>
        <p><b>Wie viel fährst du ungefähr pro Monat?</b> <span class="muted small">Daraus schätzt die App deine Lademenge — später unter „Orte“ jederzeit anpassbar.</span></p>
        <div class="btnrow">${[500, 1000, 1500, 2500].map(km => `<button class="btn small" data-action="ob-km" data-km="${km}">~${n0(km)} km</button>`).join("")}<button class="btn small ghost" data-action="ob-weiter">Überspringen</button></div></div>`;
    } else {
      html += `<div class="card alert info"><h3>Frage 3 von 3</h3>
        <p><b>Deine Heim-Adresse?</b> <span class="muted small">Bleibt nur auf diesem Gerät — als Favorit im Routen-Planer und für „Säulen in der Nähe“.</span></p>
        <div class="frow" style="align-items:flex-end">
          <div style="flex:3 1 200px"><input type="text" id="ob-adresse" placeholder="z. B. Musterstr. 1, München"></div>
          <div style="flex:1 1 120px"><button class="btn small primary" data-action="ob-fertig" style="width:100%">Fertig ✓</button></div>
        </div>
        <div class="btnrow"><button class="btn small ghost" data-action="intro-weg">Überspringen</button></div></div>`;
    }
  }

  // Als App installieren — ein Tipp statt Menü-Anleitung (nur wenn möglich & noch nicht installiert)
  if (installPrompt && !(window.matchMedia && matchMedia("(display-mode: standalone)").matches)) {
    html += tipp("install", `<p>📲 <b>Als App installieren</b> — eigenes Icon auf dem Startbildschirm, Vollbild, startet auch offline.</p>
      <div class="btnrow"><button class="btn small primary" data-action="installieren">Jetzt installieren</button></div>`);
  }

  // Tarif-Update wurde beim Start automatisch übernommen
  if (updateHinweis) {
    html += `<div class="card alert good"><p>✓ <b>Tarife automatisch aktualisiert</b> — Preisstand ${datumDE(updateHinweis)}. Deine eigenen Änderungen blieben unangetastet.</p></div>`;
  }
  // Persönlicher Preis-Alarm: Änderungen bei DEINEN Karten/Abos
  if (state.preisAlarm && state.preisAlarm.liste && state.preisAlarm.liste.length) {
    const teurer = state.preisAlarm.liste.some(a => a.neu > a.alt);
    html += `<div class="card alert ${teurer ? "" : "good"}"><h3>${teurer ? "⚠️ Preisänderung bei deinen Karten" : "🎉 Deine Karten wurden günstiger"}</h3>
      <ul class="clean">${state.preisAlarm.liste.map(a => `<li><b>${esc(a.name)}</b>: ${a.alt.toLocaleString("de-DE")} → ${a.neu.toLocaleString("de-DE")} ${esc(a.feld)} ${a.neu > a.alt ? '<span class="pill crit">teurer</span>' : '<span class="pill good">günstiger</span>'}</li>`).join("")}</ul>
      <p class="small">Alle Empfehlungen und To-dos sind bereits mit den neuen Preisen berechnet.</p>
      <div class="btnrow"><button class="btn small" data-action="preisalarm-weg">Verstanden</button></div></div>`;
  }
  // Kälte-Check kurz vor einem Trip (Wetterdaten werden beim App-Start aufgefrischt)
  for (const trK of state.trips) {
    if (!trK.datum) continue;
    const tageK = Math.round((new Date(trK.datum) - new Date()) / 864e5);
    if (tageK < 0 || tageK > 2) continue;
    if (kaelteFaktor(trK) <= 1.05) continue;
    html += `<div class="card alert"><p>🌡️ <b>${esc(trK.ziel)}</b> ${tageK === 0 ? "heute" : tageK === 1 ? "morgen" : "übermorgen"}: ${esc(kaelteText(trK))}.</p>
      <div class="btnrow"><button class="btn small primary" data-action="trip-kaelte-calc" data-id="${esc(trK.id)}">Stopps mit Kälte neu berechnen</button></div></div>`;
  }
  // Monats-Rückblick (einmal pro Monat, wegklickbar)
  const rep = monatsReport();
  if (rep) {
    const mName = new Date(rep.monat + "-01T12:00:00").toLocaleDateString("de-DE", { month: "long", year: "numeric" });
    html += tipp("report-" + rep.monat, `<h3>📅 Dein Lade-Monat ${esc(mName)}</h3>
      <div class="hero">
        <div class="stat"><div class="v num">${eur(rep.eur, 0)}</div><div class="l">${n0(rep.kwh)} kWh · ${rep.anz} Ladungen</div></div>
        <div class="stat"><div class="v num">${rep.schnitt != null ? rep.schnitt.toLocaleString("de-DE", { maximumFractionDigits: 2 }) : "–"}<span class="unit"> €/kWh</span></div><div class="l">Ø-Preis</div></div>
        <div class="stat"><div class="v num">${eur(rep.vsAdhoc, 0)}</div><div class="l">gespart vs. Ad-hoc</div></div>
        ${rep.trend != null ? `<div class="stat"><div class="v num">${rep.trend <= 0 ? "↘" : "↗"} ${eur(Math.abs(rep.trend), 0)}</div><div class="l">vs. Vormonat</div></div>` : ""}
      </div>`);
  }
  // Belegte Änderungen des letzten Updates (mit Quellen)
  if (state.aenderungsLog && state.aenderungsLog.liste && state.aenderungsLog.liste.length) {
    html += `<div class="card flat"><details class="plain"><summary>📝 Was hat sich zuletzt geändert? (Stand ${datumDE(state.aenderungsLog.stand)})</summary>
      <ul class="dots">${state.aenderungsLog.liste.map(a => `<li><b>${esc(a.id || "")}</b>: ${esc(a.was || "")} ${a.alt != null ? esc(String(a.alt)) + " → " + esc(String(a.neu)) : ""} ${a.quelle ? `<a href="${esc(a.quelle)}" target="_blank" rel="noopener">Quelle</a>` : ""}</li>`).join("")}</ul>
    </details></div>`;
  }
  // Aktions-Radar: befristete Angebote (aus dem wöchentlichen Update)
  const aktiveAktionen = (state.aktionen || []).filter(a => a.bis && a.bis >= heute());
  if (aktiveAktionen.length) {
    html += `<div class="card alert info"><h3>🏷️ Laufende Aktionen</h3><ul class="clean">` +
      aktiveAktionen.map(a => {
        const tageNoch = Math.ceil((new Date(a.bis) - new Date()) / 864e5);
        return `<li><b>${esc(a.anbieter || "")}</b>: ${esc(a.text || "")} <span class="pill warn">noch ${tageNoch} Tag${tageNoch === 1 ? "" : "e"}</span></li>`;
      }).join("") + `</ul></div>`;
  }

  // Preis-Stand-Warnung
  const tage = Math.floor((new Date() - new Date(state.settings.preiseGeprueft)) / 864e5);
  if (tage > 60) {
    html += `<div class="card alert"><h3>⚠️ Preise veraltet (${tage} Tage)</h3>
      <p>Ladepreise ändern sich oft. Bitte unter <b>Tarife</b> kurz gegen die Anbieter-Apps prüfen und auf „Preise geprüft“ tippen.</p></div>`;
  }

  // Hero-Zahlen
  html += `<div class="card"><div class="eyebrow">Dein Ladeprofil pro Monat</div>
    <div class="hero">
      <div class="stat"><div class="v num">${eur(ana.kosten.gesamt, 0)}</div><div class="l">Ladekosten/Monat (davon ${eur(ana.kosten.grund, 2)} Abos)</div></div>
      <div class="stat"><div class="v num">${n0(ana.kwhGesamt)}<span class="unit"> kWh</span></div><div class="l">geplante Lademenge (≈ ${n0(ana.kmGeschaetzt)} km)</div></div>
      <div class="stat"><div class="v num">${ana.kwhGesamt ? (ana.kosten.gesamt / ana.kmGeschaetzt * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 }) : "–"}<span class="unit"> €/100 km</span></div><div class="l">Energiekosten-Schnitt</div></div>
    </div></div>`;

  if (!ana.kwhGesamt) {
    html += `<div class="card alert info"><h3>📍 Erster Schritt: deine Ladeorte</h3>
      <p>Trage unter <b>Orte</b> ein, wo und wie viel (kWh/Monat) du laden wirst — erst dann kann die App Karten-Empfehlungen, To-dos und Break-even für dich rechnen. Für Reisen: direkt zu <b>Trips</b>.</p>
      <div class="btnrow"><button class="btn small primary" data-tab="orte">Zu den Orten</button><button class="btn small" data-tab="trips">Route planen</button></div></div>`;
  }

  // Statistik aus dem Lade-Logbuch (echte Zahlen) — auf Abruf
  const stat = logbuchStatistik();
  if (stat) {
    html += `<div class="card flat"><details class="plain"><summary>📊 Deine echten Zahlen (${stat.anz} Ladungen · ${eur(stat.eurM, 0)} diesen Monat)</summary>
      <div class="hero" style="margin-top:10px">
        <div class="stat"><div class="v num">${eur(stat.eurM, 0)}</div><div class="l">diesen Monat (${n0(stat.kwhM)} kWh)</div></div>
        <div class="stat"><div class="v num">${stat.schnittG != null ? stat.schnittG.toLocaleString("de-DE", { maximumFractionDigits: 2 }) : "–"}<span class="unit"> €/kWh</span></div><div class="l">dein Ø-Preis gesamt</div></div>
        <div class="stat"><div class="v num">${eur(stat.ersparnisAdhoc, 0)}</div><div class="l">gespart vs. Ad-hoc (0,79 €)</div></div>
        ${stat.benzinVergleich != null ? `<div class="stat"><div class="v num">${eur(stat.benzinVergleich, 0)}</div><div class="l">gespart vs. Benziner (8 l, 1,80 €)</div></div>` : ""}
      </div>
      ${stat.verbrauchEcht != null ? `<p class="small">Echter Ø-Verbrauch aus deinen km-Angaben: <b>${n1(stat.verbrauchEcht)} kWh/100 km</b>.</p>` : ""}
    </details></div>`;
  }

  // Aktionen
  if (!state.settings.einfach && acts.length) {
    html += `<div class="card"><h2>📋 Deine To-dos (automatisch berechnet)</h2><ul class="clean">`;
    for (const a of acts) {
      if (a.typ === "bestellen") {
        const akt = tarifAktion(a.tarif);
        html += `<li><span class="pill acc">Einrichten</span> <b>${esc(a.tarif.name)}</b> ${akt ? `<span class="pill warn">🏷 Aktion: ${esc(akt.text)} (bis ${datumDE(akt.bis)})</span>` : ""}<br>
          <small><b>Warum:</b> günstigste Option an mindestens einem deiner Orte. <b>Beschaffung:</b> ${esc(kartenKostenText(a.tarif))}, keine laufenden Kosten.</small>
          <div class="btnrow"><button class="btn small primary" data-action="karte-da" data-id="${a.tarif.id}">✓ Hab ich erledigt</button></div></li>`;
      } else if (a.typ === "abonnieren") {
        const t = a.tarif;
        html += `<li><span class="pill good">Abonnieren</span> <b>${esc(t.name)}</b> — spart <b>${eur(a.ersparnis)}/Monat</b>
          <div class="calcbox">
            <div class="line"><span>Preisvorteil an deinen Orten</span><span>Ø ${ct(a.vorteil)} × ${n0(a.kwh)} kWh = ${eur(a.vorteil * a.kwh)}</span></div>
            <div class="line"><span>− Grundgebühr</span><span>${eur(t.grund)}</span></div>
            <div class="line total"><span>Netto-Ersparnis</span><span>+${eur(a.ersparnis)}/Monat</span></div>
            <div class="line"><span>Lohnt sich ab</span><span>${a.breakEven ? n0(a.breakEven) + " kWh/Monat (du planst " + n0(a.kwh) + ")" : "–"}</span></div>
          </div>
          <div class="btnrow"><button class="btn small primary" data-action="abo-an" data-id="${t.id}">✓ Abo abgeschlossen</button></div></li>`;
      } else {
        html += `<li><span class="pill crit">Kündigen</span> <b>${esc(a.tarif.name)}</b><br><small>${esc(a.text)} Monatlich kündbar.</small>
          <div class="btnrow"><button class="btn small" data-action="abo-aus" data-id="${a.tarif.id}">✓ Gekündigt</button></div></li>`;
      }
    }
    html += `</ul></div>`;
  } else if (!state.settings.einfach) {
    html += `<div class="card alert good"><p>✅ <b>Setup passt</b> — Karten und Abos entsprechen deinem Ladeprofil, nichts zu tun.</p></div>`;
  }

  // Wo lade ich wie günstig — auf Abruf
  if (!state.settings.einfach && ana.kosten.detail.length) {
    html += `<div class="card flat"><details class="plain"><summary>💶 Günstigster Preis je Ort (Summe ${eur(ana.kosten.gesamt)})</summary><div class="tblwrap"><table>
      <tr><th>Ort</th><th>Womit</th><th class="num">Preis</th><th class="num">€/Monat</th></tr>`;
    for (const d of ana.kosten.detail) {
      html += `<tr><td>${esc(d.ort.name)}</td><td>${esc(d.tarifName)}${d.unsicher ? " ⚠" : ""}</td><td class="num">${ct(d.preis)}</td><td class="num">${eur(d.kosten)}</td></tr>`;
    }
    html += `<tr class="best"><td colspan="3">Summe (+ ${eur(ana.kosten.grund)} Abos)</td><td class="num">${eur(ana.kosten.gesamt)}</td></tr></table></div>
      <p class="small muted">⚠ = Preis variiert je Säule/Uhrzeit.</p></details></div>`;
  }

  html += `<div class="card flat"><details class="plain"><summary>⚙️ Daten, Updates &amp; Sicherung <span class="muted">(Preisstand ${datumDE(state.settings.preiseGeprueft)} — aktualisiert sich montags von selbst)</span></summary>
    <div class="btnrow">
      <button class="btn small primary" data-action="update-check">🔄 Nach neuen Daten suchen</button>
      <button class="btn small" data-action="recherche-start">🔬 Neu-Recherche anstoßen</button>
      ${updateCheck === "läuft" ? '<span class="pill">⏳ prüfe Quellen …</span>' : ""}
      ${updateCheck === "aktuell" ? '<span class="pill good">✓ Alles aktuell</span>' : ""}
      ${iBtn("upd-hilfe")}
    </div>
    ${iBox("upd-hilfe", `„Suchen“ prüft in Sekunden, ob die Cloud neue Daten bereitgelegt hat. „Neu-Recherche“ weckt die Cloud wirklich auf (Gemini recherchiert frisch, ~2–3 min; braucht einmalig ein GitHub-Token unter „Erweitert“ — oder <a href="https://github.com/Mintberry1628/ladekarten-checker/actions" target="_blank" rel="noopener">GitHub → Run workflow</a>). Geprüft werden Preise, Kartengebühren, Aktionen und Bestell-Links.`)}
    <hr class="divider">
    <div class="btnrow">
      <button class="btn small" data-action="export">⬇ Daten exportieren</button>
      <button class="btn small" data-action="import">⬆ Daten importieren</button>
      <button class="btn small" data-action="preise-ok">✓ Preise geprüft</button>
      <button class="btn small danger" data-action="reset">Zurücksetzen</button>
    </div>
    <p class="small muted">Deine Eingaben liegen nur lokal auf diesem Gerät — fürs zweite Gerät: exportieren &amp; dort importieren.</p>
    <hr class="divider">
    <div class="frow" style="align-items:flex-end">
      <div><label class="f">☁ Pi-Profil (z. B. nino)</label><input type="text" data-sfeldtext="profilName" value="${esc(state.settings.profilName)}" placeholder="nino"></div>
      <div><button class="btn small" data-action="profil-sichern" style="width:100%">☁⬆ Auf Pi sichern</button></div>
      <div><button class="btn small" data-action="profil-laden" style="width:100%">☁⬇ Vom Pi laden</button></div>
    </div>
    <p class="small muted">Jeder Nutzer sichert unter eigenem Namen — Einrichtung: Wissen → Profil-Sicherung.</p>
    <hr class="divider">
    <label style="display:flex;gap:10px;align-items:center;cursor:pointer">
      <input type="checkbox" data-scheck="einfach" ${state.settings.einfach ? "checked" : ""}>
      <span><b>Einfacher Modus</b> — nur Start, Fahren &amp; Wissen (z. B. wenn du die App weitergibst)</span>
    </label>
    <details class="plain"><summary>Erweitert: Update-Quelle, Neu-Recherche-Token &amp; Selbsttest</summary>
      <label class="f">URL zur tarife.json auf deinem Server</label>
      <input type="text" data-sfeldtext="updateUrl" value="${esc(state.settings.updateUrl)}">
      <p class="small">Die App prüft beim Start automatisch alle Quellen und nimmt den neuesten Stand.</p>
      <label class="f">GitHub-Token für den „Neu-Recherche“-Knopf (optional)</label>
      <input type="text" data-sfeldtext="ghToken" value="${esc(state.settings.ghToken || "")}" placeholder="github_pat_…">
      <p class="small">Erstellen: github.com → Settings → Developer settings → Fine-grained tokens → nur Repo „ladekarten-checker“, Berechtigung „Actions: Read and write“. Bleibt nur auf diesem Gerät gespeichert.</p>
      <div class="btnrow"><button class="btn small" data-action="selbsttest">🩺 Selbsttest: Sind alle Dienste erreichbar?</button></div>
      <ul class="clean" id="selbsttest-out"></ul>
    </details>
    </details>
    <input type="file" id="importfile" accept=".json" class="hidden"></div>`;
  return html;
}

/* ---------- Orte ---------- */
function viewOrte() {
  let html = `<h1>Deine Ladeorte</h1>
  <p class="small">Wo lädst du regelmäßig — und wie viel? ${iBtn("orte-hilfe")}</p>
  ${iBox("orte-hilfe", `Am einfachsten in <b>vollen Akkuladungen pro Monat</b> denken: 1 voller Akku = <b>${state.fahrzeug.akkuNetto} kWh</b> bei deinem #5, halbe Ladungen sind ok (z. B. 1,5) — das kWh-Feld rechnet automatisch mit. Faustregel: 1.000 km/Monat ≈ ${n0(((state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2) * 10)} kWh ≈ ${(((state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2) * 10 / state.fahrzeug.akkuNetto).toLocaleString("de-DE", { maximumFractionDigits: 1 })} volle Akkus. Mit einer Adresse (wie bei Google Maps) findet dir die App per Knopf die Säulen am Ort. Aus allem entstehen Empfehlungen &amp; Break-even.`)}`;
  for (const ort of state.orte) {
    const b = besterPreis(ort.netz, ort.art, null);
    html += `<div class="card" data-ort="${ort.id}">
      <div class="tarif head"><h3 style="margin:0">${esc(ort.name)}</h3>
        <span class="preis-haupt num">${b ? ct(b.preis) : "–"}</span></div>
      <p class="small">${esc(ort.notiz || "")} ${b && b.name ? `— günstigste Option: <b>${esc(b.name)}</b>` : ""}</p>
      <div class="frow">
        <div><label class="f">Name</label><input type="text" data-ofeld="name" value="${esc(ort.name)}"></div>
        <div><label class="f">Ladenetz</label><select data-ofeld="netz">${NETZE.map(n => `<option value="${n.id}" ${n.id === ort.netz ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select></div>
        <div><label class="f">AC / DC</label><select data-ofeld="art"><option value="ac" ${ort.art === "ac" ? "selected" : ""}>AC (normal)</option><option value="dc" ${ort.art === "dc" ? "selected" : ""}>DC (schnell)</option></select></div>
        <div><label class="f">Volle Akkus / Monat</label><input type="number" min="0" step="0.5" data-ofeld="ladungen" value="${ort.kwhMonat ? Math.round(ort.kwhMonat / state.fahrzeug.akkuNetto * 10) / 10 : 0}"></div>
        <div><label class="f">…oder kWh / Monat</label><input type="number" min="0" step="5" data-ofeld="kwhMonat" value="${ort.kwhMonat}"></div>
      </div>
      <div class="frow" style="align-items:flex-end">
        <div style="flex:3 1 220px"><label class="f">Adresse (optional, wie bei Google Maps)</label><input type="text" data-ofeld="adresse" value="${esc(ort.adresse || "")}" placeholder="z. B. Musterstr. 12, München"></div>
        <div style="flex:1 1 160px"><button class="btn small" data-action="ort-saeulen" data-id="${ort.id}" style="width:100%">📍 Säulen dort zeigen</button></div>
      </div>
      <div class="btnrow"><button class="del" data-action="ort-weg" data-id="${ort.id}">Ort entfernen</button></div>
    </div>`;
  }
  html += `<div class="btnrow"><button class="btn primary" data-action="ort-neu">+ Ort hinzufügen</button></div>
  <div class="card flat"><details class="plain"><summary>⚙️ Annahmen (Steckdosen-Preis, Verbrauch, Winter-Zuschlag)</summary>
    <div class="frow">
      <div><label class="f">Strompreis an der Steckdose (€/kWh)</label><input type="number" step="0.01" min="0" data-sfeld="schukoPreis" value="${state.settings.schukoPreis}"></div>
      <div><label class="f">Verbrauch Autobahn 130 (kWh/100 km)</label><input type="number" step="0.5" min="10" data-ffeld="verbrauchAB" value="${state.fahrzeug.verbrauchAB}"></div>
      <div><label class="f">Winter-Zuschlag (%)</label><input type="number" step="1" min="0" data-ffeld="winterZuschlag" value="${state.fahrzeug.winterZuschlag}"></div>
    </div>
    <hr class="divider">
    <p class="small"><b>Fahrzeug-Profil</b> ${iBtn("fzg-hilfe")}</p>
    ${iBox("fzg-hilfe", "Vorkonfiguriert ist dein smart #5 Brabus. Für ein anderes Auto (z. B. auf dem iPhone deines Schwagers) einfach Name, Akku und Ladeleistung anpassen — alle Reichweiten, Stopps und Ladezeiten rechnen dann mit diesen Werten.")}
    <div class="frow">
      <div><label class="f">Fahrzeug</label><input type="text" data-ffeldtext="name" value="${esc(state.fahrzeug.name)}"></div>
      <div><label class="f">Akku netto (kWh)</label><input type="number" step="1" min="10" data-ffeld="akkuNetto" value="${state.fahrzeug.akkuNetto}"></div>
      <div><label class="f">DC-Spitze (kW)</label><input type="number" step="10" min="20" data-ffeld="dcMax" value="${state.fahrzeug.dcMax}"></div>
      <div><label class="f">AC (kW)</label><input type="number" step="1" min="2" data-ffeld="acMax" value="${state.fahrzeug.acMax}"></div>
    </div>
  </details></div>`;
  return html;
}

/* ---------- Tarife ---------- */
function viewTarife() {
  const c = breakEvenChart(state.chartKontext);
  let html = `<h1>Tarife &amp; Break-even</h1>
  <div class="card"><h2>Ab wann lohnt sich welches Abo? ${iBtn("be-hilfe")}</h2>
    ${iBox("be-hilfe", "Jede Linie = ein Tarif (Grundgebühr + kWh-Preis). Der farbige Punkt sitzt auf der <b>Abo-Linie gleicher Farbe</b> und markiert den Break-even: ab dieser Monats-Lademenge ist das Abo günstiger als die beste Karte ohne Grundgebühr. Darunter: Finger weg vom Abo. Mit dem Finger über das Diagramm fahren zeigt Preise je Lademenge.")}
    <label class="f">Situation wählen</label>
    <select id="chartctx">${CHART_KONTEXTE.map(k => `<option value="${k.id}" ${k.id === state.chartKontext ? "selected" : ""}>${esc(k.label)}</option>`).join("")}</select>
    <div class="chartbox" id="chartbox">${c.svg}<div class="charttip" id="charttip"></div></div>
    <div class="legend">${c.legende}</div>
    ${c.beListe && c.beListe.length ? `<ul class="clean" style="margin-top:8px">${c.beListe.map(b =>
      `<li class="small"><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${b.farbe};margin-right:6px"></span>${esc(b.text)}</li>`).join("")}</ul>` : ""}
    <hr class="divider">
    <label class="f">Was wäre wenn? Lademenge pro Monat schieben ${iBtn("szen-hilfe")}</label>
    ${iBox("szen-hilfe", "Der Regler spielt Szenarien durch: Was würden die Optionen dieser Situation bei X kWh/Monat kosten, und welche wäre die günstigste? Deine echten Orte und Empfehlungen bleiben unberührt.")}
    <input type="range" id="szenario" min="0" max="${c.maxKwh}" step="10" value="${Math.max(0, Math.min(c.maxKwh, Math.round(monatsAnalyse().kwhGesamt) || 100))}" style="width:100%">
    <p class="small num" id="szenario-out"></p>
    <details><summary>Zahlen als Tabelle</summary>${c.tabelle}</details>
  </div>`;

  const gruppen = [["frei", "🆓 Ohne Grundgebühr — kosten nichts, solange du nicht lädst"], ["abo", "📅 Abos — nur in Monaten buchen, in denen sie sich rechnen"], ["adhoc", "💳 Ohne alles"]];
  for (const [kat, titel] of gruppen) {
    html += `<h2 style="margin-top:20px">${titel}</h2><div class="grid cols2">`;
    for (const t of state.tarife.filter(t => t.kategorie === kat)) {
      const hat = kat === "abo" ? !!state.abos[t.id] : !!state.karten[t.id];
      const pReihe = Object.entries(t.preise || {}).map(([nid, p]) =>
        `<span class="pill">${esc(netzKurz(nid))}: ${p.ac != null ? "AC " + p.ac.toLocaleString("de-DE") : ""}${p.ac != null && p.dc != null ? " / " : ""}${p.dc != null ? "DC " + p.dc.toLocaleString("de-DE") : ""}${p.unsicher ? " ⚠" : ""}</span>`).join(" ");
      const roam = t.roaming && (t.roaming.ac != null || t.roaming.dc != null) ? `<span class="pill">Roaming: ${t.roaming.ac != null ? "AC " + t.roaming.ac.toLocaleString("de-DE") : ""}${t.roaming.ac != null && t.roaming.dc != null ? " / " : ""}${t.roaming.dc != null ? "DC " + t.roaming.dc.toLocaleString("de-DE") : ""}${t.roamingUnsicher ? " ⚠" : ""}</span>` : "";
      html += `<div class="card tarif">
        <div class="head"><h3 style="margin:0">${esc(t.name)}</h3>
        <span class="preis-haupt num">${t.grund ? eur(t.grund) + "/Mon." : "0 €"}</span></div>
        <div class="meta">${t.basisEmpfehlung ? '<span class="pill good">Basis-Setup</span>' : ""}${hat ? `<span class="pill acc">${kat === "abo" ? "Abo aktiv" : "Hab ich"}</span>` : ""}<span class="pill">${esc(t.medium)}</span><span class="pill">${esc(t.laender)}</span>${t.preisVariabel ? '<span class="pill warn">Preis je Säule</span>' : ""}</div>
        <div class="meta">${pReihe}${roam}</div>
        ${t.voraussetzung ? `<p class="small">⚠️ ${esc(t.voraussetzung)}</p>` : ""}
        ${tarifAktion(t) ? `<p class="small"><b style="color:var(--warn)">🏷 ${esc(tarifAktion(t).text)} (bis ${datumDE(tarifAktion(t).bis)})</b></p>` : ""}
        <details class="plain"><summary>Konditionen &amp; Details</summary>
          <p class="small">${esc(t.hinweis || "")}</p>
          <p class="small muted">💳 Beschaffung: ${esc(kartenKostenText(t))}${kat === "abo" ? ` · Bindung: ${esc(t.bindung || "monatlich kündbar")}` : ""}</p>
          ${t.blockier ? `<p class="small muted">Standzeit: ${esc(t.blockier)}</p>` : ""}
          ${t.jahresAlternative ? `<p class="small muted">Alternative: ${esc(t.jahresAlternative)}</p>` : ""}
          ${t.bestellLink ? `<p class="small"><a href="${esc(t.bestellLink)}" target="_blank" rel="noopener">🔗 Zum Anbieter — bestellen / Preis gegenprüfen</a></p>` : ""}
        </details>
        <div class="btnrow">
          <button class="btn small ${hat ? "" : "primary"}" data-action="${kat === "abo" ? (hat ? "abo-aus" : "abo-an") : (hat ? "karte-weg" : "karte-da")}" data-id="${t.id}">${kat === "abo" ? (hat ? "Als gekündigt markieren" : "Als abonniert markieren") : (hat ? "Hab ich doch nicht" : "Hab ich / eingerichtet")}</button>
          <button class="btn small ghost" data-action="tarif-edit" data-id="${t.id}">Preise ändern</button>
        </div>
        <div class="hidden" data-editbox="${t.id}">
          <div class="frow">
            <div><label class="f">Grundgebühr €/Mon.</label><input type="number" step="0.01" min="0" data-tfeld="grund" data-tid="${t.id}" value="${t.grund || 0}"></div>
            ${t.roaming && t.roaming.ac != null ? `<div><label class="f">Roaming AC</label><input type="number" step="0.01" data-tfeld="roamingAc" data-tid="${t.id}" value="${t.roaming.ac}"></div>` : ""}
            ${t.roaming && t.roaming.dc != null ? `<div><label class="f">Roaming DC</label><input type="number" step="0.01" data-tfeld="roamingDc" data-tid="${t.id}" value="${t.roaming.dc}"></div>` : ""}
            ${Object.entries(t.preise || {}).map(([nid, p]) => [
              p.ac != null ? `<div><label class="f">${esc(netzKurz(nid))} AC</label><input type="number" step="0.01" data-tfeld="preis-ac" data-netz="${nid}" data-tid="${t.id}" value="${p.ac}"></div>` : "",
              p.dc != null ? `<div><label class="f">${esc(netzKurz(nid))} DC</label><input type="number" step="0.01" data-tfeld="preis-dc" data-netz="${nid}" data-tid="${t.id}" value="${p.dc}"></div>` : "",
            ].join("")).join("")}
          </div>
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  html += `<div class="btnrow" style="margin-top:14px"><button class="btn small" data-action="tarife-json">⬇ Tarifstand als tarife.json exportieren (für deinen Server)</button></div>
  <p class="footer-note">Preisstand: ${datumDE(state.settings.preiseGeprueft)} · Quellen: Anbieter-Websites &amp; Fachpresse (electrive, ecomento). Alle Angaben ohne Gewähr — Preis an der Säule/App gilt.</p>`;
  return html;
}

/* ---------- Trips ---------- */
function viewTrips() {
  let html = `<h1>Trips &amp; Routen</h1>
  <div class="card"><h2>🗺 Route planen ${iBtn("planer-hilfe")}</h2>
    ${iBox("planer-hilfe", "Start und Ziel reichen — die App berechnet die echte Straßenroute, erkennt die Länder, setzt Ladestopps passend zu deinem #5 (konservativ &amp; beladen gerechnet) und empfiehlt die günstigste Karten-Kombi für genau diese Fahrt. Adressen mit ☆ als Favoriten speichern.")}
    <div class="frow">
      <div style="flex:2 1 180px"><label class="f">Start (Adresse/Ort)</label><input type="text" id="route-start" placeholder="z. B. Musterstr. 1, München" value="${esc(state.planer.start)}"></div>
      <div style="flex:2 1 180px"><label class="f">Ziel (Adresse/Ort)</label><input type="text" id="route-ziel" placeholder="z. B. Fojnica, Bosnien" value="${esc(state.planer.ziel)}"></div>
    </div>
    ${state.adressen.length ? `<div class="meta" style="margin-top:8px">${state.adressen.map((a, i) =>
      `<span class="pill">${esc(a.label)}
        <button class="del" data-action="adr-start" data-i="${i}" title="als Start">→S</button>
        <button class="del" data-action="adr-ziel" data-i="${i}" title="als Ziel">→Z</button>
        <button class="del" data-action="adr-weg" data-i="${i}" title="löschen">✕</button></span>`).join("")}</div>` : ""}
    <div class="btnrow">
      <button class="btn small ghost" data-action="adr-merken-start">☆ Start als Adresse speichern</button>
      <button class="btn small ghost" data-action="adr-merken-ziel">☆ Ziel als Adresse speichern</button>
    </div>
    ${(state.routenVerlauf || []).length ? `<div class="meta" style="margin-top:8px"><span class="small muted">Zuletzt geplant:</span> ${state.routenVerlauf.map((v, i) =>
      `<span class="pill">🕘 ${esc(v.start.slice(0, 16))} → ${esc(v.ziel.slice(0, 16))}
        <button class="del" data-action="verlauf-plan" data-i="${i}" title="Route erneut berechnen">↻</button>
        <button class="del" data-action="verlauf-weg" data-i="${i}" title="aus dem Verlauf löschen">✕</button></span>`).join(" ")}</div>` : ""}
    ${state.planer.startErkannt ? `<p class="small">✔ Zuletzt erkannt: <b>${esc(state.planer.startErkannt)}</b> → <b>${esc(state.planer.zielErkannt || "")}</b> — falls falsch: Adresse präziser eingeben (Straße, PLZ, Land) und neu berechnen.</p>` : ""}
    <details class="plain"><summary>Annahmen anpassen (Ankunfts-%, Tempo, Winter, Beladung)</summary>
      <div class="frow">
        <div><label class="f">Ankunft je Etappe mit mind. (%)</label><input type="number" min="5" max="50" step="5" data-sfeld="ankunftSoc" value="${state.settings.ankunftSoc}"></div>
        <div><label class="f">Mein Tempo (km/h)</label><input type="number" min="60" max="200" step="5" data-fahrt="tempo" value="${state.fahrt.tempo}"></div>
        <div><label class="f">Winter?</label><select data-fahrt="winter"><option value="" ${!state.fahrt.winter ? "selected" : ""}>Nein</option><option value="1" ${state.fahrt.winter ? "selected" : ""}>Ja</option></select></div>
        <div><label class="f">Voll beladen?</label><select data-scheckSel="beladen"><option value="1" ${state.settings.beladen ? "selected" : ""}>Ja (+${state.fahrzeug.beladenZuschlag} %)</option><option value="" ${!state.settings.beladen ? "selected" : ""}>Nein</option></select></div>
      </div>
      <label style="display:flex;gap:10px;align-items:center;cursor:pointer;margin-top:12px">
        <input type="checkbox" data-scheck="nurMeineKarten" ${state.settings.nurMeineKarten ? "checked" : ""}>
        <span class="small">Nur Karten/Abos einplanen, <b>die ich schon habe</b> (unter Tarife markiert)</span>
      </label>
    </details>
    <div class="btnrow"><button class="btn primary" data-action="route-planen" ${routeStatus && !routeStatus.startsWith("fehler:") ? "disabled" : ""}>${routeStatus && !routeStatus.startsWith("fehler:") ? "⏳ Berechnung läuft …" : "Route berechnen"}</button></div>
    ${routeStatus && !routeStatus.startsWith("fehler:") ? `<div class="card flat alert info" style="margin-top:8px"><p><b>⏳ ${esc(routeStatus)}</b><br><span class="small">Dauert insgesamt ~20–40 Sek. (Karten-Dienste erlauben nur 1 Anfrage/Sek.) — du kannst währenddessen einfach warten, die Seite springt nicht mehr.</span></p></div>` : ""}
    ${routeStatus.startsWith("fehler:") ? `<p class="small" style="color:var(--crit)">${esc(routeStatus.slice(7))}</p>` : ""}
    ${state.planer.alts && state.planer.alts.length > 1 ? `<p class="small" style="margin-top:8px"><b>Alternative Routen:</b> ${state.planer.alts.map(a =>
      `<button class="btn small ${a.i === state.planer.altGewaehlt ? "primary" : ""}" data-action="route-alt" data-i="${a.i}">Route ${a.i + 1}: ${n0(a.km)} km, ${Math.floor(a.min / 60)}:${String(a.min % 60).padStart(2, "0")} h</button>`).join(" ")}</p>` : ""}
    ${!(state.settings.ocmKey || "").trim() ? '<p class="small" style="color:var(--warn)">Hinweis: Ohne OpenChargeMap-Key (unter <b>Fahren</b> eintragen) werden Stopp-Positionen geplant, aber keine konkreten Säulen vorgeschlagen.</p>' : ""}
  </div>`;
  for (const trip of state.trips) {
    const ana = tripAnalyse(trip);
    const cl = tripCheckliste(trip, ana);
    const maxK = Math.max(...ana.kandidaten.map(k => k.kosten));
    // Eine Empfehlungs-Zeile (aufklappbar mit Rechenweg, Länder-Check, Link)
    const empZeile = (k, i) => `<details class="strategie">
          <summary><div class="hbar ${i === 0 ? "best" : ""}">
            <div class="top"><span>${i === 0 ? "⭐ " : ""}${esc(k.label)}${k.unsicher ? " ⚠" : ""}${i === 0 ? " — Empfehlung" : ""}</span><span class="val">${eur(k.kosten, 0)}</span></div>
            <div class="track"><div class="fill" style="width:${Math.max(3, k.kosten / maxK * 100)}%"></div></div>
          </div></summary>
          <div class="sdetail">
            <div class="calcbox">
              <div class="line"><span><b>So kommt der Preis zustande:</b></span><span></span></div>
              ${k.grund ? `<div class="line"><span>Grundgebühr (1 Monat${k.abo ? ", danach kündigen" : ""})</span><span>${eur(k.grund)}</span></div>` : ""}
              <div class="line"><span>${n0(k.kwhCov)} kWh × ${ct(k.preis)} (${esc(netzKurz(k.netz))})</span><span>${eur(k.preis * k.kwhCov)}</span></div>
              ${k.kwhRest > 0.5 ? `<div class="line"><span>+ ${n0(k.kwhRest)} kWh × ${ct(k.lueckePreis)} (Streckenteil ohne dieses Netz)</span><span>${eur(k.lueckePreis * k.kwhRest)}</span></div>` : ""}
              ${k.blockKosten > 0.5 ? `<div class="line"><span>+ Blockiergebühr (~${n0(k.blockMin)} min über der Gratis-Standzeit, 0,10 €/min)</span><span>${eur(k.blockKosten)}</span></div>` : ""}
              <div class="line total"><span>Unterwegs gesamt</span><span>${eur(k.kosten)}</span></div>
              ${ana.bestOhneAbo && ana.bestOhneAbo !== k ? `<div class="line"><span>Vergleich beste 0-€-Option (${esc(ana.bestOhneAbo.label.split(" — ")[0])}: ${eur(ana.bestOhneAbo.kosten, 0)})</span><span>${k.kosten < ana.bestOhneAbo.kosten - 0.005 ? "spart " + eur(ana.bestOhneAbo.kosten - k.kosten) : "+" + eur(k.kosten - ana.bestOhneAbo.kosten) + " teurer"}</span></div>` : ""}
            </div>
            <p class="small">🌍 <b>Länder-Check:</b> ${laenderCheck(k, trip)}</p>
            <p class="small">💳 ${esc(kartenKostenText(k.tarif))}${k.tarif.bindung ? " · Bindung: " + esc(k.tarif.bindung) : ""}${besitzt(k.tarif) ? ' · <span class="pill acc">hast du schon</span>' : ""}</p>
            ${k.tarif.hinweis ? `<p class="small muted">${esc(k.tarif.hinweis)}</p>` : ""}
            ${k.tarif.bestellLink ? `<div class="btnrow"><a class="btn small primary" href="${esc(k.tarif.bestellLink)}" target="_blank" rel="noopener">🔗 Zum Anbieter — bestellen / Preis gegenprüfen</a></div>` : ""}
          </div>
        </details>`;
    html += `<div class="card" data-trip="${trip.id}">
      <h2>🧭 ${esc(trip.ziel)}</h2>
      <details class="plain"><summary>✏️ Reisedaten ändern (Datum, Tage vor Ort, km, Laden am Ziel …)</summary>
      <div class="frow">
        <div><label class="f">Entfernung einfach (km)</label><input type="number" min="0" data-trfeld="hinKm" value="${trip.hinKm}"></div>
        <div><label class="f">Abfahrtsdatum</label><input type="date" data-trfeld="datum" value="${esc(trip.datum || "")}"></div>
        <div><label class="f">Rückreisedatum</label><input type="date" data-trfeld="rueckDatum" value="${esc(trip.rueckDatum || "")}"></div>
        <div><label class="f">…oder Tage vor Ort</label><input type="number" min="0" data-trfeld="tageVorOrt" value="${trip.tageVorOrt}"></div>
        <div><label class="f">km vor Ort</label><input type="number" min="0" step="25" data-trfeld="kmVorOrt" value="${trip.kmVorOrt}"></div>
        <div><label class="f">Laden am Ziel</label><select data-trfeld="zielLaden">
          <option value="schuko" ${trip.zielLaden === "schuko" ? "selected" : ""}>Steckdose/Notlader</option>
          ${NETZE.filter(n => n.id !== "schuko").map(n => `<option value="${n.id}" ${trip.zielLaden === n.id ? "selected" : ""}>${esc(n.kurz)}</option>`).join("")}
          <option value="" ${!trip.zielLaden ? "selected" : ""}>Kein Laden am Ziel</option></select></div>
        <div><label class="f">Kälte-Zuschlag</label><select data-trfeld="kaelte">
          <option value="auto" ${(trip.kaelte || "auto") === "auto" ? "selected" : ""}>Automatisch (Wetter)</option>
          <option value="an" ${trip.kaelte === "an" ? "selected" : ""}>An (+${state.fahrzeug.winterZuschlag} %)</option>
          <option value="aus" ${trip.kaelte === "aus" ? "selected" : ""}>Aus</option></select></div>
      </div>
      <p class="small muted">Nach Änderungen unten auf „Neu berechnen“ drücken — während der Eingabe rechnet nichts dazwischen.</p>
      </details>
      <div class="btnrow"><button class="btn primary small" data-action="trip-calc">🔄 Neu berechnen</button>
        ${trip.startCoord ? `<a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${trip.startCoord.lat},${trip.startCoord.lng}&destination=${trip.zielCoord.lat},${trip.zielCoord.lng}${trip.stopps && trip.stopps.length ? "&waypoints=" + trip.stopps.map(s => s.lat + "," + s.lng).join("%7C") : ""}">🗺 Ganze Route mit Stopps in Google Maps</a>` : ""}
        <button class="btn small" data-action="trip-teilen" data-id="${trip.id}">📤 Trip teilen (WhatsApp)</button>
      </div>
      <hr class="divider">
      <div class="hero">
        <div class="stat"><div class="v num">${ana.stopsProRichtung}<span class="unit"> Stopps</span></div><div class="l">pro Richtung (à ~${n0(ladezeitMin(10, 80))} min, gesamt ~${n0(ana.stopsProRichtung * ladezeitMin(10, 80))} min Ladezeit)</div></div>
        <div class="stat"><div class="v num">${n0(ana.dcUnterwegs)}<span class="unit"> kWh</span></div><div class="l">Schnellladen unterwegs (hin+zurück)</div></div>
        <div class="stat"><div class="v num">${eur(ana.gesamt, 0)}</div><div class="l">Stromkosten gesamt (${n0(ana.gesamtKm)} km)</div></div>
      </div>
      <p class="small">${iBtn("trip-rechnung-" + trip.id)} <span class="muted">Wie wurde gerechnet?</span></p>
      ${iBox("trip-rechnung-" + trip.id, `${trip.routeNotiz ? "🗺 " + esc(trip.routeNotiz) + "<br><br>" : ""}${n1(ana.vAB)} kWh/100 km bei ~130 km/h${state.settings.beladen ? " · beladen" : ""} · ${esc(kaelteText(trip))} · volle Ladung reicht ${n0(ana.kmVoll)} km, Folge-Etappen (80→${state.settings.ankunftSoc} %) ${n0(ana.kmHub)} km · vor Ort ${n0(ana.kWhVorOrt)} kWh über ${esc(ana.vorOrtName)} (${ct(ana.vorOrtPreis)})${trip.hoehe ? ` · Höhenprofil +${n0(trip.hoehe.aufstieg)}/−${n0(trip.hoehe.abstieg)} m eingerechnet` : ""}.`)}

      ${trip.stopps && trip.stopps.length ? `
      <h3 style="margin-top:14px">⚡ Ladestopp-Plan (Hinfahrt)</h3>
      ${routeSchema(trip)}
      ${routeKarte(trip)}
      <p class="small">${trip.fahrzeitMin ? `Reine Fahrzeit ~${Math.floor(trip.fahrzeitMin / 60)} h ${Math.round(trip.fahrzeitMin % 60)} min + ~${n0(trip.stopps.reduce((s, x) => s + (x.ladeMin || 0), 0))} min Laden. ` : ""}Ankunft am Ziel mit ca. <b>${trip.ankunftFinal != null ? trip.ankunftFinal : "–"} % Akku</b>.</p>
      ${tipp("navi-teilen", `<p>💡 <b>Stopps ans Auto schicken:</b> Bei jedem Stopp <b>📤 Teilen → Hello smart</b> antippen — der #5 heizt den Akku dann rechtzeitig vor (volle Ladeleistung). Rückfahrt: gleiche Logik in Gegenrichtung, am Ziel vorher vollladen.</p>`)}
      ${trip.stopps.map((st, i) => stoppCard(st, i, trip.id)).join("")}` : ""}

      <h3 style="margin-top:14px">💳 Ladekarten-Empfehlung für diese Fahrt ${iBtn("emp-hilfe")}</h3>
      ${iBox("emp-hilfe", `Verglichen werden die ${n0(ana.dcUnterwegs)} kWh Schnellladen unterwegs (hin + zurück). Ein Abo empfiehlt die App nur, wenn es MIT Grundgebühr günstiger ist als die beste kostenlose Variante. Jede Zeile lässt sich antippen: Rechenweg, Länder-Check und Bestell-Link — nochmal antippen schließt.`)}
      <div class="hbars">${ana.kandidaten.slice(0, 3).map((k, i) => empZeile(k, i)).join("")}</div>
      ${ana.kandidaten.length > 3 ? `<details class="plain"><summary>Alle ${ana.kandidaten.length} Optionen vergleichen</summary><div class="hbars">${ana.kandidaten.slice(3).map((k, i) => empZeile(k, i + 3)).join("")}</div></details>` : ""}
      ${landBesteText(trip, ana)}
      ${ana.tipp ? `<p class="small" style="color:var(--warn)">💡 Ohne den „Nur meine Karten“-Filter wäre günstiger: <b>${esc(ana.tipp.label)}</b> (${eur(ana.tipp.kosten, 0)}) — die Karte/das Abo fehlt dir noch.</p>` : ""}
      ${ana.best ? `<details class="plain" style="margin-top:10px"><summary>💶 Gesamtkosten der Fahrt: ${eur(ana.gesamt, 0)} — kompletter Rechenweg</summary>
      <div class="calcbox">
        <div class="line"><span><b>Empfehlung: ${esc(ana.best.label)}</b></span><span></span></div>
        ${ana.best.grund ? `<div class="line"><span>Grundgebühr (1 Monat, danach kündigen!)</span><span>${eur(ana.best.grund)}</span></div>` : ""}
        <div class="line"><span>${n0(ana.best.kwhCov)} kWh × ${ct(ana.best.preis)}</span><span>${eur(ana.best.preis * ana.best.kwhCov)}</span></div>
        ${ana.best.kwhRest > 0.5 ? `<div class="line"><span>+ ${n0(ana.best.kwhRest)} kWh × ${ct(ana.best.lueckePreis)} (Streckenteil ohne dieses Netz)</span><span>${eur(ana.best.lueckePreis * ana.best.kwhRest)}</span></div>` : ""}
        <div class="line total"><span>Unterwegs gesamt</span><span>${eur(ana.best.kosten)}</span></div>
        ${ana.bestOhneAbo && ana.best.abo ? `<div class="line"><span>Ersparnis ggü. bester 0-€-Option (${esc(ana.bestOhneAbo.label)})</span><span>${eur(ana.bestOhneAbo.kosten - ana.best.kosten)}</span></div>` : ""}
        <div class="line"><span>+ Vollladen vor Abfahrt (~${n0(ana.kWhAbfahrt)} kWh ${esc(ana.heimBest ? ana.heimBest.name : "")})</span><span>${eur(ana.kostenAbfahrt)}</span></div>
        <div class="line"><span>+ Laden vor Ort</span><span>${eur(ana.kostenVorOrt)}</span></div>
        <div class="line total"><span>Trip gesamt (Strom)</span><span>${eur(ana.gesamt)}</span></div>
      </div>
      <p class="small">Zum Vergleich: Ein Benziner (8 l/100 km, 1,80 €/l) hätte für ${n0(ana.gesamtKm)} km ≈ ${eur(ana.gesamtKm * 0.08 * 1.8, 0)} gekostet.</p>
      </details>` : ""}

      <details class="plain" style="margin-top:10px"><summary>🌍 Länder-Infos &amp; Maut (${trip.laender.join(", ")})</summary>
      ${trip.laender.map(l => { const L = LAENDER[l]; if (!L) return ""; return `<div class="card flat" style="margin-top:8px">
        <b>${esc(L.name)}</b>
        <p class="small">⚡ ${esc(L.laden)}</p>
        <p class="small">🅱 Plan B: ${esc(L.planB)}</p>
        ${L.extras.map(x => `<p class="small">❗ ${esc(x)}</p>`).join("")}
      </div>`; }).join("")}
      </details>

      <details class="plain" style="margin-top:10px"><summary>✅ Vorbereitungs-Checkliste (${cl.filter((x, i) => state.checks[trip.id + "-" + i]).length}/${cl.length} erledigt)</summary>
      <div class="btnrow"><button class="btn small ghost" data-action="trip-ics" data-id="${trip.id}">📅 Termine in Kalender (.ics)</button></div>
      ${cl.map((item, i) => { const key = trip.id + "-" + i; const done = !!state.checks[key]; return `<div class="check ${done ? "done" : ""}">
        <input type="checkbox" id="ck-${key}" data-check="${key}" ${done ? "checked" : ""}>
        <label for="ck-${key}"><span class="when">${esc(item.when)}</span><br><span class="txt">${esc(item.text)}</span></label>
      </div>`; }).join("")}
      </details>
      <div class="btnrow"><button class="del" data-action="trip-weg" data-id="${trip.id}">Trip entfernen</button></div>
    </div>`;
  }
  html += `<div class="btnrow"><button class="btn primary" data-action="trip-neu">+ Neues Ziel planen</button></div>`;
  return html;
}

/* ---------- Fahrmodus ---------- */
function viewFahren() {
  const netz = state.driveNetz;
  const dc = preiseAnNetz(netz, "dc");
  const ac = preiseAnNetz(netz, "ac");
  const alle = dc.length ? dc : ac;
  const art = dc.length ? "DC" : "AC";
  // Nur Karten/Abos, die du wirklich hast (Ad-hoc geht immer)
  const liste = alle.filter(l => besitzt(l.tarif));
  const best = liste[0];
  // Spartipp: erst kostenlose Karten vorschlagen, Abos nur wenn nichts Kostenloses billiger ist
  const guenstiger = (l) => !besitzt(l.tarif) && (!best || l.preis < best.preis - 0.001);
  const besserer = alle.find(l => guenstiger(l) && l.tarif.kategorie !== "abo") || alle.find(guenstiger);
  const f = state.fahrzeug;
  const hub = f.akkuNetto * 0.6; // 20 -> 80 %
  const fr = fahrtRechnung();
  const fa = state.fahrt;
  let html = `<div class="drive">
  <h1>🚗 Fahrmodus</h1>
  <p class="small"><b>Nur im Stand oder vom Beifahrer bedienen.</b></p>

  <div class="card"><h2>🔋 Wie weit komme ich noch?</h2>
    <div class="frow">
      <div><label class="f">Ich gebe an</label><select data-fahrt="modus"><option value="soc" ${fa.modus === "soc" ? "selected" : ""}>Akku-%</option><option value="restkm" ${fa.modus === "restkm" ? "selected" : ""}>Rest-km laut Anzeige</option></select></div>
      ${fa.modus === "soc"
        ? `<div><label class="f">Akkustand (%)</label><input type="number" min="0" max="100" step="1" data-fahrt="soc" value="${fa.soc}"></div>`
        : `<div><label class="f">Rest-km (Anzeige)</label><input type="number" min="0" step="10" data-fahrt="restKm" value="${fa.restKm}"></div>`}
      <div><label class="f">Mein Tempo (km/h)</label><input type="number" min="60" max="200" step="5" data-fahrt="tempo" value="${fa.tempo}"></div>
      <div><label class="f">Winter?</label><select data-fahrt="winter"><option value="" ${!fa.winter ? "selected" : ""}>Nein</option><option value="1" ${fa.winter ? "selected" : ""}>Ja</option></select></div>
    </div>
    <div class="socgrid" style="margin-top:12px">
      <div class="s"><div class="v num">${n0(fr.sicherKm)} km</div><div class="l">SICHER erreichbar (bis ${state.settings.ankunftSoc} % + ${state.settings.puffer} % Puffer)</div></div>
      <div class="s"><div class="v num">${n0(fr.maxKm)} km</div><div class="l">theoretisch maximal</div></div>
      <div class="s"><div class="v num">${n1(fr.verbrauch)}</div><div class="l">kWh/100 km bei ${fa.tempo} km/h${fa.winter ? " (Winter)" : ""}</div></div>
      <div class="s"><div class="v num">${n0(fr.energie)} kWh</div><div class="l">im Akku (≈ ${n0(fr.socEff)} %)</div></div>
    </div>
    <details class="plain"><summary>Was heißt „SICHER“? (Reserve + Sicherheitspuffer erklärt)</summary>
      <p class="small">Plane Ladestopps innerhalb der <b>sicheren</b> km.${fa.modus === "restkm" ? " Die Anzeige-km rechnet der Bordcomputer mit Misch-Verbrauch — bei Autobahn-Tempo kommst du real weniger weit; genau das korrigiert diese Rechnung." : ""}</p>
      <p class="small">Die App zieht von der Reichweite <b>zwei</b> Dinge ab, damit die Zahl verlässlich ist:<br>
      <b>1) Ankunfts-Reserve (${state.settings.ankunftSoc} %):</b> mit so viel Rest-Akku willst du mindestens an der Säule ankommen — falls sie besetzt oder kaputt ist, kommst du noch zur nächsten.<br>
      <b>2) Sicherheitspuffer (${state.settings.puffer} %):</b> Abzug für alles Unplanbare — Stau, Umleitung, Gegenwind, Regen, kalter Akku.<br>
      <b>„SICHER erreichbar“</b> schaffst du also selbst dann, wenn unterwegs etwas dazwischenkommt. <b>„Theoretisch maximal“</b> rechnet bis 0 % Akku — nur zur Einordnung, nie darauf planen.</p>
      <div class="frow"><div><label class="f">Sicherheitspuffer (%)</label><input type="number" min="0" max="40" step="5" data-sfeld="puffer" value="${state.settings.puffer}"></div></div>
    </details>
  </div>

  <div class="card"><h2>📍 Nächste Ladesäulen finden</h2>
    ${!(state.settings.ocmKey || "").trim() ? `<div class="card flat alert info"><p class="small"><b>Einmalig einrichten (2 Minuten, kostenlos):</b> Auf <a href="https://openchargemap.org" target="_blank" rel="noopener">openchargemap.org</a> registrieren → Profil → „my apps“ → „Register an Application“ → den API-Key hier eintragen. Damit bekommt die App weltweite Live-Säulendaten (Stationen kommen und gehen — die Quelle ist immer aktuell).</p>
    <label class="f">OpenChargeMap API-Key</label><input type="text" data-sfeldtext="ocmKey" value="${esc(state.settings.ocmKey)}" placeholder="z. B. 123abc..."></div>` : ""}
    <div class="btnrow">
      <button class="btn primary" data-action="suche-standort">📍 Um mich herum</button>
    </div>
    <div class="frow" style="margin-top:8px; align-items:flex-end">
      <div style="flex:3 1 180px"><label class="f">…oder Ort/Adresse</label><input type="text" id="suchadresse" placeholder="z. B. Villach" value=""></div>
      <div style="flex:2 1 140px"><label class="f">Wunsch-Leistung ${iBtn("wkw")}</label><select data-sfeld="suchKw">
        <option value="0" ${!state.settings.suchKw ? "selected" : ""}>egal — alles zeigen</option>
        ${[50, 150, 300, 350, 400].map(k => `<option value="${k}" ${+state.settings.suchKw === k ? "selected" : ""}>mind. ${k} kW</option>`).join("")}
      </select></div>
      <div style="flex:1 1 90px"><button class="btn" data-action="suche-adresse" style="width:100%">Suchen</button></div>
    </div>
    ${iBox("wkw", "Bei „egal“ zeigt dir die App den <b>nächsten Schnelllader</b> und die <b>nächste normale AC-Säule</b> zuerst. Gibt's bei dir keine 350/400er? Wunsch-Leistung einstellen — dann sucht die App automatisch in größerem Umkreis (bis 300 km) nach dem nächsten passenden.")}
    ${sucheStatus === "ortung" ? '<p class="small">📡 Standort wird ermittelt …</p>' : ""}
    ${sucheStatus === "lädt" ? '<p class="small">⏳ Säulen werden geladen …</p>' : ""}
    ${sucheStatus === "kein-key" ? '<p class="small" style="color:var(--warn)">Bitte erst den OpenChargeMap-Key eintragen (siehe oben).</p>' : ""}
    ${sucheStatus.startsWith("fehler:") ? `<p class="small" style="color:var(--crit)">${esc(sucheStatus.slice(7))}</p>` : ""}
    ${state.letzteSuche ? stationListe(state.letzteSuche, fr) : ""}
  </div>

  ${state.favoriten.length ? `<div class="card"><h2>⭐ Gemerkte Säulen</h2>${state.favoriten.map(st => stationCard(st, null, fr)).join("")}</div>` : ""}

  <div class="card"><h2>Ich stehe an:</h2>
    <div class="netzgrid">${NETZE.filter(n => n.id !== "schuko" && n.id !== "ac-fremd").map(n => `<button data-drive="${n.id}" class="${n.id === netz ? "on" : ""}">${esc(n.kurz)}</button>`).join("")}</div>
  </div>`;
  if (best) {
    html += `<div class="result">
    <div class="card bigcard alert good" style="margin-top:12px">
      <div class="eyebrow">Nimm diese Karte / App (${art})</div>
      <div><b>${esc(best.tarif.name)}</b></div>
      <div class="preis num">${ct(best.preis)}</div>
      <div class="small muted">Preisstand ${datumDE(state.settings.preiseGeprueft)}</div>
      <div class="btnrow"><button class="btn small" data-action="sprech" data-text="Nimm ${esc(best.tarif.name)}. ${best.preis.toLocaleString("de-DE")} Euro pro Kilowattstunde.">🔊 Vorlesen</button></div>
      ${best.unsicher ? '<div class="small">⚠ Preis variiert — kurz in der App checken</div>' : ""}
      ${best.grund && best.tarif.kategorie === "abo" ? `<div class="small">(läuft in deinem Abo, ${eur(best.grund)}/Mon. bereits gezahlt)</div>` : ""}
    </div>
    ${besserer ? `<div class="card alert info" style="margin-top:12px"><h3>💡 Spartipp</h3><p><b>${esc(besserer.tarif.name)}</b> wäre hier mit ${ct(besserer.preis)} günstiger — unter <b>Tarife</b> einrichten${besserer.tarif.kategorie === "abo" ? " (Abo, vorher Break-even checken)" : " (kostenlos)"}.</p></div>` : ""}
    <div class="card" style="margin-top:12px"><h3>Wenn's nicht klappt — der Reihe nach:</h3>
      <ol class="fallback">${liste.slice(1, 4).filter(l => l.tarif.id !== "adhoc").map(l => `<li><b>${esc(kurzName(l.tarif))}</b> — ${ct(l.preis)}${l.unsicher ? " ⚠" : ""}</li>`).join("")}
      <li><b>Ad-hoc:</b> QR-Code auf der Säule oder Kreditkarte ans Terminal</li>
      <li><b>Hotline</b> des Betreibers (Aufkleber auf der Säule) — die starten oft remote</li>
      <li>Unter 10 % Akku? <b>Nächsten Standort</b> ansteuern, nicht warten.</li></ol>
    </div></div>`;
  } else {
    html += `<div class="card alert" style="margin-top:12px"><h3>Kein fester Preis hinterlegt</h3><p>An diesem Netz zahlst du per App des Betreibers oder ad-hoc (~0,79 €/kWh DC). Preis an der Säule prüfen.</p></div>`;
  }
  html += `<div class="card" style="margin-top:12px"><h3>Schnell-Rechner: Was kostet mich der Stopp?</h3>
    <div class="socgrid">
      <div class="s"><div class="v num">${n0(hub)} kWh</div><div class="l">20 → 80 %</div></div>
      <div class="s"><div class="v num">${best ? eur(hub * best.preis, 0) : "–"}</div><div class="l">Kosten 20 → 80 %</div></div>
      <div class="s"><div class="v num">~${n0(ladezeitMin(20, 80))} min</div><div class="l">Dauer am HPC (warm)</div></div>
      <div class="s"><div class="v num">${n0(hub / f.verbrauchAB * 100)} km</div><div class="l">Reichweite (Autobahn)</div></div>
    </div>
    <p class="small" style="margin-top:8px">⏱ Nach 80 % wird's langsam &amp; oft Blockiergebühr — weiterfahren ist fast immer besser.</p>
  </div>`;

  // Blockiergebühr-Timer
  const timer = state.ladeTimer;
  if (!timer) {
    html += `<div class="card" style="margin-top:12px"><h3>⏱ Blockiergebühr-Timer</h3>
      <p class="small">Beim Einstecken starten — die App zählt mit und warnt, bevor die Standzeitgebühr deines Tarifs losgeht${best && best.tarif.blockierAbMin ? "" : " (Standard-Annahme: DC 60 min, AC 240 min)"}.</p>
      <div class="btnrow"><button class="btn primary" data-action="timer-start">▶ Laden gestartet</button></div></div>`;
  } else {
    const min = Math.floor((Date.now() - timer.start) / 60000);
    const rest = timer.grenze == null ? null : timer.grenze - min;
    html += `<div class="card ${rest != null && rest <= 10 ? "alert crit" : "alert good"}" style="margin-top:12px"><h3>⏱ Laden läuft — ${min} min</h3>
      <p>${timer.grenze == null ? "Dieser Tarif hat keine Blockiergebühr — entspann dich. 😌"
        : rest > 0 ? `Noch <b>${rest} min</b> bis zur Blockiergebühr (ab ${timer.grenze} min bei ${esc(timer.tarifName || "deinem Tarif")}).`
        : `<b>Blockiergebühr läuft seit ${-rest} min!</b> Meist ~10 ct/min — Auto umparken.`}</p>
      <div class="btnrow"><button class="btn" data-action="timer-stop">■ Laden beendet</button></div></div>`;
  }

  // Lade-Logbuch: füttert Statistik + Kalibrierung
  const stat = logbuchStatistik();
  html += `<div class="card" style="margin-top:12px"><h3>📓 Lade-Logbuch ${iBtn("logb")}</h3>
    ${iBox("logb", "30 Sekunden nach jedem Laden eintragen: Daraus lernt die App deine <b>echte</b> Ladegeschwindigkeit und deinen <b>echten</b> Verbrauch — alle Prognosen werden persönlicher. Die Startseite zeigt deine echten Kosten.")}
    ${state.timerVorschlag ? `<p class="small">⏱ <b>${state.timerVorschlag.minuten} min aus dem Timer übernommen</b> — nur noch kWh eintragen, die Kosten rechnet die App aus deinem Tarif vor.</p>` : ""}
    <div class="frow">
      <div><label class="f">Netz</label><select id="log-netz">${NETZE.map(n => `<option value="${n.id}" ${n.id === ((state.timerVorschlag && state.timerVorschlag.netz) || netz) ? "selected" : ""}>${esc(n.kurz)}</option>`).join("")}</select></div>
      <div><label class="f">geladene kWh</label><input type="number" id="log-kwh" min="0" step="1" placeholder="55"></div>
      <div><label class="f">Dauer (min)</label><input type="number" id="log-min" min="0" step="1" placeholder="18" value="${state.timerVorschlag ? state.timerVorschlag.minuten : ""}"></div>
      <div><label class="f">Kosten (€) <span class="muted">(leer = auto)</span></label><input type="number" id="log-eur" min="0" step="0.5" placeholder="auto"></div>
      <div><label class="f">km seit letztem Laden <span class="muted">(optional)</span></label><input type="number" id="log-km" min="0" step="10" placeholder="230"></div>
      <div><label class="f">Akku von → bis % <span class="muted">(optional)</span></label><div style="display:flex;gap:6px"><input type="number" id="log-socv" min="0" max="100" placeholder="20"><input type="number" id="log-socb" min="0" max="100" placeholder="80"></div></div>
    </div>
    <div class="btnrow"><button class="btn primary small" data-action="log-neu">＋ Ladung speichern</button>${state.logbuch.length ? '<button class="btn small ghost" data-action="log-csv">⬇ Als Excel/CSV</button>' : ""}</div>
    ${state.kalib.ladeFaktor !== 1 ? `<p class="small">🎯 Kalibrierung aktiv: Ladezeiten × ${(1 / state.kalib.ladeFaktor).toLocaleString("de-DE", { maximumFractionDigits: 2 })} (aus deinen DC-Ladungen gelernt).</p>` : ""}
    ${stat && stat.verbrauchEcht != null && Math.abs(stat.verbrauchEcht / ((state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2 * (state.kalib.verbrauchFaktor || 1)) - 1) > 0.07 ? `
      <p class="small">🎯 Dein echter Ø-Verbrauch (${n1(stat.verbrauchEcht)} kWh/100 km) weicht vom Planwert ab.
      <button class="btn small" data-action="log-verbrauch">Als neue Basis übernehmen</button></p>` : ""}
    ${state.logbuch.length ? `<div class="tblwrap"><table>
      <tr><th>Datum</th><th>Netz</th><th class="num">kWh</th><th class="num">min</th><th class="num">Ø kW</th><th class="num">€/kWh</th><th></th></tr>
      ${state.logbuch.slice(-8).reverse().map(e => {
        const i = state.logbuch.indexOf(e);
        const kw = e.kwh && e.minuten ? e.kwh / (e.minuten / 60) : null;
        const proKwh = e.kwh && e.kosten ? e.kosten / e.kwh : null;
        return `<tr><td>${datumDE(e.datum)}</td><td>${esc(netzKurz(e.netz))}</td><td class="num">${n0(e.kwh || 0)}</td><td class="num">${n0(e.minuten || 0)}</td><td class="num">${kw ? n0(kw) : "–"}</td><td class="num">${proKwh ? proKwh.toLocaleString("de-DE", { maximumFractionDigits: 2 }) : "–"}</td>
        <td>${proKwh ? `<button class="btn small ghost" data-action="log-preis" data-i="${i}" title="Diesen Preis in deine Tarifdaten übernehmen">→ Tarif</button>` : ""}<button class="del" data-action="log-weg" data-i="${i}">✕</button></td></tr>`;
      }).join("")}
    </table></div>` : ""}
  </div></div>`;
  return html;
}

/* ---------- Stations-Karten (Säulen-Finder) ---------- */
function stationCard(st, distKm, fr) {
  const netzId = opZuNetz(st.op) || (st.kw >= 30 ? "dc-fremd" : "ac-fremd");
  const art = st.kw >= 30 ? "dc" : "ac";
  const meineIds = state.tarife.filter(besitzt).map(t => t.id);
  const b = besterPreis(netzId, art, meineIds);
  let reach = "";
  if (distKm != null && fr) {
    const strasse = distKm * STRASSEN_FAKTOR;
    reach = strasse <= fr.sicherKm ? '<span class="pill good">erreichbar ✓</span>'
      : strasse <= fr.maxKm ? '<span class="pill warn">knapp — riskant</span>'
        : '<span class="pill crit">zu weit ✗</span>';
  }
  const fav = state.favoriten.some(x => x.id === st.id);
  return `<div class="card flat station">
    <div class="tarif head"><b>${esc(st.name)}</b> <span class="preis-haupt num">${st.kw ? n0(st.kw) + " kW" : ""}</span></div>
    <div class="meta">${st.op ? `<span class="pill">${esc(st.op)}</span>` : ""}${st.anz ? `<span class="pill">${st.anz} Ladepunkte</span>` : ""}${st.statusAm ? `<span class="pill">${esc(st.status || "Status")} · Stand ${datumDE(st.statusAm)}</span>` : ""}${distKm != null ? `<span class="pill">≈ ${n0(distKm * STRASSEN_FAKTOR)} km Straße</span>` : ""}${reach}${st.defekt ? '<span class="pill crit">⚠ als außer Betrieb gemeldet</span>' : ""}</div>
    <p class="small">${esc(st.adresse || "")}${b ? ` — deine beste Karte hier: <b>${esc(b.name)}</b> (${ct(b.preis)})` : ` — <b>keine deiner Karten passt hier</b>: nur per Betreiber-App (z. B. Tesla-/Kaufland-App) oder Preis vor Ort prüfen`}</p>
    ${st.kommentar && st.kommentar.text ? `<p class="small muted">💬 Nutzer-Meldung (${esc(st.kommentar.am || "")}): „${esc(st.kommentar.text)}“</p>` : ""}
    <div class="btnrow">
      <a class="btn small primary" href="${mapsUrl(st)}" target="_blank" rel="noopener">🗺 Google Maps</a>
      <button class="btn small" data-action="station-teilen" data-id="${esc(st.id)}">📤 Teilen (→ Hello smart)</button>
      <button class="btn small ghost" data-action="station-fav" data-id="${esc(st.id)}">${fav ? "★ Gemerkt" : "☆ Merken"}</button>
    </div>
  </div>`;
}
function stationListe(suche, fr) {
  const mitDist = suche.stationen
    .map(st => ({ st, d: haversineKm(suche.lat, suche.lng, st.lat, st.lng) }))
    .sort((a, b) => a.d - b.d);
  if (!mitDist.length) return `<p class="small">Keine Säulen ${suche.minKw ? "mit ≥ " + suche.minKw + " kW " : ""}im Umkreis von ${suche.radius || 30} km gefunden${suche.minKw ? " — Wunsch-Leistung niedriger stellen" : ""}.</p>`;
  let top = "";
  if (!suche.minKw) {
    // Die zwei wichtigsten Antworten zuerst: nächster Schnelllader + nächste AC-Säule
    const schnell = mitDist.find(x => x.st.kw >= 150);
    const langsam = mitDist.find(x => x.st.kw > 0 && x.st.kw <= 22);
    if (schnell) top += `<h3 style="margin-top:12px">⚡ Nächster Schnelllader (DC)</h3>` + stationCard(schnell.st, schnell.d, fr);
    if (langsam) top += `<h3 style="margin-top:12px">🔌 Nächste normale Säule (AC)</h3>` + stationCard(langsam.st, langsam.d, fr);
    if (top) top += `<h3 style="margin-top:12px">Alle in der Nähe</h3>`;
  }
  return `<p class="small" style="margin-top:10px">Ergebnis vom ${new Date(suche.zeit).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}${suche.minKw ? ` · Filter ≥ ${suche.minKw} kW · Suchradius ${suche.radius} km` : ""} (bleibt offline gespeichert):</p>` +
    top +
    mitDist.slice(0, 15).map(x => stationCard(x.st, x.d, fr)).join("") +
    `<p class="small">${iBtn("finder-legende")} <span class="muted">Legende &amp; Live-Belegung erklärt</span></p>` +
    iBox("finder-legende", `<span class="pill good">erreichbar ✓</span> = schaffst du mit Reserve (${state.settings.ankunftSoc} %) + Sicherheitspuffer (${state.settings.puffer} %) · <span class="pill warn">knapp</span> = nur, wenn du den Puffer aufbrauchst — nicht empfohlen · <span class="pill crit">zu weit ✗</span> = reicht rechnerisch nicht.<br><br>Ob gerade <b>frei oder besetzt</b> ist, geben die Betreiber nur in ihren eigenen Apps live frei — hier siehst du die Anzahl der Ladepunkte und den letzten gemeldeten Status samt Datum (Quelle OpenChargeMap). Live-Check kurz vor Ankunft: Betreiber-App oder <a href="https://www.chargeprice.app" target="_blank" rel="noopener">chargeprice.app</a>/Ladefuchs.`);
}
function findeStation(id) {
  if (state.letzteSuche) { const s = state.letzteSuche.stationen.find(x => x.id === id); if (s) return s; }
  const f = state.favoriten.find(x => x.id === id);
  if (f) return f;
  for (const tr of state.trips) {
    if (tr.stopps) { const s = tr.stopps.find(x => (tr.id + "-" + x.id) === id || x.id === id); if (s) return s; }
  }
  return null;
}

// Schaubild: Route als Linie mit Ladestopps (grün = HPC, gelb = langsam, rot = Lücke)
function routeSchema(trip) {
  if (!trip.stopps || !trip.stopps.length || !trip.hinKm) return "";
  const W = 680, H = 104, padL = 34, padR = 34, y = 52;
  const X = km => padL + km / trip.hinKm * (W - padL - padR);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ladestopps entlang der Route">`;
  s += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--hairline)" stroke-width="4" stroke-linecap="round"/>`;
  s += `<circle cx="${padL}" cy="${y}" r="6" fill="var(--accent)"/><text x="${padL}" y="${y + 24}" text-anchor="middle" font-size="10" fill="var(--muted)">Start · 100 %</text>`;
  s += `<circle cx="${W - padR}" cy="${y}" r="6" fill="var(--accent)"/><text x="${W - padR}" y="${y + 24}" text-anchor="middle" font-size="10" fill="var(--muted)">Ziel · ~${trip.ankunftFinal != null ? trip.ankunftFinal : "?"} %</text>`;
  trip.stopps.forEach((st, i) => {
    const farbe = st.platzhalter || st.ohneSaeule ? "var(--crit)" : (st.kw >= 150 ? "var(--good)" : "var(--warn-stripe)");
    const oben = i % 2 === 0;
    s += `<circle cx="${X(st.posKm)}" cy="${y}" r="7" fill="${farbe}" stroke="var(--card)" stroke-width="2"/>`;
    s += `<text x="${X(st.posKm)}" y="${oben ? y - 28 : y + 24}" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--ink)">${i + 1} · km ${Math.round(st.posKm)}</text>`;
    s += `<text x="${X(st.posKm)}" y="${oben ? y - 15 : y + 37}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${st.kw ? Math.round(st.kw) + " kW" : "keine Säule!"} · ${st.ladeMin} min</text>`;
  });
  s += `</svg>`;
  return `<div class="chartbox">${s}</div>`;
}

// Echte Karten-Ansicht der Route: OpenStreetMap-Kacheln + Streckenverlauf +
// nummerierte Stopps. Braucht Internet — offline zeigt das Schema die Route.
function routeKarte(trip) {
  if (!trip.geo || trip.geo.length < 2) return "";
  const T = 256, W = 680, H = 430;
  const mx = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
  const my = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);
  const lats = trip.geo.map(p => p[0]), lons = trip.geo.map(p => p[1]);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lons), maxLo = Math.max(...lons);
  let z = 12;
  for (; z > 3; z--) {
    if ((mx(maxLo, z) - mx(minLo, z)) * T <= W - 70 && (my(minLa, z) - my(maxLa, z)) * T <= H - 70) break;
  }
  const cx = (mx(minLo, z) + mx(maxLo, z)) / 2, cy = (my(minLa, z) + my(maxLa, z)) / 2;
  const px = lon => (mx(lon, z) - cx) * T + W / 2;
  const py = lat => (my(lat, z) - cy) * T + H / 2;
  const maxT = Math.pow(2, z);
  let tiles = "";
  const urls = [];
  for (let tx = Math.floor(cx - W / 2 / T); tx <= Math.floor(cx + W / 2 / T); tx++) {
    for (let ty = Math.max(0, Math.floor(cy - H / 2 / T)); ty <= Math.min(maxT - 1, Math.floor(cy + H / 2 / T)); ty++) {
      const wrapX = ((tx % maxT) + maxT) % maxT;
      const u = `https://tile.openstreetmap.org/${z}/${wrapX}/${ty}.png`;
      urls.push(u);
      tiles += `<img src="${u}" alt="" loading="lazy" onerror="this.remove()" style="position:absolute;left:${Math.round((tx - cx) * T + W / 2)}px;top:${Math.round((ty - cy) * T + H / 2)}px;width:${T}px;height:${T}px">`;
    }
  }
  routeKarte.letzteUrls = urls; // für den Offline-Cache (tilesCachen)
  const pfad = trip.geo.map((p, i) => (i ? "L" : "M") + px(p[1]).toFixed(1) + " " + py(p[0]).toFixed(1)).join(" ");
  const punkt = (lat, lng, farbe, txt) =>
    `<circle cx="${px(lng).toFixed(1)}" cy="${py(lat).toFixed(1)}" r="10" fill="${farbe}" stroke="#fff" stroke-width="2.5"/>` +
    `<text x="${px(lng).toFixed(1)}" y="${(py(lat) + 4).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">${txt}</text>`;
  let marker = "";
  if (trip.startCoord) marker += punkt(trip.startCoord.lat, trip.startCoord.lng, "#1a73e8", "S");
  (trip.stopps || []).forEach((st, i) => {
    marker += punkt(st.lat, st.lng, st.platzhalter || st.ohneSaeule ? "#c13232" : (st.kw >= 150 ? "#0a7d0a" : "#b07b00"), String(i + 1));
  });
  if (trip.zielCoord) marker += punkt(trip.zielCoord.lat, trip.zielCoord.lng, "#1a73e8", "Z");
  return `<div class="mapwrap" data-w="${W}" data-h="${H}">
    <div class="mapcanvas" style="width:${W}px;height:${H}px">
      ${tiles}
      <svg viewBox="0 0 ${W} ${H}" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px">
        <path d="${pfad}" fill="none" stroke="#1a73e8" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
        ${marker}
      </svg>
      <span class="mapattrib">© OpenStreetMap</span>
    </div>
  </div>
  <p class="small muted">S = Start · Z = Ziel · Stopps: 🟢 schnell (≥ 150 kW) · 🟡 langsamer · 🔴 offen. Anderer Weg gewünscht? Oben Alternativ-Route wählen.</p>`;
}
// Karten-Kacheln der Route offline verfügbar machen (der Service Worker
// liefert sie dann auch ohne Netz aus — z. B. in Bosnien)
async function tilesCachen(urls) {
  try {
    if (!("caches" in window) || !urls || !urls.length) return;
    const c = await caches.open("lkc-tiles");
    await Promise.all(urls.map(u => c.match(u).then(hit => hit ? null : c.add(u).catch(() => null))));
  } catch (e) { /* offline o. Ä. — beim nächsten Planen erneut */ }
}

// Karten skalieren sich auf die Kartenbreite des Geräts
function skaliereKarten() {
  $$(".mapwrap").forEach(w => {
    const c = $(".mapcanvas", w);
    if (!c) return;
    const s = Math.min(1, (w.clientWidth || 680) / (+w.dataset.w || 680));
    c.style.transform = "scale(" + s + ")";
    w.style.height = Math.round((+w.dataset.h || 430) * s) + "px";
  });
}

// Kompakte Stopp-Karte im Trip (Ladestopp-Plan)
function stoppCard(st, i, tripId) {
  const netz = st.op ? opZuNetz(st.op) : null;
  const meineIds = state.tarife.filter(besitzt).map(t => t.id);
  const b = netz ? besterPreis(netz, "dc", meineIds) : null;
  const ocmMap = `https://map.openchargemap.io/?latitude=${st.lat}&longitude=${st.lng}&zoom=12`;
  return `<div class="card flat station">
    <div class="tarif head"><b>${i + 1}. ${esc(st.name)}</b><span class="preis-haupt num">km ${n0(st.posKm)}</span></div>
    <div class="meta">
      <span class="pill ${st.kritisch ? "crit" : "acc"}">Ankunft ~${st.ankunftSoc} %${st.kritisch ? " ⚠ unter Reserve!" : ""}</span>
      <span class="pill good">laden auf ${st.zielSoc} % (~${st.ladeMin} min, ${st.kwh} kWh)</span>
      ${st.kw ? `<span class="pill">${n0(st.kw)} kW</span>` : ""}
      ${st.anz ? `<span class="pill">${st.anz} Ladepunkte${st.statusAm ? " · Status v. " + datumDE(st.statusAm) : ""}</span>` : ""}
      ${st.kw && st.kw < 150 ? '<span class="pill warn">⚠ langsamer Lader — Zeit einplanen</span>' : ""}
      ${st.zielFest ? '<span class="pill warn">hier auf 100 % — danach kommt lange nichts!</span>' : ""}
      ${st.op && !/unknown/i.test(st.op) ? `<span class="pill">${esc(st.op)}</span>` : ""}
      ${st.autoNeu ? '<span class="pill good">Säule automatisch neu gewählt ✓</span>' : ""}
      ${st.angepasst ? '<span class="pill warn">verschoben — hier keine Säule gefunden</span>' : ""}
      ${verschiebeLauf ? '<span class="pill">⏳ Säule wird gesucht …</span>' : ""}
    </div>
    ${st.ohneSaeule ? `<p class="small" style="color:var(--crit)"><b>In diesem Abschnitt hat OpenChargeMap keinen Schnelllader</b> (dünnes Netz, z. B. Bosnien). Plan: am Stopp davor auf 100 %, hier nur Notfall-Optionen — vorab auf PlugShare prüfen.</p>` : ""}
    <p class="small">${st.platzhalter || st.angepasst ? `Geplante Position — konkrete Säule hier aussuchen: <a href="${ocmMap}" target="_blank" rel="noopener">OpenChargeMap-Karte</a>` : esc(st.adresse || "")}${b ? ` — beste Karte: <b>${esc(b.name)}</b> (${ct(b.preis)})` : ""}</p>
    ${st.warum && st.warum.length ? `<details class="plain"><summary>Warum diese Säule?${st.score != null ? " (" + n1(st.score) + " Punkte)" : ""}</summary>
      <ul class="dots small">${st.warum.map(w => `<li>${esc(w)}</li>`).join("")}</ul>
      <p class="small muted">So wählt die App: Leistungs-Stufe minus Umweg, plus Bonus für dein Karten-Netz und viele Ladepunkte — die Säule mit den meisten Punkten gewinnt. Gleiche Logik bei „25 km früher/später“.</p></details>` : ""}
    <div class="btnrow">
      <a class="btn small primary" href="${mapsUrl(st)}" target="_blank" rel="noopener">🗺 Google Maps</a>
      <button class="btn small" data-action="station-teilen" data-id="${esc(tripId + "-" + st.id)}">📤 Teilen (→ Hello smart)</button>
      <button class="btn small ghost" data-action="stop-move" data-trip="${esc(tripId)}" data-id="${esc(st.id)}" data-delta="-25" ${verschiebeLauf ? "disabled" : ""}>◀ 25 km früher</button>
      <button class="btn small ghost" data-action="stop-move" data-trip="${esc(tripId)}" data-id="${esc(st.id)}" data-delta="25" ${verschiebeLauf ? "disabled" : ""}>25 km später ▶</button>
    </div>
  </div>`;
}

/* ---------- Wissen ---------- */
function viewWissen() {
  let html = `<h1>Wissen &amp; Checklisten</h1>`;
  for (const w of WISSEN) {
    html += `<div class="card"><h2>${esc(w.titel)}</h2>${w.html}</div>`;
  }
  html += `<div class="card"><h2>Installation auf deinen Geräten</h2>
    <ul class="dots">
      <li><b>Android:</b> Seite im Chrome öffnen → Menü ⋮ → „Zum Startbildschirm hinzufügen“. Läuft dann wie eine App.</li>
      <li><b>iPhone (optional):</b> Seite in Safari öffnen → Teilen-Symbol → „Zum Home-Bildschirm“. Funktioniert ohne Extra-Aufwand.</li>
      <li><b>Windows:</b> index.html doppelklicken oder im Browser als Lesezeichen/„App installieren“.</li>
      <li><b>Home Assistant (Raspberry Pi 5):</b> <code>index.html</code> (+ optional <code>tarife.json</code>) nach <code>/config/www/ladekarten/</code> kopieren (File editor/Samba-Add-on) → lokal unter <code>http://homeassistant.local:8123/local/ladekarten/index.html</code>, von unterwegs über <b>deine eigene Domain</b>: <code>https://deine-domain.tld/local/ladekarten/index.html</code>. Über HTTPS funktionieren auch Standort-Ortung und der Teilen-Knopf.</li>
      <li><b>Wichtig:</b> Die Daten liegen je Gerät im Browser. Nach größeren Änderungen: Start → „Daten exportieren“ und auf dem anderen Gerät importieren.</li>
    </ul></div>`;
  return html;
}

/* ============================================================
   EVENTS
   ============================================================ */
function bindDynamic() {
  skaliereKarten();
  // Chart-Hover
  const box = $("#chartbox");
  if (box) {
    const svg = $("svg", box), tip = $("#charttip");
    const c = breakEvenChart(state.chartKontext);
    const g = c.geom;
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const sx = (e.clientX - r.left) / r.width * g.W;
      if (sx < g.padL || sx > g.W - g.padR) { tip.style.display = "none"; return; }
      const kwh = Math.round((sx - g.padL) / (g.W - g.padL - g.padR) * c.maxKwh);
      const farben = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s5)", "var(--s4)"];
      tip.innerHTML = `<b>${kwh} kWh/Monat</b>` + c.auswahl.map((l, i) =>
        `<div class="row"><span><span class="dot" style="background:${farben[i]}"></span>${esc(kurzName(l.tarif))}</span><b>${eur(l.grund + l.preis * kwh, 0)}</b></div>`).join("");
      tip.style.display = "block";
      const bx = box.getBoundingClientRect();
      let lx = e.clientX - bx.left + 14;
      if (lx + 170 > bx.width) lx = e.clientX - bx.left - 180;
      tip.style.left = lx + "px";
      tip.style.top = Math.max(0, e.clientY - bx.top - 40) + "px";
    });
    svg.addEventListener("pointerleave", () => { tip.style.display = "none"; });
    const sel = $("#chartctx");
    if (sel) sel.addEventListener("change", () => { state.chartKontext = sel.value; save(); render(); });
    // Was-wäre-wenn-Regler: live rechnen ohne Neuzeichnen der Seite
    const sz = $("#szenario"), szOut = $("#szenario-out");
    if (sz && szOut) {
      const zeig = () => {
        const kw = +sz.value;
        const sortiert = c.auswahl.slice().sort((a, b) => (a.grund + a.preis * kw) - (b.grund + b.preis * kw));
        szOut.innerHTML = `Bei <b>${kw} kWh/Monat</b>: ` + sortiert.slice(0, 3).map((l, i) =>
          `${["🥇", "🥈", "🥉"][i]} ${esc(kurzName(l.tarif))} <b>${eur(l.grund + l.preis * kw, 0)}</b>`).join(" · ");
      };
      sz.addEventListener("input", zeig);
      zeig();
    }
  }
  // Import-Datei
  const imp = $("#importfile");
  if (imp) imp.addEventListener("change", () => {
    const file = imp.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const s = JSON.parse(rd.result);
        if (!s.tarife || !s.orte) throw new Error("Format");
        localStorage.setItem(LS_KEY, JSON.stringify(s));
        loadState(); render();
        alert("Daten importiert ✓");
      } catch (e) { alert("Datei konnte nicht gelesen werden — ist das ein Export dieser App?"); }
    };
    rd.readAsText(file);
  });
}

document.addEventListener("click", (e) => {
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) { state.tab = tabBtn.dataset.tab; save(); render(); return; }
  const driveBtn = e.target.closest("[data-drive]");
  if (driveBtn) { state.driveNetz = driveBtn.dataset.drive; save(); render(); return; }
  const infoB = e.target.closest("[data-info]");
  if (infoB) {
    const iid = infoB.dataset.info;
    if (offeneInfos.has(iid)) offeneInfos.delete(iid); else offeneInfos.add(iid);
    render(); return;
  }
  const tippB = e.target.closest("[data-tippweg]");
  if (tippB) { state.hinweiseWeg[tippB.dataset.tippweg] = true; save(); render(); return; }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const act = btn.dataset.action, id = btn.dataset.id;
  if (act === "intro-weg") { state.settings.introWeg = true; }
  if (act === "ob-weiter") {
    // Onboarding: angehakte Karten übernehmen, dann nächste Frage
    $$("[data-obkarte]").forEach(cb => { if (cb.checked) state.karten[cb.dataset.obkarte] = true; });
    state.settings.onboarding = (state.settings.onboarding || 1) + 1;
    if (state.settings.onboarding > 3) state.settings.introWeg = true;
  }
  if (act === "ob-km") {
    const kmM = +btn.dataset.km || 0;
    const vMix = (state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2;
    const zielOrt = state.orte.find(o => o.id === "heim-dc") || state.orte[0];
    if (zielOrt) zielOrt.kwhMonat = Math.round(kmM * vMix / 100);
    state.settings.onboarding = 3;
  }
  if (act === "ob-fertig") {
    const adr = (($("#ob-adresse") || {}).value || "").trim();
    if (adr) {
      state.adressen.push({ label: "Zuhause", adresse: adr });
      const heimOrt = state.orte.find(x => x.id === "heim-ac") || state.orte[0];
      if (heimOrt) heimOrt.adresse = adr;
    }
    state.settings.introWeg = true;
  }
  if (act === "preisalarm-weg") state.preisAlarm = null;
  if (act === "trip-kaelte-calc") {
    const trC = state.trips.find(t => t.id === id);
    if (trC && trC.stopps) stoppsNeuBerechnen(trC);
    state.tab = "trips";
  }
  if (act === "installieren") {
    if (installPrompt) { installPrompt.prompt(); installPrompt.userChoice.finally(() => { installPrompt = null; render(); }); }
    return;
  }
  if (act === "live-weiter") { const trL = state.trips.find(t => t.id === id); if (trL) trL.liveStopp = Math.min((trL.liveStopp || 0) + 1, (trL.stopps || []).length); }
  if (act === "live-reset") { const trL = state.trips.find(t => t.id === id); if (trL) trL.liveStopp = 0; }
  if (act === "karte-da") state.karten[id] = true;
  if (act === "karte-weg") delete state.karten[id];
  if (act === "abo-an") state.abos[id] = true;
  if (act === "abo-aus") delete state.abos[id];
  if (act === "preise-ok") state.settings.preiseGeprueft = heute();
  if (act === "ort-neu") state.orte.push({ id: uid(), name: "Neuer Ort", netz: "enbw", art: "dc", kwhMonat: 0, notiz: "" });
  if (act === "ort-weg") state.orte = state.orte.filter(o => o.id !== id);
  if (act === "trip-neu") state.trips.push({ id: uid(), ziel: "Neues Ziel", hinKm: 400, laender: ["DE"], tageVorOrt: 3, kmVorOrt: 100, datum: "", zielLaden: "schuko", routeNotiz: "" });
  if (act === "trip-weg") { if (confirm("Diesen Trip wirklich entfernen?")) state.trips = state.trips.filter(t => t.id !== id); else return; }
  if (act === "tarif-edit") { const b = $(`[data-editbox="${id}"]`); if (b) b.classList.toggle("hidden"); return; }
  if (act === "route-planen") { routePlanen(); return; }
  if (act === "suche-standort") { standortSuche(); return; }
  if (act === "suche-adresse") { const inp = $("#suchadresse"); adresseSuche(inp ? inp.value.trim() : ""); return; }
  if (act === "ort-saeulen") {
    const ort = state.orte.find(o => o.id === id);
    if (!ort || !(ort.adresse || "").trim()) { alert("Erst beim Ort eine Adresse eintragen — dann findet die App die Säulen dort."); return; }
    state.tab = "fahren"; save(); render();
    adresseSuche(ort.adresse.trim());
    return;
  }
  if (act === "station-teilen") { const st = findeStation(id); if (st) stationTeilen(st); return; }
  if (act === "station-fav") {
    const st = findeStation(id);
    if (st) {
      const i = state.favoriten.findIndex(x => x.id === st.id);
      if (i >= 0) state.favoriten.splice(i, 1); else state.favoriten.push(st);
    }
  }
  if (act === "update-anwenden") { applyTarifUpdate(); return; }
  if (act === "update-check") { checkTarifUpdate(true); return; }
  if (act === "selbsttest") { selbsttest(); return; }
  if (act === "sprech") { sprechen(btn.dataset.text || ""); return; }
  if (act === "profil-sichern") { profilSichern(); return; }
  if (act === "profil-laden") { profilLaden(); return; }
  if (act === "route-alt") { routePlanen(+btn.dataset.i || 0); return; }
  if (act === "trip-calc") { const tr = state.trips.find(x => x.id === (btn.closest("[data-trip]") || {}).dataset.trip); if (tr && tr.stopps) stoppsNeuBerechnen(tr); save(); render(); return; }
  if (act === "adr-merken-start" || act === "adr-merken-ziel") {
    const inp = $(act.endsWith("start") ? "#route-start" : "#route-ziel");
    const adresse = inp ? inp.value.trim() : "";
    if (!adresse) { alert("Erst eine Adresse ins Feld eintragen."); return; }
    const label = prompt("Name für diese Adresse (z. B. Zuhause, Arbeit, Urlaub):", "");
    if (!label) return;
    state.adressen.push({ label: label.trim().slice(0, 20), adresse });
  }
  if (act === "adr-start" || act === "adr-ziel") {
    const a = state.adressen[+btn.dataset.i];
    if (a) { state.planer[act === "adr-start" ? "start" : "ziel"] = a.adresse; }
  }
  if (act === "adr-weg") { state.adressen.splice(+btn.dataset.i, 1); }
  if (act === "verlauf-plan") {
    const v = (state.routenVerlauf || [])[+btn.dataset.i];
    if (v) { state.planer.start = v.start; state.planer.ziel = v.ziel; save(); render(); routePlanen(); }
    return;
  }
  if (act === "verlauf-weg") { state.routenVerlauf.splice(+btn.dataset.i, 1); }
  if (act === "trip-teilen") {
    const trip = state.trips.find(t => t.id === id);
    if (!trip) return;
    const anaT = tripAnalyse(trip);
    let txt = "🚗 " + trip.ziel + (trip.datum ? " am " + datumDE(trip.datum) : "") + "\n" +
      "Strecke: " + n0(trip.hinKm) + " km" + (trip.fahrzeitMin ? " · ~" + Math.floor(trip.fahrzeitMin / 60) + " h " + Math.round(trip.fahrzeitMin % 60) + " min + " + n0((trip.stopps || []).reduce((s, x) => s + (x.ladeMin || 0), 0)) + " min Laden" : "") + "\n";
    (trip.stopps || []).forEach((st, i) => { txt += "⚡ Stopp " + (i + 1) + ": " + st.name + " (km " + n0(st.posKm) + ", ~" + (st.ladeMin || 0) + " min)\n"; });
    txt += "Ankunft mit ~" + (trip.ankunftFinal != null ? trip.ankunftFinal : "?") + " % Akku · Strom gesamt ≈ " + eur(anaT.gesamt, 0) +
      (anaT.best ? " · Karte: " + anaT.best.label.split(" — ")[0] : "");
    if (navigator.share) { navigator.share({ text: txt }).catch(() => { }); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(txt); alert("Zusammenfassung kopiert — z. B. in WhatsApp einfügen."); }
    return;
  }
  if (act === "recherche-start") {
    const token = (state.settings.ghToken || "").trim();
    if (!token) { alert("Dafür einmalig ein GitHub-Token eintragen (unter „Erweitert“) — Anleitung im Feld."); return; }
    fetch("https://api.github.com/repos/Mintberry1628/ladekarten-checker/actions/workflows/tarif-update.yml/dispatches", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    }).then(r => {
      if (r.status === 204) alert("✓ Neu-Recherche gestartet! Die Cloud recherchiert jetzt (~2–3 min). Danach hier auf „Nach neuen Daten suchen“ drücken.");
      else alert("Start fehlgeschlagen (HTTP " + r.status + ") — Token prüfen (braucht Berechtigung „Actions: write“ für das Repo).");
    }).catch(e => alert("Start fehlgeschlagen: " + e.message));
    return;
  }
  if (act === "trip-ics") {
    const trip = state.trips.find(t => t.id === id);
    if (trip) icsExport(trip, tripCheckliste(trip, tripAnalyse(trip)));
    return;
  }
  if (act === "timer-start") {
    const dcL = preiseAnNetz(state.driveNetz, "dc");
    const art = dcL.length ? "dc" : "ac";
    const own = (dcL.length ? dcL : preiseAnNetz(state.driveNetz, "ac")).filter(l => besitzt(l.tarif));
    const t0 = own[0] && own[0].tarif;
    const g = t0 && t0.blockierAbMin ? t0.blockierAbMin[art] : undefined;
    state.ladeTimer = {
      start: Date.now(), netz: state.driveNetz, art,
      grenze: g === null ? null : (g || (art === "dc" ? 60 : 240)),
      tarifName: t0 ? t0.name : "",
    };
    // Erlaubnis kontextbezogen erfragen — genau jetzt ist eine Warnung nützlich
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) { }
  }
  if (act === "timer-stop") {
    // Dauer direkt ins Logbuch-Formular übernehmen (Erfassung in 5 Sekunden)
    if (state.ladeTimer) {
      state.timerVorschlag = {
        minuten: Math.max(1, Math.round((Date.now() - state.ladeTimer.start) / 60000)),
        netz: state.ladeTimer.netz,
      };
    }
    state.ladeTimer = null;
  }
  if (act === "log-neu") {
    const val = (sel) => { const el = $(sel); return el && el.value !== "" ? Math.max(0, +el.value) : 0; };
    const eintrag = {
      datum: heute(), netz: ($("#log-netz") || {}).value || "dc-fremd",
      kwh: val("#log-kwh"), minuten: val("#log-min"), kosten: val("#log-eur"), km: val("#log-km"),
    };
    if (!eintrag.kwh) { alert("Mindestens die geladenen kWh eintragen."); return; }
    // Optionale SoC-Angaben -> präzisere persönliche Ladekurve
    const socV = ($("#log-socv") || {}).value, socB = ($("#log-socb") || {}).value;
    if (socV !== "" && socV != null && socB !== "" && socB != null && +socB > +socV) {
      eintrag.socVon = Math.max(0, Math.min(100, +socV));
      eintrag.socBis = Math.max(0, Math.min(100, +socB));
    }
    // Kosten aus deinem Tarif vorrechnen, wenn nicht angegeben
    if (!eintrag.kosten && eintrag.kwh) {
      const artL = eintrag.minuten && eintrag.kwh / (eintrag.minuten / 60) >= 30 ? "dc" : "ac";
      const meineL = state.tarife.filter(besitzt).map(t => t.id);
      const bL = besterPreis(eintrag.netz, artL, meineL);
      if (bL) eintrag.kosten = Math.round(eintrag.kwh * bL.preis * 100) / 100;
    }
    state.timerVorschlag = null;
    state.logbuch.push(eintrag);
    logbuchKalibrieren();
  }
  if (act === "log-csv") {
    const kopf = "Datum;Netz;kWh;Minuten;Kosten EUR;km;Akku von %;Akku bis %";
    const zeilen = state.logbuch.map(e => [
      e.datum, netzKurz(e.netz), e.kwh, e.minuten,
      e.kosten != null ? String(e.kosten).replace(".", ",") : "",
      e.km || "", e.socVon != null ? e.socVon : "", e.socBis != null ? e.socBis : "",
    ].join(";"));
    const blob = new Blob(["﻿" + [kopf].concat(zeilen).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ladelogbuch-" + heute() + ".csv";
    a.click(); URL.revokeObjectURL(a.href);
    return;
  }
  if (act === "log-weg") { state.logbuch.splice(+btn.dataset.i, 1); logbuchKalibrieren(); }
  if (act === "log-verbrauch") {
    const stat = logbuchStatistik();
    if (stat && stat.verbrauchEcht) {
      const basis = (state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2;
      state.kalib.verbrauchFaktor = Math.max(0.7, Math.min(1.4, stat.verbrauchEcht / basis));
    }
  }
  if (act === "log-preis") {
    const e = state.logbuch[+btn.dataset.i];
    if (!e || !e.kwh || !e.kosten) return;
    const preis = Math.round(e.kosten / e.kwh * 100) / 100;
    const art = e.minuten && e.kwh / (e.minuten / 60) >= 30 ? "dc" : "ac";
    const meine = state.tarife.filter(besitzt).map(t => t.id);
    const b = besterPreis(e.netz, art, meine);
    if (!b || !b.tarif) { alert("Keine deiner Karten passt zu diesem Netz — Preis nicht zuordenbar."); return; }
    if (!confirm(`Beobachteten Preis ${ct(preis)} (${art.toUpperCase()}) für „${b.tarif.name}“ an ${netzKurz(e.netz)} übernehmen? Nützlich bei ⚠-Preisen, die je Säule variieren.`)) return;
    const t = state.tarife.find(x => x.id === b.tarif.id);
    if (t.preise && t.preise[e.netz] && t.preise[e.netz][art] != null) t.preise[e.netz][art] = preis;
    else if (t.roaming && t.roaming[art] != null) t.roaming[art] = preis;
    else { (t.preise = t.preise || {})[e.netz] = { [art]: preis }; }
    t.editiert = true;
  }
  if (act === "stop-move") {
    const trip = state.trips.find(t => t.id === btn.dataset.trip);
    const st = trip && (trip.stopps || []).find(x => x.id === id);
    if (st && !verschiebeLauf) stoppVerschieben(trip, st, +btn.dataset.delta || 0);
    return;
  }
  if (act === "tarife-json") {
    const blob = new Blob([JSON.stringify({ preisstand: state.settings.preiseGeprueft, tarife: state.tarife }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tarife.json";
    a.click(); URL.revokeObjectURL(a.href);
    return;
  }
  if (act === "reset") {
    if (!confirm("Wirklich ALLE Daten und Anpassungen löschen und neu starten?")) return;
    localStorage.removeItem(LS_KEY); state = defaultState();
  }
  if (act === "export") {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ladekarten-checker-" + heute() + ".json";
    a.click(); URL.revokeObjectURL(a.href);
    return;
  }
  if (act === "import") { const f = $("#importfile"); if (f) f.click(); return; }
  save(); render();
});

document.addEventListener("change", (e) => {
  const t = e.target;
  // Orte
  if (t.dataset.ofeld) {
    const card = t.closest("[data-ort]");
    const ort = state.orte.find(o => o.id === card.dataset.ort);
    if (ort) {
      let v = t.value;
      if (t.dataset.ofeld === "kwhMonat") v = Math.max(0, +v || 0);
      if (t.dataset.ofeld === "ladungen") {
        // Eingabe in vollen Akkuladungen -> kWh (1 Ladung = Akku-Netto-Kapazität)
        ort.kwhMonat = Math.round(Math.max(0, +String(v).replace(",", ".") || 0) * state.fahrzeug.akkuNetto);
        save(); render(); return;
      }
      ort[t.dataset.ofeld] = v;
      save(); render();
    }
  }
  // Trips: Eingaben nur SPEICHERN — gerechnet wird erst beim „Neu berechnen“-Knopf,
  // damit dich nichts beim Eintragen unterbricht
  if (t.dataset.trfeld) {
    const card = t.closest("[data-trip]");
    const trip = state.trips.find(x => x.id === card.dataset.trip);
    if (trip) {
      let v = t.value;
      const f = t.dataset.trfeld;
      if (["hinKm", "tageVorOrt", "kmVorOrt"].includes(f)) v = Math.max(0, +v || 0);
      trip[f] = v;
      // Abfahrts-/Rückreisedatum und "Tage vor Ort" gegenseitig synchron halten
      if (f === "rueckDatum" && trip.datum && v) {
        trip.tageVorOrt = Math.max(0, Math.round((new Date(v) - new Date(trip.datum)) / 864e5));
      }
      if ((f === "tageVorOrt" || f === "datum") && trip.datum) {
        trip.rueckDatum = addTage(trip.datum, +trip.tageVorOrt || 0);
      }
      if (f === "datum") { trip.wetter = null; wetterHolen(trip); }
      save(); // KEIN render — Werte übernehmen, Ruhe beim Tippen
    }
  }
  // Fahrt-Cockpit (Fahrmodus)
  if (t.dataset.fahrt) {
    const f = t.dataset.fahrt;
    let v = t.value;
    if (f === "winter") v = !!v;
    else if (f !== "modus") v = Math.max(0, +v || 0);
    state.fahrt[f] = v;
    save(); render();
  }
  // Einstellungen / Fahrzeug
  if (t.dataset.sfeld === "suchKw") {
    // Wunsch-Leistung geändert -> letzte Suche direkt mit neuem Filter wiederholen
    state.settings.suchKw = Math.max(0, +t.value || 0);
    save();
    if (state.letzteSuche) sucheSaeulen(state.letzteSuche.lat, state.letzteSuche.lng);
    else render();
    return;
  }
  if (t.dataset.sfeld) { state.settings[t.dataset.sfeld] = Math.max(0, +t.value || 0); save(); render(); }
  if (t.dataset.sfeldtext) { state.settings[t.dataset.sfeldtext] = t.value.trim(); save(); render(); }
  if (t.dataset.scheck) { state.settings[t.dataset.scheck] = t.checked; save(); render(); }
  if (t.dataset.scheckSel) { state.settings[t.dataset.scheckSel] = !!t.value; save(); render(); }
  if (t.dataset.ffeld) { state.fahrzeug[t.dataset.ffeld] = Math.max(0, +t.value || 0); save(); render(); }
  if (t.dataset.ffeldtext) { state.fahrzeug[t.dataset.ffeldtext] = t.value.trim() || state.fahrzeug[t.dataset.ffeldtext]; save(); render(); }
  // Tarif-Preise
  if (t.dataset.tfeld) {
    const tarif = state.tarife.find(x => x.id === t.dataset.tid);
    if (tarif) {
      const v = Math.max(0, +t.value || 0);
      if (t.dataset.tfeld === "grund") tarif.grund = v;
      if (t.dataset.tfeld === "roamingAc") tarif.roaming.ac = v;
      if (t.dataset.tfeld === "roamingDc") tarif.roaming.dc = v;
      if (t.dataset.tfeld === "preis-ac") tarif.preise[t.dataset.netz].ac = v;
      if (t.dataset.tfeld === "preis-dc") tarif.preise[t.dataset.netz].dc = v;
      tarif.editiert = true;
      state.settings.preiseGeprueft = heute();
      save(); render();
    }
  }
  // Checklisten
  if (t.dataset.check) {
    state.checks[t.dataset.check] = t.checked;
    save();
    const row = t.closest(".check");
    if (row) row.classList.toggle("done", t.checked);
  }
});

/* ---------- Theme ---------- */
function initTheme() {
  const saved = localStorage.getItem("lkc-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  $("#themebtn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || "";
    const next = cur === "" ? "light" : cur === "light" ? "dark" : "";
    if (next) { document.documentElement.dataset.theme = next; localStorage.setItem("lkc-theme", next); }
    else { delete document.documentElement.dataset.theme; localStorage.removeItem("lkc-theme"); }
  });
}

/* ---------- „Als App installieren“ (ein Tipp statt Menü-Anleitung) ---------- */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; render(); });

/* ---------- Start ---------- */
loadState();
initTheme();
// App-Icon-Shortcuts (?go=…): direkt an die richtige Stelle springen
let goShortcut = "";
try {
  goShortcut = new URLSearchParams(location.search).get("go") || "";
  if (goShortcut === "trips") state.tab = "trips";
  if (goShortcut === "saeulen" || goShortcut === "timer") state.tab = "fahren";
  if (goShortcut) history.replaceState(null, "", location.pathname);
} catch (e) { /* egal */ }
render();
if (goShortcut === "saeulen") standortSuche();
checkTarifUpdate();
// Wetter für nahe Trips auffrischen (Kälte-Check am Vortag)
state.trips.filter(t => {
  if (!t.datum) return false;
  const tage = Math.round((new Date(t.datum) - new Date()) / 864e5);
  return tage >= 0 && tage <= 3;
}).forEach(wetterHolen);
// Blockier-Timer: minütlich prüfen — Benachrichtigung vor der Gebühr, Anzeige auffrischen
setInterval(() => {
  const t = state.ladeTimer;
  if (t && t.grenze != null) {
    const min = Math.floor((Date.now() - t.start) / 60000);
    const rest = t.grenze - min;
    if (rest <= 10 && rest > 0 && !t.warn10) { t.warn10 = true; benachrichtige("⏱ Gleich Blockiergebühr", "Noch " + rest + " min gratis — Ladung bald beenden oder umparken."); save(); }
    if (rest <= 0 && !t.warn0) { t.warn0 = true; benachrichtige("💸 Blockiergebühr läuft!", "Die Standzeitgebühr (~10 ct/min) hat begonnen — Auto umparken."); save(); }
  }
  if (state.ladeTimer && state.tab === "fahren") render();
}, 60000);
// Routen-Karten an die Fensterbreite anpassen
window.addEventListener("resize", skaliereKarten);
// Offline-Modus: Service Worker (nur über http/https, Datei liegt neben index.html)
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* Datei fehlt (z. B. Artifact) — ok */ });
}
