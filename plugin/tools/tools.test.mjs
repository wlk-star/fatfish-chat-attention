import assert from 'node:assert/strict'
import test from 'node:test'

import { createMoodConnector } from '../connectors/mood-connector.mjs'
import { attachRewindConnector, isRewindEvent } from '../connectors/rewind-connector.mjs'
import {
  createSpeakupConnector,
  isInternalTriggerMessage,
} from '../connectors/speakup-connector.mjs'
import { createMultiTopicEngine } from '../attention/multi-topic-engine.mjs'
import { createRelationalStore } from '../store/sqlite-repo.mjs'
import { createFocusAttentionTool } from './focus-attention.mjs'
import { createRememberRelationTool } from './remember-relation.mjs'

const OWNER_ID = 'qq:1024162823'
const BROTHER_ID = 'qq:616860663'
const PRIVATE_SESSION_ID = 'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd'
const GROUP_SESSION_ID = 'session-fb1e56d7-9651-40eb-9f42-d25702e8641b'
const OWNER_SCOPE = 'private:qq:1024162823'
const GROUP_SCOPE = 'group:1135493428'

function makeScopeResolver() {
  return (exec) => {
    const sid =
      typeof exec === 'string'
        ? exec
        : (exec?.sessionId ?? exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
    if (sid === PRIVATE_SESSION_ID) return OWNER_SCOPE
    if (sid === GROUP_SESSION_ID) return GROUP_SCOPE
    return ''
  }
}

test('focus_attention & remember_relation support both DSH defineTool(output:{schema,render}) and plain-object fallback', async () => {
  const store = createRelationalStore({ dbPath: ':memory:' })
  store.seedDefaults()

  let capturedFocusDef = null
  let capturedRememberDef = null
  const mockDefineTool = (def) => {
    if (def.name === 'focus_attention') capturedFocusDef = def
    if (def.name === 'remember_relation') capturedRememberDef = def
    // Simulate @deepseek-ai/dsh-tools#L435-L437 strict contract check
    assert.equal(typeof def.output, 'object')
    assert.equal(typeof def.output.schema, 'object')
    assert.equal(def.output.schema.type, 'object')
    assert.equal(typeof def.output.schema.additionalProperties, 'boolean')
    assert.equal(typeof def.output.render, 'function')
    return def
  }
  const mockZ = { object: (x) => x, string: () => ({}), boolean: () => ({}) }

  const focusWithHost = createFocusAttentionTool({
    defineTool: mockDefineTool,
    z: mockZ,
    store,
    resolveSessionScope: makeScopeResolver(),
  })
  const rememberWithHost = createRememberRelationTool({
    defineTool: mockDefineTool,
    z: mockZ,
    store,
    resolveSessionScope: makeScopeResolver(),
  })

  assert.equal(focusWithHost.name, 'focus_attention')
  assert.equal(rememberWithHost.name, 'remember_relation')
  assert.ok(capturedFocusDef && capturedRememberDef)

  const renderedOk = rememberWithHost.output.render({}, { ok: true, message: 'done' })
  assert.deepEqual(renderedOk, [{ type: 'text', text: '✓' }])
  const renderedFail = rememberWithHost.output.render({}, { ok: false, message: '被拦截' })
  assert.equal(renderedFail[0].type, 'text')
  assert.match(renderedFail[0].text, /被拦截/)

  // Plain-object fallback when defineTool/z are omitted in unit tests
  const focusFallback = createFocusAttentionTool({
    store,
    resolveSessionScope: makeScopeResolver(),
  })
  const rememberFallback = createRememberRelationTool({
    store,
    resolveSessionScope: makeScopeResolver(),
  })

  assert.equal(focusFallback.name, 'focus_attention')
  assert.equal(focusFallback.parameters.type, 'object')
  assert.equal(typeof focusFallback.output.render, 'function')
  assert.equal(rememberFallback.name, 'remember_relation')
  assert.deepEqual(rememberFallback.parameters.required, ['participantId'])

  await assert.rejects(
    () => rememberFallback.execute({}, { sessionId: PRIVATE_SESSION_ID }),
    /Missing required argument: participantId/,
  )

  store.close()
})

test('focus_attention enforces one-way ScopeGate, switches warm topic focus, and expands shadowed raw quotes via readRawEvents', async () => {
  const store = createRelationalStore({ dbPath: ':memory:' })
  store.seedDefaults()

  store.saveEpisode({
    episodeId: 'ep-priv-medical',
    sessionId: PRIVATE_SESSION_ID,
    scope: OWNER_SCOPE,
    title: '体检尿酸报告',
    summary: '爸爸私聊提到最近体检尿酸偏高，蓝蓝提醒少喝浓汤。',
    indexLine: '爸爸聊体检尿酸偏高',
    participantIds: [OWNER_ID],
    startSeq: 10,
    endSeq: 12,
    moodSlice: {
      slotId: 'xiaoman-companion-v1',
      startMood: 74,
      endMood: 64,
      label: '有些担心',
      dims: { worry: 3 },
      reasons: ['爸爸说体检尿酸高'],
    },
  })

  store.saveEpisode({
    episodeId: 'ep-grp-bbq',
    sessionId: GROUP_SESSION_ID,
    scope: GROUP_SCOPE,
    title: '周末烤肉局',
    summary: '源弟弟和群友约周六晚上去吃炭火烤肉。',
    indexLine: '源弟弟聊周末烤肉局',
    participantIds: [BROTHER_ID, 'qq:88888888'],
    startSeq: 40,
    endSeq: 43,
    isHighlight: true,
  })

  let focusedCalls = []
  const mockStageBySession = {
    [GROUP_SESSION_ID]: {
      scope: GROUP_SCOPE,
      focused: {
        topicId: 'topic-game',
        scope: GROUP_SCOPE,
        status: 'focused',
        title: '排位上分',
        cohort: { [BROTHER_ID]: { nickname: '源天帝', stanceSummary: '连跪三把' } },
      },
      warm: [
        {
          topicId: 'topic-bbq',
          scope: GROUP_SCOPE,
          status: 'warm',
          title: '周末烤肉局',
          summary: '讨论五花肉还是牛肋条',
          cohort: {
            [BROTHER_ID]: { nickname: '源天帝', latestStance: '投牛肋条一票' },
            'qq:88888888': { nickname: '阿哲', latestStance: '想吃蒜香五花肉' },
          },
          episodeId: 'ep-grp-bbq',
        },
      ],
    },
  }

  const mockEngine = {
    getStage: (sid) => mockStageBySession[sid] ?? null,
    focusTopic: (sid, tid) => {
      focusedCalls.push({ sid, tid })
      return true
    },
  }

  const rawReadCalls = []
  const readRawEvents = async (sid, seqRange) => {
    rawReadCalls.push({ sid, seqRange })
    if (sid === GROUP_SESSION_ID) {
      return [
        {
          seq: 40,
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: '[QQ · 群] 源天帝(qq:616860663)：周六去吃牛肋条吧！' }],
            source: { kind: 'plugin:dsh-lanlan-group-bridge' },
          },
        },
        {
          seq: 41,
          type: 'user/message',
          data: {
            content: [{ type: 'text', text: 'Current runtime context snapshot...' }],
            source: { kind: 'runtime-context' },
          },
        },
        {
          seq: 42,
          type: 'assistant/message',
          data: {
            message: { content: [{ type: 'text', text: '[QQ]牛肋条好耶！我也要吃两串～[/QQ]' }] },
          },
        },
      ]
    }
    return [
      {
        seq: 10,
        type: 'user/message',
        data: { content: [{ type: 'text', text: '今天体检单出来尿酸有点高' }] },
      },
    ]
  }

  const tool = createFocusAttentionTool({
    store,
    engine: mockEngine,
    resolveSessionScope: makeScopeResolver(),
    readRawEvents,
  })

  // 1) Group caller trying to inspect private episodeId or search private keywords -> ZERO leakage!
  const groupProbePrivate = await tool.execute(
    { episodeId: 'ep-priv-medical', query: '体检尿酸', includeRawQuotes: true },
    { agent: { session: { id: GROUP_SESSION_ID } } },
  )
  assert.equal(groupProbePrivate.ok, true)
  assert.equal(groupProbePrivate.matchCount, 0)
  assert.doesNotMatch(groupProbePrivate.text, /尿酸|体检|浓汤/)
  assert.equal(rawReadCalls.length, 0)

  // 2) Group caller switching warm topic + reading group raw quotes + resolving public brother profile
  const groupFocus = await tool.execute(
    {
      topicId: 'topic-bbq',
      participantId: '源天帝',
      includeRawQuotes: true,
    },
    { agent: { session: { id: GROUP_SESSION_ID } } },
  )
  assert.equal(groupFocus.ok, true)
  assert.equal(groupFocus.focusedTopicId, 'topic-bbq')
  assert.deepEqual(focusedCalls, [{ sid: GROUP_SESSION_ID, tid: 'topic-bbq' }])
  assert.match(groupFocus.text, /周末烤肉局/)
  assert.match(groupFocus.text, /源弟弟 \[qq:616860663\]/)
  assert.match(groupFocus.text, /亲兄弟/)
  assert.match(groupFocus.text, /牛肋条好耶/)
  // Runtime-context internal snapshot is filtered out of raw quotes
  assert.doesNotMatch(groupFocus.text, /Current runtime context snapshot/)
  assert.deepEqual(rawReadCalls[0], { sid: GROUP_SESSION_ID, seqRange: [40, 43] })

  // 3) Owner private chat CAN read both private episode (+ moodSlice) AND public group episode!
  const ownerRecallBoth = await tool.execute(
    { query: '烤肉' },
    { agent: { session: { id: PRIVATE_SESSION_ID } } },
  )
  assert.equal(ownerRecallBoth.ok, true)
  assert.match(ownerRecallBoth.text, /周末烤肉局/)

  const ownerRecallPrivate = await tool.execute(
    { episodeId: 'ep-priv-medical', includeRawQuotes: true },
    { agent: { session: { id: PRIVATE_SESSION_ID } } },
  )
  assert.match(ownerRecallPrivate.text, /体检尿酸偏高/)
  assert.match(ownerRecallPrivate.text, /有些担心 \(74->64\)/)
  assert.match(ownerRecallPrivate.text, /今天体检单出来尿酸有点高/)

  store.close()
})

