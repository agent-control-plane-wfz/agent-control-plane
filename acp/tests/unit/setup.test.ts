// Unit tests for issue #7 — the consent gate and the first-run wizard.
//
// The behaviour being locked down: installing an adapter package must NOT be enough to get an
// agent routed to. `detected` (machine fact) and `configured` (user's answer) are separate, and
// only the second one is routable.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-setup-'));
process.env.ACP_STATE_DIR = tmp;
// builtinDefaults() only materialises claude/codex/dsh when WORKSPACE_DIR is set; point it at an
// empty dir so the three exist as candidates but are reported as NOT detected.
process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'acp-ws-'));

const {
  configuredAgent, setupState, saveSettings, clearSetupMarker, USER_CONFIG_FILE, getMerged,
} = await import('../../src/config/settings.ts');
const { setupView, completeSetup, rerunSetup, SetupError } = await import('../../src/config/setup.ts');
const { describeCredential } = await import('../../src/config/secrets.ts');

const writeConfig = (obj: unknown) => writeFileSync(USER_CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
const dropConfig = () => { if (existsSync(USER_CONFIG_FILE)) rmSync(USER_CONFIG_FILE); };
const BUILTINS = ['opencode', 'claude', 'codex', 'dsh'];

test('F7: a fresh machine is "pending" and nothing is configured', () => {
  dropConfig();
  assert.equal(setupState(), 'pending');
  for (const id of BUILTINS) {
    assert.equal(configuredAgent(id), false, `${id} must not be routable before the user confirms`);
  }
  const view = setupView();
  assert.equal(view.phase, 'pending');
  // issue #7 follow-up: the wizard no longer dumps every builtin on the user — a fresh machine
  // opens on an EMPTY list, with the four builtins parked in `templates` as add-able options.
  assert.deepEqual(view.candidates, [], 'nothing has been taken on yet');
  assert.deepEqual(view.templates.map((c) => c.id).sort(), [...BUILTINS].sort());
  // The three adapter-backed agents point at files under WORKSPACE_DIR, which is empty here, so
  // they are NOT detected — that is the "fresh clone without npm install" case the wizard exists
  // to make obvious. opencode is a PATH CLI, so its detection depends on the machine and is not
  // asserted here.
  for (const id of ['claude', 'codex', 'dsh']) {
    const c = view.templates.find((x) => x.id === id)!;
    assert.equal(c.detected, false, `${id} has no adapter package in an empty workspace dir`);
    assert.match(c.detection, /入口不存在|不可解析/);
  }
});

test('F7: the wizard shows what the user took on and offers the rest as add-able', () => {
  dropConfig();
  completeSetup({ codex: { confirm: true } });
  const view = setupView();
  assert.deepEqual(view.candidates.map((c) => c.id), ['codex'], 'a confirmed agent is listed without being added again');
  assert.equal(view.candidates[0].confirmed, true);
  assert.equal(view.candidates[0].configuredNow, true);
  assert.deepEqual(view.templates.map((c) => c.id).sort(), ['claude', 'dsh', 'opencode'],
    'the ones nobody spoke for stay options — an explicit rejection is a rejection, not a "re-add me"');
  // An agent that exists only because the USER wrote it into their config is theirs too: it is a
  // candidate, never an "option" the wizard offers back.
  saveSettings({ agents: { gemini: { confirmed: true, transport: 'acp', command: 'gemini', args: ['--acp'] } } });
  const after = setupView();
  assert.deepEqual(after.candidates.map((c) => c.id).sort(), ['codex', 'gemini']);
  assert.equal(after.templates.some((t) => t.id === 'gemini'), false);
  // A hand-written custom agent is a candidate even before `confirmed` is set (it is in their config).
  writeConfig({ agents: { mine: { transport: 'acp', command: 'node', args: ['x.js'] } }, setup: { completedAt: 'x' } });
  assert.deepEqual(setupView().candidates.map((c) => c.id), ['mine']);
});

test('F7: a pre-existing config is grandfathered (legacy), not revoked', () => {
  // A config written before this feature existed: no setup marker.
  writeConfig({ agents: {}, routing: {}, budget: {}, workspace: {} });
  assert.equal(setupState(), 'legacy');
  for (const id of BUILTINS) {
    assert.equal(configuredAgent(id), true, `legacy machine keeps working: ${id}`);
  }
  writeConfig({ agents: { codex: { confirmed: false } }, setup: { completedAt: 'x' } });
  assert.equal(configuredAgent('codex'), false, 'an explicit rejection wins even on a legacy machine');
});

test('F7: a legacy machine lists its in-use agents, so completing the wizard cannot revoke them', () => {
  // Regression, found while reviewing the console rebuild (PR #14): "taken on" was derived from
  // `confirmed`/own-config only, so a legacy machine's wizard opened EMPTY while four agents were
  // routable — and the completion that followed wrote `confirmed: false` for all of them,
  // revoking a machine that was working. Grandfathered-in-use is exactly "taken on".
  writeConfig({ agents: {}, routing: {}, budget: {}, workspace: {} });
  const view = setupView();
  assert.equal(view.phase, 'legacy');
  assert.deepEqual(view.candidates.map((c) => c.id).sort(), [...BUILTINS].sort());
  assert.deepEqual(view.templates, [], 'nothing is left to "add" — everything in use is already listed');
  for (const c of view.candidates) {
    assert.equal(c.confirmed, false, 'grandfathered is not the same as explicitly confirmed');
    assert.equal(c.configuredNow, true, 'but it IS usable right now (which is why it must be listed)');
  }
  // Completing with the listed agents confirmed is what the UI does by default; availability must
  // be unchanged afterwards.
  const keep: Record<string, { confirm: boolean }> = {};
  for (const c of view.candidates) keep[c.id] = { confirm: true };
  const merged = completeSetup(keep);
  assert.equal(setupState(), 'done');
  for (const id of BUILTINS) assert.equal(configuredAgent(id, merged), true, `still routable: ${id}`);

  // Re-opening the wizard (设置 → Agents → 重新运行首启向导) must not suspend a working machine
  // mid-sitting — `undefined + pending` is NOT routable, so the grandfathering is materialised as
  // explicit consent when the marker is cleared.
  writeConfig({ agents: {}, routing: {}, budget: {}, workspace: {} });
  assert.equal(setupState(), 'legacy');
  clearSetupMarker();
  assert.equal(setupState(), 'pending');
  for (const id of BUILTINS) assert.equal(configuredAgent(id), true, `wizard open, still routable: ${id}`);
  const reopened = setupView();
  assert.deepEqual(reopened.candidates.map((c) => c.id).sort(), [...BUILTINS].sort(),
    'the re-opened wizard shows what is in use, so completing it keeps them');
  const after = completeSetup(Object.fromEntries(reopened.candidates.map((c) => [c.id, { confirm: true }])));
  for (const id of BUILTINS) assert.equal(configuredAgent(id, after), true, `still routable after re-run: ${id}`);
});

test('F7: completeSetup confirms the picked agents and records the rest as declined', () => {
  dropConfig();
  const merged = completeSetup({ codex: { confirm: true }, claude: { confirm: false } });
  assert.equal(merged.setup?.completedAt !== undefined, true, 'the completion marker is what stops the wizard');
  assert.equal(setupState(), 'done');
  assert.equal(configuredAgent('codex', merged), true);
  assert.equal(configuredAgent('claude', merged), false, 'explicitly declined');
  assert.equal(configuredAgent('dsh', merged), false, 'builtins that were not picked are recorded as declined too');
  // "we asked and the user said no" must be distinguishable from "never asked".
  const raw = JSON.parse(readFileSync(USER_CONFIG_FILE, 'utf8'));
  assert.equal(raw.agents.dsh.confirmed, false);
});

test('F7: the legacy escape hatch closes once setup is completed', () => {
  dropConfig();
  completeSetup({ codex: { confirm: true } });
  assert.equal(setupState(), 'done');
  // A builtin the wizard never mentioned (e.g. added by a later release) must NOT be silently
  // grandfathered in: undefined + done = not confirmed.
  assert.equal(configuredAgent('opencode'), false);
});

test('F7: credential values are write-only — never echoed back', () => {
  dropConfig();
  const SECRET = 'sk-issue7-should-never-be-echoed';
  const merged = completeSetup({
    codex: { confirm: true, credentialRef: 'ACP_F7_KEY', credentialValue: SECRET },
  });
  assert.ok(!JSON.stringify(merged).includes(SECRET), 'merged settings must not carry the value');
  assert.ok(!JSON.stringify(setupView()).includes(SECRET), 'the wizard view must not carry the value');
  assert.equal(describeCredential('ACP_F7_KEY').configured, true);
  assert.equal(describeCredential('ACP_F7_KEY').source, 'secrets.env', 'stored in the write-only file');
  const secretsRaw = readFileSync(join(tmp, 'secrets.env'), 'utf8');
  assert.ok(secretsRaw.includes(SECRET), 'the value IS stored (in secrets.env)');
});

test('F7: completeSetup refuses malformed input and writes nothing', () => {
  dropConfig();
  assert.throws(() => completeSetup({ ['__proto__']: { confirm: true } }), SetupError);
  assert.throws(() => completeSetup({ ['constructor']: { confirm: true } }), SetupError);
  assert.throws(() => completeSetup({ ['a/b']: { confirm: true } }), SetupError);
  assert.throws(() => completeSetup({ nope: { confirm: true } }), /未知 agent/);
  assert.throws(() => completeSetup({ codex: { confirm: true, args: 'not-an-array' as any } }), /args/);
  assert.throws(() => completeSetup({ codex: { confirm: true, credentialRef: null, credentialValue: 'sk-x' } }), /凭据引用名/);
  assert.ok(!existsSync(USER_CONFIG_FILE), 'a rejected payload must not leave a config behind');
});

test('F7: rerunSetup re-opens the wizard but keeps the confirmations', () => {
  dropConfig();
  completeSetup({ codex: { confirm: true } });
  assert.equal(setupState(), 'done');
  rerunSetup();
  assert.equal(setupState(), 'pending', 'the wizard may be re-run from Settings');
  assert.equal(configuredAgent('codex'), true, 'existing confirmations survive a re-run');
});

test('F7: the agent switch is separate from consent', () => {
  dropConfig();
  completeSetup({ codex: { confirm: true } });
  saveSettings({ agents: { codex: { enabled: false } } });
  const merged = getMerged();
  assert.equal(configuredAgent('codex', merged), true, 'consent is unchanged by the switch');
  assert.equal(merged.agents.codex.enabled, false, 'but the switch still gates routing');
  clearSetupMarker();   // exercise the helper directly too
  assert.equal(setupState(), 'pending');
});

test('F7: saving other settings must not drop the consent flag', () => {
  // Regression: saveSettings used to replace a patched agent wholesale, so editing a model (or
  // anything else) in the console silently un-confirmed an agent the user had approved.
  dropConfig();
  completeSetup({ codex: { confirm: true }, claude: { confirm: true } });
  saveSettings({ agents: { codex: { defaults: { model: 'gpt-6.1-sol', effort: 'high' } } } });
  const merged = getMerged();
  assert.equal(merged.agents.codex.confirmed, true, 'confirmed survives an unrelated settings save');
  assert.equal(merged.agents.codex.defaults?.model, 'gpt-6.1-sol');
  assert.equal(merged.agents.claude.confirmed, true, 'other agents are untouched');
  // An explicit rejection is likewise preserved (and can only be flipped by re-confirming).
  writeConfig({ agents: { claude: { confirmed: false } }, setup: { completedAt: 'x' } });
  saveSettings({ agents: { claude: { defaults: { effort: 'max' } } } });
  assert.equal(getMerged().agents.claude.confirmed, false);
});
