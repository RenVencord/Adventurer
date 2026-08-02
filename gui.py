import os
import sys
import time
import urllib.request
import traceback
import json
from datetime import datetime

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QScrollArea, QFrame, QSystemTrayIcon, QMenu, QSizePolicy,
    QDialog, QCheckBox, QSpinBox, QFormLayout, QDialogButtonBox,
    QTabWidget, QPlainTextEdit, QToolButton, QComboBox, QLineEdit,
    QPushButton, QFileDialog, QWidgetAction, QMessageBox, QGroupBox, QListView
)
from PyQt6.QtCore import Qt, QTimer, QThread, pyqtSignal, QSize, QRect, QByteArray, QBuffer, QIODevice
from PyQt6.QtGui import (
    QPixmap, QPainter, QColor, QPen, QBrush, QLinearGradient,
    QIcon, QPainterPath, QAction, QConicalGradient
)
from PyQt6.QtSvg import QSvgRenderer

import server_state
import updater
import vencord_helper

# ---------------------------------------------------------------------------
# Path helpers: resolve bundled assets (PyInstaller) and user data directory
# ---------------------------------------------------------------------------
APPDATA_DIR = os.path.join(os.path.expanduser("~"), ".Adventurer")


def _get_asset_path(relative: str) -> str:
    """Resolve a path relative to the application assets (handles PyInstaller)."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, relative)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative)


BG_DARKEST = QColor("#0f1012")
BG_DARK = QColor("#1a1b1e")
BG_MID = QColor("#232428")
BG_CARD = QColor("#2b2d31")
ACCENT_BLUE = QColor("#5865f2")
ACCENT_GREEN = QColor("#23a55a")
ACCENT_GOLD = QColor("#f0b132")
TEXT_PRIMARY = QColor("#f2f3f5")
TEXT_MUTED = QColor("#949ba4")
BORDER = QColor("#3f4147")
RING_BG = QColor("#1e1f22")

CDN_BASE = "https://cdn.discordapp.com"

QUEST_ICON_SVG_PATH = _get_asset_path(os.path.join("assets", "quest_icon.svg"))
BROWSE_ICON_SVG_PATH = _get_asset_path(os.path.join("assets", "browse_icon.svg"))

PREFS_FILE = os.path.join(APPDATA_DIR, "adventurer_settings.json")
ORB_ICON_BASE64 = ""


def _load_svg_icon(path: str, size: int = 18) -> QIcon:
    if os.path.exists(path):
        try:
            renderer = QSvgRenderer(path)
            pm = QPixmap(size, size)
            pm.fill(Qt.GlobalColor.transparent)
            p = QPainter(pm)
            renderer.render(p)
            p.end()
            if not pm.isNull():
                return QIcon(pm)
        except Exception:
            pass
    return QIcon()


def load_prefs() -> dict:
    defaults = {
        "orbs_only": True,
        "min_orbs": 0,
        "notify_video": True,
        "log_heartbeats": False,
        "log_progress": False,
        "log_completion": True,
        "log_accounts": True,
        "log_stubs": True,
        "stub_cleanup_mode": "days",
        "stub_cleanup_days": 7,
        "fake_games_dir": APPDATA_DIR,
        "update_mode_app": "Ask",
        "update_mode_plugin": "Auto",
        "update_scope": "Any",
        "vencord_source_dir": "",
        "skipped_app_version": "",
        "skipped_plugin_version": ""
    }
    if os.path.exists(PREFS_FILE):
        try:
            with open(PREFS_FILE, "r") as f:
                saved = json.load(f)
                defaults.update(saved)
        except Exception:
            pass
    return defaults


def save_prefs(prefs: dict):
    try:
        os.makedirs(os.path.dirname(PREFS_FILE), exist_ok=True)
        with open(PREFS_FILE, "w") as f:
            json.dump(prefs, f)
    except Exception:
        pass


def _load_quest_svg(size: int = 32) -> QPixmap | None:
    if not os.path.exists(QUEST_ICON_SVG_PATH):
        return None
    try:
        renderer = QSvgRenderer(QUEST_ICON_SVG_PATH)
        pm = QPixmap(size, size)
        pm.fill(Qt.GlobalColor.transparent)
        p = QPainter(pm)
        renderer.render(p)
        p.end()
        return pm if not pm.isNull() else None
    except Exception:
        return None

def _load_logo_png(size: int = 72) -> QPixmap | None:
    path = _get_asset_path(os.path.join("assets", "logo.png"))
    if not os.path.exists(path):
        return None
    try:
        pm = QPixmap(path)
        if pm.isNull():
            return None
        return pm
    except Exception:
        return None


def init_orb_icon_base64():
    global ORB_ICON_BASE64
    pm = _load_quest_svg(14)
    if pm and not pm.isNull():
        ba = QByteArray()
        buf = QBuffer(ba)
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        pm.save(buf, "PNG")
        ORB_ICON_BASE64 = ba.toBase64().data().decode("utf-8")


def fetch_pixmap(url: str, size: QSize) -> QPixmap | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AdventurerGUI/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = r.read()
        pm = QPixmap()
        pm.loadFromData(data)
        if pm.isNull():
            return None
        return pm.scaled(size, Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                         Qt.TransformationMode.SmoothTransformation)
    except Exception:
        return None


def quest_icon_url(quest: dict) -> str | None:
    if not quest or not isinstance(quest, dict):
        return None
    cfg = quest.get("config") or {}
    assets = cfg.get("assets") or {}
    tile = assets.get("gameTileDark") or assets.get("gameTile")
    if tile and not tile.startswith("quests/"):
        tile = f"quests/{cfg.get('id', '')}/{tile}"
    if tile:
        return f"{CDN_BASE}/{tile}"
    # Old Discord format: config.application contains app info
    app_obj = cfg.get("application")
    if app_obj:
        app_id = app_obj.get("id")
        icon = app_obj.get("icon")
        if app_id and icon:
            return f"{CDN_BASE}/app-icons/{app_id}/{icon}.webp"
    # New Discord format: app info lives inside taskConfigV2 tasks
    tasks = (cfg.get("taskConfigV2") or {}).get("tasks") or {}
    for task_key in ["PLAY_ON_DESKTOP", "WATCH_VIDEO"]:
        task_apps = (tasks.get(task_key) or {}).get("applications") or []
        if task_apps and isinstance(task_apps, list) and len(task_apps) > 0:
            app = task_apps[0]
            app_id = app.get("id")
            icon = app.get("icon")
            if app_id and icon:
                return f"{CDN_BASE}/app-icons/{app_id}/{icon}.webp"
    return None


def quest_hero_url(quest: dict) -> str | None:
    if not quest or not isinstance(quest, dict):
        return None
    cfg = quest.get("config") or {}
    assets = cfg.get("assets") or {}
    hero = assets.get("hero")
    if not hero:
        return None
    if not hero.startswith("quests/"):
        hero = f"quests/{cfg.get('id', '')}/{hero}"
    return f"{CDN_BASE}/{hero}"


def quest_orbs(quest: dict) -> int:
    if not quest or not isinstance(quest, dict):
        return 0
    cfg = quest.get("config") or {}
    rewards_config = cfg.get("rewardsConfig") or {}
    rewards = rewards_config.get("rewards") or []
    for r in rewards:
        if isinstance(r, dict):
            q = r.get("orbQuantity")
            if q:
                return q
    return 0


def quest_name(quest: dict) -> str:
    if not quest or not isinstance(quest, dict):
        return "Unknown Quest"
    cfg = quest.get("config") or {}
    messages = cfg.get("messages") or {}
    return (messages.get("questName")
            or messages.get("gameTitle")
            or quest.get("id", "Unknown Quest"))


def quest_progress(quest: dict, active_status_type: str | None = None, active_ends_at: int = 0) -> tuple[float, str]:
    if not quest or not isinstance(quest, dict):
        return 0.0, ""

    cfg = quest.get("config") or {}
    task_config = cfg.get("taskConfigV2") or {}
    tasks = task_config.get("tasks") or {}
    user_status = quest.get("userStatus") or {}
    progress = user_status.get("progress") or {}

    key = "PLAY_ON_DESKTOP" if "PLAY_ON_DESKTOP" in tasks else ("WATCH_VIDEO" if "WATCH_VIDEO" in tasks else None)

    if active_status_type and active_ends_at > 0:
        now_ms = int(time.time() * 1000)
        secs_left = max(0, int((active_ends_at - now_ms) / 1000))

        if secs_left > 0:
            if active_status_type == "waiting":
                return 0.0, f"Waiting {secs_left}s..."
            elif active_status_type == "stopping":
                return 1.0, f"Stopping in {secs_left}s..."
            elif active_status_type == "cleanup":
                return 1.0, f"Cleaning up ({secs_left}s)..."

    if not key or not tasks.get(key):
        if active_status_type == "running":
            return 0.0, "Running"
        return 0.0, ""

    target = tasks[key].get("target", 1)
    prog_entry = progress.get(key) or {}
    current = prog_entry.get("value", 0) if isinstance(prog_entry, dict) else 0

    pct = min(current / target, 1.0) if target > 0 else 0.0
    mins_done = int(current // 60)
    mins_total = int(target // 60)

    if active_status_type == "running":
        return pct, f"Running ({mins_done}/{mins_total} min)"

    return pct, f"{mins_done}/{mins_total} min"


def is_game_quest(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    cfg = quest.get("config") or {}
    task_config = cfg.get("taskConfigV2") or {}
    return "PLAY_ON_DESKTOP" in (task_config.get("tasks") or {})


def is_video_quest(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    cfg = quest.get("config") or {}
    task_config = cfg.get("taskConfigV2") or {}
    return "WATCH_VIDEO" in (task_config.get("tasks") or {})


def is_complete(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    user_status = quest.get("userStatus") or {}
    return bool(user_status.get("completedAt"))


def is_claimed(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    user_status = quest.get("userStatus") or {}
    return bool(user_status.get("claimedAt"))


def is_enrolled(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    return quest.get("userStatus") is not None


def make_rounded_pixmap(pm: QPixmap, size: int, radius: int = 8) -> QPixmap:
    rounded = QPixmap(size, size)
    rounded.fill(Qt.GlobalColor.transparent)
    painter = QPainter(rounded)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    path = QPainterPath()
    path.addRoundedRect(0, 0, size, size, radius, radius)
    painter.setClipPath(path)
    painter.drawPixmap(0, 0, pm)
    painter.end()
    return rounded


def make_circle_pixmap(pm: QPixmap, size: int) -> QPixmap:
    out = QPixmap(size, size)
    out.fill(Qt.GlobalColor.transparent)
    p = QPainter(out)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    path = QPainterPath()
    path.addEllipse(0, 0, size, size)
    p.setClipPath(path)
    p.drawPixmap(0, 0, size, size, pm)
    p.end()
    return out


def is_expired(quest: dict) -> bool:
    if not quest or not isinstance(quest, dict):
        return False
    cfg = quest.get("config") or {}
    expires_at = cfg.get("expiresAt")
    if not expires_at:
        return False
    try:
        from datetime import timezone
        expiry = datetime.fromisoformat(expires_at)
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > expiry
    except ValueError:
        return False


class ImageLoader(QThread):
    loaded = pyqtSignal(str, QPixmap)

    def __init__(self, url: str, size: QSize):
        super().__init__()
        self.url = url
        self.size = size

    def run(self):
        pm = fetch_pixmap(self.url, self.size)
        if pm:
            self.loaded.emit(self.url, pm)


class RingWidget(QWidget):
    def __init__(self, size: int = 80, ring_width: int = 5, parent=None):
        super().__init__(parent)
        self._size = size
        self._ring_width = ring_width
        self._progress = 0.0
        self._pixmap: QPixmap | None = None
        self.setFixedSize(size, size)

    def set_progress(self, v: float):
        self._progress = max(0.0, min(1.0, v))
        self.update()

    def set_pixmap(self, pm: QPixmap | None):
        self._pixmap = pm if (pm and not pm.isNull()) else None
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        s = self._size
        rw = self._ring_width
        inner = s - rw * 2

        p.setPen(QPen(RING_BG, rw))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(rw // 2, rw // 2, s - rw, s - rw)

        p.setBrush(QBrush(BG_MID))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(rw, rw, inner, inner)

        if self._pixmap:
            path = QPainterPath()
            path.addEllipse(rw, rw, inner, inner)
            p.setClipPath(path)
            p.drawPixmap(rw, rw, inner, inner, self._pixmap)
            p.setClipping(False)

        if self._progress > 0:
            grad = QConicalGradient(s / 2, s / 2, 90)
            grad.setColorAt(0.0, ACCENT_GREEN)
            grad.setColorAt(1.0, QColor("#57f287"))
            pen = QPen(QBrush(grad), rw, Qt.PenStyle.SolidLine,
                       Qt.PenCapStyle.RoundCap)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            span = int(-self._progress * 360 * 16)
            p.drawArc(rw // 2, rw // 2, s - rw, s - rw, 90 * 16, span)

        p.end()


class HeroBanner(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._pixmap: QPixmap | None = None
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_pixmap(self, pm: QPixmap | None):
        self._pixmap = pm
        self.update()

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        w, h = self.width(), self.height()

        if self._pixmap:
            scaled = self._pixmap.scaled(
                w, h,
                Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                Qt.TransformationMode.SmoothTransformation
            )
            x = (scaled.width() - w) // 2
            p.drawPixmap(0, 0, scaled, x, 0, w, h)
        else:
            p.fillRect(0, 0, w, h, BG_DARKEST)

        grad = QLinearGradient(0, 0, 0, h)
        grad.setColorAt(0.0, QColor(0, 0, 0, 40))
        grad.setColorAt(0.6, QColor(26, 27, 30, 160))
        grad.setColorAt(1.0, QColor(26, 27, 30, 255))
        p.fillRect(0, 0, w, h, grad)
        p.end()


class QuestCard(QFrame):
    def __init__(self, quest: dict, tag: str = "", tag_color: str = "", parent=None):
        super().__init__(parent)
        self.quest = quest
        self._loader: ImageLoader | None = None

        self.setFixedHeight(90)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setStyleSheet(f"""
            QuestCard {{
                background: {BG_CARD.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 10px;
            }}
        """)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(12)

        self.icon_lbl = QLabel()
        self.icon_lbl.setFixedSize(54, 54)
        self.icon_lbl.setStyleSheet("background: transparent; border: none;")
        self.icon_lbl.setScaledContents(True)
        layout.addWidget(self.icon_lbl)

        info = QVBoxLayout()
        info.setSpacing(3)

        name_lbl = QLabel(quest_name(quest))
        name_lbl.setStyleSheet(
            f"color: {ACCENT_BLUE.name()}; font-size: 13px; font-weight: 700; "
            "background: transparent; border: none;"
        )
        name_lbl.setWordWrap(True)
        info.addWidget(name_lbl)

        orbs = quest_orbs(quest)
        if orbs:
            orb_icon = f"<img src='data:image/png;base64,{ORB_ICON_BASE64}' width='12' height='12'>" if ORB_ICON_BASE64 else "◇"
            orb_lbl = QLabel(f"{orb_icon} {orbs:,} Orbs")
            orb_lbl.setStyleSheet(
                f"color: {TEXT_PRIMARY.name()}; font-size: 12px; background: transparent; border: none;"
            )
            info.addWidget(orb_lbl)

        self.tag_lbl = QLabel(tag if tag else "")
        self.tag_lbl.setStyleSheet(
            f"color: {tag_color if tag_color else TEXT_MUTED.name()}; font-size: 11px; font-weight: 600; "
            "background: transparent; border: none;"
        )
        info.addWidget(self.tag_lbl)

        layout.addLayout(info)
        layout.addStretch()
        self._load_icon()

    def update_tag(self, text: str, color: str = None):
        self.tag_lbl.setText(text)
        if color:
            self.tag_lbl.setStyleSheet(
                f"color: {color}; font-size: 11px; font-weight: 600; "
                "background: transparent; border: none;"
            )

    def _load_icon(self):
        url = quest_icon_url(self.quest)
        if not url:
            return
        self._loader = ImageLoader(url, QSize(54, 54))
        self._loader.loaded.connect(self._on_icon)
        self._loader.start()

    def _on_icon(self, _url: str, pm: QPixmap):
        self.icon_lbl.setPixmap(make_rounded_pixmap(pm, 54))


class ScrollPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        outer.addWidget(self.scroll)

        self._container = QWidget()
        self._layout = QVBoxLayout(self._container)
        self._layout.setContentsMargins(12, 8, 12, 12)
        self._layout.setSpacing(8)
        self._layout.addStretch()
        self.scroll.setWidget(self._container)

    def clear(self):
        while self._layout.count() > 1:
            item = self._layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

    def add_card(self, card: QWidget):
        self._layout.insertWidget(self._layout.count() - 1, card)

    def add_empty(self, text: str):
        lbl = QLabel(text)
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lbl.setStyleSheet(f"color: {TEXT_MUTED.name()}; font-size: 13px; padding: 24px;")
        self._layout.insertWidget(0, lbl)

    def cards(self) -> list[QuestCard]:
        res = []
        for i in range(self._layout.count()):
            item = self._layout.itemAt(i)
            if item and item.widget():
                w = item.widget()
                if isinstance(w, QuestCard):
                    res.append(w)
        return res


class LogPage(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._text = QPlainTextEdit()
        self._text.setReadOnly(True)
        self._text.setMaximumBlockCount(500)
        self._text.setStyleSheet(f"""
            QPlainTextEdit {{
                background: {BG_DARKEST.name()};
                color: {TEXT_MUTED.name()};
                font-family: 'Cascadia Code', 'Consolas', monospace;
                font-size: 11px;
                border: none;
                padding: 8px;
            }}
        """)
        layout.addWidget(self._text)

        self._cursor = 0

    def _get_entry_color(self, msg: str) -> str:
        msg_lower = msg.lower()
        if any(k in msg_lower for k in ["account", "heartbeat", "connect", "drop"]):
            return "#5865f2"
        if any(k in msg_lower for k in ["quest", "complete", "progress"]):
            return "#62c465"
        if any(k in msg_lower for k in ["stub", "server", "run request", "http", "get ", "post "]):
            return "#d64776"
        return "#949ba4"

    def append_entries(self, entries: list[dict]):
        if not entries:
            return
        sb = self._text.verticalScrollBar()
        at_bottom = sb.value() >= sb.maximum() - 4
        import html
        import re
        for e in entries:
            ts = html.escape(str(e.get("ts", "")))
            msg = html.escape(str(e.get("msg", "")))
            color = self._get_entry_color(e.get("msg", ""))
            msg_html = re.sub(
                r'^(\[\s*[^\]]+\s*\])',
                r"<span style='color: #ffffff;'>\1</span>",
                msg
            )
            line = f"<span style='color: #6a6f77;'>[{ts}]</span> <span style='color: {color};'>{msg_html}</span>"
            self._text.appendHtml(line)
        if at_bottom:
            self._text.moveCursor(self._text.textCursor().MoveOperation.End)


class ActiveQuestPanel(QWidget):
    HERO_HEIGHT = 140
    IDLE_HEIGHT = 90

    def __init__(self, parent=None):
        super().__init__(parent)
        self._hero_loader: ImageLoader | None = None
        self._icon_loader: ImageLoader | None = None
        self._current_quest_id: str | None = None
        self._default_icon: QPixmap | None = _load_logo_png(72)

        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        self._root = QVBoxLayout(self)
        self._root.setContentsMargins(0, 0, 0, 0)
        self._root.setSpacing(0)

        self.hero = HeroBanner()
        self.hero.setFixedHeight(self.HERO_HEIGHT)
        self.hero.hide()
        self._root.addWidget(self.hero)

        info_row = QHBoxLayout()
        info_row.setContentsMargins(20, 12, 20, 12)
        info_row.setSpacing(16)

        self.ring = RingWidget(size=72, ring_width=5)
        self.ring.set_pixmap(self._default_icon)
        info_row.addWidget(self.ring, 0, Qt.AlignmentFlag.AlignVCenter)

        text_col = QVBoxLayout()
        text_col.setSpacing(2)
        self.title_lbl = QLabel("No active quest")
        self.title_lbl.setStyleSheet(
            f"color: {ACCENT_BLUE.name()}; font-size: 15px; font-weight: 700;"
        )
        self.orb_lbl = QLabel("")
        self.orb_lbl.setStyleSheet(f"color: {TEXT_PRIMARY.name()}; font-size: 12px;")
        self.prog_lbl = QLabel("")
        self.prog_lbl.setStyleSheet(f"color: {TEXT_MUTED.name()}; font-size: 11px;")
        text_col.addWidget(self.title_lbl)
        text_col.addWidget(self.orb_lbl)
        text_col.addWidget(self.prog_lbl)
        info_row.addLayout(text_col)
        info_row.addStretch()

        self._root.addLayout(info_row)

    def _set_hero_visible(self, visible: bool):
        if visible:
            self.hero.show()
            self.hero.setFixedHeight(self.HERO_HEIGHT)
        else:
            self.hero.hide()
            self.hero.setFixedHeight(0)

    def update_quest(self, quest: dict | None, active_status_type: str | None = None, active_ends_at: int = 0):
        if quest is None or not isinstance(quest, dict):
            self._set_hero_visible(False)
            self.title_lbl.setText("No active quest")
            self.orb_lbl.setText("")
            self.prog_lbl.setText("")
            self.ring.set_progress(0.0)
            self.ring.set_pixmap(self._default_icon)
            self._current_quest_id = None
            return

        qid = quest.get("id")
        first_load = qid != self._current_quest_id
        self._current_quest_id = qid

        self.title_lbl.setText(quest_name(quest))
        orbs = quest_orbs(quest)

        orb_icon = f"<img src='data:image/png;base64,{ORB_ICON_BASE64}' width='13' height='13'>" if ORB_ICON_BASE64 else "◇"
        self.orb_lbl.setText(f"{orb_icon} {orbs:,} Orbs" if orbs else "")

        pct, label = quest_progress(quest, active_status_type, active_ends_at)
        self.ring.set_progress(pct)
        self.prog_lbl.setText(label)

        if first_load:
            self._set_hero_visible(True)

            hero_url = quest_hero_url(quest)
            if hero_url:
                self._hero_loader = ImageLoader(hero_url, QSize(900, 280))
                self._hero_loader.loaded.connect(lambda _, pm: self.hero.set_pixmap(pm))
                self._hero_loader.start()
            else:
                self.hero.set_pixmap(None)

            icon_url = quest_icon_url(quest)
            if icon_url:
                self._icon_loader = ImageLoader(icon_url, QSize(72, 72))
                self._icon_loader.loaded.connect(lambda _, pm: self.ring.set_pixmap(pm))
                self._icon_loader.start()
            else:
                self.ring.set_pixmap(self._default_icon)


class BannerBar(QLabel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(24)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setStyleSheet(f"""
            background: {ACCENT_BLUE.name()};
            color: white;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.5px;
        """)
        self.hide()

    def set_info(self, quest_count: int, orb_total: int):
        if quest_count == 0:
            self.hide()
            return
        orb_icon = f"<img src='data:image/png;base64,{ORB_ICON_BASE64}' width='12' height='12'>" if ORB_ICON_BASE64 else "◇"
        self.setText(
            f"Available Quests: {quest_count}   •   "
            f"{orb_icon} {orb_total:,} Total"
        )
        self.show()


def style_combobox(combo: QComboBox):
    combo.setView(QListView())


class SettingsDialog(QDialog):
    def __init__(self, prefs: dict, parent=None):
        super().__init__(parent)
        self._prefs = prefs
        self.setWindowTitle("General Settings")
        self.setFixedWidth(360)
        self.setStyleSheet(f"""
            QDialog {{ background: {BG_DARK.name()}; color: {TEXT_PRIMARY.name()}; }}
            QLabel {{ color: {TEXT_PRIMARY.name()}; }}
            QCheckBox {{ color: {TEXT_PRIMARY.name()}; spacing: 8px; }}
            QCheckBox::indicator {{
                width: 14px;
                height: 14px;
                border: 1.5px solid {BORDER.name()};
                border-radius: 3px;
                background: {BG_CARD.name()};
            }}
            QCheckBox::indicator:unchecked:hover {{
                border: 1.5px solid {ACCENT_BLUE.name()};
            }}
            QCheckBox::indicator:checked {{
                border: 1.5px solid {ACCENT_BLUE.name()};
                background: {ACCENT_BLUE.name()};
                image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
            }}
            QSpinBox, QLineEdit {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 4px;
                padding: 3px 6px;
            }}
            QComboBox {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 4px;
                padding: 3px 6px;
            }}
            QComboBox:hover {{ border: 1px solid {ACCENT_BLUE.name()}; }}
            QComboBox::drop-down {{ border: none; width: 20px; }}
            QComboBox::down-arrow {{ image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23949ba4' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E"); }}
            QComboBox QAbstractItemView {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 6px;
                padding: 2px 0px;
                outline: none;
            }}
            QComboBox QAbstractItemView::item {{
                padding: 2px 6px;
                background: transparent;
                color: {TEXT_PRIMARY.name()};
                border: none;
            }}
            QComboBox QAbstractItemView::item:selected, QComboBox QAbstractItemView::item:hover {{
                background-color: {ACCENT_BLUE.name()};
                color: white;
                border: none;
            }}
            QPushButton {{
                background: {ACCENT_BLUE.name()};
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 16px;
                font-weight: 700;
            }}
            QPushButton:hover {{ background: #4752c4; }}
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(20, 20, 20, 20)

        form = QFormLayout()
        form.setSpacing(10)

        self.chk_orbs_only = QCheckBox("Only show/notify for orb rewards")
        self.chk_orbs_only.setChecked(prefs.get("orbs_only", True))
        form.addRow(self.chk_orbs_only)

        self.spin_min_orbs = QSpinBox()
        self.spin_min_orbs.setRange(0, 10000)
        self.spin_min_orbs.setSingleStep(100)
        self.spin_min_orbs.setValue(prefs.get("min_orbs", 0))
        form.addRow("Minimum orbs:", self.spin_min_orbs)

        self.chk_notify_video = QCheckBox("Show/notify for video quests")
        self.chk_notify_video.setChecked(prefs.get("notify_video", True))
        form.addRow(self.chk_notify_video)

        div = QFrame()
        div.setFrameShape(QFrame.Shape.HLine)
        div.setStyleSheet(f"background: {BORDER.name()};")
        form.addRow(div)

        self.combo_cleanup = QComboBox()
        style_combobox(self.combo_cleanup)
        self.combo_cleanup.addItem("Save for X days", "days")
        self.combo_cleanup.addItem("Clean on quest end", "always")
        self.combo_cleanup.addItem("Never clean", "never")

        mode = prefs.get("stub_cleanup_mode", "days")
        idx = self.combo_cleanup.findData(mode)
        if idx >= 0:
            self.combo_cleanup.setCurrentIndex(idx)

        form.addRow("Stub Cleanup:", self.combo_cleanup)

        self.spin_cleanup_days = QSpinBox()
        self.spin_cleanup_days.setRange(0, 365)
        self.spin_cleanup_days.setValue(prefs.get("stub_cleanup_days", 7))
        form.addRow("Days to keep stubs:", self.spin_cleanup_days)

        self.combo_cleanup.currentIndexChanged.connect(self._update_spin_state)
        self._update_spin_state()

        div2 = QFrame()
        div2.setFrameShape(QFrame.Shape.HLine)
        div2.setStyleSheet(f"background: {BORDER.name()};")
        form.addRow(div2)

        dir_box = QHBoxLayout()
        self.txt_fake_games_dir = QLineEdit()
        self.txt_fake_games_dir.setText(prefs.get("fake_games_dir", APPDATA_DIR))
        btn_browse_dir = QPushButton()
        browse_icon = _load_svg_icon(BROWSE_ICON_SVG_PATH, 16)
        if not browse_icon.isNull():
            btn_browse_dir.setIcon(browse_icon)
            btn_browse_dir.setIconSize(QSize(16, 16))
        else:
            btn_browse_dir.setText("Browse...")
        btn_browse_dir.setFixedWidth(36)
        btn_browse_dir.setToolTip("Browse...")
        btn_browse_dir.clicked.connect(self._browse_fake_games_dir)
        dir_box.addWidget(self.txt_fake_games_dir)
        dir_box.addWidget(btn_browse_dir)

        form.addRow("Fake Games Dir:", dir_box)

        layout.addLayout(form)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def _browse_fake_games_dir(self):
        curr = self.txt_fake_games_dir.text().strip() or APPDATA_DIR
        chosen = QFileDialog.getExistingDirectory(self, "Select Fake Games Directory", curr)
        if chosen:
            self.txt_fake_games_dir.setText(chosen)

    def _update_spin_state(self):
        self.spin_cleanup_days.setEnabled(self.combo_cleanup.currentData() == "days")

    def get_prefs(self) -> dict:
        p = dict(self._prefs)
        p["orbs_only"] = self.chk_orbs_only.isChecked()
        p["min_orbs"] = self.spin_min_orbs.value()
        p["notify_video"] = self.chk_notify_video.isChecked()
        p["stub_cleanup_mode"] = self.combo_cleanup.currentData()
        p["stub_cleanup_days"] = self.spin_cleanup_days.value()
        p["fake_games_dir"] = self.txt_fake_games_dir.text().strip() or APPDATA_DIR
        return p


class UpdateSettingsDialog(QDialog):
    def __init__(self, prefs: dict, parent=None):
        super().__init__(parent)
        self._prefs = prefs
        self.setWindowTitle("Update Settings")
        self.setFixedWidth(420)
        self.setStyleSheet(f"""
            QDialog {{ background: {BG_DARK.name()}; color: {TEXT_PRIMARY.name()}; }}
            QLabel {{ color: {TEXT_PRIMARY.name()}; }}
            QComboBox {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 4px;
                padding: 4px 6px;
            }}
            QComboBox:hover {{ border: 1px solid {ACCENT_BLUE.name()}; }}
            QComboBox::drop-down {{ border: none; width: 20px; }}
            QComboBox::down-arrow {{ image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23949ba4' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E"); }}
            QComboBox QAbstractItemView {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 6px;
                padding: 2px 0px;
                outline: none;
            }}
            QComboBox QAbstractItemView::item {{
                padding: 2px 6px;
                background: transparent;
                color: {TEXT_PRIMARY.name()};
                border: none;
            }}
            QComboBox QAbstractItemView::item:selected, QComboBox QAbstractItemView::item:hover {{
                background-color: {ACCENT_BLUE.name()};
                color: white;
                border: none;
            }}
            QPushButton {{
                background: {ACCENT_BLUE.name()};
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 16px;
                font-weight: 700;
            }}
            QPushButton:hover {{ background: #4752c4; }}
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(20, 20, 20, 20)

        form = QFormLayout()
        form.setSpacing(12)

        self.combo_app_mode = QComboBox()
        style_combobox(self.combo_app_mode)
        self.combo_app_mode.addItem("Ask before updating", "Ask")
        self.combo_app_mode.addItem("Automatic background update", "Auto")
        app_m_idx = self.combo_app_mode.findData(prefs.get("update_mode_app", "Ask"))
        if app_m_idx >= 0:
            self.combo_app_mode.setCurrentIndex(app_m_idx)
        form.addRow("App Executable Updates:", self.combo_app_mode)

        self.combo_plugin_mode = QComboBox()
        style_combobox(self.combo_plugin_mode)
        self.combo_plugin_mode.addItem("Automatic background update", "Auto")
        self.combo_plugin_mode.addItem("Ask before updating", "Ask")
        plug_m_idx = self.combo_plugin_mode.findData(prefs.get("update_mode_plugin", "Auto"))
        if plug_m_idx >= 0:
            self.combo_plugin_mode.setCurrentIndex(plug_m_idx)
        form.addRow("Vencord Plugin Updates:", self.combo_plugin_mode)

        self.combo_scope = QComboBox()
        style_combobox(self.combo_scope)
        self.combo_scope.addItem("Any update (All versions)", "Any")
        self.combo_scope.addItem("Major updates only", "Major")
        self.combo_scope.addItem("Disable update checks", "None")
        scope_idx = self.combo_scope.findData(prefs.get("update_scope", "Any"))
        if scope_idx >= 0:
            self.combo_scope.setCurrentIndex(scope_idx)
        form.addRow("Update Scope:", self.combo_scope)

        layout.addLayout(form)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def get_prefs(self) -> dict:
        p = dict(self._prefs)
        p["update_mode_app"] = self.combo_app_mode.currentData()
        p["update_mode_plugin"] = self.combo_plugin_mode.currentData()
        p["update_scope"] = self.combo_scope.currentData()
        return p


class VencordManagerDialog(QDialog):
    def __init__(self, prefs: dict, parent=None):
        super().__init__(parent)
        self._prefs = prefs
        self.setWindowTitle("Vencord Manager")
        self.setFixedSize(480, 380)
        self.setStyleSheet(f"""
            QDialog {{ background: {BG_DARK.name()}; color: {TEXT_PRIMARY.name()}; }}
            QLabel {{ color: {TEXT_PRIMARY.name()}; }}
            QLineEdit {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 4px;
                padding: 4px 6px;
            }}
            QPushButton {{
                background: {ACCENT_BLUE.name()};
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 14px;
                font-weight: 700;
            }}
            QPushButton:hover {{ background: #4752c4; }}
            QPushButton:disabled {{ background: {BG_MID.name()}; color: {TEXT_MUTED.name()}; }}
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        form = QFormLayout()
        vencord_box = QHBoxLayout()
        self.txt_vencord_dir = QLineEdit()
        saved_v_dir = prefs.get("vencord_source_dir", "") or vencord_helper.find_vencord_dir() or ""
        self.txt_vencord_dir.setText(saved_v_dir)

        btn_browse_v = QPushButton()
        browse_icon = _load_svg_icon(BROWSE_ICON_SVG_PATH, 16)
        if not browse_icon.isNull():
            btn_browse_v.setIcon(browse_icon)
            btn_browse_v.setIconSize(QSize(16, 16))
        else:
            btn_browse_v.setText("Browse...")
        btn_browse_v.setFixedWidth(36)
        btn_browse_v.setToolTip("Browse...")
        btn_browse_v.clicked.connect(self._browse_vencord_dir)
        vencord_box.addWidget(self.txt_vencord_dir)
        vencord_box.addWidget(btn_browse_v)
        form.addRow("Vencord Source Dir:", vencord_box)
        layout.addLayout(form)

        btn_box = QHBoxLayout()
        self.btn_build_vencord = QPushButton("Sync && Build Vencord")
        self.btn_build_vencord.clicked.connect(self._on_build_vencord)
        btn_box.addWidget(self.btn_build_vencord)

        self.btn_setup_vencord = QPushButton("1-Click Full Setup")
        self.btn_setup_vencord.clicked.connect(self._on_setup_vencord)
        btn_box.addWidget(self.btn_setup_vencord)
        layout.addLayout(btn_box)

        self.vencord_log = QPlainTextEdit()
        self.vencord_log.setReadOnly(True)
        self.vencord_log.setStyleSheet(f"background: {BG_CARD.name()}; color: {TEXT_MUTED.name()}; font-family: monospace; font-size: 11px;")
        layout.addWidget(self.vencord_log)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

        self._build_worker = None

    def _browse_vencord_dir(self):
        curr = self.txt_vencord_dir.text().strip() or os.path.expanduser("~")
        chosen = QFileDialog.getExistingDirectory(self, "Select Vencord Source Directory", curr)
        if chosen:
            self.txt_vencord_dir.setText(chosen)

    def _on_build_vencord(self):
        target_dir = self.txt_vencord_dir.text().strip()
        if not target_dir:
            target_dir = vencord_helper.find_vencord_dir()
            if target_dir:
                self.txt_vencord_dir.setText(target_dir)

        if not target_dir:
            QMessageBox.warning(self, "Vencord Directory Required", "Please specify the directory where Vencord is built from source.")
            return

        self.vencord_log.appendPlainText("Starting Vencord sync and build...")
        self.btn_build_vencord.setEnabled(False)
        self.btn_setup_vencord.setEnabled(False)

        self._build_worker = vencord_helper.VencordBuildWorker(target_dir, mode="build")
        self._build_worker.log_signal.connect(self.vencord_log.appendPlainText)
        self._build_worker.finished_signal.connect(self._on_worker_finished)
        self._build_worker.start()

    def _on_setup_vencord(self):
        target_dir = self.txt_vencord_dir.text().strip() or os.path.join(os.path.expanduser("~"), "Vencord")
        self.txt_vencord_dir.setText(target_dir)

        self.vencord_log.appendPlainText("Starting 1-Click Full Vencord Setup...")
        self.btn_build_vencord.setEnabled(False)
        self.btn_setup_vencord.setEnabled(False)

        self._build_worker = vencord_helper.VencordBuildWorker(target_dir, mode="setup")
        self._build_worker.log_signal.connect(self.vencord_log.appendPlainText)
        self._build_worker.finished_signal.connect(self._on_worker_finished)
        self._build_worker.start()

    def _on_worker_finished(self, success: bool, message: str):
        self.btn_build_vencord.setEnabled(True)
        self.btn_setup_vencord.setEnabled(True)
        self.vencord_log.appendPlainText(f"\nStatus: {message}")
        if success:
            QMessageBox.information(self, "Vencord Build Complete", f"{message}\n\nPlease restart Discord (Ctrl+R) to apply changes.")
        else:
            QMessageBox.critical(self, "Vencord Build Failed", message)

    def get_prefs(self) -> dict:
        p = dict(self._prefs)
        p["vencord_source_dir"] = self.txt_vencord_dir.text().strip()
        return p


class LoggingSettingsDialog(QDialog):
    def __init__(self, prefs: dict, parent=None):
        super().__init__(parent)
        self._prefs = prefs
        self.setWindowTitle("Logging Settings")
        self.setFixedWidth(360)
        self.setStyleSheet(f"""
            QDialog {{ background: {BG_DARK.name()}; color: {TEXT_PRIMARY.name()}; }}
            QLabel {{ color: {TEXT_PRIMARY.name()}; }}
            QCheckBox {{ color: {TEXT_PRIMARY.name()}; spacing: 8px; }}
            QCheckBox::indicator {{
                width: 14px;
                height: 14px;
                border: 1.5px solid {BORDER.name()};
                border-radius: 3px;
                background: {BG_CARD.name()};
            }}
            QCheckBox::indicator:unchecked:hover {{
                border: 1.5px solid {ACCENT_BLUE.name()};
            }}
            QCheckBox::indicator:checked {{
                border: 1.5px solid {ACCENT_BLUE.name()};
                background: {ACCENT_BLUE.name()};
                image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'%3E%3C/polyline%3E%3C/svg%3E");
            }}
            QPushButton {{
                background: {ACCENT_BLUE.name()};
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 16px;
                font-weight: 700;
            }}
            QPushButton:hover {{ background: #4752c4; }}
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(20, 20, 20, 20)

        form = QFormLayout()
        form.setSpacing(10)

        self.chk_log_heartbeats = QCheckBox("Heartbeat synchronizations")
        self.chk_log_heartbeats.setChecked(prefs.get("log_heartbeats", False))
        form.addRow(self.chk_log_heartbeats)

        self.chk_log_accounts = QCheckBox("Account connections && drops")
        self.chk_log_accounts.setChecked(prefs.get("log_accounts", True))
        form.addRow(self.chk_log_accounts)

        self.chk_log_progress = QCheckBox("Quest progress updates")
        self.chk_log_progress.setChecked(prefs.get("log_progress", False))
        form.addRow(self.chk_log_progress)

        self.chk_log_completion = QCheckBox("Quest completions")
        self.chk_log_completion.setChecked(prefs.get("log_completion", True))
        form.addRow(self.chk_log_completion)

        self.chk_log_stubs = QCheckBox("Stub creation && cleanup")
        self.chk_log_stubs.setChecked(prefs.get("log_stubs", True))
        form.addRow(self.chk_log_stubs)

        self.chk_log_server = QCheckBox("Server requests")
        self.chk_log_server.setChecked(prefs.get("log_server", False))
        form.addRow(self.chk_log_server)

        layout.addLayout(form)

        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def get_prefs(self) -> dict:
        p = dict(self._prefs)
        p["log_heartbeats"] = self.chk_log_heartbeats.isChecked()
        p["log_accounts"] = self.chk_log_accounts.isChecked()
        p["log_progress"] = self.chk_log_progress.isChecked()
        p["log_completion"] = self.chk_log_completion.isChecked()
        p["log_stubs"] = self.chk_log_stubs.isChecked()
        p["log_server"] = self.chk_log_server.isChecked()
        return p


class AppUpdateDialog(QDialog):
    def __init__(self, version: str, changelog: str, download_url: str, parent=None):
        super().__init__(parent)
        self.version = version
        self.changelog = changelog
        self.download_url = download_url
        self.skip_requested = False

        self.setWindowTitle(f"Adventurer Update Available ({version})")
        self.setFixedSize(450, 320)
        self.setStyleSheet(f"""
            QDialog {{ background: {BG_DARK.name()}; color: {TEXT_PRIMARY.name()}; }}
            QLabel {{ color: {TEXT_PRIMARY.name()}; }}
            QPlainTextEdit {{ background: {BG_CARD.name()}; color: {TEXT_PRIMARY.name()}; border: 1px solid {BORDER.name()}; border-radius: 4px; font-family: sans-serif; font-size: 12px; }}
            QPushButton {{
                background: {ACCENT_BLUE.name()};
                color: white;
                border: none;
                border-radius: 4px;
                padding: 6px 14px;
                font-weight: 700;
            }}
            QPushButton:hover {{ background: #4752c4; }}
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        title_lbl = QLabel(f"<b>Adventurer {version} is now available!</b>")
        title_lbl.setStyleSheet("font-size: 14px;")
        layout.addWidget(title_lbl)

        changelog_txt = QPlainTextEdit()
        changelog_txt.setReadOnly(True)
        changelog_txt.setPlainText(changelog)
        layout.addWidget(changelog_txt)

        btn_layout = QHBoxLayout()
        btn_skip = QPushButton("Skip Version")
        btn_skip.setStyleSheet(f"background: {BG_MID.name()}; color: {TEXT_MUTED.name()};")
        btn_skip.clicked.connect(self._on_skip)

        btn_later = QPushButton("Remind Me Later")
        btn_later.setStyleSheet(f"background: {BG_MID.name()}; color: {TEXT_PRIMARY.name()};")
        btn_later.clicked.connect(self.reject)

        btn_update = QPushButton("Update Now")
        btn_update.clicked.connect(self.accept)

        btn_layout.addWidget(btn_skip)
        btn_layout.addStretch()
        btn_layout.addWidget(btn_later)
        btn_layout.addWidget(btn_update)
        layout.addLayout(btn_layout)

    def _on_skip(self):
        self.skip_requested = True
        self.reject()


class UpdateCheckerThread(QThread):
    app_update_signal = pyqtSignal(str, str, str)
    plugin_update_signal = pyqtSignal(str)

    def __init__(self, prefs: dict):
        super().__init__()
        self.prefs = prefs

    def run(self):
        try:
            upd = updater.AutoUpdater(self.prefs)
            app_update, app_ver, changelog, d_url = upd.check_app_update()
            if app_update:
                self.app_update_signal.emit(app_ver, changelog, d_url)

            plugin_update, plug_ver = upd.check_plugin_update()
            if plugin_update:
                self.plugin_update_signal.emit(plug_ver)
        except Exception as e:
            print(f"Update checker thread exception: {e}")


class UserMenuItemWidget(QFrame):
    clicked = pyqtSignal(str)

    def __init__(self, uid: str, username: str, is_selected: bool, avatar_pm: QPixmap | None, parent=None):
        super().__init__(parent)
        self.uid = uid
        self.is_selected = is_selected
        self._hovered = False

        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(6, 4, 12, 4)
        layout.setSpacing(6)

        self.avatar_lbl = QLabel()
        self.avatar_lbl.setFixedSize(22, 22)
        self.avatar_lbl.setStyleSheet("background: transparent;")
        if avatar_pm and not avatar_pm.isNull():
            self.avatar_lbl.setPixmap(avatar_pm.scaled(22, 22, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))
        layout.addWidget(self.avatar_lbl)

        check_str = "✓ " if is_selected else "  "
        self.text_lbl = QLabel(f"{check_str}{username}")
        self.text_lbl.setStyleSheet("background: transparent; color: #f2f3f5; font-size: 12px; font-weight: 500;")
        layout.addWidget(self.text_lbl)
        layout.addStretch()

        self._update_style()

    def set_avatar(self, pm: QPixmap):
        if pm and not pm.isNull():
            self.avatar_lbl.setPixmap(pm.scaled(22, 22, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation))

    def enterEvent(self, event):
        self._hovered = True
        self._update_style()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self._hovered = False
        self._update_style()
        super().leaveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.uid)
        super().mouseReleaseEvent(event)

    def _update_style(self):
        bg = ACCENT_BLUE.name() if self._hovered else "transparent"
        self.setStyleSheet(f"QFrame {{ background: {bg}; border: none; border-radius: 0px; }} QLabel {{ background: transparent; }}")


class UserAvatarButton(QToolButton):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(26, 26)
        self.setStyleSheet("""
            QToolButton { border: none; background: transparent; padding: 0; }
            QToolButton::menu-indicator { image: none; }
        """)
        self.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self._menu = QMenu(self)
        self._menu.setStyleSheet(f"""
            QMenu {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 6px;
                padding: 4px 0px;
            }}
            QMenu::item {{
                padding: 0px;
                margin: 0px;
            }}
        """)
        self.setMenu(self._menu)
        self._set_placeholder()
        self._avatar_loaders: list[ImageLoader] = []
        self._avatar_cache: dict[str, QPixmap] = {}
        self._item_widgets: dict[str, UserMenuItemWidget] = {}

    def _set_placeholder(self):
        pm = QPixmap(26, 26)
        pm.fill(Qt.GlobalColor.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setBrush(QBrush(BG_MID))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(0, 0, 26, 26)
        p.end()
        self.setIcon(QIcon(pm))
        self.setIconSize(QSize(26, 26))

    def update_users(self, users: dict[str, dict], selected_id: str | None,
                     on_select):
        self._menu.clear()
        self._item_widgets.clear()

        min_w = 180
        for u_info in users.values():
            name_len = len(u_info.get("username", ""))
            min_w = max(min_w, name_len * 9 + 65)

        for uid, info in users.items():
            username = info.get("username", "Unknown")
            is_selected = uid == selected_id

            avatar_url = info.get("avatar")
            if avatar_url:
                if not (avatar_url.startswith("http://") or avatar_url.startswith("https://")):
                    if avatar_url.startswith("/"):
                        avatar_url = f"https://discord.com{avatar_url}"
                    else:
                        avatar_url = f"https://discord.com/{avatar_url}"
            else:
                try:
                    avatar_url = f"https://cdn.discordapp.com/embed/avatars/{int(uid) % 5}.png"
                except (ValueError, TypeError):
                    avatar_url = "https://cdn.discordapp.com/embed/avatars/0.png"

            cached_pm = self._avatar_cache.get(uid)
            item_widget = UserMenuItemWidget(uid, username, is_selected, cached_pm, self._menu)
            item_widget.setMinimumWidth(min_w)
            self._item_widgets[uid] = item_widget

            action = QWidgetAction(self._menu)
            action.setDefaultWidget(item_widget)

            def on_item_clicked(u=uid):
                on_select(u)
                self._menu.close()

            item_widget.clicked.connect(on_item_clicked)

            if not cached_pm and avatar_url:
                self._load_avatar(uid, avatar_url, item_widget)

            self._menu.addAction(action)

        if selected_id and selected_id in self._avatar_cache:
            self.setIcon(QIcon(self._avatar_cache[selected_id]))
            self.setIconSize(QSize(26, 26))

    def _load_avatar(self, user_id: str, url: str, item_widget: UserMenuItemWidget):
        loader = ImageLoader(url, QSize(24, 24))
        self._avatar_loaders.append(loader)

        def on_loaded(_url: str, pm: QPixmap):
            circular = make_circle_pixmap(pm, 24)
            self._avatar_cache[user_id] = circular
            if user_id in self._item_widgets:
                self._item_widgets[user_id].set_avatar(circular)
            loader.deleteLater()
            if loader in self._avatar_loaders:
                self._avatar_loaders.remove(loader)

        loader.loaded.connect(on_loaded)
        loader.start()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Adventurer")
        self.setMinimumSize(420, 480)
        self.resize(520, 660)

        self._app_icon = self._load_app_icon()
        self.setWindowIcon(self._app_icon)

        self._prefs = load_prefs()
        server_state.set_log_settings({
            "heartbeats": self._prefs.get("log_heartbeats", False),
            "progress": self._prefs.get("log_progress", False),
            "completion": self._prefs.get("log_completion", True),
            "accounts": self._prefs.get("log_accounts", True),
            "stubs": self._prefs.get("log_stubs", True),
            "server": self._prefs.get("log_server", False)
        })
        server_state.set_stub_cleanup(
            self._prefs.get("stub_cleanup_mode", "days"),
            self._prefs.get("stub_cleanup_days", 7)
        )

        self._force_quit = False
        self._last_quest_ids: list[str] = []
        self._last_active_id: str | None = None
        self._last_user_ids: list[str] = []
        self._previously_incomplete: set[str] = set()
        self._icon_cache: dict[str, QIcon] = {}
        self._icon_loaders: list[ImageLoader] = []
        self._log_cursor: int = 0

        self._quest_svg_pm = _load_quest_svg(64)
        self._upd_checker = None
        self._plugin_worker = None

        self._setup_style()
        self._setup_tray()
        self._setup_ui()
        self._setup_timer()
        self._start_update_checker()
        self._check_vencord_path_on_startup()

    def _check_vencord_path_on_startup(self):
        vencord_dir = self._prefs.get("vencord_source_dir", "").strip()
        if not vencord_dir or not os.path.exists(vencord_dir):
            auto_dir = vencord_helper.find_vencord_dir()
            if not auto_dir or not os.path.exists(auto_dir):
                QTimer.singleShot(400, self._open_vencord_settings)

    def _start_update_checker(self):
        if self._prefs.get("update_scope", "Any") == "None":
            return
        self._upd_checker = UpdateCheckerThread(self._prefs)
        self._upd_checker.app_update_signal.connect(self._handle_app_update)
        self._upd_checker.plugin_update_signal.connect(self._handle_plugin_update)
        self._upd_checker.start()

    def _handle_app_update(self, version: str, changelog: str, download_url: str):
        mode = self._prefs.get("update_mode_app", "Ask")
        if mode == "Auto":
            upd = updater.AutoUpdater(self._prefs)
            upd.download_app_update(download_url)
        else:
            dlg = AppUpdateDialog(version, changelog, download_url, self)
            res = dlg.exec()
            if res == QDialog.DialogCode.Accepted:
                upd = updater.AutoUpdater(self._prefs)
                upd.download_app_update(download_url)
            elif dlg.skip_requested:
                self._prefs["skipped_app_version"] = version
                save_prefs(self._prefs)

    def _handle_plugin_update(self, version: str):
        mode = self._prefs.get("update_mode_plugin", "Auto")
        vencord_dir = self._prefs.get("vencord_source_dir", "") or vencord_helper.find_vencord_dir()
        if not vencord_dir or not os.path.exists(vencord_dir):
            reply = QMessageBox.question(
                self,
                "Vencord Directory Required",
                f"A new Adventurer Plugin update ({version}) is available, but your Vencord source directory is not configured.\n\nWould you like to open Settings to set up Vencord?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            )
            if reply == QMessageBox.StandardButton.Yes:
                self._open_vencord_settings()
            return

        if mode == "Auto":
            self._apply_plugin_update(version, vencord_dir)
        else:
            reply = QMessageBox.question(
                self,
                "Adventurer Plugin Update Available",
                f"A new Adventurer Vencord Plugin update ({version}) is available.\n\nWould you like to install and rebuild Vencord now?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            )
            if reply == QMessageBox.StandardButton.Yes:
                self._apply_plugin_update(version, vencord_dir)

    def _apply_plugin_update(self, version: str, vencord_dir: str):
        upd = updater.AutoUpdater(self._prefs)
        code = upd.fetch_latest_plugin_code()
        if code:
            synced = vencord_helper.sync_plugin_file(vencord_dir, code)
            if synced:
                self._plugin_worker = vencord_helper.VencordBuildWorker(vencord_dir, mode="build")
                def on_finished(success, msg):
                    if success:
                        QMessageBox.information(
                            self,
                            "Plugin Updated & Vencord Rebuilt",
                            f"Adventurer Plugin has been updated to {version} and Vencord was successfully rebuilt!\n\nPlease restart Discord (Ctrl+R) to apply changes."
                        )
                    else:
                        QMessageBox.warning(self, "Vencord Build Failed", f"Plugin file was updated, but Vencord build failed:\n{msg}")
                self._plugin_worker.finished_signal.connect(on_finished)
                self._plugin_worker.start()

    def _setup_style(self):
        self.setStyleSheet(f"""
            QMainWindow {{ background: {BG_DARK.name()}; }}
            QWidget {{
                background: {BG_DARK.name()};
                color: {TEXT_PRIMARY.name()};
                font-family: 'Segoe UI', sans-serif;
            }}
            QScrollArea {{ border: none; background: transparent; }}
            QScrollBar:vertical {{
                background: {BG_MID.name()};
                width: 6px;
                border-radius: 3px;
            }}
            QScrollBar::handle:vertical {{
                background: {BORDER.name()};
                border-radius: 3px;
                min-height: 20px;
            }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QTabWidget::pane {{
                border: none;
                background: {BG_DARK.name()};
            }}
            QTabBar::tab {{
                background: {BG_MID.name()};
                color: {TEXT_MUTED.name()};
                padding: 6px 16px;
                border: none;
                font-size: 12px;
                font-weight: 600;
            }}
            QTabBar::tab:selected {{
                background: {BG_DARK.name()};
                color: {TEXT_PRIMARY.name()};
                border-bottom: 2px solid {ACCENT_BLUE.name()};
            }}
            QTabBar::tab:hover:!selected {{ background: {BG_CARD.name()}; }}
            QMenuBar {{
                background: {BG_DARKEST.name()};
                color: {TEXT_PRIMARY.name()};
                border-bottom: 1px solid {BORDER.name()};
                padding: 2px;
            }}
            QMenuBar::item:selected {{ background: {BG_MID.name()}; border-radius: 4px; }}
            QMenu {{
                background: {BG_CARD.name()};
                color: {TEXT_PRIMARY.name()};
                border: 1px solid {BORDER.name()};
                border-radius: 6px;
                padding: 4px 0px;
            }}
            QMenu::item {{
                padding: 5px 16px 5px 12px;
                background: transparent;
                border-radius: 0px;
                margin: 0px;
            }}
            QMenu::item:selected {{
                background: {ACCENT_BLUE.name()};
                border-radius: 0px;
            }}
        """)

    def _load_app_icon(self) -> QIcon:
        icon_path = _get_asset_path(os.path.join("assets", "logo.png"))
        if os.path.exists(icon_path):
            icon = QIcon(icon_path)
            if not icon.isNull():
                return icon

        svg_pm = _load_quest_svg(32)
        if svg_pm:
            return QIcon(svg_pm)

        pm = QPixmap(32, 32)
        pm.fill(Qt.GlobalColor.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setBrush(QBrush(ACCENT_BLUE))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(2, 2, 28, 28)
        p.setPen(QPen(QColor("white"), 2.5))
        p.drawText(QRect(0, 0, 32, 32), Qt.AlignmentFlag.AlignCenter, "A")
        p.end()
        return QIcon(pm)

    def _setup_tray(self):
        self._tray = QSystemTrayIcon(self)
        self._tray.setIcon(self._app_icon)
        self._tray.setToolTip("Adventurer Quest Tracker")

        tray_menu = QMenu()
        show_action = QAction("Show", self)
        show_action.triggered.connect(self._show_from_tray)
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self._quit_app)
        tray_menu.addAction(show_action)
        tray_menu.addSeparator()
        tray_menu.addAction(quit_action)
        self._tray.setContextMenu(tray_menu)
        self._tray.activated.connect(self._on_tray_activated)
        self._tray.show()

    def _setup_ui(self):
        menubar = self.menuBar()

        self._user_btn = UserAvatarButton(menubar)
        self._user_btn.hide()
        menubar.setCornerWidget(self._user_btn, Qt.Corner.TopLeftCorner)

        file_menu = menubar.addMenu("File")
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self._quit_app)
        file_menu.addAction(quit_action)

        settings_menu = menubar.addMenu("Settings")
        notif_action = QAction("General Settings...", self)
        notif_action.triggered.connect(self._open_settings)
        settings_menu.addAction(notif_action)

        updates_action = QAction("Updates...", self)
        updates_action.triggered.connect(self._open_updates_settings)
        settings_menu.addAction(updates_action)

        vencord_action = QAction("Vencord Manager...", self)
        vencord_action.triggered.connect(self._open_vencord_settings)
        settings_menu.addAction(vencord_action)

        logging_action = QAction("Logging...", self)
        logging_action.triggered.connect(self._open_logging_settings)
        settings_menu.addAction(logging_action)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        self.banner = BannerBar()
        root.addWidget(self.banner)

        self.active_panel = ActiveQuestPanel()
        root.addWidget(self.active_panel)

        div = QFrame()
        div.setFixedHeight(1)
        div.setStyleSheet(f"background: {BORDER.name()};")
        root.addWidget(div)

        self.tabs = QTabWidget()
        self.tabs.setDocumentMode(True)
        root.addWidget(self.tabs)

        self._queue_page = ScrollPage()
        self._available_page = ScrollPage()
        self._history_page = ScrollPage()
        self._log_page = LogPage()

        self.tabs.addTab(self._queue_page, "Queue")
        self.tabs.addTab(self._available_page, "Available")
        self.tabs.addTab(self._history_page, "History")
        self.tabs.addTab(self._log_page, "Log")

        self.status_lbl = QLabel("  Waiting for plugin heartbeat...")
        self.status_lbl.setFixedHeight(22)
        self.status_lbl.setStyleSheet(
            f"color: {TEXT_MUTED.name()}; font-size: 10px; background: {BG_DARKEST.name()};"
        )
        root.addWidget(self.status_lbl)

    def _setup_timer(self):
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(1000)

    def _refresh(self):
        try:
            log_entries, self._log_cursor = server_state.get_log_since(self._log_cursor)
            self._log_page.append_entries(log_entries)

            users = server_state.get_users()
            selected_id = server_state.get_selected_user_id()
            user_ids = sorted(users.keys())

            if user_ids != self._last_user_ids:
                self._last_user_ids = user_ids
                if len(users) > 1:
                    self._user_btn.show()
                    self._user_btn.update_users(users, selected_id, self._on_select_user)
                else:
                    self._user_btn.hide()

            if getattr(self, "_last_selected_id", None) != selected_id:
                self._previously_incomplete.clear()
                self._last_selected_id = selected_id

            state = server_state.get_state(selected_id)
            quests = state.get("quests", [])
            active_quest = state.get("active_quest")
            active_id = state.get("active_quest_id")
            active_status_type = state.get("active_status_type")
            active_ends_at = state.get("active_ends_at", 0)
            last_heartbeat = state.get("last_heartbeat")

            username = users.get(selected_id, {}).get("username", "") if selected_id else ""
            hb_text = f"  Last heartbeat: {last_heartbeat}" if last_heartbeat else "  Waiting for plugin heartbeat..."
            if username and last_heartbeat:
                hb_text = f"  [{username}]  Last heartbeat: {last_heartbeat}"
            self.status_lbl.setText(hb_text)

            if active_id:
                live = next((q for q in quests if q and isinstance(q, dict) and q.get("id") == active_id), None)
                self.active_panel.update_quest(live or active_quest, active_status_type, active_ends_at)
            else:
                self.active_panel.update_quest(None)

            available = self._filter_available(quests)
            total_orbs = sum(quest_orbs(q) for q in available)
            self.banner.set_info(len(available), total_orbs)

            if selected_id:
                new_ids = server_state.consume_new_quest_ids(selected_id)
                if new_ids:
                    new_quests = [q for q in quests if q and isinstance(q, dict) and q.get("id") in new_ids]
                    self._notify_new_quests(new_quests)

            if self._previously_incomplete:
                for quest in quests:
                    if not quest or not isinstance(quest, dict):
                        continue
                    qid = quest.get("id")
                    if qid in self._previously_incomplete and is_complete(quest):
                        self._previously_incomplete.discard(qid)
                        name = quest_name(quest)
                        orbs = quest_orbs(quest)
                        orb_str = f"\n◇ {orbs:,} orbs - claim your reward!" if orbs else ""
                        self._notify_with_icon(
                            "Quest Complete!",
                            f"{name}{orb_str}",
                            quest
                        )

            for quest in quests:
                if quest and isinstance(quest, dict) and is_enrolled(quest) and not is_complete(quest):
                    self._previously_incomplete.add(quest.get("id"))

            current_ids = [q.get("id") for q in quests if q and isinstance(q, dict)]
            if current_ids != self._last_quest_ids or active_id != self._last_active_id:
                self._last_quest_ids = current_ids
                self._last_active_id = active_id
                self._rebuild_tabs(quests, active_id, active_status_type, active_ends_at)

            for card in self._queue_page.cards():
                if not card or not card.quest:
                    continue
                qid = card.quest.get("id")
                if qid == active_id and active_status_type in ["waiting", "stopping", "cleanup", "running"]:
                    _, prog_label = quest_progress(card.quest, active_status_type, active_ends_at)
                    card.update_tag(prog_label if prog_label else "Running")
                else:
                    card.update_tag("Queued")

        except Exception as e:
            print("Error suppressed during GUI refresh tick:")
            traceback.print_exc()

    def _on_select_user(self, user_id: str):
        server_state.set_selected_user(user_id)
        self._last_quest_ids = []
        self._last_user_ids = []

    def _filter_available(self, quests: list[dict]) -> list[dict]:
        result = []
        for q in quests:
            if not q or not isinstance(q, dict):
                continue
            if not is_game_quest(q):
                continue
            if is_enrolled(q):
                continue
            if is_complete(q):
                continue
            if is_expired(q):
                continue
            orbs = quest_orbs(q)
            if self._prefs.get("orbs_only") and orbs == 0:
                continue
            if orbs < self._prefs.get("min_orbs", 0):
                continue
            result.append(q)
        return result

    def _rebuild_tabs(self, quests: list[dict], active_id: str | None, active_status_type: str | None = None,
                      active_ends_at: int = 0):
        self._queue_page.clear()
        self._available_page.clear()
        self._history_page.clear()

        queue_quests = [
            q for q in quests
            if q and isinstance(q, dict)
               and is_game_quest(q)
               and is_enrolled(q)
               and not is_complete(q)
               and not is_expired(q)
        ]

        self.tabs.setTabText(0, f"Queue ({len(queue_quests)})" if queue_quests else "Queue")

        if queue_quests:
            for q in queue_quests:
                is_target_active = q.get("id") == active_id
                pct, prog_label = quest_progress(
                    q,
                    active_status_type if is_target_active else None,
                    active_ends_at if is_target_active else 0
                )
                tag = prog_label if prog_label else "Queued"
                self._queue_page.add_card(QuestCard(q, tag=tag, tag_color=TEXT_MUTED.name()))
        else:
            self._queue_page.add_empty("No queued quests")

        available_quests = self._filter_available(quests)
        self.tabs.setTabText(1, f"Available ({len(available_quests)})" if available_quests else "Available")

        if available_quests:
            for q in available_quests:
                kind = "Not accepted"
                self._available_page.add_card(QuestCard(q, tag=kind, tag_color=TEXT_MUTED.name()))
        else:
            self._available_page.add_empty("No available quests")

        history_quests = [
            q for q in quests
            if q and isinstance(q, dict)
               and is_game_quest(q)
               and is_enrolled(q)
               and (is_complete(q) or is_claimed(q) or is_expired(q))
        ]
        self.tabs.setTabText(2, f"History ({len(history_quests)})" if history_quests else "History")

        if history_quests:
            for q in history_quests:
                if is_claimed(q):
                    tag, color = "✓ Claimed", ACCENT_GREEN.name()
                elif is_complete(q):
                    tag, color = "✓ Complete - unclaimed", ACCENT_GOLD.name()
                elif is_expired(q):
                    tag, color = "Expired", TEXT_MUTED.name()
                else:
                    tag, color = "✓ Complete", ACCENT_GREEN.name()
                self._history_page.add_card(QuestCard(q, tag=tag, tag_color=color))
        else:
            self._history_page.add_empty("No history quests yet")

    def _notify_with_icon(self, title: str, message: str, quest: dict):
        if not quest or not isinstance(quest, dict):
            return
        qid = quest.get("id", "")

        if qid in self._icon_cache:
            self._tray.showMessage(title, message, self._icon_cache[qid], 6000)
            return

        if self._quest_svg_pm:
            fallback_icon = QIcon(self._quest_svg_pm)
        else:
            fallback_icon = self._app_icon

        url = quest_icon_url(quest)
        if not url:
            self._tray.showMessage(title, message, fallback_icon, 6000)
            return

        loader = ImageLoader(url, QSize(64, 64))
        self._icon_loaders.append(loader)

        def on_loaded(_url: str, pm: QPixmap):
            if pm and not pm.isNull():
                icon = QIcon(make_rounded_pixmap(pm, 64))
            else:
                icon = fallback_icon
            self._icon_cache[qid] = icon
            self._tray.showMessage(title, message, icon, 6000)
            loader.deleteLater()
            if loader in self._icon_loaders:
                self._icon_loaders.remove(loader)

        loader.loaded.connect(on_loaded)
        loader.start()

    def _notify_new_quests(self, quests: list[dict]):
        for quest in quests:
            if not quest or not isinstance(quest, dict):
                continue
            orbs = quest_orbs(quest)
            is_video = is_video_quest(quest)

            if self._prefs["orbs_only"] and orbs == 0:
                continue
            if orbs < self._prefs["min_orbs"]:
                continue
            if is_video and not self._prefs["notify_video"]:
                continue

            name = quest_name(quest)
            orb_str = f" - {orbs:,} orbs" if orbs else ""
            kind = "video quest" if is_video else "quest"
            self._notify_with_icon(
                "New Quest Available!",
                f"{name}{orb_str}\n(New {kind})",
                quest
            )

    def _open_settings(self):
        dlg = SettingsDialog(self._prefs, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._prefs = dlg.get_prefs()
            save_prefs(self._prefs)
            server_state.set_stub_cleanup(
                self._prefs.get("stub_cleanup_mode", "days"),
                self._prefs.get("stub_cleanup_days", 7)
            )
            self._last_quest_ids = []

    def _open_updates_settings(self):
        dlg = UpdateSettingsDialog(self._prefs, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._prefs = dlg.get_prefs()
            save_prefs(self._prefs)

    def _open_vencord_settings(self):
        dlg = VencordManagerDialog(self._prefs, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._prefs = dlg.get_prefs()
            save_prefs(self._prefs)

    def _open_logging_settings(self):
        dlg = LoggingSettingsDialog(self._prefs, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._prefs = dlg.get_prefs()
            save_prefs(self._prefs)
            server_state.set_log_settings({
                "heartbeats": self._prefs.get("log_heartbeats", False),
                "progress": self._prefs.get("log_progress", False),
                "completion": self._prefs.get("log_completion", True),
                "accounts": self._prefs.get("log_accounts", True),
                "stubs": self._prefs.get("log_stubs", True),
                "server": self._prefs.get("log_server", False)
            })

    def _show_from_tray(self):
        self.show()
        self.raise_()
        self.activateWindow()

    def _on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.hide() if self.isVisible() else self._show_from_tray()

    def _quit_app(self):
        self._force_quit = True
        QApplication.quit()

    def closeEvent(self, event):
        if getattr(self, "_force_quit", False):
            event.accept()
        else:
            event.ignore()
            self.hide()
            self._tray.showMessage(
                "Adventurer", "Running in system tray",
                self._app_icon, 2000
            )


def run_gui():
    def exception_hook(exctype, value, tb):
        if issubclass(exctype, KeyboardInterrupt):
            sys.__excepthook__(exctype, value, tb)
            return

        import traceback
        tb_lines = traceback.format_exception(exctype, value, tb)
        tb_text = "".join(tb_lines)

        try:
            from PyQt6.QtWidgets import QMessageBox, QApplication
            app = QApplication.instance()
            if app is None:
                app = QApplication(sys.argv)

            msg_box = QMessageBox()
            msg_box.setIcon(QMessageBox.Icon.Critical)
            msg_box.setWindowTitle("Adventurer - Application Crash")
            msg_box.setText("An unexpected error occurred and the application has crashed.")
            msg_box.setInformativeText("Please see the detailed traceback below for error details.")
            msg_box.setDetailedText(tb_text)
            msg_box.setStandardButtons(QMessageBox.StandardButton.Ok)
            msg_box.exec()
        except Exception:
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0,
                    f"An unexpected error occurred and the application has crashed.\n\n"
                    f"Error:\n{exctype.__name__}: {value}\n\n"
                    f"Traceback:\n{tb_text}",
                    "Adventurer - Crash",
                    0x10  # MB_ICONERROR
                )
            except Exception:
                print("Failed to show GUI message box for crash.", file=sys.stderr)
                print(tb_text, file=sys.stderr)

        sys.exit(1)

    sys.excepthook = exception_hook

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    init_orb_icon_base64()

    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    run_gui()