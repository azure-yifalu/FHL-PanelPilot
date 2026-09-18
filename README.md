# PanelPilot

PanelPilot is a conversational Grafana dashboard agent backed by an IDE-first MCP gateway for previewing and applying guarded, explicitly approved changes. Built for the FHL hackathon.

The product and VS Code agent are named **PanelPilot**; the npm package is `panelpilot`. The existing `fhl-grafana` MCP registration, `FHL_*` environment variables, internal CSRF fields and workspace folder name remain unchanged for compatibility. These are technical identifiers, not the product name.

## Use PanelPilot

### Use this repository's SPOONS setup

1. Ask the repository owner for access, then clone and open the repository in VS Code:

	```powershell
	gh repo clone azure-yifalu/FHL-PanelPilot
	cd FHL-PanelPilot
	code .
	```

2. Install Node.js 24 or later, the Azure CLI, and the GitHub Copilot extension. Ensure your organization allows Copilot to use workspace MCP servers.
3. Sign in to the Azure tenant that owns the configured Managed Grafana workspace:

	```powershell
	az login
	npm install
	npm test
	npm run build
	```

4. In VS Code, run **MCP: List Servers**, start or restart `fhl-grafana`, and confirm that it is running. The first Grafana request may ask you to complete Azure authentication.
5. Open Copilot Chat and select **PanelPilot** from the agent picker. Give it the original Grafana dashboard URL and a concrete request, for example:

	```text
	Add a daily Copilot request-volume trend for WW, split into DA, HVI, and SCD, using the last 7 complete UTC days.
	```

6. PanelPilot inspects the source, validates a bounded ChangeSet, and opens the review page in your external browser. Open the proposed Grafana link there and verify the real charts, data, variables, and query errors.
7. Acknowledge and approve the current revision on the local review page. Approval alone does not update the source dashboard; an explicit Apply action or request submits the approved candidate.

This checkout is preconfigured for the internal SPOONS Grafana workspace. Users need Grafana Viewer access to inspect dashboards and Editor access to publish the shared preview or apply an approved change. The shared `SPOONS-Preview-Only` dashboard holds one candidate at a time, so publishing a preview replaces its previous contents. Final writes remain gated by review approval and a separate Apply action.

### Connect another Grafana workspace

Update `.vscode/mcp.json` before starting the MCP server:

- Set `GRAFANA_MCP_URL` to the Azure Managed Grafana MCP endpoint.
- Set `FHL_PREVIEW_DASHBOARD_URL` to a dedicated, disposable preview dashboard in the same Grafana instance.
- Set `FHL_ENABLE_PREVIEW_WRITES` to `true` only after explicitly authorizing that preview destination.
- Optionally set `FHL_REVIEW_PORT`; it defaults to `4317` and binds only to loopback.

Do not commit tokens or client secrets. PanelPilot uses Microsoft Entra ID through `DefaultAzureCredential` with the `https://dashboard.azure.com/.default` scope. The controlled SPOONS request-trend template and dashboard-creation destination are intentionally environment-specific; adapt their server-side allowlists and tests before using those operations with another workspace.

## Review-first workflow

Clarify the goal -> agree on a plan -> propose -> validate -> preview -> feedback or approval -> apply -> verify.

- The agent asks focused questions when a request is ambiguous and preserves agreed constraints across revisions.
- A loopback review page shows exact field differences, feedback and revision history, plus links to the original and proposed dashboards in real Grafana when a dedicated preview destination is configured.
- Real preview mode publishes the candidate to an explicitly authorized dashboard in the same Grafana instance. Grafana renders the actual panels using existing data sources, plugins and browser authentication. No iframe authentication bypass or simulated charts are used. The offline demo retains its clearly labeled configuration-only schematic.
- Approval requires opening the current preview and using the review page. There is no MCP approval tool. Approving does not submit; the user subsequently clicks Apply or explicitly asks the agent to apply.
- Feedback revokes approval, whether submitted in the page or recorded by the agent through `grafana_dashboard_request_changes`. A replacement draft supersedes prior open drafts for the same dashboard. Revisions carry the complete desired operation list relative to the live source, not relative to the prior preview.
- The gateway builds the candidate JSON itself. Preview, digest validation and submission refer to the same candidate. Caller-supplied `upstreamArguments` and `baseVersion` are no longer accepted.
- Submission compares the source snapshot and uses the original version with `overwrite: false`; concurrent modifications require a new preview and approval. After writing, the edited fields and version are read back and verified. Uncertain failures are never automatically retried.

