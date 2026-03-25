import type {
  MetadataDocument,
  SmartList,
  SortDirection,
  TaskCollection,
  TaskFilter,
  TaskItem,
  TaskOrderField,
  TaskOrdering,
} from '../types'

type SmartListToken =
  | { kind: 'and' | 'or' | 'not' | 'lparen' | 'rparen' }
  | { kind: 'term'; value: string }

type SmartListAst =
  | { kind: 'term'; value: string }
  | { kind: 'not'; child: SmartListAst }
  | { kind: 'and' | 'or'; left: SmartListAst; right: SmartListAst }

export const defaultFilter = (): TaskFilter => ({
  query: '',
  statuses: [],
  tagIds: [],
  includeDescendantTags: true,
  collectionIds: [],
  includeDescendantCollections: true,
  datePreset: 'any',
})

export function createDefaultMetadata(accountId: string): MetadataDocument {
  return {
    accountId,
    version: 2,
    tagNodes: [],
    collectionParents: {},
    collectionOrder: [],
    smartListOrder: [],
    taskListOrderings: {},
    taskListShowCompleted: {},
    manualTaskOrder: {},
    updatedAt: new Date().toISOString(),
  }
}

export function defaultTaskListOrdering(): TaskOrdering {
  return {
    mode: 'manual',
    field: 'dueDate',
    direction: 'asc',
  }
}

export function defaultSmartListOrdering(): TaskOrdering {
  return {
    mode: 'property',
    field: 'dueDate',
    direction: 'asc',
  }
}

export function normalizeOrdering(
  ordering: Partial<TaskOrdering> | undefined,
  fallback: TaskOrdering,
): TaskOrdering {
  return {
    mode: ordering?.mode === 'property' ? 'property' : fallback.mode,
    field: isTaskOrderField(ordering?.field) ? ordering.field : fallback.field,
    direction: isSortDirection(ordering?.direction) ? ordering.direction : fallback.direction,
  }
}

export function extractHashtags(...parts: Array<string | undefined>): string[] {
  const matches = new Set<string>()
  const pattern = /(^|[\s(])#([\p{L}\p{N}_-]+)/gu

  parts.forEach((part) => {
    if (!part) {
      return
    }

    let match: RegExpExecArray | null
    while ((match = pattern.exec(part)) !== null) {
      matches.add(`#${match[2].toLowerCase()}`)
    }
  })

  return Array.from(matches).sort()
}

export function serializeSmartListPayload(smartList: Pick<SmartList, 'definition' | 'ordering' | 'showCompleted'>): string {
  return JSON.stringify(
    {
      definition: smartList.definition,
      ordering: smartList.ordering,
      showCompleted: smartList.showCompleted,
    },
    null,
    2,
  )
}

export function parseFilter(value: string): TaskFilter {
  try {
    const parsed = JSON.parse(value) as Partial<TaskFilter>
    return {
      ...defaultFilter(),
      ...parsed,
      statuses: parsed.statuses ?? [],
      tagIds: (parsed.tagIds ?? []).map(normalizeHashtag).filter(Boolean),
      collectionIds: parsed.collectionIds ?? [],
    }
  } catch {
    return defaultFilter()
  }
}

export function parseSmartListPayload(value: string): {
  definition: string
  ordering: TaskOrdering
  showCompleted: boolean
  legacyFilter?: TaskFilter
} {
  try {
    const parsed = JSON.parse(value) as {
      definition?: string
      filter?: Partial<TaskFilter>
      ordering?: Partial<TaskOrdering>
      showCompleted?: boolean
    }

    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.definition === 'string') {
        return {
          definition: parsed.definition,
          ordering: normalizeOrdering(parsed.ordering, defaultSmartListOrdering()),
          showCompleted: parsed.showCompleted === true,
        }
      }

      if ('filter' in parsed) {
        const legacyFilter = parseFilter(JSON.stringify(parsed.filter ?? {}))
        return {
          definition: '',
          legacyFilter,
          ordering: normalizeOrdering(parsed.ordering, defaultSmartListOrdering()),
          showCompleted: parsed.showCompleted === true,
        }
      }
    }
  } catch {
    // Fall through to legacy string handling.
  }

  return {
    definition: value.trim(),
    ordering: defaultSmartListOrdering(),
    showCompleted: false,
  }
}

