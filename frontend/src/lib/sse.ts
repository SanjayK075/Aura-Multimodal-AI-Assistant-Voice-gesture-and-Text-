/**
 * A parser for server-sent events arriving over fetch().
 *
 * The browser's built-in EventSource can only send GET requests, and the chat
 * endpoint is a POST, so the stream is read by hand. Network chunks can split
 * an event anywhere, even mid-character sequence, so text is buffered until a
 * blank line marks the end of an event.
 */
export interface ServerEvent {
  event: string;
  data: string;
}

export function createSSEParser(onEvent: (event: ServerEvent) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        // Lines starting with ":" are comments (keep-alives) and are ignored.
      }
      if (data.length > 0) onEvent({ event, data: data.join("\n") });
      boundary = buffer.indexOf("\n\n");
    }
  };
}
