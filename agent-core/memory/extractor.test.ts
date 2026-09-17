// agent-core/memory/extractor.test.ts — KIEO-041 extraction coverage.
import { describe, expect, it } from 'vitest'
import { extractFactsFromText, sentenceToFact } from './extractor'

describe('KIEO-041 extractor (ticket AC: durable statements only)', () => {
  it('captures the ticket example verbatim', () => {
    expect(extractFactsFromText('I use pnpm, not npm')).toEqual(['User uses pnpm, not npm'])
  })

  it('captures preferences, identity, and work facts', () => {
    expect(extractFactsFromText('I prefer dark mode')).toEqual(['User prefers dark mode'])
    expect(extractFactsFromText('My name is Ada')).toEqual(["User's name is Ada"])
    expect(extractFactsFromText("I'm a developer")).toEqual(['User is a developer'])
    expect(extractFactsFromText('My favorite editor is VS Code')).toEqual([
      "User's favorite editor is VS Code"
    ])
    expect(extractFactsFromText('I work at Acme')).toEqual(['User works at Acme'])
    expect(extractFactsFromText('I live in Berlin')).toEqual(['User lives in Berlin'])
    expect(extractFactsFromText('I like TypeScript')).toEqual(['User likes TypeScript'])
    expect(extractFactsFromText('I hate meetings')).toEqual(['User dislikes meetings'])
  })

  it('unwraps remember-that phrasing', () => {
    expect(extractFactsFromText('Remember that I use pnpm')).toEqual(['User uses pnpm'])
    expect(extractFactsFromText('remember my name is Ada')).toEqual(["User's name is Ada"])
  })

  it('never mines commands, questions, or chatter', () => {
    for (const t of [
      'delete file x',
      'open Notepad',
      'run npm test',
      'what time is it?',
      'What is the capital of France?',
      'Do you remember I use pnpm?',
      '',
      '   ',
      'ok',
      'hello there'
    ]) {
      expect(extractFactsFromText(t), JSON.stringify(t)).toEqual([])
    }
  })

  it('skips reminder todos and transient status', () => {
    expect(extractFactsFromText('remember to buy milk')).toEqual([])
    expect(extractFactsFromText("I'm running late")).toEqual([])
    expect(extractFactsFromText("I'm hungry")).toEqual([])
  })

  it('dedupes case-insensitively, in first-seen order', () => {
    expect(extractFactsFromText('I use pnpm. i USE pnpm! I prefer dark mode')).toEqual([
      'User uses pnpm',
      'User prefers dark mode'
    ])
  })

  it('sentenceToFact returns null for non-facts', () => {
    expect(sentenceToFact('delete file x')).toBeNull()
    expect(sentenceToFact('')).toBeNull()
  })
})
