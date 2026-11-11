const STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是', '还是',
  '但是', '因为', '所以', '已经', '现在', '刚才', '一下', '一个', '一些', '没有',
  '知道', '觉得', '今天', '明天', '昨天', '蓝蓝', '大肥鱼', '哈哈', '哈哈哈',
  '还能', '能去', '去哪', '哪里', '为什么', '干嘛', '顺便', '对了', '另外',
  '不是', '不要', '不能', '应该', '可能', '如果', '或者', '然后', '而且',
])

const cleanWhitespace = value => String(value ?? '').replace(/\s+/g, ' ').trim()

export function cleanIndexText(value, max = 60) {
  const stripped = String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s*/gm, '')
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= max) return stripped
  return stripped.slice(0, Math.max(1, max - 1)).trimEnd() + '…'
}

export function extractEpisodeKeywords(text, limit = 24) {
  const raw = cleanWhitespace(text)
  if (!raw) return []
  const found = []
  const seen = new Set()
  const add = token => {
    const t = token.trim().toLowerCase()
    if (!t || t.length < 2 || STOPWORDS.has(t) || seen.has(t)) return
    seen.add(t)
    found.push(t)
  }

  for (const m of raw.matchAll(/[a-zA-Z0-9_:-]{2,24}/g)) {
    if (!m[0].startsWith('qq:')) add(m[0])
  }
  for (const m of raw.matchAll(/[\p{Script=Han}]{2,24}/gu)) {
    const chunk = m[0]
    if (chunk.length <= 3) {
      add(chunk)
    } else {
      for (let i = 0; i <= chunk.length - 2 && found.length < limit; i += 1) {
        add(chunk.slice(i, i + 2))
      }
    }
    if (found.length >= limit) break
  }
  return found.slice(0, limit)
}

function normalizePid(raw) {
  if (!raw) return ''
  const v = typeof raw === 'string' ? raw.trim() : String(raw.participantId ?? raw.id ?? '').trim()
  if (!v || v === 'self' || v === 'bot') return ''
  if (/^\d+$/.test(v)) return `qq:${v}`
  return v
}

function collectParticipants({ cohortMap = null, text = '', store = null, scope = '' }) {
  const ids = []
  const seen = new Set()
  const push = raw => {
    const pid = normalizePid(raw)
    if (!pid || seen.has(pid)) return
    seen.add(pid)
    ids.push(pid)
  }

  if (cohortMap && typeof cohortMap === 'object') {
    for (const key of Object.keys(cohortMap)) push(key)
  }

  for (const m of String(text ?? '').matchAll(/\bqq:(\d{4,15})\b/gi)) {
    push(`qq:${m[1]}`)
  }

  if (store && typeof store.resolveParticipantsInText === 'function' && text) {
    try {
      const resolved = store.resolveParticipantsInText(text, { viewerScope: scope }) || []
      for (const item of resolved) push(item)
    } catch {
      // Optional store resolution fallback
    }
  }

  return ids
}

function displayCall(pid, cohortEntry, store, scope) {
  if (store && typeof store.getParticipant === 'function') {
    try {
      const p = store.getParticipant(pid, { viewerScope: scope })
      if (p?.preferredCall) return p.preferredCall
      if (p?.nickname) return p.nickname
    } catch {
      // ignore
    }
  }
  return cohortEntry?.nickname || pid
}

function buildSeqRange(startSeq, endSeq) {
  const s = Number.isFinite(startSeq) ? Number(startSeq) : null
  const e = Number.isFinite(endSeq) ? Number(endSeq) : null
  if (s === null && e === null) return { startSeq: null, endSeq: null, seqRange: null }
  const low = s ?? e
  const high = e ?? s
  return {
    startSeq: low,
    endSeq: high,
    seqRange: { startSeq: low, endSeq: high, min: low, max: high },
  }
}

function safeExtractPrivateMoodSlice({ scope, sessionId, startMs, endMs, moodConnector }) {
  if (!String(scope ?? '').startsWith('private:')) return null
  if (!moodConnector || typeof moodConnector.extractMoodSlice !== 'function') return null
  try {
    return moodConnector.extractMoodSlice({ sessionId, scope, startMs, endMs }) ?? null
  } catch {
    return null
  }
}

/**
 * Turns a completed/archived TopicThread into a SharedEpisode in store.
 */
