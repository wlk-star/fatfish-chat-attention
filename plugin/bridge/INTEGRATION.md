# QQ 桥接与 L0-L6 关系注意力接线契约

本目录包含面向 OneBot v11 的两套解耦桥接组件：
1. `attention-candidates.js`：短期一次性候选令牌管理器与缓冲摘要去重（`createAttentionCandidateStore`、`attentionDigestItems`）。
2. `onebot-enrichment.mjs`：L0 永久身份锚点（`昵称(qq:userId)`）与引用链（`[CQ:reply,id=...]` / `seg.type === 'reply'`）解析与格式化工具（`normalizeParticipantId`、`extractReplySegment`、`formatIdentityTag`、`formatInboundLine`、`formatDigestLine`、`parseInboundLine`）。

## 1. L0 身份锚点与引用段入站契约

- **严禁仅凭群昵称识别身份**：所有 `renderInbound` 与 `renderDigest` 输出必须使用 `formatIdentityTag({ userId, nickname })` 渲染为 `昵称(qq:userId)`（无昵称时回退 `qq:userId`），确保群成员改名后仍与 L3 `Participant` / `RelationEdge` 永久绑定。
- **保留 `[CQ:reply]` 引用信息**：`mapOneBotMessage(event, selfId)` 必须通过 `extractReplySegment` 提取 `{ replyToMessageId, replyToUserId }`，并根据桥接已发送消息表判定 `replyToSelf`：
  - 群聊中若 `replyToSelf === true`（引用了蓝蓝/大肥鱼的消息），即使未显式 `@蓝蓝`，`decide()` 也应返回 `{ action: 'wake', reason: 'reply-to-self' }`。

仅在真实群消息通过群白名单后发布 `qq-bridge/inbound`：

```js
ctx.emit('qq-bridge/inbound', {
  transport: true,
  message: {
    groupId,
    userId,
    nickname,
    text,
    atSelf,
    messageId,
    replyToMessageId,
    replyToUserId,
    replyToSelf,
  },
  decision: { action: 'wake' | 'record' | 'drop', reason },
  candidateToken, // 仅 record 且真实消息 id 有效时提供
  at: Date.now(),
})
```

- 人工模拟、私聊、非白名单群和缺少消息 ID 的记录不得创建可消费候选。
- 普通消息必须**先完成缓冲落盘**，再发布 `record`，防止同一消息被原流程与注意力流程并发处理。
- 只传必要字段：不要传图片 URL、token、私聊历史或附件本体。
- 桥接仅在实际向 QQ 发送成功后发布 `qq-bridge/outbound`：`{ groupId, text, messageId }`。

## 2. 注意力唤醒与摘要去重

```js
ctx.on('qq-bridge/attention-wake', async ({ candidateToken }) => {
  const message = candidates.consume(candidateToken, msg => isStillAllowlisted(msg))
  if (!message) return
  await handleInbound(message, true, true)
})
```

- `candidateToken` 由桥接为真实入站消息签发，短期有效、一次性消费，并复核群白名单。
- 唤醒同一条消息时调用 `attentionDigestItems(bufferSnapshot, message, true)`，从历史摘要中剔除本轮主输入，避免重复展示。

## 3. L6 拟人分段发送与多话题自动引用（`relationalAttention` 服务联动）

桥接在 `sendToQQ` 出站阶段可按需读取 `ctx.get?.('relationalAttention')`：

1. **多话题防串线自动引用**：读取 `getActiveStage(sessionId)` 计算当前活跃话题数 `activeTopicCount = (focused ? 1 : 0) + warm.length`。当 `activeTopicCount >= 2` 或配置 `replyWithQuote === true` 时，通过 `humanizer.selectReplyQuoteId` 在首条气泡前附带 `{ type: 'reply', data: { id: targetMessageId } }`。
2. **自然多气泡呼吸感节奏**：对于纯文本回复（不含图片段），通过 `humanizer.splitIntoHumanBubbles(text)` 拆分为最多 3 条自然短句气泡，气泡间按 `humanizer.computeTypingDelayMs(bubble)` 等待拟人打字延迟，且绝不拆断代码块或 `[QQ]...[/QQ]` 包裹。

## 4. 安全与隔离检查清单

- **单向隐私门禁（`ScopeGate`）**：群聊会话（`group:*`）严禁读取 `private:*` 事实、经历或 `feiyu-mood` 情绪原因；私聊主人会话（`private:qq:1024162823`）可主动分享群内公开趣事。
- **Preset 工具注册铁律**：`focus_attention` 与 `remember_relation` 通过 `agent.ctx.tools.register` 按会话挂载，**严禁**写入 preset 的 `ctx.tools.restrict({ allow })`，仅加入 `ctx.tools.guard` 的 `permitted()` 与 `system-prompt/assemble` 的工具过滤白名单。
- **桌宠零污染**：仅对 `allowedSessions` 白名单会话挂载工具与上下文投影，桌宠会话（如 `fish-chat`）保持 `toolSchemaCount === 0`。
