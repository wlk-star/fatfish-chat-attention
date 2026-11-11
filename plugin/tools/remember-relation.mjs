import { extractSessionIdFromExec } from './focus-attention.mjs'

/**
 * `remember_relation` tool — DSH `@deepseek-ai/dsh-tools` `defineTool` compliant with plain-object fallback.
 *
 * Enforces strict `TrustLevel` & `ScopeGate` anti-poisoning rules:
 * - In `private:<ownerId>` (owner private chat): writes `'owner_curated'`; if `publicSafe === true`,
 *   writes to `'public_roster'` so group chat recognizes public family/kin (e.g. `'源弟弟'`).
 * - In `group:*`: NEVER writes `'public_roster'`, NEVER overwrites `'owner_curated'`, and caps trust at
 *   `'fish_observed'` (or `'self_claimed_tentative'` for unverified kinship/authority/external claims).
 */

const KINSHIP_OR_AUTHORITY_CLAIM_RE =
  /爸爸|老爸|亲爹|主人|家长|亲哥|亲弟|亲姐|亲妹|源弟弟|源天帝|老公|老婆|对象|老板|上司/u

function normalizeParticipantId(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return ''
  if (/^\d{5,15}$/.test(trimmed)) return `qq:${trimmed}`
  return trimmed
}

function isValidViewerScope(scope) {
  return (
    typeof scope === 'string' &&
    ((scope.startsWith('private:') && scope.length > 'private:'.length) ||
      (scope.startsWith('group:') && scope.length > 'group:'.length))
  )
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
        if (safeArgs[reqKey] === undefined || safeArgs[reqKey] === null || String(safeArgs[reqKey]).trim() === '') {
          throw new Error(`Missing required argument: ${reqKey}`)
        }
      }
      return spec.execute(safeArgs, exec)
    },
  }
}

function classifyGroupTrust({
  participantId,
  relatedParticipantId,
  preferredCall,
  alias,
  fact,
  relation,
  ownerId,
  existingParticipant,
  existingRelated,
}) {
  if (participantId === ownerId || relatedParticipantId === ownerId) {
    return 'self_claimed_tentative'
  }
  if (
    existingParticipant?.trust === 'owner_curated' ||
    existingRelated?.trust === 'owner_curated'
  ) {
    return 'self_claimed_tentative'
  }
  const combinedText = [preferredCall, alias, fact, relation].filter(Boolean).join(' ')
  if (KINSHIP_OR_AUTHORITY_CLAIM_RE.test(combinedText)) {
    return 'self_claimed_tentative'
  }
  // If relating to an external third-party participant never seen in the group or public roster
  if (relatedParticipantId && !existingRelated) {
    return 'self_claimed_tentative'
  }
  return 'fish_observed'
}

