import os
import sys
import shutil
import subprocess
from PyQt6.QtCore import QThread, pyqtSignal

import plugin_files
import updater
from plugin_files import PluginInstallError

VENCORD_REPO_URL = "https://github.com/Vendicated/Vencord"

# Results of sync_plugin_file
SYNC_INSTALLED = "installed"
SYNC_SOURCE_CHECKOUT = "source_checkout"
SYNC_INSTALLED_NEWER = "installed_newer"


def get_bundled_plugin_path() -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        bundled = os.path.join(sys._MEIPASS, "adventurer", "index.tsx")
        if os.path.exists(bundled):
            return bundled
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "adventurer", "index.tsx")
    return local


def find_vencord_dir(custom_path: str = None) -> str | None:
    if custom_path and os.path.exists(custom_path):
        target = os.path.join(custom_path, "src", "userplugins")
        if os.path.exists(target) or os.path.exists(os.path.join(custom_path, "package.json")):
            return os.path.abspath(custom_path)

    candidates = [
        os.path.join(os.path.expanduser("~"), "Vencord"),
        "C:\\Vencord",
        os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "Vencord"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Vencord")
    ]

    for cand in candidates:
        if os.path.exists(cand):
            target = os.path.join(cand, "src", "userplugins")
            if os.path.exists(target) or os.path.exists(os.path.join(cand, "package.json")):
                return os.path.abspath(cand)

    return None


def get_plugin_dir(vencord_dir: str) -> str:
    return os.path.join(vencord_dir, "src", "userplugins", plugin_files.PLUGIN_DIR_NAME)


def is_source_checkout_plugin_dir(vencord_dir: str) -> bool:
    """True when Vencord's plugin folder is the local development checkout (the same files, e.g. via a link)."""
    plugin_dir = get_plugin_dir(vencord_dir)
    source_dir = os.path.dirname(get_bundled_plugin_path())
    return os.path.isdir(plugin_dir) and os.path.isdir(source_dir) and os.path.samefile(source_dir, plugin_dir)


def sync_plugin_file(vencord_dir: str, installed_version: str = "") -> str:
    """Install the bundled plugin runtime files into Vencord. Raises PluginInstallError on failure.

    installed_version is the plugin version recorded when the plugin in Vencord was last installed ("" if none).
    Returns SYNC_INSTALLED when the bundled files were installed (the bundled version is now the installed one),
    SYNC_SOURCE_CHECKOUT when Vencord's plugin folder is the local development checkout (nothing to do), or
    SYNC_INSTALLED_NEWER when the installed plugin is newer than the bundled one, e.g. updated from GitHub, and
    is left alone so the older bundled copy does not roll it back.
    """
    if not vencord_dir or not os.path.exists(vencord_dir):
        raise PluginInstallError("The Vencord directory does not exist.")

    bundled = get_bundled_plugin_path()
    if not os.path.exists(bundled):
        raise PluginInstallError(f"The bundled plugin was not found at {bundled}.")

    # The development checkout links the plugin folder into Vencord: source and target are the same files.
    if is_source_checkout_plugin_dir(vencord_dir):
        return SYNC_SOURCE_CHECKOUT

    # With no plugin in the folder yet (fresh install, or another Vencord checkout) the recorded version says nothing.
    plugin_installed = os.path.isfile(os.path.join(get_plugin_dir(vencord_dir), plugin_files.ENTRY_POINT))
    if installed_version and plugin_installed and updater.is_version_newer(updater.PLUGIN_VERSION, installed_version):
        return SYNC_INSTALLED_NEWER

    try:
        plugin_files.install_runtime_files(
            get_plugin_dir(vencord_dir), plugin_files.read_runtime_files(os.path.dirname(bundled))
        )
    except OSError as e:
        raise PluginInstallError(f"Failed to sync the plugin files: {e}") from e
    return SYNC_INSTALLED


def install_plugin_update(vencord_dir: str, files: dict[str, bytes]) -> None:
    """Install plugin runtime files downloaded from GitHub. Raises PluginInstallError on failure.

    Refuses to touch Vencord's plugin folder when it is the local development checkout, since the update
    would overwrite uncommitted local work.
    """
    if not vencord_dir or not os.path.exists(vencord_dir):
        raise PluginInstallError("The Vencord directory does not exist.")
    if is_source_checkout_plugin_dir(vencord_dir):
        raise PluginInstallError("Vencord's plugin folder is the local source checkout; not overwriting it.")

    try:
        plugin_files.install_runtime_files(get_plugin_dir(vencord_dir), files)
    except OSError as e:
        raise PluginInstallError(f"Failed to install the plugin update: {e}") from e


