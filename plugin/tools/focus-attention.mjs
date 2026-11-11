/**
 * `focus_attention` tool — DSH `@deepseek-ai/dsh-tools` `defineTool` compliant with plain-object fallback.
 *
 * All expanded topic details, relational profiles, episode summaries, and shadowed raw quotes
 * are returned strictly via `tool/result` so `@deepseek-ai/dsh-compaction-tool-result-pruner`
 * prunes them cleanly without polluting `RuntimeContextProjection`.
 */

function canScopeAccessLocal(viewerScope, recordScope) {
  const viewer = String(viewerScope ?? '').trim()
  const record = String(recordScope ?? '').trim()
  if (!viewer || !record) return false
  if (record === 'public_roster') return true
  if (viewer.startsWith('group:')) return record === viewer
  if (viewer.startsWith('private:')) return record === viewer || record.startsWith('group:')
  return false
}

function isValidViewerScope(scope) {
  return (
    typeof scope === 'string' &&
    ((scope.startsWith('private:') && scope.length > 'private:'.length) ||
      (scope.startsWith('group:') && scope.length > 'group:'.length))
  )
}

export function extractSessionIdFromExec(exec) {
  if (!exec || typeof exec !== 'object') return ''
  if (typeof exec.sessionId === 'string' && exec.sessionId.trim()) return exec.sessionId.trim()
  const agent = exec.agent ?? exec.caller ?? exec.agentRef
  if (agent && typeof agent === 'object') {
    if (typeof agent.session?.id === 'string' && agent.session.id.trim()) return agent.session.id.trim()
    if (typeof agent.sessionId === 'string' && agent.sessionId.trim()) return agent.sessionId.trim()
    if (typeof agent.id === 'string' && agent.id.trim()) return agent.id.trim()
  }
  return ''
}

function resolveViewerScope(resolveSessionScope, exec, sessionId) {
  if (typeof resolveSessionScope === 'function') {
    const first = resolveSessionScope(exec)
    if (typeof first === 'string' && first.trim()) return first.trim()
    if (sessionId) {
      const second = resolveSessionScope(sessionId)
      if (typeof second === 'string' && second.trim()) return second.trim()
    }
  }
  if (typeof exec?.viewerScope === 'string' && exec.viewerScope.trim()) return exec.viewerScope.trim()
  if (typeof exec?.scope === 'string' && exec.scope.trim()) return exec.scope.trim()
  return ''
}

function compileFallbackSchema(specParameters, specOutputSchema) {
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(specParameters)) {
    const { required: isReq, ...rest } = prop
    properties[key] = { ...rest }
    if (isReq === true) required.push(key)
  }

  const outProperties = {}
  const outRequired = []
  for (const [key, prop] of Object.entries(specOutputSchema.properties ?? {})) {
    const { required: isReq, ...rest } = prop
    outProperties[key] = { ...rest }
    if (isReq === true) outRequired.push(key)
  }

  return {
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    outputSchema: {
      type: 'object',
      additionalProperties: Boolean(specOutputSchema.additionalProperties),
      properties: outProperties,
      ...(outRequired.length > 0 ? { required: outRequired } : {}),
    },
    required,
  }
}

function buildToolWithFallback(defineTool, spec) {
  if (typeof defineTool === 'function') {
    return defineTool(spec)
  }
  const compiled = compileFallbackSchema(spec.parameters, spec.output.schema)
  return {
    name: spec.name,
    description: spec.description,
    parameters: compiled.parameters,
    output: {
      schema: compiled.outputSchema,
      render(args, value) {
        return spec.output.render(args, value)
      },
    },
    async execute(args = {}, exec = {}) {
      const safeArgs = args && typeof args === 'object' ? args : {}
      for (const reqKey of compiled.required) {
        if (safeArgs[reqKey] === undefined || safeArgs[reqKey] === null) {
          throw new Error(`Missing required argument: ${reqKey}`)
        }
      }
      return spec.execute(safeArgs, exec)
    },
  }
}

function findTopicInStage(stage, topicId) {
  if (!stage || typeof stage !== 'object' || !topicId) return null
  const match = (t) => t && (t.topicId === topicId || t.id === topicId)
  if (match(stage.focused)) return stage.focused
  if (match(stage.focusedTopic)) return stage.focusedTopic
  const pools = [stage.warm, stage.warmTopics, stage.topics]
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      const hit = pool.find(match)
      if (hit) return hit
    } else if (pool && typeof pool === 'object') {
      const hit = Object.values(pool).find(match)
      if (hit) return hit
    }
  }
  return null
}

