import {
  createChangeSet,
  changePaths,
  digest,
  readOperation,
  validateChangeSet,
  type ChangeSet,
  type Dashboard,
  type PatchOperation,
} from "./policy.js";
import type { GrafanaPreview, PreviewRenderer } from "./grafana-preview.js";
import {
  requestTrendSchema,
  resolveTrendPeriod,
  trendRange,
  type RequestTrend,
  type RequestTrendTimeRange,
} from "./request-trend.js";
import { randomUUID } from "node:crypto";
import { defaultDashboardDestination } from "./dashboard-destination.js";

export interface DashboardGateway {
  readDashboard(uid: string): Promise<Dashboard>;
  updateDashboard(dashboard: Dashboard, message: string): Promise<void>;
  createDashboard?(
    dashboard: Dashboard,
    folderUid: string,
    message: string,
  ): Promise<{ uid: string }>;
  readCreatedDashboard?(
    uid: string,
  ): Promise<{ dashboard: Dashboard; folderUid: string }>;
}

export type ReviewState =
  | "awaiting_review"
  | "preparing_preview"
  | "changes_requested"
  | "approved"
  | "applying"
  | "applied"
  | "conflict"
  | "failed"
  | "verification_failed"
  | "superseded"
  | "expired";
type Review = {
  change: ChangeSet;
  revision: number;
  previousId?: string;
  state: ReviewState;
  viewedDigest?: string;
  approvedDigest?: string;
  feedback: { text: string; createdAt: string }[];
  events: { action: string; createdAt: string }[];
  expiresAt: number;
  error?: string;
  livePreview?: GrafanaPreview;
  createdDashboard?: { uid: string; url: string };
};

const editableStates: ReviewState[] = [
  "awaiting_review",
  "changes_requested",
  "approved",
];

function presentation(dashboard: Dashboard) {
  return {
    uid: dashboard.uid,
    version: dashboard.version,
    title: dashboard.title,
    panels: dashboard.panels.map((panel, index) => ({
      id: panel.id,
      type: panel.type,
      title: panel.title,
      gridPos: panel.gridPos,
      unit: readOperation(
        dashboard,
        `$.panels[${index}].fieldConfig.defaults.unit`,
      ),
      thresholds: readOperation(
        dashboard,
        `$.panels[${index}].fieldConfig.defaults.thresholds`,
      ),
      legend: Object.fromEntries(
        ["displayMode", "placement", "showLegend"].map((field) => [
          field,
          readOperation(
            dashboard,
            `$.panels[${index}].options.legend.${field}`,
          ),
        ]),
      ),
      nestedPanels: Array.isArray(panel.panels) && panel.panels.length > 0,
    })),
  };
}

export class ReviewWorkflow {
  private readonly reviews = new Map<string, Review>();
  private publishing = false;

  constructor(
    private readonly gateway: DashboardGateway,
    readonly writesEnabled: boolean,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly renderer?: PreviewRenderer,
  ) {}

  private event(review: Review, action: string) {
    review.events.push({
      action,
      createdAt: new Date(this.now()).toISOString(),
    });
  }

  private get(id: string): Review {
    const review = this.reviews.get(id);
    if (!review)
      throw new Error(
        "Unknown draft. It may have been lost when the gateway restarted.",
      );
    if (
      editableStates.includes(review.state) &&
      review.expiresAt <= this.now()
    ) {
      review.state = "expired";
      review.approvedDigest = undefined;
      this.event(review, "expired");
    }
    return review;
  }

  private checkDigest(review: Review, expected: string) {
    if (expected !== review.change.digest)
      throw new Error("The displayed draft is stale. Refresh the review.");
    const errors = validateChangeSet(review.change);
    if (errors.length) throw new Error(errors.join(" "));
  }

