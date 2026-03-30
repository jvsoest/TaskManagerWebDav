const SERVER_URL = process.env.SERVER_URL ?? process.env.api_host ?? ''
const USERNAME = process.env.CALDAV_USERNAME ?? process.env.username ?? ''
const PASSWORD = process.env.CALDAV_PASSWORD ?? process.env.password ?? ''
const DRY_RUN = process.argv.includes('--dry-run')

if (!SERVER_URL || !USERNAME || !PASSWORD) {
  console.error('Set SERVER_URL/api_host, CALDAV_USERNAME/username, and CALDAV_PASSWORD/password.')
  process.exit(1)
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

function resolveUrl(base, href) {
  return new URL(href, base).toString()
}

function textContent(value) {
  return value?.trim() || undefined
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function propertyHref(xmlText, propertyLocalName) {
  const escapedName = propertyLocalName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  const match = xmlText.match(
    new RegExp(
      `<[^>]*${escapedName}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)</[^>]*href>`,
      'i',
    ),
  )
  return match?.[1]?.trim()
}

function parseCollections(xmlText, baseUrl) {
  const responses = Array.from(xmlText.matchAll(/<[^:>]*:response\b[\s\S]*?<\/[^:>]*:response>/gi)).map((match) => match[0])
  return responses.flatMap((response) => {
    const status = response.match(/<[^:>]*:status>([^<]+)<\/[^:>]*:status>/i)?.[1] ?? ''
    if (!status.includes('200')) {
      return []
    }

    const href = response.match(/<[^:>]*:href>([^<]+)<\/[^:>]*:href>/i)?.[1]?.trim()
    const displayName = response.match(/<[^:>]*:displayname>([^<]*)<\/[^:>]*:displayname>/i)?.[1]?.trim()
    const hasCalendar = /<[^:>]*:calendar\b/i.test(response)
    const supportsVtodo = /<[^:>]*:comp\b[^>]*name="VTODO"/i.test(response)

    return href && hasCalendar && supportsVtodo
      ? [
          {
            url: ensureTrailingSlash(resolveUrl(baseUrl, href)),
            displayName: displayName || href,
          },
        ]
      : []
  })
}

function parseCollectionObjects(xmlText, baseUrl) {
  const responses = Array.from(xmlText.matchAll(/<[^:>]*:response\b[\s\S]*?<\/[^:>]*:response>/gi)).map((match) => match[0])
  return responses.flatMap((response) => {
    const href = response.match(/<[^:>]*:href>([^<]+)<\/[^:>]*:href>/i)?.[1]?.trim()
    const etag = response.match(/<[^:>]*:getetag>([^<]+)<\/[^:>]*:getetag>/i)?.[1]?.trim()
    const payload = response.match(/<[^:>]*:calendar-data>([\s\S]*?)<\/[^:>]*:calendar-data>/i)?.[1]
    return href && payload
      ? [
          {
            href: resolveUrl(baseUrl, href),
            etag,
            payload: decodeXml(payload),
          },
        ]
      : []
  })
}

function unfoldIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const unfolded = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1)
    } else {
      unfolded.push(line)
    }
  }
  return unfolded
}

