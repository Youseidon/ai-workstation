# M-9 handover: the end-to-end tier

Written 2026-09-25, by the orchestrator, for whoever picks this up in a fresh session.

Read this after [team-burndown-tracker.md](team-burndown-tracker.md) and [team-gap-register.md](team-gap-register.md).
The tracker is the state of record; this is the working knowledge behind gap **M-9**.
[team-reconcile-handover.md](team-reconcile-handover.md) is the equivalent file for the reconcile and for M-8, which is now closed.

## 1. Where everything is

| Thing | Value |
| --- | --- |
| main | `/home/junaid/ai-workstation` at `cd8e4f6`, clean |
| main vs `origin/main` | **352 ahead, 0 behind**. Still **nothing pushed, ever** |
| Worktrees | One, the checkout itself. No `fix/*` or `tm/*` branch remains |
| Server suite | **617 of 617**, three times against one unchanged root |
| Shared suite | 91 of 91 |
| Web suite | 65 of 65 |
| Typecheck | Clean on all four workspaces |
| Web lint | 17 errors, 11 warnings. **Attribution needs re-measuring**, see section 5 |
| **Full T1 suite** | **20 passed, 57 failed, 50 did not run.** This is M-9 |

The pilot checkout `/home/junaid/ai-workstation-team-pilot` sits on `feature/team-telegram-pilot` at `dc3e9de`, long since merged into main.
It is the test rig, not where product code goes.

## 2. The question everyone asks first: is the Team code merged?

Yes, in both directions that matter, and no in the direction that has not been authorised.

- The Team feature branch is **merged into main**. `dc3e9de`, the pilot tip, is an ancestor of main. F01 to F09 and H01 to H07 are all on main.
- Yousef's `origin/main` is **reconciled into main**. `4fd0e65` is an ancestor of main, so main is 0 behind. The reconcile is `a641b0c`, a merge of `4fd0e65` into `c405a58`, done 2026-09-22.
- **Nothing has been pushed.** `origin/main` is still at `4fd0e65` and has none of this work. `git branch -r --contains HEAD` returns 0, so no commit of ours is reachable from any remote ref.

jd's "keep it local" ruling of 2026-09-22 still stands, and reconciling locally did not reverse it.
Whether anything is ever pushed is still jd's open question.

## 3. What M-9 is

Upstream rewrote the saved-task execute prompt, and the T1 fake provider has never been told.

The work-item context is now **inlined** in the prompt rather than fetched.
The Progress API is reached through a generated **shim**, invoked as `"<shimPath>" done --verification "..."`, rather than through a `curl -H 'Authorization: Bearer ...' .../context` line the prompt carries.
The relevant product code is `startExecute` in `server/src/runService.ts` around line 320, and `progressApiMarkdown` in `server/src/agentContext.ts` line 298, which switches on whether a `shimPath` was supplied.

`e2e/fake-provider/grok.mjs` recognises a run by that `curl` line (`livePath()`, line 75) and by the `## Offline completion reporting` heading.
Neither appears any more, so every run falls through to its `custom` path, `context` stays `""`, and the scenario fails.

This was verified directly rather than inferred.
Logging the prompt the fake actually received gives **3080 characters**, beginning `# Execute saved work item Fixture task 1`, then `The context below is authoritative and complete...`, with the whole work item inlined and no `curl` anywhere.
The fake logged `context {"chars": 0}` on the same run.

### 3.1 The part that is a judgement, not a repair

Teaching the fake the new shape is mechanical.
Deciding what the H2 scenarios should now assert is not.

`S-H2-04` is "a done scenario fetches context, posts a remark and DONE **over HTTP to 4100 only**".
`S-H2-07` is "done on the inline path embeds context and **makes no HTTP call**".
Both describe a `curl` the product no longer tells any agent to use, and the shim makes that HTTP call itself, from a child process the fake did not spawn.

So the question to settle before writing code: does "the agent made no HTTP call" still mean anything once the shim exists, and if so, is it a claim about the agent process or about the process tree?
That is worth putting to jd rather than deciding in a fixture.

