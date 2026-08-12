# NQ Pause-Board

Ein Dashboard, das dir als **NQ-Futures Mean-Reversion-Trader** anzeigt, wann du
deine automatisierten Trading-Bots wegen Marktrisiko (News, Geopolitik,
Wirtschaftsdaten) besser pausieren solltest.

Statisches Frontend + GitHub Action als Backend, gehostet auf GitHub Pages.
Sprache der Oberfläche: Deutsch, Zeitzone Europe/Zurich.

> ⚠️ **Keine Anlageberatung.** Persönliches Hilfsmittel. Einschätzungen können
> falsch oder veraltet sein — Handelsentscheidungen triffst du eigenverantwortlich.

---

## Architektur

Bewusst **kein Live-API-Call im Browser** (wäre langsam/unzuverlässig). Stattdessen:

```
GitHub Action (Zeitplan-Cron + manuell)
   → scripts/fetch-assessment.mjs
        → Anthropic Messages API (Tool: web_search)
        → strikte Schema-/Zeitkonsistenz-Prüfung (Fehler werden erneut versucht)
        → Termin-Cross-Check (nur exakte, validierte Termine erzwingen ROT)
        → schreibt data/status.json, data/signal.json, data/history.json atomar
        → Push bei Eskalation nach ROT (ntfy / Telegram)
        → committet die Dateien zurück ins Repo
        → fordert Pages-Build explizit an und verifiziert dessen Commit-SHA
GitHub Pages (statisch)
   → index.html liest kohärent status.json + signal.json + history.json (same-origin)
Trading-Bots
   → pollen data/signal.json direkt (maschinenlesbares Pause-Flag)
```

Der Anthropic API-Key liegt als **GitHub Actions Secret** (`ANTHROPIC_API_KEY`),
nie im Code. Das Modell liefert kompakte Codes (24-Zeichen `G`/`Y`/`R` + 6
Kommentare + Quellen + Confidence); die **Uhrzeiten** berechnet das Skript
deterministisch (Europe/Zurich) und mappt sie per Index auf die Codes.
Codes werden nach optionalem äußeren Whitespace strikt gegen `^[GYR]{24}$`
validiert; fehlende oder korrupte Werte werden weder bereinigt noch mit GRÜN
aufgefüllt. Auch Status, Texte, Quellen, Termine und Kommentaranzahl werden vor
jedem Schreibvorgang validiert.

### Zeitplan

An die NQ-Handelswoche angepasst (nicht 24/7 — spart Kosten):

| Tag | Läufe (CEST) |
|-----|--------------|
| Sonntag | 22:00 (Wochenstart) |
| Mo–Do | 02 · 06 · 10 · 14 · 18 · 22 (alle 4 h) |
| Freitag | 02 · 06 · 10 · 14 · 18 (Stopp) |
| Samstag | — aus |

~30 Läufe/Woche. GitHub-Cron läuft in UTC (`CEST = UTC+2`); im Winter (CET)
verschieben sich die lokalen Zeiten um 1 h — Kommentar dazu im Workflow.
Manuelles Auslösen (**Actions → Run workflow**) geht jederzeit zusätzlich.

---

## Funktionen

### Tages-Ampel & Stunden-Ampel
`dayStatus`/`status` bleibt das breitere Tagesbild. `currentHourStatus` ist dagegen
der tatsächlich aktuelle Forecast-Slot nach den deterministischen, validierten
Event-Overrides und steuert die primäre Jetzt-Anzeige sowie das Bot-Signal.
Der horizontal scrollbare 48-Punkte-Zeitstrahl (24 h zurück · „Jetzt" · 24 h
voraus) wird während einer offenen Browser-Sitzung mit der echten Zeit nachgeführt.

