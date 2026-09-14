import type { AiRunner } from '../aiRunner.js'

export class FakeAiRunner implements AiRunner {
  planResponses: string[] = []
  reviewResponses: string[] = []
  codexEffects: Array<(cwd: string) => void> = []

  async claudePlan(): Promise<string> {
    const next = this.planResponses.shift()
    if (next === undefined) throw new Error('FakeAiRunner: no more scripted plan responses')
    return next
  }

  async claudeReview(): Promise<string> {
    const next = this.reviewResponses.shift()
    if (next === undefined) throw new Error('FakeAiRunner: no more scripted review responses')
    return next
  }

  async codexExec(_prompt: string, cwd: string): Promise<string> {
    const effect = this.codexEffects.shift()
    if (!effect) throw new Error('FakeAiRunner: no more scripted codex effects')
    effect(cwd)
    return 'fake codex output'
  }
}
