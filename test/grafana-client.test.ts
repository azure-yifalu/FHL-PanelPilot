import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaMcpClient } from "../src/grafana-client.js";
import { defaultDashboardDestination as destination } from "../src/dashboard-destination.js";

const dashboard = { uid: "test", version: 7, title: "Example", panels: [] };
const unsaved = { ...dashboard, id: null, uid: "new-00000000-0000-4000-8000-000000000000", version: 0 };

afterEach(() => vi.unstubAllEnvs());

describe("Grafana update contract", () => {
  it("reads the full snapshot through property mode", async () => {
    const client = new GrafanaMcpClient();
    const call = vi
      .spyOn(client, "callTool")
      .mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ value: [dashboard], empty: false }),
          },
        ],
      });
    expect(await client.readDashboard("test")).toEqual(dashboard);
    expect(call).toHaveBeenCalledWith("amgmcp_dashboard_inspect", {
      dashboardUid: "test",
      jsonPath: "$",
    });
  });
  it("fails closed on partial snapshots and wrong UID", async () => {
    const client = new GrafanaMcpClient();
    const call = vi
      .spyOn(client, "callTool")
      .mockResolvedValue({
        content: [],
        structuredContent: { value: [{ title: "Partial" }] },
      });
    await expect(client.readDashboard("test")).rejects.toThrow();
    call.mockResolvedValue({
      content: [],
      structuredContent: { value: [dashboard] },
    });
    await expect(client.readDashboard("wrong")).rejects.toThrow(
      "wrong dashboard",
    );
  });
  it("uses the exact candidate with optimistic concurrency and no folder move", async () => {
    const client = new GrafanaMcpClient();
    const call = vi
      .spyOn(client, "callTool")
      .mockResolvedValue({ content: [] });
    await client.updateDashboard(dashboard, "Reviewed change");
    expect(call).toHaveBeenCalledWith("amgmcp_dashboard_update", {
      dashboard,
      overwrite: false,
      message: "Reviewed change",
    });
  });
  it("blocks other upstream operations before authentication", async () => {
    const client = new GrafanaMcpClient();
    await expect(
      client.callTool("amgmcp_dashboard_delete", {}),
    ).rejects.toThrow("not allowed");
    await expect(
      client.callTool("grafana_create_dashboard", {}),
    ).rejects.toThrow("not allowed");
  });
  it("treats MCP isError as a failure", async () => {
    const client = new GrafanaMcpClient();
    Object.assign(client, {
      client: { callTool: async () => ({ isError: true, content: [] }) },
    });
    await expect(
      client.callTool("amgmcp_dashboard_update", {}),
    ).rejects.toThrow("failed");
  });
  it("uses allowlisted create mode with no existing UID, no overwrite and the fixed folder", async () => {
    vi.stubEnv("GRAFANA_MCP_URL", `${destination.origin}/api/azure-mcp`);
    const client = new GrafanaMcpClient();
    const call = vi.spyOn(client, "callTool").mockResolvedValue({
      content: [],
      structuredContent: { uid: "newly-created", status: "success" },
    });
    expect(await client.createDashboard(unsaved, destination.folderUid, "Approved create")).toMatchObject({ uid: "newly-created" });
    expect(call).toHaveBeenCalledWith("amgmcp_dashboard_update", {
      dashboard: { id: null, version: 0, title: dashboard.title, panels: [] },
      folderUid: destination.folderUid,
      overwrite: false,
      message: "Approved create",
    });
    expect(call.mock.calls[0][1]).not.toHaveProperty("dashboardUid");
    expect(call.mock.calls[0][1].dashboard).not.toHaveProperty("uid");
  });
  it("rejects other folders, existing identities and other origins before any create call", async () => {
    vi.stubEnv("GRAFANA_MCP_URL", `${destination.origin}/api/azure-mcp`);
    const client = new GrafanaMcpClient();
    const call = vi.spyOn(client, "callTool");
    await expect(client.createDashboard(unsaved, "other", "")).rejects.toThrow("fixed SPOONS");
    await expect(client.createDashboard(dashboard, destination.folderUid, "")).rejects.toThrow("unsaved");
    vi.stubEnv("GRAFANA_MCP_URL", "https://other.example/api/azure-mcp");
    await expect(client.createDashboard(unsaved, destination.folderUid, "")).rejects.toThrow("SPOONS");
    expect(call).not.toHaveBeenCalled();
  });
  it("reads back both full content and folder metadata at the same dashboard version", async () => {
    vi.stubEnv("GRAFANA_MCP_URL", `${destination.origin}/api/azure-mcp`);
    const client = new GrafanaMcpClient();
    const call = vi.spyOn(client, "callTool");
    call.mockResolvedValueOnce({ content: [], structuredContent: { value: [dashboard] } });
    call.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({
        uid: dashboard.uid,
        version: dashboard.version,
        folder: { uid: destination.folderUid, title: "SPOONS" },
      }) }],
    });
    expect(await client.readCreatedDashboard(dashboard.uid)).toEqual({ dashboard, folderUid: destination.folderUid });
    expect(call.mock.calls).toEqual([
      ["amgmcp_dashboard_inspect", { dashboardUid: dashboard.uid, jsonPath: "$" }],
      ["amgmcp_dashboard_inspect", { dashboardUid: dashboard.uid }],
    ]);
    call.mockResolvedValueOnce({ content: [], structuredContent: { value: [dashboard] } });
    call.mockResolvedValueOnce({ content: [], structuredContent: {
      uid: dashboard.uid, version: 8, folder: { uid: destination.folderUid },
    } });
    await expect(client.readCreatedDashboard(dashboard.uid)).rejects.toThrow("changed during read-back");
  });
  it("does not interpret missing or malformed create results as success", async () => {
    vi.stubEnv("GRAFANA_MCP_URL", `${destination.origin}/api/azure-mcp`);
    const client = new GrafanaMcpClient();
    const call = vi.spyOn(client, "callTool").mockResolvedValue({ content: [] });
    await expect(client.createDashboard(unsaved, destination.folderUid, "")).rejects.toThrow("no JSON");
    call.mockResolvedValue({ content: [], structuredContent: { status: "success" } });
    await expect(client.createDashboard(unsaved, destination.folderUid, "")).rejects.toThrow();
  });
});
