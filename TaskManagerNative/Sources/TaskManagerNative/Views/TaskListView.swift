import SwiftUI

// MARK: - Task List View

public struct TaskListView: View {
    @EnvironmentObject var state: AppState
    @State private var showAddTask = false
    @State private var showCompleted = false
    @State private var searchText = ""
    @State private var sortMenuVisible = false
    @State private var renamingCollection = false
    @State private var collectionRenameText = ""

    public init() {}

    private var currentTitle: String {
        if let smartId = state.activeSmartListId {
            return state.smartLists.first(where: { $0.id == smartId })?.name ?? "Smart List"
        }
        if let colId = state.activeCollectionId {
            return state.collections.first(where: { $0.id == colId })?.displayName ?? "Tasks"
        }
        return "All Tasks"
    }

    private var ordering: TaskOrdering {
        if let smartId = state.activeSmartListId {
            return state.smartLists.first(where: { $0.id == smartId })?.ordering ?? .defaultSmartList
        }
        if let colId = state.activeCollectionId,
           let accountId = state.collections.first(where: { $0.id == colId })?.accountId,
           let meta = state.metadataDocs.first(where: { $0.accountId == accountId }) {
            return meta.taskListOrderings[colId] ?? .defaultTaskList
        }
        return .defaultTaskList
    }

    private var displayedTasks: [TaskItem] {
        var base: [TaskItem]

        if let smartId = state.activeSmartListId,
           let list = state.smartLists.first(where: { $0.id == smartId }),
           let account = state.accounts.first(where: { $0.id == list.accountId }) {
            base = state.tasks(matching: list.filter, ordering: list.ordering, accountId: account.id)
            if !list.showCompleted { base = base.filter { $0.status != .completed } }
        } else if let colId = state.activeCollectionId {
            base = state.tasks.filter { $0.collectionId == colId }
            if !showCompleted { base = base.filter { $0.status != .completed } }
            base = FilterService.sortTasks(base, ordering: ordering)
        } else {
            base = state.tasks
            if !showCompleted { base = base.filter { $0.status != .completed } }
            base = FilterService.sortTasks(base, ordering: ordering)
        }

        // Apply search
        if !searchText.isEmpty {
            let q = searchText.lowercased()
            base = base.filter { $0.title.lowercased().contains(q) || $0.notes.lowercased().contains(q) }
        }
        return base
    }

    public var body: some View {
        List(selection: $state.selectedTaskId) {
            ForEach(displayedTasks) { task in
                TaskRowView(task: task)
                    .tag(task.id)
                    .swipeActions(edge: .trailing) {
                        Button("Delete", role: .destructive) {
                            Task { await state.deleteTask(task.id) }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            Task { await state.toggleTaskStatus(task.id) }
                        } label: {
                            Label(
                                task.status == .completed ? "Reopen" : "Complete",
                                systemImage: task.status == .completed ? "arrow.uturn.backward" : "checkmark"
                            )
                        }
                        .tint(task.status == .completed ? .orange : .green)
                    }
            }
        }
        .listStyle(.plain)
        .searchable(text: $searchText, prompt: "Search tasks")
        .navigationTitle(currentTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .toolbar { toolbarContent }
        .sheet(isPresented: $showAddTask) {
            TaskEditView(task: nil, collectionId: state.activeCollectionId ?? state.visibleCollections.first?.id ?? "")
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                showAddTask = true
            } label: {
                Label("New Task", systemImage: "plus")
            }
        }

        ToolbarItem(placement: .automatic) {
            Button {
                withAnimation { showCompleted.toggle() }
            } label: {
                Label(
                    showCompleted ? "Hide Completed" : "Show Completed",
                    systemImage: showCompleted ? "eye.slash" : "eye"
                )
            }
        }
    }
}

// MARK: - Task Row View

struct TaskRowView: View {
    @EnvironmentObject var state: AppState
    let task: TaskItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                Task { await state.toggleTaskStatus(task.id) }
            } label: {
                Image(systemName: task.status == .completed ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.status == .completed ? .green : .secondary)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .strikethrough(task.status == .completed)
                    .foregroundStyle(task.status == .completed ? .secondary : .primary)
                    .lineLimit(2)

                HStack(spacing: 6) {
                    if let due = task.dueDate {
                        Label(dueDateText(due), systemImage: "calendar")
                            .font(.caption)
                            .foregroundStyle(isOverdue(due, task: task) ? .red : .secondary)
                    }
                    if task.priority > 0 {
                        priorityBadge(task.priority)
                    }
                    if !task.tagIds.isEmpty {
                        tagsRow(task.tagIds)
                    }
                }
            }

            Spacer(minLength: 0)

            if task.syncState == .syncing {
                ProgressView().controlSize(.mini)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func dueDateText(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInTomorrow(date) { return "Tomorrow" }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    private func isOverdue(_ date: Date, task: TaskItem) -> Bool {
        date < Calendar.current.startOfDay(for: Date()) && task.status != .completed
    }

    @ViewBuilder
    private func priorityBadge(_ priority: Int) -> some View {
        let (label, color): (String, Color) = {
            switch priority {
            case 1...3:  return ("!!!", .red)
            case 4...6:  return ("!!", .orange)
            default:     return ("!", .yellow)
            }
        }()
        Text(label)
            .font(.caption.bold())
            .foregroundStyle(color)
    }

    @ViewBuilder
    private func tagsRow(_ tagIds: [String]) -> some View {
        let names = tagIds.prefix(3).compactMap { id in
            state.allTags.first(where: { $0.id == id })?.name
        }
        if !names.isEmpty {
            HStack(spacing: 2) {
                Image(systemName: "tag")
                    .font(.caption2)
                Text(names.joined(separator: ", "))
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
        }
    }
}
