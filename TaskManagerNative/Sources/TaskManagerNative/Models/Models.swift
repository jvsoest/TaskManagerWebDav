import Foundation

// MARK: - Enumerations

public enum CollectionKind: String, Codable, Sendable {
    case task
    case metadata
    case smart
}

public enum TaskStatus: String, Codable, Sendable {
    case needsAction = "needs-action"
    case inProcess = "in-process"
    case completed
    case cancelled

    var icsValue: String {
        switch self {
        case .needsAction: return "NEEDS-ACTION"
        case .inProcess:   return "IN-PROCESS"
        case .completed:   return "COMPLETED"
        case .cancelled:   return "CANCELLED"
        }
    }

    static func from(ics value: String) -> TaskStatus {
        switch value.uppercased() {
        case "NEEDS-ACTION": return .needsAction
        case "IN-PROCESS":   return .inProcess
        case "COMPLETED":    return .completed
        case "CANCELLED":    return .cancelled
        default:             return .needsAction
        }
    }
}

public enum SyncState: String, Codable, Sendable {
    case idle
    case syncing
    case synced
    case error
}

public enum TaskOrderMode: String, Codable, Sendable {
    case manual
    case property
}

public enum TaskOrderField: String, Codable, Sendable {
    case dueDate
    case startDate
    case priority
    case title
    case createdAt
    case updatedAt
    case status
}

public enum SortDirection: String, Codable, Sendable {
    case asc
    case desc
}

public enum ConnectionMode: String, Codable, Sendable {
    case direct
    // proxy is not needed in native apps — kept for potential future migration from web import
    case proxy
}

public enum ReminderAnchor: String, Codable, Sendable {
    case start
    case due
}

public enum DatePreset: Codable, Hashable, Sendable {
    case any
    case overdue
    case today
    case next(Int)
    case custom

    // Codable support
    private enum CodingKeys: String, CodingKey { case kind, days }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "any":     self = .any
        case "overdue": self = .overdue
        case "today":   self = .today
        case "next":
            let days = try container.decode(Int.self, forKey: .days)
            self = .next(days)
        default:        self = .custom
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .any:          try container.encode("any", forKey: .kind)
        case .overdue:      try container.encode("overdue", forKey: .kind)
        case .today:        try container.encode("today", forKey: .kind)
        case .next(let d):
            try container.encode("next", forKey: .kind)
            try container.encode(d, forKey: .days)
        case .custom:       try container.encode("custom", forKey: .kind)
        }
    }
}

// MARK: - Reminders

public struct TaskReminderAbsolute: Codable, Sendable, Identifiable {
    public var id: String
    public var at: Date

    public init(id: String, at: Date) {
        self.id = id
        self.at = at
    }
}

public struct TaskReminderRelative: Codable, Sendable, Identifiable {
    public var id: String
    public var anchor: ReminderAnchor
    public var minutesBefore: Int

    public init(id: String, anchor: ReminderAnchor, minutesBefore: Int) {
        self.id = id
        self.anchor = anchor
        self.minutesBefore = minutesBefore
    }
}

public enum TaskReminder: Codable, Sendable, Identifiable {
    case absolute(TaskReminderAbsolute)
    case relative(TaskReminderRelative)

    public var id: String {
        switch self {
        case .absolute(let r): return r.id
        case .relative(let r): return r.id
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, id, at, anchor, minutesBefore }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        let id = try container.decode(String.self, forKey: .id)
        if kind == "absolute" {
            let at = try container.decode(Date.self, forKey: .at)
            self = .absolute(TaskReminderAbsolute(id: id, at: at))
        } else {
            let anchor = try container.decode(ReminderAnchor.self, forKey: .anchor)
            let mins = try container.decode(Int.self, forKey: .minutesBefore)
            self = .relative(TaskReminderRelative(id: id, anchor: anchor, minutesBefore: mins))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .absolute(let r):
            try container.encode("absolute", forKey: .kind)
            try container.encode(r.id, forKey: .id)
            try container.encode(r.at, forKey: .at)
        case .relative(let r):
            try container.encode("relative", forKey: .kind)
            try container.encode(r.id, forKey: .id)
            try container.encode(r.anchor, forKey: .anchor)
            try container.encode(r.minutesBefore, forKey: .minutesBefore)
        }
    }
}

// MARK: - Ordering

public struct TaskOrdering: Codable, Sendable {
    public var mode: TaskOrderMode
    public var field: TaskOrderField
    public var direction: SortDirection

