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

## Phase 5 新增

- **原生批量编排**（`src/batch/parallel.ts` `plane.parallel` + MCP `parallel_agents`）：
  多个子任务 fan-out 并发执行（有界并发池，默认 3），每个 job 独立走完整 ask 链路
  （路由/fallback/预算/verdict/worktree），单 job 失败不拖垮批次；汇总 per-job 状态与
  合计 usage。E2E 实测（`tests/e2e-phase5.ts`）：dsh+codex+claude 三路并发 12.5s
  （串行需 23.6s），坏 cwd 任务独立失败、好任务正常完成。
- **为什么不是 fractal/CAO（实测结论，2026-10-07）**：
  - `plasma-fractal` 1.3.0 在原生 Windows **直接不可用**：CLI 导入链的 core 层
    （config.py / node.py / worktree.py）硬依赖 Unix-only 的 `fcntl.flock` 做内核级并发锁，
    tmux 渗透到 `core/loop.py`。no-op shim 会破坏其自身的并发安全保证，不予采用。
  - `awslabs/cli-agent-orchestrator` 强依赖 tmux，需 WSL2。
  - 结论：fractal 的核心价值（worktree 隔离 + 预算 + 层级树）已在本项目原生实现，
    "整树批处理"由 `parallel_agents` 承担；WSL2 内跑 fractal 作为未来可选路径，
    届时可通过同一个 Driver 抽象挂为第五个 backend。

## Phase 4 新增

- **异构互审编排**（`src/review/review.ts` `plane.heteroReview`）：
  实现 → 交叉评审（按 **actual vendor** 强制异构，Router 自动选）→ 中立终验 → 共识判定 →
  分歧时第三方仲裁（仲裁者输入仅限两份 verdict，隔离上下文偏见）。
- **中立终验**（`src/review/verify.ts`）：`verifyCommands` 全部 exit 0 才算 done——
  LLM 无权宣布成功。E2E 实测中它抓住了实现者的虚报（"created" 但文件不存在）。
- MCP 新工具：`hetero_review` / `verify`（共 8 个）。- E2E 实录（`tests/e2e-phase4.ts`）：deepseek(claude adapter) 在隔离 worktree 里用 TDD
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

## 界面设计：直接采用 DeepSeek Harness 的设计系统

设置页与整体视觉不是"仿"，是**照抄它的真实 token**（DeepSeek Harness 为 MIT 协议）：

- **设计 token 逐值复制**：深色基色 `#151517`、层级色 `#232324/#2c2c2e/#353638`、
  白色透明描边 `#ffffff0f ~ #ffffff33`、品牌蓝 `#4176e6/#5686fe`、状态色
  `#22c55e/#f7ad31/#f25a5a`、文字四级色阶、圆角阶 4/8/12/16/20/28px、
  **0.5px 描边阴影**（dsh 的标志性细节）、设置卡专用 token
  `--dsw-alias-settings-card-fill`。原始 token 归档在 `docs/dsh-tokens/`
- **字体**：Montserrat（dsh 自带，SIL OFL 协议），woff2 与许可证随仓库发布
  （`acp/src/web/fonts/`），服务端 `/fonts/*` 提供
- **布局与交互**：侧栏导航行（图标+标签+选中态）、一行一实体、一次只展开一张卡、
  暂存表单 + 已覆盖/恢复默认、只写凭据、状态灯二分
- **没有抄的部分**：它的 React/Cordis 组件代码——那些模块依赖整个 dsh 运行时
  （200+ 包），抄一个设置页等于要搬进 dsh 本身。本项目保持零依赖单页，
  只复用**设计语言**（视觉上一致，架构上独立）

## 设置中心（v3，P1-P3 已落地）

浏览器里**配置 agent**——不用再改代码/文件：

