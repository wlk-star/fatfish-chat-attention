import assert from 'node:assert/strict'
import test from 'node:test'
import { buildClassifierPrompt, createTopicClassifier, parseTopicVerdict } from './classifier.mjs'
import { createMultiTopicEngine } from './multi-topic-engine.mjs'
import { clearSnapshotCache, estimateTokens, renderStageSnapshot } from '../projection/snapshot-quantizer.mjs'
import { crystallizeCompaction, crystallizeTopicThread } from '../projection/episode-crystallizer.mjs'

/**
 * Spec-compliant in-memory RelationalStore test double matching L3's exact API & ScopeGate rules.
 */
function createMockRelationalStore() {
  const participants = new Map()
  const edges = []
  const topics = new Map()
  const episodes = new Map()
  const careBiases = new Map()

  function canAccess(viewerScope, recordScope) {
    if (!recordScope || recordScope === 'public_roster') return true
    if (String(viewerScope).startsWith('group:')) {
      return recordScope === 'public_roster' || recordScope === viewerScope
    }
    if (String(viewerScope).startsWith('private:')) {
      return recordScope === viewerScope || recordScope === 'public_roster' || String(recordScope).startsWith('group:')
    }
    return recordScope === 'public_roster'
  }

  const store = {
    seedDefaults({ ownerId = 'qq:1024162823', brotherId = 'qq:616860663' } = {}) {
      participants.set(ownerId, {
        participantId: ownerId,
        id: ownerId,
        preferredCall: '爸爸',
        nickname: 'kk',
        aliases: ['kk', '爸爸'],
        roleToFish: 'owner',
        trust: 'owner_curated',
        scope: 'public_roster',
      })
      participants.set(brotherId, {
        participantId: brotherId,
        id: brotherId,
        preferredCall: '源弟弟',
        nickname: '源天帝',
        aliases: ['源弟弟', '源天帝'],
        roleToFish: 'owner_kin',
        trust: 'owner_curated',
        scope: 'public_roster',
      })
      edges.push({
        id: 'edge-kin-1',
        participants: [ownerId, brotherId],
        relation: '亲兄弟（爸爸与源弟弟/源天帝）',
        scope: 'public_roster',
        trust: 'owner_curated',
        status: 'active',
      })
    },
    upsertParticipant(p) {
      const id = p.participantId || p.id
      const existing = participants.get(id)
      if (existing?.trust === 'owner_curated' && p.trust !== 'owner_curated') return existing
      participants.set(id, { ...existing, ...p, participantId: id, id })
      return participants.get(id)
    },
    getParticipant(id, { viewerScope } = {}) {
      const p = participants.get(id)
      if (!p || !canAccess(viewerScope, p.scope)) return null
      return p
    },
    resolveParticipantsInText(text, { viewerScope } = {}) {
      const s = String(text ?? '')
      const matched = []
      for (const p of participants.values()) {
        if (!canAccess(viewerScope, p.scope)) continue
        const names = [p.preferredCall, ...(p.aliases || [])].filter(Boolean)
        if (s.includes(p.participantId) || names.some(n => s.includes(n))) {
          matched.push(p)
        }
      }
      return matched
    },
    upsertRelationEdge(edge) {
      edges.push({ status: 'active', ...edge })
    },
    getCohortRelations(participantIds, { viewerScope } = {}) {
      const set = new Set(participantIds)
      return edges.filter(e => {
        if (e.status === 'historical' || !canAccess(viewerScope, e.scope)) return false
        const [a, b] = e.participants || [e.sourceId, e.targetId]
        return set.has(a) && set.has(b)
      })
    },
    saveTopic(topic) {
      topics.set(topic.id, { ...topic })
    },
    getTopic(id, { viewerScope } = {}) {
      const t = topics.get(id)
      return t && canAccess(viewerScope, t.scope) ? t : null
    },
    saveEpisode(ep) {
      episodes.set(ep.id, { ...ep })
      return ep
    },
    getEpisode(id, { viewerScope } = {}) {
      const ep = episodes.get(id)
      return ep && !ep.invalidatedByRewind && canAccess(viewerScope, ep.scope) ? ep : null
    },
    searchEpisodes(query, { viewerScope, limit = 5 } = {}) {
      const terms = String(query ?? '').split(/\s+/).filter(Boolean)
      const out = []
      for (const ep of episodes.values()) {
        if (ep.invalidatedByRewind || !canAccess(viewerScope, ep.scope)) continue
        const hay = `${ep.title} ${ep.summary} ${ep.indexLine} ${(ep.keywords || []).join(' ')}`
        if (!terms.length || terms.some(t => hay.includes(t)) || hay.includes('烤肉')) {
          out.push(ep)
        }
      }
      return out.slice(0, limit)
    },
    listRecentGroupHighlights({ groupId, sinceMs = 0, limit = 3 } = {}) {
      const out = []
      for (const ep of episodes.values()) {
        if (ep.invalidatedByRewind) continue
        if (!String(ep.scope ?? '').startsWith('group:')) continue
        if (!ep.isHighlight && !ep.highlight) continue
        if (groupId && ep.groupId !== String(groupId)) continue
        if ((ep.createdAt ?? 0) < sinceMs) continue
        out.push(ep)
      }
      return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, limit)
    },
    invalidateBySeqs(sessionId, seqs) {
      const set = new Set(seqs)
      const invalidated = []
      for (const ep of episodes.values()) {
        if (ep.sessionId !== sessionId || ep.startSeq == null || ep.endSeq == null) continue
        for (const s of set) {
          if (s >= ep.startSeq && s <= ep.endSeq) {
            ep.invalidatedByRewind = true
            invalidated.push(ep.id)
            break
          }
        }
      }
      return invalidated
    },
    setCareBias(participantId, { tone, expiresAt }) {
      careBiases.set(participantId, { tone, expiresAt })
    },
    getCareBias(participantId, nowMs = Date.now()) {
      const b = careBiases.get(participantId)
      if (!b || (b.expiresAt && nowMs > b.expiresAt)) return null
      return b
    },
  }
  store.seedDefaults()
  return store
}

