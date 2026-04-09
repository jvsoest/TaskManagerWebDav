import type { Account, AppSnapshot, SmartList, TaskItem, TaskMutation } from '../types'
import { normalizeManualTaskOrder, normalizeTaskIdentity } from './task-ids'

const DB_NAME = 'taskmanager-webdav'
const DB_VERSION = 3
const FALLBACK_STORAGE_KEY = 'taskmanager-webdav-fallback'

const STORES = ['accounts', 'collections', 'tasks', 'smartLists', 'metadataDocs', 'syncLogs', 'settings', 'queuedMutations'] as const

let openPromise: Promise<IDBDatabase> | undefined

function canUseFallbackStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function normalizeSnapshot(snapshot: AppSnapshot): AppSnapshot {
  return {
    accounts: snapshot.accounts.map((account) => ({
      ...account,
    })),
    collections: snapshot.collections,
    tasks: snapshot.tasks.map(normalizeTask),
    smartLists: snapshot.smartLists.map(normalizeSmartList),
    metadataDocs: snapshot.metadataDocs.map((doc) => ({
      ...doc,
      manualTaskOrder: normalizeManualTaskOrder(doc.manualTaskOrder ?? {}),
    })),
    syncLogs: snapshot.syncLogs,
    settings: snapshot.settings
      ? {
          autoSyncEnabled: snapshot.settings.autoSyncEnabled ?? true,
          autoSyncIntervalMinutes: snapshot.settings.autoSyncIntervalMinutes ?? 15,
        }
      : {
          autoSyncEnabled: true,
          autoSyncIntervalMinutes: 15,
        },
    queuedMutations: snapshot.queuedMutations.map(normalizeQueuedMutation),
  }
}

function loadFallbackSnapshot(): AppSnapshot | undefined {
  if (!canUseFallbackStorage()) {
    return undefined
  }

  const raw = window.localStorage.getItem(FALLBACK_STORAGE_KEY)
  if (!raw) {
    return undefined
  }

  try {
    return normalizeSnapshot(JSON.parse(raw) as AppSnapshot)
  } catch {
    window.localStorage.removeItem(FALLBACK_STORAGE_KEY)
    return undefined
  }
}

function saveFallbackSnapshot(snapshot: AppSnapshot) {
  if (!canUseFallbackStorage()) {
    return
  }

  try {
    window.localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Ignore localStorage failures and rely on IndexedDB when available.
  }
}

function normalizeTask(task: TaskItem): TaskItem {
  return normalizeTaskIdentity({
    ...task,
    reminders: Array.isArray(task.reminders) ? task.reminders : [],
    unsupportedReminderBlocks: Array.isArray(task.unsupportedReminderBlocks)
      ? task.unsupportedReminderBlocks
      : [],
    tagIds: Array.isArray(task.tagIds) ? task.tagIds : [],
    startDateIsAllDay: task.startDateIsAllDay ?? true,
    dueDateIsAllDay: task.dueDateIsAllDay ?? true,
  })
}

function normalizeSmartList(smartList: SmartList): SmartList {
  return {
    ...smartList,
    showCompleted: smartList.showCompleted === true,
  }
}

function normalizeQueuedMutation(mutation: TaskMutation): TaskMutation {
  return {
    ...mutation,
    task: normalizeTask(mutation.task),
  }
}

