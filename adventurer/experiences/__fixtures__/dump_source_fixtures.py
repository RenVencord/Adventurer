"""Regenerates the fixtures in the source/ folder next to this file from the Python reference implementation.

Run from anywhere:  python dump_source_fixtures.py
Read-only on the VencordWorkbench repo (nothing is written there, bytecode is disabled, the node harness only prints).
Two kinds of fixture:

  source/analysis_<case>.json   {name, scan, knowledge, expected}: a scan with script facts (the real VALORANT Aces scan and
                                the synthetic scans of tests/test_experience_source.py) and what
                                workbench/experience_source.py makes of it (chain, hops, guards, owners, entries, recipe).
  source/extraction_<case>.json {name, spec, scan}: a fake PlayCanvas game (the spec format of
                                tests/fixtures/run_scan_js.js) and the scan workbench/js/experience_scan.js returns for it,
                                so the in-page extraction can be compared fact by fact.

graph.test.mjs only reads the *.json files directly inside __fixtures__, so these live in a sub folder.
"""
import copy
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
WB = Path(r"C:\Users\Serenity\PycharmProjects\VencordWorkbench")
OUT = Path(__file__).resolve().parent / "source"
sys.path.insert(0, str(WB))
sys.path.insert(0, str(WB / "tests"))


def load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, WB / "tests" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


t = load("wb_source_tests", "test_experience_source.py")
tj = load("wb_scan_js_tests", "test_experience_scan_js.py")
from workbench.experience_knowledge import Knowledge  # noqa: E402
from workbench.experience_source import analyze_source  # noqa: E402

GOAL = t.GOAL


# ---------------------------------------------------------------------------
# the Python result in the shape of the in-page summary (graph.ts, state().source)
# ---------------------------------------------------------------------------
def dump(a) -> dict:
    return {
        "available": a.available, "found": a.found, "scriptTypes": a.script_types, "listeners": a.listeners,
        "unattributed": a.unattributed, "goal": a.goal,
        "goals": [{"key": k, "strength": s, "learned": bool(learned)} for k, s, learned in a.goals],
        "unreachedGoals": list(a.unreached_goals),
        "events": [{"key": e.key, "name": e.name, "scope": e.scope, "entity": e.entity, "depth": e.depth, "root": e.root}
                   for e in a.events.values()],
        "hops": [{"src": h.src, "dst": h.dst, "how": h.how, "ambiguous": h.ambiguous, "approximate": h.approximate,
                  "path": h.path_text(),
                  "steps": [{"script": s.script, "entity": s.entity, "method": s.method, "inst": s.inst, "how": s.how,
                             "approximate": s.approximate} for s in h.steps]} for h in a.hops],
        # the order of owners that tie on (fires the goal, script) depends on set iteration in Python: fully sorted here
        "owners": [{"script": s, "entity": e, "why": w} for s, e, w in sorted(a.owners, key=lambda o: (not o[2], o[0], o[1]))],
        "guards": [{"state": g.state, "foreign": g.foreign, "readers": list(g.readers), "text": g.text,
                    "writers": [{"method": w["method"], "events": list(w["events"]), "via": w["via"], "onPath": w["on_path"]}
                                for w in g.writers]} for g in a.guards],
        "entries": [{"name": i.name, "depth": i.depth, "approximate": i.approximate, "guardOk": i.guard_ok,
                     "fields": dict(i.fields), "note": i.note} for i in a.entry_info],
        "preferred": a.preferred, "triggerNotes": list(a.trigger_notes), "notes": list(a.notes),
    }


