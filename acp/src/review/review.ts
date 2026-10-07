// Heterogeneous review orchestration (Phase 4):
//   implement -> cross-vendor review (actual vendor, not adapter name) -> neutral verification
//   -> consensus -> optional third-party arbitration (input limited to the two verdicts).
import type { AgentId, AgentResult } from '../core/types.ts';
import { prepareWorkspace, type PreparedWorkspace } from '../workspace/manager.ts';
import { runVerification, type VerifyCommand, type VerifyResult } from './verify.ts';
import type { ControlPlane } from '../control/plane.ts';
import { getMerged, configuredAgent, type TeamTemplate } from '../config/settings.ts';

export type { TeamTemplate };

const AUTO = 'auto';

/**
 * Resolve a team template (issue #10). `team` is either a saved template NAME or an inline
 * template; unset slots default to 'auto', which reproduces today's Router-driven selection
 * exactly (nothing regresses for callers that do not use teams).
 */
export function resolveTeam(team?: string | TeamTemplate): Required<TeamTemplate> {
  const base: Required<TeamTemplate> = { implementer: AUTO, reviewer: AUTO, arbiter: AUTO };
  if (!team) return base;
  if (typeof team !== 'string') return { ...base, ...team };
  const teams = getMerged().teams ?? {};
  const t = teams[team];
  if (!t) {
    const names = Object.keys(teams);
    throw new Error(`unknown team template: ${team}（已保存的模板：${names.length ? names.join(', ') : '无'}）`);
  }
  return { ...base, ...t };
}

const pinned = (slot: string | undefined): AgentId | undefined =>
  slot && slot !== AUTO ? (slot as AgentId) : undefined;

export interface HeteroReviewOptions {
  task: string;
  cwd: string;
  implementer?: AgentId;             // default: routed by 'code' rule
  implementerModel?: string;
  implementerEffort?: string;
  implementerMode?: string;          // e.g. 'acceptEdits' for write tasks
  reviewerEffort?: string;
  workspaceMode?: 'shared' | 'worktree';
  worktreeBaseDir?: string;          // where worktrees live — MUST NOT be inside a dir with package.json (module-type inheritance)
  verifyCommands?: VerifyCommand[];  // neutral gate: must all exit 0
  arbitrateOnConflict?: boolean;
  timeoutMs?: number;
  reviewIncludeOutput?: boolean;     // include implementer text in review prompt (default true)
  /** issue #10: saved template name, or an inline template. Unset slots = 'auto' (today's behaviour). */
  team?: string | TeamTemplate;
}

export interface HeteroReviewOutcome {
  implementation: AgentResult;
  review?: AgentResult;
  arbitration?: AgentResult;
  verification?: VerifyResult;
  implementerVendor: string;
  reviewerVendor?: string;
  consensus: 'verified' | 'review_disputed' | 'verification_failed' | 'failed';
  detail: string;
}

/**
 * Pre-flight the team BEFORE anything is dispatched (issue #10). A pinned reviewer that turns out
 * to share the implementer's vendor, or that was never confirmed, must fail here — after the
 * implementer has already run, the error would arrive having spent quota on work we would discard.
 */
