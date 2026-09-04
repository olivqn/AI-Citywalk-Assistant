"""
AI 伴游导览 FastAPI 后端
接入硅基流动 LLM API，提供 /api/chat 端点
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import httpx
import json
import os
import re
from dotenv import load_dotenv
from typing import Any, Dict, List, Optional

load_dotenv()

app = FastAPI(title="AI Citywalk 伴游助手")

# CORS - 允许本地前端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 硅基流动 API 配置 ───
SILICONFLOW_API_KEY = os.getenv("SILICONFLOW_API_KEY", "")
SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/chat/completions"
MODEL_NAME = "Qwen/Qwen3.5-122B-A10B"

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
    "constraints": []
  },
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
- trip_state 要在“当前行程状态”基础上合并本轮新信息；未知值保持 null 或空数组，不要编造。
- duration_minutes 必须换算成分钟；pace 可用 relaxed、normal、packed；theme 保留用户表达的主题。
- plan_route 的 keywords 提供 1~4 个适合地图检索的简短中文词。reply 要复述理解并说明即将规划。
- modify_route 的 modification 必须为：
  {"operation":"replace_stop|remove_stop|add_stop|shorten|extend|reorder|change_theme|change_start|change_end|replan", "target":null, "value":null, "keep_others":true}
  target 可写“第二站”等，value 写新的地点、主题或要求。默认只改受影响部分，keep_others 为 true。
- explain_place 和 chat 不触发地图动作，keywords 留空。
- 回复控制在 100 字以内，像熟悉徐汇的朋友，避免声称实时营业、最佳或绝对准确。"""


class TripState(BaseModel):
    start: Optional[str] = None
    duration_minutes: Optional[int] = None
    theme: List[str] = Field(default_factory=list)
    pace: Optional[str] = None
    end: Optional[str] = None
    constraints: List[str] = Field(default_factory=list)


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


class ChatResponse(BaseModel):
    reply: str
    action: Optional[str] = None
    keywords: Optional[List[str]] = None
    intent: str = "chat"
    trip_state: TripState = Field(default_factory=TripState)
    theme_status: str = "common"
    interpretation: str = ""
    modification: Optional[RouteModification] = None


INTENTS = {"chat", "plan_route", "modify_route", "explain_place", "out_of_scope"}
THEME_STATUSES = {"common", "abstract_valid", "out_of_scope"}
MODIFY_OPERATIONS = {
    "replace_stop", "remove_stop", "add_stop", "shorten", "extend",
    "reorder", "change_theme", "change_start", "change_end", "replan",
}

