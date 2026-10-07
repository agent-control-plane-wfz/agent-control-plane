// Single source of truth for where runtime state lives.
//
// The README documents ACP_STATE_DIR as "the state directory (budget, job history,
// write-only credentials)". That contract was only half true: secrets/settings/probe
// honoured it, while the budget ledger and the web job history were hardcoded to
// acp/state — so pointing ACP_STATE_DIR elsewhere (as the E2E tests do) still mutated
// the real runtime files. Resolving every path here makes the documented behaviour the
// actual behaviour, and keeps a test run from touching real state.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (this file lives at <root>/acp/src/config/paths.ts). */
export const REPO_ROOT = join(here, '..', '..', '..');

/** Everything below defaults to <root>/state (gitignored) and follows ACP_STATE_DIR. */
export const STATE_DIR = process.env.ACP_STATE_DIR ?? join(REPO_ROOT, 'state');

/** Budget may be separated further with ACP_BUDGET_DIR; default: the shared state dir. */
export const BUDGET_DIR = process.env.ACP_BUDGET_DIR ?? STATE_DIR;

export const SECRETS_FILE = join(STATE_DIR, 'secrets.env');
export const USER_CONFIG_FILE = join(STATE_DIR, 'control-plane-config.json');
export const OBSERVED_FILE = process.env.ACP_OBSERVED_FILE ?? join(STATE_DIR, 'capability-observed.json');
export const HISTORY_FILE = join(STATE_DIR, 'web-jobs.jsonl');

// Machine-bound model facts (issue #6): vendor mappings that are true on ONE machine — e.g. a
// Claude Code install remapped to a DeepSeek endpoint — must not ship in the tracked
// registry/models.json, or every clone inherits that machine's reality. Declared defaults stay
// in the repo; the per-machine overlay lives here and is merged over them.
export const MODELS_OBSERVED_FILE = process.env.ACP_MODELS_OBSERVED_FILE ?? join(STATE_DIR, 'models-observed.json');
