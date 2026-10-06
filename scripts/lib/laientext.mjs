/**
 * Ein Satz je Arbeitsschritt in Alltagssprache, erzeugt über die Claude API und je Inhalt
 * nur einmal (Cache in docs/data/texte.json). Steht in der PLAN.md eine Zeile
 * „Für die DBA: …“, gewinnt sie und es wird nichts erzeugt.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { phaseContentKey } from './plan.mjs';

const MODEL = 'claude-opus-5-5';

const SYSTEM = [
  'Du schreibst für Mitarbeitende eines Bildungsträgers, die ein Lernmanagementsystem im Alltag nutzen, aber keine Technik-Kenntnisse haben.',
  'Du bekommst den Titel eines Vorhabens, den Titel eines Arbeitsschritts und die interne Arbeitsliste dazu.',
  'Beschreibe in genau einem deutschen Satz mit höchstens 160 Zeichen, was dieser Arbeitsschritt für die Nutzerinnen und Nutzer bewirkt oder ermöglicht.',
  'Verboten: Fachbegriffe (Migration, Datenbank, Tabelle, Trigger, RPC, RLS, API, Test, Branch, Commit, Frontend, Backend, Edge Function, Policy, Matview, Cron), Dateinamen, Codenamen, Anführungszeichen, Markdown, Aufzählungen.',
  'Schreibe aus Sicht des Nutzens, nicht der Technik. Wenn ein Schritt rein intern ist (Tests, Absicherung, Aufräumen), sage schlicht, dass das Team die Qualität des Vorhabens absichert.',
  'Antworte ausschließlich mit dem Satz.',
].join(' ');

const SYSTEM_PR = [
  'Du schreibst für Mitarbeitende eines Bildungsträgers, die ein Lernmanagementsystem im Alltag nutzen, aber keine Technik-Kenntnisse haben.',
  'Du bekommst Titel und interne Beschreibung einer fertiggestellten Änderung an der Plattform.',
  'Beschreibe in genau einem deutschen Satz mit höchstens 160 Zeichen, was sich dadurch für die Nutzerinnen und Nutzer verbessert oder was neu möglich ist.',
  'Verboten: Fachbegriffe (Migration, Datenbank, Tabelle, Trigger, RPC, RLS, API, Test, Branch, Commit, Frontend, Backend, Edge Function, Policy, Matview, Cron, Webhook, Token), Dateinamen, Codenamen, Namen von Personen, Anführungszeichen, Markdown, Aufzählungen.',
  'Schreibe aus Sicht des Nutzens, nicht der Technik. Betrifft die Änderung nur den internen Betrieb, sage schlicht, dass das Team die Plattform im Hintergrund stabiler oder schneller gemacht hat.',
  'Antworte ausschließlich mit dem Satz.',
].join(' ');

function makeClient(apiKey, workspaceId) {
  // Ein Org-weiter Key braucht die Workspace-Kennung als Header; ein workspace-gebundener Key nicht.
  return apiKey ? new Anthropic({ apiKey, defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : {} }) : null;
}

/** Entfernt aus einem PR-Text alles, was dem Satz nicht hilft (Codeblöcke, Bilder, Links, Signaturen). */
function cleanBody(body) {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/🤖 Generated with.*$/m, ' ')
    .replace(/Co-Authored-By:.*$/gim, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}

async function askClaudeFor(client, system, user) {
  const params = { model: MODEL, max_tokens: 2000, system, output_config: { effort: 'low' }, messages: [{ role: 'user', content: user }] };
  let response;
  try {
    response = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) response = await client.messages.create(params);
    else throw err;
  }
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return text ? tidy(text) : null;
}

function logApiError(log, err, what) {
  const reason = err?.error?.error?.message || err?.message || '';
  log(`Laientext (${what}): API-Fehler (${err?.status ?? err?.name ?? 'unbekannt'}${/workspace/i.test(reason) ? ', Key braucht ANTHROPIC_WORKSPACE_ID' : ''}), übersprungen`);
}