def _get_pm_command() -> str:
    if shutil.which("pnpm"):
        return "pnpm"
    elif shutil.which("npm"):
        return "npm"
    return ""


class VencordBuildWorker(QThread):
    log_signal = pyqtSignal(str)
    finished_signal = pyqtSignal(bool, str)
    # Emitted with the bundled plugin version when the bundled plugin files were installed into Vencord.
    plugin_synced_signal = pyqtSignal(str)

    def __init__(self, vencord_dir: str, mode: str = "build", sync_plugin: bool = True, installed_plugin_version: str = ""):
        super().__init__()
        self.vencord_dir = vencord_dir
        self.mode = mode
        # False when the plugin in Vencord was just updated from GitHub: syncing the bundled copy would undo it.
        self.sync_plugin = sync_plugin
        self.installed_plugin_version = installed_plugin_version

    def _sync_plugin_files(self) -> bool:
        if not self.sync_plugin:
            return True
        self.log_signal.emit("Syncing Adventurer plugin files...")
        try:
            result = sync_plugin_file(self.vencord_dir, self.installed_plugin_version)
        except PluginInstallError as e:
            self.finished_signal.emit(False, str(e))
            return False
        if result == SYNC_INSTALLED:
            self.plugin_synced_signal.emit(updater.PLUGIN_VERSION)
        elif result == SYNC_SOURCE_CHECKOUT:
            self.log_signal.emit("Vencord's plugin folder is the local source checkout: nothing to sync.")
        elif result == SYNC_INSTALLED_NEWER:
            self.log_signal.emit(
                f"Skipped syncing the bundled plugin ({updater.PLUGIN_VERSION}): "
                f"the installed plugin ({self.installed_plugin_version}) is newer."
            )
        return True

    def run(self):
        pm = _get_pm_command()
        if not pm:
            self.finished_signal.emit(False, "Neither pnpm nor npm was found in PATH.")
            return

        if self.mode == "setup":
            if not os.path.exists(self.vencord_dir):
                self.log_signal.emit("Cloning Vencord repository from GitHub...")
                if not shutil.which("git"):
                    self.finished_signal.emit(False, "Git was not found in PATH.")
                    return
                try:
                    res = subprocess.run(["git", "clone", VENCORD_REPO_URL, self.vencord_dir], capture_output=True, text=True)
                    if res.returncode != 0:
                        self.finished_signal.emit(False, f"Git clone failed: {res.stderr}")
                        return
                except Exception as e:
                    self.finished_signal.emit(False, f"Git clone exception: {e}")
                    return

            if not self._sync_plugin_files():
                return

            self.log_signal.emit(f"Running '{pm} install --frozen-lockfile'...")
            install_cmd = [pm, "install", "--frozen-lockfile"] if pm == "pnpm" else [pm, "install"]
            res = subprocess.run(install_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True)
            if res.returncode != 0:
                self.log_signal.emit(f"Warning: Install completed with code {res.returncode}")

            self.log_signal.emit(f"Building Vencord ('{pm} build')...")
            res = subprocess.run([pm, "build"], cwd=self.vencord_dir, capture_output=True, text=True, shell=True)
            if res.returncode != 0:
                self.finished_signal.emit(False, f"Vencord build failed: {res.stderr or res.stdout}")
                return

            self.log_signal.emit(f"Injecting Vencord into Discord ('{pm} inject')...")
            res = subprocess.run([pm, "inject"], cwd=self.vencord_dir, capture_output=True, text=True, shell=True)
            self.finished_signal.emit(True, "Vencord setup, build, and inject completed successfully!")

        elif self.mode == "build":
            if not self._sync_plugin_files():
                return

            self.log_signal.emit(f"Building Vencord ('{pm} build')...")
            res = subprocess.run([pm, "build"], cwd=self.vencord_dir, capture_output=True, text=True, shell=True)
            if res.returncode != 0:
                self.finished_signal.emit(False, f"Vencord build failed: {res.stderr or res.stdout}")
                return

            self.finished_signal.emit(True, "Vencord built successfully!")
