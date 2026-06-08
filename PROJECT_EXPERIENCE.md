# 项目经验文档

> 这份文档是后续写代码前先看的项目笔记。它记录当前结构、已有结论、运行方式、关键流程、生成物和注意事项。

## 1. 当前项目概览

项目名称：AI Citywalk 伴游助手。

目标场景：面向上海徐汇区的 AI 伴游导览应用。用户可以和 AI 导游“小徐”聊天，也可以通过自然语言触发路线规划，例如“我想喝咖啡，再看看老洋房”。

当前形态：

- 后端：`main.py`，FastAPI 单文件服务。
- 前端：`1.html`，单页 HTML，包含样式、百度地图 WebGL SDK、聊天逻辑和路线规划逻辑。
- 生成物：`__pycache__/main.cpython-311.pyc`，Python 运行后生成，不应手动维护。

## 2. 文件结构

```text
dachuangX/
├── main.py
├── 1.html
├── PROJECT_EXPERIENCE.md
├── requirements.txt
├── .gitignore
├── __pycache__/
│   └── main.cpython-311.pyc
└── .git/
```

说明：

- `main.py` 是后端入口，定义 FastAPI app、接口和 LLM 调用逻辑。
- `1.html` 是当前唯一前端页面，由后端根路由 `/` 直接返回。
- `requirements.txt` 记录当前后端运行依赖。
- `.gitignore` 已忽略 `__pycache__/` 和 `*.pyc`。
- `__pycache__` 是生成目录。当前 `__pycache__/main.cpython-311.pyc` 已被 git 跟踪过，`.gitignore` 不会自动取消跟踪。

## 3. 运行方式

后端本地运行：

```powershell
uvicorn main:app --reload
```

访问入口：

```text
http://127.0.0.1:8000/
```

依赖大致包括：

- `fastapi`
- `uvicorn`
- `httpx`
- `pydantic`

如果本地没有依赖，可以通过 `requirements.txt` 安装。
如果本地没有依赖，可以执行：

```powershell
pip install -r requirements.txt
```

## 4. 后端结论

后端文件：`main.py`

已实现接口：

- `GET /`：返回 `1.html`。
- `POST /api/chat`：接收用户消息和历史，调用硅基流动大模型，返回普通聊天回复或路线规划动作。
- `POST /api/filter_pois`：接收 POI 名称列表、用户意图和历史，用小模型筛选适合 Citywalk 的地点。

核心数据结构：

- `ChatRequest`
  - `message: str`
  - `history: List[dict]`
- `ChatResponse`
  - `reply: str`
  - `action: Optional[str]`
  - `keywords: Optional[List[str]]`
- `FilterPoisRequest`
  - `poi_names: List[str]`
  - `user_message: str`
  - `history: List[dict]`
- `FilterPoisResponse`
  - `filtered_names: List[str]`

大模型配置：

- 聊天/意图识别模型：`Qwen/Qwen3.5-122B-A10B`
- POI 过滤模型：`Qwen/Qwen3.5-27B`
- API 服务：硅基流动 chat completions 接口。
- API Key 来源：环境变量 `SILICONFLOW_API_KEY`。

重要行为：

- `/api/chat` 的 system prompt 要求模型在需要规划路线时只输出 JSON：

```json
{"function_call": "plan_route", "keywords": ["咖啡", "老洋房"]}
```

- 后端会尝试把模型回复解析成 JSON。如果 `function_call` 是 `plan_route`，则返回：

```json
{"reply": "", "action": "plan_route", "keywords": ["..."]}
```

- 如果不是路线规划，就返回普通中文回复。
- `/api/filter_pois` 要求模型只输出 JSON 数组，例如：

```json
["武康大楼", "上海图书馆", "衡山路"]
```

- 过滤失败时会降级返回原始 POI 列表，避免前端流程中断。

## 5. 前端结论

前端文件：`1.html`

页面布局：

- 顶部标题栏：显示“AI Citywalk · 徐汇伴游”。
- 中间地图区：百度地图 WebGL 容器 `#container`。
- 左侧路线面板：当前位置输入、定位按钮、路线列表。
- 底部聊天面板：AI 导游“小徐”的聊天 UI。

地图能力：

- 使用百度地图 WebGL SDK：`BMapGL`。
- 默认中心点在徐汇附近：`121.445, 31.205`。
- 默认路线点：
  - 武康大楼
  - 百代小红楼
  - 徐家汇天主堂
- `simulateGPS()` 会用百度 geocoder 把输入地址解析成点位，并绘制“我的位置 + 默认路线”。
- `drawCitywalkRoute(routeArr)` 使用 `BMapGL.WalkingRoute` 拼接步行路径，然后画 polyline 和景点 marker。

聊天能力：

- `sendMessage()` 负责发送用户输入到后端。
- 如果后端返回 `action === "plan_route"`，前端会调用 `searchAndPlanRoute(data.keywords)`。
- 如果是普通回复，就把用户消息和 AI 回复追加进 `chatHistory`。

