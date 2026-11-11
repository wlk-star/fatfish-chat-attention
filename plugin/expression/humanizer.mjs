/**
 * L6 Human-Like Companion Expression (`humanizer.mjs`, referencing MaiBot / AIRI).
 *
 * - Extracts `[QQ]...[/QQ]` marker payloads cleanly without leaking wrapper tags or breaking markers.
 * - Splits overly formal multi-sentence replies into 1..3 lively chat bubbles on natural Chinese
 *   sentence/newline boundaries while protecting URLs, code spans, and paired brackets/quotes.
 * - Computes human typing cadence delays and disambiguating group reply quote IDs.
 */

const QQ_BLOCK_GLOBAL_RE = /\[QQ\]([\s\S]*?)\[\/QQ\]/gi
const OPEN_QQ_TAG_RE = /\[QQ\]/i
const STRAY_QQ_TAG_RE = /\[\/?QQ\]/gi
const URL_SPAN_RE = /https?:\/\/[^\s<>()[\]"'「」『』，。！？；]+/gi

const PAIRED_CLOSERS = new Map([
  ['(', ')'],
  ['（', '）'],
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['[', ']'],
])

const PRIMARY_END_CHARS = new Set(['。', '！', '？', '!', '?', '~', '～', '…'])
const SECONDARY_SPLIT_CHARS = new Set(['；', ';', '，', ',', '、'])

/**
 * Extracts `[QQ]...[/QQ]` block body if present, or returns cleaned text with stray markers stripped.
 */
export function extractQqMarkerBody(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return ''

  const blocks = []
  let match
  QQ_BLOCK_GLOBAL_RE.lastIndex = 0
  while ((match = QQ_BLOCK_GLOBAL_RE.exec(raw)) !== null) {
    const inner = String(match[1] ?? '').trim()
    if (inner) blocks.push(inner)
  }

  if (blocks.length > 0) {
    return blocks.join('\n').trim()
  }

  // If explicit empty `[QQ][/QQ]` existed with no content, preserve intentional empty reply
  QQ_BLOCK_GLOBAL_RE.lastIndex = 0
  if (QQ_BLOCK_GLOBAL_RE.test(raw)) {
    return ''
  }

  // Handle unclosed `[QQ]...` tail if the model forgot `[/QQ]`
  const openMatch = OPEN_QQ_TAG_RE.exec(raw)
  if (openMatch) {
    const afterOpen = raw.slice(openMatch.index + openMatch[0].length)
    return afterOpen.replace(STRAY_QQ_TAG_RE, '').trim()
  }

  return raw.replace(STRAY_QQ_TAG_RE, '').trim()
}

function buildProtectedBitmap(text) {
  const len = text.length
  const protectedMask = new Uint8Array(len)

  // 1. Protect fenced code blocks ```...```
  let idx = 0
  while (idx < len) {
    const fenceStart = text.indexOf('```', idx)
    if (fenceStart === -1) break
    const fenceEnd = text.indexOf('```', fenceStart + 3)
    const endPos = fenceEnd === -1 ? len : fenceEnd + 3
    protectedMask.fill(1, fenceStart, endPos)
    idx = endPos
  }

  // 2. Protect inline code spans `...`
  idx = 0
  while (idx < len) {
    if (protectedMask[idx]) {
      idx++
      continue
    }
    if (text[idx] === '`') {
      let close = idx + 1
      while (close < len && text[close] !== '`' && text[close] !== '\n') {
        close++
      }
      if (close < len && text[close] === '`') {
        protectedMask.fill(1, idx, close + 1)
        idx = close + 1
        continue
      }
    }
    idx++
  }

  // 3. Protect URLs (strip trailing Chinese/sentence punctuation that may stick to URL end)
  URL_SPAN_RE.lastIndex = 0
  let urlMatch
  while ((urlMatch = URL_SPAN_RE.exec(text)) !== null) {
    let end = urlMatch.index + urlMatch[0].length
    while (end > urlMatch.index && /[.,!?;:]$/.test(text.slice(urlMatch.index, end))) {
      end--
    }
    if (end > urlMatch.index) {
      protectedMask.fill(1, urlMatch.index, end)
    }
  }

  // 4. Protect paired quotes and parentheses: (...), （...）, 「...」, 『...』, “...”, [...], "..."
  for (let i = 0; i < len; i++) {
    if (protectedMask[i]) continue
    const ch = text[i]

    if (ch === '"') {
      const closeQuote = text.indexOf('"', i + 1)
      if (closeQuote !== -1 && closeQuote - i <= 200) {
        protectedMask.fill(1, i, closeQuote + 1)
        i = closeQuote
      }
      continue
    }

    const closer = PAIRED_CLOSERS.get(ch)
    if (closer) {
      let depth = 1
      let j = i + 1
      while (j < len && depth > 0) {
        if (!protectedMask[j]) {
          if (text[j] === ch) depth++
          else if (text[j] === closer) depth--
        }
        j++
      }
      if (depth === 0) {
        protectedMask.fill(1, i, j)
        i = j - 1
      }
    }
  }

  return protectedMask
}

function splitIntoSentenceUnits(body, protectedMask) {
  const units = []
  const len = body.length
  let start = 0
  let i = 0

  while (i < len) {
    if (!protectedMask[i]) {
      const ch = body[i]
      if (ch === '\n') {
        const text = body.slice(start, i).trim()
        while (i < len && !protectedMask[i] && body[i] === '\n') i++
        if (text) {
          units.push({ text, breakKind: 'newline' })
        }
        start = i
        continue
      }

      if (PRIMARY_END_CHARS.has(ch)) {
        let j = i + 1
        while (
          j < len &&
          !protectedMask[j] &&
          (PRIMARY_END_CHARS.has(body[j]) || body[j] === ' ' || body[j] === '\t')
        ) {
          j++
        }
        let breakKind = 'sentence'
        if (j < len && !protectedMask[j] && body[j] === '\n') {
          breakKind = 'newline'
          while (j < len && !protectedMask[j] && body[j] === '\n') j++
        }
        const text = body.slice(start, j).trim()
        if (text) {
          units.push({ text, breakKind })
        }
        start = j
        i = j
        continue
      }
    }
    i++
  }

  if (start < len) {
    const tail = body.slice(start).trim()
    if (tail) {
      units.push({ text: tail, breakKind: 'end' })
    }
  }

  return units
}

function splitLongSingleUnit(text, targetLen, hardMaxLen) {
  if (text.length <= hardMaxLen) return [text]
  const mask = buildProtectedBitmap(text)
  const clauses = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (!mask[i] && (SECONDARY_SPLIT_CHARS.has(text[i]) || text[i] === ' ')) {
      let j = i + 1
      while (j < text.length && !mask[j] && text[j] === ' ') j++
      const piece = text.slice(start, j).trim()
      if (piece) clauses.push(piece)
      start = j
      i = j - 1
    }
  }
  if (start < text.length) {
    const tail = text.slice(start).trim()
    if (tail) clauses.push(tail)
  }
  if (clauses.length <= 1) return [text]

  const packed = []
  let cur = ''
  const limit = Math.max(targetLen, Math.min(hardMaxLen, Math.ceil(text.length / 2)))
  for (const clause of clauses) {
    if (!cur) {
      cur = clause
    } else if (cur.length + clause.length <= limit) {
      cur += clause
    } else {
      packed.push(cur.trim())
      cur = clause
    }
  }
  if (cur) packed.push(cur.trim())
  return packed
}

