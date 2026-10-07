# Web 控制台 v3：设置中心（对标 DeepSeek Harness）

> 起因：v2 控制台只能派任务，**没有任何配置 agent 的入口**——改模型、换默认档位、填 key、
> 开关某个 agent 都得手工改代码/文件。v3 补上配置面。
>
> 设计参照物：dsh 官方 Web UI（本机已装，`npx @deepseek-ai/dsh web` → 127.0.0.1:3080）。
> 其设置页的真实信息架构从以下已安装包的官方文档中提取（非猜测）：
> `dsh-client-ui-settings-shell` / `-settings-models` / `-settings-general` / `-settings-agent-loop`、
> `dsh-credentials` / `dsh-credentials-local`、`dsh-permission-presets`、`dsh-api-settings-controller`。

---

## 1. 从 dsh 学到的六条设计原则（逐条映射到我们的场景）

| # | dsh 的做法（已核实的原话要点） | 我们的落地 |
|---|---|---|
| 1 | **凭据值永不进配置**：settings 只存引用名（如 `DEEPSEEK_API_KEY`）；值是**只写**的，界面"绝不回显任何机密内容"，只能报告"是否已设置、来自哪里、能否写入" | `state/secrets.env` 为存储；`PUT /api/credentials/:name` 只写；`GET` 只返回 `{configured, source}`，永不返回值 |
| 2 | **状态灯二分**：只有**确认已配置**才绿点；只有**确认缺失**才红点；其余为未知（灰） | 每个 agent 的凭据行同样三态；来源区分 `env` / `secrets.env` / 原生配置（`~/.codex/auth.json`、`~/.claude`、dsh `.credentials.yaml`） |
| 3 | **暂存表单**：点保存前不写入任何东西；离开页面丢弃草稿；被覆盖的字段带**已覆盖**标签 + **恢复默认**；保存被拒时字段下说明原因 | 设置页采用同样的 staged form 模型（前端 draft + 显式保存 + 逐字段恢复默认） |
| 4 | **一行一实体，一次只展开一张卡片**：provider 行列表，展开的编辑器互不影响草稿 | Agent 行列表（opencode / claude / codex / dsh / 自定义），一次只展开一个编辑卡 |
| 5 | **模型目录可探测**：提供商卡片有"获取可用模型"按钮（`llm/discoverModels`），结果进**可搜索选择器**再落盘；模型行可编辑 id / 显示名 / contextWindow / maxTokens / 输入类型 | 每个 agent 卡片有"探测能力"按钮（复用 Phase 0 握手逻辑）→ 刷新模型列表与 effort 档位；模型行的 **vendor / tier** 可人工修订（写入 models 覆盖层，不臆测） |
| 6 | **诚实的局限声明**：dsh 明说"agent 工具进程以同一用户运行，无法向 agent 隔离机密" | 我们的设置页同样标注：`secrets.env` 对子 agent 进程可见（同用户），不要放进生产密钥 |

补充（权限预设）：dsh 把沙箱 + 审批打包成**具名预设**（未来的会话默认值），不匹配的组合显示为
`custom`。我们对应的是每个 agent 的**审批/沙箱默认模式**（codex 的 sandbox/approval、claude 的
permission mode），同样以预设下拉呈现，并允许 `custom`。

---

## 2. 设置中心的信息架构（v3 新增「设置」一级页）

```
控制台（现有）          设置（新）
├ 派任务                ├ Agents        ← 本次核心
├ 作业列表              ├ Routing
└ agent 侧栏            ├ Budget
                        ├ Workspace
                        └ 集成（MCP 片段）
```

### 2.1 Agents 页（核心）