function createHarness({ classifyBatch, store = createMockRelationalStore(), extra = {} } = {}) {
  let clock = 10_000_000
  let nextTimerId = 0
  const timers = new Map()
  const wakes = []
  const events = []

  const engine = createMultiTopicEngine({
    groupId: '1135493428',
    groupSessionId: 'session-group',
    ownerId: 'qq:1024162823',
    ownerSessionId: 'session-private',
    sessionScopes: {
      'session-private': 'private:qq:1024162823',
      'session-group': 'group:1135493428',
    },
    nicknames: ['蓝蓝', '大肥鱼'],
    selfUserId: 'qq:999999999',
    quietMs: 1_000,
    maxBatchMs: 3_000,
    classifyIntervalMs: 0,
    cooldownMs: 5_000,
    warmTtlMs: 30 * 60_000,
    fastContinuationMs: 45_000,
    store,
    classifyBatch,
    requestWake: req => wakes.push(req),
    onEvent: ev => events.push(ev),
    now: () => clock,
    setTimeout: (fn, delay) => {
      const id = ++nextTimerId
      timers.set(id, { at: clock + delay, fn })
      return id
    },
    clearTimeout: id => timers.delete(id),
    ...extra,
  })

  async function advance(ms) {
    clock += ms
    for (const [id, entry] of [...timers.entries()]) {
      if (entry.at <= clock) {
        timers.delete(id)
        entry.fn()
      }
    }
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
  }

  return {
    engine,
    store,
    wakes,
    events,
    advance,
    now: () => clock,
  }
}

