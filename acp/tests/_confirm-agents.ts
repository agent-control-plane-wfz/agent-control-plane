// Import this AFTER ./_isolate-state.ts in any test that actually DISPATCHES a task.
//
// Since issue #7 nothing is routable until the user confirms it, so a test that wants to run a
// prompt must first act as the user: confirm the agents it needs. That is deliberate — it keeps
// the "fresh machine" behaviour (nothing configured) honest instead of silently special-casing
// tests, and tests/e2e-setup.ts covers the un-confirmed behaviour explicitly.
//
// SAFETY: refuses to run unless the state dir is isolated, so running the suite can never flip
// confirmations in a real deployment's user config.
import { tmpdir } from 'node:os';
import { E2E_STATE_DIR } from './_isolate-state.ts';

const dir = String(E2E_STATE_DIR ?? '').toLowerCase();
const tmp = tmpdir().toLowerCase();
if (!dir || !dir.startsWith(tmp)) {
  throw new Error(
    `refusing to write agent confirmations outside an isolated state dir (ACP_STATE_DIR=${E2E_STATE_DIR}, tmp=${tmpdir()}). `
    + 'Import ./_isolate-state.ts first, or set ACP_STATE_DIR to a temp directory.',
  );
}

const { getMerged } = await import('../src/config/settings.ts');
const { completeSetup } = await import('../src/config/setup.ts');

const ids = Object.keys(getMerged().agents);
completeSetup(Object.fromEntries(ids.map((id) => [id, { confirm: true }])));

export const CONFIRMED_AGENTS = ids;
