"""Regenerates the *.json fixtures next to this file from the Python reference implementation.

Run from anywhere:  python dump_fixtures.py
It imports the synthetic scans of tests/test_experience_graph.py in the VencordWorkbench repo, runs the Python
analyze_scan on each, and writes {scan, expected} per fixture plus tables.json (the fire/listen tables) so
graph.test.mjs can check the JS port for parity. Not used at runtime.
"""
import importlib.util
import json
import math
import sys
from pathlib import Path

WB = Path(r"C:\Users\Serenity\PycharmProjects\VencordWorkbench")
OUT = Path(__file__).resolve().parent
sys.path.insert(0, str(WB))
spec = importlib.util.spec_from_file_location("wb_graph_tests", WB / "tests" / "test_experience_graph.py")
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)
from workbench import experience_graph as g  # noqa: E402


def clean(v):
    """JSON-safe copy: NaN/inf become null (the in-page scan does the same)."""
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    return v


def scene_with(entities, scene="s", listeners=None):
    scan = {"ok": True, "scene": scene, "entities": entities, "truncated": {}}
    if listeners is not None:
        scan["listeners"] = listeners
    return scan


def fixtures() -> dict:
    ent, quest = t.ent, t.quest
    out = {}
    out["holocube"] = t.holocube_scene()

    s = t.holocube_scene()
    s["entities"][0] = quest(progress=())
    out["holocube_no_progress"] = s

    s = t.holocube_scene()
    s["entities"] = [e for e in s["entities"] if e["name"] != "Finish Relay"]
    out["holocube_no_relay"] = s

    gate = ent("Gate", "g", ("mysteryGate", {"unlockOn": "button:pressed", "openedEvent": "gate:open", "label": "a:b c"}))
    out["generic_registry"] = {"ok": True, "scene": "x", "entities": [quest(), gate], "truncated": {},
                               "listeners": {"button:pressed": [{"guid": "g", "script": "mysteryGate",
                                                                 "scopeKind": "entity", "target": "app"}]}}

    gate2 = ent("Gate", "g", ("mysteryGate", {"onOpen": "gate:open", "url": "https://x.example/a", "plain": "hello"}))
    out["generic_no_registry"] = {"ok": True, "entities": [gate2]}

    a = ent("A", "ga", ("countEvents", {"eventToCount": "tick", "eventScope": "entity",
                                        "counts": [{"targetCount": 2, "eventToFireOnCountMet": "done"}]}))
    b = ent("B", "gb", ("countEvents", {"eventToCount": "tick", "eventScope": "entity",
                                        "counts": [{"targetCount": 2, "eventToFireOnCountMet": "done"}]}))
    q = ent("Q", "q", ("discordQuestManager", {"questCompleteEvent": "done"}))
    out["entity_scope_separate"] = {"ok": True, "entities": [a, b, q]}

    combo = ent("Counter", "gc",
                ("countEvents", {"eventToCount": "hit", "eventScope": "entity",
                                 "counts": [{"targetCount": 2, "eventToFireOnCountMet": "full"}]}),
                ("eventRelay", {"triggerEvents": ["full"], "eventScope": "entity", "useAlternativeScope": True,
                                "triggerScope": "entity", "sendScope": "app",
                                "eventsToSend": [{"eventToSend": "quest:complete"}]}))
    out["entity_scoped_chain"] = {"ok": True, "scene": "s", "entities": [combo, quest(progress=())]}

    counter = ent("C", "c", ("countEvents", {"eventToCount": "ping", "counts": [{"targetCount": 3, "eventToFireOnCountMet": "mid"}]}))
    second = ent("D", "d", ("countEvents", {"eventToCount": "mid", "counts": [{"targetCount": 2, "eventToFireOnCountMet": "quest:complete"}]}))
    out["counts_multiply"] = {"ok": True, "entities": [quest(progress=()), counter, second]}

    seq = ent("Seq", "s", ("checkEventSequence", {"sequence": ["a:1", "b:2", "a:1"], "eventToEmitOnCorrect": "seq:ok",
                                                    "progressEvents": ["", "seq:half"]}))
    pat = ent("Pat", "p", ("checkEventPattern", {"onEvents": ["x:1", "y:1", "z:1"], "requiredEvents": ["x:1", "z:1"],
                                                   "confirmEvent": "pat:go", "eventToEmitOnCorrect": "pat:ok"}))
    fin = ent("Fin", "f", ("eventFlagChecker", {"allTrueEvent": "quest:complete", "events": [
        {"flagName": "seq", "flag": False, "setTrueEvent": "seq:ok"}, {"flagName": "pat", "flag": False, "setTrueEvent": "pat:ok"}]}))
    out["sequence_pattern_flags"] = {"ok": True, "entities": [quest(progress=()), seq, pat, fin]}

    keypad = ent("Keypad", "k", ("keypad", {"submitCodeEvent": "code:submit", "keyEnterEvent": "key:enter"}), tags=["interactable"])
    check = ent("Lock", "l", ("checkCodeOnEvent", {"correctCode": "4821", "eventToCheckOn": "code:submit",
                                                    "eventToEmitOnCorrect": "quest:complete", "eventToEmitOnIncorrect": "code:bad"}))
    out["code_arguments"] = {"ok": True, "entities": [quest(progress=()), keypad, check]}

    door = ent("Door", "d", ("door", {"isLocked": True, "onUnlockEvent": "door:unlock", "doorOpenedEvent": "quest:complete"}))
    unlock = ent("Switch", "s", ("pushButton", {"hasPower": False, "onPowerEvent": "power:on", "onPushEvent": "door:unlock"}))
    out["door_power"] = {"ok": True, "entities": [quest(progress=()), door, unlock]}

    out["goal_external"] = {"ok": True, "scene": "s", "entities": [quest(progress=())]}

    ca = ent("A", "a", ("eventRelay", {"triggerEvents": ["x:b"], "eventsToSend": [{"eventToSend": "x:a"}]}))
    cb = ent("B", "b", ("eventRelay", {"triggerEvents": ["x:a"], "eventsToSend": [{"eventToSend": "x:b"}, {"eventToSend": "quest:complete"}]}))
    out["cycles"] = {"ok": True, "entities": [quest(progress=()), ca, cb]}

    out["aim_no_quest_manager"] = t.aim_scene()

    # odd attribute values (the entity-level garbage of the Python test cannot exist in a real scene)
    out["malformed_attrs"] = {"ok": True, "entities": [
        ent("X", "x", ("countEvents", {"eventToCount": 5, "counts": "no"})),
        ent("Y", "y", ("countEvents", {"eventToCount": "a:b", "counts": [None, {"targetCount": "3", "eventToFireOnCountMet": 7},
                                                                         {"targetCount": float("nan"), "eventToFireOnCountMet": "c:d"}]})),
        ent("Z", "z", ("discordQuestManager", {"progressEvents": [None, {"event": "p:1", "progress": "one"}, {"event": 4}],
                                               "questCompleteEvent": None}))]}

    # extra coverage of the table scripts that no Python test exercises
    gate_chain = [
        quest(progress=((1, "q:1"),)),
        ent("Btn", "b1", ("pushButton", {"hasPower": True, "onPowerEvent": "pwr", "onPushEvent": "pushed"}), tags=["interactable"]),
        ent("Gen", "g1", ("pushButton", {"hasPower": False, "onPushEvent": "pwr"}), tags=["interactable"]),
        ent("Rel", "r1", ("eventRelay", {"triggerEvents": ["pushed, other"], "eventsToSend": [{"eventToSend": "q:1"}]})),
        ent("Slide", "s1", ("slider", {"controlEnabled": False, "enabledEvent": "slide:on", "movedEvent": "q:complete2"}),
            tags=["interactable"]),
        ent("Mixer", "m1", ("checkMultipleFlags", {"eventScope": "pre", "checkOnEvent": "go", "eventToFireOnCheckPassed": "ok",
                                                  "eventToFireOnCheckFailed": "no"})),
        ent("Tween", "t1", ("positionTween", {"tweens": [{"startTweenEvent": "pushed", "onCompleteEvent": "tw:done",
                                                           "eventScope": "entity"}]})),
        ent("Dial", "d1", ("snappingDial", {"snapAngles": [{"eventToFireAtAngle": "dial:90"}]}), tags=["interactable", "blocker"]),
    ]
    out["table_extras"] = {"ok": True, "scene": "extras", "entities": gate_chain, "truncated": {}}

    # focus item that can be taken, a useItem with a validItems list, and an unknown script with the interactable tag
    focus = [
        quest(progress=()),
        ent("Key", "k1", ("focusItem", {"core": {"itemId": "brassKey"}, "events": {"onFocusedEvent": "key:focused"}}),
            ("focusItemTakeable", {"takeEvent": "key:taken"})),
        ent("Lock", "l1", ("useItem", {"itemId": "", "validItems": [{"itemId": "brassKey", "eventOnCorrectItemUsed": "quest:complete"},
                                                                  {"itemId": "ghost", "eventOnCorrectItemUsed": "ghost:used"}]}),
            tags=["interactable"]),
        ent("Thing", "t1", ("mysteryThing", {"clickEvent": "thing:clicked"}), tags=["interactable"]),
    ]
    out["focus_items_valid_items"] = {"ok": True, "scene": "focus", "entities": focus, "truncated": {}}
    return out