test('parseTopicVerdict and createTopicClassifier follow DSH v4 source contract and legacy fallback', async () => {
  const full = parseTopicVerdict(`\`\`\`json
  {"topicAction":"switch","topicId":"t-1","topicTitle":"周末烤肉","activeParticipants":["qq:1024162823","qq:616860663"],"related":true,"reply":true,"replyTargetIds":["qq:616860663"],"triggerMessageId":"m-8","end":false}
  \`\`\``)
  assert.deepEqual(full, {
    topicAction: 'switch',
    topicId: 't-1',
    topicTitle: '周末烤肉',
    activeParticipants: ['qq:1024162823', 'qq:616860663'],
    related: true,
    reply: true,
    replyTargetIds: ['qq:616860663'],
    triggerMessageId: 'm-8',
    end: false,
  })

  const legacy = parseTopicVerdict('{"related":true,"reply":false,"end":false}')
  assert.equal(legacy.topicAction, 'continue')
  assert.equal(legacy.related, true)
  assert.equal(legacy.reply, false)
  assert.equal(parseTopicVerdict('{}'), null)
  assert.equal(parseTopicVerdict('not-json'), null)

  let capturedStreamReq = null
  let budgetCount = 0
  const classifier = createTopicClassifier({
    onBudget: () => { budgetCount += 1 },
    llm: {
      async *stream(req) {
        capturedStreamReq = req
        yield { type: 'text-delta', text: '{"topicAction":"continue","reply":true,"activeParticipants":["qq:1","qq:2"]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })

  const verdict = await classifier({
    activeTopics: [{ id: 'topic-1', status: 'focused', title: '烤肉' }],
    batch: [{ messageId: 'msg-42', speakerId: 'qq:2', who: '源弟弟', text: '加点孜然吗？' }],
    history: [{ who: '爸爸', text: '蓝蓝，今晚吃烤肉' }],
    groupId: '1135493428',
  })

  assert.equal(budgetCount, 1)
  assert.deepEqual(capturedStreamReq.messages[0].source, { kind: 'plugin:dsh-relational-attention' })
  assert.equal(verdict.topicId, 'topic-1')
  assert.equal(verdict.triggerMessageId, 'msg-42')
  assert.deepEqual(verdict.activeParticipants, ['qq:1', 'qq:2'])
})

test('multi-person cohort accumulation and byte-identical quantized snapshots across intra-topic turns', async () => {
  clearSnapshotCache()
  const classifyCalls = []
  const h = createHarness({
    classifyBatch: async payload => {
      classifyCalls.push(payload)
      return {
        topicAction: 'continue',
        topicId: payload.activeTopics[0]?.id ?? null,
        topicTitle: '周末烤肉安排',
        activeParticipants: payload.batch.map(b => b.speakerId),
        related: true,
        reply: false,
        replyTargetIds: [],
        triggerMessageId: null,
        end: false,
      }
    },
  })

  // Seed private secret edge + affect-only careBias to verify ScopeGate isolation in group snapshot
  h.store.upsertRelationEdge({
    id: 'edge-private-secret',
    participants: ['qq:1024162823', 'qq:999000'],
    relation: '私聊机密合作方',
    scope: 'private:qq:1024162823',
    trust: 'owner_curated',
  })
  h.store.setCareBias('qq:1024162823', {
    tone: '心里有点牵挂，对爸爸语气格外温和体贴',
    expiresAt: h.now() + 3600_000,
  })
  h.store.saveEpisode({
    id: 'ep-camping-bbq',
    episodeId: 'ep-camping-bbq',
    scope: 'group:1135493428',
    groupId: '1135493428',
    title: '上次露营烤肉蘸料',
    summary: '爸爸和源弟弟上次露营试了干碟烤肉蘸料',
    indexLine: '爸爸、源弟弟聊「上次露营烤肉蘸料」',
    keywords: ['烤肉', '蘸料'],
    createdAt: h.now() - 86400_000,
  })

  // 1. Owner opens topic
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '1024162823',
      nickname: 'kk',
      messageId: 'm1',
      seq: 1,
      text: '蓝蓝，周末烤肉买什么肉好？',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'at' },
    at: h.now(),
  })

  const stageAfterOpen = h.engine.getStage('session-group')
  assert.equal(stageAfterOpen.epoch, 1)
  assert.deepEqual(Object.keys(stageAfterOpen.focused.cohort), ['qq:1024162823'])

  // 2. Brother (源弟弟) and friend (阿哲) join the same topic -> cohort accumulates all 3!
  await h.advance(2_000)
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '616860663',
      nickname: '源天帝',
      messageId: 'm2',
      seq: 2,
      text: '五花肉和牛肋条必须安排上',
    },
    candidateToken: 'tok-m2',
    decision: { action: 'record', reason: 'sampled-out' },
    at: h.now(),
  })
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '888001',
      nickname: '阿哲',
      messageId: 'm3',
      seq: 3,
      text: '我带果木炭和烤架',
    },
    candidateToken: 'tok-m3',
    decision: { action: 'record', reason: 'sampled-out' },
    at: h.now(),
  })
  await h.advance(1_000)

  const stageWith3 = h.engine.getStage('session-group')
  assert.equal(stageWith3.epoch, 2)
  assert.deepEqual(
    Object.keys(stageWith3.focused.cohort),
    ['qq:1024162823', 'qq:616860663', 'qq:888001'],
    'cohort must retain all 3 active participants rather than only the last speaker',
  )
  assert.equal(stageWith3.focused.cohort['qq:1024162823'].roleInTopic, 'initiator')
  assert.equal(stageWith3.focused.cohort['qq:616860663'].roleInTopic, 'participant')
  assert.equal(stageWith3.focused.cohort['qq:888001'].roleInTopic, 'participant')

  const snap1 = renderStageSnapshot({
    stage: stageWith3,
    store: h.store,
    viewerScope: 'group:1135493428',
    isGroup: true,
    nowMs: h.now(),
  })
  assert.ok(snap1.includes('[当前话题舞台]'))
  assert.ok(snap1.includes('爸爸(qq:1024162823)'))
  assert.ok(snap1.includes('源弟弟(qq:616860663)'))
  assert.ok(snap1.includes('阿哲(qq:888001)'))
  assert.ok(snap1.includes('亲兄弟（爸爸与源弟弟/源天帝）'))
  assert.ok(snap1.includes('语气留意:心里有点牵挂'))
  assert.ok(snap1.includes('[温热挂起话题]'))
  assert.ok(snap1.includes('[关联共同经历索引]'))
  assert.ok(snap1.includes('[ep-camping-bbq]'))
  assert.ok(snap1.includes('focus_attention'))
  assert.ok(!snap1.includes('私聊机密合作方'), 'private scope edge must never leak into group snapshot')
  assert.ok(estimateTokens(snap1) <= 450)

  // 3. Consecutive back-and-forth turns among existing 3 cohort members MUST NOT bump epoch
  //    and MUST render byte-identical snapshots even as clock advances!
  const followUps = [
    { uid: '616860663', nick: '源天帝', id: 'm4', text: '五花肉切厚片比较香' },
    { uid: '888001', nick: '阿哲', id: 'm5', text: '再买点生菜和蒜片解腻' },
    { uid: '1024162823', nick: 'kk', id: 'm6', text: '好，那我订三斤肉' },
  ]
  for (let i = 0; i < followUps.length; i++) {
    await h.advance(8_000)
    const f = followUps[i]
    h.engine.onGroupInbound({
      transport: true,
      message: {
        groupId: '1135493428',
        userId: f.uid,
        nickname: f.nick,
        messageId: f.id,
        seq: 4 + i,
        text: f.text,
      },
      candidateToken: `tok-${f.id}`,
      decision: { action: 'record', reason: 'sampled-out' },
      at: h.now(),
    })
    await h.advance(1_000)

    const currentStage = h.engine.getStage('session-group')
    assert.equal(currentStage.epoch, 2, 'intra-topic turns among existing cohort must not bump epoch')
    const nextSnap = renderStageSnapshot({
      stage: currentStage,
      store: h.store,
      viewerScope: 'group:1135493428',
      isGroup: true,
      nowMs: h.now() + 99_999,
    })
    assert.equal(nextSnap, snap1, 'consecutive intra-topic turns must yield byte-identical snapshot')
  }

  h.engine.dispose()
})

