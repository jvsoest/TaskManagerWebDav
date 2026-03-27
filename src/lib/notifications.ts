import type { TaskItem } from '../types'

function reminderTimestamp(task: TaskItem): number | undefined {
  const upcoming = task.reminders
    .map((reminder) => {
      if (reminder.kind === 'absolute') {
        return new Date(reminder.at).getTime()
      }

      const anchorValue = reminder.anchor === 'start' ? task.startDate : task.dueDate
      if (!anchorValue) {
        return undefined
      }

      const anchorTime = new Date(anchorValue).getTime()
      return Number.isNaN(anchorTime) ? undefined : anchorTime - reminder.minutesBefore * 60_000
    })
    .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value))
    .sort((left, right) => left - right)

  return upcoming[0]
}

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
    .filter((task) => task.status !== 'completed')
    .forEach((task) => {
      if (deliveredIds.has(task.id)) {
        return
      }

      const dueAt =
        reminderTimestamp(task) ??
        (task.dueDate ? new Date(task.dueDate).getTime() : undefined)

      if (dueAt === undefined) {
        return
      }

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
