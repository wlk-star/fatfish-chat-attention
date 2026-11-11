import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  DESKTOP_PET_SESSION_ID,
  estimateTokens,
  extractReplySegment,
  formatDigestLine,
  formatInboundLine,
} from './index.mjs'

const PRIVATE_SESSION_ID = 'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd'
const GROUP_SESSION_ID = 'session-fb1e56d7-9651-40eb-9f42-d25702e8641b'
const GROUP_ID = '1135493428'
const OWNER_ID = 'qq:1024162823'
const BROTHER_ID = 'qq:616860663'

function createMockHost({ initialClock = 1_760_000_000_000, moodFiles = {}, seedFiles = {} } = {}) {
  let clock = initialClock
  let timerSeq = 0
  const timers = new Map()
  const listeners = new Map()
  const provided = new Map()
  const effectCleanups = []
  const agents = new Map()
  const sessions = new Map()
  const queryEventsBySession = new Map()
  const emittedEvents = []

  const ctx = {
    agents,
    sessions,
    sessionQuery: {
      async filterEvents(sessionId, filters = []) {
        const list = queryEventsBySession.get(sessionId) ?? []
        const seqFilter = filters.find(f => f.kind === 'seq')
        if (!seqFilter) return list
        return list.filter(ev => ev.seq >= seqFilter.min && ev.seq <= seqFilter.max)
      },
    },
    provide(serviceName, value) {
      provided.set(serviceName, value)
      ctx[serviceName] = value
      return () => {
        provided.delete(serviceName)
      }
    },
    get(serviceName) {
      return provided.get(serviceName)
    },
    on(eventName, handler) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set())
      listeners.get(eventName).add(handler)
      return () => listeners.get(eventName)?.delete(handler)
    },
    emit(eventName, ...args) {
      emittedEvents.push({ eventName, args })
      for (const fn of [...(listeners.get(eventName) ?? [])]) {
        fn(...args)
      }
    },
    effect(setupFn) {
      const cleanup = setupFn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      return cleanup
    },
  }

  function spawnAgent(sessionId) {
    const registeredTools = new Map()
    const promptContexts = new Map()
    const agentListeners = new Map()
    const sessionEvents = new Map()

    const session = {
      id: sessionId,
      lastSeq: 0,
      events: [],
      appendRaw(type, data, explicitSeq) {
        const seq = explicitSeq ?? ++session.lastSeq
        session.lastSeq = Math.max(session.lastSeq, seq)
        const ev = { seq, type, data }
        sessionEvents.set(seq, ev)
        session.events.push(ev)
        ctx.emit('session/event', session, ev)
        return ev
      },
      eventAt(seq) {
        return sessionEvents.get(seq) ?? null
      },
    }
    sessions.set(sessionId, session)

    const agent = {
      id: sessionId,
      session,
      registeredTools,
      promptContexts,
      ctx: {
        tools: {
          register(toolDef) {
            registeredTools.set(toolDef.name, toolDef)
            return () => registeredTools.delete(toolDef.name)
          },
        },
        systemPrompt: {
          context(spec) {
            promptContexts.set(spec.name, spec)
            return () => promptContexts.delete(spec.name)
          },
        },
        on(evName, fn) {
          if (!agentListeners.has(evName)) agentListeners.set(evName, new Set())
          agentListeners.get(evName).add(fn)
          return () => agentListeners.get(evName)?.delete(fn)
        },
        emit(evName, payload) {
          for (const fn of [...(agentListeners.get(evName) ?? [])]) {
            fn(payload)
          }
        },
      },
      renderContext(name = 'relational-attention') {
        const entry = promptContexts.get(name)
        if (!entry) return ''
        return typeof entry.text === 'function' ? entry.text({ agent }) : String(entry.text ?? '')
      },
      claimTurn(message, seqOverride) {
        const ev = session.appendRaw('user/message', { message, source: message?.source }, seqOverride)
        agent.ctx.emit('agent/inbox/claimed', { message: { ...message, seq: ev.seq } })
        return ev
      },
    }

    agents.set(sessionId, agent)
    ctx.emit('agent/created', { agent })
    return agent
  }

  async function advance(ms) {
    clock += ms
    for (const [id, entry] of [...timers.entries()]) {
      if (entry.at <= clock) {
        timers.delete(id)
        entry.fn()
      }
    }
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
  }

  function disposeAll() {
    while (effectCleanups.length > 0) {
      const fn = effectCleanups.pop()
      fn()
    }
  }

  const readMoodFile = filePath => {
    const normalized = String(filePath).replace(/\\/g, '/')
    for (const [suffix, content] of Object.entries(moodFiles)) {
      if (normalized.endsWith(suffix)) {
        return typeof content === 'string' ? content : JSON.stringify(content)
      }
    }
    throw new Error(`ENOENT: ${filePath}`)
  }

  const readSeedFile = filePath => {
    const normalized = String(filePath).replace(/\\/g, '/')
    for (const [suffix, content] of Object.entries(seedFiles)) {
      if (normalized.endsWith(suffix)) {
        return typeof content === 'string' ? content : JSON.stringify(content)
      }
    }
    throw new Error(`ENOENT: ${filePath}`)
  }

  return {
    ctx,
    now: () => clock,
    setTimeout: (fn, delay) => {
      const id = ++timerSeq
      timers.set(id, { at: clock + Math.max(0, Number(delay) || 0), fn })
      return id
    },
    clearTimeout: id => timers.delete(id),
    spawnAgent,
    advance,
    disposeAll,
    emittedEvents,
    queryEventsBySession,
    readMoodFile,
    readSeedFile,
  }
}

