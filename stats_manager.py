"""
stats_manager.py
Tracks and persists lifetime statistics for Adventurer per Discord account:
- Game quests completed
- Video quests completed
- Experience quests completed
- Total orbs gained
- Detailed history of completed quests that Adventurer actively helped with
"""

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from datetime import datetime

APPDATA_DIR = os.path.join(os.path.expanduser("~"), ".Adventurer")
STATS_FILE = os.path.join(APPDATA_DIR, "adventurer_stats.json")
STATS_SIGNING_SECRET = os.getenv(
    "ADVENTURER_STATS_SIGNING_SECRET",
    "adv_9f3c7a1e8b42d605c4a9e2f17b8d304a6e1c5f92",
).strip()

_lock = threading.RLock()


def _default_account_stats(username: str = "") -> dict:
    return {
        "username": username,
        "game_quests": 0,
        "video_quests": 0,
        "experience_quests": 0,
        "orbs_gained": 0,
        "assisted_quest_ids": [],
        "completed_quests": [],
    }


def _default_store() -> dict:
    return {
        "version": 2,
        "accounts": {},
    }


def _normalize_user_id(user_id: str | None) -> str:
    uid = str(user_id).strip() if user_id is not None else ""
    return uid if uid else "unknown"


def _recompute_account(acc: dict) -> tuple[dict, bool]:
    """Validate and recompute counters for a single account dict. Returns (cleaned, changed)."""
    if not isinstance(acc, dict):
        return _default_account_stats(), True

    username = str(acc.get("username") or "")
    assisted = acc.get("assisted_quest_ids")
    assisted_list = [str(x) for x in assisted] if isinstance(assisted, list) else []
    assisted_set = set(assisted_list)

    c_quests = acc.get("completed_quests")
    if isinstance(c_quests, list):
        valid_completed = [
            q for q in c_quests
            if isinstance(q, dict) and str(q.get("id")) in assisted_set
        ]
    else:
        valid_completed = []

    cleaned = {
        "username": username,
        "game_quests": sum(1 for q in valid_completed if q.get("type") == "game"),
        "video_quests": sum(1 for q in valid_completed if q.get("type") == "video"),
        "experience_quests": sum(1 for q in valid_completed if q.get("type") == "experience"),
        "orbs_gained": sum(int(q.get("orbs", 0)) for q in valid_completed),
        "assisted_quest_ids": assisted_list,
        "completed_quests": valid_completed,
    }

    changed = (
        len(valid_completed) != len(c_quests or [])
        or acc.get("game_quests") != cleaned["game_quests"]
        or acc.get("video_quests") != cleaned["video_quests"]
        or acc.get("experience_quests") != cleaned["experience_quests"]
        or acc.get("orbs_gained") != cleaned["orbs_gained"]
    )
    return cleaned, changed


def _migrate_v1_to_v2(saved: dict) -> dict:
    """Migrate legacy flat stats dict into per-account v2 format."""
    store = _default_store()
    assisted = saved.get("assisted_quest_ids")
    assisted_list = [str(x) for x in assisted] if isinstance(assisted, list) else []
    assisted_set = set(assisted_list)

    c_quests = saved.get("completed_quests")
    if not isinstance(c_quests, list):
        c_quests = []

    for q in c_quests:
        if not isinstance(q, dict):
            continue
        qid = str(q.get("id") or "")
        if not qid or qid not in assisted_set:
            continue
        uid = _normalize_user_id(q.get("user_id"))
        acc = store["accounts"].setdefault(uid, _default_account_stats())
        if qid not in acc["assisted_quest_ids"]:
            acc["assisted_quest_ids"].append(qid)
        if not any(str(existing.get("id")) == qid for existing in acc["completed_quests"]):
            acc["completed_quests"].append(q)

    for uid, acc in list(store["accounts"].items()):
        cleaned, _ = _recompute_account(acc)
        store["accounts"][uid] = cleaned

    return store


def load_stats() -> dict:
    """Load per-account stats store from disk (auto-migrating v1 if needed)."""
    store = _default_store()
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                if "accounts" in saved and isinstance(saved["accounts"], dict):
                    dirty = saved.get("version") != 2
                    for uid, acc in saved["accounts"].items():
                        norm_uid = _normalize_user_id(uid)
                        cleaned, changed = _recompute_account(acc)
                        store["accounts"][norm_uid] = cleaned
                        if changed or norm_uid != uid:
                            dirty = True
                    if dirty:
                        save_stats(store)
                else:
                    store = _migrate_v1_to_v2(saved)
                    save_stats(store)
        except Exception:
            pass
    return store


def save_stats(stats: dict):
    """Safely persist stats store dictionary to disk."""
    try:
        os.makedirs(os.path.dirname(STATS_FILE), exist_ok=True)
        temp_file = f"{STATS_FILE}.tmp"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, STATS_FILE)
    except Exception:
        pass


