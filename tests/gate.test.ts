import { describe, it, expect } from 'vitest'
import { findPendingRetrospectives, assertNoRetrospectiveDebt } from '../src/gate.js'
import type { TaskMeta } from '../src/taskStore.js'

function meta(taskId: string, retrospectivePending: boolean): TaskMeta {
  return {
    taskId,
    project: 'acme',
    repoKey: 'main',
    branch: `task/${taskId}`,
    status: 'abandoned',
    round: 3,
    planVersion: 1,
    retrospectivePending,
    createdAt: '2026-07-08T00:00:00.000Z',
  }
}

describe('findPendingRetrospectives', () => {
  it('filters to only tasks with retrospectivePending', () => {
    const tasks = [meta('a', false), meta('b', true)]
    expect(findPendingRetrospectives(tasks).map((t) => t.taskId)).toEqual(['b'])
  })
})

describe('assertNoRetrospectiveDebt', () => {
  it('does not throw when nothing is pending', () => {
    expect(() => assertNoRetrospectiveDebt([meta('a', false)])).not.toThrow()
  })

  it('throws naming the pending task ids', () => {
    expect(() => assertNoRetrospectiveDebt([meta('a', true), meta('b', false)])).toThrow(/a/)
  })
})
