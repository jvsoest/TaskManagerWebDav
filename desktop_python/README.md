# TaskManager Desktop (Python)

Native PySide6 desktop application for TaskManagerWebDav.

## Development

```bash
cd desktop_python
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python -m taskmanager_desktop
```

## Packaging

The GitHub Actions workflow builds standalone desktop bundles with PyInstaller for:

- Windows
- macOS
- Ubuntu/Linux

Local packaging example:

```bash
cd desktop_python
pip install -e . pyinstaller
pyinstaller pyinstaller.spec
```
