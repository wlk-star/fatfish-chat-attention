import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  assertValidScopeId,
  canScopeAccess,
  isGroupScope,
  isValidScopeId,
} from '../store/schema.mjs'

const SYNTHETIC_PASSPHRASE_RE =
  /配置验收口令|验收口令|测试口令|连通性验收|smoke[\s_-]*test/i

export function isExcludedFishMemoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return true

  // Exclude superseded / refined-skipped / deleted entries in dsh-fish-memory
  if (
    Boolean(entry['已被取代']) ||
    Boolean(entry.superseded) ||
    Boolean(entry.supersededBy) ||
    entry.refinedSkip === true ||
    entry['精炼跳过'] === true ||
    entry.deleted === true ||
    entry.status === 'superseded' ||
    entry.status === 'deleted'
  ) {
    return true
  }

  const text = extractFishMemoryText(entry)
  if (!text) return true

  if (SYNTHETIC_PASSPHRASE_RE.test(text)) {
    return true
  }

  return false
}

function extractFishMemoryText(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const raw =
    entry.text ??
    entry.content ??
    entry['内容'] ??
    entry.fact ??
    entry.memory ??
    entry.summary ??
    ''
  return String(raw).trim()
}

function buildDeterministicSeedEpisodeId(entry, text) {
  const rawId = String(entry.id ?? entry.memoryId ?? '').trim()
  if (rawId) {
    const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
    if (cleanId) return `fishmem_${cleanId}`
  }
  const digest = createHash('sha1').update(text).digest('hex').slice(0, 16)
  return `fishmem_${digest}`
}

