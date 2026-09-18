import { expect, it, vi } from "vitest";
import { ReviewWorkflow } from "../src/review-workflow.js";
import { GrafanaPreviewRenderer } from "../src/grafana-preview.js";
import type { Dashboard } from "../src/policy.js";

it.each([
  {
    name: "default seven-day",
    timeRange: undefined,
    from: "2026-09-10T00:00:00.000Z",
    to: "2026-09-17T00:00:00.000Z",
  },
  {
    name: "custom thirty-day",
    timeRange: { days: 30 },
    from: "2026-08-18T00:00:00.000Z",
    to: "2026-09-17T00:00:00.000Z",
  },
  {
    name: "custom inclusive dates",
    timeRange: { startDate: "2026-09-01", endDate: "2026-09-03" },
    from: "2026-09-01T00:00:00.000Z",
    to: "2026-09-04T00:00:00.000Z",
  },
])("publishes the $name template, preserves revisions and requires human approval", async ({ timeRange, from, to }) => {
  const source: Dashboard = {
    uid: "source",
    title: "Original",
    version: 1,
    panels: [
      {
        id: 5,
        gridPos: { x: 0, y: 0, w: 24, h: 8 },
        datasource: {
          type: "grafana-azure-data-explorer-datasource",
          uid: "existing",
        },
        targets: [{ database: "o365monitoring" }],
      },
    ],
  };
  const dashboards: Record<string, Dashboard> = {
    source,
    preview: { uid: "preview", title: "Preview", version: 1, panels: [] },
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
    "https://grafana.example/d/preview?from=now-6h&to=now",
    "https://grafana.example/api/azure-mcp",
  );
  let now = Date.parse("2026-09-17T23:59:00Z");
  const workflow = new ReviewWorkflow(
    gateway,
    () => now,
    1800000,
    renderer,
  );
  const draft = await workflow.proposeRequestTrend({
    dashboardUid: "source",
    sourcePanelId: 5,
    environment: "WW",
    timeRange,
  });
  expect(draft.diff).toHaveLength(4);
  expect(draft.diff[0].after).toHaveProperty("targets");
  expect(draft.risk).toBe("controlled-query-template");
  expect(draft.summary).toContain(from);
  expect(draft.summary).toContain(to);
  expect(gateway.updateDashboard).not.toHaveBeenCalled();
  const preview = await workflow.preparePreview(draft.id);
  const publishedContent = structuredClone(dashboards.preview);
  now += 2 * 60000;
  const sameContentDraft = await workflow.proposeRequestTrend({
    dashboardUid: "source",
    sourcePanelId: 5,
    environment: "WW",
    previousChangeSetId: draft.id,
  });
  expect(sameContentDraft.requestTrend).toEqual(draft.requestTrend);
  expect(sameContentDraft.revision).toBe(2);
  await workflow.preparePreview(sameContentDraft.id);
  expect(gateway.updateDashboard).toHaveBeenCalledTimes(1);
  expect(dashboards.preview).toEqual(publishedContent);
  const url = new URL(preview.livePreview!.url);
  expect(Number(url.searchParams.get("from"))).toBe(Date.parse(from));
  expect(Number(url.searchParams.get("to"))).toBe(Date.parse(to));
  const beforeUrl = new URL(preview.livePreview!.beforeUrl);
  expect(beforeUrl.searchParams.get("from")).toBe(url.searchParams.get("from"));
  expect(beforeUrl.searchParams.get("to")).toBe(url.searchParams.get("to"));
  expect(dashboards.preview.time).toEqual({ from, to });
  expect(url.searchParams.get("timezone")).toBe("utc");
  expect(url.searchParams.get("viewPanel")).toBe("6");
  expect(dashboards.source).toEqual(source);
  await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow(
    "approved",
  );
  workflow.markViewed(sameContentDraft.id, sameContentDraft.digest);
  await workflow.approveReviewed(sameContentDraft.id, sameContentDraft.digest);
  expect(
    (await workflow.apply(sameContentDraft.id, `APPLY ${sameContentDraft.id}`))
      .state,
  ).toBe("applied");
  expect(dashboards.source.panels).toHaveLength(2);
  expect(dashboards.source.time).toEqual({ from, to });
  const next = await workflow.proposeRequestTrend({
    dashboardUid: "source",
    sourcePanelId: 5,
    environment: "WW",
  });
  await workflow.preparePreview(next.id);
  workflow.markViewed(next.id, next.digest);
  await workflow.approveReviewed(next.id, next.digest);
  gateway.updateDashboard.mockImplementationOnce(async (dashboard) => {
    dashboards[dashboard.uid] = {
      ...dashboards[dashboard.uid],
      version: dashboard.version + 1,
    };
  });
  await expect(workflow.apply(next.id, `APPLY ${next.id}`)).rejects.toThrow(
    "read-back",
  );
  expect(workflow.view(next.id).state).toBe("verification_failed");
});
