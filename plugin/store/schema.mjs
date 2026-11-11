export const PUBLIC_ROSTER_SCOPE = 'public_roster'
export const PRIVATE_SCOPE_PREFIX = 'private:'
export const GROUP_SCOPE_PREFIX = 'group:'

export const TRUST_LEVELS = Object.freeze([
  'owner_curated',
  'fish_observed',
  'self_claimed_tentative',
])

export const TRUST_RANK = Object.freeze({
  self_claimed_tentative: 1,
  fish_observed: 2,
  owner_curated: 3,
})

export const RELATION_STATUSES = Object.freeze(['active', 'historical'])
export const TOPIC_STATUSES = Object.freeze(['focused', 'warm', 'archived'])

export function isPublicRosterScope(scope) {
  return scope === PUBLIC_ROSTER_SCOPE
}

export function isPrivateScope(scope) {
  return (
    typeof scope === 'string' &&
    scope.startsWith(PRIVATE_SCOPE_PREFIX) &&
    scope.slice(PRIVATE_SCOPE_PREFIX.length).trim().length > 0
  )
}

export function isGroupScope(scope) {
  return (
    typeof scope === 'string' &&
    scope.startsWith(GROUP_SCOPE_PREFIX) &&
    scope.slice(GROUP_SCOPE_PREFIX.length).trim().length > 0
  )
}

export function isValidScopeId(scope) {
  return isPublicRosterScope(scope) || isPrivateScope(scope) || isGroupScope(scope)
}

export function assertValidScopeId(scope, label = 'scope') {
  if (!isValidScopeId(scope)) {
    const err = new TypeError(
      `Invalid ${label}: ${JSON.stringify(scope)} (expected 'public_roster', 'private:<id>', or 'group:<id>')`
    )
    err.code = 'ERR_INVALID_SCOPE'
    throw err
  }
  return scope
}

export function isValidTrustLevel(trust) {
  return typeof trust === 'string' && TRUST_LEVELS.includes(trust)
}

export function assertValidTrustLevel(trust, label = 'trust') {
  if (!isValidTrustLevel(trust)) {
    const err = new TypeError(
      `Invalid ${label}: ${JSON.stringify(trust)} (expected one of ${TRUST_LEVELS.join(', ')})`
    )
    err.code = 'ERR_INVALID_TRUST'
    throw err
  }
  return trust
}

export function trustRank(trust) {
  return isValidTrustLevel(trust) ? TRUST_RANK[trust] : 0
}

export function isValidRelationStatus(status) {
  return typeof status === 'string' && RELATION_STATUSES.includes(status)
}

export function isValidTopicStatus(status) {
  return typeof status === 'string' && TOPIC_STATUSES.includes(status)
}

/**
 * Strict one-way ScopeGate:
 * - viewerScope = 'group:<id>': may ONLY read 'public_roster' and exact matching 'group:<id>'
 *   (NEVER any 'private:*' or another group's records).
 * - viewerScope = 'private:<id>': may read exact matching 'private:<id>', 'public_roster',
 *   AND any 'group:*' public group records (NEVER another user's 'private:*').
 * - viewerScope = 'public_roster': may ONLY read 'public_roster'.
 */
export function canScopeAccess(viewerScope, recordScope) {
  if (!isValidScopeId(viewerScope) || !isValidScopeId(recordScope)) {
    return false
  }
  if (recordScope === PUBLIC_ROSTER_SCOPE) {
    return true
  }
  if (viewerScope === PUBLIC_ROSTER_SCOPE) {
    return false
  }
  if (isGroupScope(viewerScope)) {
    return recordScope === viewerScope
  }
  if (isPrivateScope(viewerScope)) {
    return recordScope === viewerScope || isGroupScope(recordScope)
  }
  return false
}