function escapeIcs(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function unescapeIcs(value) {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function foldIcsLine(line) {
  const chunks = []
  let remaining = line
  while (remaining.length > 75) {
    chunks.push(remaining.slice(0, 75))
    remaining = ` ${remaining.slice(75)}`
  }
  chunks.push(remaining)
  return chunks
}

function parseTaskFromIcs(payload) {
  const lines = unfoldIcs(payload)
  const props = new Map()

  for (const line of lines) {
    const index = line.indexOf(':')
    if (index < 0) {
      continue
    }
    const rawKey = line.slice(0, index)
    const key = rawKey.split(';')[0].toUpperCase()
    const value = line.slice(index + 1)
    const entries = props.get(key) ?? []
    entries.push({ rawKey, value })
    props.set(key, entries)
  }

  return {
    uid: props.get('UID')?.[0]?.value,
    title: unescapeIcs(props.get('SUMMARY')?.[0]?.value ?? ''),
    notes: unescapeIcs(props.get('DESCRIPTION')?.[0]?.value ?? ''),
  }
}

function replaceDescriptionAndModified(payload, description) {
  const lines = unfoldIcs(payload)
  const nextLines = []
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  let skippedDescription = false
  let replacedModified = false

  for (const line of lines) {
    if (line.startsWith('DESCRIPTION:')) {
      if (!skippedDescription) {
        nextLines.push(...foldIcsLine(`DESCRIPTION:${escapeIcs(description)}`))
        skippedDescription = true
      }
      continue
    }

    if (line.startsWith('LAST-MODIFIED:')) {
      nextLines.push(`LAST-MODIFIED:${now}`)
      replacedModified = true
      continue
    }

    if (line === 'END:VTODO' && !skippedDescription) {
      nextLines.push(...foldIcsLine(`DESCRIPTION:${escapeIcs(description)}`))
      skippedDescription = true
    }

    nextLines.push(line)
  }

  if (!replacedModified) {
    const index = nextLines.findIndex((line) => line === 'END:VTODO')
    if (index >= 0) {
      nextLines.splice(index, 0, `LAST-MODIFIED:${now}`)
    }
  }

  return `${nextLines.join('\r\n')}\r\n`
}

async function davRequest(url, init, allowStatuses = []) {
  const response = await fetch(url, init)
  if (!response.ok && response.status !== 207 && !allowStatuses.includes(response.status)) {
    throw new Error(`${init.method ?? 'GET'} ${url} failed (${response.status}): ${await response.text()}`)
  }
  return response
}

async function discoverHomeSet(serverUrl, authorization) {
  const rootUrl = ensureTrailingSlash(serverUrl)
  const rootResponse = await davRequest(
    rootUrl,
    {
      method: 'PROPFIND',
      headers: {
        Authorization: authorization,
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:displayname />
            <d:current-user-principal />
            <c:calendar-home-set />
          </d:prop>
        </d:propfind>`,
    },
  )
  const rootXml = await rootResponse.text()
  const rootBaseUrl = rootResponse.url || rootUrl
  const rootHomeSet = propertyHref(rootXml, 'calendar-home-set')
  if (rootHomeSet) {
    return ensureTrailingSlash(resolveUrl(rootBaseUrl, rootHomeSet))
  }

  const principalHref = propertyHref(rootXml, 'current-user-principal')
  if (!principalHref) {
    return rootUrl
  }

  const principalUrl = resolveUrl(rootBaseUrl, principalHref)
  const principalResponse = await davRequest(
    principalUrl,
    {
      method: 'PROPFIND',
      headers: {
        Authorization: authorization,
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <c:calendar-home-set />
          </d:prop>
        </d:propfind>`,
    },
  )
  const principalXml = await principalResponse.text()
  const homeSetHref = propertyHref(principalXml, 'calendar-home-set')
  return ensureTrailingSlash(resolveUrl(principalResponse.url || principalUrl, homeSetHref ?? './'))
}

async function discoverCollections(homeSetUrl, authorization) {
  const response = await davRequest(
    homeSetUrl,
    {
      method: 'PROPFIND',
      headers: {
        Authorization: authorization,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
        <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:displayname />
            <d:resourcetype />
            <c:supported-calendar-component-set />
          </d:prop>
        </d:propfind>`,
    },
  )

  return parseCollections(await response.text(), response.url || homeSetUrl)
}

async function fetchCollectionObjects(collectionUrl, authorization) {
  const response = await davRequest(
    collectionUrl,
    {
      method: 'REPORT',
      headers: {
        Authorization: authorization,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
        <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <d:prop>
            <d:getetag />
            <c:calendar-data />
          </d:prop>
          <c:filter>
            <c:comp-filter name="VCALENDAR">
              <c:comp-filter name="VTODO" />
            </c:comp-filter>
          </c:filter>
        </c:calendar-query>`,
    },
  )
  return parseCollectionObjects(await response.text(), response.url || collectionUrl)
}

function buildTaskId(collectionId, uid) {
  return `${collectionId}::${uid}`
}

async function main() {
  const authorization = authHeader(USERNAME, PASSWORD)
  const homeSetUrl = await discoverHomeSet(SERVER_URL, authorization)
  const collections = await discoverCollections(homeSetUrl, authorization)
  const metadataCollection = collections.find(
    (collection) =>
      collection.displayName === 'TaskManager Metadata' ||
      /\/taskmanager-meta-[^/]+\/$/i.test(collection.url) ||
      collection.url.endsWith('/taskmanager-meta/'),
  )
  if (!metadataCollection) {
    throw new Error('TaskManager metadata collection not found.')
  }

  const taskCollections = collections.filter((collection) => collection.url !== metadataCollection.url && collection.displayName !== 'TaskManager Smart Lists')
  const metadataUrl = resolveUrl(metadataCollection.url, 'taskmanager-metadata.ics')
  const metadataResponse = await davRequest(
    metadataUrl,
    {
      method: 'GET',
      headers: {
        Authorization: authorization,
      },
    },
  )
  const metadataPayload = await metadataResponse.text()
  const metadataTask = parseTaskFromIcs(metadataPayload)
  const metadataDoc = JSON.parse(metadataTask.notes || '{}')
  if (!metadataDoc.accountId) {
    throw new Error('Metadata document is missing accountId.')
  }

  const migratedManualTaskOrder = {}
  let changedCount = 0
  for (const [storedCollectionRef, taskIds] of Object.entries(metadataDoc.manualTaskOrder ?? {})) {
    const normalizedCollectionUrl = ensureTrailingSlash(
      storedCollectionRef.includes('://') ? storedCollectionRef : storedCollectionRef.split(':').slice(1).join(':'),
    )
    const collectionId = `${metadataDoc.accountId}:${normalizedCollectionUrl}`
    migratedManualTaskOrder[storedCollectionRef] = (taskIds ?? []).map((taskId) => {
      if (String(taskId).includes('::')) {
        return String(taskId)
      }
      changedCount += 1
      return buildTaskId(collectionId, String(taskId))
    })
  }

  if (changedCount === 0) {
    console.log('No legacy task ids found in metadata manualTaskOrder.')
    return
  }

  metadataDoc.manualTaskOrder = migratedManualTaskOrder
  metadataDoc.updatedAt = new Date().toISOString()

  const nextPayload = replaceDescriptionAndModified(metadataPayload, JSON.stringify(metadataDoc, null, 2))
  console.log(`Migrated ${changedCount} manualTaskOrder entries.`)
  console.log(`Updated metadata resource: ${metadataUrl}`)
  console.log(`Discovered task collections: ${taskCollections.length}`)
  if (DRY_RUN) {
    console.log('Dry run only. No changes were written.')
    return
  }

  const response = await davRequest(
    metadataUrl,
    {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': 'text/calendar; charset=utf-8',
        ...(metadataResponse.headers.get('etag') ? { 'If-Match': metadataResponse.headers.get('etag') } : {}),
      },
      body: nextPayload,
    },
  )

  console.log(`HTTP ${response.status}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
