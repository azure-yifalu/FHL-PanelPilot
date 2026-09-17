import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

it("runs the MCP -> preview -> feedback -> revision -> approval -> verified apply flow in offline mode", async () => {
  const client = new Client({
    name: "panelpilot-integration-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", "--demo"],
    cwd: process.cwd(),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      FHL_REVIEW_PORT: "0",
    },
    stderr: "pipe",
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({
      name: `grafana_dashboard_${name}`,
      arguments: args,
    });
    const content = result.content as { type: string; text: string }[];
    if (result.isError) throw new Error(content[0].text);
    return JSON.parse(content[0].text);
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(12);
    expect(
      tools.tools.some(
        (tool) => tool.name === "grafana_dashboard_propose_request_trend",
      ),
    ).toBe(true);
    expect(
      tools.tools.some((tool) => tool.name === "grafana_dashboard_open_review"),
    ).toBe(true);
    expect(tools.tools.some((tool) => tool.name.includes("approve"))).toBe(
      false,
    );
    await call("tool_schemas");
    await call("search", { arguments: { query: "service" } });
    await call("inspect", { dashboardUid: "demo-service", jsonPath: "$" });
    const args = {
      dashboardUid: "demo-service",
      goal: "Make the service name explicit",
      summary: "Rename dashboard",
      operations: [
        { op: "replace", path: "$.title", value: "Reviewed service" },
      ],
    };
    await expect(
      call("propose_change", {
        ...args,
        upstreamArguments: { overwrite: true },
      }),
    ).rejects.toThrow();
    const draft = await call("propose_change", args);
    expect(draft.changeSetId).toBe(draft.id);
    expect(draft).not.toHaveProperty("before");
    expect(draft).not.toHaveProperty("after");
    expect(draft).not.toHaveProperty("diff");
    const recovered = await call("list_changes", { dashboardUid: args.dashboardUid });
    expect(recovered.drafts[0].changeSetId).toBe(draft.changeSetId);
    expect((await call("list_changes", { dashboardUid: "unknown" })).drafts).toEqual([]);
    await expect(
      call("open_review", {
        changeSetId: draft.id,
        url: "https://evil.example",
      }),
    ).rejects.toThrow();
    await expect(
      call("open_review", {
        changeSetId: "11111111-1111-4111-8111-111111111111",
      }),
    ).rejects.toThrow("Unknown draft");
    expect(
      (await call("validate_change", { changeSetId: draft.id })).valid,
    ).toBe(true);
    expect(
      (await call("preview_change", { changeSetId: draft.id })).previewUrl,
    ).toBe(draft.previewUrl);
    await expect(
      call("apply_change", {
        changeSetId: draft.id,
        confirmation: `APPLY ${draft.id}`,
      }),
    ).rejects.toThrow("approved");
    const origin = new URL(draft.previewUrl).origin;
    const html = await (await fetch(origin)).text();
    const csrf = /name="fhl-csrf" content="([a-f0-9]+)"/.exec(html)![1];
    const post = async (
      review: { id: string; digest: string },
      action: string,
      extra: object = {},
    ) => {
      const response = await fetch(
        `${origin}/api/reviews/${review.id}/${action}`,
        {
          method: "POST",
          headers: {
            Origin: origin,
            "X-FHL-CSRF": csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ digest: review.digest, ...extra }),
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    await post(draft, "viewed");
    await post(draft, "approve");
    await call("request_changes", {
      changeSetId: draft.id,
      feedback: "Use checkout in the title",
    });
    expect(
      (await call("review_status", { changeSetId: draft.id })).feedback[0].text,
    ).toContain("checkout");
    await expect(
      call("apply_change", {
        changeSetId: draft.id,
        confirmation: `APPLY ${draft.id}`,
      }),
    ).rejects.toThrow("approved");
    const revised = await call("propose_change", {
      ...args,
      previousChangeSetId: draft.id,
      operations: [
        { op: "replace", path: "$.title", value: "Checkout service" },
      ],
    });
    expect(revised.revision).toBe(2);
    expect((await call("review_status", { changeSetId: draft.id })).state).toBe(
      "superseded",
    );
    await post(revised, "viewed");
    await post(revised, "approve");
    expect(
      (
        await call("apply_change", {
          changeSetId: revised.id,
          confirmation: `APPLY ${revised.id}`,
        })
      ).state,
    ).toBe("applied");
    expect(
      (await call("review_status", { changeSetId: revised.id })).events.at(-1)
        .action,
    ).toContain("verified dashboard version");
  } finally {
    await client.close();
  }
}, 20000);
