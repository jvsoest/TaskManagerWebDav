import Foundation

// MARK: - Sync Service

/// Orchestrates CalDAV discovery and synchronization for all accounts.
@MainActor
public final class SyncService {

    private let client = CalDAVClient()
    private let persistence = PersistenceController.shared

    // MARK: - Discover account

    /// Connects to a CalDAV server, discovers collections, and returns an account + collections.
    public func discoverAccount(input: AccountConnectionInput) async throws -> (account: Account, collections: [TaskCollection]) {
        let accountId = UUID().uuidString
        var account = Account(
            id: accountId,
            label: input.label,
            serverUrl: input.serverUrl,
            connectionMode: input.connectionMode,
            username: input.username,
            password: input.password,
            syncState: .syncing
        )

        let homeSets = try await client.discoverHomeSets(
            serverURL: input.serverUrl,
            username: input.username,
            password: input.password
        )

        var allCollections: [TaskCollection] = []
        for homeURL in homeSets {
            let discovered = try await client.listCollections(at: homeURL, username: input.username, password: input.password)
            for dc in discovered {
                guard dc.supportsVTODO else { continue }
                let kind = hiddenCollectionKind(url: dc.url, name: dc.displayName)
                let col = TaskCollection(
                    id: UUID().uuidString,
                    accountId: accountId,
                    url: dc.url,
                    displayName: dc.displayName,
                    description: dc.description,
                    color: dc.color,
                    kind: kind ?? .task,
                    ctag: dc.ctag,
                    syncToken: dc.syncToken
                )
                allCollections.append(col)
            }
        }

        // Use display name from first collection's account info or server hostname
        if let hostname = URL(string: input.serverUrl)?.host {
            account.displayName = input.label.isEmpty ? hostname : input.label
        }

        // Ensure hidden collections exist
        let (collections, _) = try await ensureHiddenCollections(
            allCollections: allCollections,
            accountId: accountId,
            serverUrl: input.serverUrl,
            homeSets: homeSets,
            username: input.username,
            password: input.password
        )

        account.syncState = .synced
        return (account, collections)
    }

    // MARK: - Home set discovery helper (used by AppState for collection creation)

    public func discoverHomeSets(for account: Account) async throws -> [String] {
        try await client.discoverHomeSets(
            serverURL: account.serverUrl,
            username: account.username,
            password: account.password
        )
    }

    // MARK: - Full sync