test('remember_relation enforces TrustLevel & ScopeGate (owner_curated/public_roster vs group anti-poisoning)', async () => {
  const store = createRelationalStore({ dbPath: ':memory:' })
  store.seedDefaults()

  const tool = createRememberRelationTool({
    store,
    resolveSessionScope: makeScopeResolver(),
    ownerId: OWNER_ID,
  })

  // 1) Owner private chat curates a publicSafe kin/friend -> writes owner_curated into public_roster
  const resPublic = await tool.execute(
    {
      participantId: 'qq:77777777',
      preferredCall: '表姐',
      alias: '小七',
      relatedParticipantId: OWNER_ID,
      relation: '表兄妹',
      publicSafe: true,
    },
    { sessionId: PRIVATE_SESSION_ID },
  )
  assert.equal(resPublic.ok, true)
  assert.equal(resPublic.scope, 'public_roster')
  assert.equal(resPublic.trust, 'owner_curated')

  // Group chat immediately recognizes 表姐 from public_roster
  const fromGroup = store.getParticipant('qq:77777777', { viewerScope: GROUP_SCOPE })
  assert.equal(fromGroup?.preferredCall, '表姐')

  // 2) Owner private chat records a private fact (publicSafe omitted/false) -> stays strictly in private scope
  const resPrivateFact = await tool.execute(
    {
      participantId: OWNER_ID,
      fact: '下周二要去医院复查肠胃',
      publicSafe: false,
    },
    { sessionId: PRIVATE_SESSION_ID },
  )
  assert.equal(resPrivateFact.ok, true)
  assert.equal(resPrivateFact.scope, OWNER_SCOPE)
  const ownerInGroup = store.getParticipant(OWNER_ID, { viewerScope: GROUP_SCOPE })
  assert.ok(!ownerInGroup.facts.includes('下周二要去医院复查肠胃'))

  // 3) Group chat normal peer observation -> capped at fish_observed, NEVER writes public_roster even if publicSafe:true
  const resGroupPeer = await tool.execute(
    {
      participantId: 'qq:90000001',
      preferredCall: '阿杰',
      fact: '喜欢玩星露谷物语',
      publicSafe: true,
    },
    { sessionId: GROUP_SESSION_ID },
  )
  assert.equal(resGroupPeer.ok, true)
  assert.equal(resGroupPeer.scope, GROUP_SCOPE)
  assert.equal(resGroupPeer.trust, 'fish_observed')
  assert.equal(store.getParticipant('qq:90000001', { viewerScope: 'public_roster' }), null)

  // 4) Group chat prank kinship claim ("我是爸爸的老板") -> downgraded to self_claimed_tentative
  const resGroupPrank = await tool.execute(
    {
      participantId: 'qq:90000002',
      relatedParticipantId: OWNER_ID,
      relation: '自称是爸爸的顶头上司',
    },
    { sessionId: GROUP_SESSION_ID },
  )
  assert.equal(resGroupPrank.ok, true)
  assert.equal(resGroupPrank.scope, GROUP_SCOPE)
  assert.equal(resGroupPrank.trust, 'self_claimed_tentative')

  // 5) Group chat attempting to overwrite owner_curated preferredCall or owner_curated brother relation -> blocked!
  const hijackCall = await tool.execute(
    {
      participantId: BROTHER_ID,
      preferredCall: '路人甲',
    },
    { sessionId: GROUP_SESSION_ID },
  )
  assert.equal(hijackCall.ok, false)
  assert.equal(hijackCall.blocked, true)
  assert.equal(store.getParticipant(BROTHER_ID, { viewerScope: GROUP_SCOPE })?.preferredCall, '源弟弟')

  const hijackEdge = await tool.execute(
    {
      participantId: BROTHER_ID,
      relatedParticipantId: OWNER_ID,
      relation: '素不相识的陌生人',
    },
    { sessionId: GROUP_SESSION_ID },
  )
  assert.equal(hijackEdge.ok, false)
  assert.equal(hijackEdge.blocked, true)

  store.close()
})

