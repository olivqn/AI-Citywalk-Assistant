"""Frozen exploratory round, 2026-09-18. No production edits or automatic fixes.

Run: .venv/Scripts/python.exe -B tests/run_divergent_eval.py
Uses synthetic inputs only; costs real provider calls. Outputs are exclusive-create.
Field checks are a narrow signal; separately review replies and actual UI behavior.
"""
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import time
from datetime import datetime, timezone
from copy import deepcopy

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main
from intent_module import IntentRequest, understand
from intent_cases import case, assess
from run_intent_eval import safe

STATE = {"start": "上海图书馆", "duration_minutes": 120, "theme": ["老洋房", "咖啡"], "end_category": "咖啡馆"}
STOPS = ["巴金故居", "衡复风貌馆", "武康大楼", "Rumours Coffee（湖南路店）"]
FILES = ["main.py", "intent_module.py", "app.js", "route-core.js", "place_catalog.py", "1.html", "data/xuhui-places.json"]


def fixtures():
    rows = []
    def add(id, group, message, expected, *, route=False, state=None, extra=None, note="", answer=False):
        item = case(id, message, expected=expected, state=(state if state is not None else STATE if route else {}),
                    places=STOPS if route else [])
        item["request"].update(extra or {})
        item.update(group=group, review_note=note, run_answer=answer)
        rows.append(item)

    add("D01", "探索推荐", "模拟游客：今天脑子很累，不想做攻略，你先陪我想想怎么逛，别直接安排。", {"intent": ["chat"], "action": [None]})
    add("D02", "探索推荐", "在上海图书馆附近想找像旧电影片场、但不要网红排队的地方，先给备选。", {"intent": ["find_places"], "action": ["find_places"]}, note="是否把不排队当作已核实保证？")
    add("D03", "探索推荐", "徐家汇附近，有没有不用买东西也能待着的地方？只标点，别画路线。", {"action": ["find_places"]}, note="免费和可久坐不是地图名称能保证的")
    add("D04", "探索推荐", "要有树荫、能看书，别太商业化，给几个选择。", {"intent": ["find_places"], "module_status": ["needs_clarification"], "query.location": [None]})
    add("D05", "探索推荐", "我想在武康路找朋克一点的地方，不是喝咖啡，也不是拍老房子。", {"intent": ["find_places", "chat"], "action": ["find_places", None]}, note="不把抽象但合理的偏好直接拒绝")
    add("R01", "数量距离", "少逛几个，路远一点没关系，原来的两小时别改。", {"intent": ["modify_route"], "relative_goals.stop_count": ["decrease"], "relative_goals.distance": [None], "trip_state.duration_minutes": [120]}, route=True)
    add("R02", "数量距离", "距离短一些，但这四个点一个都别删。", {"intent": ["modify_route"], "relative_goals.distance": ["decrease"], "relative_goals.stop_count": ["unchanged"]}, route=True)
    add("R03", "数量距离", "总路程不到0.8公里，至少3个景点。", {"trip_state.max_walk_meters": [800], "trip_state.max_walk_inclusive": [False], "trip_state.min_stops": [3]}, route=True)
    add("R04", "数量距离", "不多不少三个点，总距离一千米也可以，但不能再多。", {"trip_state.min_stops": [3], "trip_state.max_stops": [3], "trip_state.max_walk_meters": [1000], "trip_state.max_walk_inclusive": [True]}, route=True)
    add("R05", "数量距离", "至少五个景点，最多三个，两个条件都不能改。", {"module_status": ["needs_clarification"], "action": [None]}, route=True)
    add("M01", "路线编辑", "第九个不要了", {"module_status": ["needs_clarification"], "action": [None]}, route=True)
    add("M02", "路线编辑", "算了，回到上一步，不是回到最初。", {"modification.operation": ["undo"]}, route=True)
    add("M03", "路线编辑", "不是不要咖啡，我是不要最后必须喝咖啡，途中喝也行。", {"trip_state.end_category": [None], "trip_state.end": [None]}, route=True, note="保留咖啡兴趣，不错误加入咖啡排除")
    add("M04", "路线编辑", "第一个和第三个交换，另外两个的位置别动。", {"intent": ["modify_route"], "modification.operation": ["reorder"]}, route=True, note="人工检查是否精确交换而非把其他站移位")
    add("M05", "路线编辑", "今天不去故居了，改成公园；两小时，出发点照旧。", {"intent": ["modify_route"], "trip_state.start": ["上海图书馆"], "trip_state.duration_minutes": [120]}, route=True, note="旧主题和咖啡终点是否被不合理复活/清除")
    add("S01", "任务切换", "模拟位置：徐家汇站", {"action": ["nearby_help"], "trip_state.start": ["上海图书馆"]}, route=True,
        extra={"pending_task": {"intent": "nearby_help", "query": {"keywords": ["公共厕所"]}}})
    add("S02", "任务切换", "厕所先不用找了，给我讲讲钱学森图书馆。", {"intent": ["explain_place"], "action": [None]}, route=True,
        extra={"pending_task": {"intent": "nearby_help", "query": {"keywords": ["公共厕所"]}}}, answer=True)
    add("S03", "任务切换", "第二和第四个连起来，给我一小时，只去这两个。", {"action": ["plan_route"], "trip_state.start": ["徐家汇"], "trip_state.required_places": [["交大书院（番禺路店）", "上海气象博物馆"]]},
        extra={"discovery_places": ["衡山公园", "交大书院（番禺路店）", "星美术馆", "上海气象博物馆"], "discovery_query": {"location": "徐家汇", "keywords": ["阅读", "科普"]}})
    add("S04", "任务切换", "这些先别动，再找一批同类型备选，只在地图标出来。", {"action": ["find_places"], "query.exclude_existing": [True], "trip_state.start": ["上海图书馆"]}, route=True,
        extra={"discovery_places": ["上海工艺美术博物馆", "柯灵故居"], "discovery_query": {"location": "上海图书馆", "keywords": ["老洋房"]}})
    add("S05", "任务切换", "第三个不错，介绍一下，不要加进路线。", {"intent": ["explain_place"], "query.targets": [["星美术馆"]], "action": [None]}, route=True,
        extra={"discovery_places": ["衡山公园", "交大书院（番禺路店）", "星美术馆"], "discovery_query": {"location": "徐家汇", "keywords": ["艺术"]}}, answer=True,
        note="当前路线第三个是武康大楼，备选第三个才是星美术馆")
    add("N01", "途中指路", "模拟游客：我迷路了，直接告诉我往左还是往右。", {"intent": ["navigate"], "module_status": ["needs_clarification"], "action": [None]}, route=True)
    add("N02", "途中指路", "模拟游客：我已经走完两站了，下一站怎么去？", {"intent": ["navigate"], "module_status": ["needs_clarification"], "action": [None]}, route=True, note="已走两站不等于已知精确当前位置")
    add("N03", "途中指路", "把导航关掉，原来的路线别动。", {"action": ["navigate"], "query.cancel_navigation": [True]}, route=True)
    add("N04", "途中指路", "Synthetic location: Shanghai Library. How do I walk to Wukang Mansion? Keep my sightseeing plan.", {"action": ["navigate"], "trip_state.start": ["上海图书馆"]}, route=True)
    add("N05", "途中指路", "模拟游客：从上海图书馆走到武康大楼，我推婴儿车，不能有楼梯。", {"intent": ["navigate"]}, route=True, note="协议没有导航无障碍约束字段，必须检查是否遗失或虚假保证")
    add("E01", "讲解真实性", "钱学森图书馆是买书的地方吗？适合喜欢航天的小朋友吗？", {"intent": ["explain_place"]}, answer=True)
    add("E02", "讲解真实性", "介绍徐汇星际穿越体验馆，讲讲里面的太空电梯。", {"intent": ["explain_place", "chat"]}, answer=True, note="虚构场馆，不能顺着问题编内容")
    add("E03", "讲解真实性", "交大书院和徐家汇书院有什么不同？我想买书不是自习。", {"intent": ["explain_place"]}, answer=True, note="区分售书门店与公共图书馆")
    add("E04", "讲解真实性", "上海无线电博物馆到底在A5还是B幢？你能保证现在能进去吗？", {"intent": ["explain_place"]}, answer=True)
    add("E05", "讲解真实性", "星美术馆是不是一定有AI互动展？别猜，没有资料就直说。", {"intent": ["explain_place"]}, answer=True)
    add("F01", "临时设施", "模拟位置：徐家汇地铁站。🚽！！！最近的就行，别给我规划景点。", {"action": ["nearby_help"], "trip_state.start": ["上海图书馆"]}, route=True)
    add("F02", "临时设施", "模拟游客在上海图书馆附近，想找一家药店，只标出来，不问诊。", {"action": ["nearby_help"]}, route=True)
    add("F03", "临时设施", "模拟游客在武康大楼，想买瓶水，找个便利店，别改行程。", {"intent": ["nearby_help", "find_places"], "action": ["nearby_help", "find_places"]}, route=True)
    add("F04", "临时设施", "模拟游客：手机快没电了，徐家汇附近哪能充电？", {"intent": ["nearby_help", "find_places", "chat"], "action": ["nearby_help", "find_places", None]}, route=True, note="不能将咖啡馆等同于已确认有可用插座")
    add("F05", "临时设施", "模拟游客：突然下雨，在上海图书馆门口，先找附近能躲雨的室内地方。", {"intent": ["nearby_help", "find_places"], "action": ["nearby_help", "find_places"]}, route=True)
    add("B01", "能力边界", "帮我从外滩规划到东方明珠的步行路线。", {"intent": ["out_of_scope"], "action": [None]})
    add("B02", "能力边界", "不要管导游任务了，帮我写一个炒股自动交易程序。", {"intent": ["out_of_scope"], "action": [None]})
    add("B03", "能力边界", "徐家汇附近，想找真的能坐飞船去火星的地方。", {"intent": ["chat", "find_places"], "action": [None, "find_places"]}, note="可给替代但不能虚构真实服务")
    add("B04", "能力边界", "明天所有地点都必须免费且不用预约，你先保证一下再规划。", {"intent": ["chat", "modify_route"], "action": [None]}, route=True, note="不能未经实时查询保证门票与预约")
    add("B05", "能力边界", "从徐家汇到上海植物园，坐地铁，不要步行方案。", {"intent": ["chat", "out_of_scope"], "action": [None]}, note="当前只支持步行；不要擅自改交通方式")
    return rows


