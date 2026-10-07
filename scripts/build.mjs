#!/usr/bin/env node
/**
 * Erzeugt den Tages-Snapshot der Fortschrittsseite.
 *
 *   node scripts/build.mjs --lms <Pfad zum feh-lms-Checkout> [--date YYYY-MM-DD] [--no-llm] [--remap]
 *
 * Umgebung: GITHUB_TOKEN (Lesen: feh-lms Contents + Pull requests, Org-Projekte),
 *           ANTHROPIC_API_KEY (optional, für die Laiensätze),
 *           ANTHROPIC_WORKSPACE_ID (nur bei einem Org-weiten Key ohne Workspace-Bindung).
 *
 * Das LMS-Repo weiß nichts von dieser Seite: Die Zuordnung Vorhaben → DBA-Ticket trifft die Claude API
 * (scripts/lib/zuordnung.mjs), Korrekturen stehen in config/zuordnung.json dieses Repos.
 *
 * Das Log nennt nur Zähler und Fehlerarten, keine Inhalte aus dem privaten Repo.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit, listRemoteBranches, listPlanBlobs, readBlob, readFileAt, fileCommits, lastCommitDate, tagsContaining, commitExists } from './lib/git.mjs';
import { ordneZu, ordnePRsZu } from './lib/zuordnung.mjs';
import { parsePlan } from './lib/plan.mjs';
import { listIssues, boardStatuses, pullByNumber, pullForBranch, listReleases, listMergedPulls } from './lib/github.mjs';
import { annotatePhases, annotateMerged } from './lib/laientext.mjs';

const ORG = 'Future-Education-Hub';
const LMS_REPO = 'feh-lms';
const DBA_REPO = 'dba-requests';
const PROJECT_NUMBER = 3;
const BOARD_URL = `https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}/views/6`;
const MERGED_WINDOW_DAYS = 42;              // Zeitraum für „Zuletzt fertig geworden“
const SKIP_TITLE = /^(chore|ci|docs|test|tests|refactor|build|style|revert|perf)(\(|:|!)/i;

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const lms = args.lms || join(here, '..', 'lms');
const outDir = join(here, '..', 'docs', 'data');
const snapDir = join(outDir, 'snapshots');
mkdirSync(snapDir, { recursive: true });

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const apiKey = args.noLlm ? null : process.env.ANTHROPIC_API_KEY || null;
const log = (msg) => console.log(`[fortschritt] ${msg}`);

const today = args.date || berlinDate(new Date());
log(`Snapshot für ${today}`);

// 1. Alle Pläne auf allen Branches einsammeln (je Blob nur einmal parsen)
const branches = listRemoteBranches(lms);
const parsedBlobs = new Map();
const copies = new Map(); // slug → [{ ref, branch, path, plan }]
for (const ref of branches) {
  for (const { blob, path } of listPlanBlobs(lms, ref)) {
    const slug = path.split('/')[2];
    if (!parsedBlobs.has(blob)) {
      const md = readBlob(lms, blob);
      parsedBlobs.set(blob, md ? parsePlan(md, slug) : null);
    }
    const plan = parsedBlobs.get(blob);
    if (!plan || !plan.phases.length) continue;
    if (!copies.has(slug)) copies.set(slug, []);
    copies.get(slug).push({ ref, branch: ref.replace(/^origin\//, ''), path, plan });
  }
}
if (args.worktree) {
  // Lokaler Test: unveröffentlichte Arbeitskopie des aktuellen Branches mit einbeziehen
  const head = (tryGit(lms, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  for (const path of (tryGit(lms, ['ls-files', '--', 'docs/features/*/PLAN.md']) || '').split('\n').filter(Boolean)) {
    try {
      const slug = path.split('/')[2];
      const plan = parsePlan(readFileSync(join(lms, path), 'utf8'), slug);
      if (!plan.phases.length) continue;
      if (!copies.has(slug)) copies.set(slug, []);
      copies.get(slug).unshift({ ref: 'HEAD', branch: head, path, plan });
    } catch { /* Datei nicht lesbar */ }
  }
}
log(`${branches.length} Branches durchsucht, ${copies.size} Vorhaben mit Plan gefunden`);

