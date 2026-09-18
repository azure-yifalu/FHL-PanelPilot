import { DefaultAzureCredential } from "@azure/identity";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { parseDashboard, type Dashboard } from "./policy.js";
import * as z from "zod/v4";
import { assertCreationOrigin, defaultDashboardDestination } from "./dashboard-destination.js";

const grafanaScope = "https://dashboard.azure.com/.default";
const allowedTools = new Set([
  "amgmcp_dashboard_search",
  "amgmcp_dashboard_inspect",
  "amgmcp_dashboard_update",
]);

function jsonPayload(result: Awaited<ReturnType<GrafanaMcpClient["callTool"]>>): unknown {
  if (result.structuredContent) return result.structuredContent;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.find((block) => block.type === "text");
  if (!text || text.type !== "text" || typeof text.text !== "string")
    throw new Error("Grafana returned no JSON content.");
  return JSON.parse(text.text);
}

function errorDetail(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  const detail = Array.isArray(result.content)
    ? result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim()
    : "";
  return detail ? detail.slice(0, 2_000) : undefined;
}

export class GrafanaMcpClient {
  private client?: Client;

  async readDashboard(uid: string): Promise<Dashboard> {
    const result = await this.callTool("amgmcp_dashboard_inspect", {
      dashboardUid: uid,
      jsonPath: "$",
    });
    const payload = jsonPayload(result);
    if (
      !payload ||
      typeof payload !== "object" ||
      !("value" in payload) ||
      !Array.isArray(payload.value) ||
      payload.value.length !== 1
    ) {
      throw new Error(
        "Expected one raw dashboard from Grafana inspect jsonPath '$'. Refusing a partial preview.",
      );
    }
    const dashboard = parseDashboard(payload.value[0]);
    if (dashboard.uid !== uid)
      throw new Error("Grafana returned the wrong dashboard UID.");
    return dashboard;
  }

  async updateDashboard(dashboard: Dashboard, message: string): Promise<void> {
    await this.callTool("amgmcp_dashboard_update", {
      dashboard: parseDashboard(dashboard),
      overwrite: false,
      message,
    });
  }

  async createDashboard(dashboard: Dashboard, folderUid: string, message: string) {
    assertCreationOrigin(process.env.GRAFANA_MCP_URL);
    if (
      folderUid !== defaultDashboardDestination.folderUid ||
      dashboard.id !== null ||
      dashboard.version !== 0 ||
      !/^new-[a-f0-9-]{36}$/.test(dashboard.uid)
    )
      throw new Error("Only a new, unsaved dashboard in the fixed SPOONS folder can be created.");
    const { uid: _draftUid, ...candidate } = parseDashboard(dashboard);
    const result = await this.callTool("amgmcp_dashboard_update", {
      dashboard: { ...candidate, id: null, version: 0 },
      folderUid,
      overwrite: false,
      message,
    });
    const created = z.object({
      uid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      status: z.literal("success"),
    }).safeParse(jsonPayload(result));
    if (!created.success)
      throw new Error(
        "Creation returned an unrecognized result. Inspect the SPOONS folder; do not retry automatically.",
      );
    return created.data;
  }

  async readCreatedDashboard(uid: string) {
    assertCreationOrigin(process.env.GRAFANA_MCP_URL);
    const dashboard = await this.readDashboard(uid);
    const result = await this.callTool("amgmcp_dashboard_inspect", { dashboardUid: uid });
    const payload = z.object({
      uid: z.string(),
      version: z.number().int(),
      folder: z.object({ uid: z.string() }),
    }).parse(jsonPayload(result));
    if (payload.uid !== uid || payload.version !== dashboard.version)
      throw new Error("Created dashboard identity or version changed during read-back.");
    return { dashboard, folderUid: payload.folder.uid };
  }

  async listDashboardTools() {
    const client = await this.getClient();
    const response = await client.listTools();
    return response.tools.filter((tool) => allowedTools.has(tool.name));
  }

  async callTool(name: string, args: Record<string, unknown>) {
    if (!allowedTools.has(name)) {
      throw new Error(`Upstream tool is not allowed: ${name}`);
    }

    const client = await this.getClient();
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const detail = errorDetail(result);
      throw new Error(
        `Grafana tool ${name} failed${detail ? `: ${detail}` : "."} Inspect the dashboard before retrying.`,
      );
    }
    return result;
  }

  private async getClient(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const endpoint = process.env.GRAFANA_MCP_URL;
    if (!endpoint) {
      throw new Error("GRAFANA_MCP_URL is not configured.");
    }

    const credential = new DefaultAzureCredential();
    const token = await credential.getToken(grafanaScope);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: { Authorization: `Bearer ${token.token}` },
      },
    });

    const client = new Client({
      name: "panelpilot",
      version: "0.1.0",
    });
    await client.connect(transport);
    this.client = client;
    return client;
  }
}
