const INTERNAL_SOURCE_KINDS = new Set([
  'speak-up',
  'runtime-context',
  'system-reminder',
  'compact-checkpoint',
  'agent-notification',
  'slash-command',
  'dsh-rewind',
  'system-prompt',
  'tool',
])

const BRIDGE_ALERT_PREFIXES = [
  '[QQ 桥告警',
  '[QQ群桥告警',
  '[群桥告警',
  '[QQ 出站被拒',
  '[QQ 发送失败',
  '[QQ-Bridge Alert',
  '[bridge-alert]',
  '[系统告警]',
  '<system-reminder>',
  '<speak-up',
]

function extractMessageText(messageOrEvent) {
  if (!messageOrEvent || typeof messageOrEvent !== 'object') return ''
  const target =
    messageOrEvent.message ??
    messageOrEvent.data?.message ??
    messageOrEvent.data ??
    messageOrEvent
  if (typeof target.text === 'string') return target.text
  if (typeof target.content === 'string') return target.content
  if (Array.isArray(target.content)) {
    return target.content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text ?? '') : ''))
      .join('')
  }
  return ''
}

function extractSourceObject(messageOrEvent) {
  if (!messageOrEvent || typeof messageOrEvent !== 'object') return null
  if (typeof messageOrEvent.sourceKind === 'string') {
    return { kind: messageOrEvent.sourceKind }
  }
  return (
    messageOrEvent.source ??
    messageOrEvent.message?.source ??
    messageOrEvent.data?.message?.source ??
    messageOrEvent.data?.source ??
    null
  )
}

/**
 * Returns `true` when an inbound/claimed turn or session event is an internal system trigger
 * (`dsh-speak-up`, `RuntimeContextProjection`, `dsh-rewind`, harness reminders, or bridge alerts)
 * rather than a genuine human chat turn.
 */
export function isInternalTriggerMessage(messageOrEvent) {
  if (!messageOrEvent || typeof messageOrEvent !== 'object') return false
  if (messageOrEvent.isInternal === true || messageOrEvent.bridgeAlert === true) return true

  const source = extractSourceObject(messageOrEvent)
  const kind = typeof source?.kind === 'string' ? source.kind.trim() : ''
  const plugin = typeof source?.plugin === 'string' ? source.plugin.trim() : ''

  if (kind && INTERNAL_SOURCE_KINDS.has(kind)) return true
  if (kind === 'plugin:dsh-speak-up' || plugin === 'dsh-speak-up') return true
  if (kind.startsWith('plugin:@deepseek-ai/')) return true
  if (kind === 'plugin' && plugin.startsWith('@deepseek-ai/')) return true
  if (
    source?.internal === true ||
    source?.bridgeAlert === true ||
    source?.alert === true ||
    source?.subkind === 'alert' ||
    source?.tag === 'bridge-alert'
  ) {
    return true
  }

  const text = extractMessageText(messageOrEvent).trim()
  if (text) {
    for (const prefix of BRIDGE_ALERT_PREFIXES) {
      if (text.startsWith(prefix)) return true
    }
  }

  return false
}

function canScopeAccessLocal(viewerScope, recordScope) {
  const viewer = String(viewerScope ?? '').trim()
  const record = String(recordScope ?? '').trim()
  if (!viewer || !record) return false
  if (viewer.startsWith('group:')) {
    return record === 'public_roster' || record === viewer
  }
  if (viewer.startsWith('private:')) {
    return record === viewer || record === 'public_roster' || record.startsWith('group:')
  }
  return false
}

function collectParticipantsFromTopic(topic) {
  const seen = new Set()
  const out = []
  const add = (id) => {
    const clean = String(id ?? '').trim()
    if (clean && !seen.has(clean)) {
      seen.add(clean)
      out.push(clean)
    }
  }
  if (Array.isArray(topic?.participantIds)) {
    for (const id of topic.participantIds) add(id)
  }
  if (topic?.initiatorId) add(topic.initiatorId)
  if (topic?.cohort && typeof topic.cohort === 'object') {
    for (const id of Object.keys(topic.cohort)) add(id)
  }
  return out
}

function summarizeTopicForEpisode(topic) {
  const title = String(topic?.title || '未完日常话题').trim()
  if (typeof topic?.summary === 'string' && topic.summary.trim()) {
    return topic.summary.trim()
  }
  const cohort = topic?.cohort && typeof topic.cohort === 'object' ? topic.cohort : {}
  const stances = []
  for (const [pid, member] of Object.entries(cohort)) {
    const label = String(member?.nickname || pid).trim()
    const stance = String(member?.latestStance || member?.stanceSummary || '').trim()
    if (stance) stances.push(`${label}：${stance}`)
  }
  return stances.length > 0 ? `${title}。${stances.join('；')}` : title
}

