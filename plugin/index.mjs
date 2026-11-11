import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { resolveHostPeers, resolveHostPeersSync } from './host-peer.mjs'
import { createAttentionEngine, parseDecision, usable } from './engine.mjs'
import { createMultiTopicEngine, normalizeSpeakerId } from './attention/multi-topic-engine.mjs'
import { createTopicClassifier, parseTopicVerdict } from './attention/classifier.mjs'
import { renderStageSnapshot, estimateTokens, clearSnapshotCache } from './projection/snapshot-quantizer.mjs'
import { crystallizeCompaction, crystallizeTopicThread } from './projection/episode-crystallizer.mjs'
import { createRelationalStore } from './store/sqlite-repo.mjs'
import { canScopeAccess } from './store/schema.mjs'
import { createMemoryConnector } from './connectors/memory-connector.mjs'
import { createMoodConnector } from './connectors/mood-connector.mjs'
import { attachRewindConnector } from './connectors/rewind-connector.mjs'
import { createSpeakupConnector, isInternalTriggerMessage } from './connectors/speakup-connector.mjs'
import { createFocusAttentionTool, extractSessionIdFromExec } from './tools/focus-attention.mjs'
import { createRememberRelationTool } from './tools/remember-relation.mjs'
import * as humanizer from './expression/humanizer.mjs'
import {
  normalizeParticipantId,
  extractReplySegment,
  formatIdentityTag,
  formatInboundLine,
  formatDigestLine,
  parseInboundLine,
  parseDigestLines,
} from './bridge/onebot-enrichment.mjs'

export const name = 'dsh-group-attention'
// Cordis 4 treats every entry in `inject` as a hard-required service dependency.
// Keep `inject` empty and resolve optional host services via `ctx.get(...)` (`getService`)
// so activation never stalls in pending state on either full DSH desktop or standalone contexts.
export const inject = []

export const DESKTOP_PET_SESSION_ID = 'session-6e7760fd-1ac1-4387-a765-5b7d25697b10'

export {
  createAttentionEngine,
  parseDecision,
  usable,
  createMultiTopicEngine,
  createTopicClassifier,
  parseTopicVerdict,
  createRelationalStore,
  canScopeAccess,
  renderStageSnapshot,
  estimateTokens,
  clearSnapshotCache,
  crystallizeCompaction,
  crystallizeTopicThread,
  normalizeParticipantId,
  extractReplySegment,
  formatIdentityTag,
  formatInboundLine,
  formatDigestLine,
  parseInboundLine,
  parseDigestLines,
  humanizer,
}

function dayKey(nowFn = Date.now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowFn()))
}

function readState(filePath) {
  if (!filePath) return {}
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function writeState(filePath, value) {
  if (!filePath) return
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, filePath)
}

const bounded = (x, fallback, min, max) => {
  const n = Number(x)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

function buildAllowedSessionMap(config, ownerId, fallbackGroupId) {
  const map = new Map()
  const rawSources = [config.allowedSessions, config.allowedSessionIds]
  for (const raw of rawSources) {
    if (!raw) continue
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry && typeof entry === 'object') {
          const sid = String(entry.sessionId ?? entry.id ?? '').trim()
          const scope = String(entry.scope ?? '').trim()
          if (sid && scope && sid !== DESKTOP_PET_SESSION_ID) {
            map.set(sid, scope)
          }
        }
      }
    } else if (raw instanceof Map) {
      for (const [sidRaw, scopeRaw] of raw.entries()) {
        const sid = String(sidRaw ?? '').trim()
        const scope = String(scopeRaw ?? '').trim()
        if (sid && scope && sid !== DESKTOP_PET_SESSION_ID) {
          map.set(sid, scope)
        }
      }
    } else if (typeof raw === 'object') {
      for (const [sidRaw, scopeRaw] of Object.entries(raw)) {
        const sid = String(sidRaw ?? '').trim()
        const scope = String(scopeRaw ?? '').trim()
        if (sid && scope && sid !== DESKTOP_PET_SESSION_ID) {
          map.set(sid, scope)
        }
      }
    }
  }

  if (config.privateSessionId) {
    const sid = String(config.privateSessionId).trim()
    if (sid && sid !== DESKTOP_PET_SESSION_ID && !map.has(sid)) {
      map.set(sid, `private:${ownerId}`)
    }
  }
  if (config.groupSessionId && fallbackGroupId) {
    const sid = String(config.groupSessionId).trim()
    if (sid && sid !== DESKTOP_PET_SESSION_ID && !map.has(sid)) {
      map.set(sid, `group:${fallbackGroupId}`)
    }
  }
  return map
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') return ''
  if (typeof message.text === 'string') return message.text
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text ?? '') : ''))
      .join('')
  }
  return ''
}