# ---------------------------------------------------------------------------
# analysis cases (the scans of tests/test_experience_source.py)
# ---------------------------------------------------------------------------
def analysis_cases() -> dict:
    c: dict = {}
    k_none = None

    c["valorant"] = (t.valorant(), k_none)
    s = t.valorant()
    s["listeners"] = {}
    c["valorant_no_listeners"] = (s, k_none)
    s = t.valorant()
    s["truncated"] = {"scripts": True}
    c["valorant_truncated"] = (s, k_none)

    c["mini_game"] = (t.mini_game(), k_none)
    listeners = {
        "round:win": [{"guid": "q", "script": "quest", "scopeKind": "entity", "target": "app", "method": "_onWin", "via": "proto"}],
        "round:end": [{"guid": "r", "script": "rounds", "scopeKind": "app", "target": "app", "paths": ["_wires[0][1]"]}],
        "engine:update": [{"guid": None, "script": None, "scopeKind": "app", "target": "app"}],
    }
    c["mini_game_listeners"] = (t.mini_game(listeners), k_none)
    s = t.mini_game()
    s["entities"][1]["scripts"][0]["attrs"]["winEvent"] = "round:won"
    c["mini_game_other_attr"] = (s, k_none)
    s = t.mini_game()
    s["entities"].append(t.ent("Rounds B", "r2", ("rounds", {"doneEvent": "bonus:end", "winEvent": "round:win"})))
    c["two_instances"] = (s, k_none)
    s = t.mini_game()
    s["entities"][2]["scripts"][0]["enabled"] = False
    c["disabled_script"] = (s, k_none)
    s = t.mini_game()
    s["entities"][2]["enabled"] = False
    c["disabled_entity"] = (s, k_none)

    s = t.mini_game({"round:end": [{"guid": "r", "script": "rounds", "scopeKind": "app", "target": "app", "paths": ["_h"]}]})
    s["scripts"]["rounds"]["m"]["initialize"]["o"].append(["@doneEvent", "_onOther", "a"])
    s["scripts"]["rounds"]["m"]["_onOther"] = {"c": ["_score"]}
    s["scripts"]["rounds"]["names"].append("_onOther")
    c["ambiguous_handler"] = (s, k_none)

    c["bound_copy"] = (t.scan_of([t.ent("Q", "q", ("quest", {"recordEvent": "run:recorded"}))],
                                 {"quest": t.script({"initialize": {"o": [["@recordEvent", "_handler", "a"]]}, "_onRun": {"f": [GOAL]}},
                                                    binds={"_handler": "_onRun"})}), k_none)
    c["inline_handlers"] = (t.scan_of([t.ent("Q", "q", ("quest", {}))],
                                      {"quest": t.script({"initialize": {"o": [["a:b", "initialize#1", "a"]]}, "initialize#1": {"f": [GOAL]}})}), k_none)
    c["entity_scoped"] = (t.scan_of([t.ent("Pad", "p", ("pad", {}), ("door", {}))],
                                    {"pad": t.script({"_press": {"fe": ["pad:pressed"]}, "initialize": {"o": [["pad:go", "_press", "a"]]}}),
                                     "door": t.script({"initialize": {"o": [["pad:pressed", "_open", "e"]]}, "_open": {"f": [GOAL]}})}), k_none)
    c["thin_wrapper"] = (t.scan_of([t.ent("G", "g", ("gate", {}))], {"gate": t.script({
        "initialize": {"o": [["gate:run", "_onGo", "a"], ["gate:keep", "_onSave", "a"]], "r": ["_onGo", "_onSave", "_store"]},
        "_onGo": {"w": 1}, "_onSave": {"c": ["_store"]}, "_store": {"w": 1},
        "_fireDone": {"f": [GOAL]}, "_fireOther": {"f": ["gate:other"]}})}), k_none)

    ticker = t.scan_of([t.ent("T", "t", ("ticker", {}), ("quest", {}))], {
        "ticker": t.script({"update": {"c": ["_tick"]}, "_tick": {"f": ["tick:x"]}}),
        "quest": t.script({"initialize": {"o": [["tick:x", "_onTick", "a"], ["menu:play", "_onPlay", "a"]], "r": ["_onTick", "_onPlay"]},
                           "_onTick": {"f": [GOAL]}, "_onPlay": {"f": ["tick:x"]}})})
    c["loop_with_handler"] = (copy.deepcopy(ticker), k_none)
    del ticker["scripts"]["quest"]["m"]["_onPlay"]
    ticker["scripts"]["quest"]["m"]["initialize"]["o"].pop()
    c["loop_only"] = (ticker, k_none)

    s = t.mini_game()
    s["scripts"]["quest"]["m"]["_onWin"]["pr"] = {"levelId": "s"}
    s["scripts"]["rounds"]["m"]["_score"]["pf"] = ["@winEvent"]
    c["payload_forward"] = (s, k_none)

    names = ["menu:play", "menu:playAgain", "player:fire", "player:fireTimeout", "ui:restart", "stream:ended", "shot:fire"]
    c["trigger_heuristic"] = (t.scan_of([t.ent("In", "i", ("input", {})), t.ent("Q", "q", ("quest", {}))], {
        "input": t.script({"initialize": {"o": [[n, f"_h{i}", "a"] for i, n in enumerate(names)]}, **{f"_h{i}": {} for i in range(len(names))}}),
        "quest": t.script({"initialize": {"o": [["shot:fire", "_onFire", "a"]]}, "_onFire": {"f": [GOAL]}})}), k_none)
    c["goal_nothing_fires"] = (t.scan_of([t.ent("Q", "q", ("quest", {}))],
                                         {"quest": t.script({"initialize": {"o": [[GOAL, "_onGoal", "a"]]}, "_onGoal": {}})}), k_none)
    c["leaderboard"] = (t.scan_of([t.ent("Q", "q", ("quest", {}))], {"quest": t.script({
        "initialize": {"o": [["quest:leaderboard:complete", "_a", "a"], ["leaderboard:submit", "_b", "a"],
                             ["round:win", "_onWin", "a"], ["leaderboard:play", "_c", "a"]]},
        "_a": {"f": ["quest:leaderboard:complete"]}, "_b": {}, "_c": {},
        "_onWin": {"f": [GOAL, "leaderboard:submit"]}})}), k_none)

    learned = t.scan_of([t.ent("Q", "q", ("quest", {}))], {"quest": t.script({
        "initialize": {"o": [["round:win", "_onWin", "a"]]}, "_onWin": {"f": ["bonus:unlocked"]}})})
    c["unlearned_goal"] = (copy.deepcopy(learned), k_none)
    c["learned_goal"] = (learned, Knowledge(goal_names={"bonus:unlocked"}))
    c["strongest_goal"] = (t.scan_of([t.ent("Q", "q", ("quest", {}))], {"quest": t.script({
        "initialize": {"o": [["a:one", "_one", "a"], ["a:two", "_two", "a"], ["a:three", "_three", "a"]]},
        "_one": {"f": ["quest:complete"]}, "_two": {"f": ["a:one"]}, "_three": {"f": ["arise:questComplete"]}})}), k_none)
    c["optional_events"] = (t.mini_game(), Knowledge(optional_events={"round:win", "menu:play"}))

    c["guarded"] = (t.guarded_game(), k_none)
    c["unguarded"] = (t.guarded_game(with_guard=False), k_none)
    s = t.guarded_game()
    s["scripts"]["rewards"]["m"]["_onSaved"]["sw"] = ["_done"]
    c["guard_writer_on_path"] = (s, k_none)

    from test_experience_graph import holocube_scene
    s = holocube_scene()
    s["scripts"] = {"collectable": t.script({"initialize": {"o": [["x:y", "_h", "a"]]}, "_h": {"f": ["z:w"]}})}
    c["quest_manager_with_facts"] = (s, k_none)
    c["mini_game_no_matching_script"] = (t.scan_of([t.ent("Q", "q", ("quest", {}))],
                                                   {"quest": t.script({"initialize": {"o": [["a:b", "_h", "a"]]}, "_h": {}})}), k_none)
    return c