function openDb(): Promise<IDBDatabase> {
  if (openPromise) {
    return openPromise
  }

  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains('accounts')) {
        database.createObjectStore('accounts', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('collections')) {
        database.createObjectStore('collections', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('tasks')) {
        database.createObjectStore('tasks', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('smartLists')) {
        database.createObjectStore('smartLists', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('metadataDocs')) {
        database.createObjectStore('metadataDocs', { keyPath: 'accountId' })
      }
      if (!database.objectStoreNames.contains('syncLogs')) {
        database.createObjectStore('syncLogs', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains('queuedMutations')) {
        database.createObjectStore('queuedMutations', { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return openPromise
}

function wrapRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function wrapTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  try {
    const db = await openDb()
    const [accounts, collections, tasks, smartLists, metadataDocs, syncLogs, settings, queuedMutations] = await Promise.all(
      STORES.map((storeName) =>
        wrapRequest(db.transaction(storeName, 'readonly').objectStore(storeName).getAll()),
      ),
    )

    const snapshot = normalizeSnapshot({
      accounts: accounts as Account[],
      collections: collections as AppSnapshot['collections'],
      tasks: tasks as TaskItem[],
      smartLists: smartLists as SmartList[],
      metadataDocs: metadataDocs as AppSnapshot['metadataDocs'],
      syncLogs: syncLogs as AppSnapshot['syncLogs'],
      settings: (settings as Array<{ id: string; autoSyncEnabled?: boolean; autoSyncIntervalMinutes?: number }>)[0]
        ? {
            autoSyncEnabled: (settings as Array<{ id: string; autoSyncEnabled?: boolean; autoSyncIntervalMinutes?: number }>)[0]
              .autoSyncEnabled ?? true,
            autoSyncIntervalMinutes: (settings as Array<{ id: string; autoSyncEnabled?: boolean; autoSyncIntervalMinutes?: number }>)[0]
              .autoSyncIntervalMinutes ?? 15,
          }
        : {
            autoSyncEnabled: true,
            autoSyncIntervalMinutes: 15,
          },
      queuedMutations: queuedMutations as TaskMutation[],
    })

    const isEmpty =
      snapshot.accounts.length === 0 &&
      snapshot.collections.length === 0 &&
      snapshot.tasks.length === 0 &&
      snapshot.smartLists.length === 0 &&
      snapshot.metadataDocs.length === 0 &&
      snapshot.syncLogs.length === 0 &&
      snapshot.queuedMutations.length === 0

    return isEmpty ? loadFallbackSnapshot() ?? snapshot : snapshot
  } catch {
    return loadFallbackSnapshot() ?? {
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
  }
}

type SaveSnapshotOptions = {
  stripAccountPasswords?: boolean
}

function snapshotForPersistence(snapshot: AppSnapshot, options: SaveSnapshotOptions): AppSnapshot {
  if (!options.stripAccountPasswords) {
    return snapshot
  }

  return {
    ...snapshot,
    accounts: snapshot.accounts.map((account) => ({
      ...account,
      password: '',
    })),
  }
}

export async function saveSnapshot(snapshot: AppSnapshot, options: SaveSnapshotOptions = {}): Promise<void> {
  const persistedSnapshot = snapshotForPersistence(snapshot, options)
  saveFallbackSnapshot(persistedSnapshot)

  const db = await openDb()
  const transaction = db.transaction(STORES, 'readwrite')
  const accounts = transaction.objectStore('accounts')
  const collections = transaction.objectStore('collections')
  const tasks = transaction.objectStore('tasks')
  const smartLists = transaction.objectStore('smartLists')
  const metadataDocs = transaction.objectStore('metadataDocs')
  const syncLogs = transaction.objectStore('syncLogs')
  const settings = transaction.objectStore('settings')
  const queuedMutations = transaction.objectStore('queuedMutations')

  accounts.clear()
  collections.clear()
  tasks.clear()
  smartLists.clear()
  metadataDocs.clear()
  syncLogs.clear()
  settings.clear()
  queuedMutations.clear()

  persistedSnapshot.accounts.forEach((entry) => accounts.put(entry))
  persistedSnapshot.collections.forEach((entry) => collections.put(entry))
  persistedSnapshot.tasks.forEach((entry) => tasks.put(entry))
  persistedSnapshot.smartLists.forEach((entry) => smartLists.put(entry))
  persistedSnapshot.metadataDocs.forEach((entry) => metadataDocs.put(entry))
  persistedSnapshot.syncLogs.forEach((entry) => syncLogs.put(entry))
  settings.put({ id: 'app', ...persistedSnapshot.settings })
  persistedSnapshot.queuedMutations.forEach((entry) => queuedMutations.put(entry))

  await wrapTransaction(transaction)
}

export async function clearLocalCache(): Promise<void> {
  if (canUseFallbackStorage()) {
    try {
      window.localStorage.removeItem(FALLBACK_STORAGE_KEY)
    } catch {
      // Ignore localStorage failures during cache clear.
    }
  }

  if (openPromise) {
    const db = await openPromise
    db.close()
    openPromise = undefined
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB delete was blocked by another open tab.'))
  })
}
