"""Real-provider evaluation of synthetic intent fixtures; no server or map needed.

python -B tests/run_intent_eval.py --version before --output intent-eval/before.jsonl
python -B tests/run_intent_eval.py --version after --output intent-eval/after.jsonl
"""
import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main
from intent_module import IntentRequest, understand
from intent_cases import all_cases, assess


def safe(value):
    text = json.dumps(value, ensure_ascii=False)
    # These are synthetic inputs only; never retain a provider credential even if echoed.
    if main.DEEPSEEK_API_KEY.strip():
        text = text.replace(main.DEEPSEEK_API_KEY, "[REDACTED]")
    return re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[REDACTED]", text)


async def run(args):
    if not main.DEEPSEEK_API_KEY.strip():
        raise SystemExit("DEEPSEEK_API_KEY is not configured; no evaluation was run.")
    destination = (ROOT / args.output).resolve()
    if not destination.is_relative_to(ROOT / "intent-eval"):
        raise SystemExit("Evaluation outputs must be under intent-eval/.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    suite_cases = all_cases
    if args.suite == "holdout":
        from intent_holdout_cases import all_cases as suite_cases
    elif args.suite == "flow":
        from intent_flow_cases import all_cases as suite_cases
    elif args.suite == "companion":
        from intent_companion_cases import all_cases as suite_cases
    elif args.suite == "journey":
        from intent_journey_cases import all_cases as suite_cases
    fixtures = suite_cases()
    if args.ids:
        fixtures = [item for item in fixtures if item["id"] in args.ids.split(",")]
        if not fixtures:
            raise SystemExit("No matching fixture IDs")
    metadata = {"type": "metadata", "version": args.version, "model": main.MODEL_NAME,
                "started_at": datetime.now(timezone.utc).isoformat(), "case_count": len(fixtures),
                "suite": args.suite,
                "fixtures_sha256": hashlib.sha256(safe(suite_cases()).encode()).hexdigest(),
                "main_sha256": hashlib.sha256((ROOT / "main.py").read_bytes()).hexdigest(),
                "intent_sha256": hashlib.sha256((ROOT / "intent_module.py").read_bytes()).hexdigest()}
    passed = 0
    # Exclusive create prevents accidentally replacing prior evidence.
    with destination.open("x", encoding="utf-8") as stream:
        stream.write(safe(metadata) + "\n")
        for item in fixtures:
            raw_outputs = []
            started = time.monotonic()
            req = IntentRequest(**item["request"])
            if args.version == "after":
                output = (await understand(req, runtime=main, trace=raw_outputs.append)).model_dump()
            else:
                original = main._model_content

                def capture(data):
                    # Capture before legacy parsing or semantic overrides, including failed attempts.
                    content, finish = original(data)
                    try:
                        raw_outputs.append(json.loads(content))
                    except (ValueError, TypeError):
                        raw_outputs.append({"unparsed_model_content": content})
                    return content, finish

                main._model_content = capture
                try:
                    legacy_state = {key: val for key, val in req.trip_state.model_dump().items()
                                    if key in main.TripState.model_fields}
                    legacy_req = main.ChatRequest(message=req.message, history=[h.model_dump() for h in req.history],
                                                  trip_state=main.TripState(**legacy_state), route_places=req.current_route.places)
                    output = (await main.chat(legacy_req)).model_dump()
                finally:
                    main._model_content = original
            failures = assess(item, output, args.version)
            passed += not failures
            record = {"type": "case", "id": item["id"], "request": item["request"],
                      "expected": item["expected"], "contains": item["contains"],
                      "raw_model_outputs": raw_outputs, "output": output,
                      "elapsed_seconds": round(time.monotonic() - started, 3), "failures": failures,
                      "passed": not failures}
            stream.write(safe(record) + "\n")
            stream.flush()
            print(f"{args.version} {item['id']}: {'PASS' if not failures else 'FAIL'} "
                  f"({record['elapsed_seconds']}s) " + "; ".join(failures), flush=True)
        print(f"TOTAL {passed}/{len(fixtures)}; evidence: {args.output}", flush=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", choices=["before", "after"], required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--suite", choices=["original", "holdout", "flow", "companion", "journey"], default="original")
    parser.add_argument("--ids", help="Optional comma-separated case IDs for explicitly recorded follow-up runs")
    asyncio.run(run(parser.parse_args()))
