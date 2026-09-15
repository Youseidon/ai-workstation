import assert from "node:assert/strict";
import test from "node:test";
import { detectEntities, messageEntities } from "./fakes/telegramEntities.ts";

// Fixtures: texts the test bot sent on real Telegram on 2026-09-15 and the entities Telegram returned for them,
// with the test bot's username replaced by a placeholder of the same shape.
const seen = (text: string) => detectEntities(text).map((entity) => [entity.type, text.slice(entity.offset, entity.offset + entity.length)]);

test("the fake detects the entities real Telegram added to a card with markup, links and commands", () => {
  const text = "Entity probe: <b>x</b> *bold* _it_ [click](https://example.com) `code` ||spoiler|| /help @someone #tag $USD mail@example.com +61 400 000 000 example.org http://localhost:4000/admin [redacted] /task_1 /status@harness_test_bot";
  assert.deepEqual(seen(text), [
    ["url", "https://example.com"],
    ["bot_command", "/help"],
    ["mention", "@someone"],
    ["hashtag", "#tag"],
    ["cashtag", "$USD"],
    ["email", "mail@example.com"],
    ["url", "example.org"],
    ["bot_command", "/task_1"],
    ["bot_command", "/status@harness_test_bot"],
  ]);
});

test("the fake matches real Telegram on ambiguous file names, hosts, handles and schemes", () => {
  const cases = ["README.md", "colours.ts", "notes.txt", "app.py", "index.html", "server.js", "example.io", "t.me/foo", "www.example.com", "1.2.3.4", "localhost:3000", "http://127.0.0.1:4000/x", "https://a.b.example.com/p?q=1#f", "/usr/local", "a/b", "#123", "#a1", "#tag_x", "@abc", "@abcd", "@abcde", "$AB", "$ABCD", "$abcd", "x@y.z", "first.last+tag@mail.example.co.uk", "(https://x.example.com)", "https://example.com.", "/cmd.", "/a_b@botname", "word/help", "a#tag", "a@someone", "foo.bar", "sk-live-4f9a8b7c6d5e4f3a2b1c", "ghp_abc", "C:\\x\\y.txt", "https://example.com/path/to/file.md", "ftp://example.com", "mailto:a@example.com", "tg://resolve?domain=x"];
  assert.deepEqual(seen(cases.join(" | ")), [
    ["url", "README.md"],
    ["url", "app.py"],
    ["url", "example.io"],
    ["url", "t.me/foo"],
    ["url", "www.example.com"],
    ["url", "1.2.3.4"],
    ["url", "http://127.0.0.1:4000/x"],
    ["url", "https://a.b.example.com/p?q=1#f"],
    ["hashtag", "#a1"],
    ["hashtag", "#tag_x"],
    ["mention", "@abcd"],
    ["mention", "@abcde"],
    ["cashtag", "$AB"],
    ["cashtag", "$ABCD"],
    ["email", "first.last+tag@mail.example.co.uk"],
    ["url", "https://x.example.com"],
    ["url", "https://example.com"],
    ["bot_command", "/cmd"],
    ["bot_command", "/a_b@botname"],
    ["url", "foo.bar"],
    ["url", "https://example.com/path/to/file.md"],
    ["url", "ftp://example.com"],
    ["email", "a@example.com"],
    ["url", "tg://resolve?domain=x"],
  ]);
});

test("detected entities nest inside the bot's blockquote and follow it by offset", () => {
  const head = "Entity probe plain: no entities here - just text.";
  const quote = "Details:\n- see https://example.com and /help";
  const text = `${head}\n${quote}`;
  assert.deepEqual(messageEntities(text, [{ type: "expandable_blockquote", offset: head.length + 1, length: quote.length }]), [
    { type: "expandable_blockquote", offset: 50, length: 44 },
    { type: "url", offset: 65, length: 19 },
    { type: "bot_command", offset: 89, length: 5 },
  ]);
});
