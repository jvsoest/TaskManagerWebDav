import Foundation

// MARK: - iCalendar Serializer

/// Serializes TaskItem values to RFC 5545 iCalendar (VCALENDAR/VTODO) text.
public struct ICalendarSerializer {

    public static func serialize(_ task: TaskItem) -> String {
        var lines: [String] = []
        lines.append("BEGIN:VCALENDAR")
        lines.append("VERSION:2.0")
        lines.append("PRODID:-//TaskManagerNative//NONSGML v1.0//EN")
        lines.append("BEGIN:VTODO")
        lines.append("UID:\(task.uid)")
        lines.append(fold("SUMMARY:" + escape(task.title)))
        if !task.notes.isEmpty {
            lines.append(fold("DESCRIPTION:" + escape(task.notes)))
        }
        lines.append("STATUS:\(task.status.icsValue)")
        lines.append("PRIORITY:\(task.priority)")
        lines.append(dateTimeLine("CREATED", date: task.createdAt, allDay: false))
        lines.append(dateTimeLine("LAST-MODIFIED", date: task.updatedAt, allDay: false))
        if let dt = task.startDate {
            lines.append(dateTimeLine("DTSTART", date: dt, allDay: task.startDateIsAllDay ?? false))
        }
        if let dt = task.dueDate {
            lines.append(dateTimeLine("DUE", date: dt, allDay: task.dueDateIsAllDay ?? false))
        }
        if let dt = task.completedAt {
            lines.append(dateTimeLine("COMPLETED", date: dt, allDay: false))
        }
        if !task.tagIds.isEmpty {
            lines.append(fold("CATEGORIES:" + task.tagIds.map { escape($0) }.joined(separator: ",")))
        }
        for reminder in task.reminders {
            lines.append(contentsOf: serializeAlarm(reminder, task: task))
        }
        for block in task.unsupportedReminderBlocks ?? [] {
            lines.append(block)
        }
        lines.append("END:VTODO")
        lines.append("END:VCALENDAR")
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    // MARK: - Alarm serialization

    private static func serializeAlarm(_ reminder: TaskReminder, task: TaskItem) -> [String] {
        var lines: [String] = ["BEGIN:VALARM", "ACTION:DISPLAY"]
        switch reminder {
        case .absolute(let r):
            lines.append("DESCRIPTION:Reminder")
            lines.append(dateTimeLine("TRIGGER;VALUE=DATE-TIME", date: r.at, allDay: false))
        case .relative(let r):
            lines.append("DESCRIPTION:Reminder")
            let duration = formatDuration(r.minutesBefore)
            let related = r.anchor == .due ? "END" : "START"
            lines.append("TRIGGER;RELATED=\(related):\(duration)")
        }
        lines.append("END:VALARM")
        return lines
    }

    // MARK: - Date/time formatting

    private static let utcFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate, .withTime, .withTimeZone]
        f.timeZone = TimeZone(abbreviation: "UTC")
        return f
    }()

    private static func dateTimeLine(_ prop: String, date: Date, allDay: Bool) -> String {
        if allDay {
            let cal = Calendar(identifier: .gregorian)
            let comps = cal.dateComponents(in: TimeZone(abbreviation: "UTC")!, from: date)
            let y = comps.year ?? 2000
            let m = comps.month ?? 1
            let d = comps.day ?? 1
            return String(format: "%@;VALUE=DATE:%04d%02d%02d", prop, y, m, d)
        } else {
            // Format as YYYYMMDDTHHmmssZ
            let s = utcFormatter.string(from: date)
                .replacingOccurrences(of: "-", with: "")
                .replacingOccurrences(of: ":", with: "")
            return "\(prop):\(s)"
        }
    }

    // MARK: - Duration formatting

    static func formatDuration(_ minutesBefore: Int) -> String {
        let total = minutesBefore
        if total <= 0 { return "PT0S" }
        let hours = total / 60
        let mins  = total % 60
        if hours > 0 && mins > 0 { return "-PT\(hours)H\(mins)M" }
        if hours > 0 { return "-PT\(hours)H" }
        return "-PT\(mins)M"
    }

    // MARK: - Line folding (RFC 5545 §3.1 — max 75 octets per line)

    static func fold(_ line: String) -> String {
        var result = ""
        var count = 0
        for char in line.unicodeScalars {
            let encoded = String(char).utf8.count
            if count + encoded > 75 {
                result += "\r\n "
                count = 1
            }
            result += String(char)
            count += encoded
        }
        return result
    }

    // MARK: - Value escaping

    static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: ",", with: "\\,")
            .replacingOccurrences(of: ";", with: "\\;")
    }
}
