"""Offline regressions for the local demo and its model request protocol.

Run from the project directory:
    python -B -m unittest discover -s tests -p "test_backend_runtime.py" -v
"""

import asyncio
import io
import json
import os
import time
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from contextlib import redirect_stdout
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi.testclient import TestClient

# These tests never load the project's private .env or use a real credential.
with patch("dotenv.load_dotenv", return_value=False), patch.dict(
    os.environ, {"DEEPSEEK_API_KEY": "unit-test-placeholder"}
):
    import main


class BackendRuntimeTests(unittest.TestCase):
    def test_relative_extend_is_a_local_action_and_preserves_existing_constraints(self):
        state = main.TripState(start="上海图书馆", duration_minutes=60, theme=["咖啡"], max_walk_meters=1800, end="终点咖啡馆")
        for message in ("长一点", "路线再长一点", "请延长一点", "多走一段"):
            with self.subTest(message=message):
                request = main.ChatRequest(message=message, trip_state=state, route_places=["咖啡馆", "终点咖啡馆"])
                result = asyncio.run(main.chat(request))
                self.assertEqual(result.action, "modify_route")
                self.assertEqual(result.modification.operation, "extend")
                self.assertEqual(result.source, "rule_based")
                self.assertEqual(result.trip_state, state)
        self.post.assert_not_awaited()

    def test_relative_extend_does_not_match_longer_explanation_or_an_absent_route(self):
        for message in ("讲解长一点", "不要让路线长一点", "回复长一点"):
            request = main.ChatRequest(message=message, route_places=["武康大楼"])
            self.assertIsNone(main._explicit_modification(message, request))
        self.assertIsNone(main._explicit_modification("长一点", main.ChatRequest(message="长一点")))

    def setUp(self):
        key_patch = patch.object(main, "DEEPSEEK_API_KEY", "unit-test-placeholder")
        key_patch.start()
        self.addCleanup(key_patch.stop)

        # Every test intercepts outbound POSTs, including tests expecting no call.
        post_patch = patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock)
        self.post = post_patch.start()
        self.addCleanup(post_patch.stop)
        response = Mock()
        response.json.return_value = {
            "choices": [{"message": {"content": json.dumps({
                "intent": "plan_route",
                "reply": "已经理解，开始规划。",
                "trip_state": {"start": "上海图书馆", "duration_minutes": 120},
                "keywords": ["老洋房", "咖啡"],
            }, ensure_ascii=False)}}]
        }
        self.post.return_value = response

    def test_success_sends_one_system_message_and_marks_model_source(self):
        request = main.ChatRequest(
            message="从上海图书馆出发，逛两小时，想看老洋房。",
            trip_state=main.TripState(start="上海图书馆", theme=["老洋房"]),
            route_places=["武康大楼"],
            history=[
                {"role": "system", "content": "discard this client system message"},
                {"role": "user", "content": "你好"},
                {"role": "assistant", "content": "想从哪里出发？"},
            ],
        )
        result = asyncio.run(main.chat(request))
        self.assertEqual(result.source, "model")
        self.assertIsNone(result.fallback_reason)
        self.assertEqual(result.action, "plan_route")
        self.assertEqual(result.trip_state.duration_minutes, 120)

        self.post.assert_awaited_once()
        self.assertEqual(self.post.call_args.args[0], "https://api.deepseek.com/chat/completions")
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "deepseek-v4-flash")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("enable_thinking", payload)
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(result.attempts, 1)
        self.assertFalse(result.recovered)
        messages = self.post.call_args.kwargs["json"]["messages"]
        self.assertEqual([item["role"] for item in messages],
                         ["system", "user", "assistant", "user"])
        self.assertIn(main.SYSTEM_PROMPT, messages[0]["content"])
        self.assertIn("武康大楼", messages[0]["content"])
        self.assertNotIn("discard this", messages[0]["content"])
        self.assertEqual(messages[-1]["content"], request.message)

    def test_place_filter_uses_deepseek_flash_and_only_returns_existing_places(self):
        self.post.return_value.json.return_value = {
            "choices": [{"message": {"content": '["武康大楼", "不存在的地点"]'}}]
        }
        result = asyncio.run(main.filter_pois(main.FilterPoisRequest(
            poi_names=["武康大楼", "停车场"], user_message="看老建筑"
        )))
        self.assertEqual(result.source, "model")
        self.assertEqual(result.filtered_names, ["武康大楼"])
        self.assertEqual(self.post.call_args.args[0], "https://api.deepseek.com/chat/completions")
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "deepseek-v4-flash")
        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("enable_thinking", payload)
        self.assertEqual(payload["response_format"], {"type": "json_object"})

    def _provider_response(self, content, finish_reason="stop"):
        response = Mock()
        response.json.return_value = {
            "choices": [{"message": {"content": content}, "finish_reason": finish_reason}]
        }
        return response

    def test_transient_errors_retry_once_and_report_recovery(self):
        good = self.post.return_value
        temporary = httpx.HTTPStatusError("private-provider-error", request=httpx.Request("POST", main.DEEPSEEK_API_URL),
                                         response=httpx.Response(503))
        for error in (httpx.ConnectError("private-provider-error"), httpx.ReadTimeout("private-provider-error"), temporary):
            with self.subTest(error=type(error).__name__):
                self.post.reset_mock()
                self.post.side_effect = [error, good]
                output = io.StringIO()
                with redirect_stdout(output):
                    result = asyncio.run(main.chat(main.ChatRequest(message="想逛老洋房")))
                self.assertEqual(result.source, "model")
                self.assertEqual(result.attempts, 2)
                self.assertTrue(result.recovered)
                self.assertIsNone(result.fallback_reason)
                self.assertEqual(self.post.await_count, 2)
                self.assertNotIn("private-provider-error", output.getvalue())
                self.assertIn("reason=recovered", output.getvalue())
                retry_messages = self.post.call_args.kwargs["json"]["messages"]
                self.assertEqual(sum(item["role"] == "system" for item in retry_messages), 1)

    def test_invalid_json_and_invalid_schema_retry_before_success(self):
        good = self.post.return_value
        invalid_cases = [
            '{"intent":"chat",', '{}', '{"intent":"chat","reply":[]}',
            '{"intent":"chat","reply":"ok","trip_state":{"theme":"咖啡"}}',
            '{"intent":"modify_route","reply":"ok","modification":{"operation":"magic"}}',
        ]
        for content in invalid_cases:
            with self.subTest(content=content):
                self.post.reset_mock()
                self.post.side_effect = [self._provider_response(content), good]
                result = asyncio.run(main.chat(main.ChatRequest(message="你好")))
                self.assertEqual(result.source, "model")
                self.assertTrue(result.recovered)
                self.assertEqual(self.post.await_count, 2)

    def test_final_response_revalidation_is_part_of_retry(self):
        malformed = main.ChatResponse(reply="invalid nested state")
        malformed.trip_state = {"theme": "not-an-array"}
        valid = main.ChatResponse(reply="hello", source="model")
        with patch.object(main, "_response_from_payload", side_effect=[malformed, valid]):
            # Pydantic may warn while dumping an intentionally mutated model;
            # it must still be rejected before being sent to the frontend.
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                result = asyncio.run(main.chat(main.ChatRequest(message="你好")))
        self.assertEqual(result.source, "model")
        self.assertEqual(result.reply, "hello")
        self.assertEqual(result.attempts, 2)
        self.assertTrue(result.recovered)

    def test_non_retryable_http_failures_are_safe_and_do_not_retry(self):
        for status, reason in ((400, "model_invalid_request"), (401, "model_auth_error"),
                               (402, "model_quota_exceeded"), (403, "model_access_denied"),
                               (404, "model_not_found"), (429, "model_rate_limited")):
            with self.subTest(status=status):
                self.post.reset_mock()
                self.post.side_effect = httpx.HTTPStatusError(
                    "private-provider-body-and-secret", request=httpx.Request("POST", main.DEEPSEEK_API_URL),
                    response=httpx.Response(status, text="private-provider-body-and-secret"),
                )
                output = io.StringIO()
                with redirect_stdout(output), patch.object(main, "DEEPSEEK_API_KEY", "private-api-key"):
                    result = asyncio.run(main.chat(main.ChatRequest(message="你好")))
                self.assertEqual(result.source, "fallback")
                self.assertEqual(result.fallback_reason, reason)
                self.assertEqual(result.attempts, 1)
                self.assertFalse(result.recovered)
                self.post.assert_awaited_once()
                public_output = output.getvalue() + json.dumps(main._model_dump(result))
                self.assertNotIn("private-provider-body-and-secret", public_output)
                self.assertNotIn("private-api-key", public_output)

    def test_local_rule_handling_is_not_a_model_disconnect(self):
        for message in ("先不旅游了，帮我写一个Python网页爬虫。", "撤销刚才的修改", "恢复第一次路线"):
            response = asyncio.run(main.chat(main.ChatRequest(message=message, route_places=["武康大楼"])))
            self.assertEqual(response.source, "rule_based")
            self.assertIsNone(response.fallback_reason)
            self.assertEqual(response.attempts, 0)
            self.assertFalse(response.recovered)
        places = asyncio.run(main.filter_pois(main.FilterPoisRequest(poi_names=[], user_message="咖啡")))
        self.assertEqual(places.source, "rule_based")
        self.assertIsNone(places.fallback_reason)
        self.post.assert_not_awaited()

    def test_shared_deadline_limits_both_attempts_and_cancels_inflight_work(self):
        self.assertLess(main.MODEL_TOTAL_BUDGET_SECONDS, 25)
        self.assertEqual(main.MODEL_MAX_ATTEMPTS, 2)
        cancelled = []

        async def slow_post(*args, **kwargs):
            try:
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        self.post.side_effect = slow_post
        client = Mock()
        client.post = self.post
        context = Mock()
        context.__aenter__ = AsyncMock(return_value=client)
        context.__aexit__ = AsyncMock(return_value=False)
        started = time.monotonic()
        with patch.object(main.httpx, "AsyncClient", return_value=context), \
                patch.object(main, "MODEL_TOTAL_BUDGET_SECONDS", .08), \
                patch.object(main, "MODEL_ATTEMPT_TIMEOUT_SECONDS", .05):
            result = asyncio.run(main.chat(main.ChatRequest(message="你好")))
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, .5)
        self.assertEqual(result.fallback_reason, "model_timeout")
        self.assertEqual(result.attempts, 2)
        self.assertEqual(self.post.await_count, 2)
        self.assertEqual(len(cancelled), 2)

    def test_filter_retries_malformed_output_and_supports_json_object(self):
        self.post.side_effect = [self._provider_response('{"filtered_names":"wrong-type"}'),
                                 self._provider_response('{"filtered_names":["武康大楼","不存在的地点"]}')]
        result = asyncio.run(main.filter_pois(main.FilterPoisRequest(poi_names=["武康大楼", "停车场"], user_message="老建筑")))
        self.assertEqual(result.filtered_names, ["武康大楼"])
        self.assertEqual(result.source, "model")
        self.assertEqual(result.attempts, 2)
        self.assertTrue(result.recovered)

    def test_finish_reason_and_malformed_envelopes_do_not_leak_provider_text(self):
        private = "private-upstream-body-and-secret"
        malformed = [self._provider_response(private, finish_reason=private),
                     self._provider_response('{"intent":"chat","reply":"hello"}', finish_reason="length"),
                     self._provider_response(private, finish_reason={"private": private}),
                     self._provider_response(private), Mock()]
        malformed[-1].json.return_value = {"choices": [{"message": {"content": {"private": private}}}]}
        for bad in malformed:
            with self.subTest(response=malformed.index(bad)):
                self.post.reset_mock()
                self.post.side_effect = None
                self.post.return_value = bad
                output = io.StringIO()
                with redirect_stdout(output):
                    result = asyncio.run(main.chat(main.ChatRequest(message="你好")))
                self.assertEqual(result.source, "fallback")
                self.assertEqual(result.fallback_reason, "invalid_model_response")
                self.assertEqual(result.attempts, 2)
                self.assertNotIn(private, output.getvalue() + json.dumps(main._model_dump(result)))

    def test_timeouts_return_explicit_rule_fallback_without_private_errors(self):
        for error in (httpx.ReadTimeout("private-error-text"),
                      asyncio.TimeoutError("private-error-text")):
            with self.subTest(error=type(error).__name__):
                self.post.side_effect = error
                output = io.StringIO()
                with redirect_stdout(output):
                    result = asyncio.run(main.chat(main.ChatRequest(
                        message="从上海图书馆出发，逛两小时，想喝咖啡。"
                    )))
                self.assertEqual(result.source, "fallback")
                self.assertEqual(result.fallback_reason, "model_timeout")
                self.assertEqual(result.action, "plan_route")
                self.assertEqual(result.trip_state.start, "上海图书馆")
                self.assertNotIn("private-error-text", output.getvalue())

    def test_missing_key_never_calls_provider_and_still_filters_places(self):
        with patch.object(main, "DEEPSEEK_API_KEY", ""):
            chat = asyncio.run(main.chat(main.ChatRequest(message="想喝咖啡")))
            places = asyncio.run(main.filter_pois(main.FilterPoisRequest(
                poi_names=["武康大楼", "停车场", "医院", "书店", "武康大楼"],
                user_message="想逛逛",
            )))
        self.post.assert_not_awaited()
        self.assertEqual(chat.source, "fallback")
        self.assertEqual(chat.fallback_reason, "missing_api_key")
        self.assertEqual(places.source, "fallback")
        self.assertEqual(places.fallback_reason, "missing_api_key")
        self.assertEqual(places.filtered_names, ["武康大楼", "书店"])

    def test_truncated_model_json_is_not_reported_as_model_success(self):
        self.post.return_value.json.return_value = {
            "choices": [{"message": {"content": '{"intent":"plan_route",'}}]
        }
        result = asyncio.run(main.chat(main.ChatRequest(message="想逛老洋房")))
        self.assertEqual(result.source, "fallback")
        self.assertEqual(result.fallback_reason, "invalid_model_response")
        self.assertIsNone(result.action)
        self.assertIn("从哪里出发", result.reply)

    def _response(self, message, payload=None, fallback=False, places=None, **state):
        request = main.ChatRequest(
            message=message,
            trip_state=main.TripState(start="上海图书馆", theme=["老洋房"], **state),
            route_places=places if places is not None else ["罗密欧阳台", "淮海中路1768弄优秀历史建筑", "安福路"],
        )
        if fallback:
            return main._fallback_response(request, "model_timeout")
        return main._response_from_payload(payload or {
            "intent": "modify_route", "reply": "已经改好了，加入美罗城和港汇。",
            "trip_state": {"start": "上海图书馆", "end": "武康大楼"},
            "modification": {"operation": "replan"},
        }, request)

    def test_explicit_distance_correction_overrides_model_and_fallback(self):
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                response = self._response(
                    "我不是说了不超过1公里吗？请压缩到500米以内，20分钟不变。",
                    fallback=fallback, max_walk_meters=1000,
                )
                self.assertEqual(response.trip_state.max_walk_meters, 500)
                self.assertEqual(response.trip_state.duration_minutes, 20)
                self.assertEqual(response.modification.operation, "shorten")
                self.assertNotIn("已经改好", response.reply)
        for wording, expected in (("不超过1.5公里", 1500), ("控制在五百米", 500), ("半公里以内", 500), ("最多800m", 800)):
            self.assertEqual(main._infer_distance_limit(wording), expected)

    def test_only_keep_supports_multiple_places_and_exclusions(self):
        for fallback in (False, True):
            response = self._response(
                "只保留美罗城和港汇恒隆广场，不要上海体育场和天桥。", fallback=fallback,
            )
            self.assertEqual(response.modification.operation, "set_stops")
            self.assertEqual(response.modification.places, ["美罗城", "港汇恒隆广场"])
            self.assertEqual(response.trip_state.required_places, ["美罗城", "港汇恒隆广场"])
            self.assertEqual(response.trip_state.excluded_places, ["上海体育场", "天桥"])
            self.assertFalse(response.modification.keep_others)

    def test_explicit_order_keeps_user_sequence(self):
        cases = [
            ("先去第三站安福路，再去第一站罗密欧阳台，其他站不要删。", ["安福路", "罗密欧阳台"]),
            ("把路线顺序改成：安福路 → 罗密欧阳台 → 淮海中路1768弄优秀历史建筑。不要增删地点。", ["安福路", "罗密欧阳台", "淮海中路1768弄优秀历史建筑"]),
        ]
        for text, expected in cases:
            for fallback in (False, True):
                response = self._response(text, fallback=fallback)
                self.assertEqual(response.modification.operation, "reorder")
                self.assertEqual(response.modification.places, expected)
                self.assertTrue(response.modification.keep_others)
                self.assertEqual(response.trip_state.excluded_places, [])

    def test_cancel_destination_clears_old_model_and_current_state(self):
        for fallback in (False, True):
            response = self._response(
                "不用去武康大楼了，取消固定终点，其他地方保持不变。",
                fallback=fallback, end="武康大楼",
            )
            self.assertIsNone(response.trip_state.end)
            self.assertIn("end", response.clear_fields)
            self.assertEqual(response.modification.operation, "change_end")
            self.assertIsNone(response.modification.value)
        merged = main._merge_trip_state(main.TripState(end="武康大楼"), {"end": None})
        self.assertEqual(merged.end, "武康大楼", "Null without explicit clear means unspecified")
        merged = main._merge_trip_state(merged, {"end": "武康大楼"}, ["end"])
        self.assertIsNone(merged.end)

    def test_new_origin_wins_over_old_model_coordinates_label(self):
        for fallback in (False, True):
            response = self._response(
                "现在改从徐家汇地铁站出发，还是两小时看老洋房，重新规划。", fallback=fallback,
            )
            self.assertEqual(response.trip_state.start, "徐家汇地铁站")
            self.assertEqual(response.modification.operation, "change_start")
            self.assertEqual(response.modification.value, "徐家汇地铁站")
            self.assertEqual(response.trip_state.duration_minutes, 120)

    def test_corrected_origin_and_required_bookstore_are_structured(self):
        for fallback in (False, True):
            response = self._response(
                "我说的是上海徐汇的衡山路地铁站，不是横山村。请从衡山路地铁站重新规划，必须有一家书店。",
                fallback=fallback,
            )
            self.assertEqual(response.trip_state.start, "衡山路地铁站")
            self.assertEqual(response.trip_state.required_categories, ["书店"])
            self.assertEqual(response.modification.operation, "change_start")

    def test_undo_and_restore_are_not_random_replans(self):
        for text, operation in (("撤销刚才的修改", "undo"), ("撤销刚才的修改，恢复到我第一次规划的路线和起点。", "restore_initial")):
            for fallback in (False, True):
                response = self._response(text, fallback=fallback)
                self.assertEqual(response.modification.operation, operation)
                self.assertEqual(response.action, "modify_route")
        response = main._fallback_response(main.ChatRequest(message="撤销上一步"))
        self.assertIsNone(response.action)
        self.assertIn("没有可以恢复", response.reply)

    def test_plan_keeps_distance_end_and_negative_theme_constraints(self):
        message = "从上海图书馆出发，我只有20分钟，步行不要超过1公里，想看老洋房，不要餐厅和咖啡店，最后必须到武康大楼结束。"
        response = main._fallback_response(main.ChatRequest(message=message))
        self.assertEqual(response.action, "plan_route")
        self.assertEqual(response.trip_state.max_walk_meters, 1000)
        self.assertEqual(response.trip_state.end, "武康大楼")
        self.assertEqual(response.trip_state.excluded_places, ["餐厅", "咖啡店"])
        self.assertNotIn("咖啡", response.trip_state.theme)

    def test_unknown_modification_never_defaults_to_replan(self):
        for modification in (None, {"operation": "unsupported_magic"}, {"operation": "replan"}):
            response = self._response("把路线弄得更特殊一点", payload={
                "intent": "modify_route", "modification": modification,
            })
            self.assertIsNone(response.action)
            self.assertIsNone(response.modification)
            self.assertIn("保持不变", response.reply)

    def test_model_cannot_resurrect_failed_destination_or_invent_constraints(self):
        response = self._response("从上海图书馆出发，逛咖啡馆", payload={
            "intent": "plan_route", "trip_state": {
                "start": "横山村", "end": "武康大楼", "max_walk_meters": 500,
                "required_places": ["美罗城"], "required_categories": ["书店"],
                "excluded_places": ["咖啡"],
            }, "clear_fields": ["start"],
        })
        self.assertEqual(response.trip_state.start, "上海图书馆")
        self.assertIsNone(response.trip_state.end)
        self.assertIsNone(response.trip_state.max_walk_meters)
        self.assertEqual(response.trip_state.required_places, [])
        self.assertEqual(response.trip_state.required_categories, [])
        self.assertEqual(response.trip_state.excluded_places, [])
        self.assertEqual(response.clear_fields, [])

    def test_preexecution_text_does_not_promise_unresolved_landmarks(self):
        response = self._response("从上海图书馆出发，逛咖啡馆", payload={
            "intent": "plan_route", "reply": "已经为你加入美罗城、港汇恒隆，改好了。",
            "trip_state": {"start": "上海图书馆"},
        })
        self.assertNotIn("美罗城", response.reply)
        self.assertNotIn("改好了", response.reply)
        self.assertIn("校验", response.reply.replace("检查", "校验"))

    def test_guide_fallback_is_honest_about_missing_history_and_opening(self):
        response = self._response(
            "罗密欧阳台有什么故事？为什么选它？现在能进去参观吗？", fallback=True,
        )
        self.assertEqual(response.intent, "explain_place")
        self.assertIsNone(response.action)
        self.assertIn("没有", response.reply)
        self.assertIn("可靠历史资料", response.reply)
        self.assertIn("无法确认", response.reply)
        self.assertNotIn("继续问我", response.reply)

    def test_outside_region_and_programming_fallback_do_not_modify_route(self):
        for message in ("从杭州西湖出发，帮我安排一小时的步行路线。", "先不旅游了，帮我写一个Python网页爬虫。"):
            response = main._fallback_response(main.ChatRequest(message=message))
            self.assertEqual(response.intent, "out_of_scope")
            self.assertIsNone(response.action)

    def test_changing_destination_does_not_change_theme_from_the_place_name(self):
        request = main.ChatRequest(message="终点改为盛家花园，其他地点保留。",
            route_places=["盛家花园", "上海党建书店"],
            trip_state=main.TripState(start="衡山路", theme=["花园", "书店"]))
        result = main._response_from_payload({"intent": "modify_route",
            "trip_state": {"theme": ["花园"]},
            "modification": {"operation": "change_end", "value": "盛家花园"}}, request)
        self.assertEqual(result.trip_state.theme, ["花园", "书店"])
        self.assertEqual(result.trip_state.end, "盛家花园")

    def test_health_and_static_files_work_from_another_directory(self):
        original_directory = Path.cwd()
        with TemporaryDirectory(prefix="citywalk-runtime-test-") as directory:
            try:
                os.chdir(directory)
                with TestClient(main.app) as client:
                    health = client.get("/api/health")
                    self.assertEqual(health.status_code, 200)
                    payload = health.json()
                    self.assertEqual(payload["app"], "xuhui-citywalk")
                    self.assertEqual(payload["status"], "ok")
                    self.assertTrue(payload["ai_configured"])
                    self.assertEqual(payload["default_source"], "model")
                    self.assertNotIn("unit-test-placeholder", health.text)
                    self.assertEqual(payload["model"], "deepseek-v4-flash")
                    self.assertEqual(payload["provider"], "deepseek")
                    with patch.object(main, "DEEPSEEK_API_KEY", ""):
                        payload = client.get("/api/health").json()
                        self.assertFalse(payload["ai_configured"])
                        self.assertEqual(payload["default_source"], "fallback")
                    for url, filename in (("/", "1.html"), ("/app.js", "app.js"), ("/route-core.js", "route-core.js")):
                        response = client.get(url)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.headers["cache-control"], "no-store")
                        self.assertEqual(response.content, (main.BASE_DIR / filename).read_bytes())
            finally:
                os.chdir(original_directory)
        self.post.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
