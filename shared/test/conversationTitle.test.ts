import assert from "node:assert/strict";
import test from "node:test";
import { conversationTitle } from "../src/index";

test("conversation titles are concise and topic-first", () => {
  assert.equal(
    conversationTitle("I'd like you to continue my conversation from an activity, and bring it to the front page in a tab."),
    "Continue my conversation from an activity, and bring it…",
  );
  assert.equal(conversationTitle("please rewrite the login form\nuse the existing theme"), "Rewrite the login form");
  assert.equal(conversationTitle("Can you help me fix flaky checkout tests? Thanks"), "Fix flaky checkout tests");
});
