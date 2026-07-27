import threading
from collections import deque
from datetime import datetime

_lock = threading.RLock()

_users: dict[str, dict] = {}
_selected_user_id: str | None = None

_active_quest_id: str | None = None
_active_quest: dict | None = None
_active_status_type: str | None = None
_active_ends_at: int = 0

_log: deque = deque(maxlen=500)
_log_cursor: int = 0

HEARTBEAT_MISS_LIMIT = 3

_log_settings = {
    "heartbeats": False,
    "progress": False,
    "completion": True,
    "accounts": True,
    "stubs": True,
    "server": False
}

_stub_cleanup_mode: str = "days"
_stub_cleanup_days: int = 7


def set_log_settings(settings: dict):
    global _log_settings
    with _lock:
        _log_settings.update(settings)


def should_log(key: str) -> bool:
    with _lock:
        return _log_settings.get(key, False)


def set_stub_cleanup(mode: str, days: int):
    global _stub_cleanup_mode, _stub_cleanup_days
    with _lock:
        _stub_cleanup_mode = mode
        _stub_cleanup_days = days


def get_stub_cleanup() -> tuple[str, int]:
    with _lock:
        return _stub_cleanup_mode, _stub_cleanup_days


def log_event(message: str, user_id: str | None = None):
    global _log_cursor
    ts = datetime.now().strftime("%H:%M:%S")

    tag = ""
    if user_id:
        with _lock:
            user_info = _users.get(user_id)
            name = user_info["username"] if user_info else user_id
        tag = f"[{name}] "

    with _lock:
        _log.append({"ts": ts, "msg": f"{tag}{message}", "idx": _log_cursor})
        _log_cursor += 1


def get_log_since(cursor: int) -> tuple[list[dict], int]:
    with _lock:
        entries = [e for e in _log if e["idx"] >= cursor]
        new_cursor = _log_cursor
    return entries, new_cursor


def _get_or_create_user(user_id: str, username: str, avatar: str | None) -> tuple[dict, bool]:
    is_new = False
    if user_id not in _users:
        is_new = True
        _users[user_id] = {
            "username": username,
            "avatar": avatar,
            "quests": [],
            "last_heartbeat_time": None,
            "missed_beats": 0,
            "seen_first": False,
            "known_ids": set(),
            "new_ids": set(),
            "quest_status": {},
        }
    else:
        _users[user_id]["username"] = username
        if avatar:
            _users[user_id]["avatar"] = avatar
    return _users[user_id], is_new


def tick_heartbeat_watchdog():
    global _selected_user_id, _active_quest_id, _active_quest, _active_status_type, _active_ends_at
    to_drop = []
    with _lock:
        for uid, u in list(_users.items()):
            u["missed_beats"] += 1
            if u["missed_beats"] >= HEARTBEAT_MISS_LIMIT:
                to_drop.append((uid, u["username"]))

        for uid, uname in to_drop:
            user_quests = _users[uid].get("quests", [])
            user_quest_ids = {q.get("id") for q in user_quests if q.get("id")}
            if _active_quest_id in user_quest_ids:
                _active_quest_id = None
                _active_quest = None
                _active_status_type = None
                _active_ends_at = 0

            del _users[uid]
            if _selected_user_id == uid:
                _selected_user_id = None

        if not _users:
            _selected_user_id = None
            _active_quest_id = None
            _active_quest = None
            _active_status_type = None
            _active_ends_at = 0

    for uid, uname in to_drop:
        if should_log("accounts"):
            log_event(f"User dropped after {HEARTBEAT_MISS_LIMIT} missed heartbeats", uid)


def _get_quest_name(q: dict) -> str:
    cfg = q.get("config") or {}
    msg = cfg.get("messages") or {}
    return msg.get("questName") or msg.get("gameTitle") or q.get("id", "Unknown Quest")


