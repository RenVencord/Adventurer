import logging
import re
import socket
import subprocess
import sys
import threading
import os
import shutil
import time
from pathlib import Path
import psutil
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

import server_state

# ---------------------------------------------------------------------------
# Path helpers: resolve bundled assets (PyInstaller) and user data directory
# ---------------------------------------------------------------------------

APPDATA_DIR = Path.home() / ".Adventurer"


def get_asset_path(relative: str) -> Path:
    """Resolve a path relative to the application assets (handles PyInstaller)."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / relative
    return Path(os.path.dirname(os.path.abspath(__file__))) / relative


def ensure_appdata_dir():
    """Create the ~/.Adventurer directory if it doesn't exist."""
    APPDATA_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
log = logging.getLogger(__name__)

class NoRequestLogFilter(logging.Filter):
    def filter(self, record):
        try:
            msg = record.getMessage()
            return "HTTP/1.1" not in msg and "HTTP/1.0" not in msg
        except Exception:
            return True

logging.getLogger("werkzeug").addFilter(NoRequestLogFilter())

app = Flask(__name__)

@app.before_request
def log_request_info():
    if request.method == "OPTIONS":
        return
    if server_state.should_log("server"):
        server_state.log_event(f"{request.method} {request.path}")
    if request.path not in ["/heartbeat", "/log", "/status", "/users"]:
        log.info(f"Received \033[96m{request.method} {request.path}\033[0m")


CORS(app, origins=[
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com"
])

PREFS_FILE = APPDATA_DIR / "adventurer_settings.json"


def get_fake_games_dir() -> Path:
    if PREFS_FILE.exists():
        try:
            import json
            with open(PREFS_FILE, "r") as f:
                data = json.load(f)
                val = data.get("fake_games_dir")
                if val:
                    return Path(os.path.expanduser(val)).resolve()
        except Exception:
            pass
    return APPDATA_DIR


_single_instance_mutex = None


def ensure_single_instance(mutex_name: str = "Adventurer_SingleInstance_Mutex") -> bool:
    global _single_instance_mutex
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        ERROR_ALREADY_EXISTS = 183
        mutex = kernel32.CreateMutexW(None, False, mutex_name)
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            return False
        _single_instance_mutex = mutex
        return True
    return True


STUB_EXE = APPDATA_DIR / ("stub.exe" if sys.platform == "win32" else "stub")


def _install_stub_if_needed():
    """Install stub.exe to ~/.Adventurer on startup if it's missing.

    Frozen build: copies from the bundled _MEIPASS data.
    Dev mode: attempts to build it via build_stub.py.
    """
    if STUB_EXE.exists():
        log.info(f"Stub already installed at {STUB_EXE}")
        return

    stub_name = "stub.exe" if sys.platform == "win32" else "stub"

    if getattr(sys, "frozen", False):
        bundled = get_asset_path(stub_name)
        log.info(f"Frozen build - looking for bundled stub at {bundled}")
        if bundled.exists():
            shutil.copy2(str(bundled), str(STUB_EXE))
            log.info(f"Installed bundled stub to {STUB_EXE}")
            server_state.log_event(f"Installed stub from bundle")
        else:
            log.error(f"Bundled stub NOT found at {bundled} - add {stub_name} to your .spec datas!")
            server_state.log_event(f"Error: Bundled stub missing - add {stub_name} to .spec datas")
    else:
        build_script = get_asset_path("build_stub.py")
        log.info(f"Dev mode - stub missing, build script at {build_script} (exists: {build_script.exists()})")
        if build_script.exists():
            log.info("Auto-building stub...")
            server_state.log_event("Building stub executable...")
            try:
                result = subprocess.run(
                    [sys.executable, str(build_script)],
                    check=True, timeout=120,
                    capture_output=True, text=True,
                )
                if result.stdout:
                    log.info(f"Build output: {result.stdout.strip()}")
                if result.stderr:
                    log.info(f"Build stderr: {result.stderr.strip()}")
                if STUB_EXE.exists():
                    log.info(f"Stub built successfully at {STUB_EXE}")
                else:
                    log.error("Build script ran but stub.exe was not created")
            except Exception as e:
                log.error(f"Stub auto-build failed: {e}")
                server_state.log_event(f"Error: Stub build failed: {e}")
        else:
            log.warning(f"No build_stub.py found at {build_script}")


