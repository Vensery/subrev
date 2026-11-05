import { cpSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runProcess, parseClaudeJson } from '../aiRunner.js'

export { parseClaudeJson }
import type { AgentAdapter, AgentRequest, AgentResponse, AgentUsage } from './types.js'
import { createPipelineAdapter } from './pipelineAdapter.js'

export const MOCK_MODES = ['solve', 'fail', 'retry', 'flaky', 'tamper'] as const
export type MockMode = (typeof MOCK_MODES)[number]

function fnv1a(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mockShouldSolve(mode: MockMode, request: AgentRequest): boolean {
  switch (mode) {
    case 'solve':
      return true
    case 'retry':
      return request.attempt >= 2
    case 'flaky':
      // Deterministic pseudo-random per (task, trial): reproducible, but mixed across trials.
      return fnv1a(`${request.task.id}:${request.trial}`) % 2 === 0
    default:
      return false
  }
}

function applyReference(request: AgentRequest): void {
  if (!request.referenceDir || !existsSync(request.referenceDir)) {
    throw new Error(`task "${request.task.id}" has no reference/ directory; the mock adapter cannot solve it`)
  }
  cpSync(request.referenceDir, request.cwd, { recursive: true, force: true })
}

const NOOP_TEST = `import test from 'node:test'\ntest('noop', () => {})\n`

function neutralizeProtected(request: AgentRequest): void {
  const visit = (abs: string): void => {
    if (!existsSync(abs)) return
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) visit(path.join(abs, name))
    } else if (abs.endsWith('.js') || abs.endsWith('.mjs')) {
      writeFileSync(abs, NOOP_TEST)
    }
  }
  for (const rel of request.task.protectedPaths) visit(path.join(request.cwd, rel))
}

/**
 * Deterministic stand-in agent. It exists so the harness itself (sandboxing, gate, tamper
 * detection, metrics, reports) can be tested without spending model quota; its numbers say
 * nothing about any real model.
 */
export function createMockAdapter(mode: MockMode): AgentAdapter {
  return {
    name: `mock:${mode}`,
    async run(request): Promise<AgentResponse> {
      if (mode === 'tamper') {
        neutralizeProtected(request)
        return { stdout: 'mock tamper: replaced protected tests with no-ops' }
      }
      const solve = mockShouldSolve(mode, request)
      if (solve) applyReference(request)
      return { stdout: `mock ${mode}: ${solve ? 'applied reference solution' : 'made no changes'}` }
    },
  }
}

function extraArgs(envName: string, fallback: string[]): string[] {
  const raw = process.env[envName]
  return raw && raw.trim() ? raw.trim().split(/\s+/) : fallback
}

/** `claude -p --output-format json` reports usage and cost; tolerate any other shape. */

/**
 * Real-CLI adapters. Flags can be overridden with SUBREV_EVAL_CLAUDE_ARGS / SUBREV_EVAL_CODEX_ARGS
 * because CLI flags drift between versions and this code has not been validated against every one.
 */
export function createCliAdapter(kind: 'claude' | 'codex', model?: string): AgentAdapter {
  const name = model ? `${kind}:${model}` : kind
  return {
    name,
    async run(request): Promise<AgentResponse> {
      if (kind === 'claude') {
        const args = [
          '-p',
          request.prompt,
          ...(model ? ['--model', model] : []),
          ...extraArgs('SUBREV_EVAL_CLAUDE_ARGS', [
            '--output-format',
            'json',
            '--permission-mode',
            'acceptEdits',
            '--allowedTools',
            'Bash,Edit,Write,Read,Glob,Grep',
          ]),
        ]
        return parseClaudeJson(await runProcess('claude', args, request.cwd, request.timeoutMs))
      }
      const args = [
        'exec',
        ...extraArgs('SUBREV_EVAL_CODEX_ARGS', ['-s', 'workspace-write']),
        ...(model ? ['-m', model] : []),
        request.prompt,
      ]
      return { stdout: await runProcess('codex', args, request.cwd, request.timeoutMs) }
    },
  }
}

export function parseAdapterSpec(spec: string): AgentAdapter {
  const [kind, ...rest] = spec.split(':')
  const arg = rest.join(':') || undefined
  if (kind === 'mock') {
    if (!arg || !(MOCK_MODES as readonly string[]).includes(arg)) {
      throw new Error(`unknown mock mode "${arg ?? ''}"; expected one of: ${MOCK_MODES.join(', ')}`)
    }
    return createMockAdapter(arg as MockMode)
  }
  if (kind === 'claude' || kind === 'codex') return createCliAdapter(kind, arg)
  if (kind === 'subrev') return createPipelineAdapter(arg)
  throw new Error(`unknown agent "${spec}"; expected mock:<mode>, claude[:model], codex[:model], or subrev[:options]`)
}