function extractWarmTopicsFromStage(stage) {
  if (!stage || typeof stage !== 'object') return []
  const list = []
  if (Array.isArray(stage.warmTopics)) {
    list.push(...stage.warmTopics)
  } else if (Array.isArray(stage.warm)) {
    list.push(...stage.warm)
  } else if (stage.warm && typeof stage.warm === 'object') {
    list.push(...Object.values(stage.warm))
  }
  if (Array.isArray(stage.topics)) {
    for (const t of stage.topics) {
      if (t?.status === 'warm') list.push(t)
    }
  }
  // Include focused topic if it has pending open threads or stances and isn't duplicated
  const focused = stage.focusedTopic ?? stage.focused
  if (focused && typeof focused === 'object' && (focused.topicId || focused.id)) {
    list.push(focused)
  }
  const seen = new Set()
  return list.filter((t) => {
    const id = String(t?.topicId ?? t?.id ?? '').trim()
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * L5 Autonomy & Sleep Consolidation Connector (`dsh-speak-up@0.3.1` interop).
 */
export function createSpeakupConnector({
  store,
  engine,
  ownerId = 'qq:1024162823',
  now = Date.now,
} = {}) {
  async function runIdleConsolidation({ nowMs, moodConnector } = {}) {
    const currentNow = Number.isFinite(nowMs) ? Number(nowMs) : Number(now())
    const rawArchived =
      (await engine?.archiveWarmTopics?.({ nowMs: currentNow, moodConnector })) ?? []
    const archivedTopics = Array.isArray(rawArchived) ? [...rawArchived] : []

    // Also consolidate any persisted warm topics in `store` whose `warmUntil` has elapsed
    const seenTopicIds = new Set(
      archivedTopics.map((t) => String(t?.topicId ?? t?.id ?? '')).filter(Boolean),
    )
    const adminViewerScope = `private:${ownerId}`
    const storedCandidates =
      store?.listTopics?.({
        statuses: ['warm'],
        viewerScope: adminViewerScope,
        limit: 50,
      }) ?? []
    if (Array.isArray(storedCandidates)) {
      for (const t of storedCandidates) {
        const tid = String(t?.topicId ?? t?.id ?? '')
        if (!tid || seenTopicIds.has(tid)) continue
        if (Number.isFinite(Number(t.warmUntil)) && Number(t.warmUntil) <= currentNow) {
          seenTopicIds.add(tid)
          archivedTopics.push(t)
        }
      }
    }

    const episodes = []
    for (const topic of archivedTopics) {
      if (!topic || typeof topic !== 'object') continue
      const topicId = String(topic.topicId ?? topic.id ?? '').trim()
      const scope = String(
        topic.scope || (topic.groupId ? `group:${topic.groupId}` : ''),
      ).trim()
      const sessionId = String(topic.sessionId ?? '').trim()
      if (!topicId || !scope) continue

      const archivedTopic = {
        ...topic,
        topicId,
        sessionId: sessionId || `session-${scope}`,
        scope,
        title: String(topic.title || '日常对话片段').trim(),
        status: 'archived',
      }
      try {
        store?.saveTopic?.(archivedTopic)
      } catch {
        // Optional persistence when topic schema differs in lightweight mocks
      }

      const episodeId = String(
        topic.crystallizedEpisodeId || topic.episodeId || `ep-${topicId}`,
      )
      const existing = store?.getEpisode?.(episodeId, {
        viewerScope: scope,
        excludeInvalidated: true,
      })
      if (existing) {
        episodes.push(existing)
        continue
      }

      const participantIds = collectParticipantsFromTopic(topic)
      const rawStartSeq = Array.isArray(topic.seqRange)
        ? topic.seqRange[0]
        : (topic.seqRange?.startSeq ?? topic.startSeq)
      const rawEndSeq = Array.isArray(topic.seqRange)
        ? topic.seqRange[1]
        : (topic.seqRange?.endSeq ?? topic.endSeq)
      const startSeq = Number.isFinite(Number(rawStartSeq)) ? Number(rawStartSeq) : null
      const endSeq = Number.isFinite(Number(rawEndSeq)) ? Number(rawEndSeq) : null
      const seqRange =
        startSeq !== null && endSeq !== null ? [startSeq, endSeq] : null

      const startMs = Number(topic.startedAt ?? topic.createdAt ?? currentNow - 30 * 60_000)
      const endMs = Number(topic.lastActiveAt ?? topic.updatedAt ?? currentNow)
      const moodSlice =
        scope.startsWith('private:') && typeof moodConnector?.extractMoodSlice === 'function'
          ? moodConnector.extractMoodSlice({
              sessionId,
              scope,
              startMs,
              endMs,
            })
          : null

      const title = String(topic.title || '日常对话片段').trim()
      const summary = summarizeTopicForEpisode(topic)
      const isHighlight =
        scope.startsWith('group:') &&
        (participantIds.length >= 2 ||
          participantIds.includes(ownerId) ||
          participantIds.includes('qq:616860663'))

      const episodeInput = {
        episodeId,
        topicId,
        scope,
        sessionId,
        title,
        indexLine: title,
        summary,
        participantIds,
        ...(startSeq !== null ? { startSeq } : {}),
        ...(endSeq !== null ? { endSeq } : {}),
        ...(seqRange ? { seqRange } : {}),
        ...(moodSlice ? { moodSlice } : {}),
        isHighlight,
        invalidatedByRewind: false,
        createdAt: currentNow,
      }

      const saved = store?.saveEpisode?.(episodeInput) ?? episodeInput
      episodes.push(saved)
    }

    if (typeof moodConnector?.projectGroupAffectTone === 'function') {
      moodConnector.projectGroupAffectTone({ ownerId, nowMs: currentNow })
    }

    return {
      archivedCount: episodes.length,
      episodes,
      topics: archivedTopics,
    }
  }

  function listOpenTopics(
    sessionId,
    { viewerScope, scope, groupId, limit = 5 } = {},
  ) {
    const maxItems = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 5
    const stage = sessionId ? engine?.getStage?.(sessionId) : null
    const resolvedScope = String(
      viewerScope ?? scope ?? stage?.scope ?? '',
    ).trim()
    if (!resolvedScope) return []

    const items = []
    const seenKeys = new Set()

    const pushTopic = (topic, defaultKind = 'warm_topic') => {
      if (!topic || typeof topic !== 'object') return
      const topicScope = String(topic.scope ?? resolvedScope).trim()
      if (!canScopeAccessLocal(resolvedScope, topicScope)) return
      if (resolvedScope.startsWith('private:') && !topicScope.startsWith('private:')) {
        // Group highlights are added below as `group_highlight` with explicit provenance
        return
      }
      const topicId = String(topic.topicId ?? topic.id ?? '').trim()
      if (!topicId || seenKeys.has(`topic:${topicId}`)) return
      seenKeys.add(`topic:${topicId}`)

      const title = String(topic.title || '未完话题').trim()
      const summary = summarizeTopicForEpisode(topic)
      const participantIds = collectParticipantsFromTopic(topic)
      const updatedAt = Number(topic.lastActiveAt ?? topic.updatedAt ?? topic.warmUntil ?? 0) || 0

      items.push({
        kind: topic.status === 'focused' ? 'focused_topic' : defaultKind,
        id: topicId,
        topicId,
        episodeId: null,
        scope: topicScope,
        title,
        summary,
        participantIds,
        updatedAt,
        promptHint: `延续之前没聊完的话题「${title}」：${summary}`,
      })
    }

    for (const stageTopic of extractWarmTopicsFromStage(stage)) {
      if (stageTopic.status === 'archived') continue
      pushTopic(stageTopic, stageTopic.status === 'focused' ? 'focused_topic' : 'warm_topic')
    }

    const storedTopics =
      store?.listTopics?.({
        sessionId,
        scope: resolvedScope,
        statuses: ['warm', 'focused'],
        viewerScope: resolvedScope,
        limit: maxItems,
      }) ?? []
    if (Array.isArray(storedTopics)) {
      for (const topic of storedTopics) {
        pushTopic(topic, 'warm_topic')
      }
    }

    // Owner private chat (`private:qq:1024162823`) is allowed to proactively share recent public group highlights
    if (resolvedScope === `private:${ownerId}` && typeof store?.listRecentGroupHighlights === 'function') {
      const highlights = store.listRecentGroupHighlights({
        ...(groupId ? { groupId } : {}),
        viewerScope: resolvedScope,
        limit: maxItems,
      })
      if (Array.isArray(highlights)) {
        for (const ep of highlights) {
          if (!ep || ep.invalidatedByRewind) continue
          const epScope = String(ep.scope ?? '').trim()
          if (!epScope.startsWith('group:')) continue
          const epId = String(ep.episodeId ?? '').trim()
          if (!epId || seenKeys.has(`ep:${epId}`)) continue
          seenKeys.add(`ep:${epId}`)

          const title = String(ep.indexLine || ep.title || '群里新鲜事').trim()
          const summary = String(ep.summary || title).trim()
          items.push({
            kind: 'group_highlight',
            id: epId,
            topicId: ep.topicId ?? null,
            episodeId: epId,
            scope: epScope,
            title,
            summary,
            participantIds: Array.isArray(ep.participantIds) ? [...ep.participantIds] : [],
            updatedAt: Number(ep.createdAt ?? 0) || 0,
            promptHint: `和爸爸分享群里刚发生的趣事「${title}」：${summary}`,
          })
        }
      }
    }

    // Prioritize warm topics first, then focused unfinished topics, then recent group highlights
    const rank = (kind) => (kind === 'warm_topic' ? 0 : kind === 'focused_topic' ? 1 : 2)
    items.sort((a, b) => {
      const rDiff = rank(a.kind) - rank(b.kind)
      if (rDiff !== 0) return rDiff
      return b.updatedAt - a.updatedAt
    })

    return items.slice(0, maxItems)
  }

  return {
    runIdleConsolidation,
    listOpenTopics,
  }
}
