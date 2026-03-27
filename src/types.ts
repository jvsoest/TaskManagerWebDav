export type CollectionKind = 'task' | 'metadata' | 'smart'

export type TaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled'

export type SyncState = 'idle' | 'syncing' | 'synced' | 'error'
export type TaskOrderMode = 'manual' | 'property'
export type TaskOrderField = 'dueDate' | 'startDate' | 'priority' | 'title' | 'createdAt' | 'updatedAt' | 'status'
export type SortDirection = 'asc' | 'desc'
export type ConnectionMode = 'direct' | 'proxy'
export type ReminderAnchor = 'start' | 'due'

export interface TaskReminderAbsolute {
  id: string
  kind: 'absolute'
  at: string
}

export interface TaskReminderRelative {
  id: string
  kind: 'relative'
  anchor: ReminderAnchor
  minutesBefore: number
}

export type TaskReminder = TaskReminderAbsolute | TaskReminderRelative

export interface TaskOrdering {
  mode: TaskOrderMode
  field: TaskOrderField
  direction: SortDirection
}

export interface Account {
  id: string
  label: string
  serverUrl: string
  connectionMode: ConnectionMode
  proxyUrl?: string
  username: string
  password: string
  displayName: string
  syncState: SyncState
  lastSyncAt?: string
  lastError?: string
}

export interface TaskCollection {
  id: string
  accountId: string
  url: string
  displayName: string
  description?: string
  color?: string
  kind: CollectionKind
  ctag?: string
  syncToken?: string
}

export interface TagNode {
  id: string
  accountId: string
  name: string
  parentId?: string
}

export interface MetadataDocument {
  accountId: string
  version: 2
  tagNodes: TagNode[]
  collectionParents: Record<string, string | undefined>
  collectionOrder: string[]
  smartListOrder: string[]
  taskListOrderings: Record<string, TaskOrdering | undefined>
  taskListShowCompleted: Record<string, boolean | undefined>
  manualTaskOrder: Record<string, string[] | undefined>
  updatedAt: string
  url?: string
  etag?: string
}

export interface TaskItem {
  id: string
  uid: string
  accountId: string
  collectionId: string
  url?: string
  etag?: string
  title: string
  notes: string
  status: TaskStatus
  priority: number
  startDate?: string
  startDateIsAllDay?: boolean
  dueDate?: string
  dueDateIsAllDay?: boolean
  reminders: TaskReminder[]
  unsupportedReminderBlocks?: string[]
  completedAt?: string
  createdAt: string
  updatedAt: string
  tagIds: string[]
  syncState: SyncState
}

export interface TaskFilter {
  query: string
  statuses: TaskStatus[]
  tagIds: string[]
  includeDescendantTags: boolean
  collectionIds: string[]
  includeDescendantCollections: boolean
  datePreset: 'any' | 'overdue' | 'today' | `next${number}` | 'custom'
  customFrom?: string
  customTo?: string
}

export interface SmartList {
  id: string
  accountId: string
  definition: string
  name: string
  filter: TaskFilter
  ordering: TaskOrdering
  showCompleted: boolean
  url?: string
  etag?: string
  syncState: SyncState
  updatedAt: string
}

export interface SyncLogEntry {
  id: string
  accountId?: string
  source: string
  message: string
  createdAt: string
}

export interface AppSettings {
  autoSyncEnabled: boolean
  autoSyncIntervalMinutes: number
}

export interface TaskMutation {
  id: string
  accountId: string
  kind: 'upsert' | 'delete'
  task: TaskItem
  collectionId: string
  createdAt: string
}

export interface AppSnapshot {
  accounts: Account[]
  collections: TaskCollection[]
  tasks: TaskItem[]
  smartLists: SmartList[]
  metadataDocs: MetadataDocument[]
  syncLogs: SyncLogEntry[]
  settings: AppSettings
  queuedMutations: TaskMutation[]
}

export interface AccountConnectionInput {
  label: string
  serverUrl: string
  connectionMode: ConnectionMode
  proxyUrl: string
  username: string
  password: string
}

export interface DiscoverAccountResult {
  accountDisplayName: string
  collections: TaskCollection[]
}

export interface SyncResult {
  tasks: TaskItem[]
  collections: TaskCollection[]
  metadataDoc: MetadataDocument
  smartLists: SmartList[]
}