def set_account_username(user_id: str | None, username: str | None):
    """Update cached username for an account if it already exists in stats."""
    if not user_id or not username or username == "Unknown User":
        return
    uid = _normalize_user_id(user_id)
    with _lock:
        store = load_stats()
        acc = store["accounts"].get(uid)
        if acc is not None and acc.get("username") != username:
            acc["username"] = str(username)
            save_stats(store)


def mark_quest_assisted(quest_id: str, user_id: str | None = None, username: str | None = None):
    """Mark a quest as actively assisted by Adventurer for a specific Discord account."""
    if not quest_id:
        return
    qid = str(quest_id)
    uid = _normalize_user_id(user_id)
    with _lock:
        store = load_stats()
        acc = store["accounts"].setdefault(uid, _default_account_stats())
        if username and username != "Unknown User":
            acc["username"] = str(username)
        assisted = acc.get("assisted_quest_ids", [])
        if qid not in assisted:
            assisted.append(qid)
            acc["assisted_quest_ids"] = assisted
            save_stats(store)
        elif username and username != "Unknown User":
            save_stats(store)


def is_quest_assisted(quest_id: str, user_id: str | None = None) -> bool:
    """Check if a quest was actively assisted by Adventurer (for user_id, or any account if None)."""
    if not quest_id:
        return False
    qid = str(quest_id)
    with _lock:
        store = load_stats()
        accounts = store.get("accounts", {})
        if user_id is not None:
            uid = _normalize_user_id(user_id)
            acc = accounts.get(uid)
            if acc and qid in acc.get("assisted_quest_ids", []):
                return True
            return False
        return any(qid in acc.get("assisted_quest_ids", []) for acc in accounts.values())


def quest_name(quest: dict) -> str:
    """Extract a friendly quest title from quest dict."""
    if not quest or not isinstance(quest, dict):
        return "Unknown Quest"
    cfg = quest.get("config") or {}
    messages = cfg.get("messages") or {}
    return (
        messages.get("questName")
        or messages.get("gameTitle")
        or quest.get("id", "Unknown Quest")
    )


def quest_orbs(quest: dict) -> int:
    """Extract rewarded orb quantity from quest dict."""
    if not quest or not isinstance(quest, dict):
        return 0
    cfg = quest.get("config") or {}
    rewards_config = cfg.get("rewardsConfig") or {}
    rewards = rewards_config.get("rewards") or []
    for r in rewards:
        if isinstance(r, dict):
            q = r.get("orbQuantity")
            if q is not None:
                try:
                    return int(q)
                except (ValueError, TypeError):
                    pass
    return 0


def get_quest_app_id(quest: dict) -> str | None:
    """Extract Discord application id for the quest."""
    if not quest or not isinstance(quest, dict):
        return None
    cfg = quest.get("config") or {}
    app = cfg.get("application") or {}
    if app.get("id"):
        return str(app["id"])
    if quest.get("resolvedAppId"):
        return str(quest["resolvedAppId"])
    tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}
    for key in ("PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP"):
        t = tasks.get(key) or {}
        apps = t.get("applications") or []
        if apps and isinstance(apps, list) and len(apps) > 0 and apps[0].get("id"):
            return str(apps[0]["id"])
    if quest.get("application_id"):
        return str(quest["application_id"])
    return None


def get_quest_type(quest: dict) -> str:
    """
    Classify a Discord quest into 'game', 'video', or 'experience'.
    - 'video': WATCH_VIDEO or WATCH_VIDEO_ON_MOBILE
    - 'game': PLAY_ON_DESKTOP or STREAM_ON_DESKTOP
    - 'experience': PLAY_EXPERIENCE, LAUNCH_EXPERIENCE, PLAY_ACTIVITY, PLAY_ON_MOBILE, or activity
    """
    if not quest or not isinstance(quest, dict):
        return "game"
    cfg = quest.get("config") or {}
    tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}

    if "WATCH_VIDEO" in tasks or "WATCH_VIDEO_ON_MOBILE" in tasks:
        return "video"

    if any(k in tasks for k in ("PLAY_EXPERIENCE", "LAUNCH_EXPERIENCE", "PLAY_ACTIVITY", "PLAY_ON_MOBILE", "MOBILE")):
        return "experience"

    if "PLAY_ON_DESKTOP" in tasks or "STREAM_ON_DESKTOP" in tasks:
        return "game"

    return "experience"


def is_game_quest(quest: dict) -> bool:
    return get_quest_type(quest) == "game"


def is_video_quest(quest: dict) -> bool:
    return get_quest_type(quest) == "video"


def is_experience_quest(quest: dict) -> bool:
    return get_quest_type(quest) == "experience"


