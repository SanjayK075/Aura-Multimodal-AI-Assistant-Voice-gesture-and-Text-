"""Measure the assistant: how often it does the right thing, and how fast.

Runs 30 fixed questions through the live backend exactly as the website does,
then reports task success, tool-choice accuracy and response times. These are
the numbers to quote on a resume or in an interview.

    cd backend
    .venv\\Scripts\\activate            (Windows; on macOS/Linux: source .venv/bin/activate)
    python ..\\eval\\run_eval.py

Options:
    --url URL       backend address (default http://localhost:8000)
    --delay SEC     pause between questions, to stay inside free rate limits (default 8)
    --only ID,...   run only these case ids
    --city NAME     default city sent with each request (default Chennai)
    --github NAME   GitHub username sent with each request (default octocat)

A case passes when all of these hold:
  * the request finished without an error
  * the answer is not empty
  * every tool in expect_tools was called (or no tool at all, for expect_no_tools)
  * at least min_tool_calls calls were made, when given
  * the answer contains one of answer_any, when given
  * for expect_tool_failure cases, the tool failed and the assistant still answered
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

HERE = Path(__file__).resolve().parent


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


async def ask(client: httpx.AsyncClient, url: str, body: dict[str, Any], client_id: str) -> dict[str, Any]:
    """Send one question and collect what came back, with timings."""
    started = time.perf_counter()
    result: dict[str, Any] = {
        "tools": [], "text": "", "error": None, "retry_after": None,
        "first_token_s": None, "total_s": None, "conversation_id": None, "steps": None,
    }
    try:
        async with client.stream(
            "POST", f"{url}/api/chat", json=body, headers={"X-Client-Id": client_id}
        ) as response:
            if response.status_code != 200:
                raw = await response.aread()
                try:
                    message = json.loads(raw).get("message", "")
                except ValueError:
                    message = raw.decode(errors="replace")[:200]
                result["error"] = f"HTTP {response.status_code}: {message}"
                result["retry_after"] = float(response.headers.get("retry-after") or 0) or None
                return result
            event = "message"
            async for line in response.aiter_lines():
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                    if event == "meta":
                        result["conversation_id"] = data["conversation_id"]
                    elif event == "delta" and result["first_token_s"] is None:
                        result["first_token_s"] = time.perf_counter() - started
                    elif event == "reset":
                        result["first_token_s"] = None
                    elif event == "tool":
                        result["tools"].append({"name": data["name"], "ok": data["ok"], "ms": data["duration_ms"]})
                    elif event == "done":
                        result["text"] = data["text"]
                        result["steps"] = data["steps"]
                        result["model"] = data.get("model")
                    elif event == "error":
                        result["error"] = data.get("message", "error")
                        result["retry_after"] = data.get("retry_after")
    except httpx.HTTPError as exc:
        result["error"] = f"Could not reach the backend: {exc.__class__.__name__}"
    result["total_s"] = time.perf_counter() - started
    return result


def judge(case: dict[str, Any], result: dict[str, Any]) -> tuple[bool, bool, str]:
    """Returns (passed, right_tools, reason-if-failed)."""
    called = [t["name"] for t in result["tools"]]
    if case.get("expect_no_tools"):
        right_tools = not called
    else:
        wanted = case.get("expect_tools", [])
        right_tools = all(name in called for name in wanted) and len(called) >= case.get("min_tool_calls", 0)

    if result["error"]:
        return False, right_tools, result["error"]
    if not result["text"].strip():
        return False, right_tools, "empty answer"
    if not right_tools:
        if case.get("expect_no_tools"):
            expected = "no tools"
        else:
            expected = ", ".join(case.get("expect_tools", []))
            if case.get("min_tool_calls"):
                expected += f" at least {case['min_tool_calls']} times"
        return False, False, f"expected {expected}; called {', '.join(called) or 'none'}"
    if case.get("expect_tool_failure") and all(t["ok"] for t in result["tools"]):
        return False, right_tools, "the tool was expected to fail but succeeded"
    wanted_words = case.get("answer_any")
    if wanted_words and not any(w.lower() in result["text"].lower() for w in wanted_words):
        return False, right_tools, f"answer mentions none of {wanted_words}"
    return True, right_tools, ""


async def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the Aura assistant.")
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--delay", type=float, default=8.0)
    parser.add_argument("--only", default="")
    parser.add_argument("--city", default="Chennai")
    parser.add_argument("--github", default="octocat")
    args = parser.parse_args()
    url = args.url.rstrip("/")

    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    if args.only:
        wanted = {c.strip() for c in args.only.split(",")}
        needed = wanted | {c["after"] for c in cases if c["id"] in wanted and c.get("after")}
        cases = [c for c in cases if c["id"] in needed]

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        try:
            config = (await client.get(f"{url}/api/config")).json()
        except (httpx.HTTPError, ValueError):
            print(f"Can't reach the backend at {url}. Start it first:  uvicorn app.main:app")
            return 2
        print(f"Backend: {url}   model: {config['provider']} / {config['model']}")
        if config.get("demo"):
            print("NOTE: the backend is in demo mode (no API key). These results measure the keyword")
            print("      router, not a language model. Add a key to backend/.env for real numbers.")
        if config.get("sample_data"):
            print("NOTE: OFFLINE_SAMPLE_DATA is on, so tool timings exclude real network calls.")
        print(f"Running {len(cases)} cases, {args.delay:g}s apart.\n")

        client_id = f"eval-{uuid.uuid4().hex[:16]}"
        prefs = {"default_city": args.city, "github_username": args.github, "news_region": "IN",
                 "units": "metric", "timezone": "Asia/Kolkata"}
        conversations: dict[str, str] = {}
        rows: list[dict[str, Any]] = []

        for index, case in enumerate(cases):
            body = {"message": case["question"], "prefs": prefs,
                    "conversation_id": conversations.get(case.get("after", ""))}
            result = await ask(client, url, body, client_id)
            if result["error"] and result["retry_after"] and result["retry_after"] <= 90:
                # Rate limited: wait as asked and give the case one more chance.
                print(f"      rate limited, waiting {result['retry_after']:.0f}s")
                await asyncio.sleep(result["retry_after"] + 1)
                result = await ask(client, url, body, client_id)
            if result["conversation_id"]:
                conversations[case["id"]] = result["conversation_id"]
            passed, right_tools, reason = judge(case, result)
            rows.append({**case, **result, "passed": passed, "right_tools": right_tools, "reason": reason})
            total = f"{result['total_s']:.1f}s" if result["total_s"] else "  -  "
            print(f"[{'PASS' if passed else 'FAIL'}] {case['id']:<16} {total:>6}  "
                  f"{', '.join(t['name'] for t in result['tools']) or 'no tools'}"
                  + (f"\n      {reason}" if reason else ""))
            if index < len(cases) - 1:
                await asyncio.sleep(args.delay)

        await client.delete(f"{url}/api/conversations", headers={"X-Client-Id": client_id})

    # ---- summary --------------------------------------------------------------
    finished = [r for r in rows if not r["error"]]
    totals = [r["total_s"] for r in finished if r["total_s"]]
    first = [r["first_token_s"] for r in finished if r["first_token_s"]]
    tool_ms = [t["ms"] for r in rows for t in r["tools"] if t["ok"]]
    passed = sum(r["passed"] for r in rows)
    right = sum(r["right_tools"] for r in rows)
    summary = {
        "date": time.strftime("%Y-%m-%d %H:%M"),
        "provider": config["provider"],
        "model": config["model"],
        "demo_mode": bool(config.get("demo")),
        "sample_data": bool(config.get("sample_data")),
        "cases": len(rows),
        "passed": passed,
        "task_success_pct": round(100 * passed / len(rows), 1),
        "tool_choice_accuracy_pct": round(100 * right / len(rows), 1),
        "median_response_s": round(statistics.median(totals), 2) if totals else None,
        "p95_response_s": round(percentile(totals, 0.95), 2) if totals else None,
        "median_first_token_s": round(statistics.median(first), 2) if first else None,
        "median_tool_call_ms": round(statistics.median(tool_ms)) if tool_ms else None,
        "tool_calls": sum(len(r["tools"]) for r in rows),
    }
    by_category: dict[str, list[bool]] = {}
    for row in rows:
        by_category.setdefault(row["category"], []).append(row["passed"])

    print("\nSummary")
    print("-------")
    print(f"Task success          {summary['passed']}/{summary['cases']} ({summary['task_success_pct']}%)")
    print(f"Tool-choice accuracy  {right}/{len(rows)} ({summary['tool_choice_accuracy_pct']}%)")
    print(f"Median response time  {summary['median_response_s']} s   (95th percentile {summary['p95_response_s']} s)")
    print(f"Median time to first word  {summary['median_first_token_s']} s")
    print(f"Median tool call      {summary['median_tool_call_ms']} ms over {summary['tool_calls']} calls")
    print("By category: " + ", ".join(f"{name} {sum(v)}/{len(v)}" for name, v in by_category.items()))

    out = HERE / "results"
    out.mkdir(exist_ok=True)
    (out / "latest.json").write_text(json.dumps({"summary": summary, "cases": rows}, indent=2), encoding="utf-8")
    lines = [
        f"# Evaluation results ({summary['date']})",
        "",
        f"Model: `{summary['provider']} / {summary['model']}`"
        + ("  (demo mode: keyword router, no language model)" if summary["demo_mode"] else "")
        + ("  (sample data: no real API calls)" if summary["sample_data"] else ""),
        "",
        "| Measure | Result |",
        "|---|---|",
        f"| Task success | {summary['passed']} of {summary['cases']} ({summary['task_success_pct']}%) |",
        f"| Tool-choice accuracy | {summary['tool_choice_accuracy_pct']}% |",
        f"| Median response time | {summary['median_response_s']} s |",
        f"| 95th percentile response time | {summary['p95_response_s']} s |",
        f"| Median time to first word | {summary['median_first_token_s']} s |",
        f"| Median tool call | {summary['median_tool_call_ms']} ms |",
        "",
        "| Case | Category | Result | Time | Tools called | Note |",
        "|---|---|---|---|---|---|",
    ]
    for row in rows:
        time_text = f"{row['total_s']:.1f} s" if row["total_s"] else ""
        tools = ", ".join(t["name"] for t in row["tools"]) or "none"
        lines.append(f"| {row['id']} | {row['category']} | {'pass' if row['passed'] else 'FAIL'} | {time_text} | {tools} | {row['reason']} |")
    (out / "latest.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nSaved to {out / 'latest.md'} and latest.json")
    return 0 if passed == len(rows) else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass
    sys.exit(asyncio.run(main()))
