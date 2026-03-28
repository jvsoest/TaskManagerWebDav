import Foundation
import UserNotifications

// MARK: - Notification Service

/// Schedules and cancels local UNUserNotification reminders for tasks.
public final class NotificationService: @unchecked Sendable {

    public static let shared = NotificationService()

    // MARK: - Authorization

    public func requestAuthorization() async {
        do {
            let center = UNUserNotificationCenter.current()
            try await center.requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            print("[Notifications] Authorization error: \(error)")
        }
    }

    // MARK: - Schedule

    /// Schedule all pending reminders for a task, replacing any previously scheduled ones.
    public func scheduleReminders(for task: TaskItem) async {
        let center = UNUserNotificationCenter.current()
        // Remove old notifications for this task
        center.removePendingNotificationRequests(withIdentifiers: task.reminders.map { notificationId(taskId: task.id, reminderId: $0.id) })

        let authStatus = await center.notificationSettings().authorizationStatus
        guard authStatus == .authorized || authStatus == .provisional else { return }

        for reminder in task.reminders {
            guard let trigger = makeTrigger(reminder: reminder, task: task) else { continue }
            let content = UNMutableNotificationContent()
            content.title = task.title
            content.body = reminderBody(reminder: reminder)
            content.sound = .default
            let id = notificationId(taskId: task.id, reminderId: reminder.id)
            let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
            do {
                try await center.add(request)
            } catch {
                print("[Notifications] Failed to schedule \(id): \(error)")
            }
        }
    }

    /// Cancel all pending reminders for a task.
    public func cancelReminders(for task: TaskItem) {
        let center = UNUserNotificationCenter.current()
        let ids = task.reminders.map { notificationId(taskId: task.id, reminderId: $0.id) }
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    /// Cancel all pending reminders (e.g., on account removal).
    public func cancelAllReminders() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }

    // MARK: - Helpers

    private func notificationId(taskId: String, reminderId: String) -> String {
        "task-\(taskId)-reminder-\(reminderId)"
    }

    private func reminderBody(reminder: TaskReminder) -> String {
        switch reminder {
        case .absolute:
            return "Scheduled reminder"
        case .relative(let r):
            if r.minutesBefore == 0 { return "Due now" }
            let hours = r.minutesBefore / 60
            let mins  = r.minutesBefore % 60
            if hours > 0 && mins > 0 { return "Due in \(hours)h \(mins)m" }
            if hours > 0 { return "Due in \(hours) hour\(hours == 1 ? "" : "s")" }
            return "Due in \(mins) minute\(mins == 1 ? "" : "s")"
        }
    }

    private func makeTrigger(reminder: TaskReminder, task: TaskItem) -> UNNotificationTrigger? {
        switch reminder {
        case .absolute(let r):
            guard r.at > Date() else { return nil }
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: r.at)
            return UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)

        case .relative(let r):
            let anchorDate: Date?
            switch r.anchor {
            case .start: anchorDate = task.startDate
            case .due:   anchorDate = task.dueDate
            }
            guard let anchor = anchorDate else { return nil }
            let fireAt = anchor.addingTimeInterval(Double(-r.minutesBefore) * 60)
            guard fireAt > Date() else { return nil }
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireAt)
            return UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        }
    }
}
