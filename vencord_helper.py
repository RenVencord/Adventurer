import os
import sys
import shutil
import subprocess
from PyQt6.QtCore import QThread, pyqtSignal

VENCORD_REPO_URL = "https://github.com/Vendicated/Vencord"


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


def sync_plugin_file(vencord_dir: str, code_content: str = None) -> bool:
    if not vencord_dir or not os.path.exists(vencord_dir):
        return False

    plugin_dir = os.path.join(vencord_dir, "src", "userplugins", "adventurer")
    os.makedirs(plugin_dir, exist_ok=True)
    target_file = os.path.join(plugin_dir, "index.tsx")

    try:
        if code_content:
            with open(target_file, "w", encoding="utf-8") as f:
                f.write(code_content)
        else:
            bundled = get_bundled_plugin_path()
            if not os.path.exists(bundled):
                return False
            shutil.copy2(bundled, target_file)
        return True
    except Exception as e:
        print(f"Failed to sync plugin file: {e}")
        return False


def _get_pm_command() -> str:
    if shutil.which("pnpm"):
        return "pnpm"
    elif shutil.which("npm"):
        return "npm"
    return ""


class VencordBuildWorker(QThread):
    log_signal = pyqtSignal(str)
    finished_signal = pyqtSignal(bool, str)

    def __init__(self, vencord_dir: str, mode: str = "build"):
        super().__init__()
        self.vencord_dir = vencord_dir
        self.mode = mode

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

            self.log_signal.emit("Syncing Adventurer plugin files...")
            sync_plugin_file(self.vencord_dir)

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
            self.log_signal.emit("Syncing Adventurer plugin files...")
            sync_plugin_file(self.vencord_dir)

            self.log_signal.emit(f"Building Vencord ('{pm} build')...")
            res = subprocess.run([pm, "build"], cwd=self.vencord_dir, capture_output=True, text=True, shell=True)
            if res.returncode != 0:
                self.finished_signal.emit(False, f"Vencord build failed: {res.stderr or res.stdout}")
                return

            self.finished_signal.emit(True, "Vencord built successfully!")
