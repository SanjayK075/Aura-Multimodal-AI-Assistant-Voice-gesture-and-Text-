import type { SearchData } from "../../store/types";

export function SearchBody({ data }: { data: SearchData }) {
  return (
    <div className="search">
      {data.answer && <p className="search-answer">{data.answer}</p>}
      <ol className="rows">
        {data.items.map((item) => (
          <li key={item.url}>
            <a className="row-title" href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
            {item.snippet && <p className="row-desc">{item.snippet}</p>}
            <p className="row-meta">
              <span className="publisher">{item.source}</span>
            </p>
          </li>
        ))}
      </ol>
      <p className="muted small">Searched with {data.engine}.</p>
    </div>
  );
}