test('L4 mood-connector extracts private moodSlice and projects group affect tone with ZERO private reason leakage', () => {
  const store = createRelationalStore({ dbPath: ':memory:' })
  store.seedDefaults()

  const files = new Map([
    [
      '/mock-dsh/feiyu-mood/config.json',
      JSON.stringify({
        模式: 'session',
        moodBase: 70,
        targetSession: PRIVATE_SESSION_ID,
        slots: [
          {
            id: 'xiaoman-companion-v1',
            sessions: [PRIVATE_SESSION_ID],
          },
        ],
      }),
    ],
    [
      '/mock-dsh/feiyu-mood/state.json',
      JSON.stringify({
        version: 2,
        moods: {
          'xiaoman-companion-v1': {
            mood: 58.4,
            dims: {
              happy: 0,
              calm: 0.1,
              sweet: 0.2,
              heartache: 2.6,
              worry: 1.8,
              sad: 0.4,
              jealous: 0,
            },
            lastReason: '绝密私聊秘密：爸爸说项目被砍而且胃疼了一整晚',
            timeline: [
              {
                at: 1000,
                mood: 65,
                delta: -5,
                reason: '爸爸说今晚加班很累',
                dims: { heartache: 1.2, worry: 0.8 },
              },
              {
                at: 2000,
                mood: 58.4,
                delta: -6.6,
                reason: '绝密私聊秘密：爸爸说项目被砍而且胃疼了一整晚',
                dims: { heartache: 2.6, worry: 1.8, sad: 0.4 },
              },
            ],
          },
        },
      }),
    ],
  ])

  const moodConnector = createMoodConnector({
    dshHome: '/mock-dsh',
    store,
    now: () => 5000,
    readFile: (p) => {
      const normalized = p.replace(/\\/g, '/')
      if (!files.has(normalized)) throw new Error('ENOENT')
      return files.get(normalized)
    },
  })

  // Private session slice works (including matching stripped `'session-'` key)
  const privSlice = moodConnector.extractMoodSlice({
    sessionId: PRIVATE_SESSION_ID,
    scope: OWNER_SCOPE,
    startMs: 900,
    endMs: 2500,
  })
  assert.equal(privSlice?.slotId, 'xiaoman-companion-v1')
  assert.equal(privSlice?.startMood, 70)
  assert.equal(privSlice?.endMood, 58.4)
  assert.equal(privSlice?.label, '心疼牵挂')
  assert.equal(privSlice?.reasons.length, 2)

  // Group session or group scope NEVER extracts private moodSlice
  assert.equal(
    moodConnector.extractMoodSlice({
      sessionId: GROUP_SESSION_ID,
      scope: GROUP_SCOPE,
      startMs: 0,
      endMs: 9999,
    }),
    null,
  )
  assert.equal(
    moodConnector.extractMoodSlice({
      sessionId: PRIVATE_SESSION_ID,
      scope: GROUP_SCOPE,
      startMs: 0,
      endMs: 9999,
    }),
    null,
  )

  // Group affect-only projection: syncs careBias and contains ZERO private words
  const tone = moodConnector.projectGroupAffectTone({ ownerId: OWNER_ID })
  assert.match(tone, /温和体贴/)
  assert.doesNotMatch(tone, /胃疼|项目|加班|绝密/)

  const careBias = store.getCareBias(OWNER_ID, 6000)
  assert.ok(careBias)
  assert.equal(careBias.tone, tone)
  assert.doesNotMatch(careBias.tone, /胃疼|项目|加班|绝密/)

  // Missing files degrade gracefully without throwing
  const missingConnector = createMoodConnector({
    dshHome: '/non-existent-dsh',
    readFile: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(missingConnector.extractMoodSlice({ sessionId: PRIVATE_SESSION_ID }), null)
  assert.equal(missingConnector.projectGroupAffectTone(), '')

  store.close()
})

test('L4/L5 rewind-connector & speakup-connector obey exact DSH v0.2.2-rc.1 event signatures', async () => {
  const store = createRelationalStore({ dbPath: ':memory:' })
  store.seedDefaults()

  store.saveEpisode({
    episodeId: 'ep-rewind-target',
    sessionId: PRIVATE_SESSION_ID,
    scope: OWNER_SCOPE,
    title: '撤回前的乌龙约定',
    summary: '说错时间的约定',
    participantIds: [OWNER_ID],
    startSeq: 20,
    endSeq: 25,
  })

  const engineInvalidations = []
  const engine = {
    invalidateBySeqs(sid, seqs) {
      engineInvalidations.push({ sid, seqs })
    },
    archiveWarmTopics({ nowMs }) {
      if (nowMs >= 10_000) {
        return [
          {
            topicId: 'topic-expired-warm',
            sessionId: GROUP_SESSION_ID,
            scope: GROUP_SCOPE,
            title: '群友推荐独立游戏',
            summary: '源弟弟推荐了潜水员戴夫',
            participantIds: [BROTHER_ID, 'qq:88888888'],
            seqRange: [50, 56],
          },
        ]
      }
      return []
    },
    getStage(sid) {
      if (sid === PRIVATE_SESSION_ID) {
        return {
          scope: OWNER_SCOPE,
          warm: [
            {
              topicId: 'topic-unfinished-book',
              sessionId: PRIVATE_SESSION_ID,
              scope: OWNER_SCOPE,
              status: 'warm',
              title: '睡前故事书单',
              summary: '聊到一半还没定今晚看哪本',
              participantIds: [OWNER_ID],
              lastActiveAt: 9500,
            },
          ],
        }
      }
      return null
    },
  }

  let registeredListener = null
  let registeredOpts = null
  const mockCtx = {
    on(name, fn, opts) {
      if (name === 'session/event') {
        registeredListener = fn
        registeredOpts = opts
      }
      return () => {
        registeredListener = null
      }
    },
  }

  attachRewindConnector({ ctx: mockCtx, store, engine })
  assert.deepEqual(registeredOpts, { global: true })
  assert.equal(typeof registeredListener, 'function')

  // ToolResultPruner or SystemPromptProjection `replace` events MUST NOT trigger rewind!
  const prunerReplaceEvent = {
    type: 'tool/result',
    surfaceOp: { op: 'replace', startSeq: 20, endSeq: 25 },
    sourceEventSeqs: [21, 22],
    data: { source: { kind: 'tool' } },
  }
  const sysPromptReplaceEvent = {
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
    sourceEventSeqs: [22],
    data: { source: { kind: 'system-prompt' } },
  }
  assert.equal(isRewindEvent(prunerReplaceEvent), false)
  assert.equal(isRewindEvent(sysPromptReplaceEvent), false)
  registeredListener({ id: PRIVATE_SESSION_ID }, prunerReplaceEvent)
  registeredListener({ id: PRIVATE_SESSION_ID }, sysPromptReplaceEvent)
  assert.equal(
    store.getEpisode('ep-rewind-target', { viewerScope: OWNER_SCOPE, excludeInvalidated: true })?.episodeId,
    'ep-rewind-target',
  )

  // Real DSH rewind event (`type === 'user/message' && data.source.kind === 'dsh-rewind'`) invalidates cleanly!
  const realRewindEvent = {
    type: 'user/message',
    sourceEventSeqs: [22, 23],
    data: { source: { kind: 'dsh-rewind' } },
  }
  assert.equal(isRewindEvent(realRewindEvent), true)
  registeredListener({ id: PRIVATE_SESSION_ID }, realRewindEvent)
  assert.equal(
    store.getEpisode('ep-rewind-target', { viewerScope: OWNER_SCOPE, excludeInvalidated: true }),
    null,
  )
  assert.deepEqual(engineInvalidations, [{ sid: PRIVATE_SESSION_ID, seqs: [22, 23] }])

  // Internal trigger filter (`speak-up`, `runtime-context`, `dsh-rewind`, bridge alerts vs real QQ message)
  assert.equal(isInternalTriggerMessage({ source: { kind: 'speak-up' } }), true)
  assert.equal(isInternalTriggerMessage({ message: { source: { kind: 'runtime-context' } } }), true)
  assert.equal(isInternalTriggerMessage({ data: { source: { kind: 'dsh-rewind' } } }), true)
  assert.equal(isInternalTriggerMessage({ text: '[QQ 桥告警] WebSocket 重连中' }), true)
  assert.equal(
    isInternalTriggerMessage({
      text: '[QQ · 私聊] 爸爸(qq:1024162823)：蓝蓝在干嘛呢',
      source: { kind: 'plugin:dsh-qq-bridge' },
    }),
    false,
  )

  // Speak-up connector: idle consolidation + open topics (warm topic + group highlight for owner private chat)
  const speakup = createSpeakupConnector({ store, engine, ownerId: OWNER_ID, now: () => 12_000 })
  const consolidated = await speakup.runIdleConsolidation({ nowMs: 12_000 })
  assert.equal(consolidated.archivedCount, 1)
  assert.equal(consolidated.episodes[0].episodeId, 'ep-topic-expired-warm')

  const openForOwner = speakup.listOpenTopics(PRIVATE_SESSION_ID, {
    viewerScope: OWNER_SCOPE,
    limit: 5,
  })
  assert.equal(openForOwner.length, 2)
  assert.equal(openForOwner[0].kind, 'warm_topic')
  assert.equal(openForOwner[0].title, '睡前故事书单')
  assert.equal(openForOwner[1].kind, 'group_highlight')
  assert.equal(openForOwner[1].title, '群友推荐独立游戏')

  store.close()
})

test('Live L1-L5 cross-module interop with createMultiTopicEngine + createRelationalStore', async () => {
  let clock = 100_000
  const store = createRelationalStore({ dbPath: ':memory:', now: () => clock })
  store.seedDefaults()
  const engine = createMultiTopicEngine({
    store,
    warmTtlMs: 30 * 60_000,
    now: () => clock,
  })

  // Topic 1 in owner private chat
  engine.onClaimedTurn({
    sessionId: PRIVATE_SESSION_ID,
    scope: OWNER_SCOPE,
    speakerId: OWNER_ID,
    nickname: '爸爸',
    text: '周末我们去公园放风筝吧',
    messageId: 'm1',
    seq: 1,
    nowMs: clock,
  })

  // Explicit shift to Topic 2 -> Topic 1 moves to warm
  clock += 60_000
  engine.onClaimedTurn({
    sessionId: PRIVATE_SESSION_ID,
    scope: OWNER_SCOPE,
    speakerId: OWNER_ID,
    nickname: '爸爸',
    text: '对了换个事，今晚吃番茄牛腩怎么样',
    messageId: 'm2',
    seq: 2,
    nowMs: clock,
  })

  const speakup = createSpeakupConnector({ store, engine, ownerId: OWNER_ID, now: () => clock })
  const openLoops = speakup.listOpenTopics(PRIVATE_SESSION_ID, { viewerScope: OWNER_SCOPE })
  assert.ok(openLoops.length >= 2)
  const warmLoop = openLoops.find((x) => x.kind === 'warm_topic')
  assert.ok(warmLoop)

  // Focus back to warm topic via focus_attention tool
  const focusTool = createFocusAttentionTool({
    store,
    engine,
    resolveSessionScope: makeScopeResolver(),
  })
  const switched = await focusTool.execute(
    { topicId: warmLoop.topicId },
    { sessionId: PRIVATE_SESSION_ID },
  )
  assert.equal(switched.ok, true)
  assert.equal(switched.focusedTopicId, warmLoop.topicId)

  // Advance clock past warmTtlMs and run idle consolidation -> warm topic becomes SharedEpisode
  clock += 35 * 60_000
  const consolidated = await speakup.runIdleConsolidation({ nowMs: clock })
  assert.ok(consolidated.archivedCount >= 1)

  engine.dispose()
  store.close()
})

