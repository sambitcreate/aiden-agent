import assert from "node:assert/strict";
import test from "node:test";
import { withWorkspaceScheduleRestoration } from "./workspace-schedule-restoration.js";

for (const failure of ["schedule enumeration", "generation settlement"]) {
  test(`workspace schedules resume when ${failure} fails before persistence`, async () => {
    const blocked = new Set<string>();
    const workspaceId = "workspace-1";
    let resumed = 0;
    await assert.rejects(
      withWorkspaceScheduleRestoration(
        {
          restoreOnExit: true,
          resume: async () => {
            blocked.delete(workspaceId);
            resumed += 1;
          },
          onResumeError: () => undefined,
        },
        async () => {
          blocked.add(workspaceId);
          throw new Error(`${failure} failed`);
        },
      ),
      new RegExp(`${failure} failed`, "u"),
    );
    assert.equal(resumed, 1);
    assert.equal(blocked.has(workspaceId), false);
  });
}

test("a destructive workspace mutation explicitly keeps scheduled work paused", async () => {
  let resumed = 0;
  const result = await withWorkspaceScheduleRestoration(
    {
      restoreOnExit: true,
      resume: async () => {
        resumed += 1;
      },
      onResumeError: () => undefined,
    },
    async ({ keepPaused }) => {
      keepPaused();
      return "removed";
    },
  );
  assert.equal(result, "removed");
  assert.equal(resumed, 0);
});

test("a restoration failure is reported without replacing the mutation error", async () => {
  const resumeErrors: unknown[] = [];
  await assert.rejects(
    withWorkspaceScheduleRestoration(
      {
        restoreOnExit: true,
        resume: async () => {
          throw new Error("resume failed");
        },
        onResumeError: (error) => {
          resumeErrors.push(error);
        },
      },
      async () => {
        throw new Error("mutation failed");
      },
    ),
    /mutation failed/u,
  );
  assert.equal(resumeErrors.length, 1);
  assert.match((resumeErrors[0] as Error).message, /resume failed/u);
});

test("an enabled permission persisted from none retries failed schedule activation", async () => {
  let persistedPermission = "none";
  let resumed = 0;
  let scheduled = false;
  const resume = async () => {
    resumed += 1;
    if (resumed === 1) throw new Error("schedule enumeration failed");
    scheduled = true;
  };

  await assert.rejects(
    withWorkspaceScheduleRestoration(
      {
        restoreOnExit: false,
        resume,
        onResumeError: () => undefined,
      },
      async ({ ensureResumedOnExit }) => {
        persistedPermission = "ask";
        ensureResumedOnExit();
        await resume();
      },
    ),
    /schedule enumeration failed/u,
  );

  assert.equal(persistedPermission, "ask");
  assert.equal(resumed, 2);
  assert.equal(scheduled, true);
});
