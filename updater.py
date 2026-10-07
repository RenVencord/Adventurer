import os
import sys
import json
import hashlib
import http.client
import subprocess
import urllib.parse
import urllib.request
import urllib.error
import plugin_files
import server_state

def _log(msg: str):
    if server_state.should_log("updater"):
        server_state.log_event(f"[Updater] {msg}")

def _get_local_version_info() -> tuple[str, str]:
    manifest_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "version_manifest.json")
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        manifest_path = os.path.join(sys._MEIPASS, "version_manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("app_version", "1.0.0"), data.get("plugin_version", "1.0.0")
        except Exception:
            pass
    return "1.0.0", "1.0.0"

APP_VERSION, PLUGIN_VERSION = _get_local_version_info()
REPO_OWNER = "RenVencord"
REPO_NAME = "Adventurer"

MANIFEST_RAW_URL = f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/main/version_manifest.json"
PLUGIN_TREE_API_URL = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/git/trees/main?recursive=1"
PLUGIN_RAW_BASE_URL = f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/main/"
RELEASES_API_URL = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases/latest"


class PluginDownloadError(Exception):
    pass


def _http_get(url: str, timeout: int = 15) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Adventurer-Updater"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise PluginDownloadError(f"HTTP {resp.status} for {url}")
        return resp.read()


def _git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def parse_semver(ver_str: str) -> tuple[int, int, int]:
    clean = ver_str.lstrip("v").strip()
    parts = clean.split(".")
    nums = []
    for p in parts:
        num_str = ""
        for char in p:
            if char.isdigit():
                num_str += char
            else:
                break
        nums.append(int(num_str) if num_str else 0)
    while len(nums) < 3:
        nums.append(0)
    return tuple(nums[:3])


def is_version_newer(current_ver: str, remote_ver: str, scope: str = "Any") -> bool:
    if scope == "None":
        return False

    c_major, c_minor, c_patch = parse_semver(current_ver)
    r_major, r_minor, r_patch = parse_semver(remote_ver)

    if scope == "Major":
        return r_major > c_major

    return (r_major, r_minor, r_patch) > (c_major, c_minor, c_patch)


class AutoUpdater:
    def __init__(self, settings_mgr_dict: dict):
        self.prefs = settings_mgr_dict
        self.latest_app_release = None
        self.latest_app_version = ""
        self.app_download_url = ""
        self.app_changelog = ""

        self.latest_plugin_version = ""

    def check_app_update(self) -> tuple[bool, str, str, str]:
        scope = self.prefs.get("update_scope", "Any")
        if scope == "None":
            return False, "", "", ""

        skipped = self.prefs.get("skipped_app_version", "")
        try:
            req = urllib.request.Request(RELEASES_API_URL, headers={"User-Agent": "Adventurer-Updater"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    tag = data.get("tag_name", "").strip()
                    if not tag or tag == skipped:
                        return False, "", "", ""

                    if is_version_newer(APP_VERSION, tag, scope):
                        self.latest_app_release = data
                        self.latest_app_version = tag
                        self.app_changelog = data.get("body", "No release notes provided.")

                        for asset in data.get("assets", []):
                            if asset.get("name", "").endswith(".exe"):
                                self.app_download_url = asset.get("browser_download_url", "")
                                break

                        _log(f"App update available: {tag}")
                        return True, self.latest_app_version, self.app_changelog, self.app_download_url
        except Exception as e:
            _log(f"App update check failed: {e}")
        return False, "", "", ""

    def check_plugin_update(self) -> tuple[bool, str]:
        scope = self.prefs.get("update_scope", "Any")
        if scope == "None":
            return False, ""

        skipped = self.prefs.get("skipped_plugin_version", "")
        try:
            req = urllib.request.Request(MANIFEST_RAW_URL, headers={"User-Agent": "Adventurer-Updater"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    remote_plugin_ver = data.get("plugin_version", "").strip()
                    if not remote_plugin_ver or remote_plugin_ver == skipped:
                        return False, ""

                    # The version recorded when the plugin in Vencord was last installed beats the bundled one.
                    installed_ver = self.prefs.get("installed_plugin_version", "").strip() or PLUGIN_VERSION
                    if is_version_newer(installed_ver, remote_plugin_ver, scope):
                        self.latest_plugin_version = remote_plugin_ver
                        _log(f"Plugin update available: {remote_plugin_ver}")
                        return True, remote_plugin_ver
        except Exception as e:
            _log(f"Plugin update check failed: {e}")
        return False, ""

    def download_app_update(self, download_url: str = None) -> bool:
        url = download_url or self.app_download_url
        if not url:
            return False

        if not getattr(sys, "frozen", False):
            _log("Skipping executable swap (running from python source).")
            return False

        current_exe = sys.executable
        if not current_exe.lower().endswith(".exe") or "python" in os.path.basename(current_exe).lower():
            return False

        new_exe_tmp = current_exe + ".new"
        try:
            _log(f"Downloading app update executable...")
            req = urllib.request.Request(url, headers={"User-Agent": "Adventurer-Updater"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(new_exe_tmp, "wb") as f:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)

            _log("Download complete. Triggering background executable swap...")
            self._trigger_exe_swap(current_exe, new_exe_tmp)
            return True
        except Exception as e:
            _log(f"Download app update failed: {e}")
            if os.path.exists(new_exe_tmp):
                try:
                    os.remove(new_exe_tmp)
                except Exception:
                    pass
            return False

    def _list_remote_plugin_files(self) -> dict[str, str]:
        """Map every plugin runtime file in the repository (path relative to the plugin folder) to its git blob sha."""
        tree = json.loads(_http_get(PLUGIN_TREE_API_URL).decode("utf-8"))
        if tree.get("truncated"):
            raise PluginDownloadError("GitHub returned a truncated file listing.")

        prefix = plugin_files.PLUGIN_DIR_NAME + "/"
        listed = {}
        for entry in tree.get("tree", []):
            path = entry.get("path", "")
            if entry.get("type") != "blob" or entry.get("mode") == "120000" or not path.startswith(prefix):
                continue
            rel = path[len(prefix):]
            if plugin_files.is_runtime_file(rel):
                listed[rel] = entry["sha"]

        if plugin_files.ENTRY_POINT not in listed:
            raise PluginDownloadError(f"The repository has no {plugin_files.ENTRY_POINT} in its plugin folder.")
        return listed

    def fetch_latest_plugin_files(self) -> dict[str, bytes] | None:
        """Download every runtime file of the plugin from GitHub.

        The file list comes from the git trees API, filtered by plugin_files.is_runtime_file, so new files upstream
        are picked up without a code change. Each download is checked against the blob sha of that listing, which
        also guarantees all files belong to the same repository snapshot.
        Returns {path relative to the plugin folder: content}, or None if anything is missing or invalid, so a
        partial download is never installed.
        """
        try:
            listed = self._list_remote_plugin_files()
            files = {}
            for rel, sha in listed.items():
                data = _http_get(PLUGIN_RAW_BASE_URL + urllib.parse.quote(f"{plugin_files.PLUGIN_DIR_NAME}/{rel}"))
                if not data:
                    raise PluginDownloadError(f"{rel} is empty.")
                if _git_blob_sha(data) != sha:
                    raise PluginDownloadError(f"{rel} does not match the repository listing (the repository changed during the download or a stale copy was served).")
                try:
                    data.decode("utf-8")
                except UnicodeDecodeError as e:
                    raise PluginDownloadError(f"{rel} is not valid UTF-8: {e}") from e
                files[rel] = data
            _log(f"Downloaded {len(files)} plugin files.")
            return files
        except (OSError, ValueError, KeyError, http.client.HTTPException, PluginDownloadError) as e:
            _log(f"Fetch plugin files failed: {e}")
        return None

    def _trigger_exe_swap(self, current_exe: str, new_exe: str):
        if sys.platform == "win32":
            cmd = (
                f'ping 127.0.0.1 -n 4 > nul && '
                f'del /f /q "{current_exe}" && '
                f'move /y "{new_exe}" "{current_exe}" && '
                f'explorer "{current_exe}"'
            )
            subprocess.Popen(f'cmd.exe /c "{cmd}"', shell=True, creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            cmd = f'sleep 2 && rm -f "{current_exe}" && mv -f "{new_exe}" "{current_exe}" && "{current_exe}" &'
            subprocess.Popen(cmd, shell=True)
        os._exit(0)
