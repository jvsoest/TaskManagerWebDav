import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(__dirname, '../dist')
const PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const UPSTREAM_ALLOWLIST = (process.env.UPSTREAM_ALLOWLIST ?? '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean)
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT', 'PUT', 'DELETE', 'MKCALENDAR'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'host',
  'origin',
  'referer',
  'transfer-encoding',
])
const MAX_REDIRECTS = 5
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

async function distExists() {
  try {
    const stat = await fs.stat(DIST_DIR)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function allowOrigin(origin) {
  if (!origin) {
    return ALLOWED_ORIGINS[0] ?? '*'
  }
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    return origin
  }
  return 'null'
}

function setCorsHeaders(response, origin = '') {
  response.setHeader('Access-Control-Allow-Origin', allowOrigin(origin))
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Max-Age', '86400')
  response.setHeader('Vary', 'Origin')
}

function writeJson(response, status, payload, origin = '') {
  setCorsHeaders(response, origin)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function isAllowedUpstream(url) {
  if (!UPSTREAM_ALLOWLIST.length) {
    return true
  }

  return UPSTREAM_ALLOWLIST.some((entry) => url.hostname.toLowerCase() === entry || url.hostname.toLowerCase().endsWith(`.${entry}`))
}

function sanitizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      const normalizedKey = key.toLowerCase()
      return !HOP_BY_HOP_HEADERS.has(normalizedKey) && typeof value === 'string'
    }),
  )
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function forwardRequest(url, method, headers, body) {
  let currentUrl = url

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(currentUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }

    const location = response.headers.get('location') ?? response.headers.get('Location')
    if (!location) {
      return response
    }

    currentUrl = new URL(location, currentUrl).toString()
  }

  throw new Error(`Too many redirects while forwarding ${method} ${url}`)
}

async function handleDavProxy(request, response) {
  const origin = request.headers.origin ?? ''
  const requestPath = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${PORT}`}`).pathname

  if (request.method === 'OPTIONS') {
    setCorsHeaders(response, origin)
    response.writeHead(204)
    response.end()
    return
  }

  if (!['/', '/dav'].includes(requestPath) || request.method !== 'POST') {
    writeJson(response, 404, { error: 'Not found.' }, origin)
    return
  }

  try {
    const rawBody = await readBody(request)
    const payload = JSON.parse(rawBody)
    const method = String(payload.method ?? '').toUpperCase()
    const targetUrl = new URL(String(payload.url ?? ''))

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      writeJson(response, 400, { error: 'Only HTTP(S) upstream URLs are allowed.' }, origin)
      return
    }

    if (!ALLOWED_METHODS.has(method)) {
      writeJson(response, 400, { error: `Unsupported DAV method: ${method}` }, origin)
      return
    }

    if (!isAllowedUpstream(targetUrl)) {
      writeJson(response, 403, { error: `Upstream host ${targetUrl.hostname} is not allowed.` }, origin)
      return
    }

    const upstreamHeaders = sanitizeHeaders(payload.headers ?? {})
    const upstreamResponse = await forwardRequest(targetUrl.toString(), method, upstreamHeaders, payload.body)
    const text = await upstreamResponse.text()
    const responseHeaders = sanitizeHeaders(Object.fromEntries(upstreamResponse.headers.entries()))

    writeJson(
      response,
      200,
      {
        status: upstreamResponse.status,
        headers: responseHeaders,
        url: upstreamResponse.url,
        body: text,
      },
      origin,
    )
  } catch (error) {
    writeJson(
      response,
      500,
      { error: error instanceof Error ? error.message : 'Proxy request failed.' },
      origin,
    )
  }
}

function isAssetRequest(urlPath) {
  return path.extname(urlPath) !== ''
}

async function serveFile(response, filePath) {
  const content = await fs.readFile(filePath)
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
  })
  response.end(content)
}

async function handleStaticRequest(request, response) {
  if (!(await distExists())) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('dist/ not found. Build the app before starting the combined server.')
    return
  }

  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${PORT}`}`)
  let filePath = path.join(DIST_DIR, decodeURIComponent(requestUrl.pathname))

  if (requestUrl.pathname === '/') {
    filePath = path.join(DIST_DIR, 'index.html')
  }

  try {
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      await serveFile(response, path.join(filePath, 'index.html'))
      return
    }
    await serveFile(response, filePath)
    return
  } catch {
    if (isAssetRequest(requestUrl.pathname)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found.')
      return
    }
  }

  await serveFile(response, path.join(DIST_DIR, 'index.html'))
}

const server = http.createServer(async (request, response) => {
  const requestPath = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${PORT}`}`).pathname

  if (
    requestPath.startsWith('/dav') ||
    (requestPath === '/' && ['POST', 'OPTIONS'].includes(request.method ?? 'GET'))
  ) {
    await handleDavProxy(request, response)
    return
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Method Not Allowed')
    return
  }

  await handleStaticRequest(request, response)
})

server.listen(PORT, () => {
  console.log(`TaskManagerWebDav server listening on http://localhost:${PORT}`)
})