function createGateError(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Validates write-side ScopeGate & TrustLevel anti-poisoning invariants.
 */
export function enforceWriteScopeAndTrust({ scope, writerScope, trust } = {}) {
  if (writerScope !== undefined && writerScope !== null) {
    assertValidScopeId(writerScope, 'writerScope')
  }
  const resolvedScope = scope ?? writerScope ?? PUBLIC_ROSTER_SCOPE
  assertValidScopeId(resolvedScope, 'scope')

  if (writerScope && isGroupScope(writerScope)) {
    if (resolvedScope !== writerScope) {
      throw createGateError(
        `ScopeGate violation: group caller (${writerScope}) cannot write to ${resolvedScope}`,
        'ERR_SCOPE_GATE'
      )
    }
  } else if (writerScope && isPrivateScope(writerScope)) {
    if (resolvedScope !== writerScope && resolvedScope !== PUBLIC_ROSTER_SCOPE) {
      throw createGateError(
        `ScopeGate violation: private caller (${writerScope}) cannot write to ${resolvedScope}`,
        'ERR_SCOPE_GATE'
      )
    }
  } else if (writerScope === PUBLIC_ROSTER_SCOPE && resolvedScope !== PUBLIC_ROSTER_SCOPE) {
    throw createGateError(
      `ScopeGate violation: public_roster caller cannot write to ${resolvedScope}`,
      'ERR_SCOPE_GATE'
    )
  }

  const defaultTrust = isGroupScope(resolvedScope) ? 'fish_observed' : 'owner_curated'
  let resolvedTrust = trust ?? defaultTrust
  assertValidTrustLevel(resolvedTrust, 'trust')

  // Group scopes or group callers can NEVER mint owner_curated records.
  if (isGroupScope(resolvedScope) || (writerScope && isGroupScope(writerScope))) {
    if (resolvedTrust === 'owner_curated') {
      resolvedTrust = 'fish_observed'
    }
  }

  // Only owner_curated records are allowed in cross-channel public_roster.
  if (resolvedScope === PUBLIC_ROSTER_SCOPE && resolvedTrust !== 'owner_curated') {
    throw createGateError(
      `TrustLevel violation: cannot write '${resolvedTrust}' record to public_roster (requires 'owner_curated')`,
      'ERR_TRUST_LEVEL'
    )
  }

  return { scope: resolvedScope, trust: resolvedTrust }
}

export function normalizeStringList(values) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const out = []
  for (const raw of values) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const trimmed = String(raw).trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function validateParticipantInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Participant must be an object')
  }
  const participantId = String(input.participantId ?? input.id ?? '').trim()
  if (!participantId) {
    throw new TypeError('Participant requires a non-empty participantId')
  }
  const { scope, trust } = enforceWriteScopeAndTrust({
    scope: input.scope,
    writerScope: input.writerScope,
    trust: input.trust,
  })
  const aliasInputs = [
    ...(Array.isArray(input.aliases) ? input.aliases : []),
    ...(input.alias !== undefined && input.alias !== null ? [input.alias] : []),
  ]
  const factInputs = [
    ...(Array.isArray(input.facts) ? input.facts : []),
    ...(input.fact !== undefined && input.fact !== null ? [input.fact] : []),
  ]
  return {
    participantId,
    preferredCall:
      input.preferredCall !== undefined && input.preferredCall !== null
        ? String(input.preferredCall).trim() || null
        : undefined,
    nickname:
      (input.nickname ?? input.displayName) !== undefined &&
      (input.nickname ?? input.displayName) !== null
        ? String(input.nickname ?? input.displayName).trim() || null
        : undefined,
    aliases: normalizeStringList(aliasInputs),
    replaceAliases: input.replaceAliases === true,
    roleToFish:
      input.roleToFish !== undefined && input.roleToFish !== null
        ? String(input.roleToFish).trim() || 'member'
        : undefined,
    facts: normalizeStringList(factInputs),
    replaceFacts: input.replaceFacts === true,
    notes:
      input.notes !== undefined && input.notes !== null
        ? String(input.notes).trim() || null
        : undefined,
    metadata:
      input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
        ? input.metadata
        : undefined,
    scope,
    trust,
    writerScope: input.writerScope ?? null,
  }
}

