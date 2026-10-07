# DBA-Anforderungen und Fortschrittsseite

Dieses Repo enthält die **Anforderungen der DBA an das LMS** (Issues) und die daraus erzeugte
**Fortschrittsseite** für Mitarbeitende ohne Technik-Hintergrund:

**https://future-education-hub.github.io/dba-requests/**

Die Seite zeigt je Ticket, in welchem Zustand es ist (Idee, geplant, in Arbeit, wird geprüft,
live) und bei laufenden Vorhaben die einzelnen Arbeitsschritte mit Datum. Vergangene Stände
lassen sich über die Datumsauswahl ansehen.

## Woher die Daten kommen

| Quelle | Was |
|---|---|
| Issues dieses Repos | Titel, offen/geschlossen |
| Task-Board „DBA only“ | Spalte (Backlog, Next Up, In progress, …) |
| `docs/features/<slug>/PLAN.md` im LMS-Repo (alle Branches) | Arbeitsschritte, Checklisten, Zeitpunkte aus der Git-Historie |
| Pull Requests und Releases des LMS-Repos | „wird geprüft“ bzw. „live seit“ |
| Pull Requests und Releases des LMS-Repos | „wird geprüft“ bzw. „live seit“; Bereich „Zuletzt fertig geworden“ aus den gemergten PRs der letzten 6 Wochen mit Ticket-Bezug |
| Claude API | Zuordnung Vorhaben → Ticket; ein Satz je Arbeitsschritt und je PR in Alltagssprache, einmal je Inhalt (Cache in `docs/data/`) |

**Das LMS-Repo weiß nichts von dieser Seite.** Es gibt dort keine Markierung, kein Label, keine
Konvention. Die Zuordnung eines Vorhabens (`PLAN.md`) zu einem DBA-Ticket trifft die Claude API aus
Ticket-Text und Plan-Inhalt; sie wird je Eingabestand gecacht (`docs/data/zuordnung.json`) und läuft
erst wieder, wenn ein Ticket oder Plan dazukommt oder sich ändert. Korrekturen stehen hier im Repo in
`config/zuordnung.json`:

```json
{ "pin": { "batch-mode": [13] }, "ausblenden": ["interner-plan"] }
```

`pin` erzwingt eine Zuordnung, `ausblenden` hält einen Plan dauerhaft von der Seite fern.

Zuordnungen sind **klebrig**: Ein Paar wird ab Sicherheit 0,6 akzeptiert und bleibt dann bestehen,
auch wenn ein späterer Lauf es knapp darunter bewertet. Gelöst wird es erst, wenn die API es klar
widerlegt (unter 0,4), Plan oder Ticket verschwinden, oder `ausblenden` greift. So springt kein
Ticket zwischen „Live“ und „Idee“ hin und her, nur weil ein neues Vorhaben die Neubewertung
auslöst. Begründungen und Sicherheiten stehen in `docs/data/zuordnung.json` (`pairs`).

Im Bereich „Zuletzt fertig geworden“ erscheinen nur gemergte Pull Requests nach `main`, die die
Claude API einem DBA-Ticket zuordnet (oder deren Branch zu einem zugeordneten Vorhaben gehört).
`chore`/`ci`/`docs`/`test`/`refactor`/`build`/`perf` werden vorab ausgefiltert. Cache:
`docs/data/zuordnung-prs.json`, je PR eine Entscheidung; nur neue PRs werden angefragt.

## Ablauf

`.github/workflows/fortschritt.yml` läuft täglich (und per Hand über „Run workflow“), liest das
LMS-Repo, schreibt `docs/data/snapshots/<Datum>.json` und `docs/data/index.json` und committet.
GitHub Pages liefert den Ordner `docs/` aus.

Secrets (Repository-Secrets dieses Repos):

- `LMS_READ_TOKEN` – fine-grained PAT, nur `feh-lms`: Contents *Read*, Metadata *Read*,
  Pull requests *Read*; Organisation: Projects *Read*.
- `ANTHROPIC_API_KEY` – für die Laiensätze. Fehlt er, bleibt der Satz leer, die Seite läuft trotzdem.
- `ANTHROPIC_WORKSPACE_ID` – nur nötig, wenn der Key nicht an einen Workspace gebunden ist
  (Fehler „not scoped to a workspace“); Wert `wrkspc_…` aus der Anthropic Console → Settings → Workspaces.

Die Action-Logs sind öffentlich. Der Generator schreibt deshalb nur Zähler und Fehlerarten ins
Log, nie Inhalte aus dem LMS-Repo.

## Lokal

```bash
npm ci
export GITHUB_TOKEN=$(gh auth token)
node --env-file=.env scripts/build.mjs --lms ../feh-lms --worktree   # .env mit ANTHROPIC_API_KEY
npm run serve                                                        # http://localhost:8787/
```

`--worktree` nimmt zusätzlich die ungepushte Arbeitskopie des LMS-Checkouts mit, `--no-llm`
lässt Zuordnung und Satz-Erzeugung aus (dann gelten Cache und Konfiguration), `--date YYYY-MM-DD`
schreibt einen Snapshot unter anderem Datum.
