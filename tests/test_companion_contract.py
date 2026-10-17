import json
import unittest
from intent_module import IntentRequest, ModelIntent, finalize, build_messages


class CompanionContractTests(unittest.TestCase):
    def test_incomplete_plan_can_keep_proposed_preferences_without_executing(self):
        req = IntentRequest(message="模拟规划需求")
        result = finalize(ModelIntent(status="needs_clarification", intent="plan_route",
            reply="从哪里出发？", clarification="请提供出发地标。",
            trip_state={"duration_minutes": 60, "theme": ["老洋房"]}), req)
        self.assertEqual(result.status, "needs_clarification")
        self.assertIsNone(result.action)
        self.assertEqual(result.proposal.trip_state.duration_minutes, 60)
        self.assertIsNone(req.trip_state.duration_minutes)

    def test_navigation_is_separate_and_needs_two_known_endpoints(self):
        req = IntentRequest(message="模拟", trip_state={"start": "上海图书馆"})
        model = ModelIntent(status="ready", intent="navigate", reply="查询步行路径", query={"targets": ["美罗城"]})
        self.assertEqual(finalize(model, req).status, "needs_clarification")
        model.query.location = "徐家汇站"
        result = finalize(model, req)
        self.assertEqual(result.action, "navigate")
        self.assertEqual(result.trip_state, req.trip_state)

    def test_navigation_cancel_needs_no_location(self):
        result = finalize(ModelIntent(status="ready", intent="navigate", reply="结束临时指引", query={"cancel_navigation": True}),
                          IntentRequest(message="模拟"))
        self.assertEqual(result.action, "navigate")
    def test_search_never_commits_origin_or_route_conditions(self):
        req = IntentRequest(message="仅作模拟", trip_state={"start": "上海图书馆"})
        for intent in ("find_places", "nearby_help"):
            proposal = ModelIntent(status="ready", intent=intent, reply="查找", query={"location": "徐家汇", "keywords": ["公共厕所"]})
            result = finalize(proposal, req)
            self.assertEqual(result.action, intent)
            self.assertEqual(result.trip_state, req.trip_state)
            proposal.trip_state.start = "徐家汇"
            with self.assertRaises(ValueError):
                finalize(proposal, req)

    def test_missing_help_location_keeps_query_and_cannot_execute(self):
        result = finalize(ModelIntent(status="needs_clarification", intent="nearby_help", reply="你在哪？",
            clarification="你现在在哪个路口？", query={"keywords": ["公共厕所"]}), IntentRequest(message="模拟"))
        self.assertIsNone(result.action)
        self.assertEqual(result.proposal.query.keywords, ["公共厕所"])

    def test_pending_task_is_in_model_context_as_data(self):
        req = IntentRequest(message="徐家汇站", pending_task={"intent": "nearby_help", "query": {"keywords": ["公共厕所"]}})
        messages = build_messages(req)
        self.assertIn('"pending_task": {"intent": "nearby_help"', messages[0]["content"])
        self.assertEqual(messages[-1], {"role": "user", "content": "徐家汇站"})

    def test_explanation_needs_no_route_origin(self):
        result = finalize(ModelIntent(status="ready", intent="explain_place", reply="查询资料", query={"targets": ["巴金故居"]}), IntentRequest(message="模拟"))
        self.assertEqual(result.status, "ready")
        self.assertIsNone(result.action)

    def test_endpoint_category_is_separate_from_main_theme(self):
        result = finalize(ModelIntent(status="ready", intent="plan_route", reply="核对路线",
            trip_state={"start": "上海图书馆", "theme": ["老洋房"], "end_category": "咖啡馆"}), IntentRequest(message="模拟"))
        self.assertEqual(result.trip_state.theme, ["老洋房"])
        self.assertEqual(result.trip_state.end_category, "咖啡馆")


if __name__ == "__main__":
    unittest.main()