// 1b. Je Vorhaben die maßgebliche Kopie wählen: Arbeitskopie (lokaler Test) → deklarierter Branch →
//     main (abgeschlossene oder alte Pläne) → sonst die Kopie mit dem jüngsten Commit am Plan-Ordner
const chosenBySlug = new Map();
for (const [slug, list] of copies) {
  const chosen = list.find((c) => c.ref === 'HEAD')
    || list.find((c) => c.plan.branch && c.branch === c.plan.branch)
    || list.find((c) => c.branch === 'main')
    || list.sort((a, b) => (lastCommitDate(lms, b.ref, `docs/features/${slug}`) || '').localeCompare(lastCommitDate(lms, a.ref, `docs/features/${slug}`) || ''))[0];
  chosen.declared = chosen.ref === 'HEAD' || (chosen.plan.branch && chosen.branch === chosen.plan.branch);
  chosenBySlug.set(slug, chosen);
}

// 1c. DBA-Tickets lesen und Vorhaben zuordnen (Claude API, Cache, Konfiguration)
const issues = await listIssues(token, ORG, DBA_REPO);
const zuordnung = await ordneZu(
  issues,
  [...chosenBySlug.values()].map((c) => c.plan),
  { cachePath: join(outDir, 'zuordnung.json'), configPath: join(here, '..', 'config', 'zuordnung.json'), apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || null, log, remap: !!args.remap },
);
for (const [slug, c] of chosenBySlug) c.plan.dbaTickets = [...(zuordnung.get(slug) || [])];

// 2. Je Vorhaben die maßgebliche Kopie wählen und anreichern
const releases = await listReleases(token, ORG, LMS_REPO);
const releaseByTag = new Map(releases.map((r) => [r.tag, r]));
log(`${releases.length} Releases gelesen`);

const features = [];
for (const [slug, chosen] of chosenBySlug) {
  const { plan, ref, path, branch, declared } = chosen;
  if (!plan.dbaTickets.length) continue;
  const folder = `docs/features/${slug}`;
  // Auf dem eigenen Branch zählt jeder Commit; auf main oder fremden Branches nur Arbeit am Plan selbst
  const lastActivity = declared ? lastCommitDate(lms, ref) : lastCommitDate(lms, ref, folder);

  // Phasen-Daten aus der Historie der PLAN.md auf diesem Branch
  const firstDone = new Map();
  const firstStarted = new Map();
  for (const { sha, date } of fileCommits(lms, ref, path)) {
    const md = readFileAt(lms, sha, path);
    if (!md) continue;
    const snapshot = parsePlan(md, slug);
    for (const p of snapshot.phases) {
      if (p.state !== 'open' && !firstStarted.has(p.n)) firstStarted.set(p.n, date.slice(0, 10));
      if (p.state === 'done' && !firstDone.has(p.n)) firstDone.set(p.n, p.markerDate || date.slice(0, 10));
    }
  }

  // Pull Request und Release
  let pull = plan.pr ? await pullByNumber(token, ORG, LMS_REPO, plan.pr) : null;
  if (!pull && declared && branch) pull = await pullForBranch(token, ORG, LMS_REPO, branch);
  let release = null;
  if (pull?.mergeSha && commitExists(lms, pull.mergeSha)) {
    const tags = new Set(tagsContaining(lms, pull.mergeSha));
    release = releases.find((r) => tags.has(r.tag)) || null;
  }
  const allDone = plan.phases.length > 0 && plan.phases.every((p) => p.state === 'done');
  if (!release && !declared && branch === 'main' && allDone) {
    // Alter Plan ohne Status-Block: live ab dem ersten Release, das den letzten Plan-Commit auf main enthält
    const sha = (tryGit(lms, ['log', '-1', '--format=%H', ref, '--', folder]) || '').trim();
    if (sha) {
      const tags = new Set(tagsContaining(lms, sha));
      release = releases.find((r) => tags.has(r.tag)) || null;
    }
  }

  const phases = plan.phases.map((p) => ({
    n: p.n,
    title: p.title,
    state: p.state,
    done: p.checked,
    total: p.total,
    startedAt: firstStarted.get(p.n) || null,
    doneAt: p.state === 'done' ? firstDone.get(p.n) || p.markerDate || null : null,
    items: p.items,
    dbaText: p.dbaText,
  }));

  features.push({
    slug,
    title: plan.title,
    stand: plan.stand,
    branch,
    dbaTickets: plan.dbaTickets,
    lastActivity,
    pull: pull ? { number: pull.number, state: pull.state, url: pull.url, mergedAt: pull.mergedAt } : null,
    release: release ? { tag: release.tag, publishedAt: release.publishedAt, url: release.url } : null,
    stage: featureStage(plan, pull, release, { declared, onMain: branch === 'main', allDone }),
    phases,
  });
}

