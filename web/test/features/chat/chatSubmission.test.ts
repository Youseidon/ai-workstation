import assert from "node:assert/strict";
import test from "node:test";
import { queuedScopeChanged, settleAcceptedRequest, type QueuedChatScope } from "../../../features/chat/lib/chatSubmission";
const scope: QueuedChatScope = { workspace:1, provider:"claude", model:"model", permission:"plan", directory:"/tmp/a", savedPromptId:null, fresh:false };
test("queued requests revalidate provider, model, workspace, directory, permissions, context and connection", () => {
  assert.equal(queuedScopeChanged(scope,{...scope},true),false);
  for (const patch of [{workspace:2},{provider:"codex"},{model:"other"},{permission:"bypass"},{directory:"/tmp/b"},{savedPromptId:2},{fresh:true}]) assert.equal(queuedScopeChanged(scope,{...scope,...patch},true),true);
  assert.equal(queuedScopeChanged(scope,scope,false),true);
});
test("acceptance settles exactly one request; missing or repeated acknowledgement never resubmits", () => {
  const pending=[{requestId:"a",prompt:"same"},{requestId:"b",prompt:"same"}];
  assert.deepEqual(settleAcceptedRequest(pending,"b"),[pending[0]]);
  assert.deepEqual(settleAcceptedRequest(settleAcceptedRequest(pending,"b"),"b"),[pending[0]]);
  assert.deepEqual(settleAcceptedRequest(pending,undefined),pending);
});
