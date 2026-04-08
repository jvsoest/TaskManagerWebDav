# TaskManagerWebDav

TaskManagerWebDav is a CalDAV-first task manager with one integrated runtime. The same Node application serves the React UI and exposes the CalDAV backend on the same origin, so the browser app, installed PWA, Docker deployment, and Electron desktop app all use the same backend contract.

## Runtime model

- UI is served by the integrated app server
- CalDAV requests go through same-origin `POST /dav`
- backend health/readiness is exposed at `GET /api/health`
- the browser app no longer supports direct CalDAV or an external proxy URL

## Features

- Multiple CalDAV accounts
- Hidden CalDAV task lists for metadata and saved smart lists
- Smart lists, favorites, reminders, offline queueing, and local IndexedDB caching
- Installable PWA shell for self-hosted deployments
- Electron desktop packaging for Windows, macOS, and Linux

## Development

Install dependencies:

```bash
npm install
```

Run the frontend dev server:

```bash
npm run dev
```

Build the integrated app:

```bash
npm run build
```

Run the integrated app server locally:

```bash
npm run start
```

That serves:

- UI at `http://localhost:8080/`
- backend health at `http://localhost:8080/api/health`
- CalDAV backend transport at `http://localhost:8080/dav`

## Account setup

Accounts now use:

- Label
- Server URL
- Username
- Password or app password

There is no frontend connection mode switch and no proxy URL field. The app always uses the integrated backend.

### Cirrux

Cirrux documents CalDAV/Reminders setup with:

- Server: `https://api.cirrux.co/`
- Username: your full email address
- Password: your app password

Source: https://www.cirrux.co/help/setup

## Combined container deployment

This repository ships a combined image that serves both the built UI and the CalDAV backend from one origin.

- Dockerfile: [`Dockerfile`](/home/jsoest/Repositories/TaskManagerWebDav/Dockerfile)
- Container workflow: [`.github/workflows/publish-container.yml`](/home/jsoest/Repositories/TaskManagerWebDav/.github/workflows/publish-container.yml)

Build locally:

```bash
docker build -t taskmanagerwebdav .
```

Run locally:

```bash
docker run --rm -p 8080:8080 -e UPSTREAM_ALLOWLIST=api.cirrux.co,localhost taskmanagerwebdav
```

## Desktop app

The same integrated app can be packaged as an Electron desktop app.

Run locally:

```bash
npm run desktop:dev
```

Create packaged desktop artifacts:

```bash
npm run desktop:dist
```

GitHub Actions desktop packaging workflow:

- [`.github/workflows/publish-desktop.yml`](/home/jsoest/Repositories/TaskManagerWebDav/.github/workflows/publish-desktop.yml)

Package targets:

- Windows: NSIS installer and portable executable
- macOS: DMG
- Linux: AppImage and `.deb`

## Local CalDAV test server

This repository includes a Docker Compose CalDAV server based on Radicale for local testing.

```bash
docker compose up -d
```

Test account:

- URL: `http://localhost:5232/`
- Username: `test`
- Password: `test`

## Task ID migration

The app uses collection-scoped task ids instead of plain CalDAV `UID`s. If your server has the same `UID` in multiple lists, run the one-off metadata migration script before using the updated app heavily:

```bash
set -a && source .env && set +a
npm run migrate:task-ids
```

## Notes

- The app expects CalDAV servers to support standard `PROPFIND`, `REPORT`, `PUT`, `DELETE`, and `MKCALENDAR` operations.
- The integrated backend does not persist credentials; it forwards DAV requests from the app runtime to the upstream server.
- PWA offline shell behavior still depends on the service worker caching the built UI first.
