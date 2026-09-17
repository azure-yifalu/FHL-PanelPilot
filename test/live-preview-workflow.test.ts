import { describe, expect, it, vi } from "vitest";
import { ReviewWorkflow } from "../src/review-workflow.js";
import { GrafanaPreviewRenderer } from "../src/grafana-preview.js";
import type { Dashboard } from "../src/policy.js";

function setup() {
  const dashboards: Record<string, Dashboard> = {
    source: { uid: "source", id: 1, title: "Source", version: 1, panels: [], description: "Source content" },
    other: { uid: "other", id: 2, title: "Other", version: 1, panels: [] },
    preview: {
      uid: "preview",
      id: 3,
      title: "Preview",
      version: 1,
      panels: [],
    },
  };
  const gateway = {
    readDashboard: vi.fn(async (uid: string) =>
      structuredClone(dashboards[uid]),
    ),
    updateDashboard: vi.fn(async (dashboard: Dashboard) => {
      dashboards[dashboard.uid] = {
        ...structuredClone(dashboard),
        version: dashboard.version + 1,
      };
    }),
  };
  const renderer = new GrafanaPreviewRenderer(
    gateway,
    "https://grafana.example/d/preview",
    "https://grafana.example/api/azure-mcp",
  );
  const workflow = new ReviewWorkflow(
    gateway,
    true,
    Date.now,
    1800000,
    renderer,
  );
  const propose = (dashboardUid = "source") =>
    workflow.propose({
      dashboardUid,
      goal: "Clarify",
      summary: "Rename",
      operations: [{ op: "replace", path: "$.title", value: "Reviewed" }],
    });
  return { dashboards, gateway, workflow, propose, renderer };
}

describe("real preview review lifecycle", () => {
  it("proposal is read-only, preview publishes separately, final apply verifies both dashboards", async () => {
    const { workflow, propose, gateway, dashboards } = setup();
    const draft = await propose();
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
    expect(() => workflow.markViewed(draft.id, draft.digest)).toThrow(
      "not been published",
    );
    await expect(
      workflow.approveReviewed(draft.id, draft.digest),
    ).rejects.toThrow("Publish");
    const preview = await workflow.preparePreview(draft.id);
    expect(preview.livePreview?.dashboardUid).toBe("preview");
    expect(dashboards.source.version).toBe(1);
    workflow.markViewed(draft.id, draft.digest);
    expect(() => workflow.approve(draft.id, draft.digest)).toThrow(
      "verified approval",
    );
    await workflow.approveReviewed(draft.id, draft.digest);
    expect((await workflow.apply(draft.id, `APPLY ${draft.id}`)).state).toBe(
      "applied",
    );
    expect(dashboards.source.title).toBe("Reviewed");
    expect(
      gateway.updateDashboard.mock.calls.map(([dashboard]) => dashboard.uid),
    ).toEqual(["preview", "source"]);
  });
  it("overwriting the preview invalidates approval and prevents target writes", async () => {
    const { workflow, propose, dashboards, gateway } = setup();
    const draft = await propose();
    await workflow.preparePreview(draft.id);
    workflow.markViewed(draft.id, draft.digest);
    await workflow.approveReviewed(draft.id, draft.digest);
    dashboards.preview.title = "Changed manually";
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow(
      "changed or replaced",
    );
    expect(workflow.view(draft.id).state).toBe("conflict");
    expect(gateway.updateDashboard).toHaveBeenCalledTimes(1);
  });
  it("reusing the preview slot supersedes even another source's approved draft", async () => {
    const { workflow, propose } = setup();
    const first = await propose();
    await workflow.preparePreview(first.id);
    workflow.markViewed(first.id, first.digest);
    await workflow.approveReviewed(first.id, first.digest);
    const next = await propose("other");
    await workflow.preparePreview(next.id);
    expect(workflow.view(first.id).state).toBe("superseded");
    await expect(workflow.apply(first.id, `APPLY ${first.id}`)).rejects.toThrow(
      "approved",
    );
  });
  it("rejects preview as source and does not automatically retry failed publication", async () => {
    const { workflow, propose, renderer } = setup();
    await expect(propose("preview")).rejects.toThrow("original");
    const draft = await propose();
    const publish = vi
      .spyOn(renderer, "publish")
      .mockRejectedValue(new Error("Timeout"));
    await expect(workflow.preparePreview(draft.id)).rejects.toThrow("Timeout");
    await expect(workflow.preparePreview(draft.id)).rejects.toThrow("pending");
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it("rejects concurrent publications", async () => {
    const { workflow, propose } = setup();
    const first = await propose();
    const next = await propose("other");
    const pending = workflow.preparePreview(first.id);
    await expect(workflow.preparePreview(next.id)).rejects.toThrow("busy");
    await pending;
  });
});
