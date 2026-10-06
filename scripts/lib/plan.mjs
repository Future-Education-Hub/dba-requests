/**
 * Parser für docs/features/<slug>/PLAN.md aus dem LMS-Repo.
 * Liest nur Struktur: Status-Block, Phasen, Checkboxen, Abschluss-Marker, DBA-Zeilen.
 */

const STATUS_FIELDS = ['Stand', 'Branch', 'PR', 'Fortschritt', 'Aktuelle Phase', 'DBA-Ticket', 'DBA-Tickets'];

export function parsePlan(markdown, slug) {
  const lines = markdown.split('\n');
  const titleLine = lines.find((l) => l.startsWith('# '));
  const title = titleLine
    ? titleLine.replace(/^#\s+/, '').replace(/^Implementierungsplan:\s*/i, '').trim()
    : slug;

  const status = {};
  let inStatus = false;
  for (const line of lines) {
    if (/^##\s+Status\b/.test(line)) { inStatus = true; continue; }
    if (inStatus && /^##\s+/.test(line)) break;
    if (!inStatus) continue;
    const m = line.match(/^- \*\*([^*]+?):\*\*\s*(.*)$/);
    if (m && STATUS_FIELDS.includes(m[1].trim())) status[m[1].trim()] = m[2].trim();
  }

  const branchMatch = (status.Branch || '').match(/`([^`]+)`/);
  const branch = branchMatch ? branchMatch[1] : (status.Branch || '').split(/\s/)[0] || null;
  const prMatch = (status.PR || '').match(/#(\d+)/);
  const pr = prMatch ? Number(prMatch[1]) : null;
  const currentPhaseMatch = (status['Aktuelle Phase'] || '').match(/Phase\s+(\d+)/);
  const currentPhase = currentPhaseMatch ? Number(currentPhaseMatch[1]) : null;
  const dbaLine = status['DBA-Ticket'] || status['DBA-Tickets'] || '';
  const dbaTickets = [...dbaLine.matchAll(/(?:issues\/|#)(\d+)/g)].map((m) => Number(m[1]));
  const stand = status.Stand || '';
  const planFinished = /^(Abgeschlossen|PR offen|Review grün|Manuell getestet|Pre-PR grün)/.test(stand);

  // Phasen
  const phases = [];
  let current = null;
  let inPhases = false;
  for (const line of lines) {
    const head = line.match(/^###\s+Phase\s+(\d+)\s*[—–-]\s*(.+?)\s*$/);
    if (head) {
      inPhases = true;
      current = { n: Number(head[1]), title: head[2].trim(), items: [], checked: 0, unchecked: 0, markerDate: null, marker: false, dbaText: null };
      phases.push(current);
      continue;
    }
    if (/^##\s+/.test(line) && inPhases && !/^###/.test(line)) { current = null; continue; }
    if (/^###\s+/.test(line)) { current = null; continue; }
    if (!current) continue;

    const box = line.match(/^\s*- \[([ xX])\]\s*(.*)$/);
    if (box) {
      if (box[1] === ' ') current.unchecked += 1; else current.checked += 1;
      current.items.push(box[2].trim());
      continue;
    }
    if (/^\s{2,}\S/.test(line) && current.items.length && !/^\s*[-*>]/.test(line)) {
      // Fortsetzungszeile eines Checklisten-Punkts
      current.items[current.items.length - 1] += ' ' + line.trim();
      continue;
    }
    const marker = line.match(new RegExp(`^>\\s*✅\\s*\\**Phase\\s+${current.n}\\s+abgeschlossen(?:\\s*\\((\\d{4}-\\d{2}-\\d{2})\\))?`));
    if (marker) { current.marker = true; current.markerDate = marker[1] || null; continue; }
    const dba = line.match(/^\s*[*_]{0,2}Für die DBA:[*_]{0,2}\s*(.+?)\s*[*_]{0,2}\s*$/);
    if (dba) current.dbaText = dba[1].replace(/[*_]+$/, '').trim();
  }

  for (const p of phases) {
    const total = p.checked + p.unchecked;
    let state;
    if ((total > 0 && p.unchecked === 0) || p.marker) state = 'done';
    else if (total === 0 && planFinished) state = 'done';
    else if (p.checked > 0 || p.n === currentPhase) state = 'active';
    else state = 'open';
    p.state = state;
    p.total = total;
  }

  return { slug, title, stand, branch, pr, currentPhase, dbaTickets, planFinished, phases };
}

/** Stabiler Schlüssel für den Laientext-Cache: ändert sich, wenn Titel oder Checkliste sich ändern. */
export function phaseContentKey(slug, phase) {
  return `${slug}|${phase.n}|${phase.title}|${phase.items.join('\n')}`;
}