- **Agents 页**：每个 agent 一行（凭据状态灯 / 传输方式 / 启用状态），展开编辑
  （一次一张卡）：启用开关、命令与参数、**只写凭据**（值存 `state/secrets.env`，
  界面永不回显，来源优先级 env > secrets.env > 原生登录态）、默认模型/思考档位/模式、
  工具上限与超时、**🔌 探测能力**（initialize + session/new 握手，不耗 token，
  结果写回能力矩阵并即时生效——根治 auth 状态过期导致的静默路由错位）
- **自定义 Agent 接入**（P3）：「+ 添加自定义 Agent」表单（ID / 传输方式 / 命令 / 参数 /
  凭据引用）→ 保存即探测 → 出现在列表并可被路由——任何 ACP 兼容 agent（Gemini CLI、
  Kimi CLI、goose……）零代码接入
- **首次运行引导**（P3）：没有任何可用凭据时，Agents 页顶部显示引导横幅
- **保存即生效**：配置走四层合并（用户配置 > 环境变量 > 实测矩阵 > 代码默认），
  保存后新请求立即采用；禁用的 agent 被路由跳过，显式指定则直接报错（不静默改道）
- **校验**：非法值拒绝保存（400 + 字段级原因）；恢复默认 = 移除用户层覆盖
- 其余分区（P2 已落地）：
  - **Routing**：四类任务 → agent + 档位映射表（内置规则上标"默认"，改动即"已覆盖"，
    规则采用替换语义、删键即回退内置）；LLM 路由兜底开关。保存后真实生效（E2E 验证：
    quick 规则改指 dsh 后，任务确实路由到 dsh）
  - **Budget**：每日请求/token 上限图形化；今日用量 + 分 agent 请求计数 + 一键重置当日
  - **Workspace**：常用 cwd 列表（派任务自动记录、可删，控制台表单下拉同源）；
    worktree 基目录设置（含"不要放进含 package.json 的目录树"的提醒）
  - **集成**：一键生成并复制 MCP 接入片段（给 Claude Code / Codex 的 .mcp.json，含 env）
- 设计对标 DeepSeek Harness 的设置页（原则提取自其官方包文档，见计划文档 §1）

## 评审团队槽位（issue #10）

`hetero_review` 的分工从隐式变为**可配置**。模板按名字保存在用户配置里，派单时用 `team` 指定：

```json
{ "teams": { "strict": { "implementer": "codex", "reviewer": "claude", "arbiter": "auto" } } }
```

| 槽位 | 职责 | 约束 |
|---|---|---|
| `implementer` | 产出实现 | — |
| `reviewer` | 交叉评审 | **与实现者实际厂商异构**（fail-closed） |
| `arbiter` | 分歧仲裁 | 与**双方**都不同厂商（只看两份 verdict） |

- 未填/填 `auto` 的槽位 = 由 Router 按既有规则填充，**行为与当前完全一致**（不回归）。
- `verifier` **不是槽位**：客观终验是中性命令闸（`review/verify.ts`，exit 0 才算通过），不是 agent 评审。
- 指定的槽位必须**已确认启用**（issue #7 的确认门同样适用于模板）。
- 指定的 reviewer 与实现者同厂商、或自身厂商 `unknown` → **明确报错**：不静默改道，也不降级为自评。
- **预检在任何派单之前**：同厂商的模板会在实现者跑之前就被拒绝——否则错误会在已经花掉一次调用之后才出现。

不做「LLM leader 动态指派」：Router 本身是确定性规则路由，套一层领导者要么重复它、要么把不可验证的
判断变成新的单点（正是 issue #6 的教训）。

## dsh 运行形态（issue #9）

`--profile` 不再是硬编码字面量，默认仍是 `headless`：

| 优先级 | 来源 |
|---|---|
| ① 用户配置 | 设置页 Agents → dsh 的「运行形态 profile」，或首启向导里的同名输入 |
| ② 环境变量 | `DSH_PROFILE` |
| ③ 代码默认 | `headless` |

