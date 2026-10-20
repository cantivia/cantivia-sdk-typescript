/**
 * Minimal Server-Sent Events parser.
 *
 * Events may arrive one at a time or several in one read; both parse the same.
 * Only `data:` fields carry anything; `event:`, `id:`, `retry:` and comment lines
 * are ignored.
 */

/**
 * Process one line against the accumulating buffer. Returns a completed event
 * payload when the line is blank (event terminator), otherwise `null`.
 */
export function feedLine(line: string, buffer: string[]): string | null {
  if (line === "") {
    if (buffer.length > 0) {
      const data = buffer.join("\n");
      buffer.length = 0;
      return data;
    }
    return null;
  }
  if (line.startsWith(":")) {
    return null;
  }
  if (line.startsWith("data:")) {
    // SSE strips a single leading space; all of them are stripped here so the
    // TypeScript and Python clients parse identically.
    buffer.push(line.slice(5).replace(/^ +/, ""));
  }
  return null;
}

/** Synchronous variant — used by tests and any caller that already has lines. */
export function* iterSSE(lines: Iterable<string>): Generator<string> {
  const buffer: string[] = [];
  for (const line of lines) {
    const event = feedLine(line, buffer);
    if (event !== null) {
      yield event;
    }
  }
  // An un-terminated trailing buffer means the connection was severed mid-event;
  // drop it rather than emit a truncated (and likely un-parseable) payload.
}

/** Asynchronous variant — consumes a stream of decoded lines. */
export async function* aiterSSE(lines: AsyncIterable<string>): AsyncGenerator<string> {
  const buffer: string[] = [];
  for await (const line of lines) {
    const event = feedLine(line, buffer);
    if (event !== null) {
      yield event;
    }
  }
  // See iterSSE: a non-empty trailing buffer is a mid-event disconnect; drop it.
}

/**
 * Decode a byte stream into lines, splitting on CRLF/CR/LF and holding back any
 * partial trailing line until more bytes arrive. Cancels the underlying stream on
 * early exit so breaking out of a `verifyStream` loop tears down the HTTP body.
 * `onBytes` runs on every read that returns data; the client uses it to restart
 * its idle timeout.
 */
export async function* decodeStreamToLines(
  stream: ReadableStream<Uint8Array>,
  onBytes?: () => void,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onBytes?.();
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) {
      yield buf;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed/errored — nothing to cancel.
    }
  }
}
