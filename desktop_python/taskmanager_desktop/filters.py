from __future__ import annotations

import json
import re
from dataclasses import asdict
from datetime import datetime, timedelta

from .models import MetadataDocument, SmartList, SortDirection, TaskCollection, TaskFilter, TaskItem, TaskOrderField, TaskOrdering


def default_filter() -> TaskFilter:
    return TaskFilter()


def default_task_list_ordering() -> TaskOrdering:
    return TaskOrdering(mode="manual", field="dueDate", direction="asc")


def default_smart_list_ordering() -> TaskOrdering:
    return TaskOrdering(mode="property", field="dueDate", direction="asc")


def create_default_metadata(account_id: str) -> MetadataDocument:
    return MetadataDocument(account_id=account_id, updated_at=datetime.utcnow().isoformat())


def extract_hashtags(*parts: str | None) -> list[str]:
    matches: set[str] = set()
    pattern = re.compile(r"(^|[\s(])#([\w-]+)", re.UNICODE)
    for part in parts:
        if not part:
            continue
        for match in pattern.finditer(part):
            matches.add(f"#{match.group(2).lower()}")
    return sorted(matches)


def serialize_smart_list_payload(smart_list: SmartList) -> str:
    return json.dumps(
        {
            "definition": smart_list.definition,
            "ordering": asdict(smart_list.ordering),
            "showCompleted": smart_list.show_completed,
        },
        indent=2,
    )


def parse_smart_list_payload(value: str) -> tuple[str, TaskOrdering, bool]:
    try:
        parsed = json.loads(value)
    except Exception:
        return value.strip(), default_smart_list_ordering(), False
    if not isinstance(parsed, dict):
        return value.strip(), default_smart_list_ordering(), False
    ordering_dict = parsed.get("ordering") if isinstance(parsed.get("ordering"), dict) else {}
    return (
        str(parsed.get("definition", "")).strip(),
        TaskOrdering(
            mode=ordering_dict.get("mode", "property"),
            field=ordering_dict.get("field", "dueDate"),
            direction=ordering_dict.get("direction", "asc"),
        ),
        parsed.get("showCompleted") is True,
    )


def expand_tree_ids(ids: list[str], tree: list[dict[str, str | None]]) -> set[str]:
    scope = set(ids)
    changed = True
    while changed:
        changed = False
        for node in tree:
            parent = node.get("parentId")
            if parent and parent in scope and node["id"] not in scope:
                scope.add(node["id"])
                changed = True
    return scope


def normalize_ordering(ordering: TaskOrdering | dict | None, fallback: TaskOrdering) -> TaskOrdering:
    if isinstance(ordering, TaskOrdering):
        return ordering
    if not ordering:
        return fallback
    return TaskOrdering(
        mode=ordering.get("mode", fallback.mode),
        field=ordering.get("field", fallback.field),
        direction=ordering.get("direction", fallback.direction),
    )


def smart_list_requires_completed_visibility(smart_list: SmartList) -> bool:
    definition = smart_list.definition.lower()
    return bool(re.search(r"\bcompleted:(today|last\d+)\b", definition) or re.search(r"(^|[^!\w-])status:completed(?=$|[)\s&|])", definition) or smart_list.ordering.field == "completedAt")


def _compare_strings(left: str | None, right: str | None, direction: SortDirection) -> int:
    result = (left or "") > (right or "")
    if (left or "") == (right or ""):
        return 0
    value = 1 if result else -1
    return value if direction == "asc" else -value


def _compare_numbers(left: int | None, right: int | None, direction: SortDirection) -> int:
    delta = (left or 0) - (right or 0)
    if delta == 0:
        return 0
    value = 1 if delta > 0 else -1
    return value if direction == "asc" else -value


def _completed_candidate(task: TaskItem) -> str | None:
    return task.completed_at or (task.updated_at if task.status == "completed" else None)


def _ordering_value(task: TaskItem, field: TaskOrderField):
    if field == "completedAt":
        return _completed_candidate(task)
    if field == "priority":
        return task.priority
    if field == "title":
        return task.title
    if field == "createdAt":
        return task.created_at
    if field == "updatedAt":
        return task.updated_at
    if field == "status":
        return task.status
    if field == "startDate":
        return task.start_date
    return task.due_date


