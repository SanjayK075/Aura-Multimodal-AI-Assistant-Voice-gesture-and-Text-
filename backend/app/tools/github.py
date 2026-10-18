"""GitHub's public REST API: a user's repositories and a repository's issues.

Works without a token at 60 requests an hour per IP; set GITHUB_TOKEN for 5,000.
"""
from __future__ import annotations

import re
from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, clip, get_json

API = "https://api.github.com"
_NAME = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$")


def _headers(ctx: ToolContext) -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if ctx.settings.github_token:
        headers["Authorization"] = f"Bearer {ctx.settings.github_token}"
    return headers


def _repo_defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    out = dict(args)
    username = str(out.get("username") or "").strip().lstrip("@")
    out["username"] = username or ctx.prefs.github_username.strip().lstrip("@")
    out["sort"] = "stars" if out.get("sort") == "stars" else "updated"
    return out


async def _user_repos(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    username = args.get("username") or ""
    if not username:
        raise ToolError(
"No GitHub username was named and none is saved. Name a user, or add yours in Settings."
        )
    if not _NAME.match(username):
        raise ToolError(f"'{username}' isn't a valid GitHub username.")

    try:
        repos = await get_json(
            ctx,
            f"{API}/users/{username}/repos",
            source="GitHub",
            params={"sort": "updated", "per_page": 50, "type": "owner"},
            headers=_headers(ctx),
        )
    except ToolError as error:
        if error.status == 404:
            raise ToolError(f"GitHub has no user called '{username}'.", status=404) from error
        raise
    if not isinstance(repos, list):
        raise ToolError("GitHub sent a reply that couldn't be read.")

    items = [
        {
            "name": repo.get("name"),
            "full_name": repo.get("full_name"),
            "description": clip(repo.get("description"), 160),
            "language": repo.get("language") or "",
            "stars": int(repo.get("stargazers_count") or 0),
            "forks": int(repo.get("forks_count") or 0),
            "open_issues": int(repo.get("open_issues_count") or 0),
            "updated_at": repo.get("pushed_at") or repo.get("updated_at"),
            "url": repo.get("html_url"),
            "is_fork": bool(repo.get("fork")),
            "archived": bool(repo.get("archived")),
        }
        for repo in repos
        if isinstance(repo, dict)
    ]
    if args.get("sort") == "stars":
        items.sort(key=lambda r: r["stars"], reverse=True)
    items = items[:20]

    if items:
        top = items[0]
        ordering = "most starred" if args.get("sort") == "stars" else "most recently updated"
        summary = (
            f"{username} has {len(items)}{'+' if len(repos) >= 50 else ''} public repositories. "
            f"The {ordering} is {top['name']}"
            + (f", written in {top['language']}" if top["language"] else "")
            + f", with {top['stars']} stars."
        )
    else:
        summary = f"{username} has no public repositories."

    return ToolResult(
        data={
            "username": username,
            "count": len(items),
            "repositories": [
                {k: r[k] for k in ("full_name", "description", "language", "stars", "open_issues", "updated_at")}
                for r in items[:10]
            ],
            "summary": summary,
        },
        summary=summary,
        source="GitHub",
        source_url=f"https://github.com/{username}",
        panel={
            "type": "github",
            "kind": "repos",
            "title": f"{username}'s repositories",
            "username": username,
            "items": items,
        },
    )


def _issue_defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    out = dict(args)
    repo = str(out.get("repo") or "").strip().removeprefix("https://github.com/").strip("/")
    # "my-repo" on its own means the saved user's repository.
    if repo and "/" not in repo and ctx.prefs.github_username:
        repo = f"{ctx.prefs.github_username.strip().lstrip('@')}/{repo}"
    out["repo"] = repo
    out["state"] = out.get("state") if out.get("state") in ("open", "closed", "all") else "open"
    return out


async def _repo_issues(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    repo = args.get("repo") or ""
    if not _REPO.match(repo):
        raise ToolError("A repository is needed in the form 'owner/name', for example 'fastapi/fastapi'.")
    state = args.get("state", "open")

    try:
        issues = await get_json(
            ctx,
            f"{API}/repos/{repo}/issues",
            source="GitHub",
            params={"state": state, "per_page": 40, "sort": "updated"},
            headers=_headers(ctx),
        )
    except ToolError as error:
        if error.status == 404:
            raise ToolError(f"GitHub has no public repository called '{repo}'.", status=404) from error
        raise
    if not isinstance(issues, list):
        raise ToolError("GitHub sent a reply that couldn't be read.")

    items = [
        {
            "number": issue.get("number"),
            "title": clip(issue.get("title"), 140),
            "state": issue.get("state"),
            "author": (issue.get("user") or {}).get("login") or "",
            "labels": [label.get("name") for label in issue.get("labels") or [] if isinstance(label, dict)][:4],
            "comments": int(issue.get("comments") or 0),
            "updated_at": issue.get("updated_at"),
            "url": issue.get("html_url"),
        }
        for issue in issues
        # This endpoint also returns pull requests; they carry a pull_request key.
        if isinstance(issue, dict) and "pull_request" not in issue
    ][:20]

    label = "" if state == "all" else f"{state} "
    if items:
        summary = (
            f"{repo} has {len(items)}{'+' if len(items) >= 20 else ''} {label}issues listed. "
            f"The most recently updated is number {items[0]['number']}: {items[0]['title']}."
        )
    else:
        summary = f"{repo} has no {label}issues."

    return ToolResult(
        data={
            "repo": repo,
            "state": state,
            "count": len(items),
            "issues": [
                {k: i[k] for k in ("number", "title", "labels", "comments", "updated_at")} for i in items[:10]
            ],
            "summary": summary,
        },
        summary=summary,
        source="GitHub",
        source_url=f"https://github.com/{repo}/issues",
        panel={
            "type": "github",
            "kind": "issues",
            "title": f"Issues in {repo}",
            "repo": repo,
            "state": state,
            "items": items,
        },
    )


TOOLS = [
    Tool(
        name="github_user_repos",
        description=(
            "List a GitHub user's public repositories with stars, language and last update. "
            "Omit username to use the user's own saved GitHub username."
        ),
        parameters={
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "GitHub username, e.g. 'torvalds'."},
                "sort": {
                    "type": "string",
                    "enum": ["updated", "stars"],
                    "description": "Order by most recently updated (default) or most stars.",
                },
            },
        },
        handler=_user_repos,
        ttl_seconds=180,
        defaults=_repo_defaults,
        status_label="Looking at GitHub",
    ),
    Tool(
        name="github_repo_issues",
        description="List issues in a public GitHub repository, most recently updated first.",
        parameters={
            "type": "object",
            "properties": {
                "repo": {
                    "type": "string",
                    "description": "Repository as 'owner/name', e.g. 'fastapi/fastapi'.",
                },
                "state": {
                    "type": "string",
                    "enum": ["open", "closed", "all"],
                    "description": "Which issues to list. Defaults to open.",
                },
            },
            "required": ["repo"],
        },
        handler=_repo_issues,
        ttl_seconds=180,
        defaults=_issue_defaults,
        status_label="Looking at GitHub",
    ),
]
