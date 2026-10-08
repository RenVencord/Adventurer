import json
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


def is_valid_vencord_source_dir(path: str) -> bool:
    """True only if path is an actual buildable Vencord source repository (not an AppData folder)."""
    if not path or not os.path.isdir(path):
        return False

    norm = os.path.normpath(os.path.abspath(path)).lower()
    # Explicitly reject Discord's installed AppData directories
    if "\\appdata\\roaming\\vencord" in norm or "\\appdata\\local\\vencord" in norm:
        return False
    if "/.config/vencord" in norm or "/.var/app" in norm:
        return False

    # Check for Vencord repository source structure
    has_build_script = os.path.isfile(os.path.join(path, "scripts", "build", "build.mjs"))
    has_plugins_dir = os.path.isdir(os.path.join(path, "src", "plugins"))

    pkg_json_path = os.path.join(path, "package.json")
    has_build_pkg = False
    if os.path.isfile(pkg_json_path):
        try:
            with open(pkg_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                has_build_pkg = "build" in data.get("scripts", {})
        except Exception:
            pass

    return (has_build_script or has_plugins_dir) and has_build_pkg


def find_vencord_dir(custom_path: str = None) -> str | None:
    if custom_path and is_valid_vencord_source_dir(custom_path):
        return os.path.abspath(custom_path)

    candidates = [
        os.path.join(os.path.expanduser("~"), "Vencord"),
        "C:\\Vencord",
        os.path.join(os.path.expanduser("~"), "Documents", "Vencord"),
        os.path.join(os.path.expanduser("~"), "src", "Vencord"),
        os.path.join(os.path.expanduser("~"), "Projects", "Vencord"),
    ]

    for cand in candidates:
        if is_valid_vencord_source_dir(cand):
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


def _refresh_path() -> None:
    """Update current process PATH from the Windows Registry or known fallback directories."""
    if sys.platform == "win32":
        try:
            import winreg
            paths = []
            # Machine PATH
            try:
                with winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
                ) as key:
                    val, _ = winreg.QueryValueEx(key, "Path")
                    paths.extend(val.split(";"))
            except Exception:
                pass
            # User PATH
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as key:
                    val, _ = winreg.QueryValueEx(key, "Path")
                    paths.extend(val.split(";"))
            except Exception:
                pass

            pnpm_home = os.environ.get("PNPM_HOME", "")
            well_known = [
                r"C:\Program Files\nodejs",
                r"C:\Program Files (x86)\nodejs",
                os.path.expandvars(r"%ProgramFiles%\nodejs"),
                os.path.expandvars(r"%ProgramW6432%\nodejs"),
                os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs"),
                os.path.expandvars(r"%LOCALAPPDATA%\Programs\node"),
                os.path.expandvars(r"%APPDATA%\npm"),
                os.path.expandvars(r"%LOCALAPPDATA%\pnpm"),
                os.path.expandvars(r"%APPDATA%\pnpm"),
                os.path.expandvars(r"%USERPROFILE%\AppData\Local\pnpm"),
                os.path.expandvars(r"%USERPROFILE%\AppData\Roaming\pnpm"),
                pnpm_home,
                os.path.expandvars(r"%APPDATA%\nvm"),
                os.path.expandvars(r"%NVM_HOME%"),
                os.path.expandvars(r"%NVM_SYMLINK%"),
                os.path.expandvars(r"%USERPROFILE%\.volta\bin"),
                os.path.expandvars(r"%USERPROFILE%\.fnm\current"),
                os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\cmd"),
                r"C:\Program Files\Git\cmd",
                r"C:\Program Files\Git\bin",
            ]
            for d in well_known:
                if d and os.path.isdir(d) and d not in paths:
                    paths.append(d)

            current = [p.strip().strip('"') for p in os.environ.get("PATH", "").split(";") if p.strip()]
            for p in paths:
                p_clean = p.strip().strip('"')
                if p_clean and os.path.isdir(p_clean) and p_clean not in current:
                    current.append(p_clean)

            # Prioritize directories that actually contain node.exe, git.exe, or pnpm.exe
            priority = []
            for candidate in [
                r"C:\Program Files\nodejs",
                r"C:\Program Files (x86)\nodejs",
                os.path.expandvars(r"%LOCALAPPDATA%\pnpm"),
                pnpm_home,
                os.path.expandvars(r"%LOCALAPPDATA%\Programs\Git\cmd"),
                r"C:\Program Files\Git\cmd",
            ]:
                if candidate and os.path.isdir(candidate):
                    for exe_name in ("node.exe", "pnpm.exe", "git.exe"):
                        if os.path.isfile(os.path.join(candidate, exe_name)):
                            if candidate not in priority:
                                priority.append(candidate)
                            break

            for pdir in reversed(priority):
                if pdir in current:
                    current.remove(pdir)
                current.insert(0, pdir)

            os.environ["PATH"] = ";".join(current)
        except Exception:
            pass


