import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { GrafanaMcpClient } from "./grafana-client.js";
import type { ReviewWorkflow } from "./review-workflow.js";
import { openReviewExternally } from "./external-browser.js";
import { requestTrendTimeRangeSchema } from "./request-trend.js";

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function summaryText(value: string, limit = 500) {
  return value.length <= limit ? value : `${value.slice(0, limit)}... [truncated; see review page]`;
}

export function createGatewayServer(
  grafana: Pick<GrafanaMcpClient, "listDashboardTools" | "callTool">,
  workflow: ReviewWorkflow,
  reviewOrigin: string,
) {
  const server = new McpServer({
    name: "panelpilot",
    version: "0.2.0",
  });
  const idSchema = z.object({ changeSetId: z.string().uuid() }).strict();
  const preview = (id: string) => {
    const review = workflow.view(id);
    return {
      changeSetId: id,
      id,
      dashboardUid: review.dashboardUid,
      operation: review.operation,
      creation: review.creation,
      createdDashboard: review.createdDashboard,
      revision: review.revision,
      previousId: review.previousId,
      state: review.state,
      baseVersion: review.baseVersion,
      digest: review.digest,
      createdAt: review.createdAt,
      expiresAt: review.expiresAt,
      summary: summaryText(review.summary),
      changeCount: review.diff.length,
      valid: review.validationErrors.length === 0,
      validationErrorCount: review.validationErrors.length,
      validationErrors: review.validationErrors.slice(0, 5).map((error) => summaryText(error)),
      previewUrl: `${reviewOrigin}/?id=${id}`,
      previewKind: review.previewKind,
      livePreview: review.livePreview,
      previewViewed: review.previewViewed,
      writesEnabled: review.writesEnabled,
      risk: review.risk,
      requestTrend: review.requestTrend,
      error: review.error === undefined ? undefined : summaryText(review.error),
      feedbackCount: review.feedback.length,
      feedback: review.feedback.slice(-1).map((entry) => ({
        ...entry,
        text: summaryText(entry.text, 1000),
      })),
      eventCount: review.events.length,
      events: review.events.slice(-3).map((entry) => ({
        ...entry,
        action: summaryText(entry.action),
      })),
      details: "Compact summary only. Full configuration, exact diff and history are available on the review page.",
    };
  };
  const reviewResult = (id: string) => {
    const summary = preview(id);
    return { ...text(summary), structuredContent: summary };
  };

  server.registerTool(
    "grafana_dashboard_list_changes",
    {
      description:
        "Recover draft IDs when a prior response was externalized or lost. Read-only, newest first. Supply dashboardUid to filter updates; omit it to list new-dashboard drafts in the fixed SPOONS folder. Match summary, creation time, revision and state; never guess an ID or automatically apply a recovered draft. Drafts are lost on gateway restart.",
      inputSchema: z.object({
        dashboardUid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
        offset: z.number().int().min(0).default(0),
      }).strict(),
    },
    async ({ dashboardUid, offset }) => {
      const matches = workflow.list().filter((review) =>
        dashboardUid === undefined ? review.operation === "create" : review.dashboardUid === dashboardUid,
      );
      const result = {
        drafts: matches.slice(offset, offset + 5).map((review) => ({
          changeSetId: review.id,
          dashboardUid: review.dashboardUid,
          operation: review.operation,
          folderUid: review.folderUid,
          summary: summaryText(review.summary, 200),
          state: review.state,
          revision: review.revision,
          createdAt: review.createdAt,
        })),
        total: matches.length,
        nextOffset: offset + 5 < matches.length ? offset + 5 : null,
      };
      return { ...text(result), structuredContent: result };
    },
  );

  server.registerTool(
    "grafana_dashboard_tool_schemas",
    {
      description:
        "List exact input schemas of the approved upstream dashboard tools. Local proposals do not accept upstream arguments.",
      inputSchema: z.object({}).strict(),
    },
    async () => text(await grafana.listDashboardTools()),
  );

  server.registerTool(
    "grafana_dashboard_search",
    {
      description:
        "Search dashboards. Read grafana_dashboard_tool_schemas first for exact arguments.",
      inputSchema: z
        .object({ arguments: z.record(z.string(), z.unknown()) })
        .strict(),
    },
    async ({ arguments: args }) =>
      text(await grafana.callTool("amgmcp_dashboard_search", args)),
  );

  server.registerTool(
    "grafana_dashboard_inspect",
    {
      description:
        "Inspect a dashboard without writing. Use jsonPath '$' for the raw snapshot and numeric panel indices.",
      inputSchema: z
        .object({
          dashboardUid: z.string().min(1),
          jsonPath: z.string().optional(),
          includeQueries: z.boolean().optional(),
          panelId: z.number().int().optional(),
          variables: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    },
    async (input) =>
      text(
        await grafana.callTool(
          "amgmcp_dashboard_inspect",
          Object.fromEntries(
            Object.entries(input).filter(([, value]) => value !== undefined),
          ),
        ),
      ),
  );

  server.registerTool(
    "grafana_dashboard_propose_change",
    {
      description:
        "After clarifying the user's goal and obtaining agreement on the plan, create a read-only draft and configuration preview. Fetches the source snapshot itself. Supported paths: $.title; $.panels[N].title; gridPos.x/y/w/h; fieldConfig.defaults.unit/thresholds; options.legend.displayMode/placement/showLegend. No queries, datasource, panel additions, or removals. For a revision, pass previousChangeSetId and the complete desired operation list relative to the live dashboard, not the previous candidate. Never supplies user approval.",
      inputSchema: z
        .object({
          dashboardUid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          goal: z
            .string()
            .trim()
            .min(1)
            .max(4000)
            .describe("The user's confirmed goal, audience and constraints."),
          summary: z.string().trim().min(1).max(2000),
          previousChangeSetId: z.string().uuid().optional(),
          operations: z
            .array(
              z
                .object({
                  op: z.enum(["add", "replace"]),
                  path: z.string().startsWith("$"),
                  value: z.unknown(),
                })
                .strict(),
            )
            .min(1)
            .max(100),
        })
        .strict(),
    },
    async (input) => {
      const draft = await workflow.propose(input);
      return reviewResult(draft.id);
    },
  );

  server.registerTool(
    "grafana_dashboard_propose_request_trend",
    {
      description:
        "Propose a Copilot daily DA/HVI/SCD Post request chart using fixed KQL. If the user supplied a target dashboard, pass dashboardUid and its sourcePanelId to add the chart. Otherwise OMIT dashboardUid: propose a NEW dashboard in the fixed SPOONS folder dfs8revgy9ds0e, containing only this chart, using yix8pjx panel 5 for the ADX binding. Do not use the donor as the target or ask for a target link when none was supplied. New dashboards are created only on approved apply, not proposal or preview. Defaults to 7 complete UTC days excluding today; timeRange accepts {days: N} or inclusive {startDate, endDate} in YYYY-MM-DD before today. Revisions preserve prior dates if omitted; for new-dashboard revisions omit dashboardUid and pass previousChangeSetId. No arbitrary query input. Continue with validate_change, preview_change and open_review. Final writes always require approval.",
      inputSchema: z
        .object({
          dashboardUid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
          sourcePanelId: z.number().int().positive().optional(),
          dashboardTitle: z.string().trim().min(1).max(200).optional(),
          environment: z.enum(["WW", "SIP", "MSIT", "DONMT", "SDFV2"]),
          timeRange: requestTrendTimeRangeSchema.optional().describe(
            "User-selected complete UTC days: {days: N} or inclusive {startDate, endDate}. Defaults to 7 days on a new draft; preserves the previous range on a revision. Do not combine both forms.",
          ),
          previousChangeSetId: z.string().uuid().optional(),
        })
        .strict(),
    },
    async (input) => {
      const draft = await workflow.proposeRequestTrend(input);
      return reviewResult(draft.id);
    },
  );

  server.registerTool(
    "grafana_dashboard_validate_change",
    {
      description:
        "Validate candidate integrity and policy. Validity is not human approval.",
      inputSchema: idSchema,
    },
    async ({ changeSetId }) => {
      const review = workflow.view(changeSetId);
      return text({
        changeSetId,
        valid: review.validationErrors.length === 0,
        errors: review.validationErrors.slice(0, 5).map((error) => summaryText(error)),
        errorCount: review.validationErrors.length,
        state: review.state,
        digest: review.digest,
      });
    },
  );

  server.registerTool(
    "grafana_dashboard_preview_change",
    {
      description:
        "Prepare the visual review. When a dedicated Grafana preview is configured, this WRITES the candidate ONLY to that pre-authorized preview UID, verifies its content, and returns real Grafana links plus the local approval URL. The source dashboard is never written here. Reusing the shared preview supersedes previous previews. In offline/configuration mode no Grafana write occurs. Ask the user to inspect actual charts and errors before approving; never mark it viewed or approve on their behalf.",
      inputSchema: idSchema,
    },
    async ({ changeSetId }) => {
      await workflow.preparePreview(changeSetId);
      return reviewResult(changeSetId);
    },
  );

  server.registerTool(
    "grafana_dashboard_open_review",
    {
      description:
        "Open an existing draft's local review page in the system default EXTERNAL browser. Use after preview preparation; do not use the VS Code integrated browser for Grafana authentication. Accepts only a draft ID, never an arbitrary URL. The user opens Grafana links from that external page and handles login and approval. Launching does not prove rendering/authentication and does not mark the draft viewed or approved.",
      inputSchema: idSchema,
    },
    async ({ changeSetId }) =>
      text(await openReviewExternally(workflow, reviewOrigin, changeSetId)),
  );

  server.registerTool(
    "grafana_dashboard_review_status",
    {
      description:
        "Read compact review state, latest feedback and recent events. Full history and diff are on the review page. On changes_requested, clarify feedback and propose a new revision. If the ID was lost, use list_changes with the original dashboard UID. Do not poll while waiting for the user.",
      inputSchema: idSchema,
    },
    async ({ changeSetId }) => reviewResult(changeSetId),
  );

  server.registerTool(
    "grafana_dashboard_request_changes",
    {
      description:
        "Record the user's chat feedback and immediately revoke any approval before clarifying or revising. This can only restrict submission, never authorize it.",
      inputSchema: z
        .object({
          changeSetId: z.string().uuid(),
          feedback: z.string().trim().min(1).max(4000),
        })
        .strict(),
    },
    async ({ changeSetId, feedback }) => {
      workflow.requestChanges(changeSetId, workflow.view(changeSetId).digest, feedback);
      return reviewResult(changeSetId);
    },
  );

  server.registerTool(
    "grafana_dashboard_apply_change",
    {
      description:
        "Apply only a draft already approved by the user in the review page. Requires writes enabled, matching confirmation, fresh snapshot and unexpired approval. For operation=create, creates a NEW dashboard in the fixed SPOONS folder with no existing UID and overwrite=false, then verifies content and folder and returns createdDashboard.url. For updates, changes only the approved source. Never retries uncertain failures automatically.",
      inputSchema: z
        .object({
          changeSetId: z.string().uuid(),
          confirmation: z
            .string()
            .describe(
              "Exactly APPLY <changeSetId> after explicit permission to submit.",
            ),
        })
        .strict(),
    },
    async ({ changeSetId, confirmation }) => {
      await workflow.apply(changeSetId, confirmation);
      return reviewResult(changeSetId);
    },
  );

  return server;
}