# Ensure ~/.Adventurer exists on startup
ensure_appdata_dir()
_install_stub_if_needed()
log.info(f"App data directory: {APPDATA_DIR}")
log.info(f"Stub executable path: {STUB_EXE} (exists: {STUB_EXE.exists()})")
log.info(f"Fake games directory: {get_fake_games_dir()}")
server_state.log_event(f"Data dir: {APPDATA_DIR}")
server_state.log_event(f"Stub: {STUB_EXE} ({'found' if STUB_EXE.exists() else 'NOT found'})")
DETECTABLE_URL = "https://discord.com/api/v10/applications/detectable"

_detectable_cache: list | None = None
_running = {}


def sanitize(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "_", name)


def get_detectable() -> list:
    global _detectable_cache
    if _detectable_cache is None:
        log.info("Fetching detectable applications from Discord...")
        resp = requests.get(DETECTABLE_URL, timeout=10)
        resp.raise_for_status()
        _detectable_cache = resp.json()
        log.info(f"Loaded {len(_detectable_cache)} detectable apps")
    return _detectable_cache


def find_app(app_id: str) -> dict | None:
    for app in get_detectable():
        if app["id"] == app_id:
            return app
        for linked in app.get("linked_applications", []):
            if linked.get("id") == app_id:
                return app
    return None


def ensure_executable(app_data: dict, user_id: str | None = None, force_exe: str | None = None) -> Path | None:
    name = sanitize(app_data["name"])
    log.info(f"ensure_executable: app={name!r}, force_exe={force_exe!r}")

    if force_exe:
        exe_name = force_exe
    else:
        executables = app_data.get("executables", [])
        log.info(f"ensure_executable: available executables = {executables}")
        exe_info = next(
            (e for e in executables if e.get("os") == "win32"),
            None
        )
        if not exe_info:
            log.warning(f"ensure_executable: no win32 executable found for {name}")
            server_state.log_event(f"No win32 executable found for {name}", user_id)
            return None
        exe_name = exe_info["name"]

    exe_name = exe_name.replace(">", "")
    path_sep_split = exe_name.split('/')
    if len(path_sep_split) > 1:
        sanitized_split = list(map(lambda split: sanitize(split), path_sep_split))
        exe_name = os.sep.join(sanitized_split)
    else:
        exe_name = sanitize(exe_name)

    if not exe_name.lower().endswith(".exe"):
        exe_name += ".exe"

    exe_path = get_fake_games_dir() / name / exe_name
    log.info(f"ensure_executable: target exe path = {exe_path}")
    exe_path.parent.mkdir(parents=True, exist_ok=True)

    if not exe_path.exists():
        log.info(f"ensure_executable: exe does not exist yet, checking stub at {STUB_EXE}")
        if not STUB_EXE.exists():
            if getattr(sys, "frozen", False):
                # In a frozen build, the stub must be pre-bundled in _MEIPASS.
                # Look for it there and copy it to the user data directory.
                bundled_stub = get_asset_path("stub.exe" if sys.platform == "win32" else "stub")
                log.info(f"ensure_executable: frozen build - looking for bundled stub at {bundled_stub} (exists: {bundled_stub.exists()})")
                server_state.log_event(f"Looking for bundled stub at: {bundled_stub}", user_id)
                if bundled_stub.exists():
                    shutil.copy2(str(bundled_stub), str(STUB_EXE))
                    log.info(f"Copied bundled stub to {STUB_EXE}")
                    server_state.log_event("Installed bundled stub executable", user_id)
                else:
                    msg = f"Bundled stub not found at {bundled_stub}. Add stub.exe to your .spec data files."
                    log.error(msg)
                    server_state.log_event(f"Error: {msg}", user_id)
                    raise FileNotFoundError(msg)
            else:
                # Dev mode: attempt to auto-build the stub using build_stub.py
                build_stub = get_asset_path("build_stub.py")
                log.info(f"ensure_executable: dev mode - stub missing, build_stub = {build_stub} (exists: {build_stub.exists()})")
                if build_stub.exists():
                    log.info("Stub not found - attempting to build it automatically...")
                    server_state.log_event("Building stub executable...", user_id)
                    try:
                        result = subprocess.run(
                            [sys.executable, str(build_stub)],
                            check=True, timeout=120,
                            capture_output=True, text=True,
                        )
                        log.info(f"Stub build stdout: {result.stdout}")
                        if result.stderr:
                            log.info(f"Stub build stderr: {result.stderr}")
                    except Exception as build_err:
                        log.error(f"Auto-build of stub failed: {build_err}")
                        server_state.log_event(f"Error: Stub auto-build failed: {build_err}", user_id)

                if not STUB_EXE.exists():
                    msg = f"stub executable not found at {STUB_EXE}"
                    log.error(msg)
                    server_state.log_event(f"Error: {msg}", user_id)
                    raise FileNotFoundError(msg)

        log.info(f"Copying stub executable to {exe_path}")
        server_state.log_event(f"Created new stub for {name}", user_id)
        try:
            os.link(STUB_EXE, exe_path)
            log.info(f"ensure_executable: hard-linked stub to {exe_path}")
        except OSError:
            shutil.copy2(STUB_EXE, exe_path)
            log.info(f"ensure_executable: copied stub to {exe_path}")
    else:
        log.info(f"ensure_executable: exe already exists at {exe_path}")

    return exe_path