    public init(mode: TaskOrderMode = .manual, field: TaskOrderField = .dueDate, direction: SortDirection = .asc) {
        self.mode = mode
        self.field = field
        self.direction = direction
    }

    public static let defaultTaskList = TaskOrdering(mode: .manual, field: .dueDate, direction: .asc)
    public static let defaultSmartList = TaskOrdering(mode: .property, field: .dueDate, direction: .asc)
}

// MARK: - Account

public struct Account: Codable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var serverUrl: String
    public var connectionMode: ConnectionMode
    public var username: String
    public var password: String
    public var displayName: String
    public var syncState: SyncState
    public var lastSyncAt: Date?
    public var lastError: String?

    public init(
        id: String,
        label: String,
        serverUrl: String,
        connectionMode: ConnectionMode = .direct,
        username: String,
        password: String,
        displayName: String = "",
        syncState: SyncState = .idle
    ) {
        self.id = id
        self.label = label
        self.serverUrl = serverUrl
        self.connectionMode = connectionMode
        self.username = username
        self.password = password
        self.displayName = displayName
        self.syncState = syncState
    }
}

// MARK: - Task Collection

public struct TaskCollection: Codable, Identifiable, Sendable {
    public var id: String
    public var accountId: String
    public var url: String
    public var displayName: String
    public var description: String?
    public var color: String?
    public var kind: CollectionKind
    public var ctag: String?
    public var syncToken: String?

    public init(
        id: String,
        accountId: String,
        url: String,
        displayName: String,
        description: String? = nil,
        color: String? = nil,
        kind: CollectionKind = .task,
        ctag: String? = nil,
        syncToken: String? = nil
    ) {
        self.id = id
        self.accountId = accountId
        self.url = url
        self.displayName = displayName
        self.description = description
        self.color = color
        self.kind = kind
        self.ctag = ctag
        self.syncToken = syncToken
    }
}

// MARK: - Tag

public struct TagNode: Codable, Identifiable, Sendable {
    public var id: String
    public var accountId: String
    public var name: String
    public var parentId: String?

    public init(id: String, accountId: String, name: String, parentId: String? = nil) {
        self.id = id
        self.accountId = accountId
        self.name = name
        self.parentId = parentId
    }
}

// MARK: - Metadata Document

public struct MetadataDocument: Codable, Sendable {
    public var accountId: String
    public var version: Int
    public var tagNodes: [TagNode]
    public var collectionParents: [String: String]
    public var collectionOrder: [String]
    public var smartListOrder: [String]
    public var taskListOrderings: [String: TaskOrdering]
    public var taskListShowCompleted: [String: Bool]
    public var manualTaskOrder: [String: [String]]
    public var updatedAt: Date
    public var url: String?
    public var etag: String?

    public init(accountId: String) {
        self.accountId = accountId
        self.version = 2
        self.tagNodes = []
        self.collectionParents = [:]
        self.collectionOrder = []
        self.smartListOrder = []
        self.taskListOrderings = [:]
        self.taskListShowCompleted = [:]
        self.manualTaskOrder = [:]
        self.updatedAt = Date()
    }
}

// MARK: - Task Item

public struct TaskItem: Codable, Identifiable, Sendable {
    public var id: String
    public var uid: String
    public var accountId: String
    public var collectionId: String
    public var url: String?
    public var etag: String?
    public var title: String
    public var notes: String
    public var status: TaskStatus
    public var priority: Int            // 0 = none, 1 = high, 5 = medium, 9 = low
    public var startDate: Date?
    public var startDateIsAllDay: Bool?
    public var dueDate: Date?
    public var dueDateIsAllDay: Bool?
    public var reminders: [TaskReminder]
    public var unsupportedReminderBlocks: [String]?
    public var completedAt: Date?
    public var createdAt: Date
    public var updatedAt: Date
    public var tagIds: [String]
    public var syncState: SyncState

    public init(
        id: String = UUID().uuidString,
        uid: String = UUID().uuidString,
        accountId: String,
        collectionId: String,
        title: String,
        notes: String = "",
        status: TaskStatus = .needsAction,
        priority: Int = 0,
        startDate: Date? = nil,
        dueDate: Date? = nil,
        reminders: [TaskReminder] = [],
        tagIds: [String] = [],
        syncState: SyncState = .idle
    ) {
        self.id = id
        self.uid = uid
        self.accountId = accountId
        self.collectionId = collectionId
        self.title = title
        self.notes = notes
        self.status = status
        self.priority = priority
        self.startDate = startDate
        self.dueDate = dueDate
        self.reminders = reminders
        self.tagIds = tagIds
        self.createdAt = Date()
        self.updatedAt = Date()
        self.syncState = syncState
    }
}

