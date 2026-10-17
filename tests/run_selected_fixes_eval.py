"""Real-model regressions for the two selected fixes; synthetic public places only.

Run: .venv/Scripts/python.exe -B tests/run_selected_fixes_eval.py
Logs are exclusive-create, local only. No map or browser calls.
"""
import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main
from intent_module import IntentRequest, understand
from run_divergent_eval import fixtures
from run_intent_eval import safe


def cases():
    original = {row["id"]: row for row in fixtures()}
    rows = []
    for key in ("B04", "M04"):
        for i in range(3):
            rows.append({"id": f"{key}-{i+1}", "kind": key,
                         "request": deepcopy(original[key]["request"])})
    base = deepcopy(original["M04"]["request"])
    for key, kind, message in [
        ("SWAP24", "swap24", "第二个和第四个对调，第一和第三的位置不变。"),
        ("PREFIX", "prefix", "先去第三站，再去第一站，剩下的站接在后面，不要删。"),
    ]:
        rows.append({"id": key, "kind": kind, "request": {**deepcopy(base), "message": message}})
    rows.append({"id": "KNOWN", "kind": "known", "request": {
        "message": "就按刚才的出发点，安排一小时看老洋房。",
        "trip_state": {"start": "上海图书馆"}}})
    rows.append({"id": "MISSING", "kind": "missing", "request": {
        "message": "给我规划一小时的老洋房步行路线。"}})
    rows.append({"id": "LIVE_LOCATION", "kind": "location", "request": {
        **deepcopy(base), "message": "模拟游客：我在线路上，急着找厕所！"}})
    return rows


def check(item, output):
    failures = []
    def expect(condition, message):
        if not condition:
            failures.append(message)
    proposal = output.get("proposal") or {}
    expect(output["status"] != "unavailable", "模型未返回可用结果")
    kind = item["kind"]
    replay = None
    if kind in {"M04", "swap24", "prefix"}:
        stops = item["request"]["current_route"]["places"]
        order = {"M04": [2, 1, 0, 3], "swap24": [0, 3, 2, 1], "prefix": [2, 0, 1, 3]}[kind]
        expected = [stops[i] for i in order]
        modification = proposal.get("modification") or {}
        expect(output.get("action") == "modify_route", "未进入路线修改")
        expect(modification.get("operation") == "reorder", "未输出调序")
        if kind != "prefix":
            expect(modification.get("places") == expected, "未输出精确完整交换顺序")
        payload = {"route": [{"name": "上海图书馆", "isStart": True}] + [{"name": name} for name in stops],
                   "places": modification.get("places", [])}
        code = "const fs=require('fs'),c=require('./route-core.js'),p=JSON.parse(fs.readFileSync(0,'utf8')); console.log(JSON.stringify(c.orderStops(p.route,p.places).map(x=>x.name)));"
        run = subprocess.run(["node", "-e", code], input=json.dumps(payload, ensure_ascii=False),
                             capture_output=True, text=True, encoding="utf-8", cwd=ROOT, timeout=15)
        replay = json.loads(run.stdout) if run.returncode == 0 else {"error": run.stderr}
        expect(replay == ["上海图书馆"] + expected, "现有执行器调序结果不符合要求")
        expect(output["trip_state"]["start"] == "上海图书馆", "原起点被改动")
    elif kind == "B04":
        expect(output["trip_state"]["start"] == "上海图书馆", "已知起点丢失")
        expect(output.get("action") is None, "未确认能接受待核实就开始规划")
        expect(not proposal.get("clear_fields"), "不应清空原条件")
        # Reply/clarification are manually reviewed; no production language rules.
    elif kind == "known":
        expect(output.get("action") == "plan_route", "已知起点仍未进入规划")
        expect(output["trip_state"]["start"] == "上海图书馆", "未承接已知起点")
        expect(output["trip_state"]["duration_minutes"] == 60, "时长丢失")
    elif kind == "missing":
        expect(output["status"] == "needs_clarification" and output.get("action") is None,
               "真实缺起点时应澄清")
        expect(output["trip_state"]["start"] is None, "编造了起点")
    elif kind == "location":
        expect(proposal.get("intent") == "nearby_help", "设施任务串成路线任务")
        expect(output["status"] == "needs_clarification" and output.get("action") is None,
               "未知实时位置时应澄清")
        expect(not (proposal.get("query") or {}).get("location"), "把原起点当成当前位置")
    return failures, replay


async def run():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target = ROOT / "intent-eval" / f"selected-fixes-{stamp}.jsonl"
    target.parent.mkdir(exist_ok=True)
    suite = cases()
    count = 0
    with target.open("x", encoding="utf-8") as stream:
        stream.write(safe({"type": "metadata", "model": main.MODEL_NAME, "case_count": len(suite),
            "intent_module_sha256": hashlib.sha256((ROOT / "intent_module.py").read_bytes()).hexdigest()}) + "\n")
        for item in suite:
            raw = []
            output = (await understand(IntentRequest(**item["request"]), runtime=main, trace=raw.append)).model_dump()
            failures, replay = check(item, output)
            count += not failures
            stream.write(safe({**item, "type": "case", "raw_model_outputs": raw, "output": output,
                               "executor_replay": replay, "failures": failures}) + "\n")
            stream.flush()
            proposal = output.get("proposal") or {}
            print(safe({"id": item["id"], "failures": failures, "reply": proposal.get("reply"),
                        "clarification": proposal.get("clarification"), "executor_replay": replay}), flush=True)
    print(f"Structural/replay checks: {count}/{len(suite)}. Manually inspect clarification wording.\n{target}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(run())
