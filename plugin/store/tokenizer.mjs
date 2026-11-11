export const DEFAULT_CUSTOM_ALIASES = Object.freeze([
  '源弟弟',
  '源天帝',
  '大肥鱼',
  '爸爸',
  '蓝蓝',
  'kk',
])

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const ASCII_WORD_RE = /[a-z0-9_]+/g
const QQ_ID_RE = /qq:\s*(\d{4,15})/gi
const SAFE_FTS_TOKEN_RE = /[^\p{L}\p{N}_]/gu

// Common high-frequency Chinese particles & conversational fillers that dilute keyword extraction
const CN_PARTICLE_SPLIT_RE = /[的了吗呢吧啊呀哇哦嘛呗哈啦捏噢喔和与跟把被让给着过]/g

const CN_STOPWORDS = new Set([
  '一个', '一些', '一下', '一起', '一直', '一定', '一样', '一般',
  '这个', '这些', '这里', '这样', '这么', '那个', '那些', '那里', '那样', '那么', '那次', '这次',
  '什么', '怎么', '怎样', '为什么', '哪里', '哪个', '哪些', '多少',
  '因为', '所以', '但是', '不过', '而且', '或者', '如果', '虽然', '然后', '就是', '不是', '还是',
  '可以', '可能', '应该', '需要', '觉得', '知道', '看到', '听到', '出来', '进去', '起来',
  '我们', '你们', '他们', '她们', '它们', '自己', '大家', '有人',
  '之前', '之后', '以前', '以后', '现在', '刚才', '最近', '今天', '明天', '昨天',
  '没有', '有没有', '是不是',
])

const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'have', 'been', 'from', 'this', 'that', 'with', 'they', 'what', 'when',
  'where', 'which', 'who', 'will', 'would', 'there', 'their', 'about', 'into', 'just', 'like',
])

function sanitizeToken(raw) {
  if (!raw) return ''
  return String(raw).replace(SAFE_FTS_TOKEN_RE, '').trim()
}

function normalizeInput(text) {
  if (text === undefined || text === null) return ''
  return String(text)
    .normalize('NFKC')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .toLowerCase()
}

function resolveAliasList(options = {}) {
  const extra = Array.isArray(options.customAliases)
    ? options.customAliases
    : Array.isArray(options.aliases)
      ? options.aliases
      : []
  const merged = new Set()
  const list = []
  for (const raw of [...DEFAULT_CUSTOM_ALIASES, ...extra]) {
    if (typeof raw !== 'string') continue
    const norm = raw.normalize('NFKC').toLowerCase().trim()
    if (!norm || merged.has(norm)) continue
    merged.add(norm)
    list.push(norm)
  }
  // Longest first so multi-char aliases match cleanly
  list.sort((a, b) => b.length - a.length)
  return list
}

function isPureAsciiWord(term) {
  return /^[a-z0-9_]+$/.test(term)
}

function containsAlias(text, alias) {
  if (!alias) return false
  if (isPureAsciiWord(alias)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i')
    return re.test(text)
  }
  return text.includes(alias)
}

/**
 * Tokenizes Chinese + English + QQ ID + custom entity alias text into a
 * whitespace-delimited token string optimized for SQLite FTS5 indexing.
 */
export function tokenizeForFts(text, options = {}) {
  const norm = normalizeInput(text)
  if (!norm) return ''

  const includeUnigrams = options.includeUnigrams !== false
  const aliases = resolveAliasList(options)
  const tokens = []

  // 1. Preserve explicit qq:<digits> anchors as atomic FTS tokens
  for (const match of norm.matchAll(QQ_ID_RE)) {
    const digits = match[1]
    tokens.push(`qq${digits}`)
    tokens.push(digits)
  }

  // 2. Preserve custom entity aliases as whole tokens
  for (const alias of aliases) {
    if (containsAlias(norm, alias)) {
      const clean = sanitizeToken(alias)
      if (clean) tokens.push(clean)
    }
  }

  // 3. Extract ASCII words & numbers
  for (const match of norm.matchAll(ASCII_WORD_RE)) {
    const word = sanitizeToken(match[0])
    if (word) tokens.push(word)
  }

  // 4. Extract CJK overlapping bigrams (+ optional unigrams for 1-char terms)
  for (const match of norm.matchAll(CJK_RUN_RE)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2))
    }
    if (includeUnigrams) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i])
      }
    }
  }

  return tokens.filter(Boolean).join(' ')
}

