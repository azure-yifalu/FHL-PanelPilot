import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createGatewayServer } from "../src/mcp-server.js";
import { startReviewServer } from "../src/review-server.js";
import { ReviewWorkflow } from "../src/review-workflow.js";
import { GrafanaPreviewRenderer } from "../src/grafana-preview.js";
import { defaultDashboardDestination as destination } from "../src/dashboard-destination.js";
import { createChangeSet, validateChangeSet, type Dashboard } from "../src/policy.js";

const donor: Dashboard = {
  id: 10,
  uid: destination.bindingDashboardUid,
  version: 4,
  schemaVersion: 42,
  title: "SPOONS Overview v2",
  templating: { list: [{ name: "do-not-copy" }] },
  panels: [{
    id: 5,
    title: "Enterprise",
    gridPos: { x: 0, y: 18, w: 12, h: 8 },
    datasource: { type: "grafana-azure-data-explorer-datasource", uid: "existing-adx" },
    targets: [{ database: "o365monitoring", query: "Original query" }],
  }],
};

function setup() {
  let now = Date.parse("2026-09-17T12:00:00Z");
  const dashboards: Record<string, Dashboard> = {
    [donor.uid]: structuredClone(donor),
    preview: {
      id: 20,
      uid: "preview",
      version: 1,
      title: "Preview only",
      schemaVersion: 42,
      annotations: { list: [{ name: "Annotations & Alerts" }] },
      templating: { list: [{ name: "environment" }] },
      timepicker: {},
      panels: [],
    },
  };
  const gateway = {
    readDashboard: vi.fn(async (uid: string) => {
      if (!dashboards[uid]) throw new Error("Unknown dashboard");
      return structuredClone(dashboards[uid]);
    }),
    updateDashboard: vi.fn(async (dashboard: Dashboard) => {
      dashboards[dashboard.uid] = { ...structuredClone(dashboard), version: dashboard.version + 1 };
    }),
    createDashboard: vi.fn(async (dashboard: Dashboard, _folderUid: string, _message: string) => {
      dashboards.created = { ...structuredClone(dashboard), id: 30, uid: "created", version: 1 };
      return { uid: "created" };
    }),
    readCreatedDashboard: vi.fn(async (uid: string) => ({
      dashboard: structuredClone(dashboards[uid]),
      folderUid: destination.folderUid as string,
    })),
  };
  const renderer = new GrafanaPreviewRenderer(
    gateway,
    `${destination.origin}/d/preview`,
    `${destination.origin}/api/azure-mcp`,
  );
  const workflow = new ReviewWorkflow(gateway, () => now, 1800000, renderer);
  const approve = async (draft: { id: string; digest: string }) => {
    await workflow.preparePreview(draft.id);
    workflow.markViewed(draft.id, draft.digest);
    await workflow.approveReviewed(draft.id, draft.digest);
  };
  return { gateway, workflow, dashboards, approve, advance: (ms: number) => { now += ms; } };
}