def launch_exe(path: Path) -> subprocess.Popen:
    log.info(f"Launching {path}")
    server_state.log_event(f"Launching: {path}")
    try:
        proc = subprocess.Popen([str(path)], cwd=path.parent)
        log.info(f"Launched process pid={proc.pid}")
        server_state.log_event(f"Process started (pid {proc.pid})")
        return proc
    except Exception as e:
        log.error(f"Failed to launch {path}: {e}")
        server_state.log_event(f"Error: Failed to launch {path}: {e}")
        raise


def _kill_all_running():
    for app_id, proc in list(_running.items()):
        try:
            parent = psutil.Process(proc.pid)
            for child in parent.children(recursive=True):
                try:
                    child.kill()
                    log.info(f"Killed child {child.pid} ({child.name()})")
                except psutil.NoSuchProcess:
                    pass
        except psutil.NoSuchProcess:
            pass

        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                log.warning(f"Process {proc.pid} did not exit after kill - giving up")
            log.info(f"Killed process for app {app_id} (pid {proc.pid})")

    _running.clear()


def _run_server_thread(port: int = 5000):
    """Wrapper for the server thread that catches and logs fatal errors."""
    try:
        run_server(port)
    except Exception as e:
        msg = f"Server thread crashed: {e}"
        log.error(msg)
        try:
            server_state.log_event(f"Error: {msg}")
        except Exception:
            pass