// MARK: - Task Filter

public struct TaskFilter: Codable, Sendable {
    public var query: String
    public var statuses: [TaskStatus]
    public var tagIds: [String]
    public var includeDescendantTags: Bool
    public var collectionIds: [String]
    public var includeDescendantCollections: Bool
    public var datePreset: DatePreset
    public var customFrom: Date?
    public var customTo: Date?

    public init(
        query: String = "",
        statuses: [TaskStatus] = [],
        tagIds: [String] = [],
        includeDescendantTags: Bool = true,
        collectionIds: [String] = [],
        includeDescendantCollections: Bool = true,
        datePreset: DatePreset = .any,
        customFrom: Date? = nil,
        customTo: Date? = nil
    ) {
        self.query = query
        self.statuses = statuses
        self.tagIds = tagIds
        self.includeDescendantTags = includeDescendantTags
        self.collectionIds = collectionIds
        self.includeDescendantCollections = includeDescendantCollections
        self.datePreset = datePreset
        self.customFrom = customFrom
        self.customTo = customTo
    }

    public static let `default` = TaskFilter()
}

// MARK: - Smart List

public struct SmartList: Codable, Identifiable, Sendable {
    public var id: String
    public var accountId: String
    public var definition: String
    public var name: String
    public var filter: TaskFilter
    public var ordering: TaskOrdering
    public var showCompleted: Bool
    public var url: String?
    public var etag: String?
    public var syncState: SyncState
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString,
        accountId: String,
        name: String,
        filter: TaskFilter = .default,
        ordering: TaskOrdering = .defaultSmartList,
        showCompleted: Bool = false
    ) {
        self.id = id
        self.accountId = accountId
        self.definition = ""
        self.name = name
        self.filter = filter
        self.ordering = ordering
        self.showCompleted = showCompleted
        self.syncState = .idle
        self.updatedAt = Date()
    }
}

// MARK: - Sync Log

public struct SyncLogEntry: Codable, Identifiable, Sendable {
    public var id: String
    public var accountId: String?
    public var source: String
    public var message: String
    public var createdAt: Date

    public init(id: String = UUID().uuidString, accountId: String? = nil, source: String, message: String) {
        self.id = id
        self.accountId = accountId
        self.source = source
        self.message = message
        self.createdAt = Date()
    }
}

// MARK: - App Settings

public struct AppSettings: Codable, Sendable {
    public var autoSyncEnabled: Bool
    public var autoSyncIntervalMinutes: Int

    public init(autoSyncEnabled: Bool = true, autoSyncIntervalMinutes: Int = 15) {
        self.autoSyncEnabled = autoSyncEnabled
        self.autoSyncIntervalMinutes = autoSyncIntervalMinutes
    }
}

// MARK: - Task Mutation (offline queue)

public struct TaskMutation: Codable, Identifiable, Sendable {
    public enum MutationKind: String, Codable, Sendable { case upsert, delete }
    public var id: String
    public var accountId: String
    public var kind: MutationKind
    public var task: TaskItem
    public var collectionId: String
    public var createdAt: Date

    public init(id: String = UUID().uuidString, accountId: String, kind: MutationKind, task: TaskItem, collectionId: String) {
        self.id = id
        self.accountId = accountId
        self.kind = kind
        self.task = task
        self.collectionId = collectionId
        self.createdAt = Date()
    }
}

// MARK: - App Snapshot (full persisted state)

public struct AppSnapshot: Codable, Sendable {
    public var accounts: [Account]
    public var collections: [TaskCollection]
    public var tasks: [TaskItem]
    public var smartLists: [SmartList]
    public var metadataDocs: [MetadataDocument]
    public var syncLogs: [SyncLogEntry]
    public var settings: AppSettings
    public var queuedMutations: [TaskMutation]

    public init() {
        accounts = []
        collections = []
        tasks = []
        smartLists = []
        metadataDocs = []
        syncLogs = []
        settings = AppSettings()
        queuedMutations = []
    }
}

// MARK: - Connection Input

public struct AccountConnectionInput: Sendable {
    public var label: String
    public var serverUrl: String
    public var connectionMode: ConnectionMode
    public var username: String
    public var password: String

    public init(label: String, serverUrl: String, connectionMode: ConnectionMode = .direct, username: String, password: String) {
        self.label = label
        self.serverUrl = serverUrl
        self.connectionMode = connectionMode
        self.username = username
        self.password = password
    }
}