test('End-to-End L0-L6 Companion Pipeline: session scoping, desktop pet 0-tool invariant, multi-person stage, KV-cache stability, ScopeGate, tools, rewind, speak-up, and L6 humanizer', async () => {
  const moodFiles = {
    'feiyu-mood/config.json': {
      mode: 'session',
      moodBase: 70,
      targetSession: '1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd',
      slots: [
        {
          id: '1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd',
          sessions: [PRIVATE_SESSION_ID],
          ownerName: '爸爸',
        },
      ],
    },
    'feiyu-mood/state.json': {
      moods: {
        '1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd': {
          mood: 58,
          dims: { happy: 0.1, calm: 0.4, sweet: 0.2, heartache: 1.8, worry: 1.2, sad: 0.5, jealous: 0 },
          lastReason: '爸爸私聊提到昨晚通宵改线上故障，胃痛没吃晚饭（绝密私聊原因）',
          timeline: [
            {
              at: 1_760_000_000_100,
              mood: 58,
              delta: -12,
              dims: { heartache: 1.8, worry: 1.2 },
              reason: '爸爸私聊提到昨晚通宵改线上故障，胃痛没吃晚饭（绝密私聊原因）',
            },
          ],
        },
      },
    },
  }

  const seedFiles = {
    'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd.json': {
      sessionId: PRIVATE_SESSION_ID,
      memories: [
        { id: 'm_synth', text: '配置验收口令是青石桥728' },
        { id: 'm_superseded', text: '旧记录', 已被取代: true },
        { id: 'm_real_1', text: '爸爸喜欢喝少冰美式，胃不舒服时会改喝热燕麦拿铁' },
      ],
    },
  }

  const host = createMockHost({ moodFiles, seedFiles })

  const service = apply(host.ctx, {
    groupId: GROUP_ID,
    dryRun: false,
    dbPath: ':memory:',
    dshHome: '/virtual/.dsh',
    fishMemorySeedPath: '/virtual/.dsh/fish-memory/session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd.json',
    enableConsolidationTimer: false,
    now: host.now,
    setTimeout: host.setTimeout,
    clearTimeout: host.clearTimeout,
    readMoodFile: host.readMoodFile,
    readSeedFile: host.readSeedFile,
    // Deliberately include desktop pet ID to verify hard blocklist defense-in-depth!
    allowedSessions: {
      [PRIVATE_SESSION_ID]: `private:${OWNER_ID}`,
      [GROUP_SESSION_ID]: `group:${GROUP_ID}`,
      [DESKTOP_PET_SESSION_ID]: 'private:qq:999999',
    },
  })

  // 1. Service contract & seed verification
  assert.equal(host.ctx.get('relationalAttention'), service)
  assert.equal(typeof service.ingestInbound, 'function')
  assert.equal(typeof service.recordOutbound, 'function')
  assert.equal(typeof service.listOpenTopics, 'function')
  assert.equal(typeof service.getActiveStage, 'function')
  assert.equal(typeof service.registerMemoryProvider, 'function')

  const ownerInGroup = service.store.getParticipant(OWNER_ID, { viewerScope: `group:${GROUP_ID}` })
  const brotherInGroup = service.store.getParticipant(BROTHER_ID, { viewerScope: `group:${GROUP_ID}` })
  assert.equal(ownerInGroup?.preferredCall, '爸爸')
  assert.equal(brotherInGroup?.preferredCall, '源弟弟')
  // Private fish-memory seed MUST NOT be visible in group scope, AND synthetic passphrase excluded everywhere!
  assert.ok(!ownerInGroup?.facts?.some(f => f.includes('少冰美式')))
  const ownerInPrivate = service.store.getParticipant(OWNER_ID, { viewerScope: `private:${OWNER_ID}` })
  assert.ok(ownerInPrivate?.facts?.some(f => f.includes('少冰美式')))
  assert.ok(!ownerInPrivate?.facts?.some(f => f.includes('青石桥728')))

  // 2. Spawn sessions & verify Desktop Pet `toolSchemaCount === 0` invariant
  const privateAgent = host.spawnAgent(PRIVATE_SESSION_ID)
  const groupAgent = host.spawnAgent(GROUP_SESSION_ID)
  const petAgent = host.spawnAgent(DESKTOP_PET_SESSION_ID)

  assert.equal(petAgent.registeredTools.size, 0, 'Desktop pet session MUST keep toolSchemaCount === 0')
  assert.equal(petAgent.promptContexts.size, 0, 'Desktop pet session MUST have zero injected contexts')
  assert.deepEqual([...privateAgent.registeredTools.keys()].sort(), ['focus_attention', 'remember_relation'])
  assert.deepEqual([...groupAgent.registeredTools.keys()].sort(), ['focus_attention', 'remember_relation'])
  assert.equal(groupAgent.promptContexts.get('relational-attention')?.order, 905)
  assert.equal(groupAgent.promptContexts.get('relational-attention')?.required, true)
  assert.equal(groupAgent.promptContexts.get('relational-attention')?.interpolate, false)

  // 3. L0 Quote + Identity Enrichment -> L1 Multi-Person Group Stage -> L2 KV-Cache Identical Snapshot
  const replySeg = extractReplySegment([
    { type: 'reply', data: { id: 'msg-101', qq: '616860663' } },
    { type: 'text', data: { text: '@蓝蓝 烤肉配什么蘸料好？' } },
  ])
  assert.deepEqual(replySeg, { replyToMessageId: 'msg-101', replyToUserId: '616860663' })

  // Even when `源弟弟` changes his group nickname to `无敌暴龙战神`, `qq:616860663` keeps his identity anchored!
  const digestBlock = [
    '[QQ 未唤醒期间聊天记录（共 2 条）：',
    formatDigestLine({
      userId: '616860663',
      nickname: '无敌暴龙战神',
      groupName: '鱼鱼一家人',
      text: '周末我们去吃炭火烤肉吧！',
    }),
    formatDigestLine({
      userId: '777888999',
      nickname: '小李',
      groupName: '鱼鱼一家人',
      text: '我想点厚切牛舌和五花肉',
    }),
    ']',
  ].join('\n')

  const mainWakeLine = formatInboundLine({
    groupId: GROUP_ID,
    groupName: '鱼鱼一家人',
    userId: '1024162823',
    nickname: 'kk',
    replyToMessageId: replySeg.replyToMessageId,
    replyToUserId: replySeg.replyToUserId,
    text: '@蓝蓝 烤肉配什么蘸料好？',
  })

  groupAgent.claimTurn(
    {
      id: 'msg-103',
      role: 'user',
      source: { kind: 'plugin:dsh-lanlan-group-bridge' },
      content: [{ type: 'text', text: `${digestBlock}\n\n${mainWakeLine}\n（回 QQ 用 [QQ]…[/QQ]）` }],
    },
    10,
  )

  const snapTurn1 = groupAgent.renderContext('relational-attention')
  assert.ok(snapTurn1.includes('[当前话题舞台]'))
  // Multi-person cohort: all 3 participants (`爸爸`, `源弟弟`, `小李`) + kinship edge present!
  assert.ok(snapTurn1.includes('爸爸(qq:1024162823)'), `Expected 爸爸 in snapshot:\n${snapTurn1}`)
  assert.ok(snapTurn1.includes('源弟弟(qq:616860663)'), `Expected 源弟弟 in snapshot:\n${snapTurn1}`)
  assert.ok(snapTurn1.includes('小李(qq:777888999)'), `Expected 小李 in snapshot:\n${snapTurn1}`)
  assert.ok(snapTurn1.includes('兄弟') || snapTurn1.includes('亲兄弟'), `Expected kinship relation in snapshot:\n${snapTurn1}`)
  // L4 mood desensitization check: care demeanor present, private reason NEVER leaked!
  assert.ok(snapTurn1.includes('温和体贴'), `Expected sanitized care demeanor in group snapshot:\n${snapTurn1}`)
  assert.ok(!snapTurn1.includes('胃痛'), 'Group snapshot MUST NEVER leak private mood reason!')
  assert.ok(!snapTurn1.includes('线上故障'), 'Group snapshot MUST NEVER leak private mood reason!')
  assert.ok(!snapTurn1.includes('少冰美式'), 'Group snapshot MUST NEVER leak private profile facts!')
  assert.ok(estimateTokens(snapTurn1) <= 450, 'Group snapshot must stay within 450 token budget')

  // Consecutive intra-topic turn 12s later by existing cohort member -> snapshot MUST be byte-identical!
  await host.advance(12_000)
  const followUpLine = formatInboundLine({
    groupId: GROUP_ID,
    groupName: '鱼鱼一家人',
    userId: '777888999',
    nickname: '小李',
    text: '蒜泥香油碟怎么样？',
  })
  groupAgent.claimTurn(
    {
      id: 'msg-104',
      role: 'user',
      source: { kind: 'plugin:dsh-lanlan-group-bridge' },
      content: [{ type: 'text', text: followUpLine }],
    },
    11,
  )
  const snapTurn2 = groupAgent.renderContext('relational-attention')
  assert.equal(
    snapTurn2,
    snapTurn1,
    'Consecutive turns within same focused topic & cohort MUST yield byte-identical snapshot for KV-cache!',
  )

  const bbqTopicId = service.getActiveStage(GROUP_SESSION_ID).focused.id

  // 4. Second concurrent group topic -> demotes BBQ topic to `warm`, triggers L6 automatic quote-reply
  await host.advance(60_000)
  const keyboardLine = formatInboundLine({
    groupId: GROUP_ID,
    groupName: '鱼鱼一家人',
    userId: '616860663',
    nickname: '无敌暴龙战神',
    text: '对了，换个话题，蓝蓝觉得静音红轴机械键盘适合打游戏吗？',
  })
  groupAgent.claimTurn(
    {
      id: 'msg-201',
      role: 'user',
      source: { kind: 'plugin:dsh-lanlan-group-bridge' },
      content: [{ type: 'text', text: keyboardLine }],
    },
    12,
  )

  const stageWithTwoTopics = service.getActiveStage(GROUP_SESSION_ID)
  assert.equal(stageWithTwoTopics.activeTopicCount, 2)
  assert.equal(stageWithTwoTopics.warm.length, 1)
  assert.equal(stageWithTwoTopics.warm[0].id, bbqTopicId)

  // L6 expression check: 2 active topics -> auto quote reply + natural multi-bubble split preserving `[QQ]...[/QQ]`
  const quoteId = service.humanizer.selectReplyQuoteId({
    activeTopicCount: stageWithTwoTopics.activeTopicCount,
    targetMessageId: stageWithTwoTopics.targetMessageId,
    explicitQuote: false,
  })
  assert.equal(quoteId, 'msg-201')
  const bubbles = service.humanizer.splitIntoHumanBubbles(
    '[QQ]静音红轴打游戏手感很轻盈呀！不过如果你喜欢段落确认感，也可以试试提前大段落轴～要不要问问爸爸平时敲代码用的什么轴？[/QQ]',
  )
  assert.ok(bubbles.length >= 2 && bubbles.length <= 3)
  assert.ok(bubbles.every(b => !b.includes('[QQ]') && !b.includes('[/QQ]')))
  assert.equal(service.humanizer.computeTypingDelayMs(bubbles[0], { index: 0 }), 0)
  assert.ok(service.humanizer.computeTypingDelayMs(bubbles[1], { index: 1 }) >= 280)

  // 5. `focus_attention` tool switches back to warm BBQ topic via `tool/result`
  const groupFocusTool = groupAgent.registeredTools.get('focus_attention')
  const switchRes = await groupFocusTool.execute(
    { topicId: bbqTopicId },
    { agent: groupAgent },
  )
  assert.equal(switchRes.ok, true)
  assert.equal(switchRes.focusedTopicId, bbqTopicId)
  assert.ok(switchRes.text.includes('无敌暴龙战神') || switchRes.text.includes('qq:616860663'))
  assert.equal(service.getActiveStage(GROUP_SESSION_ID).focused.id, bbqTopicId)

  // 6. Compaction episode crystallization + raw quote expansion + private group-highlight sharing
  groupAgent.session.appendRaw(
    'compaction/summary',
    {
      compactionId: 'cmp-group-1',
      shadowedRange: { start: 10, end: 11 },
      summary: [
        {
          type: 'text',
          text: '爸爸、源弟弟和小李一起商量周末去吃炭火烤肉，讨论厚切牛舌与蒜泥香油蘸料。',
        },
      ],
    },
    13,
  )

  const groupEpisodes = service.store.searchEpisodes('炭火烤肉', {
    viewerScope: `group:${GROUP_ID}`,
  })
  assert.ok(groupEpisodes.length >= 1)
  const crystallizedEp = groupEpisodes[0]

  const quoteRes = await groupFocusTool.execute(
    { episodeId: crystallizedEp.episodeId, includeRawQuotes: true },
    { agent: groupAgent },
  )
  assert.equal(quoteRes.ok, true)
  assert.ok(quoteRes.text.includes('【历史原话回放】'), `Expected raw quotes in:\n${quoteRes.text}`)
  assert.ok(quoteRes.text.includes('蒜泥香油碟'))

  // Owner private session CAN see the group highlight (`ScopeGate` one-way sharing!)
  privateAgent.claimTurn(
    {
      id: 'priv-1',
      role: 'user',
      source: { kind: 'plugin:dsh-qq-bridge' },
      content: [{ type: 'text', text: '[QQ · 私聊] kk(qq:1024162823)：蓝蓝，今天群里热闹吗？' }],
    },
    1,
  )
  const privateSnap = privateAgent.renderContext('relational-attention')
  assert.ok(privateSnap.includes('[群聊近期动态]'), `Expected group highlight in private snapshot:\n${privateSnap}`)
  assert.ok(privateSnap.includes('炭火烤肉'))

  // 7. `remember_relation` trust guard: group stranger CANNOT hijack `owner_curated` kinship or `public_roster`
  const groupRememberTool = groupAgent.registeredTools.get('remember_relation')
  const hijackAttempt = await groupRememberTool.execute(
    {
      participantId: 'qq:999000111',
      relatedParticipantId: OWNER_ID,
      relation: '自称是爸爸的亲哥哥',
      preferredCall: '大伯',
      publicSafe: true,
    },
    { agent: groupAgent },
  )
  assert.equal(hijackAttempt.ok, true)
  assert.equal(hijackAttempt.scope, `group:${GROUP_ID}`, 'Group write must stay confined to group scope')
  assert.equal(hijackAttempt.trust, 'self_claimed_tentative')
  assert.equal(
    service.store.getParticipant('qq:999000111', { viewerScope: 'public_roster' }),
    null,
    'Group member must NEVER pollute public_roster',
  )

  const overwriteCuratedAttempt = await groupRememberTool.execute(
    {
      participantId: BROTHER_ID,
      relatedParticipantId: OWNER_ID,
      relation: '陌生路人',
    },
    { agent: groupAgent },
  )
  assert.equal(overwriteCuratedAttempt.ok, false)
  assert.equal(overwriteCuratedAttempt.blocked, true)

  // Owner private `remember_relation` CAN curate relations & bi-temporally update edges
  const privateRememberTool = privateAgent.registeredTools.get('remember_relation')
  const curatedRel1 = await privateRememberTool.execute(
    {
      participantId: 'qq:777888999',
      preferredCall: '小李哥',
      relatedParticipantId: OWNER_ID,
      relation: '大学室友',
      publicSafe: true,
    },
    { agent: privateAgent },
  )
  assert.equal(curatedRel1.ok, true)
  assert.equal(curatedRel1.trust, 'owner_curated')
  assert.equal(curatedRel1.scope, 'public_roster')

  await host.advance(1000)
  const curatedRel2 = await privateRememberTool.execute(
    {
      participantId: 'qq:777888999',
      relatedParticipantId: OWNER_ID,
      relation: '创业合伙人兼老室友',
      publicSafe: true,
    },
    { agent: privateAgent },
  )
  assert.equal(curatedRel2.ok, true)
  const allEdges = service.store.listRelationEdges({
    participantId: 'qq:777888999',
    viewerScope: 'public_roster',
    includeHistorical: true,
  })
  assert.equal(allEdges.filter(e => e.status === 'active').length, 1)
  assert.equal(allEdges.filter(e => e.status === 'historical').length, 1)

  // 8. L5 `speak-up` internal trigger filtering & `listOpenTopics`
  const stageBeforeSpeakUp = service.getActiveStage(PRIVATE_SESSION_ID)
  privateAgent.claimTurn(
    {
      id: 'internal-speakup-1',
      role: 'user',
      source: { kind: 'speak-up' },
      content: [{ type: 'text', text: '<speak-up>主动关心一下爸爸</speak-up>' }],
    },
    2,
  )
  privateAgent.claimTurn(
    {
      id: 'internal-rt-1',
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'Current time: ...' }],
    },
    3,
  )
  const stageAfterSpeakUp = service.getActiveStage(PRIVATE_SESSION_ID)
  assert.equal(stageAfterSpeakUp.epoch, stageBeforeSpeakUp.epoch)
  assert.ok(!JSON.stringify(stageAfterSpeakUp).includes('主动关心一下爸爸'))

  const openTopicsForOwner = service.listOpenTopics(PRIVATE_SESSION_ID)
  assert.ok(openTopicsForOwner.length >= 1)
  assert.ok(openTopicsForOwner.some(item => item.kind === 'group_highlight'))

  // 9. L5 `dsh-rewind` invalidation vs `replace` surface op non-trigger
  groupAgent.session.appendRaw(
    'surface/replace',
    { kind: 'tool-result-pruner', targetSeq: 10 },
    14,
  )
  assert.equal(
    service.store.searchEpisodes('炭火烤肉', { viewerScope: `group:${GROUP_ID}` }).length,
    1,
    'ToolResultPruner replace ops MUST NOT invalidate episodes!',
  )

  groupAgent.session.appendRaw(
    'user/message',
    {
      source: { kind: 'dsh-rewind' },
      sourceEventSeqs: [10, 11],
    },
    15,
  )
  assert.equal(
    service.store.searchEpisodes('炭火烤肉', { viewerScope: `group:${GROUP_ID}` }).length,
    0,
    'Rewound episode MUST be invalidated and purged from FTS search!',
  )

  host.disposeAll()
})

