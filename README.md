<br />

<div align="center">
  <h1>Agent Control Plane</h1>
  <p><strong>把任意 coding-agent harness 当作可控 subagent 调度</strong></p>
  <p>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/agent-control-plane-wfz/agent-control-plane?style=flat-square"></a>
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.6-43853d?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white">
    <img alt="Core dependencies" src="https://img.shields.io/badge/core%20dependencies-0-brightgreen?style=flat-square">
    <img alt="Status" src="https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square">
  </p>
  <p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>
</div>

<br />

---

Agent Control Plane（ACP）是一层位于**主 Agent** 与**各家 coding agent** 之间的控制面。
主 Agent（任何 MCP 宿主）通过 MCP 把 ACP 当工具用，ACP 再把 opencode / Claude Code /
Codex / DeepSeek Harness 这类 harness 当作子进程驱动 —— 统一
`spawn / ask / review / stop / status`，支持按次指定 **model 与思考档位（effort）**，
以及基于**实际模型厂商**的异构约束。

Control Plane 本体**零运行时依赖**：用 Node 22 的 `--experimental-strip-types` 直接运行
TypeScript，没有构建步骤。

## 架构

```
主 Agent（任一 MCP 宿主：Claude Code / Codex / OpenCode …）
│  MCP tools
▼
Agent Control Plane
├── Router              规则 → 能力过滤 → 异构约束 → LLM 兜底 → fallback
├── Capability Registry 数据源：capability-matrix.json + models.json
├── Workspace Manager   shared cwd / per-agent git worktree
├── Budget              per-call 工具上限 + per-day 请求 / token 上限
└── Review / Judge      异构交叉评审 + 中立终验 + 分歧仲裁
▼
Driver 层（统一接口，上层不感知传输差异）
├── ACPDriver           opencode acp / claude-agent-acp / codex-acp / …
└── DshDriver           dsh --profile headless --json
```

任何 ACP 兼容 agent —— Gemini CLI（`gemini --acp`）、Qwen Code、goose 等 —— 都能零代码接入。

**分层职责**：MCP 管「主 Agent 把 ACP 当工具」；Driver 管「ACP 把各家 agent 当子进程」；
中间这层加上「model/effort 注入 + Registry + Router」是本项目的自研面。
设计上不假设任何 agent 实现了什么 —— **一律特性检测**。

## 特性

- **统一 Driver 抽象** —— 一份 `ACP` 驱动实现三份配置，外加 `dsh` 的事件流驱动

- **智路由** —— 规则表 + 能力/配额过滤；规则未命中时由 LLM 兜底分类（`ACP_LLM_ROUTER=0` 可关）；失败走 fallback 链

- **异构强制** —— `differentVendorFrom` 按**实际厂商**判定而非 adapter 名，且 **fail-closed**（厂商不明时永不满足，宁可不用也不假异构）

- **工作区隔离** —— per-agent `git worktree` + 独立分支，结束后自动清理

- **预算闸门** —— per-call `maxToolCalls` 硬闸 + per-day 请求 / token 上限，超限自动 cancel

- **异构评审** —— 实现 → 交叉评审（强制不同厂商）→ 中立终验 → 共识判定 → 分歧仲裁（仲裁者只看两份 verdict）

- **中立终验** —— `verifyCommands` 全部 exit 0 才算通过，**LLM 无权宣布成功**

- **结构化 verdict** —— 附加严格 JSON 契约 + 宽容抽取 + 校验 + 失败自动重试

- **批量编排** —— 有界并发池 fan-out，单 job 失败不拖垮批次

- **Web 控制台与设置中心** —— 浏览器里配置 agent / 路由 / 预算 / 工作区，保存即生效

## 安装

需要 **Node ≥ 22.6**。

```bash
git clone https://github.com/agent-control-plane-wfz/agent-control-plane.git
cd agent-control-plane/acp
npm ci
```

`npm ci` 会装上 `optionalDependencies` 里的 adapter 包（`claude-agent-acp`、`codex-acp`、`dsh`）。
Control Plane 本体不依赖它们 —— 它们是真正去驱动 agent 时才需要的对等依赖。