```
┌ 模型与 Agent ─────────────────────────────────────────────┐
│ ● opencode   ACP · 已认证 · 11 模型 · 2 effort 档   [展开] │
│ ● claude     ACP · 凭据来自 ~/.claude · ⚠实际厂商 deepseek │
│ ○ codex      ACP · 已禁用（灰色行）                        │
│ ● dsh        JSON-process · 凭据来自 secrets.env           │
│ + 添加自定义 Agent（ACP 命令 / JSON-process CLI）          │
└───────────────────────────────────────────────────────────┘
展开后（一次只展开一个）：
  [启用开关]
  传输方式     ACP ▾ | JSON-process ▾
  命令         node D:\...\dist\index.js   （node 脚本 / 可执行文件）
  凭据         API 密钥 [___________] （只写，留空=不改动）
               状态：🟢 已配置（来源 secrets.env）   来源优先级见下
  默认模型     [gpt-6.1-sol[xhigh] ▾]   默认档位 [low ▾]   模式 [custom ▾]
  高级         maxToolCalls [ ]  timeoutMs [300000]
  [探测能力]   → initialize + session/new 握手，返回模型/档位/认证方式/延迟
  模型目录     每行：id · vendor [可改] · tier [可改] · 删除覆盖
  [保存]  [恢复默认]        （未保存前不写任何文件）
```

- **启用开关**：禁用后 Router 直接跳过该 agent（不再靠 capability-matrix 里的 auth 状态猜）
- **探测能力**：即时验证命令路径正确 + 凭据有效，结果写回能力矩阵（带时间戳）；
  这正是 v2 踩过的坑（auth 状态过期导致静默路由到别的 agent）的正解
- **模型目录可编辑**：只覆盖 vendor/tier 两个人工判断字段，模型 id 本身来自实测探测，
  不手填臆测
- **添加自定义 Agent**：命名 + 传输方式 + 命令/参数 + 凭据引用名 → 探测通过后即可被路由。
  ACP 生态（Gemini CLI、Kimi CLI、goose……）就此可以零代码接入

### 2.2 其余四页（范围小，可在 P2 一并做）

| 页 | 内容 |
|---|---|
| **Routing** | 四类任务（quick/code/reasoning/review）→ agent + effort 的映射表；异构约束开关；LLM 路由开关（`ACP_LLM_ROUTER` 图形化）；未知 vendor 的 fail-closed 策略说明 |
| **Budget** | 每日请求上限 / token 上限（现在是环境变量，改为配置项）；今日用量（含每 agent 分解）；重置按钮 |
| **Workspace** | 常用 cwd 收藏（控制台表单的 datalist 来源）；worktree 基目录；默认隔离模式 |
| **集成** | 一键生成并复制 MCP 配置片段（给 Claude Code / Codex 的 `.mcp.json`）；Web 端口与绑定说明 |

---

## 3. 技术设计

### 3.1 配置分层（关键：不污染"实测事实"）

现状混杂三处：`capability-matrix.json`（**实测事实**）、`models.json`（人工判断）、
环境变量（预算/开关）。v3 引入用户配置层，保持事实与偏好分离：

```
优先级由高到低：
  ① state/control-plane-config.json   ← 新：用户在设置页写的东西（gitignored）
  ② 环境变量                          ← 部署级覆盖（WORKSPACE_DIR 等）
  ③ capability-matrix.json            ← 实测事实（探测按钮写回，不被用户编辑绕过）
  ④ 代码内默认值
```

配置骨架：

```jsonc
{
  "agents": {
    "codex": {
      "enabled": true,
      "transport": "acp",                    // acp | json-process
      "command": "node", "args": ["D:\\...\\codex-acp\\dist\\index.js"],
      "credentialRef": "OPENAI_API_KEY",     // 只存引用名，值在 secrets.env
      "defaults": { "model": "gpt-6.1-sol", "effort": "low", "mode": "custom" },
      "limits": { "maxToolCalls": null, "timeoutMs": 300000 },
      "modelOverrides": { "gpt-6.1-sol[xhigh]": { "vendor": "openai", "tier": "frontier" } }
    }
  },
  "routing": { "rules": { "quick": { "agent": "opencode", "effort": "default" }, "...": {} }, "llmRouter": true },
  "budget": { "dailyRequests": 0, "dailyTokens": 0 },
  "workspace": { "recentCwds": ["D:\\workb\\orchestrator"], "worktreeBaseDir": null }
}
```

