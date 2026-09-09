"""
AI 伴游导览 FastAPI 后端
接入 DeepSeek V4 Flash API，提供 /api/chat 端点
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import httpx
import asyncio
import json
import os
import re
import time
from pathlib import Path
from dotenv import load_dotenv
from typing import Any, Callable, Dict, List, Optional, Tuple
from place_catalog import CATALOG_NOTE, matching_map_context, search_places

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = FastAPI(title="AI Citywalk 伴游助手")

# CORS - 允许本地前端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── DeepSeek 官方 API 配置（密钥仅从本地环境读取） ───
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
MODEL_NAME = "deepseek-v4-flash"
# One API round must finish before the browser's 25-second request deadline.
# The shared deadline includes both attempts, response parsing and validation.
MODEL_TOTAL_BUDGET_SECONDS = 22.0
MODEL_ATTEMPT_TIMEOUT_SECONDS = 11.0
MODEL_MAX_ATTEMPTS = 2

SYSTEM_PROMPT = """你是上海徐汇区 AI Citywalk 助手“小徐”。你既要自然交流，也要把用户的话转成地图可以执行的结构化动作。

无论用户说什么，你都只能输出一个合法 JSON 对象，不要使用 Markdown，不要附加解释。格式如下：
{
  "intent": "chat | plan_route | modify_route | explain_place | out_of_scope",
  "reply": "给用户看的简短中文回复",
  "trip_state": {
    "start": null,
    "duration_minutes": null,
    "theme": [],
    "pace": null,
    "end": null,
    "constraints": [],
    "max_walk_meters": null,
    "required_places": [],
    "excluded_places": [],
    "required_categories": []
  },
  "clear_fields": [],
  "theme_status": "common | abstract_valid | out_of_scope",
  "interpretation": "用一句话说明你怎样理解用户的主题或请求",
  "keywords": [],
  "modification": null
}

【意图】
- chat：问候、能力询问或徐汇旅行的一般问题。
- plan_route：规划、推荐或寻找适合步行游览的地点。
- modify_route：用户在已有路线基础上要求替换、删除、新增、缩短、延长、调序或改起终点。
- explain_place：询问某个地点的历史、特色、推荐理由或“这里有什么好看的”。
- out_of_scope：股票、编程、作业等明显与文旅无关的请求。不要生硬拒绝，要简短说明只擅长徐汇 Citywalk，并邀请用户说出位置或兴趣。

【主题理解】
- common：咖啡、老洋房、历史建筑、花园、美食、书店、展览、公园、亲子、拍照等常见 Citywalk 主题，可直接规划。
- abstract_valid：“科幻感”“松弛感”“小资”“电影感”等抽象但合理的旅行偏好。把它翻译成 2~4 个地图可搜索的具体概念，写入 keywords，并在 interpretation 中透明说明理解；不要拒绝。
- out_of_scope：不属于正常文旅需求。

【状态和动作】
- trip_state 只填写本轮明确更新；未知值保持 null 或空数组，不要编造。取消条件必须写入顶层 clear_fields（例如取消终点是 ["end"]），不能保留旧条件。
- max_walk_meters 是用户明确的步行距离上限，公里换算成米；required_places 是必须去的地点，excluded_places 是明确不要的地点或类别，required_categories 是明确必须包含的类型。
- duration_minutes 必须换算成分钟；pace 可用 relaxed、normal、packed；theme 保留用户表达的主题。
- plan_route 的 keywords 提供 1~4 个适合地图检索的简短中文词。reply 要复述理解并说明即将规划。
- modify_route 的 modification 必须为：
  {"operation":"replace_stop|remove_stop|add_stop|shorten|extend|reorder|change_theme|change_start|change_end|replan|set_stops|undo|restore_initial", "target":null, "value":null, "places":[], "keep_others":true}
  target 可写“第二站”等，value 写新的地点、主题或要求。默认只改受影响部分，keep_others 为 true。
