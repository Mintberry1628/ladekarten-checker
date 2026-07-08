#!/bin/sh
# Baut aus src/ die zwei Auslieferungen:
#  - index.html      : eigenständige Datei (Windows-Doppelklick, Home Assistant /config/www)
#  - app-artifact.html : Variante ohne doctype/head/body für das Artifact-Hosting
set -e
cd "$(dirname "$0")"
{
  cat src/head-index.html
  echo '<style>'
  cat src/styles.css
  echo '</style>'
  echo '</head>'
  echo '<body>'
  cat src/body.html
  echo '<script>'
  cat src/data.js
  # Lokaler OpenChargeMap-Key (nicht im öffentlichen Repo, siehe .gitignore)
  [ -f src/ocm-key.local.js ] && cat src/ocm-key.local.js
  cat src/app.js
  echo '</script>'
  echo '</body>'
  echo '</html>'
} > index.html
{
  echo '<title>Ladekarten-Checker</title>'
  echo '<style>'
  cat src/styles.css
  echo '</style>'
  cat src/body.html
  echo '<script>'
  cat src/data.js
  # Kein OCM-Key im Artifact: dort sind externe Abfragen eh gesperrt,
  # und der Key soll nicht auf claude.ai liegen
  cat src/app.js
  echo '</script>'
} > app-artifact.html
node gen-tarife.js
echo "OK: $(wc -c < index.html) Bytes index.html, $(wc -c < app-artifact.html) Bytes app-artifact.html"
