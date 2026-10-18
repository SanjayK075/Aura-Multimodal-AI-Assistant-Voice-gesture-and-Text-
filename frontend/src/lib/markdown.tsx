/**
 * A small, safe Markdown renderer for the model's answers.
 *
 * It builds React elements directly and never sets raw HTML, so nothing the
 * model (or a web page it summarised) writes can inject markup or scripts.
 * Supports what answers actually use: paragraphs, bold, italic, inline code,
 * fenced code blocks, bullet and numbered lists, headings and http(s) links.
 */
import type { ReactNode } from "react";

type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "list"; ordered: boolean; items: string[] };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      // An unclosed fence (the answer is still streaming) runs to the end.
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      blocks.push({ kind: "code", text: code.join("\n"), language: fence[1] ?? "" });
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      const ordered = !bullet;
      const text = (bullet ?? numbered)![1]!;
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(text);
      else blocks.push({ kind: "list", ordered, items: [text] });
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", text: heading[1]! });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("*")) nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)!;
      nodes.push(
        <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((block, i) => {
        if (block.kind === "code") {
          return (
            <pre key={i} data-language={block.language || undefined}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "list") {
          const items = block.items.map((item, j) => <li key={j}>{renderInline(item, `l${i}-${j}`)}</li>);
          return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        if (block.kind === "heading") {
          return (
            <p key={i} className="md-heading">
              {renderInline(block.text, `h${i}`)}
            </p>
          );
        }
        return <p key={i}>{renderInline(block.text, `p${i}`)}</p>;
      })}
    </>
  );
}

/** Plain text for the speech synthesiser: no symbols, and code is not read aloud. */
export function toSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " The code is on screen. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split text into sentence-sized pieces; long utterances get cut off by some browsers. */
export function speechChunks(text: string, maxLength = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + sentence).length > maxLength) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
    while (current.length > maxLength) {
      const cut = current.lastIndexOf(" ", maxLength);
      const at = cut > 40 ? cut : maxLength;
      chunks.push(current.slice(0, at).trim());
      current = current.slice(at);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