### 3.2 What is not yet traced

Five failures have not been attributed to either cause and may be their own thing:

- `l3-b-views` S-L3-B-02, `/status` counts
- `h4-time-seams` S-H4-02
- `h6-route-proxy` S-L1-17
- `h6-stale-updates` S-H6-21
- `l3-c1-threads` S-L3-C1-10

The 50 that did not run are serial-dependent on an earlier failure in their own file, so the true failure count is higher than 57.

## 4. Things that will save you time

**The harness could not boot at all until 2026-09-25.**
Upstream moved the database out of the repository into XDG state and refuses to run a watch process against that default, so every T1 test died with `harness server: process exited (1) before becoming ready`.
Fixed by naming `AGENT_CONSOLE_DB` in the harness's server environment.
If you see that error again, read `server/src/workspaces.ts` line 64.

**Run T1 from the `e2e` directory.** `npx playwright test --project=t1` from the repository root fails with `Project(s) "t1" not found`.

**A full T1 pass takes about 37 minutes** and the first few minutes are a web bundle build with no output. It is not hung.

**Harness roots are deleted on success**, so `/tmp/ai-workstation-e2e-*` is usually empty of the run you care about.
On failure the logs are copied to `e2e/test-results/<test>/harness/`: `server.log`, `web.log`, `fake-provider.log` and `console.sqlite`.
That directory is how the fake-provider diagnosis above was made.

**Never two harness runs at once**, and nothing heavy alongside one: several T1 fixtures are load-sensitive, which is what F00B was about.

**`web/components/**/*.test.tsx` is not run by `npm run test --workspace web`**, which globs `test/` only.
`teamJoinCode.test.tsx` asserts that `AgentsView` renders the Team panels, and it would have caught the deleted section immediately.
Worth deciding whether that glob should widen; it is recorded as a coverage gap, not fixed.

## 5. Corrections the V4 auditors must be given

Section 5 of [team-reconcile-handover.md](team-reconcile-handover.md) still holds, with two additions made on 2026-09-25:

- **Lint attribution must be re-measured.** The handover records 17 errors as "all in Yousef's own files". Five were dead symbols in `web/components/agents/AgentsView.tsx` - four unused panel imports, `CAPABILITY_BADGE` and an orphaned capability state - left behind when the merge deleted that file's Task Control section. That section is restored, so the count and its attribution should be measured again rather than quoted.
- **Check A2 fails on the T1 tier**, and the auditors should record that with M-9 named rather than treat it as unmeasured.

## 6. Standing constraints, unchanged

No push and no remote write without jd's explicit approval, shown first.
No paid provider, no live Telegram credential.
Never two harness runs at once.
`team.enabled` and `team.handoverEnabled` both stay false by default.
Lint exists in the `web` workspace only.
Commit messages are imperative and carry **no co-author line of any kind**, which is both jd's standing rule and audit check D5.

## 7. Order of what is left

1. **M-9**, this file. V4 is blocked on it, for the same reason V4 was blocked on M-8: an audit is worth what the tree it audits is worth, and check A2 requires the full T1 suite.
2. **V4**, audits 3 and 4, one per track, two fresh auditor agents with no part in the build, each in its own worktree, using section 4 of [team-track-dev-brief.md](team-track-dev-brief.md) **unchanged**. They write `team-track-audit-3.md` and `team-track-audit-4.md`. The audit range starts at `dc3e9de`. They must be told the corrections in section 5 above and instructed to **record** them rather than fail the work.
3. **V5**, the solo LT-4 re-run of cases 2, 3, 11 and 12 from [solo-team-thread-grant-check.md](solo-team-thread-grant-check.md). **Stop and ask jd before starting it**: it needs the pilot rig with real Telegram bots, which collides with the standing no-live-credential rule.

Still open afterwards and not part of completion: M-1 the two-person runs, M-5, M-6, M-7, L-1 to L-11, the web lint errors, and whether anything is ever pushed.
