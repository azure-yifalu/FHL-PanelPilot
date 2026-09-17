import open from "open";
import * as z from "zod/v4";
import type { ReviewWorkflow } from "./review-workflow.js";

export async function openReviewExternally(
  workflow: Pick<ReviewWorkflow, "view">,
  reviewOrigin: string,
  changeSetId: string,
) {
  const id = z.string().uuid().parse(changeSetId);
  workflow.view(id);
  const url = new URL(reviewOrigin);
  if (
    url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
    !url.port || url.username || url.password || url.pathname !== "/" ||
    url.search || url.hash
  ) {
    throw new Error("External review launch requires the gateway's loopback origin.");
  }
  url.searchParams.set("id", id);
  await open(url.toString(), { wait: false });
  return {
    launchRequested: true,
    browser: "system-default-external",
    url: url.toString(),
    message: "Browser launch requested. This does not verify page loading, authentication, preview inspection or approval.",
  };
}