    /// Performs a full sync for one account: fetch all collections, fetch tasks, resolve metadata & smart lists.
    public func syncAccount(
        account: Account,
        existingCollections: [TaskCollection],
        existingTasks: [TaskItem],
        existingMetadataDocs: [MetadataDocument],
        existingSmartLists: [SmartList]
    ) async throws -> SyncResult {
        var result = SyncResult(
            tasks: existingTasks.filter { $0.accountId != account.id },
            collections: existingCollections.filter { $0.accountId != account.id },
            metadataDocs: existingMetadataDocs.filter { $0.accountId != account.id },
            smartLists: existingSmartLists.filter { $0.accountId != account.id },
            logs: []
        )

        // 1. Refresh collection list
        let homeSets = try await client.discoverHomeSets(
            serverURL: account.serverUrl,
            username: account.username,
            password: account.password
        )

        var freshCollections: [TaskCollection] = []
        for homeURL in homeSets {
            let discovered = try await client.listCollections(at: homeURL, username: account.username, password: account.password)
            for dc in discovered where dc.supportsVTODO {
                let kind = hiddenCollectionKind(url: dc.url, name: dc.displayName)
                // Preserve existing id if URL matches
                let existingCol = existingCollections.first(where: { $0.url == dc.url && $0.accountId == account.id })
                let col = TaskCollection(
                    id: existingCol?.id ?? UUID().uuidString,
                    accountId: account.id,
                    url: dc.url,
                    displayName: dc.displayName,
                    description: dc.description,
                    color: dc.color,
                    kind: kind ?? .task,
                    ctag: dc.ctag,
                    syncToken: dc.syncToken
                )
                freshCollections.append(col)
            }
        }

        // Ensure hidden collections
        let (collections, didCreate) = try await ensureHiddenCollections(
            allCollections: freshCollections,
            accountId: account.id,
            serverUrl: account.serverUrl,
            homeSets: homeSets,
            username: account.username,
            password: account.password
        )
        result.collections += collections

        if didCreate {
            result.logs.append(SyncLogEntry(accountId: account.id, source: "sync", message: "Created hidden metadata collections"))
        }

        // 2. Sync tasks per collection
        let taskCollections = collections.filter { $0.kind == .task }
        for col in taskCollections {
            let prevToken = existingCollections.first(where: { $0.id == col.id })?.syncToken
            let (fetched, _) = try await client.fetchVTODOs(
                from: col.url,
                username: account.username,
                password: account.password,
                syncToken: prevToken
            )
            let tasks = fetched.compactMap { f in
                ICalendarParser.parseVTODOs(
                    from: f.icsData,
                    accountId: account.id,
                    collectionId: col.id,
                    resourceUrl: f.url,
                    etag: f.etag
                ).first
            }
            result.tasks += tasks
            result.logs.append(SyncLogEntry(accountId: account.id, source: "sync", message: "Synced \(tasks.count) tasks from \(col.displayName)"))
        }

        // 3. Sync metadata document
        if let metaCol = collections.first(where: { $0.kind == .metadata }) {
            result.metadataDocs += await syncMetadata(
                collection: metaCol,
                account: account,
                existingDoc: existingMetadataDocs.first(where: { $0.accountId == account.id })
            )
        }

        // 4. Sync smart lists
        if let smartCol = collections.first(where: { $0.kind == .smart }) {
            let (smartLists, smartLogs) = await syncSmartLists(
                collection: smartCol,
                account: account,
                existingLists: existingSmartLists.filter { $0.accountId == account.id }
            )
            result.smartLists += smartLists
            result.logs += smartLogs
        }

        return result
    }

    // MARK: - Upsert task

    public func upsertTask(task: TaskItem, collection: TaskCollection, account: Account) async throws -> TaskItem {
        let resourceURL = task.url ?? collection.url.ensureTrailingSlash() + "\(task.uid).ics"
        let icsData = ICalendarSerializer.serialize(task)
        let newEtag = try await client.putVTODO(
            to: resourceURL,
            icsData: icsData,
            etag: task.etag,
            username: account.username,
            password: account.password
        )
        var updated = task
        updated.url = resourceURL
        updated.etag = newEtag
        updated.syncState = .synced
        return updated
    }

    // MARK: - Delete task

    public func deleteTask(task: TaskItem, account: Account) async throws {
        guard let url = task.url else { return }
        try await client.deleteResource(at: url, etag: task.etag, username: account.username, password: account.password)
    }

    // MARK: - Create collection

    public func createCollection(displayName: String, account: Account, homeURL: String) async throws -> TaskCollection {
        let slug = displayName.lowercased().replacingOccurrences(of: " ", with: "-")
        let url = homeURL.ensureTrailingSlash() + "\(slug)-\(UUID().uuidString.prefix(8))/"
        try await client.makeCalendar(at: url, displayName: displayName, username: account.username, password: account.password)
        return TaskCollection(
            id: UUID().uuidString,
            accountId: account.id,
            url: url,
            displayName: displayName,
            kind: .task
        )
    }

    // MARK: - Delete collection

    public func deleteCollection(_ collection: TaskCollection, account: Account) async throws {
        try await client.deleteResource(at: collection.url, etag: nil, username: account.username, password: account.password)
    }

    // MARK: - Save metadata