def label(e) -> str:
    return e.label


def dump(an) -> dict:
    events = {}
    for k, e in an.events.items():
        events[k] = {"key": e.key, "name": e.name, "scope": e.scope, "entity": e.entity, "guid": e.guid,
                     "firedBy": [list(x) for x in e.fired_by], "listenedBy": [list(x) for x in e.listened_by],
                     "isGoal": e.is_goal, "isProgress": e.is_progress, "progress": e.progress,
                     "inGoalClosure": e.in_goal_closure, "depth": e.depth, "count": e.count, "origin": e.origin,
                     "args": list(e.args)}
    edges = [{"entity": e.entity, "guid": e.guid, "script": e.script, "outKey": e.out_key, "outAttr": e.out_attr,
              "needs": [{"key": n.key, "attr": n.attr, "count": n.count, "args": n.args} for n in e.needs]}
             for e in an.edges]
    inter = [{"entity": i.entity, "guid": i.guid, "tags": i.tags, "scripts": i.scripts, "fires": i.fires,
              "inClosure": i.in_closure} for i in an.interactables]
    objective = [i for i in an.interactables if i.in_closure]
    return {"ok": an.ok, "hasQuestManager": an.has_quest_manager, "scene": an.scene,
            "goalEvents": an.goal_events, "progressEvents": an.progress_events, "rootKeys": an.root_keys,
            "eventOrder": list(an.events), "events": events, "edges": edges, "interactables": inter,
            "closureKeys": [k for k, e in an.events.items() if e.in_goal_closure],
            "closureOrder": [e.key for e in an.closure_events()],
            "objectiveNames": [i.entity for i in objective], "objectiveGuids": [i.guid for i in objective if i.guid],
            "entityCount": an.entity_count}


def tables() -> dict:
    return {"SCRIPT_EVENTS": g.SCRIPT_EVENTS, "LEAF_SCRIPTS": sorted(g.LEAF_SCRIPTS), "LEAF_LISTEN": sorted(g.LEAF_LISTEN),
            "LEAF_FIRE": sorted(g.LEAF_FIRE), "INTERACTABLE_SCRIPTS": sorted(g.INTERACTABLE_SCRIPTS),
            "QUEST_SCRIPT": g.QUEST_SCRIPT, "MAX_COUNT": g.MAX_COUNT}


def main() -> None:
    for name, scan in fixtures().items():
        scan = clean(scan)
        an = g.analyze_scan(scan)
        (OUT / f"{name}.json").write_text(json.dumps({"name": name, "scan": scan, "expected": dump(an)}, indent=1),
                                          encoding="utf-8")
        print(name, "ok" if an.has_quest_manager else "no-quest", len(an.events), "events")
    (OUT / "tables.json").write_text(json.dumps(tables(), indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
