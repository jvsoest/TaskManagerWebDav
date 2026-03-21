import type { TaskItem } from '../types'

export function canNotify(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!canNotify()) {
    return 'unsupported'
  }

  return Notification.requestPermission()
}

export function notifyDueTasks(tasks: TaskItem[], deliveredIds: Set<string>): void {
  if (!canNotify() || Notification.permission !== 'granted') {
    return
  }

  const now = Date.now()
  const windowAheadMs = 15 * 60 * 1000
  const graceWindowMs = 5 * 60 * 1000

  tasks
    .filter((task) => task.status !== 'completed' && task.dueDate)
    .forEach((task) => {
      if (!task.dueDate || deliveredIds.has(task.id)) {
        return
      }

      const dueAt = new Date(task.dueDate).getTime()
      if (Number.isNaN(dueAt)) {
        return
      }

      if (dueAt <= now + windowAheadMs && dueAt >= now - graceWindowMs) {
        const notification = new Notification(task.title || 'Task due soon', {
          body: task.notes || 'A TaskManagerWebDav task needs your attention.',
          tag: task.id,
        })
        notification.onclick = () => window.focus()
        deliveredIds.add(task.id)
      }
    })
}
