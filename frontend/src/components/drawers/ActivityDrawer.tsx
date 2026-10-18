import { useEffect, useState } from "react";

import { api, ApiError } from "../../lib/api";
import { median, relativeTime } from "../../lib/format";
import type { ActivityEntry } from "../../store/types";
import { useStore } from "../../store/useStore";

/** Every tool call the agent made: what it called, with what, and how it went. */
export function ActivityDrawer() {
  const revision = useStore((s) => s.serverRevision);
  const config = useStore((s) => s.config);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let current = true;
    api
      .activity()
      .then((list) => {
        if (!current) return;
        setEntries(list);
        setProblem("");
      })
      .catch((error: ApiError) => current && setProblem(error.message));
    return () => {
      current = false;
    };
  }, [revision]);

  const total = entries?.length ?? 0;
  const succeeded = entries?.filter((e) => e.ok).length ?? 0;
  const live = entries?.filter((e) => !e.cached).map((e) => e.duration_ms) ?? [];

  return (
    <>
      <p className="muted">
        Each row is one call the agent chose to make to an outside service.
        {config && ` Model: ${config.model}.`}
      </p>
      {problem && <p className="problem">{problem}</p>}

      {total > 0 && (
        <dl className="stats">
          <div>
            <dt>Calls</dt>
            <dd>{total}</dd>
          </div>
          <div>
            <dt>Succeeded</dt>
            <dd>{Math.round((succeeded / total) * 100)}%</dd>
          </div>
          <div>
            <dt>Median time</dt>
            <dd>{live.length ? `${Math.round(median(live))} ms` : "n/a"}</dd>
          </div>
        </dl>
      )}

      {entries?.length === 0 && (
        <p className="empty">No tool calls yet. Ask about the weather, the news or a GitHub repository.</p>
      )}

      <ol className="activity">
        {entries?.map((entry) => (
          <li key={entry.id} data-ok={entry.ok}>
            <p className="activity-call">
              <code>
                {entry.name}({Object.keys(entry.args).length ? JSON.stringify(entry.args) : ""})
              </code>
            </p>
            <p className="activity-result">{entry.summary}</p>
            <p className="row-meta">
              <span className="tag" data-tone={entry.ok ? "ok" : "bad"}>
                {entry.ok ? "OK" : "Failed"}
              </span>
              <span>{entry.cached ? "from cache" : `${entry.duration_ms} ms`}</span>
              {entry.source && <span>{entry.source}</span>}
              <span>{relativeTime(entry.created_at)}</span>
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}
