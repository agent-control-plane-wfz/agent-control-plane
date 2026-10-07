# Phase 0 —— 实测与能力矩阵（存档）

这里是 Phase 0 的**原始实测产物**，为 `registry/capability-matrix.json` 提供可追溯的依据。

> [!NOTE]
> 本目录是**历史存档，不再维护**。结论已经沉淀到
> [`../registry/capability-matrix.json`](../registry/capability-matrix.json)（机读）与
> [`adapter-notes.md`](adapter-notes.md)（人读）。
> 其中记录的绝对路径只反映当时的实测环境，在别的机器上并不存在 ——
> 换机器请重新握手（Web 控制台设置中心的「🔌 探测能力」），或用 `ACP_MATRIX_FILE` 指向临时副本。

## 文件说明

| 文件 | 内容 |
| --- | --- |
| [`adapter-notes.md`](adapter-notes.md) | **人读**的 Phase 0 总结：四家 harness 的逐项实测结论 |
| [`smoke-acp.mjs`](smoke-acp.mjs) | 通用 ACP 冒烟客户端（ndjson JSON-RPC），Phase 0 的握手就是用它跑的 |
| [`opencode-result.json`](opencode-result.json) | opencode acp 的原始握手记录（initialize / session/new / config） |
| [`claude-result.json`](claude-result.json) | claude-agent-acp 的原始握手记录 |
| [`codex-result.json`](codex-result.json) | codex-acp 的原始握手记录 |
| [`codex-caps.txt`](codex-caps.txt) | codex-acp `initialize` 返回的能力原始 dump |
| [`setter-probe.json`](setter-probe.json) | config setter 形状探针：逐个试 `session/set_config_option` 的写法的结果 |
| [`dsh-e2e.txt`](dsh-e2e.txt)、[`dsh-e2e2.txt`](dsh-e2e2.txt) | 两次 dsh headless `--json` 事件流抓取 |
| [`dsh-help.txt`](dsh-help.txt)、[`dsh-headless-help.txt`](dsh-headless-help.txt) | `dsh --help` 与 `dsh --profile headless --help` 的输出存档 |
