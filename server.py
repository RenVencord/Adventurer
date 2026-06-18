import logging
import re
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
    if request.method == "OPTIONS" or request.path in ["/heartbeat", "/log", "/status", "/users"]:
        return
    log.info(f"Received \033[96m{request.method} {request.path}\033[0m")


CORS(app, origins=[
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com"
])

BASE_DIR = Path("fake_games")
STUB_EXE = Path("stub.exe" if sys.platform == "win32" else "stub")
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

    if force_exe:
        exe_name = force_exe
    else:
        exe_info = next(
            (e for e in app_data.get("executables", []) if e.get("os") == "win32"),
            None
        )
        if not exe_info:
            return None
        exe_name = exe_info["name"]

    exe_name = exe_name.replace(">", "")
    exe_name = os.sep.join(exe_name.split("/"))
    if not exe_name.lower().endswith(".exe"):
        exe_name += ".exe"

    exe_path = BASE_DIR / name / exe_name
    exe_path.parent.mkdir(parents=True, exist_ok=True)

    if not exe_path.exists():
        if not STUB_EXE.exists():
            msg = "stub executable not found - place it next to server.py"
            log.error(msg)
            server_state.log_event(f"Error: {msg}", user_id)
            raise FileNotFoundError(msg)
        log.info(f"Copying stub executable to {exe_path}")
        if server_state.should_log("stubs"):
            server_state.log_event(f"Created new stub for {name}", user_id)
        try:
            os.link(STUB_EXE, exe_path)
        except OSError:
            shutil.copy2(STUB_EXE, exe_path)

    return exe_path


def launch_exe(path: Path) -> subprocess.Popen:
    log.info(f"Launching {path}")
    return subprocess.Popen([str(path)], cwd=path.parent)


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


def cleanup_stubs():
    mode, days = server_state.get_stub_cleanup()

    if mode == "never":
        return

    if not BASE_DIR.exists():
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
    for app_dir in BASE_DIR.iterdir():
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
    body = request.get_json(silent=True) or {}
    app_id = body.get("id")
    quest_obj = body.get("quest")
    user_id = body.get("userId")
    force_exe = body.get("forceExe")

    if not app_id:
        msg = "Missing id in /run request"
        log.error(msg)
        server_state.log_event(f"Error: {msg}", user_id)
        return jsonify({"error": "missing id"}), 400

    app_data = find_app(str(app_id))
    if not app_data:
        app_name = quest_obj.get("config", {}).get("application", {}).get("name") if quest_obj else None
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

        return jsonify({
            "error": "no suitable executable",
            "requires_confirmation": True,
            "fallback_exe": fallback_exe
        }), 400

    _kill_all_running()

    proc = launch_exe(exe_path.absolute())
    _running[app_id] = proc

    quest_id = quest_obj.get("id") if quest_obj else None
    server_state.set_active_quest(quest_id, quest_obj, "running", 0)

    msg = f"Launched {app_data['name']} (quest {quest_id})"
    log.info(msg)
    server_state.log_event(msg, user_id)

    return jsonify({"status": "launched", "name": app_data["name"]})


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

    _kill_all_running()
    server_state.set_active_quest(None, None, None, 0)
    cleanup_stubs()

    msg = "All games stopped"
    log.info(msg)
    server_state.log_event(msg, user_id)

    return jsonify({"status": "stopped"})


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

    server_state.set_quests(user_id, username, avatar, quests)
    log.info(f"Heartbeat from \033[96m{username} ({user_id})\033[0m: {len(quests)} quests")

    if server_state.should_log("heartbeats"):
        server_state.log_event(f"Heartbeat synchronized ({len(quests)} quests active/queued)", user_id)

    return jsonify({"status": "ok", "count": len(quests)})


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
        server_state.tick_heartbeat_watchdog()
        cleanup_stubs()


def run_server(port: int = 5000):
    watchdog = threading.Thread(target=_watchdog_loop, daemon=True)
    watchdog.start()
    app.run(port=port, debug=False, use_reloader=False)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000

    t = threading.Thread(target=run_server, args=(port,), daemon=True)
    t.start()

    from gui import run_gui

    run_gui()