## No target dashboard supplied

When the customer has not provided a target dashboard link, propose a **new dashboard** in the fixed [SPOONS folder](https://migreports-grafana2-a4e3gmemgwh5hday.eus.grafana.azure.com/dashboards/f/dfs8revgy9ds0e/spoons) (UID `dfs8revgy9ds0e`). Do not treat the data-source donor as the target or require the customer to supply a target link.

For the controlled daily request trend, omit `dashboardUid` and `sourcePanelId` from `grafana_dashboard_propose_request_trend`; optionally pass `dashboardTitle`. The server reads only the data-source binding from SPOONS Overview v2 (`yix8pjx`), panel `5`, and builds an empty, unsaved baseline plus the single requested chart. It does not copy the donor's panels, queries, variables or layout. The default 7-day range and custom complete-UTC-day ranges apply unchanged. Other arbitrary chart/query generation remains unsupported.

Proposal is read-only. Preview publication still writes only the dedicated preview dashboard, not the new target. The review page identifies the new-dashboard operation and folder and links to the **destination folder**, not a nonexistent original. Approval binds the candidate, folder and donor snapshot. Final Apply requires explicit user approval and a separate submission action. It rechecks the donor snapshot and preview, uses the existing allowlisted `amgmcp_dashboard_update` create mode with no UID, `id: null`, version `0` and `overwrite: false`, and never updates or moves an existing target. A title conflict fails instead of overwriting.

Creation reads back the generated UID, full content and folder metadata. Only a matching result is marked applied; the MCP result and review page then expose `createdDashboard.url`. Uncertain write/read-back failures consume approval and cannot be automatically retried. The draft's `new-*` UID is only a local review identity, never an existing Grafana UID. To revise before creation, omit `dashboardUid` and pass `previousChangeSetId`; this retains the draft's title and frozen dates unless explicitly changed. To recover a missing new-draft ID, call `grafana_dashboard_list_changes` without a dashboard UID. Do not restart to recover IDs. The offline demo continues to support its existing in-memory dashboard workflow only; verified new-dashboard creation uses the live gateway.

## Dedicated Grafana preview

The configured destination is `SPOONS-Preview-Only`, UID `yikhfbz`, in the existing SPOONS instance. This is dashboard-level separation, **not an isolated Grafana instance or security boundary**. Preview mode changes this dashboard's contents but never renames, moves or deletes it, alters its permissions, or modifies data source definitions. The destination's existing title is preserved; candidate panels and other dashboard content are published there. A proposed source-dashboard title change is shown in the local exact diff, not applied to the dedicated preview's name.

Configuration in `.vscode/mcp.json`:

- `FHL_PREVIEW_DASHBOARD_URL`: fixed HTTPS destination in the same origin as `GRAFANA_MCP_URL`; callers cannot supply another destination.
- `FHL_ENABLE_PREVIEW_WRITES=true`: permits publication to that destination only, based on the user's explicit preview authorization.

Provide the **original dashboard URL** when editing an existing dashboard; without a target link, use the new-dashboard flow above. A proposal reads its source or binding donor without writing. The preview tool then publishes its candidate to the dedicated UID, retaining the destination's database ID, title and version, and verifies the saved content. The preserved title is bound to the preview artifact; external title changes still invalidate the snapshot. For edits, the candidate for final submission retains the original source identity/version and its proposed title. New dashboards receive a fresh Grafana UID on approved creation. The preview UID cannot also be the source.

For edits, the review page opens the original and proposed dashboards in separate Grafana tabs with identical absolute time ranges and variables. For new dashboards, the original link is replaced by the destination folder. Defaults from the supplied link are the last six hours, `environment=WW`, `connectorType=All`, and browser timezone. An absolute range reduces time drift but is not a frozen data snapshot: ingestion, relative expressions inside queries, or changes to data source state can still affect results. The original link shows the live original, not a saved baseline screenshot. Refresh stale tabs and retain the supplied context when reviewing. The local page cannot observe cross-origin chart loading or query errors; its acknowledgment is the user's attestation, not automated visual verification.

The shared preview holds one candidate at a time. Publishing another invalidates prior open previews and approvals, including other source dashboards' previews. Approval and final submission recheck the preview's full saved snapshot. External edits or another gateway process overwriting the preview block stale approval/submission. Read-back drift fails closed. Process-local serialization prevents overlapping publication/application in one gateway; it is not a distributed lock across processes.

No cleanup/delete API is added. The latest preview remains until it is explicitly replaced. The user's existing preview content has not been overwritten merely by configuring the destination. API reads and browser login are separate: an Entra-authenticated gateway can read successfully while a new browser tab still requires sign-in.

## External browser

Draft-related MCP responses return compact summaries with explicit `changeSetId` (and the compatible `id` alias), validation status and review links rather than full dashboard configurations and diffs. The same summary is also available as MCP structured content. Full details remain on the local review page. This avoids large dashboard responses being externalized by the chat host and hiding the ID from the tool-only agent. If an earlier result was already externalized, `grafana_dashboard_list_changes` recovers IDs by original dashboard UID in pages of five; match the summary, creation time, revision and state before continuing. Recovery is read-only, does not authorize writes and cannot recover drafts lost on process restart. Status summaries include the latest feedback and three recent events; counts indicate when more history exists on the page.

Grafana authentication and review use the **system default external browser**, not VS Code's integrated browser. After preparing a preview, the agent calls `grafana_dashboard_open_review` with the draft ID. The local gateway uses the `open` package to launch that draft's loopback review URL in the external browser. Original/proposed Grafana links then open in the same external browser, where the user completes Entra login with their usual profile.

The launcher only accepts existing draft IDs, not arbitrary URLs or commands. It does not mark the draft viewed, acknowledge changes, or approve. A successful launch request does not prove that authentication, page loading or chart rendering succeeded. If browser launch is unavailable (for example, a headless/remote host), open the returned URL manually in an external browser with access to the gateway; there is no integrated-browser fallback. No cookies, credentials or browser automation/debugging access are requested. Restart the MCP server after updating to load this tool.

## Offline hackathon demo

```powershell
npm install
npm run demo
```

Open the local URL printed as `PanelPilot review:` (normally http://127.0.0.1:4317). A seeded service-health draft demonstrates layout changes. Review the exact differences, check the acknowledgment, approve, and apply. **Demo writes change only an in-memory fixture, never Grafana**, regardless of Azure environment variables. Restarting resets the example.

To exercise conversational revisions, temporarily add `--demo` to the existing MCP server's `npm run dev --silent` arguments after a `--` separator, then restart that MCP server. Use the review URL returned by its tools, not the URL of a separately running demo process. Ask the agent to revise `demo-service`, submit feedback in the page, and return to chat to continue. The review page itself does not run an LLM or automatically translate feedback into patches.

## Prerequisites

1. Node.js 24 or later.
2. Azure CLI signed in to the tenant that owns the Grafana workspace.
3. Grafana Viewer access for inspection; Grafana Editor access for updates.
4. GitHub Copilot MCP access enabled by organization policy.

## Run

```powershell
npm install
npm test
npm run build
```

Open this folder in VS Code, restart `fhl-grafana` from **MCP: List Servers** to load the new tool schemas, and select **PanelPilot** in Copilot Chat. The first Grafana call can prompt for Entra authentication through the available Azure credential chain. The MCP process also hosts the review page; each preview tool result contains its URL.

The checked-in MCP configuration points to the SPOONS Grafana workspace and enables the explicitly authorized dedicated preview writes. Final writes require a viewed, valid, unexpired approval plus a separate Apply action; preview and source snapshots are revalidated immediately before submission. Use a disposable source dashboard copy for integration testing. `FHL_REVIEW_PORT` defaults to 4317; an occupied port falls back to an OS-assigned port. Review data and approval sessions never bind to non-loopback interfaces.

## Supported changes

Use `add` for missing presentation properties and `replace` for existing ones. Parent objects may be created for allowed `add` operations. Only these exact paths are accepted:

| Path | Values |
| --- | --- |
| `$.title`, `$.panels[N].title` | Nonempty title, at most 200 characters |
| `$.panels[N].gridPos.x/y/w/h` | Bounded integer geometry; no overlaps or overflow past 24 columns |
| `$.panels[N].fieldConfig.defaults.unit` | Unit identifier |
| `$.panels[N].fieldConfig.defaults.thresholds` | Absolute/percentage steps, starting at null and strictly increasing |
| `$.panels[N].options.legend.displayMode` | list, table, hidden |
| `$.panels[N].options.legend.placement` | bottom, right |
| `$.panels[N].options.legend.showLegend` | Boolean |

Arbitrary panel creation/deletion, queries, data sources, permissions, variables, credentials and arbitrary JSONPath expressions remain out of scope for the generic patch tool. Review the meaning of unit and threshold changes: they can alter how operational data is interpreted even though queries are unchanged.

### Controlled daily Copilot request trend

`grafana_dashboard_propose_request_trend` accepts an existing target's `dashboardUid` and ADX `sourcePanelId`, an allowlisted `environment`, optional `timeRange`, and optional `previousChangeSetId`. Omit the target to propose a new dashboard as described above; `dashboardTitle` is supported only for creation. It reads the binding snapshot and adds a server-generated line chart for DA/HVI/SCD Post request events. New drafts default to the latest **7 complete UTC days**, excluding today. Honor a customer's specified range using either `timeRange: {"days": 30}` for the latest N complete UTC days, or `timeRange: {"startDate": "2026-09-01", "endDate": "2026-09-07"}` for inclusive UTC dates. Do not combine these forms. Dates must be valid, ordered and before today; timestamps, fractional/nonpositive day counts and calendar underflow are rejected, not silently replaced by defaults. An omitted range on a template revision preserves the previous draft's frozen dates, even across UTC midnight; an explicit range replaces them. No raw query, data source UID, database or table is accepted from the caller. The binding must come from an existing ADX panel in o365monitoring.

The fixed KQL uses SpoonsAnalyticsEvent_Global, includes all request outcomes, excludes the existing test tenant, and classifies DA before HVI before SCD. It counts events rather than distinct user prompts. It zero-fills the selected days x 3-group grid; zero means no observed events, not proof of complete ingestion. The query is frozen to the proposal's date range and environment; dashboard variable changes do not change this template's scope. Internally, `requestTrend.days` and `requestTrend.endDate` store the normalized period with an **exclusive** end date: September 1-7 inclusive becomes September 1 00:00 UTC through September 8 00:00 UTC exclusive.

The new panel is appended without changing existing panels or queries. Dashboard time becomes the selected absolute range, timezone UTC, and refresh disabled; these changes and the new query are shown in the exact diff. Proposal summaries and panel descriptions show the resolved dates. The preview URL uses that same range, overrides the six-hour default and focuses the new panel. Generic query patch paths remain blocked. Validation regenerates the entire candidate from the stored template parameters, and final read-back checks the added panel and time settings. Call validate_change, preview_change, and open_review after proposal to finish the preview flow.

## Code map

- `src/index.ts`: starts MCP and the loopback review server in one process.
- `src/mcp-server.ts`: tool schemas and workflow routing; no approval tool.
- `src/external-browser.ts`: restricted system-browser launch for existing loopback reviews.
- `src/policy.ts`: exact field allowlist, candidate generation and content integrity.
- `src/request-trend.ts`: bounded, server-generated daily DA/HVI/SCD request query and new chart.
- `src/dashboard-destination.ts`: fixed SPOONS creation folder, Grafana origin and donor binding identity.
- `src/review-workflow.ts`: revisions, feedback, approval, expiry, concurrency and read-back checks.
- `src/review-server.ts` and `web/`: local review HTTP boundary and responsive UI.
- `src/grafana-client.ts`: Entra-authenticated upstream MCP adapter.
- `src/grafana-preview.ts`: fixed preview destination, identity mapping, comparison context and preview integrity checks.
- `src/demo.ts`: isolated example dashboard for offline demos and tests.
- `test/`: policy, workflow, upstream contract, HTTP boundary and MCP integration tests.

## Security boundary

This is a single-user local prototype, not a multi-user authorization service. Drafts and audit events are process-local, expire after 30 minutes while open, and are lost on restart. Storage is capped at 100 drafts. A host check, same-origin JSON requests, session CSRF header, CSP, no-store responses and framing protection defend the browser boundary. They do not protect against malicious software or an unrestricted agent already running as the same OS user. The custom agent intentionally has only PanelPilot gateway tools.

Before multi-user deployment, add durable per-user approval/audit storage, authenticated reviewer identity, on-behalf-of authorization and remote HTTPS hosting. A future screenshot renderer must bind rendered artifacts to the candidate digest and rendering context; screenshots are not implemented here. No isolated Grafana environment is provisioned by this project.