def _get_pm_command() -> str:
    _refresh_path()
    if shutil.which("pnpm"):
        return "pnpm"
    elif shutil.which("npm"):
        return "npm"
    return ""


def _detect_linux_pm() -> tuple[str, list[str], list[str]]:
    """Detect Linux package manager and return (name, update_cmd, install_cmd)."""
    if shutil.which("apt-get"):
        return "apt-get", ["apt-get", "update"], ["apt-get", "install", "-y", "git", "nodejs", "npm"]
    elif shutil.which("dnf"):
        return "dnf", [], ["dnf", "install", "-y", "git", "nodejs", "npm"]
    elif shutil.which("pacman"):
        return "pacman", [], ["pacman", "-S", "--noconfirm", "git", "nodejs", "npm"]
    elif shutil.which("zypper"):
        return "zypper", [], ["zypper", "install", "-y", "git", "nodejs", "npm"]
    return "", [], []


def _install_prerequisites_windows(need_git: bool, need_node: bool, need_pm: bool = False, log_callback=None) -> tuple[bool, str]:
    """Automate installation of Git and Node.js via winget/pnpm on Windows."""
    def _log(msg: str):
        if log_callback:
            log_callback(msg)

    _refresh_path()
    if need_git and shutil.which("git"):
        need_git = False
    if need_node and shutil.which("node"):
        need_node = False
    if need_pm and _get_pm_command():
        need_pm = False

    if not need_git and not need_node and not need_pm:
        return True, "All prerequisites are installed."

    winget = shutil.which("winget")
    winget_flags = [
        "-e",
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
    ]

    if need_git:
        if not winget:
            return False, "Git is missing and winget was not found. Please install Git manually from https://git-scm.com."
        _log("Git was not found. Installing Git via winget...")
        try:
            res = subprocess.run(
                ["winget", "install", "--id", "Git.Git"] + winget_flags,
                capture_output=True, text=True, shell=True, env=os.environ.copy()
            )
            _refresh_path()
            if not shutil.which("git"):
                _log(f"Winget Git output: {res.stdout or res.stderr}")
                return False, f"Failed to install Git automatically. Exit code: {res.returncode}. Please install Git manually from https://git-scm.com."
            _log("Git installed successfully.")
            need_git = False
        except Exception as e:
            return False, f"Failed to run winget to install Git: {e}"

    if need_node:
        # If standalone pnpm is already present, try pnpm's built-in node version manager first (fast, no admin needed)
        pnpm_bin = shutil.which("pnpm")
        if pnpm_bin:
            _log("Standalone pnpm detected without Node.js runtime. Installing Node.js LTS via pnpm...")
            try:
                res = subprocess.run(
                    [pnpm_bin, "env", "use", "--global", "lts"],
                    capture_output=True, text=True, shell=True, env=os.environ.copy()
                )
                _refresh_path()
                if shutil.which("node"):
                    _log("Node.js LTS installed and activated via pnpm.")
                    need_node = False
                else:
                    _log("pnpm env completed, but 'node' was not recognized. Falling back to winget...")
            except Exception as e:
                _log(f"pnpm env failed ({e}). Falling back to winget...")

        # If node is still missing, install Node.js LTS via winget
        if shutil.which("node") is None:
            if not winget:
                return False, "Node.js is missing and winget was not found. Please install Node.js manually from https://nodejs.org."
            _log("Node.js was not found. Installing Node.js LTS via winget...")
            try:
                res = subprocess.run(
                    ["winget", "install", "--id", "OpenJS.NodeJS.LTS"] + winget_flags,
                    capture_output=True, text=True, shell=True, env=os.environ.copy()
                )
                _refresh_path()
                if not shutil.which("node"):
                    _log("Trying winget OpenJS.NodeJS...")
                    res = subprocess.run(
                        ["winget", "install", "--id", "OpenJS.NodeJS"] + winget_flags,
                        capture_output=True, text=True, shell=True, env=os.environ.copy()
                    )
                    _refresh_path()

                if not shutil.which("node"):
                    _log(f"Winget Node.js output: {res.stdout or res.stderr}")
                    return False, f"Failed to install Node.js automatically. Exit code: {res.returncode}. Please install Node.js manually from https://nodejs.org."
                _log("Node.js installed successfully.")
                need_node = False
            except Exception as e:
                return False, f"Failed to run winget to install Node.js: {e}"

    # Prefer pnpm over npm for speed and reliable lockfile builds
    _refresh_path()
    if not shutil.which("pnpm"):
        if shutil.which("npm"):
            _log("Installing pnpm globally via npm for faster Vencord builds...")
            try:
                subprocess.run(["npm", "install", "-g", "pnpm"], capture_output=True, text=True, shell=True, env=os.environ.copy())
                _refresh_path()
                if shutil.which("pnpm"):
                    _log("pnpm installed successfully.")
            except Exception:
                _log("Could not install pnpm globally; will fall back to npm.")
        elif winget:
            _log("Installing pnpm via winget...")
            try:
                subprocess.run(["winget", "install", "--id", "pnpm.pnpm"] + winget_flags, capture_output=True, text=True, shell=True, env=os.environ.copy())
                _refresh_path()
            except Exception:
                pass

    _refresh_path()
    if not shutil.which("node"):
        return False, "Node.js was not found after installation. Please restart Adventurer or install Node.js manually from https://nodejs.org."

    if not _get_pm_command():
        return False, "Neither pnpm nor npm was found after installation. Please install Node.js manually from https://nodejs.org."

    return True, "Prerequisites installed."