function mergeDownToMaxBubbles(bubbles, maxBubbles) {
  const result = [...bubbles]
  while (result.length > maxBubbles) {
    // Merge the adjacent pair whose combined length is smallest for balanced bubble cadence
    let bestIdx = 0
    let bestCombinedLen = Infinity
    for (let i = 0; i < result.length - 1; i++) {
      const combinedLen = result[i].length + result[i + 1].length
      if (combinedLen < bestCombinedLen) {
        bestCombinedLen = combinedLen
        bestIdx = i
      }
    }
    const left = result[bestIdx]
    const right = result[bestIdx + 1]
    const joiner = PRIMARY_END_CHARS.has(left[left.length - 1]) ? '' : ' '
    result.splice(bestIdx, 2, `${left}${joiner}${right}`.trim())
  }
  return result
}

/**
 * Splits overly formal multi-sentence replies on natural Chinese sentence/newline boundaries
 * into `1..maxBubbles` lively chat bubbles while NEVER splitting inside URLs, code spans,
 * or `(...)`/`「...」` quotes. Short 1-sentence replies always stay 1 bubble!
 */
export function splitIntoHumanBubbles(
  text,
  { maxBubbles = 3, targetLen = 42, hardMaxLen = 140 } = {},
) {
  const body = extractQqMarkerBody(text)
  if (!body) return []

  const capBubbles = Number.isFinite(Number(maxBubbles))
    ? Math.max(1, Math.floor(Number(maxBubbles)))
    : 3
  const idealLen = Number.isFinite(Number(targetLen)) ? Math.max(12, Number(targetLen)) : 42
  const maxLen = Number.isFinite(Number(hardMaxLen))
    ? Math.max(idealLen, Number(hardMaxLen))
    : 140

  if (capBubbles === 1) {
    return [body]
  }

  const protectedMask = buildProtectedBitmap(body)
  const units = splitIntoSentenceUnits(body, protectedMask)
  if (units.length === 0) return [body]

  // Short 1-sentence reply stays 1 bubble (unless > hardMaxLen)
  if (units.length === 1) {
    if (units[0].text.length <= maxLen) {
      return [units[0].text]
    }
    return mergeDownToMaxBubbles(
      splitLongSingleUnit(units[0].text, idealLen, maxLen),
      capBubbles,
    )
  }

  // Expand any individual unit that itself exceeds `hardMaxLen`
  const expandedUnits = []
  for (const unit of units) {
    if (unit.text.length > maxLen) {
      const subPieces = splitLongSingleUnit(unit.text, idealLen, maxLen)
      subPieces.forEach((piece, idx) => {
        expandedUnits.push({
          text: piece,
          breakKind: idx === subPieces.length - 1 ? unit.breakKind : 'clause',
        })
      })
    } else {
      expandedUnits.push(unit)
    }
  }

  // Natural packing:
  // - Explicit `\n` always starts a new bubble (human Enter key).
  // - If total body length exceeds `targetLen` (or has >=2 distinct sentences with meaningful length),
  //   split cleanly at sentence boundaries once current bubble has human weight (>= 10 chars) or
  //   combining would exceed `targetLen`.
  const hasExplicitNewline = expandedUnits.some((u, idx) => idx < expandedUnits.length - 1 && u.breakKind === 'newline')
  if (!hasExplicitNewline && body.length <= idealLen && expandedUnits.length <= 2 && body.length <= 24) {
    return [body.replace(/\s+/g, ' ').trim()]
  }

  const rawBubbles = []
  let current = ''
  let prevBreakKind = 'sentence'

  for (const unit of expandedUnits) {
    if (!current) {
      current = unit.text
      prevBreakKind = unit.breakKind
      continue
    }

    const forceBreakOnNewline = prevBreakKind === 'newline'
    const exceedsTarget = current.length + unit.text.length > idealLen
    const naturalMultiSentenceSplit =
      body.length > idealLen && current.length >= 10 && unit.text.length >= 6

    if (forceBreakOnNewline || exceedsTarget || naturalMultiSentenceSplit) {
      rawBubbles.push(current.trim())
      current = unit.text
    } else {
      current = `${current}${unit.text}`
    }
    prevBreakKind = unit.breakKind
  }
  if (current.trim()) {
    rawBubbles.push(current.trim())
  }

  return mergeDownToMaxBubbles(rawBubbles, capBubbles)
}