  async propose(input: {
    dashboardUid: string;
    goal: string;
    summary: string;
    operations: PatchOperation[];
    previousChangeSetId?: string;
    requestTrend?: RequestTrend;
    creation?: { title: string };
  }) {
    if (input.dashboardUid === this.renderer?.dashboardUid)
      throw new Error(
        "Choose the original dashboard as source, not the dedicated preview dashboard.",
      );
    const previous = input.previousChangeSetId
      ? this.get(input.previousChangeSetId)
      : undefined;
    if (previous && previous.change.dashboardUid !== input.dashboardUid)
      throw new Error("Revision dashboard does not match.");
    if (previous && Boolean(previous.change.creation) !== Boolean(input.creation))
      throw new Error("A revision cannot switch between creating and updating dashboards.");
    if (previous && !editableStates.includes(previous.state))
      throw new Error(
        "This draft can no longer be revised. Start a new proposal.",
      );
    if (
      input.creation &&
      (!this.gateway.createDashboard || !this.gateway.readCreatedDashboard)
    )
      throw new Error("This gateway does not support verified dashboard creation.");
    const sourceUid = input.creation
      ? defaultDashboardDestination.bindingDashboardUid
      : input.dashboardUid;
    const source = await this.gateway.readDashboard(sourceUid);
    if (source.uid !== sourceUid)
      throw new Error("Upstream returned a different dashboard.");
    const before: Dashboard = input.creation
      ? {
          id: null,
          uid: input.dashboardUid,
          version: 0,
          title: input.creation.title,
          panels: [],
        }
      : source;
    if (
      [...this.reviews.values()].some(
        (review) =>
          review.change.dashboardUid === input.dashboardUid &&
          review.state === "applying",
      )
    )
      throw new Error("A dashboard update is already in progress.");
    if (
      previous &&
      !editableStates.includes(this.get(previous.change.id).state)
    )
      throw new Error(
        "The previous draft changed while reading the dashboard.",
      );
    const change = createChangeSet({
      before,
      goal: input.goal,
      summary: input.summary,
      operations: input.operations,
      requestTrend: input.requestTrend,
      creation: input.creation
        ? { folderUid: defaultDashboardDestination.folderUid, bindingSource: source }
        : undefined,
    });
    if (this.reviews.size >= 100)
      throw new Error(
        "Review capacity reached. Restart the local gateway after completing existing reviews.",
      );
    for (const review of this.reviews.values()) {
      if (
        review.change.dashboardUid === input.dashboardUid &&
        editableStates.includes(review.state)
      ) {
        review.state = "superseded";
        review.approvedDigest = undefined;
        this.event(review, `superseded by ${change.id}`);
      }
    }
    const review: Review = {
      change,
      revision: (previous?.revision ?? 0) + 1,
      previousId: previous?.change.id,
      state: "awaiting_review",
      feedback: structuredClone(previous?.feedback ?? []),
      events: [],
      expiresAt: this.now() + this.ttlMs,
    };
    this.event(review, "proposed");
    this.reviews.set(change.id, review);
    return this.view(change.id);
  }

  async proposeRequestTrend(input: {
    dashboardUid?: string;
    sourcePanelId?: number;
    dashboardTitle?: string;
    environment: RequestTrend["environment"];
    timeRange?: RequestTrendTimeRange;
    previousChangeSetId?: string;
  }) {
    const previous = input.previousChangeSetId
      ? this.get(input.previousChangeSetId)
      : undefined;
    const previousTrend = previous?.change.requestTrend;
    const targetUid =
      input.dashboardUid ??
      (previous?.change.creation ? undefined : previous?.change.dashboardUid);
    const creating = targetUid === undefined;
    const sourcePanelId =
      input.sourcePanelId ??
      (creating
        ? defaultDashboardDestination.bindingPanelId
        : previousTrend?.sourcePanelId);
    if (creating && sourcePanelId !== defaultDashboardDestination.bindingPanelId)
      throw new Error("New request-trend dashboards use SPOONS Overview v2 panel 5.");
    if (!creating && input.dashboardTitle !== undefined)
      throw new Error("dashboardTitle is only supported when creating a new dashboard.");
    const period =
      input.timeRange === undefined && previousTrend
        ? { days: previousTrend.days, endDate: previousTrend.endDate }
        : resolveTrendPeriod(input.timeRange, this.now());
    const requestTrend = requestTrendSchema.parse({
      sourcePanelId,
      environment: input.environment,
      ...period,
    });
    const range = trendRange(requestTrend);
    const scope = `${requestTrend.days} complete UTC days, ${range.from} to ${range.to} (end exclusive)`;
    return this.propose({
      dashboardUid: targetUid ?? previous?.change.dashboardUid ?? `new-${randomUUID()}`,
      creation: creating
        ? {
            title:
              input.dashboardTitle ??
              previous?.change.before.title ??
              `Copilot ingestion requests - ${input.environment}`,
          }
        : undefined,
      previousChangeSetId: input.previousChangeSetId,
      goal: `SPOONS Copilot ingestion Post request events in ${input.environment}, split into DA, HVI and SCD; ${scope}. Include all outcomes; not distinct Copilot user prompts.`,
      summary:
        creating
          ? `Create a new dashboard in SPOONS (${defaultDashboardDestination.folderUid}) with only the daily DA / HVI / SCD request-count chart. Use ${scope}; existing dashboards remain unchanged.`
          : `Add a daily DA / HVI / SCD request-count line chart; preserve existing panels and data sources. Set dashboard time to ${scope} and disable refresh for review.`,
      operations: [],
      requestTrend,
    });
  }

