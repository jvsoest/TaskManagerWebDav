from __future__ import annotations

import base64
import json
import re
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urljoin

import httpx

from .filters import (
    create_default_metadata,
    default_filter,
    default_smart_list_ordering,
    extract_hashtags,
    normalize_ordering,
    parse_smart_list_payload,
    serialize_smart_list_payload,
)
from .models import Account, MetadataDocument, ReminderAnchor, SmartList, TaskCollection, TaskItem, TaskOrdering, TaskReminder

CALDAV_NS = "urn:ietf:params:xml:ns:caldav"
DAV_NS = "DAV:"
APPLE_NS = "http://apple.com/ns/ical/"
METADATA_COLLECTION_NAME = "taskmanager-meta"
SMART_COLLECTION_NAME = "taskmanager-smart"
METADATA_RESOURCE_NAME = "taskmanager-metadata.ics"
HIDDEN_COLLECTION_TARGETS = [
    {"kind": "metadata", "slug": METADATA_COLLECTION_NAME, "displayName": "TaskManager Metadata"},
    {"kind": "smart", "slug": SMART_COLLECTION_NAME, "displayName": "TaskManager Smart Lists"},
]


def new_uuid() -> str:
    return str(uuid.uuid4())


def _iso_now() -> str:
    return datetime.now(tz=UTC).replace(microsecond=0).isoformat()


def _auth_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _trailing_slash(value: str) -> str:
    return value if value.endswith("/") else f"{value}/"


def _resolve_url(base: str, href: str) -> str:
    return urljoin(base, href)


def _escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;")


def _ics_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _ics_unescape(value: str) -> str:
    return value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def _format_ics_date(value: str) -> str:
    try:
        if len(value) == 10:
            return value.replace("-", "")
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    except Exception:
        return value.replace("-", "").replace(":", "")


