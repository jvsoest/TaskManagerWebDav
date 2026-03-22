import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { createDefaultMetadata, defaultFilter, getSmartListCount, taskMatchesFilter } from './lib/filters'
import { clearLocalCache, loadSnapshot, saveSnapshot } from './lib/idb'
import { notifyDueTasks, requestNotifications } from './lib/notifications'
import {
  createTaskCollection,
  deleteTaskCollection,
  deleteSmartListRemote,
  deleteTaskRemote,
  discoverAccount,
  saveMetadataRemote,
  syncAccount,
  upsertSmartListRemote,
  upsertTaskRemote,
} from './lib/caldav'
import type {
  Account,
  AccountConnectionInput,
  AppSnapshot,
  FolderNode,
  MetadataDocument,
  SmartList,
  SyncLogEntry,
  TagNode,
  TaskFilter,
  TaskItem,
  TaskStatus,
} from './types'

type ActiveView =
  | { kind: 'all' }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'smart'; smartListId: string }

type WorkspaceMode = 'tasks' | 'settings'
type SettingsSection = 'accounts' | 'structure' | 'tags'

type TaskDraft = Omit<TaskItem, 'id' | 'uid' | 'createdAt' | 'updatedAt' | 'syncState'> & {
  id?: string
  uid?: string
}

const emptySnapshot: AppSnapshot = {
  accounts: [],
  collections: [],
  tasks: [],
  smartLists: [],
  metadataDocs: [],
  syncLogs: [],
}

const emptyConnection: AccountConnectionInput = {
  label: '',
  serverUrl: '',
  username: '',
  password: '',
}

const statuses: TaskStatus[] = ['needs-action', 'in-process', 'completed', 'cancelled']

function createDraft(collectionId?: string, accountId?: string): TaskDraft {
  return {
    accountId: accountId ?? '',
    collectionId: collectionId ?? '',
    title: '',
    notes: '',
    status: 'needs-action',
    priority: 1,
    tagIds: [],
  }
}

function newId(): string {
  return crypto.randomUUID()
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
    left.dueDate === right.dueDate &&
    left.completedAt === right.completedAt &&
    left.url === right.url &&
    left.etag === right.etag &&
    left.tagIds.length === right.tagIds.length &&
    left.tagIds.every((tagId, index) => tagId === right.tagIds[index])
  )
}

function moveInArray<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
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

function reorderSiblingNodes<T extends { id: string; parentId?: string }>(
  nodes: T[],
  nodeId: string,
  direction: 'up' | 'down',
): T[] {
  const node = nodes.find((entry) => entry.id === nodeId)
  if (!node) {
    return nodes
  }

  const siblingIds = nodes.filter((entry) => entry.parentId === node.parentId).map((entry) => entry.id)
  const currentIndex = siblingIds.indexOf(nodeId)
  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1

  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= siblingIds.length) {
    return nodes
  }

  const targetId = siblingIds[targetIndex]
  const fullFromIndex = nodes.findIndex((entry) => entry.id === nodeId)
  const fullToIndex = nodes.findIndex((entry) => entry.id === targetId)

  if (fullFromIndex < 0 || fullToIndex < 0) {
    return nodes
  }

  return moveInArray(nodes, fullFromIndex, fullToIndex)
}