export function crystallizeTopicThread({
  topic,
  store = null,
  moodConnector = null,
  nowMs = Date.now(),
} = {}) {
  if (!topic || typeof topic !== 'object') return null

  const scope = String(topic.scope || (topic.groupId ? `group:${topic.groupId}` : 'public_roster'))
  if (topic.crystallizedEpisodeId) {
    if (store && typeof store.getEpisode === 'function') {
      try {
        const existing = store.getEpisode(topic.crystallizedEpisodeId, { viewerScope: scope, excludeInvalidated: true })
        if (existing && !existing.invalidatedByRewind) return existing
      } catch {
        // fall through to cached reference if any
      }
    }
    if (topic.crystallizedEpisode) return topic.crystallizedEpisode
  }

  const messages = Array.isArray(topic.messages) ? topic.messages : []
  const rawTitle = cleanIndexText(topic.title || messages[0]?.text || '', 32)
  const rawSummary = cleanIndexText(topic.summary || '', 260)
  if (!messages.length && !rawTitle && !rawSummary) return null

  const title = rawTitle || '日常交流'
  const cohort = topic.cohort && typeof topic.cohort === 'object' ? topic.cohort : {}
  const combinedText = [
    title,
    rawSummary,
    ...messages.map(m => m?.text || ''),
  ].join(' ')

  const participantIds = collectParticipants({
    cohortMap: cohort,
    text: combinedText,
    store,
    scope,
  })

  const callNames = participantIds
    .slice(0, 4)
    .map(pid => displayCall(pid, cohort[pid], store, scope))

  const stanceSnippets = participantIds
    .slice(0, 5)
    .map(pid => {
      const entry = cohort[pid]
      const name = displayCall(pid, entry, store, scope)
      const stance = cleanIndexText(entry?.stanceSummary || entry?.latestStance || '', 48)
      return stance ? `${name}: ${stance}` : name
    })
    .filter(Boolean)

  const openQ = cleanIndexText(topic.openQuestion || '', 60)
  const summaryBody = rawSummary || (stanceSnippets.length
    ? stanceSnippets.join('；')
    : cleanIndexText(messages.slice(-3).map(m => `${m.nickname || m.speakerId}: ${m.text}`).join('；'), 220))
  const summary = cleanIndexText(
    `话题「${title}」：${summaryBody}${openQ ? `（待续：${openQ}）` : ''}`,
    320,
  )

  const whoPrefix = callNames.length ? `${callNames.join('、')}聊` : '讨论'
  const indexLine = cleanIndexText(
    `${whoPrefix}「${title}」${openQ ? `（未完：${openQ}）` : ''}`,
    58,
  )

  const seqNums = messages.map(m => m?.seq).filter(s => Number.isFinite(s))
  const { startSeq, endSeq, seqRange } = buildSeqRange(
    topic.seqRange?.startSeq ?? topic.startSeq ?? (seqNums.length ? Math.min(...seqNums) : null),
    topic.seqRange?.endSeq ?? topic.endSeq ?? (seqNums.length ? Math.max(...seqNums) : null),
  )

  const groupId = scope.startsWith('group:')
    ? scope.slice('group:'.length)
    : (topic.groupId != null ? String(topic.groupId) : null)

  const startMs = Number.isFinite(topic.createdAt) ? topic.createdAt : nowMs
  const endMs = Number.isFinite(topic.updatedAt) ? topic.updatedAt : nowMs
  const moodSlice = safeExtractPrivateMoodSlice({
    scope,
    sessionId: topic.sessionId,
    startMs,
    endMs,
    moodConnector,
  })

  const isGroup = scope.startsWith('group:')
  const isHighlight = isGroup && (
    messages.length >= 2 ||
    participantIds.length >= 2 ||
    participantIds.includes('qq:1024162823') ||
    participantIds.includes('qq:616860663')
  )

  const topicId = String(topic.id ?? topic.topicId ?? `topic-${nowMs}`)
  const episodeId = `ep-${topicId}`
  const keywords = Array.isArray(topic.keywords) && topic.keywords.length
    ? [...new Set([...topic.keywords, ...extractEpisodeKeywords(combinedText)])].slice(0, 14)
    : extractEpisodeKeywords(combinedText, 14)

  const episode = {
    id: episodeId,
    episodeId,
    topicId,
    sessionId: String(topic.sessionId ?? ''),
    scope,
    groupId,
    title,
    summary,
    indexLine,
    participantIds,
    participants: participantIds,
    startSeq,
    endSeq,
    seqRange,
    moodSlice,
    isHighlight,
    highlight: isHighlight,
    openLoops: openQ ? [openQ] : [],
    keywords,
    invalidatedByRewind: false,
    createdAt: nowMs,
    updatedAt: nowMs,
  }

  if (store && typeof store.saveEpisode === 'function') {
    store.saveEpisode(episode)
  }

  topic.status = 'archived'
  topic.archivedAt = topic.archivedAt ?? nowMs
  topic.crystallizedEpisodeId = episodeId
  topic.crystallizedEpisode = episode

  if (store && typeof store.saveTopic === 'function') {
    try {
      store.saveTopic(topic)
    } catch {
      // ignore optional topic persistence error
    }
  }

  return episode
}

