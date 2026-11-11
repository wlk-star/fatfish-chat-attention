# QQ 桥接接线契约

本目录只包含独立的候选令牌管理器，不包含整套 QQ 桥接。把本插件接到其他桥接前，必须实现并测试以下契约。

## 入站事件

仅在 OneBot 的真实群消息通过该桥接自己的群白名单后发布：

```js
ctx.emit('qq-bridge/inbound', {
  transport: true,
  message: {groupId, userId, nickname, text, atSelf, messageId},
  decision: {action: 'wake' | 'record' | 'drop', reason},
  candidateToken, // 仅 record 且真实消息 id 有效时提供
  at: Date.now(),
})
```

- 人工模拟、私聊、非白名单群和缺少消息 ID 的记录不得创建可消费候选。
- 唤醒消息可在正常投递时发布，普通消息必须**先完成缓冲落盘**，再发布 `record`，防止同一消息被原流程与注意力流程并发处理。
- 只传必要字段：不要传图片 URL、token、私聊历史或附件本体。
- 桥接仅在实际向 QQ 群发送成功后，发布 `qq-bridge/outbound`：`{groupId, text}`；注意力层用其补充蓝蓝的短期上下文。

## 注意力请求

```js
ctx.on('qq-bridge/attention-wake', async ({candidateToken}) => {
  const message = candidates.consume(candidateToken, msg => isStillAllowlisted(msg))
  if (!message) return
  await handleInbound(message, true, true)
})
```

`candidateToken` 必须由桥接为真实入站记录生成，短期有效、一次性消费，不能由请求方提供任意消息或目标。`handleInbound` 的注意力路径仍须复用原来的群白名单、会话映射、图片、模型和出站限制，不得绕开权限或直接发消息。

## 去重

为缓冲条目记录 `sourceMessageId`。注意力唤醒同一条消息时，调用 `attentionDigestItems(bufferSnapshot, message, true)`，从摘要排除当前消息；当前消息仍正常作为本轮输入。成功投递后按原有快照语义清理对应缓冲，失败则保留，避免漏消息。

## 部署前检查

- 确认群聊使用独立会话与人格，私聊记忆不会被注入群会话。
- 明确其他机器人是否列入忽略名单，测试冷却、批次合并和日预算。
- 测试分类器超时、消息并发、重连、候选过期/重放及白名单撤销。
- 默认使用 `dryRun: true`，观察决策后再开启实际群回复。
