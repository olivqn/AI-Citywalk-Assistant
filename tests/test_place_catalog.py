"""Offline catalogue search, strict branch matching, and prompt regressions."""

import asyncio
import json
import os
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
import place_catalog as catalog

with patch("dotenv.load_dotenv", return_value=False), patch.dict(
    os.environ, {"DEEPSEEK_API_KEY": "unit-test-placeholder"}
):
    import main


def place(identifier, name, tags, editorial=(), aliases=()):
    return {
        "id": identifier, "name": name, "aliases": list(aliases),
        "address": "徐汇区示例路 1 号", "area": "徐汇",
        "tags": list(tags), "editorial_tags": list(editorial),
        "description": f"{name}的经过整理的简要事实。", "verified_on": "2026-09-08",
        "sources": [{"title": "示例官方资料", "url": "https://example.org/official"}],
    }


FIXTURE = [
    place("cafe", "示例咖啡(衡山路店)", ["咖啡馆"], ["下午茶", "松弛感"], ["示例咖啡（衡山路店）"]),
    place("books", "示例书店", ["书店"], ["阅读"]),
    place("house", "示例故居", ["老洋房", "历史建筑"], ["电影感", "拍照"]),
    place("garden", "示例公园", ["公园", "花园"], ["松弛感"]),
    place("modern", "示例艺术馆", ["美术馆", "现代建筑"], ["未来感", "拍照"]),
    place("library", "示例图书馆", ["图书馆"]),
]


