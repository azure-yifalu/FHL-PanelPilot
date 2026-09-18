import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayServer } from "../src/mcp-server.js";
import { ReviewWorkflow } from "../src/review-workflow.js";
import type { Dashboard } from "../src/policy.js";

it("keeps large-dashboard draft responses small and recovers IDs without file tools", async () => {
  const dashboard: Dashboard = {
    uid: "large-source",
    title: "Large dashboard",
    version: 1,
    panels: Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      title: `Panel ${index} ${"x".repeat(150)}`,
      type: "timeseries",
      gridPos: { x: 0, y: index * 4, w: 24, h: 4 },
      datasource: { type: "grafana-azure-data-explorer-datasource", uid: "existing" },
      targets: [{ database: "o365monitoring", query: "large-query".repeat(1000) }],
    })),
  };
  const gateway = {
    readDashboard: vi.fn(async () => structuredClone(dashboard)),
    updateDashboard: vi.fn(async () => {}),
  };
  const workflow = new ReviewWorkflow(gateway);
  const server = createGatewayServer(
    { listDashboardTools: vi.fn(async () => []), callTool: vi.fn() },
    workflow,
    "http://127.0.0.1:4317",
  );
  const client = new Client({ name: "summary-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: `grafana_dashboard_${name}`,
      arguments: args,
    });
    expect(result.isError).not.toBe(true);
    // Budget includes both text and structured content, not just the JSON payload.
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(12_000);
    const content = result.content as { type: string; text: string }[];
    const summary = JSON.parse(content[0].text);
    if (result.structuredContent) expect(result.structuredContent).toEqual(summary);
    return summary;
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const draft = await call("propose_request_trend", {
      dashboardUid: dashboard.uid,
      sourcePanelId: 1,
      environment: "WW",
    });
    expect(draft.changeSetId).toBe(draft.id);
    expect(draft).not.toHaveProperty("diff");
    expect(draft).not.toHaveProperty("before");
    expect(draft).not.toHaveProperty("after");
    expect(JSON.stringify(workflow.view(draft.id)).length).toBeGreaterThan(100_000);
    expect(workflow.view(draft.id).diff[0].after).toHaveProperty("targets");
    const recovered = await call("list_changes", { dashboardUid: dashboard.uid });
    const changeSetId = recovered.drafts[0].changeSetId;
    expect(changeSetId).toBe(draft.changeSetId);
    expect((await call("validate_change", { changeSetId })).valid).toBe(true);
    expect((await call("preview_change", { changeSetId })).previewUrl).toBe(draft.previewUrl);
    for (let index = 0; index < 5; index++) {
      await call("request_changes", { changeSetId, feedback: "f".repeat(4000) });
    }
    const status = await call("review_status", { changeSetId });
    expect(status.feedbackCount).toBe(5);
    expect(status.feedback).toHaveLength(1);
    expect(status.events).toHaveLength(3);
    expect(workflow.view(changeSetId).feedback).toHaveLength(5);
    expect(status.state).toBe("changes_requested");
    await expect(workflow.apply(changeSetId, `APPLY ${changeSetId}`)).rejects.toThrow("approved");

    for (let index = 0; index < 6; index++) {
      await call("propose_change", {
        dashboardUid: dashboard.uid,
        goal: "Rename",
        summary: "s".repeat(2000),
        operations: [{ op: "replace", path: "$.title", value: `Revision ${index}` }],
      });
    }
    const first = await call("list_changes", { dashboardUid: dashboard.uid });
    const second = await call("list_changes", { dashboardUid: dashboard.uid, offset: first.nextOffset });
    expect(first.drafts).toHaveLength(5);
    expect(first.total).toBe(7);
    expect(second.drafts).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
    expect(second.drafts.at(-1).changeSetId).toBe(changeSetId);
    expect(new Set([...first.drafts, ...second.drafts].map((entry) => entry.changeSetId)).size).toBe(7);
    expect((await call("list_changes", { dashboardUid: "unrelated" })).drafts).toEqual([]);
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
    expect(dashboard.panels).toHaveLength(200);
  } finally {
    await client.close();
    await server.close();
  }
}, 20000);

it("accepts custom complete-day periods through MCP and rejects invalid periods before reading a source", async () => {
  const gateway = {
    readDashboard: vi.fn(async (): Promise<Dashboard> => ({
      uid: "source",
      title: "Source",
      version: 1,
      panels: [{
        id: 1,
        gridPos: { x: 0, y: 0, w: 24, h: 4 },
        datasource: { type: "grafana-azure-data-explorer-datasource", uid: "existing" },
        targets: [{ database: "o365monitoring" }],
      }],
    })),
    updateDashboard: vi.fn(async () => {}),
  };
  const workflow = new ReviewWorkflow(
    gateway,
    () => Date.parse("2026-09-17T12:00:00Z"),
  );
  const server = createGatewayServer(
    { listDashboardTools: vi.fn(async () => []), callTool: vi.fn() },
    workflow,
    "http://127.0.0.1:4317",
  );
  const client = new Client({ name: "period-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const propose = (extra: Record<string, unknown>) => client.callTool({
    name: "grafana_dashboard_propose_request_trend",
    arguments: { dashboardUid: "source", sourcePanelId: 1, environment: "WW", ...extra },
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let previousChangeSetId: unknown;
    for (const { extra, days, endDate } of [
      { extra: {}, days: 7, endDate: "2026-09-17" },
      { extra: { timeRange: { days: 30 } }, days: 30, endDate: "2026-09-17" },
      { extra: { timeRange: { startDate: "2026-09-01", endDate: "2026-09-03" } }, days: 3, endDate: "2026-09-04" },
    ]) {
      const result = await propose({
        ...extra,
        ...(previousChangeSetId ? { previousChangeSetId } : {}),
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.requestTrend).toMatchObject({ days, endDate });
      previousChangeSetId = result.structuredContent?.changeSetId;
    }
    const sourceReads = gateway.readDashboard.mock.calls.length;
    for (const timeRange of [
      null,
      {},
      { days: 0 },
      { days: 1.5 },
      { days: "30" },
      { days: Number.MAX_SAFE_INTEGER },
      { startDate: "2026-09-01" },
      { endDate: "2026-09-03" },
      { startDate: "2026-09-01", endDate: "2026-09-17" },
      { startDate: "2026-09-04", endDate: "2026-09-03" },
      { startDate: "2026-02-30", endDate: "2026-03-03" },
      { days: 7, startDate: "2026-09-01", endDate: "2026-09-03" },
      { days: 7, query: "arbitrary KQL" },
    ]) {
      expect((await propose({ timeRange, previousChangeSetId })).isError).toBe(true);
    }
    expect(gateway.readDashboard).toHaveBeenCalledTimes(sourceReads);
    expect(workflow.list()).toHaveLength(3);
    expect(workflow.list()[0].state).toBe("awaiting_review");
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});
