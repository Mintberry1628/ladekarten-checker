/* ============================================================
   Ladekarten-Checker — Logik & Ansichten
   ============================================================ */
"use strict";

const DATA_VERSION = 5;
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
    settings: {
      schukoPreis: 0.38, preiseGeprueft: PREISSTAND, introWeg: false,
      ocmKey: (typeof OCM_KEY_STANDARD !== "undefined" ? OCM_KEY_STANDARD : ""), puffer: 15, nurMeineKarten: false,
      ankunftSoc: 20, beladen: true,
      updateUrl: "https://mintberry.org/local/ladekarten/tarife.json",
    },
    fahrt: { modus: "soc", soc: 60, restKm: 250, tempo: 130, winter: false },
    planer: { start: "", ziel: "" },     // Routen-Planer: bewusst KEINE Vorgaben
    favoriten: [],                       // gemerkte Ladesäulen
    letzteSuche: null,                   // letztes Säulen-Suchergebnis (offline nutzbar)
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
    const alt = s.tarife || [];
    s.tarife = JSON.parse(JSON.stringify(TARIFE_DEFAULT)).map(def => {
      const old = alt.find(t => t.id === def.id);
      return (old && old.editiert) ? old : def;
    });
    alt.forEach(t => { if (t.eigen && !s.tarife.find(x => x.id === t.id)) s.tarife.push(t); });
    // Streckenanteile aus neuen Defaults nachziehen (nur wenn noch nicht vorhanden)
    (s.trips || []).forEach(tr => {
      const d = TRIPS_DEFAULT.find(x => x.id === tr.id);
      if (d && d.anteile && !tr.anteile) tr.anteile = d.anteile;
    });
    s.version = DATA_VERSION;
  }
  const d = defaultState();
  state = Object.assign(d, s);
  state.settings = Object.assign(defaultState().settings, s.settings || {});
  state.fahrt = Object.assign(defaultState().fahrt, s.fahrt || {});
  state.fahrzeug = Object.assign({ ...FAHRZEUG_DEFAULT }, s.fahrzeug || {});
  state.favoriten = s.favoriten || [];
  // Eingebauter OCM-Key greift, solange der Nutzer keinen eigenen eingetragen hat
  if (!state.settings.ocmKey && typeof OCM_KEY_STANDARD !== "undefined" && OCM_KEY_STANDARD) {
    state.settings.ocmKey = OCM_KEY_STANDARD;
  }
}

function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* voll/privat */ } }

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
  if (netzId === "schuko") return { preis: state.settings.schukoPreis, tarif: null, name: "Haushaltsstrom (NRGkick)" };
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
    detail.push({ ort, preis, tarifName: b ? b.name : "Ad-hoc", kosten: preis * ort.kwhMonat, unsicher: b && b.unsicher });
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

// Aktionsliste: bestellen / abonnieren / kündigen
function aktionen(analyse) {
  const acts = [];
  for (const t of state.tarife) {
    if (t.basisEmpfehlung && !state.karten[t.id]) {
      acts.push({ typ: "bestellen", tarif: t, text: `${t.medium.includes("Karte") ? "Karte bestellen / App einrichten" : "App einrichten"} — kostenlos, ${t.grund ? "" : "keine Grundgebühr"}`, });
    }
  }
  for (const a of analyse.abosGewaehlt) {
    const t = state.tarife.find(x => x.id === a.id);
    if (!state.abos[t.id]) {
      acts.push({ typ: "abonnieren", tarif: t, ersparnis: a.ersparnis, breakEven: a.breakEvenKwh, vorteil: a.vorteilProKwh, kwh: a.kwhBetroffen });
    }
  }
  for (const id of Object.keys(state.abos)) {
    if (!state.abos[id]) continue;
    const t = state.tarife.find(x => x.id === id);
    if (t && !analyse.abosGewaehlt.find(a => a.id === id)) {
      acts.push({ typ: "kuendigen", tarif: t, text: `Rechnet sich bei deinem aktuellen Ladeprofil nicht — spart ${eur(t.grund)}/Monat.` });
    }
  }
  return acts;
}

