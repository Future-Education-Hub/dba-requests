/**
 * Ordnet Vorhaben (PLAN.md) den DBA-Tickets zu, ohne dass das LMS-Repo davon weiß.
 * Die Claude API entscheidet anhand von Ticket-Titeln/-Texten und Plan-Titeln/-Phasen;
 * das Ergebnis wird je Eingabestand gecacht (docs/data/zuordnung.json) und durch
 * config/zuordnung.json (pin / ausblenden) überstimmt.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';

const SYSTEM = [
  'Du ordnest interne Entwicklungsvorhaben eines Lernmanagementsystems den Anforderungs-Tickets eines Kunden (Bildungsträger DBA) zu.',
  'Du bekommst die Liste der Tickets (Nummer, Titel, Beschreibung) und die Liste der Vorhaben (Kennung, Titel, Stand, Arbeitsschritte).',
  'Ein Vorhaben gehört zu einem Ticket, wenn es diese Anforderung ganz oder in wesentlichen Teilen umsetzt. Ein Vorhaben kann zu mehreren Tickets gehören, ein Ticket zu mehreren Vorhaben.',
  'Sei konservativ: Ordne nur zu, wenn der inhaltliche Zusammenhang klar ist. Allgemeine Plattformarbeit, interne Werkzeuge, Vertrieb, Stellenmarkt oder Dinge, die kein Ticket erkennbar fordert, bekommen keine Zuordnung.',
  'Gib für jedes zugeordnete Paar eine Sicherheit zwischen 0 und 1 an und eine Begründung in einem kurzen Satz.',
].join(' ');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zuordnungen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string' },
          ticket: { type: 'integer' },
          sicherheit: { type: 'number' },
          begruendung: { type: 'string' },
        },
        required: ['slug', 'ticket', 'sicherheit', 'begruendung'],
      },
    },
  },
  required: ['zuordnungen'],
};

const MIN_CONFIDENCE = 0.6;

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function inputKey(issues, plans) {
  const h = createHash('sha256');
  for (const i of issues) h.update(`${i.number}|${i.title}|${(i.body || '').slice(0, 1500)}\n`);
  for (const p of plans) h.update(`${p.slug}|${p.title}|${p.phases.map((x) => x.title).join(';')}\n`);
  return h.digest('hex').slice(0, 20);
}

async function askMapping(client, issues, plans) {
  const user = [
    'TICKETS:',
    ...issues.map((i) => `#${i.number} ${i.title}${i.body ? `\n  ${i.body.replace(/\s+/g, ' ').slice(0, 1500)}` : ''}`),
    '',
    'VORHABEN:',
    ...plans.map((p) => `${p.slug} | ${p.title} | Stand: ${p.stand || '?'}\n  Schritte: ${p.phases.map((x) => x.title).join(' · ').slice(0, 1200)}`),
  ].join('\n');
  const base = { model: MODEL, max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: user }] };
  let response;
  try {
    response = await client.messages.create({ ...base, output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } } });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    // Fallback ohne Schema-Zwang: JSON per Anweisung
    response = await client.messages.create({
      ...base,
      system: SYSTEM + ' Antworte ausschließlich mit JSON der Form {"zuordnungen":[{"slug":"","ticket":0,"sicherheit":0.0,"begruendung":""}]}.',
      output_config: { effort: 'medium' },
    });
  }
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(text).zuordnungen; } catch { return null; }
}

const DROP_CONFIDENCE = 0.4; // darunter wird ein bisher akzeptiertes Paar wieder gelöst

/** Alte Cache-Form (je Eingabestand eine Liste) in die Paar-Form überführen. */
function migratePlanCache(cache) {
  if (cache.pairs) return cache;
  const runs = Object.values(cache).filter((v) => Array.isArray(v?.zuordnungen)).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const pairs = {};
  for (const run of runs) {
    for (const z of run.zuordnungen) {
      const k = `${z.slug}#${z.ticket}`;
      const prev = pairs[k];
      pairs[k] = {
        sicherheit: z.sicherheit,
        begruendung: z.begruendung,
        firstSeen: prev?.firstSeen || run.createdAt,
        lastSeen: run.createdAt,
        accepted: (prev?.accepted && z.sicherheit >= DROP_CONFIDENCE) || z.sicherheit >= MIN_CONFIDENCE,
      };
    }
  }
  return { pairs, lastInputKey: null, lastRun: runs.at(-1)?.createdAt || null };
}

