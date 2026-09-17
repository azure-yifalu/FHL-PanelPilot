import { describe, expect, it } from "vitest";
import {
  buildCandidate,
  createChangeSet,
  digest,
  validateChangeSet,
  type Dashboard,
} from "../src/policy.js";

export const dashboard: Dashboard = {
  uid: "dashboard-1",
  version: 3,
  title: "Service health",
  panels: [
    {
      id: 1,
      title: "Requests",
      type: "timeseries",
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
      targets: [{ expr: "rate(requests[5m])" }],
      datasource: { uid: "prod" },
    },
    {
      id: 2,
      title: "Errors",
      type: "stat",
      gridPos: { x: 12, y: 0, w: 12, h: 8 },
    },
  ],
};

describe("dashboard policy", () => {
  it("builds an isolated candidate and preserves queries, source, version and identity", () => {
    const change = createChangeSet({
      before: dashboard,
      goal: "Make traffic clearer",
      summary: "Rename traffic",
      operations: [
        { op: "replace", path: "$.panels[0].title", value: "Traffic" },
      ],
    });
    expect(validateChangeSet(change)).toEqual([]);
    expect(change.candidate.panels[0].title).toBe("Traffic");
    expect(dashboard.panels[0].title).toBe("Requests");
    expect(change.candidate.panels[0].targets).toEqual(
      dashboard.panels[0].targets,
    );
    expect(change.candidate.panels[0].datasource).toEqual(
      dashboard.panels[0].datasource,
    );
    expect(change.candidate.version).toBe(3);
    change.candidate.title = "Tampered";
    expect(validateChangeSet(change)[0]).toContain("changed");
  });
  it.each([
    "$.permissions",
    "$.panels",
    "$.panels[0]",
    "$.titleSuffix",
    "$.panels[0].targets",
    "$.panels[0].datasource",
    "$.panels[0].__proto__.title",
    "$.panels[*].title",
    "$.panels[0].options.legend.password",
  ])("rejects unsafe path %s", (path) => {
    expect(() =>
      buildCandidate(dashboard, [{ op: "add", path, value: "unsafe" }]),
    ).toThrow("Path is not allowed");
  });
  it("rejects credential objects, unknown panels, missing replace targets and invalid layout", () => {
    expect(() =>
      buildCandidate(dashboard, [
        {
          op: "replace",
          path: "$.panels[0].title",
          value: { token: "secret" },
        },
      ]),
    ).toThrow();
    expect(() =>
      buildCandidate(dashboard, [
        { op: "replace", path: "$.panels[9].title", value: "New" },
      ]),
    ).toThrow("Panel does not exist");
    expect(() =>
      buildCandidate(dashboard, [
        {
          op: "replace",
          path: "$.panels[0].fieldConfig.defaults.unit",
          value: "ms",
        },
      ]),
    ).toThrow("Parent does not exist");
    expect(() =>
      buildCandidate(dashboard, [
        { op: "replace", path: "$.panels[0].gridPos.w", value: 13 },
      ]),
    ).toThrow("overlap");
    expect(() =>
      buildCandidate(dashboard, [
        { op: "replace", path: "$.panels[1].gridPos.w", value: 13 },
      ]),
    ).toThrow("24-column");
  });
  it("supports bounded presentation additions", () => {
    const candidate = buildCandidate(dashboard, [
      { op: "add", path: "$.panels[0].fieldConfig.defaults.unit", value: "ms" },
      {
        op: "add",
        path: "$.panels[0].options.legend.placement",
        value: "right",
      },
    ]);
    expect(candidate.panels[0].fieldConfig).toEqual({
      defaults: { unit: "ms" },
    });
  });
  it("rejects empty changes and hashes objects independent of key order", () => {
    expect(() => buildCandidate(dashboard, [])).toThrow("operations");
    expect(digest({ title: "a", version: 3 })).toBe(
      digest({ version: 3, title: "a" }),
    );
  });
});
