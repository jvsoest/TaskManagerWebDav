import SwiftUI

// MARK: - Settings View

public struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var showAddAccount = false
    @State private var showSyncLog = false
    @State private var confirmClearCache = false
    @State private var autoSync: Bool
    @State private var syncInterval: Int
    @State private var showDeleteAccountConfirm = false
    @State private var accountToDelete: Account? = nil

    public init() {
        // Initialize from state after environment is injected
        _autoSync = State(initialValue: true)
        _syncInterval = State(initialValue: 15)
    }

    public var body: some View {
        NavigationStack {
            Form {
                // Accounts section
                Section("Accounts") {
                    ForEach(state.accounts) { account in
                        AccountRow(account: account)
                            .swipeActions(edge: .trailing) {
                                Button("Remove", role: .destructive) {
                                    accountToDelete = account
                                    showDeleteAccountConfirm = true
                                }
                            }
                    }
                    Button {
                        showAddAccount = true
                    } label: {
                        Label("Add Account", systemImage: "plus.circle")
                    }
                }

                // Sync settings
                Section("Sync") {
                    Toggle("Auto-Sync", isOn: $autoSync)
                        .onChange(of: autoSync) { _, v in
                            var s = state.settings
                            s.autoSyncEnabled = v
                            state.updateSettings(s)
                        }
                    if autoSync {
                        Picker("Interval", selection: $syncInterval) {
                            Text("5 minutes").tag(5)
                            Text("15 minutes").tag(15)
                            Text("30 minutes").tag(30)
                            Text("1 hour").tag(60)
                        }
                        .onChange(of: syncInterval) { _, v in
                            var s = state.settings
                            s.autoSyncIntervalMinutes = v
                            state.updateSettings(s)
                        }
                    }
                    Button {
                        Task { await state.syncAll() }
                    } label: {
                        Label("Sync Now", systemImage: "arrow.clockwise")
                    }
                }

                // Tag management
                Section("Tags") {
                    ForEach(state.accounts) { account in
                        NavigationLink("Manage Tags for \(account.label.isEmpty ? account.displayName : account.label)") {
                            TagManagementView(accountId: account.id)
                        }
                    }
                }

                // Structure
                Section("Lists & Structure") {
                    NavigationLink("Manage Lists") {
                        CollectionManagementView()
                    }
                }

                // Cache
                Section("Advanced") {
                    Button("View Sync Log") { showSyncLog = true }
                    Button("Clear Local Cache", role: .destructive) {
                        confirmClearCache = true
                    }
                }

                // App info
                Section("About") {
                    LabeledContent("App", value: "TaskManagerNative")
                    LabeledContent("Backend", value: "CalDAV (RFC 4791)")
                    LabeledContent("Version", value: "1.0.0")
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                autoSync = state.settings.autoSyncEnabled
                syncInterval = state.settings.autoSyncIntervalMinutes
            }
            .sheet(isPresented: $showAddAccount) {
                AddAccountView()
            }
            .sheet(isPresented: $showSyncLog) {
                SyncLogView()
            }
            .confirmationDialog("Remove Account", isPresented: $showDeleteAccountConfirm, presenting: accountToDelete) { account in
                Button("Remove \(account.label.isEmpty ? account.displayName : account.label)", role: .destructive) {
                    state.removeAccount(id: account.id)
                }
                Button("Cancel", role: .cancel) { }
            } message: { account in
                Text("This removes the account and all its cached data. Your tasks on the server are not affected.")
            }
            .confirmationDialog("Clear Local Cache", isPresented: $confirmClearCache) {
                Button("Clear Cache", role: .destructive) {
                    state.clearLocalCache()
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("This will clear all locally cached data. You will need to re-sync your accounts.")
            }
        }
    }
}

// MARK: - Account Row

struct AccountRow: View {
    let account: Account

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(account.label.isEmpty ? account.displayName : account.label)
                .font(.headline)
            Text(account.serverUrl)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let err = account.lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
            if let lastSync = account.lastSyncAt {
                Text("Last synced: \(lastSync, format: .relative(presentation: .named))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Sync Log View

struct SyncLogView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(state.syncLogs.reversed()) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.message)
                            .font(.subheadline)
                        HStack {
                            Text(entry.source)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(entry.createdAt, format: .dateTime.hour().minute().second())
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .navigationTitle("Sync Log")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Tag Management View

struct TagManagementView: View {
    @EnvironmentObject var state: AppState
    let accountId: String

    @State private var showAddTag = false
    @State private var newTagName = ""
    @State private var newTagParentId: String? = nil

    var tags: [TagNode] { state.tags(for: accountId) }

    var body: some View {
        List {
            ForEach(tags.filter { $0.parentId == nil }) { tag in
                tagRow(tag, depth: 0)
            }
        }
        .navigationTitle("Tags")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAddTag = true } label: {
                    Label("Add Tag", systemImage: "plus")
                }
            }
        }
        .sheet(isPresented: $showAddTag) {
            addTagSheet
        }
    }

    @ViewBuilder
    private func tagRow(_ tag: TagNode, depth: Int) -> some View {
        HStack {
            Text(String(repeating: "  ", count: depth) + "#\(tag.name)")
            Spacer()
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) {
                state.deleteTag(id: tag.id, accountId: accountId)
            }
        }
        ForEach(tags.filter { $0.parentId == tag.id }) { child in
            tagRow(child, depth: depth + 1)
        }
    }

    private var addTagSheet: some View {
        NavigationStack {
            Form {
                Section("Tag Name") {
                    TextField("e.g. work/project", text: $newTagName)
                        .autocorrectionDisabled()
                }
                if !tags.isEmpty {
                    Section("Parent Tag (optional)") {
                        Picker("Parent", selection: $newTagParentId) {
                            Text("None").tag(Optional<String>.none)
                            ForEach(tags) { tag in
                                Text("#\(tag.name)").tag(Optional(tag.id))
                            }
                        }
                    }
                }
            }
            .navigationTitle("New Tag")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showAddTag = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        state.addTag(name: newTagName, parentId: newTagParentId, accountId: accountId)
                        showAddTag = false
                        newTagName = ""
                    }
                    .disabled(newTagName.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: - Collection Management View

struct CollectionManagementView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        List {
            ForEach(state.accounts) { account in
                let cols = state.visibleCollections.filter { $0.accountId == account.id }
                Section(account.label.isEmpty ? account.displayName : account.label) {
                    ForEach(cols) { col in
                        collectionRow(col, account: account)
                    }
                }
            }
        }
        .navigationTitle("Lists")
    }

    @ViewBuilder
    private func collectionRow(_ col: TaskCollection, account: Account) -> some View {
        VStack(alignment: .leading) {
            Text(col.displayName)
            Text(col.url)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) {
                Task { await state.deleteCollection(col.id) }
            }
        }
    }
}