export function createMemoryConnector({
  dshHome = '',
  store = null,
  readFile = (filePath) => readFileSync(filePath, 'utf8'),
} = {}) {
  const providers = new Map()
  let autoSeq = 0

  function registerProvider(provider) {
    const normalized =
      typeof provider === 'function'
        ? { name: provider.name || `provider_${++autoSeq}`, query: provider }
        : provider

    if (!normalized || typeof normalized !== 'object') {
      throw new TypeError('MemoryProvider must be an object or function')
    }
    const queryFn =
      typeof normalized.query === 'function'
        ? normalized.query.bind(normalized)
        : typeof normalized.search === 'function'
          ? normalized.search.bind(normalized)
          : null
    if (!queryFn) {
      throw new TypeError('MemoryProvider requires a query(query, options) function')
    }

    const name = String(normalized.name || `provider_${++autoSeq}`).trim()
    const defaultScope =
      normalized.defaultScope && isValidScopeId(normalized.defaultScope)
        ? normalized.defaultScope
        : null

    const record = { name, queryFn, defaultScope }
    providers.set(name, record)

    return () => {
      if (providers.get(name) === record) {
        providers.delete(name)
      }
    }
  }

  function listProviders() {
    return Array.from(providers.keys())
  }

  async function queryExternal(
    query,
    { viewerScope, limit = 5 } = {}
  ) {
    if (!isValidScopeId(viewerScope)) return []
    const trimmed = String(query ?? '').trim()
    if (!trimmed || providers.size === 0) return []

    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 5))
    const collected = []
    const seenKeys = new Set()

    for (const { name, queryFn, defaultScope } of providers.values()) {
      let rawItems
      try {
        rawItems = await queryFn(trimmed, { viewerScope, limit: safeLimit })
      } catch {
        // Fault-isolated: unreachable external sidecar (e.g. Graphiti) degrades gracefully
        continue
      }
      if (!Array.isArray(rawItems)) continue

      for (const item of rawItems) {
        if (!item || typeof item !== 'object') continue
        const recordScope = item.scope ?? defaultScope
        // Zero-trust ScopeGate post-filter on every external memory item
        if (!canScopeAccess(viewerScope, recordScope)) continue

        const text = String(
          item.text ?? item.summary ?? item.content ?? item.fact ?? item.title ?? ''
        ).trim()
        if (!text) continue

        const dedupKey = `${recordScope}::${item.id ?? text}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)

        collected.push({
          ...item,
          provider: name,
          scope: recordScope,
          text,
        })
        if (collected.length >= safeLimit) break
      }
      if (collected.length >= safeLimit) break
    }

    return collected.slice(0, safeLimit)
  }

  function resolveSeedFilePath(sessionJsonPath) {
    const raw = String(sessionJsonPath ?? '').trim()
    if (!raw) return null
    if (isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
      return raw
    }
    if (dshHome) {
      const filename = raw.endsWith('.json') ? raw : `${raw}.json`
      return join(dshHome, 'fish-memory', filename)
    }
    return raw
  }

  function processFishMemoryRawContent(
    rawContent,
    { ownerId = 'qq:1024162823', scope } = {}
  ) {
    const normalizedOwnerId = String(ownerId || 'qq:1024162823').trim()
    const targetScope = scope ?? `private:${normalizedOwnerId}`
    assertValidScopeId(targetScope, 'scope')
    if (isGroupScope(targetScope)) {
      const err = new Error(
        `ScopeGate violation: refusing to import private dsh-fish-memory seeds into group scope (${targetScope})`
      )
      err.code = 'ERR_SCOPE_GATE'
      throw err
    }

    let parsed
    try {
      parsed = JSON.parse(String(rawContent))
    } catch {
      return {
        importedCount: 0,
        skippedCount: 0,
        scope: targetScope,
        facts: [],
        episodeIds: [],
        missing: false,
        invalidJson: true,
      }
    }

    const rawList = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.memories)
        ? parsed.memories
        : Array.isArray(parsed?.items)
          ? parsed.items
          : []

    const facts = []
    const seenFacts = new Set()
    const episodeIds = []
    let skippedCount = 0

    for (const entry of rawList) {
      if (isExcludedFishMemoryEntry(entry)) {
        skippedCount++
        continue
      }
      const text = extractFishMemoryText(entry)
      if (!text || seenFacts.has(text)) {
        skippedCount++
        continue
      }
      seenFacts.add(text)
      facts.push(text)

      if (store?.saveEpisode) {
        const episodeId = buildDeterministicSeedEpisodeId(entry, text)
        const mentioned =
          store.resolveParticipantsInText?.(text, { viewerScope: targetScope }) ?? []
        const participantIds = Array.from(
          new Set([normalizedOwnerId, ...mentioned.map((p) => p.participantId)])
        )
        const createdAt = Number.isFinite(entry.createdAt ?? entry.timestamp ?? entry['时间'])
          ? Number(entry.createdAt ?? entry.timestamp ?? entry['时间'])
          : undefined

        const ep = store.saveEpisode({
          episodeId,
          sessionId: String(parsed?.sessionId ?? ''),
          scope: targetScope,
          title: String(entry.key ?? entry['键'] ?? text.slice(0, 24)).trim() || '长期记忆',
          summary: text,
          indexLine: text.slice(0, 60),
          participantIds,
          isHighlight: false,
          occurredAt: createdAt,
          createdAt,
        })
        episodeIds.push(ep.episodeId)
      }
    }

    if (facts.length > 0 && store?.upsertParticipant) {
      store.upsertParticipant({
        participantId: normalizedOwnerId,
        facts,
        scope: targetScope,
        trust: 'owner_curated',
      })
    }

    return {
      importedCount: facts.length,
      skippedCount,
      scope: targetScope,
      facts,
      episodeIds,
      missing: false,
    }
  }

  function emptyMissingResult(ownerId = 'qq:1024162823', scope) {
    const normalizedOwnerId = String(ownerId || 'qq:1024162823').trim()
    const targetScope = scope ?? `private:${normalizedOwnerId}`
    return {
      importedCount: 0,
      skippedCount: 0,
      scope: targetScope,
      facts: [],
      episodeIds: [],
      missing: true,
    }
  }

  function importFishMemorySeeds(
    sessionJsonPath,
    { ownerId = 'qq:1024162823', scope } = {}
  ) {
    const resolvedPath = resolveSeedFilePath(sessionJsonPath)
    if (!resolvedPath) {
      return emptyMissingResult(ownerId, scope)
    }

    // Validate target scope upfront even if file is missing so illegal group imports always fail fast
    const normalizedOwnerId = String(ownerId || 'qq:1024162823').trim()
    const targetScope = scope ?? `private:${normalizedOwnerId}`
    assertValidScopeId(targetScope, 'scope')
    if (isGroupScope(targetScope)) {
      const err = new Error(
        `ScopeGate violation: refusing to import private dsh-fish-memory seeds into group scope (${targetScope})`
      )
      err.code = 'ERR_SCOPE_GATE'
      throw err
    }

    let rawOrPromise
    try {
      rawOrPromise = readFile(resolvedPath)
    } catch {
      return emptyMissingResult(ownerId, scope)
    }

    if (rawOrPromise && typeof rawOrPromise.then === 'function') {
      return rawOrPromise.then(
        (raw) => processFishMemoryRawContent(raw, { ownerId, scope }),
        () => emptyMissingResult(ownerId, scope)
      )
    }

    return processFishMemoryRawContent(rawOrPromise, { ownerId, scope })
  }

  return {
    registerProvider,
    listProviders,
    queryExternal,
    importFishMemorySeeds,
  }
}