function isTaskOrderField(value: unknown): value is TaskOrderField {
  return ['dueDate', 'startDate', 'priority', 'title', 'createdAt', 'updatedAt', 'status'].includes(
    String(value),
  )
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === 'asc' || value === 'desc'
}

export function expandTreeIds(ids: string[], tree: Array<{ id: string; parentId?: string }>): Set<string> {
  const scope = new Set(ids)
  let expanded = true

  while (expanded) {
    expanded = false
    tree.forEach((node) => {
      if (node.parentId && scope.has(node.parentId) && !scope.has(node.id)) {
        scope.add(node.id)
        expanded = true
      }
    })
  }

  return scope
}

function tagScope(filter: TaskFilter): Set<string> | undefined {
  if (filter.tagIds.length === 0) {
    return undefined
  }

  return new Set(filter.tagIds.map(normalizeHashtag).filter(Boolean))
}

function collectionScope(
  filter: TaskFilter,
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): Set<string> | undefined {
  if (filter.collectionIds.length === 0) {
    return undefined
  }

  const listTree = collections
    .filter((collection) => collection.kind === 'task')
    .map((collection) => ({
      id: collection.id,
      parentId: metadataDoc.collectionParents[collection.id],
    }))

  const allowedCollections = filter.includeDescendantCollections
    ? expandTreeIds(filter.collectionIds, listTree)
    : new Set(filter.collectionIds)

  return new Set(
    collections
      .filter((collection) => collection.kind === 'task' && allowedCollections.has(collection.id))
      .map((collection) => collection.id),
  )
}

function matchesDate(task: TaskItem, filter: TaskFilter): boolean {
  if (filter.datePreset === 'any') {
    return true
  }

  const candidate = task.dueDate ?? task.startDate
  return matchesDateValue(candidate, task.status, filter)
}

function matchesDateValue(
  candidate: string | undefined,
  taskStatus: TaskItem['status'],
  filter: Pick<TaskFilter, 'datePreset' | 'customFrom' | 'customTo'>,
): boolean {
  if (!candidate) {
    return false
  }

  const date = new Date(candidate)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (filter.datePreset === 'overdue') {
    return date < today && taskStatus !== 'completed'
  }

  if (filter.datePreset === 'today') {
    const end = new Date(today)
    end.setHours(23, 59, 59, 999)
    return date >= today && date <= end
  }

  const upcomingWindow = parseUpcomingDays(filter.datePreset)
  if (upcomingWindow !== undefined) {
    const end = new Date(today)
    end.setDate(end.getDate() + upcomingWindow)
    end.setHours(23, 59, 59, 999)
    return date >= today && date <= end
  }

  const from = filter.customFrom ? new Date(filter.customFrom) : undefined
  const to = filter.customTo ? new Date(filter.customTo) : undefined

  if (from && date < from) {
    return false
  }

  if (to) {
    const end = new Date(to)
    end.setHours(23, 59, 59, 999)
    if (date > end) {
      return false
    }
  }

  return true
}

export function taskMatchesFilter(
  task: TaskItem,
  filter: TaskFilter,
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): boolean {
  const query = filter.query.trim().toLowerCase()
  if (query) {
    const haystack = `${task.title} ${task.notes}`.toLowerCase()
    if (!haystack.includes(query)) {
      return false
    }
  }

  if (filter.statuses.length > 0 && !filter.statuses.includes(task.status)) {
    return false
  }

  const taskTags = new Set(task.tagIds.map(normalizeHashtag).filter(Boolean))
  const allowedTags = tagScope(filter)
  if (allowedTags && !Array.from(allowedTags).some((tag) => taskTags.has(tag))) {
    return false
  }

  const allowedCollections = collectionScope(filter, metadataDoc, collections)
  if (allowedCollections && !allowedCollections.has(task.collectionId)) {
    return false
  }

  return matchesDate(task, filter)
}

export function getSmartListCount(
  smartList: SmartList,
  tasks: TaskItem[],
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): number {
  return tasks.filter((task) => taskMatchesSmartList(task, smartList, metadataDoc, collections)).length
}

function compareStrings(left: string | undefined, right: string | undefined, direction: SortDirection): number {
  const leftValue = left ?? ''
  const rightValue = right ?? ''
  const result = leftValue.localeCompare(rightValue)
  return direction === 'asc' ? result : -result
}

