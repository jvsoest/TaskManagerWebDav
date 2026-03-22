import type {
  MetadataDocument,
  SmartList,
  SortDirection,
  TagNode,
  TaskCollection,
  TaskFilter,
  TaskItem,
  TaskOrderField,
  TaskOrdering,
} from '../types'

export const defaultFilter = (): TaskFilter => ({
  query: '',
  statuses: [],
  tagIds: [],
  includeDescendantTags: true,
  folderIds: [],
  includeSubfolders: true,
  datePreset: 'any',
})

export function createDefaultMetadata(accountId: string): MetadataDocument {
  return {
    accountId,
    version: 1,
    folderNodes: [],
    tagNodes: [],
    collectionFolders: {},
    collectionOrder: [],
    taskListOrderings: {},
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

export function serializeFilter(filter: TaskFilter): string {
  return JSON.stringify(filter, null, 2)
}

export function serializeSmartListPayload(smartList: Pick<SmartList, 'filter' | 'ordering'>): string {
  return JSON.stringify(
    {
      filter: smartList.filter,
      ordering: smartList.ordering,
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
      tagIds: parsed.tagIds ?? [],
      folderIds: parsed.folderIds ?? [],
    }
  } catch {
    return defaultFilter()
  }
}

export function parseSmartListPayload(value: string): Pick<SmartList, 'filter' | 'ordering'> {
  try {
    const parsed = JSON.parse(value) as { filter?: Partial<TaskFilter>; ordering?: Partial<TaskOrdering> }
    if (parsed && typeof parsed === 'object' && 'filter' in parsed) {
      return {
        filter: parseFilter(JSON.stringify(parsed.filter ?? {})),
        ordering: normalizeOrdering(parsed.ordering, defaultSmartListOrdering()),
      }
    }
  } catch {
    // Fall through to legacy handling.
  }

  return {
    filter: parseFilter(value),
    ordering: defaultSmartListOrdering(),
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

function descendants(ids: string[], tree: Array<{ id: string; parentId?: string }>): Set<string> {
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

function tagScope(filter: TaskFilter, tagNodes: TagNode[]): Set<string> | undefined {
  if (filter.tagIds.length === 0) {
    return undefined
  }

  return filter.includeDescendantTags ? descendants(filter.tagIds, tagNodes) : new Set(filter.tagIds)
}

function folderScope(
  filter: TaskFilter,
  metadataDoc: MetadataDocument,
  collections: TaskCollection[],
): Set<string> | undefined {
  if (filter.folderIds.length === 0) {
    return undefined
  }

  const allowedFolders = filter.includeSubfolders
    ? descendants(filter.folderIds, metadataDoc.folderNodes)
    : new Set(filter.folderIds)

  return new Set(
    collections
      .filter((collection) => collection.kind === 'task')
      .filter((collection) => {
        const folderId = metadataDoc.collectionFolders[collection.id]
        return folderId ? allowedFolders.has(folderId) : false
      })
      .map((collection) => collection.id),
  )
}

function matchesDate(task: TaskItem, filter: TaskFilter): boolean {
  if (filter.datePreset === 'any') {
    return true
  }

  const candidate = task.dueDate ?? task.startDate
  if (!candidate) {
    return false
  }

  const date = new Date(candidate)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const sevenDays = new Date(today)
  sevenDays.setDate(sevenDays.getDate() + 7)

  if (filter.datePreset === 'overdue') {
    return date < today && task.status !== 'completed'
  }

  if (filter.datePreset === 'today') {
    const end = new Date(today)
    end.setHours(23, 59, 59, 999)
    return date >= today && date <= end
  }

  if (filter.datePreset === 'next7') {
    return date >= today && date <= sevenDays
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

  const allowedTags = tagScope(filter, metadataDoc.tagNodes)
  if (allowedTags && !task.tagIds.some((tagId) => allowedTags.has(tagId))) {
    return false
  }

  const allowedCollections = folderScope(filter, metadataDoc, collections)
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
  return tasks.filter((task) => taskMatchesFilter(task, smartList.filter, metadataDoc, collections)).length
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