function normalizeSeqRange(episode) {
  if (!episode || typeof episode !== 'object') return null
  const r = episode.seqRange
  if (Array.isArray(r) && r.length >= 2) {
    const lo = Number(r[0])
    const hi = Number(r[1])
    if (Number.isFinite(lo) && Number.isFinite(hi)) return [Math.min(lo, hi), Math.max(lo, hi)]
  }
  if (r && typeof r === 'object') {
    const lo = Number(r.min ?? r.startSeq)
    const hi = Number(r.max ?? r.endSeq)
    if (Number.isFinite(lo) && Number.isFinite(hi)) return [Math.min(lo, hi), Math.max(lo, hi)]
  }
  if (Number.isFinite(Number(episode.startSeq)) && Number.isFinite(Number(episode.endSeq))) {
    const lo = Number(episode.startSeq)
    const hi = Number(episode.endSeq)
    return [Math.min(lo, hi), Math.max(lo, hi)]
  }
  return null
}

const SKIP_RAW_SOURCE_KINDS = new Set([
  'runtime-context',
  'speak-up',
  'system-reminder',
  'compact-checkpoint',
  'dsh-rewind',
  'system-prompt',
  'tool',
])

function extractTextFromRawEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  const type = String(ev.type ?? ev.role ?? '')
  if (type.startsWith('tool')) return null

  const msg = ev.data?.message ?? ev.data ?? ev
  const sourceKind = String(msg?.source?.kind ?? ev.data?.source?.kind ?? '')
  if (sourceKind && SKIP_RAW_SOURCE_KINDS.has(sourceKind)) return null

  let text = ''
  if (typeof msg?.text === 'string') {
    text = msg.text
  } else if (typeof msg?.content === 'string') {
    text = msg.content
  } else if (Array.isArray(msg?.content)) {
    text = msg.content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text ?? '') : ''))
      .join('')
  } else if (typeof ev.text === 'string') {
    text = ev.text
  }

  const cleaned = text
    .replace(/\[QQ\]([\s\S]*?)\[\/QQ\]/gi, '$1')
    .replace(/\[\/?QQ\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null

  const roleLabel =
    type === 'assistant/message' || type === 'assistant'
      ? '蓝蓝'
      : String(ev.who || ev.speaker || msg?.speaker || '对话')
  const seqPrefix = Number.isFinite(Number(ev.seq)) ? `#${Number(ev.seq)} ` : ''
  const snippet = cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned
  return `${seqPrefix}${roleLabel}: ${snippet}`
}

function formatParticipantSection(participant, edges, viewerScope) {
  const lines = []
  const call = participant.preferredCall || participant.nickname || participant.participantId
  const aliasPart =
    Array.isArray(participant.aliases) && participant.aliases.length > 0
      ? `（别名：${participant.aliases.join('、')}）`
      : ''
  lines.push(`【人物档案】${call} [${participant.participantId}]${aliasPart} · 可信度=${participant.trust}`)

  const facts = Array.isArray(participant.facts)
    ? participant.facts
    : Array.isArray(participant.profileFacts)
      ? participant.profileFacts.map((f) => (typeof f === 'string' ? f : f?.fact)).filter(Boolean)
      : []
  if (facts.length > 0) {
    lines.push(`  画像：${facts.slice(0, 6).join('；')}`)
  }

  const safeEdges = (Array.isArray(edges) ? edges : []).filter((e) =>
    canScopeAccessLocal(viewerScope, e?.scope),
  )
  if (safeEdges.length > 0) {
    const edgeTexts = safeEdges.slice(0, 6).map((e) => {
      const pair = Array.isArray(e.participantIds)
        ? e.participantIds.join(' ↔ ')
        : Array.isArray(e.participants)
          ? e.participants.join(' ↔ ')
          : `${e.participantA} ↔ ${e.participantB}`
      return `${pair}：${e.relation}（${e.trust}）`
    })
    lines.push(`  关系边：${edgeTexts.join('；')}`)
  }
  return lines.join('\n')
}

function formatEpisodeLine(ep, viewerScope) {
  const title = ep.title || ep.indexLine || ep.episodeId
  const summary = ep.summary || ep.indexLine || ''
  const parts = [`- [${ep.episodeId}] (${ep.scope}) ${title}：${summary}`]
  // Only expose private moodSlice details in private:* viewerScope
  if (viewerScope.startsWith('private:') && ep.moodSlice && typeof ep.moodSlice === 'object') {
    const m = ep.moodSlice
    const label = m.label ? `${m.label}` : ''
    const range =
      Number.isFinite(Number(m.startMood)) && Number.isFinite(Number(m.endMood))
        ? ` (${m.startMood}->${m.endMood})`
        : ''
    if (label || range) {
      parts.push(`  当时情绪：${label}${range}`)
    }
  }
  return parts.join('\n')
}

export function createFocusAttentionTool({
  defineTool,
  z: _z,
  store,
  engine,
  resolveSessionScope,
  readRawEvents,
} = {}) {
  const spec = {
    name: 'focus_attention',
    description:
      '按需切换温热话题焦点或展开历史共同经历、人物关系与原话片段（结果仅在工具结果中临时展开，自动遵守群聊/私聊隐私边界）。',
    parameters: {
      topicId: {
        type: 'string',
        description: '要切回或展开详情的温热/挂起话题 ID。',
      },
      episodeId: {
        type: 'string',
        description: '要展开详情的共同经历 ID（如目录索引中的 ep-...）。',
      },
      participantId: {
        type: 'string',
        description: '要查阅画像与关系网的人物 ID（如 qq:616860663）或称呼/外号。',
      },
      query: {
        type: 'string',
        description: '按关键词检索可见的共同经历与挂起话题。',
      },
      includeRawQuotes: {
        type: 'boolean',
        description: '是否按事件序号回捞当时的对话原句（仅在需要核对原话细节时设为 true）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          scope: { type: 'string' },
          focusedTopicId: { type: 'string' },
          matchCount: { type: 'integer' },
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        const text =
          typeof value === 'string'
            ? value
            : String(value?.text || (value?.ok === false ? '✗ 未找到可见记忆' : '（无匹配内容）'))
        return [{ type: 'text', text }]
      },
    },
    async execute(args = {}, exec = {}) {
      const sessionId = extractSessionIdFromExec(exec)
      const viewerScope = resolveViewerScope(resolveSessionScope, exec, sessionId)
      if (!isValidViewerScope(viewerScope)) {
        return {
          ok: false,
          matchCount: 0,
          text: '✗ 无法确认当前会话的隐私作用域（ScopeGate 拒绝访问）。',
        }
      }

      const topicId = typeof args.topicId === 'string' ? args.topicId.trim() : ''
      const episodeId = typeof args.episodeId === 'string' ? args.episodeId.trim() : ''
      const rawParticipant = typeof args.participantId === 'string' ? args.participantId.trim() : ''
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const includeRawQuotes = args.includeRawQuotes === true

      const sections = []
      const matchedEpisodes = []
      const seenEpisodeIds = new Set()
      let focusedTopicId = ''
      let matchCount = 0

      const pushEpisode = (ep) => {
        if (!ep || typeof ep !== 'object' || ep.invalidatedByRewind) return
        if (!canScopeAccessLocal(viewerScope, ep.scope)) return
        const id = String(ep.episodeId ?? ep.id ?? '').trim()
        if (!id || seenEpisodeIds.has(id)) return
        seenEpisodeIds.add(id)
        matchedEpisodes.push(ep)
      }

      // 1. Topic switch / expansion
      if (topicId) {
        const stage = sessionId ? engine?.getStage?.(sessionId) : null
        let topic = findTopicInStage(stage, topicId)
        if (topic && !canScopeAccessLocal(viewerScope, topic.scope ?? stage?.scope ?? viewerScope)) {
          topic = null
        }
        if (!topic) {
          const storedTopic = store?.getTopic?.(topicId, { viewerScope })
          if (
            storedTopic &&
            !storedTopic.invalidatedByRewind &&
            canScopeAccessLocal(viewerScope, storedTopic.scope)
          ) {
            topic = storedTopic
          }
        }

        if (topic) {
          matchCount++
          if (sessionId && typeof engine?.focusTopic === 'function') {
            const switched = engine.focusTopic(sessionId, topicId)
            if (switched) {
              focusedTopicId = topicId
            } else if (topic.status === 'warm' || topic.status === 'focused') {
              focusedTopicId = topicId
            }
          }
          const title = String(topic.title || topicId)
          const summary = String(topic.summary || '').trim()
          const cohortEntries =
            topic.cohort && typeof topic.cohort === 'object'
              ? Object.entries(topic.cohort).map(([pid, info]) => {
                  const name = info?.nickname || pid
                  const stance = info?.latestStance || info?.stanceSummary || ''
                  return stance ? `${name}(${pid}): ${stance}` : `${name}(${pid})`
                })
              : []
          const lines = [
            `【话题焦点】${title} [${topicId}]（状态=${focusedTopicId ? 'focused' : topic.status || 'archived'}）`,
          ]
          if (summary) lines.push(`  小结：${summary}`)
          if (cohortEntries.length > 0) lines.push(`  在场成员：${cohortEntries.join('；')}`)
          sections.push(lines.join('\n'))

          const relEpIds = [
            ...(topic.episodeId ? [topic.episodeId] : []),
            ...(topic.crystallizedEpisodeId ? [topic.crystallizedEpisodeId] : []),
            ...(Array.isArray(topic.relatedEpisodeIds) ? topic.relatedEpisodeIds : []),
          ]
          for (const relId of relEpIds) {
            const ep = store?.getEpisode?.(relId, { viewerScope, excludeInvalidated: true })
            pushEpisode(ep)
          }
        }
      }

      // 2. Participant & relation lookup
      let resolvedParticipantId = ''
      if (rawParticipant) {
        const normalizedCandidate = /^\d{5,15}$/.test(rawParticipant)
          ? `qq:${rawParticipant}`
          : rawParticipant
        let participant = store?.getParticipant?.(normalizedCandidate, { viewerScope }) ?? null
        if (!participant && typeof store?.resolveParticipantsInText === 'function') {
          const resolvedList = store.resolveParticipantsInText(rawParticipant, { viewerScope })
          if (Array.isArray(resolvedList) && resolvedList.length > 0) {
            participant = resolvedList[0]
          }
        }
        if (participant && canScopeAccessLocal(viewerScope, participant.scope)) {
          resolvedParticipantId = participant.participantId
          matchCount++
          const edges =
            store?.getCohortRelations?.([participant.participantId], { viewerScope }) ?? []
          sections.push(formatParticipantSection(participant, edges, viewerScope))
        }
      }

      // 3. Direct Episode lookup
      if (episodeId) {
        const ep = store?.getEpisode?.(episodeId, { viewerScope, excludeInvalidated: true })
        pushEpisode(ep)
      }

      // 4. Keyword / Participant Episode Search
      if (query || resolvedParticipantId || (!topicId && !episodeId && !rawParticipant)) {
        const found =
          store?.searchEpisodes?.(query, {
            viewerScope,
            ...(resolvedParticipantId ? { participantId: resolvedParticipantId } : {}),
            limit: 5,
          }) ?? []
        if (Array.isArray(found)) {
          for (const ep of found) pushEpisode(ep)
        }
      }

      if (matchedEpisodes.length > 0) {
        matchCount += matchedEpisodes.length
        const epLines = matchedEpisodes.map((ep) => formatEpisodeLine(ep, viewerScope))
        sections.push(`【共同经历详情】\n${epLines.join('\n')}`)
      }

      // 5. Shadowed Raw Event Quotes (via host `ctx.sessions` / `ctx.sessionQuery.filterEvents`, never `.zstd` disk)
      if (includeRawQuotes && typeof readRawEvents === 'function' && matchedEpisodes.length > 0) {
        const quoteBlocks = []
        for (const ep of matchedEpisodes.slice(0, 2)) {
          if (!canScopeAccessLocal(viewerScope, ep.scope)) continue
          const range = normalizeSeqRange(ep)
          if (!ep.sessionId || !range) continue
          const rawResult = await readRawEvents(ep.sessionId, range)
          const rawList = Array.isArray(rawResult)
            ? rawResult
            : Array.isArray(rawResult?.events)
              ? rawResult.events
              : Array.isArray(rawResult?.items)
                ? rawResult.items
                : []
          const renderedLines = rawList
            .map(extractTextFromRawEvent)
            .filter(Boolean)
            .slice(0, 12)
          if (renderedLines.length > 0) {
            quoteBlocks.push(
              `[原话片段 ${ep.episodeId} seq=${range[0]}..${range[1]}]\n${renderedLines.join('\n')}`,
            )
          }
        }
        if (quoteBlocks.length > 0) {
          sections.push(`【历史原话回放】\n${quoteBlocks.join('\n\n')}`)
        }
      }

      if (sections.length === 0) {
        return {
          ok: true,
          scope: viewerScope,
          matchCount: 0,
          text: '未在当前可见范围内找到匹配的话题、人物关系或共同经历。',
        }
      }

      return {
        ok: true,
        scope: viewerScope,
        ...(focusedTopicId ? { focusedTopicId } : {}),
        matchCount,
        text: sections.join('\n\n'),
      }
    },
  }

  return buildToolWithFallback(defineTool, spec)
}
