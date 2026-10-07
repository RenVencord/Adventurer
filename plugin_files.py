"""
plugin_files.py
Single source of truth for which files of the Adventurer Vencord plugin are runtime files, and the
installer that puts a set of them into Vencord's src/userplugins/adventurer folder.

Used by vencord_helper.py (bundled sync), updater.py (GitHub update) and adventurer.spec (bundling).
Standard library only, so the spec can import it without PyQt6.
"""

import os
import shutil

PLUGIN_DIR_NAME = "adventurer"
ENTRY_POINT = "index.tsx"

# Files Vencord compiles into the plugin. Everything else in the folder (tests, fixtures, backups) is dev-only.
RUNTIME_EXTENSIONS = (".ts", ".tsx", ".js", ".css", ".json")
DEV_DIR_NAMES = ("__fixtures__", "__pycache__")

# Dot-prefixed folders are skipped by Vencord's userplugins scan (scripts/build/common.mjs).
STAGING_DIR_NAME = ".adventurer.new"


class PluginInstallError(Exception):
    pass


def is_runtime_file(rel_path: str) -> bool:
    """rel_path is relative to the plugin folder and uses forward slashes."""
    if "\\" in rel_path or ":" in rel_path:
        return False
    *folders, name = rel_path.split("/")
    if any(part in ("", ".", "..") for part in folders) or name in ("", ".", ".."):
        return False
    if any(folder in DEV_DIR_NAMES for folder in folders):
        return False
    lowered = name.lower()
    if ".test." in lowered:
        return False
    return lowered.endswith(RUNTIME_EXTENSIONS)


def list_runtime_files(plugin_dir: str) -> list[str]:
    """Runtime files below plugin_dir as sorted forward-slash paths relative to it. Empty if it does not exist."""
    found = []
    for root, folders, names in os.walk(plugin_dir):
        folders[:] = [folder for folder in folders if folder not in DEV_DIR_NAMES]
        for name in names:
            rel = os.path.relpath(os.path.join(root, name), plugin_dir).replace(os.sep, "/")
            if is_runtime_file(rel):
                found.append(rel)
    return sorted(found)


def read_runtime_files(plugin_dir: str) -> dict[str, bytes]:
    files = {}
    for rel in list_runtime_files(plugin_dir):
        with open(_abs(plugin_dir, rel), "rb") as f:
            files[rel] = f.read()
    return files


def install_runtime_files(plugin_dir: str, files: dict[str, bytes]) -> None:
    """Make the runtime files of plugin_dir exactly `files` (relative path -> content).

    All new content is written to a staging folder before the installed plugin is touched, so a failure while
    writing leaves it as it was. The staged files are then moved into place one by one (each move is atomic)
    and runtime files that are not in `files` are removed. If any of that fails, the previous runtime files
    are restored. Files that are not runtime files are never touched.
    """
    if ENTRY_POINT not in files:
        raise PluginInstallError(f"The plugin file set has no {ENTRY_POINT}.")
    for rel in files:
        if not is_runtime_file(rel):
            raise PluginInstallError(f"Refusing to install '{rel}': not a plugin runtime file.")

    staging = os.path.join(os.path.dirname(plugin_dir), STAGING_DIR_NAME)
    if os.path.isdir(staging):
        shutil.rmtree(staging)

    previous = read_runtime_files(plugin_dir)
    try:
        for rel, data in files.items():
            _write_file(_abs(staging, rel), data)
        try:
            for rel in files:
                target = _abs(plugin_dir, rel)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.replace(_abs(staging, rel), target)
            for rel in previous:
                if rel not in files:
                    os.remove(_abs(plugin_dir, rel))
        except OSError as e:
            try:
                _restore_runtime_files(plugin_dir, previous, files)
            except OSError as restore_error:
                raise PluginInstallError(
                    f"Installing the plugin failed ({e}) and the previous version could not be restored "
                    f"({restore_error}). The plugin folder may be incomplete."
                ) from restore_error
            raise
    finally:
        if os.path.isdir(staging):
            shutil.rmtree(staging)


def _restore_runtime_files(plugin_dir: str, previous: dict[str, bytes], installed: dict[str, bytes]) -> None:
    for rel, data in previous.items():
        path = _abs(plugin_dir, rel)
        if not os.path.isfile(path) or _read_file(path) != data:
            _write_file(path, data)
    for rel in installed:
        path = _abs(plugin_dir, rel)
        if rel not in previous and os.path.isfile(path):
            os.remove(path)


def _abs(base: str, rel: str) -> str:
    return os.path.join(base, *rel.split("/"))


def _read_file(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _write_file(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
