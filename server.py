import logging
import re
import subprocess
import sys
import threading
from pathlib import Path

import psutil
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

import server_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

CORS(app, origins=[
    "https://discord.com",
    "https://canary.discord.com",
    "https://ptb.discord.com"
])

BASE_DIR = Path("fake_games")
STUB_EXE = Path("stub.exe")
DETECTABLE_URL = "https://discord.com/api/v10/applications/detectable"

_detectable_cache: list | None = None


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


def ensure_executable(app_data: dict) -> Path | None:
    name = sanitize(app_data["name"])
    exe_info = next(
        (e for e in app_data.get("executables", []) if e.get("os") == "win32"),
        None
    )
    if not exe_info:
        log.warning(f"No win32 executable found for {name!r}")
        return None

    exe_path = BASE_DIR / name / exe_info["name"]
    exe_path.parent.mkdir(parents=True, exist_ok=True)

    if not exe_path.exists():
        if not STUB_EXE.exists():
            log.error("stub.exe not found - place it next to server.py")
            return None
        log.info(f"Copying stub.exe -> {exe_path}")
        exe_path.write_bytes(STUB_EXE.read_bytes())

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


@app.route("/run", methods=["POST"])
def run():
    body = request.get_json(silent=True) or {}
    app_id = body.get("id")
    quest_obj = body.get("quest")
    user_id = body.get("userId")

    if not app_id:
        return jsonify({"error": "missing id"}), 400

    app_data = find_app(str(app_id))
    if not app_data:
        log.warning(f"App ID {app_id} not found in detectable list")
        return jsonify({"error": "app not found"}), 404

    exe_path = ensure_executable(app_data)
    if not exe_path:
        return jsonify({"error": "no suitable executable"}), 400

    _kill_all_running()

    proc = launch_exe(exe_path)
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


_running = {}


@app.route("/stop", methods=["POST"])
def stop():
    body = request.get_json(silent=True) or {}
    user_id = body.get("userId") if body else None

    _kill_all_running()
    server_state.set_active_quest(None, None, None, 0)

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
    log.info(f"Heartbeat from {username} ({user_id}): {len(quests)} quests")

    # TODO: Make this optional
    # server_state.log_event(f"Heartbeat synchronized ({len(quests)} quests active/queued)", user_id)

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
    import time
    interval = 15.0
    while True:
        time.sleep(interval)
        server_state.tick_heartbeat_watchdog()


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