"""Fixed reproduction of the live five-stop endpoint failure, synthetic data only."""
from copy import deepcopy


def all_cases():
    places = ["星巴克(武康路店)", "大隐书局(印象武康主题店)", "Peet's皮爷咖啡(武康店)", "物邸BOOKSTORE", "现磨咖啡"]
    state = {"start": "武康大楼", "duration_minutes": 120, "theme": ["书店", "咖啡馆"], "min_stops": 5}
    route = {"places": places, "stop_count": 5, "total_distance_meters": 1421,
             "estimated_duration_minutes": 71, "can_undo": True, "can_restore_initial": True}
    cases = []
    for i in range(1, 4):
        for ident, message, end, expected in [
            ("END", "最后必须到大隐书局(印象武康主题店)结束，其他地点保留。", None,
             {"trip_state.end": [places[1]], "modification.operation": ["change_end"]}),
            ("CLEAR", "别删大隐书局这个点，只是不要求最后到那里了。", places[1],
             {"trip_state.end": [None], "modification.operation": ["change_end"]}),
        ]:
            cases.append({"id": f"{ident}.{i}", "request": {"message": message,
                "trip_state": {**deepcopy(state), "end": end}, "current_route": deepcopy(route),
                "history": [
                    {"role": "user", "content": "从武康大楼出发，一小时逛书店和咖啡馆。"},
                    {"role": "assistant", "content": "已生效：从武康大楼出发，星巴克(武康路店) → 大隐书局(印象武康主题店) → 物邸BOOKSTORE。步行约986米。"},
                    {"role": "user", "content": "长一点"},
                    {"role": "assistant", "content": "已生效：从武康大楼出发，大隐书局(印象武康主题店) → 星巴克(武康路店) → 物邸BOOKSTORE。步行约1134米。"},
                    {"role": "user", "content": "时间放宽到两小时，游览点必须超过四个，不含出发点。"},
                    {"role": "assistant", "content": "已生效：从武康大楼出发，星巴克(武康路店) → 大隐书局(印象武康主题店) → Peet's皮爷咖啡(武康店) → 现磨咖啡 → 物邸BOOKSTORE。步行约1677米。"},
                    {"role": "user", "content": "这些地方我都想去，数量别变，想办法让整段路少走一点。"},
                    {"role": "assistant", "content": "已生效：从武康大楼出发，" + " → ".join(places) + "。步行约1421米。"}]},
                "expected": {"module_status": ["ready"], "intent": ["modify_route"], **expected}, "contains": {}})
    return cases