// 3. Laiensätze
const textStats = await annotatePhases(features, { cachePath: join(outDir, 'texte.json'), apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || null, log });
log(`Laiensätze: ${textStats.created} neu erzeugt, ${textStats.skipped} ohne Satz${apiKey ? '' : ' (kein API-Key)'}`);
for (const f of features) for (const p of f.phases) { delete p.items; delete p.dbaText; }

// 3b. Zuletzt fertig geworden: gemergte Pull Requests nach main
const since = new Date(Date.now() - MERGED_WINDOW_DAYS * 86400000).toISOString();
const planBranches = new Map(features.filter((f) => f.branch).map((f) => [f.branch, f]));
const mergedRaw = (await listMergedPulls(token, ORG, LMS_REPO, since)).filter((p) => !SKIP_TITLE.test(p.title));
const zuordnungConfig = JSON.parse(readFileSync(join(here, '..', 'config', 'zuordnung.json'), 'utf8'));
const prZuordnung = await ordnePRsZu(issues, mergedRaw, { cachePath: join(outDir, 'zuordnung-prs.json'), apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || null, log, remap: !!args.remap });
const merged = mergedRaw
  .map((p) => {
    if ((zuordnungConfig.prAusblenden || []).includes(p.number)) return null;
    const ticketRefs = new Set(prZuordnung.get(p.number) || []);
    const viaPlan = p.branch && planBranches.get(p.branch);
    if (viaPlan) for (const t of viaPlan.dbaTickets) ticketRefs.add(t);
    if (!ticketRefs.size) return null;
    const tags = p.mergeSha && commitExists(lms, p.mergeSha) ? new Set(tagsContaining(lms, p.mergeSha)) : new Set();
    const release = releases.find((r) => tags.has(r.tag)) || null;
    return { number: p.number, title: p.title, body: p.body, mergedAt: p.mergedAt, release: release ? { tag: release.tag, publishedAt: release.publishedAt } : null, tickets: [...ticketRefs] };
  })
  .filter(Boolean);
const mergedStats = await annotateMerged(merged, { cachePath: join(outDir, 'texte.json'), apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || null, log });
log(`Fertig geworden: ${mergedRaw.length} gemergte PRs im Zeitraum, ${merged.length} mit Ticket-Bezug sichtbar, ${mergedStats.created} Sätze neu, ${mergedStats.skipped} ohne Satz`);
for (const m of merged) delete m.body;

// 4. DBA-Issues und Board-Status
const board = await boardStatuses(token, ORG, PROJECT_NUMBER);
log(`${issues.length} DBA-Tickets gelesen, Board-Status ${board ? 'verfügbar' : 'nicht verfügbar'}`);