    public func saveMetadata(_ doc: MetadataDocument, collection: TaskCollection, account: Account) async throws -> MetadataDocument {
        let resourceURL = doc.url ?? collection.url.ensureTrailingSlash() + "taskmanager-metadata.ics"
        let payload = encodeMetadataICS(doc)
        let newEtag = try await client.putVTODO(
            to: resourceURL,
            icsData: payload,
            etag: doc.etag,
            username: account.username,
            password: account.password
        )
        var updated = doc
        updated.url = resourceURL
        updated.etag = newEtag
        updated.updatedAt = Date()
        return updated
    }

    // MARK: - Save smart list

    public func saveSmartList(_ smartList: SmartList, collection: TaskCollection, account: Account) async throws -> SmartList {
        let resourceURL = smartList.url ?? collection.url.ensureTrailingSlash() + "\(smartList.id).ics"
        let payload = encodeSmartListICS(smartList)
        let newEtag = try await client.putVTODO(
            to: resourceURL,
            icsData: payload,
            etag: smartList.etag,
            username: account.username,
            password: account.password
        )
        var updated = smartList
        updated.url = resourceURL
        updated.etag = newEtag
        updated.syncState = .synced
        return updated
    }

    // MARK: - Delete smart list

    public func deleteSmartList(_ smartList: SmartList, collection: TaskCollection, account: Account) async throws {
        guard let url = smartList.url else { return }
        try await client.deleteResource(at: url, etag: smartList.etag, username: account.username, password: account.password)
    }

    // MARK: - Hidden collection helpers

    private let metaSlug = "taskmanager-meta"
    private let smartSlug = "taskmanager-smart"

    private func hiddenCollectionKind(url: String, name: String) -> CollectionKind? {
        if url.contains("taskmanager-meta") || name == "TaskManager Metadata" { return .metadata }
        if url.contains("taskmanager-smart") || name == "TaskManager Smart Lists" { return .smart }
        return nil
    }

    private func ensureHiddenCollections(
        allCollections: [TaskCollection],
        accountId: String,
        serverUrl: String,
        homeSets: [String],
        username: String,
        password: String
    ) async throws -> (collections: [TaskCollection], created: Bool) {
        var cols = allCollections
        var created = false
        let baseURL = homeSets.first ?? serverUrl.ensureTrailingSlash()

        let targets: [(slug: String, name: String, kind: CollectionKind)] = [
            (metaSlug, "TaskManager Metadata", .metadata),
            (smartSlug, "TaskManager Smart Lists", .smart),
        ]

        for target in targets {
            let existing = allCollections.first(where: { $0.kind == target.kind })
            if existing != nil { continue }

            let newURL = baseURL.ensureTrailingSlash() + target.slug + "/"
            do {
                try await client.makeCalendar(at: newURL, displayName: target.name, username: username, password: password)
                let col = TaskCollection(
                    id: UUID().uuidString,
                    accountId: accountId,
                    url: newURL,
                    displayName: target.name,
                    kind: target.kind
                )
                cols.append(col)
                created = true
            } catch {
                // Some servers may reject MKCALENDAR for already-existing or restricted paths
                print("[Sync] Could not create \(target.name): \(error)")
            }
        }

        return (cols, created)
    }

    // MARK: - Metadata ICS encode/decode

    private func syncMetadata(
        collection: TaskCollection,
        account: Account,
        existingDoc: MetadataDocument?
    ) async -> [MetadataDocument] {
        do {
            let (fetched, _) = try await client.fetchVTODOs(
                from: collection.url,
                username: account.username,
                password: account.password
            )
            if let first = fetched.first {
                if let doc = decodeMetadataICS(first.icsData, accountId: account.id) {
                    var d = doc
                    d.url = first.url
                    d.etag = first.etag
                    return [d]
                }
            }
        } catch {
            print("[Sync] Metadata fetch failed: \(error)")
        }
        // Return existing or default
        return [existingDoc ?? MetadataDocument(accountId: account.id)]
    }

