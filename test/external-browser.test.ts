import { beforeEach, describe, expect, it, vi } from "vitest";
import open from "open";
import { openReviewExternally } from "../src/external-browser.js";
import { ReviewWorkflow } from "../src/review-workflow.js";

vi.mock("open", () => ({ default: vi.fn().mockResolvedValue({}) }));
beforeEach(() => vi.clearAllMocks());

async function setup() {
  const workflow = new ReviewWorkflow({
    readDashboard: async () => ({ uid: "test", title: "Before", version: 1, panels: [] }),
    updateDashboard: async () => { throw new Error("Must not write"); },
  }, false);
  const draft = await workflow.propose({ dashboardUid: "test", goal: "Clarify", summary: "Rename", operations: [{ op: "replace", path: "$.title", value: "After" }] });
  return { workflow, draft };
}

describe("external browser review launch", () => {
  it("opens the exact local draft in the system browser without marking it viewed or approved", async () => {
    const { workflow, draft } = await setup();
    const before = workflow.view(draft.id);
    const result = await openReviewExternally(workflow, "http://127.0.0.1:4317", draft.id);
    expect(open).toHaveBeenCalledWith(`http://127.0.0.1:4317/?id=${draft.id}`, { wait: false });
    expect(result.launchRequested).toBe(true);
    expect(result.browser).toBe("system-default-external");
    expect(workflow.view(draft.id)).toEqual(before);
  });
  it.each(["https://example.com", "file:///C:/Windows", "http://127.0.0.1.evil.example:4317", "http://user:secret@127.0.0.1:4317", "http://127.0.0.1:4317/other", "http://127.0.0.1:4317/?url=https://evil.example", "http://127.0.0.1:4317/#other"])("rejects an unexpected origin %s", async (origin) => {
    const { workflow, draft } = await setup();
    await expect(openReviewExternally(workflow, origin, draft.id)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });
  it("rejects unknown drafts and malformed identifiers before launching", async () => {
    const { workflow } = await setup();
    for (const id of ["https://evil.example", "'; Start-Process calc; '", "11111111-1111-4111-8111-111111111111"]) {
      await expect(openReviewExternally(workflow, "http://127.0.0.1:4317", id)).rejects.toThrow();
    }
    expect(open).not.toHaveBeenCalled();
  });
  it("propagates browser launch failures without changing approval state", async () => {
    const { workflow, draft } = await setup();
    vi.mocked(open).mockRejectedValueOnce(new Error("No desktop session"));
    await expect(openReviewExternally(workflow, "http://127.0.0.1:4317", draft.id)).rejects.toThrow("No desktop");
    expect(workflow.view(draft.id).previewViewed).toBe(false);
    expect(workflow.view(draft.id).state).toBe("awaiting_review");
  });
});