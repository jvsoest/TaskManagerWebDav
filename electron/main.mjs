import { app, BrowserWindow, dialog } from 'electron'
import { startTaskManagerServer } from '../proxy/server.mjs'

let mainWindow
let serverHandle
let quitting = false

async function ensureServerStarted() {
  if (serverHandle) {
    return serverHandle
  }

  serverHandle = await startTaskManagerServer({
    host: '127.0.0.1',
    port: 0,
  })

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
      sandbox: true,
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
