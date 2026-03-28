import SwiftUI

// MARK: - Sidebar View

public struct SidebarView: View {
    @EnvironmentObject var state: AppState
    @State private var showAddCollection = false
    @State private var newCollectionName = ""
    @State private var newCollectionAccountId: String? = nil
    @State private var showAddSmartList = false
    @State private var editingSmartList: SmartList? = nil
    @State private var expandedAccounts: Set<String> = []

    public init() {}

    public var body: some View {
        List(selection: selectionBinding) {
            // Inbox / All Tasks quick section
            Section {
                NavigationLinkRow(
                    label: "All Tasks",
                    systemImage: "tray.full",
                    count: state.tasks.filter { $0.status != .completed }.count,
                    id: "all"
                )
            }

            // Per-account sections
            ForEach(state.accounts) { account in
                accountSection(account)
            }

            // Smart Lists section
            if !state.smartLists.isEmpty {
                Section("Smart Lists") {
                    ForEach(state.smartLists) { list in
                        NavigationLinkRow(
                            label: list.name,
                            systemImage: "line.3.horizontal.decrease.circle",
                            count: countSmartList(list),
                            id: "smart:\(list.id)"
                        )
                        .contextMenu {
                            Button("Edit") { editingSmartList = list }
                            Divider()
                            Button("Delete", role: .destructive) {
                                Task { await state.deleteSmartList(list.id) }
                            }
                        }
                    }
                }
            }
        }
        #if os(macOS)
        .listStyle(.sidebar)
        #else
        .listStyle(.insetGrouped)
        #endif
        .navigationTitle("TaskManager")
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button { showAddCollection = true } label: {
                        Label("New List", systemImage: "plus")
                    }
                    Button { showAddSmartList = true } label: {
                        Label("New Smart List", systemImage: "line.3.horizontal.decrease.circle")
                    }
                    Divider()
                    Button { Task { await state.syncAll() } } label: {
                        Label("Sync All", systemImage: "arrow.clockwise")
                    }
                    Divider()
                    Button { state.showSettings = true } label: {
                        Label("Settings", systemImage: "gear")
                    }
                    Button { state.showAddAccount = true } label: {
                        Label("Add Account", systemImage: "person.badge.plus")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            #else
            ToolbarItem {
                Button { showAddSmartList = true } label: {
                    Label("New Smart List", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            ToolbarItem {
                Button { showAddCollection = true } label: {
                    Label("New List", systemImage: "plus")
                }
            }
            ToolbarItem {
                Button { state.showAddAccount = true } label: {
                    Label("Add Account", systemImage: "person.badge.plus")
                }
            }
            #endif
        }
        .sheet(isPresented: $showAddCollection) {
            addCollectionSheet
        }
        .sheet(isPresented: $showAddSmartList) {
            SmartListBuilderView(existing: nil)
        }
        .sheet(item: $editingSmartList) { list in
            SmartListBuilderView(existing: list)
        }
    }

    // MARK: - Account section

    @ViewBuilder
    private func accountSection(_ account: Account) -> some View {
        let accountCollections = state.visibleCollections.filter { $0.accountId == account.id }
        let meta = state.metadata(for: account.id)
        let roots = rootCollections(accountCollections, parents: meta.collectionParents)

        Section {
            ForEach(roots) { col in
                collectionRow(col, depth: 0, accountCollections: accountCollections, parents: meta.collectionParents)
            }
        } header: {
            HStack {
                Text(account.label.isEmpty ? account.displayName : account.label)
                Spacer()
                syncBadge(account)
            }
        }
    }

    @ViewBuilder
    private func collectionRow(_ col: TaskCollection, depth: Int, accountCollections: [TaskCollection], parents: [String: String]) -> some View {
        let children = accountCollections.filter { parents[$0.id] == col.id }
        let count = state.tasks(in: col.id).count

        Group {
            NavigationLinkRow(
                label: col.displayName,
                systemImage: "list.bullet",
                color: col.color.flatMap { Color(hex: $0) },
                count: count,
                id: "col:\(col.id)",
                depth: depth
            )
            .contextMenu {
                Button("Rename") {
                    // handled by detail view
                }
                Button("Delete List", role: .destructive) {
                    Task { await state.deleteCollection(col.id) }
                }
            }

            ForEach(children) { child in
                collectionRow(child, depth: depth + 1, accountCollections: accountCollections, parents: parents)
            }
        }
    }

    @ViewBuilder
    private func syncBadge(_ account: Account) -> some View {
        switch account.syncState {
        case .syncing:
            ProgressView().controlSize(.mini)
        case .error:
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(.red)
                .help(account.lastError ?? "Sync error")
        default:
            EmptyView()
        }
    }

    // MARK: - Selection binding

    private var selectionBinding: Binding<String?> {
        Binding(
            get: {
                if let smartId = state.activeSmartListId { return "smart:\(smartId)" }
                if let colId = state.activeCollectionId { return "col:\(colId)" }
                return "all"
            },
            set: { value in
                guard let v = value else { return }
                if v == "all" {
                    state.activeCollectionId = nil
                    state.activeSmartListId = nil
                } else if v.hasPrefix("smart:") {
                    state.activeSmartListId = String(v.dropFirst(6))
                    state.activeCollectionId = nil
                } else if v.hasPrefix("col:") {
                    state.activeCollectionId = String(v.dropFirst(4))
                    state.activeSmartListId = nil
                }
            }
        )
    }

    // MARK: - Add collection sheet

    private var addCollectionSheet: some View {
        NavigationStack {
            Form {
                Section("List Name") {
                    TextField("Name", text: $newCollectionName)
                }
                if state.accounts.count > 1 {
                    Section("Account") {
                        Picker("Account", selection: $newCollectionAccountId) {
                            ForEach(state.accounts) { account in
                                Text(account.label.isEmpty ? account.displayName : account.label)
                                    .tag(Optional(account.id))
                            }
                        }
                    }
                }
            }
            .navigationTitle("New List")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showAddCollection = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        let accountId = newCollectionAccountId ?? state.accounts.first?.id ?? ""
                        Task {
                            await state.createCollection(displayName: newCollectionName, accountId: accountId)
                        }
                        showAddCollection = false
                        newCollectionName = ""
                    }
                    .disabled(newCollectionName.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Helpers

    private func rootCollections(_ collections: [TaskCollection], parents: [String: String]) -> [TaskCollection] {
        collections.filter { parents[$0.id] == nil }
    }

    private func countSmartList(_ list: SmartList) -> Int {
        guard let account = state.accounts.first(where: { $0.id == list.accountId }) else { return 0 }
        return state.tasks(matching: list.filter, ordering: list.ordering, accountId: account.id).count
    }
}

// MARK: - Navigation Link Row

struct NavigationLinkRow: View {
    var label: String
    var systemImage: String
    var color: Color? = nil
    var count: Int = 0
    var id: String
    var depth: Int = 0

    var body: some View {
        Label {
            HStack {
                Text(label)
                Spacer()
                if count > 0 {
                    Text("\(count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(color ?? .accentColor)
        }
        .padding(.leading, CGFloat(depth) * 16)
        .tag(id)
    }
}

// MARK: - Color hex extension

extension Color {
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s = String(s.dropFirst()) }
        guard s.count == 6 || s.count == 8 else { return nil }
        var val: UInt64 = 0
        guard Scanner(string: s).scanHexInt64(&val) else { return nil }
        let r, g, b, a: Double
        if s.count == 8 {
            r = Double((val >> 24) & 0xFF) / 255
            g = Double((val >> 16) & 0xFF) / 255
            b = Double((val >> 8)  & 0xFF) / 255
            a = Double( val        & 0xFF) / 255
        } else {
            r = Double((val >> 16) & 0xFF) / 255
            g = Double((val >> 8)  & 0xFF) / 255
            b = Double( val        & 0xFF) / 255
            a = 1.0
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}