- profile 名在 spawn **之前**校验（字母/数字/`_`/`-`，且不得以 `-` 开头——否则 `--json` 这类 flag
  会落进 `--profile` 的值槽）。名字非法直接报错，不静默回退。
- 未知 profile 交给 dsh 自己拒绝，其报错**原样上抛**（不偷偷换回 headless）。
- 参数里**不要**再写 `--profile`：驱动会自己追加，重复会出现两个冲突的 flag，保存时即被拒绝。

**明确不支持**：用 `desktop` / `web` profile 驱动 dsh。这两个形态面向人类交互（GUI / 浏览器前端），
没有受 ACP 控制、可稳定管道化的结构化输出，接进 driver 只会引入脆弱的抓取层。若诉求是
「复用桌面版 dsh 已登录的账号 / 已有会话」，那属于凭据来源问题，应走 `src/config/auth-evidence.ts`
的原生登录态通道（见 issue #6），而不是换 profile。

## 首启向导与「确认」语义（issue #7）

**默认值反过来了**：装好 adapter 包不再等于同意运行它。本项目会真实 spawn 子进程、消耗额度、
并在你指定的仓库里执行命令，所以「装了就开」在这个威胁模型下太激进。

三个状态是**互相独立**的，别再混用：

| 状态 | 来源 | 含义 |
|---|---|---|
| `detected` | `src/config/detect.ts`（命令可解析 + 入口文件存在） | 这台机器**可能**能跑它（机器事实） |
| `configured` | **用户确认**（`agents.<id>.confirmed`） | 用户同意用它 —— **唯一允许进路由与 fallback 的状态** |
| `reachable` | `initialize + session/new` 握手 | 进程能起来（**不代表有凭据**，见 issue #6） |

- 全新机器（无用户配置）打开控制台即进入**首启向导**：候选全部预勾选（不损失开箱即用）、
  命令预填可改、凭据来源**由用户回答**（环境变量 / 现在填写写入 `secrets.env` / 使用它自身的
  登录态）、逐个握手探测（不耗 token），**显式确认后**才写入 `state/control-plane-config.json`。
- 未确认的 agent：显示为中性灰「未确认」，**不参与路由与 fallback**；显式指定时**报错并给出启用
  方式**（不静默改道）。
- 不做硬门禁：headless/MCP 场景没有已确认的 agent 时 **fail-loud** 并附配置指引，而不是静默
  使用全部 `detected` 项。
- **迁移**：已有 `state/control-plane-config.json` 的机器（本特性之前写入）判定为 `legacy` ——
  **不出现向导、行为完全不变**，也不要求补确认。想重新走一遍：设置 → Agents →「✦ 重新运行首启向导」
  （只清完成标记，确认结果保留，可随时取消）。

相关 API：`GET /api/setup`（状态 + 候选）、`POST /api/setup`（写入确认）、`POST /api/setup/rerun`。
`GET /api/agents` 额外返回 `detected` / `confirmed` / `configured` 与 `authState: 'unconfirmed'`。

## Web 控制台（Phase 5.5）

图形化操作页面：浏览器里看四家 agent 实时状态（transport / 认证 / 模型数 / 实际厂商警告）、
派单任务与批量任务（含 agent/model/effort/taskType/verdict/worktree/工具上限全部参数）、
实时作业列表（点开看回复原文、verdict、usage、原始 JSON）、今日预算用量。

**一键启动（推荐）**：双击 `acp/start-web.cmd`。它自动探测装有 adapter 包的 node workspace
（优先级 `WORKSPACE_DIR` > `acp/node_modules` > `%APPDATA%\npm` > managed node workspace >
仓库根；判据是该目录 `node_modules/` 下存在 `@agentclientprotocol` 或 `@deepseek-ai/dsh`），
启动服务，并在端口就绪后自动打开浏览器 —— 不需要手动设任何环境变量。

