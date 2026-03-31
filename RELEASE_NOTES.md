# Release Notes

## 2026-03-31

### Offline handling
- Added faster offline detection so retryable network failures and request timeouts move task saves, edits, and deletes into the local queue much sooner.
- Added light connectivity checks on app open, focus, visibility return, reconnect, and a periodic interval so the app notices offline and online state changes faster.
- Added request timeouts to CalDAV/proxy DAV requests to avoid long hangs before queueing local updates.

### Sidebar favorites
- Added a new `Favorites` section at the top of the sidebar for both smart lists and regular lists.
- Favorites are now stored in the hidden TaskManager metadata collection and keep their own manual favorite order.
- Added favorite toggles in settings for smart lists and regular lists, plus drag-based ordering inside the Favorites settings block.

### Energy use
- Reduced background energy use by throttling connectivity probes instead of polling every minute while already online.
- Replaced the fixed one-minute notification scan with a next-due scheduler so reminder checks only wake up when relevant.
- Reduced sidebar CPU churn by precomputing list and smart-list counts instead of recalculating them inline on every render.
- Fixed an idle render loop that could keep a CPU core busy at rest by repeatedly rewriting unchanged task-selection state.

## 2026-03-30

### Sync correctness
- Fixed task identity so the app now scopes task ids by list/collection instead of treating CalDAV `UID` as globally unique.
- This prevents tasks in one list, such as `Inbox`, from being overwritten in the app when another list contains the same `UID`.
- Updated task save and move flows so cross-list moves delete the old remote copy instead of creating duplicate task records.

### Migration
- Added a one-off external migration script to rewrite legacy `manualTaskOrder` entries in the hidden TaskManager metadata collection to the new collection-scoped task-id format.
- Documented the migration flow in the README, including a dry-run option before writing changes to the CalDAV server.

## 2026-03-29

### Task list presentation
- Overdue due dates in task rows now render in red.
- Regular task-list views now move tasks with a start or due date into a collapsed `Planned` section.
- Fixed iPhone task-row overflow by truncating long task titles and keeping date/list metadata inside the task card.
- New sublists now inherit the color of their parent list when created.
- Smart lists can now filter by completion date with `completed:today`, `completed:last7`, and `completed:last30`, and can sort by completion date.
- Smart lists using completion-date filters now automatically show completed tasks, and fall back to `LAST-MODIFIED` when providers like Cirrux strip the standard `COMPLETED` timestamp.
- Added system-driven dark mode support based on the OS/browser color-scheme preference.
- Improved dark-mode readability in the sidebar sync/account area and the settings account/list selectors, and toned down overly bright white surfaces there.
- Dark mode now also tones down the task-list container and the task-editor description panel/markdown surfaces.

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
- Improved keyboard shortcut reliability on Windows/Edge by matching physical keys more robustly, allowing bracket navigation on layouts that use `AltGr`, and making `Escape` close the task editor consistently.

### Task interaction and reminders
- Completed the markdown description preview with sanitized GitHub-flavored markdown rendering, including raw HTML sanitization and broader styling coverage.
- Added CalDAV reminder support with multiple task reminders, `VALARM` parsing/serialization, and reminder-driven browser notifications.
- Added multi-select task actions for complete, delete, and move.
- Added support for dragging tasks onto sidebar lists to move them between lists.
- Changed visible tag chips so they reflect only the tasks currently visible in the active list or smart list.
- Fixed editing existing tasks after the reminder feature shipped by normalizing older cached tasks and queued mutations that did not yet contain reminder fields.
- Fixed the Safari-sensitive clear-cache/reconnect flow by preserving reconnect settings, unregistering service workers during a full local reset, and reloading back into the account screen with proxy settings restored.
- Fixed first-time reconnect after a cache reset so a successful account login now switches back into the task workspace instead of leaving the user stranded in settings.
- Fixed a stale-state race during first sync after reconnecting so newly connected accounts are not overwritten out of local state on Safari-sensitive timings.
- Hardened Safari/iOS reconnects further by making snapshot updates immediate and keeping a local fallback snapshot when IndexedDB is unavailable right after a cache reset.
- Added build metadata to the settings page, including the build date/time and the current git commit hash.

### Verification
- `npm run build`
- `npm run lint`
