<br />

<div align="center">
  <h1>Agent Control Plane</h1>
  <p><strong>Route any coding-agent harness as a controllable subagent</strong></p>
  <p>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/agent-control-plane-wfz/agent-control-plane?style=flat-square"></a>
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.6-43853d?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white">
    <img alt="Core dependencies" src="https://img.shields.io/badge/core%20dependencies-0-brightgreen?style=flat-square">
    <img alt="Status" src="https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square">
  </p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
</div>

<br />

---

Agent Control Plane (ACP) is a control layer that sits between a **host agent** and a set of
**coding agents**. The host (any MCP client) uses ACP as a tool over MCP; ACP in turn drives
harnesses such as opencode, Claude Code, Codex and DeepSeek Harness as child processes —
giving you a single `spawn / ask / review / stop / status` surface, **per-call model and
reasoning-effort control**, and heterogeneity constraints based on the **actual vendor**
behind each model.

The control plane itself has **zero runtime dependencies**: it runs TypeScript directly
through Node 22's `--experimental-strip-types`, with no build step.

## Architecture

```
Host agent (any MCP client: Claude Code / Codex / OpenCode …)
│  MCP tools
▼
Agent Control Plane
├── Router              rules → capability filter → heterogeneity → LLM fallback → failover
├── Capability Registry source: capability-matrix.json + models.json
├── Workspace Manager   shared cwd / per-agent git worktree
├── Budget              per-call tool cap + per-day request / token caps
└── Review / Judge      heterogeneous cross-review + neutral verification + arbitration
▼
Driver layer (one interface; upper layers never see transport differences)
├── ACPDriver          opencode acp / claude-agent-acp / codex-acp / …
└── DshDriver          dsh --profile headless --json
```

Any ACP-compatible agent — Gemini CLI (`gemini --acp`), Qwen Code, goose, … — plugs in with
zero code.

**Separation of concerns**: MCP covers "the host agent uses ACP as a tool"; the Driver layer
covers "ACP drives each agent as a child process". The layer in between — model/effort
injection, the Registry, and the Router — is what this project builds.
No agent is ever assumed to implement anything: **everything is feature-detected.**

## Features

- **Unified driver abstraction** — one `ACP` driver serving three configurations, plus an event-stream driver for `dsh`

- **Smart routing** — rule table + capability/quota filtering; an LLM classifier handles rules misses (`ACP_LLM_ROUTER=0` disables it); failures follow a failover chain

- **Enforced heterogeneity** — `differentVendorFrom` matches on the **actual vendor**, not the adapter name, and is **fail-closed** (unknown vendors never qualify — no fake heterogeneity)

- **Workspace isolation** — per-agent `git worktree` with its own branch, cleaned up afterwards

- **Budget gates** — a hard per-call `maxToolCalls` cap plus per-day request/token caps; exceeding either cancels the session

- **Heterogeneous review** — implement → cross-review (forced different vendor) → neutral verification → consensus → arbitration on disagreement (the arbiter sees only the two verdicts)

- **Neutral verification** — all `verifyCommands` must exit 0; **an LLM cannot declare success**

- **Structured verdicts** — strict JSON contract, lenient extraction, validation, one automatic retry

- **Batch orchestration** — bounded-concurrency fan-out; one failed job never sinks the batch

- **Web console and settings center** — configure agents, routing, budget and workspaces in the browser; saves take effect immediately

## Installation

Requires **Node ≥ 22.6**.

```bash
git clone https://github.com/agent-control-plane-wfz/agent-control-plane.git
cd agent-control-plane/acp
npm ci
```

`npm ci` installs the adapter packages listed under `optionalDependencies`
(`claude-agent-acp`, `codex-acp`, `dsh`). The control plane does not depend on them —
they are peer dependencies you need only when actually driving an agent.

## Quickstart

```bash
npm run typecheck   # type check
npm run test:unit   # unit tests
```

### Wiring it into an MCP host

```bash
npm run mcp         # start the stdio MCP server
```

Add this to your host's `.mcp.json` (Claude Code, Codex, …):

```json
{
  "mcpServers": {
    "agent-control-plane": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "/absolute/path/to/agent-control-plane/acp/src/mcp/server.ts"
      ]
    }
  }
}
```

> [!TIP]
> The **Integrations** page in the web console generates and copies this snippet
> (including env) for you — no need to hand-write paths.

### Running the web console

```bash
WORKSPACE_DIR=/path/to/workspace npm run web
# → http://127.0.0.1:7777
```

`WORKSPACE_DIR` must point at a directory whose `node_modules/` contains the adapter
packages — ACP resolves adapter entry points via `join(WORKSPACE_DIR, 'node_modules')`.
Change the port with `ACP_WEB_PORT`.

> [!WARNING]
> The web console binds to **`127.0.0.1` only**. Jobs really invoke agents inside the
> server process, so do not expose the port to your LAN or the public internet.

## MCP tools

