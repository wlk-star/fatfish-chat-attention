import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractReplySegment,
  formatDigestLine,
  formatIdentityTag,
  formatInboundLine,
  normalizeParticipantId,
  parseInboundLine,
} from './onebot-enrichment.mjs'

test('normalizeParticipantId produces canonical qq:<id> and is idempotent', () => {
  assert.equal(normalizeParticipantId(1024162823), 'qq:1024162823')
  assert.equal(normalizeParticipantId(' 616860663 '), 'qq:616860663')
  assert.equal(normalizeParticipantId('qq:1024162823'), 'qq:1024162823')
  assert.equal(normalizeParticipantId('QQ:616860663'), 'qq:616860663')
  assert.equal(normalizeParticipantId(''), '')
  assert.equal(normalizeParticipantId(null), '')
  assert.equal(normalizeParticipantId(undefined), '')
})

test('extractReplySegment parses OneBot v11 array segments and CQ strings', () => {
  assert.deepEqual(
    extractReplySegment([
      { type: 'reply', data: { id: '987654', qq: '1024162823' } },
      { type: 'text', data: { text: '我也觉得' } },
    ]),
    { replyToMessageId: '987654', replyToUserId: '1024162823' },
  )

  assert.deepEqual(
    extractReplySegment([
      { type: 'reply', data: { id: -42001 } },
      { type: 'text', data: { text: '收到' } },
    ]),
    { replyToMessageId: '-42001', replyToUserId: null },
  )

  const senderMap = new Map([['55501', '616860663']])
  assert.deepEqual(
    extractReplySegment([{ type: 'reply', data: { id: 55501 } }], { lookupUserId: senderMap }),
    { replyToMessageId: '55501', replyToUserId: '616860663' },
  )

  assert.deepEqual(
    extractReplySegment('[CQ:reply,id=778899,qq=616860663][CQ:at,qq=999] 赞同'),
    { replyToMessageId: '778899', replyToUserId: '616860663' },
  )

  assert.deepEqual(
    extractReplySegment('[CQ:reply,id=778899] 单独引用无@'),
    { replyToMessageId: '778899', replyToUserId: null },
  )

  assert.deepEqual(
    extractReplySegment({
      message: [{ type: 'reply', data: { message_id: '3001', user_id: 1024162823 } }],
    }),
    { replyToMessageId: '3001', replyToUserId: '1024162823' },
  )

  assert.deepEqual(extractReplySegment([{ type: 'text', data: { text: '普通闲聊' } }]), {
    replyToMessageId: null,
    replyToUserId: null,
  })
  assert.deepEqual(extractReplySegment('普通闲聊'), {
    replyToMessageId: null,
    replyToUserId: null,
  })
  assert.deepEqual(extractReplySegment(null), {
    replyToMessageId: null,
    replyToUserId: null,
  })
})

test('formatIdentityTag preserves qq:<userId> across nickname changes', () => {
  const before = formatIdentityTag({ userId: '616860663', nickname: '源天帝' })
  const afterRename = formatIdentityTag({ userId: '616860663', nickname: '源某人改名啦' })
  assert.equal(before, '源天帝(qq:616860663)')
  assert.equal(afterRename, '源某人改名啦(qq:616860663)')
  assert.ok(before.includes('qq:616860663') && afterRename.includes('qq:616860663'))

  assert.equal(formatIdentityTag({ userId: '616860663', nickname: '', userName: 'Yuan' }), 'Yuan(qq:616860663)')
  assert.equal(formatIdentityTag({ userId: '616860663' }), 'qq:616860663')
  assert.equal(formatIdentityTag({ userId: '616860663', nickname: '616860663' }), 'qq:616860663')
  assert.equal(formatIdentityTag({ userId: 'qq:1024162823', nickname: 'kk(qq:1024162823)' }), 'kk(qq:1024162823)')
  assert.equal(formatIdentityTag({}), '未知')
})

test('formatInboundLine, formatDigestLine, and parseInboundLine roundtrip group and private lines', () => {
  const groupLine = formatInboundLine({
    groupId: '1135493428',
    userId: '616860663',
    nickname: '源天帝',
    text: '蓝蓝今晚吃烤肉吗？',
    replyToMessageId: '8801',
    replyToUserId: '1024162823',
  })
  assert.equal(
    groupLine,
    '[QQ · 群 1135493428] 源天帝(qq:616860663)：[回复#8801(qq:1024162823)] 蓝蓝今晚吃烤肉吗？',
  )

  const digestLine = formatDigestLine({
    userId: '1024162823',
    nickname: 'kk',
    groupName: '快乐一家人',
    text: '先去买生菜',
    replyToMessageId: '8800',
  })
  assert.equal(digestLine, 'kk(qq:1024162823)@快乐一家人: [回复#8800] 先去买生菜')

  const injectedFull = [
    '[QQ 未唤醒期间聊天记录（最近 1 条）：',
    digestLine,
    ']',
    groupLine,
    '（回 QQ 用 [QQ]…[/QQ]）',
  ].join('\n')

  const parsed = parseInboundLine(injectedFull)
  assert.deepEqual(parsed, {
    isQqInbound: true,
    isPrivate: false,
    where: '群 1135493428',
    groupId: '1135493428',
    userId: '616860663',
    speakerId: 'qq:616860663',
    nickname: '源天帝',
    replyToMessageId: '8801',
    replyToUserId: '1024162823',
    text: '蓝蓝今晚吃烤肉吗？',
  })

  const privateLine = formatInboundLine({
    userId: '1024162823',
    nickname: 'kk',
    text: '蓝蓝今天心情怎么样\n我想听你说说',
  })
  assert.equal(privateLine, '[QQ · 私聊] kk(qq:1024162823)：蓝蓝今天心情怎么样\n我想听你说说')
  const parsedPriv = parseInboundLine(`${privateLine}\n（回 QQ 用 [QQ]…[/QQ]）`)
  assert.equal(parsedPriv.isPrivate, true)
  assert.equal(parsedPriv.speakerId, 'qq:1024162823')
  assert.equal(parsedPriv.nickname, 'kk')
  assert.equal(parsedPriv.text, '蓝蓝今天心情怎么样\n我想听你说说')
})
