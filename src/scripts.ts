import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveGateSandbox, sandboxedEnv, type GateSandbox } from './integrity/gateSandbox.js'

export interface ScriptResult {
  name: string
  passed: boolean
  output: string
}

const SCRIPT_NAMES = ['check.sh', 'build.sh', 'test.sh']

/**
 * Run the gate. Every script runs inside the gate sandbox (see integrity/gateSandbox.ts), in place,
 * so `dirname "$0"` still finds the repo. Throws GateSandboxUnavailable rather than run unconfined.
 */
export function runAllScripts(repoPath: string, sandbox: GateSandbox = resolveGateSandbox()): ScriptResult[] {
  return SCRIPT_NAMES.map((name) => runScript(repoPath, name, sandbox))
}

function runScript(repoPath: string, name: string, sandbox: GateSandbox): ScriptResult {
  const scriptPath = path.join(repoPath, 'scripts', name)
  if (!existsSync(scriptPath)) {
    return { name, passed: false, output: `missing script: scripts/${name}` }
  }
  try {
    const { cmd, args } = sandbox.command(repoPath, scriptPath)
    const output = execFileSync(cmd, args, { cwd: repoPath, encoding: 'utf8', env: sandboxedEnv(sandbox), maxBuffer: 64 * 1024 * 1024 })
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
