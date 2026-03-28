import SwiftUI

// MARK: - Task Detail View

public struct TaskDetailView: View {
    @EnvironmentObject var state: AppState
    let task: TaskItem
    @State private var isEditing = false

    public init(task: TaskItem) {
        self.task = task
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Title and status
                HStack(alignment: .top) {
                    Button {
                        Task { await state.toggleTaskStatus(task.id) }
                    } label: {
                        Image(systemName: task.status == .completed ? "checkmark.circle.fill" : "circle")
                            .font(.title)
                            .foregroundStyle(task.status == .completed ? .green : .secondary)
                    }
                    .buttonStyle(.plain)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                            .font(.title2.bold())
                            .strikethrough(task.status == .completed)
                        Text(statusLabel(task.status))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Divider()

                // Dates
                if task.dueDate != nil || task.startDate != nil {
                    VStack(alignment: .leading, spacing: 8) {
                        if let due = task.dueDate {
                            DetailRow(icon: "calendar", label: "Due", value: formatDate(due, allDay: task.dueDateIsAllDay ?? false))
                                .foregroundStyle(isOverdue(due) && task.status != .completed ? .red : .primary)
                        }
                        if let start = task.startDate {
                            DetailRow(icon: "calendar.badge.clock", label: "Start", value: formatDate(start, allDay: task.startDateIsAllDay ?? false))
                        }
                    }
                    Divider()
                }

                // Priority
                if task.priority > 0 {
                    DetailRow(icon: "exclamationmark.circle", label: "Priority", value: priorityLabel(task.priority))
                    Divider()
                }

                // Tags
                if !task.tagIds.isEmpty {
                    tagSection
                    Divider()
                }

                // Collection
                if let col = state.collections.first(where: { $0.id == task.collectionId }) {
                    DetailRow(icon: "list.bullet", label: "List", value: col.displayName)
                    Divider()
                }

                // Reminders
                if !task.reminders.isEmpty {
                    reminderSection
                    Divider()
                }

                // Notes
                if !task.notes.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Notes", systemImage: "note.text")
                            .font(.headline)
                        Text(task.notes)
                            .font(.body)
                    }
                    Divider()
                }

                // Meta
                VStack(alignment: .leading, spacing: 4) {
                    if let updated = task.updatedAt as Date? {
                        Text("Updated: \(formatDateFull(updated))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Text("Created: \(formatDateFull(task.createdAt))")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding()
        }
        .navigationTitle("")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { isEditing = true }
            }
            ToolbarItem(placement: .destructiveAction) {
                Button("Delete", role: .destructive) {
                    Task {
                        await state.deleteTask(task.id)
                        state.selectedTaskId = nil
                    }
                }
            }
        }
        .sheet(isPresented: $isEditing) {
            TaskEditView(task: task, collectionId: task.collectionId)
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var tagSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Tags", systemImage: "tag")
                .font(.headline)
            FlowLayout {
                ForEach(task.tagIds, id: \.self) { tagId in
                    if let tag = state.allTags.first(where: { $0.id == tagId }) {
                        TagChip(name: tag.name)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var reminderSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Reminders", systemImage: "bell")
                .font(.headline)
            ForEach(task.reminders) { reminder in
                Text(reminderDescription(reminder))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Formatting helpers

    private func statusLabel(_ status: TaskStatus) -> String {
        switch status {
        case .needsAction: return "Needs Action"
        case .inProcess:   return "In Process"
        case .completed:   return "Completed"
        case .cancelled:   return "Cancelled"
        }
    }

    private func priorityLabel(_ priority: Int) -> String {
        switch priority {
        case 1...3:  return "High"
        case 4...6:  return "Medium"
        case 7...9:  return "Low"
        default:     return "None"
        }
    }

    private func formatDate(_ date: Date, allDay: Bool) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = allDay ? .none : .short
        return formatter.string(from: date)
    }

    private func formatDateFull(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private func isOverdue(_ date: Date) -> Bool {
        date < Calendar.current.startOfDay(for: Date())
    }

    private func reminderDescription(_ reminder: TaskReminder) -> String {
        switch reminder {
        case .absolute(let r):
            return formatDate(r.at, allDay: false)
        case .relative(let r):
            let anchor = r.anchor == .due ? "due date" : "start date"
            if r.minutesBefore == 0 { return "At \(anchor)" }
            let hours = r.minutesBefore / 60
            let mins  = r.minutesBefore % 60
            var s = ""
            if hours > 0 { s += "\(hours)h " }
            if mins  > 0 { s += "\(mins)m " }
            return "\(s.trimmingCharacters(in: .whitespaces)) before \(anchor)"
        }
    }
}

// MARK: - Detail Row

struct DetailRow: View {
    let icon: String
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .frame(width: 24)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.body)
            }
        }
    }
}

// MARK: - Tag Chip

struct TagChip: View {
    let name: String

    var body: some View {
        Text("#\(name)")
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.quaternary, in: Capsule())
    }
}

// MARK: - Flow Layout (wrapping HStack)

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var height: CGFloat = 0
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if rowWidth + size.width > maxWidth && rowWidth > 0 {
                height += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        height += rowHeight
        return CGSize(width: maxWidth, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
