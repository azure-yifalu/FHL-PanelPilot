export const defaultDashboardDestination = {
  origin: "https://migreports-grafana2-a4e3gmemgwh5hday.eus.grafana.azure.com",
  folderUid: "dfs8revgy9ds0e",
  folderUrl: "https://migreports-grafana2-a4e3gmemgwh5hday.eus.grafana.azure.com/dashboards/f/dfs8revgy9ds0e/spoons",
  bindingDashboardUid: "yix8pjx",
  bindingPanelId: 5,
} as const;

export function assertCreationOrigin(endpoint: string | undefined) {
  if (!endpoint || new URL(endpoint).origin !== defaultDashboardDestination.origin)
    throw new Error("New dashboards require the configured SPOONS Grafana instance.");
}
