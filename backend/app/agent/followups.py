"""Suggested next questions, shown as one-tap chips under each answer.

These are picked by simple rules from the tools that just ran, instead of a
second model call, so they cost no quota and appear instantly. Each one is a
complete question, so it works without relying on conversation memory.
"""
from __future__ import annotations

from typing import Any

MAX_SUGGESTIONS = 3


def suggest(tool_runs: list[dict[str, Any]]) -> list[str]:
    """tool_runs: [{name, args, ok, panel}] in the order the tools ran."""
    ideas: list[str] = []
    used = {run["name"] for run in tool_runs}
    # Things already on screen from this answer, so they aren't suggested again.
    shown_issues = {
        (run.get("panel") or {}).get("repo") for run in tool_runs if run["name"] == "github_repo_issues" and run.get("ok")
    }
    shown_users = {
        str((run.get("panel") or {}).get("username", "")).lower()
        for run in tool_runs
        if run["name"] == "github_user_repos" and run.get("ok")
    }

    for run in tool_runs:
        if not run.get("ok"):
            continue
        name, args, panel = run["name"], run.get("args") or {}, run.get("panel") or {}

        if name == "get_weather":
            city = (panel.get("location") or {}).get("name") or args.get("city") or "there"
            if int(args.get("days") or 3) < 7:
                ideas.append(f"7-day forecast for {city}")
            ideas.append(f"News about {city}")
            ideas.append(f"Tell me about {city}")
        elif name == "github_user_repos":
            items = panel.get("items") or []
            if items and items[0]["full_name"] not in shown_issues:
                ideas.append(f"Open issues in {items[0]['full_name']}")
            username = panel.get("username") or args.get("username")
            if username and args.get("sort") != "stars":
                ideas.append(f"Show {username}'s most starred repositories")
        elif name == "github_repo_issues":
            owner = str(panel.get("repo") or "").split("/")[0]
            if owner and owner.lower() not in shown_users:
                ideas.append(f"Show repositories by {owner}")
            if args.get("state") != "closed" and panel.get("repo"):
                ideas.append(f"Closed issues in {panel['repo']}")
        elif name == "get_news":
            topic = args.get("topic")
            if topic:
                ideas.append(f"Tell me about {topic}")
                ideas.append("Top headlines")
            else:
                ideas.extend(["Technology news", "Science news"])
        elif name == "wikipedia_summary":
            title = panel.get("title")
            if title:
                ideas.append(f"Latest news about {title}")
        elif name == "get_space_picture":
            ideas.extend(["Which satellites are above me right now?", "Tell me about the Hubble telescope"])

        elif name == "get_air_quality":
            city = (panel.get("location") or {}).get("name") or args.get("city") or "there"
            ideas.extend([f"Weather in {city}", f"Is it good to run outside in {city}?"])
        elif name == "get_satellites":
            ideas.extend(["Which satellites are above me right now?", "Show the Starlink satellites"] if not args.get("city") else ["Show the space stations"])
        elif name == "web_search":
            ideas.extend(["Summarise the top result", "Latest news on this"])
        elif name in ("remember", "list_memories", "forget_memory"):
            ideas.extend(["What do you remember about me?", "Compare the weather in two cities"])

    if not tool_runs:
        ideas.extend(["Explain that more simply", "Give me an example"])

    unique: list[str] = []
    for idea in ideas:
        if idea not in unique:
            unique.append(idea)
    return unique[:MAX_SUGGESTIONS]
