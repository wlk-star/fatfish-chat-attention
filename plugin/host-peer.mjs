import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ALLOWED_EXACT_PEERS = new Set(['zod'])

function isAllowedPeer(name) {
  return (
    typeof name === 'string' &&
    (name.startsWith('@deepseek-ai/') || ALLOWED_EXACT_PEERS.has(name))
  )
}

function buildCandidateRequires() {
  const candidates = []
  const packaged = join(
    dirname(process.execPath),
    'resources',
    'app.asar',
    'dsh',
    'package.json',
  )
  if (existsSync(packaged)) {
    candidates.push(createRequire(packaged))
  }
  if (process.env.DSH_SOURCES_DIR) {
    const sourcesPkg = join(process.env.DSH_SOURCES_DIR, 'package.json')
    if (existsSync(sourcesPkg)) {
      candidates.push(createRequire(sourcesPkg))
    }
  }
  candidates.push(createRequire(import.meta.url))
  return candidates
}

/**
 * Resolve DSH's own peer instance, including its packaged Electron runtime (`app.asar`).
 * Never called at module top-level so plain Node offline imports succeed without `app.asar`.
 */
export async function loadHostPeer(name) {
  if (!isAllowedPeer(name)) {
    throw new Error(`Only DSH peer packages or 'zod' are allowed (got: ${name})`)
  }
  let lastErr = null
  for (const req of buildCandidateRequires()) {
    try {
      const resolved = req.resolve(name)
      return await import(pathToFileURL(resolved).href)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new Error(`Unable to resolve host peer: ${name}`)
}

export async function tryLoadHostPeer(name) {
  try {
    return await loadHostPeer(name)
  } catch {
    return null
  }
}

export function tryLoadHostPeerSync(name) {
  if (!isAllowedPeer(name)) return null
  for (const req of buildCandidateRequires()) {
    try {
      return req(name)
    } catch {
      // try next candidate
    }
  }
  return null
}

function createOfflineZodShim() {
  function makeSchema(kind, extra = {}) {
    const schema = {
      _kind: kind,
      ...extra,
      describe(desc) {
        return makeSchema(kind, { ...extra, description: desc })
      },
      optional() {
        return makeSchema(kind, { ...extra, isOptional: true })
      },
      nullable() {
        return makeSchema(kind, { ...extra, isNullable: true })
      },
      default(defaultValue) {
        return makeSchema(kind, { ...extra, isOptional: true, defaultValue })
      },
      min(n) {
        return makeSchema(kind, { ...extra, minValue: n })
      },
      max(n) {
        return makeSchema(kind, { ...extra, maxValue: n })
      },
      int() {
        return makeSchema(kind, { ...extra, isInt: true })
      },
      trim() {
        return makeSchema(kind, { ...extra, trimValue: true })
      },
      passthrough() {
        return makeSchema(kind, { ...extra, passthroughMode: true })
      },
      strict() {
        return makeSchema(kind, { ...extra, strictMode: true })
      },
      parse(val) {
        const res = schema.safeParse(val)
        if (!res.success) {
          throw new Error(res.error?.message || `Invalid ${kind}`)
        }
        return res.data
      },
      safeParse(val) {
        if (val === undefined) {
          if ('defaultValue' in extra) return { success: true, data: extra.defaultValue }
          if (extra.isOptional) return { success: true, data: undefined }
          return { success: false, error: new Error(`Expected ${kind}, received undefined`) }
        }
        if (val === null) {
          if (extra.isNullable) return { success: true, data: null }
          return { success: false, error: new Error(`Expected ${kind}, received null`) }
        }
        if (kind === 'enum' && Array.isArray(extra.values) && !extra.values.includes(val)) {
          return {
            success: false,
            error: new Error(`Expected one of [${extra.values.join(', ')}], got ${String(val)}`),
          }
        }
        if (kind === 'object' && extra.shape && typeof val === 'object' && !Array.isArray(val)) {
          const out = { ...val }
          for (const [k, fieldSchema] of Object.entries(extra.shape)) {
            if (fieldSchema && typeof fieldSchema.safeParse === 'function') {
              const sub = fieldSchema.safeParse(val[k])
              if (!sub.success) return sub
              if (sub.data !== undefined || k in val) out[k] = sub.data
            }
          }
          return { success: true, data: out }
        }
        return { success: true, data: val }
      },
    }
    return schema
  }

  return {
    string: () => makeSchema('string'),
    number: () => makeSchema('number'),
    boolean: () => makeSchema('boolean'),
    any: () => makeSchema('any'),
    unknown: () => makeSchema('unknown'),
    literal: (value) => makeSchema('literal', { value }),
    enum: (values) => makeSchema('enum', { values }),
    array: (itemSchema) => makeSchema('array', { itemSchema }),
    record: (keyOrVal, maybeVal) =>
      makeSchema('record', { valueSchema: maybeVal ?? keyOrVal }),
    union: (options) => makeSchema('union', { options }),
    object: (shape = {}) => makeSchema('object', { shape }),
  }
}

function offlineCreateUserMessage({ id, content, source, timestamp } = {}) {
  const blocks =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : []
  return {
    ...(id ? { id } : {}),
    role: 'user',
    content: blocks,
    ...(source ? { source } : {}),
    timestamp: timestamp ?? Date.now(),
  }
}

function compileOfflineParameterSchema(specParameters = {}) {
  if (specParameters && specParameters.type === 'object' && specParameters.properties) {
    return { schema: specParameters, required: Array.isArray(specParameters.required) ? specParameters.required : [] }
  }
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(specParameters || {})) {
    if (!prop || typeof prop !== 'object') continue
    const { required: isReq, ...rest } = prop
    properties[key] = { ...rest }
    if (isReq === true) required.push(key)
  }
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    required,
  }
}

