import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const DIST_DIR = path.resolve('dist')
const INDEX_PATH = path.join(DIST_DIR, 'index.html')
const SW_PATH = path.join(DIST_DIR, 'sw.js')

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        return listFiles(rootDir, absolutePath)
      }

      if (!entry.isFile()) {
        return []
      }

      return [path.relative(rootDir, absolutePath).split(path.sep).join('/')]
    }),
  )

  return files.flat()
}

function inferBasePath(indexHtml) {
  const assetMatch = indexHtml.match(/(?:src|href)="(\/.*?)(?:assets\/|manifest\.webmanifest|icon\.svg)/)
  if (!assetMatch) {
    return '/'
  }

  const matchedPath = assetMatch[1]
  return matchedPath.endsWith('/') ? matchedPath : `${matchedPath}`
}

function toCacheUrl(basePath, relativePath) {
  if (relativePath === 'index.html') {
    return [basePath, `${basePath}index.html`]
  }

  return [`${basePath}${relativePath}`]
}

async function main() {
  const indexHtml = await fs.readFile(INDEX_PATH, 'utf8')
  const basePath = inferBasePath(indexHtml)
  const distFiles = (await listFiles(DIST_DIR)).filter((file) => file !== 'sw.js')

  const precacheUrls = Array.from(
    new Set(
      distFiles.flatMap((relativePath) => toCacheUrl(basePath, relativePath)),
    ),
  )

  const cacheVersion = createHash('sha256')
    .update(precacheUrls.join('\n'))
    .digest('hex')
    .slice(0, 12)

  const serviceWorker = `const CACHE_NAME = 'taskmanagerwebdav-shell-${cacheVersion}'
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)}
const INDEX_URL = ${JSON.stringify(`${basePath}index.html`)}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return
  }

  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== self.location.origin) {
    return
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone()
          void caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, clone))
          return response
        })
        .catch(async () => (await caches.match(INDEX_URL)) ?? (await caches.match('/'))),
    )
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached
      }

      return fetch(event.request).then((response) => {
        if (!response.ok) {
          return response
        }

        const clone = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
        return response
      })
    }),
  )
})
`

  await fs.writeFile(SW_PATH, serviceWorker, 'utf8')
}

await main()