test('End-to-End Group Inbound -> SubHeartflow LLM Classifier -> attention-wake, Outbound, External Memory ScopeGate, and Sleep Consolidation', async () => {
  const host = createMockHost()
  const wakes = []
  host.ctx.on('qq-bridge/attention-wake', payload => wakes.push(payload))

  host.ctx.llm = {
    async *stream({ messages }) {
      assert.equal(messages.length, 1)
      assert.equal(messages[0]?.source?.kind, 'plugin:dsh-relational-attention')
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          topicAction: 'continue',
          activeParticipants: ['qq:1024162823', 'qq:616860663'],
          related: true,
          reply: true,
          replyTargetIds: ['qq:616860663'],
          triggerMessageId: 'g-msg-2',
          end: false,
        }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  const service = apply(host.ctx, {
    groupId: GROUP_ID,
    dryRun: false,
    dbPath: ':memory:',
    enableConsolidationTimer: false,
    quietSeconds: 2,
    cooldownSeconds: 5,
    warmTtlMinutes: 10,
    now: host.now,
    setTimeout: host.setTimeout,
    clearTimeout: host.clearTimeout,
    allowedSessions: {
      [PRIVATE_SESSION_ID]: `private:${OWNER_ID}`,
      [GROUP_SESSION_ID]: `group:${GROUP_ID}`,
    },
  })

  host.spawnAgent(PRIVATE_SESSION_ID)
  host.spawnAgent(GROUP_SESSION_ID)

  // Initial named wake opens group gate & creates focused topic
  host.ctx.emit('qq-bridge/inbound', {
    transport: true,
    message: {
      groupId: GROUP_ID,
      userId: '1024162823',
      nickname: 'kk',
      messageId: 'g-msg-1',
      text: '蓝蓝，今晚我们看哪部科幻电影好？',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'at-self' },
    at: host.now(),
  })

  host.ctx.emit('qq-bridge/outbound', {
    groupId: GROUP_ID,
    messageId: 'bot-msg-1',
    text: '《星际穿越》或者《降临》都很棒呀！',
    at: host.now(),
  })

  await host.advance(6_000)

  // Follow-up unaddressed message enters batch -> triggers LLM classifier -> emits attention-wake
  host.ctx.emit('qq-bridge/inbound', {
    transport: true,
    message: {
      groupId: GROUP_ID,
      userId: '616860663',
      nickname: '源天帝',
      messageId: 'g-msg-2',
      text: '《星际穿越》配乐是不是汉斯季默做的？',
      atSelf: false,
    },
    candidateToken: 'cand-token-2',
    decision: { action: 'record', reason: 'sampled-out' },
    at: host.now(),
  })

  await host.advance(2_500)
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].candidateToken, 'cand-token-2')
  assert.equal(wakes[0].triggerMessageId, 'g-msg-2')

  // External memory provider registration + zero-trust ScopeGate check
  const unregister = service.registerMemoryProvider({
    name: 'mock-graphiti',
    async query() {
      return [
        { id: 'ext-priv', scope: `private:${OWNER_ID}`, text: '私密外部记忆条目' },
        { id: 'ext-grp', scope: `group:${GROUP_ID}`, text: '群共享外部记忆条目' },
      ]
    },
  })
  const groupExt = await service.memoryConnector.queryExternal('记忆', {
    viewerScope: `group:${GROUP_ID}`,
  })
  assert.equal(groupExt.length, 1)
  assert.equal(groupExt[0].id, 'ext-grp')
  unregister()

  // Demote topic to warm by starting a new topic, then advance past warmTtlMinutes & consolidate
  await host.advance(60_000)
  host.ctx.emit('qq-bridge/inbound', {
    transport: true,
    message: {
      groupId: GROUP_ID,
      userId: '1024162823',
      nickname: 'kk',
      messageId: 'g-msg-3',
      text: '换个话题，蓝蓝明天天气冷不冷？',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'nickname' },
    at: host.now(),
  })
  assert.equal(service.getActiveStage(GROUP_SESSION_ID).warm.length, 1)

  await host.advance(11 * 60_000)
  const consolidated = await service.runIdleConsolidation({ nowMs: host.now() })
  assert.equal(consolidated.archivedCount, 1)
  assert.equal(service.getActiveStage(GROUP_SESSION_ID).warm.length, 0)
  assert.ok(
    service.store.searchEpisodes('星际穿越', { viewerScope: `group:${GROUP_ID}` }).length >= 1,
  )

  host.disposeAll()
})