AI 路线规划流程：

1. 用户先定位，保存 `currentUserPoint`。
2. 用户聊天提出路线需求。
3. 后端 `/api/chat` 把路线需求转成关键词。
4. 前端按关键词调用百度地图周边搜索。
5. 搜索半径当前是 4000 米。
6. 前端将 POI 名称发给 `/api/filter_pois` 做二次筛选。
7. 前端用贪心算法从当前位置开始选择最近 POI。
8. 总距离限制当前是 4000 米。
9. 最多途经 5 个景点，加上起点最多 6 个点。
10. 更新路线列表、地图覆盖物和聊天播报。

重要现状：

- 前端接口地址当前写死为 Render 云端：

```js
const API_URL = "https://ai-citywalk-assistant.onrender.com/api/chat";
fetch("https://ai-citywalk-assistant.onrender.com/api/filter_pois", ...)
```

- 所以本地运行 `uvicorn main:app --reload` 后，页面聊天默认仍然请求云端后端，不会请求本地 `/api/chat`。
- 如果要本地联调，需要把前端 API 改成相对路径或可配置地址。

## 6. 已有进度

从 git 历史看，当前主线进度包括：

- 初始提交：AI Citywalk Assistant 基础项目。
- 前端更新：合入用户修改。
- 前端接口更新：切到 Render 云端后端。
- 根路由修复：`GET /` 返回 `1.html`。

当前已具备的能力：

- 单页地图 + 聊天 UI。
- FastAPI 后端提供聊天接口。
- LLM 能将部分自然语言转成路线规划动作。
- 百度地图能做定位解析、周边搜索、步行路线绘制。
- 小模型能对地图 POI 做二次筛选。

## 7. 生成内容和不要手改的内容

当前生成内容：

- `__pycache__/main.cpython-311.pyc`

处理建议：

- 不要手动编辑 `.pyc`。
- `.gitignore` 已加入：

```gitignore
__pycache__/
*.pyc
```

## 8. 已知风险和后续优先级

高优先级：

- 前端写死云端 API 地址，本地开发不方便。后续建议改成根据当前 origin 请求相对路径，或做 `API_BASE_URL` 配置。
- 当前 `__pycache__/main.cpython-311.pyc` 已被 git 跟踪过，后续若要完全清理，需要从 git 索引移除。

中优先级：

- `/api/chat` 对历史记录没有严格校验，直接读取 `h["role"]`、`h["content"]`，格式异常时可能报错。
- JSON 清洗逻辑比较简单：`strip('`').replace('json\n', '', 1)`，遇到更复杂 Markdown code fence 可能失败。
- 前端 `appendMessage()` 直接写 `innerHTML`，如果内容来自用户或模型，存在 XSS 风险。后续可改成 `textContent`，路线播报中需要换行可单独处理。
- 百度地图 AK 和样式 ID 也写在前端，属于公开暴露配置。地图 AK 通常可前端暴露，但要配好域名白名单。

低优先级：

- `1.html` 体积较大，CSS、HTML、JS 都在一个文件里。后续如果继续扩展，可拆成静态资源文件。
- 默认路线是固定点，后续可抽成配置或后端返回。
- 路线算法目前是最近邻贪心，不保证全局最优。

## 9. 后续改代码前检查清单

写后端前：

- 先确认前端当前请求云端还是本地。
- 改模型调用时注意两个接口分别使用不同模型。
- 改 prompt 时保持“路线规划必须只输出 JSON”的约束，否则前端动作识别会断。
- 任何 API Key、密钥、部署 URL 优先做成环境变量或配置。

写前端前：

- 先确认百度地图 SDK 是否能正常加载。
- 改聊天逻辑时注意 `chatHistory` 的更新时机：路线规划分支不会立即写入原始用户消息，而是在路线规划完成后写入概括内容。
- 改地图覆盖物时注意 `map.clearOverlays()` 会清掉旧标记和路线，需要重画用户位置。
- 改路线规划时注意 `currentUserPoint` 必须先存在，否则无法搜索附近地点。

联调前：

- 如果要调本地后端，先把 API 地址改到本地或相对路径。
- 如果使用云端后端，要确认 Render 服务未休眠或能被唤醒。
- 网络失败时前端会提示“请确保后端服务已启动”，但这不一定准确，因为当前请求可能是云端地址。

## 10. 建议的下一步

建议优先做这几件小而关键的工程整理：

1. 已完成：新增 `.gitignore`，忽略 `__pycache__/` 和 `*.pyc`。
2. 已完成：新增 `requirements.txt`。
3. 已完成：把硅基流动 API Key 改为环境变量。
4. 把前端 API 地址改为可配置，支持本地和云端切换。
5. 给后端 JSON 解析和异常情况补更稳的处理。
6. 用 `textContent` 或安全渲染函数替换直接拼接用户/模型文本的 `innerHTML`。