  async preparePreview(id: string) {
    const review = this.get(id);
    if (!this.renderer) return this.view(id);
    if (review.state !== "awaiting_review")
      throw new Error("Only a pending draft can publish a preview.");
    this.checkDigest(review, review.change.digest);
    if (review.livePreview) {
      await this.verifyPreview(id);
      return this.view(id);
    }
    if (
      this.publishing ||
      [...this.reviews.values()].some((other) => other.state === "applying")
    )
      throw new Error(
        "The shared preview is busy. Wait for the current operation to finish.",
      );
    this.publishing = true;
    review.state = "preparing_preview";
    for (const other of this.reviews.values()) {
      if (
        other !== review &&
        other.livePreview &&
        editableStates.includes(other.state)
      ) {
        other.state = "superseded";
        other.approvedDigest = undefined;
        this.event(other, `preview slot reassigned to ${id}`);
      }
    }
    this.event(review, "publishing to dedicated Grafana preview");
    try {
      review.livePreview = await this.renderer.publish(review.change);
      review.state =
        this.now() >= review.expiresAt ? "expired" : "awaiting_review";
      this.event(
        review,
        `preview published at version ${review.livePreview.version}`,
      );
    } catch (error) {
      review.state = "failed";
      review.error =
        error instanceof Error
          ? error.message
          : "Preview publication failed. Inspect before retrying.";
      this.event(review, "preview publication failed");
      throw error;
    } finally {
      this.publishing = false;
    }
    return this.view(id);
  }

  async verifyPreview(id: string) {
    const review = this.get(id);
    if (!this.renderer) return;
    if (!review.livePreview)
      throw new Error(
        "Publish and inspect the real Grafana preview before approval.",
      );
    if (this.publishing)
      throw new Error("The shared preview is being replaced.");
    try {
      await this.renderer.verify(review.change, review.livePreview);
    } catch (error) {
      if (
        editableStates.includes(review.state) ||
        review.state === "applying"
      ) {
        review.state = "conflict";
        review.approvedDigest = undefined;
        review.viewedDigest = undefined;
        review.error =
          error instanceof Error ? error.message : "Preview no longer matches.";
        this.event(review, "preview conflict");
      }
      throw error;
    }
  }

  async approveReviewed(id: string, expectedDigest: string) {
    await this.verifyPreview(id);
    return this.recordApproval(id, expectedDigest);
  }

  view(id: string) {
    const review = this.get(id);
    const change = review.change;
    return structuredClone({
      id,
      revision: review.revision,
      previousId: review.previousId,
      state: review.state,
      dashboardUid: change.dashboardUid,
      operation: change.creation ? "create" : "update",
      creation: change.creation
        ? {
            folderUid: change.creation.folderUid,
            folderUrl: defaultDashboardDestination.folderUrl,
            bindingDashboardUid: change.creation.bindingSource.uid,
          }
        : undefined,
      createdDashboard: review.createdDashboard,
      baseVersion: change.baseVersion,
      summary: change.summary,
      goal: change.goal,
      digest: change.digest,
      createdAt: change.createdAt,
      expiresAt: new Date(review.expiresAt).toISOString(),
      before: presentation(change.before),
      after: presentation(change.candidate),
      diff: changePaths(change).map((path) => ({
        path,
        before: change.creation ? null : readOperation(change.before, path) ?? null,
        after: readOperation(change.candidate, path) ?? null,
      })),
      feedback: review.feedback,
      events: review.events,
      error: review.error,
      previewViewed: review.viewedDigest === change.digest,
      writesEnabled: this.writesEnabled,
      validationErrors: validateChangeSet(change),
      previewKind: this.renderer ? "grafana-dashboard" : "configuration-only",
      livePreview: review.livePreview,
      risk: change.requestTrend
        ? "controlled-query-template"
        : "presentation-only",
      requestTrend: change.requestTrend,
    });
  }

  list() {
    return [...this.reviews.keys()].reverse().map((id) => {
      const review = this.view(id);
      return {
        id,
        dashboardUid: review.dashboardUid,
        operation: review.operation,
        folderUid: review.creation?.folderUid,
        createdAt: review.createdAt,
        title: review.after.title,
        summary: review.summary,
        state: review.state,
        revision: review.revision,
      };
    });
  }

  markViewed(id: string, expectedDigest: string) {
    const review = this.get(id);
    this.checkDigest(review, expectedDigest);
    if (review.state !== "awaiting_review")
      throw new Error("This draft is not awaiting review.");
    if (this.renderer && !review.livePreview)
      throw new Error("The real Grafana preview has not been published.");
    if (review.viewedDigest !== expectedDigest)
      this.event(review, "preview viewed");
    review.viewedDigest = expectedDigest;
    return this.view(id);
  }

  approve(id: string, expectedDigest: string) {
    if (this.renderer)
      throw new Error(
        "Real Grafana previews require verified approval through approveReviewed.",
      );
    return this.recordApproval(id, expectedDigest);
  }

