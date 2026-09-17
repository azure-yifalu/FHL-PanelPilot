# PanelPilot development instructions

- Use the stable Model Context Protocol TypeScript SDK v2 APIs documented at https://ts.sdk.modelcontextprotocol.io/v2/.
- Keep Grafana writes behind server-side validation and explicit approval. Agent prompts are not an authorization boundary.
- Prefer Microsoft Entra ID and `https://dashboard.azure.com/.default`; do not add long-lived Grafana tokens to source or configuration.
- New upstream Grafana operations must be explicitly allowlisted and covered by policy tests.