/**
 * Liefert Map slug → Set(Ticketnummern). Pins und Ausblendungen aus der Konfiguration gewinnen.
 * Zuordnungen sind klebrig: Ein einmal akzeptiertes Paar bleibt, bis die API es klar widerlegt
 * (Sicherheit unter DROP_CONFIDENCE) oder Plan bzw. Ticket verschwinden. Ohne API-Key gilt der Cache.
 */
export async function ordneZu(issues, plans, { cachePath, configPath, apiKey, workspaceId, log }) {
  const config = loadJson(configPath, { pin: {}, ausblenden: [] });
  const cache = migratePlanCache(loadJson(cachePath, {}));
  const key = inputKey(issues, plans);
  const slugs = new Set(plans.map((p) => p.slug));
  const ticketNumbers = new Set(issues.map((i) => i.number));

  let quelle = 'cache';
  if (cache.lastInputKey !== key && apiKey && plans.length && issues.length) {
    try {
      const client = new Anthropic({ apiKey, defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : {} });
      const result = await askMapping(client, issues, plans);
      if (result) {
        const now = new Date().toISOString();
        for (const z of result) {
          const k = `${z.slug}#${z.ticket}`;
          const prev = cache.pairs[k];
          cache.pairs[k] = {
            sicherheit: z.sicherheit,
            begruendung: z.begruendung,
            firstSeen: prev?.firstSeen || now,
            lastSeen: now,
            accepted: prev?.accepted ? z.sicherheit >= DROP_CONFIDENCE : z.sicherheit >= MIN_CONFIDENCE,
          };
        }
        cache.lastInputKey = key;
        cache.lastRun = now;
        writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
        quelle = 'api';
      }
    } catch (err) {
      log(`Zuordnung: API-Fehler (${err?.status ?? err?.name ?? 'unbekannt'}), nutze letzten bekannten Stand`);
    }
  }

  const map = new Map();
  const add = (slug, ticket) => {
    if (!slugs.has(slug) || !ticketNumbers.has(ticket)) return;
    if (!map.has(slug)) map.set(slug, new Set());
    map.get(slug).add(ticket);
  };
  for (const [k, pair] of Object.entries(cache.pairs)) {
    if (!pair.accepted) continue;
    const [slug, ticket] = k.split('#');
    add(slug, Number(ticket));
  }
  for (const [slug, tickets] of Object.entries(config.pin || {})) { map.delete(slug); for (const t of tickets) add(slug, Number(t)); }
  for (const slug of config.ausblenden || []) map.delete(slug);

  log(`Zuordnung: ${map.size} von ${plans.length} Vorhaben einem Ticket zugeordnet (Quelle: ${quelle}, ${Object.keys(config.pin || {}).length} Pins, ${(config.ausblenden || []).length} ausgeblendet)`);
  return map;
}

// ---------------------------------------------------------------------------
// Pull Requests → DBA-Tickets (inkrementell: nur neue PRs werden angefragt)

const SYSTEM_PR = [
  'Du ordnest fertiggestellte Änderungen (Pull Requests) an einem Lernmanagementsystem den Anforderungs-Tickets eines Kunden (Bildungsträger DBA) zu.',
  'Du bekommst die Liste der Tickets (Nummer, Titel, Beschreibung) und eine Liste von Änderungen (Nummer, Titel, Beschreibung).',
  'Eine Änderung gehört zu einem Ticket, wenn sie dessen Anforderung ganz oder teilweise umsetzt oder einen für dieses Ticket relevanten Fehler behebt.',
  'Sei konservativ: Allgemeine Plattformarbeit, interne Werkzeuge, Vertrieb, Stellenmarkt, Dokumentation, Medienproduktion oder Dinge, die kein Ticket erkennbar fordert, bekommen keine Zuordnung. Die meisten Änderungen gehören zu keinem Ticket.',
  'Gib für jedes zugeordnete Paar eine Sicherheit zwischen 0 und 1 an und eine Begründung in einem kurzen Satz.',
].join(' ');

const SCHEMA_PR = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zuordnungen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { pr: { type: 'integer' }, ticket: { type: 'integer' }, sicherheit: { type: 'number' }, begruendung: { type: 'string' } },
        required: ['pr', 'ticket', 'sicherheit', 'begruendung'],
      },
    },
  },
  required: ['zuordnungen'],
};

