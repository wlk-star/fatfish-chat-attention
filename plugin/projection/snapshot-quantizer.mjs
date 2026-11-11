const GROUP_TOKEN_BUDGET = 450
const PRIVATE_TOKEN_BUDGET = 150

const storeIds = new WeakMap()
const stageIds = new WeakMap()
let nextObjectTag = 1

// Cache keyed by `${instanceTag}::${sessionId}::${viewerScope}::${isGroup ? 'G' : 'P'}`
const snapshotCache = new Map()

function getObjectTag(obj, map) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return 'none'
  let id = map.get(obj)
  if (!id) {
    id = ++nextObjectTag
    map.set(obj, id)
  }
  return String(id)
}

export function clearSnapshotCache() {
  snapshotCache.clear()
}

export function estimateTokens(text) {
  if (!text) return 0
  let tokens = 0
  let asciiRun = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    if (code <= 0x7f) {
      if (/\s/.test(ch)) {
        if (asciiRun > 0) {
          tokens += Math.ceil(asciiRun / 3.8)
          asciiRun = 0
        }
      } else {
        asciiRun++
      }
    } else {
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 3.8)
        asciiRun = 0
      }
      tokens += 1
    }
  }
  if (asciiRun > 0) tokens += Math.ceil(asciiRun / 3.8)
  return tokens
}

function canViewerRead(viewerScope, recordScope) {
  if (!recordScope || recordScope === 'public_roster') return true
  const viewer = String(viewerScope ?? '')
  const record = String(recordScope)
  if (viewer.startsWith('group:')) {
    return record === 'public_roster' || record === viewer
  }
  if (viewer.startsWith('private:')) {
    return record === viewer || record === 'public_roster' || record.startsWith('group:')
  }
  return record === 'public_roster'
}

/**
 * Strips dynamic timestamps, relative time phrases, and newlines for strict idempotency.
 */
