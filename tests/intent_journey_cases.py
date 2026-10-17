"""Discovery-to-itinerary and en-route guidance language contracts."""
from intent_cases import case, BASE, OLD_STOPS


def all_cases():
    cases = [
        case("J01", "我不知道去哪，先聊聊我喜欢什么，别急着规划",
             expected={"intent": ["chat"], "action": [None], "trip_state.start": [None]}),
        case("J02", "我喜欢老洋房和书店，先给几个选择，不要规划",
             expected={"intent": ["find_places"], "module_status": ["needs_clarification"]},
             contains={"query.keywords": [["老洋房", "历史建筑"], ["书店"]]}),
        case("J03", "在徐家汇", expected={"action": ["find_places"], "query.location": ["徐家汇", "徐家汇地铁站"]}),
        case("J04", "把第一和第三个串成一小时路线，就这两个",
             expected={"action": ["plan_route"], "selection_mode": ["only_specified"], "trip_state.duration_minutes": [60]},
             contains={"trip_state.required_places": [["武康大楼"], ["巴金故居"]]}),
        case("J05", "我迷路了，怎么去武康大楼？", state=BASE, places=OLD_STOPS,
             expected={"intent": ["navigate"], "module_status": ["needs_clarification"], "query.location": [None]},
             contains={"query.targets": [["武康大楼"]]}),
        case("J06", "徐家汇站", state=BASE, places=OLD_STOPS,
             expected={"action": ["navigate"], "query.location": ["徐家汇地铁站"], "trip_state.start": ["上海图书馆"]},
             contains={"query.targets": [["武康大楼"]]}),
        case("J07", "我在上海图书馆，怎么走到武康大楼", state=BASE, places=OLD_STOPS,
             expected={"action": ["navigate"], "query.location": ["上海图书馆"]}, contains={"query.targets": [["武康大楼"]]}),
        case("J08", "结束导航，回到行程地图", state=BASE, places=OLD_STOPS,
             expected={"action": ["navigate"], "query.cancel_navigation": [True]}),
        case("J09", "我迷路了，下一站怎么走", state=BASE, places=OLD_STOPS,
             expected={"intent": ["navigate"], "module_status": ["needs_clarification"], "query.location": [None]}),
        case("J10", "大隐书局有什么值得看", expected={"intent": ["explain_place"], "module_status": ["ready"]}),
        case("J11", "第二和第四个吧，给我安排一小时的路线，只去这两个",
             expected={"action": ["plan_route"], "trip_state.start": ["徐家汇"], "trip_state.duration_minutes": [60]},
             contains={"trip_state.required_places": [["衡山公园"], ["上海图书馆"]]}),
        case("J12", "模拟测试位置，不是真实定位：上海图书馆", state=BASE, places=OLD_STOPS,
             expected={"action": ["navigate"], "query.location": ["上海图书馆"]}, contains={"query.targets": [["武康大楼"]]}),
        case("J13", "帮我规划一小时的老洋房步行路线",
             expected={"intent": ["chat", "plan_route"], "module_status": ["needs_clarification"],
                       "action": [None], "trip_state.start": [None]}),
    ]
    cases[2]["request"]["pending_task"] = {"intent": "find_places", "query": {"keywords": ["历史建筑", "书店"]}}
    cases[3]["request"].update({"discovery_places": ["武康大楼", "大隐书局", "巴金故居"],
                                "discovery_query": {"location": "上海图书馆", "keywords": ["历史建筑", "书店"]}})
    cases[5]["request"]["pending_task"] = {"intent": "navigate", "query": {"targets": ["武康大楼"]}}
    cases[10]["request"].update({"discovery_places": ["宋庆龄故居", "衡山公园", "衡山和集", "上海图书馆"],
                                 "discovery_query": {"location": "徐家汇", "keywords": ["历史建筑", "公园"]}})
    cases[11]["request"]["pending_task"] = {"intent": "navigate", "query": {"targets": ["武康大楼"]}}
    return cases