/**
 * Ergänzt gemergte Pull Requests um `text` (ein Satz). Cache-Schlüssel aus Nummer, Titel und Beschreibung.
 */
export async function annotateMerged(items, { cachePath, apiKey, workspaceId, maxNew = 80, log }) {
  const cache = loadCache(cachePath);
  const client = makeClient(apiKey, workspaceId);
  let created = 0;
  let skipped = 0;
  for (const item of items) {
    const body = cleanBody(item.body || '');
    const key = 'pr:' + createHash('sha256').update(`${item.number}|${item.title}|${body}`).digest('hex').slice(0, 20);
    if (cache[key]?.text) { item.text = cache[key].text; continue; }
    if (!client || created >= maxNew) { item.text = null; skipped += 1; continue; }
    try {
      const text = await askClaudeFor(client, SYSTEM_PR, `Titel: ${item.title}\n\nBeschreibung:\n${body || '(keine)'}`);
      if (text) {
        cache[key] = { text, model: MODEL, createdAt: new Date().toISOString(), pr: item.number };
        item.text = text; created += 1;
      } else { item.text = null; skipped += 1; }
    } catch (err) {
      logApiError(log, err, 'PR');
      item.text = null; skipped += 1;
      if (err?.status === 400 || err?.status === 401) break;
    }
  }
  if (created) saveCache(cachePath, cache);
  return { created, skipped };
}

function keyFor(slug, phase) {
  return createHash('sha256').update(phaseContentKey(slug, phase)).digest('hex').slice(0, 20);
}

export function loadCache(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function saveCache(path, cache) {
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
}

function tidy(text) {
  let t = text.replace(/\s+/g, ' ').replace(/^["„“']+|["„“']+$/g, '').trim();
  if (t.length > 220) t = t.slice(0, 217).replace(/\s\S*$/, '') + '…';
  return t;
}

async function askClaude(client, featureTitle, phase) {
  const user = [
    `Vorhaben: ${featureTitle}`,
    `Arbeitsschritt ${phase.n}: ${phase.title}`,
    'Interne Arbeitsliste:',
    ...phase.items.map((i) => `- ${i}`),
  ].join('\n');
  const params = {
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: user }],
  };
  let response;
  try {
    response = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError) response = await client.messages.create(params);
    else throw err;
  }
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  return text ? tidy(text) : null;
}

/**
 * Ergänzt jede Phase um `text` und `textSource` ('plan' | 'generiert' | null).
 * Gibt die Anzahl neu erzeugter Sätze zurück. Ohne API-Key wird nichts erzeugt.
 */
export async function annotatePhases(features, { cachePath, apiKey, workspaceId, maxNew = 60, log }) {
  const cache = loadCache(cachePath);
  // Ein Org-weiter Key braucht die Workspace-Kennung als Header; ein workspace-gebundener Key nicht.
  const client = makeClient(apiKey, workspaceId);
  let created = 0;
  let skipped = 0;
  for (const feature of features) {
    for (const phase of feature.phases) {
      if (phase.dbaText) { phase.text = phase.dbaText; phase.textSource = 'plan'; continue; }
      const key = keyFor(feature.slug, phase);
      if (cache[key]?.text) { phase.text = cache[key].text; phase.textSource = 'generiert'; continue; }
      if (!client || created >= maxNew) { phase.text = null; phase.textSource = null; skipped += 1; continue; }
      try {
        const text = await askClaude(client, feature.title, phase);
        if (text) {
          cache[key] = { text, model: MODEL, createdAt: new Date().toISOString(), slug: feature.slug, phase: phase.n };
          phase.text = text; phase.textSource = 'generiert'; created += 1;
        } else { phase.text = null; phase.textSource = null; skipped += 1; }
      } catch (err) {
        logApiError(log, err, 'Phase');
        if (err?.status === 400 || err?.status === 401) { log('Laientext: Erzeugung für diesen Lauf abgebrochen'); return { created, skipped: skipped + 1 }; }
        phase.text = null; phase.textSource = null; skipped += 1;
      }
    }
  }
  if (created) saveCache(cachePath, cache);
  return { created, skipped };
}