## 快速开始

```bash
npm run typecheck   # 类型检查
npm run test:unit   # 单元测试
```

### 接入 MCP 宿主

```bash
npm run mcp         # 启动 stdio MCP server
```

在宿主（Claude Code / Codex 等）的 `.mcp.json` 中加入：

```json
{
  "mcpServers": {
    "agent-control-plane": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "/absolute/path/to/agent-control-plane/acp/src/mcp/server.ts"
      ],
      "env": {
        "WORKSPACE_DIR": "/path/to/workspace"
      }
    }
  }
}
```

> [!IMPORTANT]
> `env.WORKSPACE_DIR` 不能省 —— 缺了它，`claude` / `codex` / `dsh` 三个 adapter 的入口无法解析，
> 只有 `opencode`（走 PATH）可用。

> [!TIP]
> Web 控制台的「集成」页可以一键生成并复制这段配置（含 env），不必手写路径。

### 启动 Web 控制台

```bash
WORKSPACE_DIR=/path/to/workspace npm run web
# → http://127.0.0.1:7777
```

`WORKSPACE_DIR` 必须指向**装有 adapter 包 `node_modules/` 的目录** —— ACP 按
`join(WORKSPACE_DIR, 'node_modules')` 解析 adapter 入口。端口用 `ACP_WEB_PORT` 修改。

> [!WARNING]
> Web 控制台**只绑定 `127.0.0.1`**。作业会在服务进程内真实调用 agent，
> 不要把端口暴露到局域网或公网。

## MCP 工具

| Tool | 说明 |
| --- | --- |
| `ask_agent` | 一次性任务：自动路由或指定 agent / model / effort / mode，返回最终答复 |
| `spawn_agent` | 创建保留会话的 agent（配合 `send_agent` 续问） |
| `send_agent` | 对保留的会话续发消息 |
| `review_with` | 异构交叉评审：按 `excludeVendors`（实际厂商）强制选择不同厂商的 agent |
| `hetero_review` | 完整异构互审编排：实现 → 评审 → 中立终验 → 共识 → 仲裁 |
| `verify` | 客观终验：跑 `verifyCommands`，全 exit 0 才判通过 |
| `parallel_agents` | 批量并发派单（有界并发池） |
| `stop_agent` | 取消运行中的 prompt |
| `status` | 各 agent 传输层 / 凭据 / 模型表 / effort 档位 / actualVendor |

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `WORKSPACE_DIR` | — | 解析 adapter 包 `node_modules/` 的根目录 |
| `ACP_WEB_PORT` | `7777` | Web 控制台端口 |
| `ACP_STATE_DIR` | `state/`（仓库根） | 状态落盘目录：预算账本、作业历史、只写凭据、用户配置、探测观测值 |
| `ACP_BUDGET_DIR` | 同 `ACP_STATE_DIR` | 单独指定预算账本目录 |
| `ACP_LLM_ROUTER` | 开启 | 设为 `0` 关闭 LLM 兜底路由 |
| `ACP_DAILY_REQUESTS` | 不限 | 每日请求数上限 |
| `ACP_DAILY_TOKENS` | 不限 | 每日 token 上限 |
| `ACP_MATRIX_FILE` | `registry/capability-matrix.json` | 覆盖**声明事实**矩阵的读取位置（探测不会写这里，见 `ACP_OBSERVED_FILE`） |
| `ACP_OBSERVED_FILE` | `$ACP_STATE_DIR/capability-observed.json` | 探测产生的**观测事实**落盘位置；Registry 读「声明→观测」合并 |
| `DSH_BIN` | 由 `WORKSPACE_DIR` 推导 | `dsh` 入口 `bin.js` 路径；两者都缺时**报错**而非猜路径 |
| `DSH_NODE` | `process.execPath` | 运行 `dsh` 的 Node 可执行文件路径 |

