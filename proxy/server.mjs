import http from 'node:http'

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
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

function writeJson(response, status, payload, origin = '') {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': allowOrigin(origin),
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
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

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin ?? ''

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': allowOrigin(origin),
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    })
    response.end()
    return
  }

  if (request.url !== '/dav' || request.method !== 'POST') {
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
})

server.listen(PORT, () => {
  console.log(`TaskManagerWebDav proxy listening on http://localhost:${PORT}`)
})
