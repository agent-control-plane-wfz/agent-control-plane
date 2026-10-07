# 多 Agent 编排项目开发规划 v2.1 —— Agent Control Plane（架构冻结版）

> **v2.1（2026-10-07）**：第二轮外部评审（GPT）后**关键事实已独立核实**，风险降级，
> 架构定稿。**本文档为最终开发蓝图，架构讨论到此为止，下一步直接执行 Phase 0。**
> 版本沿革：v1"以 fractal 为核" → v2"Control Plane + ACP 底座" → v2.1 事实核实 + Driver 分层 + 架构冻结。
> 环境：Windows · Node 22/24（本机已有）· 单人业余开发。

---

## 0. 结论

1. **架构冻结**：主 Agent（任一 MCP 宿主）→ **Agent Control Plane**（Router / Registry /
   Budget / Workspace / Review）→ **Driver 层三分**（ACPDriver / JSONProcessDriver /
   CLIProcessDriver）→ 各家 agent。fractal / CAO = Phase 5 可选高级 backend。
2. **最大不确定性已解除（本轮核实）**：codex-acp 与 claude-agent-acp 均已原生支持
   model + effort 配置，"ACP 不暴露 model/effort" 从高风险降为已解决。
3. **技术选型：TypeScript / Node.js**。理由是生态事实而非偏好：claude-agent-acp、codex-acp、
   dsh、MCP TS SDK 全在 Node 生态；claude-agent-acp 要求 Node ≥22（本机满足）。
4. Phase 0 产出**机器可读的 `capability-matrix.json`**，直接成为 Capability Registry 的
   第一份数据——避免"文档知道、Router 不知道"的两套真相。
5. 量级：5~7 周；Phase 1 结束即有最小可用物，每阶段独立可停。

---

## 1. 关键事实核实记录（2026-10-07，本轮独立验证）

### codex-acp ✅ 全部属实（官方 npm 包 `@agentclientprotocol/codex-acp`，v2.1.1，2026-10-01 发布）

官方 README 明确支持：**Model、reasoning effort、fast mode、approval reviewer、
approval/sandbox mode 配置**。另发现比评审报告更多的好消息：

- **native ACP subagent sessions**（capability negotiation 之后启用，含独立子历史与
  root-routed 权限）——Codex 当 worker 时自身还能嵌套
- **goal extension**（session 级长期目标）、token usage 事件、`/review`、`/compact` 等
- 事件面覆盖：shell 命令、文件改动、权限请求、MCP 工具调用、终端输出、**推理过程**、
  计划、web 搜索、token 用量
- 生态 fork `@automatalabs/codex-acp` 额外提供 **turn 级结构化输出**（prompt 的
  `_meta.outputSchema` 约束最终回复）——**直接解决我们的结构化结果契约需求**，
  还有 session steering、live fork；功能均通过 `_meta` 特性检测协商

### claude-agent-acp ✅ 属实（`@agentclientprotocol/claude-agent-acp`，需 Node ≥22）

- session config options 含 **mode / model / effort**；实测（Parolsh 对 0.81 版）：
  effort 列表 `default/low/medium/high/xhigh/max`，**effort 选择器随模型切换同步**、
  不支持的组合会被清除——评审所述细节成立，无需自己实现 effort 生命周期
- 已知坑（评审未提，**Phase 0 必验**）：部分版本忽略 `~/.claude/settings` 的模型偏好，
  默认取 `supportedModels()[0]`——模型指定要走显式配置而非 settings
- 模式面：default / acceptEdits / plan / auto / bypassPermissions

### opencode ✅ 本机实测

`opencode v2.0.22`（`D:\npm-global\opencode.ps1`）已内建 `opencode acp`
（stdio JSON-RPC ACP server）——**Phase 0 第一刀零安装成本**。

### dsh ⚠️ 评审声称已核实、本文未独立复核 → Phase 0 首项验证

评审称 headless 支持 `--json`（newline-delimited 事件）与 `--session-id`（续会话）。
方向与官方"headless + JSON-RPC SDK + Python SDK"文档一致，具体 flag 名待跑通确认。

### ACP 扩张面（低成本加分项）

Gemini CLI（`gemini --acp`）、Qwen Code（`qwen --acp`）、Kilo、Goose 均有 ACP——
新增 agent 的边际成本≈写一段 agent 配置。

---

## 2. 定稿架构