def cleanup_stubs():
    mode, days = server_state.get_stub_cleanup()

    base_dir = get_fake_games_dir()

    if not base_dir.exists():
        return

    running_paths = []
    for proc in list(_running.values()):
        try:
            if isinstance(proc.args, (list, tuple)):
                running_paths.append(Path(proc.args[0]).resolve())
            else:
                running_paths.append(Path(proc.args).resolve())
        except Exception:
            pass

    now = time.time()
    for app_dir in base_dir.iterdir():
        if not app_dir.is_dir():
            continue

        is_running = False
        for p in running_paths:
            if app_dir.resolve() in p.parents:
                is_running = True
                break

        if is_running:
            continue

        should_delete = False
        if mode == "always":
            should_delete = True
        elif mode == "days":
            try:
                mtime = app_dir.stat().st_mtime
                age_days = (now - mtime) / 86400.0
                if age_days >= days:
                    should_delete = True
            except Exception:
                pass

        if should_delete:
            try:
                shutil.rmtree(app_dir)
                log.info(f"Cleaned up stub directory: {app_dir.name}")
                if server_state.should_log("stubs"):
                    server_state.log_event(f"Cleaned up stub: {app_dir.name}")
            except Exception as e:
                log.error(f"Failed to clean up {app_dir.name}: {e}")


@app.route("/run", methods=["POST"])
def run():
    log.info("[/run] DEBUG TEST")
    body = request.get_json(silent=True) or {}
    app_id = body.get("id")
    quest_obj = body.get("quest")
    user_id = body.get("userId")
    force_exe = body.get("forceExe")

    quest_name = ""
    if quest_obj and isinstance(quest_obj, dict):
        cfg = quest_obj.get("config") or {}
        msgs = cfg.get("messages") or {}
        quest_name = msgs.get("questName") or msgs.get("gameTitle") or ""

    log.info(f"[/run] app_id={app_id}, user_id={user_id}, force_exe={force_exe}, quest={quest_name!r}")
    server_state.log_event(f"Run request: app={app_id}, quest={quest_name or 'none'}", user_id)

    if not app_id:
        msg = "Missing id in /run request"
        log.error(msg)
        server_state.log_event(f"Error: {msg}", user_id)
        return jsonify({"error": "missing id"}), 400

    app_data = find_app(str(app_id))
    if not app_data:
        # Try multiple locations for the app name (Discord removed config.application)
        cfg = quest_obj.get("config", {}) if quest_obj else {}
        app_name = (cfg.get("application", {}) or {}).get("name")
        if not app_name:
            # New Discord format: app info lives inside taskConfigV2
            tasks = (cfg.get("taskConfigV2", {}) or {}).get("tasks", {})
            for task_key in ["PLAY_ON_DESKTOP", "WATCH_VIDEO"]:
                task_apps = (tasks.get(task_key, {}) or {}).get("applications", [])
                if task_apps and isinstance(task_apps, list) and len(task_apps) > 0:
                    app_name = task_apps[0].get("name")
                    if app_name:
                        break
        if not app_name:
            app_name = (cfg.get("messages", {}) or {}).get("gameTitle")
        if app_name:
            app_data = {"id": str(app_id), "name": app_name, "executables": []}
            msg = f"App ID {app_id} not in public detectable list, using quest payload name '{app_name}'"
            log.info(msg)
            server_state.log_event(f"Warning: {msg}", user_id)
        else:
            msg = f"App ID {app_id} not found in public detectable list"
            log.warning(msg)
            server_state.log_event(f"Error: {msg}", user_id)
            return jsonify({"error": "app not found"}), 404

    log.info(f"Discord executables: {app_data.get('executables', [])}" )

    try:
        exe_path = ensure_executable(app_data, user_id, force_exe)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 400

    if not exe_path:
        name = sanitize(app_data["name"])
        executables = app_data.get("executables", [])
        if executables and isinstance(executables[0], dict) and "name" in executables[0]:
            fallback_exe = executables[0]["name"]
        else:
            fallback_exe = f"{name}.exe"

        fallback_exe = sanitize(fallback_exe.replace(">", ""))
        if not fallback_exe.lower().endswith(".exe"):
            fallback_exe += ".exe"

        msg = f"No suitable executable for {name} (requires_confirmation)"
        log.warning(msg)
        server_state.log_event(msg, user_id)
        return jsonify({
            "error": "no suitable executable",
            "requires_confirmation": True,
            "fallback_exe": fallback_exe
        }), 400

    if str(app_id) in _running and _running[str(app_id)].poll() is None:
        log.info(f"App {app_id} is already running")
        quest_id = quest_obj.get("id") if quest_obj else None
        server_state.set_active_quest(quest_id, quest_obj, "running", 0)
        return jsonify({"status": "launched", "name": app_data["name"]})

    _kill_all_running()

    try:
        proc = launch_exe(exe_path.absolute())
    except Exception as e:
        msg = f"Failed to launch executable: {e}"
        log.error(msg)
        server_state.log_event(f"Error: {msg}", user_id)
        return jsonify({"error": msg}), 500

    _running[str(app_id)] = proc

    quest_id = quest_obj.get("id") if quest_obj else None
    server_state.set_active_quest(quest_id, quest_obj, "running", 0)

    msg = f"Launched {app_data['name']} (quest {quest_id})"
    log.info(msg)
    server_state.log_event(msg, user_id)

    return jsonify({"status": "launched", "name": app_data["name"]})


