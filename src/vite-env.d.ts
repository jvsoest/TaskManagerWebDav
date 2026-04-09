/// <reference types="vite/client" />

declare const __BUILD_TIMESTAMP__: string
declare const __BUILD_COMMIT__: string

interface TaskManagerDesktopBridge {
  isDesktop: boolean
  getAccountPassword(accountId: string): Promise<string | null>
  setAccountPassword(accountId: string, password: string): Promise<boolean>
  deleteAccountPassword(accountId: string): Promise<boolean>
}

interface Window {
  taskManagerDesktop?: TaskManagerDesktopBridge
}
