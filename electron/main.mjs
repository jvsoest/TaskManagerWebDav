import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { startTaskManagerServer } from '../proxy/server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_HOST = '127.0.0.1'
const DESKTOP_PORT = 51880
const CREDENTIALS_FILE_NAME = 'desktop-credentials.json'

let mainWindow
let serverHandle
let quitting = false

function credentialsFilePath() {
  return path.join(app.getPath('userData'), CREDENTIALS_FILE_NAME)
}

async function readCredentialStore() {
  try {
    const raw = await fs.readFile(credentialsFilePath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeCredentialStore(store) {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(credentialsFilePath(), JSON.stringify(store), 'utf8')
}

function encodePassword(password) {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      mode: 'safeStorage',
      value: safeStorage.encryptString(password).toString('base64'),
    }
  }

  return {
    mode: 'plain',
    value: password,
  }
}

function decodePassword(entry) {
  if (!entry) {
    return null
  }

  if (entry.mode === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
    } catch {
      return null
    }
  }

  if (entry.mode === 'plain') {
    return entry.value
  }

  return null
}

async function registerCredentialHandlers() {
  ipcMain.handle('desktop:credentials:get', async (_event, accountId) => {
    const store = await readCredentialStore()
    return decodePassword(store[accountId])
  })
  ipcMain.handle('desktop:credentials:set', async (_event, accountId, password) => {
    const store = await readCredentialStore()
    store[accountId] = encodePassword(password)
    await writeCredentialStore(store)
    return true
  })
  ipcMain.handle('desktop:credentials:delete', async (_event, accountId) => {
    const store = await readCredentialStore()
    delete store[accountId]
    await writeCredentialStore(store)
    return true
  })
}

async function waitForHealth(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${url}/api/health`, { cache: 'no-store' })
      if (response.ok) {
        return
      }
    } catch {
      // Server is not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error('The integrated backend did not become ready in time.')
}

async function ensureServerStarted() {
  if (serverHandle) {
    return serverHandle
  }

  serverHandle = await startTaskManagerServer({
    host: DESKTOP_HOST,
    port: DESKTOP_PORT,
  })
  await waitForHealth(serverHandle.url)

  return serverHandle
}

async function createMainWindow() {
  const { url } = await ensureServerStarted()

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f7f4ee',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  })

  await mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

async function shutdownServer() {
  if (!serverHandle) {
    return
  }

  const handle = serverHandle
  serverHandle = undefined
  await handle.close()
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void app.quit()
  }
})

app.on('before-quit', (event) => {
  if (quitting) {
    return
  }

  event.preventDefault()
  quitting = true
  void shutdownServer().finally(() => {
    app.quit()
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow()
  }
})

app.whenReady()
  .then(async () => {
    await registerCredentialHandlers()
    await createMainWindow()
  })
  .catch(async (error) => {
    await dialog.showErrorBox(
      'TaskManagerWebDav failed to start',
      error instanceof Error ? error.message : String(error),
    )
    await shutdownServer().catch(() => {})
    app.exit(1)
  })
