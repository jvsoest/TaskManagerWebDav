import {
  createDefaultMetadata,
  defaultFilter,
  defaultSmartListOrdering,
  expandTreeIds,
  extractHashtags,
  normalizeOrdering,
  parseSmartListPayload,
  smartListDefinitionFromFilter,
  serializeSmartListPayload,
} from './filters'
import { newUuid } from './ids'
import type {
  Account,
  AccountConnectionInput,
  DiscoverAccountResult,
  MetadataDocument,
  SmartList,
  SyncResult,
  TaskCollection,
  TaskItem,
} from '../types'

const METADATA_COLLECTION_NAME = 'taskmanager-meta'
const SMART_COLLECTION_NAME = 'taskmanager-smart'
const METADATA_RESOURCE_NAME = 'taskmanager-metadata.ics'
const MAX_REDIRECTS = 5
const HIDDEN_COLLECTION_TARGETS = [
  { kind: 'metadata' as const, slug: METADATA_COLLECTION_NAME, displayName: 'TaskManager Metadata' },
  { kind: 'smart' as const, slug: SMART_COLLECTION_NAME, displayName: 'TaskManager Smart Lists' },
]

type DavConnection = Pick<AccountConnectionInput, 'serverUrl' | 'connectionMode' | 'proxyUrl' | 'username' | 'password'>

function isMetadataCollectionUrl(url: string): boolean {
  return (
    url.endsWith('/taskmanager-meta/') ||
    url.endsWith('/.taskmanager-meta/') ||
    /\/taskmanager-meta-[^/]+\/$/i.test(url) ||
    /\/\.taskmanager-meta-[^/]+\/$/i.test(url)
  )
}

function isSmartCollectionUrl(url: string): boolean {
  return (
    url.endsWith('/taskmanager-smart/') ||
    url.endsWith('/.taskmanager-smart/') ||
    /\/taskmanager-smart-[^/]+\/$/i.test(url) ||
    /\/\.taskmanager-smart-[^/]+\/$/i.test(url)
  )
}

function hiddenCollectionKind(collection: Pick<DiscoveredCollection, 'url' | 'displayName'>): 'metadata' | 'smart' | undefined {
  if (isMetadataCollectionUrl(collection.url) || collection.displayName === 'TaskManager Metadata') {
    return 'metadata'
  }

  if (isSmartCollectionUrl(collection.url) || collection.displayName === 'TaskManager Smart Lists') {
    return 'smart'
  }

  return undefined
}

function authHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })

  return `Basic ${btoa(binary)}`
}

function connectionFromAccount(account: Account): DavConnection {
  return {
    serverUrl: account.serverUrl,
    connectionMode: account.connectionMode,
    proxyUrl: account.proxyUrl ?? '',
    username: account.username,
    password: account.password,
  }
}

