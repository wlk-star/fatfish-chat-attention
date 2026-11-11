/**
 * L4/L5 Rewind Synchronization Connector (`dsh-rewind-plugin@0.21.2`).
 *
 * Critical DSH v0.2.2-rc.1 invariant:
 * - ONLY treat a `session/event` as a user rewind when
 *   `event?.type === 'user/message' && event?.data?.source?.kind === 'dsh-rewind'`.
 * - NEVER trigger on `SystemPromptProjection` or `ToolResultPruner` `replace` surface ops!
 */

function unwrapEvent(eventOrWrapper) {
  if (!eventOrWrapper || typeof eventOrWrapper !== 'object') return null
  if (typeof eventOrWrapper.type === 'string') return eventOrWrapper
  if (eventOrWrapper.event && typeof eventOrWrapper.event === 'object') return eventOrWrapper.event
  return null
}

function resolveSessionId(subject, event) {
  if (typeof subject === 'string' && subject.trim()) return subject.trim()
  if (subject && typeof subject === 'object') {
    if (typeof subject.sessionId === 'string' && subject.sessionId.trim()) return subject.sessionId.trim()
    if (typeof subject.id === 'string' && subject.id.trim()) return subject.id.trim()
    if (subject.session && typeof subject.session === 'object') {
      if (typeof subject.session.id === 'string' && subject.session.id.trim()) return subject.session.id.trim()
    }
  }
  if (event && typeof event === 'object') {
    if (typeof event.sessionId === 'string' && event.sessionId.trim()) return event.sessionId.trim()
    if (typeof event.data?.sessionId === 'string' && event.data.sessionId.trim()) return event.data.sessionId.trim()
  }
  return ''
}

export function isRewindEvent(event) {
  const ev = unwrapEvent(event)
  if (!ev || ev.type !== 'user/message') return false
  const source = ev.data?.source ?? ev.data?.message?.source
  return source?.kind === 'dsh-rewind'
}

export function extractRewindSeqs(event) {
  const ev = unwrapEvent(event)
  if (!isRewindEvent(ev)) return []
  const rawSeqs = Array.isArray(ev.sourceEventSeqs)
    ? ev.sourceEventSeqs
    : Array.isArray(ev.data?.sourceEventSeqs)
      ? ev.data.sourceEventSeqs
      : []

  const seen = new Set()
  const seqs = []
  for (const item of rawSeqs) {
    const num = Number(item)
    if (Number.isInteger(num) && num >= 0 && !seen.has(num)) {
      seen.add(num)
      seqs.push(num)
    }
  }
  seqs.sort((a, b) => a - b)
  return seqs
}

export function attachRewindConnector({ ctx, store, engine } = {}) {
  function handleSessionEvent(arg1, arg2) {
    // Support both DSH host `(session, event)` 2-arg emission and 1-arg `(event)` / `({ sessionId, event })`.
    const event = arg2 !== undefined ? unwrapEvent(arg2) : unwrapEvent(arg1)
    if (!isRewindEvent(event)) return null

    const sessionId = arg2 !== undefined
      ? resolveSessionId(arg1, event)
      : resolveSessionId(arg1, event)
    const seqs = extractRewindSeqs(event)
    if (!sessionId || seqs.length === 0) {
      return { sessionId, seqs, invalidatedEpisodeIds: [] }
    }

    const invalidatedEpisodeIds = store?.invalidateBySeqs?.(sessionId, seqs) ?? []
    engine?.invalidateBySeqs?.(sessionId, seqs)

    return {
      sessionId,
      seqs,
      invalidatedEpisodeIds: Array.isArray(invalidatedEpisodeIds) ? invalidatedEpisodeIds : [],
    }
  }

  const rawDispose =
    typeof ctx?.on === 'function'
      ? ctx.on('session/event', handleSessionEvent, { global: true })
      : null

  return {
    handleSessionEvent,
    dispose() {
      if (typeof rawDispose === 'function') rawDispose()
    },
  }
}
