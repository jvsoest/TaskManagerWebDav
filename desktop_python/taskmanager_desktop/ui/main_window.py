from __future__ import annotations

from dataclasses import replace
from datetime import datetime
import json
import uuid

import httpx
from PySide6.QtCore import QMimeData, Qt
from PySide6.QtGui import QAction, QDrag, QKeySequence
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QInputDialog,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QStatusBar,
    QTextEdit,
    QToolBar,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..caldav import CalDavClient
from ..filters import (
    create_default_metadata,
    default_smart_list_ordering,
    default_task_list_ordering,
    smart_list_requires_completed_visibility,
    sort_tasks,
    task_matches_smart_list,
    validate_smart_list_definition,
)
from ..keychain import get_password, set_password
from ..models import (
    Account,
    MetadataDocument,
    SmartList,
    SyncLogEntry,
    TaskCollection,
    TaskItem,
    TaskMutation,
    TaskOrdering,
    TaskReminder,
)
from ..storage import DesktopRepository


def _new_id() -> str:
    return str(uuid.uuid4())


def _iso_now() -> str:
    return datetime.now().isoformat()


def _favorite_key(kind: str, identifier: str) -> str:
    return f"{kind}:{identifier}"


def _is_retryable(error: Exception) -> bool:
    return isinstance(error, (httpx.TimeoutException, httpx.TransportError))


def _display_date(value: str | None) -> str:
    if not value:
        return ""
    return value[:16].replace("T", " ")


class AccountDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Connect CalDAV account")
        layout = QFormLayout(self)
        self.label_input = QLineEdit()
        self.server_input = QLineEdit()
        self.username_input = QLineEdit()
        self.password_input = QLineEdit()
        self.password_input.setEchoMode(QLineEdit.Password)
        layout.addRow("Label", self.label_input)
        layout.addRow("Server URL", self.server_input)
        layout.addRow("Username", self.username_input)
        layout.addRow("Password", self.password_input)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def payload(self) -> dict[str, str]:
        return {
            "label": self.label_input.text().strip(),
            "server_url": self.server_input.text().strip(),
            "username": self.username_input.text().strip(),
            "password": self.password_input.text(),
        }


class SmartListDialog(QDialog):
    def __init__(self, smart_list: SmartList | None = None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Smart list")
        layout = QFormLayout(self)
        self.name_input = QLineEdit(smart_list.name if smart_list else "")
        self.definition_input = QLineEdit(smart_list.definition if smart_list else "")
        self.show_completed = QCheckBox()
        self.show_completed.setChecked(smart_list.show_completed if smart_list else False)
        layout.addRow("Name", self.name_input)
        layout.addRow("Definition", self.definition_input)
        layout.addRow("Show completed", self.show_completed)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def payload(self) -> dict[str, object]:
        return {
            "name": self.name_input.text().strip(),
            "definition": self.definition_input.text().strip(),
            "show_completed": self.show_completed.isChecked(),
        }


class TaskListWidget(QListWidget):
    MIME_TYPE = "application/x-taskmanager-task-ids"

    def __init__(self, owner: "MainWindow") -> None:
        super().__init__()
        self._owner = owner
        self.setSelectionMode(QListWidget.ExtendedSelection)
        self.setDragEnabled(True)
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)
        self.setDefaultDropAction(Qt.MoveAction)
        self.setDragDropMode(QListWidget.InternalMove)

    def startDrag(self, supported_actions) -> None:  # noqa: ANN001
        items = self.selectedItems()
        if not items:
            return
        mime = QMimeData()
        mime.setData(self.MIME_TYPE, json.dumps([item.data(Qt.UserRole) for item in items]).encode("utf-8"))
        drag = QDrag(self)
        drag.setMimeData(mime)
        drag.exec(Qt.MoveAction)

    def dropEvent(self, event) -> None:  # noqa: ANN001
        super().dropEvent(event)
        self._owner.handle_manual_reorder()