def record_completed_quest(
    quest: dict,
    user_id: str | None = None,
    force_assisted: bool = False,
    username: str | None = None,
) -> bool:
    """
    Records a completed quest in stats for the given Discord account ONLY if
    Adventurer actively assisted with it (or force_assisted is True) and it
    has not already been tracked for that account.
    Returns True if newly recorded, False if already present or not assisted.
    """
    if not quest or not isinstance(quest, dict):
        return False
    qid = str(quest.get("id") or "")
    if not qid:
        return False

    uid = _normalize_user_id(user_id)

    with _lock:
        store = load_stats()
        acc = store["accounts"].setdefault(uid, _default_account_stats())
        if username and username != "Unknown User":
            acc["username"] = str(username)

        if not force_assisted and qid not in acc.get("assisted_quest_ids", []):
            return False

        completed = acc.get("completed_quests", [])

        # Avoid duplicate recording of the same quest ID for this account
        for item in completed:
            if str(item.get("id")) == qid:
                return False

        q_type = get_quest_type(quest)
        orbs = quest_orbs(quest)
        name = quest_name(quest)

        user_status = quest.get("userStatus") or {}
        completed_at = user_status.get("completedAt")
        if not completed_at:
            completed_at = datetime.now().isoformat()

        if q_type == "game":
            acc["game_quests"] = acc.get("game_quests", 0) + 1
        elif q_type == "video":
            acc["video_quests"] = acc.get("video_quests", 0) + 1
        else:
            acc["experience_quests"] = acc.get("experience_quests", 0) + 1

        acc["orbs_gained"] = acc.get("orbs_gained", 0) + orbs

        entry = {
            "id": qid,
            "name": name,
            "type": q_type,
            "orbs": orbs,
            "completed_at": completed_at,
            "user_id": uid,
        }
        completed.append(entry)
        acc["completed_quests"] = completed
        save_stats(store)
    return True


def reset_stats(user_id: str | None = None):
    """
    Resets statistics for a specific Discord account, or all accounts if
    user_id is None or 'all'.
    """
    with _lock:
        if user_id is None or user_id == "all":
            save_stats(_default_store())
        else:
            uid = _normalize_user_id(user_id)
            store = load_stats()
            if uid in store.get("accounts", {}):
                store["accounts"].pop(uid, None)
                save_stats(store)


def get_tracked_accounts() -> list[dict]:
    """Return a list of accounts present in stats with basic summary info."""
    with _lock:
        store = load_stats()
        result = []
        for uid, acc in store.get("accounts", {}).items():
            total = (
                acc.get("game_quests", 0)
                + acc.get("video_quests", 0)
                + acc.get("experience_quests", 0)
            )
            result.append({
                "user_id": uid,
                "username": acc.get("username") or "",
                "total_quests": total,
                "orbs_gained": acc.get("orbs_gained", 0),
            })
        result.sort(key=lambda x: (x["user_id"] == "unknown", (x["username"] or x["user_id"]).lower()))
        return result


def get_stats_summary(user_id: str | None = None) -> dict:
    """
    Returns the stats summary dictionary with total_quests computed.
    If user_id is None or 'all', aggregates across all tracked accounts.
    Otherwise returns stats for the specified Discord account.
    """
    with _lock:
        store = load_stats()
        accounts = store.get("accounts", {})

        if user_id is not None and user_id != "all":
            uid = _normalize_user_id(user_id)
            acc = dict(accounts.get(uid) or _default_account_stats())
            acc["user_id"] = uid
            acc["total_quests"] = (
                acc.get("game_quests", 0)
                + acc.get("video_quests", 0)
                + acc.get("experience_quests", 0)
            )
            return acc

        summary = _default_account_stats()
        for acc in accounts.values():
            summary["game_quests"] += acc.get("game_quests", 0)
            summary["video_quests"] += acc.get("video_quests", 0)
            summary["experience_quests"] += acc.get("experience_quests", 0)
            summary["orbs_gained"] += acc.get("orbs_gained", 0)
            summary["completed_quests"].extend(acc.get("completed_quests", []))

        summary["total_quests"] = (
            summary["game_quests"]
            + summary["video_quests"]
            + summary["experience_quests"]
        )
        return summary


def build_signed_stats_token(user_id: str, scope: str = "account") -> dict:
    """
    Build a summary + HMAC-signed v1.<b64>.<sig> token for AdventurerBot's
    /adventurer-stats slash command.
    """
    uid = _normalize_user_id(user_id)
    target_scope = "all" if scope == "all" else "account"
    summary = get_stats_summary(user_id="all" if target_scope == "all" else uid)

    payload = {
        "uid": uid,
        "s": target_scope,
        "g": int(summary.get("game_quests", 0)),
        "v": int(summary.get("video_quests", 0)),
        "e": int(summary.get("experience_quests", 0)),
        "o": int(summary.get("orbs_gained", 0)),
        "t": int(time.time()),
    }
    raw_json = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    b64_payload = base64.urlsafe_b64encode(raw_json).decode("ascii").rstrip("=")
    sig_hex = hmac.new(
        STATS_SIGNING_SECRET.encode("utf-8"),
        b64_payload.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()

    return {
        "stats": summary,
        "token": f"v1.{b64_payload}.{sig_hex}",
    }