/* ---------- Trip-Engine ---------- */
function tripAnalyse(trip) {
  const f = state.fahrzeug;
  const winterFaktor = trip.winter ? (1 + f.winterZuschlag / 100) : 1;
  const beladenFaktor = state.settings.beladen ? 1 + (f.beladenZuschlag || 8) / 100 : 1;
  const vAB = f.verbrauchAB * winterFaktor * beladenFaktor;
  const vLokal = ((f.verbrauchStadt + f.verbrauchLand) / 2) * winterFaktor;
  const akku = f.akkuNetto;
  // Ankunfts-Reserve (Standard 20 %), fürs Planen auf sinnvollen Bereich begrenzt
  const res = Math.min(0.5, Math.max(0.05, state.settings.ankunftSoc / 100));
  const kmVoll = (akku * (1 - res)) / vAB * 100;              // 100 % -> Reserve
  const kmHub = (akku * Math.max(0.1, 0.8 - res)) / vAB * 100; // 80 % -> Reserve (Folge-Etappen)
  const stopsProRichtung = trip.hinKm <= kmVoll ? 0 : Math.ceil((trip.hinKm - kmVoll) / kmHub);
  const kWhStrecke = trip.hinKm * vAB / 100;
  const dcHin = Math.max(0, kWhStrecke - akku * (1 - res));
  // Rückfahrt: Start voll nur, wenn vor Ort geladen werden kann
  const zielLadenGeht = !!trip.zielLaden;
  const dcUnterwegs = dcHin + (zielLadenGeht ? dcHin : kWhStrecke);
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
    kandidaten.push({
      label: d.label + (cov < 0.999 ? ` — deckt ${Math.round(cov * 100)} % der Strecke, Rest über ${luecke.name.split(" ")[0]}` : ""),
      tarif: t, netz: d.netz, preis: p.preis, unsicher: p.unsicher,
      grund: (t.grund || 0) * monate, cov, kwhCov, kwhRest, lueckePreis: luecke.preis,
      kosten: (t.grund || 0) * monate + p.preis * kwhCov + luecke.preis * kwhRest,
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

  // Kosten vor Ort + Abfahrt
  const heimBest = besterPreis("enbw", "dc", null);
  const kostenAbfahrt = kWhAbfahrt * (heimBest ? heimBest.preis : 0.6);
  let vorOrtPreis, vorOrtName;
  if (trip.zielLaden === "schuko") { vorOrtPreis = state.settings.schukoPreis; vorOrtName = "Steckdose/NRGkick"; }
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

// Checkliste für einen Trip (mit Terminen, wenn Datum gesetzt)
function tripCheckliste(trip, ana) {
  const items = [];
  const d = trip.datum;
  const w = (tage) => d ? `bis ${datumDE(addTage(d, -tage))}` : `${tage} Tage vorher`;
  if (trip.laender.includes("BA")) {
    items.push({ when: w(21), text: "Grüne Versicherungskarte bei der Kfz-Versicherung anfordern und prüfen, dass Bosnien (BIH) NICHT ausgeschlossen ist. Physisch mitführen!" });
    items.push({ when: w(7), text: "eSIM/Datenpaket für Bosnien buchen (kein EU-Roaming!) — sonst offline an der Ladesäule." });
    items.push({ when: w(7), text: "PlugShare: Lader entlang Zagreb→Banja Luka→Fojnica checken, Screenshots offline speichern." });
  }
  if (trip.laender.includes("AT")) items.push({ when: w(7), text: "Digitale Vignette Österreich kaufen (asfinag.at) + an Sondermaut Tauern/Karawanken denken." });
  if (trip.laender.includes("SI")) items.push({ when: w(7), text: "E-Vinjeta Slowenien kaufen (evinjeta.dars.si) — Kennzeichen doppelt prüfen." });
  if (ana.best && ana.best.abo) items.push({ when: w(2), text: `${ana.best.tarif.name} abschließen (${eur(ana.best.grund)}, monatlich kündbar) — spart auf diesem Trip ${eur((ana.bestOhneAbo ? ana.bestOhneAbo.kosten : 0) - ana.best.kosten)} ggü. der besten 0-€-Option.` });
  items.push({ when: w(2), text: "Backup-Apps aufs Handy + einloggen + Zahlungsmittel hinterlegen: Ionity, EnBW, Tesla, Electroverse" + (trip.laender.includes("HR") ? ", ELEN (Kroatien)" : "") + "." });
  items.push({ when: w(1), text: "Ladeziel im Auto auf 100 % stellen und vollladen (Abfahrt mit vollem Akku spart den teuersten Stopp)." });
  items.push({ when: w(1), text: "Packen: Typ-2-Kabel, NRGkick + alle Adapter (Schuko, CEE blau, CEE rot), ggf. schwere Verlängerung, Handschuhe." });
  if (trip.laender.includes("BA")) items.push({ when: "Unterwegs", text: "Letzten Schnelllader in Kroatien auf 100 % nutzen, dann erst über die Grenze nach Bosnien." });
  items.push({ when: "Unterwegs", text: "Schnelllader immer im Auto-Navi als Ziel setzen → Akku-Vorkonditionierung = volle Ladeleistung." });
  if (ana.best && ana.best.abo) {
    const ende = d ? datumDE(addTage(d, (+trip.tageVorOrt || 0) + 2)) : "nach der Rückkehr";
    items.push({ when: "Danach", text: `${ana.best.tarif.name} wieder kündigen (${ende}) — sonst läuft die Grundgebühr weiter.` });
  }
  return items;
}

/* ---------- Fahr-Physik & Ladekurve ---------- */
// Besitzt der Nutzer diesen Tarif? (Ad-hoc geht immer)
function besitzt(t) {
  return t.id === "adhoc" ? true : (t.kategorie === "abo" ? !!state.abos[t.id] : !!state.karten[t.id]);
}
// Verbrauch (kWh/100 km) je Ziel-Tempo — Grundlast + Luftwiderstand, kalibriert am 130-km/h-Wert
function verbrauchBeiTempo(v, winter) {
  const c130 = state.fahrzeug.verbrauchAB;
  const a = c130 * 0.3876, b = (c130 * 0.6124) / (130 * 130);
  let c = a + b * v * v;
  if (winter) c *= 1 + state.fahrzeug.winterZuschlag / 100;
  if (state.settings.beladen) c *= 1 + (state.fahrzeug.beladenZuschlag || 8) / 100;
  return c;
}
// DC-Ladezeit in Minuten von SoC a → b (warmer Akku, Näherung laut LADEKURVE)
function ladezeitMin(von, bis) {
  const akku = state.fahrzeug.akkuNetto;
  let min = 0;
  for (const [s0, s1, kw] of LADEKURVE) {
    const lo = Math.max(von, s0), hi = Math.min(bis, s1);
    if (hi > lo) min += ((hi - lo) / 100 * akku) / kw * 60;
  }
  return min;
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
  try {
    const url = "https://api.openchargemap.io/v3/poi/?output=json&distanceunit=km&distance=30&maxresults=25&verbose=false" +
      "&latitude=" + lat + "&longitude=" + lng + "&key=" + encodeURIComponent(key);
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const js = await r.json();
    state.letzteSuche = {
      lat, lng, zeit: new Date().toISOString(),
      stationen: js.filter(p => p.AddressInfo).map(p => ({
        id: "ocm" + p.ID,
        name: p.AddressInfo.Title || "Ladepunkt",
        op: (p.OperatorInfo && p.OperatorInfo.Title) || "",
        lat: p.AddressInfo.Latitude, lng: p.AddressInfo.Longitude,
        adresse: [p.AddressInfo.AddressLine1, p.AddressInfo.Town].filter(Boolean).join(", "),
        kw: Math.max(0, ...(p.Connections || []).map(c => c.PowerKW || 0)),
        anz: (p.Connections || []).reduce((s, c) => s + (c.Quantity || 1), 0),
      })),
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
  return js.length ? { lat: +js[0].lat, lng: +js[0].lon, label: js[0].display_name.split(",").slice(0, 2).join(",") } : null;
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
async function ocmBesteSaeule(lat, lng) {
  const key = (state.settings.ocmKey || "").trim();
  if (!key) return null;
  const abfrage = async (minKw) => {
    const url = "https://api.openchargemap.io/v3/poi/?output=json&distanceunit=km&distance=12&maxresults=10&verbose=false&minpowerkw=" + minKw +
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
      dist: haversineKm(lat, lng, p.AddressInfo.Latitude, p.AddressInfo.Longitude),
    })).filter(k => k.kw >= minKw);
  };
  try {
    let kand = await abfrage(150);
    if (!kand.length) { await sleep(300); kand = await abfrage(50); }
    if (!kand.length) return null;
    const meineIds = state.tarife.filter(besitzt).map(t => t.id);
    kand.forEach(k => {
      const netz = opZuNetz(k.op);
      const b = netz ? besterPreis(netz, "dc", meineIds) : null;
      k.score = (k.kw >= 300 ? 3 : k.kw >= 150 ? 1 : 0)  // HPC-Bonus: 300+ klar bevorzugt
        + Math.min(k.kw, 400) / 400                        // Feinabstufung nach Leistung
        - k.dist / 8                                       // Umweg bestraft
        + (b ? 1.5 : 0)                                    // Netz einer deiner Karten
        + (k.anz >= 4 ? 0.5 : 0);                          // viele Ladepunkte = weniger Wartezeit
    });
    kand.sort((a, b) => b.score - a.score);
    return kand[0];
  } catch (e) { return null; }
}
async function routePlanen() {
  const startQ = ($("#route-start") || {}).value || "";
  const zielQ = ($("#route-ziel") || {}).value || "";
  state.planer = { start: startQ.trim(), ziel: zielQ.trim() };
  if (!state.planer.start || !state.planer.ziel) { routeStatus = "fehler:Bitte Start und Ziel eingeben."; render(); return; }
  save();
  try {
    routeStatus = "1/4 Adressen suchen …"; render();
    const a = await geocode(state.planer.start);
    await sleep(1100); // Nominatim-Fair-Use: max. 1 Anfrage/Sekunde
    const b = await geocode(state.planer.ziel);
    if (!a || !b) { routeStatus = "fehler:" + (!a ? "Start" : "Ziel") + " nicht gefunden — Adresse präzisieren (Ort, Land)."; render(); return; }

    routeStatus = "2/4 Route berechnen …"; render();
    const rr = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`);
    const rjs = await rr.json();
    if (!rjs.routes || !rjs.routes.length) { routeStatus = "fehler:Keine Route gefunden."; render(); return; }
    const route = rjs.routes[0];
    const distKm = route.distance / 1000, fahrzeitMin = route.duration / 60;
    const coords = route.geometry.coordinates;
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]));

    routeStatus = "3/4 Länder auf der Route erkennen …"; render();
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

    routeStatus = "4/4 Ladestopps setzen …"; render();
    const f = state.fahrzeug;
    const res = Math.min(0.5, Math.max(0.05, state.settings.ankunftSoc / 100));
    const verbrauch = verbrauchBeiTempo(state.fahrt.tempo, state.fahrt.winter);
    const stopps = [];
    let covered = 0, soc = 100;
    for (let i = 0; i < 8; i++) {
      const reichKm = (soc - res * 100) / 100 * f.akkuNetto / verbrauch * 100;
      if (covered + reichKm >= distKm) break;
      const stopKm = covered + reichKm * 0.92; // 8 % Marge für Umweg/Abweichung
      const p = punktBeiKm(coords, cum, stopKm);
      const saeule = await ocmBesteSaeule(p.lat, p.lng);
      const ankunftSoc = soc - (stopKm - covered) * verbrauch / f.akkuNetto;
      const restKm = distKm - stopKm;
      const brauchtSoc = restKm * verbrauch / f.akkuNetto + res * 100;
      const zielSoc = Math.min(brauchtSoc > 80 ? 80 : Math.min(95, brauchtSoc + 3), 100);
      stopps.push(Object.assign({
        id: "stop" + i, posKm: stopKm, lat: p.lat, lng: p.lng,
        name: "Geplanter Ladestopp", op: "", kw: 0, adresse: "", platzhalter: true,
      }, saeule || {}, {
        ankunftSoc: Math.round(ankunftSoc), zielSoc: Math.round(zielSoc),
        ladeMin: Math.round(ladezeitMin(ankunftSoc, zielSoc)),
        kwh: Math.round((zielSoc - ankunftSoc) / 100 * f.akkuNetto),
        posKm: stopKm,
      }));
      soc = zielSoc; covered = stopKm;
      if (saeule) await sleep(400);
    }
    const ankunftFinal = Math.round(soc - (distKm - covered) * verbrauch / f.akkuNetto);

    // Route als Trip anlegen/aktualisieren — dort passiert die Karten- & Kosten-Empfehlung
    const tripId = "route-" + (a.label + "-" + b.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    let trip = state.trips.find(t => t.id === tripId);
    if (!trip) {
      trip = { id: tripId, tageVorOrt: 0, kmVorOrt: 0, datum: "", zielLaden: "schuko" };
      state.trips.unshift(trip);
    }
    Object.assign(trip, {
      ziel: a.label + " → " + b.label,
      hinKm: Math.round(distKm), laender, anteile, stopps,
      fahrzeitMin: Math.round(fahrzeitMin), ankunftFinal,
      winter: state.fahrt.winter,
      routeNotiz: "Echte Route (" + n0(distKm) + " km, ~" + Math.floor(fahrzeitMin / 60) + " h " + Math.round(fahrzeitMin % 60) + " min reine Fahrzeit). Geplant mit " + n1(verbrauch) + " kWh/100 km bei " + state.fahrt.tempo + " km/h" + (state.settings.beladen ? ", beladen" : "") + ", Ankunft je Etappe ≥ " + state.settings.ankunftSoc + " %.",
    });
    routeStatus = "";
    save(); render();
  } catch (e) {
    routeStatus = "fehler:Planung fehlgeschlagen (" + e.message + "). Hinweis: Im claude.ai-Link sind externe Abfragen gesperrt — nutze die App über mintberry.org oder am PC.";
    render();
  }
}

/* ---------- Tarif-Updates (tarife.json neben der App) ---------- */
let updateInfo = null;
async function checkTarifUpdate() {
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
    updateInfo = bestes; render();
  }
}
function applyTarifUpdate() {
  if (!updateInfo) return;
  for (const neu of updateInfo.tarife) {
    const i = state.tarife.findIndex(t => t.id === neu.id);
    if (i >= 0) { if (!state.tarife[i].editiert) state.tarife[i] = neu; }
    else state.tarife.push(neu);
  }
  if (Array.isArray(updateInfo.entfernt)) {
    state.tarife = state.tarife.filter(t => !updateInfo.entfernt.includes(t.id) || t.editiert);
  }
  state.settings.preiseGeprueft = updateInfo.preisstand;
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
  // Break-even-Punkte: Abos vs. beste freie Linie
  let marker = "";
  const besteFrei = frei[0];
  if (besteFrei) {
    for (const l of auswahl) {
      if (!l.grund || l.preis >= besteFrei.preis) continue;
      const kStar = l.grund / (besteFrei.preis - l.preis);
      if (kStar > 0 && kStar < maxKwh) {
        const cStar = l.grund + l.preis * kStar;
        marker += `<circle cx="${X(kStar)}" cy="${Y(cStar)}" r="5" fill="var(--card)" stroke="var(--ink)" stroke-width="2"/>` +
          `<text x="${X(kStar)}" y="${Y(cStar) - 10}" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--ink)">${Math.round(kStar)} kWh</text>`;
      }
    }
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
  return { svg, legende, tabelle, ctx, auswahl, maxKwh, geom: { W, H, padL, padR, padT, padB, maxY } };
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
  main.innerHTML = `<div class="tabpane wrap">${fn()}</div>`;
  bindDynamic();
  window.scrollTo(0, 0);
}

function renderNav() {
  const mk = (t) => `<button data-tab="${t.id}" class="${state.tab === t.id ? "on" : ""}" aria-label="${t.label}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg>${t.label}</button>`;
  $("#tabbar").innerHTML = TABS.map(mk).join("");
  $("#topnav").innerHTML = TABS.map(t => `<button data-tab="${t.id}" class="${state.tab === t.id ? "on" : ""}">${t.label}</button>`).join("");
}

/* ---------- Start / Dashboard ---------- */
function viewStart() {
  const ana = monatsAnalyse();
  const acts = aktionen(ana);
  let html = "";

  if (!state.settings.introWeg) {
    html += `<div class="card alert info"><h3>👋 Willkommen zu deinem Lade-Cockpit</h3>
      <p>Alles ist schon mit deinen Daten vorbefüllt: <b>smart #5 Brabus</b>, München ohne Heimladen, Trips nach Fojnica &amp; Oberhausen.
      Die App rechnet dir jederzeit aus: welche Karten du brauchst, welche Abos sich wann lohnen (mit Rechenbeispiel) und was du vor Reisen erledigen musst.
      Alle Zahlen unter <b>Orte</b> und <b>Tarife</b> sind anpassbar — die Empfehlungen rechnen sofort neu.</p>
      <div class="btnrow"><button class="btn small" data-action="intro-weg">Verstanden, ausblenden</button></div></div>`;
  }

  // Tarif-Update vom eigenen Server verfügbar?
  if (updateInfo) {
    html += `<div class="card alert good"><h3>⬇️ Neue Tarifdaten verfügbar (Stand ${datumDE(updateInfo.preisstand)})</h3>
      <p>Auf deinem Server liegt eine neuere <code>tarife.json</code>. Von dir selbst geänderte Tarife werden nicht überschrieben.</p>
      <div class="btnrow"><button class="btn small primary" data-action="update-anwenden">Jetzt übernehmen</button></div></div>`;
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

  // Aktionen
  if (acts.length) {
    html += `<div class="card"><h2>📋 Deine To-dos (automatisch berechnet)</h2><ul class="clean">`;
    for (const a of acts) {
      if (a.typ === "bestellen") {
        html += `<li><span class="pill acc">Einrichten</span> <b>${esc(a.tarif.name)}</b><br><small>${esc(a.text)} — ${esc(a.tarif.hinweis || "")}</small>
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
  } else {
    html += `<div class="card alert good"><h3>✅ Setup passt</h3><p>Karten und Abos entsprechen genau deinem Ladeprofil — nichts zu tun.</p></div>`;
  }

  // Wo lade ich wie günstig (Detail)
  html += `<div class="card"><h2>Dein günstigster Preis je Ort</h2><div class="tblwrap"><table>
    <tr><th>Ort</th><th>Womit</th><th class="num">Preis</th><th class="num">€/Monat</th></tr>`;
  for (const d of ana.kosten.detail) {
    html += `<tr><td>${esc(d.ort.name)}</td><td>${esc(d.tarifName)}${d.unsicher ? " ⚠" : ""}</td><td class="num">${ct(d.preis)}</td><td class="num">${eur(d.kosten)}</td></tr>`;
  }
  html += `<tr class="best"><td colspan="3">Summe (+ ${eur(ana.kosten.grund)} Abos)</td><td class="num">${eur(ana.kosten.gesamt)}</td></tr></table></div>
    <p class="small">⚠ = Preis variiert je Säule/Uhrzeit — vor dem Laden in der App prüfen.</p></div>`;

  // Nächster Trip
  const nT = state.trips.filter(t => t.datum && t.datum >= heute()).sort((a, b) => a.datum.localeCompare(b.datum))[0];
  if (nT) {
    const tg = Math.ceil((new Date(nT.datum) - new Date()) / 864e5);
    html += `<div class="card alert info"><h3>🧳 Nächster Trip: ${esc(nT.ziel)} in ${tg} Tagen</h3>
      <p>Checkliste und Ladeplan findest du unter <b>Trips</b>.</p>
      <div class="btnrow"><button class="btn small primary" data-tab="trips">Zum Trip-Planer</button></div></div>`;
  }

  html += `<div class="card flat"><h2>Daten</h2>
    <p class="small">Alles liegt nur lokal auf diesem Gerät. Für dein zweites Gerät (PC ↔ Handy): exportieren &amp; dort importieren.</p>
    <div class="btnrow">
      <button class="btn small" data-action="export">⬇ Daten exportieren</button>
      <button class="btn small" data-action="import">⬆ Daten importieren</button>
      <button class="btn small" data-action="preise-ok">✓ Preise geprüft (${datumDE(state.settings.preiseGeprueft)})</button>
      <button class="btn small danger" data-action="reset">Zurücksetzen</button>
    </div>
    <details class="plain"><summary>Update-Quelle für Tarifdaten</summary>
      <label class="f">URL zur tarife.json auf deinem Server</label>
      <input type="text" data-sfeldtext="updateUrl" value="${esc(state.settings.updateUrl)}">
      <p class="small">Die App prüft beim Start automatisch, ob dort ein neuerer Tarifstand liegt.</p>
    </details>
    <input type="file" id="importfile" accept=".json" class="hidden"></div>`;
  return html;
}

/* ---------- Orte ---------- */
function viewOrte() {
  let html = `<h1>Deine Ladeorte</h1>
  <p class="small">Trag ein, wo du regelmäßig lädst und wie viel (kWh pro Monat). Daraus berechnet die App Empfehlungen und Break-even.
  Faustregel: dein #5 braucht ca. <b>${n1((state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2)} kWh/100 km</b> im Alltag — 1.000 km/Monat ≈ ${n0(((state.fahrzeug.verbrauchStadt + state.fahrzeug.verbrauchLand) / 2) * 10)} kWh.</p>`;
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
        <div><label class="f">kWh / Monat</label><input type="number" min="0" step="5" data-ofeld="kwhMonat" value="${ort.kwhMonat}"></div>
      </div>
      <div class="btnrow"><button class="del" data-action="ort-weg" data-id="${ort.id}">Ort entfernen</button></div>
    </div>`;
  }
  html += `<div class="btnrow"><button class="btn primary" data-action="ort-neu">+ Ort hinzufügen</button></div>
  <div class="card flat"><h3>Einstellungen</h3>
    <div class="frow">
      <div><label class="f">Strompreis an der Steckdose (€/kWh)</label><input type="number" step="0.01" min="0" data-sfeld="schukoPreis" value="${state.settings.schukoPreis}"></div>
      <div><label class="f">Verbrauch Autobahn 130 (kWh/100 km)</label><input type="number" step="0.5" min="10" data-ffeld="verbrauchAB" value="${state.fahrzeug.verbrauchAB}"></div>
      <div><label class="f">Winter-Zuschlag (%)</label><input type="number" step="1" min="0" data-ffeld="winterZuschlag" value="${state.fahrzeug.winterZuschlag}"></div>
    </div>
    <p class="small">Fahrzeug: ${esc(state.fahrzeug.name)} — ${state.fahrzeug.akkuNetto} kWh netto, DC bis ${state.fahrzeug.dcMax} kW (10→80 % ≈ 18 min), AC ${state.fahrzeug.acMax} kW.</p>
  </div>`;
  return html;
}

/* ---------- Tarife ---------- */
function viewTarife() {
  const c = breakEvenChart(state.chartKontext);
  let html = `<h1>Tarife &amp; Break-even</h1>
  <div class="card"><h2>Ab wann lohnt sich welches Abo?</h2>
    <label class="f">Situation wählen</label>
    <select id="chartctx">${CHART_KONTEXTE.map(k => `<option value="${k.id}" ${k.id === state.chartKontext ? "selected" : ""}>${esc(k.label)}</option>`).join("")}</select>
    <div class="chartbox" id="chartbox">${c.svg}<div class="charttip" id="charttip"></div></div>
    <div class="legend">${c.legende}</div>
    <p class="small">Die markierten Punkte zeigen den <b>Break-even</b>: ab dieser Monats-Lademenge ist das Abo günstiger als die beste Karte ohne Grundgebühr. Darunter: Finger weg vom Abo.</p>
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
        <p class="small">${esc(t.hinweis || "")}</p>
        ${t.blockier ? `<p class="small muted">Standzeit: ${esc(t.blockier)}</p>` : ""}
        ${t.jahresAlternative ? `<p class="small muted">Alternative: ${esc(t.jahresAlternative)}</p>` : ""}
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
  <div class="card"><h2>🗺 Route planen</h2>
    <p class="small">Start und Ziel eingeben — die App berechnet die echte Straßenroute, erkennt die Länder, setzt Ladestopps passend zu deinem #5 (konservativ, beladen gerechnet) und empfiehlt unten im Trip die günstigste Karten-Kombi für genau diese Fahrt.</p>
    <div class="frow">
      <div style="flex:2 1 180px"><label class="f">Start (Adresse/Ort)</label><input type="text" id="route-start" placeholder="z. B. Musterstr. 1, München" value="${esc(state.planer.start)}"></div>
      <div style="flex:2 1 180px"><label class="f">Ziel (Adresse/Ort)</label><input type="text" id="route-ziel" placeholder="z. B. Fojnica, Bosnien" value="${esc(state.planer.ziel)}"></div>
    </div>
    <details class="plain"><summary>Annahmen anpassen (Ankunfts-%, Tempo, Winter, Beladung)</summary>
      <div class="frow">
        <div><label class="f">Ankunft je Etappe mit mind. (%)</label><input type="number" min="5" max="50" step="5" data-sfeld="ankunftSoc" value="${state.settings.ankunftSoc}"></div>
        <div><label class="f">Mein Tempo (km/h)</label><input type="number" min="60" max="200" step="5" data-fahrt="tempo" value="${state.fahrt.tempo}"></div>
        <div><label class="f">Winter?</label><select data-fahrt="winter"><option value="" ${!state.fahrt.winter ? "selected" : ""}>Nein</option><option value="1" ${state.fahrt.winter ? "selected" : ""}>Ja</option></select></div>
        <div><label class="f">Voll beladen?</label><select data-scheckSel="beladen"><option value="1" ${state.settings.beladen ? "selected" : ""}>Ja (+${state.fahrzeug.beladenZuschlag} %)</option><option value="" ${!state.settings.beladen ? "selected" : ""}>Nein</option></select></div>
      </div>
    </details>
    <div class="btnrow"><button class="btn primary" data-action="route-planen">Route berechnen</button></div>
    ${routeStatus && !routeStatus.startsWith("fehler:") ? `<p class="small">⏳ ${esc(routeStatus)} (dauert ~15 Sek. — die Karten-Dienste erlauben nur 1 Anfrage/Sekunde)</p>` : ""}
    ${routeStatus.startsWith("fehler:") ? `<p class="small" style="color:var(--crit)">${esc(routeStatus.slice(7))}</p>` : ""}
    ${!(state.settings.ocmKey || "").trim() ? '<p class="small" style="color:var(--warn)">Hinweis: Ohne OpenChargeMap-Key (unter <b>Fahren</b> eintragen) werden Stopp-Positionen geplant, aber keine konkreten Säulen vorgeschlagen.</p>' : ""}
  </div>
  <div class="card flat"><label style="display:flex;gap:10px;align-items:center;cursor:pointer">
    <input type="checkbox" data-scheck="nurMeineKarten" ${state.settings.nurMeineKarten ? "checked" : ""}>
    <span>Nur Karten/Abos einplanen, <b>die ich schon habe</b> (unter Tarife als „Hab ich“/„abonniert“ markiert)</span>
  </label></div>`;
  for (const trip of state.trips) {
    const ana = tripAnalyse(trip);
    const cl = tripCheckliste(trip, ana);
    const maxK = Math.max(...ana.kandidaten.map(k => k.kosten));
    html += `<div class="card" data-trip="${trip.id}">
      <h2>🧭 ${esc(trip.ziel)}</h2>
      <div class="frow">
        <div><label class="f">Entfernung einfach (km)</label><input type="number" min="0" data-trfeld="hinKm" value="${trip.hinKm}"></div>
        <div><label class="f">Abfahrtsdatum</label><input type="date" data-trfeld="datum" value="${esc(trip.datum || "")}"></div>
        <div><label class="f">Tage vor Ort</label><input type="number" min="0" data-trfeld="tageVorOrt" value="${trip.tageVorOrt}"></div>
        <div><label class="f">km vor Ort</label><input type="number" min="0" step="25" data-trfeld="kmVorOrt" value="${trip.kmVorOrt}"></div>
        <div><label class="f">Laden am Ziel</label><select data-trfeld="zielLaden">
          <option value="schuko" ${trip.zielLaden === "schuko" ? "selected" : ""}>Steckdose/NRGkick</option>
          ${NETZE.filter(n => n.id !== "schuko").map(n => `<option value="${n.id}" ${trip.zielLaden === n.id ? "selected" : ""}>${esc(n.kurz)}</option>`).join("")}
          <option value="" ${!trip.zielLaden ? "selected" : ""}>Kein Laden am Ziel</option></select></div>
        <div><label class="f">Winter?</label><select data-trfeld="winter"><option value="" ${!trip.winter ? "selected" : ""}>Nein</option><option value="1" ${trip.winter ? "selected" : ""}>Ja (+${state.fahrzeug.winterZuschlag} %)</option></select></div>
      </div>
      ${trip.routeNotiz ? `<p class="small" style="margin-top:8px">🗺 ${esc(trip.routeNotiz)}</p>` : ""}

      <hr class="divider">
      <div class="hero">
        <div class="stat"><div class="v num">${ana.stopsProRichtung}<span class="unit"> Stopps</span></div><div class="l">pro Richtung (à ~${n0(ladezeitMin(10, 80))} min, gesamt ~${n0(ana.stopsProRichtung * ladezeitMin(10, 80))} min Ladezeit)</div></div>
        <div class="stat"><div class="v num">${n0(ana.dcUnterwegs)}<span class="unit"> kWh</span></div><div class="l">Schnellladen unterwegs (hin+zurück)</div></div>
        <div class="stat"><div class="v num">${eur(ana.gesamt, 0)}</div><div class="l">Stromkosten gesamt (${n0(ana.gesamtKm)} km)</div></div>
      </div>
      <p class="small">Rechnung: ${n1(ana.vAB)} kWh/100 km bei ~130 km/h${trip.winter ? " (Winter)" : ""}${state.settings.beladen ? " · beladen" : ""} · volle Ladung reicht ${n0(ana.kmVoll)} km, Folge-Etappen (80→${state.settings.ankunftSoc} %) ${n0(ana.kmHub)} km · vor Ort ${n0(ana.kWhVorOrt)} kWh über ${esc(ana.vorOrtName)} (${ct(ana.vorOrtPreis)}).</p>

      ${trip.stopps && trip.stopps.length ? `
      <h3 style="margin-top:14px">⚡ Ladestopp-Plan (Hinfahrt)</h3>
      <p class="small">${trip.fahrzeitMin ? `Reine Fahrzeit ~${Math.floor(trip.fahrzeitMin / 60)} h ${Math.round(trip.fahrzeitMin % 60)} min + ~${n0(trip.stopps.reduce((s, x) => s + (x.ladeMin || 0), 0))} min Laden. ` : ""}Ankunft am Ziel mit ca. ${trip.ankunftFinal != null ? trip.ankunftFinal : "–"} % Akku. Jeden Stopp im Auto-Navi als Ziel setzen (→ Vorkonditionierung!): einfach <b>Teilen → Hello smart</b>.</p>
      ${trip.stopps.map((st, i) => stoppCard(st, i, trip.id)).join("")}
      <p class="small muted">Rückfahrt: gleiche Logik in Gegenrichtung — vor Abfahrt am Ziel wieder vollladen. Positionen sind Planwerte; unterwegs zeigt dir der Fahrmodus jederzeit Alternativen.</p>` : ""}

      <h3 style="margin-top:14px">Lade-Strategien unterwegs im Vergleich</h3>
      <div class="hbars">
        ${ana.kandidaten.map((k, i) => `<div class="hbar ${i === 0 ? "best" : ""}">
          <div class="top"><span>${esc(k.label)}${k.unsicher ? " ⚠" : ""}${i === 0 ? " — Empfehlung" : ""}</span><span class="val">${eur(k.kosten, 0)}</span></div>
          <div class="track"><div class="fill" style="width:${Math.max(3, k.kosten / maxK * 100)}%"></div></div>
        </div>`).join("")}
      </div>
      ${ana.tipp ? `<p class="small" style="color:var(--warn)">💡 Ohne den „Nur meine Karten“-Filter wäre günstiger: <b>${esc(ana.tipp.label)}</b> (${eur(ana.tipp.kosten, 0)}) — die Karte/das Abo fehlt dir noch.</p>` : ""}
      ${ana.best ? `<div class="calcbox">
        <div class="line"><span><b>Empfehlung: ${esc(ana.best.label)}</b></span><span></span></div>
        ${ana.best.grund ? `<div class="line"><span>Grundgebühr (1 Monat, danach kündigen!)</span><span>${eur(ana.best.grund)}</span></div>` : ""}
        <div class="line"><span>${n0(ana.best.kwhCov)} kWh × ${ct(ana.best.preis)}</span><span>${eur(ana.best.preis * ana.best.kwhCov)}</span></div>
        ${ana.best.kwhRest > 0.5 ? `<div class="line"><span>+ ${n0(ana.best.kwhRest)} kWh × ${ct(ana.best.lueckePreis)} (Streckenteil ohne dieses Netz)</span><span>${eur(ana.best.lueckePreis * ana.best.kwhRest)}</span></div>` : ""}
        <div class="line total"><span>Unterwegs gesamt</span><span>${eur(ana.best.kosten)}</span></div>
        ${ana.bestOhneAbo && ana.best.abo ? `<div class="line"><span>Ersparnis ggü. bester 0-€-Option (${esc(ana.bestOhneAbo.label)})</span><span>${eur(ana.bestOhneAbo.kosten - ana.best.kosten)}</span></div>` : ""}
        <div class="line"><span>+ Vollladen vor Abfahrt (~${n0(ana.kWhAbfahrt)} kWh ${esc(ana.heimBest ? ana.heimBest.name : "")})</span><span>${eur(ana.kostenAbfahrt)}</span></div>
        <div class="line"><span>+ Laden vor Ort</span><span>${eur(ana.kostenVorOrt)}</span></div>
        <div class="line total"><span>Trip gesamt (Strom)</span><span>${eur(ana.gesamt)}</span></div>
      </div>` : ""}
      <p class="small">Zum Vergleich: Ein Benziner (8 l/100 km, 1,80 €/l) hätte für ${n0(ana.gesamtKm)} km ≈ ${eur(ana.gesamtKm * 0.08 * 1.8, 0)} gekostet.</p>

      <h3 style="margin-top:14px">Länder auf der Route</h3>
      ${trip.laender.map(l => { const L = LAENDER[l]; if (!L) return ""; return `<div class="card flat" style="margin-top:8px">
        <b>${esc(L.name)}</b>
        <p class="small">⚡ ${esc(L.laden)}</p>
        <p class="small">🅱 Plan B: ${esc(L.planB)}</p>
        ${L.extras.map(x => `<p class="small">❗ ${esc(x)}</p>`).join("")}
      </div>`; }).join("")}

      <h3 style="margin-top:14px">✅ Vorbereitungs-Checkliste</h3>
      ${cl.map((item, i) => { const key = trip.id + "-" + i; const done = !!state.checks[key]; return `<div class="check ${done ? "done" : ""}">
        <input type="checkbox" id="ck-${key}" data-check="${key}" ${done ? "checked" : ""}>
        <label for="ck-${key}"><span class="when">${esc(item.when)}</span><br><span class="txt">${esc(item.text)}</span></label>
      </div>`; }).join("")}
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
  <p class="small">Große Knöpfe, schnelle Antworten. <b>Nur vom Beifahrer oder im Stand bedienen.</b></p>

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
    <p class="small" style="margin-top:8px">Plane Ladestopps innerhalb der <b>sicheren</b> km. ${fa.modus === "restkm" ? "Die Anzeige-km rechnet der Bordcomputer mit Misch-Verbrauch — bei Autobahn-Tempo kommst du real weniger weit; genau das korrigiert diese Rechnung." : ""}</p>
  </div>

  <div class="card"><h2>📍 Nächste Ladesäulen finden</h2>
    ${!(state.settings.ocmKey || "").trim() ? `<div class="card flat alert info"><p class="small"><b>Einmalig einrichten (2 Minuten, kostenlos):</b> Auf <a href="https://openchargemap.org" target="_blank" rel="noopener">openchargemap.org</a> registrieren → Profil → „my apps“ → „Register an Application“ → den API-Key hier eintragen. Damit bekommt die App weltweite Live-Säulendaten (Stationen kommen und gehen — die Quelle ist immer aktuell).</p>
    <label class="f">OpenChargeMap API-Key</label><input type="text" data-sfeldtext="ocmKey" value="${esc(state.settings.ocmKey)}" placeholder="z. B. 123abc..."></div>` : ""}
    <div class="btnrow">
      <button class="btn primary" data-action="suche-standort">📍 Um mich herum</button>
    </div>
    <div class="frow" style="margin-top:8px; align-items:flex-end">
      <div style="flex:3 1 200px"><label class="f">…oder Ort/Adresse</label><input type="text" id="suchadresse" placeholder="z. B. Villach" value=""></div>
      <div style="flex:1 1 90px"><button class="btn" data-action="suche-adresse" style="width:100%">Suchen</button></div>
    </div>
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
    <div class="tarif head"><b>${esc(st.name)}</b><span class="preis-haupt num">${st.kw ? n0(st.kw) + " kW" : ""}</span></div>
    <div class="meta">${st.op ? `<span class="pill">${esc(st.op)}</span>` : ""}${st.anz ? `<span class="pill">${st.anz} Punkte</span>` : ""}${distKm != null ? `<span class="pill">≈ ${n0(distKm * STRASSEN_FAKTOR)} km Straße</span>` : ""}${reach}</div>
    <p class="small">${esc(st.adresse || "")}${b ? ` — deine beste Karte hier: <b>${esc(b.name)}</b> (${ct(b.preis)})` : ` — <b>keine deiner Karten passt hier</b>: nur per Betreiber-App (z. B. Tesla-/Kaufland-App) oder Preis vor Ort prüfen`}</p>
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
  if (!mitDist.length) return '<p class="small">Keine Säulen im Umkreis von 30 km gefunden.</p>';
  return `<p class="small" style="margin-top:10px">Ergebnis vom ${new Date(suche.zeit).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} (bleibt offline gespeichert):</p>` +
    mitDist.slice(0, 15).map(x => stationCard(x.st, x.d, fr)).join("") +
    `<p class="small">💡 Spot-Preischeck aller Kartenkombis an einer fremden Säule: <a href="https://www.chargeprice.app" target="_blank" rel="noopener">chargeprice.app</a> oder die App <b>Ladefuchs</b>.</p>`;
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

// Kompakte Stopp-Karte im Trip (Ladestopp-Plan)
function stoppCard(st, i, tripId) {
  const netz = st.op ? opZuNetz(st.op) : null;
  const meineIds = state.tarife.filter(besitzt).map(t => t.id);
  const b = netz ? besterPreis(netz, "dc", meineIds) : null;
  const ocmMap = `https://map.openchargemap.io/?latitude=${st.lat}&longitude=${st.lng}&zoom=12`;
  return `<div class="card flat station">
    <div class="tarif head"><b>${i + 1}. ${esc(st.name)}</b><span class="preis-haupt num">km ${n0(st.posKm)}</span></div>
    <div class="meta">
      <span class="pill acc">Ankunft ~${st.ankunftSoc} %</span>
      <span class="pill good">laden auf ${st.zielSoc} % (~${st.ladeMin} min, ${st.kwh} kWh)</span>
      ${st.kw ? `<span class="pill">${n0(st.kw)} kW</span>` : ""}
      ${st.op ? `<span class="pill">${esc(st.op)}</span>` : ""}
    </div>
    <p class="small">${st.platzhalter ? `Geplante Position — konkrete Säule hier aussuchen: <a href="${ocmMap}" target="_blank" rel="noopener">OpenChargeMap-Karte</a>` : esc(st.adresse || "")}${b ? ` — beste Karte: <b>${esc(b.name)}</b> (${ct(b.preis)})` : ""}</p>
    <div class="btnrow">
      <a class="btn small primary" href="${mapsUrl(st)}" target="_blank" rel="noopener">🗺 Google Maps</a>
      <button class="btn small" data-action="station-teilen" data-id="${esc(tripId + "-" + st.id)}">📤 Teilen (→ Hello smart)</button>
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
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const act = btn.dataset.action, id = btn.dataset.id;
  if (act === "intro-weg") { state.settings.introWeg = true; }
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
  if (act === "station-teilen") { const st = findeStation(id); if (st) stationTeilen(st); return; }
  if (act === "station-fav") {
    const st = findeStation(id);
    if (st) {
      const i = state.favoriten.findIndex(x => x.id === st.id);
      if (i >= 0) state.favoriten.splice(i, 1); else state.favoriten.push(st);
    }
  }
  if (act === "update-anwenden") { applyTarifUpdate(); return; }
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
      ort[t.dataset.ofeld] = v;
      save(); render();
    }
  }
  // Trips
  if (t.dataset.trfeld) {
    const card = t.closest("[data-trip]");
    const trip = state.trips.find(x => x.id === card.dataset.trip);
    if (trip) {
      let v = t.value;
      const f = t.dataset.trfeld;
      if (["hinKm", "tageVorOrt", "kmVorOrt"].includes(f)) v = Math.max(0, +v || 0);
      if (f === "winter") v = !!v;
      trip[f] = v;
      save(); render();
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
  if (t.dataset.sfeld) { state.settings[t.dataset.sfeld] = Math.max(0, +t.value || 0); save(); render(); }
  if (t.dataset.sfeldtext) { state.settings[t.dataset.sfeldtext] = t.value.trim(); save(); render(); }
  if (t.dataset.scheck) { state.settings[t.dataset.scheck] = t.checked; save(); render(); }
  if (t.dataset.scheckSel) { state.settings[t.dataset.scheckSel] = !!t.value; save(); render(); }
  if (t.dataset.ffeld) { state.fahrzeug[t.dataset.ffeld] = Math.max(0, +t.value || 0); save(); render(); }
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

/* ---------- Start ---------- */
loadState();
initTheme();
render();
checkTarifUpdate();