function issuesKey(issues) {
  const h = createHash('sha256');
  for (const i of issues) h.update(`${i.number}|${i.title}|${(i.body || '').slice(0, 1500)}\n`);
  return h.digest('hex').slice(0, 12);
}

async function askPrMapping(client, issues, prs) {
  const user = [
    'TICKETS:',
    ...issues.map((i) => `#${i.number} ${i.title}${i.body ? `\n  ${i.body.replace(/\s+/g, ' ').slice(0, 1500)}` : ''}`),
    '',
    'ÄNDERUNGEN:',
    ...prs.map((p) => `PR ${p.number} | ${p.title}\n  ${(p.body || '').replace(/\s+/g, ' ').slice(0, 900)}`),
  ].join('\n');
  const base = { model: MODEL, max_tokens: 8000, system: SYSTEM_PR, messages: [{ role: 'user', content: user }] };
  let response;
  try {
    response = await client.messages.create({ ...base, output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA_PR } } });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    response = await client.messages.create({
      ...base,
      system: SYSTEM_PR + ' Antworte ausschließlich mit JSON der Form {"zuordnungen":[{"pr":0,"ticket":0,"sicherheit":0.0,"begruendung":""}]}.',
      output_config: { effort: 'medium' },
    });
  }
  if (response.stop_reason === 'refusal') return null;
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(text).zuordnungen; } catch { return null; }
}

/**
 * Liefert Map PR-Nummer → Set(Ticketnummern). Cache je PR; neue PRs und (bei geändertem Ticketstand)
 * alle PRs werden angefragt, in Paketen von höchstens 25. Akzeptierte Paare bleiben, bis die API sie
 * klar widerlegt (unter DROP_CONFIDENCE).
 */
export async function ordnePRsZu(issues, prs, { cachePath, apiKey, workspaceId, log }) {
  let cache = loadJson(cachePath, {});
  if (!cache.prs) cache = { prs: {}, issuesKey: null }; // alte Form verwerfen (nur ein Tag alt)
  const ik = issuesKey(issues);
  const ticketNumbers = new Set(issues.map((i) => i.number));
  const titleHash = (p) => createHash('sha256').update(p.title).digest('hex').slice(0, 8);
  const pending = prs.filter((p) => {
    const e = cache.prs[p.number];
    return !e || e.titleHash !== titleHash(p) || e.issuesKey !== ik;
  });
  let asked = 0;
  if (pending.length && apiKey && issues.length) {
    const client = new Anthropic({ apiKey, defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : {} });
    for (let i = 0; i < pending.length; i += 25) {
      const batch = pending.slice(i, i + 25);
      try {
        const result = await askPrMapping(client, issues, batch);
        if (!result) continue;
        const now = new Date().toISOString();
        for (const p of batch) {
          const prev = cache.prs[p.number]?.pairs || {};
          const pairs = { ...prev };
          for (const z of result.filter((z) => z.pr === p.number && ticketNumbers.has(z.ticket))) {
            const before = pairs[z.ticket];
            pairs[z.ticket] = { sicherheit: z.sicherheit, begruendung: z.begruendung, accepted: before?.accepted ? z.sicherheit >= DROP_CONFIDENCE : z.sicherheit >= MIN_CONFIDENCE };
          }
          cache.prs[p.number] = { titleHash: titleHash(p), issuesKey: ik, updatedAt: now, pairs };
        }
        asked += batch.length;
      } catch (err) {
        log(`Zuordnung PRs: API-Fehler (${err?.status ?? err?.name ?? 'unbekannt'}), Paket übersprungen`);
        if (err?.status === 400 || err?.status === 401) break;
      }
    }
    if (asked) {
      cache.issuesKey = ik;
      const keep = new Set(prs.map((p) => String(p.number)));
      cache.prs = Object.fromEntries(Object.entries(cache.prs).filter(([n]) => keep.has(n)));
      writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
    }
  }
  const map = new Map();
  for (const p of prs) {
    const tickets = Object.entries(cache.prs[p.number]?.pairs || {}).filter(([t, v]) => v.accepted && ticketNumbers.has(Number(t))).map(([t]) => Number(t));
    if (tickets.length) map.set(p.number, new Set(tickets));
  }
  log(`Zuordnung PRs: ${prs.length} geprüft, ${asked} neu angefragt, ${map.size} einem Ticket zugeordnet`);
  return map;
}