test('E2E 7: Cordis 4 strict immediate service registration + empty inject array + un-injected getter guard', async () => {
  const pluginMod = await import('./index.mjs')
  assert.equal(Array.isArray(pluginMod.inject), true, 'Cordis 4 inject must be an array (never { required, optional })')
  assert.deepEqual(pluginMod.inject, [])

  const providedCalls = []
  const stored = new Map()
  const disposers = []
  const rawCtx = {
    registry: {},
    plugin() {},
    provide(key, immediate) {
      providedCalls.push([key, immediate])
    },
    get(key) {
      return providedCalls.some(([k, imm]) => k === key && imm === true) ? stored.get(key) : undefined
    },
    effect(fn) {
      const off = fn()
      if (typeof off === 'function') disposers.push(off)
    },
  }
  const guardedServices = new Set(['relationalAttention', 'llm', 'tools', 'sessions', 'sessionQuery', 'agents'])
  // Simulate Cordis 4 reflect proxy: reading un-injected service properties throws,
  // while setting ctx.relationalAttention stores the immediate service instance.
  const cordisProxy = new Proxy(rawCtx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && guardedServices.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value, receiver) {
      if (prop === 'relationalAttention') {
        stored.set('relationalAttention', value)
        return true
      }
      return Reflect.set(target, prop, value, receiver)
    },
  })

  const rel = apply(cordisProxy, {
    groupId: GROUP_ID,
    dbPath: ':memory:',
    fishMemorySeedPath: false,
    enableConsolidationTimer: false,
  })
  assert.deepEqual(providedCalls, [['relationalAttention', true]])
  assert.equal(cordisProxy.get('relationalAttention'), rel)
  for (const d of disposers.reverse()) d()
})
