# Fatfish Chat Attention (大肥鱼/蓝蓝 L0-L6 拟人陪伴连续性系统)

基于 DeepSeek Harness (`v0.2.2-rc.1`) + OneBot v11 插件体系构建的大肥鱼/蓝蓝**多人多话题关系注意力、共同经历结晶与拟人表达**全栈插件套件。

## 目录结构

- `plugin/`：核心插件源码与完整单测/端到端集成测试
  - `plugin/index.mjs`：Cordis/DSH 宿主装配入口与 `relationalAttention` 服务导出
  - `plugin/host-peer.mjs`：Electron `app.asar` 与离线 Node 双兼容惰性依赖解析器
  - `plugin/bridge/`：L0 身份锚点 `昵称(qq:userId)`、`[CQ:reply]` 引用富化与候选令牌管理
  - `plugin/attention/` & `plugin/engine.mjs`：L1 多人多话题舞台（`Topic Stage × Participant Cohort`）与意愿门控分类器
  - `plugin/projection/`：L2 KV-Cache 友好的 Epoch 锁定快照量化器与 `SharedEpisode` 经历结晶器
  - `plugin/store/`：L3 `node:sqlite` WAL + CJK FTS5 关系图谱、共同经历库与 `ScopeGate` 单向隐私门禁
  - `plugin/connectors/`：L4/L5 `dsh-feiyu-mood` 情感余温桥、`dsh-rewind` 回溯失效桥、`dsh-speak-up` 未完话题桥与外部记忆槽位
  - `plugin/tools/`：`focus_attention`（按需展开话题/经历/原文）与 `remember_relation`（受信任守卫保护的关系记录）
  - `plugin/expression/`：L6 拟人多气泡切分、打字呼吸延迟与多话题自动引用选择
- 插件架构与使用说明：[plugin/README.md](plugin/README.md)
- QQ 桥接接线契约：[plugin/bridge/INTEGRATION.md](plugin/bridge/INTEGRATION.md)
