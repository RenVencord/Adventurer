/*
 * Adventurer: in-experience button and menu for toggling features (ESP, Minimap, Auto-complete).
 *
 * buildMenuScript() returns plain JS source that is injected into the
 * activity iframe.
 *
 * Rules:
 *  - Only erasable TypeScript syntax (so node can import it directly).
 *  - Self-contained, idempotent, no external network dependencies.
 */

export interface MenuOptions {
    esp: boolean;
    minimap: boolean;
    autoComplete: boolean;
}

export const MENU_MESSAGE_TAG = "__adventurerOverlay";

export const LOGO_DATA_URI = "data:image/png;base64,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";

export function buildMenuMessage(options: Partial<MenuOptions>) {
    return { [MENU_MESSAGE_TAG]: true, type: "menu_state" as const, ...options };
}

export function buildMenuScript(options: MenuOptions): string {
    const initial = {
        esp: !!options.esp,
        minimap: !!options.minimap,
        autoComplete: !!options.autoComplete
    };

    return `(function () {
    var TAG = "${MENU_MESSAGE_TAG}";

    // If already installed, update local state from options and return.
    if (window.__adventurerMenu) {
        window.__adventurerMenu.update(${JSON.stringify(initial)});
        return;
    }

    // Do not mount duplicate UI if this frame is an inner iframe whose parent frame is on the same origin.
    try {
        if (window.parent && window.parent !== window && window.parent.location.hostname === window.location.hostname) {
            return;
        }
    } catch (e) {
        // Cross-origin parent: this is the top-most frame of the activity.
    }

    var state = {
        open: false,
        esp: ${initial.esp},
        minimap: ${initial.minimap},
        autoComplete: ${initial.autoComplete}
    };

    var switchRenders = {};
    var badgeEl = null;
    var menuEl = null;

    function notifyToggle(feature, enabled) {
        var baseMsg = { [TAG]: true, type: feature === "esp" ? "state" : (feature === "minimap" ? "minimap" : "completion"), enabled: enabled };
        var stateMsg = { [TAG]: true, type: "menu_state", [feature]: enabled };

        // 1. Notify current window
        window.postMessage(baseMsg, "*");
        window.postMessage(stateMsg, "*");

        // 2. Notify all child iframes (such as inner game frames)
        try {
            var iframes = document.querySelectorAll("iframe");
            for (var i = 0; i < iframes.length; i++) {
                var f = iframes[i];
                if (f && f.contentWindow) {
                    f.contentWindow.postMessage(baseMsg, "*");
                    f.contentWindow.postMessage(stateMsg, "*");
                }
            }
        } catch (err) {}

        // 3. Notify parent/top window (Discord renderer / Vencord settings)
        try {
            if (window.top && window.top !== window) {
                window.top.postMessage({
                    __adventurerExperienceToggle: true,
                    feature: feature,
                    enabled: enabled
                }, "*");
            }
        } catch (err) {}
    }

    function updateBadgeIcon() {
        if (!badgeEl) return;
        if (state.open) {
            badgeEl.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#dbdee1" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        } else {
            badgeEl.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#dbdee1" stroke-width="3" stroke-linecap="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
        }
    }

    function setMenuOpen(open) {
        state.open = !!open;
        if (menuEl) menuEl.style.display = state.open ? "block" : "none";
        updateBadgeIcon();
    }

    function createUI() {
        if (document.getElementById("adventurer-experience-bar")) return;

        var host = document.querySelector(".iF1WSW_contentWrapper") || document.body || document.documentElement;
        if (!host) {
            setTimeout(createUI, 200);
            return;
        }

        var container = document.createElement("div");
        container.id = "adventurer-experience-bar";
        container.style.cssText = "position: absolute; top: 15px; left: 15px; z-index: 2147483646; font-family: 'gg sans', 'Noto Sans', sans-serif; user-select: none;";

        // Expand Button (mirrors the game's FloatingHeaderBar button)
        var btn = document.createElement("button");
        btn.id = "adventurer-experience-btn";
        btn.setAttribute("aria-label", "Adventurer Menu");
        btn.style.cssText = "position: relative; width: 60px; height: 60px; border-radius: 50%; background: #262626; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; box-shadow: 0 4px 14px rgba(0,0,0,0.4); transition: transform 0.15s ease, background-color 0.2s ease;";

        var logo = document.createElement("img");
        logo.src = ${JSON.stringify(LOGO_DATA_URI)};
        logo.alt = "Adventurer";
        logo.style.cssText = "width: 42px; height: 42px; border-radius: 50%; object-fit: cover; transition: transform 0.2s cubic-bezier(0.5, 0.33, 0.33, 1); pointer-events: none;";
        btn.appendChild(logo);

        badgeEl = document.createElement("div");
        badgeEl.style.cssText = "position: absolute; bottom: -4px; left: 16px; width: 28px; height: 13px; border-radius: 8px; background: #383838; display: flex; align-items: center; justify-content: center; transition: filter 0.2s ease, background 0.2s ease; pointer-events: none;";
        updateBadgeIcon();
        btn.appendChild(badgeEl);

        btn.onmouseenter = function () {
            logo.style.transform = "scale(1.1)";
            badgeEl.style.filter = "brightness(1.4)";
        };
        btn.onmouseleave = function () {
            logo.style.transform = "scale(1)";
            badgeEl.style.filter = "brightness(1)";
        };

        btn.onclick = function (e) {
            e.stopPropagation();
            setMenuOpen(!state.open);
        };

        // Menu Card
        menuEl = document.createElement("div");
        menuEl.id = "adventurer-experience-menu";
        menuEl.style.cssText = "position: absolute; top: 68px; left: 0; width: 220px; background: rgba(30, 31, 34, 0.95); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6); padding: 12px; display: " + (state.open ? "block" : "none") + ";";

        var header = document.createElement("div");
        header.style.cssText = "display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);";
        header.innerHTML = '<span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #949ba4;">Adventurer</span><span style="font-size: 10px; background: #23a55a; color: #fff; padding: 2px 6px; border-radius: 8px; font-weight: 600;">ACTIVE</span>';
        menuEl.appendChild(header);

        var itemsList = document.createElement("div");
        itemsList.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

        var features = [
            {
                id: "esp",
                label: "ESP",
                desc: "Highlight items",
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
            },
            {
                id: "minimap",
                label: "Minimap",
                desc: "POIs & navigation",
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>'
            },
            {
                id: "autoComplete",
                label: "Auto-complete",
                desc: "Complete quest",
                icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
            }
        ];

        features.forEach(function (f) {
            var row = document.createElement("div");
            row.setAttribute("data-feature", f.id);
            row.className = "adventurer-menu-row";
            row.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 8px; cursor: pointer; transition: background 0.15s ease; color: #dbdee1;";
            row.onmouseenter = function () { row.style.background = "rgba(255, 255, 255, 0.06)"; };
            row.onmouseleave = function () { row.style.background = "transparent"; };

            var left = document.createElement("div");
            left.style.cssText = "display: flex; align-items: center; gap: 10px; pointer-events: none;";

            var iconBox = document.createElement("div");
            iconBox.style.cssText = "display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; color: #b5bac1;";
            iconBox.innerHTML = f.icon;

            var textCol = document.createElement("div");
            textCol.style.cssText = "display: flex; flex-direction: column;";
            textCol.innerHTML = '<span style="font-size: 13px; font-weight: 600; color: #f2f3f5; line-height: 1.2;">' + f.label + '</span><span style="font-size: 10px; color: #949ba4;">' + f.desc + '</span>';

            left.appendChild(iconBox);
            left.appendChild(textCol);

            // Toggle switch
            var track = document.createElement("div");
            track.style.cssText = "position: relative; width: 34px; height: 18px; border-radius: 9px; transition: background 0.2s ease; cursor: pointer; flex-shrink: 0;";

            var thumb = document.createElement("div");
            thumb.style.cssText = "position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #ffffff; transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 1px 3px rgba(0,0,0,0.3);";
            track.appendChild(thumb);

            function renderSwitch(val) {
                track.style.background = val ? "#23a55a" : "#4e5058";
                thumb.style.transform = val ? "translateX(16px)" : "translateX(0px)";
            }
            renderSwitch(state[f.id]);
            switchRenders[f.id] = renderSwitch;

            row.onclick = function (e) {
                e.stopPropagation();
                state[f.id] = !state[f.id];
                renderSwitch(state[f.id]);
                notifyToggle(f.id, state[f.id]);
            };

            row.appendChild(left);
            row.appendChild(track);
            itemsList.appendChild(row);
        });

        menuEl.appendChild(itemsList);

        container.appendChild(btn);
        container.appendChild(menuEl);

        // Outside click listener to collapse menu
        document.addEventListener("click", function (e) {
            if (state.open && !container.contains(e.target)) {
                setMenuOpen(false);
            }
        });

        host.appendChild(container);
    }

    createUI();

    // Listen for state synchronization messages from parent or settings
    window.addEventListener("message", function (e) {
        var d = e && e.data;
        if (!d) return;

        if (d[TAG]) {
            if (d.type === "menu_state") {
                if (typeof d.esp === "boolean") { state.esp = d.esp; if (switchRenders.esp) switchRenders.esp(d.esp); }
                if (typeof d.minimap === "boolean") { state.minimap = d.minimap; if (switchRenders.minimap) switchRenders.minimap(d.minimap); }
                if (typeof d.autoComplete === "boolean") { state.autoComplete = d.autoComplete; if (switchRenders.autoComplete) switchRenders.autoComplete(d.autoComplete); }
            } else if (d.type === "state" && typeof d.enabled === "boolean") {
                state.esp = d.enabled;
                if (switchRenders.esp) switchRenders.esp(d.enabled);
            } else if (d.type === "minimap" && typeof d.enabled === "boolean") {
                state.minimap = d.enabled;
                if (switchRenders.minimap) switchRenders.minimap(d.enabled);
            } else if (d.type === "completion" && typeof d.enabled === "boolean") {
                state.autoComplete = d.enabled;
                if (switchRenders.autoComplete) switchRenders.autoComplete(d.enabled);
            }

            // Forward down to child iframes if this is an outer container frame
            try {
                var iframes = document.querySelectorAll("iframe");
                for (var i = 0; i < iframes.length; i++) {
                    var f = iframes[i];
                    if (f && f.contentWindow && f.contentWindow !== e.source) {
                        f.contentWindow.postMessage(d, "*");
                    }
                }
            } catch (err) {}
        }
    });

    window.__adventurerMenu = {
        update: function (opts) {
            if (opts) {
                if (typeof opts.esp === "boolean") { state.esp = opts.esp; if (switchRenders.esp) switchRenders.esp(opts.esp); }
                if (typeof opts.minimap === "boolean") { state.minimap = opts.minimap; if (switchRenders.minimap) switchRenders.minimap(opts.minimap); }
                if (typeof opts.autoComplete === "boolean") { state.autoComplete = opts.autoComplete; if (switchRenders.autoComplete) switchRenders.autoComplete(opts.autoComplete); }
            }
        },
        state: function () {
            return { open: state.open, esp: state.esp, minimap: state.minimap, autoComplete: state.autoComplete };
        }
    };
})();`;
}