def _parse_ics_date(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    if re.fullmatch(r"\d{8}", raw):
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    if raw.endswith("Z"):
        return datetime.strptime(raw, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).isoformat()
    if re.fullmatch(r"\d{8}T\d{6}", raw):
        return datetime.strptime(raw, "%Y%m%dT%H%M%S").isoformat()
    return raw if "-" in raw else None


def _build_task_id(collection_id: str, uid: str) -> str:
    return f"{collection_id}::{uid}"


def _collection_kind(url: str, display_name: str) -> str | None:
    normalized = _trailing_slash(url)
    if normalized.endswith("/taskmanager-meta/") or re.search(r"/\.?taskmanager-meta-[^/]+/$", normalized, re.I) or display_name == "TaskManager Metadata":
        return "metadata"
    if normalized.endswith("/taskmanager-smart/") or re.search(r"/\.?taskmanager-smart-[^/]+/$", normalized, re.I) or display_name == "TaskManager Smart Lists":
        return "smart"
    return None


def _parse_duration_to_minutes(value: str) -> int | None:
    match = re.match(r"^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$", value, re.I)
    if not match:
        return None
    sign = -1 if value.startswith("-") else 1
    weeks = int(match.group(1) or 0)
    days = int(match.group(2) or 0)
    hours = int(match.group(3) or 0)
    minutes = int(match.group(4) or 0)
    return sign * (weeks * 7 * 24 * 60 + days * 24 * 60 + hours * 60 + minutes)


def _format_reminder_duration(minutes_before: int) -> str:
    remaining = max(0, minutes_before)
    days = remaining // 1440
    remaining -= days * 1440
    hours = remaining // 60
    minutes = remaining - hours * 60
    date_part = f"{days}D" if days else ""
    time_part = f"{hours}H" if hours else ""
    if minutes or (not days and not hours):
        time_part += f"{minutes}M"
    return f"-P{date_part}{f'T{time_part}' if time_part else ''}"


def _unfold_ics(text: str) -> list[str]:
    lines = text.replace("\r\n", "\n").split("\n")
    unfolded: list[str] = []
    for line in lines:
        if (line.startswith(" ") or line.startswith("\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    return unfolded


def _parse_valarm(lines: list[str]) -> tuple[TaskReminder | None, bool]:
    props: dict[str, list[tuple[str, str]]] = {}
    for line in lines:
        if ":" not in line:
            continue
        raw_key, value = line.split(":", 1)
        key = raw_key.split(";", 1)[0].upper()
        props.setdefault(key, []).append((raw_key, value))
    if (props.get("ACTION", [("", "")])[0][1].upper()) != "DISPLAY":
        return None, False
    if "REPEAT" in props or "DURATION" in props:
        return None, False
    trigger = props.get("TRIGGER", [None])[0]
    if not trigger:
        return None, False
    raw_key, value = trigger
    if "VALUE=DATE-TIME" in raw_key.upper() or re.fullmatch(r"\d{8}T\d{6}Z?", value):
        at = _parse_ics_date(value)
        return (TaskReminder(id=new_uuid(), kind="absolute", at=at), True) if at else (None, False)
    minutes = _parse_duration_to_minutes(value)
    if minutes is None or minutes >= 0:
        return None, False
    anchor: ReminderAnchor = "due" if "RELATED=END" in raw_key.upper() else "start"
    return TaskReminder(id=new_uuid(), kind="relative", anchor=anchor, minutes_before=abs(minutes)), True


def _reminder_to_valarm(task: TaskItem, reminder: TaskReminder) -> list[str]:
    description = _ics_escape(task.title or "Task reminder")
    if reminder.kind == "absolute" and reminder.at:
        return [
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            f"DESCRIPTION:{description}",
            f"TRIGGER;VALUE=DATE-TIME:{_format_ics_date(reminder.at)}",
            "END:VALARM",
        ]
    return [
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        f"DESCRIPTION:{description}",
        f"TRIGGER;RELATED={'END' if reminder.anchor == 'due' else 'START'}:{_format_reminder_duration(reminder.minutes_before or 0)}",
        "END:VALARM",
    ]


def _task_to_ics(task: TaskItem) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TaskManagerDesktop//EN",
        "BEGIN:VTODO",
        f"UID:{task.uid}",
        f"DTSTAMP:{_format_ics_date(_iso_now())}",
        f"SUMMARY:{_ics_escape(task.title)}",
        f"DESCRIPTION:{_ics_escape(task.notes)}",
        f"STATUS:{task.status.upper()}",
        f"PRIORITY:{task.priority}",
        f"CREATED:{_format_ics_date(task.created_at or _iso_now())}",
        f"LAST-MODIFIED:{_format_ics_date(task.updated_at or _iso_now())}",
    ]
    if task.start_date:
        lines.append(
            f"DTSTART;VALUE=DATE:{_format_ics_date(task.start_date)}"
            if task.start_date_is_all_day
            else f"DTSTART:{_format_ics_date(task.start_date)}"
        )
    if task.due_date:
        lines.append(
            f"DUE;VALUE=DATE:{_format_ics_date(task.due_date)}"
            if task.due_date_is_all_day
            else f"DUE:{_format_ics_date(task.due_date)}"
        )
    if task.completed_at:
        lines.append(f"COMPLETED:{_format_ics_date(task.completed_at)}")
    if task.tag_ids:
        lines.append(f"CATEGORIES:{','.join(_ics_escape(tag.replace('#', '')) for tag in task.tag_ids)}")
    for reminder in task.reminders:
        lines.extend(_reminder_to_valarm(task, reminder))
    for block in task.unsupported_reminder_blocks:
        lines.extend([line for line in block.splitlines() if line])
    lines.extend(["END:VTODO", "END:VCALENDAR", ""])
    return "\r\n".join(lines)


def _parse_task_from_ics(payload: str, account_id: str, collection_id: str, use_collection_scoped_id: bool = True) -> TaskItem | None:
    lines = _unfold_ics(payload)
    props: dict[str, list[str]] = {}
    reminders: list[TaskReminder] = []
    unsupported_blocks: list[str] = []
    current_alarm: list[str] | None = None
    start_all_day = True
    due_all_day = True

    for line in lines:
        upper = line.upper()
        if upper == "BEGIN:VALARM":
            current_alarm = [line]
            continue
        if current_alarm is not None:
            current_alarm.append(line)
            if upper == "END:VALARM":
                reminder, supported = _parse_valarm(current_alarm)
                if supported and reminder:
                    reminders.append(reminder)
                else:
                    unsupported_blocks.append("\r\n".join(current_alarm))
                current_alarm = None
            continue
        if ":" not in line:
            continue
        raw_key, value = line.split(":", 1)
        key = raw_key.split(";", 1)[0].upper()
        props.setdefault(key, []).append(value)
        if key == "DTSTART":
            start_all_day = "VALUE=DATE" in raw_key.upper() or re.fullmatch(r"\d{8}", value) is not None
        if key == "DUE":
            due_all_day = "VALUE=DATE" in raw_key.upper() or re.fullmatch(r"\d{8}", value) is not None

    uid = props.get("UID", [None])[0]
    if not uid:
        return None
    status = props.get("STATUS", ["NEEDS-ACTION"])[0].lower()
    status = {"needs-action": "needs-action", "in-process": "in-process", "completed": "completed", "cancelled": "cancelled"}.get(status, "needs-action")
    priority = int(props.get("PRIORITY", ["0"])[0] or 0)
    return TaskItem(
        id=_build_task_id(collection_id, uid) if use_collection_scoped_id else uid,
        uid=uid,
        account_id=account_id,
        collection_id=collection_id,
        title=_ics_unescape(props.get("SUMMARY", [""])[0]),
        notes=_ics_unescape(props.get("DESCRIPTION", [""])[0]),
        status=status,
        priority=priority,
        created_at=_parse_ics_date(props.get("CREATED", [None])[0]) or _iso_now(),
        updated_at=_parse_ics_date(props.get("LAST-MODIFIED", [None])[0]) or _iso_now(),
        start_date=_parse_ics_date(props.get("DTSTART", [None])[0]),
        start_date_is_all_day=start_all_day,
        due_date=_parse_ics_date(props.get("DUE", [None])[0]),
        due_date_is_all_day=due_all_day,
        completed_at=_parse_ics_date(props.get("COMPLETED", [None])[0]),
        tag_ids=extract_hashtags(_ics_unescape(props.get("SUMMARY", [""])[0]), _ics_unescape(props.get("DESCRIPTION", [""])[0])),
        reminders=reminders,
        unsupported_reminder_blocks=unsupported_blocks,
        sync_state="synced",
    )


def _parse_multistatus(xml_text: str, base_url: str) -> list[dict[str, Any]]:
    document = ET.fromstring(xml_text)
    entries: list[dict[str, Any]] = []
    for response in document.findall(f".//{{{DAV_NS}}}response"):
        href_node = response.find(f"./{{{DAV_NS}}}href")
        if href_node is None or not href_node.text:
            continue
        propstat = None
        for candidate in response.findall(f"./{{{DAV_NS}}}propstat"):
            status_node = candidate.find(f"./{{{DAV_NS}}}status")
            if status_node is not None and status_node.text and "200" in status_node.text:
                propstat = candidate
                break
        if propstat is None:
            continue
        prop = propstat.find(f"./{{{DAV_NS}}}prop")
        if prop is None:
            continue
        display_name = prop.findtext(f"./{{{DAV_NS}}}displayname") or href_node.text
        color = prop.findtext(f"./{{{APPLE_NS}}}calendar-color")
        sync_token = prop.findtext(f"./{{{DAV_NS}}}sync-token")
        resource_types = {child.tag for child in prop.findall(f"./{{{DAV_NS}}}resourcetype/*")}
        supports_vtodo = any(
            element.get("name", "").upper() == "VTODO"
            for element in prop.findall(f".//{{{CALDAV_NS}}}comp")
        )
        entries.append(
            {
                "url": _trailing_slash(_resolve_url(base_url, href_node.text)),
                "display_name": display_name,
                "color": color,
                "is_calendar": f"{{{CALDAV_NS}}}calendar" in resource_types,
                "supports_vtodo": supports_vtodo,
                "sync_token": sync_token,
            }
        )
    return entries


def _parse_calendar_objects(xml_text: str, base_url: str) -> list[dict[str, str | None]]:
    document = ET.fromstring(xml_text)
    objects: list[dict[str, str | None]] = []
    for response in document.findall(f".//{{{DAV_NS}}}response"):
        href_node = response.find(f"./{{{DAV_NS}}}href")
        data_node = response.find(f".//{{{CALDAV_NS}}}calendar-data")
        if href_node is None or data_node is None or not href_node.text or not data_node.text:
            continue
        objects.append(
            {
                "href": _resolve_url(base_url, href_node.text),
                "etag": response.findtext(f".//{{{DAV_NS}}}getetag"),
                "payload": data_node.text,
            }
        )
    return objects


class CalDavClient:
    def __init__(self, timeout: float = 8.0) -> None:
        self._timeout = timeout

    def _request(self, username: str, password: str, method: str, url: str, body: str | None = None, depth: str | None = None, allow_statuses: set[int] | None = None) -> httpx.Response:
        headers = {"Authorization": _auth_header(username, password), "Accept": "*/*"}
        if depth is not None:
            headers["Depth"] = depth
        if body is not None:
            headers["Content-Type"] = "application/xml; charset=utf-8"
        with httpx.Client(timeout=self._timeout, follow_redirects=True) as client:
            response = client.request(method, url, headers=headers, content=body)
        if response.status_code >= 400 and response.status_code != 207 and (allow_statuses is None or response.status_code not in allow_statuses):
            raise RuntimeError(f"{method} {url} failed ({response.status_code}): {response.text}")
        return response

    def _discover_home(self, server_url: str, username: str, password: str) -> tuple[str, str]:
        root_url = _trailing_slash(server_url)
        root = self._request(
            username,
            password,
            "PROPFIND",
            root_url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                "<d:prop><d:displayname/><d:current-user-principal/><c:calendar-home-set/></d:prop>"
                "</d:propfind>"
            ),
            "0",
        )
        root_doc = ET.fromstring(root.text)
        display_name = next((node.text for node in root_doc.findall(f".//{{{DAV_NS}}}displayname") if node.text), "") or username
        home_href = next((node.text for node in root_doc.findall(f".//{{{CALDAV_NS}}}calendar-home-set/{{{DAV_NS}}}href") if node.text), None)
        if home_href:
            return display_name, _trailing_slash(_resolve_url(str(root.url), home_href))
        principal_href = next((node.text for node in root_doc.findall(f".//{{{DAV_NS}}}current-user-principal/{{{DAV_NS}}}href") if node.text), None)
        if not principal_href:
            return display_name, root_url
        principal_url = _resolve_url(str(root.url), principal_href)
        principal = self._request(
            username,
            password,
            "PROPFIND",
            principal_url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                "<d:prop><d:displayname/><c:calendar-home-set/></d:prop>"
                "</d:propfind>"
            ),
            "0",
        )
        principal_doc = ET.fromstring(principal.text)
        home_href = next((node.text for node in principal_doc.findall(f".//{{{CALDAV_NS}}}calendar-home-set/{{{DAV_NS}}}href") if node.text), None)
        display_name = next((node.text for node in principal_doc.findall(f".//{{{DAV_NS}}}displayname") if node.text), display_name)
        return display_name or username, _trailing_slash(_resolve_url(str(principal.url), home_href or "./"))

    def _propfind_collections(self, username: str, password: str, home_url: str) -> list[dict[str, Any]]:
        response = self._request(
            username,
            password,
            "PROPFIND",
            home_url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">'
                "<d:prop><d:displayname/><a:calendar-color/><d:resourcetype/><d:sync-token/><c:supported-calendar-component-set/></d:prop>"
                "</d:propfind>"
            ),
            "1",
        )
        return _parse_multistatus(response.text, str(response.url))

    def _mkcalendar(self, username: str, password: str, url: str, display_name: str) -> str:
        response = self._request(
            username,
            password,
            "MKCALENDAR",
            url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                "<d:set><d:prop><d:displayname>"
                f"{_escape_xml(display_name)}"
                "</d:displayname><c:supported-calendar-component-set><c:comp name=\"VTODO\" /></c:supported-calendar-component-set></d:prop></d:set>"
                "</c:mkcalendar>"
            ),
            allow_statuses={405},
        )
        location = response.headers.get("location") or response.headers.get("Location")
        return _trailing_slash(_resolve_url(url, location)) if location else _trailing_slash(url)

    def _ensure_hidden_collections(self, username: str, password: str, home_url: str, collections: list[dict[str, Any]]) -> list[dict[str, Any]]:
        existing = {_collection_kind(entry["url"], entry["display_name"]): entry for entry in collections if _collection_kind(entry["url"], entry["display_name"])}
        for target in HIDDEN_COLLECTION_TARGETS:
            if target["kind"] in existing:
                continue
            slug = f"{target['slug']}-{new_uuid().upper()}"
            self._mkcalendar(username, password, _resolve_url(home_url, f"{slug}/"), target["displayName"])
        return self._propfind_collections(username, password, home_url)

    def discover(self, label: str, server_url: str, username: str, password: str) -> tuple[Account, list[TaskCollection]]:
        display_name, home_url = self._discover_home(server_url, username, password)
        discovered = self._ensure_hidden_collections(username, password, home_url, self._propfind_collections(username, password, home_url))
        account = Account(id=new_uuid(), label=label or display_name, server_url=server_url, username=username, display_name=display_name)
        collections: list[TaskCollection] = []
        for entry in discovered:
            if not entry["is_calendar"] or not entry["supports_vtodo"]:
                continue
            kind = _collection_kind(entry["url"], entry["display_name"]) or "task"
            collections.append(
                TaskCollection(
                    id=f"{account.id}:{entry['url']}",
                    account_id=account.id,
                    url=entry["url"],
                    display_name=entry["display_name"],
                    color=entry["color"],
                    kind=kind,
                    sync_token=entry["sync_token"],
                )
            )
        return account, collections

    def _fetch_collection_objects(self, username: str, password: str, collection: TaskCollection) -> list[dict[str, str | None]]:
        response = self._request(
            username,
            password,
            "REPORT",
            collection.url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                "<d:prop><d:getetag/><c:calendar-data/></d:prop>"
                "<c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VTODO\"/></c:comp-filter></c:filter>"
                "</c:calendar-query>"
            ),
            "1",
        )
        return _parse_calendar_objects(response.text, collection.url)

    def sync_account(self, account: Account, password: str, collections: list[TaskCollection]) -> tuple[list[TaskItem], list[TaskCollection], MetadataDocument, list[SmartList]]:
        display_name, home_url = self._discover_home(account.server_url, account.username, password)
        refreshed = []
        for entry in self._ensure_hidden_collections(account.username, password, home_url, self._propfind_collections(account.username, password, home_url)):
            if not entry["is_calendar"] or not entry["supports_vtodo"]:
                continue
            kind = _collection_kind(entry["url"], entry["display_name"]) or "task"
            refreshed.append(
                TaskCollection(
                    id=f"{account.id}:{entry['url']}",
                    account_id=account.id,
                    url=entry["url"],
                    display_name=entry["display_name"],
                    color=entry["color"],
                    kind=kind,
                    sync_token=entry["sync_token"],
                )
            )
        task_collections = [entry for entry in refreshed if entry.kind == "task"]
        metadata_collection = next((entry for entry in refreshed if entry.kind == "metadata"), None)
        smart_collection = next((entry for entry in refreshed if entry.kind == "smart"), None)
        if metadata_collection is None or smart_collection is None:
            raise RuntimeError("Required hidden TaskManager collections are missing.")

        metadata_doc = create_default_metadata(account.id)
        metadata_objects = self._fetch_collection_objects(account.username, password, metadata_collection)
        metadata_entry = next((entry for entry in metadata_objects if str(entry["href"]).endswith(METADATA_RESOURCE_NAME)), metadata_objects[0] if metadata_objects else None)
        if metadata_entry and metadata_entry["payload"]:
            metadata_task = _parse_task_from_ics(str(metadata_entry["payload"]), account.id, metadata_collection.id, False)
            if metadata_task and metadata_task.notes:
                try:
                    raw_doc = json.loads(metadata_task.notes)
                    metadata_doc = MetadataDocument(
                        account_id=account.id,
                        version=raw_doc.get("version", 2),
                        collection_parents=raw_doc.get("collectionParents", raw_doc.get("collection_parents", {})),
                        collection_order=raw_doc.get("collectionOrder", raw_doc.get("collection_order", [])),
                        smart_list_order=raw_doc.get("smartListOrder", raw_doc.get("smart_list_order", [])),
                        favorite_item_ids=raw_doc.get("favoriteItemIds", raw_doc.get("favorite_item_ids", [])),
                        favorite_order=raw_doc.get("favoriteOrder", raw_doc.get("favorite_order", [])),
                        task_list_orderings={
                            key: normalize_ordering(value, TaskOrdering()) if value else None
                            for key, value in raw_doc.get("taskListOrderings", raw_doc.get("task_list_orderings", {})).items()
                        },
                        task_list_show_completed=raw_doc.get("taskListShowCompleted", raw_doc.get("task_list_show_completed", {})),
                        manual_task_order=raw_doc.get("manualTaskOrder", raw_doc.get("manual_task_order", {})),
                        updated_at=raw_doc.get("updatedAt", raw_doc.get("updated_at", _iso_now())),
                        url=str(metadata_entry["href"]),
                        etag=str(metadata_entry["etag"]) if metadata_entry["etag"] else None,
                    )
                except Exception:
                    metadata_doc = create_default_metadata(account.id)

        tasks: list[TaskItem] = []
        for collection in task_collections:
            for entry in self._fetch_collection_objects(account.username, password, collection):
                if not entry["payload"]:
                    continue
                task = _parse_task_from_ics(str(entry["payload"]), account.id, collection.id, True)
                if task:
                    task.url = str(entry["href"])
                    task.etag = str(entry["etag"]) if entry["etag"] else None
                    tasks.append(task)

        smart_lists: list[SmartList] = []
        for entry in self._fetch_collection_objects(account.username, password, smart_collection):
            if not entry["payload"]:
                continue
            smart_task = _parse_task_from_ics(str(entry["payload"]), account.id, smart_collection.id, False)
            if not smart_task:
                continue
            definition, ordering, show_completed = parse_smart_list_payload(smart_task.notes)
            smart_lists.append(
                SmartList(
                    id=smart_task.id,
                    account_id=smart_task.account_id,
                    name=smart_task.title,
                    definition=definition,
                    filter=default_filter(),
                    ordering=ordering or default_smart_list_ordering(),
                    show_completed=show_completed,
                    url=str(entry["href"]),
                    etag=str(entry["etag"]) if entry["etag"] else None,
                    updated_at=smart_task.updated_at,
                )
            )

        account.display_name = display_name
        return tasks, refreshed, metadata_doc, smart_lists

    def upsert_task(self, account: Account, password: str, collection: TaskCollection, task: TaskItem) -> tuple[str, str | None]:
        url = task.url or _resolve_url(collection.url, f"{task.uid}.ics")
        headers = {"Authorization": _auth_header(account.username, password), "Content-Type": "text/calendar; charset=utf-8"}
        if task.etag:
            headers["If-Match"] = task.etag
        else:
            headers["If-None-Match"] = "*"
        with httpx.Client(timeout=self._timeout, follow_redirects=True) as client:
            response = client.put(url, headers=headers, content=_task_to_ics(task))
        if response.status_code not in {200, 201, 204}:
            raise RuntimeError(f"Task save failed ({response.status_code}): {response.text}")
        return url, response.headers.get("etag") or response.headers.get("ETag")

    def delete_task(self, account: Account, password: str, task: TaskItem) -> None:
        if not task.url:
            return
        headers = {"Authorization": _auth_header(account.username, password)}
        if task.etag:
            headers["If-Match"] = task.etag
        with httpx.Client(timeout=self._timeout, follow_redirects=True) as client:
            response = client.delete(task.url, headers=headers)
        if response.status_code not in {200, 204, 404}:
            raise RuntimeError(f"Task delete failed ({response.status_code}): {response.text}")

    def create_task_collection(self, account: Account, password: str, display_name: str) -> TaskCollection:
        _, home_url = self._discover_home(account.server_url, account.username, password)
        target_url = _resolve_url(home_url, f"{new_uuid().upper()}/")
        actual_url = self._mkcalendar(account.username, password, target_url, display_name.strip())
        return TaskCollection(
            id=f"{account.id}:{actual_url}",
            account_id=account.id,
            url=actual_url,
            display_name=display_name.strip(),
            kind="task",
        )

    def rename_task_collection(self, account: Account, password: str, collection: TaskCollection, display_name: str) -> TaskCollection:
        self._request(
            account.username,
            password,
            "PROPPATCH",
            collection.url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>'
                f"{_escape_xml(display_name.strip())}"
                "</d:displayname></d:prop></d:set></d:propertyupdate>"
            ),
        )
        collection.display_name = display_name.strip()
        return collection

    def update_task_collection_color(self, account: Account, password: str, collection: TaskCollection, color: str) -> TaskCollection:
        normalized = color.strip().upper()
        self._request(
            account.username,
            password,
            "PROPPATCH",
            collection.url,
            (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<d:propertyupdate xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><a:calendar-color>'
                f"{_escape_xml(normalized)}"
                "</a:calendar-color></d:prop></d:set></d:propertyupdate>"
            ),
        )
        collection.color = normalized
        return collection

    def delete_task_collection(self, account: Account, password: str, collection: TaskCollection) -> None:
        self._request(account.username, password, "DELETE", collection.url, allow_statuses={404})

    def save_metadata(self, account: Account, password: str, collection: TaskCollection, metadata_doc: MetadataDocument) -> tuple[str, str | None]:
        payload = json.dumps(
            {
                "account_id": metadata_doc.account_id,
                "version": metadata_doc.version,
                "tag_nodes": metadata_doc.tag_nodes,
                "collection_parents": metadata_doc.collection_parents,
                "collection_order": metadata_doc.collection_order,
                "smart_list_order": metadata_doc.smart_list_order,
                "favorite_item_ids": metadata_doc.favorite_item_ids,
                "favorite_order": metadata_doc.favorite_order,
                "task_list_orderings": {key: (vars(value) if value else None) for key, value in metadata_doc.task_list_orderings.items()},
                "task_list_show_completed": metadata_doc.task_list_show_completed,
                "manual_task_order": metadata_doc.manual_task_order,
                "updated_at": metadata_doc.updated_at,
            },
            indent=2,
        )
        task = TaskItem(
            id="taskmanager-metadata",
            uid="taskmanager-metadata",
            account_id=metadata_doc.account_id,
            collection_id=collection.id,
            title="TaskManager Metadata",
            notes=payload,
            created_at=metadata_doc.updated_at or _iso_now(),
            updated_at=metadata_doc.updated_at or _iso_now(),
            url=metadata_doc.url or _resolve_url(collection.url, METADATA_RESOURCE_NAME),
            etag=metadata_doc.etag,
        )
        return self.upsert_task(account, password, collection, task)

    def upsert_smart_list(self, account: Account, password: str, collection: TaskCollection, smart_list: SmartList) -> tuple[str, str | None]:
        task = TaskItem(
            id=smart_list.id,
            uid=f"smart-{smart_list.id}",
            account_id=smart_list.account_id,
            collection_id=collection.id,
            title=smart_list.name,
            notes=serialize_smart_list_payload(smart_list),
            created_at=smart_list.updated_at or _iso_now(),
            updated_at=smart_list.updated_at or _iso_now(),
            url=smart_list.url or _resolve_url(collection.url, f"smart-{smart_list.id}.ics"),
            etag=smart_list.etag,
        )
        return self.upsert_task(account, password, collection, task)

    def delete_smart_list(self, account: Account, password: str, smart_list: SmartList) -> None:
        self.delete_task(
            account,
            password,
            TaskItem(
                id=smart_list.id,
                uid=f"smart-{smart_list.id}",
                account_id=smart_list.account_id,
                collection_id="",
                title=smart_list.name,
                created_at=smart_list.updated_at,
                updated_at=smart_list.updated_at,
                url=smart_list.url,
                etag=smart_list.etag,
            ),
        )
