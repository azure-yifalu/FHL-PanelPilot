import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { GrafanaMcpClient } from "./grafana-client.js";
import { createGatewayServer } from "./mcp-server.js";
import { ReviewWorkflow } from "./review-workflow.js";
import { startReviewServer } from "./review-server.js";
import { DemoGrafanaClient, seedDemo } from "./demo.js";
import { GrafanaPreviewRenderer } from "./grafana-preview.js";

async function main() {
  const demo = process.argv.includes("--demo");
  const grafana = demo ? new DemoGrafanaClient() : new GrafanaMcpClient();
  const previewUrl = process.env.FHL_PREVIEW_DASHBOARD_URL;
  const previewEnabled =
    !demo && process.env.FHL_ENABLE_PREVIEW_WRITES === "true";
  if (previewEnabled && (!previewUrl || !process.env.GRAFANA_MCP_URL))
    throw new Error(
      "Preview writes require FHL_PREVIEW_DASHBOARD_URL and GRAFANA_MCP_URL.",
    );
  if (!demo && previewUrl && !previewEnabled)
    throw new Error(
      "A real preview is configured but preview writes are disabled. Set FHL_ENABLE_PREVIEW_WRITES=true only after authorizing this destination.",
    );
  const renderer = previewEnabled
    ? new GrafanaPreviewRenderer(
        grafana,
        previewUrl!,
        process.env.GRAFANA_MCP_URL!,
      )
    : undefined;
  const workflow = new ReviewWorkflow(
    grafana,
    Date.now,
    30 * 60 * 1000,
    renderer,
  );
  const port = Number(process.env.FHL_REVIEW_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("FHL_REVIEW_PORT must be an integer between 0 and 65535.");
  const review = await startReviewServer(workflow, { port, demo });
  if (demo) await seedDemo(workflow);
  console.error(
    `PanelPilot review: ${review.origin}${demo ? " (DEMO: local memory only)" : ""}`,
  );
  const server = createGatewayServer(grafana, workflow, review.origin);
  const shutdown = async () => {
    await server.close();
    await review.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  if (!demo)
    process.stdin.once("end", () => {
      void shutdown().finally(() => process.exit(0));
    });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