function planTeam(plane: ControlPlane, team: Required<TeamTemplate>, explicitImplementer?: AgentId) {
  const slots: Array<['implementer' | 'reviewer' | 'arbiter', AgentId | undefined]> = [
    ['implementer', pinned(explicitImplementer ?? team.implementer)],
    ['reviewer', pinned(team.reviewer)],
    ['arbiter', pinned(team.arbiter)],
  ];
  for (const [slot, id] of slots) {
    if (!id) continue;
    if (!plane.registry.get(id)) throw new Error(`团队模板的 ${slot} 指向未知 agent: ${id}`);
    if (!configuredAgent(id)) {
      throw new Error(
        `团队模板的 ${slot} 指向 agent '${id}'，但它尚未确认启用（见「设置 → Agents」或首启向导）。`
        + '未确认的 agent 不会被派单——这里明确报错而不是静默改道。',
      );
    }
  }

  const routed = pinned(explicitImplementer ?? team.implementer) ? undefined : plane.route({ taskType: 'code' });
  const implAgent: AgentId = pinned(explicitImplementer ?? team.implementer) ?? routed!.agent;
  const implVendor = plane.registry.actualVendor(implAgent, routed?.model);

  // Heterogeneity is FAIL-CLOSED for pinned slots too: 'unknown' cannot prove a different vendor,
  // and the same vendor would make the "cross review" a self-review.
  const vendorOf = (id: AgentId | undefined) => (id ? plane.registry.actualVendor(id) : undefined);
  const revVendor = vendorOf(pinned(team.reviewer));
  if (revVendor !== undefined) {
    if (revVendor === 'unknown') {
      throw new Error(`团队模板的 reviewer='${team.reviewer}' 实际厂商无法确认（unknown）：fail-closed 下无法证明异构，拒绝。`);
    }
    if (revVendor === implVendor) {
      throw new Error(
        `团队模板的 reviewer='${team.reviewer}' 与实现者 '${implAgent}' 实际厂商相同（都是 '${implVendor}'）：`
        + '拒绝执行——既不静默改道，也不降级为自评。',
      );
    }
  }
  const arbVendor = vendorOf(pinned(team.arbiter));
  if (arbVendor !== undefined) {
    if (arbVendor === 'unknown') {
      throw new Error(`团队模板的 arbiter='${team.arbiter}' 实际厂商无法确认（unknown）：fail-closed 下无法证明与双方异构，拒绝。`);
    }
    if (arbVendor === implVendor || arbVendor === revVendor) {
      throw new Error(`团队模板的 arbiter='${team.arbiter}' 与实现者或评审者同厂商（'${arbVendor}'）：仲裁者必须是第三方。`);
    }
  }
  return { implAgent, implVendor, routedModel: routed?.model };
}

export async function heteroReview(plane: ControlPlane, opts: HeteroReviewOptions): Promise<HeteroReviewOutcome> {
  const team = resolveTeam(opts.team);
  const plan = planTeam(plane, team, opts.implementer);
  const implAgent: AgentId = plan.implAgent;
  const teamResolved = { team, plan };
  void teamResolved;

  // Workspace lifetime is owned HERE (whole loop), not per-ask — otherwise the
  // implementer's output would be destroyed before review/verification run.
  let ws: PreparedWorkspace | undefined;
  let effCwd = opts.cwd;
  if (opts.workspaceMode === 'worktree') {
    ws = await prepareWorkspace({ repoDir: opts.cwd, agent: implAgent, mode: 'worktree', baseDir: opts.worktreeBaseDir ?? getMerged().workspace.worktreeBaseDir ?? undefined });
    effCwd = ws.path;
  }

  try {
    return await runLoop(plane, opts, implAgent, effCwd, team, plan.implVendor);
  } finally {
    if (ws) await ws.cleanup();
  }
}