def get_quest_app_id(quest: dict) -> str | None:
    if not quest or not isinstance(quest, dict):
        return None
    cfg = quest.get("config") or {}
    app_obj = cfg.get("application") or {}
    if app_obj.get("id"):
        return str(app_obj["id"])
    if quest.get("resolvedAppId"):
        return str(quest["resolvedAppId"])
    tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}
    for task_key in ["PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP"]:
        task_apps = (tasks.get(task_key) or {}).get("applications") or []
        if task_apps and isinstance(task_apps, list) and len(task_apps) > 0:
            app_id = task_apps[0].get("id")
            if app_id:
                return str(app_id)
    if quest.get("application_id"):
        return str(quest["application_id"])
    return None


def _is_quest_expired(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    cfg = quest.get("config") or {}
    expires_at = cfg.get("expiresAt")
    if not expires_at:
        return False
    try:
        from datetime import datetime, timezone
        expiry = datetime.fromisoformat(expires_at)
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > expiry
    except Exception:
        return False


def get_first_queued_quest(user_id: str | None = None) -> dict | None:
    state = server_state.get_state(user_id)
    quests = state.get("quests") or []
    skipped_ids = set(state.get("skipped_quest_ids") or [])

    eligible = []
    for q in quests:
        if not q or not isinstance(q, dict) or not q.get("id"):
            continue
        qid = str(q["id"])
        if qid in skipped_ids:
            continue
        user_status = q.get("userStatus")
        if user_status is None:
            continue
        if user_status.get("completedAt") or user_status.get("claimedAt"):
            continue
        if _is_quest_expired(q):
            continue

        cfg = q.get("config") or {}
        tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}
        has_desktop_task = "PLAY_ON_DESKTOP" in tasks or "STREAM_ON_DESKTOP" in tasks
        app_id = get_quest_app_id(q)
        if not has_desktop_task or not app_id:
            continue

        task_key = "PLAY_ON_DESKTOP" if "PLAY_ON_DESKTOP" in tasks else "STREAM_ON_DESKTOP"
        task_obj = tasks.get(task_key) or {}
        target = task_obj.get("target") or 1
        prog_entry = (user_status.get("progress") or {}).get(task_key) or {}
        val = prog_entry.get("value", 0) if isinstance(prog_entry, dict) else 0
        pct = val / target if target > 0 else 0.0

        expires_at = cfg.get("expiresAt")
        exp_ts = float("inf")
        if expires_at:
            try:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(expires_at)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                exp_ts = dt.timestamp()
            except Exception:
                pass

        eligible.append((pct, exp_ts, q))

    if not eligible:
        return None

    eligible.sort(key=lambda item: (-item[0], item[1]))
    return eligible[0][2]


@app.route("/active", methods=["POST"])
def active():
    body = request.get_json(silent=True) or {}
    quest_id = body.get("questId")
    quest_obj = body.get("quest")
    status_data = body.get("statusData") or {}

    status_type = status_data.get("type")
    ends_at = status_data.get("endsAt", 0)

    server_state.set_active_quest(quest_id, quest_obj, status_type, ends_at)
    return jsonify({"status": "ok"})


