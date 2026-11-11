import { usable } from '../engine.mjs'
import { parseTopicVerdict } from './classifier.mjs'
import {
  cleanIndexText,
  crystallizeTopicThread,
  extractEpisodeKeywords,
} from '../projection/episode-crystallizer.mjs'

const INTERNAL_SOURCE_KINDS = new Set([
  'speak-up',
  'runtime-context',
  'system-reminder',
  'compact-checkpoint',
  'agent-notification',
  'slash-command',
  'dsh-rewind',
])

const TOPIC_SHIFT_CUE_RE = /^(?:对了|顺便(?:问一下|问下|说一下|说下)?|另外|换个话题|说另一件事|先不说这个|扯远了)[，,、：:\s]*/u
const TOPIC_RESUME_CUE_RE = /(?:说回|聊回|回到刚才|刚才说的|前面说的|接着聊)/u
const EMBEDDED_IDENTITY_RE = /([^\s()（）:：\[\]]{1,24})\(qq:(\d{4,15})\)/u

const DEFAULTS = {
  groupId: '',
  groupSessionId: '',
  ownerId: 'qq:1024162823',
  ownerSessionId: '',
  sessionScopes: {},
  nicknames: ['蓝蓝', '大肥鱼'],
  selfUserId: '',
  warmTtlMs: 30 * 60_000,
  fastContinuationMs: 45_000,
  windowMs: 8 * 60_000,
  maxWindowMs: 30 * 60_000,
  quietMs: 8_000,
  maxBatchMs: 25_000,
  classifyIntervalMs: 20_000,
  cooldownMs: 60_000,
  maxAutoReplies: 3,
  unrelatedLimit: 2,
  historyLimit: 8,
  maxWarmTopics: 6,
  maxTopicMessages: 40,
  ignoredUserIds: [],
}

let nextStageUid = 1

const clean = (value, max = 600) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const compact = value => clean(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

function called(text, names) {
  const stripped = clean(text).replace(/@\S+/g, match => match)
  const value = compact(stripped)
  return (names || []).some(name => {
    const n = compact(name)
    return n && value.includes(n)
  })
}

export function normalizeSpeakerId(raw) {
  if (raw == null) return ''
  const s = String(raw).trim()
  if (!s) return ''
  if (s === 'self' || s === 'bot') return 'self'
  if (s.includes(':')) return s
  if (/^\d+$/.test(s)) return `qq:${s}`
  return s
}

function stripBotAddress(text, nicknames = []) {
  let out = clean(text, 200)
  out = out.replace(/^@\S+\s*/g, '')
  for (const name of nicknames) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`^${escaped}[，,、：:\\s]+`, 'iu'), '')
  }
  out = out.replace(TOPIC_SHIFT_CUE_RE, '')
  return out.trim() || clean(text, 60)
}

function inferTopicTitle(text, nicknames = []) {
  const core = stripBotAddress(text, nicknames)
  const firstClause = core.split(/[\n。！？!?；;]/)[0] || core
  return cleanIndexText(firstClause, 24) || '日常闲聊'
}

function inferOpenQuestion(text) {
  const s = clean(text, 160)
  if (!s) return ''
  if (/[？?]|(?:吗|呢|怎么|为什么|多少|几[点个秒天]|好不好|行不行|能不能|要不要)\s*[呀啊嘛呢吧]?$/.test(s)) {
    return cleanIndexText(s, 56)
  }
  return ''
}

function mergeStanceSummary(prev, latest) {
  const p = cleanIndexText(prev, 64)
  const l = cleanIndexText(latest, 48)
  if (!l) return p
  if (!p || p === l || p.includes(l)) return p || l
  if (l.includes(p)) return l
  return cleanIndexText(`${p}；${l}`, 72)
}

function trimHistoryWithAnchor(items, anchor, limit) {
  const max = Math.max(1, Number(limit) || 8)
  if (!items.length) return anchor ? [anchor] : []
  if (!anchor) return items.slice(-max)
  const rest = items[0] === anchor
    ? items.slice(1)
    : items.filter((item, idx) => !(idx === 0 && item.who === anchor.who && item.text === anchor.text))
  if (max === 1) return [anchor]
  return [anchor, ...rest.slice(-(max - 1))]
}

function cloneCohort(cohort = {}) {
  const out = {}
  for (const [pid, member] of Object.entries(cohort)) {
    out[pid] = { ...member }
  }
  return out
}

function cloneTopic(topic) {
  if (!topic) return null
  return {
    ...topic,
    keywords: [...(topic.keywords || [])],
    cohort: cloneCohort(topic.cohort),
    messages: (topic.messages || []).map(m => ({ ...m })),
    seqRange: topic.seqRange ? { ...topic.seqRange } : { startSeq: null, endSeq: null },
  }
}