function compareNumbers(left: number | undefined, right: number | undefined, direction: SortDirection): number {
  const leftValue = left ?? 0
  const rightValue = right ?? 0
  const result = leftValue - rightValue
  return direction === 'asc' ? result : -result
}

function compareByOrdering(left: TaskItem, right: TaskItem, ordering: TaskOrdering): number {
  switch (ordering.field) {
    case 'priority':
      return compareNumbers(left.priority, right.priority, ordering.direction)
    case 'title':
      return compareStrings(left.title, right.title, ordering.direction)
    case 'createdAt':
      return compareStrings(left.createdAt, right.createdAt, ordering.direction)
    case 'updatedAt':
      return compareStrings(left.updatedAt, right.updatedAt, ordering.direction)
    case 'status':
      return compareStrings(left.status, right.status, ordering.direction)
    case 'startDate':
      return compareStrings(left.startDate, right.startDate, ordering.direction)
    case 'dueDate':
    default:
      return compareStrings(left.dueDate, right.dueDate, ordering.direction)
  }
}

export function sortTasks(
  tasks: TaskItem[],
  ordering: TaskOrdering,
  manualTaskIds: string[] = [],
): TaskItem[] {
  const openTasks = tasks.filter((task) => task.status !== 'completed')
  const completedTasks = tasks.filter((task) => task.status === 'completed')

  const orderedOpenTasks =
    ordering.mode === 'manual'
      ? sortManualTasks(openTasks, manualTaskIds)
      : [...openTasks].sort((left, right) => compareTaskWithFallback(left, right, ordering))

  const orderedCompletedTasks = [...completedTasks].sort((left, right) =>
    compareTaskWithFallback(left, right, {
      ...ordering,
      mode: 'property',
    }),
  )

  return [...orderedOpenTasks, ...orderedCompletedTasks]
}

function sortManualTasks(tasks: TaskItem[], manualTaskIds: string[]): TaskItem[] {
  const orderIndex = new Map(manualTaskIds.map((taskId, index) => [taskId, index]))

  return [...tasks].sort((left, right) => {
    const leftIndex = orderIndex.get(left.id)
    const rightIndex = orderIndex.get(right.id)

    if (leftIndex !== undefined && rightIndex !== undefined) {
      return leftIndex - rightIndex
    }
    if (leftIndex !== undefined) {
      return -1
    }
    if (rightIndex !== undefined) {
      return 1
    }

    return compareTaskWithFallback(left, right, {
      mode: 'property',
      field: 'createdAt',
      direction: 'asc',
    })
  })
}

function compareTaskWithFallback(left: TaskItem, right: TaskItem, ordering: TaskOrdering): number {
  const comparisons = [
    compareByOrdering(left, right, ordering),
    compareStrings(left.updatedAt, right.updatedAt, 'desc'),
    compareStrings(left.title, right.title, 'asc'),
    compareStrings(left.id, right.id, 'asc'),
  ]

  return comparisons.find((value) => value !== 0) ?? 0
}

function normalizeHashtag(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return ''
  }
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

function tokenizeSmartListDefinition(definition: string): SmartListToken[] {
  const tokens: SmartListToken[] = []
  let index = 0

  while (index < definition.length) {
    const current = definition[index]

    if (/\s/.test(current)) {
      index += 1
      continue
    }

    if (current === '&') {
      tokens.push({ kind: 'and' })
      index += 1
      continue
    }

    if (current === '|') {
      tokens.push({ kind: 'or' })
      index += 1
      continue
    }

    if (current === '!') {
      tokens.push({ kind: 'not' })
      index += 1
      continue
    }

    if (current === '(') {
      tokens.push({ kind: 'lparen' })
      index += 1
      continue
    }

    if (current === ')') {
      tokens.push({ kind: 'rparen' })
      index += 1
      continue
    }

    if (current === '"') {
      let value = ''
      index += 1
      while (index < definition.length && definition[index] !== '"') {
        if (definition[index] === '\\' && index + 1 < definition.length) {
          index += 1
        }
        value += definition[index]
        index += 1
      }
      if (index >= definition.length) {
        throw new Error('Unterminated quoted string in smart list definition.')
      }
      index += 1
      tokens.push({ kind: 'term', value })
      continue
    }

    const colonQuoteMatch = definition.slice(index).match(/^([a-z_]+):"((?:[^"\\]|\\.)*)"/i)
    if (colonQuoteMatch) {
      tokens.push({
        kind: 'term',
        value: `${colonQuoteMatch[1]}:${colonQuoteMatch[2].replace(/\\"/g, '"')}`,
      })
      index += colonQuoteMatch[0].length
      continue
    }

    let end = index
    while (end < definition.length && !/[\s&|!()]/.test(definition[end])) {
      end += 1
    }
    tokens.push({ kind: 'term', value: definition.slice(index, end) })
    index = end
  }

  return tokens
}

