import type { WikipediaData } from "../../store/types";

export function WikipediaBody({ data }: { data: WikipediaData }) {
  return (
    <article className="wiki prose">
      {data.thumbnail && <img className="wiki-thumb" src={data.thumbnail} alt="" loading="lazy" />}
      {data.featured && <p className="tag">Today's featured article</p>}
      {data.description && <p className="wiki-description">{data.description}</p>}
      <p>{data.extract}</p>
      <p>
        <a href={data.url} target="_blank" rel="noopener noreferrer">
          Read the full article
        </a>
      </p>
    </article>
  );
}