def set_quests(user_id: str, username: str, avatar: str | None, quests: list[dict]):
    global _log_cursor
    with _lock:
        u, is_new = _get_or_create_user(user_id, username, avatar)

        if is_new and _log_settings.get("accounts", False) and not getattr(threading.current_thread(), "_initial_load",
                                                                           False):
            _log.append({"ts": datetime.now().strftime("%H:%M:%S"), "msg": f"[{username}] Account connected",
                         "idx": _log_cursor})
            _log_cursor += 1

        u["missed_beats"] = 0
        u["last_heartbeat_time"] = datetime.now().strftime("%H:%M:%S")

        incoming_ids = {q.get("id") for q in quests if q and isinstance(q, dict) and q.get("id")}

        uncompleted_incoming_ids = {
            q.get("id") for q in quests
            if
            q and isinstance(q, dict) and q.get("id") and not (q.get("userStatus") or {}).get("completedAt") and not (
                        q.get("userStatus") or {}).get("claimedAt")
        }

        if not u["seen_first"]:
            u["known_ids"] = set(incoming_ids)
            u["seen_first"] = True
            u["new_ids"] = set()
        else:
            new_ids = uncompleted_incoming_ids - u["known_ids"]
            u["known_ids"] |= incoming_ids
            u["new_ids"] = new_ids

        for q in quests:
            if not q or not isinstance(q, dict):
                continue
            qid = q.get("id")
            if not qid:
                continue

            cfg = q.get("config") or {}
            tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}

            key = "PLAY_ON_DESKTOP" if "PLAY_ON_DESKTOP" in tasks else (
                "WATCH_VIDEO" if "WATCH_VIDEO" in tasks else None)
            current_prog = 0
            if key and key in tasks:
                prog_entry = (q.get("userStatus") or {}).get("progress", {}).get(key)
                if isinstance(prog_entry, dict):
                    current_prog = prog_entry.get("value", 0)

            is_completed = bool((q.get("userStatus") or {}).get("completedAt"))

            old_status = u["quest_status"].get(qid, {})
            old_prog = old_status.get("progress", 0)
            old_comp = old_status.get("completed", False)

            name = _get_quest_name(q)

            if u["seen_first"]:
                if is_completed and not old_comp:
                    if _log_settings.get("completion", False):
                        _log.append(
                            {"ts": datetime.now().strftime("%H:%M:%S"), "msg": f"[{username}] Quest completed: {name}",
                             "idx": _log_cursor})
                        _log_cursor += 1
                elif current_prog > old_prog:
                    if _log_settings.get("progress", False):
                        mins = int(current_prog // 60)
                        _log.append({"ts": datetime.now().strftime("%H:%M:%S"),
                                     "msg": f"[{username}] Quest progress: {name} ({mins}m)", "idx": _log_cursor})
                        _log_cursor += 1

            u["quest_status"][qid] = {"completed": is_completed, "progress": current_prog}

        u["quests"] = quests


def consume_new_quest_ids(user_id: str) -> set[str]:
    with _lock:
        u = _users.get(user_id)
        if not u:
            return set()
        ids = set(u["new_ids"])
        u["new_ids"] = set()
        return ids


def get_users() -> dict[str, dict]:
    with _lock:
        result = {}
        for uid, u in _users.items():
            result[uid] = {
                "username": u["username"],
                "avatar": u["avatar"],
                "last_heartbeat": u["last_heartbeat_time"],
                "quest_count": len(u["quests"]),
                "quest_ids": [q.get("id") for q in u["quests"] if isinstance(q, dict) and "id" in q]
            }
        return result


def get_selected_user_id() -> str | None:
    with _lock:
        if _selected_user_id and _selected_user_id in _users:
            return _selected_user_id
        if _users:
            return next(iter(_users))
        return None


def set_selected_user(user_id: str | None):
    global _selected_user_id
    with _lock:
        _selected_user_id = user_id


def get_state(user_id: str | None = None) -> dict:
    with _lock:
        uid = user_id or (_selected_user_id if _selected_user_id in _users else None)
        if not uid and _users:
            uid = next(iter(_users))

        u = _users.get(uid) if uid else None
        return {
            "quests": list(u["quests"]) if u else [],
            "active_quest_id": _active_quest_id,
            "active_quest": _active_quest,
            "active_status_type": _active_status_type,
            "active_ends_at": _active_ends_at,
            "last_heartbeat": u["last_heartbeat_time"] if u else None,
            "seen_first_heartbeat": u["seen_first"] if u else False,
            "new_quest_ids": set(u["new_ids"]) if u else set(),
        }


def set_active_quest(quest_id: str | None, quest_obj: dict | None, status_type: str | None = None, ends_at: int = 0):
    global _active_quest_id, _active_quest, _active_status_type, _active_ends_at
    with _lock:
        _active_quest_id = quest_id
        _active_quest = quest_obj
        _active_status_type = status_type
        _active_ends_at = ends_at


def get_active_quest() -> tuple[str | None, dict | None]:
    with _lock:
        return _active_quest_id, _active_quest


def mark_first_heartbeat_seen():
    pass