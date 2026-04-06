from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .models import (
    Account,
    AppSettings,
    MetadataDocument,
    SmartList,
    SyncLogEntry,
    TaskCollection,
    TaskFilter,
    TaskItem,
    TaskMutation,
    TaskOrdering,
    TaskReminder,
)

APP_DIR = Path.home() / ".taskmanager_desktop"
DB_PATH = APP_DIR / "taskmanager.sqlite3"


def _row_factory(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {column[0]: row[index] for index, column in enumerate(cursor.description)}


def _ordering_from_dict(value: dict | None) -> TaskOrdering:
    if not value:
        return TaskOrdering()
    return TaskOrdering(
        mode=value.get("mode", "manual"),
        field=value.get("field", "dueDate"),
        direction=value.get("direction", "asc"),
    )


def _filter_from_dict(value: dict | None) -> TaskFilter:
    if not value:
        return TaskFilter()
    return TaskFilter(
        query=value.get("query", ""),
        statuses=value.get("statuses", []),
        tag_ids=value.get("tag_ids", value.get("tagIds", [])),
        include_descendant_tags=value.get("include_descendant_tags", value.get("includeDescendantTags", True)),
        collection_ids=value.get("collection_ids", value.get("collectionIds", [])),
        include_descendant_collections=value.get("include_descendant_collections", value.get("includeDescendantCollections", True)),
        date_preset=value.get("date_preset", value.get("datePreset", "any")),
        custom_from=value.get("custom_from", value.get("customFrom")),
        custom_to=value.get("custom_to", value.get("customTo")),
    )


def _reminder_from_dict(value: dict) -> TaskReminder:
    return TaskReminder(
        id=value["id"],
        kind=value["kind"],
        at=value.get("at"),
        anchor=value.get("anchor"),
        minutes_before=value.get("minutes_before", value.get("minutesBefore")),
    )


def _task_from_dict(payload: dict[str, Any]) -> TaskItem:
    return TaskItem(
        id=payload["id"],
        uid=payload["uid"],
        account_id=payload["account_id"],
        collection_id=payload["collection_id"],
        title=payload.get("title", ""),
        notes=payload.get("notes", ""),
        status=payload.get("status", "needs-action"),
        priority=payload.get("priority", 0),
        created_at=payload.get("created_at", ""),
        updated_at=payload.get("updated_at", ""),
        start_date=payload.get("start_date"),
        start_date_is_all_day=payload.get("start_date_is_all_day", True),
        due_date=payload.get("due_date"),
        due_date_is_all_day=payload.get("due_date_is_all_day", True),
        completed_at=payload.get("completed_at"),
        url=payload.get("url"),
        etag=payload.get("etag"),
        tag_ids=payload.get("tag_ids", []),
        reminders=[_reminder_from_dict(entry) for entry in payload.get("reminders", [])],
        unsupported_reminder_blocks=payload.get("unsupported_reminder_blocks", []),
        sync_state=payload.get("sync_state", "synced"),
    )


def _smart_list_from_dict(payload: dict[str, Any]) -> SmartList:
    return SmartList(
        id=payload["id"],
        account_id=payload["account_id"],
        name=payload["name"],
        definition=payload.get("definition", ""),
        filter=_filter_from_dict(payload.get("filter")),
        ordering=_ordering_from_dict(payload.get("ordering")),
        show_completed=payload.get("show_completed", False),
        url=payload.get("url"),
        etag=payload.get("etag"),
        sync_state=payload.get("sync_state", "synced"),
        updated_at=payload.get("updated_at", ""),
    )


def _metadata_from_dict(payload: dict[str, Any]) -> MetadataDocument:
    return MetadataDocument(
        account_id=payload["account_id"],
        version=payload.get("version", 2),
        tag_nodes=payload.get("tag_nodes", []),
        collection_parents=payload.get("collection_parents", {}),
        collection_order=payload.get("collection_order", []),
        smart_list_order=payload.get("smart_list_order", []),
        favorite_item_ids=payload.get("favorite_item_ids", []),
        favorite_order=payload.get("favorite_order", []),
        task_list_orderings={key: _ordering_from_dict(value) if value else None for key, value in payload.get("task_list_orderings", {}).items()},
        task_list_show_completed=payload.get("task_list_show_completed", {}),
        manual_task_order=payload.get("manual_task_order", {}),
        updated_at=payload.get("updated_at", ""),
        url=payload.get("url"),
        etag=payload.get("etag"),
    )


def _mutation_from_dict(payload: dict[str, Any]) -> TaskMutation:
    return TaskMutation(
        id=payload["id"],
        account_id=payload["account_id"],
        kind=payload["kind"],
        task=_task_from_dict(payload["task"]),
        collection_id=payload["collection_id"],
        created_at=payload["created_at"],
    )


class DesktopRepository:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._db_path)
        connection.row_factory = _row_factory
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                create table if not exists accounts (id text primary key, payload text not null);
                create table if not exists collections (id text primary key, payload text not null);
                create table if not exists tasks (id text primary key, payload text not null);
                create table if not exists smart_lists (id text primary key, payload text not null);
                create table if not exists metadata_docs (account_id text primary key, payload text not null);
                create table if not exists settings (id integer primary key check (id = 1), payload text not null);
                create table if not exists sync_logs (id text primary key, payload text not null);
                create table if not exists queued_mutations (id text primary key, payload text not null);
                """
            )

    def _load_table(self, table: str, parser):
        with self._connect() as connection:
            rows = connection.execute(f"select payload from {table} order by id").fetchall()
        return [parser(json.loads(row["payload"])) for row in rows]

    def _replace_table(self, table: str, rows: list[tuple[str, str]]) -> None:
        with self._connect() as connection:
            connection.execute(f"delete from {table}")
            if rows:
                connection.executemany(f"insert into {table} (id, payload) values (?, ?)", rows)

    def load_accounts(self) -> list[Account]:
        return self._load_table("accounts", lambda payload: Account(**payload))

    def save_accounts(self, accounts: list[Account]) -> None:
        self._replace_table("accounts", [(entry.id, json.dumps(asdict(entry))) for entry in accounts])

    def load_collections(self) -> list[TaskCollection]:
        return self._load_table("collections", lambda payload: TaskCollection(**payload))

    def save_collections(self, collections: list[TaskCollection]) -> None:
        self._replace_table("collections", [(entry.id, json.dumps(asdict(entry))) for entry in collections])

    def load_tasks(self) -> list[TaskItem]:
        return self._load_table("tasks", _task_from_dict)

    def save_tasks(self, tasks: list[TaskItem]) -> None:
        self._replace_table("tasks", [(entry.id, json.dumps(asdict(entry))) for entry in tasks])

    def load_smart_lists(self) -> list[SmartList]:
        return self._load_table("smart_lists", _smart_list_from_dict)

    def save_smart_lists(self, smart_lists: list[SmartList]) -> None:
        self._replace_table("smart_lists", [(entry.id, json.dumps(asdict(entry))) for entry in smart_lists])

    def load_metadata_docs(self) -> list[MetadataDocument]:
        with self._connect() as connection:
            rows = connection.execute("select payload from metadata_docs order by account_id").fetchall()
        return [_metadata_from_dict(json.loads(row["payload"])) for row in rows]

    def save_metadata_docs(self, metadata_docs: list[MetadataDocument]) -> None:
        with self._connect() as connection:
            connection.execute("delete from metadata_docs")
            connection.executemany(
                "insert into metadata_docs (account_id, payload) values (?, ?)",
                [(entry.account_id, json.dumps(asdict(entry))) for entry in metadata_docs],
            )

    def load_settings(self) -> AppSettings:
        with self._connect() as connection:
            row = connection.execute("select payload from settings where id = 1").fetchone()
        return AppSettings(**json.loads(row["payload"])) if row else AppSettings()

    def save_settings(self, settings: AppSettings) -> None:
        with self._connect() as connection:
            connection.execute(
                "insert into settings (id, payload) values (1, ?) on conflict(id) do update set payload=excluded.payload",
                (json.dumps(asdict(settings)),),
            )

    def append_sync_log(self, entry: SyncLogEntry) -> None:
        with self._connect() as connection:
            connection.execute(
                "insert or replace into sync_logs (id, payload) values (?, ?)",
                (entry.id, json.dumps(asdict(entry))),
            )

    def load_sync_logs(self, limit: int = 100) -> list[SyncLogEntry]:
        with self._connect() as connection:
            rows = connection.execute("select payload from sync_logs order by id desc limit ?", (limit,)).fetchall()
        return [SyncLogEntry(**json.loads(row["payload"])) for row in rows]

    def load_queued_mutations(self) -> list[TaskMutation]:
        return self._load_table("queued_mutations", _mutation_from_dict)

    def save_queued_mutations(self, mutations: list[TaskMutation]) -> None:
        self._replace_table("queued_mutations", [(entry.id, json.dumps(asdict(entry))) for entry in mutations])
