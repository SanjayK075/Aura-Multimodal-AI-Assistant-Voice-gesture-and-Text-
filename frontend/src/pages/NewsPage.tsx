import { useState } from "react";

import { Card, Loaded, PageShell, PanelBody, SearchField, SourceNote, useTool } from "../components/page/kit";
import { useStore } from "../store/useStore";

const TOPICS = ["", "technology", "science", "business", "sports", "health", "world"];

export function NewsPage() {
  const [topic, setTopic] = useState("");
  const [query, setQuery] = useState("");
  const region = useStore((s) => s.settings.newsRegion);
  const news = useTool("get_news", topic ? { topic } : {});
  const search = useTool("web_search", query ? { query, max_results: 8 } : null);

  return (
    <PageShell id="news">
      <div className="grid two">
        <Card title={topic ? `News: ${topic}` : `Top headlines (${region})`} actions={<SearchField onSubmit={setTopic} placeholder="Any topic" label="News topic" />}>
          <div className="chips">
            {TOPICS.map((t) => (
              <button type="button" key={t || "top"} className="chip" aria-pressed={topic === t} onClick={() => setTopic(t)}>
                {t || "Top stories"}
              </button>
            ))}
          </div>
          <Loaded state={news}>{(r) => <><PanelBody data={r.panel!} /><SourceNote data={r.panel!} /></>}</Loaded>
        </Card>
        <Card title="Web search" actions={<SearchField onSubmit={setQuery} placeholder="Search the web" label="Web search" button="Search" />}>
          {query ? (
            <Loaded state={search}>{(r) => <><PanelBody data={r.panel!} /><SourceNote data={r.panel!} /></>}</Loaded>
          ) : (
            <p className="muted">Search for anything recent. Aura uses Tavily when a key is set, and DuckDuckGo and Wikipedia otherwise. When you ask a question by voice, it searches on its own whenever it needs to.</p>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
