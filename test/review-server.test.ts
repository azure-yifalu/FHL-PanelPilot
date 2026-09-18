import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { startReviewServer } from "../src/review-server.js";
import { ReviewWorkflow } from "../src/review-workflow.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function setup() {
  let current = {
    uid: "test",
    title: "Before",
    version: 1,
    panels: [],
  };
  const workflow = new ReviewWorkflow(
    {
      readDashboard: async () => structuredClone(current),
      updateDashboard: async (dashboard) => {
        current = { ...structuredClone(dashboard), version: dashboard.version + 1 };
      },
    },
  );
  const draft = await workflow.propose({
    dashboardUid: "test",
    goal: "Clear title",
    summary: "Rename",
    operations: [{ op: "replace", path: "$.title", value: "After" }],
  });
  const server = await startReviewServer(workflow, { port: 0 });
  closers.push(server.close);
  const html = await (await fetch(server.origin)).text();
  const csrf = /name="fhl-csrf" content="([a-f0-9]+)"/.exec(html)![1];
  const headers = {
    "X-FHL-CSRF": csrf,
    "Content-Type": "application/json",
    Origin: server.origin,
  };
  const post = (action: string, data: object = {}) =>
    fetch(`${server.origin}/api/reviews/${draft.id}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ digest: draft.digest, ...data }),
    });
  return { server, workflow, draft, headers, post };
}

describe("local review HTTP boundary", () => {
  it("serves the page and local assets with no-store and framing protection", async () => {
    const { server } = await setup();
    for (const asset of ["/", "/app.js", "/styles.css", "/lucide.js"]) {
      const response = await fetch(server.origin + asset);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      if (asset === "/") {
        const html = await response.text();
        expect(html).toContain("<title>PanelPilot | Dashboard review</title>");
        expect(html).toContain('aria-label="PanelPilot review home"');
        expect(html).toMatch(/<strong>PanelPilot<\/strong\s*>/);
        expect(html).not.toContain("Approve this version");
        expect(html).toContain("Approve and apply");
        expect(html).not.toContain("FHL / REVIEW WORKSPACE");
      }
    }
  });
  it("reports write capability to enable guarded review actions", async () => {
    const { workflow, draft } = await setup();
    expect(workflow.view(draft.id).writesEnabled).toBe(true);
  });
  it("rejects missing session headers, foreign origins and rebound hosts", async () => {
    const { server, headers } = await setup();
    expect((await fetch(`${server.origin}/api/reviews`)).status).toBe(403);
    expect(
      (
        await fetch(`${server.origin}/api/reviews`, {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(
        `${server.origin}/api/reviews`,
        { headers: { ...headers, Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(403);
  });
  it("requires viewed state and applies only after approval", async () => {
    const { post, workflow, draft } = await setup();
    expect((await post("approve")).status).toBe(400);
    expect((await post("viewed")).status).toBe(200);
    expect((await post("approve")).status).toBe(200);
    expect(
      (await post("apply", { confirmation: `APPLY ${draft.id}` })).status,
    ).toBe(200);
    expect(workflow.view(draft.id).state).toBe("applied");
    expect(
      (await post("feedback", { text: "Change the title again" })).status,
    ).toBe(400);
  });
  it("approves and applies through one explicit review action", async () => {
    const { post, workflow, draft } = await setup();
    expect((await post("approve-and-apply")).status).toBe(400);
    expect((await post("viewed")).status).toBe(200);
    expect((await post("approve-and-apply")).status).toBe(200);
    expect(workflow.view(draft.id).state).toBe("applied");
    const actions = workflow.view(draft.id).events.map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["approved in review page", "apply started"]),
    );
    expect(actions).toContainEqual(expect.stringMatching(/^verified dashboard version \d+$/));
  });
  it("rejects stale digests and arbitrary request fields", async () => {
    const { post } = await setup();
    expect((await post("viewed", { digest: "a".repeat(64) })).status).toBe(400);
    expect((await post("approve", { upstreamArguments: {} })).status).toBe(400);
  });
  it("uses another port when the requested port is occupied", async () => {
    const { server, workflow } = await setup();
    const next = await startReviewServer(workflow, {
      port: Number(new URL(server.origin).port),
    });
    closers.push(next.close);
    expect(next.origin).not.toBe(server.origin);
  });
});