def _install_prerequisites_linux(need_git: bool, need_node: bool, need_pm: bool = False, log_callback=None) -> tuple[bool, str]:
    """Check and assist with prerequisites on Linux (using PolicyKit pkexec if available)."""
    def _log(msg: str):
        if log_callback:
            log_callback(msg)

    pm_name, update_cmd, install_cmd = _detect_linux_pm()
    needed = []
    if need_git:
        needed.append("git")
    if need_node:
        needed.append("nodejs")
    if need_pm:
        needed.append("npm")
    needed_str = " and ".join(needed)

    if not pm_name:
        return False, (
            f"Missing prerequisites ({needed_str}). "
            "Could not detect your Linux package manager (apt, dnf, pacman, zypper). "
            "Please install Git and Node.js using your distribution's package manager."
        )

    sudo_cmd_str = f"sudo {' '.join(install_cmd)}"
    if update_cmd:
        sudo_cmd_str = f"sudo {' '.join(update_cmd)} && " + sudo_cmd_str

    if shutil.which("pkexec"):
        _log(f"{needed_str.capitalize()} missing. Requesting authorization to install via PolicyKit (pkexec)...")
        try:
            if update_cmd:
                subprocess.run(["pkexec"] + update_cmd, capture_output=True, text=True, env=os.environ.copy())
            res = subprocess.run(["pkexec"] + install_cmd, capture_output=True, text=True, env=os.environ.copy())
            _refresh_path()
            if (not need_git or shutil.which("git")) and (not need_node or shutil.which("node")) and (not need_pm or _get_pm_command()):
                _log("Prerequisites installed successfully on Linux.")
                return True, "Prerequisites installed."
            _log(f"pkexec install failed or was canceled. Exit code: {res.returncode}")
        except Exception as e:
            _log(f"PolicyKit execution error: {e}")

    return False, (
        f"Missing prerequisites: {needed_str}.\n\n"
        f"Please run the following command in your terminal to install them:\n\n"
        f"    {sudo_cmd_str}\n\n"
        "After installation, run the 1-Click Setup again."
    )


