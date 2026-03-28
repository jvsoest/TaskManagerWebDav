import Foundation

// MARK: - iCalendar Parser

/// Parses raw iCalendar (RFC 5545) text and extracts VTODO components.
public struct ICalendarParser {

    // MARK: - Public entry point

    /// Parse raw calendar data and return all VTODO items found.
    public static func parseVTODOs(from icsData: String, accountId: String, collectionId: String, resourceUrl: String?, etag: String?) -> [TaskItem] {
        var tasks: [TaskItem] = []
        let lines = unfoldLines(icsData)
        var inVTODO = false
        var inVALARM = false
        var currentProps: [String: [PropValue]] = [:]
        var currentAlarmProps: [String: String] = [:]
        var alarmBlocks: [[String: String]] = []
        var unsupportedBlocks: [String] = []
        var rawAlarmBlock = ""

        for line in lines {
            if line == "BEGIN:VTODO" {
                inVTODO = true
                currentProps = [:]
                alarmBlocks = []
                unsupportedBlocks = []
                continue
            }
            if line == "END:VTODO" {
                inVTODO = false
                if let task = buildTask(props: currentProps, alarmBlocks: alarmBlocks, unsupportedBlocks: unsupportedBlocks, accountId: accountId, collectionId: collectionId, resourceUrl: resourceUrl, etag: etag) {
                    tasks.append(task)
                }
                continue
            }
            if line == "BEGIN:VALARM" {
                inVALARM = true
                currentAlarmProps = [:]
                rawAlarmBlock = "BEGIN:VALARM"
                continue
            }
            if line == "END:VALARM" {
                inVALARM = false
                rawAlarmBlock += "\r\nEND:VALARM"
                alarmBlocks.append(currentAlarmProps)
                _ = rawAlarmBlock   // used for unsupported tracking
                continue
            }
            guard inVTODO else { continue }
            if inVALARM {
                rawAlarmBlock += "\r\n" + line
                let (name, params, value) = splitProperty(line)
                currentAlarmProps[name] = value
                _ = params
                continue
            }
            let (name, params, value) = splitProperty(line)
            currentProps[name, default: []].append(PropValue(params: params, value: value))
        }
        return tasks
    }

    // MARK: - Line unfolding (RFC 5545 §3.1)

    static func unfoldLines(_ raw: String) -> [String] {
        let normalized = raw.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var result: [String] = []
        var current = ""
        for line in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            if s.hasPrefix(" ") || s.hasPrefix("\t") {
                current += s.dropFirst()
            } else {
                if !current.isEmpty { result.append(current) }
                current = s
            }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    // MARK: - Property splitting

    struct PropValue {
        var params: [String: String]
        var value: String
    }

    static func splitProperty(_ line: String) -> (name: String, params: [String: String], value: String) {
        // Find the colon that splits name+params from value
        // Must handle quoted strings in param values
        var colonIdx: String.Index? = nil
        var inQuote = false
        var idx = line.startIndex
        while idx < line.endIndex {
            let ch = line[idx]
            if ch == "\"" { inQuote.toggle() }
            if ch == ":" && !inQuote { colonIdx = idx; break }
            idx = line.index(after: idx)
        }
        guard let ci = colonIdx else { return (line, [:], "") }
        let nameAndParams = String(line[..<ci])
        let value = unescape(String(line[line.index(after: ci)...]))

        // Split name and params by ";"
        let parts = nameAndParams.split(separator: ";", omittingEmptySubsequences: false).map { String($0) }
        let name = parts[0].uppercased()
        var params: [String: String] = [:]
        for part in parts.dropFirst() {
            if let eqIdx = part.firstIndex(of: "=") {
                let k = String(part[..<eqIdx]).uppercased()
                let v = String(part[part.index(after: eqIdx)...]).trimmingCharacters(in: .init(charactersIn: "\""))
                params[k] = v
            }
        }
        return (name, params, value)
    }

    // MARK: - Build TaskItem from collected properties

    private static func buildTask(
        props: [String: [PropValue]],
        alarmBlocks: [[String: String]],
        unsupportedBlocks: [String],
        accountId: String,
        collectionId: String,
        resourceUrl: String?,
        etag: String?
    ) -> TaskItem? {
        guard let uid = props["UID"]?.first?.value, !uid.isEmpty else { return nil }
        let summary = props["SUMMARY"]?.first?.value ?? "(no title)"
        let notes = props["DESCRIPTION"]?.first?.value ?? ""
        let statusRaw = props["STATUS"]?.first?.value ?? "NEEDS-ACTION"
        let status = TaskStatus.from(ics: statusRaw)
        let priority = Int(props["PRIORITY"]?.first?.value ?? "0") ?? 0
        let created = parseDate(props["CREATED"]?.first) ?? Date()
        let lastMod = parseDate(props["LAST-MODIFIED"]?.first) ?? created
        let completedAt = parseDate(props["COMPLETED"]?.first)

        // Dates
        let dtstart = props["DTSTART"]?.first
        let due = props["DUE"]?.first
        let startIsAllDay = dtstart.map { isAllDay($0) } ?? false
        let dueIsAllDay = due.map { isAllDay($0) } ?? false

        // Categories → tag IDs
        let categoryRaw = props["CATEGORIES"]?.first?.value ?? ""
        let tagIds: [String] = categoryRaw.isEmpty ? [] : categoryRaw.split(separator: ",").map {
            String($0).trimmingCharacters(in: .whitespaces)
        }

        // Alarms
        var reminders: [TaskReminder] = []
        for alarm in alarmBlocks {
            if let r = parseAlarm(alarm, dtstart: dtstart, due: due) {
                reminders.append(r)
            }
        }

        var item = TaskItem(
            id: uid,
            uid: uid,
            accountId: accountId,
            collectionId: collectionId,
            title: summary,
            notes: notes,
            status: status,
            priority: priority,
            startDate: parseDate(dtstart),
            dueDate: parseDate(due),
            reminders: reminders,
            tagIds: tagIds,
            syncState: .synced
        )
        item.url = resourceUrl
        item.etag = etag
        item.startDateIsAllDay = startIsAllDay
        item.dueDateIsAllDay = dueIsAllDay
        item.completedAt = completedAt
        item.createdAt = created
        item.updatedAt = lastMod
        if !unsupportedBlocks.isEmpty { item.unsupportedReminderBlocks = unsupportedBlocks }
        return item
    }

    // MARK: - Date parsing

    static func isAllDay(_ prop: PropValue) -> Bool {
        let valueParam = prop.params["VALUE"]
        return valueParam == "DATE" || prop.value.count == 8
    }

    static func parseDate(_ prop: PropValue?) -> Date? {
        guard let prop = prop else { return nil }
        let raw = prop.value.trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { return nil }
        let formatter = ISO8601DateFormatter()
        // UTC form: 20240101T120000Z
        if raw.hasSuffix("Z") {
            formatter.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime, .withTimeZone]
            if let d = formatter.date(from: raw) { return d }
            // Try without separators
            formatter.formatOptions = [.withFullDate, .withTime, .withTimeZone]
            if let d = formatter.date(from: raw) { return d }
            // Manual parse
            return parseDateManually(raw)
        }
        // All-day form: 20240101
        if raw.count == 8 {
            return parseDateManually(raw + "T000000Z")
        }
        // Floating form: 20240101T120000
        return parseDateManually(raw + "Z")
    }

