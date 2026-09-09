"""Offline contract tests; these do not establish real-model language accuracy."""
import asyncio
from copy import deepcopy
import json
import unittest
from unittest.mock import AsyncMock, Mock, patch
import os

import httpx
from pydantic import ValidationError

with patch("dotenv.load_dotenv", return_value=False), patch.dict(os.environ, {"DEEPSEEK_API_KEY": "unit-test-placeholder"}):
    import main
from intent_module import IntentRequest, IntentState, ModelIntent, RouteContext, build_messages, finalize, understand
from intent_cases import all_cases, assess, BASE, OLD_STOPS, request


def payload(**updates):
    result = {"status": "ready", "intent": "modify_route", "reply": "准备核对这次修改。",
              "trip_state": {}, "modification": {"operation": "adjust_constraints"}}
    result.update(updates)
    return result


class IntentContractTests(unittest.TestCase):
    def setUp(self):
        self.req = IntentRequest(**request("更少景点", BASE, OLD_STOPS))

    def test_frozen_fixtures_have_18_original_and_12_core_requests(self):
        cases = all_cases()
        self.assertEqual(len(cases), 30)
        self.assertEqual(len({c["id"] for c in cases}), 30)
        for case in cases:
            IntentRequest(**case["request"])

    def test_distance_and_count_goals_are_independent(self):
        for goals in ({"stop_count": "decrease"}, {"distance": "decrease"},
                      {"stop_count": "unchanged", "distance": "decrease"}):
            with self.subTest(goals=goals):
                result = finalize(ModelIntent(**payload(relative_goals=goals)), self.req)
                self.assertEqual(result.status, "ready")
                self.assertEqual(result.trip_state, self.req.trip_state)
                self.assertEqual(result.comparison_baseline.stop_count, 3)
                self.assertEqual(result.comparison_baseline.total_distance_meters, 2100)
                for key, value in goals.items():
                    self.assertEqual(getattr(result.proposal.relative_goals, key), value)

    def test_limits_preserve_units_strict_boundaries_and_integer_counts(self):
        for state in ({"max_walk_meters": 500, "max_walk_inclusive": False},
                      {"max_walk_meters": 1000, "max_walk_inclusive": True},
                      {"min_stops": 4}, {"min_stops": 3}, {"max_stops": 2},
                      {"min_stops": 3, "max_stops": 3}):
            result = finalize(ModelIntent(**payload(trip_state=state)), self.req)
            for key, value in state.items():
                self.assertEqual(getattr(result.trip_state, key), value)

    def test_combined_constraints_remain_independent(self):
        state = {"min_stops": 4, "max_walk_meters": 999.5, "max_walk_inclusive": False}
        result = finalize(ModelIntent(**payload(trip_state=state)), self.req)
        self.assertEqual(result.trip_state.min_stops, 4)
        self.assertEqual(result.trip_state.max_walk_meters, 999.5)
        self.assertIsNone(result.proposal.relative_goals.distance)

    def test_relative_goals_conflicting_with_absolute_limits_are_not_executable(self):
        cases = [({"min_stops": 3}, {"stop_count": "decrease"}),
                 ({"max_stops": 3}, {"stop_count": "increase"}),
                 ({"min_stops": 4}, {"stop_count": "unchanged"}),
                 ({"max_walk_meters": 2100, "max_walk_inclusive": True}, {"distance": "increase"}),
                 ({"max_walk_meters": 2100, "max_walk_inclusive": False}, {"distance": "unchanged"})]
        for state, goals in cases:
            with self.subTest(state=state, goals=goals):
                result = finalize(ModelIntent(**payload(trip_state=state, relative_goals=goals)), self.req)
                self.assertEqual(result.status, "needs_clarification")
                self.assertIsNone(result.action)

    def test_action_and_state_must_agree(self):
        for operation, state in (("change_start", {"start": "A"}), ("change_end", {"end": "A"})):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                finalize(ModelIntent(**payload(trip_state=state, modification={"operation": operation, "value": "B"})), self.req)

    def test_count_conflict_requests_clarification_without_discarding_either(self):
        result = finalize(ModelIntent(**payload(trip_state={"min_stops": 5, "max_stops": 3})), self.req)
        self.assertEqual(result.status, "needs_clarification")
        self.assertIsNone(result.action)
        self.assertEqual(result.trip_state.min_stops, 5)
        self.assertEqual(result.trip_state.max_stops, 3)
        self.assertTrue(result.validation_issues)

    def test_relative_request_without_baseline_never_executes(self):
        for req in (IntentRequest(message="长一点"),
                    IntentRequest(message="近一点", current_route=RouteContext(places=["A"], stop_count=1))):
            result = finalize(ModelIntent(**payload(relative_goals={"distance": "decrease"})), req)
            self.assertEqual(result.status, "needs_clarification")
            self.assertIsNone(result.action)

    def test_clear_is_explicit_and_does_not_change_caller(self):
        req = IntentRequest(**request("取消距离限制", {**BASE, "max_walk_meters": 1000, "max_walk_inclusive": True}, OLD_STOPS))
        before = req.model_dump()
        result = finalize(ModelIntent(**payload(clear_fields=["max_walk_meters", "max_walk_inclusive"])), req)
        self.assertIsNone(result.trip_state.max_walk_meters)
        self.assertIsNone(result.trip_state.max_walk_inclusive)
        self.assertEqual(req.model_dump(), before)

    def test_omitted_null_empty_fields_do_not_erase_prior_state(self):
        result = finalize(ModelIntent(**payload(trip_state={"start": None, "theme": []})), self.req)
        self.assertEqual(result.trip_state, self.req.trip_state)

    def test_no_user_text_is_reparsed_or_used_to_override_model(self):
        proposal = ModelIntent(**payload(trip_state={"start": "武康大楼"}))
        for text in ("从上海图书馆出发", "不要改起点", "总距离小于1000米", "景点数量大于3个"):
            req = self.req.model_copy(update={"message": text})
            result = finalize(proposal, req)
            # Deliberately wrong mock AI response must remain wrong, not be secretly repaired.
            self.assertEqual(result.trip_state.start, "武康大楼")
            self.assertIsNone(result.trip_state.max_walk_meters)
            self.assertIsNone(result.trip_state.min_stops)

    def test_negated_or_explanation_input_can_return_non_route_intent(self):
        for text in ("讲解长一点", "回复长一点", "不要删除第二站"):
            req = self.req.model_copy(update={"message": text})
            result = finalize(ModelIntent(status="ready", intent="chat", reply="保持不变。"), req)
            self.assertIsNone(result.action)
            self.assertEqual(result.trip_state, req.trip_state)

    def test_invalid_contracts_are_rejected_not_silently_normalized(self):
        for patch_state in ({"min_stops": 3.5}, {"min_stops": True}, {"max_walk_meters": -1},
                            {"max_walk_inclusive": "false"}, {"duration_minutes": 0}, {"unknown": 3}):
            with self.subTest(state=patch_state), self.assertRaises(ValidationError):
                ModelIntent(**payload(trip_state=patch_state))
        for updates in ({"clear_fields": ["unknown"]}, {"trip_state": {"max_walk_meters": 1000}},
                        {"trip_state": {"start": "A"}, "clear_fields": ["start"]}):
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                finalize(ModelIntent(**payload(**updates)), self.req)

    def test_unknown_target_and_unavailable_undo_are_not_guessed(self):
        for operation in ("remove_stop", "replace_stop", "reorder"):
            result = finalize(ModelIntent(**payload(modification={"operation": operation, "target": "第二站"})), self.req)
            self.assertEqual(result.status, "needs_clarification")
        req = self.req.model_copy(deep=True)
        req.current_route.can_undo = False
        result = finalize(ModelIntent(**payload(modification={"operation": "undo"})), req)
        self.assertEqual(result.status, "needs_clarification")

    def test_actual_context_and_history_passed_without_rule_extraction(self):
        messages = build_messages(self.req)
        self.assertEqual(messages[-1], {"role": "user", "content": self.req.message})
        self.assertIn('"stop_count": 3', messages[0]["content"])
        self.assertIn('"total_distance_meters": 2100.0', messages[0]["content"])
        self.assertEqual(sum(m["role"] == "system" for m in messages), 1)
        self.assertEqual([m["role"] for m in messages], ["system", "user"])
        self.assertIn('"conversation_history"', messages[0]["content"])

    def test_route_count_must_match_supplied_places(self):
        with self.assertRaises(ValidationError):
            RouteContext(places=["A"], stop_count=4)


