import type { MetadataDocument, TaskItem } from '../types'

const TASK_ID_SEPARATOR = '::'

export function buildTaskId(collectionId: string, uid: string): string {
  return `${collectionId}${TASK_ID_SEPARATOR}${uid}`
}

export function isScopedTaskId(taskId: string): boolean {
  return taskId.includes(TASK_ID_SEPARATOR)
}

export function normalizeTaskIdentity(task: TaskItem): TaskItem {
  return {
    ...task,
    id: buildTaskId(task.collectionId, task.uid),
  }
}

export function normalizeManualTaskOrder(
  manualTaskOrder: MetadataDocument['manualTaskOrder'],
): MetadataDocument['manualTaskOrder'] {
  return Object.fromEntries(
    Object.entries(manualTaskOrder).map(([collectionId, taskIds]) => [
      collectionId,
      (taskIds ?? []).map((taskId) =>
        isScopedTaskId(taskId) ? taskId : buildTaskId(collectionId, taskId),
      ),
    ]),
  )
}