TOURISM_WORDS = {
    "徐汇", "上海", "citywalk", "路线", "景点", "地点", "旅游", "旅行", "逛",
    "步行", "出发", "咖啡", "餐厅", "美食", "建筑", "博物馆", "公园", "展览",
}
OBVIOUSLY_OUT_OF_SCOPE_WORDS = {
    "股票", "炒股", "基金", "比特币", "彩票", "写代码", "编程", "数学题",
    "写论文", "做作业", "法律诉讼", "修电脑",
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


def _merge_trip_state(base: TripState, raw: Any) -> TripState:
    current = _model_dump(base)
    if isinstance(raw, dict):
        for key in ("start", "duration_minutes", "pace", "end"):
            value = raw.get(key)
            if value not in (None, "", []):
                current[key] = value
        for key in ("theme", "constraints"):
            values = _clean_string_list(raw.get(key))
            if values:
                current[key] = values

    try:
        duration = current.get("duration_minutes")
        if duration is not None:
            current["duration_minutes"] = max(10, min(int(duration), 720))
    except (TypeError, ValueError):
        current["duration_minutes"] = None

    if current.get("pace") not in {None, "relaxed", "normal", "packed"}:
        current["pace"] = "normal"
    return TripState(**current)


def _is_obviously_out_of_scope(message: str) -> bool:
    lower = message.lower()
    has_out_of_scope_word = any(word in lower for word in OBVIOUSLY_OUT_OF_SCOPE_WORDS)
    has_tourism_context = any(word in lower for word in TOURISM_WORDS)
    return has_out_of_scope_word and not has_tourism_context


def _infer_duration(message: str) -> Optional[int]:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(小时|分钟)", message)
    if match:
        amount = float(match.group(1))
        return max(10, min(int(amount * 60 if match.group(2) == "小时" else amount), 720))
    chinese_hours = {"半": 30, "一": 60, "两": 120, "二": 120, "三": 180, "四": 240}
    match = re.search(r"(半|一|两|二|三|四)个?小时", message)
    return chinese_hours.get(match.group(1)) if match else None


def _infer_trip_state(message: str, base: TripState) -> TripState:
    raw: Dict[str, Any] = {}
    duration = _infer_duration(message)
    if duration:
        raw["duration_minutes"] = duration

    start_match = re.search(r"从(.{2,24}?)(?:出发|开始)", message)
    if start_match:
        raw["start"] = start_match.group(1).strip("，,。 ")
    end_match = re.search(r"(?:终点(?:是|设为|改成)?|最后(?:回)?到)(.{2,24}?)(?:结束|[，,。]|$)", message)
    if end_match:
        raw["end"] = end_match.group(1).strip("，,。 ")

    if any(word in message for word in ("轻松", "慢慢", "少走", "别太赶", "不赶")):
        raw["pace"] = "relaxed"
    elif any(word in message for word in ("紧凑", "多逛", "尽量多")):
        raw["pace"] = "packed"

    themes = [word for word in COMMON_THEME_WORDS if word in message]
    themes.extend(word for word in ABSTRACT_THEME_MAP if word in message)
    if themes:
        raw["theme"] = themes
    return _merge_trip_state(base, raw)


def _fallback_response(req: ChatRequest, reason: str = "") -> ChatResponse:
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

    modify_words = (
        "换掉", "换成", "换个", "换一家", "删除", "删掉", "去掉", "不去",
        "加一站", "加上", "少走", "短一点", "延长", "长一点", "调整顺序",
        "重新规划", "重新安排", "保留", "改终点", "改起点", "最后回到",
    )
    has_route_context = bool(req.route_places) or bool(
        re.search(r"第[一二三四五六七八九\d]+站|这条路线|当前路线", message)
    )
    if has_route_context and any(word in message for word in modify_words):
        operation = "replan"
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
    strong_explain_words = ("介绍", "讲讲", "有什么特别", "什么来历", "为什么")
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
            reply = f"{place}：{note}它也和当前路线的主题、步行顺序比较契合。"
        elif place:
            themes = "、".join(state.theme) or "当前"
            reply = f"{place}与“{themes}”主题比较匹配，也方便和前后站串联。你可以继续问我它的看点。"
        else:
            reply = "可以。告诉我地点名称，或直接点地图上的地点，我会从历史和看点为你讲解。"
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

    fallback_note = " AI 服务暂时不可用，" if reason else ""
    return ChatResponse(
        reply=f"你好，我是小徐。{fallback_note}你仍可以告诉我起点、时长和想逛的主题。",
        intent="chat",
        trip_state=state,
        interpretation="用户正在进行一般交流。",
        keywords=[],
    )


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
    if intent == "modify_route" and not req.route_places:
        # 没有现有路线时，“少走一点”等表达属于首次规划约束，而不是修改动作。
        intent = "plan_route"
    theme_status = payload.get("theme_status") if payload.get("theme_status") in THEME_STATUSES else "common"
    if intent == "out_of_scope":
        theme_status = "out_of_scope"

    state = _merge_trip_state(req.trip_state or TripState(), payload.get("trip_state"))
    keywords = _clean_string_list(payload.get("keywords"), limit=4)
    if intent == "plan_route" and not keywords:
        keywords = state.theme or ["历史街区", "特色建筑"]

    modification = None
    raw_modification = payload.get("modification")
    if intent == "modify_route":
        if not isinstance(raw_modification, dict):
            raw_modification = {"operation": "replan", "keep_others": True}
        operation = raw_modification.get("operation", "replan")
        if operation not in MODIFY_OPERATIONS:
            operation = "replan"
        modification = RouteModification(
            operation=operation,
            target=raw_modification.get("target"),
            value=raw_modification.get("value"),
            keep_others=raw_modification.get("keep_others", True) is not False,
        )

    reply = payload.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        reply = "我已经理解你的需求。" if intent != "out_of_scope" else "我主要帮助你探索徐汇 Citywalk，可以告诉我想逛的主题。"

    action = intent if intent in {"plan_route", "modify_route"} else None
    return ChatResponse(
        reply=reply.strip()[:300],
        action=action,
        keywords=keywords,
        intent=intent,
        trip_state=state,
        theme_status=theme_status,
        interpretation=str(payload.get("interpretation") or "").strip()[:300],
        modification=modification,
    )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """理解用户意图，返回可供聊天界面和地图共同消费的结构化响应。"""

    if _is_obviously_out_of_scope(req.message):
        return _fallback_response(req)

    # 构建 messages 数组
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    state = req.trip_state or TripState()
    messages.append({
        "role": "system",
        "content": (
            "当前行程状态：" + json.dumps(_model_dump(state), ensure_ascii=False)
            + "\n当前路线地点：" + json.dumps(req.route_places, ensure_ascii=False)
        ),
    })
    for h in req.history[-12:]:
        role = h.get("role")
        content = h.get("content")
        if role in {"user", "assistant"} and isinstance(content, str):
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": req.message})

    if not SILICONFLOW_API_KEY.strip():
        return _fallback_response(req, reason="missing_api_key")

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                SILICONFLOW_API_URL,
                headers={
                    "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MODEL_NAME,
                    "messages": messages,
                    "temperature": 0.7,
                    "max_tokens": 512,
                    "enable_thinking": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]
            parsed = _extract_json_object(reply)
            if parsed is not None:
                return _response_from_payload(parsed, req)
    except Exception as e:
        print(f"[chat] AI 请求失败，使用本地兜底: {e}")
        return _fallback_response(req, reason=str(e))

    return _fallback_response(req, reason="invalid_model_response")


@app.get("/")
async def root():
    return FileResponse("1.html")


@app.get("/app.js")
async def frontend_script():
    return FileResponse("app.js", media_type="application/javascript")


# ─── POI 智能过滤功能 ───
FILTER_MODEL_NAME = "Qwen/Qwen3.5-27B"

FILTER_SYSTEM_PROMPT = """你是一个地点筛选助手。用户在进行城市漫步（Citywalk），现在系统通过地图搜索到了一批附近的地点。
你的任务是：根据用户最近的对话内容，判断哪些地点符合用户的游览意图，删除不相关或不适合步行游览的地点。

【筛选规则】
1. 如果用户明确提到了想去的类型（如"咖啡馆"、"书店"、"老洋房"），只保留与该类型相关的地点。
2. 如果用户没有指定具体类型，默认保留：名胜古迹、历史街区、特色建筑、文化场馆、公园、知名商圈等具有可玩性和探索性的地点。
3. 删除以下类型的地点：普通住宅小区、停车场、加油站、医院、银行网点、政府办事机构、普通写字楼、工地等无游览价值的地点。
4. 保留的地点数量控制在 3~10 个为佳。

【输出格式】
你必须仅输出一个 JSON 数组，包含你认为应该保留的地点名称（原名，不要修改），不要输出任何额外文字！
示例输出：["武康大楼", "上海图书馆", "衡山路"]"""


class FilterPoisRequest(BaseModel):
    poi_names: List[str]
    user_message: str
    history: List[dict] = []


class FilterPoisResponse(BaseModel):
    filtered_names: List[str]


@app.post("/api/filter_pois", response_model=FilterPoisResponse)
async def filter_pois(req: FilterPoisRequest):
    """使用小模型根据用户意图过滤 POI 列表"""

    # 取最近 10 条历史
    recent_history = req.history[-10:] if len(req.history) > 10 else req.history

    messages = [{"role": "system", "content": FILTER_SYSTEM_PROMPT}]
    for h in recent_history:
        messages.append({"role": h["role"], "content": h["content"]})

    # 构建过滤请求
    poi_list_text = "、".join(req.poi_names)
    messages.append({
        "role": "user",
        "content": f"用户的原始请求是：「{req.user_message}」\n\n以下是地图搜索到的地点列表：\n{poi_list_text}\n\n请根据用户意图筛选出适合游览的地点，仅输出 JSON 数组。"
    })

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                SILICONFLOW_API_URL,
                headers={
                    "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": FILTER_MODEL_NAME,
                    "messages": messages,
                    "temperature": 0.3,
                    "max_tokens": 256,
                    "enable_thinking": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            reply = data["choices"][0]["message"]["content"]

            # 解析 JSON 数组
            clean = reply.strip().strip('`').replace('json\n', '', 1).strip()
            filtered = json.loads(clean)
            if isinstance(filtered, list):
                return FilterPoisResponse(filtered_names=filtered)

    except Exception as e:
        print(f"[filter_pois] 过滤失败，返回原始列表: {e}")

    # 过滤失败时返回原始列表
    return FilterPoisResponse(filtered_names=req.poi_names)
