/** Lesezugriffe auf GitHub: Issues, Board-Status, Pull Requests, Releases. */

const API = 'https://api.github.com';

function headers(token, extra = {}) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dba-fortschritt', ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function rest(token, path) {
  const res = await fetch(`${API}${path}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub ${res.status} für ${path.split('?')[0]}`);
  return res.json();
}

async function restAll(token, path) {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await rest(token, `${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function listIssues(token, owner, repo) {
  let all;
  try {
    all = await restAll(token, `/repos/${owner}/${repo}/issues?state=all`);
  } catch (err) {
    if (!token) throw err;
    all = await restAll(null, `/repos/${owner}/${repo}/issues?state=all`); // öffentliches Repo
  }
  return all
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      url: i.html_url,
      createdAt: i.created_at,
      closedAt: i.closed_at,
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    }));
}

/** Board-Status je Issue: Map "owner/repo#number" → Spaltenname. null, wenn kein Zugriff. */
export async function boardStatuses(token, org, projectNumber) {
  if (!token) return null;
  const query = `
    query($org: String!, $number: Int!, $after: String) {
      organization(login: $org) {
        projectV2(number: $number) {
          items(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
              content { ... on Issue { number repository { nameWithOwner } } }
            }
          }
        }
      }
    }`;
  const map = new Map();
  let after = null;
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables: { org, number: projectNumber, after } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const items = json?.data?.organization?.projectV2?.items;
    if (!items) return null;
    for (const node of items.nodes) {
      if (node?.content?.number) map.set(`${node.content.repository.nameWithOwner}#${node.content.number}`, node.fieldValueByName?.name ?? null);
    }
    if (!items.pageInfo.hasNextPage) break;
    after = items.pageInfo.endCursor;
  }
  return map;
}

function mapPull(p) {
  return { number: p.number, state: p.merged_at ? 'merged' : p.state, url: p.html_url, mergedAt: p.merged_at, mergeSha: p.merge_commit_sha, createdAt: p.created_at };
}

export async function pullByNumber(token, owner, repo, number) {
  try { return mapPull(await rest(token, `/repos/${owner}/${repo}/pulls/${number}`)); } catch { return null; }
}

export async function pullForBranch(token, owner, repo, branch) {
  try {
    const list = await rest(token, `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`);
    if (!list.length) return null;
    list.sort((a, b) => (b.merged_at ? 1 : 0) - (a.merged_at ? 1 : 0) || b.number - a.number);
    return mapPull(list[0]);
  } catch { return null; }
}

/** Veröffentlichte Releases, älteste zuerst. */
export async function listReleases(token, owner, repo) {
  try {
    const all = await restAll(token, `/repos/${owner}/${repo}/releases`);
    return all
      .filter((r) => !r.draft && r.published_at)
      .map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, publishedAt: r.published_at, url: r.html_url }))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  } catch { return []; }
}

/** Gemergte Pull Requests nach main seit einem Zeitpunkt (neueste zuerst). */
export async function listMergedPulls(token, owner, repo, sinceIso) {
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await rest(token, `/repos/${owner}/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`);
    let older = false;
    for (const p of batch) {
      if (!p.merged_at) continue;
      if (p.merged_at < sinceIso) { older = true; continue; }
      out.push({
        number: p.number,
        title: p.title || '',
        body: p.body || '',
        url: p.html_url,
        mergedAt: p.merged_at,
        mergeSha: p.merge_commit_sha,
        branch: p.head?.ref || null,
        labels: (p.labels || []).map((l) => l.name),
      });
    }
    if (batch.length < 100 || older) break;
  }
  return out.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}
