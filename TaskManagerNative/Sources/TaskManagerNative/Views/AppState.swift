import Foundation
import Combine
#if canImport(UserNotifications)
import UserNotifications
#endif

// MARK: - AppState

/// Central observable state for the TaskManagerNative app.
@MainActor
public final class AppState: ObservableObject {

    // MARK: - Published properties

    @Published public var accounts: [Account] = []
    @Published public var collections: [TaskCollection] = []
    @Published public var tasks: [TaskItem] = []
    @Published public var smartLists: [SmartList] = []
    @Published public var metadataDocs: [MetadataDocument] = []
    @Published public var syncLogs: [SyncLogEntry] = []
    @Published public var settings: AppSettings = AppSettings()
    @Published public var queuedMutations: [TaskMutation] = []

    @Published public var isOnboarding: Bool = false
    @Published public var activeAccountId: String? = nil
    @Published public var activeCollectionId: String? = nil
    @Published public var activeSmartListId: String? = nil
    @Published public var selectedTaskId: String? = nil
    @Published public var isSyncing: Bool = false
    @Published public var globalError: String? = nil
    @Published public var showAddAccount: Bool = false
    @Published public var showSettings: Bool = false

    // MARK: - Services

    private let persistence = PersistenceController.shared
    private let syncService = SyncService()
    private var autoSyncTimer: Timer?

    // MARK: - Initialization

    public init() {
        loadFromDisk()
        if accounts.isEmpty { isOnboarding = true }
        startAutoSyncTimer()
        Task { await NotificationService.shared.requestAuthorization() }
    }

    // MARK: - Persistence

    private func loadFromDisk() {
        let snapshot = persistence.loadSnapshot()
        accounts      = snapshot.accounts
        collections   = snapshot.collections
        tasks         = snapshot.tasks
        smartLists    = snapshot.smartLists
        metadataDocs  = snapshot.metadataDocs
        syncLogs      = snapshot.syncLogs
        settings      = snapshot.settings
        queuedMutations = snapshot.queuedMutations
        activeCollectionId = collections.first(where: { $0.kind == .task })?.id
    }

    public func saveState() {
        var snapshot = AppSnapshot()
        snapshot.accounts      = accounts
        snapshot.collections   = collections
        snapshot.tasks         = tasks
        snapshot.smartLists    = smartLists
        snapshot.metadataDocs  = metadataDocs
        snapshot.syncLogs      = syncLogs
        snapshot.settings      = settings
        snapshot.queuedMutations = queuedMutations
        persistence.saveSnapshot(snapshot)
    }

    // MARK: - Computed helpers

    public var visibleCollections: [TaskCollection] {
        collections.filter { $0.kind == .task }
    }

    public func metadata(for accountId: String) -> MetadataDocument {
        metadataDocs.first(where: { $0.accountId == accountId }) ?? MetadataDocument(accountId: accountId)
    }

    public func tags(for accountId: String) -> [TagNode] {
        metadata(for: accountId).tagNodes
    }

    public var allTags: [TagNode] {
        metadataDocs.flatMap { $0.tagNodes }
    }

    public func collectionParents(for accountId: String) -> [String: String] {
        metadata(for: accountId).collectionParents
    }

    public func tasks(in collectionId: String, includeCompleted: Bool = false) -> [TaskItem] {
        tasks.filter {
            $0.collectionId == collectionId && (includeCompleted || $0.status != .completed)
        }
    }

    public func tasks(matching filter: TaskFilter, ordering: TaskOrdering, accountId: String) -> [TaskItem] {
        let meta = metadata(for: accountId)
        let candidates = tasks.filter { $0.accountId == accountId }
        let filtered = candidates.filter {
            FilterService.taskMatchesFilter(
                $0,
                filter: filter,
                allTags: meta.tagNodes,
                collectionParents: meta.collectionParents
            )
        }
        return FilterService.sortTasks(filtered, ordering: ordering)
    }

    // MARK: - Account management

    public func addAccount(input: AccountConnectionInput) async {
        isSyncing = true
        globalError = nil
        do {
            let (account, accountCollections) = try await syncService.discoverAccount(input: input)
            accounts.append(account)
            collections.append(contentsOf: accountCollections)
            metadataDocs.append(MetadataDocument(accountId: account.id))
            isOnboarding = false
            activeCollectionId = accountCollections.first(where: { $0.kind == .task })?.id
            saveState()
            await syncAccount(id: account.id)
        } catch {
            globalError = error.localizedDescription
        }
        isSyncing = false
    }

