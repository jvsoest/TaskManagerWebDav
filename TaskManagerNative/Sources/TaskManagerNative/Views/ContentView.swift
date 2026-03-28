import SwiftUI

// MARK: - Content View (Root)

public struct ContentView: View {
    @EnvironmentObject var state: AppState

    public init() {}

    public var body: some View {
        Group {
            if state.isOnboarding {
                OnboardingView()
            } else {
                mainInterface
            }
        }
        .alert("Error", isPresented: Binding(
            get: { state.globalError != nil },
            set: { if !$0 { state.globalError = nil } }
        )) {
            Button("OK") { state.globalError = nil }
        } message: {
            Text(state.globalError ?? "")
        }
    }

    @ViewBuilder
    private var mainInterface: some View {
        #if os(macOS)
        NavigationSplitView {
            SidebarView()
        } content: {
            TaskListView()
        } detail: {
            if let taskId = state.selectedTaskId,
               let task = state.tasks.first(where: { $0.id == taskId }) {
                TaskDetailView(task: task)
            } else {
                EmptyDetailView()
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    Task { await state.syncAll() }
                } label: {
                    Label("Sync", systemImage: state.isSyncing ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                }
                .disabled(state.isSyncing)
            }
            ToolbarItem(placement: .automatic) {
                Button { state.showSettings = true } label: {
                    Label("Settings", systemImage: "gear")
                }
            }
        }
        .sheet(isPresented: $state.showSettings) {
            SettingsView()
        }
        #else
        NavigationSplitView {
            SidebarView()
        } detail: {
            NavigationStack {
                TaskListView()
            }
        }
        .sheet(isPresented: $state.showAddAccount) {
            AddAccountView()
        }
        .sheet(isPresented: $state.showSettings) {
            SettingsView()
        }
        #endif
    }
}

// MARK: - Onboarding View

struct OnboardingView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.tint)
            Text("TaskManager")
                .font(.largeTitle.bold())
            Text("Connect to your CalDAV server to get started.\nYour tasks stay in sync with your calendar backend.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            Button("Add CalDAV Account") {
                state.showAddAccount = true
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            Spacer()
        }
        .frame(maxWidth: 420)
        .padding()
        .sheet(isPresented: $state.showAddAccount) {
            AddAccountView()
        }
    }
}

// MARK: - Empty Detail View

struct EmptyDetailView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("Select a task to view details")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