```
主 Agent（Codex / Claude Code / OpenCode …任一 MCP 宿主）
   │  MCP tools：spawn_agent / ask_agent / review_with / parallel_agents / stop_agent / status
   ▼
Agent Control Plane（本项目，TypeScript）
   ├─ Router：规则 → 能力过滤 → 成本/配额过滤 → LLM（仅模糊区）→ Fallback
   ├─ Capability Registry：数据源 = capability-matrix.json（Phase 0 实测产出）
   ├─ Workspace Manager：shared cwd / per-agent worktree（worktree ≠ sandbox）
   ├─ Budget：per-call / per-day 上限，超限降档或停
   └─ Review / Judge：异构复审 + 客观终验 + 冲突仲裁
   ▼
Driver 层（统一接口，上层不感知传输差异）
   ├─ ACPDriver          → codex-acp / claude-agent-acp / opencode acp / gemini --acp …
   ├─ JSONProcessDriver  → dsh headless（--json 事件流 + --session-id 续会话）
   └─ CLIProcessDriver   → 未来不支持 ACP 的 agent（兜底，不追求架构纯洁性）

能力协商（正式入架构）：
  caps = await driver.initialize()
  if (caps.modelConfig)  …   // codex ✅ claude ✅
  if (caps.effortConfig) …   // codex ✅ claude ✅（选择器随模型同步）
  if (caps.sessionResume)…
  if (caps.subagents)    …   // codex 原生 ✅
  if (caps.outputSchema) …   // @automatalabs fork 的 _meta.outputSchema
不假设任何 agent 实现了什么——一律特性检测。
```

**分层职责**：MCP 管"主 Agent 把 Control Plane 当工具"；ACP / JSON / CLI Driver 管
"Control Plane 把各家 agent 当子进程"；中间这层 + 三样增量（model/effort 注入、
Registry、Router）是我们的全部自研面。

---

## 3. 两轮外部评审裁决汇总（存档）

### 第一轮（v1 → v2）
- 采纳：场景=会话内动态委托；G1 升级 Registry；路由分层；dsh 走 JSON stream
- 修正：Adapter 底座=ACP 不重造（评审盲点）；拒绝 0.97 式伪精确分数
- 保留：Phase 0 先跑真实现（定性为调研非绑定）；工作量如实标注

### 第二轮（v2 → v2.1）
- 采纳并核实：codex-acp / claude-agent-acp 的 model+effort 支持（§1 独立验证属实）
- 采纳：Driver 三分（不强求全 ACP）；capability negotiation 正式化；
  Phase 0 产出 capability-matrix.json；ACP 版本/扩展漂移列为新风险；TS/Node 选型
- 补充（评审未提）：`@automatalabs/codex-acp` 的 turn 级 outputSchema 正好实现
  结构化结果契约；claude-agent-acp 的模型偏好已知 bug 列入 Phase 0 必验；
  codex-acp 的 native subagent 能力
- 同意其结论：**停止架构讨论，进入执行**

---

## 4. 阶段计划（定稿）

### Phase 0 — 实测与能力矩阵，2~3 天
1. **codex-acp**：验证 model / effort / sandbox / approval / resume / cancel / streaming
   （`npx -y @agentclientprotocol/codex-acp`，需 ChatGPT 登录或 OPENAI_API_KEY）
2. **claude-agent-acp**：验证 model / effort / 模型切换同步 / 权限 / resume / cancel
   / 子代理事件（`npm i -g @agentclientprotocol/claude-agent-acp`，需 Claude 登录或
   ANTHROPIC_API_KEY）；**必验模型偏好 bug**
3. **opencode acp**（本机已就绪）：session / stream / 权限 / model 配置
4. **dsh**：`--json` 事件 schema、`--session-id`、interrupt、exit code、
   **Windows stdin/stdout 行为**（dsh 对 Windows PTY 有已知平台限制，headless 是否
   受影响必须实测）
5. **产出**：`adapter-notes.md`（人读）+ **`capability-matrix.json`**（机读，Registry 首份数据）：
   ```yaml
   codex:   { transport: acp, session: {resume: true, cancel: true, streaming: true},
              config: {model: true, effort: true, sandbox: true, approval: true} }
   claude:  { transport: acp, session: {resume: true, cancel: true, streaming: true},
              config: {model: true, effort: true} }
   opencode:{ transport: acp, ... }
   dsh:     { transport: json-process, session: {resume: TBD, streaming: TBD},
              config: {model: TBD} }
   ```
   认证门槛提前列明：codex 要 ChatGPT/OpenAI key，claude 要 Anthropic key，
   dsh 要 DeepSeek key——**需 wfz 提供账号或登录一次**。

