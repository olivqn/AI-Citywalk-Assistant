"""Small, source-backed Xuhui place catalogue; deliberately not a live POI API.

Search expands a short, explicit synonym list. It never fills a result set with
unmatched places, invents coordinates, or treats a brand as a specific branch.
"""

import json
import re
import unicodedata
from copy import deepcopy
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse


CATALOG_PATH = Path(__file__).resolve().parent / "data" / "xuhui-places.json"
CATALOG_NOTE = "人工整理的徐汇地点资料，非实时营业信息；审美标签仅供参考，落图和步行可达性仍需地图核验。"

# Query expressions, then corresponding factual/editorial tags. These are
# interpretation hints, not claims that every matching place provides a service.
THEMES = (
    (("咖啡", "coffee"), ("咖啡", "咖啡馆", "精品咖啡", "coffee")),
    (("下午茶", "甜品"), ("下午茶", "咖啡", "咖啡馆", "甜品", "coffee")),
    (("书店", "bookstore"), ("书店", "独立书店", "bookstore")),
    (("阅读", "读书", "看书"), ("阅读", "书店", "独立书店", "图书馆", "bookstore")),
    (("老洋房", "洋房"), ("老洋房", "洋房", "花园洋房")),
    (("历史", "老建筑", "人文"), ("历史", "历史建筑", "历史街区", "故居", "历史文化", "heritage")),
    (("公园", "绿地"), ("公园", "绿地", "植物园", "park")),
    (("花园", "园林", "赏花"), ("花园", "园林", "公园", "植物园", "garden")),
    (("科幻", "未来", "科技感"), ("科幻感", "未来感", "现代建筑", "数字艺术", "科技", "modern")),
    (("拍照", "摄影", "出片"), ("拍照", "摄影", "出片", "photo")),
    (("电影感", "电影氛围"), ("电影感", "电影", "历史街区", "老洋房")),
    (("松弛", "放松", "慢逛", "散心"), ("松弛感", "公园", "花园", "咖啡", "咖啡馆", "滨江", "慢行")),
    (("展览", "艺术", "美术"), ("展览", "艺术", "美术馆", "艺术馆", "艺术空间", "博物馆", "art")),
    (("博物馆",), ("博物馆", "museum")),
    (("滨江", "江边", "江景"), ("滨江", "江景", "慢行")),
)
NEGATION = re.compile(r"(?:不要|不想|不去|不喝|不看|不逛|避开|排除|别去)[^，。；,;!?！？想要但只]{0,5}$")


def normalize_name(value: str) -> str:
    """Keep branch qualifiers/punctuation; only normalize typography and space."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value)).casefold()


def _strings(value: Any) -> Optional[List[str]]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        return None
    return list(dict.fromkeys(item.strip() for item in value))


def _validated_place(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    required_text = ("id", "name", "address", "area", "description", "verified_on")
    if any(not isinstance(value.get(key), str) or not value[key].strip() for key in required_text):
        return None
    try:
        date.fromisoformat(value["verified_on"])
    except ValueError:
        return None
    result = {key: value[key].strip() for key in required_text}
    for key in ("aliases", "tags", "editorial_tags"):
        entries = _strings(value.get(key, []))
        if entries is None or (key == "tags" and not entries):
            return None
        result[key] = entries
    sources = value.get("sources")
    if not isinstance(sources, list) or not sources:
        return None
    result["sources"] = []
    for source in sources:
        if not isinstance(source, dict) or not isinstance(source.get("title"), str) or not source["title"].strip():
            return None
        url = source.get("url")
        if not isinstance(url, str):
            return None
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        result["sources"].append({"title": source["title"].strip(), "url": url})
    return result


def load_catalog(path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Missing/malformed optional data must not break chatting or map search."""
    try:
        payload = json.loads((path or CATALOG_PATH).read_text(encoding="utf-8-sig"))
        values = payload.get("places") if isinstance(payload, dict) else payload
        if not isinstance(values, list):
            return []
        places = [place for value in values if (place := _validated_place(value)) is not None]
        duplicate_ids = {place["id"] for place in places if sum(other["id"] == place["id"] for other in places) > 1}
        return [place for place in places if place["id"] not in duplicate_ids]
    except (OSError, ValueError, TypeError):
        return []


def find_exact_place(name: str, places: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """No substring or branch-stripping matches; ambiguous aliases match nothing."""
    if not isinstance(name, str) or not name.strip():
        return None
    key = normalize_name(name)
    matches = [place for place in (load_catalog() if places is None else places)
               if any(normalize_name(alias) == key for alias in [place["name"], *place["aliases"]])]
    return deepcopy(matches[0]) if len(matches) == 1 else None


def search_places(query: str, limit: int = 8, places: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    if not isinstance(query, str) or not query.strip():
        return []
    query = normalize_name(query[:500])
    wanted, excluded = set(), set()
    for expressions, tags in THEMES:
        for expression in expressions:
            for match in re.finditer(re.escape(normalize_name(expression)), query):
                target = excluded if NEGATION.search(query[:match.start()]) else wanted
                target.update(normalize_name(tag) for tag in tags)
    wanted -= excluded
    ranked = []
    for place in (load_catalog() if places is None else places):
        names = [normalize_name(name) for name in [place["name"], *place["aliases"]]]
        if any((at := query.find(name)) >= 0 and NEGATION.search(query[:at]) for name in names):
            continue
        all_tags = [*place["tags"], *place["editorial_tags"]]
        if any(normalize_name(tag) in excluded for tag in all_tags):
            continue
        matched_tags = [tag for tag in all_tags if normalize_name(tag) in wanted]
        factual_hits = sum(tag in place["tags"] for tag in matched_tags)
        score = factual_hits * 12 + (len(matched_tags) - factual_hits) * 6
        for name in names:
            if query == name:
                score += 1000
                break
            at = query.find(name)
            if len(name) >= 2 and at >= 0 and not NEGATION.search(query[:at]):
                score += 200
                break
            if len(query) >= 2 and query in name:
                score += 80
                break
        if score > 0:
            ranked.append((score, place, list(dict.fromkeys(matched_tags))))
    ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [dict(deepcopy(place), matched_tags=tags) for _, place, tags in ranked[:max(1, min(int(limit), 12))]]


def matching_map_context(names: List[str]) -> List[Dict[str, Any]]:
    """Attach server-owned notes only to an unambiguous exact map name/alias."""
    places = load_catalog()
    context = []
    for name in list(dict.fromkeys(names))[:100]:
        place = find_exact_place(name, places)
        if place is not None:
            context.append(dict(place, map_name=name))
    return context
