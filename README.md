# TaskManagerWebDav

TaskManagerWebDav is a CalDAV-first task manager PWA built with React, TypeScript, and Vite. It connects directly to CalDAV servers from the browser, discovers `VTODO` collections, syncs tasks into IndexedDB, and provides app-managed folders, nested tags, and smart lists.

## Features

- Multiple CalDAV accounts
- Direct browser-side discovery of `VTODO` task lists
- Hidden CalDAV task lists for metadata and saved smart lists
- Nested folders and nested tags
- Smart list builder with stored filters
- IndexedDB caching for offline read access
- Web Notifications reminders while the PWA is active
- Installable manifest and basic service worker shell caching

## Development

```bash
npm install
npm run dev
```

## Local CalDAV Test Server

This repository includes a Docker Compose CalDAV server based on Radicale for local testing.

```bash
docker compose up -d
```

Test account:

- URL: `http://localhost:5232/`
- Username: `test`
- Password: `test`

Notes:

- The exposed test endpoint on `http://localhost:5232/` is an nginx proxy that adds browser-safe CORS headers in front of Radicale.
- The app will create its hidden metadata and smart-list collections on first connect.
- Persistent CalDAV data is stored in `docker-data/radicale/`, which is ignored by Git.

## Notes

- The app expects CalDAV servers to support browser CORS access, HTTPS, and standard `PROPFIND`, `REPORT`, `PUT`, `DELETE`, and `MKCALENDAR` operations.
- Credentials are stored locally in IndexedDB for direct browser sync.
- Background reminders depend on browser and PWA support, especially on iOS, so notification delivery is intentionally best effort.
