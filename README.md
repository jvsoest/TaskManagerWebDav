# TaskManagerWebDav

TaskManagerWebDav is a CalDAV-first task manager PWA built with React, TypeScript, and Vite. It connects to CalDAV servers either directly from the browser or through an optional standalone proxy, discovers `VTODO` collections, syncs tasks into IndexedDB, and provides app-managed folders, nested tags, and smart lists.

## Features

- Multiple CalDAV accounts
- Direct browser-side discovery of `VTODO` task lists
- Optional standalone CalDAV proxy mode for CORS-restricted providers
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

## CalDAV Connection Modes

- `Direct CalDAV`: use this for providers that allow browser CORS access from your app origin
- `CalDAV via Proxy`: use this for providers that support CalDAV for native clients, but block browser DAV requests

### Cirrux

Cirrux documents CalDAV/Reminders setup with:

- Server: `api.cirrux.co`
- Username: your full email address
- Password: your app password

Source: https://www.cirrux.co/help/setup

Direct browser mode is expected to fail against Cirrux because the CalDAV endpoint does not allow this app origin for browser DAV preflights. Use Proxy mode instead.

## Standalone Proxy

This repository includes a small standalone CalDAV proxy in [`proxy/server.mjs`](/home/jsoest/Repositories/TaskManagerWebDav/proxy/server.mjs). It is intended for providers like Cirrux that support CalDAV, but do not permit direct browser DAV access.

Run it locally:

```bash
ALLOWED_ORIGINS=http://localhost:5173 npm run proxy
```

Optional environment variables:

- `PORT`: proxy port, defaults to `8787`
- `ALLOWED_ORIGINS`: comma-separated frontend origins allowed to call the proxy
- `UPSTREAM_ALLOWLIST`: comma-separated upstream hosts allowed through the proxy, for example `api.cirrux.co,localhost`

In the app:

1. Choose `CalDAV via Proxy`
2. Set the CalDAV server URL, for example `https://api.cirrux.co/`
3. Set the proxy base URL, for example `http://localhost:8787/`
4. Enter the CalDAV username and password or app password

The proxy does not persist credentials. It only forwards the incoming DAV request upstream and returns the response to the browser with browser-safe CORS headers.

### Proxy Auth Test

You can test a provider through the proxy without opening the app UI:

```bash
CALDAV_USERNAME='you@example.com' \
CALDAV_PASSWORD='your-app-password' \
SERVER_URL='https://api.cirrux.co/' \
PROXY_URL='http://localhost:8787/' \
npm run proxy:test-auth
```

This probes both the root DAV URL and the `/caldav/` path through the proxy and prints the upstream status and response body preview.

## Cirrux Cleanup Script

There is also a destructive Cirrux helper at [`scripts/clear-cirrux-calendars.sh`](/home/jsoest/Repositories/TaskManagerWebDav/scripts/clear-cirrux-calendars.sh).

Dry run first:

```bash
./scripts/clear-cirrux-calendars.sh --dry-run
```

Delete all discovered calendars/reminder collections:

```bash
./scripts/clear-cirrux-calendars.sh
```

Skip the interactive confirmation only if you are sure:

```bash
./scripts/clear-cirrux-calendars.sh --yes
```

There is also a non-destructive verification helper for Cirrux list/folder behavior:

```bash
./scripts/test-cirrux-lists-folders.sh
```

That script:
- discovers the Cirrux home set from `.env`
- creates and deletes a temporary VTODO list
- updates the app metadata with a temporary folder marker and then reverts it

## GitHub Pages

GitHub Pages deployment is configured in [`.github/workflows/deploy-pages.yml`](/home/jsoest/Repositories/TaskManagerWebDav/.github/workflows/deploy-pages.yml).

- Push to `main` to build and deploy the app to GitHub Pages
- Enable Pages in the repository settings and select `GitHub Actions` as the source
- The Vite base path is set automatically for Pages builds in [`vite.config.ts`](/home/jsoest/Repositories/TaskManagerWebDav/vite.config.ts)

### Custom Subdomain

The workflow also supports a custom domain on a subdomain such as `tasks.example.com`.

1. In GitHub, open `Settings -> Secrets and variables -> Actions -> Variables`
2. Add a repository variable named `CUSTOM_DOMAIN`
3. Set its value to your subdomain, for example `tasks.example.com`
4. In your DNS provider, create a `CNAME` record for that subdomain pointing to your GitHub Pages host, usually `<your-github-username>.github.io`
5. Push to `main` again

When `CUSTOM_DOMAIN` is set, the workflow writes a `dist/CNAME` file automatically before deployment.

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

- The app expects CalDAV servers to support standard `PROPFIND`, `REPORT`, `PUT`, `DELETE`, and `MKCALENDAR` operations.
- Direct mode also requires browser CORS access from the app origin.
- Credentials are stored locally in IndexedDB for direct or proxied sync.
- Background reminders depend on browser and PWA support, especially on iOS, so notification delivery is intentionally best effort.
