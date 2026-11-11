/**
 * L0 Identity & Quote Enrichment for OneBot v11 / NapCat / DSH QQ Bridges.
 *
 * Ensures stable `qq:<userId>` participant anchoring across nickname changes
 * and preserves `[CQ:reply]` / `{ type: 'reply' }` quote chains into L1/L2.
 */

function cleanRawQqId(userId) {
  if (userId === null || userId === undefined) return ''
  const raw = String(userId).trim()
  if (!raw) return ''
  if (/^qq:/i.test(raw)) return raw.slice(3).trim()
  return raw
}

function unescapeCqValue(value) {
  return String(value ?? '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
    .trim()
}

function resolveLookupUserId(lookup, messageId) {
  if (!lookup || !messageId) return null
  if (typeof lookup === 'function') {
    const found = lookup(messageId)
    const id = cleanRawQqId(found)
    return id || null
  }
  if (lookup instanceof Map) {
    const found = lookup.get(messageId) ?? lookup.get(String(messageId))
    const id = cleanRawQqId(found)
    return id || null
  }
  if (typeof lookup === 'object') {
    const found = lookup[messageId]
    const id = cleanRawQqId(found)
    return id || null
  }
  return null
}

/**
 * Normalize a raw QQ number or string into canonical `'qq:<id>'` ParticipantId.
 * Returns `''` if `userId` is null/undefined/blank.
 */
export function normalizeParticipantId(userId) {
  const id = cleanRawQqId(userId)
  return id ? `qq:${id}` : ''
}

/**
 * Extract `{ replyToMessageId, replyToUserId }` from OneBot v11 message segments
 * (`seg.type === 'reply'`), CQ code strings (`[CQ:reply,id=...]`), or a full OneBot event.
 */
export function extractReplySegment(segments, options = {}) {
  const lookup = options?.lookupUserId ?? options?.messageSenders ?? null
  const source =
    segments && typeof segments === 'object' && !Array.isArray(segments)
      ? (segments.message ?? segments.raw_message ?? null)
      : segments

  if (Array.isArray(source)) {
    for (const seg of source) {
      if (seg?.type !== 'reply') continue
      const data = seg.data ?? {}
      const rawMsgId = data.id ?? data.message_id ?? data.seq ?? null
      const replyToMessageId =
        rawMsgId === null || rawMsgId === undefined || String(rawMsgId).trim() === ''
          ? null
          : String(rawMsgId).trim()
      const directUser = cleanRawQqId(data.qq ?? data.user_id ?? data.sender_id ?? data.uid ?? null)
      const replyToUserId = directUser || resolveLookupUserId(lookup, replyToMessageId)
      return {
        replyToMessageId,
        replyToUserId: replyToUserId || null,
      }
    }
    return { replyToMessageId: null, replyToUserId: null }
  }

  if (typeof source === 'string' && source.includes('[CQ:reply,')) {
    const match = source.match(/\[CQ:reply,([^\]]+)\]/)
    if (match) {
      const kv = {}
      for (const part of match[1].split(',')) {
        const eq = part.indexOf('=')
        if (eq < 0) continue
        const key = part.slice(0, eq).trim()
        const val = unescapeCqValue(part.slice(eq + 1))
        if (key) kv[key] = val
      }
      const replyToMessageId = kv.id || kv.message_id || kv.seq || null
      const directUser = cleanRawQqId(kv.qq || kv.user_id || kv.sender_id || kv.uid || null)
      const replyToUserId = directUser || resolveLookupUserId(lookup, replyToMessageId)
      return {
        replyToMessageId: replyToMessageId ? String(replyToMessageId) : null,
        replyToUserId: replyToUserId || null,
      }
    }
  }

  return { replyToMessageId: null, replyToUserId: null }
}

/**
 * Format a speaker's display + canonical identity tag:
 * - `${nickname}(qq:${userId})` when both name and userId exist
 * - `qq:${userId}` when only userId exists
 * - `${nickname}` when only name exists
 * - `'未知'` when neither exists
 */
export function formatIdentityTag({ userId, nickname, userName } = {}) {
  const uid = cleanRawQqId(userId)
  const rawName = String(nickname || userName || '').trim()

  if (uid && rawName) {
    const canonicalSuffix = `(qq:${uid})`
    if (rawName.endsWith(canonicalSuffix)) return rawName
    if (rawName === uid || rawName.toLowerCase() === `qq:${uid.toLowerCase()}`) {
      return `qq:${uid}`
    }
    return `${rawName}${canonicalSuffix}`
  }
  if (uid) return `qq:${uid}`
  if (rawName) return rawName
  return '未知'
}

export function formatReplyPrefix({ replyToMessageId, replyToUserId } = {}) {
  const msgId =
    replyToMessageId === null || replyToMessageId === undefined
      ? ''
      : String(replyToMessageId).trim()
  if (!msgId) return ''
  const replyUid = cleanRawQqId(replyToUserId)
  return replyUid ? `[回复#${msgId}(qq:${replyUid})] ` : `[回复#${msgId}] `
}

/**
 * Render an enriched inbound QQ chat line preserving `qq:<userId>` and `[回复#...]` metadata.
 */
