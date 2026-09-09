# 独立 AI 意图理解模块

这一阶段只验证“用户说了什么 → 输出哪些查询/修改条件”。没有调用地图，没有切换网页的 `/api/chat`，也没有实现景点数量约束的路线执行器。

景点讲解类输入也仅识别查询意图，在 `interpretation` 中记录待查询的地点和问题；不在本模块生成没有事实资料支持的景点故事或开放信息。

## 接口

新增 `POST /api/intent`，或在 Python 中调用 `intent_module.understand(IntentRequest(...))`。与旧模块仅共用 DeepSeek V4 Flash 的请求、超时与重试机制；不调用旧的需求规则、备用意图判断或地点检索。

请求包括：

- `message`：本轮消息；`history`：最多取最近 12 条用户/助手历史。
- `trip_state`：已生效的行程条件，不是未执行的模型建议。
- `current_route.places`：按实际顺序列出的游览停靠点，不含起点；`stop_count` 必须等于列表长度。终点仅作为游览停靠点时计一次。
- `current_route.total_distance_meters`：完整路线实际步行距离；不知道时传 `null`，不能用搜索半径或直线距离冒充。
- 可选的 `estimated_duration_minutes`、`can_undo`、`can_restore_initial` 用于提供事实和前置条件。

例如，在当前三个景点、步行 2100 米的路线中输入“景点数量不变，总距离短一点”：

```json
{
  "message": "景点数量不变，总距离短一点",
  "trip_state": {"start": "上海图书馆", "duration_minutes": 120},
  "current_route": {
    "places": ["罗密欧阳台", "淮海中路1768弄优秀历史建筑", "安福路"],
    "stop_count": 3,
    "total_distance_meters": 2100
  }
}
```

期望 `proposal.relative_goals` 为 `{"distance":"decrease","stop_count":"unchanged"}`，而不是擅自减少一站或指定缩短百分比。

## 输出字段

| 字段 | 含义 |
| --- | --- |
| `status` | `ready`：理解完成；`needs_clarification`：还需澄清或字段存在冲突；`unavailable`：模型本轮未完成 |
| `proposal` | AI 的意图、稀疏条件更新、动作、检索词及说明。不可作为执行成功证明 |
| `trip_state` | 合并本轮提议后的条件，仍未生效；上层必须在后续执行成功后才提交 |
| `comparison_baseline` | 原样复制当前已生效路线作为相对比较基准 |
| `action` | 仅在就绪且需规划/修改时输出；其余为 `null` |
| `validation_issues` | 程序检查到的字段/前置条件矛盾，不是程序对原话的再理解 |
| `attempts` / `recovered` / `failure_reason` | 请求次数、重试是否恢复及安全失败分类 |

新增的行程字段：

| 字段 | 规则 |
| --- | --- |
| `min_stops` / `max_stops` | 非负整数。“大于 3 个”是 `min_stops=4`；“至少 3 个”是 `3`；恰好 N 同时设置上下限 N |
| `max_walk_meters` | 米，正数，上限 50000；不暗中把“更近”换成一个绝对上限 |
| `max_walk_inclusive` | `<` 为 `false`；`≤`（以内、不超过）为 `true`。设置新上限时必须一起输出 |
| `proposal.relative_goals.distance` / `.stop_count` | 分别是 `increase`、`decrease`、`unchanged` 或 `null`；未提出的维度必须为空 |
| `proposal.selection_mode` | `only_specified` 表示仅指定地点，`recommend` 表示推荐路线 |
| `proposal.modification.value_kind` | 新地点目标是具体 `place` 还是检索 `category`；序号由 AI 转成当前路线的完整地点名 |
| `proposal.modification.operation` | 保留原动作，增加 `adjust_constraints` 表达数量/距离条件更新，不绑定删站或加站策略 |

条件更新只接受已声明字段。未填写、`null` 或空数组表示保持；明确取消使用 `clear_fields`。列表更新为更新后的完整列表，不自动推断追加意图。取消距离限制同时清空距离数值和包含边界字段。不能同时设置和清空同一个字段。

输入不合法返回接口验证错误。模型格式不合法会重试一次；仍失败时没有备用语义判断，`proposal=null`、`action=null`，原条件保留。相对修改没有基准、数量下限高于上限或明确数字约束相互冲突时不能执行，但保留 AI 提议供说明，不偷偷舍弃约束。

## 复现测试

项目环境安装 `requirements.txt` 后运行（模块使用 Pydantic 2；本次环境为 2.13.5）：

```powershell
python -B -m unittest discover -s tests -p 'test_intent_module.py'
python -B -m unittest discover -s tests -p 'test_*.py'
python -B tests/run_intent_eval.py --version before --output intent-eval/before-rerun.jsonl
python -B tests/run_intent_eval.py --version after --output intent-eval/after-rerun.jsonl
```

真实测评需本地 `.env` 中配置 `DEEPSEEK_API_KEY`，会产生 API 调用费用。每个完整版本为 30 个测试请求：原来的 18 轮固定输入，加四类核心需求各三次。自动重试可能增加实际供应商调用数。证据文件排他创建，不覆盖历史结果；再次运行请使用新文件名。

每个原题有固定的历史和当前路线，结果不会传给下一题。C5 特别加入“终点设置失败”的历史，检查失败条件是否被复活。旧模块不支持的新输入字段不会被强行注入旧协议；旧接口缺少的数量/比较输出会被如实计为不支持。

`raw_model_outputs` 保存解析前的模型 JSON（包括重试失败输出），`output` 保存模块最终结果。只有这些合成测评显式启用记录；普通 `/api/intent` 不存用户对话，不在日志输出请求正文或密钥。证据保存模型名、代码与输入摘要、耗时和逐字段失败项。

自动测试主要证明协议、校验、重试和“不用规则覆盖模型”。其中模拟输出的测试不能证明真实模型理解了单位、否定或其他任意表达。语言准确性结论只来自真实测评题；这些题用于提示词迭代，不是独立留出测试集，也不代表统计成功率。

## 后续接入边界

当前网页仍使用旧模块，因此页面体验不会随此次模块改动立即变化。新接口的 `ready` 仅表示可以交给后续检索/路线执行器，并不保证在指定距离内找到足够景点；特别是数量约束和严格距离边界，必须由后续执行器落实并验收。没有提交或推送 GitHub。
