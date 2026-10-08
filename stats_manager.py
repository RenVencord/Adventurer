"""
stats_manager.py
Tracks and persists lifetime statistics for Adventurer:
- Game quests completed
- Video quests completed
- Experience quests completed
- Total orbs gained
- Detailed history of completed quests that Adventurer actively helped with
"""

import json
import os
import threading
from datetime import datetime

APPDATA_DIR = os.path.join(os.path.expanduser("~"), ".Adventurer")
STATS_FILE = os.path.join(APPDATA_DIR, "adventurer_stats.json")

_lock = threading.RLock()


def _default_stats() -> dict:
    return {
        "game_quests": 0,
        "video_quests": 0,
        "experience_quests": 0,
        "orbs_gained": 0,
        "assisted_quest_ids": [],
        "completed_quests": []
    }


def load_stats() -> dict:
    """Load stats from disk or return default initial stats."""
    defaults = _default_stats()
    if os.path.exists(STATS_FILE):
        try:
            with open(STATS_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
                if isinstance(saved, dict):
                    assisted = saved.get("assisted_quest_ids")
                    assisted_list = [str(x) for x in assisted] if isinstance(assisted, list) else []
                    assisted_set = set(assisted_list)
                    defaults["assisted_quest_ids"] = assisted_list

                    c_quests = saved.get("completed_quests")
                    if isinstance(c_quests, list):
                        # Strictly retain only quests that Adventurer actively assisted
                        valid_completed = [
                            q for q in c_quests
                            if isinstance(q, dict) and str(q.get("id")) in assisted_set
                        ]
                    else:
                        valid_completed = []

                    defaults["completed_quests"] = valid_completed
                    defaults["game_quests"] = sum(1 for q in valid_completed if q.get("type") == "game")
                    defaults["video_quests"] = sum(1 for q in valid_completed if q.get("type") == "video")
                    defaults["experience_quests"] = sum(1 for q in valid_completed if q.get("type") == "experience")
                    defaults["orbs_gained"] = sum(int(q.get("orbs", 0)) for q in valid_completed)

                    # If there was stale/unassisted data on disk, automatically re-save the cleaned state
                    if (
                        len(valid_completed) != len(c_quests or [])
                        or saved.get("game_quests") != defaults["game_quests"]
                        or saved.get("orbs_gained") != defaults["orbs_gained"]
                    ):
                        save_stats(defaults)
        except Exception:
            pass
    return defaults


def save_stats(stats: dict):
    """Safely persist stats dictionary to disk."""
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


def mark_quest_assisted(quest_id: str):
    """Mark a quest as actively assisted by Adventurer."""
    if not quest_id:
        return
    qid = str(quest_id)
    with _lock:
        stats = load_stats()
        assisted = stats.get("assisted_quest_ids", [])
        if qid not in assisted:
            assisted.append(qid)
            stats["assisted_quest_ids"] = assisted
            save_stats(stats)


def is_quest_assisted(quest_id: str) -> bool:
    """Check if a quest was actively assisted by Adventurer."""
    if not quest_id:
        return False
    with _lock:
        stats = load_stats()
        return str(quest_id) in stats.get("assisted_quest_ids", [])


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


def record_completed_quest(quest: dict, user_id: str | None = None, force_assisted: bool = False) -> bool:
    """
    Records a completed quest in stats ONLY if Adventurer actively assisted with it
    (or force_assisted is True) and it has not already been tracked.
    Returns True if newly recorded, False if already present or not assisted.
    """
    if not quest or not isinstance(quest, dict):
        return False
    qid = str(quest.get("id") or "")
    if not qid:
        return False

    with _lock:
        stats = load_stats()

        # Enforce that Adventurer must have actively assisted this quest!
        if not force_assisted and qid not in stats.get("assisted_quest_ids", []):
            return False

        completed = stats.get("completed_quests", [])

        # Avoid duplicate recording of the same quest ID
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
            stats["game_quests"] = stats.get("game_quests", 0) + 1
        elif q_type == "video":
            stats["video_quests"] = stats.get("video_quests", 0) + 1
        else:
            stats["experience_quests"] = stats.get("experience_quests", 0) + 1

        stats["orbs_gained"] = stats.get("orbs_gained", 0) + orbs

        entry = {
            "id": qid,
            "name": name,
            "type": q_type,
            "orbs": orbs,
            "completed_at": completed_at,
            "user_id": str(user_id) if user_id else ""
        }
        completed.append(entry)
        stats["completed_quests"] = completed
        save_stats(stats)
        return True


def reset_stats():
    """Resets all statistics to 0, clears completed history, and clears assisted list."""
    with _lock:
        save_stats(_default_stats())


def get_stats_summary() -> dict:
    """Returns the current stats summary dictionary with total_quests computed."""
    with _lock:
        stats = load_stats()
        stats["total_quests"] = (
            stats.get("game_quests", 0)
            + stats.get("video_quests", 0)
            + stats.get("experience_quests", 0)
        )
        return stats