class SidebarTreeWidget(QTreeWidget):
    def __init__(self, owner: "MainWindow") -> None:
        super().__init__()
        self._owner = owner
        self.setHeaderHidden(True)
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)

    def dragEnterEvent(self, event) -> None:  # noqa: ANN001
        if event.mimeData().hasFormat(TaskListWidget.MIME_TYPE):
            event.acceptProposedAction()
            return
        super().dragEnterEvent(event)

    def dragMoveEvent(self, event) -> None:  # noqa: ANN001
        if event.mimeData().hasFormat(TaskListWidget.MIME_TYPE):
            event.acceptProposedAction()
            return
        super().dragMoveEvent(event)

    def dropEvent(self, event) -> None:  # noqa: ANN001
        item = self.itemAt(event.position().toPoint())
        if item and event.mimeData().hasFormat(TaskListWidget.MIME_TYPE):
            payload = item.data(0, Qt.UserRole)
            if payload and payload[0] == "collection":
                task_ids = json.loads(bytes(event.mimeData().data(TaskListWidget.MIME_TYPE)).decode("utf-8"))
                self._owner.move_tasks_to_collection(task_ids, payload[1])
                event.acceptProposedAction()
                return
        super().dropEvent(event)


class MainWindow(QMainWindow):
    def __init__(self, repository: DesktopRepository, caldav: CalDavClient) -> None:
        super().__init__()
        self._repository = repository
        self._caldav = caldav
        self._accounts = repository.load_accounts()
        self._collections = repository.load_collections()
        self._tasks = repository.load_tasks()
        self._smart_lists = repository.load_smart_lists()
        self._metadata_docs = repository.load_metadata_docs()
        self._queued_mutations = repository.load_queued_mutations()
        self._active_account_id: str | None = self._accounts[0].id if self._accounts else None
        self._active_view: tuple[str, str] | None = None
        self._selected_task_id: str | None = None
        self._favorite_mode = False

        self.setWindowTitle("TaskManager Desktop")
        self.resize(1440, 900)

        self._sidebar = SidebarTreeWidget(self)
        self._sidebar.itemSelectionChanged.connect(self._handle_sidebar_selection)

        self._task_list = TaskListWidget(self)
        self._task_list.itemSelectionChanged.connect(self._render_task_editor)

        self._title_input = QLineEdit()
        self._notes_input = QTextEdit()
        self._status_input = QComboBox()
        self._status_input.addItems(["needs-action", "in-process", "completed", "cancelled"])
        self._priority_input = QComboBox()
        self._priority_input.addItems(["0", "1", "2", "3", "4"])
        self._start_date_input = QLineEdit()
        self._start_all_day = QCheckBox("All-day")
        self._due_date_input = QLineEdit()
        self._due_all_day = QCheckBox("All-day")
        self._reminders_list = QListWidget()
        self._info_label = QLabel("Select or create a task")

        editor = QWidget()
        editor_layout = QVBoxLayout(editor)
        form = QFormLayout()
        form.addRow("Title", self._title_input)
        form.addRow("Description", self._notes_input)
        form.addRow("Status", self._status_input)
        form.addRow("Priority", self._priority_input)
        start_row = QWidget()
        start_layout = QHBoxLayout(start_row)
        start_layout.setContentsMargins(0, 0, 0, 0)
        start_layout.addWidget(self._start_date_input)
        start_layout.addWidget(self._start_all_day)
        form.addRow("Start", start_row)
        due_row = QWidget()
        due_layout = QHBoxLayout(due_row)
        due_layout.setContentsMargins(0, 0, 0, 0)
        due_layout.addWidget(self._due_date_input)
        due_layout.addWidget(self._due_all_day)
        form.addRow("Due", due_row)
        form.addRow("Reminders", self._reminders_list)
        editor_layout.addLayout(form)
        reminder_buttons = QHBoxLayout()
        add_relative = QPushButton("Add relative reminder")
        add_relative.clicked.connect(self._add_relative_reminder)
        add_absolute = QPushButton("Add absolute reminder")
        add_absolute.clicked.connect(self._add_absolute_reminder)
        remove_reminder = QPushButton("Remove reminder")
        remove_reminder.clicked.connect(self._remove_selected_reminder)
        reminder_buttons.addWidget(add_relative)
        reminder_buttons.addWidget(add_absolute)
        reminder_buttons.addWidget(remove_reminder)
        editor_layout.addLayout(reminder_buttons)
        editor_actions = QHBoxLayout()
        new_task_button = QPushButton("New task")
        new_task_button.clicked.connect(self._new_task)
        save_task_button = QPushButton("Save task")
        save_task_button.clicked.connect(self._save_task)
        delete_task_button = QPushButton("Delete task")
        delete_task_button.clicked.connect(self._delete_task)
        editor_actions.addWidget(new_task_button)
        editor_actions.addWidget(save_task_button)
        editor_actions.addWidget(delete_task_button)
        editor_layout.addLayout(editor_actions)
        editor_layout.addWidget(self._info_label)

        splitter = QSplitter()
        splitter.addWidget(self._sidebar)
        splitter.addWidget(self._task_list)
        splitter.addWidget(editor)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 1)
        self.setCentralWidget(splitter)

        toolbar = QToolBar("Main")
        self.addToolBar(toolbar)
        connect_action = QAction("Connect", self)
        connect_action.triggered.connect(self._connect_account)
        toolbar.addAction(connect_action)
        sync_action = QAction("Sync", self)
        sync_action.triggered.connect(self._sync_active_account)
        toolbar.addAction(sync_action)
        new_smart_action = QAction("New smart list", self)
        new_smart_action.triggered.connect(self._create_or_edit_smart_list)
        toolbar.addAction(new_smart_action)
        toggle_favorite_action = QAction("Toggle favorite", self)
        toggle_favorite_action.triggered.connect(self._toggle_active_favorite)
        toolbar.addAction(toggle_favorite_action)
        create_list_action = QAction("New list", self)
        create_list_action.triggered.connect(self._create_list)
        toolbar.addAction(create_list_action)
        self.addAction(sync_action)
        sync_action.setShortcut(QKeySequence.Refresh)

        self.setStatusBar(QStatusBar())

        self._refresh_sidebar()
        self._refresh_task_list()

    def _append_sync_log(self, source: str, message: str, account_id: str | None = None) -> None:
        entry = SyncLogEntry(id=_new_id(), source=source, message=message, created_at=_iso_now(), account_id=account_id)
        self._repository.append_sync_log(entry)

    def _active_account(self) -> Account | None:
        return next((entry for entry in self._accounts if entry.id == self._active_account_id), None)

    def _password_for_account(self, account: Account) -> str | None:
        return get_password(account.id)

    def _active_collections(self) -> list[TaskCollection]:
        return [entry for entry in self._collections if entry.account_id == self._active_account_id]

    def _active_task_collections(self) -> list[TaskCollection]:
        return [entry for entry in self._active_collections() if entry.kind == "task"]

    def _active_metadata_doc(self) -> MetadataDocument:
        return next((doc for doc in self._metadata_docs if doc.account_id == self._active_account_id), create_default_metadata(self._active_account_id or ""))

    def _active_smart_lists(self) -> list[SmartList]:
        return [entry for entry in self._smart_lists if entry.account_id == self._active_account_id]

    def _save_state(self) -> None:
        self._repository.save_accounts(self._accounts)
        self._repository.save_collections(self._collections)
        self._repository.save_tasks(self._tasks)
        self._repository.save_smart_lists(self._smart_lists)
        self._repository.save_metadata_docs(self._metadata_docs)
        self._repository.save_queued_mutations(self._queued_mutations)

    def _set_active_view_default(self) -> None:
        smart_lists = self._active_smart_lists()
        collections = self._active_task_collections()
        if smart_lists:
            ordered = self._ordered_smart_lists()
            if ordered:
                self._active_view = ("smart", ordered[0].id)
                return
        if collections:
            ordered = self._ordered_collections()
            if ordered:
                self._active_view = ("collection", ordered[0].id)

    def _ordered_collections(self) -> list[TaskCollection]:
        metadata_doc = self._active_metadata_doc()
        preferred = [collection_id for collection_id in metadata_doc.collection_order if any(entry.id == collection_id for entry in self._active_task_collections())]
        remainder = [entry.id for entry in self._active_task_collections() if entry.id not in preferred]
        ordered_ids = preferred + remainder
        lookup = {entry.id: entry for entry in self._active_task_collections()}
        return [lookup[entry_id] for entry_id in ordered_ids if entry_id in lookup]

    def _ordered_smart_lists(self) -> list[SmartList]:
        metadata_doc = self._active_metadata_doc()
        preferred = [smart_id for smart_id in metadata_doc.smart_list_order if any(entry.id == smart_id for entry in self._active_smart_lists())]
        remainder = [entry.id for entry in self._active_smart_lists() if entry.id not in preferred]
        ordered_ids = preferred + remainder
        lookup = {entry.id: entry for entry in self._active_smart_lists()}
        return [lookup[entry_id] for entry_id in ordered_ids if entry_id in lookup]

    def _favorite_items(self) -> list[tuple[str, object]]:
        metadata_doc = self._active_metadata_doc()
        lookup_collections = {entry.id: entry for entry in self._active_task_collections()}
        lookup_smart_lists = {entry.id: entry for entry in self._active_smart_lists()}
        ordered = [entry for entry in metadata_doc.favorite_order if entry in metadata_doc.favorite_item_ids]
        ordered.extend(entry for entry in metadata_doc.favorite_item_ids if entry not in ordered)
        items: list[tuple[str, object]] = []
        for entry in ordered:
            if entry.startswith("collection:"):
                collection = lookup_collections.get(entry.split(":", 1)[1])
                if collection:
                    items.append((entry, collection))
            elif entry.startswith("smart:"):
                smart_list = lookup_smart_lists.get(entry.split(":", 1)[1])
                if smart_list:
                    items.append((entry, smart_list))
        return items

    def _view_tasks(self) -> list[TaskItem]:
        metadata_doc = self._active_metadata_doc()
        tasks = [task for task in self._tasks if task.account_id == self._active_account_id]
        if self._active_view is None:
            return tasks
        kind, identifier = self._active_view
        if kind == "collection":
            show_completed = metadata_doc.task_list_show_completed.get(identifier) is True
            ordering = metadata_doc.task_list_orderings.get(identifier) or default_task_list_ordering()
            scoped = [task for task in tasks if task.collection_id == identifier and (show_completed or task.status != "completed")]
            return sort_tasks(scoped, ordering, metadata_doc.manual_task_order.get(identifier) or [])
        smart_list = next((entry for entry in self._active_smart_lists() if entry.id == identifier), None)
        if smart_list is None:
            return []
        show_completed = smart_list.show_completed or smart_list_requires_completed_visibility(smart_list)
        scoped = [
            task for task in tasks
            if task_matches_smart_list(task, smart_list, metadata_doc, self._active_task_collections())
            and (show_completed or task.status != "completed")
        ]
        return sort_tasks(scoped, smart_list.ordering)

    def _refresh_sidebar(self) -> None:
        self._sidebar.clear()
        favorites_root = QTreeWidgetItem(["Favorites"])
        smart_root = QTreeWidgetItem(["Smart lists"])
        lists_root = QTreeWidgetItem(["Lists"])
        self._sidebar.addTopLevelItems([favorites_root, smart_root, lists_root])
        for key, item in self._favorite_items():
            if isinstance(item, TaskCollection):
                node = QTreeWidgetItem([item.display_name])
                node.setData(0, Qt.UserRole, ("collection", item.id))
            else:
                node = QTreeWidgetItem([item.name])
                node.setData(0, Qt.UserRole, ("smart", item.id))
            favorites_root.addChild(node)
        for smart_list in self._ordered_smart_lists():
            node = QTreeWidgetItem([smart_list.name])
            node.setData(0, Qt.UserRole, ("smart", smart_list.id))
            smart_root.addChild(node)
        for collection in self._ordered_collections():
            node = QTreeWidgetItem([collection.display_name])
            node.setData(0, Qt.UserRole, ("collection", collection.id))
            lists_root.addChild(node)
        self._sidebar.expandAll()
        if self._active_view is None:
            self._set_active_view_default()

    def _refresh_task_list(self) -> None:
        self._task_list.clear()
        for task in self._view_tasks():
            item = QListWidgetItem(task.title or "Untitled task")
            item.setData(Qt.UserRole, task.id)
            item.setToolTip(f"{_display_date(task.due_date or task.start_date)} {task.notes[:120]}")
            if task.status == "completed":
                item.setCheckState(Qt.Checked)
            self._task_list.addItem(item)

    def _selected_tasks(self) -> list[TaskItem]:
        selected_ids = [item.data(Qt.UserRole) for item in self._task_list.selectedItems()]
        return [task for task in self._tasks if task.id in selected_ids]

    def _selected_task(self) -> TaskItem | None:
        selected = self._selected_tasks()
        return selected[0] if selected else None

    def _render_task_editor(self) -> None:
        task = self._selected_task()
        self._selected_task_id = task.id if task else None
        if not task:
            self._title_input.setText("")
            self._notes_input.setPlainText("")
            self._status_input.setCurrentText("needs-action")
            self._priority_input.setCurrentText("0")
            self._start_date_input.setText("")
            self._start_all_day.setChecked(True)
            self._due_date_input.setText("")
            self._due_all_day.setChecked(True)
            self._reminders_list.clear()
            self._info_label.setText("Select or create a task")
            return
        self._title_input.setText(task.title)
        self._notes_input.setPlainText(task.notes)
        self._status_input.setCurrentText(task.status)
        self._priority_input.setCurrentText(str(task.priority))
        self._start_date_input.setText(task.start_date or "")
        self._start_all_day.setChecked(task.start_date_is_all_day)
        self._due_date_input.setText(task.due_date or "")
        self._due_all_day.setChecked(task.due_date_is_all_day)
        self._reminders_list.clear()
        for reminder in task.reminders:
            label = reminder.at if reminder.kind == "absolute" else f"{reminder.minutes_before} min before {reminder.anchor}"
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, reminder.id)
            self._reminders_list.addItem(item)
        self._info_label.setText(f"{task.status} | updated {task.updated_at}")

    def _connect_account(self) -> None:
        dialog = AccountDialog(self)
        if dialog.exec() != QDialog.Accepted:
            return
        payload = dialog.payload()
        if not payload["server_url"] or not payload["username"] or not payload["password"]:
            QMessageBox.warning(self, "Missing fields", "Server URL, username, and password are required.")
            return
        try:
            account, collections = self._caldav.discover(payload["label"] or payload["username"], payload["server_url"], payload["username"], payload["password"])
            set_password(account.id, payload["password"])
            self._accounts = [*self._accounts, account]
            self._collections = [entry for entry in self._collections if entry.account_id != account.id] + collections
            self._metadata_docs = [entry for entry in self._metadata_docs if entry.account_id != account.id] + [create_default_metadata(account.id)]
            self._active_account_id = account.id
            self._active_view = None
            self._save_state()
            self._refresh_sidebar()
            self._refresh_task_list()
            self.statusBar().showMessage(f"Connected {account.display_name or account.label}", 5000)
        except Exception as error:
            QMessageBox.critical(self, "Connection failed", str(error))

    def _flush_queue(self, account: Account, password: str) -> None:
        remaining: list[TaskMutation] = []
        for mutation in sorted(self._queued_mutations, key=lambda entry: entry.created_at):
            if mutation.account_id != account.id:
                remaining.append(mutation)
                continue
            collection = next((entry for entry in self._active_collections() if entry.id == mutation.collection_id), None)
            if not collection:
                continue
            try:
                if mutation.kind == "upsert":
                    url, etag = self._caldav.upsert_task(account, password, collection, mutation.task)
                    for index, task in enumerate(self._tasks):
                        if task.id == mutation.task.id:
                            self._tasks[index] = replace(task, url=url, etag=etag, sync_state="synced")
                            break
                else:
                    self._caldav.delete_task(account, password, mutation.task)
                    self._tasks = [task for task in self._tasks if task.id != mutation.task.id]
            except Exception as error:
                if _is_retryable(error):  # type: ignore[arg-type]
                    remaining.append(mutation)
                else:
                    self._append_sync_log("Queue replay", str(error), account.id)
        self._queued_mutations = remaining

    def _sync_active_account(self) -> None:
        account = self._active_account()
        if not account:
            QMessageBox.information(self, "No account", "Connect a CalDAV account first.")
            return
        password = self._password_for_account(account)
        if not password:
            QMessageBox.warning(self, "Missing password", "Password not found in the system keychain.")
            return
        try:
            self._flush_queue(account, password)
            tasks, collections, metadata_doc, smart_lists = self._caldav.sync_account(account, password, self._active_collections())
            self._tasks = [entry for entry in self._tasks if entry.account_id != account.id] + tasks
            self._collections = [entry for entry in self._collections if entry.account_id != account.id] + collections
            self._smart_lists = [entry for entry in self._smart_lists if entry.account_id != account.id] + smart_lists
            self._metadata_docs = [entry for entry in self._metadata_docs if entry.account_id != account.id] + [metadata_doc]
            account.last_sync_at = _iso_now()
            account.sync_state = "synced"
            self._save_state()
            self._refresh_sidebar()
            self._refresh_task_list()
            self.statusBar().showMessage(f"Synced {len(tasks)} tasks", 5000)
        except Exception as error:
            account.sync_state = "error"
            account.last_error = str(error)
            self._append_sync_log("Sync", str(error), account.id)
            self._save_state()
            QMessageBox.critical(self, "Sync failed", str(error))

    def _current_edit_task(self) -> TaskItem | None:
        task = self._selected_task()
        if task:
            return task
        if self._active_view and self._active_view[0] == "collection":
            collection_id = self._active_view[1]
        else:
            collection_id = self._ordered_collections()[0].id if self._ordered_collections() else ""
        if not collection_id or not self._active_account_id:
            return None
        return TaskItem(
            id=_new_id(),
            uid=_new_id().replace("-", ""),
            account_id=self._active_account_id,
            collection_id=collection_id,
            title="",
            created_at=_iso_now(),
            updated_at=_iso_now(),
            sync_state="idle",
        )

    def _new_task(self) -> None:
        self._task_list.clearSelection()
        self._render_task_editor()
        self._title_input.setFocus()

    def _current_reminders(self) -> list[TaskReminder]:
        task = self._selected_task()
        if task:
            return list(task.reminders)
        reminders: list[TaskReminder] = []
        for index in range(self._reminders_list.count()):
            entry = self._reminders_list.item(index).data(Qt.UserRole)
            if isinstance(entry, TaskReminder):
                reminders.append(entry)
        return reminders

    def _build_task_from_editor(self) -> TaskItem | None:
        task = self._current_edit_task()
        if task is None:
            return None
        reminders: list[TaskReminder] = []
        for index in range(self._reminders_list.count()):
            payload = self._reminders_list.item(index).data(Qt.UserRole)
            if isinstance(payload, TaskReminder):
                reminders.append(payload)
        status = self._status_input.currentText()
        completed_at = task.completed_at
        if status == "completed" and not completed_at:
            completed_at = _iso_now()
        if status != "completed":
            completed_at = None
        return replace(
            task,
            title=self._title_input.text().strip(),
            notes=self._notes_input.toPlainText(),
            status=status,
            priority=int(self._priority_input.currentText()),
            start_date=self._start_date_input.text().strip() or None,
            start_date_is_all_day=self._start_all_day.isChecked(),
            due_date=self._due_date_input.text().strip() or None,
            due_date_is_all_day=self._due_all_day.isChecked(),
            completed_at=completed_at,
            updated_at=_iso_now(),
            reminders=reminders,
            tag_ids=[],
        )

    def _save_task(self) -> None:
        account = self._active_account()
        if account is None:
            return
        task = self._build_task_from_editor()
        if task is None or not task.collection_id:
            QMessageBox.warning(self, "No list", "Select a list before saving a task.")
            return
        password = self._password_for_account(account)
        collection = next((entry for entry in self._active_collections() if entry.id == task.collection_id), None)
        if not password or collection is None:
            QMessageBox.warning(self, "Missing account", "Active account or list is unavailable.")
            return
        existing = next((entry for entry in self._tasks if entry.id == task.id), None)
        self._tasks = [entry for entry in self._tasks if entry.id != task.id] + [task]
        try:
            url, etag = self._caldav.upsert_task(account, password, collection, task)
            self._tasks = [entry for entry in self._tasks if entry.id != task.id] + [replace(task, url=url, etag=etag, sync_state="synced")]
            self.statusBar().showMessage("Task saved", 5000)
        except Exception as error:
            if _is_retryable(error):  # type: ignore[arg-type]
                queued = TaskMutation(id=_new_id(), account_id=account.id, kind="upsert", task=replace(task, sync_state="syncing"), collection_id=task.collection_id, created_at=_iso_now())
                self._queued_mutations = [entry for entry in self._queued_mutations if entry.task.id != task.id] + [queued]
                self.statusBar().showMessage("Task queued for sync", 5000)
            else:
                self._tasks = [entry for entry in self._tasks if entry.id != task.id] + ([existing] if existing else [])
                QMessageBox.critical(self, "Task save failed", str(error))
                return
        self._save_state()
        self._refresh_task_list()

    def _delete_task(self) -> None:
        account = self._active_account()
        task = self._selected_task()
        if account is None or task is None:
            return
        password = self._password_for_account(account)
        self._tasks = [entry for entry in self._tasks if entry.id != task.id]
        try:
            if password:
                self._caldav.delete_task(account, password, task)
            self.statusBar().showMessage("Task deleted", 5000)
        except Exception as error:
            if _is_retryable(error):  # type: ignore[arg-type]
                self._queued_mutations.append(TaskMutation(id=_new_id(), account_id=account.id, kind="delete", task=task, collection_id=task.collection_id, created_at=_iso_now()))
                self.statusBar().showMessage("Task delete queued", 5000)
            else:
                QMessageBox.critical(self, "Task delete failed", str(error))
                return
        self._save_state()
        self._refresh_task_list()

    def _handle_sidebar_selection(self) -> None:
        current = self._sidebar.currentItem()
        if not current:
            return
        payload = current.data(0, Qt.UserRole)
        if not payload:
            return
        self._active_view = payload
        self._refresh_task_list()

    def _toggle_active_favorite(self) -> None:
        metadata_doc = self._active_metadata_doc()
        if self._active_view is None:
            return
        key = _favorite_key(self._active_view[0], self._active_view[1])
        if key in metadata_doc.favorite_item_ids:
            metadata_doc.favorite_item_ids = [entry for entry in metadata_doc.favorite_item_ids if entry != key]
            metadata_doc.favorite_order = [entry for entry in metadata_doc.favorite_order if entry != key]
        else:
            metadata_doc.favorite_item_ids.append(key)
            metadata_doc.favorite_order.append(key)
        metadata_doc.updated_at = _iso_now()
        self._metadata_docs = [entry for entry in self._metadata_docs if entry.account_id != metadata_doc.account_id] + [metadata_doc]
        self._persist_metadata(metadata_doc)
        self._save_state()
        self._refresh_sidebar()

    def _persist_metadata(self, metadata_doc: MetadataDocument) -> None:
        account = self._active_account()
        if account is None:
            return
        password = self._password_for_account(account)
        collection = next((entry for entry in self._active_collections() if entry.kind == "metadata"), None)
        if not password or collection is None:
            return
        try:
            url, etag = self._caldav.save_metadata(account, password, collection, metadata_doc)
            metadata_doc.url = url
            metadata_doc.etag = etag
        except Exception as error:
            self._append_sync_log("Metadata save", str(error), account.id)

    def _create_or_edit_smart_list(self) -> None:
        current_smart = None
        if self._active_view and self._active_view[0] == "smart":
            current_smart = next((entry for entry in self._active_smart_lists() if entry.id == self._active_view[1]), None)
        dialog = SmartListDialog(current_smart, self)
        if dialog.exec() != QDialog.Accepted:
            return
        payload = dialog.payload()
        definition_error = validate_smart_list_definition(str(payload["definition"]))
        if definition_error:
            QMessageBox.warning(self, "Invalid definition", definition_error)
            return
        account = self._active_account()
        if account is None:
            return
        password = self._password_for_account(account)
        smart_collection = next((entry for entry in self._active_collections() if entry.kind == "smart"), None)
        if not password or smart_collection is None:
            return
        smart_list = current_smart or SmartList(id=_new_id(), account_id=account.id, name="", definition="", ordering=default_smart_list_ordering(), updated_at=_iso_now())
        smart_list.name = str(payload["name"])
        smart_list.definition = str(payload["definition"])
        smart_list.show_completed = bool(payload["show_completed"])
        smart_list.updated_at = _iso_now()
        try:
            url, etag = self._caldav.upsert_smart_list(account, password, smart_collection, smart_list)
            smart_list.url = url
            smart_list.etag = etag
            self._smart_lists = [entry for entry in self._smart_lists if entry.id != smart_list.id] + [smart_list]
            metadata_doc = self._active_metadata_doc()
            if smart_list.id not in metadata_doc.smart_list_order:
                metadata_doc.smart_list_order.append(smart_list.id)
                metadata_doc.updated_at = _iso_now()
                self._metadata_docs = [entry for entry in self._metadata_docs if entry.account_id != metadata_doc.account_id] + [metadata_doc]
                self._persist_metadata(metadata_doc)
            self._save_state()
            self._refresh_sidebar()
        except Exception as error:
            QMessageBox.critical(self, "Smart list save failed", str(error))

    def _create_list(self) -> None:
        account = self._active_account()
        if account is None:
            return
        password = self._password_for_account(account)
        if not password:
            return
        name, ok = QInputDialog.getText(self, "New list", "List name")  # type: ignore[name-defined]
        if not ok or not name.strip():
            return
        try:
            collection = self._caldav.create_task_collection(account, password, name)
            self._collections.append(collection)
            metadata_doc = self._active_metadata_doc()
            metadata_doc.collection_order.append(collection.id)
            metadata_doc.updated_at = _iso_now()
            self._metadata_docs = [entry for entry in self._metadata_docs if entry.account_id != metadata_doc.account_id] + [metadata_doc]
            self._persist_metadata(metadata_doc)
            self._save_state()
            self._refresh_sidebar()
        except Exception as error:
            QMessageBox.critical(self, "List create failed", str(error))

    def _add_relative_reminder(self) -> None:
        reminder = TaskReminder(id=_new_id(), kind="relative", anchor="due", minutes_before=30)
        item = QListWidgetItem("30 min before due")
        item.setData(Qt.UserRole, reminder)
        self._reminders_list.addItem(item)

    def _add_absolute_reminder(self) -> None:
        reminder = TaskReminder(id=_new_id(), kind="absolute", at=_iso_now()[:16])
        item = QListWidgetItem(reminder.at or "")
        item.setData(Qt.UserRole, reminder)
        self._reminders_list.addItem(item)

    def _remove_selected_reminder(self) -> None:
        row = self._reminders_list.currentRow()
        if row >= 0:
            self._reminders_list.takeItem(row)

    def move_tasks_to_collection(self, task_ids: list[str], target_collection_id: str) -> None:
        account = self._active_account()
        if account is None:
            return
        password = self._password_for_account(account)
        target_collection = next((entry for entry in self._active_collections() if entry.id == target_collection_id), None)
        if not password or target_collection is None:
            return
        moved_tasks = [entry for entry in self._tasks if entry.id in task_ids]
        for task in moved_tasks:
            next_task = replace(task, collection_id=target_collection_id, id=f"{target_collection_id}::{task.uid}", updated_at=_iso_now(), url=None, etag=None)
            self._tasks = [entry for entry in self._tasks if entry.id != task.id] + [next_task]
            try:
                self._caldav.upsert_task(account, password, target_collection, next_task)
                if task.url:
                    self._caldav.delete_task(account, password, task)
            except Exception as error:
                if _is_retryable(error):  # type: ignore[arg-type]
                    self._queued_mutations.append(TaskMutation(id=_new_id(), account_id=account.id, kind="upsert", task=next_task, collection_id=target_collection_id, created_at=_iso_now()))
                else:
                    self._append_sync_log("Task move", str(error), account.id)
        self._save_state()
        self._refresh_task_list()

    def handle_manual_reorder(self) -> None:
        if not self._active_view or self._active_view[0] != "collection":
            return
        collection_id = self._active_view[1]
        metadata_doc = self._active_metadata_doc()
        ordered_ids = [self._task_list.item(index).data(Qt.UserRole) for index in range(self._task_list.count())]
        metadata_doc.manual_task_order[collection_id] = ordered_ids
        metadata_doc.updated_at = _iso_now()
        self._metadata_docs = [entry for entry in self._metadata_docs if entry.account_id != metadata_doc.account_id] + [metadata_doc]
        self._persist_metadata(metadata_doc)
        self._save_state()
