import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MOOD_DIM_KEYS = Object.freeze([
  'happy',
  'calm',
  'sweet',
  'heartache',
  'worry',
  'sad',
  'jealous',
])

/**
 * Normalize a DSH session ID into the slot matching key used by `dsh-feiyu-mood` (`会话键`).
 * Strips a leading `'session-'` prefix while keeping non-prefixed IDs intact.
 */
export function normalizeMoodSessionKey(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (!raw) return ''
  return raw.startsWith('session-') ? raw.slice('session-'.length) : raw
}

function roundScore(value, fallback = 70) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.round(num * 100) / 100
}

function sanitizeDims(rawDims) {
  const out = {}
  for (const key of MOOD_DIM_KEYS) {
    const val = Number(rawDims?.[key] ?? 0)
    out[key] = Number.isFinite(val) && val > 0 ? Math.round(val * 10000) / 10000 : 0
  }
  return out
}

export function describeMoodLabel(mood, dims = {}, moodBase = 70) {
  const score = roundScore(mood, moodBase)
  const d = sanitizeDims(dims)
  if (d.heartache >= 1.5 || (d.heartache >= 0.3 && d.heartache >= d.happy)) return '心疼牵挂'
  if (d.worry >= 1.5 || (d.worry >= 0.3 && d.worry >= d.happy)) return '有些担心'
  if (score < moodBase - 8 || d.sad >= 1.5 || d.sad >= 0.5) return '有点低落'
  if (d.sweet >= 2 || (d.sweet >= 0.4 && score >= moodBase)) return '温柔甜蜜'
  if (score >= moodBase + 8 || d.happy >= 2) return '心情明朗'
  if (d.calm >= 2 || score >= moodBase - 3) return '平和放松'
  return '安静微澜'
}