@app.route("/detectable", methods=["GET"])
def detectable():
    data = get_detectable()
    return jsonify({"count": len(data), "apps": [{"id": a["id"], "name": a["name"]} for a in data]})


@app.route("/stop", methods=["POST"])
def stop():
    body = request.get_json(silent=True) or {}
    user_id = body.get("userId") if body else None

    server_state.set_auto_complete_enabled(False)
    _kill_all_running()
    server_state.set_active_quest(None, None, None, 0)
    cleanup_stubs()

    msg = "All games stopped"
    log.info(msg)
    server_state.log_event(msg, user_id)

    return jsonify({"status": "stopped"})


@app.route("/start", methods=["POST"])
def start():
    body = request.get_json(silent=True) or {}
    user_id = body.get("userId") if body else None

    server_state.set_auto_complete_enabled(True)
    msg = "Auto complete started"
    log.info(msg)
    server_state.log_event(msg, user_id)

    first_quest = get_first_queued_quest(user_id)
    if first_quest:
        app_id = get_quest_app_id(first_quest)
        if app_id:
            app_data = find_app(str(app_id))
            if not app_data:
                cfg = first_quest.get("config") or {}
                app_name = (cfg.get("application") or {}).get("name")
                if not app_name:
                    tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}
                    for task_key in ["PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP"]:
                        task_apps = (tasks.get(task_key) or {}).get("applications") or []
                        if task_apps and isinstance(task_apps, list) and len(task_apps) > 0:
                            app_name = task_apps[0].get("name")
                            if app_name:
                                break
                if not app_name:
                    app_name = (cfg.get("messages") or {}).get("gameTitle")
                if app_name:
                    app_data = {"id": str(app_id), "name": app_name, "executables": []}

            if app_data:
                try:
                    exe_path = ensure_executable(app_data, user_id)
                    if exe_path:
                        _kill_all_running()
                        proc = launch_exe(exe_path.absolute())
                        _running[str(app_id)] = proc
                        server_state.set_active_quest(first_quest.get("id"), first_quest, "running", 0)
                        server_state.log_event(f"Started quest: {server_state._get_quest_name(first_quest)}", user_id)
                except Exception as e:
                    log.error(f"Failed to launch first quest in queue: {e}")

    return jsonify({"status": "started"})


@app.route("/skip", methods=["POST"])
def skip():
    body = request.get_json(silent=True) or {}
    user_id = body.get("userId") if body else None
    quest_id = body.get("questId")

    if quest_id:
        server_state.add_skipped_quest(quest_id)
        active_id, _ = server_state.get_active_quest()
        if active_id == quest_id:
            _kill_all_running()
            server_state.set_active_quest(None, None, None, 0)
            cleanup_stubs()
        msg = f"Quest skipped: {quest_id}"
        log.info(msg)
        server_state.log_event(msg, user_id)
        return jsonify({"status": "skipped", "questId": quest_id})
    return jsonify({"error": "missing questId"}), 400


@app.route("/reset", methods=["POST"])
def reset():
    body = request.get_json(silent=True) or {}
    user_id = body.get("userId") if body else None

    _kill_all_running()
    server_state.set_active_quest(None, None, None, 0)
    cleanup_stubs()

    msg = "Server state reset by plugin"
    log.info(msg)
    server_state.log_event(msg, user_id)

    return jsonify({"status": "reset"})


