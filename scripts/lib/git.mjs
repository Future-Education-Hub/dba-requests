import { execFileSync } from 'node:child_process';

/** Führt git im LMS-Checkout aus und liefert stdout. Wirft bei Fehler. */
export function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function tryGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}

/** Alle Remote-Branches als `origin/<name>` (ohne HEAD). */
export function listRemoteBranches(repo) {
  return git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'origin/HEAD');
}

/** Pfade aller PLAN.md unter docs/features, die den Suchbegriff enthalten, auf einem Ref. */
export function grepPlanFiles(repo, ref, needle) {
  const out = tryGit(repo, ['grep', '-l', '--fixed-strings', needle, ref, '--', 'docs/features/*/PLAN.md']);
  if (!out) return [];
  // Format: <ref>:<path>
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(':') + 1))
    .filter((p) => /^docs\/features\/[^/]+\/PLAN\.md$/.test(p));
}

export function readFileAt(repo, ref, path) {
  return tryGit(repo, ['show', `${ref}:${path}`]);
}

/** Commits (älteste zuerst), die eine Datei auf einem Ref berührt haben. */
export function fileCommits(repo, ref, path) {
  const out = tryGit(repo, ['log', '--format=%H %aI', '--reverse', ref, '--', path]);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date] = line.split(' ');
      return { sha, date };
    });
}

export function lastCommitDate(repo, ref) {
  const out = tryGit(repo, ['log', '-1', '--format=%aI', ref]);
  return out ? out.trim() : null;
}

/** Tags, die einen Commit enthalten. */
export function tagsContaining(repo, sha) {
  const out = tryGit(repo, ['tag', '--contains', sha]);
  if (!out) return [];
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function commitExists(repo, sha) {
  return tryGit(repo, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}
