# Agent Control Plane (v0.1.0, Phase 1)

把任意 coding-agent harness（opencode / Claude Code / Codex / DeepSeek Harness）
当作可控 subagent 调度：统一 spawn / ask / review / stop / status，支持按次指定
**model 与思考档位（effort）**，并支持基于**实际模型厂商**的异构约束。

零运行时依赖 —— Node 22 `--experimental-strip-types` 直接跑 TS。
规划文档：`D:\workb\multi-agent-orchestrator-plan.md`（v2.1 架构冻结版）。

## 架构（对应规划 §2）

```
主 Agent（任一 MCP 宿主） ──MCP──▶ Control Plane ──▶ Router（规则版）
                                                      │
                              ┌───────────────────────┴──────────────┐
                              ▼                                      ▼
                        ACPDriver（一份实现三份配置）        JSONProcessDriver（dsh）
                        opencode / claude / codex           dsh --profile headless --json
```

## 已验证状态（2026-10-07，Phase 2 后）

- E2E 真实往返：opencode 免费池 prompt → `stopReason=end_turn` ✅
- **长驻会话延续**：spawn(keepSession) 记住数字 → send 续问答出原数字（上下文在 agent 侧保持）✅
- 异构路由：`differentVendorFrom:["deepseek"]` 时 review 自动跳过 claude（本机 vendor=deepseek）✅
- **config setter 收敛**：对 adapter 源码核实 + 三家实测，统一为
  `session/set_config_option { sessionId, configId, value }`，8/8 设置+恢复成功。
  注意 codex 的 effort 项 id 是 `reasoning_effort`（plane 按 category=thought_level 动态解析）。
- MCP 冒烟：initialize / tools/list(6 工具) / tools/call(status) ✅

## Phase 4 新增

- **异构互审编排**（`src/review/review.ts` `plane.heteroReview`）：
  实现 → 交叉评审（按 **actual vendor** 强制异构，Router 自动选）→ 中立终验 → 共识判定 →
  分歧时第三方仲裁（仲裁者输入仅限两份 verdict，隔离上下文偏见）。
- **中立终验**（`src/review/verify.ts`）：`verifyCommands` 全部 exit 0 才算 done——
  LLM 无权宣布成功。E2E 实测中它抓住了实现者的虚报（"created" 但文件不存在）。
- MCP 新工具：`hetero_review` / `verify`（共 8 个）。
- E2E 实录（`tests/e2e-phase4.ts`）：deepseek(claude adapter) 在隔离 worktree 里用 TDD
  实现 calc.js → codex(openai) 实际运行测试后给出 approve verdict（还指出 NaN 规格边界）→
  node 中立终验通过 → consensus=verified。

**模型指令遵从差异（实测）**：verdict JSON 契约对 codex/openai 一次通过；deepseek-v4-flash
(dsh) 倾向输出 markdown 分析而忽略结尾 JSON 指令（重试也难救）——verdict 场景优先路由
到遵从度已验证的 agent，Registry 的 traits 字段未来纳入该维度。

## Phase 3 新增

- **Workspace 管理**（`src/workspace/manager.ts`）：`ask(workspaceMode:'worktree')` 为 agent
  建独立 `git worktree` + 分支 `acp/<agent>/<ts>`，结束自动清理（worktree 移除、分支保留）；
  `shared` 模式直用调用方 cwd。**worktree ≠ sandbox**（只隔离分支，不隔离 fs/网络/凭据）。
- **预算闸门**（`src/budget/budget.ts`）：per-day 请求/token 上限（`ACP_DAILY_REQUESTS` /
  `ACP_DAILY_TOKENS`，按天落盘 `state/budget-*.json`）；per-call `maxToolCalls` 硬闸
  （超限自动 session/cancel，stopReason=`budget_tool_calls`）。无 usage 数据的 agent 按请求计数兜底。
- **结构化 verdict 契约**（`src/core/verdict.ts`）：`ask(verdict:true)` 附加严格 JSON 输出指令，
  宽容抽取（fenced → 平衡括号 → 全文）+ 校验 + 失败自动重试一次；结果在 `result.verdict`。
  E2E 实测：免费池小模型一次通过（conclusion/risks/recommendation 结构完整）。
- MCP tools 同步暴露 `workspaceMode` / `verdict` / `maxToolCalls` 参数。

## Phase 2 新增

- `src/router/llm-router.ts`：规则未命中且未显式指定 agent 时，用 opencode(quick 规则, 防递归)
  把任务分类为 quick/code/reasoning/review 再路由；`ACP_LLM_ROUTER=0` 可关闭。
- `plane.send` + MCP `send_agent`：对 spawn_agent(keepSession) 创建的会话续发消息。
- Token usage 抽取：从 session/update 流宽容累加（opencode 免费池不回报 usage，字段留空）。
- models.json 细化 opencode 免费池 11 个模型的 vendor（确定标 inclusionai/meituan/xiaomi/nvidia，
  不确定的标 unknown，禁止臆测）。
- `plane.shutdown()`：退出前关闭所有 ACP 子进程（否则 Node 事件循环挂住）。

## 运行

```bash
# 端到端验收（真实调用 opencode）
node --experimental-strip-types tests/e2e-opencode.ts

# MCP 冒烟
node tests/mcp-smoke.mjs

# 启动 MCP server（给主 Agent 接入）
node --experimental-strip-types src/mcp/server.ts
```

接入 Claude Code（`.mcp.json`）示例：

```json
{ "mcpServers": { "agent-control-plane": {
    "command": "node",
    "args": ["--experimental-strip-types", "D:\\workb\\orchestrator\\acp\\src\\mcp\\server.ts"] } } }
```

## MCP Tools

| Tool | 说明 |
|---|---|
| `ask_agent` | 一次性任务：自动路由或指定 agent/model/effort/mode，返回最终答复 |
| `review_with` | 异构交叉评审：按 `excludeVendors`（实际厂商）强制选择不同厂商的 agent |
| `spawn_agent` | Phase 1 为 ask 别名（session 保留，Phase 2 支持后续 send） |
| `stop_agent` | 取消运行中的 prompt |
| `status` | 各 agent 传输层 / 凭据 / 模型表 / effort 档位 / actualVendor |

## 目录

```
src/core/      types.ts（类型） jsonrpc.ts（ndjson JSON-RPC 客户端）
src/drivers/   acp-driver.ts（一份实现三份配置；config setter 特性检测）
               dsh-driver.ts（headless --json 事件流，宽容解析）
src/registry/  registry.ts + models.json（粗粒度 tier/traits + actual_vendor）
src/router/    router.ts（规则表 + 能力过滤 + 异构约束 + fallback；LLM 路由 Phase 2）
src/control/   plane.ts（Router+Registry+Driver 组合）
src/mcp/       server.ts（手写 MCP stdio server）
tests/         e2e-opencode.ts / mcp-smoke.mjs
```

## 已知边界（Phase 3）

- dsh 端到端未验证（需 DeepSeek key）；`--json` 事件 schema 为宽容解析，实测后收紧
- codex / claude 的真实 prompt 往返需各自凭据（claude 本机已有，走的是 DeepSeek 映射）
- `session/set_config_option` 已收敛为 `{ sessionId, configId, value }`（三家源码+实测确认）；
  codex 的 effort 项 id 是 `reasoning_effort`，plane 按 category 动态解析
- opencode 免费池不回报 token usage（usage 字段为空）；预算按请求计数兜底
- worktree 只隔离 git 分支；`@automatalabs/codex-acp` 的 `_meta.outputSchema` 待 OPENAI key 实测后替换 prompt 约束方案