test('ping-pong focused <-> warm zero-fragmentation and replyToMessageId fast routing (0 LLM calls)', async () => {
  let llmClassifyCount = 0
  const h = createHarness({
    classifyBatch: async () => {
      llmClassifyCount += 1
      return {
        topicAction: 'continue',
        topicId: null,
        topicTitle: '',
        activeParticipants: [],
        related: true,
        reply: false,
        replyTargetIds: [],
        triggerMessageId: null,
        end: false,
      }
    },
  })

  // 1. Topic A started: 烤肉
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '1024162823',
      nickname: 'kk',
      messageId: 'bbq-1',
      seq: 10,
      text: '蓝蓝，周末烤肉蘸料怎么配？',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'at' },
    at: h.now(),
  })
  h.engine.onGroupOutbound({
    groupId: '1135493428',
    text: '孜然粉、辣椒面加白芝麻泼热油超香！',
    messageId: 'bot-bbq-reply',
    replyToMessageId: 'bbq-1',
    seq: 11,
    at: h.now() + 500,
  })

  const topicAId = h.engine.getStage('session-group').focused.id
  assert.ok(topicAId)
  assert.equal(llmClassifyCount, 0)

  // 2. Topic B interrupts: 路由器断网 -> Topic A becomes warm, Topic B becomes focused
  await h.advance(10_000)
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '888001',
      nickname: '阿哲',
      messageId: 'wifi-1',
      seq: 12,
      text: '@蓝蓝 家里路由器DNS解析失败怎么排查？',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'at' },
    at: h.now(),
  })

  const stageDuringB = h.engine.getStage('session-group')
  const topicBId = stageDuringB.focused.id
  assert.notEqual(topicBId, topicAId)
  assert.equal(stageDuringB.warm.length, 1)
  assert.equal(stageDuringB.warm[0].id, topicAId, 'Topic A must reside in warm pool without fragmentation')
  assert.equal(stageDuringB.activeTopicCount, 2)
  assert.equal(llmClassifyCount, 0)

  // 3. Brother quotes message `bbq-1` (or `bot-bbq-reply`) -> FAST PATH switches Topic A back to focused in 0 LLM calls!
  await h.advance(10_000)
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '616860663',
      nickname: '源天帝',
      messageId: 'bbq-2',
      replyToMessageId: 'bot-bbq-reply',
      seq: 13,
      text: '花生碎要不要加一点？',
    },
    candidateToken: 'tok-bbq-2',
    decision: { action: 'record', reason: 'sampled-out' },
    at: h.now(),
  })

  const stageBackToA = h.engine.getStage('session-group')
  assert.equal(llmClassifyCount, 0, 'replyToMessageId matching known topic must use 0 LLM calls')
  assert.equal(stageBackToA.focused.id, topicAId, 'must resume exact Topic A ID with zero fragmentation')
  assert.equal(stageBackToA.warm.length, 1)
  assert.equal(stageBackToA.warm[0].id, topicBId, 'Topic B moves cleanly into warm pool')
  assert.deepEqual(
    Object.keys(stageBackToA.focused.cohort),
    ['qq:1024162823', 'qq:616860663'],
    'quoting speaker joins Topic A cohort alongside original initiator',
  )
  assert.equal(h.wakes.length, 1, 'quoting Fatfish message triggers wake immediately after cooldown')
  assert.equal(h.wakes[0].candidateToken, 'tok-bbq-2')
  assert.equal(h.wakes[0].topicId, topicAId)
  assert.equal(h.wakes[0].triggerMessageId, 'bbq-2')
  assert.equal(h.wakes[0].activeTopicCount, 2)

  // 4. Explicit focusTopic switches back to Topic B, then warm TTL expiry archives Topic A into SharedEpisode
  const switched = h.engine.focusTopic('session-group', topicBId, h.now())
  assert.equal(switched.id, topicBId)
  assert.equal(h.engine.getStage('session-group').warm[0].id, topicAId)

  await h.advance(31 * 60_000)
  const archived = h.engine.archiveWarmTopics({ nowMs: h.now() })
  assert.equal(archived.length, 1)
  assert.equal(archived[0].id, topicAId)
  assert.equal(h.engine.getStage('session-group').warm.length, 0)

  const savedEp = h.store.getEpisode(`ep-${topicAId}`, { viewerScope: 'group:1135493428' })
  assert.ok(savedEp, 'expired warm topic must crystallize into SharedEpisode')
  assert.deepEqual(savedEp.participantIds, ['qq:1024162823', 'qq:616860663'])

  h.engine.dispose()
})