function parseSmartListDefinition(definition: string): SmartListAst | undefined {
  const tokens = tokenizeSmartListDefinition(definition.trim())
  if (tokens.length === 0) {
    return undefined
  }

  let index = 0

  function parseOr(): SmartListAst {
    let left = parseAnd()
    while (tokens[index]?.kind === 'or') {
      index += 1
      left = {
        kind: 'or',
        left,
        right: parseAnd(),
      }
    }
    return left
  }

  function parseAnd(): SmartListAst {
    let left = parseUnary()
    while (tokens[index]?.kind === 'and') {
      index += 1
      left = {
        kind: 'and',
        left,
        right: parseUnary(),
      }
    }
    return left
  }

  function parseUnary(): SmartListAst {
    const token = tokens[index]
    if (!token) {
      throw new Error('Unexpected end of smart list definition.')
    }

    if (token.kind === 'not') {
      index += 1
      return {
        kind: 'not',
        child: parseUnary(),
      }
    }

    if (token.kind === 'lparen') {
      index += 1
      const expression = parseOr()
      if (tokens[index]?.kind !== 'rparen') {
        throw new Error('Missing closing parenthesis in smart list definition.')
      }
      index += 1
      return expression
    }

    if (token.kind === 'term') {
      index += 1
      return {
        kind: 'term',
        value: token.value,
      }
    }

    throw new Error('Invalid smart list definition.')
  }

  const ast = parseOr()
  if (index !== tokens.length) {
    throw new Error('Invalid trailing tokens in smart list definition.')
  }

  return ast
}

function fullTextMatch(task: TaskItem, needle: string): boolean {
  const haystack = `${task.title} ${task.notes}`.toLowerCase()
  return haystack.includes(needle.toLowerCase())
}

function taskMatchesStatusAlias(task: TaskItem, value: string): boolean {
  const normalized = value.toLowerCase()
  if (normalized === 'open') {
    return task.status === 'needs-action' || task.status === 'in-process'
  }
  if (normalized === 'completed') {
    return task.status === 'completed'
  }
  if (normalized === 'in-progress') {
    return task.status === 'in-process'
  }
  return task.status === normalized
}

type SmartDateField = 'start' | 'due' | 'either'

function candidateDateForField(task: TaskItem, field: SmartDateField): string | undefined {
  if (field === 'start') {
    return task.startDate
  }
  if (field === 'due') {
    return task.dueDate
  }
  return task.dueDate ?? task.startDate
}

function taskMatchesNamedDate(task: TaskItem, value: string, field: SmartDateField = 'either'): boolean {
  const upcomingWindow = parseUpcomingDays(value)
  const candidate = candidateDateForField(task, field)

  if (upcomingWindow !== undefined) {
    return matchesDateValue(candidate, task.status, {
      ...defaultFilter(),
      datePreset: `next${upcomingWindow}`,
    })
  }

  return matchesDateValue(candidate, task.status, {
    ...defaultFilter(),
    datePreset: value as TaskFilter['datePreset'],
  })
}

function parseUpcomingDays(value: string): number | undefined {
  const match = /^next(\d+)$/i.exec(value.trim())
  if (!match) {
    return undefined
  }

  const days = Number.parseInt(match[1], 10)
  return Number.isFinite(days) && days > 0 ? days : undefined
}

function parseSmartDateTerm(value: string): { field: SmartDateField; preset: string } | undefined {
  const match = /^(start|due|end):(today|overdue|next\d+)$/i.exec(value.trim())
  if (!match) {
    return undefined
  }

  return {
    field: match[1].toLowerCase() === 'start' ? 'start' : 'due',
    preset: match[2].toLowerCase(),
  }
}

function resolveCollectionIdsByName(value: string, collections: TaskCollection[]): string[] {
  const normalized = value.trim().toLowerCase()
  return collections
    .filter((collection) => collection.kind === 'task' && collection.displayName.trim().toLowerCase() === normalized)
    .map((collection) => collection.id)
}

