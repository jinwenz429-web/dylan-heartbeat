# Persona Continuity Guard（角色连续性保护）

只检测**可观察的**角色连续性断裂（突然自称通用 AI 助手、否认既有关系、模板化免责声明），不声称识别上游的任何内部机制。
正常检测是纯代码（正则 + 上下文特征 + 状态机），**不增加任何 API、不额外调用模型**。

## 实际调用链（按代码确认）

```
Kelivo ──/v1/chat/completions──▶ Dylan(server.js) ──TARGET_API_URL──▶ Pawwake(main.py) ──▶ Gemini
           每轮都带完整历史           时间线 enhanced_messages.json        conversations 表 / 记忆提取 / 分区摘要
                                     ▲ wake_up.js 读时间线做心跳、日记      ▲ /internal/dylan-diary
```

- 正式聊天历史：Kelivo 本地保存，每轮整段重发；Dylan 只维护时间线文件，Pawwake 在 Postgres 里另存一份。
- 长期记忆写入：只有 Pawwake（`process_memories_background` → `extract_memories`）。
- 后台消费 assistant 回复：Dylan 的心跳/日记（读时间线），Pawwake 的记忆提取、分区摘要、对话召回。
- 工具调用由 Kelivo 在客户端执行，Dylan/Pawwake 只转发。

## 分工

| 组件 | 负责 |
|---|---|
| **Dylan** | 检测（`persona_guard.js`）、恢复状态机（`persona_recovery.js`）、隔离指纹（`persona_quarantine.js`）、入站剔除已隔离回复、时间线/心跳保护、诊断日志 |
| **Pawwake**（补丁） | 记忆写入闸门：漂移回复不进 `conversations`、不提取记忆；可疑/安全拒绝本轮不提取；恢复轮把被采纳的回复接到原 user 消息后；摘要输入过滤 |
| **Kelivo** | 不改。限制见下文 |

两边共用 `persona_guard_rules.json` 和 `test/fixtures/persona_guard_cases.json`，判定逻辑一一对应，指纹算法有跨语言测试向量。

## 判定

| 状态 | 条件 | 动作 |
|---|---|---|
| `CONFIRMED_DRIFT` | 自称 AI / 否认关系（强信号）**且**另有至少一类信号，或身份信号总分 ≥5 | 隔离 → 自动恢复 |
| `SUSPECTED_DRIFT` | 单一身份信号，或身份+助手腔，或助手腔 ≥3 分 | 只记日志；Pawwake 本轮不提取记忆 |
| `SAFETY_REFUSAL` | 上游 finish_reason/拦截，或回复里有“拒绝请求”的表述 | 原样保留，**永不重试、不换模型** |
| `UNKNOWN` | 空回复、工具调用轮 | 不干预 |
| `NORMAL` | 其余 | — |

不会误判的情形：用户自己在聊 AI/问“你有感情吗”、用户要求出戏（OOC）、技术讨论、语气变化、单句客气话。
**本体向角色**：如果最近的 assistant 历史里角色自己常说“作为 AI”，自称 AI 不算断裂（只看关系否认）。也可用 `PERSONA_GUARD_AI_SELF_AWARE_PERSONA=true/false` 强制。

## 恢复流程（单轮）

`QUARANTINED → REGENERATING（原样重发 1 次）→ CONTEXT_REPAIR（只在找到可确认问题时：历史里残留的漂移回复、system 顺序错位、重复消息）→ FALLBACK（默认关）→ RECOVERED / RECOVERY_FAILED`

- 额外请求最多 3 次；额外 token 预算、恢复总超时可配；任一步出现安全拒绝立即停止并采纳拒绝；上游报错立即停止。
- 不改用户问题、不改提示词、不插入任何新指令。
- 有工具调用的轮次不检测、不重生，所以不会重复执行有副作用的操作（被丢弃的尝试从未到达客户端）。
- `RECOVERY_FAILED`：`passthrough`（默认）把原回复交给客户端，它已在服务端隔离，下一轮不会进上下文；`error` 则返回 `persona_recovery_failed`，由你手动重新生成。不会伪造回复。

## 流式（SSE）

