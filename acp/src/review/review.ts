// Heterogeneous review orchestration (Phase 4):
//   implement -> cross-vendor review (actual vendor, not adapter name) -> neutral verification
//   -> consensus -> optional third-party arbitration (input limited to the two verdicts).
import type { AgentId, AgentResult } from '../core/types.ts';
import { prepareWorkspace, type PreparedWorkspace } from '../workspace/manager.ts';
import { runVerification, type VerifyCommand, type VerifyResult } from './verify.ts';
import type { ControlPlane } from '../control/plane.ts';
import { getMerged } from '../config/settings.ts';

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

export async function heteroReview(plane: ControlPlane, opts: HeteroReviewOptions): Promise<HeteroReviewOutcome> {
  const implAgent: AgentId = opts.implementer
    ?? plane.route({ taskType: 'code' }).agent;

  // Workspace lifetime is owned HERE (whole loop), not per-ask — otherwise the
  // implementer's output would be destroyed before review/verification run.
  let ws: PreparedWorkspace | undefined;
  let effCwd = opts.cwd;
  if (opts.workspaceMode === 'worktree') {
    ws = await prepareWorkspace({ repoDir: opts.cwd, agent: implAgent, mode: 'worktree', baseDir: opts.worktreeBaseDir ?? getMerged().workspace.worktreeBaseDir ?? undefined });
    effCwd = ws.path;
  }

  try {
    return await runLoop(plane, opts, implAgent, effCwd);
  } finally {
    if (ws) await ws.cleanup();
  }
}

async function runLoop(plane: ControlPlane, opts: HeteroReviewOptions, implAgent: AgentId, effCwd: string): Promise<HeteroReviewOutcome> {
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
  try {
    review = await plane.review({
      task: [
        `原实现任务：${opts.task}`,
        opts.reviewIncludeOutput === false ? '' : `实现者的产出报告：\n${impl.text.slice(0, 4000)}`,
        '',
        `实现工作目录：${implWorkspacePath}（可直接读取文件核实）`,
        '请审查实现是否正确、完整、安全，并按要求的 JSON 格式给出 verdict。',
      ].filter(Boolean).join('\n\n'),
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
      arbitration = await plane.ask({
        taskType: 'reasoning',
        differentVendorFrom: bothVendors,
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
