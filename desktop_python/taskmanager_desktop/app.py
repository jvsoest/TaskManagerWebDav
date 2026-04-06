from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from .caldav import CalDavClient
from .storage import DesktopRepository
from .ui.main_window import MainWindow


def run() -> int:
    application = QApplication(sys.argv)
    application.setApplicationName("TaskManager Desktop")
    repository = DesktopRepository()
    caldav = CalDavClient()
    window = MainWindow(repository, caldav)
    window.show()
    return application.exec()
