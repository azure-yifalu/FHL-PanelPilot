import * as z from "zod/v4";
import type { Dashboard } from "./policy.js";

const utcDateSchema = z.iso.date().regex(/^(?!0000)/, "Use a UTC date in years 0001-9999.");
const dayCountSchema = z.number().int().positive();
const dayMs = 86400000;

export const requestTrendTimeRangeSchema = z.union([
  z.object({ days: dayCountSchema }).strict(),
  z.object({
    startDate: utcDateSchema,
    endDate: utcDateSchema,
  }).strict(),
]);

export type RequestTrendTimeRange = z.infer<typeof requestTrendTimeRangeSchema>;

export const requestTrendSchema = z
  .object({
    sourcePanelId: z.number().int().positive(),
    environment: z.enum(["WW", "SIP", "MSIT", "DONMT", "SDFV2"]),
    days: dayCountSchema,
    endDate: utcDateSchema,
  })
  .strict();

export type RequestTrend = z.infer<typeof requestTrendSchema>;

export function resolveTrendPeriod(
  input: RequestTrendTimeRange | undefined,
  now: number,
): Pick<RequestTrend, "days" | "endDate"> {
  const period = requestTrendTimeRangeSchema.parse(
    input === undefined ? { days: 7 } : input,
  );
  const today = new Date(now).toISOString().slice(0, 10);
  if ("days" in period) return { days: period.days, endDate: today };
  if (period.startDate > period.endDate)
    throw new Error("UTC start date must not be after the end date.");
  if (period.endDate >= today)
    throw new Error("Choose complete UTC days: the end date must be before today.");
  const start = Date.parse(`${period.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${period.endDate}T00:00:00.000Z`) + dayMs;
  return {
    days: (end - start) / dayMs,
    endDate: new Date(end).toISOString().slice(0, 10),
  };
}

export function trendRange(input: RequestTrend) {
  const trend = requestTrendSchema.parse(input);
  const end = new Date(`${trend.endDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(end.getTime()) ||
    end.toISOString().slice(0, 10) !== trend.endDate
  )
    throw new Error("Invalid UTC end date.");
  const start = new Date(end.getTime() - trend.days * dayMs);
  if (
    !Number.isFinite(start.getTime()) ||
    start.getTime() < Date.parse("0001-01-01T00:00:00.000Z")
  )
    throw new Error("UTC time range starts before the supported calendar.");
  return { from: start.toISOString(), to: end.toISOString() };
}

export function requestTrendQuery(input: RequestTrend): string {
  const trend = requestTrendSchema.parse(input);
  const range = trendRange(trend);
  return `let Start = datetime(${range.from});
let End = datetime(${range.to});
let Counts = SpoonsAnalyticsEvent_Global
| where env_time >= Start and env_time < End
| where tenantId != "84df9e7f-e9f6-40af-b435-aaaaaaaaaaaa"
| where subScenario == "Post"
| where env_cloud_environment == "${trend.environment}"
| extend Workload = case(
    CopilotScenarios has "CopilotStudioDA" or CopilotScenarios has "CopilotStudioEmbeddedDA", "DA",
    CopilotScenarios has "spa" or CopilotScenarios has "refda" or CopilotScenarios has "userscd", "HVI",
    IsSCDItem == "True", "SCD",
    "Enterprise")
| where Workload in ("DA", "HVI", "SCD")
| summarize Requests = count() by Time = bin(env_time, 1d), Workload;
range Time from Start to (End - 1d) step 1d
| extend Workload = dynamic(["DA", "HVI", "SCD"])
| mv-expand Workload to typeof(string)
| join kind=leftouter Counts on Time, Workload
| project Time, Workload, Requests = coalesce(Requests, tolong(0))
| order by Time asc, Workload asc`;
}

export function buildRequestTrend(
  before: Dashboard,
  input: RequestTrend,
  bindingSource: Dashboard = before,
): Dashboard {
  const trend = requestTrendSchema.parse(input);
  const range = trendRange(trend);
  const binding = z
    .object({
      datasource: z.object({
        type: z.literal("grafana-azure-data-explorer-datasource"),
        uid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      }),
      targets: z
        .array(
          z.object({
            database: z.literal("o365monitoring"),
            datasource: z
              .object({
                type: z.literal("grafana-azure-data-explorer-datasource"),
                uid: z.string(),
              })
              .optional(),
          }),
        )
        .min(1),
    })
    .parse(bindingSource.panels.find((panel) => panel.id === trend.sourcePanelId));
  if (
    binding.targets.some(
      (target) =>
        target.datasource && target.datasource.uid !== binding.datasource.uid,
    )
  )
    throw new Error("Source panel uses inconsistent data sources.");
  const ids: number[] = [];
  let bottom = 0;
  const visit = (panels: Record<string, unknown>[]) => {
    for (const panel of panels) {
      const id = z.number().int().nonnegative().parse(panel.id);
      ids.push(id);
      const position = z
        .object({
          y: z.number().int().nonnegative(),
          h: z.number().int().positive(),
        })
        .parse(panel.gridPos);
      bottom = Math.max(bottom, position.y + position.h);
      if (Array.isArray(panel.panels))
        visit(panel.panels as Record<string, unknown>[]);
    }
  };
  visit(before.panels);
  const nextId = Math.max(0, ...ids) + 1;
  if (!Number.isSafeInteger(nextId) || bottom > 10000)
    throw new Error("Dashboard layout exceeds the supported range.");
  const candidate = structuredClone(before);
  candidate.time = range;
  candidate.timezone = "utc";
  candidate.refresh = "";
  candidate.panels.push({
    id: nextId,
    title: `Copilot ingestion requests per UTC day - DA / HVI / SCD - ${trend.environment}`,
    description:
      `Post request events, including all outcomes, not distinct user prompts. DA > HVI > SCD classification precedence. Missing days are shown as zero observed events, not proof of complete telemetry. Fixed ${trend.days} complete UTC days: ${range.from} to ${range.to}; end exclusive.`,
    type: "timeseries",
    datasource: binding.datasource,
    gridPos: { x: 0, y: bottom, w: 24, h: 10 },
    fieldConfig: {
      defaults: {
        unit: "short",
        decimals: 0,
        min: 0,
        color: { mode: "palette-classic" },
        custom: {
          drawStyle: "line",
          lineInterpolation: "linear",
          lineWidth: 2,
          fillOpacity: 0,
          showPoints: "always",
          pointSize: 5,
          spanNulls: false,
          stacking: { mode: "none", group: "A" },
        },
      },
      overrides: [],
    },
    options: {
      legend: {
        showLegend: true,
        displayMode: "list",
        placement: "bottom",
        calcs: [],
      },
      tooltip: { mode: "multi", sort: "none" },
    },
    targets: [
      {
        refId: "A",
        datasource: binding.datasource,
        database: "o365monitoring",
        queryType: "KQL",
        querySource: "raw",
        rawMode: true,
        resultFormat: "time_series",
        query: requestTrendQuery(trend),
      },
    ],
  });
  return candidate;
}
