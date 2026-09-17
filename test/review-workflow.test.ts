import { describe, expect, it, vi } from "vitest";
import { ReviewWorkflow } from "../src/review-workflow.js";
import type { Dashboard } from "../src/policy.js";

function setup(enabled = true) {
  let current: Dashboard = {
    uid: "test",
    title: "Before",
    version: 1,
    panels: [],
  };
  let now = Date.now();
  const gateway = {
    readDashboard: vi.fn(async () => structuredClone(current)),
    updateDashboard: vi.fn(async (dashboard: Dashboard) => {
      current = {
        ...structuredClone(dashboard),
        version: dashboard.version + 1,
      };
    }),
  };
  const workflow = new ReviewWorkflow(gateway, enabled, () => now, 1000);
  const propose = (previousChangeSetId?: string) =>
    workflow.propose({
      dashboardUid: "test",
      goal: "Clear title",
      summary: "Rename",
      operations: [{ op: "replace", path: "$.title", value: "After" }],
      previousChangeSetId,
    });
  return {
    workflow,
    gateway,
    propose,
    advance: () => {
      now += 1001;
    },
    changeRemote: () => {
      current.version++;
    },
  };
}

describe("review workflow", () => {
  it("requires preview plus human approval, submits exactly the candidate and verifies", async () => {
    const { workflow, gateway, propose } = setup();
    const draft = await propose();
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
    expect(() => workflow.approve(draft.id, draft.digest)).toThrow("Open");
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow(
      "approved",
    );
    workflow.markViewed(draft.id, draft.digest);
    workflow.approve(draft.id, draft.digest);
    await expect(workflow.apply(draft.id, "yes")).rejects.toThrow(
      "confirmation",
    );
    expect((await workflow.apply(draft.id, `APPLY ${draft.id}`)).state).toBe(
      "applied",
    );
    expect(gateway.updateDashboard.mock.calls[0][0]).toEqual({
      uid: "test",
      title: "After",
      version: 1,
      panels: [],
    });
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow(
      "approved",
    );
    expect(gateway.updateDashboard).toHaveBeenCalledTimes(1);
  });
  it("feedback revokes approval, retains history and revisions invalidate old drafts", async () => {
    const { workflow, propose } = setup();
    const first = await propose();
    workflow.markViewed(first.id, first.digest);
    workflow.approve(first.id, first.digest);
    workflow.requestChanges(
      first.id,
      first.digest,
      "Use a more specific title",
    );
    await expect(workflow.apply(first.id, `APPLY ${first.id}`)).rejects.toThrow(
      "approved",
    );
    const next = await propose(first.id);
    expect(next.revision).toBe(2);
    expect(next.feedback[0].text).toContain("specific");
    expect(workflow.view(first.id).state).toBe("superseded");
    expect(() => workflow.approve(first.id, first.digest)).toThrow();
    expect(() => workflow.approve(next.id, next.digest)).toThrow("Open");
  });
  it.each(["disabled", "expired", "conflict"])(
    "blocks %s writes",
    async (kind) => {
      const { workflow, gateway, propose, advance, changeRemote } = setup(
        kind !== "disabled",
      );
      const draft = await propose();
      workflow.markViewed(draft.id, draft.digest);
      workflow.approve(draft.id, draft.digest);
      if (kind === "expired") advance();
      if (kind === "conflict") changeRemote();
      await expect(
        workflow.apply(draft.id, `APPLY ${draft.id}`),
      ).rejects.toThrow();
      expect(gateway.updateDashboard).not.toHaveBeenCalled();
    },
  );
  it("blocks stale digests and protects stored objects from caller mutation", async () => {
    const { workflow, propose } = setup();
    const draft = await propose();
    draft.after.title = "Tampered";
    expect(workflow.view(draft.id).after.title).toBe("After");
    expect(() => workflow.markViewed(draft.id, "old-digest")).toThrow("stale");
  });
  it("prevents duplicate concurrent applies", async () => {
    const { workflow, gateway, propose } = setup();
    const draft = await propose();
    workflow.markViewed(draft.id, draft.digest);
    workflow.approve(draft.id, draft.digest);
    const first = workflow.apply(draft.id, `APPLY ${draft.id}`);
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow(
      "approved",
    );
    await first;
    expect(gateway.updateDashboard).toHaveBeenCalledTimes(1);
  });
  it("does not report success or retry when a write or read-back fails", async () => {
    const { workflow, gateway, propose } = setup();
    const draft = await propose();
    workflow.markViewed(draft.id, draft.digest);
    workflow.approve(draft.id, draft.digest);
    gateway.updateDashboard.mockImplementationOnce(async () => {});
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow(
      "read-back",
    );
    expect(workflow.view(draft.id).state).toBe("verification_failed");
    await expect(
      workflow.apply(draft.id, `APPLY ${draft.id}`),
    ).rejects.toThrow();
    expect(gateway.updateDashboard).toHaveBeenCalledTimes(1);
  });
});
