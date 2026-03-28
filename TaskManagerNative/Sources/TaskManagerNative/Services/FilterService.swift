import Foundation

// MARK: - Filter & Sort Engine

/// Replicates the filter and sorting logic from the web app's filters.ts.
public enum FilterService {

    // MARK: - Hashtag extraction

    public static func extractHashtags(from strings: String...) -> [String] {
        var result = Set<String>()
        let pattern = try? NSRegularExpression(pattern: #"(?:^|[\s(])#([\p{L}\p{N}_-]+)"#, options: [.useUnicodeWordBoundaries])
        for s in strings {
            let range = NSRange(s.startIndex..., in: s)
            pattern?.enumerateMatches(in: s, range: range) { match, _, _ in
                guard let match = match, match.numberOfRanges > 1 else { return }
                if let r = Range(match.range(at: 1), in: s) {
                    result.insert(String(s[r]).lowercased())
                }
            }
        }
        return Array(result)
    }

    // MARK: - Tag tree helpers

    /// Returns all descendant tag IDs (including the given IDs themselves).
    public static func expandTagIds(_ ids: [String], allTags: [TagNode]) -> Set<String> {
        var result = Set(ids)
        var changed = true
        while changed {
            changed = false
            for tag in allTags where !result.contains(tag.id) {
                if let p = tag.parentId, result.contains(p) {
                    result.insert(tag.id)
                    changed = true
                }
            }
        }
        return result
    }

    /// Returns all descendant collection IDs (including the given IDs themselves).
    public static func expandCollectionIds(_ ids: [String], parents: [String: String]) -> Set<String> {
        var result = Set(ids)
        var changed = true
        while changed {
            changed = false
            for (childId, parentId) in parents where !result.contains(childId) {
                if result.contains(parentId) {
                    result.insert(childId)
                    changed = true
                }
            }
        }
        return result
    }

    // MARK: - Task matching

    public static func taskMatchesFilter(
        _ task: TaskItem,
        filter: TaskFilter,
        allTags: [TagNode],
        collectionParents: [String: String]
    ) -> Bool {
        // Status filter
        if !filter.statuses.isEmpty && !filter.statuses.contains(task.status) { return false }

        // Collection filter
        if !filter.collectionIds.isEmpty {
            let allowed = filter.includeDescendantCollections
                ? expandCollectionIds(filter.collectionIds, parents: collectionParents)
                : Set(filter.collectionIds)
            if !allowed.contains(task.collectionId) { return false }
        }

        // Tag filter
        if !filter.tagIds.isEmpty {
            let allowed = filter.includeDescendantTags
                ? expandTagIds(filter.tagIds, allTags: allTags)
                : Set(filter.tagIds)
            if Set(task.tagIds).intersection(allowed).isEmpty { return false }
        }

        // Date preset
        if !matchesDatePreset(task, preset: filter.datePreset, customFrom: filter.customFrom, customTo: filter.customTo) {
            return false
        }

        // Text query
        if !filter.query.isEmpty {
            let q = filter.query.lowercased()
            if !task.title.lowercased().contains(q) && !task.notes.lowercased().contains(q) { return false }
        }

        return true
    }

    private static func matchesDatePreset(_ task: TaskItem, preset: DatePreset, customFrom: Date?, customTo: Date?) -> Bool {
        let cal = Calendar.current
        let now = Date()
        let startOfToday = cal.startOfDay(for: now)
        switch preset {
        case .any:
            return true
        case .overdue:
            if let due = task.dueDate { return due < startOfToday && task.status != .completed }
            return false
        case .today:
            guard let due = task.dueDate else { return false }
            return cal.isDate(due, inSameDayAs: now)
        case .next(let days):
            guard let due = task.dueDate else { return false }
            let end = cal.date(byAdding: .day, value: days, to: startOfToday)!
            return due >= startOfToday && due < end
        case .custom:
            guard let due = task.dueDate else { return false }
            if let from = customFrom, due < from { return false }
            if let to = customTo, due > to { return false }
            return true
        }
    }

    // MARK: - Sorting

    public static func sortTasks(_ tasks: [TaskItem], ordering: TaskOrdering, manualOrder: [String]? = nil) -> [TaskItem] {
        if ordering.mode == .manual, let order = manualOrder {
            var result: [TaskItem] = []
            for id in order {
                if let t = tasks.first(where: { $0.id == id }) { result.append(t) }
            }
            let remaining = tasks.filter { !Set(order).contains($0.id) }
            result.append(contentsOf: remaining)
            return result
        }

        return tasks.sorted { a, b in
            let cmp = compare(a, b, by: ordering.field)
            return ordering.direction == .asc ? cmp < 0 : cmp > 0
        }
    }

    private static func compare(_ a: TaskItem, _ b: TaskItem, by field: TaskOrderField) -> Int {
        switch field {
        case .dueDate:
            return compareDates(a.dueDate, b.dueDate)
        case .startDate:
            return compareDates(a.startDate, b.startDate)
        case .priority:
            let ap = a.priority == 0 ? Int.max : a.priority
            let bp = b.priority == 0 ? Int.max : b.priority
            return ap < bp ? -1 : ap > bp ? 1 : 0
        case .title:
            return a.title.localizedCompare(b.title) == .orderedAscending ? -1 : 1
        case .createdAt:
            return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
        case .updatedAt:
            return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0
        case .status:
            return a.status.rawValue.compare(b.status.rawValue).rawValue
        }
    }

    private static func compareDates(_ a: Date?, _ b: Date?) -> Int {
        switch (a, b) {
        case (nil, nil):   return 0
        case (nil, _):     return 1
        case (_, nil):     return -1
        case let (a?, b?): return a < b ? -1 : a > b ? 1 : 0
        }
    }
}
