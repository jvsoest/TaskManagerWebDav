import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('taskManagerDesktop', {
  isDesktop: true,
  getAccountPassword: (accountId) => ipcRenderer.invoke('desktop:credentials:get', accountId),
  setAccountPassword: (accountId, password) => ipcRenderer.invoke('desktop:credentials:set', accountId, password),
  deleteAccountPassword: (accountId) => ipcRenderer.invoke('desktop:credentials:delete', accountId),
})