function connectionInputFromAccount(account: Account): AccountConnectionInput {
  return {
    label: account.label,
    serverUrl: account.serverUrl,
    connectionMode: account.connectionMode,
    proxyUrl: account.proxyUrl ?? '',
    username: account.username,
    password: account.password,
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function resolveUrl(base: string, href: string): string {
  return new URL(href, base).toString()
}

function responseBaseUrl(response: Response, fallbackUrl: string): string {
  const forwardedUrl = response.headers.get('x-taskmanager-final-url')
  if (forwardedUrl) {
    return forwardedUrl
  }

  return response.url || fallbackUrl
}

function textContent(element: Element | null): string | undefined {
  return element?.textContent?.trim() || undefined
}

function firstDescendant(element: Element, localName: string): Element | null {
  return (
    Array.from(element.getElementsByTagName('*')).find((candidate) => candidate.localName === localName) ??
    null
  )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function firstElementByLocalName(document: XMLDocument, localName: string): Element | null {
  return Array.from(document.getElementsByTagName('*')).find((element) => element.localName === localName) ?? null
}

function propertyHref(document: XMLDocument, propertyLocalName: string): string | undefined {
  const property = firstElementByLocalName(document, propertyLocalName)
  return property ? textContent(firstDescendant(property, 'href')) : undefined
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

function normalizeProxyUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.trim()
  if (!trimmed) {
    return trimmed
  }

  try {
    return new URL(trimmed).toString().endsWith('/') ? new URL(trimmed).toString() : `${new URL(trimmed).toString()}/`
  } catch {
    const baseUrl =
      typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const resolved = new URL(trimmed, baseUrl).toString()
    return resolved.endsWith('/') ? resolved : `${resolved}/`
  }
}

function isCirruxServer(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase()
    return hostname === 'api.cirrux.co' || hostname.endsWith('.cirrux.co')
  } catch {
    return false
  }
}

function connectionErrorMessage(connection: DavConnection, error: unknown): string {
  if (connection.connectionMode === 'direct' && isCirruxServer(connection.serverUrl)) {
    return 'Cirrux exposes CalDAV for native clients, but blocks direct browser CalDAV from this app origin. Use Proxy mode with https://api.cirrux.co as the server URL and the Cirrux app password.'
  }

  if (connection.connectionMode === 'direct' && error instanceof TypeError) {
    return 'Direct browser CalDAV access failed. This provider likely blocks cross-origin DAV requests from this app. Try Proxy mode.'
  }

  return error instanceof Error ? error.message : 'CalDAV request failed.'
}

async function proxyRequest(url: string, init: RequestInit, proxyUrl: string): Promise<Response> {
  const endpoint = normalizeProxyUrl(proxyUrl)
  const headers = new Headers(init.headers)
  const body = typeof init.body === 'string' ? init.body : undefined

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      body,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Proxy request failed (${response.status}): ${message}`)
  }

  const payload = (await response.json()) as {
    status: number
    headers?: Record<string, string>
    body?: string
    url?: string
  }

  const responseHeaders = new Headers(payload.headers ?? {})
  if (payload.url) {
    responseHeaders.set('x-taskmanager-final-url', payload.url)
  }

  const responseBody =
    [101, 103, 204, 205, 304].includes(payload.status) || payload.body === undefined
      ? null
      : payload.body

  return new Response(responseBody, {
    status: payload.status,
    headers: responseHeaders,
  })
}

async function directRequest(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(currentUrl, {
      ...init,
      redirect: 'manual',
    })

    if (!isRedirectStatus(response.status)) {
      return response
    }

    const location = response.headers.get('location') ?? response.headers.get('Location')
    if (!location) {
      return response
    }

    currentUrl = new URL(location, currentUrl).toString()
  }

  throw new Error(`Too many redirects while requesting ${url}.`)
}

async function davRequest(
  connection: DavConnection,
  url: string,
  init: RequestInit & { depth?: '0' | '1'; allowStatuses?: number[] } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.depth) {
    headers.set('Depth', init.depth)
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/xml; charset=utf-8')
  }

  let response: Response
  try {
    if (connection.connectionMode === 'proxy') {
      if (!connection.proxyUrl.trim()) {
        throw new Error('Proxy URL is required for Proxy mode.')
      }
      response = await proxyRequest(url, { ...init, headers }, connection.proxyUrl)
    } else {
      response = await directRequest(url, { ...init, headers })
    }
  } catch (error) {
    throw new Error(connectionErrorMessage(connection, error))
  }

  if (!response.ok && response.status !== 207 && !init.allowStatuses?.includes(response.status)) {
    const message = await response.text()
    throw new Error(`${init.method ?? 'GET'} ${url} failed (${response.status}): ${message}`)
  }

  return response
}

interface DiscoveredCollection {
  url: string
  displayName: string
  isCalendar: boolean
  supportsVtodo: boolean
  syncToken?: string
}

function parseMultiStatus(xmlText: string, baseUrl: string): DiscoveredCollection[] {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml')
  const responses = Array.from(document.getElementsByTagName('*')).filter(
    (element) => element.localName === 'response',
  )

  return responses.reduce<DiscoveredCollection[]>((entries, response) => {
      const href = textContent(firstDescendant(response, 'href'))
      const propstat = Array.from(response.getElementsByTagName('*')).find(
        (element) => element.localName === 'propstat' && textContent(firstDescendant(element, 'status'))?.includes('200'),
      )

      if (!href || !propstat) {
        return entries
      }

      const prop = firstDescendant(propstat, 'prop')
      if (!prop) {
        return entries
      }

      const resourceType = firstDescendant(prop, 'resourcetype')
      const isCalendar = Boolean(resourceType && firstDescendant(resourceType, 'calendar'))
      const supportsVtodo = Array.from(prop.getElementsByTagName('*')).some(
        (element) =>
          element.localName === 'comp' && element.getAttribute('name')?.toUpperCase() === 'VTODO',
      )

      entries.push({
        url: resolveUrl(baseUrl, href),
        displayName: textContent(firstDescendant(prop, 'displayname')) ?? href,
        isCalendar,
        supportsVtodo,
        syncToken: textContent(firstDescendant(prop, 'sync-token')),
      })

      return entries
    }, [])
}

async function propfind(
  connection: DavConnection,
  url: string,
  authorization: string,
  body: string,
  depth: '0' | '1',
): Promise<DiscoveredCollection[]> {
  const response = await davRequest(connection, url, {
    method: 'PROPFIND',
    depth,
    headers: {
      Authorization: authorization,
    },
    body,
  })

  return parseMultiStatus(await response.text(), responseBaseUrl(response, url))
}

async function fetchResourceEtag(connection: DavConnection, url: string, authorization: string): Promise<string | undefined> {
  const response = await davRequest(connection, url, {
    method: 'PROPFIND',
    depth: '0',
    headers: {
      Authorization: authorization,
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:">
        <d:prop>
          <d:getetag />
        </d:prop>
      </d:propfind>`,
  })

  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml')
  const resourceResponse = Array.from(xml.getElementsByTagName('*')).find(
    (element) => element.localName === 'response',
  )

  return resourceResponse ? textContent(firstDescendant(resourceResponse, 'getetag')) : undefined
}

