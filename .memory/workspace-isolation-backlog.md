# Workspace isolation backlog — 2026-11-02

Revalidated on main `9b2875d65f316265323d3d06a73904fbe00e2277` after #696. Findings 6.2 (populated No workspace copy/fork sharing a private folder/access) and 6.1 (first-send folder allocation invalidating the selected skill) were confirmed current by behavioral repros.

A shared main-process reservation now excludes concurrent assignment of an empty hidden home until its owning operation and failure cleanup settle. Desktop first-send, copy/fork and supported Remote creation all use this reservation; unknown commit outcomes keep it until restart/reconciliation.

The shared fork service now assigns a fresh hidden workspace through the existing workspace application service, admits both source and target, and releases only unowned targets on known failure. Unknown commit outcomes retain the target for reconciliation. Named-workspace forks, Bots, shared No workspace memory, existing shared copies and the legacy shared home remain unchanged; newly copied legacy chats get independent folders. Desktop workspace metadata is refreshed before navigating. iOS validates fork lineage rather than workspace equality; Android accepts the returned workspace already.

Desktop private first-send allocation now happens inside the main-owned first-message committer after durable-receipt replay checks. Its fingerprint keeps the submitted source identity; skill resolution keeps the original selection authority while the prepared turn and persisted chat own the destination. Both workspace admissions cancel/drain preparation. No Remote wire change or runtime network fetch was added.

Focused source tests reproduce the original folder sharing and cover file/access isolation, named-workspace sharing, refusal cleanup, skill handoff and replay. Native fork tests exercise returned private workspace IDs. Validation and PR details are recorded in the working chat.
