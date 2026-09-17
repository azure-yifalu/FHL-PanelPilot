const csrf = document.querySelector('meta[name="fhl-csrf"]').content;
const element = (id) => document.getElementById(id);
let current;
let busy = false;
let loadVersion = 0;

function icon(name) {
  const node = document.createElement("i");
  node.dataset.lucide = name;
  return node;
}

function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function icons() {
  lucide.createIcons();
}
function message(text, error = false) {
  element("message").textContent = text;
  element("message").className = error ? "error" : "";
  element("message").hidden = !text;
}

async function api(path, data) {
  const response = await fetch(`/api/${path}`, {
    method: data ? "POST" : "GET",
    headers: {
      "X-FHL-CSRF": csrf,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Review request failed.");
  return result;
}

function controls() {
  const open =
    current &&
    ["awaiting_review", "approved", "changes_requested"].includes(
      current.state,
    );
  element("approve").disabled =
    busy ||
    !current ||
    current.state !== "awaiting_review" ||
    !current.previewViewed ||
    current.validationErrors.length > 0 ||
    !element("acknowledge").checked;
  element("approve").hidden =
    current?.state === "approved" || current?.state === "applied";
  element("apply").hidden = current?.state !== "approved";
  element("apply").textContent = current?.creation
    ? "Create approved dashboard"
    : "Apply approved version";
  element("apply").disabled = busy || !current?.writesEnabled;
  element("send-feedback").disabled = busy || !open;
  element("feedback").disabled = busy || !open;
  element("acknowledge").disabled =
    busy ||
    current?.state !== "awaiting_review" ||
    (current?.previewKind === "grafana-dashboard" && !current.livePreview);
  element("refresh").disabled = busy;
}

function renderDashboard(id, dashboard, changed) {
  const grid = element(id);
  grid.replaceChildren();
  if (!dashboard.panels.length)
    grid.append(textNode("p", "No panels", "unavailable"));
  dashboard.panels.forEach((panel, index) => {
    const tile = document.createElement("article");
    tile.className = `panel${changed.has(index) ? " changed" : ""}`;
    const position = panel.gridPos;
    const valid =
      position &&
      ["x", "y", "w", "h"].every((field) =>
        Number.isInteger(position[field]),
      ) &&
      position.x >= 0 &&
      position.y >= 0 &&
      position.w > 0 &&
      position.h > 0 &&
      position.x + position.w <= 24 &&
      position.y <= 1000 &&
      position.h <= 100;
    if (valid) {
      tile.style.gridColumn = `${position.x + 1} / span ${position.w}`;
      tile.style.gridRow = `${position.y + 1} / span ${position.h}`;
    } else {
      tile.style.gridColumn = "1 / -1";
      tile.style.minHeight = "120px";
    }
    const heading = textNode("div", "", "panel-head");
    heading.append(
      icon(
        panel.type === "stat"
          ? "hash"
          : panel.type === "table"
            ? "table"
            : panel.type === "row"
              ? "rows-3"
              : "chart-no-axes-combined",
      ),
      textNode("h3", String(panel.title || `Panel ${panel.id ?? index}`)),
    );
    tile.append(
      heading,
      textNode(
        "p",
        `${panel.type || "unknown"} / ID ${panel.id ?? index}`,
        "panel-meta",
      ),
    );
    if (!valid) tile.append(textNode("p", "Layout unavailable", "panel-meta"));
    if (panel.nestedPanels)
      tile.append(textNode("p", "Nested panels not expanded", "panel-meta"));
    const properties = textNode("div", "", "panel-properties");
    if (panel.unit)
      properties.append(
        textNode("span", `Unit: ${panel.unit}`, "panel-property"),
      );
    if (
      panel.legend &&
      Object.values(panel.legend).some((value) => value !== undefined)
    )
      properties.append(
        textNode(
          "span",
          `Legend: ${panel.legend.showLegend === false ? "off" : (panel.legend.displayMode ?? "default")} / ${panel.legend.placement ?? "default"}`,
          "panel-property",
        ),
      );
    if (Array.isArray(panel.thresholds?.steps)) {
      const thresholds = textNode(
        "div",
        `${panel.thresholds.mode}: `,
        "thresholds",
      );
      panel.thresholds.steps.forEach((step) => {
        const label = textNode(
          "span",
          step.value === null ? "base" : String(step.value),
        );
        const swatch = textNode("span", "", "swatch");
        swatch.style.backgroundColor = CSS.supports("color", step.color)
          ? step.color
          : "#818b85";
        label.title = String(step.color);
        label.prepend(swatch);
        thresholds.append(label);
      });
      properties.append(thresholds);
    }
    tile.append(properties);
    grid.append(tile);
  });
}

function renderReview(review) {
  current = review;
  element("inbox").hidden = true;
  element("detail").hidden = false;
  element("revision").textContent = `DRAFT / REVISION ${review.revision}`;
  element("title").textContent = review.after.title;
  element("summary").textContent = review.summary;
  element("goal").textContent = review.goal;
  element("change-scope").textContent = review.creation
    ? "New dashboard / only the requested chart / existing dashboards unchanged"
    : review.requestTrend
    ? "New daily request query / existing panels and data sources preserved / dashboard time changed"
    : "Queries and data sources unchanged";
  element("state").textContent = review.state.replaceAll("_", " ");
  element("state").dataset.state = review.state;
  element("uid").textContent = review.creation
    ? `New dashboard: ${review.createdDashboard?.uid ?? "UID assigned on creation"}`
    : `UID: ${review.dashboardUid}`;
  element("version").textContent = review.creation
    ? "Create only / no existing dashboard will be overwritten"
    : `Base version: ${review.baseVersion}`;
  element("creation-destination").hidden = !review.creation;
  element("creation-destination").textContent = review.creation
    ? `Destination: SPOONS (${review.creation.folderUid}) / ${review.creation.folderUrl}. Data-source binding from ${review.creation.bindingDashboardUid}, panel 5 only.`
    : "";
  element("created-dashboard").hidden = !review.createdDashboard;
  if (review.createdDashboard) {
    element("created-dashboard").href = review.createdDashboard.url;
    element("created-dashboard").textContent = review.state === "applied"
      ? "Open created dashboard"
      : "Inspect creation result (verification not complete)";
  }
  element("expires").textContent =
    `Expires: ${new Date(review.expiresAt).toLocaleTimeString()}`;
  element("before-title").textContent = review.creation ? "Not yet created" : review.before.title;
  element("after-title").textContent = review.after.title;
  const changed = new Set(
    review.diff
      .map((change) => /^\$\.panels\[(\d+)\]/.exec(change.path)?.[1])
      .filter((value) => value !== undefined)
      .map(Number),
  );
  renderDashboard("before", review.before, new Set());
  renderDashboard("after", review.after, changed);
  const live = review.previewKind === "grafana-dashboard";
  element("configuration-preview").hidden = live;
  element("live-preview").hidden = !live;
  element("preview-heading").textContent = live
    ? "Grafana preview"
    : "Configuration preview";
  element("preview-caption").textContent = live
    ? review.creation
      ? "Dedicated preview dashboard / final dashboard not created until approved apply"
      : "Dedicated preview dashboard / original unchanged"
    : "No live data / Not a Grafana render";
  element("acknowledge-label").textContent = live
    ? "I inspected this Grafana preview, its data and exact changes."
    : "I reviewed this version and its exact changes.";
  element("live-before").hidden = !review.livePreview;
  element("live-before").textContent = review.creation ? "Destination folder" : "Original dashboard";
  element("live-after").hidden = !review.livePreview;
  if (review.livePreview) {
    element("live-before").href = review.livePreview.beforeUrl;
    element("live-after").href = review.livePreview.url;
    const context = new URL(review.livePreview.url).searchParams;
    const variables = [...context.entries()]
      .filter(([key]) => key.startsWith("var-"))
      .map(([key, value]) => `${key.slice(4)}=${value}`)
      .join(" / ");
    element("live-context").textContent =
      `${new Date(Number(context.get("from"))).toISOString()} - ${new Date(Number(context.get("to"))).toISOString()} (end exclusive) / ${variables}`;
    element("live-status").textContent =
      `Preview UID ${review.livePreview.dashboardUid} / version ${review.livePreview.version}. Content verified; chart rendering and data access require your review. Shared destination: refresh stale tabs.`;
  } else {
    element("live-context").textContent = "";
    element("live-status").textContent =
      "Awaiting publication to the dedicated Grafana preview.";
  }
  element("change-count").textContent = String(review.diff.length);
  element("diff").replaceChildren(
    ...review.diff.map((change) => {
      const row = textNode("div", "", "diff-row");
      const values = textNode("div", "", "diff-values");
      values.append(
        textNode("pre", JSON.stringify(change.before, null, 2)),
        icon("arrow-right"),
        textNode("pre", JSON.stringify(change.after, null, 2)),
      );
      row.append(textNode("div", change.path, "diff-path"), values);
      return row;
    }),
  );
  element("history").replaceChildren(
    ...review.events.map((event) =>
      textNode(
        "li",
        `${new Date(event.createdAt).toLocaleTimeString()} - ${event.action}`,
      ),
    ),
  );
  element("identity").textContent =
    `Draft: ${review.id}\nSHA-256: ${review.digest}`;
  element("feedback-history").replaceChildren(
    ...review.feedback.map((entry) => {
      const node = textNode("div", "", "feedback-entry");
      node.append(
        textNode("small", new Date(entry.createdAt).toLocaleString()),
        textNode("p", entry.text),
      );
      return node;
    }),
  );
  element("validation").textContent = review.validationErrors.length
    ? review.validationErrors.join(" ")
    : "Policy checks passed";
  element("validation").className =
    `validation${review.validationErrors.length ? " error" : ""}`;
  element("write-status").textContent =
    review.state === "changes_requested"
      ? "Awaiting a revised draft from the agent."
      : review.writesEnabled
        ? review.creation
          ? "Apply creates a new dashboard in the displayed SPOONS folder; it never overwrites an existing dashboard."
          : "Only this approved version can be applied."
        : "Target writes disabled for this gateway session.";
  controls();
  icons();
}

async function load() {
  const version = ++loadVersion;
  const data = await api("reviews");
  if (version !== loadVersion) return;
  element("environment").textContent = data.demo
    ? "DEMO / local memory only"
    : "Local review";
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    current = undefined;
    element("inbox").hidden = false;
    element("detail").hidden = true;
    element("review-count").textContent = `${data.reviews.length} drafts`;
    element("empty").hidden = data.reviews.length > 0;
    element("review-list").replaceChildren(
      ...data.reviews.map((review) => {
        const link = document.createElement("a");
        link.href = `/?id=${encodeURIComponent(review.id)}`;
        link.className = "review-item";
        const copy = document.createElement("div");
        copy.append(
          textNode("h2", review.title),
          textNode("p", review.summary, "muted"),
        );
        link.append(
          icon("panels-top-left"),
          copy,
          textNode(
            "span",
            `v${review.revision} / ${review.state.replaceAll("_", " ")}`,
            "badge",
          ),
          icon("arrow-up-right"),
        );
        return link;
      }),
    );
    icons();
    return;
  }
  const review = await api(`reviews/${id}`);
  if (version !== loadVersion) return;
  element("acknowledge").checked = false;
  renderReview(review);
  if (review.error) message(review.error, true);
  if (
    review.state === "awaiting_review" &&
    review.previewKind !== "grafana-dashboard"
  ) {
    await new Promise(requestAnimationFrame);
    if (version !== loadVersion) return;
    const viewed = await api(`reviews/${id}/viewed`, { digest: review.digest });
    if (version === loadVersion) renderReview(viewed);
  }
}

async function action(name, extra = {}) {
  if (busy || !current) return;
  busy = true;
  controls();
  try {
    const review = await api(`reviews/${current.id}/${name}`, {
      digest: current.digest,
      ...extra,
    });
    element("acknowledge").checked = false;
    renderReview(review);
    if (name === "feedback") element("feedback").value = "";
    message(
      name === "apply"
        ? "Applied and verified."
        : name === "approve"
          ? "This draft version is approved. No changes have been submitted yet."
          : "Feedback recorded. Approval revoked.",
    );
  } catch (error) {
    try {
      renderReview(await api(`reviews/${current.id}`));
    } catch {}
    message(error.message, true);
  } finally {
    busy = false;
    controls();
  }
}

element("acknowledge").addEventListener("change", async () => {
  if (
    current?.previewKind !== "grafana-dashboard" ||
    !element("acknowledge").checked
  ) {
    controls();
    return;
  }
  busy = true;
  controls();
  try {
    renderReview(
      await api(`reviews/${current.id}/viewed`, { digest: current.digest }),
    );
  } catch (error) {
    element("acknowledge").checked = false;
    message(error.message, true);
  } finally {
    busy = false;
    controls();
  }
});
element("approve").addEventListener("click", () => action("approve"));
element("apply").addEventListener("click", () =>
  action("apply", { confirmation: `APPLY ${current.id}` }),
);
element("feedback-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action("feedback", { text: element("feedback").value });
});
element("refresh").addEventListener("click", () => {
  message("");
  load().catch((error) => message(error.message, true));
});
icons();
load().catch((error) => message(error.message, true));
