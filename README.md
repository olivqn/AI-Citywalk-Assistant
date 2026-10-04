# 徐汇区 AI Citywalk 伴游助手

这是一个面向上海徐汇区 Citywalk 场景的 Web 小项目。页面左侧是路线定位和规划面板，中间是百度地图，底部是 AI 导游聊天窗口。

用户可以先选择起点，再和 AI 导游“小徐”聊天。用户提出“想喝咖啡，再看看老洋房”等需求后，系统会提取关键词，在附近搜索地点，并把合适的 POI 串成一条步行路线。

## 线上演示与后端状态

演示入口：[AI Citywalk 伴游助手](https://ai-citywalk-assistant.onrender.com/)。前端页面和 FastAPI 后端由同一个 Render Web Service 提供。

**最近核验：2026-10-04（北京时间）。** 以下为实际 HTTP 请求结果，只代表此次检查时的状态，不保证持续可用。

| 检查项 | 结果 |
| --- | --- |
| `GET /` | HTTP 200，返回 Citywalk 页面 |
| `GET /openapi.json` | HTTP 200，包含聊天和地点筛选接口 |
| `POST /api/chat`，普通问答 | HTTP 200，返回正常的徐汇区介绍，没有返回后端错误提示 |
| `POST /api/chat`，路线需求 | HTTP 200，返回 `action: "plan_route"` 和 `keywords: ["咖啡", "老洋房"]` |
| `POST /api/filter_pois` | HTTP 200，从“武康大楼、上海图书馆、停车场”中筛出“武康大楼” |
| 聊天接口跨域预检 | HTTP 200，允许来自 `http://127.0.0.1:8000` 的 JSON POST 请求 |

此次检查验证了页面和 AI 接口；未实测浏览器内百度地图加载及完整步行路线流程。线上返回的 HTML 与提交 `16e7b3e` 中的 `1.html` 内容一致，尚未包含 main 分支后续新增的地点候选下拉功能；这只能确认页面版本，不能确定整个后端的部署提交。

首次页面请求在 25 秒后超时，重试后成功。若使用 Render 免费实例，闲置后的唤醒可能需要约一分钟，参见 [Render 免费服务说明](https://render.com/docs/free#spinning-down-on-idle)。未读取此服务的套餐或部署日志，不能确定首次超时的原因。

## 现在能做什么

以下描述对应仓库当前代码；线上旧页面的功能差异见上文。

- 在百度地图上展示徐汇区附近路线。
- 输入地名后，前端用百度地图 SDK 搜索候选地点。
- 候选下拉项展示 POI 名称和详细地址。
- 点击候选地点后，把该地点坐标作为新的起点，并自动重画路线。
- 和 AI 导游“小徐”聊天，询问徐汇区文化、建筑、美食和路线建议。
- 当聊天内容包含路线需求时，后端会让模型返回关键词，前端再调用百度地图搜索附近 POI。
- 对搜索到的 POI 做一次 AI 过滤，尽量保留适合步行游览的地点。

## 实际架构与调用链

| 部分 | 职责与调用方式 |
| --- | --- |
| FastAPI `GET /` | 返回项目根目录的 `1.html`，不需要单独的前端服务器或构建步骤 |
| 浏览器 → `POST /api/chat` | 发送 `message` 和 `history`；后端调用硅基流动，返回普通 `reply` 或路线指令及关键词 |
| 浏览器 → 百度地图 JSAPI GL | 完成地点候选、地理编码、周边 POI 搜索和步行路线绘制，不经过 FastAPI |
| 浏览器 → `POST /api/filter_pois` | 发送 `poi_names`、`user_message` 和 `history`；后端调用小模型筛选地点 |
| 前端路线规划 | 对保留地点按距离贪心排序，最多选择 5 个景点，再用百度地图绘制步行路线；4 km 限制按直线距离估算，非实际步行里程 |

两个前端 API 地址均使用同源路径：`/api/chat` 和 `/api/filter_pois`。从本地页面打开时请求本地 FastAPI，从 Render 页面打开时请求 Render 后端，切换部署环境无需修改域名。

此前代码将这两个地址固定为 Render URL，导致即使按照 README 在本地启动，AI 请求仍发送到云端。本次改为同源路径；线上现有页面仍使用旧的固定地址，需要部署本次修改后才会更新。若要将前端和后端分别部署在不同域名，需要同时调整两个 API 地址及后端 CORS 配置；本文默认采用同源部署。

后端模型在 `main.py` 中配置：聊天使用 `Qwen/Qwen3.5-122B-A10B`，地点筛选使用 `Qwen/Qwen3.5-27B`。聊天历史保存在浏览器页面内存中，刷新即重置；仓库没有数据库或用户账号系统。

## 技术栈

- 前端：原生 HTML、CSS、JavaScript
- 地图：百度地图 JSAPI GL
- 后端：FastAPI
- HTTP 客户端：httpx
- 模型服务：硅基流动 Chat Completions API
- 配置读取：python-dotenv

## 项目结构

```text
AI-Citywalk-Assistant/
├── main.py                  # FastAPI 后端入口
├── 1.html                   # 单页前端
├── requirements.txt         # Python 依赖
├── README.md
└── .gitignore
```

`.env` 需要自行创建，不属于仓库文件。

## 本地运行

准备 Python 环境，克隆仓库并进入根目录：

```sh
git clone https://github.com/olivqn/AI-Citywalk-Assistant.git
cd AI-Citywalk-Assistant
```

安装依赖：

```sh
python -m pip install -r requirements.txt
```

在项目根目录创建 `.env`，写入硅基流动 API Key：

```env
SILICONFLOW_API_KEY=你的硅基流动key
```

Key 只保存在后端环境变量或 `.env` 中，不要写进 HTML 或提交到 Git。需确保账户余额和上述模型的调用权限正常。

`1.html` 的百度地图 SDK 脚本目前包含一个浏览器端 `ak`。自行部署时请替换为自己的百度地图浏览器端 AK，并配置允许访问的来源，包括本地测试地址及实际部署域名。地图 AK 与硅基流动 Key 是两种不同配置；地图 SDK 加载失败会影响页面脚本执行。

在项目根目录启动服务（`GET /` 通过相对路径读取 `1.html`）：

```sh
python -m uvicorn main:app --reload
```

浏览器打开：

```text
http://127.0.0.1:8000/
```

此时两个 AI 接口都请求 `http://127.0.0.1:8000`。请通过 FastAPI 页面入口访问，不要直接双击 `1.html`，也不要用另一个静态服务器打开它。

“本地运行”指应用服务在本机运行；百度地图和硅基流动仍需要联网。没有硅基流动 Key 时，页面可能可以打开，但 AI 功能不能正常工作。

## Render 部署方式

以下是适配当前仓库的部署配置，参见 [Render 官方 FastAPI 部署文档](https://render.com/docs/deploy-fastapi)；不表示已读取或修改现有服务的后台配置。

| 配置项 | 值 |
| --- | --- |
| 服务类型 | Web Service |
| 运行环境 | Python 3 |
| 部署分支 | `main`（修改合并后再部署） |
| 工作目录 | 仓库根目录 |
| Build Command | `python -m pip install -r requirements.txt` |
| Start Command | `python -m uvicorn main:app --host 0.0.0.0 --port $PORT` |
| 环境变量 | `SILICONFLOW_API_KEY`，填入有效 Key |

部署后打开 Render 提供的根地址 `/`，页面与两个 API 使用相同域名。更新现有服务时，确认部署成功，并检查返回页面是否包含地点候选功能和新的同源 API 地址；仓库提交更新不等于线上已部署更新。

## 接口复核与排障

页面打开成功或 HTTP 200 并不能单独证明模型可用：`/api/chat` 在模型异常时仍可能返回 HTTP 200 和错误文本，`/api/filter_pois` 在模型异常时会返回原始地点列表。

可在 Bash 中运行以下请求；改为本地验证时，将域名替换为 `http://127.0.0.1:8000`：

```sh
curl --max-time 120 https://ai-citywalk-assistant.onrender.com/openapi.json

curl --max-time 120 https://ai-citywalk-assistant.onrender.com/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好，请用一句话介绍上海徐汇区。","history":[]}'

curl --max-time 120 https://ai-citywalk-assistant.onrender.com/api/filter_pois \
  -H 'Content-Type: application/json' \
  -d '{"poi_names":["武康大楼","上海图书馆","停车场"],"user_message":"想看看老洋房","history":[]}'
```

- 聊天应返回有效 `reply`；路线需求应返回 `action: "plan_route"` 和关键词。若返回“AI 导游暂时无法回复”，检查后端的 Key、余额、模型权限和日志。
- 地点筛选应返回 `filtered_names`。如果列表原样返回，不能据此断定模型正常，应结合输入意图和后端日志判断是否触发降级。
- 页面或接口超时可稍后重试；持续失败时检查 Render 服务状态、部署日志和启动命令。
- 地图空白或报 `BMapGL` 错误时，检查地图 SDK 的网络请求、AK 及来源限制。

## 使用流程

1. 打开页面后，左侧定位框默认是“上海图书馆”。
2. 在定位框输入一个地点，停顿约 300ms 后会出现候选列表。
3. 点击候选地点，系统会把它作为“我的位置”，并重新绘制默认路线。
4. 在底部聊天框里向“小徐”提问。
5. 如果问题是路线类需求，例如“我想喝咖啡，再看看老洋房”，系统会搜索附近地点并规划路线。
