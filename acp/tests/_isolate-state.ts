// Import this FIRST in any test that drives the real control plane.
//
// Every state file the plane writes — job history, budget ledger, write-only credentials,
// user config, probe observations — resolves through src/config/paths.ts, which reads
// ACP_STATE_DIR at module load. Setting it here (before the app modules are evaluated)
// keeps an E2E run from touching the real deployment: no phantom budget consumption, no
// appended job history, no risk of overwriting real credentials.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.ACP_STATE_DIR) {
  process.env.ACP_STATE_DIR = mkdtempSync(join(tmpdir(), 'acp-e2e-state-'));
}
if (!process.env.ACP_BUDGET_DIR) process.env.ACP_BUDGET_DIR = process.env.ACP_STATE_DIR;

export const E2E_STATE_DIR = process.env.ACP_STATE_DIR;
