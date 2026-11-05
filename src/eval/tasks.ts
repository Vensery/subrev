import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { EvalTaskSpec, TaskBundle } from './types.js'

export function validateSpec(raw: unknown, dirName: string): EvalTaskSpec {
  const fail = (why: string): never => {
    throw new Error(`invalid task spec in "${dirName}": ${why}`)
  }
  if (typeof raw !== 'object' || raw === null) return fail('task.json must be an object')
  const spec = raw as Record<string, unknown>
  for (const key of ['id', 'title', 'prompt', 'gate'] as const) {
    if (typeof spec[key] !== 'string' || (spec[key] as string).trim() === '') fail(`"${key}" must be a non-empty string`)
  }
  if (spec.id !== dirName) fail(`"id" (${String(spec.id)}) must match the directory name`)
  if (!Array.isArray(spec.protectedPaths) || spec.protectedPaths.some((p) => typeof p !== 'string')) {
    fail('"protectedPaths" must be an array of strings')
  }
  if (spec.acceptance !== undefined && (!Array.isArray(spec.acceptance) || spec.acceptance.some((a) => typeof a !== 'string' || a.trim() === ''))) {
    fail('"acceptance" must be an array of non-empty strings')
  }
  if (typeof spec.maxAttempts !== 'number' || !Number.isInteger(spec.maxAttempts) || spec.maxAttempts < 1) {
    fail('"maxAttempts" must be a positive integer')
  }
  return spec as unknown as EvalTaskSpec
}

export function loadTasks(tasksDir: string, onlyIds?: string[]): TaskBundle[] {
  if (!existsSync(tasksDir)) throw new Error(`tasks directory not found: ${tasksDir}`)
  const bundles: TaskBundle[] = []
  for (const name of readdirSync(tasksDir).sort()) {
    const dir = path.join(tasksDir, name)
    if (!statSync(dir).isDirectory() || !existsSync(path.join(dir, 'task.json'))) continue
    const spec = validateSpec(JSON.parse(readFileSync(path.join(dir, 'task.json'), 'utf8')), name)
    const fixtureDir = path.join(dir, 'fixture')
    if (!existsSync(fixtureDir)) throw new Error(`task "${name}" has no fixture/ directory`)
    const referenceDir = path.join(dir, 'reference')
    bundles.push({ spec, dir, fixtureDir, referenceDir: existsSync(referenceDir) ? referenceDir : undefined })
  }
  if (onlyIds && onlyIds.length > 0) {
    const known = new Set(bundles.map((b) => b.spec.id))
    const unknown = onlyIds.filter((id) => !known.has(id))
    if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(', ')}`)
    return bundles.filter((b) => onlyIds.includes(b.spec.id))
  }
  return bundles
}