function safeReadJson(readFile, filePath) {
  try {
    const text = readFile(filePath, 'utf8')
    if (typeof text !== 'string' || !text.trim()) return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function resolveSlotForSession(config, sessionId) {
  const targetKey = normalizeMoodSessionKey(sessionId)
  if (!targetKey || !config || typeof config !== 'object') return null

  const mode = config['模式'] ?? config.mode ?? 'session'
  if (mode !== 'session') return null

  const slots = Array.isArray(config.slots) && config.slots.length > 0
    ? config.slots
    : config.targetSession
      ? [{ id: 'default', sessions: [config.targetSession] }]
      : []

  for (const slot of slots) {
    if (!slot || typeof slot !== 'object') continue
    const candidates = [
      ...(Array.isArray(slot.sessions) ? slot.sessions : []),
      ...(typeof slot.session === 'string' ? [slot.session] : []),
    ]
    for (const candidate of candidates) {
      if (normalizeMoodSessionKey(candidate) === targetKey) {
        const slotId = String(slot.id || targetKey || 'default').trim()
        return { slotId, slot }
      }
    }
  }

  if (typeof config.targetSession === 'string' && normalizeMoodSessionKey(config.targetSession) === targetKey) {
    return { slotId: targetKey, slot: { id: targetKey, sessions: [config.targetSession] } }
  }

  return null
}

function pickPrimaryOwnerMoodEntry(config, state) {
  const moods = state?.moods
  if (!moods || typeof moods !== 'object') return null

  const candidateSlotIds = []
  if (config && typeof config === 'object') {
    if (typeof config.targetSession === 'string' && config.targetSession.trim()) {
      const matched = resolveSlotForSession(config, config.targetSession)
      if (matched?.slotId) candidateSlotIds.push(matched.slotId)
      candidateSlotIds.push(normalizeMoodSessionKey(config.targetSession))
    }
    if (Array.isArray(config.slots)) {
      for (const slot of config.slots) {
        if (typeof slot?.id === 'string' && slot.id.trim()) candidateSlotIds.push(slot.id.trim())
      }
    }
  }
  candidateSlotIds.push(...Object.keys(moods))

  for (const id of candidateSlotIds) {
    const entry = moods[id]
    if (entry && typeof entry === 'object' && Number.isFinite(Number(entry.mood))) {
      return { slotId: id, entry }
    }
  }
  return null
}

/**
 * L4 Optional Connector for `dsh-feiyu-mood@0.9.2`.
 * - Private companion archival (`private:*`) extracts full mood slices including timeline reasons.
 * - Group demeanor projection (`projectGroupAffectTone`) converts ONLY numeric scores into fixed
 *   demeanor hints and syncs `store.setCareBias`, strictly stripping `lastReason` & `timeline[].reason`.
 */
export function createMoodConnector({
  dshHome,
  store,
  readFile = readFileSync,
  now = Date.now,
} = {}) {
  const baseHome = String(dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const configPath = join(baseHome, 'feiyu-mood', 'config.json')
  const statePath = join(baseHome, 'feiyu-mood', 'state.json')

  function extractMoodSlice({ sessionId, scope, startMs, endMs } = {}) {
    if (scope !== undefined && scope !== null && !String(scope).startsWith('private:')) {
      return null
    }
    const sid = String(sessionId ?? '').trim()
    if (!sid || sid.startsWith('group:')) return null

    const config = safeReadJson(readFile, configPath)
    const state = safeReadJson(readFile, statePath)
    if (!config || !state?.moods || typeof state.moods !== 'object') return null

    const matched = resolveSlotForSession(config, sid)
    if (!matched) return null

    const sessionKey = normalizeMoodSessionKey(sid)
    const moodEntry =
      state.moods[matched.slotId] ??
      state.moods[sessionKey] ??
      state.moods[sid]
    if (!moodEntry || typeof moodEntry !== 'object') return null

    const moodBase = roundScore(config.moodBase, 70)
    const hasStart = Number.isFinite(startMs)
    const hasEnd = Number.isFinite(endMs)
    const rawTimeline = Array.isArray(moodEntry.timeline) ? moodEntry.timeline : []

    const inWindow = rawTimeline
      .filter((item) => {
        if (!item || typeof item !== 'object') return false
        const at = Number(item.at)
        if (!Number.isFinite(at)) return false
        if (hasStart && at < startMs) return false
        if (hasEnd && at > endMs) return false
        return true
      })
      .sort((a, b) => Number(a.at) - Number(b.at))

    if (inWindow.length > 0) {
      const first = inWindow[0]
      const last = inWindow[inWindow.length - 1]
      const firstMood = roundScore(first.mood, roundScore(moodEntry.mood, moodBase))
      const firstDelta = Number(first.delta)
      const startMood = Number.isFinite(firstDelta)
        ? roundScore(firstMood - firstDelta, firstMood)
        : firstMood
      const endMood = roundScore(last.mood, roundScore(moodEntry.mood, moodBase))
      const dims = sanitizeDims(last.dims ?? moodEntry.dims)
      const reasons = []
      const seenReasons = new Set()
      for (const item of inWindow) {
        const reason = String(item.reason ?? '').trim()
        if (reason && !seenReasons.has(reason)) {
          seenReasons.add(reason)
          reasons.push(reason)
        }
      }
      return {
        slotId: matched.slotId,
        startMood,
        endMood,
        label: describeMoodLabel(endMood, dims, moodBase),
        dims,
        reasons,
      }
    }

    if (!Number.isFinite(Number(moodEntry.mood))) return null
    const currentMood = roundScore(moodEntry.mood, moodBase)
    const dims = sanitizeDims(moodEntry.dims)
    const fallbackReasons =
      !hasStart && !hasEnd && typeof moodEntry.lastReason === 'string' && moodEntry.lastReason.trim()
        ? [moodEntry.lastReason.trim()]
        : []

    return {
      slotId: matched.slotId,
      startMood: currentMood,
      endMood: currentMood,
      label: describeMoodLabel(currentMood, dims, moodBase),
      dims,
      reasons: fallbackReasons,
    }
  }

  function projectGroupAffectTone({
    ownerId = 'qq:1024162823',
    careTtlMs = 4 * 60 * 60 * 1000,
    nowMs,
  } = {}) {
    const config = safeReadJson(readFile, configPath)
    const state = safeReadJson(readFile, statePath)
    const picked = pickPrimaryOwnerMoodEntry(config, state)
    if (!picked) return ''

    // Strictly read numeric fields ONLY — never inspect `lastReason`, `lastInjectedText`, or `timeline[].reason`.
    const moodBase = roundScore(config?.moodBase, 70)
    const mood = Math.max(0, Math.min(100, roundScore(picked.entry.mood, moodBase)))
    const dims = sanitizeDims(picked.entry.dims)

    const publicOwner = store?.getParticipant?.(ownerId, { viewerScope: 'public_roster' })
    const safeOwnerCall =
      typeof publicOwner?.preferredCall === 'string' && publicOwner.preferredCall.trim()
        ? publicOwner.preferredCall.trim()
        : '爸爸'

    const highCareOrWorry = dims.heartache >= 0.3 || dims.worry >= 0.3
    const moodDropped = mood < moodBase - 4 || dims.sad >= 0.35

    let tone = '心情平和放松'
    if (highCareOrWorry || mood < moodBase - 8) {
      tone = `心里有点牵挂，对${safeOwnerCall}语气格外温和体贴，少开重玩笑`
    } else if (moodDropped) {
      tone = `情绪略微安静柔和，对${safeOwnerCall}语气格外温和体贴，少开重玩笑`
    } else if (mood >= moodBase + 8 || dims.happy >= 2 || dims.sweet >= 2) {
      tone = '心情明朗轻快'
    }

    if ((highCareOrWorry || moodDropped) && ownerId) {
      const currentNow = Number.isFinite(nowMs) ? Number(nowMs) : Number(now())
      const ttl = Number.isFinite(careTtlMs) && careTtlMs > 0 ? Number(careTtlMs) : 4 * 60 * 60 * 1000
      store?.setCareBias?.(ownerId, {
        tone,
        expiresAt: currentNow + ttl,
      })
    }

    return tone
  }

  return {
    configPath,
    statePath,
    extractMoodSlice,
    projectGroupAffectTone,
  }
}
