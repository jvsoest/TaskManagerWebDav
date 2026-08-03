import type { TaskItem } from '../types'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

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

function taskNotificationTimestamp(task: TaskItem): number | undefined {
  const timestamp = reminderTimestamp(task) ?? (task.dueDate ? new Date(task.dueDate).getTime() : undefined)
  return timestamp !== undefined && !Number.isNaN(timestamp) ? timestamp : undefined
}

export function usesNativeNotifications(): boolean {
  return Capacitor.getPlatform() === 'ios'
}

function nativeNotificationId(taskId: string): number {
  let hash = 0
  for (let index = 0; index < taskId.length; index += 1) {
    hash = (Math.imul(hash, 31) + taskId.charCodeAt(index)) | 0
  }
  return Math.max(1, Math.abs(hash))
}

export async function syncNativeNotifications(tasks: TaskItem[]): Promise<void> {
  if (!usesNativeNotifications()) {
    return
  }

  let permission = await LocalNotifications.checkPermissions()
  const schedulableTasks = tasks.filter((task) => task.status !== 'completed' && taskNotificationTimestamp(task) !== undefined)
  if (permission.display === 'prompt' && schedulableTasks.length > 0) {
    permission = await LocalNotifications.requestPermissions()
  }
  if (permission.display !== 'granted') {
    return
  }

  const pending = await LocalNotifications.getPending()
  if (pending.notifications.length > 0) {
    await LocalNotifications.cancel({
      notifications: pending.notifications.map(({ id }) => ({ id })),
    })
  }

  const now = Date.now()
  const notifications = schedulableTasks
    .map((task) => ({ task, at: taskNotificationTimestamp(task) }))
    .filter((entry): entry is { task: TaskItem; at: number } => typeof entry.at === 'number' && entry.at > now)
    .sort((left, right) => left.at - right.at)
    .slice(0, 64)
    .map(({ task, at }) => ({
      id: nativeNotificationId(task.id),
      title: task.title || 'Task due soon',
      body: task.notes || 'A TaskManagerWebDav task needs your attention.',
      schedule: { at: new Date(at) },
      extra: { taskId: task.id, accountId: task.accountId },
    }))

  if (notifications.length > 0) {
    await LocalNotifications.schedule({ notifications })
  }
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

      const dueAt = taskNotificationTimestamp(task)

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
      const dueAt = taskNotificationTimestamp(task)

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
