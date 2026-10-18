import { Markdown } from "../../lib/markdown";
import type { AnswerData } from "../../store/types";

export function AnswerBody({ data }: { data: AnswerData }) {
  return (
    <div className="answer prose">
      <Markdown text={data.text} />
    </div>
  );
}
