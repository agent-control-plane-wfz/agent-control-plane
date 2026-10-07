// Secrets seam (v3, modeled on dsh-credentials): config stores credential *references*
// (env var names); values live outside config. Write-only API — callers can learn WHETHER
// a credential is set and WHERE it came from, never the value itself.
// Lookup order (dsh-credentials-local): startup env > stored secrets.env file.
// Honest limit (same as dsh): agent child processes run as the same OS user and inherit
// an injected env — this storage cannot isolate secrets from the agents themselves.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Repo-root state dir (D:\workb\orchestrator\state) — same place secrets.env already lives.
const STATE_DIR = process.env.ACP_STATE_DIR ?? join(here, '..', '..', '..', 'state');
export const SECRETS_FILE = join(STATE_DIR, 'secrets.env');

export interface CredentialStatus {
  name: string;
  configured: boolean;
  source: 'env' | 'secrets.env' | 'none';
}

function parseSecretsFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(SECRETS_FILE)) return out;
  try {
    for (const raw of readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) out[key] = val;
    }
  } catch { /* unreadable -> treat as empty */ }
  return out;
}

/** Resolve a credential value. Never log or return this through any API. */
export function getCredential(name: string): { value: string; source: 'env' | 'secrets.env' } | undefined {
  const env = process.env[name];
  if (env && env.trim()) return { value: env, source: 'env' };
  const stored = parseSecretsFile()[name];
  if (stored) return { value: stored, source: 'secrets.env' };
  return undefined;
}

/** Write-only store. Empty value deletes the entry (dsh: empty field + save = reset). */
export function setCredential(name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid credential name: ${name}`);
  const raw = existsSync(SECRETS_FILE) ? readFileSync(SECRETS_FILE, 'utf8') : '';
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  // Drop only the final empty line that a trailing newline produces; we add one back.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const wantSet = !!(value && value.trim());
  const out: string[] = [];
  let replaced = false;
  // F6 (issue #2): preserve every unrelated line verbatim — the old code rebuilt the file
  // from a filter that dropped comments and blank lines, silently destroying them.
  for (const line of lines) {
    const t = line.trim();
    const eq = t.indexOf('=');
    const key = eq > 0 ? t.slice(0, eq).trim() : '';
    if (key === name) {
      if (wantSet) out.push(`${name}=${value.trim()}`);
      replaced = true;
      continue;                        // value deleted when wantSet is false
    }
    out.push(line);
  }
  if (!replaced && wantSet) out.push(`${name}=${value.trim()}`);
  mkdirSync(dirname(SECRETS_FILE), { recursive: true });
  const tmp = `${SECRETS_FILE}.tmp`;
  writeFileSync(tmp, out.join('\n') + '\n', 'utf8');
  renameSync(tmp, SECRETS_FILE);
}

export function deleteCredential(name: string): void {
  setCredential(name, '');
}

/** Names that have an entry in the stored secrets file (values excluded). */
export function storedNames(): string[] {
  return Object.keys(parseSecretsFile());
}

export function describeCredential(name: string): CredentialStatus {
  const r = getCredential(name);
  if (r) return { name, configured: true, source: r.source };
  return { name, configured: false, source: 'none' };
}
