import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeTypingDelayMs,
  extractQqMarkerBody,
  selectReplyQuoteId,
  splitIntoHumanBubbles,
} from './humanizer.mjs'

test('extractQqMarkerBody extracts [QQ]...[/QQ] cleanly and strips stray wrapper tags', () => {
  assert.equal(
    extractQqMarkerBody('先想一下怎么接话...\n[QQ]在呢爸爸！刚吃完草莓～[/QQ]'),
    '在呢爸爸！刚吃完草莓～',
  )

  assert.equal(
    extractQqMarkerBody('[QQ]第一句气泡[/QQ]\n中间草稿\n[QQ]第二句气泡[/QQ]'),
    '第一句气泡\n第二句气泡',
  )

  // Unclosed [QQ] marker recovery
  assert.equal(extractQqMarkerBody('[QQ]哎呀忘写闭合标签啦'), '哎呀忘写闭合标签啦')

  // Intentional silent empty [QQ][/QQ]
  assert.equal(extractQqMarkerBody('[QQ]   [/QQ]'), '')

  // Plain text without markers stays intact
  assert.equal(extractQqMarkerBody('普通文本直接发'), '普通文本直接发')
})

test('splitIntoHumanBubbles keeps short 1-sentence replies as 1 bubble', () => {
  const shortOne = splitIntoHumanBubbles('[QQ]嗯嗯，爸爸下班路上注意安全哦！[/QQ]')
  assert.deepEqual(shortOne, ['嗯嗯，爸爸下班路上注意安全哦！'])

  const commaClause = splitIntoHumanBubbles('我今天在家里乖乖看书呢，没有乱跑哦。')
  assert.equal(commaClause.length, 1)
  assert.equal(commaClause[0], '我今天在家里乖乖看书呢，没有乱跑哦。')
})

test('splitIntoHumanBubbles splits multi-sentence & newline replies into 1..3 natural bubbles without leaking [QQ]', () => {
  const multi =
    '[QQ]哈哈源弟弟刚才在群里又吹牛说自己十连双金了！结果截图发出来全是蓝天白云，笑死我啦。爸爸你快去看他笑话呀！[/QQ]'
  const bubbles = splitIntoHumanBubbles(multi, { maxBubbles: 3, targetLen: 36 })

  assert.ok(bubbles.length >= 2 && bubbles.length <= 3)
  for (const b of bubbles) {
    assert.doesNotMatch(b, /\[\/?QQ\]/i)
    assert.ok(b.length > 0)
  }
  assert.equal(bubbles.join(''), extractQqMarkerBody(multi))

  // Explicit newline splits naturally even when short, capped by maxBubbles
  const newlineReply = '[QQ]在呢爸爸！\n刚把小鱼干吃完～\n今晚我们看什么电影呀？\n我先把小板凳搬好啦！[/QQ]'
  const nlBubbles = splitIntoHumanBubbles(newlineReply, { maxBubbles: 3, targetLen: 42 })
  assert.equal(nlBubbles.length, 3)
})

test('splitIntoHumanBubbles NEVER splits inside URLs, code spans, parentheses, or 「...」 quotes', () => {
  const tricky =
    '[QQ]你看这个地址 https://example.com/path.v1?foo=1!bar=2#top 真的能打开哦！刚才源弟弟还嘴硬说「我今天绝对不熬夜！谁熬夜谁是小狗。」（结果凌晨两点还在跑 `npm run build && echo ok!` 呢），笑死我啦！[/QQ]'
  const bubbles = splitIntoHumanBubbles(tricky, { maxBubbles: 3, targetLen: 42 })

  assert.ok(bubbles.length >= 2 && bubbles.length <= 3)

  // Verify URL stays 100% intact inside a single bubble
  assert.ok(
    bubbles.some((b) => b.includes('https://example.com/path.v1?foo=1!bar=2#top')),
    'URL must remain unbroken in a single bubble',
  )
  // Verify 「...」 quote stays 100% intact inside a single bubble
  assert.ok(
    bubbles.some((b) => b.includes('「我今天绝对不熬夜！谁熬夜谁是小狗。」')),
    'Chinese corner quote must remain unbroken in a single bubble',
  )
  // Verify inline code and parentheses stay 100% intact inside a single bubble
  assert.ok(
    bubbles.some((b) => b.includes('（结果凌晨两点还在跑 `npm run build && echo ok!` 呢）')),
    'Parentheses + inline code span must remain unbroken in a single bubble',
  )
})

test('computeTypingDelayMs and selectReplyQuoteId follow human cadence & multi-topic quote disambiguation', () => {
  assert.equal(computeTypingDelayMs('第一条立刻发', { index: 0 }), 0)
  const secondDelay = computeTypingDelayMs('紧跟着敲第二句短话～', {
    index: 1,
    baseMs: 280,
    perCharMs: 35,
    maxMs: 1500,
  })
  assert.equal(secondDelay, 280 + 10 * 35)

  const cappedDelay = computeTypingDelayMs('这是一段特别特别长的话'.repeat(10), {
    index: 2,
    baseMs: 280,
    perCharMs: 35,
    maxMs: 1500,
  })
  assert.equal(cappedDelay, 1500)

  // Single active topic without explicit quote -> no redundant quote spam
  assert.equal(
    selectReplyQuoteId({ activeTopicCount: 1, targetMessageId: 'msg-100', explicitQuote: false }),
    null,
  )
  // Parallel topics (>= 2) -> automatically quote targetMessageId to disambiguate threads
  assert.equal(
    selectReplyQuoteId({ activeTopicCount: 2, targetMessageId: 'msg-100', explicitQuote: false }),
    'msg-100',
  )
  // Explicit quote -> always quote targetMessageId if present
  assert.equal(
    selectReplyQuoteId({ activeTopicCount: 1, targetMessageId: 998877, explicitQuote: true }),
    '998877',
  )
  assert.equal(
    selectReplyQuoteId({ activeTopicCount: 3, targetMessageId: null, explicitQuote: true }),
    null,
  )
})
