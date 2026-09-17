// agent-core/memory/extractor.ts — durable-fact extraction (KIEO-041).
//
// Deterministic, dependency-free, and safe by construction: only
// first-person durable statements become facts. Commands ("delete file x"),
// questions ("what time is it?"), and transient status ("I'm running late")
// never match — the patterns require explicit durable language.
//
// Design notes:
//   * User text ONLY is mined (never assistant output or tool results —
//     assistant hallucinations must not become "facts about the user").
//   * `remember to <verb>` reminders are skipped: a todo is not a trait.
//   * Bare "I'm <adjective>" is skipped (transient); only "I'm a <role>"
//     is durable enough to keep for v1.
//   * Everything is pure + unit-tested; the SQLite write path lives in
//     store.ts, the LLM-context read path in buildMemoryContext().
export const MAX_FACT_BODY_CHARS = 200

/** Split text into sentences, keeping terminators so questions can be skipped. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?\n]+[.!?]?/g)
  if (!matches) return []
  return matches.map((s) => s.trim()).filter((s) => s.length > 0)
}

function cleanBody(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!\s]+$/, '')
    .trim()
}

function validBody(body: string): boolean {
  return body.length >= 2 && body.length <= MAX_FACT_BODY_CHARS
}

/**
 * Normalize one sentence into a stored fact, or null when it is not a
 * durable user fact. First match wins; matching is case-insensitive but the
 * captured body keeps its original casing (e.g. "pnpm" stays lowercase).
 */
export function sentenceToFact(sentence: string): string | null {
  const trimmed = sentence.trim()
  if (!trimmed) return null
  // Questions are never durable statements ("Do you remember I use pnpm?").
  if (trimmed.endsWith('?')) return null

  let m: RegExpMatchArray | null

  // "Remember that <fact>" / "Remember <fact>" — but not "remember to ...".
  m = trimmed.match(/^\s*remember\s+(that\s+)?(.+)$/i)
  if (m) {
    const body = cleanBody(m[2] ?? '')
    if (!body) return null
    if (/^to\s+/i.test(body)) return null // reminder todo, not a trait
    if (!validBody(body)) return null
    // Recurse: "remember that I use pnpm" -> "User uses pnpm".
    if (/^(i|my|i'm|i've|i'll)\b/i.test(body)) {
      const inner = sentenceToFact(body)
      if (inner) return inner
    }
    // Generic durable statement ("remember the deploy key is abc").
    return body.charAt(0).toUpperCase() + body.slice(1)
  }

  // "I use pnpm, not npm" (ticket AC example).
  m = trimmed.match(/^\s*i\s+use\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User uses ${body}`
  }

  m = trimmed.match(/^\s*i\s+prefer\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User prefers ${body}`
  }

  m = trimmed.match(/^\s*i\s+(?:don't|do\s+not)\s+like\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User dislikes ${body}`
  }

  m = trimmed.match(/^\s*i\s+(?:hate|dislike)\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User dislikes ${body}`
  }

  m = trimmed.match(/^\s*i\s+like\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User likes ${body}`
  }

  m = trimmed.match(/^\s*my\s+name\s+is\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User's name is ${body}`
  }

  // "I'm a developer" (durable role only — bare adjectives are transient).
  m = trimmed.match(/^\s*i(?:'m|\s+am)\s+(a|an)\s+(.+)$/i)
  if (m) {
    const body = cleanBody(`${m[1]} ${m[2]}`)
    if (!validBody(body)) return null
    return `User is ${body}`
  }

  m = trimmed.match(/^\s*my\s+(.+?)\s+is\s+(.+)$/i)
  if (m) {
    const key = cleanBody(m[1] ?? '')
    const value = cleanBody(m[2] ?? '')
    if (!validBody(key) || !validBody(value)) return null
    return `User's ${key} is ${value}`
  }

  m = trimmed.match(/^\s*i\s+work\s+(at|on|with|as)\s+(.+)$/i)
  if (m) {
    const prep = m[1]?.toLowerCase()
    const body = cleanBody(m[2] ?? '')
    if (!validBody(body)) return null
    return `User works ${prep} ${body}`
  }

  m = trimmed.match(/^\s*i\s+live\s+in\s+(.+)$/i)
  if (m) {
    const body = cleanBody(m[1] ?? '')
    if (!validBody(body)) return null
    return `User lives in ${body}`
  }

  return null
}

/**
 * Extract durable facts from free text. Returns normalized fact strings,
 * deduped case-insensitively, in first-seen order. Returns [] for commands,
 * questions, and chatter with no durable content.
 */
export function extractFactsFromText(text: string): string[] {
  if (!text || text.trim().length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const sentence of splitSentences(text)) {
    const fact = sentenceToFact(sentence)
    if (!fact) continue
    const key = fact.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}