| Tool | Description |
| --- | --- |
| `ask_agent` | One-shot task: auto-routed or pinned to an agent / model / effort / mode; returns the final answer |
| `spawn_agent` | Create a session-retaining agent (pair with `send_agent` for follow-ups) |
| `send_agent` | Send a follow-up message to a retained session |
| `review_with` | Heterogeneous cross-review: forces a different vendor via `excludeVendors` (actual vendor) |
| `hetero_review` | Full heterogeneous loop: implement → review → neutral verification → consensus → arbitration |
| `verify` | Objective verification: runs `verifyCommands`; passes only if all exit 0 |
| `parallel_agents` | Batched dispatch with a bounded concurrency pool |
| `stop_agent` | Cancel an in-flight prompt |
| `status` | Per-agent transport / auth / model table / effort levels / actualVendor |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `WORKSPACE_DIR` | — | Root used to resolve adapter package `node_modules/` |
| `ACP_WEB_PORT` | `7777` | Web console port |
| `ACP_STATE_DIR` | `acp/state` | State directory (budget, job history, write-only credentials) |
| `ACP_LLM_ROUTER` | on | Set to `0` to disable LLM fallback routing |
| `ACP_DAILY_REQUESTS` | unlimited | Daily request cap |
| `ACP_DAILY_TOKENS` | unlimited | Daily token cap |
| `ACP_MATRIX_FILE` | `registry/capability-matrix.json` | Capability matrix read/write location |
| `DSH_BIN` | auto-detected | Path to the `dsh` executable |
| `DSH_NODE` | auto-detected | Path to the Node executable used to run `dsh` |

Most of these can also be edited in the web console's settings center, where **saves take
effect immediately** (precedence: user settings > environment > measured matrix > code defaults).

## Repository layout

```
acp/           Control plane implementation (TypeScript, zero runtime dependencies)
├── src/core/      types, ndjson JSON-RPC client, verdict contract
├── src/drivers/   acp-driver.ts (one implementation, three configs), dsh-driver.ts (headless event stream)
├── src/registry/  registry.ts + models.json (tier / traits + actual_vendor)
├── src/router/    router.ts (rules + capability filter + heterogeneity + failover), llm-router.ts
├── src/control/   plane.ts (Router + Registry + Driver)
├── src/review/    heterogeneous review, neutral verification
├── src/workspace/ git worktree management
├── src/budget/    per-call / per-day budget gates
├── src/batch/     bounded-concurrency batch orchestration
├── src/config/    settings / secrets / capability probing
├── src/mcp/       hand-written MCP stdio server
├── src/web/       Web console (single page + local server + bundled design tokens and fonts)
└── tests/         e2e-*.ts (per-phase live round-trips) and unit/*.test.ts
docs/          Planning and design docs (PLAN.md is the frozen architecture plan)
phase0/        Phase 0 measurements (adapter notes, raw results, generic ACP smoke client)
registry/      capability-matrix.json — the registry's first machine-readable dataset
```

## Known limitations

- **Adapters are optional peer dependencies** — the control plane is dependency-free, but driving an agent requires its adapter package

- `registry/capability-matrix.json` is a **measurement snapshot from one machine**, and the entry paths in it usually do not exist elsewhere.
  On a new machine, re-handshake via the **Probe capabilities** button in the settings center, or point `ACP_MATRIX_FILE` at a temporary copy

- **A worktree is not a sandbox** — it isolates git branches only, not the filesystem, network or credentials. Agent processes can run arbitrary
  commands; use this only on trusted repositories, keep sensitive directories out of the workspace, and never expose keys to an agent unsupervised

- Some agents do not report token usage (e.g. opencode's free tier); budgets fall back to request counting

- ACP is still a Draft specification and adapters move at different speeds — ACP Core only, with everything else feature-detected

## Documentation

- [docs/PLAN.md](docs/PLAN.md) — frozen architecture plan: technology rationale, fact-checking, risk table
- [docs/WEB-V3-SETTINGS-PLAN.md](docs/WEB-V3-SETTINGS-PLAN.md) — settings center design
- [acp/README.md](acp/README.md) — per-phase implementation log, measurements and gotchas
- [phase0/adapter-notes.md](phase0/adapter-notes.md) — detailed measurements for all four harnesses

## Acknowledgements

The web console's visual language is not an imitation of another UI — it copies the real
design tokens of **DeepSeek Harness** (MIT licensed) value for value: base and elevation
colors, borders, status colors, text scale, radii, the signature 0.5px hairline shadow.
The original tokens are archived in [`docs/dsh-tokens/`](docs/dsh-tokens/). Typography uses
**Montserrat** (SIL OFL); the woff2 files and license ship with the repository.

What is *not* copied is Dsh's React/component code — those modules depend on its entire
runtime. This project stays a zero-dependency single page and reuses only the design
language: consistent visuals, independent architecture.

## Contributing

Issues and pull requests are welcome. This repository is maintained by
[@wfz2006](https://github.com/wfz2006) and [@chromoany](https://github.com/chromoany);
please send changes through a pull request rather than pushing to `main` directly.

## License

[MIT](LICENSE) © 2026 wfz2006