```bash
# 命令行等价用法（在 acp/ 目录下）
node scripts/start-web.mjs                      # 自动探测 WORKSPACE_DIR + 自动开浏览器
ACP_WEB_PORT=8888 node scripts/start-web.mjs    # 换端口
ACP_NO_OPEN=1 node scripts/start-web.mjs        # 只起服务，不开浏览器

# 想让四家 agent 全可用（自包含安装）：在 acp/ 里装一次依赖
npm install                                     # 装 optionalDependencies 里的三个 adapter

# 原始方式（自己指定 WORKSPACE_DIR）
WORKSPACE_DIR=C:\Users\me\.workbuddy\binaries\node\workspace npm run web
# 控制台地址 http://127.0.0.1:7777（端口可用 ACP_WEB_PORT 改）
```

> opencode 是 PATH 上的 CLI，默认命令就是 `opencode`（不再从 capability-matrix.json 读
> 某台机器的绝对路径）；需要时用环境变量 `OPENCODE_BIN` 覆盖（同 dsh 的 `DSH_BIN`）。
> 其余三家走 WORKSPACE_DIR 下的 node_modules，本机路径差异请写进 `state/control-plane-config.json`
> （设置页保存，已 gitignore），不要改 tracked 的 matrix。
>
> **Windows 上的 PATH 壳**：npm 全局安装的 `opencode` 是 `opencode`（无扩展名脚本）+
> `opencode.cmd` + `opencode.ps1` **三件套，没有 `opencode.exe`**。而 `spawn('opencode')`
> 会 ENOENT、直接 spawn `opencode.cmd` 会 EINVAL —— 只有经解释器（`cmd /c ...`）或真 `.exe`
> 才能跑。所以裸名在 **spawn 时**由 `src/core/resolve-cli.ts` 按 PATH 解析（优先 `.exe`，
> 其次 `.cmd`/`.bat` 并包一层解释器），解析不到就带修复提示报错。配置里因此可以保持可移植的
> `opencode`，不必写死机器路径。

- REST API：`GET /api/status`、`GET/POST /api/jobs`、`POST /api/jobs/clear`、`POST /api/ask`、`POST /api/parallel`
- **实时事件流**：driver 层 `onEvent` 回调 → 作业事件（模型输出块 / 工具调用 / 子任务完成）
  → UI 实时日志面板，运行中的作业不再是黑盒等待
- **历史落盘**：完成的作业追加到 `state/web-jobs.jsonl`，服务重启自动加载最近 60 条
- 易用性：快捷模板、表单参数 localStorage 记忆、状态/agent/搜索三重筛选、
  批量作业子任务进度 chips、一键复制回复、侧栏 agent 点击选中（含实际厂商警告）
- **只绑定 127.0.0.1**（作业在服务进程内存里执行真实 agent 调用，不要暴露到局域网/公网）
- 预算按天落盘不受影响
- E2E：`tests/e2e-web.ts`（拉起子进程服务端 → 静态页 / 状态 / 400 校验 / 真实 dsh 往返 / 事件流捕获）

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

## 外部审计修复（issue #2，2026-10-07）

队友在第二台 Windows 机器上对 `f651fcf` 做了验证，提了 10 条（F1–F10），全部核实成立并修复：