export function canonicalizeParticipantPair(pairInput) {
  if (!Array.isArray(pairInput) || pairInput.length < 2) {
    throw new TypeError('RelationEdge requires two participant IDs')
  }
  const first = String(pairInput[0] ?? '').trim()
  const second = String(pairInput[1] ?? '').trim()
  if (!first || !second) {
    throw new TypeError('RelationEdge participant IDs must be non-empty strings')
  }
  if (first === second) {
    throw new TypeError(`RelationEdge requires two distinct participants, got '${first}'`)
  }
  const sorted = [first, second].sort()
  return {
    participantIds: [first, second],
    participantA: sorted[0],
    participantB: sorted[1],
    pairKey: `${sorted[0]}|${sorted[1]}`,
  }
}

export function validateRelationEdgeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('RelationEdge must be an object')
  }
  const rawPair = Array.isArray(input.participantIds)
    ? input.participantIds
    : Array.isArray(input.participants)
      ? input.participants
      : [
          input.participantA ?? input.sourceId ?? input.fromId ?? input.subjectId,
          input.participantB ?? input.targetId ?? input.toId ?? input.objectId,
        ]
  const { participantIds, participantA, participantB, pairKey } =
    canonicalizeParticipantPair(rawPair)

  const relation = String(input.relation ?? '').trim()
  if (!relation) {
    throw new TypeError('RelationEdge requires a non-empty relation description')
  }

  const { scope, trust } = enforceWriteScopeAndTrust({
    scope: input.scope,
    writerScope: input.writerScope,
    trust: input.trust,
  })

  const status = input.status ?? 'active'
  if (!isValidRelationStatus(status)) {
    throw new TypeError(`Invalid RelationEdge status: ${JSON.stringify(status)}`)
  }

  return {
    edgeId: input.edgeId ? String(input.edgeId).trim() : null,
    participantIds,
    participantA,
    participantB,
    pairKey,
    relation,
    relationType: String(input.relationType ?? 'social').trim() || 'social',
    closeness: Number.isFinite(input.closeness) ? Number(input.closeness) : null,
    notes:
      input.notes !== undefined && input.notes !== null
        ? String(input.notes).trim() || null
        : null,
    scope,
    trust,
    writerScope: input.writerScope ?? null,
    status,
    validAt: Number.isFinite(input.validAt) ? Number(input.validAt) : null,
    invalidAt: Number.isFinite(input.invalidAt) ? Number(input.invalidAt) : null,
    sourceEpisodeId: input.sourceEpisodeId ? String(input.sourceEpisodeId).trim() : null,
  }
}

export function normalizeSeqBounds(input) {
  let start =
    input?.startSeq ??
    input?.sliceStartSeq ??
    (Array.isArray(input?.seqRange)
      ? input.seqRange[0]
      : (input?.seqRange?.startSeq ?? input?.seqRange?.min ?? input?.seqRange?.start))
  let end =
    input?.endSeq ??
    input?.sliceEndSeq ??
    (Array.isArray(input?.seqRange)
      ? input.seqRange[1]
      : (input?.seqRange?.endSeq ?? input?.seqRange?.max ?? input?.seqRange?.end))

  const hasStart = Number.isFinite(start)
  const hasEnd = Number.isFinite(end)
  if (!hasStart && !hasEnd) {
    return { startSeq: null, endSeq: null }
  }
  let s = hasStart ? Math.trunc(Number(start)) : Math.trunc(Number(end))
  let e = hasEnd ? Math.trunc(Number(end)) : Math.trunc(Number(start))
  if (s > e) {
    ;[s, e] = [e, s]
  }
  return { startSeq: s, endSeq: e }
}