const tickets = issues.map((issue) => {
  const linked = features.filter((f) => f.dbaTickets.includes(issue.number));
  const boardStatus = board ? board.get(`${ORG}/${DBA_REPO}#${issue.number}`) ?? null : null;
  const mergedForTicket = merged.filter((m) => m.tickets.includes(issue.number));
  const stage = ticketStage(issue, boardStatus, linked, mergedForTicket);
  // „live seit“: das jüngste Release, das einen Teil dieses Tickets enthält (alle Teile sind dann live)
  const releaseDates = [...linked.filter((f) => f.release).map((f) => f.release.publishedAt), ...mergedForTicket.filter((m) => m.release).map((m) => m.release.publishedAt)].sort();
  const live = stage === 'live' && releaseDates.length ? releaseDates.at(-1) : null;
  const lastActivity = linked.map((f) => f.lastActivity).filter(Boolean).sort().at(-1) || null;
  const phasesTotal = linked.reduce((s, f) => s + f.phases.length, 0);
  const phasesDone = linked.reduce((s, f) => s + f.phases.filter((p) => p.state === 'done').length, 0);
  return {
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    createdAt: issue.createdAt,
    closedAt: issue.closedAt,
    boardStatus,
    stage,
    liveSince: live ? live.slice(0, 10) : null,
    lastActivity,
    phasesTotal,
    phasesDone,
    features: linked.map(({ dbaTickets, ...rest }) => ({ ...rest, ticketCount: dbaTickets.length })),
    merged: mergedForTicket.map(({ tickets, ...rest }) => rest),
  };
});


// 5. Schreiben
const snapshot = {
  date: today,
  generatedAt: new Date().toISOString(),
  boardUrl: BOARD_URL,
  tickets: tickets.sort((a, b) => a.number - b.number),
  merged: merged.map(({ tickets, ...rest }) => ({ ...rest, ticket: tickets[0] ?? null })),
};
writeFileSync(join(snapDir, `${today}.json`), JSON.stringify(snapshot, null, 2) + '\n');

const dates = readdirSync(snapDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ dates, latest: dates.at(-1), updatedAt: snapshot.generatedAt }, null, 2) + '\n');
log(`geschrieben: ${tickets.length} Tickets, ${features.length} Vorhaben, ${dates.length} Snapshots insgesamt`);

// ---------------------------------------------------------------------------

function featureStage(plan, pull, release, { declared, onMain, allDone }) {
  if (release) return 'live';
  if (pull?.state === 'merged') return 'test';
  if (pull?.state === 'open') return 'test';
  if (/^(Abgeschlossen|PR offen|Review grün|Manuell getestet|Pre-PR grün)/.test(plan.stand)) return 'test';
  if (/^In Arbeit/.test(plan.stand)) return declared ? 'in_arbeit' : 'geplant';
  if (/^(Entwurf|Freigegeben)/.test(plan.stand)) return 'geplant';
  // Kein Status-Block (alte Pläne): nur auf dem eigenen Branch ist etwas in Arbeit
  if (declared) return 'in_arbeit';
  if (onMain && allDone) return 'test';
  return 'geplant';
}

/**
 * Zustand eines Tickets. Maßgeblich ist, was im Repo liegt: Vorhaben zuerst, dann gemergte PRs,
 * die Board-Spalte nur, wenn beides fehlt. Bei mehreren Vorhaben gilt das am wenigsten weit
 * gediehene (offene Arbeit schlägt Testphase schlägt Live), weil das Ticket erst fertig ist,
 * wenn alle Teile fertig sind.
 */
function ticketStage(issue, boardStatus, linked, mergedForTicket) {
  if (issue.state === 'closed') return linked.some((f) => f.stage === 'live') || mergedForTicket.some((m) => m.release) ? 'live' : 'erledigt';
  if (linked.length) {
    for (const s of ['in_arbeit', 'test', 'geplant']) if (linked.some((f) => f.stage === s)) return s;
    return 'live';
  }
  if (mergedForTicket.length) return mergedForTicket.every((m) => m.release) ? 'live' : 'test';
  switch (boardStatus) {
    case 'In progress': return 'in_arbeit';
    case 'Current Sprint':
    case 'Next Up': return 'geplant';
    case 'On Hold': return 'pausiert';
    case 'Done': return 'erledigt';
    default: return 'idee';
  }
}

function berlinDate(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--lms') out.lms = argv[++i];
    else if (argv[i] === '--date') out.date = argv[++i];
    else if (argv[i] === '--no-llm') out.noLlm = true;
    else if (argv[i] === '--worktree') out.worktree = true;
    else if (argv[i] === '--remap') out.remap = true;
  }
  return out;
}
