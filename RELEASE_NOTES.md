# Release Notes

## 2026-03-25

### Sync and offline reliability
- Added automatic sync on app startup.
- Added periodic auto-sync with a configurable interval in settings.
- Added immediate sync when the browser comes back online.
- Added a persisted local task-mutation queue so offline task creates, edits, and deletes are replayed after reconnecting.
- Preserved proxy-mode compatibility for queued task replay.
- Improved offline task saves so retryable network/proxy failures are treated as queued local saves, the editor returns to the list view, and sync replay picks those entries up correctly.

### Smart lists and data integrity
- Fixed smart-list editing so saving an existing smart list updates it in place instead of creating duplicates.
- Changed app startup so it opens the first smart list by order, and falls back to the first normal list only when no smart lists exist.
- Completed tasks are now hidden by default in both regular lists and smart lists, with a per-view `Show completed` toggle in list settings and smart-list configuration.

### Mobile and navigation
- Moved `Sync` and `Settings` actions into the sidebar footer so they stay reachable on phones.
- Selecting a list or smart list now returns from settings to the task view on mobile.
- Moved `Back to tasks` from the settings header into the sidebar footer so it stays visible on narrow mobile screens.
- Removed the redundant top-bar action buttons and made the top bar the single location for the current list title and task-creation `+` button.
- Fixed phone task-row metadata alignment so the project/list name aligns correctly.

### Sidebar and settings
- Added auto-sync controls to the settings page.
- Made the sidebar navigation scroll independently when many lists are present.

### Task creation and editor flow
- Removed the inline quick-add row and the sidebar add-task button.
- Added a single `+` action next to the current list or smart-list title to open the task editor.
- The task editor now autofocuses the title field, and pressing `Enter` in the title saves the task and returns to the list view.
- New tasks now default to the currently selected regular list, or to the first regular list in UI order when the current view is a smart list.

### Keyboard shortcuts
- Added `q` for new task creation, `ArrowUp` / `ArrowDown` for task-list navigation, `Enter` to open the selected task, and `Space` to toggle completion.
- Added `Ctrl/Cmd+S` to save from the task editor and `/` to focus search.
- Added keyboard navigation between smart lists and lists with `g l` for a searchable quick switcher and `[` / `]` for previous/next view navigation in sidebar order.

### Verification
- `npm run build`
- `npm run lint`