function sanitizeStatic(value, maxLen = 64) {
  const cleaned = String(value ?? '')
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
    .replace(/\d+\s*(?:秒|分钟|小时|天|周|个月)(?:前|后|内)/g, '')
    .replace(/\b\d+\s*(?:sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\s*ago\b/gi, '')
    .replace(/\bTTL\s*[:=]\s*\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= maxLen) return cleaned
  return cleaned.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…'
}

function resolveCallName(participantId, fallbackNickname, store, viewerScope) {
  if (store && typeof store.getParticipant === 'function') {
    try {
      const p = store.getParticipant(participantId, { viewerScope })
      if (p && canViewerRead(viewerScope, p.scope)) {
        const call = sanitizeStatic(p.preferredCall || p.nickname || '', 24)
        if (call) return call
      }
    } catch {
      // ignore optional store error
    }
  }
  const nick = sanitizeStatic(fallbackNickname || '', 24)
  return nick || participantId
}

function resolveCareBiasTone(participantId, store, nowMs) {
  if (!store || typeof store.getCareBias !== 'function') return ''
  try {
    const bias = store.getCareBias(participantId, nowMs)
    if (!bias) return ''
    const rawTone = typeof bias === 'string' ? bias : (bias.tone ?? '')
    return sanitizeStatic(rawTone, 36)
  } catch {
    return ''
  }
}

function extractEdgeEndpoints(edge) {
  if (!edge || typeof edge !== 'object') return [null, null]
  if (Array.isArray(edge.participants) && edge.participants.length >= 2) {
    return [String(edge.participants[0]), String(edge.participants[1])]
  }
  const a = edge.sourceId ?? edge.fromId ?? edge.subjectId ?? edge.participantA ?? edge.a ?? null
  const b = edge.targetId ?? edge.toId ?? edge.objectId ?? edge.participantB ?? edge.b ?? null
  return [a ? String(a) : null, b ? String(b) : null]
}

function fetchSafeRelations(participantIds, cohortMap, store, viewerScope) {
  if (!participantIds.length || !store || typeof store.getCohortRelations !== 'function') return []
  let rawEdges = []
  try {
    rawEdges = store.getCohortRelations(participantIds, { viewerScope }) || []
  } catch {
    return []
  }

  const lines = []
  const seen = new Set()
  for (const edge of rawEdges) {
    if (!edge || edge.status === 'historical' || edge.invalidAt != null) continue
    if (!canViewerRead(viewerScope, edge.scope)) continue
    const [idA, idB] = extractEdgeEndpoints(edge)
    const rel = sanitizeStatic(edge.relation || edge.label || edge.summary || '', 44)
    if (!rel) continue

    const nameA = idA ? resolveCallName(idA, cohortMap?.[idA]?.nickname, store, viewerScope) : ''
    const nameB = idB ? resolveCallName(idB, cohortMap?.[idB]?.nickname, store, viewerScope) : ''
    const trustNote = edge.trust === 'self_claimed_tentative' ? '(群友自称/待核实)' : ''
    const pairLabel = idA && idB ? `${nameA}(${idA}) ↔ ${nameB}(${idB}): ${rel}${trustNote}` : `${rel}${trustNote}`
    if (seen.has(pairLabel)) continue
    seen.add(pairLabel)
    lines.push(pairLabel)
  }
  return lines.sort()
}

function fetchSafeEpisodes(query, store, viewerScope, limit = 3) {
  if (!query || !store || typeof store.searchEpisodes !== 'function') return []
  try {
    const list = store.searchEpisodes(query, { viewerScope, limit }) || []
    return list.filter(ep => ep && !ep.invalidatedByRewind && canViewerRead(viewerScope, ep.scope))
  } catch {
    return []
  }
}

function fetchUnsharedGroupHighlights({ stage, store, viewerScope, includeGroupHighlights, ownerId }) {
  if (!includeGroupHighlights) return []
  const expectedOwnerScope = `private:${ownerId}`
  if (viewerScope && viewerScope !== expectedOwnerScope) return []

  const sharedSet = new Set(
    Array.isArray(stage?.sharedHighlightIds)
      ? stage.sharedHighlightIds.map(String)
      : (stage?.sharedHighlightIds instanceof Set ? [...stage.sharedHighlightIds].map(String) : []),
  )

  const items = []
  const seen = new Set()
  const add = item => {
    if (!item || item.invalidatedByRewind) return
    if (item.scope && !String(item.scope).startsWith('group:')) return
    const id = String(item.id ?? item.episodeId ?? '')
    if (!id || sharedSet.has(id) || seen.has(id)) return
    seen.add(id)
    items.push(item)
  }

  if (Array.isArray(stage?.unseenGroupHighlights)) {
    for (const h of stage.unseenGroupHighlights) add(h)
  }

  if (store && typeof store.listRecentGroupHighlights === 'function') {
    try {
      const sinceMs = Number.isFinite(stage?.sharedHighlightBeforeMs) ? stage.sharedHighlightBeforeMs : 0
      const list = store.listRecentGroupHighlights({
        viewerScope,
        sinceMs,
        limit: 3,
      }) || []
      for (const h of list) add(h)
    } catch {
      // ignore optional store error
    }
  }

  return items.slice(0, 3)
}

function fitLinesWithinBudget(buildFn, maxTokens) {
  const attempts = [
    { maxCohort: 6, maxEdges: 3, maxWarm: 4, maxEpisodes: 3, lineCap: 54 },
    { maxCohort: 4, maxEdges: 2, maxWarm: 3, maxEpisodes: 2, lineCap: 42 },
    { maxCohort: 3, maxEdges: 1, maxWarm: 2, maxEpisodes: 1, lineCap: 32 },
    { maxCohort: 2, maxEdges: 1, maxWarm: 1, maxEpisodes: 1, lineCap: 24 },
  ]
  let last = ''
  for (const cfg of attempts) {
    last = buildFn(cfg)
    if (estimateTokens(last) <= maxTokens) return last
  }
  // Hard character fallback if extreme synthetic inputs still exceed budget
  let trimmed = last
  while (estimateTokens(trimmed) > maxTokens && trimmed.length > 24) {
    trimmed = trimmed.slice(0, Math.floor(trimmed.length * 0.85)).trimEnd() + '…'
  }
  return trimmed
}

function renderGroupSnapshot({ stage, store, viewerScope, nowMs }) {
  const focused = stage?.focused ?? null
  const warm = Array.isArray(stage?.warm) ? stage.warm : []
  if (!focused && !warm.length) return ''

  const cohortMap = focused?.cohort && typeof focused.cohort === 'object' ? focused.cohort : {}
  const cohortIds = Object.keys(cohortMap).filter(pid => pid && pid !== 'self' && pid !== 'bot')
  const relationLines = fetchSafeRelations(cohortIds, cohortMap, store, viewerScope)

  const searchTerms = [
    focused?.title || '',
    ...(Array.isArray(focused?.keywords) ? focused.keywords.slice(0, 4) : []),
    ...warm.slice(0, 1).map(w => w?.title || ''),
  ].filter(Boolean).join(' ')
  const episodes = fetchSafeEpisodes(searchTerms, store, viewerScope, 3)

  return fitLinesWithinBudget(({ maxCohort, maxEdges, maxWarm, maxEpisodes, lineCap }) => {
    const out = ['[当前话题舞台]']
    if (focused) {
      const fId = sanitizeStatic(focused.id ?? focused.topicId ?? 'focused', 24)
      const fTitle = sanitizeStatic(focused.title || '当前讨论', lineCap)
      out.push(`- 焦点: [${fId}] ${fTitle}`)
      if (cohortIds.length) {
        const memberTags = cohortIds.slice(0, maxCohort).map(pid => {
          const call = resolveCallName(pid, cohortMap[pid]?.nickname, store, viewerScope)
          const bias = resolveCareBiasTone(pid, store, nowMs)
          const label = call === pid ? pid : `${call}(${pid})`
          return bias ? `${label}[语气留意:${sanitizeStatic(bias, 24)}]` : label
        })
        const overflow = cohortIds.length > maxCohort ? ` 等${cohortIds.length}人` : ''
        out.push(`- 在场: ${memberTags.join('、')}${overflow}`)
      }
      for (const edgeLine of relationLines.slice(0, maxEdges)) {
        out.push(`- 关系: ${sanitizeStatic(edgeLine, lineCap + 18)}`)
      }
    } else {
      out.push('- 焦点: 暂无活跃主话题')
    }

    out.push('[温热挂起话题]')
    if (warm.length) {
      for (const w of warm.slice(0, maxWarm)) {
        const wId = sanitizeStatic(w.id ?? w.topicId ?? 'warm', 24)
        const wTitle = sanitizeStatic(w.title || '未完话题', lineCap)
        const wPids = Object.keys(w.cohort ?? {}).filter(pid => pid && pid !== 'self' && pid !== 'bot')
        const wWho = wPids.slice(0, 3).map(pid => resolveCallName(pid, w.cohort?.[pid]?.nickname, store, viewerScope)).join('、')
        out.push(wWho ? `- [${wId}] ${wTitle}（参与:${wWho}）` : `- [${wId}] ${wTitle}`)
      }
    } else {
      out.push('- 暂无')
    }

    out.push('[关联共同经历索引]')
    if (episodes.length) {
      for (const ep of episodes.slice(0, maxEpisodes)) {
        const epId = sanitizeStatic(ep.id ?? ep.episodeId ?? 'ep', 28)
        const idx = sanitizeStatic(ep.indexLine || ep.title || ep.summary || '', lineCap)
        out.push(`- [${epId}] ${idx}`)
      }
    } else {
      out.push('- 暂无匹配经历')
    }
    out.push('提示: 如需展开挂起话题、经历详情或原话，请调用 focus_attention 工具。')
    return out.join('\n')
  }, GROUP_TOKEN_BUDGET)
}

function renderPrivateSnapshot({ stage, store, viewerScope, ownerId, highlights }) {
  const focused = stage?.focused ?? null
  const warm = Array.isArray(stage?.warm) ? stage.warm : []
  const cohortMap = focused?.cohort && typeof focused.cohort === 'object' ? focused.cohort : {}
  const cohortIds = Object.keys(cohortMap).filter(pid => pid && pid !== 'self' && pid !== 'bot')

  const extraMentioned = Array.isArray(stage?.mentionedParticipantIds) ? stage.mentionedParticipantIds : []
  const thirdPartyIds = [...new Set([...cohortIds, ...extraMentioned])].filter(pid => pid && pid !== ownerId)

  if (warm.length === 0 && thirdPartyIds.length === 0 && highlights.length === 0) {
    return ''
  }

  const relationLines = thirdPartyIds.length
    ? fetchSafeRelations([ownerId, ...thirdPartyIds], cohortMap, store, viewerScope)
    : []

  return fitLinesWithinBudget(({ maxEdges, maxWarm, maxEpisodes, lineCap }) => {
    const out = []

    if (warm.length > 0) {
      out.push('[当前与挂起话题]')
      if (focused) {
        out.push(`- 焦点: ${sanitizeStatic(focused.title || '当前对话', lineCap)}`)
      }
      for (const w of warm.slice(0, Math.min(2, maxWarm))) {
        const wId = sanitizeStatic(w.id ?? w.topicId ?? 'warm', 20)
        out.push(`- 挂起: [${wId}] ${sanitizeStatic(w.title || '未完话题', lineCap)}`)
      }
    }

    if (thirdPartyIds.length > 0) {
      out.push('[提及亲友]')
      const labels = thirdPartyIds.slice(0, 3).map(pid => {
        const call = resolveCallName(pid, cohortMap[pid]?.nickname, store, viewerScope)
        return call === pid ? pid : `${call}(${pid})`
      })
      out.push(`- 人物: ${labels.join('、')}`)
      for (const rel of relationLines.slice(0, Math.min(2, maxEdges))) {
        out.push(`- 关系: ${sanitizeStatic(rel, lineCap + 10)}`)
      }
    }

    if (highlights.length > 0) {
      out.push('[群聊近期动态]')
      for (const h of highlights.slice(0, Math.min(2, maxEpisodes))) {
        const hId = sanitizeStatic(h.id ?? h.episodeId ?? 'hl', 24)
        const line = sanitizeStatic(h.indexLine || h.title || h.summary || '', lineCap)
        out.push(`- [${hId}] ${line}`)
      }
    }

    out.push('需详情可调 focus_attention。')
    return out.join('\n')
  }, PRIVATE_TOKEN_BUDGET)
}

/**
 * Epoch-locked, strictly idempotent RuntimeContextProjection quantizer.
 * Zero timestamps, zero relative time strings, zero TTL counters.
 */
export function renderStageSnapshot({
  stage,
  store = null,
  viewerScope = '',
  isGroup = false,
  ownerId = 'qq:1024162823',
  includeGroupHighlights = true,
  nowMs = Date.now(),
} = {}) {
  const effectiveScope = String(
    viewerScope || stage?.scope || (isGroup ? `group:${stage?.groupId ?? 'default'}` : `private:${ownerId}`),
  )
  const sessionId = String(stage?.sessionId ?? effectiveScope)
  const epoch = Number.isFinite(stage?.epoch) ? Number(stage.epoch) : 0

  const privateHighlights = !isGroup
    ? fetchUnsharedGroupHighlights({
        stage,
        store,
        viewerScope: effectiveScope,
        includeGroupHighlights,
        ownerId,
      })
    : []

  const baseHighlightRev = Number.isFinite(stage?.highlightRevision) ? Number(stage.highlightRevision) : 0
  const highlightRevision = !isGroup && privateHighlights.length
    ? `${baseHighlightRev}:${privateHighlights.map(h => h.id ?? h.episodeId).join(',')}`
    : String(baseHighlightRev)

  const instanceKey = store
    ? `store:${getObjectTag(store, storeIds)}`
    : (stage?._stageUid ? `uid:${stage._stageUid}` : `stage:${getObjectTag(stage, stageIds)}`)

  const cacheKey = `${instanceKey}::${sessionId}::${effectiveScope}::${isGroup ? 'G' : 'P'}`
  const cached = snapshotCache.get(cacheKey)
  if (cached && cached.epoch === epoch && cached.highlightRevision === highlightRevision) {
    return cached.text
  }

  const text = isGroup
    ? renderGroupSnapshot({ stage, store, viewerScope: effectiveScope, nowMs })
    : renderPrivateSnapshot({
        stage,
        store,
        viewerScope: effectiveScope,
        ownerId,
        highlights: privateHighlights,
      })

  if (snapshotCache.size > 256) {
    const oldestKey = snapshotCache.keys().next().value
    snapshotCache.delete(oldestKey)
  }
  snapshotCache.set(cacheKey, { epoch, highlightRevision, text })

  return text
}