class CatalogueTests(unittest.TestCase):
    def setUp(self):
        self.places = deepcopy(FIXTURE)

    def search(self, query, limit=8):
        return catalog.search_places(query, limit, self.places)

    def test_empty_unknown_and_out_of_scope_search_do_not_fill_random_places(self):
        for query in ("", "  ", "写一段代码", "火星太空站", "游乐园"):
            self.assertEqual(self.search(query), [], query)

    def test_each_supported_theme_retrieves_only_matching_places(self):
        expected = {
            "咖啡": {"cafe"}, "下午茶": {"cafe"}, "书店": {"books"},
            "阅读": {"books", "library"}, "老洋房": {"house"}, "历史": {"house"},
            "公园": {"garden"}, "花园": {"garden"}, "科幻": {"modern"},
            "未来": {"modern"}, "拍照": {"house", "modern"}, "电影感": {"house"},
            "松弛感": {"cafe", "garden"},
        }
        for query, ids in expected.items():
            with self.subTest(query=query):
                results = self.search(query)
                self.assertEqual({item["id"] for item in results}, ids)
                self.assertTrue(all(item["matched_tags"] for item in results))
                for item in results:
                    self.assertTrue(set(item["matched_tags"]) <= set(item["tags"] + item["editorial_tags"]))

    def test_concrete_bookstore_does_not_falsely_match_library(self):
        self.assertEqual([item["id"] for item in self.search("想逛一家书店")], ["books"])

    def test_exact_name_ranks_first_and_partial_name_is_searchable(self):
        self.assertEqual(self.search("介绍一下示例故居，喜欢拍照")[0]["id"], "house")
        self.assertEqual(self.search("示例故")[0]["id"], "house")

    def test_negative_themes_and_named_exclusions_are_not_recommended(self):
        self.assertEqual([item["id"] for item in self.search("不要咖啡，想逛书店")], ["books"])
        self.assertEqual([item["id"] for item in self.search("不要咖啡想看书")], ["books", "library"])
        self.assertEqual(self.search("不去示例故居，想看历史建筑"), [])

    def test_exact_matching_preserves_branch_qualifier_and_ambiguity(self):
        self.assertEqual(catalog.find_exact_place("示例咖啡（衡山路店）", self.places)["id"], "cafe")
        for name in ("示例咖啡", "示例咖啡(淮海路店)", "示例咖啡 衡山路", "示例咖啡(衡山路店)停车场"):
            self.assertIsNone(catalog.find_exact_place(name, self.places), name)
        self.places.append(place("other", "别的店", ["咖啡馆"], aliases=["示例书店"]))
        self.assertIsNone(catalog.find_exact_place("示例书店", self.places))

    def test_returned_metadata_cannot_mutate_loaded_catalogue(self):
        results = self.search("书店")
        results[0]["tags"].append("假的标签")
        exact = catalog.find_exact_place("示例书店", self.places)
        exact["sources"][0]["url"] = "https://example.org/changed"
        self.assertEqual(self.places, FIXTURE)

    def test_limit_is_bounded_to_twelve(self):
        self.places = [place(str(index), f"书店{index}", ["书店"]) for index in range(20)]
        self.assertEqual(len(self.search("书店", 999)), 12)
        self.assertEqual(len(self.search("书店", 2)), 2)

    def test_load_missing_malformed_and_wrong_schema_is_safe(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "places.json"
            self.assertEqual(catalog.load_catalog(path), [])
            for content in ("{", "null", '{"places":{}}', "[{}]", "[1]"):
                with patch.object(Path, "read_text", return_value=content):
                    self.assertEqual(catalog.load_catalog(path), [])

    def test_load_accepts_envelope_and_rejects_bad_sources_or_duplicate_ids(self):
        def load(values):
            with patch.object(Path, "read_text", return_value=json.dumps({"places": values})):
                return catalog.load_catalog()
        self.assertEqual(load(FIXTURE), FIXTURE)
        invalid = deepcopy(FIXTURE[0])
        invalid["sources"][0]["url"] = "javascript:alert(1)"
        self.assertEqual(load([invalid, FIXTURE[1]]), [FIXTURE[1]])
        self.assertEqual(load([FIXTURE[0], FIXTURE[0], FIXTURE[1]]), [FIXTURE[1]])

    def test_api_is_read_only_has_caution_and_bounds_results(self):
        with patch.object(catalog, "load_catalog", return_value=self.places):
            client = TestClient(main.app)
            data = client.get("/api/places/search", params={"query": "书店", "limit": 99}).json()
            self.assertEqual(data["source"], "curated")
            self.assertEqual(data["places"][0]["name"], "示例书店")
            self.assertIn("非实时营业", data["note"])
            self.assertEqual(client.get("/api/places/search").json()["places"], [])

    def test_map_context_only_enriches_exact_original_names(self):
        with patch.object(catalog, "load_catalog", return_value=self.places):
            context = catalog.matching_map_context(["示例咖啡（衡山路店）", "示例咖啡", "示例咖啡(淮海路店)"])
        self.assertEqual(len(context), 1)
        self.assertEqual(context[0]["map_name"], "示例咖啡（衡山路店）")
        self.assertIn("咖啡馆", context[0]["tags"])

    def test_filter_prompt_uses_trusted_catalogue_not_another_branch(self):
        provider = AsyncMock(return_value=(main.FilterPoisResponse(filtered_names=["示例书店"], source="model"), None, 1))
        with patch.object(catalog, "load_catalog", return_value=self.places), patch.object(main, "_request_model", provider), patch.object(main, "DEEPSEEK_API_KEY", "test"):
            request = main.FilterPoisRequest(poi_names=["示例书店", "示例咖啡(淮海路店)"], user_message="想逛书店")
            result = asyncio.run(main.filter_pois(request))
        system = provider.call_args.kwargs["messages"][0]["content"]
        self.assertIn("示例书店的经过整理的简要事实", system)
        self.assertIn("https://example.org/official", system)
        self.assertNotIn("示例咖啡(衡山路店)的经过整理", system)
        self.assertEqual(result.filtered_names, ["示例书店"])

    def test_chat_reference_context_remains_non_authoritative_for_route_execution(self):
        provider = AsyncMock(return_value=(main.ChatResponse(reply="这是整理资料里的历史建筑。", source="model"), None, 1))
        with patch.object(catalog, "load_catalog", return_value=self.places), patch.object(main, "_request_model", provider), patch.object(main, "DEEPSEEK_API_KEY", "test"):
            asyncio.run(main.chat(main.ChatRequest(message="示例故居是什么地方")))
        system = provider.call_args.kwargs["messages"][0]["content"]
        self.assertIn("示例故居的经过整理的简要事实", system)
        self.assertIn("不代表地图已找到或已加入路线", system)
        self.assertIn("不得因此预告具体落图地点", system)


if __name__ == "__main__":
    unittest.main()