/**
 * Extracts deduplicated salient keywords (entity aliases, qq:IDs, ASCII terms,
 * and stopword-filtered CJK bigrams) for topic routing & FTS5 search queries.
 */
export function extractKeywords(text, options = {}) {
  const norm = normalizeInput(text)
  if (!norm) return []

  const maxKeywords = Number.isFinite(options.maxKeywords) ? Math.max(1, options.maxKeywords) : 32
  const aliases = resolveAliasList(options)
  const seen = new Set()
  const keywords = []

  const pushKeyword = (kw) => {
    if (!kw || seen.has(kw)) return
    seen.add(kw)
    keywords.push(kw)
  }

  // 1. Explicit qq:<id> mentions
  for (const match of norm.matchAll(QQ_ID_RE)) {
    pushKeyword(`qq:${match[1]}`)
  }

  // 2. Custom entity aliases
  for (const alias of aliases) {
    if (containsAlias(norm, alias)) {
      pushKeyword(alias)
    }
  }

  // 3. Meaningful ASCII words (excluding pure stopwords & single noise letters unless numeric)
  for (const match of norm.matchAll(ASCII_WORD_RE)) {
    const word = match[0]
    if (word === 'qq') continue
    if (EN_STOPWORDS.has(word)) continue
    if (word.length >= 2 || /\d/.test(word)) {
      pushKeyword(word)
    }
  }

  // 4. CJK runs split on grammatical particles -> bigrams filtered against stopwords
  const fallbackUnigrams = []
  for (const match of norm.matchAll(CJK_RUN_RE)) {
    const fullRun = match[0]
    const subRuns = fullRun.split(CN_PARTICLE_SPLIT_RE).filter(Boolean)
    for (const sub of subRuns) {
      if (sub.length === 1) {
        if (!CN_STOPWORDS.has(sub)) fallbackUnigrams.push(sub)
        continue
      }
      if (sub.length <= 4 && !CN_STOPWORDS.has(sub)) {
        // Keep short 2..4 char phrase intact if it's a compact noun phrase, plus its bigrams
        if (sub.length === 2) {
          pushKeyword(sub)
          continue
        }
      }
      for (let i = 0; i < sub.length - 1; i++) {
        const bg = sub.slice(i, i + 2)
        if (!CN_STOPWORDS.has(bg)) {
          pushKeyword(bg)
        }
      }
    }
  }

  // Fallback for single-character CJK queries like "猫" or "鱼" when no bigrams existed
  if (keywords.length === 0 && fallbackUnigrams.length > 0) {
    for (const u of fallbackUnigrams) {
      pushKeyword(u)
    }
  }

  return keywords.slice(0, maxKeywords)
}

/**
 * Builds an injection-safe SQLite FTS5 MATCH expression ("t1" OR "t2" ...)
 * from free-form chat query text + optional extra terms (e.g. resolved participant IDs).
 */
export function buildFtsMatchQuery(query, options = {}) {
  const extracted = extractKeywords(query, options)
  const extra = Array.isArray(options.extraTokens) ? options.extraTokens : []
  const ftsTerms = []
  const seen = new Set()

  const addSafeTerm = (raw) => {
    if (!raw) return
    const str = String(raw).trim().toLowerCase()
    const qqMatch = /^qq:(\d{4,15})$/.exec(str)
    const token = qqMatch ? `qq${qqMatch[1]}` : sanitizeToken(str)
    if (!token || seen.has(token)) return
    seen.add(token)
    ftsTerms.push(`"${token}"`)
  }

  for (const item of [...extra, ...extracted]) {
    addSafeTerm(item)
  }

  // If query was purely stopwords (e.g. "今天怎么样"), fall back to raw tokenization
  if (ftsTerms.length === 0) {
    const fallbackTokens = tokenizeForFts(query, {
      ...options,
      includeUnigrams: true,
    }).split(/\s+/)
    for (const tok of fallbackTokens.slice(0, 12)) {
      addSafeTerm(tok)
    }
  }

  return ftsTerms.join(' OR ')
}