    private static func parseDateManually(_ raw: String) -> Date? {
        // Expected: YYYYMMDDTHHmmssZ or YYYYMMDDZ
        var s = raw.uppercased()
        if s.hasSuffix("Z") { s = String(s.dropLast()) }
        if s.count < 8 { return nil }
        let year  = Int(s.prefix(4))
        let month = Int(s.dropFirst(4).prefix(2))
        let day   = Int(s.dropFirst(6).prefix(2))
        var hour = 0, min = 0, sec = 0
        if s.count >= 15 {
            let timePart = s.dropFirst(9) // after 'T'
            hour = Int(timePart.prefix(2)) ?? 0
            min  = Int(timePart.dropFirst(2).prefix(2)) ?? 0
            sec  = Int(timePart.dropFirst(4).prefix(2)) ?? 0
        }
        guard let y = year, let mo = month, let d = day else { return nil }
        var comps = DateComponents()
        comps.year = y; comps.month = mo; comps.day = d
        comps.hour = hour; comps.minute = min; comps.second = sec
        comps.timeZone = TimeZone(abbreviation: "UTC")
        return Calendar(identifier: .gregorian).date(from: comps)
    }

    // MARK: - Alarm parsing

    private static func parseAlarm(_ props: [String: String], dtstart: PropValue?, due: PropValue?) -> TaskReminder? {
        let action = (props["ACTION"] ?? "").uppercased()
        guard action == "DISPLAY" || action == "AUDIO" || action == "EMAIL" else { return nil }
        let id = UUID().uuidString

        if let trigger = props["TRIGGER"] {
            let trigUpper = trigger.uppercased()
            // Relative trigger: -PT15M, PT0S, etc.
            if trigUpper.hasPrefix("-P") || trigUpper.hasPrefix("P") || trigUpper.hasPrefix("-PT") {
                let minutesBefore = parseDurationMinutes(trigger)
                // Determine anchor from TRIGGER;RELATED=
                let related = props["TRIGGER;RELATED"] ?? props["RELATED"] ?? "START"
                let anchor: ReminderAnchor = related.uppercased() == "END" ? .due : .start
                return .relative(TaskReminderRelative(id: id, anchor: anchor, minutesBefore: minutesBefore))
            }
            // Absolute trigger
            let propValue = PropValue(params: [:], value: trigger)
            if let date = parseDate(propValue) {
                return .absolute(TaskReminderAbsolute(id: id, at: date))
            }
        }
        return nil
    }

    private static func parseDurationMinutes(_ raw: String) -> Int {
        var s = raw.uppercased()
        var negative = false
        if s.hasPrefix("-") { negative = true; s = String(s.dropFirst()) }
        if s.hasPrefix("P") { s = String(s.dropFirst()) }

        var total = 0
        var current = ""
        for ch in s {
            if ch.isNumber || ch == "-" {
                current.append(ch)
            } else {
                let n = Int(current) ?? 0
                switch ch {
                case "W": total += n * 7 * 24 * 60
                case "D": total += n * 24 * 60
                case "T": break  // time separator
                case "H": total += n * 60
                case "M": total += n
                case "S": total += n / 60
                default: break
                }
                current = ""
            }
        }
        return negative ? total : total
    }

    // MARK: - Unescaping

    static func unescape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "\\N", with: "\n")
            .replacingOccurrences(of: "\\,", with: ",")
            .replacingOccurrences(of: "\\;", with: ";")
            .replacingOccurrences(of: "\\\\", with: "\\")
    }
}
