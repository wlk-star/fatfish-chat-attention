const defaults = {
  groupId: '',
  nicknames: ['蓝蓝', '大肥鱼'],
  windowMs: 8 * 60_000,
  maxWindowMs: 30 * 60_000,
  quietMs: 8_000,
  maxBatchMs: 25_000,
  cooldownMs: 60_000,
  maxAutoReplies: 3,
  unrelatedLimit: 2,
  historyLimit: 8,
  ignoredUserIds: [],
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
const compact = value => clean(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const PURE_MEDIA_RE = /^(?:\[(?:图片|语音|视频|动画表情|表情\d*)\]\s*)+$/u

function called(text, names) {
  const value = compact(text)
  return (names || []).some(name => {
    const n = compact(name)
    return n && value.includes(n)
  })
}

export function usable(text) {
  const value = clean(text)
  return !!value && !PURE_MEDIA_RE.test(value)
}

function trimHistory(items, topicAnchor, limit) {
  const max = Math.max(1, Number(limit) || 8)
  if (!items.length) return topicAnchor ? [topicAnchor] : []
  if (!topicAnchor) return items.slice(-max)
  const rest = items[0] === topicAnchor
    ? items.slice(1)
    : items.filter((item, idx) => !(idx === 0 && item.who === topicAnchor.who && item.text === topicAnchor.text))
  if (max === 1) return [topicAnchor]
  return [topicAnchor, ...rest.slice(-(max - 1))]
}

export function parseDecision(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let x
  try {
    x = JSON.parse(raw)
  } catch {
    return null
  }
  if (!x || typeof x !== 'object' || typeof x.related !== 'boolean' || typeof x.reply !== 'boolean' || typeof x.end !== 'boolean') {
    return null
  }
  return { related: x.related, reply: x.reply, end: x.end }
}

/** Pure scheduling and policy engine; all I/O and timers are injected for testing. */
export function createAttentionEngine(options = {}) {
  const o = { ...defaults, ...options }
  const now = o.now ?? Date.now
  const later = o.setTimeout ?? setTimeout
  const clear = o.clearTimeout ?? clearTimeout
  if (!o.groupId || typeof o.classify !== 'function' || typeof o.requestWake !== 'function') {
    throw Error('groupId, classify and requestWake are required')
  }

  let state = {
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
  }
  let timer = null
  let wakeTimer = null
  let pendingWake = null
  let running = false
  let closed = false
  let lastClassifyAt = 0
  const ignored = new Set((o.ignoredUserIds || []).map(String))
  const seen = new Set()
  const seenOrder = []

  function snapshot() {
    const { history, batch, topicAnchor, ...safe } = state
    return { ...safe, pending: batch.length }
  }

  function publish() {
    o.onState?.(snapshot())
  }

  function cancelTimer() {
    if (timer !== null) {
      clear(timer)
      timer = null
    }
  }

  function cancelWakeTimer() {
    if (wakeTimer !== null) {
      clear(wakeTimer)
      wakeTimer = null
    }
    pendingWake = null
  }

  function stop(reason) {
    cancelTimer()
    cancelWakeTimer()
    state = {
      ...state,
      active: false,
      generation: state.generation + 1,
      activeUntil: 0,
      topicAnchor: null,
      history: [],
      batch: [],
      batchStartedAt: 0,
      version: state.version + 1,
    }
    o.onEvent?.({ type: 'stopped', reason })
    publish()
  }

  function rememberId(id) {
    if (!id) return false
    if (seen.has(id)) return false
    seen.add(id)
    seenOrder.push(id)
    while (seenOrder.length > 256) seen.delete(seenOrder.shift())
    return true
  }

  function start(message) {
    const t = now()
    cancelTimer()
    cancelWakeTimer()
    const anchor = {
      who: clean(message.nickname || message.userId),
      text: clean(message.text),
    }
    state = {
      active: true,
      generation: state.generation + 1,
      openedAt: t,
      activeUntil: t + o.windowMs,
      lastWakeAt: t,
      unrelated: 0,
      autoReplies: 0,
      topicAnchor: anchor,
      history: [anchor],
      batch: [],
      batchStartedAt: 0,
      version: state.version + 1,
    }
    o.onEvent?.({ type: 'started' })
    publish()
  }

  function scheduleDeferredWake(candidate, delayMs) {
    cancelWakeTimer()
    const generation = state.generation
    const version = state.version
    pendingWake = candidate
    wakeTimer = later(async () => {
      wakeTimer = null
      const target = pendingWake
      pendingWake = null
      if (closed || !target || !state.active || state.generation !== generation || state.version !== version) return
      const t = now()
      if (t > state.activeUntil || t - state.openedAt >= o.maxWindowMs) {
        stop('timeout')
        return
      }
      if (state.autoReplies >= o.maxAutoReplies || t - state.lastWakeAt < o.cooldownMs) return
      state.lastWakeAt = t
      state.autoReplies++
      publish()
      try {
        await o.requestWake({ candidateToken: target.token })
      } catch (error) {
        o.onEvent?.({ type: 'wake-error', error: String(error?.message ?? error).slice(0, 200) })
      }
    }, Math.max(0, delayMs))
    wakeTimer?.unref?.()
  }

  function schedule() {
    if (closed || running || !state.active || !state.batch.length) return
    cancelTimer()
    const elapsed = now() - state.batchStartedAt
    const quietDelay = Math.max(0, Math.min(o.quietMs, o.maxBatchMs - elapsed))
    const rateDelay = Math.max(0, lastClassifyAt + (o.classifyIntervalMs ?? 20_000) - now())
    const delay = Math.max(quietDelay, rateDelay)
    timer = later(() => {
      timer = null
      void evaluate()
    }, delay)
    timer?.unref?.()
  }

  function commitBatchToHistory(baseHistory, batchItems, baseLen) {
    const addedDuring = state.history.slice(baseLen)
    const mapped = batchItems.map(({ who, text }) => ({ who, text }))
    state.history = trimHistory([...baseHistory, ...mapped, ...addedDuring], state.topicAnchor, o.historyLimit)
  }

  async function evaluate() {
    if (closed || running || !state.active || !state.batch.length) return
    const t = now()
    if (t > state.activeUntil || t - state.openedAt >= o.maxWindowMs) {
      stop('timeout')
      return
    }
    running = true
    lastClassifyAt = t
    const generation = state.generation
    const version = state.version
    const batch = state.batch.slice()
    const history = state.history.slice()
    const historyBaseLen = state.history.length
    state.batch = []
    state.batchStartedAt = 0
    publish()

    let verdict = null
    try {
      verdict = await o.classify({
        history,
        batch,
        groupId: o.groupId,
        topicAnchor: state.topicAnchor,
      })
    } catch (error) {
      if (!closed && state.active && state.generation === generation) {
        commitBatchToHistory(history, batch, historyBaseLen)
      }
      o.onEvent?.({ type: 'classifier-error', error: String(error?.message ?? error).slice(0, 200) })
      running = false
      if (!closed) {
        publish()
        schedule()
      }
      return
    }

    running = false
    if (closed) return
    if (!state.active || state.generation !== generation) {
      schedule()
      return
    }
    // A newer user message supersedes the candidate: fold it into the next batch rather than send a stale reply.
    if (state.version !== version) {
      const combined = [...batch, ...state.batch]
      if (combined.length > o.historyLimit) {
        const overflow = combined.slice(0, combined.length - o.historyLimit)
        commitBatchToHistory(history, overflow, historyBaseLen)
        state.batch = combined.slice(-o.historyLimit)
      } else {
        state.batch = combined
      }
      if (!state.batchStartedAt) state.batchStartedAt = now()
      schedule()
      return
    }

    commitBatchToHistory(history, batch, historyBaseLen)

    if (now() > state.activeUntil || now() - state.openedAt >= o.maxWindowMs) {
      stop('timeout')
      return
    }
    if (!verdict || typeof verdict.related !== 'boolean' || typeof verdict.reply !== 'boolean' || typeof verdict.end !== 'boolean') {
      o.onEvent?.({ type: 'classifier-invalid' })
      publish()
      schedule()
      return
    }
    if (verdict.end) {
      stop('topic-ended')
      return
    }
    if (!verdict.related) {
      state.unrelated++
      if (state.unrelated >= o.unrelatedLimit) {
        stop('unrelated')
        return
      }
      publish()
      schedule()
      return
    }

    state.unrelated = 0
    state.activeUntil = Math.min(now() + o.windowMs, state.openedAt + o.maxWindowMs)
    const candidate = [...batch].reverse().find(item => item.token)
    if (verdict.reply && candidate && state.autoReplies < o.maxAutoReplies) {
      const elapsedSinceWake = now() - state.lastWakeAt
      if (elapsedSinceWake >= o.cooldownMs) {
        state.lastWakeAt = now()
        state.autoReplies++
        publish()
        try {
          await o.requestWake({ candidateToken: candidate.token })
        } catch (error) {
          o.onEvent?.({ type: 'wake-error', error: String(error?.message ?? error).slice(0, 200) })
        }
      } else if (state.autoReplies > 0) {
        o.onEvent?.({ type: 'cooldown-deferred' })
        publish()
        scheduleDeferredWake(candidate, o.cooldownMs - elapsedSinceWake)
      } else {
        publish()
      }
    } else {
      publish()
    }
    schedule()
  }

  function onEvent(event) {
    if (closed || event?.transport !== true) return
    const m = event.message
    const decision = event.decision ?? {}
    const id = String(m?.groupId ?? '')
    if (!m || id !== String(o.groupId) || ignored.has(String(m.userId ?? '')) || decision.reason === 'attention') return
    const text = clean(m.text)
    const named = m.atSelf === true || called(text, o.nicknames)
    if (named && decision.action === 'wake') {
      if (m.messageId && !rememberId(String(m.messageId))) return
      start(m)
      return
    }
    if (decision.action !== 'record' || !state.active) return
    const t = now()
    if (t > state.activeUntil || t - state.openedAt >= o.maxWindowMs) {
      stop('timeout')
      return
    }
    if (!usable(text) || !event.candidateToken || !m.messageId || !rememberId(String(m.messageId))) return

    cancelWakeTimer()
    const item = {
      who: clean(m.nickname || m.userId),
      text,
      token: String(event.candidateToken),
    }
    if (!state.batch.length) state.batchStartedAt = t
    state.batch.push(item)
    if (state.batch.length > o.historyLimit) {
      const evicted = state.batch.shift()
      state.history = trimHistory([...state.history, { who: evicted.who, text: evicted.text }], state.topicAnchor, o.historyLimit)
    }
    state.version++
    publish()
    schedule()
  }

  function onReply(event) {
    if (closed || !state.active || String(event?.groupId ?? '') !== String(o.groupId)) return
    const text = clean(event?.text)
    if (!text) return
    const selfName = clean(o.nicknames?.[0]) || '蓝蓝'
    state.history = trimHistory([...state.history, { who: selfName, text }], state.topicAnchor, o.historyLimit)
    publish()
  }

  return {
    onEvent,
    onReply,
    snapshot,
    stop,
    dispose() {
      closed = true
      cancelTimer()
      cancelWakeTimer()
      state.history = []
      state.batch = []
    },
  }
}