    private func syncSmartLists(
        collection: TaskCollection,
        account: Account,
        existingLists: [SmartList]
    ) async -> (lists: [SmartList], logs: [SyncLogEntry]) {
        do {
            let (fetched, _) = try await client.fetchVTODOs(
                from: collection.url,
                username: account.username,
                password: account.password
            )
            var lists: [SmartList] = []
            for f in fetched {
                if let sl = decodeSmartListICS(f.icsData, accountId: account.id) {
                    var l = sl
                    l.url = f.url
                    l.etag = f.etag
                    l.syncState = .synced
                    lists.append(l)
                }
            }
            return (lists, [SyncLogEntry(accountId: account.id, source: "sync", message: "Loaded \(lists.count) smart lists")])
        } catch {
            return (existingLists, [SyncLogEntry(accountId: account.id, source: "sync", message: "Smart list sync failed: \(error.localizedDescription)")])
        }
    }

    // MARK: - Metadata ICS encoding

    private func encodeMetadataICS(_ doc: MetadataDocument) -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let json = (try? encoder.encode(doc)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let escaped = ICalendarSerializer.escape(json)
        return """
        BEGIN:VCALENDAR\r
        VERSION:2.0\r
        PRODID:-//TaskManagerNative//NONSGML v1.0//EN\r
        BEGIN:VTODO\r
        UID:taskmanager-metadata\r
        SUMMARY:TaskManager Metadata\r
        \(ICalendarSerializer.fold("DESCRIPTION:" + escaped))\r
        END:VTODO\r
        END:VCALENDAR\r
        """
    }

    private func decodeMetadataICS(_ ics: String, accountId: String) -> MetadataDocument? {
        let lines = ICalendarParser.unfoldLines(ics)
        for line in lines {
            if line.hasPrefix("DESCRIPTION:") {
                let raw = ICalendarParser.unescape(String(line.dropFirst("DESCRIPTION:".count)))
                let decoder = JSONDecoder()
                decoder.dateDecodingStrategy = .iso8601
                if let data = raw.data(using: .utf8),
                   let doc = try? decoder.decode(MetadataDocument.self, from: data) {
                    return doc
                }
            }
        }
        return nil
    }

    // MARK: - Smart list ICS encoding

    private func encodeSmartListICS(_ list: SmartList) -> String {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let json = (try? encoder.encode(list)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let escaped = ICalendarSerializer.escape(json)
        return """
        BEGIN:VCALENDAR\r
        VERSION:2.0\r
        PRODID:-//TaskManagerNative//NONSGML v1.0//EN\r
        BEGIN:VTODO\r
        UID:\(list.id)\r
        SUMMARY:\(ICalendarSerializer.escape(list.name))\r
        \(ICalendarSerializer.fold("DESCRIPTION:" + escaped))\r
        END:VTODO\r
        END:VCALENDAR\r
        """
    }

    private func decodeSmartListICS(_ ics: String, accountId: String) -> SmartList? {
        let lines = ICalendarParser.unfoldLines(ics)
        var uid: String?
        var summary: String?
        var description: String?
        for line in lines {
            if line.hasPrefix("UID:") { uid = String(line.dropFirst(4)) }
            if line.hasPrefix("SUMMARY:") { summary = ICalendarParser.unescape(String(line.dropFirst("SUMMARY:".count))) }
            if line.hasPrefix("DESCRIPTION:") {
                description = ICalendarParser.unescape(String(line.dropFirst("DESCRIPTION:".count)))
            }
        }
        guard let d = description else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let data = d.data(using: .utf8),
           let list = try? decoder.decode(SmartList.self, from: data) {
            return list
        }
        // Fallback: use SUMMARY as name and raw description as definition
        if let id = uid {
            let name = summary ?? "Smart List"
            var list = SmartList(id: id, accountId: accountId, name: name)
            list.definition = d
            return list
        }
        return nil
    }
}

// MARK: - Sync Result

public struct SyncResult {
    public var tasks: [TaskItem]
    public var collections: [TaskCollection]
    public var metadataDocs: [MetadataDocument]
    public var smartLists: [SmartList]
    public var logs: [SyncLogEntry]
}
