# Phase 0 实测笔记 — ACP / headless 控制面（2026-10-07）

> 执行：大赢鲸 · 环境：Windows 11 · Node 22.22.2（管理版）
> 工具：`D:\workb\orchestrator\phase0\smoke-acp.mjs`（通用 ACP 冒烟客户端，ndjson JSON-RPC）
> 机器可读结论：`D:\workb\orchestrator\registry\capability-matrix.json`

## 一、总览

| Agent | 版本 | initialize | session/new | model 配置 | effort 配置 | 未登录可握手 | Windows |
|---|---|---|---|---|---|---|---|
| opencode acp | 2.0.22 | ✅ | ✅ | ✅ 11 个免费模型 | ✅ high/default | 已登录 | ✅ 原生 exe |
| claude-agent-acp | 0.86.0 | ✅ | ✅ | ✅ 5 项（含重映射） | ✅ 六档 default→max | ✅（本机已有凭据） | ✅ Node 直跑 |
| codex-acp | 2.1.1 | ✅ | ✅ | ✅ 7 模型 | ✅ 六档 low→ultra | ✅（auth 在 prompt 层） | ✅ Node 直跑 |
| dsh headless | 0.2.0-rc.2 | —（非 ACP） | —（--session-id） | TBD | TBD | 需 DeepSeek key | CLI 层 ✅ |

四家全部按预期工作，**Phase 0 无一否决项**。v2.1 规划的"ACP 不暴露 model/effort"风险
解除结论被实测再次确认，且比预期更丰富：**三家 ACP agent 全部把 model/effort 作为
session configOptions 暴露**，机制统一。

## 二、逐家细节

### opencode（本机已有，v2.0.22）

- `session/new` 直接返回 `configOptions`：**model / effort(category=thought_level) / mode**。
- effort 档位**随模型动态变化**（当前免费池只有 high/default 两档）——路由器必须
  按 model 查 effort 可选集，不能写死。
- sessionCapabilities：resume / fork / list / close / delete 全有；`loadSession: true`。
- 扩展：`opencode/child-session-updates`（子会话事件上报）。
- prompt 往返未测（留待 capability 探针 v2）。

### claude（claude-agent-acp v0.86.0）

- **本机 `~/.claude` 已有登录态**，`authMethods: []`，session/new 直接成功。
- configOptions 四项：mode（5 种权限模式）/ model / effort（六档）/ **agent（persona 选择）**。
- agentCapabilities：**subagents ✅**、**steering ✅**（`_meta.steering.supported`）、
  promptQueueing ✅、fork/list/close/delete/resume ✅、MCP http+sse ✅。
- ⚠️ **重大发现：模型重映射**。model 选项里 opus/sonnet/haiku 的显示名全是
  `deepseek-v4-flash`（"Custom Opus model" 等），仅 `claude-fable-5[1m]` 是真 Claude。
  说明本机 Claude Code 配置了自定义模型映射（ANTHROPIC_BASE_URL → DeepSeek 兼容端点）。
  **影响**：异构交叉评审的 `different_provider_from` 约束必须基于**实际模型厂商**，
  不能看 adapter 名——"claude adapter"现在实际上跑的是 DeepSeek 模型。

### codex（codex-acp v2.1.1，自带 @openai/codex 0.155.1）

- **未登录也能 initialize + session/new**（authMethods: api-key / chat-gpt），
  auth 拦截在 prompt 层——冒烟/能力探测成本极低。
- `models.availableModels`：42 个条目，格式 `modelId: "gpt-6.1-sol[xhigh]"`——
  **模型与档位在 modelId 里组合编码**；同时 configOptions 有独立的
  `model`（7 项）与 `reasoning_effort`（low/medium/high/xhigh/max/ultra 六档）。
- mode 四预设 = approval+sandbox 组合：read-only / workspace-write / agent / agent-full-access。
- fast-mode（on/off，1.5x 速度）、collaboration_mode（default/plan）。
- agentCapabilities：**subagents ✅**、fork/resume/list/close/delete ✅、
  additionalDirectories ✅。
- prompt 往返需要 OPENAI_API_KEY 或 ChatGPT 登录（待 wfz 提供）。

### dsh（v0.2.0-rc.2，JSONProcessDriver 唯一目标）

- 官方 help 实测证实：`--json`（**newline-delimited run events 到 stdout**）与
  `--session-id <id>`（**续持久化 Session**，未知 id 报错）；`-` 读 stdin；
  答案走 stdout / 诊断走 stderr——与 v2.1 规划的 JSONProcessDriver 设计完全吻合。
- 未实测 prompt（需 DeepSeek key）。Windows：CLI 层正常；PTY 能力受限是官方已知，
  headless 不依赖 PTY，预期可用。
- 安装注意：依赖树巨大（499 包，含 libreoffice-kit 等）；三包联装曾触发
  WorkBuddy 沙箱的 safe-delete 批量删除保护导致回滚，**单独安装成功**。

## 三、对规划的影响

1. **Driver 抽象可以更薄**：三家 ACP agent 的能力面高度对称（configOptions + 同一套
   sessionCapabilities），ACPDriver 可以做成"一个实现 + 三份配置"。
2. **effort 统一枚举可行**：codex 六档、claude 六档、opencode 按模型动态——
   Registry 按 agent+model 存"实际可选档位集"，Router 查询而非硬编码。
3. **异构判定改用模型厂商表**：Registry 需要加 `actual_vendor` 字段
   （本机 claude adapter 的 actual_vendor 当前 = deepseek）。
4. **capability-matrix.json 就是 Registry v0**，已落盘 `orchestrator/registry/`。
5. 剩余待测（需凭据）：codex prompt 往返（需 OPENAI key）、dsh headless 端到端
  （需 DeepSeek key）、各家的 session/update 事件流形状。

## 四、产物清单

- `phase0/smoke-acp.mjs` — 通用 ACP 冒烟客户端（复用于 capability 探针）
- `phase0/{opencode,claude,codex}-result.json` — 三家握手原始响应
- `phase0/{opencode,claude,codex}-log.txt` — 完整 ndjson 往返日志
- `phase0/dsh-help.txt`、`dsh-headless-help.txt` — dsh flag 核实记录
- `registry/capability-matrix.json` — 机读能力矩阵 v0（Registry 首份数据）
