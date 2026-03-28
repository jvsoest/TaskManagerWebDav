import SwiftUI

// MARK: - App Entry Point

@main
struct TaskManagerApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
        }
        #if os(macOS)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Sync All") {
                    Task { @MainActor in await appState.syncAll() }
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    appState.showSettings = true
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }
        #endif
    }
}