function extractSummaryText(summaryField) {
  if (typeof summaryField === 'string') return summaryField.trim()
  if (Array.isArray(summaryField)) {
    return summaryField
      .map(block => (typeof block === 'string' ? block : block?.type === 'text' ? String(block.text ?? '') : ''))
      .join('\n')
      .trim()
  }
  return ''
}

function resolveAgentSessionId(agent) {
  if (!agent || typeof agent !== 'object') return ''
  const sid = agent.session?.id ?? agent.sessionId ?? agent.id ?? ''
  return String(sid).trim()
}

function resolveLatestUserSeq(agent, message) {
  if (Number.isFinite(Number(message?.seq))) return Number(message.seq)
  const session = agent?.session
  if (!session || typeof session !== 'object') return null
  if (Number.isFinite(Number(session.lastSeq))) return Number(session.lastSeq)
  if (Number.isFinite(Number(session.headSeq))) return Number(session.headSeq)
  if (Array.isArray(session.events) && session.events.length > 0) {
    for (let i = session.events.length - 1; i >= 0; i--) {
      const ev = session.events[i]
      if (ev?.type === 'user/message' && Number.isFinite(Number(ev.seq))) {
        return Number(ev.seq)
      }
    }
  }
  return null
}

function iterateExistingAgents(agentsContainer) {
  if (!agentsContainer) return []
  if (Array.isArray(agentsContainer)) return agentsContainer
  if (agentsContainer instanceof Map || agentsContainer instanceof Set) {
    return [...agentsContainer.values()]
  }
  if (typeof agentsContainer.values === 'function') {
    try {
      return [...agentsContainer.values()]
    } catch {
      return []
    }
  }
  if (typeof agentsContainer.list === 'function') {
    try {
      const res = agentsContainer.list()
      return Array.isArray(res) ? res : []
    } catch {
      return []
    }
  }
  return []
}