### Phase 1 — Control Plane 骨架，1~2 周
- [ ] Driver 三类实现 + initialize() 能力协商（特性检测，不硬编码）
- [ ] MCP tool surface：spawn_agent / ask_agent / review_with / stop_agent / status
- [ ] dsh JSONProcessDriver（若 Phase 0 的 --json 属实则直用，否则走 JSON-RPC SDK）
- [ ] Registry v0：读 capability-matrix.json + models.yaml（粗粒度 tier/traits，不打分）

### Phase 2 — Router，1 周
- [ ] 规则表 + 能力过滤 + 成本/配额过滤；LLM 仅处理规则未命中的模糊区
- [ ] `different_provider_from` 异构约束；Fallback 链（次选 → 降 effort → 停）

### Phase 3 — Workspace / Budget / 结果契约，1 周
- [ ] shared cwd（咨询评审类）+ per-agent worktree（写码类）
- [ ] 硬预算（per-call / per-day）；结构化 verdict schema（优先试 codex fork 的
  outputSchema，不可用则 prompt 约束 + 解析校验）

### Phase 4 — Review / Judge，1~2 周
- [ ] 异构交叉评审（实现者 ≠ 评审者，强制不同厂商）；中立终验只认客观信号（测试/构建/lint）
- [ ] 冲突仲裁流（两份报告 + 只做仲裁的第三方，输入仅限两份报告）

### Phase 5 — 高级 backend 接入（可选，按需）
- [ ] fractal（整树自治批处理，`--headless` Windows 可跑）/ CAO（WSL2 多 worker 团队流）

---

## 5. 风险表（v2.1 定稿）

| 风险 | 等级 | 对策 |
|---|---|---|
| ~~ACP 不暴露 model/effort~~ | ~~高~~ → **已解除** | codex-acp / claude-agent-acp 均已原生支持（§1 核实） |
| **ACP 版本/扩展能力漂移**（v2 仍为 Draft；高级能力走 capability negotiation / AIR extensions / `_meta`，各 adapter 版本节奏不同） | **高（新晋首位）** | 只依赖 ACP Core（initialize / session new·resume·prompt·update·cancel）；一切高级能力特性检测；adapter 版本 pin + 升级回归 |
| claude-agent-acp 忽略 settings 模型偏好（部分版本默认 supportedModels()[0]） | 中 | Phase 0 必验；模型指定走显式 config option 不走 settings |
| agent 进程可任意执行命令、触及凭据（所有路线共有） | **高** | 只在可信 repo；敏感目录不进 workspace；后续容器/沙箱；绝不无监督跑含密钥环境 |
| dsh Windows 平台限制（PTY）+ 预览版破坏性变更 | 中 | Phase 0 实测 headless 是否受 PTY 限制；pin 精确版本；不行则 JSON-RPC SDK 替代 |
| Windows 无 tmux | 低 | 主路径 ACP（stdio）/ headless；CAO 仅 WSL2 |
| 单人业余，5~7 周战线 | 中 | Phase 1 结束即最小可用；每阶段独立可停；架构已冻结防范围蔓延 |
| Anthropic effort 中途调档击穿 prompt 缓存 | 低 | 路由规则：会话内不中途降档 |

---

## 6. 技术选型与代码骨架（定稿）

**TypeScript / Node.js**（生态事实：claude-agent-acp、codex-acp、dsh、MCP TS SDK 全在
Node；claude-agent-acp 硬性要求 Node ≥22，本机 22.22.2 / 24.15.0 均满足）。

```
agent-control-plane/
├─ src/
│  ├─ core/        session.ts / task.ts / result.ts
│  ├─ drivers/     acp/ / dsh/ / cli/     （三类 Driver + initialize 协商）
│  ├─ agents/      codex.ts / claude.ts / opencode.ts / dsh.ts
│  ├─ registry/    capability-matrix.json / models.yaml
│  ├─ router/      rules.ts / filters.ts / llm-router.ts / fallback.ts
│  ├─ workspace/   （shared / worktree）
│  ├─ budget/
│  ├─ review/      （异构复审 + 终验 + 仲裁）
│  └─ mcp/         （对上暴露 MCP tools）
└─ tests/
```

---

## 7. 立即行动（Phase 0 开工清单）

1. **opencode acp 冒烟**（零安装成本，本机 v2.0.22 已就绪）——起 ACP server，
   走 initialize/session/new/session/prompt 最小回路
2. 安装并验证 codex-acp、claude-agent-acp（**需要 wfz 配合登录一次**：ChatGPT / Claude）
3. dsh 冒烟：`npx @deepseek-ai/dsh --profile headless` + `--json` flag 核实（需 DeepSeek key）
4. 产出 `capability-matrix.json` v0（至少 opencode 一行真实数据 + 其余三行待验标记）
