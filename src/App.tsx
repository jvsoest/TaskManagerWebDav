import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import {
  createDefaultMetadata,
  defaultFilter,
  defaultSmartListOrdering,
  defaultTaskListOrdering,
  expandTreeIds,
  extractHashtags,
  getSmartListCount,
  normalizeOrdering,
  sortTasks,
  taskMatchesFilter,
  taskMatchesSmartList,
  validateSmartListDefinition,
} from './lib/filters'
import { clearLocalCache, loadSnapshot, saveSnapshot } from './lib/idb'
import { notifyDueTasks, requestNotifications } from './lib/notifications'
import {
  createTaskCollection,
  deleteTaskCollection,
  deleteSmartListRemote,
  deleteTaskRemote,
  discoverAccount,
  renameTaskCollection,
  saveMetadataRemote,
  syncAccount,
  updateTaskCollectionColor,
  upsertSmartListRemote,
  upsertTaskRemote,
} from './lib/caldav'
import { newUuid } from './lib/ids'
import type {
  Account,
  AccountConnectionInput,
  AppSettings,
  AppSnapshot,
  MetadataDocument,
  SmartList,
  SortDirection,
  SyncLogEntry,
  TaskMutation,
  TaskItem,
  TaskOrderField,
  TaskOrdering,
  TaskStatus,
} from './types'

type ActiveView =
  | { kind: 'collection'; collectionId: string }
  | { kind: 'smart'; smartListId: string }

type WorkspaceMode = 'tasks' | 'settings'
type SettingsSection = 'accounts' | 'structure'
type CollectionViewScope = 'self' | 'self-and-descendants'
type DescriptionMode = 'display' | 'edit'

type TaskDraft = Omit<TaskItem, 'id' | 'uid' | 'createdAt' | 'updatedAt' | 'syncState'> & {
  id?: string
  uid?: string
}

