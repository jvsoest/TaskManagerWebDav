import type { TaskItem } from '../types'

const WINDOW_AHEAD_MS = 15 * 60 * 1000
const GRACE_WINDOW_MS = 5 * 60 * 1000
const MIN_CHECK_DELAY_MS = 15 * 1000
const MAX_CHECK_DELAY_MS = 30 * 60 * 1000

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

      if (dueAt <= now + WINDOW_AHEAD_MS && dueAt >= now - GRACE_WINDOW_MS) {
        const notification = new Notification(task.title || 'Task due soon', {
          body: task.notes || 'A TaskManagerWebDav task needs your attention.',
          tag: task.id,
        })
        notification.onclick = () => window.focus()
        deliveredIds.add(task.id)
      }
    })
}

export function getNextNotificationCheckDelay(tasks: TaskItem[], deliveredIds: Set<string>): number {
  const now = Date.now()
  let nextDueAt: number | undefined

  tasks
    .filter((task) => task.status !== 'completed' && !deliveredIds.has(task.id))
    .forEach((task) => {
      const dueAt =
        reminderTimestamp(task) ??
        (task.dueDate ? new Date(task.dueDate).getTime() : undefined)

      if (dueAt === undefined || Number.isNaN(dueAt)) {
        return
      }

      if (dueAt <= now + WINDOW_AHEAD_MS && dueAt >= now - GRACE_WINDOW_MS) {
        nextDueAt = now
        return
      }

      if (dueAt > now + WINDOW_AHEAD_MS) {
        const candidate = dueAt - WINDOW_AHEAD_MS
        if (nextDueAt === undefined || candidate < nextDueAt) {
          nextDueAt = candidate
        }
      }
    })

  if (nextDueAt === undefined) {
    return MAX_CHECK_DELAY_MS
  }

  return Math.min(Math.max(nextDueAt - now, MIN_CHECK_DELAY_MS), MAX_CHECK_DELAY_MS)
}
