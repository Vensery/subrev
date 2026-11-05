import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AiRunner, ReviewCallOptions } from '../aiRunner.js'

export interface RecordedReviewCall {
  prompt: string
  cwd: string
  opts?: ReviewCallOptions
  /** Whether a `.ai/` directory was visible from the reviewer's cwd at call time. */
  aiDirVisible: boolean
}

export interface RecordedAuditCall {
  prompt: string
  cwd: string
}

export class FakeAiRunner implements AiRunner {
  planResponses: string[] = []
  reviewResponses: string[] = []
  /**
   * Scripted phase-2 audit responses. When empty, the fake answers CONSISTENT so
   * tests that only care about the gate (phase 1) need not script the audit.
   */
  auditResponses: string[] = []
  codexEffects: Array<(cwd: string) => void> = []
  reviewCalls: RecordedReviewCall[] = []
  auditCalls: RecordedAuditCall[] = []

  async claudePlan(): Promise<string> {
    const next = this.planResponses.shift()
    if (next === undefined) throw new Error('FakeAiRunner: no more scripted plan responses')
    return next
  }

  async claudeReview(prompt: string, cwd: string, opts?: ReviewCallOptions): Promise<string> {
    this.reviewCalls.push({ prompt, cwd, opts, aiDirVisible: existsSync(path.join(cwd, '.ai')) })
    const next = this.reviewResponses.shift()
    if (next === undefined) throw new Error('FakeAiRunner: no more scripted review responses')
    return next
  }

  async claudeAudit(prompt: string, cwd: string): Promise<string> {
    this.auditCalls.push({ prompt, cwd })
    return this.auditResponses.shift() ?? 'CONSISTENCY: CONSISTENT'
  }

  async codexExec(_prompt: string, cwd: string): Promise<string> {
    const effect = this.codexEffects.shift()
    if (!effect) throw new Error('FakeAiRunner: no more scripted codex effects')
    effect(cwd)
    return 'fake codex output'
  }
}