test('private chat zero-bloat empty return, <45s fast continuation, 3rd-party mention, and group highlight projection', async () => {
  clearSnapshotCache()
  const h = createHarness()

  // Internal triggers must be ignored
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    text: '[speak-up tick]',
    sourceKind: 'speak-up',
    nowMs: h.now(),
  })
  assert.equal(h.engine.getStage('session-private').focused, null)

  // 1. Single private topic, no warm topics, no 3rd party, no group highlights -> MUST return ""
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '今晚准备重构一下后端接口',
    seq: 1,
    nowMs: h.now(),
  })
  const pStage1 = h.engine.getStage('session-private')
  assert.equal(pStage1.epoch, 1)
  const emptySnap1 = renderStageSnapshot({
    stage: pStage1,
    store: h.store,
    viewerScope: 'private:qq:1024162823',
    isGroup: false,
    nowMs: h.now(),
  })
  assert.equal(emptySnap1, '', 'single 1-on-1 private topic without warm/3rd-party/highlights must return ""')

  // Within <45s continuation -> stays on same topic, epoch unchanged, still ""
  await h.advance(20_000)
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '先把鉴权中间件拆出来',
    seq: 2,
    nowMs: h.now(),
  })
  const pStage2 = h.engine.getStage('session-private')
  assert.equal(pStage2.epoch, 1)
  assert.equal(pStage2.warm.length, 0)
  assert.equal(
    renderStageSnapshot({
      stage: pStage2,
      store: h.store,
      viewerScope: 'private:qq:1024162823',
      isGroup: false,
      nowMs: h.now(),
    }),
    '',
  )

  // 2. Mentioning 3rd-party relative (源弟弟) adds mentioned participant -> bumps epoch & renders compact index
  await h.advance(15_000)
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '周末还要带源弟弟去配台新电脑',
    seq: 3,
    nowMs: h.now(),
  })
  const pStage3 = h.engine.getStage('session-private')
  assert.equal(pStage3.epoch, 2)
  assert.equal(pStage3.focused.cohort['qq:616860663']?.roleInTopic, 'mentioned')

  const thirdPartySnap = renderStageSnapshot({
    stage: pStage3,
    store: h.store,
    viewerScope: 'private:qq:1024162823',
    isGroup: false,
    nowMs: h.now(),
  })
  assert.ok(thirdPartySnap.includes('[提及亲友]'))
  assert.ok(thirdPartySnap.includes('源弟弟(qq:616860663)'))
  assert.ok(estimateTokens(thirdPartySnap) <= 150)

  // 3. New group highlight arrives -> bumps private stage epoch ONCE and renders [群聊近期动态] <= 150 tokens
  h.store.saveEpisode({
    id: 'ep-group-highlight-1',
    episodeId: 'ep-group-highlight-1',
    sessionId: 'session-group',
    scope: 'group:1135493428',
    groupId: '1135493428',
    title: '源弟弟晒新显卡跑分',
    summary: '源弟弟在群里晒了新显卡跑分，群友们围观祝贺',
    indexLine: '源弟弟、阿哲聊「源弟弟晒新显卡跑分」',
    isHighlight: true,
    highlight: true,
    createdAt: h.now(),
  })

  const pStage4 = h.engine.getStage('session-private')
  assert.equal(pStage4.epoch, 3, 'new unseen group highlight must bump owner private stage epoch')

  const highlightSnapA = renderStageSnapshot({
    stage: pStage4,
    store: h.store,
    viewerScope: 'private:qq:1024162823',
    isGroup: false,
    nowMs: h.now(),
  })
  assert.ok(highlightSnapA.includes('[群聊近期动态]'))
  assert.ok(highlightSnapA.includes('[ep-group-highlight-1]'))
  assert.ok(highlightSnapA.includes('源弟弟晒新显卡跑分'))
  assert.ok(estimateTokens(highlightSnapA) <= 150)

  // Consecutive turn with no new group highlight -> epoch stays 3 and snapshot is byte-identical!
  await h.advance(10_000)
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '电源配750W应该够用',
    seq: 4,
    nowMs: h.now(),
  })
  const pStage5 = h.engine.getStage('session-private')
  assert.equal(pStage5.epoch, 3)
  const highlightSnapB = renderStageSnapshot({
    stage: pStage5,
    store: h.store,
    viewerScope: 'private:qq:1024162823',
    isGroup: false,
    nowMs: h.now() + 50_000,
  })
  assert.equal(highlightSnapB, highlightSnapA)

  h.engine.dispose()
})