实现要点：
- `src/config/settings.ts`：加载/校验/合并上述四层；`plane` 每次 ask 时读（进程内缓存 + 显式 reload）
- `loadAcpConfigs()` 改为从合并配置读取（不再硬编码三家的路径拼装），自定义 agent 由此自然支持
- `secrets.env` 读写封装（`src/config/secrets.ts`）：写入即热生效（子进程 spawn 时读最新值），
  文件权限尽量收紧（Windows 上写明限制）

### 3.2 新增 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/settings` | 返回合并后的配置 + 每字段"来源/是否被覆盖"（供"已覆盖 + 恢复默认"UI） |
| PUT | `/api/settings` | 保存暂存草稿（整体或按 section），校验失败 → 400 + 字段级原因 |
| POST | `/api/settings/reset` | 按 section / 按字段恢复默认 |
| GET | `/api/agents` | 行列表数据：enabled / transport / 认证状态三态 / 来源 / 模型数 / vendor 警告 |
| POST | `/api/agents/:id/test` | 探测能力（握手 + 可选真实小 prompt），写回 capability-matrix，返回模型/档位/延迟 |
| PUT | `/api/credentials/:name` | **只写**；落 secrets.env 并热生效 |
| GET | `/api/credentials` | 仅返回 `{name, configured, source}` 数组，永不返回值 |
| DELETE | `/api/credentials/:name` | 清除（等于 dsh 的"清空字段并保存 = 重置"） |

### 3.3 安全边界（写进 UI 与 README，不含糊）

- 仅绑定 127.0.0.1；设置页顶部常驻提示
- 凭据只写不回显；日志与作业结果中的 key 一律不落盘（落盘前过滤 `sk-` 形态串）
- `secrets.env` 与子 agent 进程同用户可见——**不能隔离给 agent**（照抄 dsh 的诚实声明）
- 配置写入走原子写（临时文件 + rename），避免半截文件

---

## 4. 实施顺序（每阶段可独立验收、可停）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1（核心）** | 配置分层 + secrets 封装 + Agents 页（行列表 / 展开编辑 / 凭据只写 / 启用开关 / 默认模型档位 / 探测能力）+ 设置页骨架导航 | 改一次 codex 默认档位 → 控制台派任务时实际生效；粘一个假 key → 状态灯仍绿但探测失败并给出原因；禁用某 agent → 路由确实跳过 |
| **P2** | Routing / Budget / Workspace / 集成 四页；models.json 覆盖编辑；预算图形化 | 改路由规则后实际生效；预算上限触发时派任务被拒并有明确提示 |
| **P3** | 添加自定义 Agent（ACP 命令模板）+ 首次运行引导（照 dsh：首次打开若没有任何可用凭据，引导配置一个） + 深浅主题 | 用 Gemini CLI 或 Kimi CLI 实际接一个第三方 ACP agent 跑通一个 prompt |

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 配置改坏导致 plane 起不来 | 保存前 schema 校验；加载失败回退默认层并在 UI 顶部报错，不静默 |
| 凭据泄露进 git / 日志 / 作业历史 | secrets 与 config 均 gitignore；作业历史落盘前做 `sk-` 形态过滤；UI 不回显 |
| 探测按钮误触发计费 | ACP 的 initialize + session/new **不产生 token**（Phase 0 已实测），默认探测只做握手；真实 prompt 探测为可选项且提示计费 |
| agent 路径跨盘/中文路径 | 沿用 `WORKSPACE_DIR` 与绝对路径策略（v2 踩过的坑已记录） |
| 与 MCP 入口配置不一致 | 单一配置源：MCP server 与 Web 共用同一 `ControlPlane` 与配置文件 |

---

## 6. 与 dsh 的关系说明

- **只借信息架构与交互原则，不复制代码**：dsh 是"一切皆插件"的 Cordis 架构、React 客户端，
  与我们的零依赖单页控制台技术栈不同；照抄代码会引入整个运行时依赖。
- 可对照体验：dsh 官方 UI 已在 `<http://127.0.0.1:3080>`（token 在启动日志里）运行着，
  可以直接打开对照 Settings → Models 的交互。
- 若未来要更深度对标，可考虑把 dsh 作为第五个 backend（它本身有 ACP/SDK 入口），
  届时它的 Models 配置由它自己管，我们不重复造。
