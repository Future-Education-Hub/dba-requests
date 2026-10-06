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
| Claude API | ein Satz je Arbeitsschritt in Alltagssprache, einmal je Inhalt (Cache `docs/data/texte.json`) |

Ein Vorhaben erscheint nur, wenn seine `PLAN.md` im Status-Block eine Zeile trägt:

```markdown
- **DBA-Ticket:** dba-requests#13
```

Mehrere Nummern sind erlaubt. Soll ein Arbeitsschritt einen handgeschriebenen Satz bekommen,
steht in seinem Abschnitt eine Zeile `*Für die DBA: …*`; sie gewinnt vor dem erzeugten Satz.

## Ablauf

`.github/workflows/fortschritt.yml` läuft täglich (und per Hand über „Run workflow“), liest das
LMS-Repo, schreibt `docs/data/snapshots/<Datum>.json` und `docs/data/index.json` und committet.
GitHub Pages liefert den Ordner `docs/` aus.

Secrets (Repository-Secrets dieses Repos):

- `LMS_READ_TOKEN` – fine-grained PAT, nur `feh-lms`: Contents *Read*, Metadata *Read*,
  Pull requests *Read*; Organisation: Projects *Read*.
- `ANTHROPIC_API_KEY` – für die Laiensätze. Fehlt er, bleibt der Satz leer, die Seite läuft trotzdem.

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
lässt die Satz-Erzeugung aus, `--date YYYY-MM-DD` schreibt einen Snapshot unter anderem Datum.