test('crystallizeCompaction, crystallizeTopicThread, and invalidateBySeqs rewind consistency', () => {
  const h = createHarness()

  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '记一下下周五去体检',
    messageId: 'pm-1',
    seq: 10,
    nowMs: h.now(),
  })
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '对了，源弟弟下个月生日买什么礼物？',
    messageId: 'pm-2',
    seq: 15,
    nowMs: h.now() + 5_000,
  })

  const beforeRewind = h.engine.getStage('session-private')
  assert.equal(beforeRewind.warm.length, 1)
  assert.ok(beforeRewind.focused.title.includes('源弟弟'))

  const moodConnector = {
    extractMoodSlice: ({ sessionId }) => ({
      slotId: sessionId.replace(/^session-/, ''),
      startMood: 78,
      endMood: 86,
      label: '开心期待',
    }),
  }

  const compactEp = crystallizeCompaction({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    sliceStartSeq: 1,
    sliceEndSeq: 12,
    summaryText: '爸爸提到下周五要去医院做年度体检，提醒空腹。',
    stage: beforeRewind,
    store: h.store,
    moodConnector,
    nowMs: h.now() + 6_000,
  })
  assert.ok(compactEp)
  assert.deepEqual(compactEp.seqRange, { startSeq: 1, endSeq: 12, min: 1, max: 12 })
  assert.equal(compactEp.moodSlice?.endMood, 86)
  assert.equal(compactEp.isHighlight, false)

  // Group episode crystallization must NEVER attach private moodSlice
  const groupEp = crystallizeTopicThread({
    topic: {
      id: 'g-topic-1',
      sessionId: 'session-group',
      scope: 'group:1135493428',
      title: '群友约打球',
      cohort: { 'qq:616860663': { nickname: '源弟弟', stanceSummary: '周六下午有空' } },
      messages: [
        { seq: 20, speakerId: 'qq:616860663', nickname: '源弟弟', text: '周六下午打羽毛球吗' },
        { seq: 21, speakerId: 'qq:888001', nickname: '阿哲', text: '算我一个' },
      ],
    },
    store: h.store,
    moodConnector,
    nowMs: h.now() + 7_000,
  })
  assert.equal(groupEp.moodSlice, null, 'group episodes must never carry private moodSlice')
  assert.equal(groupEp.isHighlight, true)

  // Rewind seq 15 retracts the birthday topic and restores the checkup topic as focused!
  const rewindRes = h.engine.invalidateBySeqs('session-private', [15])
  assert.equal(rewindRes.removedTopicIds.length, 1)
  const afterRewind = h.engine.getStage('session-private')
  assert.ok(afterRewind.focused.title.includes('体检'))
  assert.equal(afterRewind.warm.length, 0)

  h.engine.dispose()
})