export function apply(ctx, config = {}) {
  const now = typeof config.now === 'function' ? config.now : Date.now
  const later = typeof config.setTimeout === 'function' ? config.setTimeout : setTimeout
  const clear = typeof config.clearTimeout === 'function' ? config.clearTimeout : clearTimeout
  const laterInterval = typeof config.setInterval === 'function' ? config.setInterval : setInterval
  const clearTimerInterval = typeof config.clearInterval === 'function' ? config.clearInterval : clearInterval

  const ownerId = normalizeParticipantId(config.ownerId || 'qq:1024162823') || 'qq:1024162823'
  const brotherId = normalizeParticipantId(config.brotherId || 'qq:616860663') || 'qq:616860663'

  const rawGroupId = String(config.groupId ?? '').trim()
  const sessionScopes = buildAllowedSessionMap(config, ownerId, rawGroupId)

  let groupId = rawGroupId
  if (!groupId) {
    for (const scope of sessionScopes.values()) {
      if (scope.startsWith('group:')) {
        groupId = scope.slice('group:'.length)
        break
      }
    }
  }
  if (!groupId && sessionScopes.size === 0) {
    throw new Error('groupId or allowedSessions is required; refusing to observe all groups')
  }

  let ownerSessionId = ''
  let groupSessionId = ''
  for (const [sid, scope] of sessionScopes.entries()) {
    if (!ownerSessionId && scope === `private:${ownerId}`) ownerSessionId = sid
    if (!groupSessionId && groupId && scope === `group:${groupId}`) groupSessionId = sid
  }

  const dshHome = String(config.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const dbPath = String(
    config.dbPath ?? join(dshHome, 'relational-attention', 'relational.sqlite'),
  )
  const isPureMemoryDb = dbPath === ':memory:'
  const statePath =
    config.persistState === false || (isPureMemoryDb && !config.statePath)
      ? ''
      : String(config.statePath ?? join(dshHome, 'group-attention', 'state.json'))

  const model = String(config.model ?? 'gpt-6.1-terra')
  const provider = String(config.provider ?? 'zzapi')
  const dailyLimit = bounded(config.dailyClassifyLimit, 60, 1, 2000)
  const dryRun = config.dryRun !== false
  const nicknames =
    Array.isArray(config.nicknames) && config.nicknames.length > 0
      ? config.nicknames
      : ['蓝蓝', '大肥鱼']

  const metadata = readState(statePath)
  let disposed = false
  const disposers = []

  function getService(targetCtx, serviceName) {
    if (!targetCtx || typeof targetCtx !== 'object') return undefined
    const isCordisCtx = Boolean(targetCtx.registry && typeof targetCtx.plugin === 'function')
    if (isCordisCtx) {
      return typeof targetCtx.get === 'function' ? targetCtx.get(serviceName) : undefined
    }
    if (typeof targetCtx.get === 'function') {
      const viaGet = targetCtx.get(serviceName)
      if (viaGet !== undefined) return viaGet
    }
    return targetCtx[serviceName]
  }

  function getLogger(targetCtx) {
    if (!targetCtx || typeof targetCtx !== 'object') return undefined
    try {
      return targetCtx.logger ?? getService(targetCtx, 'logger')
    } catch {
      return getService(targetCtx, 'logger')
    }
  }

  function saveState() {
    if (!statePath) return
    try {
      writeState(statePath, metadata)
    } catch (err) {
      getLogger(ctx)?.warn?.(`[relational-attention] state save: ${err?.message ?? err}`)
    }
  }

  function consumeBudget() {
    const day = dayKey(now)
    if (metadata.budget?.day !== day) {
      metadata.budget = { day, count: 0 }
    }
    if (metadata.budget.count >= dailyLimit) {
      throw new Error('daily classification limit reached')
    }
    metadata.budget.count += 1
    saveState()
  }

  // Initialize L3 Relational Store + Seeds
  const ownsStore = !config.store
  const store = config.store ?? createRelationalStore({ dbPath, now })
  store.seedDefaults?.({ ownerId, brotherId })

  // Initialize L5 Memory Connector + Optional Fish-Memory Seed Import
  const memoryConnector = createMemoryConnector({
    dshHome,
    store,
    ...(typeof config.readSeedFile === 'function' ? { readFile: config.readSeedFile } : {}),
  })
  if (config.fishMemorySeedPath !== false) {
    const seedTarget =
      config.fishMemorySeedPath ??
      (isPureMemoryDb
        ? ''
        : join(dshHome, 'fish-memory', 'session-1c2e0af0-9f78-45cb-b7b2-d07a4a44e2fd.json'))
    if (seedTarget) {
      try {
        memoryConnector.importFishMemorySeeds(seedTarget, {
          ownerId,
          scope: `private:${ownerId}`,
        })
      } catch (err) {
        getLogger(ctx)?.warn?.(`[relational-attention] fish-memory seed import skipped: ${err?.message ?? err}`)
      }
    }
  }

  // Initialize L4 Mood Connector
  const moodConnector = createMoodConnector({
    dshHome,
    store,
    now,
    ...(typeof config.readMoodFile === 'function' ? { readFile: config.readMoodFile } : {}),
  })
  try {
    moodConnector.projectGroupAffectTone({ ownerId, nowMs: now() })
  } catch {
    // non-fatal if feiyu-mood files do not exist yet
  }

  const syncPeers = resolveHostPeersSync(config.deps)

  async function classifyBatch(batchPayload) {
    if (typeof config.classifyBatch === 'function') {
      consumeBudget()
      return config.classifyBatch(batchPayload)
    }
    if (typeof config.classify === 'function') {
      consumeBudget()
      return config.classify(batchPayload)
    }
    const llm = getService(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('ctx.llm.stream is unavailable for group topic classification')
    }
    const peers = await resolveHostPeers(config.deps)
    const classifier = createTopicClassifier({
      llm,
      createUserMessage: peers.createUserMessage,
      provider,
      model,
      nicknames,
      onBudget: () => consumeBudget(),
    })
    return classifier(batchPayload)
  }

  const engine = createMultiTopicEngine({
    groupId,
    groupSessionId,
    ownerId,
    ownerSessionId,
    sessionScopes: Object.fromEntries(sessionScopes.entries()),
    store,
    nicknames,
    selfUserId: config.selfUserId ?? '',
    warmTtlMs: bounded(config.warmTtlMinutes, 30, 1, 1440) * 60_000,
    windowMs: bounded(config.attentionMinutes, 8, 1, 360) * 60_000,
    maxWindowMs: bounded(config.maxAttentionMinutes, 30, 2, 720) * 60_000,
    quietMs: bounded(config.quietSeconds, 8, 1, 120) * 1000,
    maxBatchMs: bounded(config.maxBatchSeconds, 25, 2, 180) * 1000,
    classifyIntervalMs: bounded(config.classifyIntervalSeconds, 20, 0, 600) * 1000,
    cooldownMs: bounded(config.cooldownSeconds, 60, 1, 1800) * 1000,
    maxAutoReplies: bounded(config.maxAutoReplies, 3, 1, 20),
    unrelatedLimit: bounded(config.unrelatedLimit, 2, 1, 10),
    historyLimit: bounded(config.historyLimit, 8, 2, 30),
    ignoredUserIds: Array.isArray(config.ignoredUserIds) ? config.ignoredUserIds : [],
    now,
    setTimeout: later,
    clearTimeout: clear,
    classifyBatch,
    requestWake: wakePayload => {
      if (disposed) return
      const { candidateToken, ...extra } = wakePayload || {}
      if (!candidateToken) return
      if (dryRun) {
        metadata.lastEvent = {
          type: 'dry-run-would-wake',
          ...extra,
          at: now(),
        }
        saveState()
        return
      }
      metadata.updatedAt = now()
      metadata.attention = engine.snapshot()
      saveState()
      ctx.emit?.('qq-bridge/attention-wake', { candidateToken, ...extra })
    },
    onEvent: event => {
      metadata.groupId = groupId
      metadata.updatedAt = now()
      metadata.attention = engine.snapshot()
      metadata.lastEvent = { ...event, at: now() }
      saveState()
    },
  })

  const speakupConnector = createSpeakupConnector({
    store,
    engine,
    ownerId,
    now,
  })

  function isAllowedSession(sessionId) {
    const sid = String(sessionId ?? '').trim()
    if (!sid || sid === DESKTOP_PET_SESSION_ID) return false
    return sessionScopes.has(sid)
  }

  function resolveSessionScope(execOrSessionId) {
    if (typeof execOrSessionId === 'string') {
      const sid = execOrSessionId.trim()
      if (!sid || sid === DESKTOP_PET_SESSION_ID) return ''
      return sessionScopes.get(sid) ?? ''
    }
    const sid = extractSessionIdFromExec(execOrSessionId)
    if (!sid || sid === DESKTOP_PET_SESSION_ID) return ''
    return sessionScopes.get(sid) ?? ''
  }

  async function readRawEvents(targetSessionId, seqRange) {
    if (typeof config.readRawEvents === 'function') {
      return config.readRawEvents(targetSessionId, seqRange)
    }
    const sid = String(targetSessionId ?? '').trim()
    if (!sid || !isAllowedSession(sid) || !Array.isArray(seqRange) || seqRange.length < 2) {
      return []
    }
    const lo = Math.max(0, Math.floor(Number(seqRange[0]) || 0))
    const hi = Math.max(lo, Math.floor(Number(seqRange[1]) || lo))
    const cappedHi = Math.min(hi, lo + 40)

    // 1. Live in-memory Session (`ctx.sessions.get(sid)?.eventAt(seq)`)
    const sessionsSvc = getService(ctx, 'sessions')
    const agentsSvc = getService(ctx, 'agents')
    const liveSession =
      sessionsSvc?.get?.(sid) ??
      agentsSvc?.get?.(sid)?.session ??
      null
    if (liveSession) {
      if (typeof liveSession.eventAt === 'function') {
        const collected = []
        for (let seq = lo; seq <= cappedHi; seq++) {
          try {
            const ev = liveSession.eventAt(seq)
            if (ev) collected.push(ev)
          } catch {
            // out-of-bounds or missing seq
          }
        }
        if (collected.length > 0) return collected
      }
      if (Array.isArray(liveSession.events)) {
        const matched = liveSession.events.filter(
          ev => Number.isFinite(Number(ev?.seq)) && Number(ev.seq) >= lo && Number(ev.seq) <= cappedHi,
        )
        if (matched.length > 0) return matched
      }
    }

    // 2. Host `ctx.sessionQuery.filterEvents(sid, [{ kind: 'seq', min, max }])`
    const sessionQuerySvc = getService(ctx, 'sessionQuery')
    if (typeof sessionQuerySvc?.filterEvents === 'function') {
      try {
        const res = await sessionQuerySvc.filterEvents(sid, [
          { kind: 'seq', min: lo, max: cappedHi },
        ])
        if (Array.isArray(res)) return res
        if (Array.isArray(res?.events)) return res.events
      } catch {
        // graceful fallback if cold log unavailable
      }
    }

    return []
  }

  // Build per-session tools once (scoped strictly via `resolveSessionScope` + mounted ONLY on allowlisted agents)
  const focusAttentionTool = createFocusAttentionTool({
    defineTool: syncPeers.defineTool,
    z: syncPeers.z,
    store,
    engine,
    resolveSessionScope,
    readRawEvents,
  })

  const rememberRelationTool = createRememberRelationTool({
    defineTool: syncPeers.defineTool,
    z: syncPeers.z,
    store,
    resolveSessionScope,
    ownerId,
  })

  const mountedAgents = new WeakSet()

  function handleClaimedTurn(agent, sessionId, scope, payload) {
    if (disposed) return
    const message = payload?.message ?? payload
    if (!message || isInternalTriggerMessage(message)) return

    if (scope.startsWith('group:')) {
      try {
        moodConnector.projectGroupAffectTone({ ownerId, nowMs: now() })
      } catch {
        // ignore optional mood sync error
      }
    }

    const rawText = extractMessageText(message)
    if (!rawText.trim()) return

    const seq = resolveLatestUserSeq(agent, message)
    const sourceKind = String(message?.source?.kind ?? '').trim()
    const currentTime = now()

    // Feed any preceding buffered digest speaker lines into the topic stage so multi-person context is complete
    const digestItems = parseDigestLines(rawText)
    for (const item of digestItems) {
      engine.onClaimedTurn({
        sessionId,
        scope,
        speakerId: item.speakerId || '',
        nickname: item.nickname || '',
        text: item.text,
        replyToMessageId: item.replyToMessageId,
        seq,
        sourceKind,
        nowMs: currentTime,
      })
    }

    const parsedInbound = parseInboundLine(rawText)
    if (parsedInbound) {
      engine.onClaimedTurn({
        sessionId,
        scope,
        speakerId:
          parsedInbound.speakerId ||
          (scope.startsWith('private:') ? scope.slice('private:'.length) : ''),
        nickname: parsedInbound.nickname || '',
        text: parsedInbound.text,
        messageId: message?.id ?? null,
        replyToMessageId: parsedInbound.replyToMessageId,
        seq,
        sourceKind,
        nowMs: currentTime,
      })
      return
    }

    engine.onClaimedTurn({
      sessionId,
      scope,
      speakerId: scope.startsWith('private:') ? scope.slice('private:'.length) : '',
      nickname: '',
      text: rawText,
      messageId: message?.id ?? null,
      seq,
      sourceKind,
      nowMs: currentTime,
    })
  }

  function mountAgentIfAllowed(agent) {
    if (disposed || !agent || typeof agent !== 'object') return false
    if (mountedAgents.has(agent)) return false

    const sessionId = resolveAgentSessionId(agent)
    // HARD INVARIANT: Never mount tools or context on desktop pet or non-allowlisted sessions!
    if (!isAllowedSession(sessionId)) return false

    const scope = sessionScopes.get(sessionId)
    const agentCtx = agent.ctx
    if (!agentCtx || typeof agentCtx !== 'object') return false

    mountedAgents.add(agent)
    const isGroup = scope.startsWith('group:')

    const agentTools = getService(agentCtx, 'tools')
    if (typeof agentTools?.register === 'function') {
      const offFocus = agentTools.register(focusAttentionTool)
      if (typeof offFocus === 'function') disposers.push(offFocus)
      const offRemember = agentTools.register(rememberRelationTool)
      if (typeof offRemember === 'function') disposers.push(offRemember)
    }

    const agentSystemPrompt = getService(agentCtx, 'systemPrompt')
    if (typeof agentSystemPrompt?.context === 'function') {
      const offContext = agentSystemPrompt.context({
        name: 'relational-attention',
        order: 905,
        required: true,
        interpolate: false,
        text: () => {
          if (disposed) return ''
          if (isGroup) {
            try {
              moodConnector.projectGroupAffectTone({ ownerId, nowMs: now() })
            } catch {
              // ignore
            }
          }
          const stage = engine.getStage(sessionId)
          return renderStageSnapshot({
            stage,
            store,
            viewerScope: scope,
            isGroup,
            ownerId,
            includeGroupHighlights: config.includeGroupHighlights !== false,
            nowMs: now(),
          })
        },
      })
      if (typeof offContext === 'function') disposers.push(offContext)
    }

    if (typeof agentCtx.on === 'function') {
      const offClaimed = agentCtx.on('agent/inbox/claimed', payload => {
        handleClaimedTurn(agent, sessionId, scope, payload)
      })
      if (typeof offClaimed === 'function') disposers.push(offClaimed)
    }

    return true
  }

  // Mount onto any already-alive allowlisted agents (e.g. after HMR plugin reload)
  for (const existingAgent of iterateExistingAgents(getService(ctx, 'agents'))) {
    mountAgentIfAllowed(existingAgent)
  }
  if (typeof ctx.inject === 'function') {
    const offAgentsInject = ctx.inject(['agents'], injectedCtx => {
      for (const existingAgent of iterateExistingAgents(getService(injectedCtx, 'agents'))) {
        mountAgentIfAllowed(existingAgent)
      }
    })
    if (typeof offAgentsInject === 'function') {
      disposers.push(offAgentsInject)
    } else if (typeof offAgentsInject?.dispose === 'function') {
      disposers.push(() => offAgentsInject.dispose())
    }
  }

  // Listen globally for newly created agents
  if (typeof ctx.on === 'function') {
    const offAgentCreated = ctx.on(
      'agent/created',
      payload => {
        const agent = payload?.agent ?? payload
        mountAgentIfAllowed(agent)
      },
      { global: true },
    )
    if (typeof offAgentCreated === 'function') disposers.push(offAgentCreated)

    // Group QQ Bridge events
    const offInbound = ctx.on('qq-bridge/inbound', event => {
      const res = engine.onGroupInbound(event)
      metadata.groupId = groupId
      metadata.updatedAt = now()
      metadata.attention = engine.snapshot()
      saveState()
      return res
    })
    if (typeof offInbound === 'function') disposers.push(offInbound)

    const offOutbound = ctx.on('qq-bridge/outbound', event => {
      return engine.onGroupOutbound(event)
    })
    if (typeof offOutbound === 'function') disposers.push(offOutbound)

    // Rewind synchronization connector (`{ global: true }`)
    const rewindHandle = attachRewindConnector({ ctx, store, engine })
    disposers.push(() => rewindHandle.dispose())

    // Compaction episode crystallizer (supports both `session/event` with `type === 'compaction/summary'`
    // and direct `compaction/summary` events, deduplicated by compaction key)
    const seenCompactionKeys = new Set()
    const handleCompactionPayload = (arg1, arg2) => {
      if (disposed) return null
      const event = arg2 !== undefined ? arg2 : arg1
      const isCompactionEvent =
        event?.type === 'compaction/summary' ||
        arg2 === undefined // direct `compaction/summary` emission
      if (!isCompactionEvent) return null

      const data = event?.data ?? event ?? {}
      const sid = String(
        (arg2 !== undefined
          ? arg1?.id ?? arg1?.sessionId ?? arg1?.session?.id
          : data.sessionId ?? event?.sessionId) ?? '',
      ).trim()
      if (!isAllowedSession(sid)) return null

      const scope = sessionScopes.get(sid)
      const sliceStartSeq =
        data.shadowedRange?.start ??
        data.sliceStartSeq ??
        data.startSeq ??
        (Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.length > 0
          ? Math.min(...data.shadowedSeqs)
          : null)
      const sliceEndSeq =
        data.shadowedRange?.end ??
        data.sliceEndSeq ??
        data.endSeq ??
        (Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.length > 0
          ? Math.max(...data.shadowedSeqs)
          : null)
      const summaryText = extractSummaryText(data.summary ?? data.summaryText ?? data.text ?? '')
      if (!summaryText && sliceEndSeq == null) return null

      const dedupKey = `${sid}:${data.compactionId || `${sliceStartSeq ?? 'na'}-${sliceEndSeq ?? 'na'}:${summaryText.slice(0, 32)}`}`
      if (seenCompactionKeys.has(dedupKey)) return null
      seenCompactionKeys.add(dedupKey)
      if (seenCompactionKeys.size > 256) {
        const oldest = seenCompactionKeys.values().next().value
        seenCompactionKeys.delete(oldest)
      }

      const ep = crystallizeCompaction({
        sessionId: sid,
        scope,
        sliceStartSeq,
        sliceEndSeq,
        summaryText,
        stage: engine.getStage(sid),
        store,
        moodConnector,
        nowMs: now(),
      })
      if (ep && scope.startsWith('group:')) {
        engine.notifyGroupHighlight(ep)
      }
      return ep
    }

    const offSessionCompaction = ctx.on(
      'session/event',
      (sessionOrEvent, maybeEvent) => {
        if (maybeEvent !== undefined) {
          if (maybeEvent?.type === 'compaction/summary') {
            handleCompactionPayload(sessionOrEvent, maybeEvent)
          }
        } else if (sessionOrEvent?.type === 'compaction/summary') {
          handleCompactionPayload(sessionOrEvent, undefined)
        }
      },
      { global: true },
    )
    if (typeof offSessionCompaction === 'function') disposers.push(offSessionCompaction)

    const offDirectCompaction = ctx.on(
      'compaction/summary',
      (arg1, arg2) => {
        if (arg2 !== undefined) {
          handleCompactionPayload(arg1, { type: 'compaction/summary', data: arg2 })
        } else {
          handleCompactionPayload(arg1, undefined)
        }
      },
      { global: true },
    )
    if (typeof offDirectCompaction === 'function') disposers.push(offDirectCompaction)
  }

  // Periodic background sleep consolidation for expired warm topics
  const consolidationIntervalMin = bounded(config.consolidationIntervalMinutes, 10, 0, 1440)
  let consolidationTimer = null
  if (consolidationIntervalMin > 0 && config.enableConsolidationTimer !== false) {
    consolidationTimer = laterInterval(() => {
      if (disposed) return
      void speakupConnector
        .runIdleConsolidation({ nowMs: now(), moodConnector })
        .catch(err => {
          getLogger(ctx)?.warn?.(`[relational-attention] idle consolidation error: ${err?.message ?? err}`)
        })
    }, consolidationIntervalMin * 60_000)
    consolidationTimer?.unref?.()
  }

  metadata.groupId = groupId
  metadata.startedAt ??= now()
  metadata.updatedAt = now()
  saveState()

  const relationalAttention = {
    ingestInbound(event) {
      if (event?.message?.groupId || event?.transport === true) {
        return engine.onGroupInbound(event)
      }
      if (event?.sessionId && isAllowedSession(event.sessionId)) {
        return engine.onClaimedTurn({
          ...event,
          scope: event.scope || sessionScopes.get(event.sessionId),
        })
      }
      return null
    },
    recordOutbound(event) {
      if (event?.groupId) {
        return engine.onGroupOutbound(event)
      }
      return null
    },
    listOpenTopics(sessionId, opts = {}) {
      const sid = String(sessionId ?? '').trim()
      const configuredScope = sid ? sessionScopes.get(sid) : undefined
      return speakupConnector.listOpenTopics(sid, {
        ...(configuredScope ? { viewerScope: configuredScope } : {}),
        ...opts,
      })
    },
    getActiveStage(sessionId) {
      const sid = String(sessionId ?? '').trim()
      if (!sid) return null
      return engine.getStage(sid)
    },
    registerMemoryProvider(provider) {
      return memoryConnector.registerProvider(provider)
    },
    runIdleConsolidation(opts = {}) {
      return speakupConnector.runIdleConsolidation({
        moodConnector,
        ...opts,
      })
    },
    isAllowedSession,
    resolveSessionScope,
    readRawEvents,
    store,
    engine,
    humanizer,
    moodConnector,
    memoryConnector,
    speakupConnector,
  }

  if (typeof ctx.provide === 'function') {
    // Cordis 4 `ctx.provide(name, immediate?: boolean)` checks `immediate === true`
    // and expects `ctx[name] = service`; lightweight test mocks use `ctx.provide(name, service)`.
    const isCordisContext = Boolean(ctx.registry && typeof ctx.plugin === 'function')
    ctx.provide('relationalAttention', isCordisContext ? true : relationalAttention)
  }
  try {
    ctx.relationalAttention = relationalAttention
  } catch {
    // Non-extensible mock contexts
  }

  const cleanup = () => {
    if (disposed) return
    disposed = true
    if (consolidationTimer !== null) {
      clearTimerInterval(consolidationTimer)
      consolidationTimer = null
    }
    while (disposers.length > 0) {
      const off = disposers.pop()
      try {
        off?.()
      } catch {
        // ignore disposer error
      }
    }
    engine.dispose()
    if (ownsStore) {
      store.close()
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => cleanup)
  }

  return relationalAttention
}