function compileOfflineValueSchema(specSchema = {}) {
  if (!specSchema || typeof specSchema !== 'object') return { type: 'object' }
  if (specSchema.type === 'object' && specSchema.properties) {
    const outProperties = {}
    const outRequired = Array.isArray(specSchema.required) ? [...specSchema.required] : []
    for (const [key, prop] of Object.entries(specSchema.properties)) {
      if (!prop || typeof prop !== 'object') continue
      const { required: isReq, ...rest } = prop
      outProperties[key] = { ...rest }
      if (isReq === true && !outRequired.includes(key)) outRequired.push(key)
    }
    return {
      type: 'object',
      additionalProperties: Boolean(specSchema.additionalProperties),
      properties: outProperties,
      ...(outRequired.length > 0 ? { required: outRequired } : {}),
    }
  }
  return { ...specSchema }
}

function offlineDefineTool(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('defineTool expects a tool definition object')
  }
  if (!spec.name || typeof spec.execute !== 'function') {
    throw new TypeError('defineTool requires name and execute(args, exec)')
  }
  const { schema: parameters, required } = compileOfflineParameterSchema(spec.parameters)
  const outputSchema = spec.output?.schema ? compileOfflineValueSchema(spec.output.schema) : undefined
  const userExecute = spec.execute
  return {
    ...spec,
    parameters,
    ...(spec.output
      ? {
          output: {
            ...spec.output,
            ...(outputSchema ? { schema: outputSchema } : {}),
          },
        }
      : {}),
    async execute(args = {}, exec = {}) {
      const safeArgs = args && typeof args === 'object' ? args : {}
      for (const reqKey of required) {
        if (safeArgs[reqKey] === undefined || safeArgs[reqKey] === null) {
          throw new Error(`Missing required argument: ${reqKey}`)
        }
      }
      return userExecute(safeArgs, exec)
    },
  }
}

let cachedSyncPeers = null

export function resolveHostPeersSync(overrides = {}) {
  if (!cachedSyncPeers) {
    const llmMod = tryLoadHostPeerSync('@deepseek-ai/dsh-llm')
    const toolsMod = tryLoadHostPeerSync('@deepseek-ai/dsh-tools')
    const zodMod = tryLoadHostPeerSync('zod')
    cachedSyncPeers = {
      createUserMessage:
        typeof llmMod?.createUserMessage === 'function'
          ? llmMod.createUserMessage
          : offlineCreateUserMessage,
      defineTool:
        typeof toolsMod?.defineTool === 'function'
          ? toolsMod.defineTool
          : offlineDefineTool,
      z: zodMod?.z ?? zodMod?.default ?? createOfflineZodShim(),
      isOfflineFallback: !(llmMod && toolsMod),
    }
  }
  return {
    createUserMessage: overrides?.createUserMessage ?? cachedSyncPeers.createUserMessage,
    defineTool: overrides?.defineTool ?? cachedSyncPeers.defineTool,
    z: overrides?.z ?? cachedSyncPeers.z,
    isOfflineFallback: cachedSyncPeers.isOfflineFallback,
  }
}

let cachedDefaultPeersPromise = null

export async function resolveHostPeers(overrides = {}) {
  if (
    overrides &&
    typeof overrides.createUserMessage === 'function' &&
    typeof overrides.defineTool === 'function' &&
    overrides.z
  ) {
    return {
      createUserMessage: overrides.createUserMessage,
      defineTool: overrides.defineTool,
      z: overrides.z,
      isOfflineFallback: false,
    }
  }

  if (!cachedDefaultPeersPromise) {
    cachedDefaultPeersPromise = (async () => {
      const [llmMod, toolsMod, zodMod] = await Promise.all([
        tryLoadHostPeer('@deepseek-ai/dsh-llm'),
        tryLoadHostPeer('@deepseek-ai/dsh-tools'),
        tryLoadHostPeer('zod'),
      ])
      const z = zodMod?.z ?? zodMod?.default ?? createOfflineZodShim()
      const createUserMessage =
        typeof llmMod?.createUserMessage === 'function'
          ? llmMod.createUserMessage
          : offlineCreateUserMessage
      const defineTool =
        typeof toolsMod?.defineTool === 'function'
          ? toolsMod.defineTool
          : offlineDefineTool
      return {
        createUserMessage,
        defineTool,
        z,
        isOfflineFallback: !(llmMod && toolsMod),
      }
    })()
  }

  const base = await cachedDefaultPeersPromise
  return {
    createUserMessage: overrides.createUserMessage ?? base.createUserMessage,
    defineTool: overrides.defineTool ?? base.defineTool,
    z: overrides.z ?? base.z,
    isOfflineFallback: base.isOfflineFallback,
  }
}