    public func removeAccount(id: String) {
        // Cancel notifications for all tasks of this account
        for task in tasks where task.accountId == id {
            NotificationService.shared.cancelReminders(for: task)
        }
        accounts.removeAll { $0.id == id }
        collections.removeAll { $0.accountId == id }
        tasks.removeAll { $0.accountId == id }
        smartLists.removeAll { $0.accountId == id }
        metadataDocs.removeAll { $0.accountId == id }
        queuedMutations.removeAll { $0.accountId == id }
        if accounts.isEmpty { isOnboarding = true }
        saveState()
    }

    // MARK: - Sync

    public func syncAll() async {
        for account in accounts {
            await syncAccount(id: account.id)
        }
    }

    public func syncAccount(id: String) async {
        guard let account = accounts.first(where: { $0.id == id }) else { return }
        isSyncing = true
        markAccountSyncState(.syncing, accountId: id)
        do {
            let result = try await syncService.syncAccount(
                account: account,
                existingCollections: collections,
                existingTasks: tasks,
                existingMetadataDocs: metadataDocs,
                existingSmartLists: smartLists
            )
            // Merge result
            let otherTasks = tasks.filter { $0.accountId != id }
            let otherCollections = collections.filter { $0.accountId != id }
            let otherMeta = metadataDocs.filter { $0.accountId != id }
            let otherSmart = smartLists.filter { $0.accountId != id }

            tasks = otherTasks + result.tasks
            collections = otherCollections + result.collections
            metadataDocs = otherMeta + result.metadataDocs
            smartLists = otherSmart + result.smartLists
            syncLogs = (syncLogs + result.logs).suffix(200).map { $0 }

            // Apply queued mutations
            await flushQueuedMutations(for: id)

            markAccountSyncState(.synced, accountId: id)
            if let idx = accounts.firstIndex(where: { $0.id == id }) {
                accounts[idx].lastSyncAt = Date()
                accounts[idx].lastError = nil
            }
        } catch {
            markAccountSyncState(.error, accountId: id)
            if let idx = accounts.firstIndex(where: { $0.id == id }) {
                accounts[idx].lastError = error.localizedDescription
            }
            addLog(accountId: id, source: "sync", message: "Sync failed: \(error.localizedDescription)")
        }
        isSyncing = false
        saveState()
    }

    private func markAccountSyncState(_ state: SyncState, accountId: String) {
        if let idx = accounts.firstIndex(where: { $0.id == accountId }) {
            accounts[idx].syncState = state
        }
    }

    // MARK: - Offline queue

    private func flushQueuedMutations(for accountId: String) async {
        let mutations = queuedMutations.filter { $0.accountId == accountId }
        guard !mutations.isEmpty else { return }
        guard let account = accounts.first(where: { $0.id == accountId }) else { return }

        for mutation in mutations {
            guard let collection = collections.first(where: { $0.id == mutation.collectionId }) else { continue }
            do {
                switch mutation.kind {
                case .upsert:
                    let updated = try await syncService.upsertTask(task: mutation.task, collection: collection, account: account)
                    if let idx = tasks.firstIndex(where: { $0.id == updated.id }) {
                        tasks[idx] = updated
                    }
                case .delete:
                    try await syncService.deleteTask(task: mutation.task, account: account)
                }
                queuedMutations.removeAll { $0.id == mutation.id }
            } catch {
                print("[Queue] Mutation \(mutation.id) failed: \(error)")
            }
        }
    }

    // MARK: - Task CRUD

