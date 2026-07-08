# 🤖 Vollautomatisches Tarif-Update (Cloud, ohne PC)

Ziel: Am 2. jeden Monats recherchiert **GitHub Actions** (kostenloser Cloud-Dienst)
mit **Gemini + Google-Suche** die aktuellen Ladetarife, prüft sie streng auf
Plausibilität und schreibt die neue `tarife.json` ins Repository. Deine App
(auf mintberry.org, PC, Handy) holt sich den neuen Stand **von selbst** —
kein PC, keine laufende Claude-Instanz, nichts zu kopieren.

## Einmalige Einrichtung (~10 Minuten, danach nie wieder)

Diese 3 Schritte kann nur der Konto-Inhaber machen (Logins/Schlüssel):

### 1. GitHub-Repository anlegen und hochladen
- Kostenloses Konto auf https://github.com (falls noch keins).
- Neues Repository anlegen: Name `ladekarten-checker`, **Public**
  (nötig, damit die App die tarife.json ohne Anmeldung lesen kann;
  der OpenChargeMap-Key liegt NICHT im Repo — siehe .gitignore).
- Dann im Projektordner (Git Bash oder Terminal in Claude):
  ```
  git remote add origin https://github.com/DEIN-NUTZERNAME/ladekarten-checker.git
  git push -u origin main
  ```
  (Der lokale Commit existiert schon — Claude hat alles vorbereitet.)

### 2. Gemini-API-Key holen (kostenlos)
- https://aistudio.google.com öffnen → mit Google-Konto anmelden →
  „Get API key“ → „Create API key“ → Key kopieren.
- Kostenlos: Das Gratis-Kontingent von `gemini-2.5-flash` inkl. Google-Suche
  reicht für diesen einen Lauf pro Monat um ein Vielfaches.

### 3. Key als Secret hinterlegen
- Im GitHub-Repo: **Settings → Secrets and variables → Actions →
  New repository secret** → Name: `GEMINI_API_KEY`, Wert: der Key.

### Danach einmal testen
- Repo → **Actions** → „Tarif-Update (monatlich, automatisch)“ →
  **Run workflow**. Nach ~2 Minuten sollte ein grüner Haken stehen und
  ein Commit „Automatisches Tarif-Update …“ erscheinen.

### App auf die neue Quelle zeigen lassen
- In der App: **Start → Update-Quelle für Tarifdaten** →
  `https://raw.githubusercontent.com/DEIN-NUTZERNAME/ladekarten-checker/main/tarife.json`
- Oder Claude sagen: „Trag meine GitHub-URL als Update-Quelle ein“ —
  dann wird sie fest in `src/data.js` (UPDATE_QUELLEN) eingebaut.

## Wie es funktioniert

- `automation/update-tarife.mjs` schickt die aktuelle Datenbank an
  `gemini-2.5-flash` (Google-Suche aktiviert) und verlangt die
  vollständige, belegte Aktualisierung als JSON.
- **Sicherheitsnetz:** Schema-Prüfung, Preisspannen (0,05–1,50 €/kWh),
  Grundgebühr 0–30 €, Kern-Tarife müssen vorhanden sein, Preissprünge
  über 0,30 €/kWh lassen den Lauf absichtlich fehlschlagen.
- Schlägt etwas fehl, bleibt die alte tarife.json unangetastet und
  **GitHub schickt dir automatisch eine E-Mail** — du musst nichts überwachen.
- Der monatliche Commit hält den Zeitplan aktiv (GitHub pausiert
  Zeitpläne sonst nach 60 Tagen ohne Aktivität).

## Kosten

| Posten | Kosten |
|---|---|
| GitHub Actions (öffentliches Repo) | 0 € |
| Gemini `gemini-2.5-flash` inkl. Google-Suche, 1 Lauf/Monat | 0 € (Gratis-Kontingent) |
| Worst Case, falls Google das Gratis-Kontingent streicht | wenige Cent pro Lauf, unter ~1 €/Jahr |
