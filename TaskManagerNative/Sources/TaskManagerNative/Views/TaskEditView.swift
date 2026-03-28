import SwiftUI

// MARK: - Task Edit View

public struct TaskEditView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    let existingTask: TaskItem?
    let initialCollectionId: String

    @State private var title: String
    @State private var notes: String
    @State private var status: TaskStatus
    @State private var priority: Int
    @State private var hasDueDate: Bool
    @State private var dueDate: Date
    @State private var dueDateIsAllDay: Bool
    @State private var hasStartDate: Bool
    @State private var startDate: Date
    @State private var startDateIsAllDay: Bool
    @State private var collectionId: String
    @State private var selectedTagIds: Set<String>
    @State private var reminders: [TaskReminder]
    @State private var showAddReminder = false
    @State private var isLoading = false

    public init(task: TaskItem?, collectionId: String) {
        self.existingTask = task
        self.initialCollectionId = collectionId
        if let t = task {
            _title = State(initialValue: t.title)
            _notes = State(initialValue: t.notes)
            _status = State(initialValue: t.status)
            _priority = State(initialValue: t.priority)
            _hasDueDate = State(initialValue: t.dueDate != nil)
            _dueDate = State(initialValue: t.dueDate ?? Date())
            _dueDateIsAllDay = State(initialValue: t.dueDateIsAllDay ?? false)
            _hasStartDate = State(initialValue: t.startDate != nil)
            _startDate = State(initialValue: t.startDate ?? Date())
            _startDateIsAllDay = State(initialValue: t.startDateIsAllDay ?? false)
            _collectionId = State(initialValue: t.collectionId)
            _selectedTagIds = State(initialValue: Set(t.tagIds))
            _reminders = State(initialValue: t.reminders)
        } else {
            _title = State(initialValue: "")
            _notes = State(initialValue: "")
            _status = State(initialValue: .needsAction)
            _priority = State(initialValue: 0)
            _hasDueDate = State(initialValue: false)
            _dueDate = State(initialValue: Date())
            _dueDateIsAllDay = State(initialValue: true)
            _hasStartDate = State(initialValue: false)
            _startDate = State(initialValue: Date())
            _startDateIsAllDay = State(initialValue: true)
            _collectionId = State(initialValue: collectionId)
            _selectedTagIds = State(initialValue: [])
            _reminders = State(initialValue: [])
        }
    }

    private var accountId: String {
        state.collections.first(where: { $0.id == collectionId })?.accountId ?? state.accounts.first?.id ?? ""
    }

    private var accountTags: [TagNode] {
        state.tags(for: accountId)
    }

    public var body: some View {
        NavigationStack {
            Form {
                // Title & Notes
                Section {
                    TextField("Task Title", text: $title, axis: .vertical)
                        .font(.headline)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(4...)
                        .font(.body)
                }

                // Status & Priority
                Section("Details") {
                    Picker("Status", selection: $status) {
                        Text("Needs Action").tag(TaskStatus.needsAction)
                        Text("In Process").tag(TaskStatus.inProcess)
                        Text("Completed").tag(TaskStatus.completed)
                        Text("Cancelled").tag(TaskStatus.cancelled)
                    }
                    Picker("Priority", selection: $priority) {
                        Text("None").tag(0)
                        Text("High").tag(1)
                        Text("Medium").tag(5)
                        Text("Low").tag(9)
                    }
                }

                // Dates
                Section("Dates") {
                    Toggle("Due Date", isOn: $hasDueDate.animation())
                    if hasDueDate {
                        Toggle("All Day", isOn: $dueDateIsAllDay)
                        if dueDateIsAllDay {
                            DatePicker("Due", selection: $dueDate, displayedComponents: .date)
                        } else {
                            DatePicker("Due", selection: $dueDate, displayedComponents: [.date, .hourAndMinute])
                        }
                    }
                    Toggle("Start Date", isOn: $hasStartDate.animation())
                    if hasStartDate {
                        Toggle("All Day", isOn: $startDateIsAllDay)
                        if startDateIsAllDay {
                            DatePicker("Start", selection: $startDate, displayedComponents: .date)
                        } else {
                            DatePicker("Start", selection: $startDate, displayedComponents: [.date, .hourAndMinute])
                        }
                    }
                }

                // List
                Section("List") {
                    Picker("List", selection: $collectionId) {
                        ForEach(state.visibleCollections) { col in
                            Text(col.displayName).tag(col.id)
                        }
                    }
                }

                // Tags
                if !accountTags.isEmpty {
                    Section("Tags") {
                        ForEach(accountTags) { tag in
                            HStack {
                                Text("#\(tag.name)")
                                Spacer()
                                if selectedTagIds.contains(tag.id) {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if selectedTagIds.contains(tag.id) {
                                    selectedTagIds.remove(tag.id)
                                } else {
                                    selectedTagIds.insert(tag.id)
                                }
                            }
                        }
                    }
                }

                // Reminders
                Section("Reminders") {
                    ForEach(reminders) { reminder in
                        HStack {
                            Text(reminderLabel(reminder))
                            Spacer()
                            Button("Remove", role: .destructive) {
                                reminders.removeAll { $0.id == reminder.id }
                            }
                            .font(.caption)
                        }
                    }
                    Button("Add Reminder") { showAddReminder = true }
                }
            }
            .navigationTitle(existingTask == nil ? "New Task" : "Edit Task")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existingTask == nil ? "Create" : "Save") {
                        Task { await save() }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || isLoading)
                }
            }
            .sheet(isPresented: $showAddReminder) {
                AddReminderView { reminder in
                    reminders.append(reminder)
                }
            }
        }
    }

    // MARK: - Save

    private func save() async {
        isLoading = true
        var draft = existingTask ?? TaskItem(
            accountId: accountId,
            collectionId: collectionId,
            title: title
        )
        draft.title = title.trimmingCharacters(in: .whitespaces)
        draft.notes = notes
        draft.status = status
        draft.priority = priority
        draft.dueDate = hasDueDate ? dueDate : nil
        draft.dueDateIsAllDay = hasDueDate ? dueDateIsAllDay : nil
        draft.startDate = hasStartDate ? startDate : nil
        draft.startDateIsAllDay = hasStartDate ? startDateIsAllDay : nil
        draft.tagIds = Array(selectedTagIds)
        draft.reminders = reminders
        draft.collectionId = collectionId
        draft.updatedAt = Date()

        if existingTask == nil {
            var d = TaskDraft()
            d.title = draft.title
            d.notes = draft.notes
            d.status = draft.status
            d.priority = draft.priority
            d.startDate = draft.startDate
            d.dueDate = draft.dueDate
            d.reminders = draft.reminders
            d.tagIds = draft.tagIds
            await state.createTask(d, in: collectionId)
        } else {
            await state.updateTask(draft)
        }
        isLoading = false
        dismiss()
    }

    // MARK: - Reminder label

    private func reminderLabel(_ reminder: TaskReminder) -> String {
        switch reminder {
        case .absolute(let r):
            let f = DateFormatter()
            f.dateStyle = .short; f.timeStyle = .short
            return f.string(from: r.at)
        case .relative(let r):
            let anchor = r.anchor == .due ? "due" : "start"
            if r.minutesBefore == 0 { return "At \(anchor)" }
            let h = r.minutesBefore / 60, m = r.minutesBefore % 60
            if h > 0 && m > 0 { return "\(h)h \(m)m before \(anchor)" }
            if h > 0 { return "\(h)h before \(anchor)" }
            return "\(m)m before \(anchor)"
        }
    }
}