async function runLoop(plane: ControlPlane, opts: HeteroReviewOptions, implAgent: AgentId, effCwd: string, team: Required<TeamTemplate>, implVendorPlanned: string): Promise<HeteroReviewOutcome> {
  // 1) Implement (shared mode against effCwd — worktree already prepared above).
  const impl = await plane.ask({
    task: opts.task,
    cwd: effCwd,
    agent: implAgent,
    model: opts.implementerModel,
    effort: opts.implementerEffort,
    mode: opts.implementerMode ?? 'acceptEdits',
    workspaceMode: 'shared',
      timeoutMs: opts.timeoutMs,
    keepSession: false,
  });
  const implVendor = plane.registry.actualVendor(implAgent, impl.model);
  const implWorkspacePath = effCwd;

  if (!impl.ok) {
    return {
      implementation: impl, implementerVendor: implVendor,
      consensus: 'failed', detail: `implementation failed: ${impl.error ?? impl.stopReason}`,
    };
  }

  // 2) Cross-vendor review — Router enforces different ACTUAL vendor.
  let review: AgentResult | undefined;
  let reviewerVendor: string | undefined;
  const reviewTask = [
        `原实现任务：${opts.task}`,
        opts.reviewIncludeOutput === false ? '' : `实现者的产出报告：\n${impl.text.slice(0, 4000)}`,
        '',
        `实现工作目录：${implWorkspacePath}（可直接读取文件核实）`,
        '请审查实现是否正确、完整、安全，并按要求的 JSON 格式给出 verdict。',
      ].filter(Boolean).join('\n\n');
  const pinnedReviewer = pinned(team.reviewer);
  try {
    // issue #10: a pinned reviewer is dispatched explicitly (its consent + heterogeneity
    // were pre-flighted in planTeam, before anything ran). No pinned slot -> the Router picks,
    // exactly as before.
    review = pinnedReviewer
      ? await plane.ask({
          agent: pinnedReviewer,
          taskType: 'review',
          task: reviewTask,
          cwd: implWorkspacePath,
          effort: opts.reviewerEffort,
          verdict: true,
          timeoutMs: opts.timeoutMs,
        })
      : await plane.review({
          task: reviewTask,
          cwd: implWorkspacePath,
          excludeVendors: [implVendor],
          effort: opts.reviewerEffort,
          verdict: true,
          timeoutMs: opts.timeoutMs,
        });
    reviewerVendor = plane.registry.actualVendor(review.agent, review.model);
  } catch (e: any) {
    // no heterogeneous candidate available — proceed with verification only
    review = undefined;
    reviewerVendor = undefined;
    if (opts.arbitrateOnConflict) {
      // noted in detail below
    }
  }

  // 3) Neutral verification — objective signals only.
  let verification: VerifyResult | undefined;
  if (opts.verifyCommands?.length) {
    verification = await runVerification(opts.verifyCommands, implWorkspacePath);
  }

  // 4) Consensus.
  let consensus: HeteroReviewOutcome['consensus'];
  let detail: string;
  const rec = review?.verdict?.recommendation?.toLowerCase() ?? '';
  const reviewerRejects = review?.verdict && (rec.startsWith('reject') || rec.startsWith('fix'));
  if (!verification) {
    consensus = reviewerRejects ? 'review_disputed' : 'verified';
    detail = reviewerRejects
      ? `reviewer (${reviewerVendor}) demands changes; no objective gate configured`
      : 'no objective gate configured; reviewer verdict stands';
  } else if (!verification.allPassed) {
    consensus = 'verification_failed';
    detail = `neutral gate FAILED: ${verification.results.find((r) => !r.passed)?.cmd} exit=${verification.results.find((r) => !r.passed)?.exitCode}`;
  } else {
    consensus = reviewerRejects ? 'review_disputed' : 'verified';
    detail = reviewerRejects
      ? `objective gate passed but reviewer (${reviewerVendor}) disputes -> arbitration available`
      : `objective gate passed (${verification.results.length} commands)`;
  }

  // 5) Arbitration — third vendor, input limited to the two verdicts (no code, no bias).
  let arbitration: AgentResult | undefined;
  if (consensus === 'review_disputed' && opts.arbitrateOnConflict && review?.verdict) {
    const bothVendors = [implVendor, reviewerVendor ?? implVendor];
    try {
      const pinnedArbiter = pinned(team.arbiter);
      arbitration = await plane.ask({
        // issue #10: a pinned arbiter is dispatched explicitly (pre-flighted as a third vendor).
        ...(pinnedArbiter
          ? { agent: pinnedArbiter }
          : { taskType: 'reasoning' as const, differentVendorFrom: bothVendors }),
        task: [
          '你是仲裁者。实现者与评审者就以下任务产生分歧。你的输入只有两份结论，不要臆测代码细节。',
          `任务：${opts.task}`,
          `实现方（vendor=${implVendor}）结论：${impl.text.slice(0, 1500)}`,
          `评审方（vendor=${reviewerVendor}）verdict：${JSON.stringify(review.verdict)}`,
          `客观终验：${verification ? (verification.allPassed ? '全部通过' : '失败') : '未配置'}`,
          '请给出最终裁决（按要求的 JSON verdict 格式）：以客观终验结果为最高依据，评审意见其次。',
        ].join('\n\n'),
        cwd: opts.cwd,
        verdict: true,
        timeoutMs: opts.timeoutMs,
      });
    } catch { /* arbitration optional */ }
  }

  return { implementation: impl, review, arbitration, verification, implementerVendor: implVendor, reviewerVendor, consensus, detail };
}