export function formatInboundLine({
  groupId,
  groupName,
  userId,
  nickname,
  userName,
  text,
  replyToMessageId,
  replyToUserId,
} = {}) {
  const cleanGroupId = groupId === null || groupId === undefined ? '' : String(groupId).trim()
  const cleanGroupName = groupName === null || groupName === undefined ? '' : String(groupName).trim()
  const where = cleanGroupId ? cleanGroupName || `群 ${cleanGroupId}` : '私聊'
  const who = formatIdentityTag({ userId, nickname, userName })
  const replyPrefix = formatReplyPrefix({ replyToMessageId, replyToUserId })
  const body = String(text ?? '')
  return `[QQ · ${where}] ${who}：${replyPrefix}${body}`
}

/**
 * Render a buffered digest line preserving `qq:<userId>` and `[回复#...]` metadata.
 */
export function formatDigestLine({
  userId,
  nickname,
  userName,
  groupName,
  text,
  replyToMessageId,
  replyToUserId,
} = {}) {
  const who = formatIdentityTag({ userId, nickname, userName })
  const cleanGroupName = groupName === null || groupName === undefined ? '' : String(groupName).trim()
  const replyPrefix = formatReplyPrefix({ replyToMessageId, replyToUserId })
  return `${who}${cleanGroupName ? `@${cleanGroupName}` : ''}: ${replyPrefix}${String(text ?? '')}`
}

/**
 * Parse an injected QQ message (potentially preceded by a `[QQ 未唤醒期间聊天记录...]` digest
 * and followed by `（回 QQ ...）` instructions) back into structured L0 metadata.
 */
export function parseInboundLine(rawText) {
  const full = String(rawText ?? '')
  if (!full.trim()) return null

  const lines = full.split(/\r?\n/)
  const headerIdx = lines.findIndex(line => line.startsWith('[QQ · '))
  if (headerIdx < 0) return null

  const bodyLines = [lines[headerIdx]]
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^（回 QQ[： ]/.test(line) || /^（有 \d+ 张图片没能取到/.test(line)) break
    bodyLines.push(line)
  }
  const combined = bodyLines.join('\n')
  const envMatch = combined.match(/^\[QQ · ([^\]]+)\]\s+(.+?)：([\s\S]*)$/)
  if (!envMatch) return null

  const [, where, rawWho, rawRest] = envMatch
  const isPrivate = where === '私聊'
  const groupMatch = where.match(/^群\s+(\S+)$/)
  const groupId = isPrivate ? null : groupMatch ? groupMatch[1] : null

  let userId = null
  let nickname = rawWho.trim()
  const idMatch = nickname.match(/^(.*)\(qq:([^)\s]+)\)$/)
  if (idMatch) {
    nickname = idMatch[1].trim() || null
    userId = idMatch[2].trim()
  } else if (/^qq:(\S+)$/i.test(nickname)) {
    userId = nickname.slice(3).trim()
    nickname = null
  }

  let text = rawRest
  let replyToMessageId = null
  let replyToUserId = null
  const replyMatch = text.match(/^\[回复#([^\](\s]+)(?:\(qq:([^)\s]+)\))?\]\s*/)
  if (replyMatch) {
    replyToMessageId = replyMatch[1] || null
    replyToUserId = replyMatch[2] || null
    text = text.slice(replyMatch[0].length)
  }

  return {
    isQqInbound: true,
    isPrivate,
    where,
    groupId,
    userId,
    speakerId: userId ? normalizeParticipantId(userId) : null,
    nickname,
    replyToMessageId,
    replyToUserId,
    text: text.trim(),
  }
}

/**
 * Extract structured speaker lines from a preceding `[QQ 未唤醒期间聊天记录...]` or `[近期...]` digest block.
 */
export function parseDigestLines(rawText) {
  const full = String(rawText ?? '')
  if (!full.trim()) return []
  const lines = full.split(/\r?\n/)
  const headerIdx = lines.findIndex(line => line.startsWith('[QQ · '))
  const candidateLines = headerIdx > 0 ? lines.slice(0, headerIdx) : []
  const items = []
  for (const rawLine of candidateLines) {
    const trimmed = rawLine.trim().replace(/^\[|\]$/g, '')
    if (!trimmed || trimmed.startsWith('QQ 未唤醒') || trimmed.startsWith('近期')) continue
    const match = trimmed.match(
      /^((?:qq:[^@\s:：]+|[^:：@()]+|\([^)]*\))+?)(?:@([^:：]+))?(?::\s+|：\s*)([\s\S]+)$/i,
    )
    if (!match) continue
    const [, rawWho, , rawRest] = match
    let userId = null
    let nickname = rawWho.trim()
    const idMatch = nickname.match(/^(.*)\(qq:([^)\s]+)\)$/)
    if (idMatch) {
      nickname = idMatch[1].trim() || null
      userId = idMatch[2].trim()
    } else if (/^qq:(\S+)$/i.test(nickname)) {
      userId = nickname.slice(3).trim()
      nickname = null
    }
    if (!userId && !nickname) continue
    let text = rawRest.trim()
    let replyToMessageId = null
    let replyToUserId = null
    const replyMatch = text.match(/^\[回复#([^\](\s]+)(?:\(qq:([^)\s]+)\))?\]\s*/)
    if (replyMatch) {
      replyToMessageId = replyMatch[1] || null
      replyToUserId = replyMatch[2] || null
      text = text.slice(replyMatch[0].length).trim()
    }
    if (!text) continue
    items.push({
      userId,
      speakerId: userId ? normalizeParticipantId(userId) : null,
      nickname,
      replyToMessageId,
      replyToUserId,
      text,
    })
  }
  return items
}
