"""Contract regression checks for known origins and exact station swaps only."""
import unittest

from intent_module import IntentRequest, ModelIntent, finalize


class SelectedFixTests(unittest.TestCase):
    def test_clarifying_availability_retains_committed_origin_and_state(self):
        req = IntentRequest(message="先保证明天免费免预约", trip_state={
            "start": "上海图书馆", "duration_minutes": 120, "theme": ["老洋房"]},
            current_route={"places": ["巴金故居"], "stop_count": 1})
        before = req.model_dump()
        result = finalize(ModelIntent(status="needs_clarification", intent="modify_route",
            reply="仍从上海图书馆出发；免费和预约信息无法保证。",
            clarification="是否接受这些信息仍需核实？"), req)
        self.assertEqual(result.status, "needs_clarification")
        self.assertEqual(result.trip_state, req.trip_state)
        self.assertIsNone(result.action)
        self.assertEqual(req.model_dump(), before)

    def test_known_origin_is_available_without_repeating_it_in_model_patch(self):
        req = IntentRequest(message="安排一小时老洋房路线", trip_state={"start": "上海图书馆"})
        result = finalize(ModelIntent(status="ready", intent="plan_route", reply="核对路线",
            trip_state={"duration_minutes": 60, "theme": ["老洋房"]}), req)
        self.assertEqual(result.action, "plan_route")
        self.assertEqual(result.trip_state.start, "上海图书馆")
        self.assertEqual(result.validation_issues, [])

    def test_swap_permutation_survives_contract_without_semantic_rewrite(self):
        stops = ["巴金故居", "衡复风貌馆", "武康大楼", "Rumours Coffee（湖南路店）"]
        req = IntentRequest(message="交换第一第三", trip_state={"start": "上海图书馆"},
            current_route={"places": stops, "stop_count": 4})
        desired = [stops[2], stops[1], stops[0], stops[3]]
        proposal = ModelIntent(status="ready", intent="modify_route", reply="仅交换两站",
            modification={"operation": "reorder", "places": desired,
                          "keep_others": True, "preserve_order": True})
        result = finalize(proposal, req)
        self.assertEqual(result.action, "modify_route")
        self.assertEqual(result.proposal.modification.places, desired)
        self.assertEqual(result.trip_state, req.trip_state)
        self.assertEqual(req.current_route.places, stops)


if __name__ == "__main__":
    unittest.main()