    public func createTask(_ draft: TaskDraft, in collectionId: String) async {
        guard let collection = collections.first(where: { $0.id == collectionId }),
              let account = accounts.first(where: { $0.id == collection.accountId }) else { return }
        var task = TaskItem(
            accountId: account.id,
            collectionId: collectionId,
            title: draft.title,
            notes: draft.notes,
            status: draft.status,
            priority: draft.priority,
            startDate: draft.startDate,
            dueDate: draft.dueDate,
            reminders: draft.reminders,
            tagIds: draft.tagIds,
            syncState: .syncing
        )
        tasks.append(task)
        saveState()

        do {
            task = try await syncService.upsertTask(task: task, collection: collection, account: account)
            if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
                tasks[idx] = task
            }
        } catch {
            enqueueUpsert(task: task)
        }
        await NotificationService.shared.scheduleReminders(for: task)
        saveState()
    }

    public func updateTask(_ task: TaskItem) async {
        var updated = task
        updated.updatedAt = Date()
        updated.syncState = .syncing
        if let idx = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[idx] = updated
        }
        saveState()

        guard let collection = collections.first(where: { $0.id == task.collectionId }),
              let account = accounts.first(where: { $0.id == task.accountId }) else { return }
        do {
            updated = try await syncService.upsertTask(task: updated, collection: collection, account: account)
            if let idx = tasks.firstIndex(where: { $0.id == updated.id }) {
                tasks[idx] = updated
            }
        } catch {
            enqueueUpsert(task: updated)
        }
        await NotificationService.shared.scheduleReminders(for: updated)
        saveState()
    }

    public func toggleTaskStatus(_ taskId: String) async {
        guard let task = tasks.first(where: { $0.id == taskId }) else { return }
        var updated = task
        if task.status == .completed {
            updated.status = .needsAction
            updated.completedAt = nil
        } else {
            updated.status = .completed
            updated.completedAt = Date()
        }
        await updateTask(updated)
    }

    public func deleteTask(_ taskId: String) async {
        guard let task = tasks.first(where: { $0.id == taskId }) else { return }
        NotificationService.shared.cancelReminders(for: task)
        tasks.removeAll { $0.id == taskId }
        saveState()

        guard let account = accounts.first(where: { $0.id == task.accountId }) else { return }
        do {
            try await syncService.deleteTask(task: task, account: account)
        } catch {
            enqueueDelete(task: task)
        }
        saveState()
    }

    public func moveTask(_ taskId: String, to collectionId: String) async {
        guard var task = tasks.first(where: { $0.id == taskId }) else { return }
        let oldCollection = collections.first(where: { $0.id == task.collectionId })
        let newCollection = collections.first(where: { $0.id == collectionId })
        guard let old = oldCollection, let new = newCollection, old.accountId == new.accountId else { return }
        guard let account = accounts.first(where: { $0.id == task.accountId }) else { return }

        // Delete from old, create in new
        let oldTask = task
        task.collectionId = collectionId
        task.url = nil
        task.etag = nil

        do {
            try await syncService.deleteTask(task: oldTask, account: account)
            task = try await syncService.upsertTask(task: task, collection: new, account: account)
        } catch {
            enqueueDelete(task: oldTask)
            enqueueUpsert(task: task)
        }

        if let idx = tasks.firstIndex(where: { $0.id == taskId }) {
            tasks[idx] = task
        }
        saveState()
    }

    // MARK: - Collection management

    public func createCollection(displayName: String, accountId: String) async {
        guard let account = accounts.first(where: { $0.id == accountId }) else { return }
        let homeSets = (try? await syncService.discoverHomeSets(for: account)) ?? [account.serverUrl]
        do {
            let col = try await syncService.createCollection(displayName: displayName, account: account, homeURL: homeSets.first ?? account.serverUrl)
            collections.append(col)
            saveState()
        } catch {
            globalError = error.localizedDescription
        }
    }

    public func deleteCollection(_ collectionId: String) async {
        guard let col = collections.first(where: { $0.id == collectionId }),
              let account = accounts.first(where: { $0.id == col.accountId }) else { return }
        do {
            try await syncService.deleteCollection(col, account: account)
        } catch {
            print("[AppState] Delete collection error: \(error)")
        }
        for task in tasks.filter({ $0.collectionId == collectionId }) {
            NotificationService.shared.cancelReminders(for: task)
        }
        tasks.removeAll { $0.collectionId == collectionId }
        collections.removeAll { $0.id == collectionId }
        if activeCollectionId == collectionId {
            activeCollectionId = visibleCollections.first?.id
        }
        saveState()
    }

    public func renameCollection(_ collectionId: String, newName: String) async {
        guard let col = collections.first(where: { $0.id == collectionId }),
              let account = accounts.first(where: { $0.id == col.accountId }) else { return }
        do {
            try await CalDAVClient().renameCollection(at: col.url, newName: newName, username: account.username, password: account.password)
        } catch {
            print("[AppState] Rename collection error: \(error)")
        }
        if let idx = collections.firstIndex(where: { $0.id == collectionId }) {
            collections[idx].displayName = newName
        }
        saveState()
    }

    public func setCollectionParent(_ collectionId: String, parentId: String?, accountId: String) {
        var meta = metadata(for: accountId)
        if let parentId = parentId {
            meta.collectionParents[collectionId] = parentId
        } else {
            meta.collectionParents.removeValue(forKey: collectionId)
        }
        meta.updatedAt = Date()
        updateMetadata(meta, accountId: accountId)
    }

    // MARK: - Smart list management

    public func saveSmartList(_ list: SmartList) async {
        guard let account = accounts.first(where: { $0.id == list.accountId }),
              let smartCol = collections.first(where: { $0.accountId == list.accountId && $0.kind == .smart }) else {
            // Store locally only
            upsertSmartList(list)
            saveState()
            return
        }
        do {
            var updated = try await syncService.saveSmartList(list, collection: smartCol, account: account)
            updated.syncState = .synced
            upsertSmartList(updated)
        } catch {
            upsertSmartList(list)
        }
        saveState()
    }

    public func deleteSmartList(_ listId: String) async {
        guard let list = smartLists.first(where: { $0.id == listId }),
              let account = accounts.first(where: { $0.id == list.accountId }),
              let smartCol = collections.first(where: { $0.accountId == list.accountId && $0.kind == .smart }) else {
            smartLists.removeAll { $0.id == listId }
            saveState()
            return
        }
        do {
            try await syncService.deleteSmartList(list, collection: smartCol, account: account)
        } catch {
            print("[AppState] Delete smart list error: \(error)")
        }
        smartLists.removeAll { $0.id == listId }
        saveState()
    }

    private func upsertSmartList(_ list: SmartList) {
        if let idx = smartLists.firstIndex(where: { $0.id == list.id }) {
            smartLists[idx] = list
        } else {
            smartLists.append(list)
        }
    }

    // MARK: - Metadata management

    public func updateMetadata(_ doc: MetadataDocument, accountId: String) {
        if let idx = metadataDocs.firstIndex(where: { $0.accountId == accountId }) {
            metadataDocs[idx] = doc
        } else {
            metadataDocs.append(doc)
        }
        saveState()
        // Persist to server in background
        Task {
            guard let account = accounts.first(where: { $0.id == accountId }),
                  let metaCol = collections.first(where: { $0.accountId == accountId && $0.kind == .metadata }) else { return }
            if let updated = try? await syncService.saveMetadata(doc, collection: metaCol, account: account) {
                if let idx = metadataDocs.firstIndex(where: { $0.accountId == accountId }) {
                    metadataDocs[idx] = updated
                }
                saveState()
            }
        }
    }

    // MARK: - Tag management

    public func addTag(name: String, parentId: String?, accountId: String) {
        var meta = metadata(for: accountId)
        let tag = TagNode(id: UUID().uuidString, accountId: accountId, name: name, parentId: parentId)
        meta.tagNodes.append(tag)
        updateMetadata(meta, accountId: accountId)
    }

    public func renameTag(id: String, newName: String, accountId: String) {
        var meta = metadata(for: accountId)
        if let idx = meta.tagNodes.firstIndex(where: { $0.id == id }) {
            meta.tagNodes[idx].name = newName
        }
        updateMetadata(meta, accountId: accountId)
    }

    public func deleteTag(id: String, accountId: String) {
        var meta = metadata(for: accountId)
        meta.tagNodes.removeAll { $0.id == id }
        updateMetadata(meta, accountId: accountId)
        // Remove tag from all tasks
        for i in tasks.indices where tasks[i].accountId == accountId {
            tasks[i].tagIds.removeAll { $0 == id }
        }
        saveState()
    }

    // MARK: - Settings

    public func updateSettings(_ newSettings: AppSettings) {
        settings = newSettings
        startAutoSyncTimer()
        saveState()
    }

    // MARK: - Auto-sync

    private func startAutoSyncTimer() {
        autoSyncTimer?.invalidate()
        guard settings.autoSyncEnabled else { return }
        let interval = TimeInterval(settings.autoSyncIntervalMinutes * 60)
        autoSyncTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.syncAll()
            }
        }
    }

    // MARK: - Offline queue helpers

    private func enqueueUpsert(task: TaskItem) {
        var t = task
        t.syncState = .idle
        let mutation = TaskMutation(accountId: task.accountId, kind: .upsert, task: t, collectionId: task.collectionId)
        queuedMutations.removeAll { $0.task.id == task.id }
        queuedMutations.append(mutation)
    }

    private func enqueueDelete(task: TaskItem) {
        let mutation = TaskMutation(accountId: task.accountId, kind: .delete, task: task, collectionId: task.collectionId)
        queuedMutations.append(mutation)
    }

    // MARK: - Logging

    private func addLog(accountId: String?, source: String, message: String) {
        let entry = SyncLogEntry(accountId: accountId, source: source, message: message)
        syncLogs = (syncLogs + [entry]).suffix(200).map { $0 }
    }

    // MARK: - Clear cache

    public func clearLocalCache() {
        persistence.clearAll()
        tasks = []
        collections = []
        metadataDocs = []
        smartLists = []
        syncLogs = []
        queuedMutations = []
    }
}

// MARK: - Task Draft

public struct TaskDraft {
    public var title: String = ""
    public var notes: String = ""
    public var status: TaskStatus = .needsAction
    public var priority: Int = 0
    public var startDate: Date? = nil
    public var dueDate: Date? = nil
    public var reminders: [TaskReminder] = []
    public var tagIds: [String] = []

    public init() {}
}
