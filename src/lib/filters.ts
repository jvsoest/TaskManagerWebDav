import type { MetadataDocument, SmartList, TagNode, TaskCollection, TaskFilter, TaskItem } from '../types'

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
    updatedAt: new Date().toISOString(),
  }
}

export function serializeFilter(filter: TaskFilter): string {
  return JSON.stringify(filter, null, 2)
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