def _compare_tasks(left: TaskItem, right: TaskItem, ordering: TaskOrdering) -> int:
    if ordering.field == "priority":
        result = _compare_numbers(left.priority, right.priority, ordering.direction)
    else:
        result = _compare_strings(_ordering_value(left, ordering.field), _ordering_value(right, ordering.field), ordering.direction)
    if result != 0:
        return result
    return _compare_strings(left.id, right.id, "asc")


def sort_tasks(tasks: list[TaskItem], ordering: TaskOrdering, manual_task_ids: list[str] | None = None) -> list[TaskItem]:
    manual_task_ids = manual_task_ids or []
    if ordering.mode == "manual":
        order_index = {task_id: index for index, task_id in enumerate(manual_task_ids)}
        open_tasks = [task for task in tasks if task.status != "completed"]
        completed_tasks = [task for task in tasks if task.status == "completed"]
        ordered_open = sorted(
            open_tasks,
            key=lambda task: (order_index.get(task.id, 10_000_000), task.created_at, task.id),
        )
        ordered_completed = sorted(completed_tasks, key=lambda task: (_ordering_value(task, ordering.field) or "", task.id))
        return ordered_open + ordered_completed

    from functools import cmp_to_key

    return sorted(tasks, key=cmp_to_key(lambda left, right: _compare_tasks(left, right, ordering)))


def _parse_upcoming_days(value: str) -> int | None:
    match = re.fullmatch(r"next(\d+)", value.strip(), re.I)
    return int(match.group(1)) if match else None


def _parse_past_days(value: str) -> int | None:
    match = re.fullmatch(r"last(\d+)", value.strip(), re.I)
    return int(match.group(1)) if match else None


def _today_bounds() -> tuple[datetime, datetime]:
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1) - timedelta(milliseconds=1)
    return start, end


def _parse_dt(candidate: str | None) -> datetime | None:
    if not candidate:
        return None
    try:
        if len(candidate) == 10:
            return datetime.fromisoformat(candidate)
        return datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except Exception:
        return None


def _matches_date_value(candidate: str | None, task_status: str, preset: str, custom_from: str | None = None, custom_to: str | None = None) -> bool:
    dt = _parse_dt(candidate)
    if not dt:
        return False
    today_start, today_end = _today_bounds()
    if preset == "any":
        return True
    if preset == "overdue":
        return dt < today_start and task_status != "completed"
    if preset == "today":
        return today_start <= dt <= today_end
    upcoming = _parse_upcoming_days(preset)
    if upcoming is not None:
        return today_start <= dt <= today_end + timedelta(days=upcoming)
    if custom_from and dt < (_parse_dt(custom_from) or dt):
        return False
    if custom_to:
        to_dt = _parse_dt(custom_to)
        if to_dt and dt > (to_dt.replace(hour=23, minute=59, second=59, microsecond=999000)):
            return False
    return True


def task_matches_filter(task: TaskItem, filter_value: TaskFilter, metadata_doc: MetadataDocument, collections: list[TaskCollection]) -> bool:
    query = filter_value.query.strip().lower()
    if query and query not in f"{task.title} {task.notes}".lower():
        return False
    if filter_value.statuses and task.status not in filter_value.statuses:
        return False
    if filter_value.tag_ids and not any(tag in task.tag_ids for tag in filter_value.tag_ids):
        return False
    if filter_value.collection_ids:
        tree = [{"id": collection.id, "parentId": metadata_doc.collection_parents.get(collection.id)} for collection in collections if collection.kind == "task"]
        allowed = expand_tree_ids(filter_value.collection_ids, tree) if filter_value.include_descendant_collections else set(filter_value.collection_ids)
        if task.collection_id not in allowed:
            return False
    return _matches_date_value(task.due_date or task.start_date, task.status, filter_value.date_preset, filter_value.custom_from, filter_value.custom_to)


def _resolve_collection_ids_by_name(name: str, collections: list[TaskCollection]) -> list[str]:
    target = name.strip().strip('"').lower()
    return [collection.id for collection in collections if collection.kind == "task" and collection.display_name.lower() == target]