test('live interoperability with L3 SQLite + FTS5 createRelationalStore', async () => {
  const { createRelationalStore } = await import('../store/sqlite-repo.mjs')
  let clock = 20_000_000
  const realStore = createRelationalStore({ dbPath: ':memory:', now: () => clock })
  realStore.seedDefaults()

  const h = createHarness({ store: realStore })
  clock = h.now()

  // Group turn with 爸爸 & 源弟弟 -> crystallize warm topic -> verify FTS5 search & private highlight projection
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '1024162823',
      nickname: 'kk',
      messageId: 'sq-1',
      seq: 1,
      text: '蓝蓝，源天帝今晚请大家吃潮汕牛肉火锅！',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'at' },
    at: h.now(),
  })

  const gStage = h.engine.getStage('session-group')
  assert.deepEqual(
    Object.keys(gStage.focused.cohort),
    ['qq:1024162823', 'qq:616860663'],
    'real SQLite store alias resolution ("源天帝") must populate 源弟弟 into cohort',
  )

  const gSnap = renderStageSnapshot({
    stage: gStage,
    store: realStore,
    viewerScope: 'group:1135493428',
    isGroup: true,
    nowMs: h.now(),
  })
  assert.ok(gSnap.includes('爸爸(qq:1024162823)'))
  assert.ok(gSnap.includes('源弟弟(qq:616860663)'))
  assert.ok(gSnap.includes('亲兄弟（爸爸与源弟弟/源天帝）'))

  // Switch group topic so the hotpot topic warms and then archives into SQLite FTS5
  await h.advance(5_000)
  clock = h.now()
  h.engine.onGroupInbound({
    transport: true,
    message: {
      groupId: '1135493428',
      userId: '888002',
      nickname: '小周',
      messageId: 'sq-2',
      seq: 2,
      text: '@蓝蓝 顺便问下周日羽毛球场订几点？',
      atSelf: true,
    },
    decision: { action: 'wake', reason: 'at' },
    at: h.now(),
  })

  await h.advance(31 * 60_000)
  clock = h.now()
  const archived = h.engine.archiveWarmTopics({ nowMs: h.now() })
  assert.equal(archived.length, 1)

  const ftsHits = realStore.searchEpisodes('潮汕牛肉火锅', { viewerScope: 'group:1135493428' })
  assert.equal(ftsHits.length, 1)

  // Owner private session sees the group highlight automatically!
  h.engine.onClaimedTurn({
    sessionId: 'session-private',
    scope: 'private:qq:1024162823',
    speakerId: 'qq:1024162823',
    nickname: '爸爸',
    text: '刚忙完手头的事',
    seq: 10,
    nowMs: h.now(),
  })
  const pStage = h.engine.getStage('session-private')
  const pSnap = renderStageSnapshot({
    stage: pStage,
    store: realStore,
    viewerScope: 'private:qq:1024162823',
    isGroup: false,
    nowMs: h.now(),
  })
  assert.ok(pSnap.includes('[群聊近期动态]'))
  assert.ok(pSnap.includes('潮汕牛肉火锅'))
  assert.ok(estimateTokens(pSnap) <= 150)

  h.engine.dispose()
  realStore.close()
})
