const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:8787/dav'
const SERVER_URL = process.env.SERVER_URL ?? 'https://api.cirrux.co/'
const USERNAME = process.env.CALDAV_USERNAME ?? ''
const PASSWORD = process.env.CALDAV_PASSWORD ?? ''

if (!USERNAME || !PASSWORD) {
  console.error('Set CALDAV_USERNAME and CALDAV_PASSWORD before running this test.')
  process.exit(1)
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:displayname />
    <d:current-user-principal />
    <cs:calendar-home-set />
  </d:prop>
</d:propfind>`

const principalPropfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname />
    <c:calendar-home-set />
  </d:prop>
</d:propfind>`

async function requestViaProxy(url, body = propfindBody) {
  const endpoint = ensureTrailingSlash(PROXY_URL).replace(/\/$/, '')
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        method: 'PROPFIND',
        headers: {
          Authorization: authHeader(USERNAME, PASSWORD),
          Depth: '0',
          'Content-Type': 'application/xml; charset=utf-8',
        },
        body,
      }),
    })
  } catch (error) {
    const details =
      error instanceof Error
        ? [error.message, error.cause?.code, error.cause?.errno, error.cause?.syscall]
            .filter(Boolean)
            .join(' | ')
        : String(error)
    throw new Error(`Proxy request to ${endpoint} failed: ${details}`)
  }

  const payload = await response.json()
  return {
    proxyStatus: response.status,
    upstreamStatus: payload.status,
    headers: payload.headers ?? {},
    body: payload.body ?? '',
  }
}

function printResult(label, result) {
  console.log(`\n=== ${label} ===`)
  console.log(`Proxy HTTP: ${result.proxyStatus}`)
  console.log(`Upstream HTTP: ${result.upstreamStatus}`)
  if (result.headers.location) {
    console.log(`Location: ${result.headers.location}`)
  }
  if (result.headers['www-authenticate']) {
    console.log(`WWW-Authenticate: ${result.headers['www-authenticate']}`)
  }
  console.log(result.body.slice(0, 1200))

  const principalHrefMatch = result.body.match(/<[^>]*current-user-principal[^>]*>[\s\S]*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)
  const homeSetHrefMatch = result.body.match(/<[^>]*calendar-home-set[^>]*>[\s\S]*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)

  if (principalHrefMatch?.[1]) {
    console.log(`Discovered principal href: ${principalHrefMatch[1]}`)
  }
  if (homeSetHrefMatch?.[1]) {
    console.log(`Discovered calendar-home-set href: ${homeSetHrefMatch[1]}`)
  }
}

async function main() {
  const rootUrl = ensureTrailingSlash(SERVER_URL)
  const caldavUrl = new URL('caldav/', rootUrl).toString()

  const [rootResult, caldavResult] = await Promise.all([
    requestViaProxy(rootUrl),
    requestViaProxy(caldavUrl),
  ])

  printResult(rootUrl, rootResult)
  printResult(caldavUrl, caldavResult)

  const principalHrefMatch =
    rootResult.body.match(/<[^>]*current-user-principal[^>]*>[\s\S]*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i) ??
    caldavResult.body.match(/<[^>]*current-user-principal[^>]*>[\s\S]*?<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/i)

  if (principalHrefMatch?.[1]) {
    const principalUrl = new URL(principalHrefMatch[1], caldavUrl).toString()
    const principalResult = await requestViaProxy(principalUrl, principalPropfindBody)
    printResult(principalUrl, principalResult)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  console.error('Check that the proxy is running and reachable at PROXY_URL.')
  process.exit(1)
})