export function validateTopicInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Topic must be an object')
  }
  const rawScope = input.scope ?? input.writerScope
  assertValidScopeId(rawScope, 'topic.scope')
  const { scope } = enforceWriteScopeAndTrust({
    scope: rawScope,
    writerScope: input.writerScope,
    trust: input.trust,
  })
  const status = input.status ?? 'focused'
  if (!isValidTopicStatus(status)) {
    throw new TypeError(`Invalid Topic status: ${JSON.stringify(status)}`)
  }
  const cohort =
    input.cohort && typeof input.cohort === 'object' && !Array.isArray(input.cohort)
      ? input.cohort
      : {}
  const participantIds = normalizeStringList([
    ...Object.keys(cohort),
    ...(Array.isArray(input.participantIds) ? input.participantIds : []),
  ])
  const { startSeq, endSeq } = normalizeSeqBounds(input)

  return {
    topicId: String(input.topicId ?? input.id ?? '').trim() || null,
    sessionId: String(input.sessionId ?? '').trim(),
    scope,
    title: String(input.title ?? '').trim() || '未命名话题',
    summary: String(input.summary ?? '').trim(),
    status,
    keywords: Array.isArray(input.keywords) ? normalizeStringList(input.keywords) : null,
    openLoops: normalizeStringList(input.openLoops ?? []),
    cohort,
    participantIds,
    messageIds: normalizeStringList(input.messageIds ?? []),
    anchorMessageId: input.anchorMessageId ? String(input.anchorMessageId) : null,
    lastMessageId: input.lastMessageId ? String(input.lastMessageId) : null,
    startSeq,
    endSeq,
    episodeId:
      input.episodeId || input.crystallizedEpisodeId
        ? String(input.episodeId ?? input.crystallizedEpisodeId)
        : null,
    openQuestion: input.openQuestion ? String(input.openQuestion).trim() : null,
    warmUntil: Number.isFinite(input.warmUntil) ? Number(input.warmUntil) : null,
    invalidatedByRewind: Boolean(input.invalidatedByRewind),
    createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : null,
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : null,
    lastActiveAt: Number.isFinite(input.lastActiveAt) ? Number(input.lastActiveAt) : null,
  }
}

export function validateEpisodeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Episode must be an object')
  }
  const rawScope = input.scope ?? input.writerScope
  assertValidScopeId(rawScope, 'episode.scope')
  const { scope } = enforceWriteScopeAndTrust({
    scope: rawScope,
    writerScope: input.writerScope,
    trust: input.trust,
  })
  const summary = String(input.summary ?? input.summaryText ?? '').trim()
  const rawTitle = String(input.title ?? '').trim()
  const title = rawTitle || summary.slice(0, 32) || '对话记忆片段'
  const rawIndex = String(input.indexLine ?? '').trim()
  const compactSummary = summary.replace(/\s+/g, ' ')
  const indexLine =
    rawIndex ||
    (compactSummary
      ? `${title}：${compactSummary.slice(0, 56)}`
      : title)

  const { startSeq, endSeq } = normalizeSeqBounds(input)
  // Defense-in-depth: never store private mood reasons on non-private episodes.
  const moodSlice =
    isPrivateScope(scope) && input.moodSlice && typeof input.moodSlice === 'object'
      ? input.moodSlice
      : null

  return {
    episodeId: String(input.episodeId ?? input.id ?? '').trim() || null,
    sessionId: String(input.sessionId ?? '').trim(),
    topicId: input.topicId ? String(input.topicId).trim() : null,
    scope,
    title,
    summary,
    indexLine,
    participantIds: normalizeStringList(input.participantIds ?? input.participants ?? []),
    keywords: Array.isArray(input.keywords) ? normalizeStringList(input.keywords) : null,
    openLoops: normalizeStringList(input.openLoops ?? []),
    highlights: normalizeStringList(input.highlights ?? []),
    moodSlice,
    startSeq,
    endSeq,
    isHighlight: input.isHighlight !== false,
    invalidatedByRewind: Boolean(input.invalidatedByRewind),
    occurredAt: Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : null,
    createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : null,
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : null,
  }
}

export function sanitizeCareBiasTone(tone) {
  if (tone === undefined || tone === null) return ''
  // Collapse whitespace/newlines, strip CQ tags or quote blocks so only short demeanor remains.
  let cleaned = String(tone)
    .replace(/\[CQ:[^\]]*\]/gi, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length > 120) {
    cleaned = cleaned.slice(0, 120).trim()
  }
  return cleaned
}