function taskMatchesDefinitionTerm(
  term: string,
  task: TaskItem,
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): boolean {
  const normalized = term.trim()
  const taskTags = new Set(task.tagIds.map(normalizeHashtag).filter(Boolean))
  const lowered = normalized.toLowerCase()

  if (!normalized) {
    return true
  }

  if (normalized.startsWith('#')) {
    return taskTags.has(normalizeHashtag(normalized))
  }

  if (/^p[1-4]$/i.test(normalized)) {
    return task.priority === Number.parseInt(normalized.slice(1), 10)
  }

  const smartDateTerm = parseSmartDateTerm(normalized)
  if (smartDateTerm) {
    return taskMatchesNamedDate(task, smartDateTerm.preset, smartDateTerm.field)
  }

  if (lowered === 'today' || lowered === 'overdue' || parseUpcomingDays(lowered) !== undefined) {
    return taskMatchesNamedDate(task, lowered)
  }

  if (lowered.startsWith('status:')) {
    return taskMatchesStatusAlias(task, normalized.slice('status:'.length))
  }

  if (lowered.startsWith('list:')) {
    const matchingCollectionIds = new Set(resolveCollectionIdsByName(normalized.slice('list:'.length), collections))
    return matchingCollectionIds.has(task.collectionId)
  }

  if (lowered.startsWith('subtree:')) {
    const matchingCollectionIds = resolveCollectionIdsByName(normalized.slice('subtree:'.length), collections)
    const allowed = expandTreeIds(
      matchingCollectionIds,
      collections
        .filter((collection) => collection.kind === 'task')
        .map((collection) => ({
          id: collection.id,
          parentId: metadataDoc.collectionParents[collection.id],
        })),
    )
    return allowed.has(task.collectionId)
  }

  return fullTextMatch(task, normalized)
}

function evaluateSmartListAst(
  ast: SmartListAst,
  task: TaskItem,
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): boolean {
  if (ast.kind === 'term') {
    return taskMatchesDefinitionTerm(ast.value, task, metadataDoc, collections)
  }

  if (ast.kind === 'not') {
    return !evaluateSmartListAst(ast.child, task, metadataDoc, collections)
  }

  if (ast.kind === 'and') {
    return (
      evaluateSmartListAst(ast.left, task, metadataDoc, collections) &&
      evaluateSmartListAst(ast.right, task, metadataDoc, collections)
    )
  }

  return (
    evaluateSmartListAst(ast.left, task, metadataDoc, collections) ||
    evaluateSmartListAst(ast.right, task, metadataDoc, collections)
  )
}

export function validateSmartListDefinition(definition: string): string | undefined {
  try {
    parseSmartListDefinition(definition)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid smart list definition.'
  }
}

export function taskMatchesSmartList(
  task: TaskItem,
  smartList: Pick<SmartList, 'definition' | 'filter'>,
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): boolean {
  const definition = smartList.definition.trim()
  if (definition) {
    try {
      const ast = parseSmartListDefinition(definition)
      return ast ? evaluateSmartListAst(ast, task, metadataDoc, collections) : true
    } catch {
      return false
    }
  }

  return taskMatchesFilter(task, smartList.filter, metadataDoc, collections)
}

export function smartListDefinitionFromFilter(
  filter: TaskFilter,
  collections: TaskCollection[],
): string {
  const terms: string[] = []

  if (filter.query.trim()) {
    terms.push(JSON.stringify(filter.query.trim()))
  }

  filter.statuses.forEach((status) => {
    if (status === 'needs-action') {
      terms.push('status:open')
    } else if (status === 'in-process') {
      terms.push('status:in-progress')
    } else {
      terms.push(`status:${status}`)
    }
  })

  filter.tagIds.forEach((tag) => {
    terms.push(normalizeHashtag(tag))
  })

  filter.collectionIds.forEach((collectionId) => {
    const displayName = collections.find((collection) => collection.id === collectionId)?.displayName ?? collectionId
    terms.push(`${filter.includeDescendantCollections ? 'subtree' : 'list'}:${JSON.stringify(displayName)}`)
  })

  if (filter.datePreset !== 'any') {
    if (
      filter.datePreset === 'today' ||
      filter.datePreset === 'overdue' ||
      parseUpcomingDays(filter.datePreset) !== undefined
    ) {
      terms.push(filter.datePreset)
    }
  }

  return terms.join(' & ')
}
