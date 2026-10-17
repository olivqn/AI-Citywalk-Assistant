"""Synthetic multi-turn regressions based on reported companion-task failures."""
from copy import deepcopy
from intent_cases import case, BASE, OLD_STOPS


def all_cases():
    cases = [
        case("P01", "从上海图书馆出发，两小时看老洋房，最后喝咖啡",
             expected={"intent": ["plan_route"], "trip_state.end_category": ["咖啡馆"],
                       "trip_state.duration_minutes": [120]}, contains={"trip_state.theme": [["老洋房"]]}),
        case("P02", "不顺啊这也", state=BASE, places=OLD_STOPS,
             expected={"intent": ["modify_route"], "relative_goals.distance": ["decrease"]}),
        case("P03", "3删掉", state=BASE, places=OLD_STOPS,
             expected={"modification.operation": ["remove_stop"], "modification.target": [OLD_STOPS[2]]}),
        case("P04", "换一个科幻主题的", state=BASE, places=OLD_STOPS,
             expected={"intent": ["modify_route"], "modification.operation": ["change_theme", "replan"],
                       "theme_status": ["abstract_valid"]}, contains={"trip_state.theme": [["科幻", "科幻感"]]}),
        case("P05", "没有别的地点吗", state={**BASE, "theme": ["科幻感"]}, places=OLD_STOPS,
             expected={"action": ["find_places"], "query.exclude_existing": [True], "modification": [None]}),
        case("P06", "还有没有别的地点，标出来就行", state={**BASE, "theme": ["科技感"]}, places=OLD_STOPS,
             expected={"action": ["find_places"], "query.exclude_existing": [True], "trip_state.theme": [["科技感"]]}),
        case("P07", "找找其他有科技感的地点", state=BASE, places=OLD_STOPS,
             expected={"action": ["find_places"], "query.exclude_existing": [True], "trip_state.theme": [["老洋房"]]}),
        case("P08", "太远了。有没有更近一点的线路", state=BASE, places=OLD_STOPS,
             expected={"action": ["modify_route"], "relative_goals.distance": ["decrease"],
                       "relative_goals.stop_count": [None], "modification.allow_replace": [True]}),
        case("P09", "徐汇交大附近怎么玩", state={**BASE, "theme": ["科技感"]}, places=OLD_STOPS,
             expected={"action": ["find_places"], "trip_state.start": ["上海图书馆"]}),
        case("P10", "是我现在就在你的线路上 我很急！我要上🚽！", state=BASE, places=OLD_STOPS,
             expected={"intent": ["nearby_help"], "module_status": ["needs_clarification"],
                       "query.location": [None], "query.keywords": [["公共厕所"]], "trip_state.start": ["上海图书馆"]}),
        case("P11", "徐家汇", state=BASE, places=OLD_STOPS,
             expected={"action": ["nearby_help"], "query.location": ["徐家汇", "徐家汇地铁站"],
                       "query.keywords": [["公共厕所"]], "trip_state.start": ["上海图书馆"]}),
        case("P12", "徐家汇站", state=BASE, places=OLD_STOPS,
             expected={"action": ["nearby_help"], "query.location": ["徐家汇地铁站"],
                       "query.keywords": [["公共厕所"]], "trip_state.start": ["上海图书馆"]}),
        case("P13", "介绍上海交通大学(徐汇校区)科学馆", expected={"intent": ["explain_place"], "module_status": ["ready"]},
             contains={"query.targets": [["上海交通大学(徐汇校区)科学馆", "上海交通大学（徐汇校区）科学馆"]]}),
        case("P14", "数量和地点不变，顺序也别动，总距离必须小于986米", state=BASE, places=OLD_STOPS,
             expected={"module_status": ["needs_clarification"], "modification.preserve_order": [True], "modification.allow_replace": [False],
                       "trip_state.max_walk_meters": [986], "trip_state.max_walk_inclusive": [False]}),
    ]
    for item in cases:
        if item["id"] in {"P11", "P12"}:
            item["request"]["pending_task"] = {"intent": "nearby_help", "query": {"keywords": ["公共厕所"]}}
            item["request"]["history"] = [{"role": "user", "content": "我要上厕所"},
                                          {"role": "assistant", "content": "你现在在哪个路口或地标附近？"}]
    return deepcopy(cases)