def _task_matches_named_date(task: TaskItem, preset: str, field: str = "either") -> bool:
    if field == "completed":
        candidate = _completed_candidate(task)
        if not candidate:
            return False
        dt = _parse_dt(candidate)
        if not dt:
            return False
        today_start, today_end = _today_bounds()
        if preset == "today":
            return today_start <= dt <= today_end
        past = _parse_past_days(preset)
        if past is not None:
            return today_start - timedelta(days=past - 1) <= dt <= today_end
        return False
    if field == "start":
        candidate = task.start_date
    elif field in ("due", "end"):
        candidate = task.due_date
    else:
        candidate = task.due_date or task.start_date
    return _matches_date_value(candidate, task.status, preset)


def _term_matches(task: TaskItem, term: str, metadata_doc: MetadataDocument, collections: list[TaskCollection]) -> bool:
    normalized = term.strip()
    lowered = normalized.lower()
    if not normalized:
        return True
    if normalized.startswith("#"):
        return normalized.lower() in [tag.lower() for tag in task.tag_ids]
    if re.fullmatch(r"p[1-4]", lowered):
        return task.priority == int(lowered[1:])
    date_match = re.fullmatch(r"(start|due|end):(today|overdue|next\d+)", lowered)
    if date_match:
        return _task_matches_named_date(task, date_match.group(2), date_match.group(1))
    completed_match = re.fullmatch(r"completed:(today|last\d+)", lowered)
    if completed_match:
        return _task_matches_named_date(task, completed_match.group(1), "completed")
    if lowered in {"today", "overdue"} or _parse_upcoming_days(lowered) is not None:
        return _task_matches_named_date(task, lowered)
    if lowered.startswith("status:"):
        alias = lowered.split(":", 1)[1]
        if alias == "open":
            return task.status in {"needs-action", "in-process"}
        if alias == "in-progress":
            return task.status == "in-process"
        return task.status == alias
    if lowered.startswith("list:"):
        return task.collection_id in set(_resolve_collection_ids_by_name(normalized.split(":", 1)[1], collections))
    if lowered.startswith("subtree:"):
        roots = _resolve_collection_ids_by_name(normalized.split(":", 1)[1], collections)
        allowed = expand_tree_ids(
            roots,
            [{"id": collection.id, "parentId": metadata_doc.collection_parents.get(collection.id)} for collection in collections if collection.kind == "task"],
        )
        return task.collection_id in allowed
    return lowered in f"{task.title} {task.notes}".lower()


def _tokenize(definition: str) -> list[str]:
    pattern = re.compile(r'"(?:[^"\\]|\\.)*"|[()&|!]|[^\s()&|!]+')
    return pattern.findall(definition)


def _parse_expression(tokens: list[str], index: int = 0):
    def parse_or(i: int):
        left, i = parse_and(i)
        while i < len(tokens) and tokens[i] == "|":
            right, i = parse_and(i + 1)
            left = ("or", left, right)
        return left, i

    def parse_and(i: int):
        left, i = parse_unary(i)
        while i < len(tokens) and tokens[i] == "&":
            right, i = parse_unary(i + 1)
            left = ("and", left, right)
        return left, i

    def parse_unary(i: int):
        token = tokens[i]
        if token == "!":
            node, next_i = parse_unary(i + 1)
            return ("not", node), next_i
        if token == "(":
            node, next_i = parse_or(i + 1)
            if tokens[next_i] != ")":
                raise ValueError("Missing closing parenthesis in smart list definition.")
            return node, next_i + 1
        return ("term", token.strip('"')), i + 1

    return parse_or(index)


def task_matches_smart_list(task: TaskItem, smart_list: SmartList, metadata_doc: MetadataDocument, collections: list[TaskCollection]) -> bool:
    definition = smart_list.definition.strip()
    if not definition:
        return task_matches_filter(task, smart_list.filter, metadata_doc, collections)
    tokens = _tokenize(definition)
    if not tokens:
        return True
    ast, index = _parse_expression(tokens)
    if index != len(tokens):
        raise ValueError("Invalid smart list definition.")

    def evaluate(node) -> bool:
        kind = node[0]
        if kind == "term":
            return _term_matches(task, node[1], metadata_doc, collections)
        if kind == "not":
            return not evaluate(node[1])
        if kind == "and":
            return evaluate(node[1]) and evaluate(node[2])
        return evaluate(node[1]) or evaluate(node[2])

    return evaluate(ast)


def validate_smart_list_definition(definition: str) -> str | None:
    try:
        tokens = _tokenize(definition.strip())
        if tokens:
            _parse_expression(tokens)
        return None
    except Exception as error:
        return str(error)
