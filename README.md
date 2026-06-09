# 徐汇区 AI Citywalk 伴游助手

这是一个面向上海徐汇区 Citywalk 场景的 Web 小项目。页面左侧是路线定位和规划面板，中间是百度地图，底部是 AI 导游聊天窗口。

用户可以先选择自己的起点，再和 AI 导游“小徐”聊天。如果用户提出类似“想喝咖啡，再看看老洋房”这样的需求，系统会提取关键词，在附近搜索地点，并把合适的 POI 串成一条步行路线。

## 现在能做什么

- 在百度地图上展示徐汇区附近路线。
- 输入地名后，前端用百度地图 SDK 搜索候选地点。
- 候选下拉项展示 POI 名称和详细地址。
- 点击候选地点后，把该地点坐标作为新的起点，并自动重画路线。
- 和 AI 导游“小徐”聊天，询问徐汇区文化、建筑、美食和路线建议。
- 当聊天内容包含路线需求时，后端会让模型返回关键词，前端再调用百度地图搜索附近 POI。
- 对搜索到的 POI 做一次 AI 过滤，尽量保留适合步行游览的地点。

## 技术栈

- 前端：原生 HTML、CSS、JavaScript
- 地图：百度地图 JSAPI GL
- 后端：FastAPI
- HTTP 客户端：httpx
- 模型服务：硅基流动 Chat Completions API
- 配置读取：python-dotenv

## 项目结构

```text
dachuangX/
├── main.py                  # FastAPI 后端入口
├── 1.html                   # 单页前端
├── requirements.txt         # Python 依赖
├── PROJECT_EXPERIENCE.md    # 项目经验文档，后续开发前可先看
├── GITHUB_README.md         # GitHub README 草稿
├── .env                     # 本地密钥文件，不要提交
├── .gitignore
└── __pycache__/             # Python 生成文件
```

## 本地运行

先进入项目目录：

```powershell
cd C:\PythonProjects\codex\dachuangX
```

安装依赖：

```powershell
python -m pip install -r requirements.txt
```

在项目根目录创建 `.env`，写入硅基流动 API Key：

```env
SILICONFLOW_API_KEY=你的硅基流动key
```

启动服务：

```powershell
python -m uvicorn main:app --reload
```

浏览器打开：

```text
http://127.0.0.1:8000/
```

如果直接运行 `uvicorn main:app --reload` 提示找不到命令，用 `python -m uvicorn main:app --reload` 更稳。

## 使用流程

1. 打开页面后，左侧定位框默认是“上海图书馆”。
2. 在定位框输入一个地点，停顿约 300ms 后会出现候选列表。
3. 点击候选地点，系统会把它作为“我的位置”，并重新绘制默认路线。
4. 在底部聊天框里向“小徐”提问。
5. 如果问题是路线类需求，例如“我想喝咖啡，再看看老洋房”，系统会搜索附近地点并规划路线。
