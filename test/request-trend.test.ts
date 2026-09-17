import { describe, expect, it } from "vitest";
import {
  buildRequestTrend,
  requestTrendQuery,
  resolveTrendPeriod,
  trendRange,
  type RequestTrend,
} from "../src/request-trend.js";
import {
  createChangeSet,
  validateChangeSet,
  buildCandidate,
  parseDashboard,
  type Dashboard,
} from "../src/policy.js";

const source: Dashboard = {
  uid: "source",
  version: 1,
  title: "Overview",
  panels: [
    {
      id: 5,
      title: "Enterprise",
      type: "timeseries",
      gridPos: { x: 0, y: 18, w: 13, h: 9 },
      datasource: {
        type: "grafana-azure-data-explorer-datasource",
        uid: "existing",
      },
      targets: [{ database: "o365monitoring", query: "Original query" }],
    },
  ],
};
const trend: RequestTrend = {
  sourcePanelId: 5,
  environment: "WW",
  days: 15,
  endDate: "2026-09-17",
};

describe("controlled Copilot daily request template", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");
  it("defaults to seven complete UTC days, not a rolling 168-hour range", () => {
    const period = resolveTrendPeriod(undefined, now);
    expect(period).toEqual({ days: 7, endDate: "2026-09-17" });
    expect(trendRange({ ...trend, ...period })).toEqual({
      from: "2026-09-10T00:00:00.000Z",
      to: "2026-09-17T00:00:00.000Z",
    });
  });
  it.each([1, 7, 15, 30, 366])("honors a requested %i-day range throughout the candidate", (days) => {
    const custom = { ...trend, ...resolveTrendPeriod({ days }, now) };
    const range = trendRange(custom);
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(days * 86400000);
    const candidate = buildRequestTrend(source, custom);
    expect(candidate.time).toEqual(range);
    expect(candidate.panels[1].description).toContain(`${days} complete UTC days`);
    const query = requestTrendQuery(custom);
    expect(query).toContain(`let Start = datetime(${range.from})`);
    expect(query).toContain(`let End = datetime(${range.to})`);
    expect(query).toContain("range Time from Start to (End - 1d) step 1d");
  });
  it.each([
    { startDate: "2026-09-16", endDate: "2026-09-16", days: 1, endExclusive: "2026-09-17" },
    { startDate: "2024-02-28", endDate: "2024-03-01", days: 3, endExclusive: "2024-03-02" },
    { startDate: "2025-12-31", endDate: "2026-01-01", days: 2, endExclusive: "2026-01-02" },
  ])("includes both requested dates: $startDate through $endDate", ({ startDate, endDate, days, endExclusive }) => {
    const period = resolveTrendPeriod({ startDate, endDate }, now);
    expect(period).toEqual({ days, endDate: endExclusive });
    expect(trendRange({ ...trend, ...period })).toEqual({
      from: `${startDate}T00:00:00.000Z`,
      to: `${endExclusive}T00:00:00.000Z`,
    });
  });
  it.each([
    { days: 0 },
    { days: -1 },
    { days: 1.5 },
    { days: Infinity },
    { startDate: "2026-09-10", endDate: "2026-09-17" },
    { startDate: "2026-09-10", endDate: "2026-09-18" },
    { startDate: "2026-09-10", endDate: "2026-09-09" },
    { startDate: "2026-02-29", endDate: "2026-03-01" },
    { startDate: "0000-01-01", endDate: "2026-03-01" },
    { startDate: "2026-09-10T12:00:00Z", endDate: "2026-09-16" },
    { days: 7, startDate: "2026-09-10", endDate: "2026-09-16" },
  ])("rejects invalid or ambiguous user periods: %j", (period) => {
    expect(() => resolveTrendPeriod(period, now)).toThrow();
  });
  it("rejects calendar underflow instead of emitting an invalid KQL datetime", () => {
    expect(() => trendRange({ ...trend, days: Number.MAX_SAFE_INTEGER })).toThrow("calendar");
    expect(() => trendRange({ ...trend, days: 1, endDate: "0001-01-01" })).toThrow("calendar");
  });
  it("normalizes only absolute dashboard time serialization, preserving query text and relative times", () => {
    const input = {
      ...source,
      time: { from: "2026-09-02T00:00:00Z", to: "2026-09-17T00:00:00Z" },
    };
    expect(parseDashboard(input).time).toEqual(trendRange(trend));
    expect(input.time.from).toBe("2026-09-02T00:00:00Z");
    expect(parseDashboard(input).panels).toEqual(source.panels);
    expect(
      parseDashboard({ ...source, time: { from: "now-15d/d", to: "now/d" } })
        .time,
    ).toEqual({ from: "now-15d/d", to: "now/d" });
  });
  it("uses exactly fifteen complete UTC days and three exclusive workload groups", () => {
    expect(trendRange(trend)).toEqual({
      from: "2026-09-02T00:00:00.000Z",
      to: "2026-09-17T00:00:00.000Z",
    });
    const query = requestTrendQuery(trend);
    expect(query).toContain("env_time >= Start and env_time < End");
    expect(query).toContain("bin(env_time, 1d)");
    expect(query).toContain('dynamic(["DA", "HVI", "SCD"])');
    expect(query).toContain("range Time from Start to (End - 1d) step 1d");
    expect(query).toContain('subScenario == "Post"');
    expect(query).not.toContain("IgnoredError");
    expect(query.indexOf('"DA",')).toBeLessThan(query.indexOf('"HVI",'));
  });
  it("adds a real line chart without replacing existing panels or data sources", () => {
    const candidate = buildRequestTrend(source, trend);
    expect(candidate.panels[0]).toEqual(source.panels[0]);
    expect(source.panels).toHaveLength(1);
    expect(candidate.panels[1]).toMatchObject({
      id: 6,
      type: "timeseries",
      gridPos: { x: 0, y: 27, w: 24, h: 10 },
      datasource: source.panels[0].datasource,
    });
    expect(candidate.timezone).toBe("utc");
    expect(candidate.uid).toBe(source.uid);
  });
  it("binds the generated query and time range to validation and rejects tampering", () => {
    const change = createChangeSet({
      before: source,
      goal: "Daily Copilot requests",
      summary: "15 days",
      operations: [],
      requestTrend: trend,
    });
    expect(validateChangeSet(change)).toEqual([]);
    change.candidate.time = { from: "now-6h", to: "now" };
    expect(validateChangeSet(change)[0]).toContain("changed");
  });
  it("rejects changed custom period parameters even if the candidate was not touched", () => {
    const change = createChangeSet({
      before: source,
      goal: "Custom period",
      summary: "30 days",
      operations: [],
      requestTrend: { ...trend, days: 30 },
    });
    expect(validateChangeSet(change)).toEqual([]);
    change.requestTrend!.days = 7;
    expect(validateChangeSet(change)).not.toEqual([]);
  });
  it("does not open generic query or whole-panel mutation paths", () => {
    expect(() =>
      buildCandidate(source, [
        {
          op: "replace",
          path: "$.panels[0].targets[0].query",
          value: "anything",
        },
      ]),
    ).toThrow("not allowed");
    expect(() =>
      createChangeSet({
        before: source,
        goal: "test",
        summary: "test",
        operations: [{ op: "replace", path: "$.title", value: "anything" }],
        requestTrend: trend,
      }),
    ).toThrow("mixed");
    expect(() =>
      buildRequestTrend(source, {
        ...trend,
        environment: 'WW"; anything',
      } as RequestTrend),
    ).toThrow();
    expect(() =>
      buildRequestTrend(source, { ...trend, endDate: "2026-02-31" }),
    ).toThrow();
    expect(() =>
      buildRequestTrend(source, { ...trend, sourcePanelId: 99 }),
    ).toThrow();
    expect(() =>
      buildRequestTrend(
        {
          ...source,
          panels: [
            {
              ...source.panels[0],
              datasource: { uid: "other", type: "prometheus" },
            },
          ],
        },
        trend,
      ),
    ).toThrow();
  });
});
