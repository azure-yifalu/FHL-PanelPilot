import { describe, expect, it, vi } from "vitest";
import { GrafanaPreviewRenderer } from "../src/grafana-preview.js";
import { createChangeSet, type Dashboard } from "../src/policy.js";

const endpoint = "https://example.grafana.azure.com/api/azure-mcp";
const url =
  "https://example.grafana.azure.com/d/preview/preview-only?from=now-6h&to=now&var-environment=WW&orgId=1";
function setup() {
  let preview: Dashboard = {
    id: 90,
    uid: "preview",
    version: 4,
    title: "Sandbox",
    panels: [],
  };
  const source: Dashboard = {
    id: 10,
    uid: "source",
    version: 9,
    title: "Source",
    panels: [
      {
        id: 1,
        title: "Latency",
        datasource: { uid: "existing" },
        targets: [{ expr: "query" }],
      },
    ],
  };
  const change = createChangeSet({
    before: source,
    goal: "Clarify",
    summary: "Title",
    operations: [{ op: "replace", path: "$.title", value: "Service latency" }],
  });
  const gateway = {
    readDashboard: vi.fn(async () => structuredClone(preview)),
    updateDashboard: vi.fn(async (candidate: Dashboard) => {
      preview = {
        ...structuredClone(candidate),
        version: candidate.version + 1,
      };
    }),
  };
  return {
    change,
    gateway,
    renderer: new GrafanaPreviewRenderer(gateway, url, endpoint),
    mutate: () => {
      preview.title = "Changed elsewhere";
    },
  };
}

describe("fixed Grafana preview destination", () => {
  it("writes only the configured UID, preserves source content, and freezes comparison context", async () => {
    const { change, gateway, renderer } = setup();
    const artifact = await renderer.publish(change);
    const sent = gateway.updateDashboard.mock.calls[0][0];
    expect(sent).toEqual({
      ...change.candidate,
      id: 90,
      uid: "preview",
      version: 4,
      title: "Sandbox",
    });
    expect(artifact.previewTitle).toBe("Sandbox");
    expect(change.candidate.title).toBe("Service latency");
    expect(change.candidate.uid).toBe("source");
    expect(change.candidate.version).toBe(9);
    const afterUrl = new URL(artifact.url);
    const beforeUrl = new URL(artifact.beforeUrl);
    expect(afterUrl.search).toBe(beforeUrl.search);
    expect(beforeUrl.pathname).toBe("/d/source");
    expect(afterUrl.searchParams.get("var-environment")).toBe("WW");
    expect(
      Number(afterUrl.searchParams.get("to")) -
        Number(afterUrl.searchParams.get("from")),
    ).toBe(21600000);
    await renderer.verify(change, artifact);
  });
  it("keeps the dedicated title across repeated publications without changing the candidate title", async () => {
    const { change, gateway, renderer } = setup();
    await renderer.publish(change);
    const next = createChangeSet({ before: change.before, goal: "Rename a panel", summary: "Panel title", operations: [{ op: "replace", path: "$.panels[0].title", value: "Daily latency" }] });
    const artifact = await renderer.publish(next);
    expect(gateway.updateDashboard.mock.calls.at(-1)![0].title).toBe("Sandbox");
    expect(next.candidate.title).toBe("Source");
    await renderer.verify(next, artifact);
  });
  it("detects overwritten previews and invalid artifact identity", async () => {
    const { change, renderer, mutate } = setup();
    const artifact = await renderer.publish(change);
    await expect(
      renderer.verify(change, { ...artifact, candidateDigest: "wrong" }),
    ).rejects.toThrow("belong");
    mutate();
    await expect(renderer.verify(change, artifact)).rejects.toThrow(
      "changed or replaced",
    );
  });
  it("blocks source=preview, other origins and malformed URLs", async () => {
    const { change, gateway, renderer } = setup();
    await expect(
      renderer.publish({ ...change, dashboardUid: "preview" }),
    ).rejects.toThrow("source");
    expect(gateway.updateDashboard).not.toHaveBeenCalled();
    for (const invalid of [
      "https://other.example/d/preview",
      "http://example.grafana.azure.com/d/preview",
      "https://example.grafana.azure.com/",
      "https://user:secret@example.grafana.azure.com/d/preview",
    ]) {
      expect(
        () => new GrafanaPreviewRenderer(gateway, invalid, endpoint),
      ).toThrow();
    }
  });
  it("fails closed on read-back drift and does not force an overwrite", async () => {
    const { change, gateway, renderer } = setup();
    gateway.updateDashboard.mockImplementation(async () => {});
    await expect(renderer.publish(change)).rejects.toThrow("read-back");
    expect(gateway.updateDashboard).toHaveBeenCalledTimes(1);
  });
});