function seqRangeOverlapsCompaction(topic, sliceStartSeq, sliceEndSeq) {
  if (!Number.isFinite(sliceEndSeq)) return false
  const tEnd = topic?.seqRange?.endSeq ?? topic?.endSeq
  if (Number.isFinite(tEnd)) return tEnd <= sliceEndSeq
  return false
}

/**
 * Crystallizes a DSH `compaction/summary` slice (plus any warm topics covered by the compacted range)
 * into SharedEpisode records in store.
 */
export function crystallizeCompaction({
  sessionId,
  scope,
  sliceStartSeq = null,
  sliceEndSeq = null,
  summaryText = '',
  stage = null,
  store = null,
  moodConnector = null,
  nowMs = Date.now(),
} = {}) {
  const effectiveScope = String(scope || stage?.scope || '').trim()
  if (!sessionId || !effectiveScope) return null

  const crystallizedTopics = []
  if (stage && Array.isArray(stage.warm)) {
    for (const warmTopic of [...stage.warm]) {
      if (seqRangeOverlapsCompaction(warmTopic, sliceStartSeq, sliceEndSeq)) {
        const ep = crystallizeTopicThread({ topic: warmTopic, store, moodConnector, nowMs })
        if (ep) crystallizedTopics.push(ep)
      }
    }
  }

  const cleanedSummary = cleanIndexText(summaryText, 420)
  if (!cleanedSummary) {
    return crystallizedTopics[0] ?? null
  }

  const mergedCohort = {}
  if (stage?.focused?.cohort) Object.assign(mergedCohort, stage.focused.cohort)
  if (Array.isArray(stage?.warm)) {
    for (const w of stage.warm) {
      if (w?.cohort) Object.assign(mergedCohort, w.cohort)
    }
  }

  const participantIds = collectParticipants({
    cohortMap: mergedCohort,
    text: summaryText,
    store,
    scope: effectiveScope,
  })

  const firstClause = cleanIndexText(
    String(summaryText ?? '').split(/[\n。！？!?；;]/)[0] || stage?.focused?.title || '阶段对话回顾',
    28,
  )
  const title = firstClause || stage?.focused?.title || '阶段对话回顾'
  const callNames = participantIds
    .slice(0, 3)
    .map(pid => displayCall(pid, mergedCohort[pid], store, effectiveScope))

  const indexLine = cleanIndexText(
    callNames.length ? `${callNames.join('、')}：${title}` : title,
    58,
  )

  const { startSeq, endSeq, seqRange } = buildSeqRange(sliceStartSeq, sliceEndSeq)
  const groupId = effectiveScope.startsWith('group:')
    ? effectiveScope.slice('group:'.length)
    : (stage?.groupId != null ? String(stage.groupId) : null)

  const startMs = stage?.focused?.createdAt ?? (nowMs - 30 * 60_000)
  const moodSlice = safeExtractPrivateMoodSlice({
    scope: effectiveScope,
    sessionId,
    startMs,
    endMs: nowMs,
    moodConnector,
  })

  const isHighlight = effectiveScope.startsWith('group:')
  const episodeId = `ep-compact-${sessionId}-${startSeq ?? 'na'}-${endSeq ?? nowMs}`
  const openLoops = []
  if (stage?.focused?.openQuestion) openLoops.push(cleanIndexText(stage.focused.openQuestion, 60))
  for (const w of stage?.warm || []) {
    if (w?.openQuestion && openLoops.length < 3) openLoops.push(cleanIndexText(w.openQuestion, 60))
  }

  const episode = {
    id: episodeId,
    episodeId,
    topicId: stage?.focused?.id ?? null,
    sessionId: String(sessionId),
    scope: effectiveScope,
    groupId,
    title,
    summary: cleanedSummary,
    indexLine,
    participantIds,
    participants: participantIds,
    startSeq,
    endSeq,
    seqRange,
    moodSlice,
    isHighlight,
    highlight: isHighlight,
    openLoops,
    keywords: extractEpisodeKeywords(summaryText, 14),
    crystallizedTopicIds: crystallizedTopics.map(ep => ep.id),
    invalidatedByRewind: false,
    createdAt: nowMs,
    updatedAt: nowMs,
  }

  if (store && typeof store.saveEpisode === 'function') {
    store.saveEpisode(episode)
  }

  return episode
}