export function createRememberRelationTool({
  defineTool,
  z: _z,
  store,
  resolveSessionScope,
  ownerId = 'qq:1024162823',
} = {}) {
  const normalizedOwnerId = normalizeParticipantId(ownerId) || 'qq:1024162823'
  const ownerPrivateScope = `private:${normalizedOwnerId}`

  const spec = {
    name: 'remember_relation',
    description:
      '安静记录人物称呼、外号、画像事实或两人之间的人际关系（严格遵守群聊/私聊权限与信任等级，记完后无需在回复里汇报“我记住了”）。',
    parameters: {
      participantId: {
        type: 'string',
        required: true,
        description: '目标人物唯一标识（如 qq:616860663）。',
      },
      preferredCall: {
        type: 'string',
        description: '蓝蓝对该人物的自然称呼（如 爸爸、源弟弟）。',
      },
      alias: {
        type: 'string',
        description: '该人物常用的群昵称或外号（如 源天帝）。',
      },
      fact: {
        type: 'string',
        description: '关于该人物的一条简短相处事实或特征（一句话一事）。',
      },
      relatedParticipantId: {
        type: 'string',
        description: '与该人物存在关系的另一位人物 ID（如 qq:1024162823）。',
      },
      relation: {
        type: 'string',
        description: '两人之间的关系描述（如 亲兄弟、室友、球友）。',
      },
      publicSafe: {
        type: 'boolean',
        description: '仅主人私聊可用：该称呼或关系是否允许同步到公开名册供群聊认人。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          blocked: { type: 'boolean' },
          scope: { type: 'string' },
          trust: { type: 'string' },
          participantId: { type: 'string' },
          edgeId: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        if (value && value.ok === false) {
          return [{ type: 'text', text: `✗ ${String(value.message || '未记录')}` }]
        }
        return [{ type: 'text', text: '✓' }]
      },
    },
    async execute(args = {}, exec = {}) {
      const sessionId = extractSessionIdFromExec(exec)
      const viewerScope = resolveViewerScope(resolveSessionScope, exec, sessionId)
      if (!isValidViewerScope(viewerScope)) {
        return {
          ok: false,
          blocked: true,
          message: '无法确认当前会话作用域（ScopeGate 拒绝写入）。',
        }
      }

      const participantId = normalizeParticipantId(args.participantId)
      if (!participantId) {
        return {
          ok: false,
          blocked: true,
          scope: viewerScope,
          message: '缺少有效的 participantId。',
        }
      }

      const preferredCall = typeof args.preferredCall === 'string' ? args.preferredCall.trim() : ''
      const alias = typeof args.alias === 'string' ? args.alias.trim() : ''
      const fact = typeof args.fact === 'string' ? args.fact.trim() : ''
      const relatedParticipantId = normalizeParticipantId(args.relatedParticipantId)
      const relation = typeof args.relation === 'string' ? args.relation.trim() : ''
      const publicSafe = args.publicSafe === true

      if (!preferredCall && !alias && !fact && !(relatedParticipantId && relation)) {
        return {
          ok: false,
          blocked: false,
          scope: viewerScope,
          participantId,
          message: '未提供需要记录的称呼、事实或关系内容。',
        }
      }

      const isOwnerPrivate = viewerScope === ownerPrivateScope
      const isGroup = viewerScope.startsWith('group:')

      const existingParticipant = store?.getParticipant?.(participantId, { viewerScope }) ?? null
      const existingRelated = relatedParticipantId
        ? (store?.getParticipant?.(relatedParticipantId, { viewerScope }) ?? null)
        : null

      let targetScope = viewerScope
      let trust = 'fish_observed'

      if (isOwnerPrivate) {
        trust = 'owner_curated'
        targetScope = publicSafe ? 'public_roster' : ownerPrivateScope
      } else if (isGroup) {
        // Group callers can NEVER write to `public_roster` even if `publicSafe: true` was passed
        targetScope = viewerScope
        trust = classifyGroupTrust({
          participantId,
          relatedParticipantId,
          preferredCall,
          alias,
          fact,
          relation,
          ownerId: normalizedOwnerId,
          existingParticipant,
          existingRelated,
        })

        // Guard: group chat cannot overwrite an `owner_curated` participant's preferredCall without other group facts
        const tryingToOverwriteCuratedCall =
          Boolean(preferredCall) &&
          existingParticipant?.trust === 'owner_curated' &&
          preferredCall !== existingParticipant.preferredCall

        if (tryingToOverwriteCuratedCall && !alias && !fact && !(relatedParticipantId && relation)) {
          return {
            ok: false,
            blocked: true,
            scope: targetScope,
            trust,
            participantId,
            message: '该人物的核心称呼已由主人私聊确认（owner_curated），群聊侧不可覆盖。',
          }
        }
      } else {
        targetScope = viewerScope
        trust = 'fish_observed'
      }

      // Upsert Participant if any participant-level attributes were provided (or ensure participant exists)
      const safePreferredCall =
        !isOwnerPrivate && existingParticipant?.trust === 'owner_curated'
          ? undefined
          : preferredCall || undefined

      if (safePreferredCall || alias || fact || !existingParticipant) {
        store?.upsertParticipant?.({
          participantId,
          ...(safePreferredCall ? { preferredCall: safePreferredCall } : {}),
          ...(alias ? { aliases: [alias] } : {}),
          ...(fact ? { facts: [fact] } : {}),
          scope: targetScope,
          writerScope: viewerScope,
          trust,
        })
      }

      // Upsert RelationEdge if `relatedParticipantId` & `relation` were provided
      let edgeId = ''
      if (relatedParticipantId && relation) {
        if (relatedParticipantId === participantId) {
          return {
            ok: false,
            blocked: true,
            scope: targetScope,
            trust,
            participantId,
            message: '关系边两端不能是同一个人。',
          }
        }

        // Extra defensive check in case store is a lightweight mock without built-in owner_curated edge protection
        if (!isOwnerPrivate && typeof store?.getCohortRelations === 'function') {
          const currentEdges =
            store.getCohortRelations([participantId, relatedParticipantId], { viewerScope }) ?? []
          const curatedPairEdge = currentEdges.find((e) => {
            if (e?.trust !== 'owner_curated' || e?.status === 'historical') return false
            const ids = e.participantIds ?? e.participants ?? [e.participantA, e.participantB]
            return Array.isArray(ids) && ids.includes(participantId) && ids.includes(relatedParticipantId)
          })
          if (curatedPairEdge) {
            return {
              ok: false,
              blocked: true,
              scope: targetScope,
              trust,
              participantId,
              message: '两人关系已由主人确认（owner_curated），群聊侧不可覆盖。',
            }
          }
        }

        const edgeResult = store?.upsertRelationEdge?.({
          participantIds: [participantId, relatedParticipantId],
          participants: [participantId, relatedParticipantId],
          relation,
          scope: targetScope,
          writerScope: viewerScope,
          trust,
          status: 'active',
        })

        if (edgeResult?.blocked) {
          return {
            ok: false,
            blocked: true,
            scope: targetScope,
            trust,
            participantId,
            message: '高可信关系（owner_curated）受保护，拒绝覆盖。',
          }
        }
        edgeId = String(edgeResult?.edgeId ?? '')
      }

      return {
        ok: true,
        blocked: false,
        scope: targetScope,
        trust,
        participantId,
        ...(edgeId ? { edgeId } : {}),
        message: `已记录关系记忆（scope=${targetScope}, trust=${trust}）`,
      }
    },
  }

  return buildToolWithFallback(defineTool, spec)
}
