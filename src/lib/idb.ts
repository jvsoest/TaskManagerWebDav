import type { AppSnapshot } from '../types'

const DB_NAME = 'taskmanager-webdav'
const DB_VERSION = 2

const STORES = ['accounts', 'collections', 'tasks', 'smartLists', 'metadataDocs', 'syncLogs'] as const

let openPromise: Promise<IDBDatabase> | undefined

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
  const db = await openDb()
  const [accounts, collections, tasks, smartLists, metadataDocs, syncLogs] = await Promise.all(
    STORES.map((storeName) =>
      wrapRequest(db.transaction(storeName, 'readonly').objectStore(storeName).getAll()),
    ),
  )

  return {
    accounts,
    collections,
    tasks,
    smartLists,
    metadataDocs,
    syncLogs,
  }
}

export async function saveSnapshot(snapshot: AppSnapshot): Promise<void> {
  const db = await openDb()
  const transaction = db.transaction(STORES, 'readwrite')
  const accounts = transaction.objectStore('accounts')
  const collections = transaction.objectStore('collections')
  const tasks = transaction.objectStore('tasks')
  const smartLists = transaction.objectStore('smartLists')
  const metadataDocs = transaction.objectStore('metadataDocs')
  const syncLogs = transaction.objectStore('syncLogs')

  accounts.clear()
  collections.clear()
  tasks.clear()
  smartLists.clear()
  metadataDocs.clear()
  syncLogs.clear()

  snapshot.accounts.forEach((entry) => accounts.put(entry))
  snapshot.collections.forEach((entry) => collections.put(entry))
  snapshot.tasks.forEach((entry) => tasks.put(entry))
  snapshot.smartLists.forEach((entry) => smartLists.put(entry))
  snapshot.metadataDocs.forEach((entry) => metadataDocs.put(entry))
  snapshot.syncLogs.forEach((entry) => syncLogs.put(entry))

  await wrapTransaction(transaction)
}

export async function clearLocalCache(): Promise<void> {
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