function reorderCollectionIdsWithinFolder(
  collectionIds: string[],
  collectionFolders: Record<string, string | undefined>,
  collectionId: string,
  direction: 'up' | 'down',
): string[] {
  const folderId = collectionFolders[collectionId]
  const siblingIds = collectionIds.filter((id) => collectionFolders[id] === folderId)
  const currentIndex = siblingIds.indexOf(collectionId)
  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1

  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= siblingIds.length) {
    return collectionIds
  }

  const targetId = siblingIds[targetIndex]
  const fromIndex = collectionIds.indexOf(collectionId)
  const toIndex = collectionIds.indexOf(targetId)

  if (fromIndex < 0 || toIndex < 0) {
    return collectionIds
  }

  return moveInArray(collectionIds, fromIndex, toIndex)
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot)
  const [hydrated, setHydrated] = useState(false)
  const [activeAccountId, setActiveAccountId] = useState<string>()
  const [activeView, setActiveView] = useState<ActiveView>({ kind: 'all' })
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(createDraft())
  const [connectionForm, setConnectionForm] = useState<AccountConnectionInput>(emptyConnection)
  const [folderDraft, setFolderDraft] = useState({ name: '', parentId: '' })
  const [tagDraft, setTagDraft] = useState({ name: '', parentId: '' })
  const [listDraft, setListDraft] = useState({ name: '', folderId: '' })
  const [smartDraftId, setSmartDraftId] = useState<string>()
  const [smartDraftName, setSmartDraftName] = useState('')
  const [smartDraftFilter, setSmartDraftFilter] = useState<TaskFilter>(defaultFilter())
  const [searchText, setSearchText] = useState('')
  const [quickAddTitle, setQuickAddTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('Connect a CalDAV account to start syncing tasks.')
  const [isCreatingTask, setIsCreatingTask] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isSmartEditorOpen, setIsSmartEditorOpen] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([])
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('tasks')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('accounts')
  const deliveredRef = useRef<Set<string>>(new Set())
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
  const folderTreeOptions = useMemo(
    () => buildTreeOptions<FolderNode>(metadataDoc?.folderNodes ?? []),
    [metadataDoc?.folderNodes],
  )
  const tagTreeOptions = useMemo(
    () => buildTreeOptions<TagNode>(metadataDoc?.tagNodes ?? []),
    [metadataDoc?.tagNodes],
  )

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
        dueDate: selectedTask.dueDate,
        completedAt: selectedTask.completedAt,
        tagIds: selectedTask.tagIds,
        url: selectedTask.url,
        etag: selectedTask.etag,
      }

      setTaskDraft((current) => (sameTaskDraft(current, nextDraft) ? current : nextDraft))
      return
    }

    if (isCreatingTask) {
      return
    }

    const nextDraft = createDraft(defaultCollectionId, activeAccountId)
    setTaskDraft((current) => (sameTaskDraft(current, nextDraft) ? current : nextDraft))
  }, [activeAccountId, defaultCollectionId, isCreatingTask, selectedTaskId, snapshot.tasks])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const tasks = snapshot.tasks.filter((task) => task.accountId === activeAccountId)
      notifyDueTasks(tasks, deliveredRef.current)
    }, 60_000)

    return () => window.clearInterval(interval)
  }, [activeAccountId, snapshot.tasks])

  const visibleTasks = useMemo(() => {
    let tasks = activeTasks

    if (activeView.kind === 'collection') {
      tasks = tasks.filter((task) => task.collectionId === activeView.collectionId)
    }

    if (activeView.kind === 'smart') {
      const smartList = activeSmartLists.find((entry) => entry.id === activeView.smartListId)
      if (smartList && metadataDoc) {
        tasks = tasks.filter((task) =>
          taskMatchesFilter(task, smartList.filter, metadataDoc, taskCollections),
        )
      }
    }

    if (deferredSearch.trim() && metadataDoc) {
      const searchFilter = { ...defaultFilter(), query: deferredSearch }
      tasks = tasks.filter((task) => taskMatchesFilter(task, searchFilter, metadataDoc, taskCollections))
    }

    return [...tasks].sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'completed' ? 1 : -1
      }

      return (left.dueDate ?? left.startDate ?? '').localeCompare(right.dueDate ?? right.startDate ?? '')
    })
  }, [activeSmartLists, activeTasks, activeView, deferredSearch, metadataDoc, taskCollections])

  const folderNameById = new Map((metadataDoc?.folderNodes ?? []).map((entry) => [entry.id, entry.name]))
  const tagNameById = new Map((metadataDoc?.tagNodes ?? []).map((entry) => [entry.id, entry.name]))

  const folderSections = useMemo(() => {
    const folders = metadataDoc?.folderNodes ?? []
    const rootFolders = folders.filter((folder) => !folder.parentId)
    const folderChildren = new Map<string, typeof folders>()
    folders.forEach((folder) => {
      if (!folder.parentId) {
        return
      }

      const entries = folderChildren.get(folder.parentId) ?? []
      entries.push(folder)
      folderChildren.set(folder.parentId, entries)
    })

    const collectionsByFolder = new Map<string, typeof orderedTaskCollections>()
    const unfiled: typeof orderedTaskCollections = []
    orderedTaskCollections.forEach((collection) => {
      const folderId = metadataDoc?.collectionFolders[collection.id]
      if (!folderId) {
        unfiled.push(collection)
        return
      }

      const entries = collectionsByFolder.get(folderId) ?? []
      entries.push(collection)
      collectionsByFolder.set(folderId, entries)
    })

    return {
      rootFolders,
      folderChildren,
      collectionsByFolder,
      unfiled,
    }
  }, [metadataDoc, orderedTaskCollections])
  const orderedCollectionOptions = useMemo(() => {
    const options: Array<{ id: string; label: string }> = []

    function appendFolder(folderId: string, depth: number) {
      const directCollections = folderSections.collectionsByFolder.get(folderId) ?? []
      const childFolders = folderSections.folderChildren.get(folderId) ?? []

      directCollections.forEach((collection) => {
        options.push({
          id: collection.id,
          label: `${'↳ '.repeat(depth + 1)}${collection.displayName}`,
        })
      })

      childFolders.forEach((childFolder) => appendFolder(childFolder.id, depth + 1))
    }

    folderSections.unfiled.forEach((collection) => {
      options.push({
        id: collection.id,
        label: collection.displayName,
      })
    })

    folderSections.rootFolders.forEach((folder) => appendFolder(folder.id, 0))

    return options
  }, [folderSections])

  const currentViewTitle =
    activeView.kind === 'all'
      ? 'Today'
      : activeView.kind === 'collection'
        ? taskCollections.find((collection) => collection.id === activeView.collectionId)?.displayName ?? 'Task list'
        : activeSmartLists.find((smartList) => smartList.id === activeView.smartListId)?.name ?? 'Smart list'

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
  }

  function beginNewTask(prefill = '') {
    setWorkspaceMode('tasks')
    setSelectedTaskId(undefined)
    setIsCreatingTask(true)
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

  function recordSyncIssue(source: string, failure: string, accountId = activeAccountId) {
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
  }

  function toggleFolderCollapsed(folderId: string) {
    setCollapsedFolders((current) =>
      current.includes(folderId) ? current.filter((id) => id !== folderId) : [...current, folderId],
    )
  }

  async function handleConnectAccount() {
    if (!connectionForm.serverUrl || !connectionForm.username || !connectionForm.password) {
      setMessage('Server URL, username, and password are required.')
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
      setActiveView({ kind: 'all' })
      setConnectionForm(emptyConnection)

      await handleSyncAccount(account, discovery.collections, true)
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
    collections = activeCollections,
    isFirstSync = false,
  ) {
    if (!account) {
      return
    }

    setBusy(true)
    setMessage(`Syncing ${account.label}...`)
    updateAccount(account.id, { syncState: 'syncing', lastError: undefined })

    try {
      const result = await syncAccount(account, collections)
      const nextAccount: Account = {
        ...account,
        syncState: 'synced',
        lastSyncAt: new Date().toISOString(),
        lastError: undefined,
      }

      replaceSnapshot({
        accounts: [...snapshot.accounts.filter((entry) => entry.id !== account.id), nextAccount],
        collections: [...snapshot.collections.filter((entry) => entry.accountId !== account.id), ...result.collections],
        tasks: [...snapshot.tasks.filter((entry) => entry.accountId !== account.id), ...result.tasks],
        smartLists: [
          ...snapshot.smartLists.filter((entry) => entry.accountId !== account.id),
          ...result.smartLists,
        ],
        metadataDocs: [
          ...snapshot.metadataDocs.filter((entry) => entry.accountId !== account.id),
          result.metadataDoc,
        ],
        syncLogs: snapshot.syncLogs,
      })
      setMessage(isFirstSync ? 'Account connected and synced.' : `${account.label} is up to date.`)
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Sync failed.'
      updateAccount(account.id, { syncState: 'error', lastError: failure })
      recordSyncIssue('Account sync', failure, account.id)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveTask() {
    if (!activeAccount || !metadataDoc || taskCollections.length === 0) {
      setMessage('Connect an account with at least one task list before saving tasks.')
      return
    }

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
      dueDate: taskDraft.dueDate,
      completedAt: taskDraft.status === 'completed' ? taskDraft.completedAt ?? now : undefined,
      createdAt: snapshot.tasks.find((task) => task.id === taskDraft.id)?.createdAt ?? now,
      updatedAt: now,
      tagIds: taskDraft.tagIds,
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
      const remote = await upsertTaskRemote(activeAccount, targetCollection, nextTask, metadataDoc)
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          { ...nextTask, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
      }))
      closeEditor()
      setMessage('Task saved to CalDAV.')
    } catch (error) {
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          { ...nextTask, syncState: 'error' },
        ],
      }))
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
      const remote = await upsertTaskRemote(activeAccount, targetCollection, updatedTask, metadataDoc)
      replaceSnapshot({
        ...snapshot,
        tasks: [
          ...snapshot.tasks.filter((entry) => entry.id !== task.id),
          { ...updatedTask, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
      })
    } catch (error) {
      replaceSnapshot({
        ...snapshot,
        tasks: [...snapshot.tasks.filter((entry) => entry.id !== task.id), { ...task, syncState: 'error' }],
      })
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
      setMessage('Task deleted from CalDAV.')
    } catch (error) {
      replaceSnapshot({
        ...snapshot,
        tasks: [...snapshot.tasks, { ...existing, syncState: 'error' }],
      })
      const failure = error instanceof Error ? error.message : 'Task delete failed.'
      recordSyncIssue('Task delete', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  async function saveMetadata(doc: MetadataDocument, successMessage: string) {
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
  }

  async function handleAddFolder() {
    if (!metadataDoc || !activeAccountId || !folderDraft.name.trim()) {
      return
    }

    await saveMetadata(
      {
        ...metadataDoc,
        folderNodes: [
          ...metadataDoc.folderNodes,
          {
            id: newId(),
            accountId: activeAccountId,
            name: folderDraft.name.trim(),
            parentId: folderDraft.parentId || undefined,
          },
        ],
        updatedAt: new Date().toISOString(),
      },
      'Folder saved.',
    )
    setFolderDraft({ name: '', parentId: '' })
  }

  async function handleAddTag() {
    if (!metadataDoc || !activeAccountId || !tagDraft.name.trim()) {
      return
    }

    await saveMetadata(
      {
        ...metadataDoc,
        tagNodes: [
          ...metadataDoc.tagNodes,
          {
            id: newId(),
            accountId: activeAccountId,
            name: tagDraft.name.trim(),
            parentId: tagDraft.parentId || undefined,
          },
        ],
        updatedAt: new Date().toISOString(),
      },
      'Tag saved.',
    )
    setTagDraft({ name: '', parentId: '' })
  }

  async function handleAssignCollectionFolder(collectionId: string, folderId?: string) {
    if (!metadataDoc) {
      return
    }

    await saveMetadata(
      {
        ...metadataDoc,
        collectionFolders: {
          ...metadataDoc.collectionFolders,
          [collectionId]: folderId || undefined,
        },
        collectionOrder: [...metadataDoc.collectionOrder],
        updatedAt: new Date().toISOString(),
      },
      'List moved.',
    )
  }

  async function handleReorderFolder(folderId: string, direction: 'up' | 'down') {
    if (!metadataDoc) {
      return
    }

    const nextMetadataDoc: MetadataDocument = {
      ...metadataDoc,
      folderNodes: reorderSiblingNodes(metadataDoc.folderNodes, folderId, direction),
      updatedAt: new Date().toISOString(),
    }

    await saveMetadata(nextMetadataDoc, 'Folder order updated.')
  }

  async function handleReorderTag(tagId: string, direction: 'up' | 'down') {
    if (!metadataDoc) {
      return
    }

    const nextMetadataDoc: MetadataDocument = {
      ...metadataDoc,
      tagNodes: reorderSiblingNodes(metadataDoc.tagNodes, tagId, direction),
      updatedAt: new Date().toISOString(),
    }

    await saveMetadata(nextMetadataDoc, 'Tag order updated.')
  }

  async function handleReorderTaskList(collectionId: string, direction: 'up' | 'down') {
    if (!metadataDoc) {
      return
    }

    const nextMetadataDoc: MetadataDocument = {
      ...metadataDoc,
      collectionOrder: reorderCollectionIdsWithinFolder(
        orderedCollectionIds,
        metadataDoc.collectionFolders,
        collectionId,
        direction,
      ),
      updatedAt: new Date().toISOString(),
    }

    await saveMetadata(nextMetadataDoc, 'Task list order updated.')
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
            collectionFolders: Object.fromEntries(
              Object.entries(metadataDoc.collectionFolders).filter(([key]) => key !== collectionId),
            ),
            collectionOrder: metadataDoc.collectionOrder.filter((id) => id !== collectionId),
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

      if (activeView.kind === 'collection' && activeView.collectionId === collectionId) {
        setActiveView({ kind: 'all' })
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

  async function handleDeleteFolder(folderId: string) {
    if (!metadataDoc) {
      return
    }

    const descendantIds = new Set<string>([folderId])
    let changed = true
    while (changed) {
      changed = false
      metadataDoc.folderNodes.forEach((folder) => {
        if (folder.parentId && descendantIds.has(folder.parentId) && !descendantIds.has(folder.id)) {
          descendantIds.add(folder.id)
          changed = true
        }
      })
    }

    const nextMetadataDoc: MetadataDocument = {
      ...metadataDoc,
      folderNodes: metadataDoc.folderNodes.filter((folder) => !descendantIds.has(folder.id)),
      collectionFolders: Object.fromEntries(
        Object.entries(metadataDoc.collectionFolders).map(([collectionId, mappedFolderId]) => [
          collectionId,
          mappedFolderId && descendantIds.has(mappedFolderId) ? undefined : mappedFolderId,
        ]),
      ),
      updatedAt: new Date().toISOString(),
    }

    setCollapsedFolders((current) => current.filter((id) => !descendantIds.has(id)))
    await saveMetadata(nextMetadataDoc, 'Folder deleted.')
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

      if (metadataDoc && listDraft.folderId) {
        await saveMetadata(
          {
            ...metadataDoc,
            collectionFolders: {
              ...metadataDoc.collectionFolders,
              [newCollection.id]: listDraft.folderId,
            },
            updatedAt: new Date().toISOString(),
          },
          'Task list created.',
        )
      } else {
        setMessage('Task list created.')
      }

      setListDraft({ name: '', folderId: '' })
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Task list creation failed.'
      recordSyncIssue('Task list creation', failure, activeAccount.id)
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveSmartList() {
    if (!activeAccount || !smartCollection || !metadataDoc || !smartDraftName.trim()) {
      return
    }

    const nextSmartList: SmartList = {
      id: smartDraftId ?? newId(),
      accountId: activeAccount.id,
      name: smartDraftName.trim(),
      filter: smartDraftFilter,
      syncState: 'syncing',
      updatedAt: new Date().toISOString(),
    }

    replaceSnapshot({
      ...snapshot,
      smartLists: [...snapshot.smartLists.filter((entry) => entry.id !== nextSmartList.id), nextSmartList],
    })

    try {
      const remote = await upsertSmartListRemote(activeAccount, smartCollection, nextSmartList, metadataDoc)
      replaceSnapshot({
        ...snapshot,
        smartLists: [
          ...snapshot.smartLists.filter((entry) => entry.id !== nextSmartList.id),
          { ...nextSmartList, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
      })
      setMessage('Smart list saved.')
      setSmartDraftId(undefined)
      setSmartDraftName('')
      setSmartDraftFilter(defaultFilter())
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
      setMessage('Smart list deleted.')
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
      setActiveView({ kind: 'all' })
      setSelectedTaskId(undefined)
      setTaskDraft(createDraft())
      setIsCreatingTask(false)
      setSmartDraftId(undefined)
      setSmartDraftName('')
      setSmartDraftFilter(defaultFilter())
      setSearchText('')
      setQuickAddTitle('')
      setCollapsedFolders([])
      setConnectionForm(emptyConnection)
      setFolderDraft({ name: '', parentId: '' })
      setTagDraft({ name: '', parentId: '' })
      setListDraft({ name: '', folderId: '' })
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

    const targetCollection = taskCollections[0]
    const now = new Date().toISOString()
    const nextTask: TaskItem = {
      id: newId(),
      uid: newId().replace(/-/g, ''),
      accountId: activeAccount.id,
      collectionId: targetCollection.id,
      title: quickAddTitle.trim(),
      notes: '',
      status: 'needs-action',
      priority: 1,
      tagIds: [],
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
      const remote = await upsertTaskRemote(activeAccount, targetCollection, nextTask, metadataDoc)
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          { ...nextTask, url: remote.url, etag: remote.etag, syncState: 'synced' },
        ],
      }))
      setMessage('Task added.')
    } catch (error) {
      replaceSnapshotWith((current) => ({
        ...current,
        tasks: [
          ...current.tasks.filter((task) => task.id !== nextTask.id),
          { ...nextTask, syncState: 'error' },
        ],
      }))
      const failure = error instanceof Error ? error.message : 'Quick add failed.'
      recordSyncIssue('Quick add', failure, activeAccount.id)
      setMessage(failure)
    }
  }

  function editSmartList(smartList: SmartList) {
    setSmartDraftId(smartList.id)
    setSmartDraftName(smartList.name)
    setSmartDraftFilter(smartList.filter)
    setIsSmartEditorOpen(true)
  }

  function renderFolderTree(folderId: string, depth = 0): React.JSX.Element | null {
    const folder = (metadataDoc?.folderNodes ?? []).find((entry) => entry.id === folderId)
    if (!folder) {
      return null
    }

    const isCollapsed = collapsedFolders.includes(folder.id)
    const directCollections = folderSections.collectionsByFolder.get(folder.id) ?? []
    const childFolders = folderSections.folderChildren.get(folder.id) ?? []

    return (
      <div key={folder.id} className="sidebar-folder">
        <button
          className={`sidebar-folder-toggle depth-${Math.min(depth, 3)}`}
          onClick={() => toggleFolderCollapsed(folder.id)}
        >
          <span>{isCollapsed ? '>' : 'v'}</span>
          <strong>{folder.name}</strong>
        </button>

        {!isCollapsed && (
          <>
            {directCollections.map((collection) => (
              <button
                key={collection.id}
                className={`sidebar-link nested depth-${Math.min(depth, 3)} ${
                  activeView.kind === 'collection' && activeView.collectionId === collection.id ? 'active' : ''
                }`}
                onClick={() => {
                  setActiveView({ kind: 'collection', collectionId: collection.id })
                  setIsSidebarOpen(false)
                }}
              >
                <span>{collection.displayName}</span>
                <strong>{activeTasks.filter((task) => task.collectionId === collection.id).length}</strong>
              </button>
            ))}
            {childFolders.map((childFolder) => renderFolderTree(childFolder.id, depth + 1))}
          </>
        )}
      </div>
    )
  }

  function renderSettingsCollectionRow(collection: (typeof orderedTaskCollections)[number], depth: number) {
    return (
      <div key={collection.id} className={`assign-row structure-row depth-${Math.min(depth, 3)}`}>
        <span>{collection.displayName}</span>
        <div className="assign-actions">
          <select
            value={metadataDoc?.collectionFolders[collection.id] ?? ''}
            onChange={(event) =>
              void handleAssignCollectionFolder(collection.id, event.target.value || undefined)
            }
          >
            <option value="">Unfiled</option>
            {folderTreeOptions.map((folderOption) => (
              <option key={folderOption.id} value={folderOption.id}>
                {folderOption.label}
              </option>
            ))}
          </select>
          <button className="ghost-button" onClick={() => void handleReorderTaskList(collection.id, 'up')}>
            Up
          </button>
          <button className="ghost-button" onClick={() => void handleReorderTaskList(collection.id, 'down')}>
            Down
          </button>
          <button className="ghost-button danger" onClick={() => void handleDeleteTaskList(collection.id)}>
            Delete
          </button>
        </div>
      </div>
    )
  }

  function renderSettingsFolderTree(folderId: string, depth = 0): React.JSX.Element | null {
    const folder = (metadataDoc?.folderNodes ?? []).find((entry) => entry.id === folderId)
    if (!folder) {
      return null
    }

    const directCollections = folderSections.collectionsByFolder.get(folder.id) ?? []
    const childFolders = folderSections.folderChildren.get(folder.id) ?? []

    return (
      <div key={folder.id} className="structure-branch">
        <div className={`simple-row structure-row depth-${Math.min(depth, 3)}`}>
          <div>
            <strong>{folder.name}</strong>
            <span>{folder.parentId ? `inside ${folderNameById.get(folder.parentId)}` : 'root'}</span>
          </div>
          <div className="row-control-group">
            <button className="ghost-button" onClick={() => void handleReorderFolder(folder.id, 'up')}>
              Up
            </button>
            <button className="ghost-button" onClick={() => void handleReorderFolder(folder.id, 'down')}>
              Down
            </button>
            <button className="ghost-button danger" onClick={() => void handleDeleteFolder(folder.id)}>
              Delete
            </button>
          </div>
        </div>

        <div className="structure-children">
          {directCollections.map((collection) => renderSettingsCollectionRow(collection, depth + 1))}
          {childFolders.map((childFolder) => renderSettingsFolderTree(childFolder.id, depth + 1))}
        </div>
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
          <button
            className={`sidebar-link ${activeView.kind === 'all' ? 'active' : ''}`}
            onClick={() => {
              setActiveView({ kind: 'all' })
              setIsSidebarOpen(false)
            }}
          >
            <span>All tasks</span>
            <strong>{activeTasks.length}</strong>
          </button>

          <div className="sidebar-group">
            <div className="sidebar-group-title">
              <span>Lists</span>
              <button className="ghost-inline" onClick={() => openSettings('structure')}>
                Manage
              </button>
            </div>

            {folderSections.unfiled.map((collection) => (
              <button
                key={collection.id}
                className={`sidebar-link ${
                  activeView.kind === 'collection' && activeView.collectionId === collection.id ? 'active' : ''
                }`}
                onClick={() => {
                  setActiveView({ kind: 'collection', collectionId: collection.id })
                  setIsSidebarOpen(false)
                }}
              >
                <span>{collection.displayName}</span>
                <strong>{activeTasks.filter((task) => task.collectionId === collection.id).length}</strong>
              </button>
            ))}

            {folderSections.rootFolders.map((folder) => renderFolderTree(folder.id))}
          </div>

          <div className="sidebar-group">
            <div className="sidebar-group-title">
              <span>Smart lists</span>
              <button
                className="ghost-inline"
                onClick={() => {
                  setSmartDraftId(undefined)
                  setSmartDraftName('')
                  setSmartDraftFilter(defaultFilter())
                  setIsSmartEditorOpen(true)
                }}
              >
                New
              </button>
            </div>
            {activeSmartLists.map((smartList) => (
              <div key={smartList.id} className="sidebar-smart-row">
                <button
                  className={`sidebar-link ${
                    activeView.kind === 'smart' && activeView.smartListId === smartList.id ? 'active' : ''
                  }`}
                  onClick={() => {
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
        </nav>

        <div className="sidebar-footer">
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
              <button className="ghost-button" onClick={() => setIsSmartEditorOpen(true)} disabled={!activeAccount}>
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
                  <strong>Folders and lists</strong>
                  <span>Hierarchy and ordering</span>
                </button>
                <button
                  className={`settings-nav-button ${settingsSection === 'tags' ? 'active' : ''}`}
                  onClick={() => setSettingsSection('tags')}
                >
                  <strong>Tags</strong>
                  <span>Nested tag structure</span>
                </button>
              </aside>

              <div className="settings-panel">
                {settingsSection === 'accounts' && (
                  <section className="settings-page-section">
                    <div className="settings-page-header">
                      <div>
                        <p>Window 1 of 3</p>
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
                        <p>Window 2 of 3</p>
                        <h3>Folders and task lists</h3>
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Create list</h4>
                      </div>
                      <div className="settings-form split">
                        <input
                          value={listDraft.name}
                          onChange={(event) => setListDraft((current) => ({ ...current, name: event.target.value }))}
                          placeholder="New task list"
                        />
                        <select
                          value={listDraft.folderId}
                          onChange={(event) =>
                            setListDraft((current) => ({ ...current, folderId: event.target.value }))
                          }
                        >
                          <option value="">Create as unfiled</option>
                          {folderTreeOptions.map((folderOption) => (
                            <option key={folderOption.id} value={folderOption.id}>
                              {folderOption.label}
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

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Create folder</h4>
                      </div>
                      <div className="settings-form split">
                        <input
                          value={folderDraft.name}
                          onChange={(event) => setFolderDraft((current) => ({ ...current, name: event.target.value }))}
                          placeholder="New folder"
                        />
                        <select
                          value={folderDraft.parentId}
                          onChange={(event) =>
                            setFolderDraft((current) => ({ ...current, parentId: event.target.value }))
                          }
                        >
                          <option value="">Root</option>
                          {folderTreeOptions.map((folderOption) => (
                            <option key={folderOption.id} value={folderOption.id}>
                              {folderOption.label}
                            </option>
                          ))}
                        </select>
                        <button className="ghost-button" onClick={() => void handleAddFolder()} disabled={!activeAccount}>
                          Add folder
                        </button>
                      </div>
                    </div>

                    <div className="settings-block">
                      <div className="section-title-row">
                        <h4>Structure overview</h4>
                      </div>
                      <div className="structure-overview">
                        {folderSections.unfiled.length > 0 && (
                          <div className="structure-group">
                            <div className="structure-group-label">Unfiled</div>
                            <div className="structure-children">
                              {folderSections.unfiled.map((collection) => renderSettingsCollectionRow(collection, 1))}
                            </div>
                          </div>
                        )}

                        {folderSections.rootFolders.map((folder) => renderSettingsFolderTree(folder.id))}

                        {folderSections.unfiled.length === 0 && folderSections.rootFolders.length === 0 && (
                          <div className="empty-state">
                            <strong>No folders or task lists yet.</strong>
                            <span>Create a folder or add a task list above.</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {settingsSection === 'tags' && (
                  <section className="settings-page-section">
                    <div className="settings-page-header">
                      <div>
                        <p>Window 3 of 3</p>
                        <h3>Tags</h3>
                      </div>
                    </div>

                    <div className="stack-list">
                      {tagTreeOptions.map((tagOption) => (
                        <div key={tagOption.id} className="simple-row">
                          <div>
                            <strong>{`${tagOption.depth > 0 ? `${'↳ '.repeat(tagOption.depth)}` : ''}#${tagOption.node.name}`}</strong>
                            <span>{tagOption.node.parentId ? `inside #${tagNameById.get(tagOption.node.parentId)}` : 'root'}</span>
                          </div>
                          <div className="row-control-group">
                            <button className="ghost-button" onClick={() => void handleReorderTag(tagOption.id, 'up')}>
                              Up
                            </button>
                            <button className="ghost-button" onClick={() => void handleReorderTag(tagOption.id, 'down')}>
                              Down
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="settings-form split">
                      <input
                        value={tagDraft.name}
                        onChange={(event) => setTagDraft((current) => ({ ...current, name: event.target.value }))}
                        placeholder="New tag"
                      />
                      <select
                        value={tagDraft.parentId}
                        onChange={(event) => setTagDraft((current) => ({ ...current, parentId: event.target.value }))}
                      >
                        <option value="">Root</option>
                        {tagTreeOptions.map((tagOption) => (
                          <option key={tagOption.id} value={tagOption.id}>
                            {`${tagOption.depth > 0 ? `${'↳ '.repeat(tagOption.depth)}` : ''}#${tagOption.node.name}`}
                          </option>
                        ))}
                      </select>
                      <button className="ghost-button" onClick={() => void handleAddTag()} disabled={!activeAccount}>
                        Add tag
                      </button>
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
            </div>

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

              {visibleTasks.map((task) => (
                <div
                  key={task.id}
                  className={`task-row ${task.id === selectedTaskId ? 'selected' : ''} ${task.status === 'completed' ? 'done' : ''}`}
                >
                  <button
                    className={`task-check ${task.status === 'completed' ? 'checked' : ''}`}
                    onClick={() => void handleToggleTaskStatus(task)}
                  >
                    {task.status === 'completed' ? 'x' : ''}
                  </button>
                  <button className="task-main" onClick={() => openTask(task.id)}>
                    <span className="task-title">{task.title || 'Untitled task'}</span>
                    <span className="task-subline">
                      {task.notes || 'No description'}
                    </span>
                  </button>
                  <div className="task-side">
                    <span className={`priority-badge priority-${task.priority}`}>P{task.priority || 0}</span>
                    <span className="task-date">{displayDate(task.dueDate ?? task.startDate)}</span>
                    <span className="task-list-name">
                      {taskCollections.find((collection) => collection.id === task.collectionId)?.displayName}
                    </span>
                  </div>
                </div>
              ))}
            </div>
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

              <textarea
                className="editor-notes"
                rows={8}
                value={taskDraft.notes}
                onChange={(event) => setTaskDraft((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Description"
              />

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
                    <input
                      type="number"
                      min="0"
                      max="4"
                      value={taskDraft.priority}
                      onChange={(event) =>
                        setTaskDraft((current) => ({
                          ...current,
                          priority: Number.parseInt(event.target.value || '0', 10),
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="editor-chipbar">
                  <div className="editor-chipfield">
                    <span>Start</span>
                    <input
                      type="datetime-local"
                      value={normalizeDateInput(taskDraft.startDate)}
                      onChange={(event) =>
                        setTaskDraft((current) => ({ ...current, startDate: event.target.value || undefined }))
                      }
                    />
                  </div>
                  <div className="editor-chipfield">
                    <span>Due</span>
                    <input
                      type="datetime-local"
                      value={normalizeDateInput(taskDraft.dueDate)}
                      onChange={(event) =>
                        setTaskDraft((current) => ({ ...current, dueDate: event.target.value || undefined }))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="chip-field">
                <span>Tags</span>
                <div className="tag-grid">
                  {tagTreeOptions.map((tagOption) => (
                    <label
                      key={tagOption.id}
                      className={`tag-toggle ${taskDraft.tagIds.includes(tagOption.id) ? 'active' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={taskDraft.tagIds.includes(tagOption.id)}
                        onChange={(event) =>
                          setTaskDraft((current) => ({
                            ...current,
                            tagIds: event.target.checked
                              ? [...current.tagIds, tagOption.id]
                              : current.tagIds.filter((entry) => entry !== tagOption.id),
                          }))
                        }
                      />
                      <span>{`${tagOption.depth > 0 ? `${'↳ '.repeat(tagOption.depth)}` : ''}#${tagOption.node.name}`}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        <footer className="status-bar">
          <span>{message}</span>
          {activeAccount && <span>{activeAccount.lastError ?? syncLabel(activeAccount.lastSyncAt)}</span>}
        </footer>
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
                value={smartDraftFilter.query}
                onChange={(event) =>
                  setSmartDraftFilter((current) => ({ ...current, query: event.target.value }))
                }
                placeholder="Search query"
              />
              <div className="settings-form split">
                <select
                  value={smartDraftFilter.statuses[0] ?? ''}
                  onChange={(event) =>
                    setSmartDraftFilter((current) => ({
                      ...current,
                      statuses: event.target.value ? [event.target.value as TaskStatus] : [],
                    }))
                  }
                >
                  <option value="">Any status</option>
                  {statuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <select
                  value={smartDraftFilter.tagIds[0] ?? ''}
                  onChange={(event) =>
                    setSmartDraftFilter((current) => ({
                      ...current,
                      tagIds: event.target.value ? [event.target.value] : [],
                    }))
                  }
                >
                  <option value="">Any tag</option>
                  {tagTreeOptions.map((tagOption) => (
                    <option key={tagOption.id} value={tagOption.id}>
                      {`${tagOption.depth > 0 ? `${'↳ '.repeat(tagOption.depth)}` : ''}#${tagOption.node.name}`}
                    </option>
                  ))}
                </select>
                <select
                  value={smartDraftFilter.folderIds[0] ?? ''}
                  onChange={(event) =>
                    setSmartDraftFilter((current) => ({
                      ...current,
                      folderIds: event.target.value ? [event.target.value] : [],
                    }))
                  }
                >
                  <option value="">Any folder</option>
                  {folderTreeOptions.map((folderOption) => (
                    <option key={folderOption.id} value={folderOption.id}>
                      {folderOption.label}
                    </option>
                  ))}
                </select>
              </div>
              <select
                value={smartDraftFilter.datePreset}
                onChange={(event) =>
                  setSmartDraftFilter((current) => ({
                    ...current,
                    datePreset: event.target.value as TaskFilter['datePreset'],
                  }))
                }
              >
                <option value="any">Any date</option>
                <option value="overdue">Overdue</option>
                <option value="today">Today</option>
                <option value="next7">Next 7 days</option>
                <option value="custom">Custom range</option>
              </select>
              {smartDraftFilter.datePreset === 'custom' && (
                <div className="settings-form split">
                  <input
                    type="date"
                    value={smartDraftFilter.customFrom ?? ''}
                    onChange={(event) =>
                      setSmartDraftFilter((current) => ({ ...current, customFrom: event.target.value }))
                    }
                  />
                  <input
                    type="date"
                    value={smartDraftFilter.customTo ?? ''}
                    onChange={(event) =>
                      setSmartDraftFilter((current) => ({ ...current, customTo: event.target.value }))
                    }
                  />
                </div>
              )}
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
