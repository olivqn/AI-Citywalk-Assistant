"""Render a comparison from saved synthetic evidence, with no provider calls."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from intent_cases import all_cases, assess, canonical, value_at


def read(path):
    records = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    return records[0], {r["id"]: r for r in records if r.get("type") == "case"}


def raw_changes(record, version):
    raws = record.get("raw_model_outputs", [])
    if not raws or "unparsed_model_content" in raws[-1]:
        return None
    raw = raws[-1]
    final = canonical(record["output"], version)
    paths = [key for key in ("intent", "modification", "relative_goals", "clear_fields", "selection_mode") if key in raw]
    paths += ["trip_state." + key for key, value in (raw.get("trip_state") or {}).items()
              if value is not None and value != [] and value != ""]
    changes = []
    for path in paths:
        first, last = value_at(raw, path), value_at(final, path)
        if isinstance(first, dict) and isinstance(last, dict):
            differs = any(last.get(key) != value for key, value in first.items())
        else:
            differs = first != last
        if differs:
            changes.append(path)
    return changes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default="intent-eval/before.jsonl")
    parser.add_argument("--after", required=True)
    parser.add_argument("--output", default="INTENT_EVALUATION_2026-09-09.md")
    args = parser.parse_args()
    fixtures = all_cases()
    meta_b, before = read(ROOT / args.before)
    meta_a, after = read(ROOT / args.after)
    if meta_b["fixtures_sha256"] != meta_a["fixtures_sha256"]:
        raise SystemExit("Cannot compare different fixture inputs")
    if set(before) != {i["id"] for i in fixtures} or set(after) != set(before):
        raise SystemExit("Incomplete comparison")
    scored = {}
    for name, records in (("before", before), ("after", after)):
        scored[name] = {item["id"]: assess(item, records[item["id"]]["output"], name) for item in fixtures}
    n_before = sum(not f for f in scored["before"].values())
    n_after = sum(not f for f in scored["after"].values())
    originals = [item["id"] for item in fixtures[:18]]
    cores = [item["id"] for item in fixtures[18:]]
    regressions = [id for id in originals if not scored["before"][id] and scored["after"][id]]
    mutations = {id: raw_changes(after[id], "after") for id in after}
    mutated = {id: paths for id, paths in mutations.items() if paths}
    lines = ["# AI 意图模块独立测评（2026-09-09）", "",
             f"最终对照：旧模块 **{n_before}/30**，新模块 **{n_after}/30**。", "",
             "仅直接调用意图模块和 DeepSeek V4 Flash，未启动网页、未调用地图、未测试路线生成。这里的通过指关键字段符合预先定义的期望，不代表地图可行或任意问法都稳定。", "",
             "## 验收", "",
             f"- 原 18 轮：旧模块 {sum(not scored['before'][id] for id in originals)}/18，新模块 {sum(not scored['after'][id] for id in originals)}/18。",
             f"- 四类核心需求各三次：新模块 {sum(not scored['after'][id] for id in cores)}/12。",
             f"- 相比旧模块新增的原题退步：{'、'.join(regressions) if regressions else '未观察到'}。",
             f"- 新模块最后一次模型输出的显式语义字段与最终输出差异：{json.dumps(mutated, ensure_ascii=False) if mutated else '未发现覆盖改写（默认值补齐、状态合并与执行状态校验不算改写）'}。", "",
             "## 逐题对照", "", "| 编号 | 原题/核心输入 | 旧模块 | 新模块 |", "| --- | --- | --- | --- |"]
    for item in fixtures:
        id = item["id"]
        old = "通过" if not scored["before"][id] else "未通过"
        new = "通过" if not scored["after"][id] else "未通过"
        lines.append(f"| {id} | {item['request']['message']} | {old} | {new} |")
    lines += ["", "## 失败项详情", ""]
    for name in ("before", "after"):
        lines.append(f"### {'旧模块' if name == 'before' else '新模块'}")
        lines.append("")
        failures = {id: failures for id, failures in scored[name].items() if failures}
        if not failures:
            lines.append("本轮未发现关键字段失败。")
        for id, failures in failures.items():
            lines.append(f"- {id}：" + "；".join(failures))
        lines.append("")
    lines += ["## 迭代记录与限制", "",
              "不是首版一次通过。下面保留每一轮失败证据，按最终同一评分器重新统计；首轮 A1 还发现缺起点未明确追问，评分器随后补充该检查。", "",
              "| 版本 | 通过 | 重试请求数 |", "| --- | --- | --- |"]
    total_requests = len(before)
    for path in sorted((ROOT / "intent-eval").glob("after-v*.jsonl")):
        meta, records = read(path)
        score = sum(not assess(item, records[item["id"]]["output"], "after") for item in fixtures if item["id"] in records)
        retries = sum(r["output"].get("attempts", 0) > 1 for r in records.values())
        lines.append(f"| {path.name} | {score}/{len(records)} | {retries} |")
        total_requests += len(records)
    lines += ["", "- 提示词迭代处理了过度追问、新指定地点被误认为只能选旧站、排除条件漏填、调序抄回旧顺序、距离严格边界，以及不现实主题的合理替代。没有添加按题目关键词修复结果的本地规则。",
              "- v4 字段虽已通过，人工读原始输出发现 A4 擅自生成未提供来源的历史/入内信息，D2 还重复追问起点。v5 进一步限定讲解只识别查询意图，不抢答事实；字段评分不等于文案事实核验。",
              f"- 本次保存 {total_requests} 个合成测评请求的证据，包含基线和所有提示词迭代复测；自动重试会增加供应商调用数，旧模块本地抢答则不调用模型。",
              "- 旧模块不支持新增的数量和比较字段，因此差异同时体现协议补齐与语义理解改进，不能解释为模型本身的通用能力提升。",
              "- 题目是固定合成上下文，不回放地图。新输出不影响下一题；旧接口无法接受的新字段不会被强行注入。",
              "- 同一模型、相同温度 0.2 和相同重试机制；新模块包含更完整的输出协议和当前路线度量。测试题用于迭代，不是留出集，最终一次全过也不是统计成功率。",
              "- 中间失败未删除。若未来做泛化评估，需另设同义表达、复合约束和独立留出集；本阶段没有做完整网页流程或这类额外实测。", "",
              "## 证据和复现", "",
              f"- [旧模块原始记录]({(ROOT / args.before).as_posix()})",
              f"- [最终新模块原始记录]({(ROOT / args.after).as_posix()})",
              f"- [模块字段与运行方法]({(ROOT / 'INTENT_MODULE.md').as_posix()})", "",
              "每条 JSONL 含固定输入、期望字段、模型原始输出、模块最终输出、请求耗时与失败项。无密钥；未提交或推送 GitHub。", ""]
    path = (ROOT / args.output).resolve()
    if not path.is_relative_to(ROOT):
        raise SystemExit("Report must stay in workspace")
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Report: {path}; before={n_before}/30 after={n_after}/30 regressions={regressions} raw_changes={mutated}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
