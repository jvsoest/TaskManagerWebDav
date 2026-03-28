# TaskManagerNative

A native macOS and iOS task manager built with Swift and SwiftUI. Connects directly to CalDAV servers — no CORS proxy needed.

## Architecture

```
TaskManagerNative/
├── Package.swift
└── Sources/TaskManagerNative/
    ├── App/
    │   └── TaskManagerApp.swift          # @main SwiftUI App entry point
    ├── Models/
    │   └── Models.swift                  # All data types (Account, TaskItem, SmartList, …)
    ├── Networking/
    │   ├── CalDAVClient.swift            # URLSession-based CalDAV HTTP client
    │   ├── ICalendarParser.swift         # RFC 5545 VTODO parser
    │   └── ICalendarSerializer.swift     # RFC 5545 VTODO serializer
    ├── Storage/
    │   └── PersistenceController.swift   # JSON file persistence (Application Support)
    ├── Services/
    │   ├── SyncService.swift             # CalDAV sync orchestration
    │   ├── FilterService.swift           # Task filtering & sorting
    │   └── NotificationService.swift     # UNUserNotificationCenter reminders
    └── Views/
        ├── AppState.swift                # @MainActor ObservableObject central state
        ├── ContentView.swift             # Root NavigationSplitView
        ├── SidebarView.swift             # Accounts, collections, smart lists sidebar
        ├── TaskListView.swift            # Task list with search & swipe actions
        ├── TaskDetailView.swift          # Read-only task detail panel
        ├── TaskEditView.swift            # Create / edit task form
        ├── AddAccountView.swift          # Add CalDAV account form
        ├── SmartListBuilderView.swift    # Smart list filter builder
        └── SettingsView.swift            # Settings, accounts, tags, sync log
```

## Features

- **Native macOS & iOS** — built with SwiftUI, no web view wrapper
- **Direct CalDAV** — no CORS proxy required; native `URLSession` speaks directly to any CalDAV server
- **Multiple accounts** — connect to as many CalDAV servers as you like
- **VTODO sync** — full PROPFIND / REPORT / PUT / DELETE / MKCALENDAR support
- **Nested folders** — organise lists into a hierarchy stored in app metadata
- **Nested tags** — hashtag-style tags with parent/child relationships
- **Smart lists** — save complex filters (status, date range, tags, collections) as named views
- **Offline queue** — mutations are queued when offline and flushed on next sync
- **Local notifications** — reminders via `UNUserNotificationCenter` (relative and absolute)
- **JSON persistence** — app state stored in Application Support as JSON
- **Auto-sync** — configurable background sync timer

## Building

### Requirements

- Xcode 15 or later
- macOS 14 / iOS 17 deployment target

### macOS (via Swift Package Manager)

```bash
cd TaskManagerNative
swift build -c release
```

### iOS / macOS (via Xcode)

1. Open Xcode
2. Choose **File → Open** and select the `TaskManagerNative` folder
3. Xcode will detect the `Package.swift` and open it as a package
4. For an iOS or macOS *app bundle*, create a new Xcode project:
   - **File → New → Project → App**
   - Name it `TaskManagerNative`
   - Delete the auto-generated Swift files
   - Add all files from `Sources/TaskManagerNative/` to the project
5. Set the deployment target to macOS 14 / iOS 17
6. Add `UserNotifications.framework` to the target

### Entitlements (iOS / macOS)

The app requires these entitlements:

```xml
<key>com.apple.security.network.client</key>
<true/>
```

For macOS sandboxed apps, also add:

```xml
<key>com.apple.security.files.user-selected.read-write</key>
<true/>
```

## CalDAV Compatibility

The native app talks directly to any CalDAV server using standard operations:

| Operation | Purpose |
|-----------|---------|
| `PROPFIND` (Depth: 0) | Discover home set / principal |
| `PROPFIND` (Depth: 1) | List calendar collections |
| `REPORT calendar-query` | Fetch all VTODO resources |
| `REPORT sync-collection` | Incremental sync (if supported) |
| `PUT` | Create or update a VTODO |
| `DELETE` | Remove a VTODO or collection |
| `MKCALENDAR` | Create a new task list |
| `PROPPATCH` | Rename a collection or update color |

### Tested providers

- **Radicale** — works in direct mode
- **Cirrux** — works in direct mode (no CORS issue in native apps)
- **Any RFC 4791-compliant server** — should work

## Data Model

Tasks are stored as `VTODO` components in iCalendar format. App-specific metadata (folder structure, tags, manual ordering) is stored in a hidden `taskmanager-meta` calendar collection. Smart list definitions are stored in a hidden `taskmanager-smart` collection, both as VTODO notes with JSON payloads.
