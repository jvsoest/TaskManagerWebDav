import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST_DIR = path.resolve(__dirname, '../dist')
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? '8080', 10)
const MAX_REDIRECTS = 5
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'PROPPATCH', 'REPORT', 'PUT', 'DELETE', 'MKCALENDAR'])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'host',
  'origin',
  'referer',
  'transfer-encoding',
])
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

function parseCsvEnv(value, fallback = '') {
  return (value ?? fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function createRuntimeConfig(overrides = {}) {
  return {
    port: overrides.port ?? DEFAULT_PORT,
    host: overrides.host ?? '0.0.0.0',
    distDir: overrides.distDir ?? DEFAULT_DIST_DIR,
    allowedOrigins: overrides.allowedOrigins ?? parseCsvEnv(process.env.ALLOWED_ORIGINS, '*'),
    upstreamAllowlist:
      overrides.upstreamAllowlist ??
      parseCsvEnv(process.env.UPSTREAM_ALLOWLIST).map((entry) => entry.toLowerCase()),
  }
}

async function distExists(distDir) {
  try {
    const stat = await fs.stat(distDir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function allowOrigin(origin, allowedOrigins) {
  if (!origin) {
    return allowedOrigins[0] ?? '*'
  }
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    return origin
  }
  return 'null'
}

function setCorsHeaders(response, allowedOrigins, origin = '') {
  response.setHeader('Access-Control-Allow-Origin', allowOrigin(origin, allowedOrigins))
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Max-Age', '86400')
  response.setHeader('Vary', 'Origin')
}

function writeJson(response, status, payload, allowedOrigins, origin = '') {
  setCorsHeaders(response, allowedOrigins, origin)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function isAllowedUpstream(url, upstreamAllowlist) {
  if (!upstreamAllowlist.length) {
    return true
  }

  return upstreamAllowlist.some(
    (entry) => url.hostname.toLowerCase() === entry || url.hostname.toLowerCase().endsWith(`.${entry}`),
  )
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

async function handleDavProxy(request, response, config) {
  const origin = request.headers.origin ?? ''
  const requestPath = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${config.port}`}`).pathname

  if (request.method === 'OPTIONS') {
    setCorsHeaders(response, config.allowedOrigins, origin)
    response.writeHead(204)
    response.end()
    return
  }

  if (!['/', '/dav'].includes(requestPath) || request.method !== 'POST') {
    writeJson(response, 404, { error: 'Not found.' }, config.allowedOrigins, origin)
    return
  }

  try {
    const rawBody = await readBody(request)
    const payload = JSON.parse(rawBody)
    const method = String(payload.method ?? '').toUpperCase()
    const targetUrl = new URL(String(payload.url ?? ''))

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      writeJson(response, 400, { error: 'Only HTTP(S) upstream URLs are allowed.' }, config.allowedOrigins, origin)
      return
    }

    if (!ALLOWED_METHODS.has(method)) {
      writeJson(response, 400, { error: `Unsupported DAV method: ${method}` }, config.allowedOrigins, origin)
      return
    }

    if (!isAllowedUpstream(targetUrl, config.upstreamAllowlist)) {
      writeJson(response, 403, { error: `Upstream host ${targetUrl.hostname} is not allowed.` }, config.allowedOrigins, origin)
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
      config.allowedOrigins,
      origin,
    )
  } catch (error) {
    writeJson(
      response,
      500,
      { error: error instanceof Error ? error.message : 'Proxy request failed.' },
      config.allowedOrigins,
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

async function handleStaticRequest(request, response, config) {
  if (!(await distExists(config.distDir))) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('dist/ not found. Build the app before starting the integrated server.')
    return
  }

  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${config.port}`}`)
  let filePath = path.join(config.distDir, decodeURIComponent(requestUrl.pathname))

  if (requestUrl.pathname === '/') {
    filePath = path.join(config.distDir, 'index.html')
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

  await serveFile(response, path.join(config.distDir, 'index.html'))
}

function handleHealth(response) {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify({ ok: true }))
}

export function createTaskManagerServer(overrides = {}) {
  const config = createRuntimeConfig(overrides)
  const server = http.createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${config.port}`}`).pathname

    if (requestPath === '/api/health') {
      handleHealth(response)
      return
    }

    if (
      requestPath.startsWith('/dav') ||
      (requestPath === '/' && ['POST', 'OPTIONS'].includes(request.method ?? 'GET'))
    ) {
      await handleDavProxy(request, response, config)
      return
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Method Not Allowed')
      return
    }

    await handleStaticRequest(request, response, config)
  })

  return server
}

export async function startTaskManagerServer(overrides = {}) {
  const config = createRuntimeConfig(overrides)
  const server = createTaskManagerServer(config)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port

  return {
    server,
    port,
    url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startTaskManagerServer({ port: DEFAULT_PORT, host: '0.0.0.0' })
    .then(({ url }) => {
      console.log(`TaskManagerWebDav server listening on ${url}`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