describe("new dashboards in the fixed SPOONS folder", () => {
  it("creates only the requested chart after approval, verifies its folder and never edits the donor", async () => {
    const { workflow, gateway, dashboards, approve } = setup();
    const draft = await workflow.proposeRequestTrend({ environment: "WW", dashboardTitle: "Customer requests" });
    expect(draft.operation).toBe("create");
    expect(draft.creation).toEqual({
      folderUid: destination.folderUid,
      folderUrl: destination.folderUrl,
      bindingDashboardUid: donor.uid,
    });
    expect(draft.before.panels).toEqual([]);
    expect(draft.before.schemaVersion).toBe(42);
    expect(draft.after.panels).toHaveLength(1);
    expect(draft.after.schemaVersion).toBe(42);
    expect(draft.after.panels[0]).toMatchObject({ id: 1, gridPos: { x: 0, y: 0, w: 24, h: 10 } });
    expect(draft.requestTrend?.days).toBe(7);
    expect(draft.diff.every((entry) => entry.before === null)).toBe(true);
    expect(draft.validationErrors).toEqual([]);
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
    expect(gateway.createDashboard).not.toHaveBeenCalled();
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow("approved");
    await approve(draft);
    const preview = workflow.view(draft.id);
    expect(preview.writesEnabled).toBe(true);
    expect(preview.livePreview?.beforeUrl).toBe(destination.folderUrl);
    expect(new URL(preview.livePreview!.url).searchParams.get("viewPanel")).toBe("1");
    expect(gateway.createDashboard).not.toHaveBeenCalled();
    expect(gateway.updateDashboard.mock.calls.map(([dashboard]) => dashboard.uid)).toEqual(["preview"]);
    expect(gateway.updateDashboard.mock.calls[0][0]).toMatchObject({
      schemaVersion: 42,
      annotations: { list: [{ name: "Annotations & Alerts" }] },
      templating: { list: [{ name: "environment" }] },
      timepicker: {},
      panels: [{ id: 1 }],
    });
    await expect(workflow.apply(draft.id, "APPLY someone-else")).rejects.toThrow("confirmation");
    const applied = await workflow.apply(draft.id, `APPLY ${draft.id}`);
    expect(applied.state).toBe("applied");
    expect(applied.createdDashboard).toEqual({ uid: "created", url: `${destination.origin}/d/created` });
    expect(gateway.createDashboard).toHaveBeenCalledTimes(1);
    expect(gateway.createDashboard.mock.calls[0][1]).toBe(destination.folderUid);
    expect(dashboards.created.title).toBe("Customer requests");
    expect(dashboards.created.panels).toHaveLength(1);
    expect(dashboards.created.panels[0].datasource).toEqual(donor.panels[0].datasource);
    expect(dashboards.created).not.toHaveProperty("templating");
    expect(dashboards[donor.uid]).toEqual(donor);
    await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow("approved");
    expect(gateway.createDashboard).toHaveBeenCalledTimes(1);
  });

  it("revises the same unsaved dashboard, preserving dates/title and revoking old approval", async () => {
    const { workflow, approve, gateway } = setup();
    const first = await workflow.proposeRequestTrend({
      environment: "WW",
      dashboardTitle: "Custom name",
      timeRange: { startDate: "2026-09-01", endDate: "2026-09-03" },
    });
    await approve(first);
    workflow.requestChanges(first.id, first.digest, "Use SIP");
    const next = await workflow.proposeRequestTrend({ environment: "SIP", previousChangeSetId: first.id });
    expect(next.dashboardUid).toBe(first.dashboardUid);
    expect(next.after.title).toBe("Custom name");
    expect(next.requestTrend).toMatchObject({ days: 3, endDate: "2026-09-04", environment: "SIP" });
    expect(next.revision).toBe(2);
    expect(workflow.view(first.id).state).toBe("superseded");
    await expect(workflow.apply(first.id, `APPLY ${first.id}`)).rejects.toThrow("approved");
    expect(gateway.createDashboard).not.toHaveBeenCalled();
  });

  it.each(["unapproved", "donor drift", "preview drift", "expired", "feedback"] as const)(
    "blocks creation when %s",
    async (reason) => {
      const { workflow, approve, dashboards, gateway, advance } = setup();
      const draft = await workflow.proposeRequestTrend({ environment: "WW" });
      if (reason !== "unapproved") await approve(draft);
      if (reason === "donor drift") dashboards[donor.uid].version++;
      if (reason === "preview drift") dashboards.preview.version++;
      if (reason === "expired") advance(1800001);
      if (reason === "feedback") workflow.requestChanges(draft.id, draft.digest, "Not yet");
      await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow();
      expect(gateway.createDashboard).not.toHaveBeenCalled();
    },
  );

  it.each(["write failure", "wrong folder", "wrong content", "read failure", "existing identity"] as const)(
    "fails closed without automatic retry after %s",
    async (reason) => {
      const { workflow, approve, gateway } = setup();
      const draft = await workflow.proposeRequestTrend({ environment: "WW" });
      await approve(draft);
      if (reason === "write failure") gateway.createDashboard.mockRejectedValueOnce(new Error("Uncertain write"));
      if (reason === "existing identity") gateway.createDashboard.mockResolvedValueOnce({ uid: donor.uid });
      if (reason === "read failure") gateway.readCreatedDashboard.mockRejectedValueOnce(new Error("Read unavailable"));
      if (reason === "wrong folder" || reason === "wrong content") {
        const read = gateway.readCreatedDashboard.getMockImplementation()!;
        gateway.readCreatedDashboard.mockImplementationOnce(async (uid) => {
          const result = await read(uid);
          if (reason === "wrong folder") result.folderUid = "another-folder";
          else result.dashboard.title = "Changed";
          return result;
        });
      }
      await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow();
      expect(workflow.view(draft.id).state).toBe(reason === "write failure" ? "failed" : "verification_failed");
      await expect(workflow.apply(draft.id, `APPLY ${draft.id}`)).rejects.toThrow("approved");
      expect(gateway.createDashboard).toHaveBeenCalledTimes(1);
    },
  );

  it("binds the destination and donor snapshot to approval and rejects scope changes", () => {
    const change = createChangeSet({
      before: { id: null, uid: "new-00000000-0000-4000-8000-000000000000", version: 0, schemaVersion: 42, title: "New", panels: [] },
      goal: "New request chart",
      summary: "Create in SPOONS",
      operations: [],
      requestTrend: { sourcePanelId: 5, days: 7, endDate: "2026-09-17", environment: "WW" },
      creation: { folderUid: destination.folderUid, bindingSource: donor },
    });
    expect(validateChangeSet(change)).toEqual([]);
    for (const mutate of [
      (copy: typeof change) => Object.assign(copy.creation!, { folderUid: "other" }),
      (copy: typeof change) => { copy.creation!.bindingSource.uid = "other"; },
      (copy: typeof change) => { copy.creation!.bindingSource.version++; },
      (copy: typeof change) => { copy.before.id = 1; },
      (copy: typeof change) => { copy.candidate.panels.push({ id: 99 }); },
      (copy: typeof change) => { copy.requestTrend!.sourcePanelId = 99; },
    ]) {
      const copy = structuredClone(change);
      mutate(copy);
      expect(validateChangeSet(copy)).not.toEqual([]);
    }
  });

  it("routes omitted targets via MCP, recovers new-draft IDs and rejects caller destination overrides", async () => {
    const { workflow, gateway } = setup();
    const server = createGatewayServer(
      { listDashboardTools: vi.fn(async () => []), callTool: vi.fn() },
      workflow,
      "http://127.0.0.1:4317",
    );
    const client = new Client({ name: "creation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const call = (name: string, args: Record<string, unknown>) => client.callTool({
      name: `grafana_dashboard_${name}`, arguments: args,
    });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const proposal = await call("propose_request_trend", { environment: "WW" });
      expect(proposal.isError).not.toBe(true);
      expect(proposal.structuredContent?.operation).toBe("create");
      expect(proposal.structuredContent?.creation).not.toHaveProperty("bindingSource");
      expect(Buffer.byteLength(JSON.stringify(proposal))).toBeLessThan(12_000);
      const changeSetId = proposal.structuredContent?.changeSetId;
      expect((await call("list_changes", {})).structuredContent?.drafts).toMatchObject([{ changeSetId, operation: "create" }]);
      for (const extra of [
        { folderUid: "another-folder" },
        { bindingDashboardUid: "other" },
        { sourcePanelId: 99 },
        { dashboardUid: "" },
        { dashboardTitle: "" },
      ]) {
        expect((await call("propose_request_trend", { environment: "WW", ...extra })).isError).toBe(true);
      }
      expect(workflow.list()).toHaveLength(1);
      expect(gateway.createDashboard).not.toHaveBeenCalled();
      const target = await call("propose_request_trend", { environment: "WW", dashboardUid: donor.uid, sourcePanelId: 5 });
      expect(target.isError).not.toBe(true);
      expect(target.structuredContent?.operation).toBe("update");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("blocks new-dashboard preview publication to another Grafana instance", async () => {
    const { gateway } = setup();
    const renderer = new GrafanaPreviewRenderer(gateway, "https://other.example/d/preview", "https://other.example/api/azure-mcp");
    const workflow = new ReviewWorkflow(gateway, Date.now, 1800000, renderer);
    const draft = await workflow.proposeRequestTrend({ environment: "WW" });
    await expect(workflow.preparePreview(draft.id)).rejects.toThrow("SPOONS");
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
  });

  it("creates through the local review HTTP flow only after acknowledgment and approval", async () => {
    const { workflow, gateway } = setup();
    const draft = await workflow.proposeRequestTrend({ environment: "WW" });
    await workflow.preparePreview(draft.id);
    const server = await startReviewServer(workflow, { port: 0 });
    try {
      const html = await (await fetch(server.origin)).text();
      expect(html).toContain('id="creation-destination"');
      expect(html).toContain('id="created-dashboard"');
      const csrf = /name="fhl-csrf" content="([a-f0-9]+)"/.exec(html)![1];
      const post = (action: string, extra: object = {}) => fetch(
        `${server.origin}/api/reviews/${draft.id}/${action}`,
        {
          method: "POST",
          headers: { Origin: server.origin, "X-FHL-CSRF": csrf, "Content-Type": "application/json" },
          body: JSON.stringify({ digest: draft.digest, ...extra }),
        },
      );
      expect((await post("apply", { confirmation: `APPLY ${draft.id}` })).status).toBe(400);
      expect((await post("approve")).status).toBe(400);
      expect((await post("viewed")).status).toBe(200);
      expect((await post("approve")).status).toBe(200);
      expect(gateway.createDashboard).not.toHaveBeenCalled();
      expect((await post("apply", {
        confirmation: `APPLY ${draft.id}`,
        folderUid: "another-folder",
      })).status).toBe(400);
      const result = await post("apply", { confirmation: `APPLY ${draft.id}` });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        state: "applied",
        operation: "create",
        createdDashboard: { uid: "created", url: `${destination.origin}/d/created` },
      });
      expect(gateway.createDashboard).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