### Termin-Cross-Check (mit Vorlauf) + Live-Kalender
High-Impact-Events **erzwingen ROT** — nicht erst zur Event-Uhrzeit, sondern
schon **~2 Stunden davor** (das Risiko baut sich vorher auf). Das Fenster ist
über `EVENT_PRE_HOURS` einstellbar (Default 2). Liegt ein Event in der aktuellen
oder einer der nächsten `EVENT_PRE_HOURS` Stunden, wird auch die Tages-Ampel auf
ROT gezogen; die Empfehlung nennt den Vorlauf (z. B. „US Core PPI in ~2h").

Zwei Quellen speisen den Cross-Check:
- **Fester exakter Anker**: die gepflegte FOMC-Terminliste.
- **Live-Kalender aus der Recherche** (auto-aktualisierend): Das Modell liefert
  bei jedem Lauf den US-Wirtschaftskalender der nächsten 7 Tage als `termine`
  (CPI, **Core PPI**, Retail Sales, Jobless Claims, ISM …) mit Datum/Uhrzeit und
  Impact. Alle mit `impact: "hoch"` erzeugen automatisch ein rotes Vorlauf-Fenster
  — ohne dass du etwas pflegen musst. Das Frontend zeigt die Liste als
  „Anstehende Termine" mit „Pause-Fenster"-Markierung.

Die NFP-/CPI-/PCE-Wiederholungsmuster sind nur sichtbar als **ungefähre
UI-Hinweise**. Sie erzwingen niemals ROT und pausieren keine Bots.

### Push-Benachrichtigung
Beim **Wechsel nach ROT** (und bei Entwarnung) schickt das Skript einen Push —
per **ntfy.sh** (ohne Account) und/oder **Telegram**. Nur bei Zustandswechsel,
kein Spam. Ohne konfigurierte Kanäle wird der Push übersprungen.

### Bot-Signal (`data/signal.json`)
Kompaktes, maschinenlesbares Flag, das deine Bots direkt pollen können:

```json
{
  "generatedAt": "2026-08-10T14:00:00.000Z",
  "effectiveStatus": "gruen",
  "pause": false,
  "caution": false,
  "dayStatus": "rot",
  "currentHourStatus": "gruen",
  "statusText": "Aktuelle Stunde ruhig",
  "empfehlung": "…",
  "source": "nq-pause-board"
}
```

`effectiveStatus` ist immer identisch mit dem bei der Generierung geltenden
`currentHourStatus`; `pause` ist nur bei ROT wahr, `caution` nur bei GELB.
Bot-Logik z. B.: `if (signal.pause) botsAnhalten()`. Wird bei jedem Lauf
aktualisiert (alle ~4 h); für stündliche Details siehe `status.json`.

### Verlauf & Quellen
`data/history.json` protokolliert die Gesamt-Ampel jedes Laufs. Das Frontend
zeigt einen Verlaufs-Streifen und **„Zeit seit letztem ROT"**. Zusätzlich liefert
das Modell 2–4 **Quell-Links** und ein **Confidence-Level** zur Nachprüfung.

### Stale-/Wochenend-Warnung
Ist die letzte Einschätzung im Handelsfenster älter als ~6 h, warnt das Frontend
(„Daten veraltet"). Am Wochenende zeigt es stattdessen einen ruhigen Hinweis
(„Markt geschlossen"). Unabhängig vom angezeigten Cron-Ziel prüft eine offene
Seite etwa minütlich mit Cache-Buster und `cache: "no-store"` auf eine neue
Generation. Status- und Bot-Datei werden beim Start auf identisches
`generatedAt` und die Bot-Invarianten geprüft; bei dauerhafter Inkonsistenz wird
kein vermeintlich verlässliches Pause-Flag angezeigt.

### Gerätezeit & Versionierung
Jede Stunde im Ampel-System trägt einen absoluten Zeitstempel (`ts`). Das
Frontend beschriftet daraus in **deiner Gerätezeit** (praktisch auf Reisen) und
setzt den **„Jetzt"-Marker nach der tatsächlichen aktuellen Zeit** — nicht am
Generierungs-Zeitpunkt. Termin- und Handelslogik bleibt in Europe/Zurich
verankert (nur die Anzeige ist lokal). Ein sichtbares **Versions-Badge**
(`vX.Y.Z`) im Kopf und Footer zeigt die App-Version; `appVersion` steckt auch in
`status.json`/`signal.json`, sodass du nach einem Deploy siehst, welche Version
live ist.

### `data/status.json` — Schema

```json
{
  "generatedAt": "2026-08-10T21:00:00.000Z",
  "appVersion": "1.8.0",
  "status": "gruen",
  "dayStatus": "gruen",
  "currentHourStatus": "gruen",
  "statusText": "Ruhige Lage",
  "empfehlung": "Bots normal laufen lassen",
  "headline": "Kurze Ticker-Zeile",
  "body": "2-3 Sätze Begründung",
  "confidence": "mittel",
  "quellen": [{ "titel": "Reuters", "url": "https://…" }],
  "rueckblickSummary": "2-3 Sätze",
  "rueckblick": [{ "stunde": "14:00", "ts": "2026-08-10T12:00:00.000Z", "status": "gruen" }],
  "ausblickSummary": "2-3 Sätze",
  "forecast": [{ "stunde": "22:00", "ts": "2026-08-10T20:00:00.000Z", "status": "gelb" }],
  "forecastDetail": [{ "stunde": "22:00", "ts": "…", "status": "gelb", "kommentar": "…" }],
  "termine": [{ "name": "US Core PPI", "ts": "2026-08-13T12:30:00.000Z", "impact": "hoch" }]
}
```

`stunde` ist das Zürcher Label; `ts` der absolute Zeitstempel (das Frontend
beschriftet daraus in Gerätezeit). Beim Bump von `APP_VERSION` beide Stellen
(`scripts/fetch-assessment.mjs` und `index.html`) synchron halten.

---

## Setup

### 1. Anthropic API-Key als Secret
**Settings → Secrets and variables → Actions → New repository secret**
Name `ANTHROPIC_API_KEY`, Wert dein Key. Konto braucht **Guthaben** (Billing).

Optional (Variables statt Secret): `ANTHROPIC_MODEL` (Default `claude-sonnet-4-5`),
`BOARD_URL`, `NTFY_SERVER`.

### 2. Push-Kanäle (optional)
Als **Secrets** hinterlegen — je nach gewünschtem Kanal:

- **ntfy.sh** (ohne Account): `NTFY_TOPIC` = ein frei gewähltes, geheimes Topic
  (z. B. `nq-pause-board-a7x9`). In der ntfy-App dasselbe Topic abonnieren. Fertig.
- **Telegram**: `TELEGRAM_BOT_TOKEN` (von @BotFather) und `TELEGRAM_CHAT_ID`.

Ohne diese Secrets läuft alles normal, nur ohne Push.

### 3. GitHub Pages aktivieren
**Settings → Pages** → Source `Deploy from a branch` → Branch `main`, Ordner
`/ (root)`. Danach live unter `https://<user>.github.io/<repo>/`.

### 4. Workflow-Schreibrechte
Falls der Rück-Push scheitert: **Settings → Actions → General → Workflow
permissions → Read and write permissions**.

### 5. Erste Einschätzung auslösen
**Actions → „Update NQ Pause-Board Assessment" → Run workflow**. Danach läuft es
automatisch nach obigem Zeitplan.

---

## Lokal testen

```bash
cp .env.example .env      # ANTHROPIC_API_KEY (+ optional Push) eintragen
node --env-file=.env scripts/fetch-assessment.mjs
python3 -m http.server 8080   # Frontend unter http://localhost:8080
node --test                    # Regressionstests (keine Zusatzpakete)
```

Voraussetzung: **Node 20+** (natives `fetch` und `--env-file`).

---

## Fehler-Verhalten

API-, Modell- und Validierungsfehler erhalten 3 Versuche mit Backoff (2 s, 4 s).
Bleibt es dabei, werden **alle Dateien unangetastet** gelassen, ein klarer Log
geschrieben und der Prozess endet ungleich null. Die drei JSON-Dateien werden
erst nach vollständigem Aufbau als zusammengehöriger Snapshot installiert. Ein
Commit passiert nur bei tatsächlicher Änderung; danach fordert der Workflow den
Pages-Build explizit an und schlägt fehl, wenn die publizierte Revision nicht der
gepushten SHA entspricht.

---

## Wartung: Termine

Die meisten Termine kommen jetzt **automatisch** aus der Live-Recherche
(`termine` im Modell-Output) — inkl. CPI, **Core PPI**, Retail Sales, Jobless
Claims usw. Da musst du nichts pflegen. Nur die festen Anker sind statisch:

| Termin | Berechnung | Pflege |
|--------|-----------|--------|
| **Live-Kalender** | Modell-Recherche, nächste 7 Tage | **automatisch** |
| **NFP** | UI-Näherung: 1. Freitag, 14:30 Zurich | Datum prüfen; kein ROT-Override |
| **US-CPI / PCE** | UI-Näherung (2. Mittwoch / letzter Freitag) | Datum prüfen; kein ROT-Override |
| **FOMC** | Anker: feste Terminliste, 20:00 | **manuell nachpflegen** |

> ⚠️ Die **FOMC-Terminliste** steht an **zwei** Stellen und muss synchron gehalten
> werden: `FOMC_DATES` in `scripts/fetch-assessment.mjs` und in `index.html`.
> Aktuell gepflegt bis **Dez 2026**. Alles andere aktualisiert sich über die
> Recherche selbst.

---

## Projektstruktur

```
.github/workflows/update-assessment.yml   # Zeitplan-Cron + manuelles Triggern
scripts/fetch-assessment.mjs              # Backend: API + Cross-Check + Push
data/status.json                          # volle Einschätzung (Frontend)
data/signal.json                          # Pause-Flag (Bots)
data/history.json                         # Verlauf der Gesamt-Ampel
index.html                                # statisches Frontend
.env.example · .gitignore · README.md
```