@app.route("/heartbeat", methods=["POST"])
def heartbeat():
    body = request.get_json(silent=True) or {}
    quests = body.get("quests", [])
    user_id = body.get("userId", "unknown")
    username = body.get("username", "Unknown User")
    avatar = body.get("avatar")

    if not isinstance(quests, list):
        return jsonify({"error": "quests must be an array"}), 400

    skipped_from_plugin = body.get("skippedQuests")
    if skipped_from_plugin and isinstance(skipped_from_plugin, list):
        for sq_id in skipped_from_plugin:
            server_state.add_skipped_quest(sq_id)

    server_state.set_quests(user_id, username, avatar, quests)
    log.info(f"Heartbeat from \033[96m{username} ({user_id})\033[0m: {len(quests)} quests")

    if server_state.should_log("heartbeats"):
        server_state.log_event(f"Heartbeat synchronized ({len(quests)} quests active/queued)", user_id)

    return jsonify({
        "status": "ok",
        "count": len(quests),
        "auto_complete_enabled": server_state.is_auto_complete_enabled(),
        "skipped_quest_ids": server_state.get_skipped_quests()
    })


@app.route("/users", methods=["GET"])
def users():
    return jsonify(server_state.get_users())


@app.route("/select_user", methods=["POST"])
def select_user():
    body = request.get_json(silent=True) or {}
    user_id = body.get("userId")
    server_state.set_selected_user(user_id)
    return jsonify({"status": "ok", "selectedUserId": user_id})


@app.route("/status", methods=["GET"])
def status():
    user_id = request.args.get("userId")
    return jsonify(server_state.get_state(user_id))


@app.route("/log", methods=["GET"])
def get_log():
    try:
        cursor = int(request.args.get("cursor", 0))
    except ValueError:
        cursor = 0
    entries, new_cursor = server_state.get_log_since(cursor)
    return jsonify({"entries": entries, "cursor": new_cursor})


def _watchdog_loop():
    interval = 15.0
    while True:
        time.sleep(interval)
        try:
            for app_id, proc in list(_running.items()):
                if proc.poll() is not None:
                    log.info(f"Stub process for app {app_id} (pid {proc.pid}) exited")
                    del _running[app_id]
                    server_state.set_auto_complete_enabled(False)
                    server_state.set_active_quest(None, None, None, 0)
                    server_state.log_event("Stub manually closed - auto complete paused")

            server_state.tick_heartbeat_watchdog()
            cleanup_stubs()
        except Exception as e:
            log.error(f"Watchdog error: {e}")
            server_state.log_event(f"Error: Watchdog crashed: {e}")


def _is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("", port))
            return True
        except OSError:
            return False


def _find_free_port(start: int = 5000, end: int = 5050) -> int | None:
    for port in range(start, end + 1):
        if _is_port_free(port):
            return port
    return None


def run_server(port: int = 5000):
    watchdog = threading.Thread(target=_watchdog_loop, daemon=True)
    watchdog.start()

    actual_port = port
    if not _is_port_free(port):
        free = _find_free_port(port + 1)
        if free is not None:
            log.warning(f"Port {port} is in use, falling back to port {free}")
            server_state.log_event(f"Port {port} in use - using port {free} instead")
            actual_port = free
        else:
            msg = f"Port {port} is in use and no free port found in range {port}-{port + 50}"
            log.error(msg)
            server_state.log_event(f"Error: {msg}")
            return

    log.info(f"Starting server on port {actual_port}...")
    server_state.log_event(f"Server started on port {actual_port}")
    try:
        app.run(port=actual_port, debug=False, use_reloader=False)
    except OSError as e:
        msg = f"Server failed to start on port {actual_port}: {e}"
        log.error(msg)
        server_state.log_event(f"Error: {msg}")
    except Exception as e:
        msg = f"Server error: {e}"
        log.error(msg)
        server_state.log_event(f"Error: {msg}")


if __name__ == "__main__":
    if not ensure_single_instance():
        log.warning("Another instance of Adventurer is already running.")
        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0,
                    "Adventurer is already running.",
                    "Adventurer",
                    0x30
                )
            except Exception:
                pass
        sys.exit(0)

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

    t = threading.Thread(target=_run_server_thread, args=(port,), daemon=True)
    t.start()

    from gui import run_gui

    run_gui()
