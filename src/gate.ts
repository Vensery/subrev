import type { TaskMeta } from './taskStore.js'

export function findPendingRetrospectives(tasks: TaskMeta[]): TaskMeta[] {
  return tasks.filter((t) => t.retrospectivePending)
}

export function assertNoRetrospectiveDebt(tasks: TaskMeta[]): void {
  const pending = findPendingRetrospectives(tasks)
  if (pending.length > 0) {
    const ids = pending.map((t) => t.taskId).join(', ')
    throw new Error(
      `Cannot start a new task: ${pending.length} task(s) have a pending retrospective (${ids}). Run "subrev retro <task-id>" first.`
    )
  }
}