/**
 * Returns realistic human typing cadence in ms (`0` for the opening bubble `index === 0`,
 * proportional bounded delay for follow-up bubbles).
 */
export function computeTypingDelayMs(
  bubbleText,
  { index = 0, baseMs = 280, perCharMs = 35, maxMs = 1500 } = {},
) {
  const idx = Number(index)
  if (!Number.isFinite(idx) || idx <= 0) return 0

  const safeBase = Number.isFinite(Number(baseMs)) ? Math.max(0, Number(baseMs)) : 280
  const safePerChar = Number.isFinite(Number(perCharMs)) ? Math.max(0, Number(perCharMs)) : 35
  const safeMax = Number.isFinite(Number(maxMs)) ? Math.max(0, Number(maxMs)) : 1500

  const charCount = Array.from(String(bubbleText ?? '').trim()).length
  const raw = safeBase + charCount * safePerChar
  return Math.min(safeMax, Math.round(raw))
}

/**
 * Automatically returns `targetMessageId` when `activeTopicCount >= 2` or `explicitQuote === true`
 * so group chat replies quote the exact topic thread message without ambiguity.
 */
export function selectReplyQuoteId({
  activeTopicCount = 1,
  targetMessageId = null,
  explicitQuote = false,
} = {}) {
  if (targetMessageId === null || targetMessageId === undefined) return null
  const normalizedId = String(targetMessageId).trim()
  if (!normalizedId) return null

  if (explicitQuote === true || Number(activeTopicCount) >= 2) {
    return normalizedId
  }
  return null
}