  private recordApproval(id: string, expectedDigest: string) {
    const review = this.get(id);
    this.checkDigest(review, expectedDigest);
    if (
      review.state !== "awaiting_review" ||
      review.viewedDigest !== expectedDigest
    )
      throw new Error("Open the current preview before approving it.");
    review.approvedDigest = expectedDigest;
    review.state = "approved";
    this.event(review, "approved in review page");
    return this.view(id);
  }

  requestChanges(id: string, expectedDigest: string, text: string) {
    const review = this.get(id);
    this.checkDigest(review, expectedDigest);
    if (!editableStates.includes(review.state))
      throw new Error("This draft is no longer open for feedback.");
    if (!text.trim() || text.length > 4000)
      throw new Error("Feedback must contain 1 to 4000 characters.");
    review.feedback.push({
      text: text.trim(),
      createdAt: new Date(this.now()).toISOString(),
    });
    review.state = "changes_requested";
    review.approvedDigest = undefined;
    review.viewedDigest = undefined;
    this.event(review, "changes requested");
    return this.view(id);
  }

  async apply(id: string, confirmation: string) {
    const review = this.get(id);
    if (!this.writesEnabled)
      throw new Error(
        "Dashboard writes are disabled. Restart with FHL_ENABLE_WRITES=true, then create and review a fresh draft.",
      );
    if (confirmation !== `APPLY ${id}`)
      throw new Error("Explicit confirmation does not match the draft ID.");
    this.checkDigest(review, review.change.digest);
    if (
      review.state !== "approved" ||
      review.approvedDigest !== review.change.digest
    )
      throw new Error(
        "The current preview must be approved in the review page.",
      );
    review.state = "applying";
    this.event(review, "apply started");
    let written = false;
    try {
      await this.verifyPreview(id);
      const creation = review.change.creation;
      const current = await this.gateway.readDashboard(
        creation?.bindingSource.uid ?? review.change.dashboardUid,
      );
      if (
        digest(current) !==
        digest(creation?.bindingSource ?? review.change.before)
      ) {
        review.state = "conflict";
        throw new Error(
          "Dashboard or data-source binding changed since preview. Create and approve a new draft.",
        );
      }
      if (this.now() >= review.expiresAt) {
        review.state = "expired";
        throw new Error(
          "Approval expired before submission. Create a new draft.",
        );
      }
      const message = `PanelPilot ${id}: ${review.change.summary}`.slice(0, 1024);
      let observed: Dashboard;
      let matches: boolean;
      if (creation) {
        if (!this.gateway.createDashboard || !this.gateway.readCreatedDashboard)
          throw new Error("This gateway does not support verified dashboard creation.");
        const result = await this.gateway.createDashboard(
          structuredClone(review.change.candidate),
          creation.folderUid,
          message,
        );
        written = true;
        if (
          !/^[a-zA-Z0-9_-]{1,64}$/.test(result.uid) ||
          [
            review.change.dashboardUid,
            creation.bindingSource.uid,
            this.renderer?.dashboardUid,
          ].includes(result.uid)
        )
          throw new Error("Creation returned an invalid or existing dashboard identity. Inspect before retrying.");
        review.createdDashboard = {
          uid: result.uid,
          url: `${defaultDashboardDestination.origin}/d/${result.uid}`,
        };
        const saved = await this.gateway.readCreatedDashboard(result.uid);
        observed = saved.dashboard;
        matches =
          observed.uid === result.uid &&
          observed.version > 0 &&
          saved.folderUid === creation.folderUid &&
          Object.entries(review.change.candidate).every(
            ([key, value]) =>
              ["id", "uid", "version"].includes(key) ||
              digest(observed[key] ?? null) === digest(value ?? null),
          );
      } else {
        await this.gateway.updateDashboard(
          structuredClone(review.change.candidate),
          message,
        );
        written = true;
        observed = await this.gateway.readDashboard(review.change.dashboardUid);
        matches =
          observed.uid === review.change.dashboardUid &&
          observed.version > review.change.baseVersion &&
          changePaths(review.change).every(
            (path) =>
              digest(readOperation(observed, path) ?? null) ===
              digest(readOperation(review.change.candidate, path) ?? null),
          );
      }
      if (!matches)
        throw new Error(
          "Write returned success, but read-back did not match the approved changes. Inspect the dashboard; do not retry automatically.",
        );
      review.state = "applied";
      this.event(review, `verified ${creation ? "created " : ""}dashboard version ${observed.version}`);
    } catch (error) {
      if (review.state === "applying")
        review.state = written ? "verification_failed" : "failed";
      review.error =
        error instanceof Error
          ? error.message
          : "Unknown update failure. Inspect before retrying.";
      this.event(review, review.state);
      throw error;
    } finally {
      review.approvedDigest = undefined;
    }
    return this.view(id);
  }
}