type DragSession = {
  taskId: string
  pointerX: number
  pointerY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

type PendingTaskPress = {
  taskId: string
  pointerX: number
  pointerY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

type SettingsDragSession = {
  kind: 'collection' | 'smart'
  itemId: string
  parentId?: string
  pointerX: number
  pointerY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

type PendingSettingsPress = {
  kind: 'collection' | 'smart'
  itemId: string
  parentId?: string
  pointerX: number
  pointerY: number
  offsetX: number
  offsetY: number
  width: number
  height: number
}

const emptySnapshot: AppSnapshot = {
  accounts: [],
  collections: [],
  tasks: [],
  smartLists: [],
  metadataDocs: [],
  syncLogs: [],
  settings: {
    autoSyncEnabled: true,
    autoSyncIntervalMinutes: 15,
  },
  queuedMutations: [],
}

const emptyConnection: AccountConnectionInput = {
  label: '',
  serverUrl: '',
  connectionMode: 'direct',
  proxyUrl: '',
  username: '',
  password: '',
}

const statuses: TaskStatus[] = ['needs-action', 'in-process', 'completed', 'cancelled']
const orderingFields: Array<{ value: TaskOrderField; label: string }> = [
  { value: 'dueDate', label: 'Due date' },
  { value: 'startDate', label: 'Start date' },
  { value: 'priority', label: 'Priority' },
  { value: 'title', label: 'Title' },
  { value: 'createdAt', label: 'Created' },
  { value: 'updatedAt', label: 'Updated' },
  { value: 'status', label: 'Status' },
]
const sortDirections: Array<{ value: SortDirection; label: string }> = [
  { value: 'asc', label: 'Ascending' },
  { value: 'desc', label: 'Descending' },
]

function createDraft(collectionId?: string, accountId?: string): TaskDraft {
  return {
    accountId: accountId ?? '',
    collectionId: collectionId ?? '',
    title: '',
    notes: '',
    status: 'needs-action',
    priority: 0,
    startDateIsAllDay: true,
    dueDateIsAllDay: true,
    tagIds: [],
  }
}

function newId(): string {
  return newUuid()
}

function mergeSyncedAndPendingTasks(remoteTasks: TaskItem[], localTasks: TaskItem[]): TaskItem[] {
  const mergedById = new Map(remoteTasks.map((task) => [task.id, task]))

  localTasks
    .filter((task) => task.syncState !== 'synced')
    .forEach((task) => {
      mergedById.set(task.id, task)
    })

  return Array.from(mergedById.values())
}

function isRetryableTaskMutationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true
  }

  const message = error.message
  const statusMatch = message.match(/\((\d{3})\)/)
  if (!statusMatch) {
    return true
  }

  const status = Number.parseInt(statusMatch[1], 10)
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function enqueueTaskMutation(
  queuedMutations: TaskMutation[],
  nextMutation: TaskMutation,
): TaskMutation[] {
  const deduped = queuedMutations.filter(
    (entry) => !(entry.accountId === nextMutation.accountId && entry.task.id === nextMutation.task.id),
  )

  if (nextMutation.kind === 'delete' && !nextMutation.task.url) {
    return deduped
  }

  return [...deduped, nextMutation]
}

function normalizeDateInput(value?: string): string {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function normalizeDateOnlyInput(value?: string): string {
  if (!value) {
    return ''
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10)
  }

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function collectionColorStyle(color?: string): React.CSSProperties | undefined {
  if (!color) {
    return undefined
  }
  return { '--collection-color': color } as React.CSSProperties
}

function normalizeColorForInput(color?: string): string {
  if (!color) {
    return '#D7D7D7'
  }

  const match = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())
  if (!match) {
    return '#D7D7D7'
  }

  return `#${match[1].slice(0, 6)}`
}

function displayDate(value?: string): string {
  if (!value) {
    return 'No date'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: value.includes('T') ? '2-digit' : undefined,
    minute: value.includes('T') ? '2-digit' : undefined,
  }).format(date)
}

function syncLabel(value?: string): string {
  if (!value) {
    return 'Not synced yet'
  }

  return `Synced ${new Date(value).toLocaleString()}`
}

function defaultDescriptionMode(notes?: string): DescriptionMode {
  return notes?.trim() ? 'display' : 'edit'
}

function sameTaskDraft(left: TaskDraft, right: TaskDraft): boolean {
  return (
    left.id === right.id &&
    left.uid === right.uid &&
    left.accountId === right.accountId &&
    left.collectionId === right.collectionId &&
    left.title === right.title &&
    left.notes === right.notes &&
    left.status === right.status &&
    left.priority === right.priority &&
    left.startDate === right.startDate &&
    left.startDateIsAllDay === right.startDateIsAllDay &&
    left.dueDate === right.dueDate &&
    left.dueDateIsAllDay === right.dueDateIsAllDay &&
    left.completedAt === right.completedAt &&
    left.url === right.url &&
    left.etag === right.etag &&
    left.tagIds.length === right.tagIds.length &&
    left.tagIds.every((tagId, index) => tagId === right.tagIds[index])
  )
}

function moveTaskIdToIndex(items: string[], taskId: string, targetIndex: number): string[] {
  const fromIndex = items.indexOf(taskId)
  if (fromIndex < 0) {
    return items
  }

  const next = [...items]
  next.splice(fromIndex, 1)
  const insertIndex = Math.max(0, Math.min(targetIndex, next.length))
  next.splice(insertIndex, 0, taskId)
  return next
}

function moveIdToIndex(items: string[], itemId: string, targetIndex: number): string[] {
  const fromIndex = items.indexOf(itemId)
  if (fromIndex < 0) {
    return items
  }

  const next = [...items]
  next.splice(fromIndex, 1)
  const insertIndex = Math.max(0, Math.min(targetIndex, next.length))
  next.splice(insertIndex, 0, itemId)
  return next
}

function moveCollectionIdWithinParent(
  collectionIds: string[],
  collectionParents: Record<string, string | undefined>,
  collectionId: string,
  targetIndex: number,
): string[] {
  const parentId = collectionParents[collectionId]
  const siblingIds = collectionIds.filter((id) => collectionParents[id] === parentId)
  if (!siblingIds.includes(collectionId)) {
    return collectionIds
  }

  const nextSiblingIds = moveIdToIndex(siblingIds, collectionId, targetIndex)
  let cursor = 0

  return collectionIds.map((id) => {
    if (collectionParents[id] !== parentId) {
      return id
    }
    const nextId = nextSiblingIds[cursor]
    cursor += 1
    return nextId
  })
}

function buildTreeOptions<T extends { id: string; name: string; parentId?: string }>(nodes: T[]) {
  const children = new Map<string | undefined, T[]>()
  nodes.forEach((node) => {
    const bucket = children.get(node.parentId) ?? []
    bucket.push(node)
    children.set(node.parentId, bucket)
  })

  const result: Array<{ id: string; label: string; depth: number; node: T }> = []

  function walk(parentId: string | undefined, depth: number) {
    const entries = children.get(parentId) ?? []
    entries.forEach((node) => {
      result.push({
        id: node.id,
        label: `${depth > 0 ? `${'↳ '.repeat(depth)}` : ''}${node.name}`,
        depth,
        node,
      })
      walk(node.id, depth + 1)
    })
  }

  walk(undefined, 0)
  return result
}

function settingsRowKey(kind: 'collection' | 'smart', itemId: string): string {
  return `${kind}:${itemId}`
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot)
  const [hydrated, setHydrated] = useState(false)
  const [activeAccountId, setActiveAccountId] = useState<string>()
  const [activeView, setActiveView] = useState<ActiveView>()
  const [collectionViewScope, setCollectionViewScope] = useState<CollectionViewScope>('self')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(createDraft())
  const [connectionForm, setConnectionForm] = useState<AccountConnectionInput>(emptyConnection)
  const [listDraft, setListDraft] = useState({ name: '', parentId: '' })
  const [smartDraftId, setSmartDraftId] = useState<string>()
  const [smartDraftName, setSmartDraftName] = useState('')
  const [smartDraftDefinition, setSmartDraftDefinition] = useState('')
  const [smartDraftOrdering, setSmartDraftOrdering] = useState<TaskOrdering>(defaultSmartListOrdering())
  const [searchText, setSearchText] = useState('')
  const [selectedViewTags, setSelectedViewTags] = useState<string[]>([])
  const [quickAddTitle, setQuickAddTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Connect a CalDAV account to start syncing tasks.')
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isSmartEditorOpen, setIsSmartEditorOpen] = useState(false)
  const [collapsedCollections, setCollapsedCollections] = useState<string[]>([])
  const [dragSession, setDragSession] = useState<DragSession>()
  const [pendingTaskPress, setPendingTaskPress] = useState<PendingTaskPress>()
  const [dropIndex, setDropIndex] = useState<number>()
  const [settingsDragSession, setSettingsDragSession] = useState<SettingsDragSession>()
  const [pendingSettingsPress, setPendingSettingsPress] = useState<PendingSettingsPress>()
  const [settingsDropIndex, setSettingsDropIndex] = useState<number>()
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('tasks')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('accounts')
  const [renamingCollectionId, setRenamingCollectionId] = useState<string>()
  const [renameCollectionValue, setRenameCollectionValue] = useState('')
  const [colorPickerCollectionId, setColorPickerCollectionId] = useState<string>()
  const [descriptionMode, setDescriptionMode] = useState<DescriptionMode>('edit')
  const deliveredRef = useRef<Set<string>>(new Set())
  const taskRowsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const settingsRowsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const suppressTaskClickRef = useRef(false)
  const snapshotRef = useRef<AppSnapshot>(emptySnapshot)
  const syncInFlightRef = useRef<Set<string>>(new Set())
  const autoSyncedAccountIdsRef = useRef<Set<string>>(new Set())
  const syncRunnerRef = useRef<(accountId?: string) => void>(() => {})
  const deferredSearch = useDeferredValue(searchText)

  useEffect(() => {
    void loadSnapshot().then((loaded) => {
      setSnapshot(loaded)
      setActiveAccountId(loaded.accounts[0]?.id)
      setHydrated(true)
    })
  }, [])

  useEffect(() => {
    if (!hydrated) {
      return
    }

    void saveSnapshot(snapshot)
  }, [hydrated, snapshot])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  const activeAccount = snapshot.accounts.find((account) => account.id === activeAccountId)
  const activeCollections = snapshot.collections.filter((collection) => collection.accountId === activeAccountId)
  const taskCollections = activeCollections.filter((collection) => collection.kind === 'task')
  const metadataCollection = activeCollections.find((collection) => collection.kind === 'metadata')
  const smartCollection = activeCollections.find((collection) => collection.kind === 'smart')
  const activeTasks = snapshot.tasks.filter((task) => task.accountId === activeAccountId)
  const activeSmartLists = snapshot.smartLists.filter((smartList) => smartList.accountId === activeAccountId)
  const defaultCollectionId = taskCollections[0]?.id
  const metadataDoc =
    snapshot.metadataDocs.find((doc) => doc.accountId === activeAccountId) ??
    (activeAccountId ? createDefaultMetadata(activeAccountId) : undefined)
  const isSettingsMode = workspaceMode === 'settings'
  const isEditorMode = isCreatingTask || Boolean(selectedTaskId)
  const visibleSyncLogs = useMemo(
    () =>
      [...snapshot.syncLogs]
        .filter((entry) => !activeAccountId || !entry.accountId || entry.accountId === activeAccountId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 20),
    [activeAccountId, snapshot.syncLogs],
  )
  const orderedCollectionIds = useMemo(() => {
    const ids = taskCollections.map((collection) => collection.id)
    const preferred = (metadataDoc?.collectionOrder ?? []).filter((id) => ids.includes(id))
    const missing = ids.filter((id) => !preferred.includes(id))
    return [...preferred, ...missing]
  }, [metadataDoc?.collectionOrder, taskCollections])
  const orderedTaskCollections = useMemo(
    () =>
      orderedCollectionIds
        .map((id) => taskCollections.find((collection) => collection.id === id))
        .filter((collection): collection is (typeof taskCollections)[number] => Boolean(collection)),
    [orderedCollectionIds, taskCollections],
  )
  const orderedSmartListIds = useMemo(() => {
    const ids = activeSmartLists.map((smartList) => smartList.id)
    const preferred = (metadataDoc?.smartListOrder ?? []).filter((id) => ids.includes(id))
    const missing = ids.filter((id) => !preferred.includes(id))
    return [...preferred, ...missing]
  }, [activeSmartLists, metadataDoc?.smartListOrder])
  const orderedSmartLists = useMemo(
    () =>
      orderedSmartListIds
        .map((id) => activeSmartLists.find((smartList) => smartList.id === id))
        .filter((smartList): smartList is (typeof activeSmartLists)[number] => Boolean(smartList)),
    [activeSmartLists, orderedSmartListIds],
  )
  const renderedSmartLists = useMemo(() => {
    if (settingsDragSession?.kind !== 'smart') {
      return orderedSmartLists
    }

    return orderedSmartLists.filter((smartList) => smartList.id !== settingsDragSession.itemId)
  }, [orderedSmartLists, settingsDragSession])
  const availableTags = useMemo(
    () => Array.from(new Set(activeTasks.flatMap((task) => task.tagIds))).sort(),
    [activeTasks],
  )
  const activeViewKey = activeView?.kind === 'collection'
    ? `collection:${activeView.collectionId}`
    : activeView?.kind === 'smart'
      ? `smart:${activeView.smartListId}`
      : undefined
  const collectionTreeNodes = useMemo(
    () =>
      orderedTaskCollections.map((collection) => ({
        id: collection.id,
        name: collection.displayName,
        parentId: metadataDoc?.collectionParents[collection.id],
      })),
    [metadataDoc?.collectionParents, orderedTaskCollections],
  )
  const collectionTreeOptions = useMemo(
    () => buildTreeOptions(collectionTreeNodes),
    [collectionTreeNodes],
  )

  useEffect(() => {
    if (!activeAccountId) {
      return
    }

    const hasValidCollectionView =
      activeView?.kind === 'collection' &&
      orderedTaskCollections.some((collection) => collection.id === activeView.collectionId)
    const hasValidSmartView =
      activeView?.kind === 'smart' &&
      orderedSmartLists.some((smartList) => smartList.id === activeView.smartListId)

    if (hasValidCollectionView || hasValidSmartView) {
      return
    }

    if (orderedTaskCollections[0]) {
      setActiveView({ kind: 'collection', collectionId: orderedTaskCollections[0].id })
      setCollectionViewScope('self')
      return
    }

    if (orderedSmartLists[0]) {
      setActiveView({ kind: 'smart', smartListId: orderedSmartLists[0].id })
    }
  }, [activeAccountId, activeView, orderedSmartLists, orderedTaskCollections])

  useEffect(() => {
    setSelectedViewTags([])
  }, [activeAccountId, activeViewKey])

  useEffect(() => {
    if (
      !hydrated ||
      !activeAccountId ||
      !snapshotRef.current.accounts.some((account) => account.id === activeAccountId)
    ) {
      return
    }

    if (autoSyncedAccountIdsRef.current.has(activeAccountId)) {
      return
    }

    autoSyncedAccountIdsRef.current.add(activeAccountId)
    syncRunnerRef.current(activeAccountId)
  }, [activeAccountId, hydrated])

  useEffect(() => {
    if (!hydrated || !activeAccountId || !snapshot.settings.autoSyncEnabled) {
      return
    }

    const intervalMs = Math.max(1, snapshot.settings.autoSyncIntervalMinutes) * 60_000
    const intervalId = window.setInterval(() => {
      syncRunnerRef.current(activeAccountId)
    }, intervalMs)

    return () => window.clearInterval(intervalId)
  }, [activeAccountId, hydrated, snapshot.settings.autoSyncEnabled, snapshot.settings.autoSyncIntervalMinutes])

  useEffect(() => {
    if (!hydrated) {
      return
    }

    function handleOnline() {
      syncRunnerRef.current(activeAccountId)
    }

    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [activeAccountId, hydrated])

  useEffect(() => {
    const selectedTask = snapshot.tasks.find(
      (task) => task.id === selectedTaskId && task.accountId === activeAccountId,
    )

    if (selectedTask) {
      const nextDraft: TaskDraft = {
        id: selectedTask.id,
        uid: selectedTask.uid,
        accountId: selectedTask.accountId,
        collectionId: selectedTask.collectionId,
        title: selectedTask.title,
        notes: selectedTask.notes,
        status: selectedTask.status,
        priority: selectedTask.priority,
        startDate: selectedTask.startDate,
        startDateIsAllDay: selectedTask.startDateIsAllDay ?? true,
        dueDate: selectedTask.dueDate,
        dueDateIsAllDay: selectedTask.dueDateIsAllDay ?? true,
        completedAt: selectedTask.completedAt,
        tagIds: selectedTask.tagIds,
        url: selectedTask.url,
        etag: selectedTask.etag,
      }

      setTaskDraft((current) => (sameTaskDraft(current, nextDraft) ? current : nextDraft))
      setDescriptionMode(defaultDescriptionMode(selectedTask.notes))
      return
    }

    if (isCreatingTask) {
      return
    }

    const nextDraft = createDraft(defaultCollectionId, activeAccountId)
    setTaskDraft((current) => (sameTaskDraft(current, nextDraft) ? current : nextDraft))
    setDescriptionMode(defaultDescriptionMode(nextDraft.notes))
  }, [activeAccountId, defaultCollectionId, isCreatingTask, selectedTaskId, snapshot.tasks])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const tasks = snapshot.tasks.filter((task) => task.accountId === activeAccountId)
      notifyDueTasks(tasks, deliveredRef.current)
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [activeAccountId, snapshot.tasks])

  const activeSmartList = useMemo(
    () =>
      activeView?.kind === 'smart'
        ? orderedSmartLists.find((entry) => entry.id === activeView.smartListId)
        : undefined,
    [activeView, orderedSmartLists],
  )
  const currentTaskListOrdering = useMemo(
    () =>
      activeView?.kind === 'collection'
        ? normalizeOrdering(metadataDoc?.taskListOrderings[activeView.collectionId], defaultTaskListOrdering())
        : defaultTaskListOrdering(),
    [activeView, metadataDoc?.taskListOrderings],
  )
  const currentOrdering = useMemo(
    () =>
      activeView?.kind === 'smart'
        ? normalizeOrdering(activeSmartList?.ordering, defaultSmartListOrdering())
        : activeView?.kind === 'collection'
          ? currentTaskListOrdering
          : {
              mode: 'property' as const,
              field: 'dueDate' as const,
              direction: 'asc' as const,
            },
    [activeSmartList?.ordering, activeView, currentTaskListOrdering],
  )
  const canManualReorderTasks = activeView?.kind === 'collection' && currentOrdering.mode === 'manual'

  const scopedVisibleTasks = useMemo(() => {
    let tasks = activeTasks

    if (activeView?.kind === 'collection') {
      const allowedCollectionIds =
        collectionViewScope === 'self-and-descendants'
          ? expandTreeIds(
              [activeView.collectionId],
              taskCollections.map((collection) => ({
                id: collection.id,
                parentId: metadataDoc?.collectionParents[collection.id],
              })),
            )
          : new Set([activeView.collectionId])
      tasks = tasks.filter((task) => allowedCollectionIds.has(task.collectionId))
    }

    if (activeView?.kind === 'smart') {
      if (activeSmartList && metadataDoc) {
        tasks = tasks.filter((task) => taskMatchesSmartList(task, activeSmartList, metadataDoc, taskCollections))
      }
    }

    if (deferredSearch.trim() && metadataDoc) {
      const searchFilter = { ...defaultFilter(), query: deferredSearch }
      tasks = tasks.filter((task) => taskMatchesFilter(task, searchFilter, metadataDoc, taskCollections))
    }

    const manualTaskIds =
      activeView?.kind === 'collection' && currentOrdering.mode === 'manual'
        ? metadataDoc?.manualTaskOrder[activeView.collectionId] ?? []
        : []

    return sortTasks(tasks, currentOrdering, manualTaskIds)
  }, [activeSmartList, activeTasks, activeView, collectionViewScope, currentOrdering, deferredSearch, metadataDoc, taskCollections])
  const visibleFilterTags = useMemo(
    () => Array.from(new Set(scopedVisibleTasks.flatMap((task) => task.tagIds))).sort(),
    [scopedVisibleTasks],
  )
  const visibleTasks = useMemo(() => {
    if (selectedViewTags.length === 0) {
      return scopedVisibleTasks
    }

    return scopedVisibleTasks.filter((task) =>
      selectedViewTags.every((tag) => task.tagIds.includes(tag)),
    )
  }, [scopedVisibleTasks, selectedViewTags])
  const openVisibleTasks = useMemo(
    () => visibleTasks.filter((task) => task.status !== 'completed'),
    [visibleTasks],
  )
  const completedVisibleTasks = useMemo(
    () => visibleTasks.filter((task) => task.status === 'completed'),
    [visibleTasks],
  )
  const renderedOpenTasks = useMemo(() => {
    if (!dragSession || !canManualReorderTasks) {
      return openVisibleTasks
    }

    return openVisibleTasks.filter((task) => task.id !== dragSession.taskId)
  }, [canManualReorderTasks, dragSession, openVisibleTasks])
  const renderedCompletedTasks = completedVisibleTasks
  const draggedTask = dragSession ? visibleTasks.find((task) => task.id === dragSession.taskId) : undefined
  const draggedSettingsCollection =
    settingsDragSession?.kind === 'collection'
      ? orderedTaskCollections.find((collection) => collection.id === settingsDragSession.itemId)
      : undefined
  const draggedSettingsSmartList =
    settingsDragSession?.kind === 'smart'
      ? orderedSmartLists.find((smartList) => smartList.id === settingsDragSession.itemId)
      : undefined

  const collectionSections = useMemo(() => {
    const roots = collectionTreeNodes.filter((collection) => !collection.parentId)
    const children = new Map<string, typeof collectionTreeNodes>()
    collectionTreeNodes.forEach((collection) => {
      if (!collection.parentId) {
        return
      }
      const entries = children.get(collection.parentId) ?? []
      entries.push(collection)
      children.set(collection.parentId, entries)
    })
    return {
      roots,
      children,
    }
  }, [collectionTreeNodes])
  const orderedCollectionOptions = useMemo(() => {
    const options: Array<{ id: string; label: string }> = []

    function appendCollection(collectionId: string, depth: number) {
      const collection = orderedTaskCollections.find((entry) => entry.id === collectionId)
      if (!collection) {
        return
      }
      options.push({
        id: collection.id,
        label: `${'↳ '.repeat(depth)}${collection.displayName}`,
      })
      ;(collectionSections.children.get(collectionId) ?? []).forEach((childCollection) =>
        appendCollection(childCollection.id, depth + 1),
      )
    }

    collectionSections.roots.forEach((collection) => appendCollection(collection.id, 0))

    return options
  }, [collectionSections, orderedTaskCollections])

  const currentViewTitle =
    activeView?.kind === 'collection'
      ? taskCollections.find((collection) => collection.id === activeView.collectionId)?.displayName ?? 'Task list'
      : activeView?.kind === 'smart'
        ? orderedSmartLists.find((smartList) => smartList.id === activeView.smartListId)?.name ?? 'Smart list'
        : orderedTaskCollections[0]?.displayName ?? orderedSmartLists[0]?.name ?? 'Tasks'

  function replaceSnapshot(nextSnapshot: AppSnapshot) {
    startTransition(() => setSnapshot(nextSnapshot))
  }

  function replaceSnapshotWith(updater: (current: AppSnapshot) => AppSnapshot) {
    startTransition(() => setSnapshot((current) => updater(current)))
  }

  function updateAccount(accountId: string, patch: Partial<Account>) {
    replaceSnapshot({
      ...snapshot,
      accounts: snapshot.accounts.map((account) =>
        account.id === accountId ? { ...account, ...patch } : account,
      ),
    })
  }

  function updateSettings(patch: Partial<AppSettings>) {
    replaceSnapshotWith((current) => ({
      ...current,
      settings: {
        ...current.settings,
        ...patch,
      },
    }))
  }

  function queueTaskMutation(kind: TaskMutation['kind'], task: TaskItem, collectionId = task.collectionId) {
    const mutation: TaskMutation = {
      id: newId(),
      accountId: task.accountId,
      kind,
      task,
      collectionId,
      createdAt: new Date().toISOString(),
    }

    replaceSnapshotWith((current) => ({
      ...current,
      queuedMutations: enqueueTaskMutation(current.queuedMutations, mutation),
    }))
  }

  async function flushQueuedMutations(account: Account): Promise<void> {
    const initialSnapshot = snapshotRef.current
    const queued = initialSnapshot.queuedMutations
      .filter((mutation) => mutation.accountId === account.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))

    for (const mutation of queued) {
      const currentSnapshot = snapshotRef.current
      const currentAccount = currentSnapshot.accounts.find((entry) => entry.id === account.id) ?? account
      const collection = currentSnapshot.collections.find(
        (entry) => entry.accountId === account.id && entry.id === mutation.collectionId,
      )

      if (!collection) {
        continue
      }

      try {
        if (mutation.kind === 'upsert') {
          const remote = await upsertTaskRemote(currentAccount, collection, mutation.task)
          replaceSnapshotWith((current) => ({
            ...current,
            tasks: current.tasks.map((task) =>
              task.id === mutation.task.id
                ? { ...task, url: remote.url, etag: remote.etag, syncState: 'synced' }
                : task,
            ),
            queuedMutations: current.queuedMutations.filter((entry) => entry.id !== mutation.id),
          }))
        } else {
          await deleteTaskRemote(currentAccount, mutation.task)
          replaceSnapshotWith((current) => ({
            ...current,
            queuedMutations: current.queuedMutations.filter((entry) => entry.id !== mutation.id),
            tasks: current.tasks.filter((task) => task.id !== mutation.task.id),
          }))
        }
      } catch (error) {
        if (!isRetryableTaskMutationError(error)) {
          replaceSnapshotWith((current) => ({
            ...current,
            queuedMutations: current.queuedMutations.filter((entry) => entry.id !== mutation.id),
          }))
        }
        throw error
      }
    }
  }

  function openTask(taskId: string) {
    setWorkspaceMode('tasks')
    setSelectedTaskId(taskId)
    setIsCreatingTask(false)
    setIsSidebarOpen(false)
  }

  function closeEditor() {
    setSelectedTaskId(undefined)
    setIsCreatingTask(false)
    setTaskDraft(createDraft(defaultCollectionId, activeAccountId))
    setDescriptionMode('edit')
  }

  function beginNewTask(prefill = '') {
    setWorkspaceMode('tasks')
    setSelectedTaskId(undefined)
    setIsCreatingTask(true)
    setDescriptionMode('edit')
    setTaskDraft({
      ...createDraft(defaultCollectionId, activeAccountId),
      title: prefill,
    })
  }

  function openSettings(section: SettingsSection = 'accounts') {
    setWorkspaceMode('settings')
    setSettingsSection(section)
    setIsSidebarOpen(false)
  }

  function closeSettings() {
    setWorkspaceMode('tasks')
  }

  function handleTaskDragStart(event: React.PointerEvent<HTMLSpanElement>, task: TaskItem) {
    if (!canManualReorderTasks || task.status === 'completed' || activeView?.kind !== 'collection') {
      return
    }

    const row = taskRowsRef.current.get(task.id)
    if (!row) {
      return
    }

    const rect = row.getBoundingClientRect()

    setPendingTaskPress({
      taskId: task.id,
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    })
  }

  function handleSettingsDragStart(
    event: React.PointerEvent<HTMLSpanElement>,
    kind: 'collection' | 'smart',
    itemId: string,
    parentId?: string,
  ) {
    const row = settingsRowsRef.current.get(settingsRowKey(kind, itemId))
    if (!row) {
      return
    }

    const rect = row.getBoundingClientRect()

    setPendingSettingsPress({
      kind,
      itemId,
      parentId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    })
  }

  useEffect(() => {
    if (!pendingTaskPress) {
      return
    }

    const press = pendingTaskPress

    function clearPendingTaskPress() {
      setPendingTaskPress(undefined)
    }

    function handlePointerMove(event: PointerEvent) {
      const deltaX = event.clientX - press.pointerX
      const deltaY = event.clientY - press.pointerY
      if (Math.hypot(deltaX, deltaY) < 6) {
        return
      }

      suppressTaskClickRef.current = true
      setDragSession({
        taskId: press.taskId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        offsetX: press.offsetX,
        offsetY: press.offsetY,
        width: press.width,
        height: press.height,
      })
      clearPendingTaskPress()
    }

    function handlePointerEnd() {
      clearPendingTaskPress()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }
  }, [pendingTaskPress])

  useEffect(() => {
    if (!pendingSettingsPress) {
      return
    }

    const press = pendingSettingsPress

    function clearPendingSettingsPress() {
      setPendingSettingsPress(undefined)
    }

    function handlePointerMove(event: PointerEvent) {
      const deltaX = event.clientX - press.pointerX
      const deltaY = event.clientY - press.pointerY
      if (Math.hypot(deltaX, deltaY) < 6) {
        return
      }

      setSettingsDragSession({
        kind: press.kind,
        itemId: press.itemId,
        parentId: press.parentId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        offsetX: press.offsetX,
        offsetY: press.offsetY,
        width: press.width,
        height: press.height,
      })
      clearPendingSettingsPress()
    }

    function handlePointerEnd() {
      clearPendingSettingsPress()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }
  }, [pendingSettingsPress])

  const recordSyncIssue = useCallback(
    (source: string, failure: string, accountId = activeAccountId) => {
      const nextEntry: SyncLogEntry = {
        id: newId(),
        accountId,
        source,
        message: failure,
        createdAt: new Date().toISOString(),
      }

      replaceSnapshotWith((current) => ({
        ...current,
        syncLogs: [nextEntry, ...current.syncLogs].slice(0, 50),
      }))
    },
    [activeAccountId],
  )

  function toggleCollectionCollapsed(collectionId: string) {
    setCollapsedCollections((current) =>
      current.includes(collectionId) ? current.filter((id) => id !== collectionId) : [...current, collectionId],
    )
  }

  const isManualOrderingEnabled = useCallback(
    (collectionId: string): boolean =>
      normalizeOrdering(metadataDoc?.taskListOrderings[collectionId], defaultTaskListOrdering()).mode === 'manual',
    [metadataDoc?.taskListOrderings],
  )

  function withTaskPosition(
    doc: MetadataDocument,
    task: Pick<TaskItem, 'id' | 'collectionId' | 'status'>,
    previousTask?: Pick<TaskItem, 'id' | 'collectionId' | 'status'>,
  ): MetadataDocument {
    const previousCollectionId = previousTask?.collectionId
    const nextManualTaskOrder = Object.fromEntries(
      Object.entries(doc.manualTaskOrder).map(([collectionId, taskIds]) => [
        collectionId,
        (taskIds ?? []).filter((taskId) => taskId !== task.id),
      ]),
    )

    if (previousCollectionId && !nextManualTaskOrder[previousCollectionId]) {
      nextManualTaskOrder[previousCollectionId] = []
    }

    if (
      task.status !== 'completed' &&
      normalizeOrdering(doc.taskListOrderings[task.collectionId], defaultTaskListOrdering()).mode === 'manual'
    ) {
      const currentIds = nextManualTaskOrder[task.collectionId] ?? []
      const shouldPreservePosition =
        previousTask &&
        previousTask.collectionId === task.collectionId &&
        previousTask.status !== 'completed' &&
        (doc.manualTaskOrder[task.collectionId] ?? []).includes(task.id)

      nextManualTaskOrder[task.collectionId] = shouldPreservePosition ? currentIds : [...currentIds, task.id]
    }

    return {
      ...doc,
      manualTaskOrder: nextManualTaskOrder,
    }
  }

  async function handleUpdateTaskListOrdering(
    collectionId: string,
    patch: Partial<TaskOrdering>,
  ) {
    if (!metadataDoc) {
      return
    }

    const currentOrdering = normalizeOrdering(metadataDoc.taskListOrderings[collectionId], defaultTaskListOrdering())
    const nextOrdering = normalizeOrdering(
      {
        ...currentOrdering,
        ...patch,
      },
      defaultTaskListOrdering(),
    )

    await saveMetadata(
      {
        ...metadataDoc,
        taskListOrderings: {
          ...metadataDoc.taskListOrderings,
          [collectionId]: nextOrdering,
        },
        updatedAt: new Date().toISOString(),
      },
      'Task list ordering updated.',
    )
  }

  async function handleConnectAccount() {
    if (!connectionForm.serverUrl || !connectionForm.username || !connectionForm.password) {
      setMessage('Server URL, username, and password are required.')
      return
    }

    if (connectionForm.connectionMode === 'proxy' && !connectionForm.proxyUrl.trim()) {
      setMessage('Proxy URL is required when using Proxy mode.')
      return
    }

    const accountId = newId()
    setBusy(true)
    setMessage('Discovering task collections...')

    try {
      const discovery = await discoverAccount(connectionForm, accountId)
      const account: Account = {
        id: accountId,
        label: connectionForm.label || discovery.accountDisplayName || connectionForm.username,
        serverUrl: connectionForm.serverUrl,
        connectionMode: connectionForm.connectionMode,
        proxyUrl: connectionForm.connectionMode === 'proxy' ? connectionForm.proxyUrl.trim() : undefined,
        username: connectionForm.username,
        password: connectionForm.password,
        displayName: discovery.accountDisplayName,
        syncState: 'syncing',
      }

      replaceSnapshot({
        ...snapshot,
        accounts: [...snapshot.accounts, account],
        collections: [...snapshot.collections, ...discovery.collections],
        metadataDocs: [...snapshot.metadataDocs, createDefaultMetadata(accountId)],
      })
      setActiveAccountId(accountId)
      setActiveView(undefined)
      setConnectionForm(emptyConnection)

      await handleSyncAccount(account, true)
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Failed to connect account.'
      recordSyncIssue('Account connection', failure, accountId)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleSyncAccount(
    account = activeAccount,
    isFirstSync = false,
  ) {
    if (!account) {
      return
    }

    if (syncInFlightRef.current.has(account.id)) {
      return
    }

    syncInFlightRef.current.add(account.id)
    setBusy(true)
    setMessage(`Syncing ${account.label}...`)
    updateAccount(account.id, { syncState: 'syncing', lastError: undefined })

    try {
      try {
        await flushQueuedMutations(account)
      } catch (error) {
        const failure = error instanceof Error ? error.message : 'Queued task replay failed.'
        recordSyncIssue('Queued task replay', failure, account.id)
      }

      const result = await syncAccount(account)
      const nextAccount: Account = {
        ...account,
        syncState: 'synced',
        lastSyncAt: new Date().toISOString(),
        lastError: undefined,
      }

      replaceSnapshotWith((current) => {
        const localAccountTasks = current.tasks.filter((entry) => entry.accountId === account.id)

        return {
          ...current,
          accounts: [...current.accounts.filter((entry) => entry.id !== account.id), nextAccount],
          collections: [...current.collections.filter((entry) => entry.accountId !== account.id), ...result.collections],
          tasks: [
            ...current.tasks.filter((entry) => entry.accountId !== account.id),
            ...mergeSyncedAndPendingTasks(result.tasks, localAccountTasks),
          ],
          smartLists: [
            ...current.smartLists.filter((entry) => entry.accountId !== account.id),
            ...result.smartLists,
          ],
          metadataDocs: [
            ...current.metadataDocs.filter((entry) => entry.accountId !== account.id),
            result.metadataDoc,
          ],
        }
      })
      setMessage(isFirstSync ? 'Account connected and synced.' : `${account.label} is up to date.`)
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Sync failed.'
      updateAccount(account.id, { syncState: 'error', lastError: failure })
      recordSyncIssue('Account sync', failure, account.id)
      setMessage(failure)
    } finally {
      syncInFlightRef.current.delete(account.id)
      setBusy(false)
    }
  }

  syncRunnerRef.current = (accountId?: string) => {
    const targetId = accountId ?? activeAccountId
    if (!targetId) {
      return
    }

    const account = snapshotRef.current.accounts.find((entry) => entry.id === targetId)
    if (account) {
      void handleSyncAccount(account)
    }
  }

  async function handleSaveTask() {
    if (!activeAccount || !metadataDoc || taskCollections.length === 0) {
      setMessage('Connect an account with at least one task list before saving tasks.')
      return
    }

    const previousTask = snapshot.tasks.find((task) => task.id === taskDraft.id)
    const targetCollection =
      taskCollections.find((collection) => collection.id === taskDraft.collectionId) ?? taskCollections[0]
    const now = new Date().toISOString()
    const nextTask: TaskItem = {
      id: taskDraft.id ?? newId(),
      uid: taskDraft.uid ?? newId().replace(/-/g, ''),
      accountId: activeAccount.id,
      collectionId: targetCollection.id,
      title: taskDraft.title.trim(),
      notes: taskDraft.notes.trim(),
      status: taskDraft.status,
      priority: taskDraft.priority,
      startDate: taskDraft.startDate,
      startDateIsAllDay: taskDraft.startDateIsAllDay,
      dueDate: taskDraft.dueDate,
      dueDateIsAllDay: taskDraft.dueDateIsAllDay,
      completedAt: taskDraft.status === 'completed' ? taskDraft.completedAt ?? now : undefined,
      createdAt: snapshot.tasks.find((task) => task.id === taskDraft.id)?.createdAt ?? now,
      updatedAt: now,
      tagIds: extractHashtags(taskDraft.title.trim(), taskDraft.notes.trim()),
      syncState: 'syncing',
      url: taskDraft.url,
      etag: taskDraft.etag,
    }

    setMessage(`Saving ${nextTask.title || 'task'}...`)

    try {
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [...current.tasks.filter((task) => task.id !== nextTask.id), nextTask],
      }))
      const remote = await upsertTaskRemote(activeAccount, targetCollection, nextTask)
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          { ...nextTask, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
        queuedMutations: current.queuedMutations.filter((entry) => entry.task.id !== nextTask.id),
      }))
      const nextMetadataDoc = withTaskPosition(
        metadataDoc,
        { ...nextTask, status: nextTask.status, collectionId: targetCollection.id },
        previousTask,
      )
      const metadataChanged =
        JSON.stringify(nextMetadataDoc.manualTaskOrder) !== JSON.stringify(metadataDoc.manualTaskOrder)
      if (metadataChanged) {
        await saveMetadata(
          {
            ...nextMetadataDoc,
            updatedAt: new Date().toISOString(),
          },
          'Task saved to CalDAV.',
        )
      } else {
        setMessage('Task saved to CalDAV.')
      }
      closeEditor()
    } catch (error) {
      const queuedTask = { ...nextTask, syncState: 'error' as const }
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          queuedTask,
        ],
      }))
      if (isRetryableTaskMutationError(error)) {
        queueTaskMutation('upsert', queuedTask, targetCollection.id)
      }
      const failure = error instanceof Error ? error.message : 'Task save failed.'
      recordSyncIssue('Task save', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  async function handleToggleTaskStatus(task: TaskItem) {
    if (!activeAccount || !metadataDoc) {
      return
    }

    const targetCollection = taskCollections.find((collection) => collection.id === task.collectionId)
    if (!targetCollection) {
      return
    }

    const updatedTask: TaskItem = {
      ...task,
      status: task.status === 'completed' ? 'needs-action' : 'completed',
      completedAt: task.status === 'completed' ? undefined : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncState: 'syncing',
    }

    replaceSnapshot({
      ...snapshot,
      tasks: [...snapshot.tasks.filter((entry) => entry.id !== task.id), updatedTask],
    })

    try {
      const remote = await upsertTaskRemote(activeAccount, targetCollection, updatedTask)
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((entry) => entry.id !== task.id),
          { ...updatedTask, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
        queuedMutations: current.queuedMutations.filter((entry) => entry.task.id !== task.id),
      }))
      const nextMetadataDoc = withTaskPosition(metadataDoc, updatedTask, task)
      if (JSON.stringify(nextMetadataDoc.manualTaskOrder) !== JSON.stringify(metadataDoc.manualTaskOrder)) {
        await saveMetadata(
          {
            ...nextMetadataDoc,
            updatedAt: new Date().toISOString(),
          },
          'Task updated.',
        )
      }
    } catch (error) {
      const queuedTask = { ...updatedTask, syncState: 'error' as const }
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [...current.tasks.filter((entry) => entry.id !== task.id), queuedTask],
      }))
      if (isRetryableTaskMutationError(error)) {
        queueTaskMutation('upsert', queuedTask, targetCollection.id)
      }
      const failure = error instanceof Error ? error.message : 'Task update failed.'
      recordSyncIssue('Task update', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  async function handleDeleteTask() {
    if (!activeAccount || !taskDraft.id) {
      return
    }

    const existing = snapshot.tasks.find((task) => task.id === taskDraft.id)
    if (!existing) {
      return
    }

    replaceSnapshot({
      ...snapshot,
      tasks: snapshot.tasks.filter((task) => task.id !== existing.id),
    })
    closeEditor()

    try {
      await deleteTaskRemote(activeAccount, existing)
      replaceSnapshotWith((current) => ({
        ...current,
        queuedMutations: current.queuedMutations.filter((entry) => entry.task.id !== existing.id),
      }))
      if (metadataDoc) {
        const nextMetadataDoc = {
          ...metadataDoc,
          manualTaskOrder: Object.fromEntries(
            Object.entries(metadataDoc.manualTaskOrder).map(([collectionId, taskIds]) => [
              collectionId,
              (taskIds ?? []).filter((taskId) => taskId !== existing.id),
            ]),
          ),
          updatedAt: new Date().toISOString(),
        }
        if (JSON.stringify(nextMetadataDoc.manualTaskOrder) !== JSON.stringify(metadataDoc.manualTaskOrder)) {
          await saveMetadata(nextMetadataDoc, 'Task deleted from CalDAV.')
        } else {
          setMessage('Task deleted from CalDAV.')
        }
        return
      }
      setMessage('Task deleted from CalDAV.')
    } catch (error) {
      if (isRetryableTaskMutationError(error)) {
        queueTaskMutation('delete', existing, existing.collectionId)
      } else {
        replaceSnapshotWith((current) => ({
          ...current,
          tasks: [...current.tasks, { ...existing, syncState: 'error' }],
        }))
      }
      const failure = error instanceof Error ? error.message : 'Task delete failed.'
      recordSyncIssue('Task delete', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  const saveMetadata = useCallback(
    async (doc: MetadataDocument, successMessage: string) => {
      if (!activeAccount || !metadataCollection) {
        return
      }

      replaceSnapshotWith((current) => ({
        ...current,
        metadataDocs: [...current.metadataDocs.filter((entry) => entry.accountId !== doc.accountId), doc],
      }))

      try {
        const remote = await saveMetadataRemote(activeAccount, metadataCollection, doc, taskCollections)
        replaceSnapshotWith((current) => ({
          ...current,
          metadataDocs: [
            ...current.metadataDocs.filter((entry) => entry.accountId !== doc.accountId),
            {
              ...doc,
              url: remote.url,
              etag: remote.etag,
            },
          ],
        }))
        setMessage(successMessage)
      } catch (error) {
        const failure = error instanceof Error ? error.message : 'Metadata save failed.'
        recordSyncIssue('Metadata sync', failure, activeAccount.id)
        setMessage(failure)
      }
    },
    [activeAccount, metadataCollection, recordSyncIssue, taskCollections],
  )

  useEffect(() => {
    if (!dragSession || !canManualReorderTasks) {
      return
    }

    function updateDropIndex(pointerY: number) {
      const openTaskIds = renderedOpenTasks.map((task) => task.id)
      if (openTaskIds.length === 0) {
        setDropIndex(0)
        return
      }

      for (let index = 0; index < openTaskIds.length; index += 1) {
        const element = taskRowsRef.current.get(openTaskIds[index])
        if (!element) {
          continue
        }

        const rect = element.getBoundingClientRect()
        if (pointerY < rect.top + rect.height / 2) {
          setDropIndex(index)
          return
        }
      }

      setDropIndex(openTaskIds.length)
    }

    function handlePointerMove(event: PointerEvent) {
      setDragSession((current) =>
        current
          ? {
              ...current,
              pointerX: event.clientX,
              pointerY: event.clientY,
            }
          : current,
      )
      updateDropIndex(event.clientY)
    }

    function finishDrag(commit: boolean) {
      const currentDropIndex = dropIndex ?? renderedOpenTasks.length
      const currentDragSession = dragSession
      setDragSession(undefined)
      setDropIndex(undefined)

      if (
        commit &&
        currentDragSession &&
        metadataDoc &&
        activeView?.kind === 'collection' &&
        isManualOrderingEnabled(activeView.collectionId)
      ) {
        const collectionId = activeView.collectionId
        const openTaskIds = visibleTasks.filter((task) => task.status !== 'completed').map((task) => task.id)
        const baseOrder = [
          ...(metadataDoc.manualTaskOrder[collectionId] ?? []).filter((id) => openTaskIds.includes(id)),
          ...openTaskIds.filter((id) => !(metadataDoc.manualTaskOrder[collectionId] ?? []).includes(id)),
        ]
        const nextOrder = moveTaskIdToIndex(baseOrder, currentDragSession.taskId, currentDropIndex)
        void saveMetadata(
          {
            ...metadataDoc,
            manualTaskOrder: {
              ...metadataDoc.manualTaskOrder,
              [collectionId]: nextOrder,
            },
            updatedAt: new Date().toISOString(),
          },
          'Task order updated.',
        )
      }
    }

    function handlePointerUp() {
      finishDrag(true)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        finishDrag(false)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('keydown', handleKeyDown)
    document.body.classList.add('drag-active')
    updateDropIndex(dragSession.pointerY)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('drag-active')
    }
  }, [activeView, canManualReorderTasks, dragSession, dropIndex, isManualOrderingEnabled, metadataDoc, renderedOpenTasks, saveMetadata, visibleTasks])

  useEffect(() => {
    const activeSettingsDrag = settingsDragSession
    const currentMetadataDoc = metadataDoc

    if (!activeSettingsDrag || !currentMetadataDoc) {
      return
    }

    const drag = activeSettingsDrag
    const metadata = currentMetadataDoc

    function renderedIdsForSession(session: SettingsDragSession): string[] {
      if (session.kind === 'smart') {
        return renderedSmartLists.map((smartList) => smartList.id)
      }

      return orderedCollectionIds.filter(
        (collectionId) =>
          metadata.collectionParents[collectionId] === session.parentId && collectionId !== session.itemId,
      )
    }

    function updateSettingsDropIndex(pointerY: number) {
      const renderedIds = renderedIdsForSession(drag)
      if (renderedIds.length === 0) {
        setSettingsDropIndex(0)
        return
      }

      for (let index = 0; index < renderedIds.length; index += 1) {
        const element = settingsRowsRef.current.get(settingsRowKey(drag.kind, renderedIds[index]))
        if (!element) {
          continue
        }

        const rect = element.getBoundingClientRect()
        if (pointerY < rect.top + rect.height / 2) {
          setSettingsDropIndex(index)
          return
        }
      }

      setSettingsDropIndex(renderedIds.length)
    }

    function handlePointerMove(event: PointerEvent) {
      setSettingsDragSession((current) =>
        current
          ? {
              ...current,
              pointerX: event.clientX,
              pointerY: event.clientY,
            }
          : current,
      )
      updateSettingsDropIndex(event.clientY)
    }

    function finishSettingsDrag(commit: boolean) {
      const session = drag
      const currentDropIndex = settingsDropIndex ?? renderedIdsForSession(drag).length
      setSettingsDragSession(undefined)
      setSettingsDropIndex(undefined)

      if (!commit) {
        return
      }

      if (session.kind === 'smart') {
        void saveMetadata(
          {
            ...metadata,
            smartListOrder: moveIdToIndex(orderedSmartListIds, session.itemId, currentDropIndex),
            updatedAt: new Date().toISOString(),
          },
          'Smart list order updated.',
        )
        return
      }

      void saveMetadata(
        {
          ...metadata,
          collectionOrder: moveCollectionIdWithinParent(
            orderedCollectionIds,
            metadata.collectionParents,
            session.itemId,
            currentDropIndex,
          ),
          updatedAt: new Date().toISOString(),
        },
        'Task list order updated.',
      )
    }

    function handlePointerUp() {
      finishSettingsDrag(true)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        finishSettingsDrag(false)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('keydown', handleKeyDown)
    document.body.classList.add('drag-active')
    updateSettingsDropIndex(drag.pointerY)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.classList.remove('drag-active')
    }
  }, [metadataDoc, orderedCollectionIds, orderedSmartListIds, renderedSmartLists, saveMetadata, settingsDragSession, settingsDropIndex])

  async function handleAssignCollectionParent(collectionId: string, parentId?: string) {
    if (!metadataDoc) {
      return
    }

    if (parentId) {
      const descendantIds = expandTreeIds(
        [collectionId],
        taskCollections.map((collection) => ({
          id: collection.id,
          parentId: metadataDoc.collectionParents[collection.id],
        })),
      )
      if (descendantIds.has(parentId)) {
        setMessage('A list cannot be nested inside itself or one of its sublists.')
        return
      }
    }

    await saveMetadata(
      {
        ...metadataDoc,
        collectionParents: {
          ...metadataDoc.collectionParents,
          [collectionId]: parentId || undefined,
        },
        collectionOrder: [...metadataDoc.collectionOrder],
        updatedAt: new Date().toISOString(),
      },
      'List hierarchy updated.',
    )
  }

  async function handleDeleteTaskList(collectionId: string) {
    if (!activeAccount) {
      return
    }

    const collection = taskCollections.find((entry) => entry.id === collectionId)
    if (!collection) {
      return
    }

    setBusy(true)
    setMessage(`Deleting ${collection.displayName}...`)

    try {
      await deleteTaskCollection(activeAccount, collection)

      let nextMetadataDoc = metadataDoc
        ? {
            ...metadataDoc,
            collectionParents: Object.fromEntries(
              Object.entries(metadataDoc.collectionParents).flatMap(([key, parentId]) => {
                if (key === collectionId) {
                  return []
                }
                return [[key, parentId === collectionId ? undefined : parentId]]
              }),
            ),
            collectionOrder: metadataDoc.collectionOrder.filter((id) => id !== collectionId),
            taskListOrderings: Object.fromEntries(
              Object.entries(metadataDoc.taskListOrderings).filter(([key]) => key !== collectionId),
            ),
            manualTaskOrder: Object.fromEntries(
              Object.entries(metadataDoc.manualTaskOrder).filter(([key]) => key !== collectionId),
            ),
            updatedAt: new Date().toISOString(),
          }
        : undefined

      if (nextMetadataDoc) {
        const remote = await saveMetadataRemote(activeAccount, metadataCollection!, nextMetadataDoc!, taskCollections)
        nextMetadataDoc = {
          ...nextMetadataDoc,
          url: remote.url,
          etag: remote.etag,
        }
      }

      replaceSnapshotWith((current) => ({
        ...current,
        collections: current.collections.filter((entry) => entry.id !== collectionId),
        tasks: current.tasks.filter((task) => task.collectionId !== collectionId),
        metadataDocs: nextMetadataDoc
          ? [...current.metadataDocs.filter((entry) => entry.accountId !== nextMetadataDoc.accountId), nextMetadataDoc]
          : current.metadataDocs,
      }))

      if (activeView?.kind === 'collection' && activeView.collectionId === collectionId) {
        setActiveView(undefined)
      }
      if (taskDraft.collectionId === collectionId || selectedTaskId) {
        closeEditor()
      }

      setMessage('Task list deleted.')
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Task list delete failed.'
      recordSyncIssue('Task list delete', failure, activeAccount.id)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateTaskList() {
    if (!activeAccount || !listDraft.name.trim()) {
      return
    }

    setBusy(true)
    setMessage(`Creating ${listDraft.name.trim()}...`)

    try {
      const newCollection = await createTaskCollection(activeAccount, listDraft.name)

      replaceSnapshot({
        ...snapshot,
        collections: [...snapshot.collections, newCollection],
      })

      if (metadataDoc && listDraft.parentId) {
        await saveMetadata(
          {
            ...metadataDoc,
            collectionParents: {
              ...metadataDoc.collectionParents,
              [newCollection.id]: listDraft.parentId,
            },
            updatedAt: new Date().toISOString(),
          },
          'Task list created.',
        )
      } else {
        setMessage('Task list created.')
      }

      setListDraft({ name: '', parentId: '' })
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Task list creation failed.'
      recordSyncIssue('Task list creation', failure, activeAccount.id)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleRenameTaskList(collectionId: string) {
    if (!activeAccount || !renameCollectionValue.trim()) {
      return
    }

    const collection = taskCollections.find((entry) => entry.id === collectionId)
    if (!collection) {
      return
    }

    setBusy(true)
    setMessage(`Renaming ${collection.displayName}...`)

    try {
      const renamedCollection = await renameTaskCollection(activeAccount, collection, renameCollectionValue)
      replaceSnapshotWith((current) => ({
        ...current,
        collections: current.collections.map((entry) => (entry.id === collectionId ? renamedCollection : entry)),
      }))
      setRenamingCollectionId(undefined)
      setRenameCollectionValue('')
      setMessage('Task list renamed.')
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Task list rename failed.'
      recordSyncIssue('Task list rename', failure, activeAccount.id)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdateTaskListColor(collectionId: string, color: string) {
    if (!activeAccount) {
      return
    }

    const collection = taskCollections.find((entry) => entry.id === collectionId)
    if (!collection) {
      return
    }

    setBusy(true)
    setMessage(`Updating color for ${collection.displayName}...`)

    try {
      const updatedCollection = await updateTaskCollectionColor(activeAccount, collection, color)
      replaceSnapshotWith((current) => ({
        ...current,
        collections: current.collections.map((entry) => (entry.id === collectionId ? updatedCollection : entry)),
      }))
      setColorPickerCollectionId(undefined)
      setMessage('Task list color updated.')
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Task list color update failed.'
      recordSyncIssue('Task list color update', failure, activeAccount.id)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveSmartList() {
    if (!activeAccount || !smartCollection || !metadataDoc || !smartDraftName.trim()) {
      return
    }

    const definitionError = validateSmartListDefinition(smartDraftDefinition)
    if (definitionError) {
      setMessage(definitionError)
      return
    }

    const existingSmartList = snapshot.smartLists.find((entry) => entry.id === smartDraftId)
    const nextSmartList: SmartList = {
      id: smartDraftId ?? newId(),
      accountId: activeAccount.id,
      definition: smartDraftDefinition.trim(),
      name: smartDraftName.trim(),
      filter: defaultFilter(),
      ordering: normalizeOrdering(smartDraftOrdering, defaultSmartListOrdering()),
      syncState: 'syncing',
      updatedAt: new Date().toISOString(),
      url: existingSmartList?.url,
      etag: existingSmartList?.etag,
    }

    replaceSnapshotWith((current) => ({
      ...current,
      smartLists: [...current.smartLists.filter((entry) => entry.id !== nextSmartList.id), nextSmartList],
    }))

    try {
      const remote = await upsertSmartListRemote(activeAccount, smartCollection, nextSmartList)
      replaceSnapshotWith((current) => ({
        ...current,
        smartLists: [
          ...current.smartLists.filter((entry) => entry.id !== nextSmartList.id),
          { ...nextSmartList, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
      }))
      const needsOrderUpdate = !metadataDoc.smartListOrder.includes(nextSmartList.id)
      if (needsOrderUpdate) {
        await saveMetadata(
          {
            ...metadataDoc,
            smartListOrder: [...orderedSmartListIds, nextSmartList.id],
            updatedAt: new Date().toISOString(),
          },
          'Smart list saved.',
        )
      } else {
        setMessage('Smart list saved.')
      }
      setSmartDraftId(undefined)
      setSmartDraftName('')
      setSmartDraftDefinition('')
      setSmartDraftOrdering(defaultSmartListOrdering())
      setIsSmartEditorOpen(false)
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Smart list save failed.'
      recordSyncIssue('Smart list save', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  async function handleDeleteSmartList(smartList: SmartList) {
    if (!activeAccount) {
      return
    }

    replaceSnapshot({
      ...snapshot,
      smartLists: snapshot.smartLists.filter((entry) => entry.id !== smartList.id),
    })

    try {
      await deleteSmartListRemote(activeAccount, smartList)
      if (metadataDoc && metadataDoc.smartListOrder.includes(smartList.id)) {
        await saveMetadata(
          {
            ...metadataDoc,
            smartListOrder: metadataDoc.smartListOrder.filter((id) => id !== smartList.id),
            updatedAt: new Date().toISOString(),
          },
          'Smart list deleted.',
        )
      } else {
        setMessage('Smart list deleted.')
      }
      if (activeView?.kind === 'smart' && activeView.smartListId === smartList.id) {
        setActiveView(undefined)
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Smart list delete failed.'
      recordSyncIssue('Smart list delete', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  async function handleNotifications() {
    const permission = await requestNotifications()
    if (permission === 'unsupported') {
      setMessage('Notifications are not supported in this browser.')
      return
    }

    setMessage(
      permission === 'granted'
        ? 'Notifications enabled. Reminders fire while the PWA is active.'
        : 'Notification permission was not granted.',
    )
  }

  async function handleClearLocalCache() {
    setBusy(true)
    setMessage('Clearing local cache...')

    try {
      await clearLocalCache()

      if ('caches' in window) {
        const cacheKeys = await window.caches.keys()
        await Promise.all(cacheKeys.map((key) => window.caches.delete(key)))
      }

      replaceSnapshot(emptySnapshot)
      setActiveAccountId(undefined)
      setActiveView(undefined)
      setSelectedTaskId(undefined)
      setTaskDraft(createDraft())
      setIsCreatingTask(false)
      setSmartDraftId(undefined)
      setSmartDraftName('')
      setSmartDraftDefinition('')
      setSearchText('')
      setQuickAddTitle('')
      setCollapsedCollections([])
      setConnectionForm(emptyConnection)
      setListDraft({ name: '', parentId: '' })
      setWorkspaceMode('settings')
      setSettingsSection('accounts')
      setMessage('Local cache cleared. Reconnect an account to sync again.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to clear local cache.')
    } finally {
      setBusy(false)
    }
  }

  async function handleQuickAdd() {
    if (!activeAccount || !metadataDoc || taskCollections.length === 0) {
      setMessage('Connect an account with at least one task list before adding tasks.')
      return
    }

    if (!quickAddTitle.trim()) {
      beginNewTask()
      return
    }

    const targetCollection =
      activeView?.kind === 'collection'
        ? taskCollections.find((collection) => collection.id === activeView.collectionId) ?? taskCollections[0]
        : taskCollections[0]
    const now = new Date().toISOString()
    const nextTask: TaskItem = {
      id: newId(),
      uid: newId().replace(/-/g, ''),
      accountId: activeAccount.id,
      collectionId: targetCollection.id,
      title: quickAddTitle.trim(),
      notes: '',
      status: 'needs-action',
      priority: 0,
      tagIds: extractHashtags(quickAddTitle.trim()),
      createdAt: now,
      updatedAt: now,
      syncState: 'syncing',
    }

    setQuickAddTitle('')
    setMessage(`Saving ${nextTask.title}...`)

    try {
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [...current.tasks.filter((task) => task.id !== nextTask.id), nextTask],
      }))
      const remote = await upsertTaskRemote(activeAccount, targetCollection, nextTask)
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          { ...nextTask, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
        queuedMutations: current.queuedMutations.filter((entry) => entry.task.id !== nextTask.id),
      }))
      const nextMetadataDoc = withTaskPosition(metadataDoc, nextTask)
      const metadataChanged =
        JSON.stringify(nextMetadataDoc.manualTaskOrder) !== JSON.stringify(metadataDoc.manualTaskOrder)
      if (metadataChanged) {
        await saveMetadata(
          {
            ...nextMetadataDoc,
            updatedAt: new Date().toISOString(),
          },
          'Task added.',
        )
      } else {
        setMessage('Task added.')
      }
    } catch (error) {
      const queuedTask = { ...nextTask, syncState: 'error' as const }
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          queuedTask,
        ],
      }))
      if (isRetryableTaskMutationError(error)) {
        queueTaskMutation('upsert', queuedTask, targetCollection.id)
      }
      const failure = error instanceof Error ? error.message : 'Quick add failed.'
      recordSyncIssue('Quick add', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  function editSmartList(smartList: SmartList) {
    setSmartDraftId(smartList.id)
    setSmartDraftName(smartList.name)
    setSmartDraftDefinition(smartList.definition)
    setSmartDraftOrdering(normalizeOrdering(smartList.ordering, defaultSmartListOrdering()))
    setIsSmartEditorOpen(true)
  }

  function renderCollectionTree(collectionId: string, depth = 0): React.JSX.Element | null {
    const collection = orderedTaskCollections.find((entry) => entry.id === collectionId)
    if (!collection) {
      return null
    }

    const childCollections = collectionSections.children.get(collection.id) ?? []
    const hasChildren = childCollections.length > 0
    const isCollapsed = collapsedCollections.includes(collection.id)
    const descendantIds = expandTreeIds(
      [collection.id],
      taskCollections.map((entry) => ({
        id: entry.id,
        parentId: metadataDoc?.collectionParents[entry.id],
      })),
    )
    const selfTaskCount = activeTasks.filter((task) => task.collectionId === collection.id).length
    const descendantTaskCount = activeTasks.filter((task) => descendantIds.has(task.collectionId)).length
    const taskCount = hasChildren && isCollapsed ? descendantTaskCount : selfTaskCount

    return (
      <div key={collection.id} className="sidebar-folder">
        <div className={`sidebar-folder-toggle depth-${Math.min(depth, 3)} ${hasChildren ? 'has-children' : ''}`}>
          <button
            className={`sidebar-link nested ${
              activeView?.kind === 'collection' && activeView.collectionId === collection.id ? 'active' : ''
            }`}
            style={collectionColorStyle(collection.color)}
            onClick={() => {
              setWorkspaceMode('tasks')
              setActiveView({ kind: 'collection', collectionId: collection.id })
              setCollectionViewScope('self')
              setIsSidebarOpen(false)
            }}
          >
            <span className="sidebar-link-main">
              {hasChildren ? (
                <span
                  className={`collection-color-dot collapsible ${isCollapsed ? 'collapsed' : 'expanded'}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleCollectionCollapsed(collection.id)
                  }}
                  role="button"
                  aria-label={isCollapsed ? 'Expand sublists' : 'Collapse sublists'}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      event.stopPropagation()
                      toggleCollectionCollapsed(collection.id)
                    }
                  }}
                />
              ) : (
                <span className="collection-color-dot" />
              )}
              <span>{collection.displayName}</span>
            </span>
            <strong>{taskCount}</strong>
          </button>
        </div>

        {!isCollapsed &&
          childCollections.map((childCollection) =>
            renderCollectionTree(childCollection.id, depth + 1),
          )}
      </div>
    )
  }

  function renderSettingsCollectionRow(collection: (typeof orderedTaskCollections)[number], depth: number) {
    const ordering = normalizeOrdering(metadataDoc?.taskListOrderings[collection.id], defaultTaskListOrdering())

    return (
      <div key={collection.id} className="structure-branch">
        <div
          ref={(element) => {
            const key = settingsRowKey('collection', collection.id)
            if (element) {
              settingsRowsRef.current.set(key, element)
            } else {
              settingsRowsRef.current.delete(key)
            }
          }}
          className={`assign-row structure-row depth-${Math.min(depth, 3)} ${
            settingsDragSession?.kind === 'collection' && settingsDragSession.itemId === collection.id ? 'drag-source-hidden' : ''
          }`}
        >
          <div className="settings-row-title" style={collectionColorStyle(collection.color)}>
            <span
              className="task-drag-handle settings-drag-handle"
              onPointerDown={(event) =>
                handleSettingsDragStart(event, 'collection', collection.id, metadataDoc?.collectionParents[collection.id])
              }
            >
              ::
            </span>
            <button
              className="color-dot-button"
              onClick={() =>
                setColorPickerCollectionId((current) => (current === collection.id ? undefined : collection.id))
              }
            >
              <span className="collection-color-dot" />
            </button>
            {renamingCollectionId === collection.id ? (
              <input
                value={renameCollectionValue}
                onChange={(event) => setRenameCollectionValue(event.target.value)}
                className="rename-list-input"
                placeholder="List name"
              />
            ) : (
              <span>{collection.displayName}</span>
            )}
            {colorPickerCollectionId === collection.id && (
              <div className="color-picker-inline">
                <input
                  type="color"
                  value={normalizeColorForInput(collection.color)}
                  onChange={(event) => void handleUpdateTaskListColor(collection.id, event.target.value)}
                />
              </div>
            )}
          </div>
          <div className="assign-actions">
            <select
              value={metadataDoc?.collectionParents[collection.id] ?? ''}
              onChange={(event) =>
                void handleAssignCollectionParent(collection.id, event.target.value || undefined)
              }
            >
              <option value="">Root</option>
              {collectionTreeOptions
                .filter((option) => {
                  if (option.id === collection.id) {
                    return false
                  }
                  const descendantIds = expandTreeIds(
                    [collection.id],
                    taskCollections.map((entry) => ({
                      id: entry.id,
                      parentId: metadataDoc?.collectionParents[entry.id],
                    })),
                  )
                  return !descendantIds.has(option.id)
                })
                .map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
            </select>
            <select
              value={ordering.mode}
              onChange={(event) =>
                void handleUpdateTaskListOrdering(collection.id, {
                  mode: event.target.value as TaskOrdering['mode'],
                })
              }
            >
              <option value="manual">Manual</option>
              <option value="property">Property</option>
            </select>
            {ordering.mode === 'property' && (
              <>
                <select
                  value={ordering.field}
                  onChange={(event) =>
                    void handleUpdateTaskListOrdering(collection.id, {
                      field: event.target.value as TaskOrderField,
                    })
                  }
                >
                  {orderingFields.map((field) => (
                    <option key={field.value} value={field.value}>
                      {field.label}
                    </option>
                  ))}
                </select>
                <select
                  value={ordering.direction}
                  onChange={(event) =>
                    void handleUpdateTaskListOrdering(collection.id, {
                      direction: event.target.value as SortDirection,
                    })
                  }
                >
                  {sortDirections.map((direction) => (
                    <option key={direction.value} value={direction.value}>
                      {direction.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            {renamingCollectionId === collection.id ? (
              <>
                <button className="ghost-button" onClick={() => void handleRenameTaskList(collection.id)} disabled={busy}>
                  Save
                </button>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setRenamingCollectionId(undefined)
                    setRenameCollectionValue('')
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className="ghost-button"
                onClick={() => {
                  setRenamingCollectionId(collection.id)
                  setRenameCollectionValue(collection.displayName)
                }}
              >
                Rename
              </button>
            )}
            <button className="ghost-button danger" onClick={() => void handleDeleteTaskList(collection.id)}>
              Delete
            </button>
          </div>
        </div>
      </div>
    )
  }

  function renderSettingsCollectionList(parentId: string | undefined, depth: number) {
    const childCollections = (parentId ? collectionSections.children.get(parentId) ?? [] : collectionSections.roots)
      .map((collection) => orderedTaskCollections.find((entry) => entry.id === collection.id))
      .filter((collection): collection is (typeof orderedTaskCollections)[number] => Boolean(collection))

    const renderedCollections =
      settingsDragSession?.kind === 'collection' && settingsDragSession.parentId === parentId
        ? childCollections.filter((collection) => collection.id !== settingsDragSession.itemId)
        : childCollections

    return (
      <div className="structure-children">
        {renderedCollections.map((collection, index) => (
          <div key={collection.id}>
            {settingsDragSession?.kind === 'collection' &&
              settingsDragSession.parentId === parentId &&
              settingsDropIndex === index && <div className="task-drop-slot settings-drop-slot" />}
            {renderSettingsCollectionRow(collection, depth)}
            {renderSettingsCollectionList(collection.id, depth + 1)}
          </div>
        ))}
        {settingsDragSession?.kind === 'collection' &&
          settingsDragSession.parentId === parentId &&
          settingsDropIndex === renderedCollections.length && <div className="task-drop-slot settings-drop-slot" />}
      </div>
    )
  }

  return (
    <div className="todoist-shell">
      <aside className={`todoist-sidebar ${isSidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-top">
          <div>
            <p className="sidebar-label">TaskManagerWebDav</p>
            <h1>Inbox</h1>
          </div>
          <button className="ghost-icon mobile-only" onClick={() => setIsSidebarOpen(false)}>
            x
          </button>
        </div>

        <button className="sidebar-add" onClick={() => beginNewTask()} disabled={!activeAccount}>
          + Add task
        </button>

        <div className="sidebar-search">
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search"
          />
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-group">
            <div className="sidebar-group-title">
              <span>Smart lists</span>
              <button
                className="ghost-inline"
                onClick={() => {
                  setSmartDraftId(undefined)
                  setSmartDraftName('')
                  setSmartDraftDefinition('')
                  setSmartDraftOrdering(defaultSmartListOrdering())
                  setIsSmartEditorOpen(true)
                }}
              >
                New
              </button>
            </div>
            {orderedSmartLists.map((smartList) => (
              <div key={smartList.id} className="sidebar-smart-row">
                <button
                  className={`sidebar-link ${
                    activeView?.kind === 'smart' && activeView.smartListId === smartList.id ? 'active' : ''
                  }`}
                  onClick={() => {
                    setWorkspaceMode('tasks')
                    setActiveView({ kind: 'smart', smartListId: smartList.id })
                    setIsSidebarOpen(false)
                  }}
                >
                  <span>{smartList.name}</span>
                  <strong>{metadataDoc ? getSmartListCount(smartList, activeTasks, metadataDoc, taskCollections) : 0}</strong>
                </button>
                <button className="ghost-icon small" onClick={() => editSmartList(smartList)}>
                  ...
                </button>
              </div>
            ))}
          </div>

          <div className="sidebar-group">
            <div className="sidebar-group-title">
              <span>Lists</span>
              <button className="ghost-inline" onClick={() => openSettings('structure')}>
                Manage
              </button>
            </div>

            {collectionSections.roots.map((collection) => renderCollectionTree(collection.id))}
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-actions">
            <button className="ghost-button" onClick={() => openSettings('accounts')}>
              Settings
            </button>
            <button className="primary-button" onClick={() => void handleSyncAccount()} disabled={!activeAccount || busy}>
              {busy ? 'Working...' : 'Sync'}
            </button>
          </div>
          <button className="account-switcher" onClick={() => openSettings('accounts')}>
            <div>
              <strong>{activeAccount?.label ?? 'No account'}</strong>
              <span>{activeAccount ? syncLabel(activeAccount.lastSyncAt) : 'Connect a CalDAV account'}</span>
            </div>
            <span>{activeAccount?.syncState ?? 'idle'}</span>
          </button>
        </div>
      </aside>

      {isSidebarOpen && <button className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} />}

      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <button className="ghost-icon mobile-only" onClick={() => setIsSidebarOpen(true)}>
              =
            </button>
            <div>
              <p>{activeAccount ? activeAccount.displayName || activeAccount.label : 'No connected account'}</p>
              <h2>
                {isSettingsMode
                  ? 'Settings'
                  : isEditorMode
                    ? (taskDraft.id ? 'Edit task' : 'New task')
                    : currentViewTitle}
              </h2>
            </div>
          </div>
          {isSettingsMode ? (
            <div className="workspace-actions">
              <button className="ghost-button" onClick={closeSettings}>
                Back to tasks
              </button>
            </div>
          ) : (
            <div className="workspace-actions">
              <button className="ghost-button" onClick={() => void handleNotifications()}>
                Reminders
              </button>
              <button className="ghost-button" onClick={() => openSettings('accounts')}>
                Settings
              </button>
              <button
                className="ghost-button"
                onClick={() => {
                  setSmartDraftId(undefined)
                  setSmartDraftName('')
                  setSmartDraftDefinition('')
                  setSmartDraftOrdering(defaultSmartListOrdering())
                  setIsSmartEditorOpen(true)
                }}
                disabled={!activeAccount}
              >
                Smart list
              </button>
              <button className="primary-button" onClick={() => void handleSyncAccount()} disabled={!activeAccount || busy}>
                {busy ? 'Working...' : 'Sync'}
              </button>
            </div>
          )}
        </header>

        {isSettingsMode ? (
          <section className="workspace-surface settings-page">
            <div className="settings-layout">
              <aside className="settings-nav">
                <button
                  className={`settings-nav-button ${settingsSection === 'accounts' ? 'active' : ''}`}
                  onClick={() => setSettingsSection('accounts')}
                >
                  <strong>Accounts</strong>
                  <span>Connections and sync</span>
                </button>
                <button
                  className={`settings-nav-button ${settingsSection === 'structure' ? 'active' : ''}`}
                  onClick={() => setSettingsSection('structure')}
                >
                  <strong>Lists</strong>
                  <span>Nesting and ordering</span>
                </button>
              </aside>

              <div className="settings-panel">
                {settingsSection === 'accounts' && (
                  <section className="settings-page-section">
                    <div className="settings-page-header">
                      <div>
                        <p>Window 1 of 2</p>
                        <h3>Accounts</h3>
                      </div>
                          <button
                            className="ghost-button"
                            onClick={() => void handleSyncAccount()}
                            disabled={!activeAccount || busy}
                          >
                            Sync
                          </button>
                    </div>

                    <div className="stack-list">
                      {snapshot.accounts.map((account) => (
                        <button
                          key={account.id}
                          className={`account-switcher ${account.id === activeAccountId ? 'active' : ''}`}
                          onClick={() => setActiveAccountId(account.id)}
                        >
                          <div>
                            <strong>{account.label}</strong>
                            <span>{syncLabel(account.lastSyncAt)}</span>
                          </div>
                          <span>{account.syncState}</span>
                        </button>
                      ))}
                    </div>

                    <div className="settings-form">
                      <select
                        value={connectionForm.connectionMode}
                        onChange={(event) =>
                          setConnectionForm((current) => ({
                            ...current,
                            connectionMode: event.target.value as AccountConnectionInput['connectionMode'],
                          }))
                        }
                      >
                        <option value="direct">Direct CalDAV</option>
                        <option value="proxy">CalDAV via Proxy</option>
                      </select>
                      <input
                        value={connectionForm.label}
                        onChange={(event) =>
                          setConnectionForm((current) => ({ ...current, label: event.target.value }))
                        }
                        placeholder="Label"
                      />
                      <input
                        value={connectionForm.serverUrl}
                        onChange={(event) =>
                          setConnectionForm((current) => ({ ...current, serverUrl: event.target.value }))
                        }
                        placeholder="Server URL"
                      />
                      {connectionForm.connectionMode === 'proxy' && (
                        <input
                          value={connectionForm.proxyUrl}
                          onChange={(event) =>
                            setConnectionForm((current) => ({ ...current, proxyUrl: event.target.value }))
                          }
                          placeholder="Proxy URL (example: https://proxy.example.com or /dav)"
                        />
                      )}
                      <input
                        value={connectionForm.username}
                        onChange={(event) =>
                          setConnectionForm((current) => ({ ...current, username: event.target.value }))
                        }
                        placeholder="Username"
                      />
                      <input
                        type="password"
                        value={connectionForm.password}
                        onChange={(event) =>
                          setConnectionForm((current) => ({ ...current, password: event.target.value }))
                        }
                        placeholder="Password or token"
                      />
                      <button className="primary-button" onClick={() => void handleConnectAccount()} disabled={busy}>
                        Connect account
                      </button>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Auto-sync</h4>
                      </div>
                      <div className="settings-form split">
                        <label className="simple-row checkbox-row">
                          <div>
                            <strong>Enable periodic sync</strong>
                            <span>Sync on app open, when coming back online, and at the selected interval.</span>
                          </div>
                          <input
                            type="checkbox"
                            checked={snapshot.settings.autoSyncEnabled}
                            onChange={(event) => updateSettings({ autoSyncEnabled: event.target.checked })}
                          />
                        </label>
                        <select
                          value={String(snapshot.settings.autoSyncIntervalMinutes)}
                          onChange={(event) =>
                            updateSettings({
                              autoSyncIntervalMinutes: Number.parseInt(event.target.value, 10) || 15,
                            })
                          }
                          disabled={!snapshot.settings.autoSyncEnabled}
                        >
                          <option value="5">Every 5 minutes</option>
                          <option value="15">Every 15 minutes</option>
                          <option value="30">Every 30 minutes</option>
                          <option value="60">Every hour</option>
                        </select>
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Connection notes</h4>
                      </div>
                      <div className="stack-list">
                        <div className="simple-row">
                          <div>
                            <strong>Direct mode</strong>
                            <span>Use this for CalDAV servers that allow browser CORS access from this app.</span>
                          </div>
                        </div>
                        <div className="simple-row">
                          <div>
                            <strong>Proxy mode</strong>
                            <span>Use this for providers like Cirrux that support CalDAV, but block direct browser DAV requests.</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Local cache</h4>
                      </div>
                      <div className="simple-row">
                        <div>
                          <strong>Clear all local cache</strong>
                          <span>Removes IndexedDB and browser cache storage without touching the CalDAV server.</span>
                        </div>
                        <div className="row-control-group">
                          <button className="ghost-button danger" onClick={() => void handleClearLocalCache()} disabled={busy}>
                            Clear local cache
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Sync status</h4>
                      </div>
                      <div className="stack-list">
                        <div className="simple-row">
                          <div>
                            <strong>{activeAccount ? activeAccount.label : 'No active account'}</strong>
                            <span>
                              {activeAccount
                                ? activeAccount.lastError ?? syncLabel(activeAccount.lastSyncAt)
                                : 'Connect an account to start syncing.'}
                            </span>
                          </div>
                        </div>

                        {visibleSyncLogs.length === 0 ? (
                          <div className="simple-row">
                            <div>
                              <strong>No recent sync issues</strong>
                              <span>Only failures are stored here, so successful syncs do not fill up this history.</span>
                            </div>
                          </div>
                        ) : (
                          visibleSyncLogs.map((entry) => (
                            <div key={entry.id} className="simple-row">
                              <div>
                                <strong>{entry.source}</strong>
                                <span>
                                  {new Date(entry.createdAt).toLocaleString()}
                                  {entry.accountId
                                    ? ` · ${snapshot.accounts.find((account) => account.id === entry.accountId)?.label ?? 'Account'}`
                                    : ''}
                                </span>
                              </div>
                              <div>
                                <span>{entry.message}</span>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {settingsSection === 'structure' && (
                  <section className="settings-page-section">
                    <div className="settings-page-header">
                      <div>
                        <p>Window 2 of 2</p>
                        <h3>Nested lists</h3>
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Smart lists</h4>
                        <button
                          className="ghost-button"
                          onClick={() => {
                            setSmartDraftId(undefined)
                            setSmartDraftName('')
                            setSmartDraftDefinition('')
                            setSmartDraftOrdering(defaultSmartListOrdering())
                            setIsSmartEditorOpen(true)
                          }}
                        >
                          New smart list
                        </button>
                      </div>
                      <div className="stack-list">
                        {renderedSmartLists.map((smartList, index) => (
                          <div key={smartList.id}>
                            {settingsDragSession?.kind === 'smart' && settingsDropIndex === index && (
                              <div className="task-drop-slot settings-drop-slot" />
                            )}
                            <div
                              ref={(element) => {
                                const key = settingsRowKey('smart', smartList.id)
                                if (element) {
                                  settingsRowsRef.current.set(key, element)
                                } else {
                                  settingsRowsRef.current.delete(key)
                                }
                              }}
                              className={`simple-row ${settingsDragSession?.kind === 'smart' && settingsDragSession.itemId === smartList.id ? 'drag-source-hidden' : ''}`}
                            >
                              <div className="settings-row-title">
                                <span
                                  className="task-drag-handle settings-drag-handle"
                                  onPointerDown={(event) => handleSettingsDragStart(event, 'smart', smartList.id)}
                                >
                                  ::
                                </span>
                                <strong>{smartList.name}</strong>
                                <span className="inline-definition">{smartList.definition || 'No definition'}</span>
                              </div>
                              <div className="row-control-group">
                                <button className="ghost-button" onClick={() => editSmartList(smartList)}>
                                  Edit
                                </button>
                                <button className="ghost-button danger" onClick={() => void handleDeleteSmartList(smartList)}>
                                  Delete
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                        {settingsDragSession?.kind === 'smart' && settingsDropIndex === renderedSmartLists.length && (
                          <div className="task-drop-slot settings-drop-slot" />
                        )}

                        {orderedSmartLists.length === 0 && (
                          <div className="empty-state">
                            <strong>No smart lists yet.</strong>
                            <span>Create one to save a reusable query.</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Structure overview</h4>
                      </div>
                      <div className="structure-overview">
                        <div className="assign-row structure-row create-list-row">
                          <div className="settings-row-title">
                            <span className="task-drag-handle settings-drag-placeholder">+</span>
                            <input
                              value={listDraft.name}
                              onChange={(event) => setListDraft((current) => ({ ...current, name: event.target.value }))}
                              placeholder="New task list"
                            />
                          </div>
                          <div className="assign-actions">
                            <select
                              value={listDraft.parentId}
                              onChange={(event) =>
                                setListDraft((current) => ({ ...current, parentId: event.target.value }))
                              }
                            >
                              <option value="">Create at root</option>
                              {collectionTreeOptions.map((collectionOption) => (
                                <option key={collectionOption.id} value={collectionOption.id}>
                                  {collectionOption.label}
                                </option>
                              ))}
                            </select>
                            <button
                              className="ghost-button"
                              onClick={() => void handleCreateTaskList()}
                              disabled={!activeAccount || busy}
                            >
                              Add list
                            </button>
                          </div>
                        </div>

                        {renderSettingsCollectionList(undefined, 0)}

                        {collectionSections.roots.length === 0 && (
                          <div className="empty-state">
                            <strong>No task lists yet.</strong>
                            <span>Create one with the inline row above.</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                )}

              </div>
            </div>
          </section>
        ) : !isEditorMode ? (
          <section className="workspace-surface">
            <div className="list-header">
              <div>
                <h3>{currentViewTitle}</h3>
                <p>{visibleTasks.length} tasks</p>
              </div>
              {activeView?.kind === 'collection' && (
                <div className="row-control-group">
                  <button
                    className={`ghost-button ${collectionViewScope === 'self-and-descendants' ? 'active' : ''}`}
                    onClick={() => setCollectionViewScope('self-and-descendants')}
                  >
                    This list + sublists
                  </button>
                  <button
                    className={`ghost-button ${collectionViewScope === 'self' ? 'active' : ''}`}
                    onClick={() => setCollectionViewScope('self')}
                  >
                    This list only
                  </button>
                </div>
              )}
            </div>

            {visibleFilterTags.length > 0 && (
              <div className="view-tag-chips">
                {visibleFilterTags.map((tag) => (
                  <button
                    key={tag}
                    className={`tag-chip ${selectedViewTags.includes(tag) ? 'active' : ''}`}
                    onClick={() =>
                      setSelectedViewTags((current) =>
                        current.includes(tag) ? current.filter((entry) => entry !== tag) : [...current, tag],
                      )
                    }
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}

            <div className="quick-add-row">
              <button className="quick-add-trigger" onClick={() => handleQuickAdd()} disabled={!activeAccount}>
                +
              </button>
              <input
                value={quickAddTitle}
                onChange={(event) => setQuickAddTitle(event.target.value)}
                placeholder="Add task"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleQuickAdd()
                  }
                }}
              />
              <button className="ghost-button" onClick={() => beginNewTask(quickAddTitle.trim())} disabled={!activeAccount}>
                Open editor
              </button>
            </div>

            <div className="task-rows">
              {visibleTasks.length === 0 && (
                <div className="empty-state">
                  <strong>No tasks here yet.</strong>
                  <span>Create a task or change your current view.</span>
                </div>
              )}

              {renderedOpenTasks.map((task, index) => {
                const isAboveGap = dragSession && dropIndex === index + 1
                const isBelowGap = dragSession && dropIndex === index

                return (
                  <div key={task.id}>
                    {dragSession && dropIndex === index && <div className="task-drop-slot" />}
                    <div
                      className={`task-row-shell ${isAboveGap ? 'gap-neighbor-above' : ''} ${
                        isBelowGap ? 'gap-neighbor-below' : ''
                      }`}
                      ref={(element) => {
                        if (element) {
                          taskRowsRef.current.set(task.id, element)
                        } else {
                          taskRowsRef.current.delete(task.id)
                        }
                      }}
                    >
                      <div
                        className={`task-row ${task.id === selectedTaskId ? 'selected' : ''} ${
                          task.status === 'completed' ? 'done' : ''
                        } ${canManualReorderTasks && task.status !== 'completed' ? 'reorderable' : ''}`}
                        onClick={() => {
                          if (suppressTaskClickRef.current) {
                            suppressTaskClickRef.current = false
                            return
                          }
                          openTask(task.id)
                        }}
                      >
                        {canManualReorderTasks && task.status !== 'completed' && (
                          <span
                            className="task-drag-handle"
                            onPointerDown={(event) => {
                              event.stopPropagation()
                              handleTaskDragStart(event, task)
                            }}
                          >
                            ::
                          </span>
                        )}
                        <button
                          className={`task-check ${task.status === 'completed' ? 'checked' : ''}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleToggleTaskStatus(task)
                          }}
                        >
                          {task.status === 'completed' ? 'x' : ''}
                        </button>
                        <button className="task-main" onClick={(event) => event.preventDefault()}>
                          <span className="task-title">{task.title || 'Untitled task'}</span>
                          {task.tagIds.length > 0 && (
                            <span className="task-tag-row">
                              {task.tagIds.map((tag) => (
                                <span key={tag} className="task-inline-tag">
                                  {tag}
                                </span>
                              ))}
                            </span>
                          )}
                        </button>
                        <div className="task-side">
                          {task.priority > 0 && <span className={`priority-badge priority-${task.priority}`}>P{task.priority}</span>}
                          <span className="task-date">{displayDate(task.dueDate ?? task.startDate)}</span>
                          <span className="task-list-name" style={collectionColorStyle(taskCollections.find((collection) => collection.id === task.collectionId)?.color)}>
                            <span className="collection-color-dot subtle" />
                            {taskCollections.find((collection) => collection.id === task.collectionId)?.displayName}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}

              {dragSession && dropIndex === renderedOpenTasks.length && <div className="task-drop-slot" />}

              {renderedCompletedTasks.map((task) => (
                <div
                  key={task.id}
                  className="task-row-shell"
                  ref={(element) => {
                    if (element) {
                      taskRowsRef.current.set(task.id, element)
                    } else {
                      taskRowsRef.current.delete(task.id)
                    }
                  }}
                >
                  <div className={`task-row ${task.id === selectedTaskId ? 'selected' : ''} done`}>
                    <button
                      className={`task-check ${task.status === 'completed' ? 'checked' : ''}`}
                      onClick={() => void handleToggleTaskStatus(task)}
                    >
                      {task.status === 'completed' ? 'x' : ''}
                    </button>
                    <button className="task-main" onClick={() => openTask(task.id)}>
                      <span className="task-title">{task.title || 'Untitled task'}</span>
                      {task.tagIds.length > 0 && (
                        <span className="task-tag-row">
                          {task.tagIds.map((tag) => (
                            <span key={tag} className="task-inline-tag">
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                    <div className="task-side">
                      {task.priority > 0 && <span className={`priority-badge priority-${task.priority}`}>P{task.priority}</span>}
                      <span className="task-date">{displayDate(task.dueDate ?? task.startDate)}</span>
                      <span className="task-list-name" style={collectionColorStyle(taskCollections.find((collection) => collection.id === task.collectionId)?.color)}>
                        <span className="collection-color-dot subtle" />
                        {taskCollections.find((collection) => collection.id === task.collectionId)?.displayName}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {dragSession && draggedTask && (
              <div
                className="task-drag-preview"
                style={{
                  width: `${dragSession.width}px`,
                  top: `${dragSession.pointerY - dragSession.offsetY}px`,
                  left: `${dragSession.pointerX - dragSession.offsetX}px`,
                }}
              >
                <div className="task-row reorderable">
                  <span className="task-drag-handle">::</span>
                  <button className={`task-check ${draggedTask.status === 'completed' ? 'checked' : ''}`} tabIndex={-1}>
                    {draggedTask.status === 'completed' ? 'x' : ''}
                  </button>
                  <div className="task-main">
                    <span className="task-title">{draggedTask.title || 'Untitled task'}</span>
                    {draggedTask.tagIds.length > 0 && (
                      <span className="task-tag-row">
                        {draggedTask.tagIds.map((tag) => (
                          <span key={tag} className="task-inline-tag">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <div className="task-side">
                    {draggedTask.priority > 0 && <span className={`priority-badge priority-${draggedTask.priority}`}>P{draggedTask.priority}</span>}
                    <span className="task-date">{displayDate(draggedTask.dueDate ?? draggedTask.startDate)}</span>
                    <span className="task-list-name" style={collectionColorStyle(taskCollections.find((collection) => collection.id === draggedTask.collectionId)?.color)}>
                      <span className="collection-color-dot subtle" />
                      {taskCollections.find((collection) => collection.id === draggedTask.collectionId)?.displayName}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="workspace-surface editor-surface">
            <div className="editor-header">
              <button className="ghost-button" onClick={closeEditor}>
                Back
              </button>
              <div className="editor-header-actions">
                <button className="ghost-button danger" onClick={() => void handleDeleteTask()} disabled={!taskDraft.id}>
                  Delete
                </button>
                <button className="primary-button" onClick={() => void handleSaveTask()} disabled={!activeAccount || busy}>
                  Save task
                </button>
              </div>
            </div>

            <div className="editor-body">
              <input
                className="editor-title"
                value={taskDraft.title}
                onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Task name"
              />

              <section className="description-panel">
                <div className="description-header">
                  <div>
                    <strong>Description</strong>
                    <span>{descriptionMode === 'display' ? 'Markdown preview' : 'Markdown editor'}</span>
                  </div>
                  <button
                    className="ghost-button"
                    onClick={() =>
                      setDescriptionMode((current) =>
                        current === 'display' ? 'edit' : taskDraft.notes.trim() ? 'display' : 'edit',
                      )
                    }
                  >
                    {descriptionMode === 'display' ? 'Edit' : taskDraft.notes.trim() ? 'Done' : 'Preview'}
                  </button>
                </div>

                {descriptionMode === 'display' ? (
                  <div className="markdown-display" onClick={() => setDescriptionMode('edit')}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                      }}
                    >
                      {taskDraft.notes}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <textarea
                    className="editor-notes"
                    rows={taskDraft.notes.trim() ? 7 : 5}
                    value={taskDraft.notes}
                    onChange={(event) => setTaskDraft((current) => ({ ...current, notes: event.target.value }))}
                    placeholder="Write markdown notes, checklists, links, or code snippets"
                  />
                )}
              </section>

              <div className="editor-meta-block">
                <div className="editor-chipbar">
                  <div className="editor-chipfield wide">
                    <span>List</span>
                    <select
                      value={taskDraft.collectionId}
                      onChange={(event) =>
                        setTaskDraft((current) => ({ ...current, collectionId: event.target.value }))
                      }
                    >
                      <option value="">Choose a task list</option>
                      {orderedCollectionOptions.map((collection) => (
                        <option key={collection.id} value={collection.id}>
                          {collection.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="editor-chipfield">
                    <span>Status</span>
                    <select
                      value={taskDraft.status}
                      onChange={(event) =>
                        setTaskDraft((current) => ({ ...current, status: event.target.value as TaskStatus }))
                      }
                    >
                      {statuses.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="editor-chipfield">
                    <span>Priority</span>
                    <select
                      value={taskDraft.priority}
                      onChange={(event) =>
                        setTaskDraft((current) => ({
                          ...current,
                          priority: Number.parseInt(event.target.value || '0', 10),
                        }))
                      }
                    >
                      <option value="0">Normal</option>
                      <option value="1">P1</option>
                      <option value="2">P2</option>
                      <option value="3">P3</option>
                      <option value="4">P4</option>
                    </select>
                  </div>
                </div>

                <div className="editor-chipbar">
                  <div className="editor-chipfield">
                    <span>Start</span>
                    <div className="date-field-row">
                      <input
                        type={taskDraft.startDateIsAllDay ? 'date' : 'datetime-local'}
                        value={(taskDraft.startDateIsAllDay ? normalizeDateOnlyInput : normalizeDateInput)(taskDraft.startDate)}
                        onChange={(event) =>
                          setTaskDraft((current) => ({ ...current, startDate: event.target.value || undefined }))
                        }
                      />
                      <label className="checkbox-row compact subtle-all-day">
                        <input
                          type="checkbox"
                          checked={taskDraft.startDateIsAllDay ?? true}
                          onChange={(event) =>
                            setTaskDraft((current) => ({
                              ...current,
                              startDateIsAllDay: event.target.checked,
                              startDate:
                                current.startDate && event.target.checked
                                  ? normalizeDateOnlyInput(current.startDate)
                                  : current.startDate && !event.target.checked
                                    ? `${normalizeDateOnlyInput(current.startDate)}T09:00`
                                  : current.startDate,
                            }))
                          }
                        />
                        All-day
                      </label>
                    </div>
                  </div>
                  <div className="editor-chipfield">
                    <span>Due</span>
                    <div className="date-field-row">
                      <input
                        type={taskDraft.dueDateIsAllDay ? 'date' : 'datetime-local'}
                        value={(taskDraft.dueDateIsAllDay ? normalizeDateOnlyInput : normalizeDateInput)(taskDraft.dueDate)}
                        onChange={(event) =>
                          setTaskDraft((current) => ({ ...current, dueDate: event.target.value || undefined }))
                        }
                      />
                      <label className="checkbox-row compact subtle-all-day">
                        <input
                          type="checkbox"
                          checked={taskDraft.dueDateIsAllDay ?? true}
                          onChange={(event) =>
                            setTaskDraft((current) => ({
                              ...current,
                              dueDateIsAllDay: event.target.checked,
                              dueDate:
                                current.dueDate && event.target.checked
                                  ? normalizeDateOnlyInput(current.dueDate)
                                  : current.dueDate && !event.target.checked
                                    ? `${normalizeDateOnlyInput(current.dueDate)}T09:00`
                                  : current.dueDate,
                            }))
                          }
                        />
                        All-day
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="simple-row">
                <div>
                  <strong>Tags</strong>
                  <span>
                    Use hashtags directly in the title or description, for example `#work` or `#waiting`.
                    {availableTags.length > 0 ? ` Known tags: ${availableTags.slice(0, 6).join(', ')}` : ''}
                  </span>
                </div>
              </div>
            </div>
          </section>
        )}

        <footer className="status-bar">
          <span>{message}</span>
          {activeAccount && <span>{activeAccount.lastError ?? syncLabel(activeAccount.lastSyncAt)}</span>}
        </footer>

        {settingsDragSession && (draggedSettingsCollection || draggedSettingsSmartList) && (
          <div
            className="task-drag-preview settings-drag-preview"
            style={{
              width: `${settingsDragSession.width}px`,
              top: `${settingsDragSession.pointerY - settingsDragSession.offsetY}px`,
              left: `${settingsDragSession.pointerX - settingsDragSession.offsetX}px`,
            }}
          >
            <div className="simple-row settings-preview-row">
              <div className="settings-row-title">
                <span className="task-drag-handle settings-drag-handle">::</span>
                <strong>{draggedSettingsCollection?.displayName ?? draggedSettingsSmartList?.name}</strong>
                {draggedSettingsSmartList && <span className="inline-definition">{draggedSettingsSmartList.definition || 'No definition'}</span>}
              </div>
            </div>
          </div>
        )}
      </main>

      {isSmartEditorOpen && (
        <div className="modal-shell" role="dialog" aria-modal="true">
          <button className="modal-backdrop" onClick={() => setIsSmartEditorOpen(false)} />
          <div className="modal-card smart-card">
            <div className="modal-header">
              <div>
                <p>Smart list</p>
                <h3>{smartDraftId ? 'Edit filter' : 'Create filter'}</h3>
              </div>
              <button className="ghost-icon" onClick={() => setIsSmartEditorOpen(false)}>
                x
              </button>
            </div>

            <div className="settings-form">
              <input value={smartDraftName} onChange={(event) => setSmartDraftName(event.target.value)} placeholder="Name" />
              <input
                value={smartDraftDefinition}
                onChange={(event) => setSmartDraftDefinition(event.target.value)}
                placeholder='Example: #work & (due:next14 | start:today) & !status:completed'
              />
              <div className="simple-row">
                <div>
                  <strong>Supported syntax</strong>
                  <span>Use `&`, `|`, `!`, parentheses, `#tag`, `p1`-`p4`, `status:open`, `today`, `overdue`, `next7`, `next14`, `next30`, `start:today`, `due:overdue`, `end:next14`, `list:"Name"`, and `subtree:"Name"`.</span>
                </div>
              </div>
              <div className="settings-form split">
                <select
                  value={smartDraftOrdering.field}
                  onChange={(event) =>
                    setSmartDraftOrdering((current) => ({
                      ...current,
                      mode: 'property',
                      field: event.target.value as TaskOrderField,
                    }))
                  }
                >
                  {orderingFields.map((field) => (
                    <option key={field.value} value={field.value}>
                      {field.label}
                    </option>
                  ))}
                </select>
                <select
                  value={smartDraftOrdering.direction}
                  onChange={(event) =>
                    setSmartDraftOrdering((current) => ({
                      ...current,
                      mode: 'property',
                      direction: event.target.value as SortDirection,
                    }))
                  }
                >
                  {sortDirections.map((direction) => (
                    <option key={direction.value} value={direction.value}>
                      {direction.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="editor-header-actions">
                {smartDraftId && (
                  <button
                    className="ghost-button danger"
                    onClick={() => {
                      const smartList = activeSmartLists.find((entry) => entry.id === smartDraftId)
                      if (smartList) {
                        void handleDeleteSmartList(smartList)
                        setIsSmartEditorOpen(false)
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
                <button className="primary-button" onClick={() => void handleSaveSmartList()} disabled={!activeAccount}>
                  Save smart list
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