def knowledge_json(k) -> dict | None:
    if k is None:
        return None
    return {"goalNames": sorted(k.goal_names), "optionalEvents": sorted(k.optional_events)}


# ---------------------------------------------------------------------------
# extraction cases: fake games run through workbench/js/experience_scan.js
# ---------------------------------------------------------------------------
GIZMO = {
    "initialize": "function(){var self=this,a=self.app;a.on('g:one',self._a,self);self.app.once('g:two',function(e){self._b(e.id)},self);"
                  "this.entity.on('g:ent',this._c,this);this._pairs=[['g:pair',this._d],['g:pair2',function(x){self._e(x)}]];"
                  "this.app.fire('g:boot');var tpl=`${1} this.app.fire('in:tpl') ${self.x}`,rx=/\\/\\*|[\\]]\\/fire/;"
                  "this.app.on(this.dynamicEvent,this._a);this.app.on(someName,this._b);"
                  "this._ownFn=function(q){self.app.fire('own:fired',q)};this.app.on('own:ev',this._ownFn)}",
    "_a": "function(p){if(!this.ready)return;this._b(p);this._d.call(this,p)}",
    "_b": "function(e){this.count=(this.count||0)+1;this.log.push(e.id);this.app.fire(this.doneEvent,e.id,e);this.entity.fire('g:local',e)}",
    "_c": "function(){return this._b.apply(this,arguments)}",
    "_d": "function(m){var n=Number(m.score),s=String(m.name||''),k='number'==typeof m.rank?m.rank:0;return !!m.flag&&m.list.length>0&&m.bag||{}}",
    "_e": "function(x){this.state.deep.x=3;this.map.set('k',1);this.flags={a:1,b:2,'c-d':3};this.items.splice(0,1);this.n++;this._h(x)}",
    "_f": "function(){var t=this._other();return t&&t.count>0&&t.data.list[0].x&&t.go(1)}",
    "_other": "function(){return this.entity.script.other}",
    "_g": "function(){this.entity.script.other.go();return this.entity.script.other.data.rows[2].v}",
    "_h": "function(t){return [1].map(function(t){return t.x}).length+t.y}",
    "_w": "function(){return n.apply(this,arguments)}",
    "_mix": "function(){this.k=1;return n.call(this)}",
    "_bind": "function(){this._bound={ev:this._a.bind(this)};this._alias=this._b.bind(this);this._deep=[this._a.bind(this)]}",
    "update": "function(dt){this.t+=dt;this._tick()}",
    "_tick": "function(){this.app.fire('g:tick')}",
    "_comments": "function(){/* this.app.fire('c:block') */ // this.app.fire('c:line')\n return this.a/2+this.b/3}",
    "_arrow": "function(){var u=this.app;u.on('arrow:ev',(z)=>{this._b(z)});this.items.forEach(i=>this._h(i))}",
    "_big": "function(){this.queue.unshift(1);this.cache.delete('x');this.total+=2;this.n--;this.o.p.q=1;this.w['k'].v=2}",
}
OTHER = {
    "go": "function(n){this.last=n;this.app.fire('o:go',n)}",
    "ping": "function(){this.entity.script.gizmo._b(1);this.entity.script.gizmo.count}",
}


