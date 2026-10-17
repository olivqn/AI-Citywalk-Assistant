"""Frozen synthetic module cases. Never depend on live map or prior model output."""
from copy import deepcopy


OLD_STOPS = ["罗密欧阳台", "淮海中路1768弄优秀历史建筑", "安福路"]
BASE = {"start": "上海图书馆", "duration_minutes": 120, "theme": ["老洋房"]}


def request(message, state=None, places=None, distance=2100, history=None):
    places = list(places or [])
    return {"message": message, "trip_state": deepcopy(state or {}), "history": deepcopy(history or []),
            "current_route": {"places": places, "stop_count": len(places),
                              "total_distance_meters": distance if places else None,
                              "can_undo": bool(places), "can_restore_initial": bool(places)}}


def case(id, message, *, state=None, places=None, expected=None, contains=None, history=None):
    return {"id": id, "request": request(message, state, places, history=history),
            "expected": expected or {}, "contains": contains or {}}


# Each contains entry is a group of accepted equivalent spellings, not production inference.
CASES = [
    case("A1", "我第一次来上海，今天想随便逛逛，不知道去哪。",
         expected={"intent": ["chat"], "action": [None], "trip_state.start": [None]}),
    case("A2", "从上海图书馆出发，我只有20分钟，步行不要超过1公里，带两位长辈，想看老洋房，不要餐厅和咖啡店。",
         expected={"intent": ["plan_route"], "trip_state.start": ["上海图书馆"], "trip_state.duration_minutes": [20],
                   "trip_state.max_walk_meters": [1000], "trip_state.max_walk_inclusive": [True]},
         contains={"trip_state.theme": [["老洋房"]], "trip_state.excluded_places": [["餐厅"], ["咖啡店", "咖啡馆", "咖啡"]]}),
    case("A3", "我不是说了不超过1公里吗？请压缩到500米以内，20分钟不变。",
         state={**BASE, "duration_minutes": 20, "max_walk_meters": 1000, "max_walk_inclusive": True,
                "excluded_places": ["餐厅", "咖啡店"]}, places=OLD_STOPS[:1],
         expected={"intent": ["modify_route"], "trip_state.max_walk_meters": [500],
                   "trip_state.max_walk_inclusive": [True], "trip_state.duration_minutes": [20]},
         contains={"trip_state.excluded_places": [["餐厅"], ["咖啡店", "咖啡馆"]]}),
    case("A4", "罗密欧阳台有什么故事？为什么选它？现在能进去参观吗？", state=BASE, places=OLD_STOPS,
         expected={"intent": ["explain_place"], "action": [None], "trip_state.start": ["上海图书馆"]}),
    case("B1", "我在徐家汇，想走一条有科幻感、像未来城市的路线，1小时。",
         expected={"intent": ["plan_route"], "theme_status": ["abstract_valid"],
                   "trip_state.start": ["徐家汇"], "trip_state.duration_minutes": [60]}),
    case("B2", "你说去美罗城和港汇，可地图里没有。只保留美罗城和港汇恒隆广场，不要上海体育场和天桥。",
         state={"start": "徐家汇", "duration_minutes": 60, "theme": ["科幻感"]}, places=["上海体育场", "光景天桥"],
         expected={"intent": ["modify_route"], "modification.operation": ["set_stops"],
                   "modification.places": [["美罗城", "港汇恒隆广场"]]},
         contains={"trip_state.excluded_places": [["上海体育场"], ["天桥", "光景天桥"]]}),
    case("B3", "先不旅游了，帮我写一个Python网页爬虫。", state=BASE, places=OLD_STOPS,
         expected={"intent": ["out_of_scope"], "action": [None]}),
    case("C1", "从上海图书馆出发，两小时看老洋房，最后必须到武康大楼结束。",
         expected={"intent": ["plan_route"], "trip_state.start": ["上海图书馆"],
                   "trip_state.duration_minutes": [120], "trip_state.end": ["武康大楼"]}),
    case("C2", "先去第三站安福路，再去第一站罗密欧阳台，其他站不要删。", state=BASE, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "modification.operation": ["reorder"],
                   "modification.places": [["安福路", "罗密欧阳台"], ["安福路", "罗密欧阳台", OLD_STOPS[1]]],
                   "modification.keep_others": [True]}),
    case("C3", "把路线顺序改成：安福路 → 罗密欧阳台 → 淮海中路1768弄优秀历史建筑。不要增删地点。",
         state=BASE, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "modification.operation": ["reorder"],
                   "modification.places": [["安福路", "罗密欧阳台", OLD_STOPS[1]]], "modification.keep_others": [True]}),
    case("C4", "不用去武康大楼了，取消固定终点，其他地方保持不变。",
         state={**BASE, "end": "武康大楼"}, places=OLD_STOPS + ["武康大楼"],
         expected={"intent": ["modify_route"], "modification.operation": ["change_end"],
                   "modification.value": [None], "trip_state.end": [None]}, contains={"clear_fields": [["end"]]}),
    case("C5", "现在改从徐家汇地铁站出发，还是两小时看老洋房，重新规划。", state=BASE, places=OLD_STOPS,
         history=[{"role": "user", "content": "最后想去武康大楼。"},
                  {"role": "assistant", "content": "上次修改失败，武康大楼终点未生效，原路线保留。"}],
         expected={"intent": ["modify_route"], "modification.operation": ["change_start", "replan"],
                   "trip_state.start": ["徐家汇地铁站"], "trip_state.duration_minutes": [120], "trip_state.end": [None]}),
    case("C6", "撤销刚才的修改，恢复到我第一次规划的路线和起点。",
         state={**BASE, "start": "徐家汇地铁站"}, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "modification.operation": ["restore_initial"]}),
    case("D1", "从杭州西湖出发，帮我安排一小时的步行路线。",
         expected={"intent": ["out_of_scope"], "action": [None]}),
    case("D2", "那从徐家汇出发，我想体验外星球降落现场，能近距离看真实外星飞船，走1小时。",
         expected={"intent": ["plan_route", "chat"], "theme_status": ["abstract_valid"],
                   "trip_state.start": ["徐家汇"], "trip_state.duration_minutes": [60]}),
    case("E1", "从衡山路出发，轻松逛花园和书店，1小时。",
         expected={"intent": ["plan_route"], "trip_state.start": ["衡山路"], "trip_state.duration_minutes": [60],
                   "trip_state.pace": ["relaxed"]}, contains={"trip_state.theme": [["花园"], ["书店"]]}),
    case("E2", "我说的是上海徐汇的衡山路地铁站，不是横山村。请从衡山路地铁站重新规划，必须有一家书店。",
         state={"start": "衡山路", "duration_minutes": 60, "theme": ["花园", "书店"]}, places=["盛家花园", "上海党建书店"],
         expected={"intent": ["modify_route"], "trip_state.start": ["衡山路地铁站", "上海徐汇的衡山路地铁站"],
                   "trip_state.duration_minutes": [60]}, contains={"trip_state.required_categories": [["书店"]]}),
    case("F1", "从上海图书馆出发，1小时逛咖啡馆。",
         expected={"intent": ["plan_route"], "trip_state.start": ["上海图书馆"], "trip_state.duration_minutes": [60]},
         contains={"trip_state.theme": [["咖啡馆", "咖啡", "咖啡店"]]}),
]


