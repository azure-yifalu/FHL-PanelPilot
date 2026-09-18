import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import * as z from "zod/v4";
import type { ReviewWorkflow } from "./review-workflow.js";

const requestSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().max(4000).optional(),
    confirmation: z.string().optional(),
  })
  .strict();

async function body(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("Request body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return requestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
}

export async function startReviewServer(
  workflow: ReviewWorkflow,
  options: { port?: number; demo?: boolean } = {},
) {
  const csrf = randomBytes(32).toString("hex");
  let origin = "";
  const assets: Record<string, { file: URL; type: string }> = {
    "/": {
      file: new URL("../web/index.html", import.meta.url),
      type: "text/html; charset=utf-8",
    },
    "/app.js": {
      file: new URL("../web/app.js", import.meta.url),
      type: "text/javascript; charset=utf-8",
    },
    "/styles.css": {
      file: new URL("../web/styles.css", import.meta.url),
      type: "text/css; charset=utf-8",
    },
    "/lucide.js": {
      file: new URL(
        "../node_modules/lucide/dist/umd/lucide.js",
        import.meta.url,
      ),
      type: "text/javascript; charset=utf-8",
    },
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (status: number, value: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(value));
    };
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      json(403, { error: "Only same-origin loopback requests are accepted." });
      return;
    }
    try {
      const pathname = new URL(request.url ?? "/", origin).pathname;
      if (request.method === "GET" && Object.hasOwn(assets, pathname)) {
        const asset = assets[pathname];
        const contents = await readFile(asset.file, "utf8");
        response.writeHead(200, { "Content-Type": asset.type });
        response.end(
          pathname === "/" ? contents.replace("__CSRF__", csrf) : contents,
        );
        return;
      }
      if (
        pathname.startsWith("/api/") &&
        request.headers["x-fhl-csrf"] !== csrf
      ) {
        json(403, {
          error: "Open the review page to establish a local review session.",
        });
        return;
      }
      if (request.method === "GET" && pathname === "/api/reviews") {
        json(200, { reviews: workflow.list(), demo: options.demo === true });
        return;
      }
      const match =
        /^\/api\/reviews\/([a-f0-9-]{36})(?:\/(viewed|approve|approve-and-apply|feedback|apply))?$/.exec(
          pathname,
        );
      if (match && request.method === "GET" && !match[2]) {
        json(200, workflow.view(match[1]));
        return;
      }
      if (match && request.method === "POST" && match[2]) {
        if (
          request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json"
        ) {
          json(403, {
            error: "Review actions require same-origin JSON requests.",
          });
          return;
        }
        const input = await body(request);
        const id = match[1];
        if (input.digest !== workflow.view(id).digest)
          throw new Error("The displayed draft is stale. Refresh the review.");
        let result;
        switch (match[2]) {
          case "viewed":
            await workflow.verifyPreview(id);
            result = workflow.markViewed(id, input.digest);
            break;
          case "approve":
            result = await workflow.approveReviewed(id, input.digest);
            break;
          case "approve-and-apply":
            result = await workflow.approveAndApply(id, input.digest);
            break;
          case "feedback":
            result = workflow.requestChanges(
              id,
              input.digest,
              input.text ?? "",
            );
            break;
          case "apply":
            result = await workflow.apply(id, input.confirmation ?? "");
            break;
        }
        json(200, result);
        return;
      }
      json(404, { error: "Not found." });
    } catch (error) {
      json(400, {
        error:
          error instanceof Error ? error.message : "Review request failed.",
      });
    }
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListen);
        reject(error);
      };
      const onListen = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(port, "127.0.0.1");
    });
  try {
    await listen(options.port ?? 4317);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await listen(0);
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Review listener has no TCP address.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
