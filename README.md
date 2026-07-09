# ⚡ Ladekarten-Checker

Dein persönliches Lade-Cockpit für den **smart #5 Brabus**: welche Ladekarten du brauchst,
welche Abos sich ab wie viel kWh lohnen (Break-even mit Rechenbeispiel), **echter
Routen-Planer** (Start/Ziel → Straßenroute via OSRM, Länder-Erkennung, Ladestopps mit
SoC-Prognose und Ankunfts-Reserve, Standard 20 %, konservativ/beladen gerechnet),
Vorbereitungs-Checklisten, Reichweiten-Cockpit, Säulen-Finder mit Live-Daten (OpenChargeMap)
und Fahrmodus mit großen Knöpfen. Jeder Ladestopp lässt sich per **Teilen → Hello smart**
ans Auto-Navi schicken (das Auto vorkonditioniert dann den Akku für den Schnelllader).

**Alles in einer einzigen Datei** ([index.html](index.html), ~110 KB) — kein Server-Backend,
keine Datenbank. Deine Daten bleiben lokal im Browser (localStorage).

## Nutzung auf deinen Geräten

| Gerät | So geht's |
|---|---|
| **Überall (Fallback)** | Gehosteter privater Link: https://claude.ai/code/artifact/c6aa822a-4416-41e0-aa8f-4e1618ea3e44 — Achtung: dort sind externe Abfragen (Säulen-Suche/Ortung) aus Sicherheitsgründen gesperrt; Rechner & Planer funktionieren voll |
| **Windows-PC** | `index.html` doppelklicken — fertig |
| **Android** | Seite in Chrome öffnen → Menü ⋮ → „Zum Startbildschirm hinzufügen“ |
| **iPhone (optional)** | Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“ |
| **Raspberry Pi 5 (Home Assistant), empfohlen** | `index.html`, `sw.js` und `manifest.json` nach `/config/www/ladekarten/` kopieren (per *File editor*- oder *Samba*-Add-on). Lokal: `http://homeassistant.local:8123/local/ladekarten/index.html` — von unterwegs: **https://mintberry.org/local/ladekarten/index.html**. Über HTTPS funktionieren auch **Standort-Ortung**, **Teilen** (→ Hello smart / Google Maps) und der **Offline-Modus** (App startet ohne Netz — wichtig für Bosnien). |

**Daten zwischen Geräten übertragen:** Start → „Daten exportieren“ → auf dem anderen Gerät importieren.

## Säulen-Finder einrichten (einmalig, kostenlos)

Für Live-Ladesäulen-Daten (Stationen kommen und gehen — die Quelle ist immer aktuell):
auf [openchargemap.org](https://openchargemap.org) registrieren → Profil → *my apps* →
*Register an Application* → API-Key in der App unter **Fahren → Nächste Ladesäulen** eintragen.

## Aktuell bleiben — das ehrliche Konzept

1. **Stationen** (kommen/gehen): live via OpenChargeMap bei jeder Suche.
2. **Spot-Preise aller Kartenkombis an einer fremden Säule**: verlinkt auf
   [chargeprice.app](https://www.chargeprice.app) / App „Ladefuchs“ (deren Live-Daten sind
   lizenzpflichtig und nicht einbettbar).
3. **Tarife/Preise/Anbieter** (Datenbasis dieser App): **vollautomatisch in der Cloud**
   — GitHub Actions + Gemini recherchieren am 2. jeden Monats die Preise, validieren
   sie streng und schreiben die neue `tarife.json`; die App holt sich beim Start den
   neuesten Stand aller Quellen (eigener Server, eingestellte URL, GitHub). Kein PC,
   keine Claude-Instanz, nichts zu kopieren. Einmalige Einrichtung (~10 min):
   **[automation/README-AUTOMATION.md](automation/README-AUTOMATION.md)**.
   Zusatznetz: lokaler Claude-Task (monatlich, falls App offen) aktualisiert auch die
   App selbst + Artifact; die App warnt außerdem, wenn der Preisstand > 60 Tage alt ist.
   Eigene Preis-Änderungen werden nie überschrieben.

## Projektstruktur

```
src/styles.css      Design (Dunkel/Hell, Mobile-first)
src/data.js         Tarif-Datenbank (Preisstand 07/2026), Netze, Ladekurve, Länder-Infos, Wissen
src/app.js          Rechen-Engines (Monat, Break-even, Trip, Reichweite, Ladezeit) + UI
src/body.html       App-Gerüst
src/head-index.html HTML-Kopf für die eigenständige Datei
build.sh            baut index.html + app-artifact.html + tarife.json aus src/
gen-tarife.js       erzeugt tarife.json (wird von build.sh aufgerufen)
server.js           Mini-Server nur für die lokale Vorschau (nicht nötig für Betrieb)
```

## Preismodell-Hinweise

- **Geschlossene Systeme:** Tesla Supercharger, Lidl/Kaufland und Ionity akzeptieren keine
  fremden Roaming-Karten — die App rechnet dort nur Tarife mit explizit hinterlegtem Preis.
- Preisstand **7. Juli 2026** (Maingau-Staffelung, SWM-Reform, Ionity-Erhöhung zum 1.7.,
  Aral-Senkung, EnBW-Sommeraktion Juli–Sept.). Alle Angaben ohne Gewähr — es gilt der Preis
  in der Anbieter-App/an der Säule.
