import SwiftUI

// MARK: - Smart List Builder View

public struct SmartListBuilderView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    let existing: SmartList?

    @State private var name: String
    @State private var selectedAccountId: String
    @State private var filter: TaskFilter
    @State private var ordering: TaskOrdering
    @State private var showCompleted: Bool
    @State private var isLoading = false

    public init(existing: SmartList?) {
        self.existing = existing
        _name = State(initialValue: existing?.name ?? "")
        _selectedAccountId = State(initialValue: existing?.accountId ?? "")
        _filter = State(initialValue: existing?.filter ?? .default)
        _ordering = State(initialValue: existing?.ordering ?? .defaultSmartList)
        _showCompleted = State(initialValue: existing?.showCompleted ?? false)
    }

    private var previewCount: Int {
        guard let account = state.accounts.first(where: { $0.id == selectedAccountId }) ?? state.accounts.first else { return 0 }
        return state.tasks(matching: filter, ordering: ordering, accountId: account.id).count
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Smart List Name", text: $name)
                }

                if state.accounts.count > 1 {
                    Section("Account") {
                        Picker("Account", selection: $selectedAccountId) {
                            ForEach(state.accounts) { account in
                                Text(account.label.isEmpty ? account.displayName : account.label)
                                    .tag(account.id)
                            }
                        }
                    }
                }

                // Status filter
                Section("Status") {
                    ForEach([TaskStatus.needsAction, .inProcess, .completed, .cancelled], id: \.self) { s in
                        HStack {
                            Text(statusLabel(s))
                            Spacer()
                            if filter.statuses.contains(s) {
                                Image(systemName: "checkmark").foregroundStyle(.tint)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            toggleStatus(s)
                        }
                    }
                }

                // Date filter
                Section("Date") {
                    Picker("Date Range", selection: $filter.datePreset) {
                        Text("Any").tag(DatePreset.any)
                        Text("Overdue").tag(DatePreset.overdue)
                        Text("Today").tag(DatePreset.today)
                        Text("Next 7 days").tag(DatePreset.next(7))
                        Text("Next 30 days").tag(DatePreset.next(30))
                        Text("Custom").tag(DatePreset.custom)
                    }
                    if case .custom = filter.datePreset {
                        DatePicker("From", selection: Binding(
                            get: { filter.customFrom ?? Date() },
                            set: { filter.customFrom = $0 }
                        ), displayedComponents: .date)
                        DatePicker("To", selection: Binding(
                            get: { filter.customTo ?? Date() },
                            set: { filter.customTo = $0 }
                        ), displayedComponents: .date)
                    }
                }

                // Text search
                Section("Search") {
                    TextField("Contains text", text: $filter.query)
                        .autocorrectionDisabled()
                }

                // Collections filter
                let accountId = selectedAccountId.isEmpty ? (state.accounts.first?.id ?? "") : selectedAccountId
                let accountCollections = state.visibleCollections.filter { $0.accountId == accountId }
                if !accountCollections.isEmpty {
                    Section {
                        Toggle("Filter by list", isOn: Binding(
                            get: { !filter.collectionIds.isEmpty },
                            set: { if !$0 { filter.collectionIds = [] } }
                        ))
                        if !filter.collectionIds.isEmpty {
                            Toggle("Include sub-lists", isOn: $filter.includeDescendantCollections)
                            ForEach(accountCollections) { col in
                                HStack {
                                    Text(col.displayName)
                                    Spacer()
                                    if filter.collectionIds.contains(col.id) {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                                .contentShape(Rectangle())
                                .onTapGesture { toggleCollection(col.id) }
                            }
                        }
                    } header: {
                        Text("Lists")
                    }
                }

                // Tags filter
                let allTags = state.tags(for: accountId)
                if !allTags.isEmpty {
                    Section {
                        Toggle("Filter by tag", isOn: Binding(
                            get: { !filter.tagIds.isEmpty },
                            set: { if !$0 { filter.tagIds = [] } }
                        ))
                        if !filter.tagIds.isEmpty {
                            Toggle("Include sub-tags", isOn: $filter.includeDescendantTags)
                            ForEach(allTags) { tag in
                                HStack {
                                    Text("#\(tag.name)")
                                    Spacer()
                                    if filter.tagIds.contains(tag.id) {
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                                .contentShape(Rectangle())
                                .onTapGesture { toggleTag(tag.id) }
                            }
                        }
                    } header: {
                        Text("Tags")
                    }
                }

                // Sort order
                Section("Sort Order") {
                    Picker("Sort by", selection: $ordering.field) {
                        Text("Due Date").tag(TaskOrderField.dueDate)
                        Text("Start Date").tag(TaskOrderField.startDate)
                        Text("Priority").tag(TaskOrderField.priority)
                        Text("Title").tag(TaskOrderField.title)
                        Text("Created").tag(TaskOrderField.createdAt)
                        Text("Updated").tag(TaskOrderField.updatedAt)
                    }
                    Picker("Direction", selection: $ordering.direction) {
                        Text("Ascending").tag(SortDirection.asc)
                        Text("Descending").tag(SortDirection.desc)
                    }
                }

                // Show completed
                Section {
                    Toggle("Show Completed Tasks", isOn: $showCompleted)
                }

                // Preview
                Section {
                    Text("\(previewCount) task\(previewCount == 1 ? "" : "s") match this filter")
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Preview")
                }
            }
            .navigationTitle(existing == nil ? "New Smart List" : "Edit Smart List")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Button(existing == nil ? "Create" : "Save") {
                            Task { await save() }
                        }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
    }

    // MARK: - Save

    private func save() async {
        isLoading = true
        let accountId = selectedAccountId.isEmpty ? (state.accounts.first?.id ?? "") : selectedAccountId
        var list = existing ?? SmartList(accountId: accountId, name: name)
        list.name = name.trimmingCharacters(in: .whitespaces)
        list.filter = filter
        list.ordering = ordering
        list.showCompleted = showCompleted
        list.updatedAt = Date()
        list.accountId = accountId
        await state.saveSmartList(list)
        isLoading = false
        dismiss()
    }

    // MARK: - Helpers

    private func statusLabel(_ status: TaskStatus) -> String {
        switch status {
        case .needsAction: return "Needs Action"
        case .inProcess:   return "In Process"
        case .completed:   return "Completed"
        case .cancelled:   return "Cancelled"
        }
    }

    private func toggleStatus(_ s: TaskStatus) {
        if filter.statuses.contains(s) {
            filter.statuses.removeAll { $0 == s }
        } else {
            filter.statuses.append(s)
        }
    }

    private func toggleCollection(_ id: String) {
        if filter.collectionIds.contains(id) {
            filter.collectionIds.removeAll { $0 == id }
        } else {
            filter.collectionIds.append(id)
        }
    }

    private func toggleTag(_ id: String) {
        if filter.tagIds.contains(id) {
            filter.tagIds.removeAll { $0 == id }
        } else {
            filter.tagIds.append(id)
        }
    }
}
