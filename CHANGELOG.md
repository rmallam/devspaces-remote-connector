# Changelog

## 0.10.2

- Use the Dev Spaces route host (`status.cheURL`) after API-server login instead of guessing `devspaces.` from the API name.
- Keep the API server from sign-in when reconnecting through a shared ingress.
- Update the active cluster URL only for the cluster that owns it.
- Give each ROSA and shared-ingress host its own cluster id so primary and DR do not collapse into one entry.
- Keep the OpenShift token when Connect uses that CheCluster host, so a dashboard on a different domain than the API server still finds the stored session.
- Stop hanging sign-in when the Dev Spaces URL is a shared ingress host.

## 0.7.0

### Architecture
- Expanded `ClusterEntry` — stores `id`, `apiUrl`, `devSpacesUrl`, `appsDomain`, `displayName` (resolved once, persisted)
- `WorkspaceModel` carries `clusterId` — every workspace knows its cluster, no scanning needed
- Stateless `KubeClientFactory` — each operation builds its own KubeConfig, no shared state between clusters
- Per-cluster API clients — each cluster gets its own CoreV1Api, CustomObjectsApi
- ConsoleLink discovery — queries OpenShift ConsoleLink CRs to find real DevSpaces URL (handles custom domains/CNAMEs)
- Token keyed by `appsDomain` — any URL from the same cluster resolves to the same token
- `urlToId` uses `appsDomain` — prevents duplicate cluster entries from different URLs
- Removed global `devspacesInitializing` view — replaced with per-cluster spinner in tree
- Refactored `initCluster` into focused methods

### Features
- Auto sign-in on IDE reopen — resolver triggers OAuth flow when token is missing/expired
- Auto workspace start on IDE reopen — starts stopped workspace before connecting
- Namespace provisioning flow — modal dialog per-cluster, progress notification while polling, notification when ready
- New Workspace from cluster context menu — right-click cluster, no cluster prompt
- Remove Cluster from command palette — prompts to pick which cluster
- Cluster tree spinner — shows loading animation while workspaces are being fetched
- REH download URL auto-constructed from VS Code's `updateUrl` in product.json
- Connections map — stores connection info per workspace for multi-workspace recent support
- Sign Out from Cluster — per-cluster sign-out with grayed-out state, click to re-auth
- Sign-in prompts for cluster URL before authentication (no premature consent dialog)
- Loading spinner in empty workspaces view while clusters initialize

### Bug Fixes
- Connect used wrong cluster's API — now uses `workspace.clusterId` for correct cluster
- Create workspace always used first cluster — now uses right-clicked cluster or prompts
- `ensureWorkspaceManager` double-prompted for cluster — removed from create commands
- `createViaDashboard` prompted for cluster again — now accepts `clusterId` directly
- `pickCluster` checked `.url` instead of `.devSpacesUrl` — always failed
- Remove cluster didn't clear settings — hostname vs appsDomain mismatch
- Remove last cluster didn't show sign-in view — now resets `CTX_AUTHENTICATED`
- Clear All Auth didn't delete all token keys — now deletes under all stored keys
- Clear All Auth didn't clear `devspaces.clusters` setting — re-populated on restart
- Empty REH download URL error in VS Code — clear error message added
- `storageType=per-workspace` removed from factory URLs
- `ignoreFocusOut` added to all input boxes and pickers

### Docs
- Comprehensive README with mermaid diagrams
- Key Design Decisions section
- `docs/SETUP_GUIDE.md` added
- Renamed CA bundle module to `ca-bundle.ts`

## 0.5.7

- Namespace discovery improvements
- Seamless reconnection on pod restart
- TLS CA bundle support
- CI/CD pipeline

## 0.5.0

- Initial release
- Browser-based OpenShift OAuth2 authentication
- K8s exec + port-forward remote connectivity
- Workspace lifecycle management
- Self-healing reconnection on pod reschedule
