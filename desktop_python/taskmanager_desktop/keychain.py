from __future__ import annotations

try:
    import keyring
except Exception:  # pragma: no cover - runtime fallback
    keyring = None

SERVICE_NAME = "TaskManagerDesktop"


class KeychainUnavailableError(RuntimeError):
    pass


def set_password(account_id: str, password: str) -> None:
    if keyring is None:
        raise KeychainUnavailableError("Python keyring is not available.")
    keyring.set_password(SERVICE_NAME, account_id, password)


def get_password(account_id: str) -> str | None:
    if keyring is None:
        return None
    return keyring.get_password(SERVICE_NAME, account_id)


def delete_password(account_id: str) -> None:
    if keyring is None:
        return
    try:
        keyring.delete_password(SERVICE_NAME, account_id)
    except Exception:
        pass
