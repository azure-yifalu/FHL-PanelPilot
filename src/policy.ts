import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { defaultDashboardDestination } from "./dashboard-destination.js";
import {
  buildRequestTrend,
  requestTrendSchema,
  type RequestTrend,
} from "./request-trend.js";

export type PatchOperation = {
  op: "add" | "replace";
  path: string;
  value: unknown;
};
export type Dashboard = Record<string, unknown> & {
  uid: string;
  version: number;
  title: string;
  panels: Record<string, unknown>[];
};
export type ChangeSet = {
  id: string;
  dashboardUid: string;
  baseVersion: number;
  summary: string;
  goal: string;
  operations: PatchOperation[];
  before: Dashboard;
  candidate: Dashboard;
  digest: string;
  createdAt: string;
  requestTrend?: RequestTrend;
  creation?: DashboardCreation;
};

export type DashboardCreation = {
  folderUid: typeof defaultDashboardDestination.folderUid;
  bindingSource: Dashboard;
};

const dashboardSchema = z
  .object({
    uid: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    version: z.number().int().nonnegative(),
    title: z.string().min(1),
    panels: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const thresholdSchema = z
  .object({
    mode: z.enum(["absolute", "percentage"]),
    steps: z
      .array(
        z
          .object({
            color: z.string().min(1).max(80),
            value: z.number().finite().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (value) =>
      value.steps[0].value === null &&
      value.steps
        .slice(1)
        .every(
          (step, index) =>
            step.value !== null &&
            (index === 0 || step.value > value.steps[index].value!),
        ),
    "Threshold steps must start with null and increase.",
  );

const fields: Record<string, z.ZodType> = {
  title: z.string().trim().min(1).max(200),
  "gridPos.x": z.number().int().min(0).max(23),
  "gridPos.y": z.number().int().min(0).max(1000),
  "gridPos.w": z.number().int().min(1).max(24),
  "gridPos.h": z.number().int().min(1).max(100),
  "fieldConfig.defaults.unit": z.string().min(1).max(80),
  "fieldConfig.defaults.thresholds": thresholdSchema,
  "options.legend.displayMode": z.enum(["list", "table", "hidden"]),
  "options.legend.placement": z.enum(["bottom", "right"]),
  "options.legend.showLegend": z.boolean(),
};

function location(path: string): {
  panelIndex?: number;
  keys: string[];
  schema: z.ZodType;
} {
  if (path === "$.title") return { keys: ["title"], schema: fields.title };
  const match = /^\$\.panels\[(0|[1-9]\d*)\]\.(.+)$/.exec(path);
  if (!match || !Object.hasOwn(fields, match[2]))
    throw new Error(`Path is not allowed: ${path}`);
  return {
    panelIndex: Number(match[1]),
    keys: match[2].split("."),
    schema: fields[match[2]],
  };
}

export function parseDashboard(value: unknown): Dashboard {
  const dashboard = structuredClone(dashboardSchema.parse(value));
  if (
    dashboard.time !== null &&
    typeof dashboard.time === "object" &&
    !Array.isArray(dashboard.time)
  ) {
    const time = dashboard.time as Record<string, unknown>;
    for (const key of ["from", "to"]) {
      const timestamp = time[key];
      if (
        typeof timestamp === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
          timestamp,
        ) &&
        Number.isFinite(Date.parse(timestamp))
      ) {
        time[key] = new Date(timestamp).toISOString();
      }
    }
  }
  return dashboard;
}

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function readOperation(dashboard: Dashboard, path: string): unknown {
  if (["$.time", "$.timezone", "$.refresh"].includes(path))
    return dashboard[path.slice(2)];
  const panel = /^\$\.panels\[(0|[1-9]\d*)\]$/.exec(path);
  if (panel) return dashboard.panels[Number(panel[1])];
  const target = location(path);
  let value: unknown =
    target.panelIndex === undefined
      ? dashboard
      : dashboard.panels[target.panelIndex];
  for (const key of target.keys)
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return value;
}

export function buildCandidate(
  before: Dashboard,
  operations: PatchOperation[],
): Dashboard {
  if (operations.length === 0 || operations.length > 100)
    throw new Error("Between 1 and 100 operations are required.");
  const candidate = structuredClone(parseDashboard(before));
  for (const operation of operations) {
    if (operation.op !== "add" && operation.op !== "replace")
      throw new Error("Only add and replace are allowed.");
    const target = location(operation.path);
    const value = target.schema.parse(operation.value);
    let parent: Record<string, unknown> =
      target.panelIndex === undefined
        ? candidate
        : candidate.panels[target.panelIndex];
    if (!parent) throw new Error(`Panel does not exist: ${operation.path}`);
    for (const key of target.keys.slice(0, -1)) {
      if (!Object.hasOwn(parent, key) && operation.op === "add")
        parent[key] = {};
      const child = parent[key];
      if (child === null || typeof child !== "object" || Array.isArray(child))
        throw new Error(`Parent does not exist: ${operation.path}`);
      parent = child as Record<string, unknown>;
    }
    const key = target.keys.at(-1)!;
    if (operation.op === "replace" && !Object.hasOwn(parent, key))
      throw new Error(`Replace target does not exist: ${operation.path}`);
    parent[key] = structuredClone(value);
  }
  if (operations.some((operation) => operation.path.includes(".gridPos."))) {
    const positions = candidate.panels.map((panel) =>
      z
        .object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        })
        .parse(panel.gridPos),
    );
    for (const [index, position] of positions.entries()) {
      if (position.x + position.w > 24)
        throw new Error("Panel exceeds the 24-column dashboard grid.");
      if (
        positions
          .slice(index + 1)
          .some(
            (other) =>
              position.x < other.x + other.w &&
              position.x + position.w > other.x &&
              position.y < other.y + other.h &&
              position.y + position.h > other.y,
          )
      )
        throw new Error("Panel layouts overlap.");
    }
  }
  return candidate;
}

export function createChangeSet(input: {
  before: Dashboard;
  summary: string;
  goal: string;
  operations: PatchOperation[];
  requestTrend?: RequestTrend;
  creation?: DashboardCreation;
}): ChangeSet {
  if (!input.goal.trim() || !input.summary.trim())
    throw new Error("A confirmed goal and summary are required.");
  const before = structuredClone(parseDashboard(input.before));
  const operations = structuredClone(input.operations);
  const requestTrend = input.requestTrend
    ? requestTrendSchema.parse(input.requestTrend)
    : undefined;
  const creation = input.creation === undefined
    ? undefined
    : parseCreation(input.creation, before, requestTrend);
  if (requestTrend && operations.length)
    throw new Error(
      "A request trend cannot be mixed with arbitrary operations.",
    );
  const candidate = requestTrend
    ? buildRequestTrend(before, requestTrend, creation?.bindingSource)
    : buildCandidate(before, operations);
  if (digest(before) === digest(candidate))
    throw new Error("The proposal does not change the dashboard.");
  return {
    id: randomUUID(),
    dashboardUid: before.uid,
    baseVersion: before.version,
    goal: input.goal,
    summary: input.summary,
    operations,
    before,
    candidate,
    digest: creation ? digest({ candidate, creation }) : digest(candidate),
    createdAt: new Date().toISOString(),
    ...(requestTrend ? { requestTrend } : {}),
    ...(creation ? { creation } : {}),
  };
}

function parseCreation(
  input: DashboardCreation,
  before: Dashboard,
  trend: RequestTrend | undefined,
): DashboardCreation {
  const creation = z.object({
    folderUid: z.literal(defaultDashboardDestination.folderUid),
    bindingSource: dashboardSchema,
  }).strict().parse(input);
  if (
    !trend ||
    trend.sourcePanelId !== defaultDashboardDestination.bindingPanelId ||
    creation.bindingSource.uid !== defaultDashboardDestination.bindingDashboardUid
  )
    throw new Error("New dashboards must use the approved SPOONS request-trend binding.");
  if (
    before.id !== null ||
    before.version !== 0 ||
    !/^new-[a-f0-9-]{36}$/.test(before.uid) ||
    before.panels.length !== 0 ||
    Object.keys(before).some((key) => !["id", "uid", "version", "title", "panels"].includes(key))
  )
    throw new Error("New-dashboard drafts require an empty, unsaved baseline.");
  z.string().trim().min(1).max(200).parse(before.title);
  return structuredClone(creation);
}

export function validateChangeSet(changeSet: ChangeSet): string[] {
  try {
    if (changeSet.requestTrend && changeSet.operations.length)
      throw new Error(
        "A request trend cannot be mixed with arbitrary operations.",
      );
    if (
      changeSet.dashboardUid !== changeSet.before.uid ||
      changeSet.baseVersion !== changeSet.before.version
    )
      throw new Error("Snapshot identity mismatch.");
    const creation = changeSet.creation === undefined
      ? undefined
      : parseCreation(changeSet.creation, changeSet.before, changeSet.requestTrend);
    const expected = changeSet.requestTrend
      ? buildRequestTrend(changeSet.before, changeSet.requestTrend, creation?.bindingSource)
      : buildCandidate(changeSet.before, changeSet.operations);
    const contentDigest = (candidate: Dashboard) =>
      creation ? digest({ candidate, creation }) : digest(candidate);
    if (
      contentDigest(expected) !== changeSet.digest ||
      contentDigest(changeSet.candidate) !== changeSet.digest
    )
      throw new Error("Candidate content changed after proposal.");
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : "Invalid ChangeSet."];
  }
}

export function changePaths(change: ChangeSet): string[] {
  return change.requestTrend
    ? [
        ...(change.creation ? ["$.title"] : []),
        `$.panels[${change.before.panels.length}]`,
        "$.time",
        "$.timezone",
        "$.refresh",
      ]
    : change.operations.map((operation) => operation.path);
}
