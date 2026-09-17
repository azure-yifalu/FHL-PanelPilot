import { digest, type ChangeSet, type Dashboard } from "./policy.js";
import type { DashboardGateway } from "./review-workflow.js";
import { trendRange } from "./request-trend.js";
import { assertCreationOrigin, defaultDashboardDestination } from "./dashboard-destination.js";

export type GrafanaPreview = {
  dashboardUid: string;
  previewTitle: string;
  candidateDigest: string;
  snapshotDigest: string;
  version: number;
  url: string;
  beforeUrl: string;
  publishedAt: string;
};

export interface PreviewRenderer {
  readonly dashboardUid: string;
  publish(change: ChangeSet): Promise<GrafanaPreview>;
  verify(change: ChangeSet, artifact: GrafanaPreview): Promise<void>;
}

function contentDigest(dashboard: Dashboard) {
  const { id, uid, version, ...content } = dashboard;
  return digest(content);
}

export class GrafanaPreviewRenderer implements PreviewRenderer {
  readonly dashboardUid: string;
  private readonly url: URL;

  constructor(
    private readonly gateway: DashboardGateway,
    previewUrl: string,
    upstreamEndpoint: string,
  ) {
    this.url = new URL(previewUrl);
    const match = /^\/d\/([a-zA-Z0-9_-]{1,64})(?:\/[^/]*)?$/.exec(
      this.url.pathname,
    );
    if (
      this.url.protocol !== "https:" ||
      this.url.username ||
      this.url.password ||
      !match ||
      this.url.origin !== new URL(upstreamEndpoint).origin
    ) {
      throw new Error(
        "Preview must be a fixed HTTPS dashboard URL in the configured Grafana instance.",
      );
    }
    this.dashboardUid = match[1];
    for (const key of [...this.url.searchParams.keys()]) {
      if (
        !["orgId", "from", "to", "timezone"].includes(key) &&
        !key.startsWith("var-")
      )
        this.url.searchParams.delete(key);
    }
    this.url.hash = "";
  }

  private urls(change: ChangeSet) {
    if (change.creation) assertCreationOrigin(this.url.toString());
    const preview = new URL(this.url);
    if (change.requestTrend) {
      const range = trendRange(change.requestTrend);
      preview.searchParams.set("from", String(Date.parse(range.from)));
      preview.searchParams.set("to", String(Date.parse(range.to)));
      preview.searchParams.set("timezone", "utc");
      preview.searchParams.set(
        "var-environment",
        change.requestTrend.environment,
      );
    }
    const from = preview.searchParams.get("from") ?? "now-6h";
    const to = preview.searchParams.get("to") ?? "now";
    const relative = /^now-(\d+)([mhd])$/.exec(from);
    const end = to === "now" ? Date.now() : Number(to);
    const units: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
    const start = relative
      ? end - Number(relative[1]) * units[relative[2]]
      : Number(from);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= end
    )
      throw new Error(
        "Preview URL requires a valid absolute range or now-Nm/h/d to now.",
      );
    preview.searchParams.set("from", String(start));
    preview.searchParams.set("to", String(end));
    preview.searchParams.set("refresh", "");
    const before = new URL(preview);
    before.pathname = `/d/${change.dashboardUid}`;
    if (change.requestTrend)
      preview.searchParams.set(
        "viewPanel",
        String(change.candidate.panels.at(-1)!.id),
      );
    return {
      url: preview.toString(),
      beforeUrl: change.creation ? defaultDashboardDestination.folderUrl : before.toString(),
    };
  }

  async publish(change: ChangeSet): Promise<GrafanaPreview> {
    if (change.dashboardUid === this.dashboardUid)
      throw new Error(
        "The preview dashboard cannot also be the source dashboard.",
      );
    const urls = this.urls(change);
    const previous = await this.gateway.readDashboard(this.dashboardUid);
    if (previous.uid !== this.dashboardUid)
      throw new Error("Preview destination identity mismatch.");
    const mapped: Dashboard = {
      ...structuredClone(change.candidate),
      id: previous.id,
      uid: this.dashboardUid,
      version: previous.version,
      title: previous.title,
    };
    if (contentDigest(previous) === contentDigest(mapped)) {
      return {
        ...urls,
        dashboardUid: this.dashboardUid,
        previewTitle: previous.title,
        candidateDigest: change.digest,
        snapshotDigest: digest(previous),
        version: previous.version,
        publishedAt: new Date().toISOString(),
      };
    }
    await this.gateway.updateDashboard(
      mapped,
      `PanelPilot preview ${change.id} / ${change.digest}`,
    );
    const observed = await this.gateway.readDashboard(this.dashboardUid);
    if (
      observed.uid !== this.dashboardUid ||
      observed.version <= previous.version ||
      contentDigest(observed) !== contentDigest(mapped)
    ) {
      throw new Error(
        "Grafana preview read-back differs from the candidate. Approval is blocked; inspect before retrying.",
      );
    }
    return {
      ...urls,
      dashboardUid: this.dashboardUid,
      previewTitle: previous.title,
      candidateDigest: change.digest,
      snapshotDigest: digest(observed),
      version: observed.version,
      publishedAt: new Date().toISOString(),
    };
  }

  async verify(change: ChangeSet, artifact: GrafanaPreview) {
    if (
      change.dashboardUid === this.dashboardUid ||
      artifact.dashboardUid !== this.dashboardUid ||
      artifact.candidateDigest !== change.digest
    )
      throw new Error("Preview does not belong to this candidate.");
    const current = await this.gateway.readDashboard(this.dashboardUid);
    if (
      digest(current) !== artifact.snapshotDigest ||
      current.title !== artifact.previewTitle ||
      contentDigest(current) !== contentDigest({ ...change.candidate, title: artifact.previewTitle })
    ) {
      throw new Error(
        "The preview dashboard was changed or replaced. Create and review a new preview before approval or submission.",
      );
    }
  }
}
