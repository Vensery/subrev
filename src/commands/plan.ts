import type { AiRunner } from '../aiRunner.js'
import { readTaskFile, writeTaskFile } from '../taskStore.js'

export function buildPlanPrompt(brief: string): string {
  return [
    'You are drafting an implementation plan. Do not edit any files.',
    'Read the brief below and produce a plan with exactly two sections:',
    '## Files — a bullet list of file paths you expect to touch, one per line, e.g. "- src/foo.ts".',
    '## Acceptance criteria — a list of items with explicit IDs, one per line: "- AC-1: ...", "- AC-2: ...", never prose.',
    'Each item must be independently checkable from the code or a test. If an existing or planned test checks it,',
    'append "[tests: <test name or file>]" to that item.',
    'A later review step checks each AC id independently as covered/missing, and maps every change in the diff to an AC id.',
    '',
    '## Brief',
    brief,
  ].join('\n')
}

export async function planTask(ai: AiRunner, repoPath: string, taskId: string): Promise<string> {
  const brief = readTaskFile(repoPath, taskId, 'brief.md')
  if (!brief) throw new Error(`brief.md not found for task ${taskId}`)
  const plan = await ai.claudePlan(buildPlanPrompt(brief), repoPath)
  writeTaskFile(repoPath, taskId, 'plan.md', plan)
  return plan
}
