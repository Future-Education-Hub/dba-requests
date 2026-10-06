#!/usr/bin/env node
/**
 * Erzeugt den Tages-Snapshot der Fortschrittsseite.
 *
 *   node scripts/build.mjs --lms <Pfad zum feh-lms-Checkout> [--date YYYY-MM-DD] [--no-llm]
 *
 * Umgebung: GITHUB_TOKEN (Lesen: feh-lms Contents + Pull requests, Org-Projekte),
 *           ANTHROPIC_API_KEY (optional, für die Laiensätze),
 *           ANTHROPIC_WORKSPACE_ID (nur bei einem Org-weiten Key ohne Workspace-Bindung).
 *
 * Das Log nennt nur Zähler und Fehlerarten, keine Inhalte aus dem privaten Repo.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit, listRemoteBranches, grepPlanFiles, readFileAt, fileCommits, lastCommitDate, tagsContaining, commitExists } from './lib/git.mjs';
import { parsePlan } from './lib/plan.mjs';
import { listIssues, boardStatuses, pullByNumber, pullForBranch, listReleases } from './lib/github.mjs';
import { annotatePhases } from './lib/laientext.mjs';

const ORG = 'Future-Education-Hub';
const LMS_REPO = 'feh-lms';
const DBA_REPO = 'dba-requests';
const PROJECT_NUMBER = 3;
const BOARD_URL = `https://github.com/orgs/${ORG}/projects/${PROJECT_NUMBER}/views/6`;

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

// 1. Pläne mit DBA-Verknüpfung auf allen Branches einsammeln
const branches = listRemoteBranches(lms);
const copies = new Map(); // slug → [{ ref, branch, path, plan }]
for (const ref of branches) {
  for (const path of grepPlanFiles(lms, ref, 'DBA-Ticket')) {
    const md = readFileAt(lms, ref, path);
    if (!md) continue;
    const slug = path.split('/')[2];
    const plan = parsePlan(md, slug);
    if (!plan.dbaTickets.length) continue;
    if (!copies.has(slug)) copies.set(slug, []);
    copies.get(slug).push({ ref, branch: ref.replace(/^origin\//, ''), path, plan });
  }
}
if (args.worktree) {
  // Lokaler Test: unveröffentlichte Arbeitskopie des aktuellen Branches mit einbeziehen
  const head = (tryGit(lms, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  for (const path of (tryGit(lms, ['grep', '-l', '--fixed-strings', 'DBA-Ticket', '--', 'docs/features/*/PLAN.md']) || '').split('\n').filter(Boolean)) {
    try {
      const md = readFileSync(join(lms, path), 'utf8');
      const slug = path.split('/')[2];
      const plan = parsePlan(md, slug);
      if (!plan.dbaTickets.length) continue;
      if (!copies.has(slug)) copies.set(slug, []);
      copies.get(slug).unshift({ ref: 'HEAD', branch: head, path, plan });
    } catch { /* Datei nicht lesbar */ }
  }
}
log(`${branches.length} Branches durchsucht, ${copies.size} verknüpfte Vorhaben gefunden`);

// 2. Je Vorhaben die maßgebliche Kopie wählen und anreichern
const releases = await listReleases(token, ORG, LMS_REPO);
const releaseByTag = new Map(releases.map((r) => [r.tag, r]));
log(`${releases.length} Releases gelesen`);

const features = [];
for (const [slug, list] of copies) {
  const declared = list.find((c) => c.ref === 'HEAD') || list.find((c) => c.plan.branch && c.branch === c.plan.branch);
  const chosen = declared || list.sort((a, b) => (lastCommitDate(lms, b.ref) || '').localeCompare(lastCommitDate(lms, a.ref) || ''))[0];
  const { plan, ref, path, branch } = chosen;

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
  if (!pull && branch) pull = await pullForBranch(token, ORG, LMS_REPO, branch);
  let release = null;
  if (pull?.mergeSha && commitExists(lms, pull.mergeSha)) {
    const tags = new Set(tagsContaining(lms, pull.mergeSha));
    release = releases.find((r) => tags.has(r.tag)) || null;
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
    lastActivity: lastCommitDate(lms, ref),
    pull: pull ? { number: pull.number, state: pull.state, url: pull.url, mergedAt: pull.mergedAt } : null,
    release: release ? { tag: release.tag, publishedAt: release.publishedAt, url: release.url } : null,
    stage: featureStage(plan, pull, release),
    phases,
  });
}

// 3. Laiensätze
const textStats = await annotatePhases(features, { cachePath: join(outDir, 'texte.json'), apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || null, log });
log(`Laiensätze: ${textStats.created} neu erzeugt, ${textStats.skipped} ohne Satz${apiKey ? '' : ' (kein API-Key)'}`);
for (const f of features) for (const p of f.phases) { delete p.items; delete p.dbaText; }

// 4. DBA-Issues und Board-Status
const issues = await listIssues(token, ORG, DBA_REPO);
const board = await boardStatuses(token, ORG, PROJECT_NUMBER);
log(`${issues.length} DBA-Tickets gelesen, Board-Status ${board ? 'verfügbar' : 'nicht verfügbar'}`);

const tickets = issues.map((issue) => {
  const linked = features.filter((f) => f.dbaTickets.includes(issue.number));
  const boardStatus = board ? board.get(`${ORG}/${DBA_REPO}#${issue.number}`) ?? null : null;
  const live = linked.filter((f) => f.release).sort((a, b) => a.release.publishedAt.localeCompare(b.release.publishedAt))[0] || null;
  const stage = ticketStage(issue, boardStatus, linked);
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
    liveSince: live ? live.release.publishedAt.slice(0, 10) : null,
    releaseTag: live ? live.release.tag : null,
    lastActivity,
    phasesTotal,
    phasesDone,
    features: linked.map(({ dbaTickets, ...rest }) => rest),
  };
});

const orphanLinks = features.flatMap((f) => f.dbaTickets).filter((n) => !issues.some((i) => i.number === n));
if (orphanLinks.length) log(`Warnung: ${orphanLinks.length} Verknüpfung(en) auf unbekannte Ticketnummern`);

// 5. Schreiben
const snapshot = {
  date: today,
  generatedAt: new Date().toISOString(),
  boardUrl: BOARD_URL,
  tickets: tickets.sort((a, b) => a.number - b.number),
};
writeFileSync(join(snapDir, `${today}.json`), JSON.stringify(snapshot, null, 2) + '\n');

const dates = readdirSync(snapDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ dates, latest: dates.at(-1), updatedAt: snapshot.generatedAt }, null, 2) + '\n');
log(`geschrieben: ${tickets.length} Tickets, ${features.length} Vorhaben, ${dates.length} Snapshots insgesamt`);

// ---------------------------------------------------------------------------

function featureStage(plan, pull, release) {
  if (release) return 'live';
  if (pull?.state === 'merged') return 'test';
  if (pull?.state === 'open') return 'test';
  if (/^(Abgeschlossen|PR offen|Review grün|Manuell getestet|Pre-PR grün)/.test(plan.stand)) return 'test';
  if (/^In Arbeit/.test(plan.stand)) return 'in_arbeit';
  if (/^(Entwurf|Freigegeben)/.test(plan.stand)) return 'geplant';
  return 'in_arbeit';
}

function ticketStage(issue, boardStatus, linked) {
  if (linked.some((f) => f.stage === 'live')) return 'live';
  if (issue.state === 'closed') return 'erledigt';
  if (linked.length) {
    const order = ['test', 'in_arbeit', 'geplant'];
    for (const s of order) if (linked.some((f) => f.stage === s)) return s;
  }
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
  }
  return out;
}