CORE = [
    case("G1", "更少景点", state=BASE, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "relative_goals.stop_count": ["decrease"],
                   "relative_goals.distance": [None], "trip_state.min_stops": [None], "trip_state.max_stops": [None]}),
    case("G2", "更近总距离", state=BASE, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "relative_goals.distance": ["decrease"],
                   "relative_goals.stop_count": [None], "trip_state.max_walk_meters": [None]}),
    case("G3", "总距离小于1000米", state=BASE, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "trip_state.max_walk_meters": [1000],
                   "trip_state.max_walk_inclusive": [False], "relative_goals.stop_count": [None]}),
    case("G4", "景点数量大于3个", state=BASE, places=OLD_STOPS,
         expected={"intent": ["modify_route"], "trip_state.min_stops": [4], "trip_state.max_stops": [None],
                   "relative_goals.distance": [None], "relative_goals.stop_count": [None]}),
]


def all_cases():
    result = deepcopy(CASES)
    for item in CORE:
        for repeat in range(1, 4):
            copied = deepcopy(item)
            copied["id"] += f".{repeat}"
            result.append(copied)
    return result


def canonical(output, version):
    if version == "after":
        proposal = output.get("proposal") or {}
        return {**proposal, "trip_state": output.get("trip_state", {}), "action": output.get("action"),
                "module_status": output.get("status")}
    result = deepcopy(output)
    # Legacy executor treats max_walk_meters as an inclusive cap. It has no relative/count fields.
    state = result.setdefault("trip_state", {})
    state["max_walk_inclusive"] = True if state.get("max_walk_meters") is not None else None
    return result


def value_at(data, path):
    value = data
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def assess(item, output, version):
    data = canonical(output, version)
    failures = []
    if version == "after" and output.get("status") == "unavailable":
        failures.append("模型本轮未完成")
    if version == "after" and item["id"] == "A1":
        # Product scope changed: undecided visitors explore interests before planning.
        # Explicit planning without an origin is separately covered by journey J13.
        if output.get("status") != "ready" or not (output.get("proposal") or {}).get("reply"):
            failures.append("不知道去哪应先进入兴趣对话，不强制补齐规划条件")
    for path, options in item["expected"].items():
        actual = value_at(data, path)
        if actual not in options:
            failures.append(f"{path}: 实际{actual!r}，预期{options!r}")
    for path, groups in item["contains"].items():
        actual = value_at(data, path) or []
        for group in groups:
            if not any(term in actual for term in group):
                failures.append(f"{path}: 缺少{group!r}中的任一项")
    # No successful-looking clarification for a fully specified actionable fixture.
    if (version == "after" and item["id"] != "A1"
            and "needs_clarification" not in item["expected"].get("module_status", [])
            and data.get("intent") in {"plan_route", "modify_route"}):
        if output.get("status") != "ready":
            failures.append("已给全条件的路线意图未就绪")
    return failures