- “只保留 A 和 B”必须是 set_stops，places=["A","B"]，不能只做一次删除；用户指定的调序必须用 reorder 的 places 数组保留精确顺序，未提到的站保留；撤销是 undo，恢复第一次是 restore_initial，绝不重新随机生成。
- change_end 的 value=null 表示取消固定终点；change_start 的 value 必须是新起点。没有明确要重新规划时，不得把无法支持的修改转换成 replan，应询问具体要修改什么。
- 所有地图动作都尚未执行。reply 只能描述正在理解、准备检索和校验，不得说“已加入/已删除/改好了”，不得自行列举将落图的具体地点；真正完成说明由地图执行器提供。
- 还没有起点时先询问起点，intent=chat，不要宣称开始规划。讲解地点时没有可靠依据就明说，不能编造历史、开放时间或推荐理由。
- explain_place 和 chat 不触发地图动作，keywords 留空。
- 回复控制在 100 字以内，像熟悉徐汇的朋友，避免声称实时营业、最佳或绝对准确。"""


class TripState(BaseModel):
    start: Optional[str] = None
    duration_minutes: Optional[int] = None
    theme: List[str] = Field(default_factory=list)
    pace: Optional[str] = None
    end: Optional[str] = None
    constraints: List[str] = Field(default_factory=list)
    max_walk_meters: Optional[int] = None
    required_places: List[str] = Field(default_factory=list)
    excluded_places: List[str] = Field(default_factory=list)
    required_categories: List[str] = Field(default_factory=list)


class ChatRequest(BaseModel):
    message: str
    history: List[dict] = Field(default_factory=list)
    trip_state: Optional[TripState] = None
    route_places: List[str] = Field(default_factory=list)


class RouteModification(BaseModel):
    operation: str
    target: Optional[str] = None
    value: Optional[str] = None
    keep_others: bool = True
    places: List[str] = Field(default_factory=list)


class ChatResponse(BaseModel):
    reply: str
    action: Optional[str] = None
    keywords: Optional[List[str]] = None
    intent: str = "chat"
    trip_state: TripState = Field(default_factory=TripState)
    theme_status: str = "common"
    interpretation: str = ""
    modification: Optional[RouteModification] = None
    source: str = "fallback"
    fallback_reason: Optional[str] = None
    clear_fields: List[str] = Field(default_factory=list)
    attempts: int = 0
    recovered: bool = False


INTENTS = {"chat", "plan_route", "modify_route", "explain_place", "out_of_scope"}
THEME_STATUSES = {"common", "abstract_valid", "out_of_scope"}
MODIFY_OPERATIONS = {
    "replace_stop", "remove_stop", "add_stop", "shorten", "extend",
    "reorder", "change_theme", "change_start", "change_end", "replan",
    "set_stops", "undo", "restore_initial",
}

TOURISM_WORDS = {
    "徐汇", "上海", "citywalk", "路线", "景点", "地点", "旅游", "旅行", "逛",
    "步行", "出发", "咖啡", "餐厅", "美食", "建筑", "博物馆", "公园", "展览",
}
OBVIOUSLY_OUT_OF_SCOPE_WORDS = {
    "股票", "炒股", "基金", "比特币", "彩票", "写代码", "编程", "数学题",
    "写论文", "做作业", "法律诉讼", "修电脑",
    "python", "网页爬虫",
}
COMMON_THEME_WORDS = [
    "老洋房", "历史建筑", "海派建筑", "咖啡", "下午茶", "花园", "公园",
    "美食", "书店", "展览", "博物馆", "亲子", "拍照", "购物", "夜景",
]
ABSTRACT_THEME_MAP = {
    "科幻": ["未来感建筑", "数字艺术展", "沉浸式体验"],
    "未来感": ["现代建筑", "科技展览", "艺术空间"],
    "松弛": ["公园", "街区", "咖啡馆"],
    "小资": ["历史街区", "精品咖啡", "花园洋房"],
    "电影感": ["历史街区", "老洋房", "特色街道"],
    "浪漫": ["花园", "老洋房", "咖啡馆"],
}
PLACE_GUIDE_NOTES = {
    "武康大楼": "它是上海很有辨识度的历史建筑，三角形转角轮廓特别适合观察和拍照。",
    "上海图书馆": "它是徐汇重要的公共文化地标，也适合作为人文主题 Citywalk 的起点。",
    "徐家汇天主堂": "它以哥特式建筑语言和徐家汇历史文化背景著称。",
    "百代小红楼": "这里与中国早期唱片工业有关，是理解徐汇音乐文化的一站。",
    "巴金故居": "这里连接着巴金的生活与创作，适合放进文学和老洋房主题路线。",
}


def _model_dump(model: BaseModel) -> Dict[str, Any]:
    """兼容 Pydantic v1/v2。"""
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _clean_string_list(value: Any, limit: int = 8) -> List[str]:
    if not isinstance(value, list):
        return []
    result: List[str] = []
    for item in value:
        if isinstance(item, str) and item.strip() and item.strip() not in result:
            result.append(item.strip())
        if len(result) >= limit:
            break
    return result


def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    """容忍模型偶尔添加代码围栏或少量前后文字。"""
    clean = text.strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:json)?\s*", "", clean, flags=re.IGNORECASE)
        clean = re.sub(r"\s*```$", "", clean)
    try:
        parsed = json.loads(clean)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        start, end = clean.find("{"), clean.rfind("}")
        if start >= 0 and end > start:
            try:
                parsed = json.loads(clean[start:end + 1])
                return parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                return None
    return None


STATE_LIST_FIELDS = {"theme", "constraints", "required_places", "excluded_places", "required_categories"}
STATE_SCALAR_FIELDS = {"start", "duration_minutes", "pace", "end", "max_walk_meters"}
PROTECTED_STATE_FIELDS = {"start", "end", "max_walk_meters", "required_places", "excluded_places", "required_categories"}
END_CLEAR_PATTERN = r"取消(?:固定)?终点|(?:固定)?终点(?:取消|不要了)|不(?:用|再|要)(?:设|设置|固定)终点|终点不限"


def _merge_trip_state(base: TripState, raw: Any, clear_fields: Any = None) -> TripState:
    """Missing/null means unchanged; explicit clear_fields removes an old condition."""
    current = _model_dump(base)
    if isinstance(raw, dict):
        for key in STATE_SCALAR_FIELDS:
            value = raw.get(key)
            if value not in (None, "", []):
                current[key] = value
        for key in STATE_LIST_FIELDS:
            values = _clean_string_list(raw.get(key))
            if values:
                current[key] = values
    clears = _clean_string_list(clear_fields)
    if isinstance(raw, dict):
        clears += _clean_string_list(raw.get("clear_fields"))
    for key in clears:
        if key in STATE_SCALAR_FIELDS:
            current[key] = None
        elif key in STATE_LIST_FIELDS:
            current[key] = []

    try:
        duration = current.get("duration_minutes")
        if duration is not None:
            current["duration_minutes"] = max(10, min(int(duration), 720))
    except (TypeError, ValueError):
        current["duration_minutes"] = None
    try:
        meters = current.get("max_walk_meters")
        if meters is not None:
            current["max_walk_meters"] = max(1, min(int(meters), 50000))
    except (TypeError, ValueError):
        current["max_walk_meters"] = None

    if current.get("pace") not in {None, "relaxed", "normal", "packed"}:
        current["pace"] = "normal"
    return TripState(**current)


def _is_obviously_out_of_scope(message: str) -> bool:
    lower = message.lower()
    has_out_of_scope_word = any(word in lower for word in OBVIOUSLY_OUT_OF_SCOPE_WORDS)
    has_tourism_context = any(word in lower for word in TOURISM_WORDS)
    return has_out_of_scope_word and (not has_tourism_context or "先不旅游" in lower)


def _infer_duration(message: str) -> Optional[int]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(小时|分钟)", message)
    if match:
        amount = float(match.group(1))
        return max(10, min(int(amount * 60 if match.group(2) == "小时" else amount), 720))
    chinese_hours = {"半": 30, "一": 60, "两": 120, "二": 120, "三": 180, "四": 240}
    match = re.search(r"(半|一|两|二|三|四)个?小时", message)
    return chinese_hours.get(match.group(1)) if match else None


def _clean_place_name(value: str) -> str:
    value = re.sub(r"^第[一二三四五六七八九十\d]+站\s*", "", value.strip())
    return value.strip("，,。；;：:！!？? \n")


def _split_places(value: str) -> List[str]:
    return _clean_string_list([
        _clean_place_name(part) for part in re.split(r"\s*(?:→|->|、|，|,|和|以及|及)\s*", value)
    ], limit=12)


def _infer_start(message: str) -> Optional[str]:
    # Take the last explicit correction, not an earlier quoted/negated location.
    matches = list(re.finditer(r"从([^，,。；;\n]{2,35}?)(?:出发|开始|重新规划|重新安排)", message))
    if matches:
        return _clean_place_name(matches[-1].group(1))
    match = re.search(r"(?:起点(?:改成|改为|设为|换成|是)|我(?:现在)?在)([^，,。；;\n]{2,30})", message)
    return _clean_place_name(match.group(1)) if match else None


def _infer_distance_limit(message: str) -> Optional[int]:
    number = r"(\d+(?:\.\d+)?|半|一|两|二|三|四|五|六|七|八|九|十|一百|两百|二百|三百|四百|五百|六百|七百|八百|九百)"
    unit = r"\s*(公里|千米|km|米|m)"
    patterns = [
        rf"(?:不要超过|不能超过|不超过|最多|上限(?:是|为)?|控制在|压缩到|缩短到|少于|小于|不多于)\s*{number}{unit}",
        rf"{number}{unit}\s*(?:以内|以下|内)",
    ]
    matches = []
    for pattern in patterns:
        matches.extend(re.finditer(pattern, message, flags=re.IGNORECASE))
    if not matches:
        return None
    match = max(matches, key=lambda item: item.start())
    chinese = {"半": .5, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5,
               "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    amount_text = match.group(1)
    if amount_text.endswith("百"):
        amount = chinese.get(amount_text[0], 1) * 100
    else:
        amount = chinese.get(amount_text)
        if amount is None:
            amount = float(amount_text)
    return max(1, int(amount * (1000 if match.group(2).lower() in {"公里", "千米", "km"} else 1)))


def _explicit_trip_patch(message: str) -> Dict[str, Any]:
    patch: Dict[str, Any] = {}
    start = _infer_start(message)
    if start:
        patch["start"] = start
    distance = _infer_distance_limit(message)
    if distance is not None:
        patch["max_walk_meters"] = distance
    if re.search(END_CLEAR_PATTERN, message):
        patch["clear_fields"] = ["end"]
    else:
        match = re.search(r"(?:终点(?:是|设为|改成|改为)?|最后(?:必须|一定)?(?:回)?到)([^，,。；;]{2,30}?)(?:结束|[，,。；;]|$)", message)
        if match:
            patch["end"] = _clean_place_name(match.group(1))
    excluded = []
    for match in re.finditer(r"(?:不要|不去|排除|不包含)([^，,。；;]+)", message):
        part = match.group(1)
        if re.match(r"超过|超过|删|增删|变|改|设置|固定|终点", part):
            continue
        excluded.extend(_split_places(part))
    if excluded:
        patch["excluded_places"] = _clean_string_list(excluded)
    categories = []
    for match in re.finditer(r"(?:必须|一定|务必)(?:要)?(?:有|包含|包括|安排)(?:一[家个处座]|至少一[家个处座])?([^，,。；;]+)", message):
        categories.extend(word for word in COMMON_THEME_WORDS if word in match.group(1))
    if categories:
        patch["required_categories"] = _clean_string_list(categories)
    must_visit = re.search(r"(?:必须去|一定要去|必去)([^，,。；;]+)", message)
    if must_visit:
        patch["required_places"] = _split_places(must_visit.group(1))
    return patch


def _explicit_modification(message: str, req: ChatRequest) -> Optional[RouteModification]:
    if req.route_places and re.fullmatch(
        r"(?:请|帮我|能不能|可以)?(?:把)?(?:这条|当前|现在的)?(?:路线|行程|路程)?(?:再|稍微)?"
        r"(?:长一点|长一些|更长(?:一点|一些)?|延长(?:一点|一些)?|多走一段|多逛一会儿?)(?:吧|吗)?[。！？!?]?",
        message.strip(),
    ):
        return RouteModification(operation="extend", keep_others=True)
    if re.search(r"恢复.*(?:第一次|最初|初始)|(?:第一次|最初|初始).*恢复", message):
        return RouteModification(operation="restore_initial")
    if re.search(r"撤销|回退上一步|回到上一(?:版|步)|恢复上一(?:版|步)", message):
        return RouteModification(operation="undo")
    if re.search(END_CLEAR_PATTERN, message):
        return RouteModification(operation="change_end", value=None)
    only = re.search(r"(?:只保留|仅保留|只去)([^，,。；;]+)", message)
    if only:
        names = _split_places(only.group(1))
        if names:
            return RouteModification(operation="set_stops", places=names, keep_others=False)
    if re.search(r"顺序|先去|先走|先到", message):
        sequence = re.search(r"(?:顺序(?:改成|改为|设为|调整为)?\s*[：:]?)([^。；;\n]+)", message)
        if sequence and re.search(r"→|->|、|，|,", sequence.group(1)):
            names = _split_places(sequence.group(1))
            if names:
                return RouteModification(operation="reorder", places=names)
        visits = re.findall(r"(?:先|再|然后)(?:去|走|到)([^，,。；;]+)", message)
        if visits:
            return RouteModification(operation="reorder", places=[_clean_place_name(name) for name in visits])
    start = _infer_start(message)
    if req.route_places and start and (start != (req.trip_state or TripState()).start or "改" in message or "重新" in message):
        return RouteModification(operation="change_start", value=start)
    if req.route_places and _infer_distance_limit(message) is not None:
        return RouteModification(operation="shorten")
    if req.route_places and "end" in _explicit_trip_patch(message):
        return RouteModification(operation="change_end", value=_explicit_trip_patch(message)["end"])
    return None


def _infer_trip_state(message: str, base: TripState) -> TripState:
    raw: Dict[str, Any] = {}
    duration = _infer_duration(message)
    if duration:
        raw["duration_minutes"] = duration

    if any(word in message for word in ("轻松", "慢慢", "少走", "别太赶", "不赶")):
        raw["pace"] = "relaxed"
    elif any(word in message for word in ("紧凑", "多逛", "尽量多")):
        raw["pace"] = "packed"

    positive_message = re.sub(r"(?:不要|不去|排除|不包含)[^，,。；;]+", "", message)
    themes = [word for word in COMMON_THEME_WORDS if word in positive_message]
    themes.extend(word for word in ABSTRACT_THEME_MAP if word in positive_message)
    if themes:
        raw["theme"] = themes
    raw.update(_explicit_trip_patch(message))
    for key in ("excluded_places", "required_places", "required_categories"):
        if raw.get(key):
            raw[key] = _clean_string_list(getattr(base, key) + raw[key])
    return _merge_trip_state(base, raw)


def _enforce_request(response: ChatResponse, req: ChatRequest) -> ChatResponse:
    """The latest explicit request overrides model guesses on both online and fallback paths."""
    if response.intent == "out_of_scope":
        response.action = None
        response.modification = None
        response.trip_state = req.trip_state or TripState()
        return response
    response.trip_state = _infer_trip_state(req.message, response.trip_state)
    patch = _explicit_trip_patch(req.message)
    response.clear_fields = _clean_string_list(response.clear_fields + patch.get("clear_fields", []))
    response.trip_state = _merge_trip_state(response.trip_state, {}, response.clear_fields)
    explicit = _explicit_modification(req.message, req)
    if explicit:
        if explicit.operation == "extend":
            # A relative request is not permission to invent a new duration,
            # origin, theme, or walking cap. The executor must prove growth.
            response.trip_state = req.trip_state or TripState()
            response.clear_fields = []
        if explicit.operation in {"undo", "restore_initial"} and not req.route_places:
            response.intent, response.action, response.modification = "chat", None, None
            response.reply = "还没有可以恢复的路线。先告诉我起点和想逛的主题吧。"
            return response
        response.intent = "modify_route" if req.route_places else "plan_route"
        response.action = response.intent
        response.modification = explicit if req.route_places else None
        if explicit.operation == "set_stops":
            response.trip_state.required_places = explicit.places
        if explicit.operation == "change_end" and explicit.value is None:
            response.trip_state.end = None
            response.clear_fields = _clean_string_list(response.clear_fields + ["end"])
    elif response.modification and response.modification.operation == "replan" and not re.search(r"重新(?:规划|安排|生成)|重做路线", req.message):
        response.intent, response.action, response.modification = "chat", None, None
        response.trip_state = req.trip_state or TripState()
        response.reply = "我还不能可靠执行这次修改，现有路线保持不变。请告诉我具体要修改哪个地点或条件。"
        return response
    if response.modification and response.modification.operation == "change_end" and response.modification.value is None:
        response.trip_state.end = None
        response.clear_fields = _clean_string_list(response.clear_fields + ["end"])
    if response.modification and response.modification.operation in {
        "reorder", "change_end", "remove_stop", "replace_stop", "add_stop", "undo", "restore_initial"
    } and req.trip_state:
        # A place name such as 盛家花园 is not an instruction to replace the trip's theme.
        response.trip_state.theme = list(req.trip_state.theme)
    # The backend does not know which locations the map can resolve or route to.
    # All completed/failed wording must come from the map executor, not the LLM.
    if response.action == "modify_route":
        response.reply = "收到，我会按你的要求调整，并检查地点、顺序和步行范围；结果以地图实际执行为准。"
    elif response.action == "plan_route":
        if not response.trip_state.start:
            response.intent, response.action = "chat", None
            response.reply = "想从哪里出发？告诉我一个徐汇的地点，我再根据你的主题和时间找路线。"
            response.modification = None
        else:
            response.reply = "收到，我会检索附近地点并检查步行范围、必去和排除条件，通过后再展示路线。"
            if response.theme_status == "abstract_valid":
                response.reply = "我会把这个偏好理解为建筑、艺术或街区氛围，先检索并校验可走的路线。具体地点以地图结果为准。"
    return response


def _fallback_content(req: ChatRequest) -> ChatResponse:
    """模型不可用或格式异常时，仍给 Demo 一个可预测的基础协议。"""
    message = req.message.strip()
    base_state = req.trip_state or TripState()
    state = _infer_trip_state(message, base_state)

    if _is_obviously_out_of_scope(message):
        return ChatResponse(
            reply="我目前主要帮你探索徐汇 Citywalk。告诉我你从哪里出发、想逛什么，我来安排路线。",
            intent="out_of_scope",
            trip_state=state,
            theme_status="out_of_scope",
            interpretation="这项请求不属于徐汇文旅或 Citywalk 场景。",
            keywords=[],
        )

    if state.start and re.search(r"杭州|西湖|北京|广州|深圳|南京|苏州|成都|重庆|武汉|西安|黄浦区|杨浦区|浦东|五角场|外滩", state.start):
        return ChatResponse(
            reply="这个 Demo 目前只支持上海徐汇的步行游览。请换一个徐汇起点，例如上海图书馆或徐家汇。",
            intent="out_of_scope", trip_state=base_state, theme_status="out_of_scope", keywords=[],
        )

    if _explicit_modification(message, req):
        return ChatResponse(intent="modify_route", action="modify_route", reply="准备检查这次修改。", trip_state=state, keywords=state.theme)

    modify_words = (
        "换掉", "换成", "换个", "换一家", "删除", "删掉", "去掉", "不去",
        "加一站", "加上", "少走", "短一点", "延长", "长一点", "调整顺序",
        "重新规划", "重新安排", "保留", "改终点", "改起点", "最后回到",
    )
    has_route_context = bool(req.route_places) or bool(
        re.search(r"第[一二三四五六七八九\d]+站|这条路线|当前路线", message)
    )
    if has_route_context and any(word in message for word in modify_words):
        operation = None
        if any(word in message for word in ("换掉", "换成", "换个", "换一家")):
            operation = "replace_stop"
        elif any(word in message for word in ("删除", "删掉", "去掉", "不去")):
            operation = "remove_stop"
        elif any(word in message for word in ("加一站", "加上")):
            operation = "add_stop"
        elif any(word in message for word in ("少走", "短一点")):
            operation = "shorten"
        elif any(word in message for word in ("延长", "长一点")):
            operation = "extend"
        elif "调整顺序" in message:
            operation = "reorder"
        elif "改终点" in message or "最后回到" in message:
            operation = "change_end"
        elif "改起点" in message:
            operation = "change_start"
        elif "重新规划" in message or "重新安排" in message:
            operation = "replan"

        if operation is None:
            return ChatResponse(
                reply="这次修改还不能可靠执行，路线保持不变。请直接说要保留哪些地点、具体顺序，或要改成的起点。",
                intent="chat", trip_state=base_state, keywords=[],
            )

        target_match = re.search(r"第[一二三四五六七八九\d]+站", message)
        value_match = re.search(r"(?:换成|换个|换一家|改成|加上)([^，,。]+)", message)
        modification = RouteModification(
            operation=operation,
            target=target_match.group(0) if target_match else None,
            value=value_match.group(1).strip() if value_match else None,
            keep_others=True,
        )
        return ChatResponse(
            reply="明白，我会只调整你提到的部分，其他路线尽量保留。",
            action="modify_route",
            intent="modify_route",
            trip_state=state,
            theme_status="common",
            interpretation="用户希望在当前路线基础上做局部调整。",
            modification=modification,
            keywords=state.theme,
        )

    abstract_word = next((word for word in ABSTRACT_THEME_MAP if word in message), None)
    plan_words = ("规划", "路线", "推荐", "找个", "找一", "想去", "想看", "想逛", "带我逛", "安排")
    strong_explain_words = ("介绍", "讲讲", "有什么特别", "什么来历", "为什么", "故事", "参观", "开放", "营业", "能进去")
    explicit_plan = any(word in message for word in ("想看", "想逛", "规划", "安排", "生成", "带我逛"))
    is_explanation = any(word in message for word in strong_explain_words) or (
        "历史" in message and not explicit_plan
    )
    if is_explanation:
        place = next((name for name in req.route_places if name in message), None)
        if not place:
            place_match = re.search(r"(?:介绍一下|讲讲)([^，,。]+)", message)
            place = place_match.group(1).strip() if place_match else None
        note = next((value for name, value in PLACE_GUIDE_NOTES.items() if name in (place or "")), None)
        if note:
            reply = f"{place}：{note}我无法确认现在是否开放或能否入内，请以现场标识和场馆官方信息为准。"
        elif place:
            reply = f"我暂时没有关于{place}的可靠历史资料，也无法确认现在能否入内。当前仅按地图搜索与主题匹配推荐，请以现场标识或场馆官方信息为准。"
        else:
            reply = "请告诉我具体地点名。我目前无法确认实时开放情况；没有可靠资料时，不会编造故事或参观信息。"
        return ChatResponse(
            reply=reply,
            intent="explain_place",
            trip_state=state,
            interpretation="用户希望了解一个地点的背景或特色。",
            keywords=[],
        )

    message_themes = [word for word in COMMON_THEME_WORDS if word in message]
    message_themes.extend(word for word in ABSTRACT_THEME_MAP if word in message)
    if any(word in message for word in plan_words) or message_themes:
        if abstract_word:
            keywords = ABSTRACT_THEME_MAP[abstract_word]
            theme_status = "abstract_valid"
            interpretation = f"我把“{abstract_word}”理解为“{'、'.join(keywords)}”。"
        else:
            keywords = message_themes or state.theme or ["历史街区", "特色建筑"]
            theme_status = "common"
            interpretation = f"按“{'、'.join(keywords)}”寻找适合步行游览的地点。"
        return ChatResponse(
            reply=f"收到，{interpretation}我现在按这个方向为你生成路线。",
            action="plan_route",
            intent="plan_route",
            trip_state=state,
            theme_status=theme_status,
            interpretation=interpretation,
            keywords=keywords,
        )

    return ChatResponse(
        reply="你好，我是小徐。你可以告诉我起点、时长和想逛的主题。",
        intent="chat",
        trip_state=state,
        interpretation="用户正在进行一般交流。",
        keywords=[],
    )


def _fallback_response(req: ChatRequest, reason: str = "rule_based") -> ChatResponse:
    response = _enforce_request(_fallback_content(req), req)
    response.source = "rule_based" if reason == "rule_based" else "fallback"
    response.fallback_reason = None if reason == "rule_based" else reason
    return response


class InvalidModelResponse(ValueError):
    """Only a safe, constant classification; never stores provider content."""


def _model_failure_reason(error: Exception) -> str:
    """对外只返回可处理的错误类型，避免返回上游正文或请求凭据。"""
    if isinstance(error, (httpx.TimeoutException, asyncio.TimeoutError)):
        return "model_timeout"
    if isinstance(error, httpx.HTTPStatusError):
        return {
            400: "model_invalid_request",
            401: "model_auth_error",
            402: "model_quota_exceeded",
            403: "model_access_denied",
            404: "model_not_found",
            429: "model_rate_limited",
        }.get(error.response.status_code, "model_unavailable")
    if isinstance(error, httpx.RequestError):
        return "model_network_error"
    if isinstance(error, InvalidModelResponse):
        return "invalid_model_response"
    return "model_unavailable"


def _retryable_model_error(error: Exception) -> bool:
    if isinstance(error, (httpx.TimeoutException, asyncio.TimeoutError,
                          httpx.RequestError, InvalidModelResponse)):
        return True
    # Bad requests, credentials, exhausted balance and rate limits need a
    # different remedy, not a second identical request in the same user turn.
    return isinstance(error, httpx.HTTPStatusError) and error.response.status_code in {500, 502, 503, 504}


def _safe_model_log(stage: str, reason: str, attempt: int, finish_reason: Any = None):
    finish = finish_reason if isinstance(finish_reason, str) and finish_reason in {"stop", "length", "content_filter", "tool_calls", "insufficient_system_resource"} else "unknown"
    print(f"[model] stage={stage} reason={reason} attempt={attempt} finish_reason={finish}")


def _model_content(data: Any) -> Tuple[str, Optional[str]]:
    try:
        choice = data["choices"][0]
        content = choice["message"]["content"]
        finish = choice.get("finish_reason")
        if not isinstance(content, str) or not content.strip():
            raise InvalidModelResponse()
        if finish not in (None, "stop"):
            raise InvalidModelResponse()
        return content, finish
    except (KeyError, IndexError, TypeError, AttributeError):
        raise InvalidModelResponse() from None


async def _request_model(
    *, stage: str, messages: List[dict], model: str, max_tokens: int,
    validate: Callable[[str], BaseModel],
) -> Tuple[Optional[BaseModel], Optional[str], int]:
    """Retry once within one wall-clock budget; never log prompts or secrets."""
    attempts = 0
    deadline = time.monotonic() + MODEL_TOTAL_BUDGET_SECONDS

    async def run():
        nonlocal attempts
        reason = "model_timeout"
        async with httpx.AsyncClient(timeout=httpx.Timeout(MODEL_ATTEMPT_TIMEOUT_SECONDS, connect=4.0)) as client:
            for attempt in range(1, MODEL_MAX_ATTEMPTS + 1):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                attempts = attempt
                finish = None
                try:
                    request_messages = [dict(item) for item in messages]
                    if attempt > 1:
                        request_messages[0]["content"] += "\n请重新完成这次请求：仅输出完整合法的 JSON 对象，不要代码围栏，所有字段使用指定类型。"
                    resp = await asyncio.wait_for(client.post(
                        DEEPSEEK_API_URL,
                        headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}", "Content-Type": "application/json"},
                        json={
                            "model": model, "messages": request_messages,
                            "temperature": 0.2, "max_tokens": max_tokens,
                            "thinking": {"type": "disabled"},
                            # DeepSeek's documented JSON mode requires an object
                            # and the word JSON in the prompt (both satisfied).
                            "response_format": {"type": "json_object"},
                        },
                    ), timeout=min(MODEL_ATTEMPT_TIMEOUT_SECONDS, remaining))
                    resp.raise_for_status()
                    try:
                        data = resp.json()
                        if isinstance(data, dict) and isinstance(data.get("choices"), list) and data["choices"] and isinstance(data["choices"][0], dict):
                            finish = data["choices"][0].get("finish_reason")
                        content, _ = _model_content(data)
                        result = validate(content)
                    except (ValueError, KeyError, TypeError, AttributeError, IndexError):
                        raise InvalidModelResponse() from None
                    if attempt > 1:
                        _safe_model_log(stage, "recovered", attempt, finish)
                    return result, None, attempts
                except Exception as error:
                    reason = _model_failure_reason(error)
                    _safe_model_log(stage, reason, attempt, finish)
                    if not _retryable_model_error(error):
                        break
            return None, reason, attempts

    try:
        return await asyncio.wait_for(run(), timeout=MODEL_TOTAL_BUDGET_SECONDS)
    except (httpx.TimeoutException, asyncio.TimeoutError):
        _safe_model_log(stage, "model_timeout", attempts)
        return None, "model_timeout", attempts
    except Exception as error:
        reason = _model_failure_reason(error)
        _safe_model_log(stage, reason, attempts)
        return None, reason, attempts


def _validated_chat_response(content: str, req: ChatRequest) -> ChatResponse:
    payload = _extract_json_object(content)
    if payload is None:
        raise InvalidModelResponse()
    legacy = payload.get("function_call") == "plan_route"
    if not legacy:
        if payload.get("intent") not in INTENTS or not isinstance(payload.get("reply"), str) or not payload["reply"].strip():
            raise InvalidModelResponse()
        if payload.get("trip_state") is not None:
            if not isinstance(payload["trip_state"], dict):
                raise InvalidModelResponse()
            TripState(**payload["trip_state"])
        for field in ("keywords", "clear_fields"):
            values = payload.get(field)
            if values is not None and (not isinstance(values, list) or not all(isinstance(item, str) for item in values)):
                raise InvalidModelResponse()
        if payload.get("intent") == "modify_route":
            modification = payload.get("modification")
            if not isinstance(modification, dict) or modification.get("operation") not in MODIFY_OPERATIONS:
                raise InvalidModelResponse()
            RouteModification(**modification)
    response = _response_from_payload(payload, req)
    # _enforce_request mutates nested fields; validate again after that final
    # transformation rather than claiming success before response validation.
    return ChatResponse(**_model_dump(response))


def _response_from_payload(payload: Dict[str, Any], req: ChatRequest) -> ChatResponse:
    """校验模型协议并映射到兼容旧前端的响应。"""
    # 兼容旧提示词偶尔产生的 function_call 格式。
    if payload.get("function_call") == "plan_route":
        payload = {
            "intent": "plan_route",
            "reply": "好的，我已经理解你的主题，正在为你生成附近的 Citywalk 路线。",
            "keywords": payload.get("keywords", []),
            "trip_state": {"theme": payload.get("keywords", [])},
            "theme_status": "common",
            "interpretation": "按用户给出的主题寻找适合步行游览的地点。",
        }

    intent = payload.get("intent") if payload.get("intent") in INTENTS else "chat"
    theme_status = payload.get("theme_status") if payload.get("theme_status") in THEME_STATUSES else "common"
    if intent == "out_of_scope":
        theme_status = "out_of_scope"

    # Location/requirements are an executable contract, not model recollection.
    # Keep the last applied state and accept changes only from this user turn.
    # This also prevents a failed prior destination in chat history resurfacing.
    explicit_patch = _explicit_trip_patch(req.message)
    clear_fields = explicit_patch.get("clear_fields", [])
    raw_state = payload.get("trip_state")
    if isinstance(raw_state, dict):
        raw_state = {key: value for key, value in raw_state.items()
                     if key not in PROTECTED_STATE_FIELDS and key != "clear_fields"}
    state = _merge_trip_state(req.trip_state or TripState(), raw_state, clear_fields)
    keywords = _clean_string_list(payload.get("keywords"), limit=4)
    if intent == "plan_route" and not keywords:
        keywords = state.theme or ["历史街区", "特色建筑"]

    modification = None
    raw_modification = payload.get("modification")
    if intent == "modify_route":
        if not isinstance(raw_modification, dict):
            raw_modification = {}
        operation = raw_modification.get("operation")
        if operation not in MODIFY_OPERATIONS:
            intent = "chat"
            payload["reply"] = "这次修改还不能可靠执行，路线保持不变。请说明要保留的地点、具体顺序或新的起点。"
        else:
            modification = RouteModification(
                operation=operation,
                target=raw_modification.get("target") if isinstance(raw_modification.get("target"), str) else None,
                value=raw_modification.get("value") if isinstance(raw_modification.get("value"), str) else None,
                keep_others=raw_modification.get("keep_others", True) is not False,
                places=_clean_string_list(raw_modification.get("places"), limit=12),
            )
            if not req.route_places and operation not in {"undo", "restore_initial"}:
                intent, modification = "plan_route", None

    reply = payload.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        reply = "我已经理解你的需求。" if intent != "out_of_scope" else "我主要帮助你探索徐汇 Citywalk，可以告诉我想逛的主题。"

    action = intent if intent in {"plan_route", "modify_route"} else None
    return _enforce_request(ChatResponse(
        reply=reply.strip()[:300],
        action=action,
        keywords=keywords,
        intent=intent,
        trip_state=state,
        theme_status=theme_status,
        interpretation=str(payload.get("interpretation") or "").strip()[:300],
        modification=modification,
        source="model",
        clear_fields=clear_fields,
    ), req)


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """理解用户意图，返回可供聊天界面和地图共同消费的结构化响应。"""

    if _is_obviously_out_of_scope(req.message):
        return _fallback_response(req)
    explicit = _explicit_modification(req.message, req)
    if explicit and explicit.operation in {"undo", "restore_initial", "extend"}:
        # These commands are executed from local route snapshots. Calling a
        # language model adds no information and must not make undo unavailable.
        return _fallback_response(req)

    # 构建 messages 数组
    state = req.trip_state or TripState()
    # 系统规则与行程上下文合并为一条 system 消息，保持请求格式一致。
    messages = [{
        "role": "system",
        "content": (
            SYSTEM_PROMPT + "\n\n当前行程状态：" + json.dumps(_model_dump(state), ensure_ascii=False)
            + "\n当前路线地点：" + json.dumps(req.route_places, ensure_ascii=False)
            + "\n\n人工整理的徐汇参考资料（不代表地图已找到或已加入路线）："
            + json.dumps(search_places(req.message, limit=4), ensure_ascii=False)
            + "\n" + CATALOG_NOTE
            + "讲解可以引用这些资料的简要事实；editorial_tags 是人工审美判断，不是客观服务承诺。"
            + "未检索到资料时不要编造。不得因此预告具体落图地点或宣称路线动作已完成。"
        ),
    }]
    for h in req.history[-12:]:
        role = h.get("role")
        content = h.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": req.message})

    if not DEEPSEEK_API_KEY.strip():
        return _fallback_response(req, reason="missing_api_key")

    result, reason, attempts = await _request_model(
        stage="chat", messages=messages, model=MODEL_NAME, max_tokens=1800,
        validate=lambda content: _validated_chat_response(content, req),
    )
    if result is not None:
        result.attempts, result.recovered = attempts, attempts > 1
        return result
    response = _fallback_response(req, reason=reason or "invalid_model_response")
    response.attempts = attempts
    return response


@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "1.html", headers={"Cache-Control": "no-store"})


@app.get("/app.js")
async def frontend_script():
    return FileResponse(BASE_DIR / "app.js", media_type="application/javascript", headers={"Cache-Control": "no-store"})


@app.get("/route-core.js")
async def route_core_script():
    return FileResponse(BASE_DIR / "route-core.js", media_type="application/javascript", headers={"Cache-Control": "no-store"})


@app.get("/api/health")
async def health():
    configured = bool(DEEPSEEK_API_KEY.strip())
    return {
        "app": "xuhui-citywalk",
        "version": "ai-native-demo",
        "status": "ok",
        "ai_configured": configured,
        "provider": "deepseek",
        "model": MODEL_NAME,
        "default_source": "model" if configured else "fallback",
    }


@app.get("/api/places/search")
async def search_catalog(query: str = "", limit: int = 8):
    """Read-only, curated topic/name retrieval; no live opening/position claims."""
    return {"places": search_places(query, limit=max(1, min(limit, 12))),
            "source": "curated", "note": CATALOG_NOTE}


# ─── POI 智能过滤功能 ───
FILTER_MODEL_NAME = MODEL_NAME

FILTER_SYSTEM_PROMPT = """你是一个地点筛选助手。用户在进行城市漫步（Citywalk），现在系统通过地图搜索到了一批附近的地点。
你的任务是：根据用户最近的对话内容，判断哪些地点符合用户的游览意图，删除不相关或不适合步行游览的地点。

