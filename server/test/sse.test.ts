import assert from "node:assert/strict";
import test from "node:test";
import { SseDecoder } from "../src/lib/sse.ts";

test("SSE handles every frame boundary, CRLF, comments, event IDs and multiline data", () => {
  const source = ': heartbeat\r\nid: e1\r\nevent: event\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: second\n\n';
  for (let split = 0; split <= source.length; split++) {
    const decoder = new SseDecoder();
    assert.deepEqual([...decoder.push(source.slice(0, split)), ...decoder.push(source.slice(split))], [{ id: "e1", data: '{"a":\n1}' }, { id: "", data: "second" }]);
  }
});

test("SSE preserves text when UTF-8 is delivered one byte at a time", () => {
  const bytes = new TextEncoder().encode('data: {"delta":"🌊 日本語"}\n\n');
  const utf8 = new TextDecoder();
  const decoder = new SseDecoder();
  const frames = [];
  for (const byte of bytes) frames.push(...decoder.push(utf8.decode(new Uint8Array([byte]), { stream: true })));
  assert.equal(JSON.parse(frames[0]!.data).delta, "🌊 日本語");
});
