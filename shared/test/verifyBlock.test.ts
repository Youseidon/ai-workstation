import assert from "node:assert/strict";
import test from "node:test";
import {
  DOD_COMMAND_MAX_LENGTH,
  DOD_COMMAND_TIMEOUT_DEFAULT_MS,
  parseVerifyBlock,
} from "../src/index.ts";

test("no Verify heading yields no commands", () => {
  assert.deepEqual(parseVerifyBlock("# Title\n\nDo the work.\n"), { commands: [], tooLong: [] });
});

test("the last Verify heading wins, and only the first sh/bash fence is read", () => {
  const content = `
## Verify early
\`\`\`sh
echo stale
\`\`\`

## Acceptance
looks good

## Verify (only these routes)
Prose is ignored.
\`\`\`bash
dotnet build src/backend/MaterioForge.slnx -warnaserror
# a full-line comment is skipped
node harness/replay.mjs --target http://localhost:8080 --namespace clients
\`\`\`
\`\`\`sh
echo ignored second fence
\`\`\`

## Notes
more prose
`;
  const parsed = parseVerifyBlock(content);
  assert.equal(parsed.commands.length, 2);
  assert.equal(parsed.commands[0]!.text, "dotnet build src/backend/MaterioForge.slnx -warnaserror");
  assert.equal(parsed.commands[0]!.timeoutMs, DOD_COMMAND_TIMEOUT_DEFAULT_MS);
  assert.equal(parsed.commands[1]!.text, "node harness/replay.mjs --target http://localhost:8080 --namespace clients");
});

test("a trailing timeout comment is stripped and applied", () => {
  const parsed = parseVerifyBlock(`## Verify
\`\`\`sh
npm test # timeout=600s
FOO=bar npm run lint # timeout=90s
\`\`\`
`);
  assert.equal(parsed.commands[0]!.text, "npm test");
  assert.equal(parsed.commands[0]!.timeoutMs, 600_000);
  assert.equal(parsed.commands[1]!.text, "FOO=bar npm run lint");
  assert.equal(parsed.commands[1]!.timeoutMs, 90_000);
});

test("a Verify heading with no fenced block yields no commands", () => {
  assert.deepEqual(
    parseVerifyBlock("## Verify\n\nRun the tests by hand.\n"),
    { commands: [], tooLong: [] },
  );
});

test("an overlong line is reported rather than silently dropped into criteria", () => {
  const long = `echo ${"x".repeat(DOD_COMMAND_MAX_LENGTH)}`;
  const parsed = parseVerifyBlock(`## Verify\n\`\`\`sh\n${long}\nok\n\`\`\`\n`);
  assert.deepEqual(parsed.commands.map((c) => c.text), ["ok"]);
  assert.equal(parsed.tooLong.length, 1);
  assert.equal(parsed.tooLong[0], long);
});
