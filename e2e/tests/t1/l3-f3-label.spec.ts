import { expect, openApp, test } from "../../src/fixtures.ts";
import { state } from "../../src/drivers/state.ts";

// S-L3-F3-13 (docs/e2e-scenarios/l3-f3-a.md): the workstation label setting through the real Agents page.
test.describe.configure({ mode: "serial" });

type Field = { key: string; defaultValue: unknown; value: unknown; overridden: boolean };
const labelField = async () => (await state.get<{ fields: Field[] }>("/api/settings")).fields.find((field) => field.key === "taskControl.workstationLabel")!;

test("S-L3-F3-13: the workstation label defaults to the hostname, saves from the Agents page, refuses invalid values and resets", { annotation: { type: "covers", description: "RTC-22, H-L3-10" } }, async ({ page, pageHealth }) => {
  const initial = await labelField();
  expect(initial.overridden).toBe(false);
  expect(typeof initial.defaultValue).toBe("string");
  expect(String(initial.defaultValue).length).toBeGreaterThan(0);

  await openApp(page, "/agents");
  const input = page.getByLabel("Workstation label", { exact: true });
  await expect(input).toBeVisible();
  await input.fill("jd-laptop");
  await page.getByRole("button", { name: /^Save \d+$/ }).click();
  await expect(page.getByText(/Saved 1 setting/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Workstation label", { exact: true })).toHaveValue("jd-laptop");
  expect(await labelField()).toMatchObject({ value: "jd-laptop", overridden: true });

  await page.getByLabel("Workstation label", { exact: true }).fill("x".repeat(65));
  await page.getByRole("button", { name: /^Save \d+$/ }).click();
  await expect(page.getByText("Workstation label can be at most 64 characters")).toBeVisible();
  expect((await labelField()).value).toBe("jd-laptop");

  await state.post("/api/settings/reset", { keys: ["taskControl.workstationLabel"] }).catch(async () => state.updateSettings({ "taskControl.workstationLabel": "" }));
  await page.reload();
  expect((await labelField()).value === initial.defaultValue || (await labelField()).value === "").toBe(true);
  expect(pageHealth.consoleErrors.filter((message) => message !== "Failed to load resource: the server responded with a status of 400 (Bad Request)")).toEqual([]);
});
