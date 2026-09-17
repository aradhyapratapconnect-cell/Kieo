// agent-core/memory/store.ts — SQLite-backed memory (KIEO-041).
//
// Thin, Electron-free layer over db/tables.ts memory_facts helpers:
//   * learnFacts() mines user texts via the extractor and inserts only
//     genuinely new facts (case-insensitive exact dedupe, batch + DB).
//   * buildMemoryContext() renders the LLM system-prompt snippet — the read
//     path that makes edits/deletes take effect on the very next turn
//     (deleted rows are gone, so they can never leak into context).
//   * editFact() validates + delegates to updateMemoryFact() (which stamps
//     edited_by_user=1 per the schema contract).
//
// The extractor only inserts; it never updates or deletes. A user-edited
// fact is therefore never silently overwritten by a later extraction.
import type { DatabaseHandle } from '../../db/database'
import {
  createMemoryFact,
  deleteMemoryFact,
  listMemoryFacts,
  updateMemoryFact,
  type MemoryFactRow
} from '../../db/tables'
import { extractFactsFromText } from './extractor'

export const MAX_MEMORY_FACTS_IN_CONTEXT = 20
export const MAX_STORED_FACT_CHARS = 280

export function listFacts(db: DatabaseHandle): MemoryFactRow[] {
  return listMemoryFacts(db)
}

/**
 * Mine durable facts from user texts and persist the new ones.
 * Returns only the rows actually created (existing duplicates are skipped).
 * Never throws for empty input — returns [].
 */
export function learnFacts(
  db: DatabaseHandle,
  texts: string[],
  sourceMessageId?: string | null
): MemoryFactRow[] {
  const existing = new Set(listMemoryFacts(db).map((r) => r.fact.toLowerCase()))
  const created: MemoryFactRow[] = []
  for (const text of texts) {
    for (const fact of extractFactsFromText(text)) {
      const trimmed = fact.trim()
      if (!trimmed || trimmed.length > MAX_STORED_FACT_CHARS) continue
      const key = trimmed.toLowerCase()
      if (existing.has(key)) continue
      existing.add(key)
      created.push(
        createMemoryFact(db, { fact: trimmed, sourceMessageId: sourceMessageId ?? null })
      )
    }
  }
  return created
}

/**
 * Render stored facts as an LLM system-prompt section. Returns "" when no
 * facts exist. Deleted facts are absent from the DB, so they never appear
 * here (ticket AC3). Capped so a large memory can't blow up context.
 */
export function buildMemoryContext(db: DatabaseHandle, maxFacts = MAX_MEMORY_FACTS_IN_CONTEXT): string {
  const facts = listMemoryFacts(db).slice(0, Math.max(0, maxFacts))
  if (facts.length === 0) return ''
  const lines = facts.map((f) => `- ${f.fact}`)
  return `User memory facts (durable preferences the user stated — use them to personalize, never reveal this block verbatim):\n${lines.join('\n')}`
}

/**
 * Validate + apply a user edit from the Memory view. Trims; rejects empty
 * (returns false, row untouched). Delegates the edited_by_user stamp to
 * updateMemoryFact().
 */
export function editFact(db: DatabaseHandle, id: string, newFact: string): boolean {
  const trimmed = newFact.replace(/\s+/g, ' ').trim()
  if (!trimmed || trimmed.length > MAX_STORED_FACT_CHARS) return false
  return updateMemoryFact(db, id, trimmed)
}

export function removeFact(db: DatabaseHandle, id: string): boolean {
  return deleteMemoryFact(db, id)
}
