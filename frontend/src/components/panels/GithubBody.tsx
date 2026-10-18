import { compact, relativeTime } from "../../lib/format";
import type { GithubData } from "../../store/types";
import { CommentIcon, ForkIcon, IssueIcon, StarIcon } from "../icons";

export function GithubBody({ data }: { data: GithubData }) {
  if (data.items.length === 0) {
    return <p className="empty">{data.kind === "repos" ? "No public repositories." : `No ${data.state} issues.`}</p>;
  }
  if (data.kind === "repos") {
    return (
      <ul className="rows">
        {data.items.map((repo) => (
          <li key={repo.full_name}>
            <a className="row-title" href={repo.url} target="_blank" rel="noopener noreferrer">
              {repo.name}
            </a>
            {repo.archived && <span className="tag">Archived</span>}
            {repo.is_fork && <span className="tag">Fork</span>}
            {repo.description && <p className="row-text">{repo.description}</p>}
            <p className="row-meta">
              {repo.language && <span className="language">{repo.language}</span>}
              <span title="Stars">
                <StarIcon size={14} /> {compact(repo.stars)}
              </span>
              <span title="Forks">
                <ForkIcon size={14} /> {compact(repo.forks)}
              </span>
              <span title="Open issues">
                <IssueIcon size={14} /> {compact(repo.open_issues)}
              </span>
              <span>Updated {relativeTime(repo.updated_at)}</span>
            </p>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="rows">
      {data.items.map((issue) => (
        <li key={issue.number}>
          <a className="row-title" href={issue.url} target="_blank" rel="noopener noreferrer">
            <span className="issue-number">#{issue.number}</span> {issue.title}
          </a>
          <p className="row-meta">
            {issue.labels.map((label) => (
              <span className="tag" key={label}>
                {label}
              </span>
            ))}
            <span title="Comments">
              <CommentIcon size={14} /> {issue.comments}
            </span>
            {issue.author && <span>by {issue.author}</span>}
            <span>{relativeTime(issue.updated_at)}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}