| # | 严重度 | 问题 | 修复 |
|---|---|---|---|
| F1 | P1 | `keepSession` 被接受后从未使用——`runAcp` 的 `finally` 无条件销毁会话，`spawn_agent`/`send_agent`/`stop_agent` 对 ACP agent 完全不可达 | `finally` 尊重 `keep`；`stop()` 负责 cancel + 回收（dsh 的 `stop` 也改为丢弃 resume 句柄） |
| F2 | P1 | 探测把观测结果写进**受版本控制**的矩阵，且失败也写、`command` 只留裸可执行文件（丢 argv） | declared/observed 分层：可观测事实写 `state/capability-observed.json`（gitignored），Registry 读 declared→observed；仅成功时写，且保留完整命令行 |
| F3 | P2 | 成功的作业仍渲染红色错误块（fallback trail 被塞进 `error`），all-failed 路径还重复打印 | trail 移入独立的 `fallbackTrail` 字段；前端只在 `!ok` 时渲染错误 |
| F4 | P2 | 每日预算用 **UTC 日**（UTC+8 下 08:00 重置），且长驻进程从不跨天滚动 | 改用本地日 + 在每个入口（checkRequest/record/stats/resetDay）做 `rollOver()` |
| F5 | P2 | worktree 清理只删目录不删分支，每次运行泄漏一个 `acp/<agent>/<ts>` | cleanup 追加 `git branch -D`（`keep:true` 时保留） |
| F6 | P3 | `setCredential` 重建 `secrets.env`，抹掉所有注释与空行 | 逐行保留，仅替换/删除目标键 |
| F7 | P3 | `extractVerdict` 只试第一个 `{...}`，前置示例块会遮蔽真正的 verdict 并浪费一次重试 | 扫描每个 `{` 的平衡块 |
| F8 | P3 | `isTransportError` 的 `/auth/i` 也匹配 `author`，内容级失败被误判为传输失败并跨厂商重试 | 收紧为 `\bauth\b`，并独立成 `src/core/transport-error.ts`（可单测） |
| F9 | P3 | `FALLBACK` 是硬编码内置列表，自定义 agent 永远无法成为 fallback 候选 | fallback 顺序从 registry 派生（内置保持稳定序，自定义 agent 其后） |
| F10 | P3 | agent id 校验只挡空白/斜杠，`__proto__`/`constructor`/`prototype` 可通过 | 白名单 `^[A-Za-z0-9_-]+$` + 保留名拒绝；`resetSettings` 只删自有键 |

回归：`test:unit` **47/47**（新增 F1 会话生命周期、F2/F4/F5/F6/F7/F8/F10 的锁定测试）、`tsc` 干净，
`e2e-settings` / `e2e-web` / `mcp-smoke` / `e2e-send` / `e2e-phase3` / `e2e-phase4` / `e2e-phase5` 全绿。
F1 用 `tests/fixtures/stub-acp-agent.mjs`（最小 ACP 桩，无凭据无网络）驱动，确保这条链不会再静默失效。

## 已知边界（Phase 3）

- dsh 端到端**已验证**（DeepSeek key 实测，`--json` 事件 schema 已收敛）
- codex / claude 的真实 prompt 往返已实测（claude 本机走的是 DeepSeek 映射）
- `session/set_config_option` 已收敛为 `{ sessionId, configId, value }`（三家源码+实测确认）；
  codex 的 effort 项 id 是 `reasoning_effort`，plane 按 category 动态解析
- opencode 免费池不回报 token usage（usage 字段为空）；预算按请求计数兜底
- worktree 只隔离 git 分支；`@automatalabs/codex-acp` 的 `_meta.outputSchema` 待 OPENAI key 实测后替换 prompt 约束方案
- 显式 `agent` 提示仍是硬约束（不可用即报错），因此其 `fallbackChain` 为空——这是刻意保留的
  安全属性（B5 审计决策），与 F9 修的是两件事
- `confirmed`（用户同意）与 `enabled`（开关）是两件事，都需要：前者只在向导/设置页里被用户写入，
  后者是「之后关掉」。**注意**：任何设置保存都必须保留 `confirmed`（曾经的整体替换会静默取消确认，
  `tests/unit/setup.test.ts` 已锁）
- 向导只做握手探测，**不做真实 prompt**；它也不能替你判断凭据是否有效（那由凭据证据层回答）
- 空 `WORKSPACE_DIR` 下 `claude/codex/dsh` 不会出现在候选里（`builtinDefaults()` 依赖它拼入口路径），
  启动时会以 `WORKSPACE_DIR is not set` 明确报错