export function createMultiTopicEngine(options = {}) {
  const o = { ...DEFAULTS, ...options }
  const now = o.now ?? Date.now
  const later = o.setTimeout ?? setTimeout
  const clear = o.clearTimeout ?? clearTimeout
  const classifyFn = o.classifyBatch ?? o.classify ?? null
  const requestWake = o.requestWake ?? null
  const store = o.store ?? null

  const ignored = new Set((o.ignoredUserIds || []).map(v => String(v).trim()))
  const normalizedSelfId = o.selfUserId ? normalizeSpeakerId(o.selfUserId) : ''

  const stages = new Map()
  const scopeToSession = new Map()
  const groupToSession = new Map()
  let topicSeq = 0
  let closed = false

  for (const [sid, scope] of Object.entries(o.sessionScopes || {})) {
    const cleanSid = String(sid).trim()
    const cleanScope = String(scope).trim()
    if (!cleanSid || !cleanScope) continue
    scopeToSession.set(cleanScope, cleanSid)
    if (cleanScope.startsWith('group:')) {
      groupToSession.set(cleanScope.slice('group:'.length), cleanSid)
    }
  }
  if (o.groupId && o.groupSessionId) {
    groupToSession.set(String(o.groupId), String(o.groupSessionId))
    scopeToSession.set(`group:${o.groupId}`, String(o.groupSessionId))
  }
  if (o.ownerId && o.ownerSessionId) {
    scopeToSession.set(`private:${normalizeSpeakerId(o.ownerId)}`, String(o.ownerSessionId))
  }

  function resolveGroupSessionId(groupId, explicitSessionId) {
    const gid = String(groupId ?? o.groupId ?? '').trim()
    if (explicitSessionId) {
      const sid = String(explicitSessionId).trim()
      if (gid) groupToSession.set(gid, sid)
      return sid
    }
    if (gid && groupToSession.has(gid)) return groupToSession.get(gid)
    if (o.groupSessionId && (!o.groupId || String(o.groupId) === gid)) return String(o.groupSessionId)
    return `group:${gid || 'default'}`
  }

  function captureEpochSignature(stage) {
    const focusedId = stage.focused?.id ?? ''
    const cohortKey = stage.focused?.cohort
      ? Object.keys(stage.focused.cohort)
          .filter(k => k && k !== 'self' && k !== 'bot')
          .sort()
          .join(',')
      : ''
    const warmKey = stage.warm.map(t => t.id).sort().join(',')
    const unseenKey = [...stage.unseenHighlightIds].sort().join(',')
    return `${focusedId}|${cohortKey}|${warmKey}|${unseenKey}`
  }

  function syncEpoch(stage) {
    const nextSig = captureEpochSignature(stage)
    if (nextSig !== stage._lastEpochSig) {
      stage._lastEpochSig = nextSig
      stage.epoch += 1
      return true
    }
    return false
  }

  function ensureStage(sessionId, scopeHint = '', groupIdHint = null) {
    const sid = String(sessionId).trim()
    let stage = stages.get(sid)
    if (stage) {
      if (scopeHint && (!stage.scope || stage.scope === sid)) stage.scope = scopeHint
      if (groupIdHint && !stage.groupId) stage.groupId = String(groupIdHint)
      return stage
    }

    const configuredScope = o.sessionScopes?.[sid]
    const inferredScope = String(
      scopeHint ||
      configuredScope ||
      (groupIdHint ? `group:${groupIdHint}` : (sid.startsWith('group:') || sid.startsWith('private:') ? sid : `private:${normalizeSpeakerId(o.ownerId)}`)),
    )
    const gid = groupIdHint != null
      ? String(groupIdHint)
      : (inferredScope.startsWith('group:') ? inferredScope.slice('group:'.length) : null)

    stage = {
      _stageUid: nextStageUid++,
      sessionId: sid,
      scope: inferredScope,
      groupId: gid,
      epoch: 0,
      highlightRevision: 0,
      focused: null,
      warm: [],
      archivedIds: [],
      messageTopicMap: new Map(),
      messageOrder: [],
      seenMessageIds: new Set(),
      seenMessageOrder: [],
      selfMessageIds: new Set(),
      selfMessageOrder: [],
      knownHighlightIds: new Set(),
      unseenHighlightIds: new Set(),
      unseenGroupHighlights: [],
      sharedHighlightIds: new Set(),
      sharedHighlightBeforeMs: 0,
      // Group attention gate runtime state
      gate: {
        active: false,
        generation: 0,
        openedAt: 0,
        activeUntil: 0,
        lastWakeAt: 0,
        unrelated: 0,
        autoReplies: 0,
        topicAnchor: null,
        history: [],
        batch: [],
        batchStartedAt: 0,
        version: 0,
        lastClassifyAt: 0,
        running: false,
        timer: null,
        wakeTimer: null,
        pendingWake: null,
      },
      _lastEpochSig: '||',
    }
    stage._lastEpochSig = captureEpochSignature(stage)
    stages.set(sid, stage)
    scopeToSession.set(inferredScope, sid)
    if (gid) groupToSession.set(gid, sid)
    return stage
  }

  function findStage(sessionIdOrScope) {
    const key = String(sessionIdOrScope ?? '').trim()
    if (!key) return null
    if (stages.has(key)) return stages.get(key)
    const mapped = scopeToSession.get(key) || groupToSession.get(key)
    if (mapped && stages.has(mapped)) return stages.get(mapped)
    return null
  }

  function rememberSeenMessage(stage, messageId) {
    if (messageId == null || String(messageId) === '') return true
    const id = String(messageId)
    if (stage.seenMessageIds.has(id)) return false
    stage.seenMessageIds.add(id)
    stage.seenMessageOrder.push(id)
    while (stage.seenMessageOrder.length > 512) {
      stage.seenMessageIds.delete(stage.seenMessageOrder.shift())
    }
    return true
  }

  function bindMessageToTopic(stage, messageId, topicId) {
    if (messageId == null || String(messageId) === '' || !topicId) return
    const id = String(messageId)
    stage.messageTopicMap.set(id, topicId)
    stage.messageOrder.push(id)
    while (stage.messageOrder.length > 512) {
      const oldest = stage.messageOrder.shift()
      stage.messageTopicMap.delete(oldest)
    }
  }

  function rememberSelfMessage(stage, messageId, topicId) {
    if (messageId == null || String(messageId) === '') return
    const id = String(messageId)
    stage.selfMessageIds.add(id)
    stage.selfMessageOrder.push(id)
    while (stage.selfMessageOrder.length > 256) {
      stage.selfMessageIds.delete(stage.selfMessageOrder.shift())
    }
    if (topicId) bindMessageToTopic(stage, id, topicId)
  }

  function persistTopic(topic) {
    if (!store || typeof store.saveTopic !== 'function' || !topic) return
    try {
      store.saveTopic({
        ...topic,
        topicId: topic.id,
        participantIds: Object.keys(topic.cohort),
        messageIds: (topic.messages || []).map(m => m.messageId).filter(Boolean),
        anchorMessageId: topic.messages?.[0]?.messageId ?? null,
        openLoops: topic.openQuestion ? [topic.openQuestion] : [],
        warmUntil: topic.status === 'warm' && Number.isFinite(topic.warmedAt)
          ? topic.warmedAt + o.warmTtlMs
          : null,
        lastActiveAt: topic.updatedAt,
      })
    } catch {
      // Optional store persistence
    }
  }

  function ensureObservedParticipant(stage, speakerId, nickname) {
    if (!store || typeof store.getParticipant !== 'function' || typeof store.upsertParticipant !== 'function') return
    if (!speakerId || speakerId === 'self' || speakerId === 'bot') return
    try {
      const existing = store.getParticipant(speakerId, { viewerScope: stage.scope })
      if (existing) return
      const cleanNick = clean(nickname, 32)
      if (!cleanNick) return
      store.upsertParticipant({
        id: speakerId,
        participantId: speakerId,
        nickname: cleanNick,
        preferredCall: cleanNick,
        aliases: [cleanNick],
        roleToFish: 'member',
        trust: 'fish_observed',
        scope: stage.scope,
      })
    } catch {
      // ignore if store rejects or uses strict schema
    }
  }

  function resolveMentionedParticipants(stage, text) {
    const out = []
    const seen = new Set()
    const push = raw => {
      const pid = normalizeSpeakerId(typeof raw === 'string' ? raw : (raw?.participantId ?? raw?.id))
      if (!pid || pid === 'self' || seen.has(pid)) return
      seen.add(pid)
      out.push({
        pid,
        nickname: typeof raw === 'object' ? clean(raw?.preferredCall || raw?.nickname || '', 32) : '',
      })
    }

    for (const m of String(text ?? '').matchAll(/([^\s()（）:：\[\]]{1,24})\(qq:(\d{4,15})\)/gu)) {
      push({ participantId: `qq:${m[2]}`, nickname: m[1] })
    }
    for (const m of String(text ?? '').matchAll(/\bqq:(\d{4,15})\b/gi)) {
      push(`qq:${m[1]}`)
    }

    if (store && typeof store.resolveParticipantsInText === 'function' && text) {
      try {
        const resolved = store.resolveParticipantsInText(text, { viewerScope: stage.scope }) || []
        for (const item of resolved) push(item)
      } catch {
        // ignore optional store resolution failure
      }
    }
    return out
  }

  function syncOwnerHighlights(stage) {
    const ownerScope = `private:${normalizeSpeakerId(o.ownerId)}`
    if (stage.scope !== ownerScope) return false

    let changed = false
    if (store && typeof store.listRecentGroupHighlights === 'function') {
      try {
        const list = store.listRecentGroupHighlights({
          viewerScope: stage.scope,
          sinceMs: stage.sharedHighlightBeforeMs,
          limit: 3,
        }) || []
        for (const item of list) {
          if (!item || item.invalidatedByRewind) continue
          const id = String(item.id ?? item.episodeId ?? '')
          if (!id || stage.sharedHighlightIds.has(id)) continue
          if (!stage.knownHighlightIds.has(id)) {
            stage.knownHighlightIds.add(id)
            stage.unseenHighlightIds.add(id)
            stage.unseenGroupHighlights.push(item)
            changed = true
          }
        }
      } catch {
        // ignore
      }
    }

    if (changed) {
      stage.highlightRevision += 1
      syncEpoch(stage)
    }
    return changed
  }

  function notifyGroupHighlight(episode) {
    if (!episode || !String(episode.scope ?? '').startsWith('group:')) return
    if (!episode.isHighlight && !episode.highlight) return
    const id = String(episode.id ?? episode.episodeId ?? '')
    if (!id) return

    const ownerScope = `private:${normalizeSpeakerId(o.ownerId)}`
    for (const st of stages.values()) {
      if (st.scope !== ownerScope) continue
      if (st.sharedHighlightIds.has(id) || st.knownHighlightIds.has(id)) continue
      st.knownHighlightIds.add(id)
      st.unseenHighlightIds.add(id)
      st.unseenGroupHighlights.unshift(episode)
      st.unseenGroupHighlights = st.unseenGroupHighlights.slice(0, 5)
      st.highlightRevision += 1
      syncEpoch(st)
    }
  }

  function createTopic(stage, { title, text, speakerId, nickname, messageId, replyToMessageId, seq, nowMs }) {
    const id = `topic-${++topicSeq}`
    const cleanTitle = cleanIndexText(title || inferTopicTitle(text, o.nicknames), 32) || '日常讨论'
    const keywords = extractEpisodeKeywords(`${cleanTitle} ${text || ''}`, 24)
    const topic = {
      id,
      topicId: id,
      sessionId: stage.sessionId,
      scope: stage.scope,
      groupId: stage.groupId,
      title: cleanTitle,
      status: 'focused',
      createdAt: nowMs,
      updatedAt: nowMs,
      warmedAt: null,
      archivedAt: null,
      keywords,
      cohort: {},
      messages: [],
      seqRange: { startSeq: null, endSeq: null },
      startSeq: null,
      endSeq: null,
      lastMessageId: null,
      lastTriggerMessageId: null,
      openQuestion: '',
      summary: cleanTitle,
      crystallizedEpisodeId: null,
    }
    appendTurnToTopic(stage, topic, {
      speakerId,
      nickname,
      text,
      messageId,
      replyToMessageId,
      seq,
      nowMs,
      roleHint: 'initiator',
    })
    return topic
  }

  function appendTurnToTopic(
    stage,
    topic,
    {
      speakerId,
      nickname = '',
      text = '',
      messageId = null,
      replyToMessageId = null,
      seq = null,
      nowMs = now(),
      roleHint = 'participant',
      extraParticipantIds = [],
      isSelf = false,
    },
  ) {
    const pid = isSelf ? 'self' : normalizeSpeakerId(speakerId)
    const cleanText = clean(text, 500)
    const cleanNick = clean(nickname, 32) || pid

    if (cleanText || messageId != null) {
      topic.messages.push({
        messageId: messageId != null ? String(messageId) : null,
        seq: Number.isFinite(seq) ? Number(seq) : null,
        speakerId: pid,
        nickname: cleanNick,
        text: cleanText,
        replyToMessageId: replyToMessageId != null ? String(replyToMessageId) : null,
        at: nowMs,
        isSelf,
      })
      if (topic.messages.length > o.maxTopicMessages) {
        topic.messages = [topic.messages[0], ...topic.messages.slice(-(o.maxTopicMessages - 1))]
      }
    }

    if (Number.isFinite(seq)) {
      const s = Number(seq)
      topic.startSeq = topic.startSeq == null ? s : Math.min(topic.startSeq, s)
      topic.endSeq = topic.endSeq == null ? s : Math.max(topic.endSeq, s)
      topic.seqRange = { startSeq: topic.startSeq, endSeq: topic.endSeq }
    }

    if (messageId != null && String(messageId) !== '') {
      const mid = String(messageId)
      if (!isSelf) {
        topic.lastMessageId = mid
        bindMessageToTopic(stage, mid, topic.id)
      } else {
        rememberSelfMessage(stage, mid, topic.id)
      }
    }

    if (!isSelf && pid && pid !== 'self') {
      ensureObservedParticipant(stage, pid, cleanNick)
      const stance = stripBotAddress(cleanText, o.nicknames)
      const existing = topic.cohort[pid]
      if (!existing) {
        const isFirstHuman = Object.keys(topic.cohort).length === 0
        topic.cohort[pid] = {
          nickname: cleanNick,
          roleInTopic: isFirstHuman ? 'initiator' : (roleHint || 'participant'),
          stanceSummary: cleanIndexText(stance, 64),
          latestStance: cleanIndexText(stance, 48),
          lastSpokeAt: nowMs,
        }
      } else {
        if (cleanNick && cleanNick !== pid) existing.nickname = cleanNick
        if (existing.roleInTopic === 'mentioned') existing.roleInTopic = 'participant'
        existing.latestStance = cleanIndexText(stance, 48) || existing.latestStance
        existing.stanceSummary = mergeStanceSummary(existing.stanceSummary, stance)
        existing.lastSpokeAt = nowMs
      }
    }

    // Add extra active participants identified by classifier or resolved mentions
    for (const rawExtra of extraParticipantIds || []) {
      const extraPid = normalizeSpeakerId(rawExtra)
      if (!extraPid || extraPid === 'self' || topic.cohort[extraPid]) continue
      topic.cohort[extraPid] = {
        nickname: extraPid,
        roleInTopic: 'participant',
        stanceSummary: '',
        latestStance: '',
        lastSpokeAt: nowMs,
      }
    }

    if (cleanText) {
      const mentioned = resolveMentionedParticipants(stage, cleanText)
      for (const m of mentioned) {
        if (!m.pid || m.pid === pid || topic.cohort[m.pid]) continue
        // Only treat resolved 3rd parties as mentioned cohort members if they are NOT the bot itself
        if (normalizedSelfId && m.pid === normalizedSelfId) continue
        topic.cohort[m.pid] = {
          nickname: m.nickname || m.pid,
          roleInTopic: 'mentioned',
          stanceSummary: '',
          latestStance: '',
          lastSpokeAt: 0,
        }
      }

      const newKw = extractEpisodeKeywords(cleanText, 18)
      if (newKw.length) {
        topic.keywords = [...new Set([...topic.keywords, ...newKw])].slice(0, 36)
      }

      if (!isSelf) {
        const openQ = inferOpenQuestion(cleanText)
        if (openQ) topic.openQuestion = openQ
      } else if (topic.openQuestion && cleanText.length >= 4) {
        // Bot answered the open question unless a new question follows
        topic.openQuestion = ''
      }
    }

    topic.updatedAt = nowMs
    const stancePreview = Object.entries(topic.cohort)
      .filter(([, m]) => m.stanceSummary)
      .slice(0, 3)
      .map(([id, m]) => `${m.nickname || id}:${m.stanceSummary}`)
      .join('；')
    topic.summary = cleanIndexText(
      stancePreview ? `${topic.title}（${stancePreview}）` : topic.title,
      180,
    )
    persistTopic(topic)
  }

  function promoteTopicToFocused(stage, targetTopic, nowMs = now()) {
    if (!targetTopic) return null
    if (stage.focused?.id === targetTopic.id) {
      targetTopic.status = 'focused'
      targetTopic.warmedAt = null
      return targetTopic
    }

    if (stage.focused) {
      const prev = stage.focused
      prev.status = 'warm'
      prev.warmedAt = nowMs
      stage.warm = [prev, ...stage.warm.filter(w => w.id !== prev.id && w.id !== targetTopic.id)]
      persistTopic(prev)
    } else {
      stage.warm = stage.warm.filter(w => w.id !== targetTopic.id)
    }

    targetTopic.status = 'focused'
    targetTopic.warmedAt = null
    targetTopic.updatedAt = nowMs
    stage.focused = targetTopic
    persistTopic(targetTopic)

    // Evict oldest warm topics if exceeding maxWarmTopics
    while (stage.warm.length > o.maxWarmTopics) {
      const evicted = stage.warm.pop()
      if (evicted) {
        evicted.status = 'archived'
        evicted.archivedAt = nowMs
        stage.archivedIds.push(evicted.id)
        const ep = crystallizeTopicThread({ topic: evicted, store, nowMs })
        if (ep) notifyGroupHighlight(ep)
      }
    }

    return targetTopic
  }

  function demoteFocusedToWarm(stage, nowMs = now()) {
    if (!stage.focused) return
    const prev = stage.focused
    prev.status = 'warm'
    prev.warmedAt = nowMs
    stage.focused = null
    stage.warm = [prev, ...stage.warm.filter(w => w.id !== prev.id)]
    persistTopic(prev)
    syncEpoch(stage)
  }

  function findActiveTopicById(stage, topicId) {
    if (!topicId) return null
    const id = String(topicId)
    if (stage.focused?.id === id) return stage.focused
    return stage.warm.find(w => w.id === id) ?? null
  }

  function scoreTopicRelevance(topic, keywords, mentionedPids, speakerId) {
    if (!topic) return 0
    let score = 0
    const topicKwSet = new Set(topic.keywords || [])
    const titleStr = topic.title || ''
    for (const kw of keywords) {
      if (topicKwSet.has(kw) || (kw.length >= 2 && titleStr.includes(kw))) {
        score += 2
      }
    }
    for (const pid of mentionedPids) {
      if (pid && topic.cohort[pid]) score += 2
    }
    if (speakerId && topic.cohort[speakerId] && score > 0) {
      score += 1
    }
    return score
  }

  function pruneExpiredWarmForStage(stage, nowMs = now(), forceAll = false, moodConnector = null) {
    if (!stage.warm.length) return []
    const archived = []
    const kept = []
    for (const w of stage.warm) {
      const refTime = w.warmedAt ?? w.updatedAt ?? w.createdAt ?? nowMs
      if (forceAll || nowMs - refTime >= o.warmTtlMs) {
        w.status = 'archived'
        w.archivedAt = nowMs
        stage.archivedIds.push(w.id)
        const ep = crystallizeTopicThread({ topic: w, store, moodConnector, nowMs })
        if (ep) notifyGroupHighlight(ep)
        archived.push(w)
      } else {
        kept.push(w)
      }
    }
    if (archived.length) {
      stage.warm = kept
      syncEpoch(stage)
    }
    return archived
  }

  function cancelGateTimers(stage) {
    const g = stage.gate
    if (g.timer !== null) {
      clear(g.timer)
      g.timer = null
    }
    if (g.wakeTimer !== null) {
      clear(g.wakeTimer)
      g.wakeTimer = null
    }
    g.pendingWake = null
  }

  function stopGroupGate(stage, reason, nowMs = now()) {
    const g = stage.gate
    cancelGateTimers(stage)
    g.active = false
    g.generation += 1
    g.activeUntil = 0
    g.topicAnchor = null
    g.history = []
    g.batch = []
    g.batchStartedAt = 0
    g.version += 1
    if (reason === 'topic-ended' || reason === 'unrelated' || reason === 'timeout') {
      demoteFocusedToWarm(stage, nowMs)
    }
    o.onEvent?.({ type: 'stopped', reason, sessionId: stage.sessionId, groupId: stage.groupId })
  }

  function openOrRefreshGroupGate(stage, anchorMessage, nowMs = now(), isInitialWake = false) {
    const g = stage.gate
    if (!g.active || isInitialWake) {
      if (g.wakeTimer !== null) {
        clear(g.wakeTimer)
        g.wakeTimer = null
        g.pendingWake = null
      }
      const anchor = {
        speakerId: normalizeSpeakerId(anchorMessage.speakerId || anchorMessage.userId),
        who: clean(anchorMessage.nickname || anchorMessage.userId, 40),
        text: clean(anchorMessage.text, 300),
      }
      g.active = true
      g.generation += 1
      g.openedAt = nowMs
      g.activeUntil = nowMs + o.windowMs
      if (isInitialWake) {
        g.lastWakeAt = nowMs
        g.autoReplies = 0
      }
      g.unrelated = 0
      g.topicAnchor = anchor
      g.history = trimHistoryWithAnchor([...g.history, anchor], anchor, o.historyLimit)
    } else {
      g.unrelated = 0
      g.activeUntil = Math.min(nowMs + o.windowMs, g.openedAt + o.maxWindowMs)
    }
  }

  function maybeTriggerGroupWake(stage, { candidateToken, topicId, triggerMessageId, replyTargetIds = [], nowMs = now() }) {
    if (!requestWake || !candidateToken) return
    const g = stage.gate
    if (g.autoReplies >= o.maxAutoReplies) return

    const sinceWake = nowMs - g.lastWakeAt
    if (sinceWake >= o.cooldownMs) {
      g.lastWakeAt = nowMs
      g.autoReplies += 1
      void Promise.resolve(
        requestWake({
          candidateToken,
          topicId: topicId ?? stage.focused?.id ?? null,
          triggerMessageId: triggerMessageId ?? null,
          replyTargetIds,
          activeTopicCount: (stage.focused ? 1 : 0) + stage.warm.length,
        }),
      ).catch(error => {
        o.onEvent?.({ type: 'wake-error', error: String(error?.message ?? error).slice(0, 200) })
      })
    } else if (g.autoReplies > 0) {
      if (g.wakeTimer !== null) clear(g.wakeTimer)
      const generation = g.generation
      const version = g.version
      g.pendingWake = { candidateToken, topicId, triggerMessageId, replyTargetIds }
      g.wakeTimer = later(async () => {
        g.wakeTimer = null
        const pending = g.pendingWake
        g.pendingWake = null
        if (closed || !pending || !g.active || g.generation !== generation || g.version !== version) return
        const t = now()
        if (t > g.activeUntil || t - g.openedAt >= o.maxWindowMs) {
          stopGroupGate(stage, 'timeout', t)
          return
        }
        if (g.autoReplies >= o.maxAutoReplies || t - g.lastWakeAt < o.cooldownMs) return
        g.lastWakeAt = t
        g.autoReplies += 1
        try {
          await requestWake({
            candidateToken: pending.candidateToken,
            topicId: pending.topicId ?? stage.focused?.id ?? null,
            triggerMessageId: pending.triggerMessageId ?? null,
            replyTargetIds: pending.replyTargetIds,
            activeTopicCount: (stage.focused ? 1 : 0) + stage.warm.length,
          })
        } catch (error) {
          o.onEvent?.({ type: 'wake-error', error: String(error?.message ?? error).slice(0, 200) })
        }
      }, Math.max(0, o.cooldownMs - sinceWake))
      g.wakeTimer?.unref?.()
    }
  }

  function scheduleGroupEvaluate(stage) {
    const g = stage.gate
    if (closed || !classifyFn || g.running || !g.active || !g.batch.length) return
    if (g.timer !== null) {
      clear(g.timer)
      g.timer = null
    }
    const t = now()
    const elapsed = t - g.batchStartedAt
    const quietDelay = Math.max(0, Math.min(o.quietMs, o.maxBatchMs - elapsed))
    const rateDelay = Math.max(0, g.lastClassifyAt + o.classifyIntervalMs - t)
    const delay = Math.max(quietDelay, rateDelay)
    g.timer = later(() => {
      g.timer = null
      void evaluateGroupBatch(stage)
    }, delay)
    g.timer?.unref?.()
  }

  async function evaluateGroupBatch(stage) {
    const g = stage.gate
    if (closed || !classifyFn || g.running || !g.active || !g.batch.length) return
    const t = now()
    if (t > g.activeUntil || t - g.openedAt >= o.maxWindowMs) {
      stopGroupGate(stage, 'timeout', t)
      return
    }

    g.running = true
    g.lastClassifyAt = t
    const generation = g.generation
    const version = g.version
    const batch = g.batch.slice()
    const history = g.history.slice()
    const historyBaseLen = g.history.length
    g.batch = []
    g.batchStartedAt = 0

    const activeTopics = [
      ...(stage.focused ? [stage.focused] : []),
      ...stage.warm,
    ]

    let rawVerdict = null
    try {
      rawVerdict = await classifyFn({
        activeTopics,
        batch,
        history,
        groupId: stage.groupId || o.groupId,
        topicAnchor: g.topicAnchor,
      })
    } catch (error) {
      if (!closed && g.active && g.generation === generation) {
        const added = g.history.slice(historyBaseLen)
        g.history = trimHistoryWithAnchor(
          [...history, ...batch.map(b => ({ speakerId: b.speakerId, who: b.who, text: b.text })), ...added],
          g.topicAnchor,
          o.historyLimit,
        )
      }
      o.onEvent?.({ type: 'classifier-error', error: String(error?.message ?? error).slice(0, 200) })
      g.running = false
      if (!closed) scheduleGroupEvaluate(stage)
      return
    }

    g.running = false
    if (closed) return
    if (!g.active || g.generation !== generation) {
      scheduleGroupEvaluate(stage)
      return
    }

    if (g.version !== version) {
      const combined = [...batch, ...g.batch]
      if (combined.length > o.historyLimit) {
        const overflow = combined.slice(0, combined.length - o.historyLimit)
        const added = g.history.slice(historyBaseLen)
        g.history = trimHistoryWithAnchor(
          [...history, ...overflow.map(b => ({ speakerId: b.speakerId, who: b.who, text: b.text })), ...added],
          g.topicAnchor,
          o.historyLimit,
        )
        g.batch = combined.slice(-o.historyLimit)
      } else {
        g.batch = combined
      }
      if (!g.batchStartedAt) g.batchStartedAt = now()
      scheduleGroupEvaluate(stage)
      return
    }

    const addedDuring = g.history.slice(historyBaseLen)
    g.history = trimHistoryWithAnchor(
      [...history, ...batch.map(b => ({ speakerId: b.speakerId, who: b.who, text: b.text })), ...addedDuring],
      g.topicAnchor,
      o.historyLimit,
    )

    const evalNow = now()
    if (evalNow > g.activeUntil || evalNow - g.openedAt >= o.maxWindowMs) {
      stopGroupGate(stage, 'timeout', evalNow)
      return
    }

    const verdict = typeof rawVerdict === 'string'
      ? parseTopicVerdict(rawVerdict)
      : (rawVerdict && typeof rawVerdict === 'object'
          ? parseTopicVerdict(JSON.stringify(rawVerdict))
          : null)

    if (!verdict) {
      o.onEvent?.({ type: 'classifier-invalid' })
      scheduleGroupEvaluate(stage)
      return
    }

    if (verdict.topicAction === 'ignore' || !verdict.related) {
      if (verdict.end) {
        stopGroupGate(stage, 'topic-ended', evalNow)
        return
      }
      g.unrelated += 1
      if (g.unrelated >= o.unrelatedLimit) {
        stopGroupGate(stage, 'unrelated', evalNow)
        return
      }
      scheduleGroupEvaluate(stage)
      return
    }

    g.unrelated = 0
    g.activeUntil = Math.min(evalNow + o.windowMs, g.openedAt + o.maxWindowMs)

    // Route batch to target topic according to topicAction
    let targetTopic = null
    if (verdict.topicAction === 'switch') {
      targetTopic = findActiveTopicById(stage, verdict.topicId)
      if (!targetTopic && verdict.topicTitle) {
        const kw = extractEpisodeKeywords(verdict.topicTitle, 6)
        targetTopic = stage.warm.find(w => scoreTopicRelevance(w, kw, [], '') > 0) ?? null
      }
      if (targetTopic) {
        promoteTopicToFocused(stage, targetTopic, evalNow)
      }
    } else if (verdict.topicAction === 'continue') {
      targetTopic = (verdict.topicId && findActiveTopicById(stage, verdict.topicId)) || stage.focused
      if (targetTopic && targetTopic !== stage.focused) {
        promoteTopicToFocused(stage, targetTopic, evalNow)
      }
    }

    if (!targetTopic) {
      const first = batch[0]
      const newTopic = createTopic(stage, {
        title: verdict.topicTitle || inferTopicTitle(first.text, o.nicknames),
        text: first.text,
        speakerId: first.speakerId,
        nickname: first.nickname || first.who,
        messageId: first.messageId,
        replyToMessageId: first.replyToMessageId,
        seq: first.seq,
        nowMs: evalNow,
      })
      promoteTopicToFocused(stage, newTopic, evalNow)
      targetTopic = newTopic
      for (const item of batch.slice(1)) {
        appendTurnToTopic(stage, targetTopic, {
          speakerId: item.speakerId,
          nickname: item.nickname || item.who,
          text: item.text,
          messageId: item.messageId,
          replyToMessageId: item.replyToMessageId,
          seq: item.seq,
          nowMs: evalNow,
          extraParticipantIds: verdict.activeParticipants,
        })
      }
      if (verdict.activeParticipants.length) {
        appendTurnToTopic(stage, targetTopic, {
          speakerId: '',
          text: '',
          nowMs: evalNow,
          extraParticipantIds: verdict.activeParticipants,
        })
      }
    } else {
      for (const item of batch) {
        appendTurnToTopic(stage, targetTopic, {
          speakerId: item.speakerId,
          nickname: item.nickname || item.who,
          text: item.text,
          messageId: item.messageId,
          replyToMessageId: item.replyToMessageId,
          seq: item.seq,
          nowMs: evalNow,
          extraParticipantIds: verdict.activeParticipants,
        })
      }
    }

    if (verdict.triggerMessageId) {
      targetTopic.lastTriggerMessageId = verdict.triggerMessageId
    } else if (batch.length) {
      const lastMsg = [...batch].reverse().find(b => b.messageId)
      if (lastMsg) targetTopic.lastTriggerMessageId = lastMsg.messageId
    }

    syncEpoch(stage)

    if (verdict.end) {
      stopGroupGate(stage, 'topic-ended', evalNow)
      return
    }

    if (verdict.reply) {
      const matchedCandidate = verdict.triggerMessageId
        ? batch.find(item => item.token && String(item.messageId) === String(verdict.triggerMessageId))
        : null
      const fallbackCandidate = [...batch].reverse().find(item => item.token)
      const chosen = matchedCandidate || fallbackCandidate
      if (chosen) {
        targetTopic.lastTriggerMessageId = chosen.messageId || targetTopic.lastTriggerMessageId
        maybeTriggerGroupWake(stage, {
          candidateToken: chosen.token,
          topicId: targetTopic.id,
          triggerMessageId: chosen.messageId,
          replyTargetIds: verdict.replyTargetIds,
          nowMs: evalNow,
        })
      }
    }

    scheduleGroupEvaluate(stage)
  }

  function selectOrCreateTopicOnFastWake(stage, { speakerId, nickname, text, messageId, replyToMessageId, seq, nowMs }) {
    if (replyToMessageId != null) {
      const mappedId = stage.messageTopicMap.get(String(replyToMessageId))
      const mapped = findActiveTopicById(stage, mappedId)
      if (mapped) {
        promoteTopicToFocused(stage, mapped, nowMs)
        appendTurnToTopic(stage, mapped, { speakerId, nickname, text, messageId, replyToMessageId, seq, nowMs })
        if (messageId != null) mapped.lastTriggerMessageId = String(messageId)
        syncEpoch(stage)
        return mapped
      }
    }

    const coreText = stripBotAddress(text, o.nicknames)
    const kw = extractEpisodeKeywords(coreText, 20)
    const mentioned = resolveMentionedParticipants(stage, coreText).map(m => m.pid)
    const hasShiftCue = TOPIC_SHIFT_CUE_RE.test(coreText)

    const focusedScore = stage.focused ? scoreTopicRelevance(stage.focused, kw, mentioned, speakerId) : 0
    let bestWarm = null
    let bestWarmScore = 0
    for (const w of stage.warm) {
      const s = scoreTopicRelevance(w, kw, mentioned, speakerId)
      if (s > bestWarmScore) {
        bestWarmScore = s
        bestWarm = w
      }
    }

    if (bestWarm && bestWarmScore > focusedScore && (bestWarmScore >= 2 || TOPIC_RESUME_CUE_RE.test(coreText))) {
      promoteTopicToFocused(stage, bestWarm, nowMs)
      appendTurnToTopic(stage, bestWarm, { speakerId, nickname, text, messageId, replyToMessageId, seq, nowMs })
      if (messageId != null) bestWarm.lastTriggerMessageId = String(messageId)
      syncEpoch(stage)
      return bestWarm
    }

    if (
      stage.focused &&
      !hasShiftCue &&
      (focusedScore >= 2 || (nowMs - stage.focused.updatedAt < o.fastContinuationMs && kw.length <= 1))
    ) {
      appendTurnToTopic(stage, stage.focused, { speakerId, nickname, text, messageId, replyToMessageId, seq, nowMs })
      if (messageId != null) stage.focused.lastTriggerMessageId = String(messageId)
      syncEpoch(stage)
      return stage.focused
    }

    const created = createTopic(stage, {
      title: inferTopicTitle(text, o.nicknames),
      text,
      speakerId,
      nickname,
      messageId,
      replyToMessageId,
      seq,
      nowMs,
    })
    if (messageId != null) created.lastTriggerMessageId = String(messageId)
    promoteTopicToFocused(stage, created, nowMs)
    syncEpoch(stage)
    return created
  }

  function onGroupInbound(event) {
    if (closed || event?.transport !== true) return null
    const m = event.message
    const decision = event.decision ?? {}
    if (!m) return null
    const gid = String(m.groupId ?? '').trim()
    if (!gid) return null
    if (o.groupId && gid !== String(o.groupId)) return null

    const rawUserId = String(m.userId ?? m.speakerId ?? '').trim()
    const speakerId = normalizeSpeakerId(m.speakerId || rawUserId)
    if (ignored.has(rawUserId) || ignored.has(speakerId) || decision.reason === 'attention') return null

    const t = Number.isFinite(event.at) ? Number(event.at) : now()
    const sid = resolveGroupSessionId(gid, event.sessionId)
    const stage = ensureStage(sid, event.scope || `group:${gid}`, gid)
    pruneExpiredWarmForStage(stage, t, false)

    const text = clean(m.text)
    const messageId = m.messageId != null ? String(m.messageId) : null
    if (messageId && !rememberSeenMessage(stage, messageId)) return getStage(stage.sessionId)

    const replyToMessageId = m.replyToMessageId != null && String(m.replyToMessageId) !== ''
      ? String(m.replyToMessageId)
      : null
    const replyToUserId = m.replyToUserId != null ? normalizeSpeakerId(m.replyToUserId) : ''
    const replyToSelf = Boolean(
      m.replyToSelf === true ||
      (replyToMessageId && stage.selfMessageIds.has(replyToMessageId)) ||
      (normalizedSelfId && replyToUserId === normalizedSelfId),
    )
    const named = m.atSelf === true || called(text, o.nicknames)

    // --- TIER 1: FAST DETERMINISTIC ROUTING (0 LLM CALLS) ---
    // F1: Explicit quote/reply matching a known active topic (focused or warm)
    if (replyToMessageId) {
      const matchedTopicId = stage.messageTopicMap.get(replyToMessageId)
      const matchedTopic = findActiveTopicById(stage, matchedTopicId)
      if (matchedTopic && (usable(text) || decision.action === 'wake' || replyToSelf)) {
        promoteTopicToFocused(stage, matchedTopic, t)
        appendTurnToTopic(stage, matchedTopic, {
          speakerId,
          nickname: m.nickname || rawUserId,
          text,
          messageId,
          replyToMessageId,
          seq: m.seq ?? null,
          nowMs: t,
        })
        if (messageId) matchedTopic.lastTriggerMessageId = messageId
        syncEpoch(stage)

        const isInitialWake = decision.action === 'wake'
        openOrRefreshGroupGate(stage, m, t, isInitialWake)
        stage.gate.history = trimHistoryWithAnchor(
          [...stage.gate.history, { speakerId, who: clean(m.nickname || rawUserId, 40), text }],
          stage.gate.topicAnchor,
          o.historyLimit,
        )

        if (!isInitialWake && (replyToSelf || named) && event.candidateToken) {
          maybeTriggerGroupWake(stage, {
            candidateToken: String(event.candidateToken),
            topicId: matchedTopic.id,
            triggerMessageId: messageId,
            replyTargetIds: speakerId ? [speakerId] : [],
            nowMs: t,
          })
        }
        return getStage(stage.sessionId)
      }
    }

    // F2: Direct reply to Fatfish (`replyToSelf === true`) or explicit wake (`decision.action === 'wake'`)
    if (replyToSelf || (named && decision.action === 'wake') || decision.action === 'wake') {
      const topic = selectOrCreateTopicOnFastWake(stage, {
        speakerId,
        nickname: m.nickname || rawUserId,
        text,
        messageId,
        replyToMessageId,
        seq: m.seq ?? null,
        nowMs: t,
      })
      const isInitialWake = decision.action === 'wake'
      openOrRefreshGroupGate(stage, m, t, isInitialWake)
      if (!isInitialWake && replyToSelf && event.candidateToken) {
        maybeTriggerGroupWake(stage, {
          candidateToken: String(event.candidateToken),
          topicId: topic.id,
          triggerMessageId: messageId,
          replyTargetIds: speakerId ? [speakerId] : [],
          nowMs: t,
        })
      }
      return getStage(stage.sessionId)
    }

    // --- TIER 2: SLOW MICRO-BATCH ROUTING (AMBIGUOUS GROUP RECORD TURNS) ---
    if (decision.action !== 'record' || !stage.gate.active) {
      return getStage(stage.sessionId)
    }

    if (t > stage.gate.activeUntil || t - stage.gate.openedAt >= o.maxWindowMs) {
      stopGroupGate(stage, 'timeout', t)
      return getStage(stage.sessionId)
    }

    if (!usable(text) || !messageId) {
      return getStage(stage.sessionId)
    }

    if (stage.gate.wakeTimer !== null) {
      clear(stage.gate.wakeTimer)
      stage.gate.wakeTimer = null
      stage.gate.pendingWake = null
    }

    const batchItem = {
      messageId,
      speakerId,
      nickname: clean(m.nickname || rawUserId, 40),
      who: clean(m.nickname || rawUserId, 40),
      text,
      replyToMessageId,
      seq: m.seq ?? null,
      token: event.candidateToken ? String(event.candidateToken) : null,
    }
    if (!stage.gate.batch.length) stage.gate.batchStartedAt = t
    stage.gate.batch.push(batchItem)
    if (stage.gate.batch.length > o.historyLimit) {
      const evicted = stage.gate.batch.shift()
      stage.gate.history = trimHistoryWithAnchor(
        [...stage.gate.history, { speakerId: evicted.speakerId, who: evicted.who, text: evicted.text }],
        stage.gate.topicAnchor,
        o.historyLimit,
      )
    }
    stage.gate.version += 1
    scheduleGroupEvaluate(stage)
    return getStage(stage.sessionId)
  }

  function onGroupOutbound(event) {
    if (closed || !event) return null
    const gid = String(event.groupId ?? '').trim()
    if (!gid) return null
    if (o.groupId && gid !== String(o.groupId)) return null

    const sid = resolveGroupSessionId(gid, event.sessionId)
    const stage = findStage(sid)
    if (!stage) return null

    const text = clean(event.text)
    if (!text) return getStage(stage.sessionId)

    const t = Number.isFinite(event.at) ? Number(event.at) : now()
    const targetTopic = (event.replyToMessageId && findActiveTopicById(stage, stage.messageTopicMap.get(String(event.replyToMessageId))))
      || stage.focused

    if (targetTopic) {
      appendTurnToTopic(stage, targetTopic, {
        speakerId: 'self',
        nickname: clean(o.nicknames?.[0]) || '蓝蓝',
        text,
        messageId: event.messageId ?? null,
        replyToMessageId: event.replyToMessageId ?? null,
        seq: event.seq ?? null,
        nowMs: t,
        isSelf: true,
      })
    } else if (event.messageId != null) {
      rememberSelfMessage(stage, event.messageId, null)
    }

    if (stage.gate.active) {
      const selfName = clean(o.nicknames?.[0]) || '蓝蓝'
      stage.gate.history = trimHistoryWithAnchor(
        [...stage.gate.history, { speakerId: 'self', who: selfName, text }],
        stage.gate.topicAnchor,
        o.historyLimit,
      )
    }
    return getStage(stage.sessionId)
  }

  function onClaimedTurn({
    sessionId,
    scope = '',
    speakerId = '',
    nickname = '',
    text = '',
    messageId = null,
    replyToMessageId = null,
    replyToSelf = false,
    seq = null,
    sourceKind = '',
    nowMs = now(),
  } = {}) {
    if (closed || !sessionId) return null
    if (sourceKind && INTERNAL_SOURCE_KINDS.has(String(sourceKind))) {
      return getStage(sessionId)
    }

    const stage = ensureStage(sessionId, scope)
    pruneExpiredWarmForStage(stage, nowMs, false)
    syncOwnerHighlights(stage)

    const cleanText = clean(text)
    if (!cleanText && messageId == null) return getStage(stage.sessionId)

    // Avoid double-routing group messages already routed by onGroupInbound
    if (messageId != null && stage.seenMessageIds.has(String(messageId))) {
      const existingTopicId = stage.messageTopicMap.get(String(messageId))
      const existingTopic = findActiveTopicById(stage, existingTopicId)
      if (existingTopic && Number.isFinite(seq)) {
        const s = Number(seq)
        existingTopic.startSeq = existingTopic.startSeq == null ? s : Math.min(existingTopic.startSeq, s)
        existingTopic.endSeq = existingTopic.endSeq == null ? s : Math.max(existingTopic.endSeq, s)
        existingTopic.seqRange = { startSeq: existingTopic.startSeq, endSeq: existingTopic.endSeq }
        persistTopic(existingTopic)
      }
      return getStage(stage.sessionId)
    }
    if (messageId != null) rememberSeenMessage(stage, messageId)

    let effectiveSpeaker = normalizeSpeakerId(speakerId)
    let effectiveNick = clean(nickname, 32)
    if (!effectiveSpeaker) {
      const match = cleanText.match(EMBEDDED_IDENTITY_RE)
      if (match) {
        effectiveNick = effectiveNick || match[1]
        effectiveSpeaker = `qq:${match[2]}`
      } else if (stage.scope.startsWith('private:')) {
        effectiveSpeaker = normalizeSpeakerId(stage.scope.slice('private:'.length))
      }
    }

    // Fast route 1: explicit replyToMessageId matching known topic
    if (replyToMessageId != null && String(replyToMessageId) !== '') {
      const rid = String(replyToMessageId)
      const matched = findActiveTopicById(stage, stage.messageTopicMap.get(rid))
      if (matched) {
        promoteTopicToFocused(stage, matched, nowMs)
        appendTurnToTopic(stage, matched, {
          speakerId: effectiveSpeaker,
          nickname: effectiveNick,
          text: cleanText,
          messageId,
          replyToMessageId: rid,
          seq,
          nowMs,
        })
        syncEpoch(stage)
        return getStage(stage.sessionId)
      }
    }

    // Fast route 2: replyToSelf continues focused topic if present
    if (replyToSelf && stage.focused) {
      appendTurnToTopic(stage, stage.focused, {
        speakerId: effectiveSpeaker,
        nickname: effectiveNick,
        text: cleanText,
        messageId,
        replyToMessageId,
        seq,
        nowMs,
      })
      syncEpoch(stage)
      return getStage(stage.sessionId)
    }

    const coreText = stripBotAddress(cleanText, o.nicknames)
    const kw = extractEpisodeKeywords(coreText, 20)
    const mentioned = resolveMentionedParticipants(stage, coreText).map(m => m.pid)
    const hasShiftCue = TOPIC_SHIFT_CUE_RE.test(cleanText)
    const hasResumeCue = TOPIC_RESUME_CUE_RE.test(cleanText)

    const focusedScore = stage.focused
      ? scoreTopicRelevance(stage.focused, kw, mentioned, effectiveSpeaker)
      : 0

    let bestWarm = null
    let bestWarmScore = 0
    for (const w of stage.warm) {
      const s = scoreTopicRelevance(w, kw, mentioned, effectiveSpeaker)
      if (s > bestWarmScore) {
        bestWarmScore = s
        bestWarm = w
      }
    }

    // Switch back to warm topic if keywords/participants match warm topic better than current focus
    if (bestWarm && bestWarmScore > focusedScore && (bestWarmScore >= 2 || hasResumeCue)) {
      promoteTopicToFocused(stage, bestWarm, nowMs)
      appendTurnToTopic(stage, bestWarm, {
        speakerId: effectiveSpeaker,
        nickname: effectiveNick,
        text: cleanText,
        messageId,
        replyToMessageId,
        seq,
        nowMs,
      })
      syncEpoch(stage)
      return getStage(stage.sessionId)
    }

    if (!stage.focused) {
      const initial = createTopic(stage, {
        title: inferTopicTitle(cleanText, o.nicknames),
        text: cleanText,
        speakerId: effectiveSpeaker,
        nickname: effectiveNick,
        messageId,
        replyToMessageId,
        seq,
        nowMs,
      })
      promoteTopicToFocused(stage, initial, nowMs)
      syncEpoch(stage)
      return getStage(stage.sessionId)
    }

    const dt = nowMs - stage.focused.updatedAt
    // Fast deterministic continuation: within <45s (when hitting active topic or without explicit topic-shift cue)
    if (!hasShiftCue && (dt < o.fastContinuationMs || focusedScore > 0 || kw.length < 2)) {
      appendTurnToTopic(stage, stage.focused, {
        speakerId: effectiveSpeaker,
        nickname: effectiveNick,
        text: cleanText,
        messageId,
        replyToMessageId,
        seq,
        nowMs,
      })
      syncEpoch(stage)
      return getStage(stage.sessionId)
    }

    // Disjoint new topic (explicit shift cue or >= 45s with new subject keywords)
    const nextTopic = createTopic(stage, {
      title: inferTopicTitle(cleanText, o.nicknames),
      text: cleanText,
      speakerId: effectiveSpeaker,
      nickname: effectiveNick,
      messageId,
      replyToMessageId,
      seq,
      nowMs,
    })
    promoteTopicToFocused(stage, nextTopic, nowMs)
    syncEpoch(stage)
    return getStage(stage.sessionId)
  }

  function focusTopic(sessionId, topicId, nowMs = now()) {
    const stage = findStage(sessionId)
    if (!stage || !topicId) return null
    const target = findActiveTopicById(stage, topicId)
    if (!target) return null
    promoteTopicToFocused(stage, target, nowMs)
    syncEpoch(stage)
    return cloneTopic(target)
  }

  function archiveWarmTopics({ nowMs = now(), forceAll = false, sessionId = null, moodConnector = null } = {}) {
    const archived = []
    if (sessionId) {
      const stage = findStage(sessionId)
      if (stage) archived.push(...pruneExpiredWarmForStage(stage, nowMs, forceAll, moodConnector))
      return archived.map(cloneTopic)
    }
    for (const stage of stages.values()) {
      archived.push(...pruneExpiredWarmForStage(stage, nowMs, forceAll, moodConnector))
    }
    return archived.map(cloneTopic)
  }

  function recomputeTopicAfterRewind(stage, topic, seqSet) {
    const beforeLen = topic.messages.length
    const removedMsgIds = []
    topic.messages = topic.messages.filter(m => {
      if (m.seq != null && seqSet.has(Number(m.seq))) {
        if (m.messageId) removedMsgIds.push(m.messageId)
        return false
      }
      return true
    })
    for (const mid of removedMsgIds) {
      stage.messageTopicMap.delete(String(mid))
      stage.seenMessageIds.delete(String(mid))
    }
    if (topic.messages.length === 0 && beforeLen > 0) {
      return { empty: true, changed: true }
    }
    if (topic.messages.length === beforeLen) {
      return { empty: false, changed: false }
    }

    // Rebuild cohort & seqRange from surviving messages
    const rebuiltCohort = {}
    let startSeq = null
    let endSeq = null
    let lastMessageId = null
    for (const m of topic.messages) {
      if (Number.isFinite(m.seq)) {
        startSeq = startSeq == null ? m.seq : Math.min(startSeq, m.seq)
        endSeq = endSeq == null ? m.seq : Math.max(endSeq, m.seq)
      }
      if (!m.isSelf && m.messageId) lastMessageId = m.messageId
      if (!m.isSelf && m.speakerId && m.speakerId !== 'self') {
        const stance = stripBotAddress(m.text, o.nicknames)
        const existing = rebuiltCohort[m.speakerId]
        if (!existing) {
          rebuiltCohort[m.speakerId] = {
            nickname: m.nickname || m.speakerId,
            roleInTopic: Object.keys(rebuiltCohort).length === 0 ? 'initiator' : 'participant',
            stanceSummary: cleanIndexText(stance, 64),
            latestStance: cleanIndexText(stance, 48),
            lastSpokeAt: m.at,
          }
        } else {
          existing.latestStance = cleanIndexText(stance, 48) || existing.latestStance
          existing.stanceSummary = mergeStanceSummary(existing.stanceSummary, stance)
          existing.lastSpokeAt = m.at
        }
      }
      for (const mentioned of resolveMentionedParticipants(stage, m.text)) {
        if (mentioned.pid && !rebuiltCohort[mentioned.pid]) {
          rebuiltCohort[mentioned.pid] = {
            nickname: mentioned.nickname || mentioned.pid,
            roleInTopic: 'mentioned',
            stanceSummary: '',
            latestStance: '',
            lastSpokeAt: 0,
          }
        }
      }
    }

    topic.cohort = rebuiltCohort
    topic.startSeq = startSeq
    topic.endSeq = endSeq
    topic.seqRange = { startSeq, endSeq }
    topic.lastMessageId = lastMessageId
    topic.lastTriggerMessageId = lastMessageId
    persistTopic(topic)
    return { empty: false, changed: true }
  }

  function invalidateBySeqs(sessionId, seqs = []) {
    const stage = findStage(sessionId)
    const seqSet = new Set((seqs || []).map(Number).filter(Number.isFinite))
    if (!stage || !seqSet.size) {
      return { removedTopicIds: [], updatedTopicIds: [] }
    }

    const removedTopicIds = []
    const updatedTopicIds = []

    if (stage.focused) {
      const res = recomputeTopicAfterRewind(stage, stage.focused, seqSet)
      if (res.empty) {
        removedTopicIds.push(stage.focused.id)
        stage.focused = null
      } else if (res.changed) {
        updatedTopicIds.push(stage.focused.id)
      }
    }

    const survivingWarm = []
    for (const w of stage.warm) {
      const res = recomputeTopicAfterRewind(stage, w, seqSet)
      if (res.empty) {
        removedTopicIds.push(w.id)
      } else {
        if (res.changed) updatedTopicIds.push(w.id)
        survivingWarm.push(w)
      }
    }
    stage.warm = survivingWarm

    if (!stage.focused && stage.warm.length > 0) {
      const promoted = stage.warm.shift()
      promoted.status = 'focused'
      promoted.warmedAt = null
      stage.focused = promoted
      persistTopic(promoted)
    }

    syncEpoch(stage)
    return { removedTopicIds, updatedTopicIds }
  }

  function getStage(sessionId) {
    let stage = findStage(sessionId)
    if (!stage) {
      const key = String(sessionId ?? '').trim()
      if (!key) return null
      stage = ensureStage(key)
    }
    syncOwnerHighlights(stage)
    const focused = cloneTopic(stage.focused)
    const warm = stage.warm.map(cloneTopic)
    return {
      _stageUid: stage._stageUid,
      sessionId: stage.sessionId,
      scope: stage.scope,
      groupId: stage.groupId,
      epoch: stage.epoch,
      highlightRevision: stage.highlightRevision,
      focused,
      warm,
      archivedIds: [...stage.archivedIds],
      activeTopicCount: (focused ? 1 : 0) + warm.length,
      targetMessageId: focused?.lastTriggerMessageId || focused?.lastMessageId || null,
      unseenGroupHighlights: [...stage.unseenGroupHighlights],
      sharedHighlightIds: [...stage.sharedHighlightIds],
      sharedHighlightBeforeMs: stage.sharedHighlightBeforeMs,
    }
  }

  function listOpenTopics(sessionId, { limit = 5 } = {}) {
    const stage = findStage(sessionId)
    if (!stage) return []
    const items = [
      ...(stage.focused ? [stage.focused] : []),
      ...stage.warm,
    ]
    return items.slice(0, Math.max(1, limit)).map(cloneTopic)
  }

  function markGroupHighlightsShared(sessionId, highlightIds = [], nowMs = now()) {
    const stage = findStage(sessionId)
    if (!stage) return
    const idSet = new Set((highlightIds || []).map(String))
    for (const id of idSet) {
      stage.sharedHighlightIds.add(id)
      stage.unseenHighlightIds.delete(id)
    }
    stage.unseenGroupHighlights = stage.unseenGroupHighlights.filter(
      h => !idSet.has(String(h.id ?? h.episodeId ?? '')),
    )
    if (!highlightIds?.length) {
      for (const id of stage.unseenHighlightIds) stage.sharedHighlightIds.add(id)
      stage.unseenHighlightIds.clear()
      stage.unseenGroupHighlights = []
      stage.sharedHighlightBeforeMs = nowMs
    }
    stage.highlightRevision += 1
    syncEpoch(stage)
  }

  function snapshot() {
    const sessions = {}
    for (const [sid, stage] of stages.entries()) {
      sessions[sid] = {
        scope: stage.scope,
        groupId: stage.groupId,
        epoch: stage.epoch,
        highlightRevision: stage.highlightRevision,
        focusedTopicId: stage.focused?.id ?? null,
        focusedTitle: stage.focused?.title ?? null,
        focusedCohort: stage.focused ? Object.keys(stage.focused.cohort) : [],
        warmTopicIds: stage.warm.map(w => w.id),
        archivedCount: stage.archivedIds.length,
        gateActive: stage.gate.active,
        pendingBatch: stage.gate.batch.length,
        autoReplies: stage.gate.autoReplies,
      }
    }
    return { sessions }
  }

  function dispose() {
    closed = true
    for (const stage of stages.values()) {
      cancelGateTimers(stage)
      stage.gate.history = []
      stage.gate.batch = []
    }
  }

  return {
    onGroupInbound,
    onGroupOutbound,
    onClaimedTurn,
    getStage,
    focusTopic,
    archiveWarmTopics,
    invalidateBySeqs,
    listOpenTopics,
    notifyGroupHighlight,
    markGroupHighlightsShared,
    snapshot,
    dispose,
  }
}