async function discoverHomeSet(input: AccountConnectionInput): Promise<{ displayName: string; homeSetUrl: string }> {
  if (input.connectionMode === 'direct' && isCirruxServer(input.serverUrl)) {
    throw new Error(connectionErrorMessage(input, new Error('Cirrux requires proxy mode.')))
  }

  const authorization = authHeader(input.username, input.password)
  const serverUrl = ensureTrailingSlash(input.serverUrl)
  const rootResponse = await davRequest(input, serverUrl, {
    method: 'PROPFIND',
    depth: '0',
    headers: {
      Authorization: authorization,
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:displayname />
          <d:current-user-principal />
          <c:calendar-home-set />
        </d:prop>
      </d:propfind>`,
  })
  const rootBaseUrl = responseBaseUrl(rootResponse, serverUrl)

  const rootXml = new DOMParser().parseFromString(await rootResponse.text(), 'application/xml')
  const rootDisplayName = textContent(firstElementByLocalName(rootXml, 'displayname'))
  const rootHomeSet = propertyHref(rootXml, 'calendar-home-set')

  if (rootHomeSet) {
    return {
      displayName: rootDisplayName ?? input.label ?? input.username,
      homeSetUrl: ensureTrailingSlash(resolveUrl(rootBaseUrl, rootHomeSet)),
    }
  }

  const principalHref = propertyHref(rootXml, 'current-user-principal')

  if (!principalHref) {
    return {
      displayName: rootDisplayName ?? input.label ?? input.username,
      homeSetUrl: serverUrl,
    }
  }

  const principalUrl = resolveUrl(rootBaseUrl, principalHref)
  const principalResponse = await davRequest(input, principalUrl, {
    method: 'PROPFIND',
    depth: '0',
    headers: {
      Authorization: authorization,
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:displayname />
          <c:calendar-home-set />
        </d:prop>
      </d:propfind>`,
  })
  const principalBaseUrl = responseBaseUrl(principalResponse, principalUrl)

  const principalXml = new DOMParser().parseFromString(await principalResponse.text(), 'application/xml')
  const displayName =
    textContent(firstElementByLocalName(principalXml, 'displayname')) ??
    rootDisplayName ??
    input.label ??
    input.username

  const homeSetHref = propertyHref(principalXml, 'calendar-home-set')

  return {
    displayName,
    homeSetUrl: ensureTrailingSlash(resolveUrl(principalBaseUrl, homeSetHref ?? './')),
  }
}

async function mkcalendar(connection: DavConnection, url: string, authorization: string, displayName: string): Promise<string> {
  const response = await davRequest(connection, url, {
    method: 'MKCALENDAR',
    allowStatuses: [405],
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:set>
          <d:prop>
            <d:displayname>${escapeXml(displayName)}</d:displayname>
            <c:supported-calendar-component-set>
              <c:comp name="VTODO" />
            </c:supported-calendar-component-set>
          </d:prop>
        </d:set>
      </c:mkcalendar>`,
  })

  if (![200, 201, 204, 405].includes(response.status)) {
    const message = await response.text()
    throw new Error(`MKCALENDAR ${url} failed (${response.status}): ${message}`)
  }

  const location = response.headers.get('location') ?? response.headers.get('Location')
  if (location) {
    return ensureTrailingSlash(resolveUrl(url, location))
  }

  return ensureTrailingSlash(url)
}

async function isCollectionAccessible(
  connection: DavConnection,
  url: string,
  authorization: string,
): Promise<boolean> {
  try {
    const response = await davRequest(connection, ensureTrailingSlash(url), {
      method: 'PROPFIND',
      depth: '0',
      allowStatuses: [404],
      headers: {
        Authorization: authorization,
      },
      body: `<?xml version="1.0" encoding="utf-8" ?>
        <d:propfind xmlns:d="DAV:">
          <d:prop>
            <d:displayname />
          </d:prop>
        </d:propfind>`,
    })
    return response.status !== 404
  } catch {
    return false
  }
}

async function ensureHiddenCollections(
  connection: DavConnection,
  homeSetUrl: string,
  authorization: string,
  collections: DiscoveredCollection[],
): Promise<DiscoveredCollection[]> {
  for (const target of HIDDEN_COLLECTION_TARGETS) {
    const candidates = collections.filter((collection) => hiddenCollectionKind(collection) === target.kind)
    let hasUsableCandidate = false

    for (const candidate of candidates) {
      if (await isCollectionAccessible(connection, candidate.url, authorization)) {
        hasUsableCandidate = true
        break
      }
    }

    if (hasUsableCandidate) {
      continue
    }

    let created = false
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const uniqueSlug = `${target.slug}-${newUuid().toUpperCase()}`
      const uniqueUrl = ensureTrailingSlash(resolveUrl(homeSetUrl, `${uniqueSlug}/`))
      try {
        await mkcalendar(connection, uniqueUrl, authorization, target.displayName)
        created = true
      } catch {
        // Try another UUID-based hidden collection URL.
      }
    }

    if (!created) {
      throw new Error(`Failed to create ${target.displayName} collection.`)
    }
  }

  return propfind(
    connection,
    homeSetUrl,
    authorization,
    `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:displayname />
          <d:resourcetype />
          <d:sync-token />
          <c:supported-calendar-component-set />
        </d:prop>
      </d:propfind>`,
    '1',
  )
}

export async function discoverAccount(
  input: AccountConnectionInput,
  accountId: string,
): Promise<DiscoverAccountResult> {
  const authorization = authHeader(input.username, input.password)
  const { displayName, homeSetUrl } = await discoverHomeSet(input)
  const collections = await propfind(
    input,
    homeSetUrl,
    authorization,
    `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:displayname />
          <d:resourcetype />
          <d:sync-token />
          <c:supported-calendar-component-set />
        </d:prop>
      </d:propfind>`,
    '1',
  )

  const refreshedCollections = await ensureHiddenCollections(input, homeSetUrl, authorization, collections)

  const accessibleHiddenUrls = new Map<'metadata' | 'smart', string>()
  for (const target of HIDDEN_COLLECTION_TARGETS) {
    const candidates = refreshedCollections.filter((collection) => hiddenCollectionKind(collection) === target.kind)
    for (const candidate of candidates) {
      if (await isCollectionAccessible(input, candidate.url, authorization)) {
        accessibleHiddenUrls.set(target.kind, ensureTrailingSlash(candidate.url))
        break
      }
    }
  }

  return {
    accountDisplayName: displayName,
    collections: refreshedCollections
      .filter((collection) => collection.isCalendar && collection.supportsVtodo)
      .filter((collection) => {
        const kind = hiddenCollectionKind(collection)
        if (!kind) {
          return true
        }
        return accessibleHiddenUrls.get(kind) === ensureTrailingSlash(collection.url)
      })
      .map((collection) => {
        const url = ensureTrailingSlash(collection.url)
        const kind = hiddenCollectionKind({ url, displayName: collection.displayName })
        return {
          id: `${accountId}:${url}`,
          accountId,
          url,
          displayName: collection.displayName,
          kind: kind ?? 'task',
          syncToken: collection.syncToken,
        } as TaskCollection
      }),
  }
}

function rfcPriorityFromAppPriority(priority: number): number {
  switch (priority) {
    case 1:
      return 1
    case 2:
      return 3
    case 3:
      return 5
    case 4:
      return 7
    default:
      return 0
  }
}

function appPriorityFromRfcPriority(priority: number): number {
  if (priority <= 0) {
    return 0
  }
  if (priority <= 1) {
    return 1
  }
  if (priority <= 3) {
    return 2
  }
  if (priority <= 5) {
    return 3
  }
  return 4
}

export async function createTaskCollection(account: Account, displayName: string): Promise<TaskCollection> {
  const authorization = authHeader(account.username, account.password)
  const { homeSetUrl } = await discoverHomeSet(connectionInputFromAccount(account))

  const collections = await propfind(
    connectionFromAccount(account),
    homeSetUrl,
    authorization,
    `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
        <d:prop>
          <d:displayname />
          <d:resourcetype />
          <d:sync-token />
          <c:supported-calendar-component-set />
        </d:prop>
      </d:propfind>`,
    '1',
  )

  const takenUrls = new Set(collections.map((collection) => ensureTrailingSlash(collection.url)))
  let targetUrl = ensureTrailingSlash(resolveUrl(homeSetUrl, `${newUuid().toUpperCase()}/`))

  while (takenUrls.has(targetUrl)) {
    targetUrl = ensureTrailingSlash(resolveUrl(homeSetUrl, `${newUuid().toUpperCase()}/`))
  }

  const actualUrl = await mkcalendar(connectionFromAccount(account), targetUrl, authorization, displayName.trim())

  return {
    id: `${account.id}:${actualUrl}`,
    accountId: account.id,
    url: actualUrl,
    displayName: displayName.trim(),
    kind: 'task',
  }
}

export async function deleteTaskCollection(account: Account, collection: TaskCollection): Promise<void> {
  const connection = connectionFromAccount(account)
  const authorization = authHeader(account.username, account.password)
  let response = await davRequest(connection, collection.url, {
    method: 'DELETE',
    allowStatuses: [404],
    headers: {
      Authorization: authorization,
    },
  })

  if (response.status === 404) {
    const rediscovered = await discoverAccount(connectionInputFromAccount(account), account.id)
    const refreshedCollection = rediscovered.collections.find(
      (entry) => entry.kind === 'task' && entry.displayName === collection.displayName,
    )
    if (refreshedCollection && refreshedCollection.url !== collection.url) {
      response = await davRequest(connection, refreshedCollection.url, {
        method: 'DELETE',
        allowStatuses: [404],
        headers: {
          Authorization: authorization,
        },
      })
    }
  }

  if (!response.ok && response.status !== 404) {
    const message = await response.text()
    throw new Error(`Task list delete failed (${response.status}): ${message}`)
  }
}

function unfoldIcs(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const unfolded: string[] = []

  lines.forEach((line: string) => {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1)
    } else {
      unfolded.push(line)
    }
  })

  return unfolded
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

function parseIcsDate(value?: string): string | undefined {
  if (!value) {
    return undefined
  }

  if (value.includes('-')) {
    return value
  }

  const normalized = value.replace('Z', '')
  if (normalized.length < 8) {
    return undefined
  }

  const year = normalized.slice(0, 4)
  const month = normalized.slice(4, 6)
  const day = normalized.slice(6, 8)

  if (normalized.length === 8) {
    return `${year}-${month}-${day}`
  }

  const hour = normalized.slice(9, 11) || normalized.slice(8, 10)
  const minute = normalized.slice(11, 13) || normalized.slice(10, 12)
  const second = normalized.slice(13, 15) || normalized.slice(12, 14) || '00'
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${value.endsWith('Z') ? 'Z' : ''}`
}

function formatIcsDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toISOString().replace(/-/g, '').replace(/:/g, '').replace('.000', '')
}

function parseTaskFromIcs(
  payload: string,
  accountId: string,
  collectionId: string,
): TaskItem | undefined {
  const lines = unfoldIcs(payload)
  const props = new Map<string, string[]>()

  lines.forEach((line) => {
    const index = line.indexOf(':')
    if (index < 0) {
      return
    }

    const key = line.slice(0, index).split(';')[0].toUpperCase()
    const value = line.slice(index + 1)
    const entries = props.get(key) ?? []
    entries.push(value)
    props.set(key, entries)
  })

  const uid = props.get('UID')?.[0]
  if (!uid) {
    return undefined
  }

  return {
    id: uid,
    uid,
    accountId,
    collectionId,
    title: unescapeIcs(props.get('SUMMARY')?.[0] ?? ''),
    notes: unescapeIcs(props.get('DESCRIPTION')?.[0] ?? ''),
    status: (props.get('STATUS')?.[0]?.toLowerCase() ?? 'needs-action') as TaskItem['status'],
    priority: appPriorityFromRfcPriority(Number.parseInt(props.get('PRIORITY')?.[0] ?? '0', 10) || 0),
    startDate: parseIcsDate(props.get('DTSTART')?.[0]),
    dueDate: parseIcsDate(props.get('DUE')?.[0]),
    completedAt: parseIcsDate(props.get('COMPLETED')?.[0]),
    createdAt: parseIcsDate(props.get('CREATED')?.[0]) ?? new Date().toISOString(),
    updatedAt: parseIcsDate(props.get('LAST-MODIFIED')?.[0]) ?? new Date().toISOString(),
    tagIds: extractHashtags(
      unescapeIcs(props.get('SUMMARY')?.[0] ?? ''),
      unescapeIcs(props.get('DESCRIPTION')?.[0] ?? ''),
    ),
    syncState: 'synced',
  }
}

interface CalendarObject {
  href: string
  etag?: string
  payload?: string
}

function parseCalendarObjects(xmlText: string, baseUrl: string): CalendarObject[] {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml')
  const responses = Array.from(document.getElementsByTagName('*')).filter(
    (element) => element.localName === 'response',
  )

  return responses.reduce<CalendarObject[]>((entries, response) => {
      const href = textContent(firstDescendant(response, 'href'))
      const etag = textContent(firstDescendant(response, 'getetag'))
      const payload = textContent(firstDescendant(response, 'calendar-data'))
      if (!href || !payload) {
        return entries
      }

      entries.push({
        href: resolveUrl(baseUrl, href),
        etag,
        payload,
      })

      return entries
    }, [])
}

async function fetchCollectionObjectsForConnection(
  connection: DavConnection,
  collection: TaskCollection,
  authorization: string,
): Promise<CalendarObject[]> {
  const response = await davRequest(connection, collection.url, {
    method: 'REPORT',
    depth: '1',
    headers: {
      Authorization: authorization,
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
  })

  return parseCalendarObjects(await response.text(), collection.url)
}

async function fetchTaskLocationAndEtag(
  connection: DavConnection,
  collection: TaskCollection,
  authorization: string,
  uid: string,
): Promise<{ url: string; etag?: string } | undefined> {
  const objects = await fetchCollectionObjectsForConnection(connection, collection, authorization)
  const matched = objects.find((entry) => {
    if (entry.href.endsWith(`${uid}.ics`)) {
      return true
    }

    const parsed = parseTaskFromIcs(entry.payload ?? '', collection.accountId, collection.id)
    return parsed?.uid === uid
  })

  return matched
    ? {
        url: matched.href,
        etag: matched.etag,
      }
    : undefined
}

function serializeMetadataDocument(doc: MetadataDocument, taskCollections: TaskCollection[]): string {
  const collectionUrlById = new Map(taskCollections.map((collection) => [collection.id, ensureTrailingSlash(collection.url)]))
  const serializedDoc: MetadataDocument = {
    ...doc,
    collectionParents: Object.fromEntries(
      Object.entries(doc.collectionParents).map(([collectionId, parentId]) => [
        collectionUrlById.get(collectionId) ?? collectionId,
        parentId ? collectionUrlById.get(parentId) ?? parentId : undefined,
      ]),
    ),
    collectionOrder: doc.collectionOrder.map((collectionId) => collectionUrlById.get(collectionId) ?? collectionId),
    smartListOrder: doc.smartListOrder,
    taskListOrderings: Object.fromEntries(
      Object.entries(doc.taskListOrderings).map(([collectionId, ordering]) => [
        collectionUrlById.get(collectionId) ?? collectionId,
        ordering,
      ]),
    ),
    manualTaskOrder: Object.fromEntries(
      Object.entries(doc.manualTaskOrder).map(([collectionId, taskIds]) => [
        collectionUrlById.get(collectionId) ?? collectionId,
        taskIds,
      ]),
    ),
  }

  return JSON.stringify(serializedDoc, null, 2)
}

function metadataTask(
  doc: MetadataDocument,
  collectionId: string,
  taskCollections: TaskCollection[],
): TaskItem {
  return {
    id: 'taskmanager-metadata',
    uid: 'taskmanager-metadata',
    accountId: doc.accountId,
    collectionId,
    title: 'TaskManager Metadata',
    notes: serializeMetadataDocument(doc, taskCollections),
    status: 'needs-action',
    priority: 0,
    createdAt: doc.updatedAt,
    updatedAt: doc.updatedAt,
    tagIds: [],
    syncState: 'synced',
    url: doc.url,
    etag: doc.etag,
  }
}

function extractCollectionRef(value: string): string {
  if (value.includes('://')) {
    return ensureTrailingSlash(value)
  }

  const separatorIndex = value.indexOf(':')
  if (separatorIndex >= 0) {
    return ensureTrailingSlash(value.slice(separatorIndex + 1))
  }

  return value
}

function legacyVisibleCollectionOrder(rawDoc: Record<string, unknown>, taskCollections: TaskCollection[]): string[] {
  const collectionIdByRef = new Map<string, string>()
  taskCollections.forEach((collection) => {
    collectionIdByRef.set(collection.id, collection.id)
    collectionIdByRef.set(ensureTrailingSlash(collection.url), collection.id)
  })

  const orderedRefs = Array.isArray(rawDoc.collectionOrder) ? rawDoc.collectionOrder.map(String) : []
  const baseOrder = orderedRefs
    .map((storedCollectionRef) => collectionIdByRef.get(extractCollectionRef(storedCollectionRef)))
    .filter((collectionId): collectionId is string => Boolean(collectionId))
  const orderedIds = [...baseOrder, ...taskCollections.map((collection) => collection.id).filter((id) => !baseOrder.includes(id))]

  const folderNodes = Array.isArray(rawDoc.folderNodes) ? rawDoc.folderNodes as Array<{ id: string; parentId?: string }> : []
  const collectionFolders = rawDoc.collectionFolders && typeof rawDoc.collectionFolders === 'object'
    ? rawDoc.collectionFolders as Record<string, string | undefined>
    : {}

  if (folderNodes.length === 0 || Object.keys(collectionFolders).length === 0) {
    return orderedIds
  }

  const rootFolders = folderNodes.filter((folder) => !folder.parentId)
  const folderChildren = new Map<string, typeof folderNodes>()
  folderNodes.forEach((folder) => {
    if (!folder.parentId) {
      return
    }
    const entries = folderChildren.get(folder.parentId) ?? []
    entries.push(folder)
    folderChildren.set(folder.parentId, entries)
  })

  const orderedIdsSet = new Set(orderedIds)
  const collectionsByFolder = new Map<string, string[]>()
  orderedIds.forEach((collectionId) => {
    const storedFolderRef = collectionFolders[collectionId] ?? collectionFolders[taskCollections.find((collection) => collection.id === collectionId)?.url ?? '']
    if (!storedFolderRef) {
      return
    }
    const entries = collectionsByFolder.get(storedFolderRef) ?? []
    if (orderedIdsSet.has(collectionId)) {
      entries.push(collectionId)
    }
    collectionsByFolder.set(storedFolderRef, entries)
  })

  const flattened: string[] = []
  const unassigned = orderedIds.filter((collectionId) => {
    const storedFolderRef = collectionFolders[collectionId] ?? collectionFolders[taskCollections.find((collection) => collection.id === collectionId)?.url ?? '']
    return !storedFolderRef
  })
  flattened.push(...unassigned)

  function appendFolder(folderId: string) {
    flattened.push(...(collectionsByFolder.get(folderId) ?? []))
    ;(folderChildren.get(folderId) ?? []).forEach((child) => appendFolder(child.id))
  }

  rootFolders.forEach((folder) => appendFolder(folder.id))
  return [...flattened, ...orderedIds.filter((collectionId) => !flattened.includes(collectionId))]
}

function normalizeMetadataDocument(
  rawDoc: Record<string, unknown>,
  accountId: string,
  taskCollections: TaskCollection[],
  url?: string,
  etag?: string,
): MetadataDocument {
  const collectionIdByRef = new Map<string, string>()
  taskCollections.forEach((collection) => {
    collectionIdByRef.set(collection.id, collection.id)
    collectionIdByRef.set(ensureTrailingSlash(collection.url), collection.id)
  })

  const normalizedCollectionParents = Object.fromEntries(
    Object.entries((rawDoc.collectionParents as Record<string, string | undefined> | undefined) ?? {}).flatMap(([storedCollectionRef, storedParentRef]) => {
      const collectionId = collectionIdByRef.get(extractCollectionRef(storedCollectionRef))
      const parentId = storedParentRef ? collectionIdByRef.get(extractCollectionRef(storedParentRef)) : undefined
      return collectionId ? [[collectionId, parentId]] : []
    }),
  )

  const normalizedCollectionOrder = ((rawDoc.collectionParents as object | undefined) ? (rawDoc.collectionOrder as string[] | undefined) ?? [] : legacyVisibleCollectionOrder(rawDoc, taskCollections)).flatMap((storedCollectionRef) => {
    const collectionId = collectionIdByRef.get(extractCollectionRef(storedCollectionRef))
    return collectionId ? [collectionId] : []
  })
  const normalizedSmartListOrder = Array.isArray(rawDoc.smartListOrder)
    ? rawDoc.smartListOrder.map(String)
    : []
  const normalizedTaskListOrderings = Object.fromEntries(
    Object.entries(rawDoc.taskListOrderings ?? {}).flatMap(([storedCollectionRef, ordering]) => {
      const collectionId = collectionIdByRef.get(extractCollectionRef(storedCollectionRef))
      return collectionId ? [[collectionId, normalizeOrdering(ordering, { mode: 'manual', field: 'dueDate', direction: 'asc' })]] : []
    }),
  )
  const normalizedManualTaskOrder = Object.fromEntries(
    Object.entries(rawDoc.manualTaskOrder ?? {}).flatMap(([storedCollectionRef, taskIds]) => {
      const collectionId = collectionIdByRef.get(extractCollectionRef(storedCollectionRef))
      return collectionId ? [[collectionId, taskIds ?? []]] : []
    }),
  )

  return {
    ...createDefaultMetadata(accountId),
    accountId,
    collectionParents: normalizedCollectionParents,
    collectionOrder: normalizedCollectionOrder,
    smartListOrder: normalizedSmartListOrder,
    taskListOrderings: normalizedTaskListOrderings,
    manualTaskOrder: normalizedManualTaskOrder,
    updatedAt: typeof rawDoc.updatedAt === 'string' ? rawDoc.updatedAt : new Date().toISOString(),
    url,
    etag,
  }
}

function migrateSmartListFilter(
  filter: ReturnType<typeof parseSmartListPayload>['legacyFilter'],
  rawDoc: Record<string, unknown>,
  taskCollections: TaskCollection[],
): ReturnType<typeof parseSmartListPayload>['legacyFilter'] {
  if (!filter) {
    return undefined
  }

  if (filter.collectionIds.length > 0) {
    return filter
  }

  const legacyFolderIds = Array.isArray((filter as { folderIds?: string[] }).folderIds)
    ? (filter as { folderIds?: string[] }).folderIds ?? []
    : []
  if (legacyFolderIds.length === 0) {
    return filter
  }

  const rawFolderNodes = Array.isArray(rawDoc.folderNodes)
    ? (rawDoc.folderNodes as Array<{ id: string; parentId?: string }>)
    : []
  const rawCollectionFolders = rawDoc.collectionFolders && typeof rawDoc.collectionFolders === 'object'
    ? (rawDoc.collectionFolders as Record<string, string | undefined>)
    : {}
  const legacyScope = (filter as { includeSubfolders?: boolean }).includeSubfolders !== false
    ? expandTreeIds(legacyFolderIds, rawFolderNodes)
    : new Set(legacyFolderIds)

  const collectionIdByRef = new Map<string, string>()
  taskCollections.forEach((collection) => {
    collectionIdByRef.set(collection.id, collection.id)
    collectionIdByRef.set(ensureTrailingSlash(collection.url), collection.id)
  })

  const collectionIds = Object.entries(rawCollectionFolders).flatMap(([storedCollectionRef, folderId]) => {
    const collectionId = collectionIdByRef.get(extractCollectionRef(storedCollectionRef))
    return collectionId && folderId && legacyScope.has(folderId) ? [collectionId] : []
  })

  return {
    ...filter,
    collectionIds,
    includeDescendantCollections: (filter as { includeSubfolders?: boolean }).includeSubfolders !== false,
  }
}

function smartListTask(smartList: SmartList, collectionId: string): TaskItem {
  return {
    id: smartList.id,
    uid: `smart-${smartList.id}`,
    accountId: smartList.accountId,
    collectionId,
    title: smartList.name,
    notes: serializeSmartListPayload(smartList),
    status: 'needs-action',
    priority: 0,
    createdAt: smartList.updatedAt,
    updatedAt: smartList.updatedAt,
    tagIds: [],
    syncState: 'synced',
  }
}

function taskToIcs(task: TaskItem): string {
  const categoryNames = task.tagIds
    .map((tag) => tag.replace(/^#/, ''))
    .map(escapeIcs)
    .join(',')

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TaskManagerWebDav//EN',
    'BEGIN:VTODO',
    `UID:${task.uid}`,
    `DTSTAMP:${formatIcsDate(new Date().toISOString())}`,
    `SUMMARY:${escapeIcs(task.title)}`,
    `DESCRIPTION:${escapeIcs(task.notes)}`,
    `STATUS:${task.status.toUpperCase()}`,
    `PRIORITY:${rfcPriorityFromAppPriority(task.priority)}`,
    `CREATED:${formatIcsDate(task.createdAt)}`,
    `LAST-MODIFIED:${formatIcsDate(task.updatedAt)}`,
  ]

  if (categoryNames) {
    lines.push(`CATEGORIES:${categoryNames}`)
  }
  if (task.startDate) {
    lines.push(`DTSTART:${formatIcsDate(task.startDate)}`)
  }
  if (task.dueDate) {
    lines.push(`DUE:${formatIcsDate(task.dueDate)}`)
  }
  if (task.completedAt) {
    lines.push(`COMPLETED:${formatIcsDate(task.completedAt)}`)
  }

  lines.push('END:VTODO', 'END:VCALENDAR', '')
  return lines.join('\r\n')
}

export async function syncAccount(account: Account, collections: TaskCollection[]): Promise<SyncResult> {
  const authorization = authHeader(account.username, account.password)
  const connection = connectionFromAccount(account)
  const metadataCollection = collections.find((collection) => collection.kind === 'metadata')
  const smartCollection = collections.find((collection) => collection.kind === 'smart')
  const taskCollections = collections.filter((collection) => collection.kind === 'task')
  if (!metadataCollection || !smartCollection) {
    throw new Error('Required hidden TaskManager collections are missing.')
  }

  const metadataEntries = await fetchCollectionObjectsForConnection(connection, metadataCollection, authorization)
  const metadataEntry =
    metadataEntries.find((entry) => entry.href.endsWith(METADATA_RESOURCE_NAME)) ?? metadataEntries[0]
  const defaultMetadata = createDefaultMetadata(account.id)
  let metadataDoc = defaultMetadata
  let rawMetadataDoc: Record<string, unknown> = defaultMetadata as unknown as Record<string, unknown>
  if (metadataEntry?.payload) {
    try {
      const parsedMetadataTask = parseTaskFromIcs(metadataEntry.payload, account.id, metadataCollection.id)
      rawMetadataDoc = {
        ...defaultMetadata,
        ...JSON.parse(parsedMetadataTask?.notes ?? '{}'),
      }
      metadataDoc = normalizeMetadataDocument(
        rawMetadataDoc,
        account.id,
        taskCollections,
        metadataEntry.href,
        metadataEntry.etag,
      )
    } catch {
      metadataDoc = defaultMetadata
    }
  }

  const taskLists = await Promise.all(
    taskCollections.map(async (collection) => {
      const objects = await fetchCollectionObjectsForConnection(connection, collection, authorization)
      return objects.reduce<TaskItem[]>((entries, entry) => {
        const task = parseTaskFromIcs(entry.payload ?? '', account.id, collection.id)
        if (task) {
          entries.push({
            ...task,
            url: entry.href,
            etag: entry.etag,
            syncState: 'synced',
          })
        }
        return entries
      }, [])
    }),
  )

  const smartEntries = await fetchCollectionObjectsForConnection(connection, smartCollection, authorization)
  const smartLists = smartEntries.reduce<SmartList[]>((entries, entry) => {
      const task = parseTaskFromIcs(entry.payload ?? '', account.id, smartCollection.id)
      if (!task) {
        return entries
      }
      const parsedPayload = parseSmartListPayload(task.notes)
      const migratedFilter = migrateSmartListFilter(parsedPayload.legacyFilter, rawMetadataDoc, taskCollections)
      const definition =
        parsedPayload.definition || (migratedFilter ? smartListDefinitionFromFilter(migratedFilter, taskCollections) : '')

      entries.push({
        id: task.id,
        accountId: task.accountId,
        definition,
        name: task.title,
        filter: migratedFilter ?? defaultFilter(),
        ordering: parsedPayload.ordering ?? defaultSmartListOrdering(),
        url: entry.href,
        etag: entry.etag,
        syncState: 'synced' as const,
        updatedAt: task.updatedAt,
      })

      return entries
    }, [])

  return {
    tasks: taskLists.flat(),
    collections,
    metadataDoc,
    smartLists,
  }
}

export async function upsertTaskRemote(
  account: Account,
  collection: TaskCollection,
  task: TaskItem,
): Promise<{ url: string; etag?: string }> {
  const connection = connectionFromAccount(account)
  const url = task.url ?? resolveUrl(collection.url, `${task.uid}.ics`)
  const authorization = authHeader(account.username, account.password)
  const headers: Record<string, string> = {
    Authorization: authorization,
    'Content-Type': 'text/calendar; charset=utf-8',
  }

  if (task.etag) {
    headers['If-Match'] = task.etag
  } else {
    headers['If-None-Match'] = '*'
  }

  const response = await davRequest(connection, url, {
    method: 'PUT',
    headers,
    body: taskToIcs(task),
  })

  if (!response.ok && ![201, 204].includes(response.status)) {
    const message = await response.text()
    throw new Error(`Task save failed (${response.status}): ${message}`)
  }

  let remoteUrl = url
  let etag = response.headers.get('etag') ?? response.headers.get('ETag') ?? undefined

  if (!etag) {
    try {
      etag = (await fetchResourceEtag(connection, url, authorization)) ?? undefined
    } catch (error) {
      const isNotFound = error instanceof Error && error.message.includes('PROPFIND') && error.message.includes('(404)')
      if (!isNotFound) {
        throw error
      }
    }
  }

  if (!etag) {
    const discovered = await fetchTaskLocationAndEtag(connection, collection, authorization, task.uid)
    if (discovered) {
      remoteUrl = discovered.url
      etag = discovered.etag
    }
  }

  return {
    url: remoteUrl,
    etag,
  }
}

export async function deleteTaskRemote(account: Account, task: TaskItem): Promise<void> {
  if (!task.url) {
    return
  }

  const headers: Record<string, string> = {
    Authorization: authHeader(account.username, account.password),
  }

  if (task.etag) {
    headers['If-Match'] = task.etag
  }

  const connection = connectionFromAccount(account)
  const response = await davRequest(connection, task.url, {
    method: 'DELETE',
    allowStatuses: [404],
    headers,
  })

  if (!response.ok && response.status !== 404) {
    const message = await response.text()
    throw new Error(`Task delete failed (${response.status}): ${message}`)
  }
}

export async function saveMetadataRemote(
  account: Account,
  collection: TaskCollection,
  metadataDoc: MetadataDocument,
  taskCollections: TaskCollection[],
): Promise<{ url: string; etag?: string }> {
  const metadataTaskItem = (
    targetCollection: TaskCollection,
    targetDoc: MetadataDocument,
    targetUrl = targetDoc.url ?? resolveUrl(targetCollection.url, METADATA_RESOURCE_NAME),
    etag = targetDoc.etag,
  ): TaskItem => ({
    ...metadataTask(targetDoc, targetCollection.id, taskCollections),
    url: targetUrl,
    etag,
  })

  try {
    return await upsertTaskRemote(account, collection, metadataTaskItem(collection, metadataDoc))
  } catch (error) {
    const isNotFoundFailure =
      error instanceof Error && error.message.includes('Task save failed (404)')
    const isPreconditionFailure =
      error instanceof Error && error.message.includes('Task save failed (412)')

    if (isNotFoundFailure) {
      const rediscovered = await discoverAccount(connectionInputFromAccount(account), account.id)
      const refreshedCollection = rediscovered.collections.find((entry) => entry.kind === 'metadata')
      if (!refreshedCollection) {
        throw error
      }

      const refreshedDoc = {
        ...metadataDoc,
        url: resolveUrl(refreshedCollection.url, METADATA_RESOURCE_NAME),
        etag: undefined,
      }

      return upsertTaskRemote(
        account,
        refreshedCollection,
        metadataTaskItem(refreshedCollection, refreshedDoc),
      )
    }

    if (!isPreconditionFailure) {
      throw error
    }

    const url = metadataDoc.url ?? resolveUrl(collection.url, METADATA_RESOURCE_NAME)
    const latestEtag = await fetchResourceEtag(connectionFromAccount(account), url, authHeader(account.username, account.password))
    return upsertTaskRemote(account, collection, metadataTaskItem(collection, metadataDoc, url, latestEtag))
  }
}

export async function upsertSmartListRemote(
  account: Account,
  collection: TaskCollection,
  smartList: SmartList,
): Promise<{ url: string; etag?: string }> {
  return upsertTaskRemote(
    account,
    collection,
    {
      ...smartListTask(smartList, collection.id),
      url: smartList.url ?? resolveUrl(collection.url, `smart-${smartList.id}.ics`),
      etag: smartList.etag,
    },
  )
}

export async function deleteSmartListRemote(account: Account, smartList: SmartList): Promise<void> {
  await deleteTaskRemote(account, {
    id: smartList.id,
    uid: `smart-${smartList.id}`,
    accountId: smartList.accountId,
    collectionId: '',
    title: smartList.name,
    notes: '',
    status: 'needs-action',
    priority: 0,
    createdAt: smartList.updatedAt,
    updatedAt: smartList.updatedAt,
    tagIds: [],
    syncState: 'synced',
    url: smartList.url,
    etag: smartList.etag,
  })
}