【筛选规则】
1. 如果用户明确提到了想去的类型（如"咖啡馆"、"书店"、"老洋房"），只保留与该类型相关的地点。
2. 如果用户没有指定具体类型，默认保留：名胜古迹、历史街区、特色建筑、文化场馆、公园、知名商圈等具有可玩性和探索性的地点。
3. 删除以下类型的地点：普通住宅小区、停车场、加油站、医院、银行网点、政府办事机构、普通写字楼、工地等无游览价值的地点。
4. 保留的地点数量控制在 3~10 个为佳，但不相关的地点绝不能为凑数保留，可以全部不选。
5. 系统提供的人工地点资料只与 map_name 所指的当前地图候选关联；资料中的 tags 是事实类型，editorial_tags 是审美参考。优先据此判断，不得把品牌泛称的资料套到其他分店，也不得添加地图列表外的名称。没有资料不代表地点不存在，不要凭名称编造服务或历史；资料不证明实时营业、门票或可达性。

【输出格式】
你必须仅输出一个 JSON 对象，filtered_names 数组包含应该保留的地点名称（原名，不要修改）。可以为空数组，不要输出任何额外文字。
示例输出：{"filtered_names":["武康大楼", "上海图书馆", "衡山路"]}"""


class FilterPoisRequest(BaseModel):
    poi_names: List[str]
    user_message: str
    history: List[dict] = Field(default_factory=list)


class FilterPoisResponse(BaseModel):
    filtered_names: List[str]
    source: str = "fallback"
    fallback_reason: Optional[str] = None
    attempts: int = 0
    recovered: bool = False


def _fallback_filter(req: FilterPoisRequest, reason: str) -> FilterPoisResponse:
    """服务不可用时执行明确的基础排除规则，不把原始列表冒充 AI 筛选结果。"""
    excluded = ("停车场", "加油站", "医院", "银行", "办事处", "工地", "住宅小区")
    names = [name for name in _clean_string_list(req.poi_names, limit=100)
             if not any(word in name for word in excluded)]
    return FilterPoisResponse(filtered_names=names[:10], source="rule_based" if reason == "rule_based" else "fallback",
                              fallback_reason=None if reason == "rule_based" else reason)


def _validated_filter_response(content: str, req: FilterPoisRequest) -> FilterPoisResponse:
    parsed = _extract_json_object(content)
    if parsed is not None:
        filtered = parsed.get("filtered_names")
    else:
        # Retain compatibility with valid legacy array output while requesting
        # an object on all new provider calls.
        clean = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.IGNORECASE)
        filtered = json.loads(clean)
    if not isinstance(filtered, list) or not all(isinstance(name, str) and name.strip() for name in filtered):
        raise InvalidModelResponse()
    original_names = set(req.poi_names)
    names = [name for name in _clean_string_list(filtered, limit=10) if name in original_names]
    return FilterPoisResponse(filtered_names=names, source="model")


@app.post("/api/filter_pois", response_model=FilterPoisResponse)
async def filter_pois(req: FilterPoisRequest):
    """使用小模型根据用户意图过滤 POI 列表"""

    if not req.poi_names:
        return _fallback_filter(req, "rule_based")
    if not DEEPSEEK_API_KEY.strip():
        return _fallback_filter(req, "missing_api_key")

    # 取最近 10 条历史
    recent_history = req.history[-10:] if len(req.history) > 10 else req.history

    messages = [{"role": "system", "content": (
        FILTER_SYSTEM_PROMPT + "\n\n与当前地图名称严格对应的服务器地点资料："
        + json.dumps(matching_map_context(req.poi_names), ensure_ascii=False)
        + "\n" + CATALOG_NOTE
    )}]
    for h in recent_history:
        if h.get("role") in {"user", "assistant"} and isinstance(h.get("content"), str):
            messages.append({"role": h["role"], "content": h["content"]})

    # 构建过滤请求
    poi_list_text = "、".join(req.poi_names)
    messages.append({
        "role": "user",
        "content": f"用户的原始请求是：「{req.user_message}」\n\n以下是地图搜索到的地点列表：\n{poi_list_text}\n\n请根据用户意图筛选出适合游览的地点，仅输出包含 filtered_names 数组的 JSON 对象。"
    })

    result, reason, attempts = await _request_model(
        stage="filter_pois", messages=messages, model=FILTER_MODEL_NAME, max_tokens=1000,
        validate=lambda content: _validated_filter_response(content, req),
    )
    if result is not None:
        result.attempts, result.recovered = attempts, attempts > 1
        return result
    response = _fallback_filter(req, reason or "invalid_model_response")
    response.attempts = attempts
    return response