class IntentTransportTests(unittest.TestCase):
    def setUp(self):
        self.req = IntentRequest(**request("更少景点", BASE, OLD_STOPS))
        self.key = patch.object(main, "DEEPSEEK_API_KEY", "unit-test-placeholder")
        self.key.start()
        self.addCleanup(self.key.stop)

    @staticmethod
    def response(data):
        response = Mock()
        response.json.return_value = {"choices": [{"message": {"content": json.dumps(data, ensure_ascii=False)}, "finish_reason": "stop"}]}
        return response

    def test_every_message_calls_model_not_legacy_rules(self):
        for text in ("更少景点", "撤销上一步", "长一点", "帮我写Python爬虫", "路线有多远"):
            with self.subTest(text=text), patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as post:
                post.return_value = self.response({"status": "ready", "intent": "chat", "reply": "测试回复。"})
                with patch.object(main, "_explicit_modification", side_effect=AssertionError("legacy invoked")):
                    result = asyncio.run(understand(self.req.model_copy(update={"message": text}), runtime=main))
                self.assertEqual(post.await_count, 1)
                self.assertEqual(result.source, "model")

    def test_retry_invalid_schema_then_success_preserves_raw_output(self):
        wrong = payload(trip_state={"min_stops": "four"})
        correct = payload(trip_state={"min_stops": 4})
        trace = []
        with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as post:
            post.side_effect = [self.response(wrong), self.response(correct)]
            result = asyncio.run(understand(self.req, runtime=main, trace=trace.append))
        self.assertEqual(trace, [wrong, correct])
        self.assertEqual(result.trip_state.min_stops, 4)
        self.assertEqual(result.attempts, 2)
        self.assertTrue(result.recovered)

    def test_timeout_has_no_semantic_fallback_and_preserves_state(self):
        with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as post:
            post.side_effect = httpx.ReadTimeout("private diagnostic")
            result = asyncio.run(understand(self.req, runtime=main))
        self.assertEqual(result.status, "unavailable")
        self.assertEqual(result.attempts, 2)
        self.assertIsNone(result.proposal)
        self.assertIsNone(result.action)
        self.assertEqual(result.trip_state, self.req.trip_state)
        self.assertNotIn("private diagnostic", result.model_dump_json())

    def test_missing_key_does_not_call_provider(self):
        with patch.object(main, "DEEPSEEK_API_KEY", ""), patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as post:
            result = asyncio.run(understand(self.req, runtime=main))
        post.assert_not_awaited()
        self.assertEqual(result.status, "unavailable")

    def test_empty_json_mode_retries_transport_but_never_bypasses_schema(self):
        blank = self.response({})
        blank.json.return_value = {"choices": [{"message": {"content": ""}, "finish_reason": "stop"}]}
        valid = self.response(payload(relative_goals={"stop_count": "decrease"}))
        with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as post:
            post.side_effect = [blank, valid]
            result = asyncio.run(understand(self.req, runtime=main))
        self.assertEqual(result.status, "ready")
        self.assertTrue(result.recovered)
        self.assertEqual(post.call_args_list[0].kwargs["json"]["response_format"]["type"], "json_object")
        self.assertEqual(post.call_args_list[1].kwargs["json"]["response_format"]["type"], "text")
        invalid = self.response({"unexpected_field": "bad"})
        with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as post:
            post.side_effect = [blank, invalid]
            rejected = asyncio.run(understand(self.req, runtime=main))
        self.assertEqual(rejected.status, "unavailable")
        self.assertIsNone(rejected.action)

    def test_endpoint_is_additive_and_does_not_call_chat_or_map(self):
        from fastapi.testclient import TestClient
        with patch.object(main, "understand", new_callable=AsyncMock) as call:
            call.return_value = finalize(ModelIntent(**payload(relative_goals={"stop_count": "decrease"})), self.req)
            response = TestClient(main.app).post("/api/intent", json=self.req.model_dump())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["proposal"]["relative_goals"]["stop_count"], "decrease")


if __name__ == "__main__":
    unittest.main()
