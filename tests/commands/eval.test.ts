import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_TASKS_DIR, evalList, evalReport, evalRun, readResults } from '../../src/commands/eval.js'

describe('eval commands', () => {
  it('lists the starter tasks', () => {
    const lines = evalList(DEFAULT_TASKS_DIR)
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(lines.join('\n')).toContain('fix-map-limit')
  })

  it('runs end to end, writes results and reports, and refuses to overwrite a run', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'subrev-evalrun-'))
    const outDir = path.join(base, 'run-1')
    try {
      const summary = await evalRun({
        tasksDir: DEFAULT_TASKS_DIR,
        agents: ['mock:solve', 'mock:fail', 'mock:tamper'],
        trials: 2,
        taskIds: ['fix-off-by-one-range', 'parse-duration'],
        outDir,
      })
      const byAgent = Object.fromEntries(summary.agents.map((a) => [a.agent, a]))
      expect(byAgent['mock:solve'].macroPassAt1).toBe(1)
      expect(byAgent['mock:fail'].macroPassAt1).toBe(0)
      expect(byAgent['mock:tamper'].macroPassAt1).toBe(0)
      expect(byAgent['mock:tamper'].tampered).toBe(4)
      expect(readResults(outDir)).toHaveLength(12)
      for (const file of ['results.jsonl', 'summary.json', 'report.md', 'report.html']) {
        expect(existsSync(path.join(outDir, file)), file).toBe(true)
      }
      expect(readFileSync(path.join(outDir, 'report.md'), 'utf8')).toContain('mock:tamper')
      expect(readFileSync(path.join(outDir, 'report.html'), 'utf8')).toContain('<table>')

      expect(evalReport(outDir).agents).toHaveLength(3)
      await expect(
        evalRun({ tasksDir: DEFAULT_TASKS_DIR, agents: ['mock:solve'], trials: 1, outDir })
      ).rejects.toThrow(/refusing to overwrite/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 120_000)

  it('validates its inputs', async () => {
    const outDir = path.join(os.tmpdir(), 'subrev-evalrun-never-created')
    await expect(evalRun({ tasksDir: DEFAULT_TASKS_DIR, agents: [], trials: 1, outDir })).rejects.toThrow(/--agent/)
    await expect(evalRun({ tasksDir: DEFAULT_TASKS_DIR, agents: ['mock:solve'], trials: 0, outDir })).rejects.toThrow(/--trials/)
    await expect(evalRun({ tasksDir: DEFAULT_TASKS_DIR, agents: ['wat'], trials: 1, outDir })).rejects.toThrow(/unknown agent/)
  })
})
