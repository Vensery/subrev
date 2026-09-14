import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface ScriptResult {
  name: string
  passed: boolean
  output: string
}

const SCRIPT_NAMES = ['check.sh', 'build.sh', 'test.sh']

export function runAllScripts(repoPath: string): ScriptResult[] {
  return SCRIPT_NAMES.map((name) => runScript(repoPath, name))
}

function runScript(repoPath: string, name: string): ScriptResult {
  const scriptPath = path.join(repoPath, 'scripts', name)
  if (!existsSync(scriptPath)) {
    return { name, passed: false, output: `missing script: scripts/${name}` }
  }
  try {
    const output = execFileSync('bash', [scriptPath], { cwd: repoPath, encoding: 'utf8' })
    return { name, passed: true, output }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string }
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message
    return { name, passed: false, output }
  }
}

export function allGreen(results: ScriptResult[]): boolean {
  return results.every((result) => result.passed)
}

export function formatTestLog(results: ScriptResult[]): string {
  return results
    .map((r) => `## ${r.name} — ${r.passed ? 'PASS' : 'FAIL'}\n\n\`\`\`\n${r.output.trim()}\n\`\`\`\n`)
    .join('\n')
}
