import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  PUBLIC_ROSTER_SCOPE,
  canScopeAccess,
  isGroupScope,
  isPrivateScope,
  isValidScopeId,
  normalizeStringList,
  sanitizeCareBiasTone,
  trustRank,
  validateEpisodeInput,
  validateParticipantInput,
  validateRelationEdgeInput,
  validateTopicInput,
} from './schema.mjs'
import { buildFtsMatchQuery, extractKeywords, tokenizeForFts } from './tokenizer.mjs'

const DEFAULT_CARE_BIAS_TTL_MS = 6 * 60 * 60 * 1000

function safeParseJson(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchTermInText(normText, rawTerm) {
  if (!rawTerm) return null
  const term = String(rawTerm).normalize('NFKC').trim().toLowerCase()
  if (!term) return null

  const qqMatch = /^qq:(\d+)$/.exec(term)
  if (qqMatch) {
    const re = new RegExp(`qq:\\s*${escapeRegExp(qqMatch[1])}(?!\\d)`, 'i')
    return re.test(normText) ? rawTerm : null
  }

  if (/^[a-z0-9_]+$/.test(term)) {
    const re = new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(term)}(?:$|[^a-z0-9_])`, 'i')
    return re.test(normText) ? rawTerm : null
  }

  return normText.includes(term) ? rawTerm : null
}

function buildSqlScopeFilter(viewerScope, columnName = 'scope') {
  if (viewerScope === PUBLIC_ROSTER_SCOPE) {
    return { clause: `${columnName} = ?`, params: [PUBLIC_ROSTER_SCOPE] }
  }
  if (isGroupScope(viewerScope)) {
    return {
      clause: `(${columnName} = ? OR ${columnName} = ?)`,
      params: [PUBLIC_ROSTER_SCOPE, viewerScope],
    }
  }
  if (isPrivateScope(viewerScope)) {
    return {
      clause: `(${columnName} = ? OR ${columnName} = ? OR ${columnName} LIKE 'group:%')`,
      params: [PUBLIC_ROSTER_SCOPE, viewerScope],
    }
  }
  return { clause: '1 = 0', params: [] }
}

function rowToParticipant(row) {
  return {
    participantId: row.participant_id,
    preferredCall: row.preferred_call ?? null,
    nickname: row.nickname ?? null,
    aliases: safeParseJson(row.aliases_json, []),
    roleToFish: row.role_to_fish || 'member',
    facts: safeParseJson(row.facts_json, []),
    notes: row.notes ?? null,
    metadata: safeParseJson(row.metadata_json, {}),
    trust: row.trust,
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mergeVisibleParticipantRows(rows, viewerScope) {
  if (!rows || rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => {
    const tDiff = trustRank(b.trust) - trustRank(a.trust)
    if (tDiff !== 0) return tDiff
    const scopeScore = (s) => (s === viewerScope ? 3 : s === PUBLIC_ROSTER_SCOPE ? 2 : 1)
    const sDiff = scopeScore(b.scope) - scopeScore(a.scope)
    if (sDiff !== 0) return sDiff
    return b.updated_at - a.updated_at
  })

  const parsed = sorted.map(rowToParticipant)
  const top = parsed[0]
  const exactScopeEntry = parsed.find((p) => p.scope === viewerScope)

  const preferredCall = parsed.find((p) => p.preferredCall)?.preferredCall ?? null
  const nickname =
    exactScopeEntry?.nickname ?? parsed.find((p) => p.nickname)?.nickname ?? null
  const roleEntry = parsed.find((p) => p.roleToFish && p.roleToFish !== 'member')
  const roleToFish = roleEntry?.roleToFish ?? top.roleToFish ?? 'member'

  const aliases = normalizeStringList(parsed.flatMap((p) => p.aliases))
  const facts = normalizeStringList(parsed.flatMap((p) => p.facts))
  const distinctNotes = normalizeStringList(
    parsed.map((p) => p.notes).filter(Boolean)
  )
  const notes = distinctNotes.length > 0 ? distinctNotes.join('；') : null

  const metadata = {}
  for (let i = parsed.length - 1; i >= 0; i--) {
    Object.assign(metadata, parsed[i].metadata)
  }

  return {
    participantId: top.participantId,
    preferredCall,
    nickname,
    aliases,
    roleToFish,
    facts,
    notes,
    metadata,
    trust: top.trust,
    scope: top.scope,
    scopes: normalizeStringList(parsed.map((p) => p.scope)),
    createdAt: Math.min(...parsed.map((p) => p.createdAt)),
    updatedAt: Math.max(...parsed.map((p) => p.updatedAt)),
  }
}

function rowToRelationEdge(row) {
  const participantIds = safeParseJson(row.participant_ids_json, [
    row.participant_a,
    row.participant_b,
  ])
  return {
    edgeId: row.edge_id,
    participantIds,
    participants: participantIds,
    participantA: row.participant_a,
    participantB: row.participant_b,
    relation: row.relation,
    relationType: row.relation_type || 'social',
    closeness: row.closeness ?? null,
    notes: row.notes ?? null,
    trust: row.trust,
    scope: row.scope,
    status: row.status,
    validAt: row.valid_at,
    invalidAt: row.invalid_at ?? null,
    supersededBy: row.superseded_by ?? null,
    sourceEpisodeId: row.source_episode_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTopic(row) {
  const startSeq = row.start_seq ?? null
  const endSeq = row.end_seq ?? null
  const episodeId = row.episode_id ?? null
  return {
    id: row.topic_id,
    topicId: row.topic_id,
    sessionId: row.session_id,
    scope: row.scope,
    title: row.title,
    summary: row.summary || '',
    status: row.status,
    keywords: safeParseJson(row.keywords_json, []),
    openLoops: safeParseJson(row.open_loops_json, []),
    openQuestion: row.open_question ?? null,
    warmUntil: row.warm_until ?? null,
    cohort: safeParseJson(row.cohort_json, {}),
    participantIds: safeParseJson(row.participant_ids_json, []),
    messageIds: safeParseJson(row.message_ids_json, []),
    anchorMessageId: row.anchor_message_id ?? null,
    lastMessageId: row.last_message_id ?? null,
    startSeq,
    endSeq,
    seqRange: startSeq !== null && endSeq !== null ? [startSeq, endSeq] : null,
    episodeId,
    crystallizedEpisodeId: episodeId,
    invalidatedByRewind: Boolean(row.invalidated_by_rewind),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  }
}

function rowToEpisode(row) {
  const startSeq = row.start_seq ?? null
  const endSeq = row.end_seq ?? null
  const participantIds = safeParseJson(row.participant_ids_json, [])
  return {
    id: row.episode_id,
    episodeId: row.episode_id,
    sessionId: row.session_id || '',
    topicId: row.topic_id ?? null,
    scope: row.scope,
    title: row.title,
    summary: row.summary || '',
    indexLine: row.index_line || row.title,
    participantIds,
    participants: participantIds,
    keywords: safeParseJson(row.keywords_json, []),
    openLoops: safeParseJson(row.open_loops_json, []),
    highlights: safeParseJson(row.highlights_json, []),
    moodSlice: safeParseJson(row.mood_slice_json, null),
    startSeq,
    endSeq,
    seqRange: startSeq !== null && endSeq !== null ? [startSeq, endSeq] : null,
    isHighlight: Boolean(row.is_highlight),
    invalidatedByRewind: Boolean(row.invalidated_by_rewind),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function createRelationalStore({ dbPath = ':memory:', now = Date.now } = {}) {
  if (dbPath && dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  const db = new DatabaseSync(dbPath)
  let closed = false
  let txDepth = 0

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS participants (
      participant_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      preferred_call TEXT,
      nickname TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      role_to_fish TEXT NOT NULL DEFAULT 'member',
      facts_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      trust TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (participant_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_scope ON participants(scope);

    CREATE TABLE IF NOT EXISTS relation_edges (
      edge_id TEXT PRIMARY KEY,
      pair_key TEXT NOT NULL,
      participant_a TEXT NOT NULL,
      participant_b TEXT NOT NULL,
      participant_ids_json TEXT NOT NULL,
      relation TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'social',
      closeness REAL,
      notes TEXT,
      trust TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      valid_at INTEGER NOT NULL,
      invalid_at INTEGER,
      superseded_by TEXT,
      source_episode_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relation_pair_scope_status
      ON relation_edges(pair_key, scope, status);
    CREATE INDEX IF NOT EXISTS idx_relation_participants_status
      ON relation_edges(participant_a, participant_b, status);
    CREATE INDEX IF NOT EXISTS idx_relation_scope_status
      ON relation_edges(scope, status);

    CREATE TABLE IF NOT EXISTS topics (
      topic_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'focused',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      open_loops_json TEXT NOT NULL DEFAULT '[]',
      open_question TEXT,
      warm_until INTEGER,
      cohort_json TEXT NOT NULL DEFAULT '{}',
      participant_ids_json TEXT NOT NULL DEFAULT '[]',
      message_ids_json TEXT NOT NULL DEFAULT '[]',
      anchor_message_id TEXT,
      last_message_id TEXT,
      start_seq INTEGER,
      end_seq INTEGER,
      episode_id TEXT,
      invalidated_by_rewind INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_topics_session_status
      ON topics(session_id, status, last_active_at DESC);
    CREATE INDEX IF NOT EXISTS idx_topics_scope_status
      ON topics(scope, status, last_active_at DESC);

    CREATE TABLE IF NOT EXISTS shared_episodes (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL DEFAULT '',
      topic_id TEXT,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      index_line TEXT NOT NULL DEFAULT '',
      participant_ids_json TEXT NOT NULL DEFAULT '[]',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      open_loops_json TEXT NOT NULL DEFAULT '[]',
      highlights_json TEXT NOT NULL DEFAULT '[]',
      mood_slice_json TEXT,
      start_seq INTEGER,
      end_seq INTEGER,
      is_highlight INTEGER NOT NULL DEFAULT 1,
      invalidated_by_rewind INTEGER NOT NULL DEFAULT 0,
      occurred_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_scope_occurred
      ON shared_episodes(scope, invalidated_by_rewind, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodes_session_seq
      ON shared_episodes(session_id, start_seq, end_seq);

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      episode_id UNINDEXED,
      title_tokens,
      body_tokens
    );

    CREATE TABLE IF NOT EXISTS care_biases (
      participant_id TEXT PRIMARY KEY,
      tone TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  function inTransaction(fn) {
    const level = txDepth
    const spName = `sp_${level}`
    if (level === 0) {
      db.exec('BEGIN IMMEDIATE')
    } else {
      db.exec(`SAVEPOINT ${spName}`)
    }
    txDepth++
    try {
      const result = fn()
      txDepth--
      if (level === 0) {
        db.exec('COMMIT')
      } else {
        db.exec(`RELEASE SAVEPOINT ${spName}`)
      }
      return result
    } catch (err) {
      txDepth--
      if (level === 0) {
        try {
          db.exec('ROLLBACK')
        } catch {}
      } else {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${spName}`)
          db.exec(`RELEASE SAVEPOINT ${spName}`)
        } catch {}
      }
      throw err
    }
  }

  const stmts = {
    getParticipantExact: db.prepare(
      'SELECT * FROM participants WHERE participant_id = ? AND scope = ?'
    ),
    getParticipantAllScopes: db.prepare(
      'SELECT * FROM participants WHERE participant_id = ?'
    ),
    getAllPublicCuratedParticipants: db.prepare(
      `SELECT * FROM participants WHERE scope = 'public_roster' AND trust = 'owner_curated'`
    ),
    upsertParticipantRow: db.prepare(`
      INSERT INTO participants (
        participant_id, scope, preferred_call, nickname, aliases_json,
        role_to_fish, facts_json, notes, trust, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(participant_id, scope) DO UPDATE SET
        preferred_call = excluded.preferred_call,
        nickname = excluded.nickname,
        aliases_json = excluded.aliases_json,
        role_to_fish = excluded.role_to_fish,
        facts_json = excluded.facts_json,
        notes = excluded.notes,
        trust = excluded.trust,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `),
    getActiveEdgesByPair: db.prepare(
      `SELECT * FROM relation_edges WHERE pair_key = ? AND status = 'active'`
    ),
    getEdgeById: db.prepare('SELECT * FROM relation_edges WHERE edge_id = ?'),
    supersedeEdge: db.prepare(`
      UPDATE relation_edges
      SET status = 'historical', invalid_at = ?, superseded_by = ?, updated_at = ?
      WHERE edge_id = ?
    `),
    touchEdge: db.prepare(`
      UPDATE relation_edges
      SET closeness = COALESCE(?, closeness),
          notes = COALESCE(?, notes),
          updated_at = ?
      WHERE edge_id = ?
    `),
    insertEdge: db.prepare(`
      INSERT INTO relation_edges (
        edge_id, pair_key, participant_a, participant_b, participant_ids_json,
        relation, relation_type, closeness, notes, trust, scope, status,
        valid_at, invalid_at, superseded_by, source_episode_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getTopicById: db.prepare('SELECT * FROM topics WHERE topic_id = ?'),
    upsertTopicRow: db.prepare(`
      INSERT INTO topics (
        topic_id, session_id, scope, title, summary, status,
        keywords_json, open_loops_json, open_question, warm_until,
        cohort_json, participant_ids_json,
        message_ids_json, anchor_message_id, last_message_id,
        start_seq, end_seq, episode_id, invalidated_by_rewind,
        created_at, updated_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(topic_id) DO UPDATE SET
        session_id = excluded.session_id,
        scope = excluded.scope,
        title = excluded.title,
        summary = excluded.summary,
        status = excluded.status,
        keywords_json = excluded.keywords_json,
        open_loops_json = excluded.open_loops_json,
        open_question = excluded.open_question,
        warm_until = excluded.warm_until,
        cohort_json = excluded.cohort_json,
        participant_ids_json = excluded.participant_ids_json,
        message_ids_json = excluded.message_ids_json,
        anchor_message_id = excluded.anchor_message_id,
        last_message_id = excluded.last_message_id,
        start_seq = excluded.start_seq,
        end_seq = excluded.end_seq,
        episode_id = excluded.episode_id,
        invalidated_by_rewind = excluded.invalidated_by_rewind,
        updated_at = excluded.updated_at,
        last_active_at = excluded.last_active_at
    `),
    getEpisodeById: db.prepare('SELECT * FROM shared_episodes WHERE episode_id = ?'),
    insertEpisodeRow: db.prepare(`
      INSERT INTO shared_episodes (
        episode_id, session_id, topic_id, scope, title, summary, index_line,
        participant_ids_json, keywords_json, open_loops_json, highlights_json,
        mood_slice_json, start_seq, end_seq, is_highlight, invalidated_by_rewind,
        occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateEpisodeRow: db.prepare(`
      UPDATE shared_episodes SET
        session_id = ?,
        topic_id = ?,
        scope = ?,
        title = ?,
        summary = ?,
        index_line = ?,
        participant_ids_json = ?,
        keywords_json = ?,
        open_loops_json = ?,
        highlights_json = ?,
        mood_slice_json = ?,
        start_seq = ?,
        end_seq = ?,
        is_highlight = ?,
        invalidated_by_rewind = ?,
        occurred_at = ?,
        updated_at = ?
      WHERE episode_id = ?
    `),
    deleteEpisodeFts: db.prepare('DELETE FROM episodes_fts WHERE rowid = ?'),
    insertEpisodeFts: db.prepare(
      'INSERT INTO episodes_fts (rowid, episode_id, title_tokens, body_tokens) VALUES (?, ?, ?, ?)'
    ),
    getSessionEpisodesWithSeqs: db.prepare(`
      SELECT rowid, episode_id, start_seq, end_seq, invalidated_by_rewind
      FROM shared_episodes
      WHERE session_id = ? AND start_seq IS NOT NULL AND end_seq IS NOT NULL
    `),
    markEpisodeInvalidated: db.prepare(`
      UPDATE shared_episodes
      SET invalidated_by_rewind = 1, updated_at = ?
      WHERE episode_id = ?
    `),
    getSessionTopicsWithSeqs: db.prepare(`
      SELECT topic_id, start_seq, end_seq
      FROM topics
      WHERE session_id = ? AND start_seq IS NOT NULL AND end_seq IS NOT NULL AND invalidated_by_rewind = 0
    `),
    markTopicInvalidated: db.prepare(`
      UPDATE topics
      SET invalidated_by_rewind = 1, updated_at = ?
      WHERE topic_id = ?
    `),
    upsertCareBias: db.prepare(`
      INSERT INTO care_biases (participant_id, tone, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(participant_id) DO UPDATE SET
        tone = excluded.tone,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
    getCareBias: db.prepare('SELECT * FROM care_biases WHERE participant_id = ?'),
    deleteCareBias: db.prepare('DELETE FROM care_biases WHERE participant_id = ?'),
  }

  function collectReservedCuratedTerms(excludeParticipantId) {
    const reserved = new Set()
    const curatedRows = stmts.getAllPublicCuratedParticipants.all()
    for (const r of curatedRows) {
      if (r.participant_id === excludeParticipantId) continue
      if (r.preferred_call) reserved.add(r.preferred_call.normalize('NFKC').toLowerCase())
      for (const alias of safeParseJson(r.aliases_json, [])) {
        reserved.add(String(alias).normalize('NFKC').toLowerCase())
      }
    }
    return reserved
  }

  function upsertParticipant(input) {
    const validated = validateParticipantInput(input)
    const nowTs = Number(now())

    return inTransaction(() => {
      const existingRow = stmts.getParticipantExact.get(
        validated.participantId,
        validated.scope
      )
      const publicRow = stmts.getParticipantExact.get(
        validated.participantId,
        PUBLIC_ROSTER_SCOPE
      )
      const existing = existingRow ? rowToParticipant(existingRow) : null
      const publicCurated =
        publicRow && publicRow.trust === 'owner_curated'
          ? rowToParticipant(publicRow)
          : null

      const incomingRank = trustRank(validated.trust)
      const existingRank = existing ? trustRank(existing.trust) : 0
      const isDowngradeAttempt = existing && incomingRank < existingRank
      const hasHigherPublicCurated =
        publicCurated && incomingRank < trustRank('owner_curated')

      // Anti-poisoning: prevent non-curated callers from hijacking another owner_curated identity's call/aliases
      const reservedTerms =
        validated.trust !== 'owner_curated'
          ? collectReservedCuratedTerms(validated.participantId)
          : new Set()
      const isReserved = (term) =>
        term && reservedTerms.has(String(term).normalize('NFKC').trim().toLowerCase())

      let preferredCall = existing?.preferredCall ?? null
      if (!isDowngradeAttempt && !hasHigherPublicCurated && validated.preferredCall !== undefined) {
        if (!isReserved(validated.preferredCall)) {
          preferredCall = validated.preferredCall
        }
      }

      let roleToFish = existing?.roleToFish ?? 'member'
      if (!isDowngradeAttempt && !hasHigherPublicCurated && validated.roleToFish !== undefined) {
        roleToFish = validated.roleToFish
      }

      let nickname = existing?.nickname ?? null
      if (validated.nickname !== undefined && !isReserved(validated.nickname)) {
        nickname = validated.nickname
      }

      const filteredNewAliases = validated.aliases.filter((a) => !isReserved(a))
      const aliases =
        validated.replaceAliases && !isDowngradeAttempt
          ? filteredNewAliases
          : normalizeStringList([...(existing?.aliases ?? []), ...filteredNewAliases])

      const facts =
        validated.replaceFacts && !isDowngradeAttempt
          ? validated.facts
          : normalizeStringList([...(existing?.facts ?? []), ...validated.facts])

      const notes =
        validated.notes !== undefined ? validated.notes : (existing?.notes ?? null)

      const metadata = {
        ...(existing?.metadata ?? {}),
        ...(validated.metadata ?? {}),
      }

      const finalTrust =
        existing && existingRank > incomingRank ? existing.trust : validated.trust
      const createdAt = existing?.createdAt ?? nowTs

      stmts.upsertParticipantRow.run(
        validated.participantId,
        validated.scope,
        preferredCall,
        nickname,
        JSON.stringify(aliases),
        roleToFish,
        JSON.stringify(facts),
        notes,
        finalTrust,
        JSON.stringify(metadata),
        createdAt,
        nowTs
      )

      return rowToParticipant(
        stmts.getParticipantExact.get(validated.participantId, validated.scope)
      )
    })
  }

  function getParticipant(participantId, { viewerScope } = {}) {
    const id = String(participantId ?? '').trim()
    if (!id || !isValidScopeId(viewerScope)) return null
    const rows = stmts.getParticipantAllScopes
      .all(id)
      .filter((r) => canScopeAccess(viewerScope, r.scope))
    return mergeVisibleParticipantRows(rows, viewerScope)
  }

  function listParticipants({ viewerScope } = {}) {
    if (!isValidScopeId(viewerScope)) return []
    const { clause, params } = buildSqlScopeFilter(viewerScope, 'scope')
    const rows = db
      .prepare(`SELECT * FROM participants WHERE ${clause}`)
      .all(...params)
      .filter((r) => canScopeAccess(viewerScope, r.scope))

    const grouped = new Map()
    for (const row of rows) {
      const list = grouped.get(row.participant_id) ?? []
      list.push(row)
      grouped.set(row.participant_id, list)
    }

    const merged = []
    for (const groupRows of grouped.values()) {
      const p = mergeVisibleParticipantRows(groupRows, viewerScope)
      if (p) merged.push(p)
    }

    merged.sort((a, b) => {
      const tDiff = trustRank(b.trust) - trustRank(a.trust)
      if (tDiff !== 0) return tDiff
      return a.participantId.localeCompare(b.participantId)
    })
    return merged
  }

  function resolveParticipantsInText(text, { viewerScope } = {}) {
    if (!text || !isValidScopeId(viewerScope)) return []
    const normText = String(text).normalize('NFKC').toLowerCase()
    if (!normText.trim()) return []

    const participants = listParticipants({ viewerScope })
    const resolved = []

    for (const p of participants) {
      const sortedAliases = [...p.aliases].sort((a, b) => b.length - a.length)
      const candidates = [
        p.participantId,
        p.preferredCall,
        ...sortedAliases,
        p.nickname && p.nickname.length >= 2 ? p.nickname : null,
      ].filter(Boolean)

      let matchedBy = null
      for (const term of candidates) {
        const hit = matchTermInText(normText, term)
        if (hit) {
          matchedBy = hit
          break
        }
      }

      if (matchedBy) {
        resolved.push({ ...p, matchedBy })
      }
    }

    return resolved
  }

  function upsertRelationEdge(input) {
    const validated = validateRelationEdgeInput(input)
    const nowTs = Number(now())

    return inTransaction(() => {
      const activeForPair = stmts.getActiveEdgesByPair.all(validated.pairKey)
      const incomingRank = trustRank(validated.trust)

      // Anti-poisoning: group / lower-trust callers CANNOT overwrite or shadow an active owner_curated edge
      const curatedExisting = activeForPair.find(
        (r) =>
          r.trust === 'owner_curated' &&
          (r.scope === PUBLIC_ROSTER_SCOPE || r.scope === validated.scope)
      )
      if (curatedExisting && incomingRank < trustRank('owner_curated')) {
        return {
          ...rowToRelationEdge(curatedExisting),
          blocked: true,
          applied: false,
          reason: 'owner_curated_protected',
        }
      }

      const existingSameScope = activeForPair.find((r) => r.scope === validated.scope)

      if (existingSameScope) {
        const existingRank = trustRank(existingSameScope.trust)
        if (incomingRank < existingRank) {
          return {
            ...rowToRelationEdge(existingSameScope),
            blocked: true,
            applied: false,
            reason: 'higher_trust_exists',
          }
        }

        // Idempotent no-op when active relation & trust are unchanged
        if (
          existingSameScope.relation === validated.relation &&
          existingSameScope.trust === validated.trust &&
          validated.status === 'active'
        ) {
          stmts.touchEdge.run(
            validated.closeness,
            validated.notes,
            nowTs,
            existingSameScope.edge_id
          )
          return {
            ...rowToRelationEdge(stmts.getEdgeById.get(existingSameScope.edge_id)),
            blocked: false,
            applied: true,
            supersededEdgeId: null,
          }
        }

        // Bi-temporal superseding: retire old edge -> insert new active edge
        const validAt = validated.validAt ?? nowTs
        const newEdgeId =
          validated.edgeId ?? `rel_${randomUUID().replace(/-/g, '').slice(0, 16)}`

        stmts.supersedeEdge.run(
          validAt,
          newEdgeId,
          nowTs,
          existingSameScope.edge_id
        )

        stmts.insertEdge.run(
          newEdgeId,
          validated.pairKey,
          validated.participantA,
          validated.participantB,
          JSON.stringify(validated.participantIds),
          validated.relation,
          validated.relationType,
          validated.closeness,
          validated.notes,
          validated.trust,
          validated.scope,
          validated.status,
          validAt,
          validated.invalidAt,
          null,
          validated.sourceEpisodeId,
          nowTs,
          nowTs
        )

        return {
          ...rowToRelationEdge(stmts.getEdgeById.get(newEdgeId)),
          blocked: false,
          applied: true,
          supersededEdgeId: existingSameScope.edge_id,
        }
      }

      const validAt = validated.validAt ?? nowTs
      const edgeId =
        validated.edgeId ?? `rel_${randomUUID().replace(/-/g, '').slice(0, 16)}`

      stmts.insertEdge.run(
        edgeId,
        validated.pairKey,
        validated.participantA,
        validated.participantB,
        JSON.stringify(validated.participantIds),
        validated.relation,
        validated.relationType,
        validated.closeness,
        validated.notes,
        validated.trust,
        validated.scope,
        validated.status,
        validAt,
        validated.invalidAt,
        null,
        validated.sourceEpisodeId,
        nowTs,
        nowTs
      )

      return {
        ...rowToRelationEdge(stmts.getEdgeById.get(edgeId)),
        blocked: false,
        applied: true,
        supersededEdgeId: null,
      }
    })
  }

  function getCohortRelations(
    participantIds,
    { viewerScope, includeHistorical = false } = {}
  ) {
    if (!isValidScopeId(viewerScope)) return []
    const ids = normalizeStringList(participantIds)
    if (ids.length === 0) return []

    const idSet = new Set(ids)
    const placeholders = ids.map(() => '?').join(', ')
    const { clause: scopeClause, params: scopeParams } = buildSqlScopeFilter(
      viewerScope,
      'scope'
    )
    const statusClause = includeHistorical ? '1 = 1' : `status = 'active'`

    const rows = db
      .prepare(
        `SELECT * FROM relation_edges
         WHERE ${statusClause}
           AND ${scopeClause}
           AND (participant_a IN (${placeholders}) OR participant_b IN (${placeholders}))`
      )
      .all(...scopeParams, ...ids, ...ids)
      .filter((r) => canScopeAccess(viewerScope, r.scope))

    const filtered = rows.filter((r) => {
      if (ids.length === 1) return true
      return idSet.has(r.participant_a) && idSet.has(r.participant_b)
    })

    filtered.sort((a, b) => {
      const aBoth = idSet.has(a.participant_a) && idSet.has(a.participant_b) ? 1 : 0
      const bBoth = idSet.has(b.participant_a) && idSet.has(b.participant_b) ? 1 : 0
      if (bBoth !== aBoth) return bBoth - aBoth
      const statusDiff = (b.status === 'active' ? 1 : 0) - (a.status === 'active' ? 1 : 0)
      if (statusDiff !== 0) return statusDiff
      const tDiff = trustRank(b.trust) - trustRank(a.trust)
      if (tDiff !== 0) return tDiff
      return b.valid_at - a.valid_at
    })

    return filtered.map(rowToRelationEdge)
  }

  function listRelationEdges({
    participantId,
    participantIds,
    viewerScope,
    includeHistorical = true,
  } = {}) {
    if (!isValidScopeId(viewerScope)) return []
    const { clause: scopeClause, params: scopeParams } = buildSqlScopeFilter(
      viewerScope,
      'scope'
    )
    const statusClause = includeHistorical ? '1 = 1' : `status = 'active'`

    let sql = `SELECT * FROM relation_edges WHERE ${statusClause} AND ${scopeClause}`
    const params = [...scopeParams]

    if (Array.isArray(participantIds) && participantIds.length >= 2) {
      const sorted = [String(participantIds[0]).trim(), String(participantIds[1]).trim()].sort()
      sql += ' AND pair_key = ?'
      params.push(`${sorted[0]}|${sorted[1]}`)
    } else if (participantId) {
      const id = String(participantId).trim()
      sql += ' AND (participant_a = ? OR participant_b = ?)'
      params.push(id, id)
    }

    sql += ' ORDER BY valid_at DESC, created_at DESC'
    return db
      .prepare(sql)
      .all(...params)
      .filter((r) => canScopeAccess(viewerScope, r.scope))
      .map(rowToRelationEdge)
  }

  function seedDefaults({
    ownerId = 'qq:1024162823',
    brotherId = 'qq:616860663',
  } = {}) {
    return inTransaction(() => {
      const owner = upsertParticipant({
        participantId: ownerId,
        preferredCall: '爸爸',
        aliases: ['kk', '爸爸'],
        roleToFish: 'owner',
        trust: 'owner_curated',
        scope: PUBLIC_ROSTER_SCOPE,
      })

      const brother = upsertParticipant({
        participantId: brotherId,
        preferredCall: '源弟弟',
        aliases: ['源天帝'],
        roleToFish: 'owner_kin',
        trust: 'owner_curated',
        scope: PUBLIC_ROSTER_SCOPE,
      })

      const pairKey = [ownerId, brotherId].sort().join('|')
      const existingCurated = stmts.getActiveEdgesByPair
        .all(pairKey)
        .find(
          (r) => r.scope === PUBLIC_ROSTER_SCOPE && r.trust === 'owner_curated'
        )

      const relationEdge = existingCurated
        ? rowToRelationEdge(existingCurated)
        : upsertRelationEdge({
            participantIds: [ownerId, brotherId],
            relation: '亲兄弟（爸爸与源弟弟/源天帝）',
            scope: PUBLIC_ROSTER_SCOPE,
            trust: 'owner_curated',
          })

      return { owner, brother, relationEdge }
    })
  }

  function saveTopic(input) {
    const validated = validateTopicInput(input)
    const nowTs = Number(now())

    return inTransaction(() => {
      const topicId =
        validated.topicId ?? `topic_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      const existingRow = stmts.getTopicById.get(topicId)
      const existing = existingRow ? rowToTopic(existingRow) : null

      const keywords =
        validated.keywords ??
        extractKeywords(`${validated.title} ${validated.summary}`)
      const createdAt = validated.createdAt ?? existing?.createdAt ?? nowTs
      const updatedAt = validated.updatedAt ?? nowTs
      const lastActiveAt =
        validated.lastActiveAt ?? validated.updatedAt ?? existing?.lastActiveAt ?? nowTs

      stmts.upsertTopicRow.run(
        topicId,
        validated.sessionId,
        validated.scope,
        validated.title,
        validated.summary,
        validated.status,
        JSON.stringify(keywords),
        JSON.stringify(validated.openLoops),
        validated.openQuestion,
        validated.warmUntil,
        JSON.stringify(validated.cohort),
        JSON.stringify(validated.participantIds),
        JSON.stringify(validated.messageIds),
        validated.anchorMessageId,
        validated.lastMessageId,
        validated.startSeq,
        validated.endSeq,
        validated.episodeId,
        validated.invalidatedByRewind ? 1 : 0,
        createdAt,
        updatedAt,
        lastActiveAt
      )

      return rowToTopic(stmts.getTopicById.get(topicId))
    })
  }

  function getTopic(topicId, { viewerScope } = {}) {
    const id = String(topicId ?? '').trim()
    if (!id || !isValidScopeId(viewerScope)) return null
    const row = stmts.getTopicById.get(id)
    if (!row || !canScopeAccess(viewerScope, row.scope)) return null
    return rowToTopic(row)
  }

  function listTopics({
    sessionId,
    scope,
    statuses,
    status,
    viewerScope,
    includeInvalidated = false,
    limit = 20,
  } = {}) {
    if (!isValidScopeId(viewerScope)) return []
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20))
    const { clause: scopeClause, params: scopeParams } = buildSqlScopeFilter(
      viewerScope,
      'scope'
    )

    let sql = `SELECT * FROM topics WHERE ${scopeClause}`
    const params = [...scopeParams]

    if (!includeInvalidated) {
      sql += ' AND invalidated_by_rewind = 0'
    }
    if (sessionId) {
      sql += ' AND session_id = ?'
      params.push(String(sessionId).trim())
    }
    if (scope) {
      sql += ' AND scope = ?'
      params.push(String(scope).trim())
    }

    const statusList = Array.isArray(statuses)
      ? normalizeStringList(statuses)
      : status
        ? [String(status).trim()]
        : []
    if (statusList.length > 0) {
      sql += ` AND status IN (${statusList.map(() => '?').join(', ')})`
      params.push(...statusList)
    }

    sql += ' ORDER BY last_active_at DESC, updated_at DESC LIMIT ?'
    params.push(safeLimit)

    return db
      .prepare(sql)
      .all(...params)
      .filter((r) => canScopeAccess(viewerScope, r.scope))
      .map(rowToTopic)
  }

  function collectScopeSafeCustomAliases(scope) {
    // Only index public_roster + exact record scope aliases into FTS so zero private aliases ever enter group FTS rows!
    const { clause, params } = buildSqlScopeFilter(scope, 'scope')
    const rows = db.prepare(`SELECT preferred_call, aliases_json FROM participants WHERE ${clause}`).all(...params)
    const terms = []
    for (const r of rows) {
      if (r.preferred_call) terms.push(r.preferred_call)
      terms.push(...safeParseJson(r.aliases_json, []))
    }
    return normalizeStringList(terms)
  }

  function saveEpisode(input) {
    const validated = validateEpisodeInput(input)
    const nowTs = Number(now())

    return inTransaction(() => {
      const episodeId =
        validated.episodeId ?? `ep_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      const existingRow = stmts.getEpisodeById.get(episodeId)

      const customAliases = collectScopeSafeCustomAliases(validated.scope)
      const keywords =
        validated.keywords ??
        extractKeywords(
          `${validated.title} ${validated.summary} ${validated.indexLine}`,
          { customAliases }
        )

      const createdAt =
        validated.createdAt ?? existingRow?.created_at ?? nowTs
      const updatedAt = validated.updatedAt ?? nowTs
      const occurredAt =
        validated.occurredAt ?? existingRow?.occurred_at ?? createdAt

      let rowid
      if (existingRow) {
        rowid = existingRow.rowid
        stmts.updateEpisodeRow.run(
          validated.sessionId,
          validated.topicId,
          validated.scope,
          validated.title,
          validated.summary,
          validated.indexLine,
          JSON.stringify(validated.participantIds),
          JSON.stringify(keywords),
          JSON.stringify(validated.openLoops),
          JSON.stringify(validated.highlights),
          validated.moodSlice ? JSON.stringify(validated.moodSlice) : null,
          validated.startSeq,
          validated.endSeq,
          validated.isHighlight ? 1 : 0,
          validated.invalidatedByRewind ? 1 : 0,
          occurredAt,
          updatedAt,
          episodeId
        )
        stmts.deleteEpisodeFts.run(rowid)
      } else {
        const res = stmts.insertEpisodeRow.run(
          episodeId,
          validated.sessionId,
          validated.topicId,
          validated.scope,
          validated.title,
          validated.summary,
          validated.indexLine,
          JSON.stringify(validated.participantIds),
          JSON.stringify(keywords),
          JSON.stringify(validated.openLoops),
          JSON.stringify(validated.highlights),
          validated.moodSlice ? JSON.stringify(validated.moodSlice) : null,
          validated.startSeq,
          validated.endSeq,
          validated.isHighlight ? 1 : 0,
          validated.invalidatedByRewind ? 1 : 0,
          occurredAt,
          createdAt,
          updatedAt
        )
        rowid = Number(res.lastInsertRowid)
      }

      if (!validated.invalidatedByRewind) {
        const titleTokens = tokenizeForFts(validated.title, { customAliases })
        const bodySource = [
          validated.summary,
          validated.indexLine,
          keywords.join(' '),
          validated.openLoops.join(' '),
          validated.highlights.join(' '),
          validated.participantIds.join(' '),
        ]
          .filter(Boolean)
          .join(' ')
        const bodyTokens = tokenizeForFts(bodySource, { customAliases })
        stmts.insertEpisodeFts.run(rowid, episodeId, titleTokens, bodyTokens)
      }

      return rowToEpisode(stmts.getEpisodeById.get(episodeId))
    })
  }

  function getEpisode(
    episodeId,
    { viewerScope, excludeInvalidated = false } = {}
  ) {
    const id = String(episodeId ?? '').trim()
    if (!id || !isValidScopeId(viewerScope)) return null
    const row = stmts.getEpisodeById.get(id)
    if (!row || !canScopeAccess(viewerScope, row.scope)) return null
    if (excludeInvalidated && row.invalidated_by_rewind) return null
    return rowToEpisode(row)
  }

  function searchEpisodes(
    query,
    { viewerScope, participantId, limit = 5 } = {}
  ) {
    if (!isValidScopeId(viewerScope)) return []
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 5))
    const targetParticipant = participantId ? String(participantId).trim() : null
    const { clause: scopeClause, params: scopeParams } = buildSqlScopeFilter(
      viewerScope,
      'e.scope'
    )

    const trimmedQuery = String(query ?? '').trim()

    // Blank query fallback: list recent ScopeGate-visible episodes (optionally filtered by participantId)
    if (!trimmedQuery) {
      let sql = `
        SELECT e.* FROM shared_episodes e
        WHERE e.invalidated_by_rewind = 0
          AND ${scopeClause}
      `
      const params = [...scopeParams]
      if (targetParticipant) {
        sql += ' AND instr(e.participant_ids_json, ?) > 0'
        params.push(targetParticipant)
      }
      sql += ' ORDER BY e.occurred_at DESC, e.rowid DESC LIMIT ?'
      params.push(safeLimit * 3)

      return db
        .prepare(sql)
        .all(...params)
        .filter((r) => canScopeAccess(viewerScope, r.scope))
        .map(rowToEpisode)
        .filter((ep) =>
          targetParticipant ? ep.participantIds.includes(targetParticipant) : true
        )
        .slice(0, safeLimit)
    }

    const visibleParticipants = listParticipants({ viewerScope })
    const customAliases = normalizeStringList(
      visibleParticipants.flatMap((p) => [p.preferredCall, ...p.aliases].filter(Boolean))
    )
    const resolvedInQuery = resolveParticipantsInText(trimmedQuery, { viewerScope })
    const extraTokens = normalizeStringList(
      resolvedInQuery.flatMap((p) =>
        [p.participantId, p.preferredCall, ...p.aliases].filter(Boolean)
      )
    )

    const matchExpr = buildFtsMatchQuery(trimmedQuery, {
      customAliases,
      extraTokens,
    })
    if (!matchExpr) return []

    let sql = `
      SELECT e.*, bm25(episodes_fts, 0.0, 2.5, 1.0) AS rank_score
      FROM episodes_fts
      JOIN shared_episodes e ON e.rowid = episodes_fts.rowid
      WHERE episodes_fts MATCH ?
        AND e.invalidated_by_rewind = 0
        AND ${scopeClause}
    `
    const params = [matchExpr, ...scopeParams]
    if (targetParticipant) {
      sql += ' AND instr(e.participant_ids_json, ?) > 0'
      params.push(targetParticipant)
    }
    sql += ' ORDER BY rank_score ASC, e.occurred_at DESC, e.rowid DESC LIMIT ?'
    params.push(safeLimit * 3)

    const rows = db.prepare(sql).all(...params)
    return rows
      .filter((r) => canScopeAccess(viewerScope, r.scope))
      .map(rowToEpisode)
      .filter((ep) =>
        targetParticipant ? ep.participantIds.includes(targetParticipant) : true
      )
      .slice(0, safeLimit)
  }

  function listRecentGroupHighlights({
    groupId,
    viewerScope,
    sinceMs = 0,
    limit = 3,
  } = {}) {
    if (viewerScope !== undefined && !isValidScopeId(viewerScope)) {
      return []
    }
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 3))
    const minOccurredAt = Number.isFinite(sinceMs) ? Number(sinceMs) : 0

    let scopeSql
    let scopeParams
    if (groupId) {
      const gStr = String(groupId).trim()
      const targetGroupScope = gStr.startsWith('group:') ? gStr : `group:${gStr}`
      if (viewerScope && !canScopeAccess(viewerScope, targetGroupScope)) {
        return []
      }
      scopeSql = 'scope = ?'
      scopeParams = [targetGroupScope]
    } else {
      scopeSql = `scope LIKE 'group:%'`
      scopeParams = []
    }

    const rows = db
      .prepare(
        `SELECT * FROM shared_episodes
         WHERE ${scopeSql}
           AND invalidated_by_rewind = 0
           AND is_highlight = 1
           AND occurred_at >= ?
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(...scopeParams, minOccurredAt, safeLimit * 2)

    return rows
      .filter((r) =>
        viewerScope
          ? canScopeAccess(viewerScope, r.scope)
          : isGroupScope(r.scope)
      )
      .map(rowToEpisode)
      .slice(0, safeLimit)
  }

  function invalidateBySeqs(sessionId, seqs) {
    const sid = String(sessionId ?? '').trim()
    if (!sid || !seqs) return []

    const seqNumbers = []
    for (const item of seqs) {
      const n = Number(item)
      if (Number.isFinite(n)) seqNumbers.push(Math.trunc(n))
    }
    if (seqNumbers.length === 0) return []

    const nowTs = Number(now())
    return inTransaction(() => {
      const candidates = stmts.getSessionEpisodesWithSeqs.all(sid)
      const invalidatedIds = []

      for (const row of candidates) {
        const intersects = seqNumbers.some(
          (s) => s >= row.start_seq && s <= row.end_seq
        )
        if (!intersects) continue
        if (!row.invalidated_by_rewind) {
          stmts.markEpisodeInvalidated.run(nowTs, row.episode_id)
          stmts.deleteEpisodeFts.run(row.rowid)
        }
        invalidatedIds.push(row.episode_id)
      }

      const topicCandidates = stmts.getSessionTopicsWithSeqs.all(sid)
      for (const tRow of topicCandidates) {
        const intersects = seqNumbers.some(
          (s) => s >= tRow.start_seq && s <= tRow.end_seq
        )
        if (intersects) {
          stmts.markTopicInvalidated.run(nowTs, tRow.topic_id)
        }
      }

      return invalidatedIds
    })
  }

  function setCareBias(participantIdOrInput, options = {}) {
    const input =
      participantIdOrInput && typeof participantIdOrInput === 'object'
        ? participantIdOrInput
        : { ...options, participantId: participantIdOrInput }

    const participantId = String(input.participantId ?? '').trim()
    if (!participantId) {
      throw new TypeError('setCareBias requires a non-empty participantId')
    }

    const tone = sanitizeCareBiasTone(input.tone)
    if (!tone) {
      stmts.deleteCareBias.run(participantId)
      return null
    }

    const nowTs = Number(now())
    const expiresAt = Number.isFinite(input.expiresAt)
      ? Number(input.expiresAt)
      : Number.isFinite(input.ttlMs)
        ? nowTs + Number(input.ttlMs)
        : nowTs + DEFAULT_CARE_BIAS_TTL_MS

    stmts.upsertCareBias.run(participantId, tone, expiresAt, nowTs)
    return {
      participantId,
      tone,
      expiresAt,
      updatedAt: nowTs,
    }
  }

  function getCareBias(participantId, nowMs = now()) {
    const id = String(participantId ?? '').trim()
    if (!id) return null
    const row = stmts.getCareBias.get(id)
    if (!row) return null
    const checkTs = Number.isFinite(nowMs) ? Number(nowMs) : Number(now())
    if (row.expires_at <= checkTs) {
      stmts.deleteCareBias.run(id)
      return null
    }
    return {
      participantId: row.participant_id,
      tone: row.tone,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    }
  }

  function close() {
    if (!closed) {
      closed = true
      db.close()
    }
  }

  return {
    seedDefaults,
    upsertParticipant,
    getParticipant,
    listParticipants,
    resolveParticipantsInText,
    upsertRelationEdge,
    getCohortRelations,
    listRelationEdges,
    saveTopic,
    getTopic,
    listTopics,
    saveEpisode,
    getEpisode,
    searchEpisodes,
    listRecentGroupHighlights,
    invalidateBySeqs,
    setCareBias,
    getCareBias,
    close,
  }
}
