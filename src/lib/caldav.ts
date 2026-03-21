import { createDefaultMetadata, parseFilter, serializeFilter } from './filters'
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

function isMetadataCollectionUrl(url: string): boolean {
  return (
    url.endsWith('/taskmanager-meta/') ||
    url.endsWith('/.taskmanager-meta/')
  )
}

function isSmartCollectionUrl(url: string): boolean {
  return (
    url.endsWith('/taskmanager-smart/') ||
    url.endsWith('/.taskmanager-smart/')
  )
}

function authHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function resolveUrl(base: string, href: string): string {
  return new URL(href, base).toString()
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

async function davRequest(
  url: string,
  init: RequestInit & { depth?: '0' | '1' } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.depth) {
    headers.set('Depth', init.depth)
  }
  headers.set('Content-Type', headers.get('Content-Type') ?? 'application/xml; charset=utf-8')

  const response = await fetch(url, {
    ...init,
    headers,
  })

  if (!response.ok && response.status !== 207) {
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
  url: string,
  authorization: string,
  body: string,
  depth: '0' | '1',
): Promise<DiscoveredCollection[]> {
  const response = await davRequest(url, {
    method: 'PROPFIND',
    depth,
    headers: {
      Authorization: authorization,
    },
    body,
  })

  return parseMultiStatus(await response.text(), url)
}

async function discoverHomeSet(input: AccountConnectionInput): Promise<{ displayName: string; homeSetUrl: string }> {
  const authorization = authHeader(input.username, input.password)
  const serverUrl = ensureTrailingSlash(input.serverUrl)
  const rootResponse = await davRequest(serverUrl, {
    method: 'PROPFIND',
    depth: '0',
    headers: {
      Authorization: authorization,
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
        <d:prop>
          <d:displayname />
          <d:current-user-principal />
          <cs:calendar-home-set />
        </d:prop>
      </d:propfind>`,
  })

  const rootXml = new DOMParser().parseFromString(await rootResponse.text(), 'application/xml')
  const rootDisplayName = textContent(
    Array.from(rootXml.getElementsByTagName('*')).find((element) => element.localName === 'displayname') ?? null,
  )
  const rootHomeSet = textContent(
    firstDescendant(
      Array.from(rootXml.getElementsByTagName('*')).find((element) => element.localName === 'calendar-home-set') ??
        rootXml.documentElement,
      'href',
    ),
  )

  if (rootHomeSet) {
    return {
      displayName: rootDisplayName ?? input.label ?? input.username,
      homeSetUrl: ensureTrailingSlash(resolveUrl(serverUrl, rootHomeSet)),
    }
  }

  const principalHref = textContent(
    firstDescendant(
      Array.from(rootXml.getElementsByTagName('*')).find((element) => element.localName === 'current-user-principal') ??
        rootXml.documentElement,
      'href',
    ),
  )

  if (!principalHref) {
    return {
      displayName: rootDisplayName ?? input.label ?? input.username,
      homeSetUrl: serverUrl,
    }
  }

  const principalUrl = resolveUrl(serverUrl, principalHref)
  const principalResponse = await davRequest(principalUrl, {
    method: 'PROPFIND',
    depth: '0',
    headers: {
      Authorization: authorization,
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
      <d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
        <d:prop>
          <d:displayname />
          <cs:calendar-home-set />
        </d:prop>
      </d:propfind>`,
  })

  const principalXml = new DOMParser().parseFromString(await principalResponse.text(), 'application/xml')
  const displayName =
    textContent(
      Array.from(principalXml.getElementsByTagName('*')).find((element) => element.localName === 'displayname') ?? null,
    ) ??
    rootDisplayName ??
    input.label ??
    input.username

  const homeSetHref = textContent(
    firstDescendant(
      Array.from(principalXml.getElementsByTagName('*')).find((element) => element.localName === 'calendar-home-set') ??
        principalXml.documentElement,
      'href',
    ),
  )

  return {
    displayName,
    homeSetUrl: ensureTrailingSlash(resolveUrl(principalUrl, homeSetHref ?? './')),
  }
}

async function mkcalendar(url: string, authorization: string, displayName: string): Promise<void> {
  const response = await fetch(url, {
    method: 'MKCALENDAR',
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
}

async function ensureHiddenCollections(
  homeSetUrl: string,
  authorization: string,
  collections: DiscoveredCollection[],
): Promise<DiscoveredCollection[]> {
  const knownUrls = new Set(collections.map((collection) => ensureTrailingSlash(collection.url)))
  const required = [
    { slug: METADATA_COLLECTION_NAME, displayName: 'TaskManager Metadata' },
    { slug: SMART_COLLECTION_NAME, displayName: 'TaskManager Smart Lists' },
  ]

  for (const target of required) {
    const collectionUrl = ensureTrailingSlash(resolveUrl(homeSetUrl, `${target.slug}/`))
    if (!knownUrls.has(collectionUrl)) {
      await mkcalendar(collectionUrl, authorization, target.displayName)
    }
  }

  return propfind(
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

  const refreshedCollections = await ensureHiddenCollections(homeSetUrl, authorization, collections)

  return {
    accountDisplayName: displayName,
    collections: refreshedCollections
      .filter((collection) => collection.isCalendar && collection.supportsVtodo)
      .map((collection) => {
        const url = ensureTrailingSlash(collection.url)
        const isMetadata = isMetadataCollectionUrl(url)
        const isSmart = isSmartCollectionUrl(url)
        return {
          id: `${accountId}:${url}`,
          accountId,
          url,
          displayName: collection.displayName,
          kind: isMetadata ? 'metadata' : isSmart ? 'smart' : 'task',
          syncToken: collection.syncToken,
        } as TaskCollection
      }),
  }
}

function slugifyCollectionName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'tasks'
}

export async function createTaskCollection(account: Account, displayName: string): Promise<TaskCollection> {
  const authorization = authHeader(account.username, account.password)
  const { homeSetUrl } = await discoverHomeSet({
    label: account.label,
    serverUrl: account.serverUrl,
    username: account.username,
    password: account.password,
  })

  const collections = await propfind(
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
  const slugBase = slugifyCollectionName(displayName)
  let slug = slugBase
  let counter = 2
  let targetUrl = ensureTrailingSlash(resolveUrl(homeSetUrl, `${slug}/`))

  while (takenUrls.has(targetUrl)) {
    slug = `${slugBase}-${counter}`
    counter += 1
    targetUrl = ensureTrailingSlash(resolveUrl(homeSetUrl, `${slug}/`))
  }

  await mkcalendar(targetUrl, authorization, displayName.trim())

  return {
    id: `${account.id}:${targetUrl}`,
    accountId: account.id,
    url: targetUrl,
    displayName: displayName.trim(),
    kind: 'task',
  }
}

export async function deleteTaskCollection(account: Account, collection: TaskCollection): Promise<void> {
  const response = await fetch(collection.url, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader(account.username, account.password),
    },
  })

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
    priority: Number.parseInt(props.get('PRIORITY')?.[0] ?? '0', 10) || 0,
    startDate: parseIcsDate(props.get('DTSTART')?.[0]),
    dueDate: parseIcsDate(props.get('DUE')?.[0]),
    completedAt: parseIcsDate(props.get('COMPLETED')?.[0]),
    createdAt: parseIcsDate(props.get('CREATED')?.[0]) ?? new Date().toISOString(),
    updatedAt: parseIcsDate(props.get('LAST-MODIFIED')?.[0]) ?? new Date().toISOString(),
    tagIds: props.get('X-TASKMANAGER-TAGS')?.[0]?.split(',').filter(Boolean) ?? [],
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

async function fetchCollectionObjects(collection: TaskCollection, authorization: string): Promise<CalendarObject[]> {
  const response = await davRequest(collection.url, {
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

function metadataTask(doc: MetadataDocument, collectionId: string): TaskItem {
  return {
    id: 'taskmanager-metadata',
    uid: 'taskmanager-metadata',
    accountId: doc.accountId,
    collectionId,
    title: 'TaskManager Metadata',
    notes: JSON.stringify(doc, null, 2),
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

function smartListTask(smartList: SmartList, collectionId: string): TaskItem {
  return {
    id: smartList.id,
    uid: `smart-${smartList.id}`,
    accountId: smartList.accountId,
    collectionId,
    title: smartList.name,
    notes: serializeFilter(smartList.filter),
    status: 'needs-action',
    priority: 0,
    createdAt: smartList.updatedAt,
    updatedAt: smartList.updatedAt,
    tagIds: [],
    syncState: 'synced',
  }
}

function taskToIcs(task: TaskItem, metadataDoc: MetadataDocument): string {
  const tagNameById = new Map(metadataDoc.tagNodes.map((tag) => [tag.id, tag.name]))
  const categoryNames = task.tagIds
    .map((tagId) => tagNameById.get(tagId))
    .filter((tagName): tagName is string => Boolean(tagName))
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
    `PRIORITY:${task.priority}`,
    `CREATED:${formatIcsDate(task.createdAt)}`,
    `LAST-MODIFIED:${formatIcsDate(task.updatedAt)}`,
    `X-TASKMANAGER-TAGS:${task.tagIds.join(',')}`,
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
  const metadataCollection = collections.find((collection) => collection.kind === 'metadata')
  const smartCollection = collections.find((collection) => collection.kind === 'smart')
  if (!metadataCollection || !smartCollection) {
    throw new Error('Required hidden TaskManager collections are missing.')
  }

  const metadataEntries = await fetchCollectionObjects(metadataCollection, authorization)
  const metadataEntry =
    metadataEntries.find((entry) => entry.href.endsWith(METADATA_RESOURCE_NAME)) ?? metadataEntries[0]
  const defaultMetadata = createDefaultMetadata(account.id)
  let metadataDoc = defaultMetadata
  if (metadataEntry?.payload) {
    try {
      const metadataTask = parseTaskFromIcs(metadataEntry.payload, account.id, metadataCollection.id)
      metadataDoc = {
        ...defaultMetadata,
        ...JSON.parse(metadataTask?.notes ?? '{}'),
        accountId: account.id,
        url: metadataEntry.href,
        etag: metadataEntry.etag,
      }
    } catch {
      metadataDoc = defaultMetadata
    }
  }

  const taskCollections = collections.filter((collection) => collection.kind === 'task')
  const taskLists = await Promise.all(
    taskCollections.map(async (collection) => {
      const objects = await fetchCollectionObjects(collection, authorization)
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

  const smartEntries = await fetchCollectionObjects(smartCollection, authorization)
  const smartLists = smartEntries.reduce<SmartList[]>((entries, entry) => {
      const task = parseTaskFromIcs(entry.payload ?? '', account.id, smartCollection.id)
      if (!task) {
        return entries
      }

      entries.push({
        id: task.id,
        accountId: task.accountId,
        name: task.title,
        filter: parseFilter(task.notes),
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
  metadataDoc: MetadataDocument,
): Promise<{ url: string; etag?: string }> {
  const url = task.url ?? resolveUrl(collection.url, `${task.uid}.ics`)
  const headers: Record<string, string> = {
    Authorization: authHeader(account.username, account.password),
    'Content-Type': 'text/calendar; charset=utf-8',
  }

  if (task.etag) {
    headers['If-Match'] = task.etag
  } else {
    headers['If-None-Match'] = '*'
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: taskToIcs(task, metadataDoc),
  })

  if (!response.ok && ![201, 204].includes(response.status)) {
    const message = await response.text()
    throw new Error(`Task save failed (${response.status}): ${message}`)
  }

  return {
    url,
    etag: response.headers.get('etag') ?? undefined,
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

  const response = await fetch(task.url, {
    method: 'DELETE',
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
): Promise<{ url: string; etag?: string }> {
  return upsertTaskRemote(
    account,
    collection,
    {
      ...metadataTask(metadataDoc, collection.id),
      url: metadataDoc.url ?? resolveUrl(collection.url, METADATA_RESOURCE_NAME),
    },
    metadataDoc,
  )
}

export async function upsertSmartListRemote(
  account: Account,
  collection: TaskCollection,
  smartList: SmartList,
  metadataDoc: MetadataDocument,
): Promise<{ url: string; etag?: string }> {
  return upsertTaskRemote(
    account,
    collection,
    {
      ...smartListTask(smartList, collection.id),
      url: smartList.url ?? resolveUrl(collection.url, `smart-${smartList.id}.ics`),
      etag: smartList.etag,
    },
    metadataDoc,
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
