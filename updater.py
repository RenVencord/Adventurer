import os
import sys
import json
import subprocess
import urllib.request
import urllib.error

APP_VERSION = "1.0.0"
PLUGIN_VERSION = "1.0.0"
REPO_OWNER = "RenVencord"
REPO_NAME = "Adventurer"

MANIFEST_RAW_URL = f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/main/version_manifest.json"
PLUGIN_RAW_URL = f"https://raw.githubusercontent.com/{REPO_OWNER}/{REPO_NAME}/main/adventurer/index.tsx"
RELEASES_API_URL = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases/latest"


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

                        return True, self.latest_app_version, self.app_changelog, self.app_download_url
        except Exception as e:
            print(f"App update check failed: {e}")
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

                    if is_version_newer(PLUGIN_VERSION, remote_plugin_ver, scope):
                        self.latest_plugin_version = remote_plugin_ver
                        return True, remote_plugin_ver
        except Exception as e:
            print(f"Plugin update check failed: {e}")
        return False, ""

    def download_app_update(self, download_url: str = None) -> bool:
        url = download_url or self.app_download_url
        if not url:
            return False

        current_exe = sys.executable
        if not current_exe.endswith(".exe"):
            return False

        new_exe_tmp = current_exe + ".new"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Adventurer-Updater"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(new_exe_tmp, "wb") as f:
                while True:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)

            self._trigger_exe_swap(current_exe, new_exe_tmp)
            return True
        except Exception as e:
            print(f"Download app update failed: {e}")
            if os.path.exists(new_exe_tmp):
                try:
                    os.remove(new_exe_tmp)
                except Exception:
                    pass
            return False

    def fetch_latest_plugin_code(self) -> str | None:
        try:
            req = urllib.request.Request(PLUGIN_RAW_URL, headers={"User-Agent": "Adventurer-Updater"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status == 200:
                    return resp.read().decode("utf-8")
        except Exception as e:
            print(f"Fetch plugin code failed: {e}")
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
