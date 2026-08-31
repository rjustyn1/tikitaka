import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoClick, demoType, installCursor } from "./cursor";
import { mark, startClock } from "./markers";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

/** The main token lever from DEMO-CHEAP.md — pasted into all three agents. */
const INSTRUCTIONS =
  "Do the absolute minimum that satisfies the task. One small file, in-memory " +
  "only, no npm packages, no tests, no README, no configs, no refactoring of " +
  "existing files. Keep new code under ~25 lines. Stop the moment it works.";

const AGENTS = [
  { name: "backend", description: "Backend HTTP endpoints and in-memory storage in plain Node/JS." },
  { name: "frontend", description: "Minimal HTML/JS UI, no frameworks or build tools." },
  { name: "security", description: "Input validation and secret-boundary review, small targeted checks only." },
];

const TASKS = [
  "In code/, add a POST /upload endpoint that accepts JSON {filename} and returns {id,url}, stored in an in-memory object. Security: reject any filename containing '..' or '/'. Frontend: add a ~10-line code/index.html with a filename input that POSTs to it. Nothing else.",
  "Add a GET /upload/:id endpoint that returns the stored record as JSON, reusing the existing in-memory store in code/. Do not change anything else.",
  "In code/slug.js add a pure function slugify(text): lowercase, replace non-alphanumeric runs with single hyphens, trim leading/trailing hyphens. No dependencies.",
];

const TASK_TIMEOUT = Number(process.env.DEMO_TASK_TIMEOUT_MS ?? 12 * 60_000);
const DWELL = Number(process.env.DEMO_DWELL_MS ?? 4_000);
/** Rehearsal: build the agents and the team, but never spend Ark tokens. */
const DRY = process.env.DEMO_DRY === "1";

test("cheap end-to-end demo", async ({ page }) => {
  startClock(OUT);
  await installCursor(page);
  await page.goto("/");

  // The token is never persisted (api.ts holds it in a module variable), so it
  // must be typed. The field is type=password, so it stays masked on video.
  const token = page.locator('input[type="password"]');
  if (await token.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false)) {
    await token.fill(process.env.APP_AUTH_TOKEN ?? "");
    await demoClick(page, page.getByRole("button", { name: "Open Launchpad" }));
    mark("unlocked");
  }

  // 1. Three agents.
  await demoClick(page, page.getByRole("tab", { name: "Agents" }));
  for (const agent of AGENTS) {
    // Re-runnable: the store keeps agents, so don't pile up duplicates.
    if (await page.locator("aside nav").getByText(agent.name, { exact: true }).count()) {
      mark("agent-exists", agent.name);
      continue;
    }
    await demoClick(page, page.locator("button.create-button"));
    const form = page.locator("form.modal");
    await demoType(page, form.getByLabel("Name", { exact: true }), agent.name);
    await demoType(page, form.getByLabel("Description", { exact: true }), agent.description, 8);
    // The wrapping <label> resolves for the two inputs but not the textarea;
    // the modal has exactly one, so target it directly.
    await demoType(page, form.locator("textarea"), INSTRUCTIONS, 0);
    await demoClick(page, form.getByRole("button", { name: "Create Agent" }));
    await expect(form).toBeHidden();
    mark("agent-created", agent.name);
  }

  // 2. One team.
  await demoClick(page, page.getByRole("tab", { name: "Teams" }));
  const TEAM = "Upload Feature Team";
  // The list paints a beat after the tab switch; counting too early races and
  // creates a duplicate team.
  await expect(page.locator("aside nav")).toBeVisible();
  await page.waitForTimeout(1_000);
  const existingTeam = page.locator("aside nav").getByText(TEAM, { exact: true });
  if (await existingTeam.count()) {
    await demoClick(page, existingTeam.first());
    mark("team-reused");
  } else {
  await demoClick(page, page.getByRole("button", { name: "Create New Team" }));
  const editor = page.locator("form").filter({ hasText: "Assemble a team" });
  await demoType(page, editor.getByLabel("Team name", { exact: true }), TEAM);
  for (const agent of AGENTS) {
    // Exact text — the store may already hold e.g. "Backend agent", which a
    // substring match on "backend" would also select.
    const row = editor.locator(".roster-row")
      .filter({ has: page.getByText(agent.name, { exact: true }) })
      .first();
    // The checkbox itself is visually hidden behind its styled label.
    await demoClick(page, row.locator(".roster-toggle"));
  }
  await demoClick(page, editor.getByRole("button", { name: "Create team" }));
  await expect(editor).toBeHidden();
  mark("team-created");
  }

  // Proof the in-page cursor renders (Playwright video never shows the OS one).
  await page.screenshot({ path: path.join(OUT, "cursor-check.png") });

  // 3. Three goals, one at a time. Never cancel — cancelling skips consolidation.
  const goal = page.getByLabel("Team goal");
  await expect(goal).toBeVisible();
  for (const [index, body] of DRY ? [] : TASKS.entries()) {
    const n = index + 1;
    await expect(goal).toBeEnabled({ timeout: TASK_TIMEOUT });
    await demoType(page, goal, body, 0);
    await demoClick(page, page.getByRole("button", { name: "Start task" }));
    mark(`task-${n}-sent`);

    await expect(goal).toBeDisabled({ timeout: 60_000 });
    mark(`task-${n}-running`);

    // Watch for work and for completion in ONE poll loop.
    //
    // Awaiting a separate waitFor for the parallel case blocks for its whole
    // timeout before the completion check ever runs — on the first live run
    // that made every task report "done" at exactly 180.0s, which was the
    // timeout expiring, not the task ending.
    const running = page.locator(".member-card.member-running");
    let sawWork = false;
    let sawParallel = false;
    await expect
      .poll(async () => {
        const live = await running.count();
        if (!sawWork && live >= 1) {
          sawWork = true;
          mark(`task-${n}-working`);
        }
        if (!sawParallel && live >= 2) {
          sawParallel = true;
          mark(`task-${n}-parallel`);
        }
        return goal.isEnabled();
      }, { timeout: TASK_TIMEOUT, intervals: [500] })
      .toBe(true);
    mark(`task-${n}-done`);
  }

  // 4. The tour. Plan is a top-level button; the rest live behind "Audit ▾".
  // Both are disabled until the team has a task, so a dry run on a fresh team
  // has nothing to inspect and stops here.
  const plan = page.getByRole("button", { name: "Plan", exact: true });
  if (!(await plan.isEnabled())) {
    mark("tour-skipped", "no task on this team");
    return;
  }
  await demoClick(page, plan);
  mark("view-plan");
  await page.waitForTimeout(DWELL);

  for (const view of ["Review", "Ledger", "Workspaces", "Proof"]) {
    await demoClick(page, page.getByRole("button", { name: /^Audit/ }));
    await demoClick(page, page.getByRole("menuitem", { name: view, exact: true }));
    mark(`view-${view.toLowerCase()}`);
    await page.waitForTimeout(DWELL);
  }
  mark("run-end");
});
