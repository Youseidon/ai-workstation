import { expect, test } from "@playwright/test";
import { startTeamHarness } from "../../src/env/teamHarness.ts";

/*
 * TM-T1-H1 and TM-T1-H2, the halves that genuinely need the two-environment
 * harness (docs/e2e-scenarios/tm4.md).
 *
 * WRITTEN AND NOT RUN, deliberately, and every case below is `fixme` for one
 * reason, stated once here rather than repeated:
 *
 *   Handover has no HTTP or Telegram runtime surface yet. H02 built the control
 *   record, H03 built capture and publish and H04 built accept, claim and the
 *   receiver's run, all as server modules with no route and no long-poll wiring.
 *   `server/src/workspaceApi.ts` exposes no `/api/task-control/team/handover/…`
 *   route and `telegramLiveRuntime` schedules no control-record poll, so a
 *   Playwright harness has nothing to drive. Marking these cases `fixme` says
 *   that plainly rather than pretending a pass.
 *
 * The server tier of both rows lives in `server/src/teamHandoverRun.test.ts` and
 * passes, 34/34. It covers everything that does not need two databases or a
 * delivered Telegram update: the shared bare repository, the compare-and-swap
 * race, RTC-12's four outcomes, the worktree run under the receiver's own
 * provider, the questions' actor mapping, the partial return with quota as its
 * own stop reason, the no-reclaim proof and the capability gate.
 *
 * What is left here is what only two app roots, two bots and one fake group can
 * show. Each case names exactly what it would assert.
 */

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

test.fixme("TM-T1-H1: the offer crosses two workstations and the receiver runs it", async () => {
  const team = await startTeamHarness({
    envA: { settings: { "team.enabled": true, "team.handoverEnabled": true } },
    envB: { settings: { "team.enabled": true, "team.handoverEnabled": true } },
  });
  try {
    /*
     * Needs the harness because two databases and two bots are the subject:
     *
     * 1. jd triggers handover from the quota-warning card in his private chat,
     *    and separately by `/handover` on the item anchor, reviews the preview
     *    and publishes. Both triggers reach the same capture.
     * 2. The offer card is posted in the item thread by env A's bot and NAMES NO
     *    RECEIVER; existing grants on the item end when handover starts.
     * 3. Env B discovers the offer on its next shared-record read, at the
     *    recorded 5-second default, without reading env A's message.
     * 4. The Accept and run card is posted by ENV B'S OWN BOT, and its
     *    `from.id` in the fake transcript is env B's bot, not env A's.
     * 5. Progress replies carry the item tag and edit the same anchor in place,
     *    bounded on material content (F07).
     * 6. A requirement question raised mid-run while ENV A IS STOPPED is
     *    delivered to jd, and applies when he answers after env A returns;
     *    access, provider and allowance questions go to the teammate locally.
     * 7. The completed anchor renders from the completed state and retires only
     *    once the run has actually ended (F08).
     * 8. Exactly one run exists and it is on env B; env A's database shows none.
     * 9. One `accept_offer` receipt, one `return_work` receipt, each applied
     *    once, with duplicate callback delivery returning the first receipt and
     *    creating no second run.
     * 10. Env A holds its pipeline hold from capture until the result is
     *     applied.
     * 11. No token, absolute path or credential appears in the fake transcript.
     */
    expect(team.envA.app.serverUrl).toBeTruthy();
  } finally {
    await team.dispose();
  }
});

test.fixme("TM-T1-H2: contention and offline behaviour across two workstations", async () => {
  const team = await startTeamHarness({
    envA: { settings: { "team.enabled": true, "team.handoverEnabled": true } },
    envB: { settings: { "team.enabled": true, "team.handoverEnabled": true } },
  });
  try {
    /*
     * Needs the harness because delivery order, an offline workstation and a
     * restart are the subject:
     *
     * 1. Two receivers tap Accept at the same moment with the tap that reaches
     *    its BOT second made to reach the CONTROL RECORD first. Both taps are
     *    answered with their own callback answer, and neither is applied twice.
     *    (The record's half of this is verified at the server tier.)
     * 2. Env B is stopped when the offer is published: jd sees the offer is
     *    unclaimed and waiting, and the Accept card appears when env B returns.
     * 3. A tap dropped by Telegram while env B was offline longer than about
     *    2.5 minutes is never invented; the returning workstation renews the
     *    open card's buttons with the stated wording.
     * 4. A tap after the 10-minute action expiry is rejected with the expiry
     *    reason and renews nothing. (Rejection is verified at the server tier;
     *    what needs the harness is that no renewal message is delivered.)
     * 5. The decliner's card goes inert on their phone while the offer card in
     *    the thread still shows as open to the other member.
     * 6. Team disabled on either side mid-offer answers 403 to the tap and
     *    stops cards applying while leaving the record untouched, and the
     *    handover resumes when Team is re-enabled, with personal control
     *    unaffected throughout. This case also covers `team.handoverEnabled`
     *    toggled off on env B alone.
     * 7. Env B restarts mid-offer and re-reads the record rather than
     *    re-applying a command id it already carries.
     */
    expect(team.envB.app.serverUrl).toBeTruthy();
  } finally {
    await team.dispose();
  }
});