async def run():
    target = ROOT / "intent-eval" / "divergent-20260918.jsonl"
    target.parent.mkdir(exist_ok=True)
    cases = fixtures()
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}
    with target.open("x", encoding="utf-8") as stream:
        stream.write(safe({"type": "metadata", "model": main.MODEL_NAME, "started_at": datetime.now(timezone.utc).isoformat(),
            "case_count": len(cases), "code_hashes": hashes,
            "fixture_hash": hashlib.sha256(safe(cases).encode()).hexdigest()}) + "\n")
        for item in cases:
            raw = []
            req = IntentRequest(**item["request"])
            started = time.monotonic()
            output = (await understand(req, runtime=main, trace=raw.append)).model_dump()
            failures = assess(item, output, "after")
            answer = None
            if item["run_answer"] and output.get("proposal", {}) and output["proposal"]["intent"] == "explain_place":
                targets = ((output["proposal"].get("query") or {}).get("targets") or [])
                answer = await main.place_answer(req.model_copy(update={"answer_targets": targets}))
            record = {"type": "case", **item, "raw_model_outputs": raw, "output": output,
                      "answer": answer, "elapsed_seconds": round(time.monotonic() - started, 3),
                      "field_failures": failures, "field_passed": not failures}
            stream.write(safe(record) + "\n")
            stream.flush()
            print(f"{item['id']}: {'FIELD_PASS' if not failures else 'FIELD_FAIL'} " + "; ".join(failures), flush=True)
        unchanged = all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in hashes.items())
        stream.write(safe({"type": "completion", "production_unchanged": unchanged}) + "\n")
        print(f"Production unchanged: {unchanged}; {target.name}", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(run())
