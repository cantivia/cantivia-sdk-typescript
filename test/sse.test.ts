import { describe, expect, test } from "bun:test";

import { aiterSSE, decodeStreamToLines, feedLine, iterSSE } from "../src/sse";
import { ErrorChunk, parseChunk } from "../src/models";

describe("iterSSE", () => {
  test("splits events on blank lines", () => {
    const lines = ["data: a", "", "data: b", ""];
    expect([...iterSSE(lines)]).toEqual(["a", "b"]);
  });

  test("ignores comment lines", () => {
    const lines = [":keep-alive", "data: a", ""];
    expect([...iterSSE(lines)]).toEqual(["a"]);
  });

  test("joins a multi-line data block with newlines", () => {
    const lines = ['data: {"type":"error",', 'data: "message":"split across lines"}', ""];
    const events = [...iterSSE(lines)];
    expect(events).toEqual(['{"type":"error",\n"message":"split across lines"}']);
    const chunk = parseChunk(events[0]) as ErrorChunk;
    expect(chunk.type).toBe("error");
    expect(chunk.message).toBe("split across lines");
  });

  test("drops an unterminated trailing event", () => {
    const lines = [
      'data: {"type":"routing","action":"a","difficulty":0.1}',
      "",
      'data: {"type":"done","result":{', // truncated, no blank line after
    ];
    const events = [...iterSSE(lines)];
    expect(events).toHaveLength(1);
    expect(parseChunk(events[0]).type).toBe("routing");
  });
});

describe("feedLine", () => {
  test("strips the leading space after data:", () => {
    const buffer: string[] = [];
    expect(feedLine("data:   spaced", buffer)).toBeNull();
    expect(feedLine("", buffer)).toBe("spaced");
  });
});

describe("decodeStreamToLines", () => {
  test("decodes a byte stream and feeds the SSE parser", async () => {
    const body = new Response("data: a\n\ndata: b\n\n").body;
    expect(body).not.toBeNull();
    const events: string[] = [];
    for await (const e of aiterSSE(decodeStreamToLines(body!))) {
      events.push(e);
    }
    expect(events).toEqual(["a", "b"]);
  });
});
