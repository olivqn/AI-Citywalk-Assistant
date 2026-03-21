"""
AI 伴游导览 FastAPI 后端
接入硅基流动 LLM API，提供 /api/chat 端点
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import httpx
import json
from typing import List, Optional

app = FastAPI(title="AI Citywalk 伴游助手")

# CORS - 允许本地前端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 硅基流动 API 配置 ───
SILICONFLOW_API_KEY = "sk-gjobmvivhgtbfjvoagztqugidzkphnrpgbdcdxnkdvrykyoi"
SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/chat/completions"
MODEL_NAME = "Qwen/Qwen3.5-122B-A10B"

SYSTEM_PROMPT = """你是一位热情、专业的上海徐汇区 AI 伴游导游。你的名字叫"小徐"。
你对上海徐汇区的历史文化、海派建筑、美食、生活方式了如指掌。

【重要：路线规划指令】
如果用户的话语中明确或隐含地要求“规划路线”、“推荐几个景点逛逛”、“找个地方”等需要按图索骥的需求，你必须**仅仅**输出一段JSON格式的数据，不要输出任何额外的解释文本！
JSON格式如下：
{
  "function_call": "plan_route",
  "keywords": ["关键词1", "关键词2"]
}
例如，用户说“我想喝咖啡，再看看老洋房”，你输出：
{"function_call": "plan_route", "keywords": ["咖啡", "老洋房"]}

如果用户只是普通聊天或提问，请用中文正常回复他（每次回复控制在 200 字以内），语气亲切友好，像一个当地老朋友带你逛街。"""


class ChatRequest(BaseModel):
    message: str
    history: List[dict] = []  # [{"role": "user"/"assistant", "content": "..."}]


class ChatResponse(BaseModel):
    reply: str
    action: Optional[str] = None
    keywords: Optional[List[str]] = None


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """接收用户消息和历史记录，调用硅基流动 LLM 返回 AI 导游回复"""

    # 构建 messages 数组
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in req.history:
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": req.message})

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
            
            # --- 拦截 Function Call ---
            try:
                # 尝试解析是否为 JSON
                clean_reply = reply.strip().strip('`').replace('json\n', '', 1).strip()
                if clean_reply.startswith('{') and clean_reply.endswith('}'):
                    parsed = json.loads(clean_reply)
                    if parsed.get("function_call") == "plan_route":
                        return ChatResponse(
                            reply="", 
                            action="plan_route", 
                            keywords=parsed.get("keywords", [])
                        )
            except Exception:
                pass
            
            # 普通回复
    except Exception as e:
        reply = f"抱歉，AI 导游暂时无法回复，请稍后再试。（错误：{str(e)}）"

    return ChatResponse(reply=reply)


@app.get("/")
async def root():
    return FileResponse("1.html")


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