def patterns_spec() -> dict:
    return {
        "scene": "Patterns",
        "scripts": {"gizmo": {"methods": GIZMO}, "other": {"methods": OTHER}},
        "entities": [
            {"name": "G", "guid": "g1", "scripts": [
                {"name": "gizmo", "attrs": {"doneEvent": "g:done", "dynamicEvent": "dyn"},
                 "own": {"_boundA": "_a", "stray": "_h"}, "ownFns": {"_ownFn": "function(){}"},
                 "ownArrays": {"_pairs": [["g:pair", "_d"]]}},
                {"name": "other", "attrs": {}}]}],
        "listeners": [
            {"event": "g:one", "scope": {"entity": "G", "script": "gizmo"}, "handler": {"proto": "_a"}},
            {"event": "g:pair", "scope": "app", "holder": {"entity": "G", "script": "gizmo"}, "handler": {"path": "_pairs.0.1"}},
            {"event": "g:bound", "scope": "app", "holder": {"entity": "G", "script": "gizmo"}, "handler": {"own": "_boundA"}},
            {"event": "g:stray", "scope": "app", "holder": {"entity": "G", "script": "gizmo"}, "handler": {"own": "stray"}},
            {"event": "own:ev", "scope": "app", "holder": {"entity": "G", "script": "gizmo"}, "handler": {"own": "_ownFn"}},
            {"event": "engine:tick", "scope": "app", "handler": {"native": True}},
        ],
    }


def run_extraction(spec: dict) -> dict:
    node = shutil.which("node")
    if node is None:
        raise SystemExit("node not found")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "spec.json"
        path.write_text(json.dumps(spec), encoding="utf-8")
        out = subprocess.run([node, str(WB / "tests" / "fixtures" / "run_scan_js.js"), str(path)], capture_output=True,
                             text=True, encoding="utf-8", timeout=60, check=True)
    reply = json.loads(out.stdout)
    assert reply["called"] == 0, "the reference scan called a script method"
    return reply["scan"]


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()
    for name, (scan, knowledge) in analysis_cases().items():
        a = analyze_source(copy.deepcopy(scan), knowledge)
        doc = {"name": name, "scan": scan, "knowledge": knowledge_json(knowledge),
               "expected": {"source": dump(a), "recipe": a.recipe if a.found else None}}
        (OUT / f"analysis_{name}.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
        print("analysis", name, "found" if a.found else "-", len(a.hops), "hops")
    for name, spec in (("fake_game", tj.fake_game()), ("patterns", patterns_spec())):
        scan = run_extraction(spec)
        (OUT / f"extraction_{name}.json").write_text(json.dumps({"name": name, "spec": spec, "scan": scan}, indent=1), encoding="utf-8")
        print("extraction", name, len(scan["scripts"]), "script types", sum(len(v["m"]) for v in scan["scripts"].values()), "methods")


if __name__ == "__main__":
    main()
