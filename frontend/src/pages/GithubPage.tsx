import { useEffect, useState } from "react";

import { Card, Loaded, PageShell, PanelBody, SearchField, Segmented, SourceNote, useTool } from "../components/page/kit";
import { useStore } from "../store/useStore";
import type { GithubData } from "../store/types";

export function GithubPage() {
  const saved = useStore((s) => s.settings.githubUsername);
  const [user, setUser] = useState(saved);
  const [sort, setSort] = useState<"updated" | "stars">("updated");
  const [repo, setRepo] = useState<string | null>(null);
  const [state, setState] = useState<"open" | "closed">("open");
  const repos = useTool("github_user_repos", user ? { username: user, sort } : null);
  const issues = useTool("github_repo_issues", repo ? { repo, state } : null);

  const data = repos.response?.panel as GithubData | undefined;
  useEffect(() => {
    if (data?.kind === "repos" && !repo && data.items[0]) setRepo(data.items[0].full_name);
  }, [data, repo]);

  return (
    <PageShell id="github" actions={<SearchField value={user} onSubmit={(v) => { setUser(v); setRepo(null); }} placeholder="GitHub username" label="GitHub username" />}>
      {!user ? (
        <Card>
          <p>Enter a GitHub username above, or save yours in Settings so this page and the voice command "show my repositories" know who you are.</p>
        </Card>
      ) : (
        <div className="grid two">
          <Card title={`${user}'s repositories`} actions={<Segmented label="Sort" value={sort} onChange={setSort} options={[{ value: "updated", label: "Recent" }, { value: "stars", label: "Stars" }]} />}>
            <Loaded state={repos}>
              {(r) => (
                <>
                  <ol className="rows repos">
                    {(r.panel as GithubData & { kind: "repos" }).items.map((item) => (
                      <li key={item.full_name}>
                        <button type="button" className="row-button repo-button" data-selected={repo === item.full_name} onClick={() => setRepo(item.full_name)}>
                          <span className="row-title">{item.name}</span>
                          <span className="row-meta">
                            {item.language && <span>{item.language}</span>}
                            <span>★ {item.stars}</span>
                            <span>{item.open_issues} open issues</span>
                          </span>
                          {item.description && <span className="row-desc">{item.description}</span>}
                        </button>
                      </li>
                    ))}
                  </ol>
                  <SourceNote data={r.panel!} />
                </>
              )}
            </Loaded>
          </Card>
          <Card
            title={repo ? `Issues in ${repo}` : "Issues"}
            actions={<Segmented label="State" value={state} onChange={setState} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }]} />}
          >
            {repo ? <Loaded state={issues}>{(r) => <><PanelBody data={r.panel!} /><SourceNote data={r.panel!} /></>}</Loaded> : <p className="muted">Pick a repository.</p>}
          </Card>
        </div>
      )}
    </PageShell>
  );
}