- **默认：直通 + 旁路检测**。字节原样转发、零额外首字延迟；结束后检测，确认漂移只做服务端隔离（下一轮从上下文和时间线剔除）。**这一模式下不会自动重生**，因为已经发出去的内容无法在不改 Kelivo 协议的前提下替换。
- **缓冲模式** `PERSONA_GUARD_BUFFER_STREAM=true`：整条回复先在服务端检测/恢复，再一次性发给 Kelivo。可以自动替换，但首字延迟 = 整条生成时间（恢复时再加一次）。
- 不插入任何 Kelivo 不认识的 SSE 事件；状态只通过响应头 `X-Persona-Guard-State` 暴露（缓冲/非流式模式）。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PERSONA_GUARD_ENABLED` | `false` | 总开关；关闭时所有代码路径与原来一致 |
| `PERSONA_GUARD_MODE` | `conservative` | `observe`＝只检测/隔离/记日志，不发任何额外请求 |
| `PERSONA_GUARD_GEMINI_ONLY` | `true` | 只对模型名含 gemini 的请求生效 |
| `PERSONA_GUARD_AUTO_REGENERATE` | `true` | 单独关闭自动重生 |
| `PERSONA_GUARD_MAX_REGENERATIONS` | `1` | 上限被代码钳在 1 |
| `PERSONA_GUARD_CONTEXT_REPAIR` | `true` | |
| `PERSONA_GUARD_FALLBACK_ENABLED` / `_MODEL` / `_API_URL` / `_API_KEY_ENV` | 关 / 空 | 只能用已配置的模型；`_API_KEY_ENV` 填**已有**环境变量的名字，不需要新 key |
| `PERSONA_GUARD_BUFFER_STREAM` | `false` | |
| `PERSONA_GUARD_FAILURE_MODE` | `passthrough` | 或 `error` |
| `PERSONA_GUARD_MAX_EXTRA_REQUESTS` | `3` | |
| `PERSONA_GUARD_EXTRA_TOKEN_BUDGET` | `60000` | |
| `PERSONA_GUARD_RECOVERY_TIMEOUT_MS` | `120000` | |
| `PERSONA_GUARD_CHECK_WAKE` | `true` | 心跳回复确认漂移时不推送、不写日记 |
| `PERSONA_GUARD_DIAGNOSTICS` | `true` | 写 `DATA_DIR/persona_guard_log.jsonl`（不含正文） |
| `PERSONA_GUARD_LLM_JUDGE_ENABLED` | — | 预留，第一版不实现 |

Pawwake 侧：`PERSONA_GUARD_ENABLED`、`PERSONA_GUARD_GEMINI_ONLY`、`PERSONA_GUARD_AI_SELF_AWARE_PERSONA`、`PERSONA_GUARD_KEEP_QUARANTINED_TEXT`（默认 false，不存正文）。

## 新增数据

- Dylan：`DATA_DIR/persona_quarantine.json`（指纹 + 规则，最多 300 条）、`persona_guard_log.jsonl`（≤1000 行）。
- Pawwake：新表 `persona_guard_quarantine`（`CREATE TABLE IF NOT EXISTS`，仅在 guard 开启时创建；不改已有表）。

诊断：`GET /admin/persona-guard`（管理页 Basic Auth）返回最近 100 条检测记录和隔离条目数。

## 部署顺序与灰度

1. 先部署 Pawwake 补丁（guard 关闭），确认原功能正常。
2. 部署 Dylan（guard 关闭），跑一天确认无变化。
3. 两边 `PERSONA_GUARD_ENABLED=true`，Dylan `PERSONA_GUARD_MODE=observe`。看 `/admin/persona-guard` 一周：统计 `CONFIRMED_DRIFT` 里有没有误判。
4. 误判率可以接受后，Dylan 改 `PERSONA_GUARD_MODE=conservative`；需要自动替换流式回复时再开 `PERSONA_GUARD_BUFFER_STREAM`。

## 回滚

- 一键关闭：两边 `PERSONA_GUARD_ENABLED=false` 并重启。隔离文件/表保留但不再被读取。
- 代码回滚：revert 本分支的合并提交即可；新表可以留着，也可 `DROP TABLE persona_guard_quarantine;`。

## 性能

- 检测：一次正则扫描，几十微秒到 1 毫秒级；7 千字回复的测试上限是 50ms。无网络请求。
- 入站过滤：Dylan 读一个小 JSON；Pawwake 多一次带索引的小查询（仅 guard 开启时）。
- 正常聊天：0 额外 token。最坏情况（缓冲/非流式且全部失败）：额外 3 次完整生成，受 `EXTRA_TOKEN_BUDGET` 与超时约束。
- 内存：流式旁路最多缓存 4MB/请求，结束即释放。

## 已知限制 / 可能的误判

- 隐性语义漂移（语气慢慢变冷但没说任何断裂句）第一版识别不了。
- 用户消息里只要提到 AI/模型等字眼，身份类信号就整体豁免 —— 这时真漂移会漏判（有意为之）。
- 刻意写“AI 自我怀疑”剧情时，角色说“我们之间并不存在真实的关系”仍可能被判漂移；可临时 OOC 或关 guard。
- 默认流式模式下 Kelivo 仍会显示那条漂移回复（只是服务端已隔离，下一轮不会影响）；要在客户端替换需要缓冲模式，或之后改 Kelivo 识别 `X-Persona-Guard-State`。
- Pawwake 的恢复轮协调是单进程内存表；多实例部署时退化为“可能多存一条 user 消息”。
- 用户在 Kelivo 手动重新生成、且新回复被判漂移时，Pawwake 保留旧的那一轮。
