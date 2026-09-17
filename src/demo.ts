import { parseDashboard, type Dashboard } from "./policy.js";
import { ReviewWorkflow } from "./review-workflow.js";
import type { GrafanaMcpClient } from "./grafana-client.js";

export class DemoGrafanaClient {
  private dashboard: Dashboard = {
    uid: "demo-service",
    version: 12,
    title: "Checkout / service health",
    time: { from: "now-6h", to: "now" },
    panels: [
      {
        id: 1,
        title: "Requests",
        type: "timeseries",
        gridPos: { x: 0, y: 0, w: 12, h: 8 },
        fieldConfig: { defaults: { unit: "reqps" } },
        options: {
          legend: {
            placement: "bottom",
            displayMode: "list",
            showLegend: true,
          },
        },
      },
      {
        id: 2,
        title: "Latency",
        type: "timeseries",
        gridPos: { x: 12, y: 0, w: 12, h: 8 },
        fieldConfig: { defaults: { unit: "s" } },
      },
      {
        id: 3,
        title: "Availability",
        type: "stat",
        gridPos: { x: 0, y: 8, w: 8, h: 6 },
        fieldConfig: {
          defaults: {
            unit: "percent",
            thresholds: {
              mode: "absolute",
              steps: [
                { color: "red", value: null },
                { color: "green", value: 99.9 },
              ],
            },
          },
        },
      },
      {
        id: 4,
        title: "Errors",
        type: "stat",
        gridPos: { x: 8, y: 8, w: 8, h: 6 },
        fieldConfig: { defaults: { unit: "percent" } },
      },
      {
        id: 5,
        title: "Saturation",
        type: "gauge",
        gridPos: { x: 16, y: 8, w: 8, h: 6 },
        fieldConfig: { defaults: { unit: "percent" } },
      },
    ],
  };

  async readDashboard(uid: string) {
    if (uid !== this.dashboard.uid)
      throw new Error("The demo contains only demo-service.");
    return structuredClone(this.dashboard);
  }

  async updateDashboard(dashboard: Dashboard) {
    if (
      dashboard.uid !== this.dashboard.uid ||
      dashboard.version !== this.dashboard.version
    )
      throw new Error("Demo version conflict.");
    this.dashboard = {
      ...structuredClone(dashboard),
      version: dashboard.version + 1,
    };
  }

  async listDashboardTools(): ReturnType<
    GrafanaMcpClient["listDashboardTools"]
  > {
    return [
      {
        name: "amgmcp_dashboard_search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      {
        name: "amgmcp_dashboard_inspect",
        inputSchema: {
          type: "object",
          properties: {
            dashboardUid: { type: "string" },
            jsonPath: { type: "string" },
          },
          required: ["dashboardUid"],
        },
      },
      {
        name: "amgmcp_dashboard_update",
        inputSchema: {
          type: "object",
          properties: {
            dashboard: {},
            overwrite: { type: "boolean" },
            message: { type: "string" },
          },
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>) {
    let payload: unknown;
    if (name === "amgmcp_dashboard_search")
      payload = [
        { uid: this.dashboard.uid, title: this.dashboard.title, demo: true },
      ];
    else if (name === "amgmcp_dashboard_inspect") {
      const dashboard = await this.readDashboard(String(args.dashboardUid));
      if (args.jsonPath && args.jsonPath !== "$")
        throw new Error("Demo inspect supports jsonPath '$' only.");
      payload = args.jsonPath
        ? { value: [dashboard], empty: false }
        : { ...dashboard, demo: true };
    } else if (name === "amgmcp_dashboard_update") {
      await this.updateDashboard(parseDashboard(args.dashboard));
      payload = { status: "success", demo: true };
    } else throw new Error("Upstream tool is not allowed.");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  }
}

export async function seedDemo(workflow: ReviewWorkflow) {
  return workflow.propose({
    dashboardUid: "demo-service",
    goal: "Help the on-call engineer compare latency with traffic. Keep queries and data sources unchanged.",
    summary:
      "Give latency more room and make the latency and error labels explicit.",
    operations: [
      { op: "replace", path: "$.panels[0].gridPos.w", value: 8 },
      { op: "replace", path: "$.panels[1].gridPos.x", value: 8 },
      { op: "replace", path: "$.panels[1].gridPos.w", value: 16 },
      { op: "replace", path: "$.panels[1].title", value: "Request latency" },
      { op: "replace", path: "$.panels[3].title", value: "Error rate" },
    ],
  });
}
