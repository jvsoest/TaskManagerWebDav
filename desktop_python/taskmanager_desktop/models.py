from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

TaskStatus = Literal["needs-action", "in-process", "completed", "cancelled"]
SyncState = Literal["idle", "syncing", "synced", "error"]
CollectionKind = Literal["task", "metadata", "smart"]
TaskOrderMode = Literal["manual", "property"]
TaskOrderField = Literal["dueDate", "startDate", "completedAt", "priority", "title", "createdAt", "updatedAt", "status"]
SortDirection = Literal["asc", "desc"]
ReminderAnchor = Literal["start", "due"]


@dataclass(slots=True)
class TaskReminder:
    id: str
    kind: Literal["absolute", "relative"]
    at: str | None = None
    anchor: ReminderAnchor | None = None
    minutes_before: int | None = None


@dataclass(slots=True)
class TaskOrdering:
    mode: TaskOrderMode = "manual"
    field: TaskOrderField = "dueDate"
    direction: SortDirection = "asc"


@dataclass(slots=True)
class TaskFilter:
    query: str = ""
    statuses: list[TaskStatus] = field(default_factory=list)
    tag_ids: list[str] = field(default_factory=list)
    include_descendant_tags: bool = True
    collection_ids: list[str] = field(default_factory=list)
    include_descendant_collections: bool = True
    date_preset: str = "any"
    custom_from: str | None = None
    custom_to: str | None = None


@dataclass(slots=True)
class Account:
    id: str
    label: str
    server_url: str
    username: str
    display_name: str = ""
    sync_state: SyncState = "idle"
    last_sync_at: str | None = None
    last_error: str | None = None


@dataclass(slots=True)
class TaskCollection:
    id: str
    account_id: str
    url: str
    display_name: str
    description: str = ""
    color: str | None = None
    kind: CollectionKind = "task"
    ctag: str | None = None
    sync_token: str | None = None


@dataclass(slots=True)
class MetadataDocument:
    account_id: str
    version: int = 2
    tag_nodes: list[dict] = field(default_factory=list)
    collection_parents: dict[str, str | None] = field(default_factory=dict)
    collection_order: list[str] = field(default_factory=list)
    smart_list_order: list[str] = field(default_factory=list)
    favorite_item_ids: list[str] = field(default_factory=list)
    favorite_order: list[str] = field(default_factory=list)
    task_list_orderings: dict[str, TaskOrdering | None] = field(default_factory=dict)
    task_list_show_completed: dict[str, bool | None] = field(default_factory=dict)
    manual_task_order: dict[str, list[str] | None] = field(default_factory=dict)
    updated_at: str = ""
    url: str | None = None
    etag: str | None = None


@dataclass(slots=True)
class TaskItem:
    id: str
    uid: str
    account_id: str
    collection_id: str
    title: str
    notes: str = ""
    status: TaskStatus = "needs-action"
    priority: int = 0
    created_at: str = ""
    updated_at: str = ""
    start_date: str | None = None
    start_date_is_all_day: bool = True
    due_date: str | None = None
    due_date_is_all_day: bool = True
    completed_at: str | None = None
    url: str | None = None
    etag: str | None = None
    tag_ids: list[str] = field(default_factory=list)
    reminders: list[TaskReminder] = field(default_factory=list)
    unsupported_reminder_blocks: list[str] = field(default_factory=list)
    sync_state: SyncState = "synced"


@dataclass(slots=True)
class SmartList:
    id: str
    account_id: str
    name: str
    definition: str
    filter: TaskFilter = field(default_factory=TaskFilter)
    ordering: TaskOrdering = field(default_factory=lambda: TaskOrdering(mode="property", field="dueDate", direction="asc"))
    show_completed: bool = False
    url: str | None = None
    etag: str | None = None
    sync_state: SyncState = "synced"
    updated_at: str = ""


@dataclass(slots=True)
class AppSettings:
    auto_sync_enabled: bool = True
    auto_sync_interval_minutes: int = 15


@dataclass(slots=True)
class SyncLogEntry:
    id: str
    source: str
    message: str
    created_at: str
    account_id: str | None = None


@dataclass(slots=True)
class TaskMutation:
    id: str
    account_id: str
    kind: Literal["upsert", "delete"]
    task: TaskItem
    collection_id: str
    created_at: str