def ensure_prerequisites(log_callback=None, check_git: bool = True) -> tuple[bool, str]:
    """Ensure Git, Node.js, and pnpm/npm are installed on the system."""
    _refresh_path()
    need_git = check_git and (shutil.which("git") is None)
    need_node = (shutil.which("node") is None)
    has_pm = bool(_get_pm_command())
    need_pm = not has_pm

    if not need_git and not need_node and not need_pm:
        return True, "All prerequisites are installed."

    if sys.platform == "win32":
        return _install_prerequisites_windows(need_git, need_node, need_pm, log_callback)
    elif sys.platform.startswith("linux"):
        return _install_prerequisites_linux(need_git, need_node, need_pm, log_callback)
    elif sys.platform == "darwin":
        missing = []
        if need_git:
            missing.append("git")
        if need_node:
            missing.append("node")
        if need_pm:
            missing.append("pnpm")
        return False, (
            f"Missing prerequisites ({', '.join(missing)}). "
            f"Please install them via Homebrew in your terminal:\n\n"
            f"    brew install {' '.join(missing)}"
        )
    else:
        return False, "Missing prerequisites (Git, Node.js). Please install them for your operating system."


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
        need_git = (self.mode == "setup" and not is_valid_vencord_source_dir(self.vencord_dir))
        self.log_signal.emit("Checking build prerequisites...")
        ready, msg = ensure_prerequisites(log_callback=self.log_signal.emit, check_git=need_git)
        if not ready:
            self.finished_signal.emit(False, msg)
            return

        pm = _get_pm_command()
        if not pm:
            self.finished_signal.emit(False, "Neither pnpm nor npm was found in PATH.")
            return

        node_path = shutil.which("node")
        if not node_path:
            self.finished_signal.emit(False, "Node.js ('node') was not found in PATH.")
            return

        self.log_signal.emit(f"Using package manager: {pm}")
        self.log_signal.emit(f"Using Node.js runtime: {node_path}")

        build_cmd = [pm, "run", "build"]
        inject_cmd = [pm, "run", "inject"]

        if self.mode == "setup":
            norm = os.path.normpath(os.path.abspath(self.vencord_dir)).lower()
            if "\\appdata\\roaming\\vencord" in norm or "\\appdata\\local\\vencord" in norm or not self.vencord_dir:
                default_target = os.path.join(os.path.expanduser("~"), "Vencord")
                self.log_signal.emit(
                    f"Notice: '{self.vencord_dir}' is Vencord's AppData configuration folder, not source code. "
                    f"Redirecting setup destination to '{default_target}'."
                )
                self.vencord_dir = default_target

            if not is_valid_vencord_source_dir(self.vencord_dir):
                if os.path.exists(self.vencord_dir) and os.listdir(self.vencord_dir):
                    default_target = os.path.join(os.path.expanduser("~"), "Vencord")
                    if os.path.abspath(self.vencord_dir) != os.path.abspath(default_target) and (not os.path.exists(default_target) or not os.listdir(default_target)):
                        self.log_signal.emit(f"Changing target to clean folder '{default_target}'...")
                        self.vencord_dir = default_target
                    else:
                        self.finished_signal.emit(
                            False,
                            f"The folder '{self.vencord_dir}' exists and is not empty, but is not a valid Vencord source repository.\n\n"
                            "Please choose an empty folder or delete it to proceed with 1-Click Setup."
                        )
                        return

                if not os.path.exists(self.vencord_dir) or not os.listdir(self.vencord_dir):
                    self.log_signal.emit(f"Cloning Vencord repository into '{self.vencord_dir}'...")
                    if not shutil.which("git"):
                        self.finished_signal.emit(False, "Git was not found in PATH.")
                        return
                    try:
                        res = subprocess.run(["git", "clone", VENCORD_REPO_URL, self.vencord_dir], capture_output=True, text=True, shell=True, env=os.environ.copy())
                        if res.returncode != 0:
                            self.finished_signal.emit(False, f"Git clone failed: {res.stderr or res.stdout}")
                            return
                    except Exception as e:
                        self.finished_signal.emit(False, f"Git clone exception: {e}")
                        return

            if not self._sync_plugin_files():
                return

            self.log_signal.emit(f"Running '{pm} install'...")
            install_cmd = [pm, "install", "--frozen-lockfile"] if pm == "pnpm" else [pm, "install"]
            res = subprocess.run(install_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())
            if res.returncode != 0:
                self.log_signal.emit(f"Warning: Install completed with code {res.returncode}")

            self.log_signal.emit(f"Building Vencord ('{' '.join(build_cmd)}')...")
            res = subprocess.run(build_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())
            if res.returncode != 0:
                self.finished_signal.emit(False, f"Vencord build failed: {res.stderr or res.stdout}")
                return

            self.log_signal.emit(f"Injecting Vencord into Discord ('{' '.join(inject_cmd)}')...")
            res = subprocess.run(inject_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())
            if res.returncode != 0:
                self.finished_signal.emit(False, f"Vencord inject failed: {res.stderr or res.stdout}")
                return

            self.finished_signal.emit(True, "Vencord setup, build, and inject completed successfully!")

        elif self.mode == "build":
            if not is_valid_vencord_source_dir(self.vencord_dir):
                if "appdata" in self.vencord_dir.lower():
                    self.finished_signal.emit(
                        False,
                        f"The selected folder '{self.vencord_dir}' is Vencord's AppData configuration folder, "
                        "not the Vencord source code repository.\n\n"
                        "Please click '1-Click Full Setup' to clone and build Vencord from source into ~/Vencord."
                    )
                    return
                self.finished_signal.emit(
                    False,
                    f"The directory '{self.vencord_dir}' is not a valid Vencord source repository (missing build.mjs/package.json).\n\n"
                    "Please click '1-Click Full Setup' to set up Vencord from source."
                )
                return

            if not self._sync_plugin_files():
                return

            # If node_modules is missing, run install first
            if not os.path.isdir(os.path.join(self.vencord_dir, "node_modules")):
                self.log_signal.emit(f"Dependencies not installed. Running '{pm} install'...")
                install_cmd = [pm, "install", "--frozen-lockfile"] if pm == "pnpm" else [pm, "install"]
                res = subprocess.run(install_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())
                if res.returncode != 0:
                    self.log_signal.emit(f"Warning: Install completed with code {res.returncode}")

            self.log_signal.emit(f"Building Vencord ('{' '.join(build_cmd)}')...")
            res = subprocess.run(build_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())
            if res.returncode != 0:
                # If build failed due to dependency sync issue or broken previous install, retry with clean install
                combined = f"{res.stderr}\n{res.stdout}"
                if any(k in combined.lower() for k in ("out of sync", "lifecycle", "failed to run", "cannot find module")):
                    self.log_signal.emit(f"Build failed due to dependency sync issue. Running '{pm} install'...")
                    install_cmd = [pm, "install"]
                    subprocess.run(install_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())
                    self.log_signal.emit(f"Retrying Vencord build ('{' '.join(build_cmd)}')...")
                    res = subprocess.run(build_cmd, cwd=self.vencord_dir, capture_output=True, text=True, shell=True, env=os.environ.copy())

            if res.returncode != 0:
                self.finished_signal.emit(False, f"Vencord build failed: {res.stderr or res.stdout}")
                return

            self.finished_signal.emit(True, "Vencord built successfully!")
