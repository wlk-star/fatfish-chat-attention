# Fatfish Relational Attention Suite (大肥鱼/蓝蓝 L0-L6 拟人陪伴连续性系统)

面向 DeepSeek Harness (`v0.2.2-rc.1`) + OneBot v11 的全栈**多人多话题关系注意力与陪伴连续性插件**（兼容原 `dsh-group-attention` 插件名与事件总线）。

## L0-L6 分层架构概览

```text
OneBot v11 (私聊 / 群聊)
  │
  ▼  L0 感知富化层 (bridge/onebot-enrichment.mjs + attention-candidates.js)
  │   - 永久身份锚点 `昵称(qq:userId)`（改群名片不丢人）
  │   - `[CQ:reply]` 引用链提取与引用蓝蓝自动唤醒
  ▼
  ├─► L1 实时多人话题舞台 (attention/multi-topic-engine.mjs + classifier.mjs + engine.mjs)
  │   - Topic Stage × Participant Cohort（区分焦点话题与温热挂起话题，保留全部参与人及其立场）
  │   - SubHeartflow 风格多话题分类与插话意愿门控
  │
  ├─► L2 KV-Cache 友好快照与经历结晶 (projection/snapshot-quantizer.mjs + episode-crystallizer.mjs)
  │   - Epoch 锁定的零动态时间戳快照（群聊 ≤450 tokens / 私聊 ≤150 tokens，同话题连续轮次字节级恒等）
  │   - 监听 `compaction/summary` 与温热话题归档，结晶为 `SharedEpisode`
  │   - 按需调用 `focus_attention` 通过 `tool/result` 展开挂起话题、共同经历或原始对话切片
  │
  ├─► L3 关系图谱与单向隐私门禁 (store/sqlite-repo.mjs + schema.mjs + tokenizer.mjs)
  │   - 基于 `node:sqlite` WAL + CJK 二元分词 FTS5（零原生编译依赖）
  │   - `Participant` + 时序双状态 `RelationEdge` + `Topic` + `SharedEpisode`
  │   - `ScopeGate` 硬隔离：`group:*` 绝不可读取 `private:*`；`private:qq:1024162823` 可感知群内公开高光
  │
  ├─► L4 情感余温投影与工具记忆守卫 (connectors/mood-connector.mjs + tools/remember-relation.mjs)
  │   - 私聊经历归档附带 `dsh-feiyu-mood` 情绪切片；群聊仅投射脱敏数值语气偏置（`careBias`），剥离私聊原因文本
  │   - `remember_relation` 强制信任分级：群友口述一律标为 `self_claimed_tentative`，禁止篡改核心亲属关系
  │
  ├─► L5 自主挂念与回溯同步 (connectors/speakup-connector.mjs + rewind-connector.mjs + memory-connector.mjs)
  │   - 精准过滤 `speak-up` / `runtime-context` 内部触发源，提供 `listOpenTopics` 未完话题目录
  │   - 监听全局 `session/event` 中 `source.kind === 'dsh-rewind'`，自动失效被回滚序号覆盖的经历与话题
  │
  └─► L6 拟人呼吸感表达层 (expression/humanizer.mjs)
      - 多话题并发时自动挂载 `[CQ:reply]` 引用回复防串线
      - 长句自然拆分为 1-3 条短气泡并模拟打字停顿，严格保护 `[QQ]...[/QQ]` 与代码块完整性
```

## 核心铁律（DSH v0.2.2-rc.1 适配）

1. **零 System Prompt 膨胀**：每轮仅注入紧凑静态目录快照，禁止塞入相对时间或滚动原文；细节一律由 `focus_attention` 走 `tool/result`（可被 `ToolResultPruner` 自动修剪）。
2. **桌宠零污染**：仅对 `allowedSessions` 显式白名单会话挂载工具与上下文投影，桌宠会话（如 `session-6e7760fd-1ac1-4387-a765-5b7d25697b10`）严格保持 `toolSchemaCount === 0`。
3. **Preset 工具白名单纪律**：`focus_attention` 与 `remember_relation` 注册在 `agent.ctx.tools` 上，**绝不能**放入 preset 的 `ctx.tools.restrict({ allow })`，仅加入 `ctx.tools.guard` 的 `permitted()` 与 `system-prompt/assemble` 过滤器。
4. **纯 Node 与 Electron 双环境可测**：`host-peer.mjs` 在 `apply()` 阶段惰性解析宿主依赖并提供离线测试回退，既支持本地 `node --test`，也支持宿主 `DeepSeek Harness.exe` 运行时测试。

## 测试命令

本地纯 Node（v22.5+ / v24+）：

```bash
node --test ./plugin/**/*.test.mjs ./plugin/**/*.test.js
```

Windows DSH Electron 宿主运行时：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'D:\dsh\DeepSeek Harness.exe' --test .\index.test.mjs .\integration.test.mjs .\bridge\attention-candidates.test.js .\bridge\onebot-enrichment.test.mjs .\store\sqlite-repo.test.mjs .\attention\multi-topic-engine.test.mjs .\tools\tools.test.mjs .\expression\humanizer.test.mjs
```