多数配置也可以直接在 Web 控制台的设置中心里改，**保存即生效**（优先级：用户配置 > 环境变量 > 实测矩阵 > 代码默认）。
声明事实与观测事实分开：矩阵（`registry/`）随仓库走、人可编辑；探测结果落 `state/`（gitignored），
不污染受版本控制的文件。

## 项目结构

```
acp/           Control Plane 实现（TypeScript，零运行时依赖）
├── src/core/      类型定义、ndjson JSON-RPC 客户端、verdict 契约
├── src/drivers/   acp-driver.ts（一实现三配置）、dsh-driver.ts（headless 事件流）
├── src/registry/  registry.ts + models.json（tier / traits + actual_vendor）
├── src/router/    router.ts（规则 + 能力过滤 + 异构约束 + fallback）、llm-router.ts
├── src/control/   plane.ts（Router + Registry + Driver 组合）
├── src/review/    异构评审、中立终验
├── src/workspace/ git worktree 管理
├── src/budget/    per-call / per-day 预算闸门
├── src/batch/     有界并发批量编排
├── src/config/    settings / secrets / paths（状态目录） / 能力探测
├── src/mcp/       手写 MCP stdio server
├── src/web/       Web 控制台（单页 + 本地服务端 + 自带设计 token 与字体）
└── tests/         e2e-*.ts（逐阶段真实往返）与 unit/*.test.ts
docs/          规划与设计文档（PLAN.md 为架构冻结版规划）
phase0/        Phase 0 实测产物（适配器笔记、原始结果、通用 ACP 冒烟客户端）
registry/      capability-matrix.json —— 能力注册表的首份机器可读数据
```

## 已知边界

- **adapter 是可选对等依赖** —— Control Plane 本体零依赖，但真正驱动 agent 需要各家 adapter 包

- `registry/capability-matrix.json` 是**某台机器的实测快照**，其中的入口路径在别的机器上通常不存在。
  换机器请用设置中心的「🔌 探测能力」重新握手 —— 探测结果写进 `state/capability-observed.json`（不受版本控制），
  与本文件「声明事实」合并生效，不会改动仓库

- **`worktree` 不是沙箱** —— 它只隔离 git 分支，不隔离文件系统、网络与凭据。agent 进程可以执行任意命令，
  只在可信仓库使用，敏感目录不要进 workspace，绝不在无监督下把密钥暴露给 agent

- 部分 agent 不回报 token usage（如 opencode 免费池），预算按请求计数兜底

- ACP 仍是 Draft 规范，各 adapter 版本节奏不一 —— 只依赖 ACP Core，高级能力一律特性检测

## 文档

- [docs/PLAN.md](docs/PLAN.md) —— 架构冻结版规划：选型理由、关键事实核实、风险表
- [docs/WEB-V3-SETTINGS-PLAN.md](docs/WEB-V3-SETTINGS-PLAN.md) —— 设置中心设计
- [acp/README.md](acp/README.md) —— 逐 Phase 实现记录、实测结论与踩坑
- [phase0/adapter-notes.md](phase0/adapter-notes.md) —— 四家 harness 的实测细节

## 设计来源与致谢

Web 控制台的视觉不是「仿」某套 UI，而是逐值复制 **DeepSeek Harness** 的真实设计 token
（该项目为 MIT 协议）：基色、层级色、描边、状态色、文字色阶、圆角阶、0.5px 描边阴影等，
原始 token 归档在 [`docs/dsh-tokens/`](docs/dsh-tokens/)。字体使用 **Montserrat**
（SIL OFL 协议），woff2 与许可证随仓库发布。

没有复制的部分是它的 React / 组件代码 —— 那些模块依赖整个运行时。本项目保持零依赖单页，
只复用设计语言：视觉一致，架构独立。

## 贡献

欢迎提 Issue 与 PR。这个仓库由 [@wfz2006](https://github.com/wfz2006) 与
[@chromoany](https://github.com/chromoany) 共同维护，改动请走 Pull Request 而非直接推送 `main`。

## 许可证

[MIT](LICENSE) © 2026 wfz2006