// MARK: - Add Reminder View

struct AddReminderView: View {
    @Environment(\.dismiss) private var dismiss
    var onAdd: (TaskReminder) -> Void

    @State private var kind: String = "relative"
    @State private var absoluteDate = Date().addingTimeInterval(3600)
    @State private var minutesBefore: Int = 15
    @State private var anchor: ReminderAnchor = .due

    private let presetMinutes = [0, 5, 10, 15, 30, 60, 120, 1440]

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $kind) {
                    Text("Relative").tag("relative")
                    Text("Specific Date").tag("absolute")
                }
                .pickerStyle(.segmented)
                .listRowInsets(.init())
                .listRowBackground(Color.clear)

                if kind == "relative" {
                    Picker("Before", selection: $minutesBefore) {
                        ForEach(presetMinutes, id: \.self) { m in
                            Text(minuteLabel(m)).tag(m)
                        }
                    }
                    Picker("Anchor", selection: $anchor) {
                        Text("Due Date").tag(ReminderAnchor.due)
                        Text("Start Date").tag(ReminderAnchor.start)
                    }
                } else {
                    DatePicker("Date & Time", selection: $absoluteDate, displayedComponents: [.date, .hourAndMinute])
                }
            }
            .navigationTitle("Add Reminder")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let id = UUID().uuidString
                        if kind == "absolute" {
                            onAdd(.absolute(TaskReminderAbsolute(id: id, at: absoluteDate)))
                        } else {
                            onAdd(.relative(TaskReminderRelative(id: id, anchor: anchor, minutesBefore: minutesBefore)))
                        }
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func minuteLabel(_ m: Int) -> String {
        if m == 0 { return "At time" }
        if m < 60 { return "\(m) minutes before" }
        let h = m / 60; let rem = m % 60
        if rem == 0 { return "\(h) hour\(h == 1 ? "" : "s") before" }
        return "\(h)h \(rem)m before"
    }
}
