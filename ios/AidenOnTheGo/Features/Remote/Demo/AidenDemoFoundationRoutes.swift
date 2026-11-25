#if DEBUG
import CryptoKit
import Foundation

/// The `full` scenario's extra answers: every screen the new direction draws
/// has data behind it. A second Bot (running), an archived workspace, usage
/// history, scheduled tasks, Bot memory, routine results and workspace git.
///
/// Shapes follow the iOS decoders and validators, which are stricter than
/// `protocol/aiden-remote/v1/fixtures/contract.json` in three places: a git
/// `operationId` starts with `op_`, a scheduled task's revision with `rev_`,
/// and a task with MCP servers is an llm task with full access and no
/// workspace. Where the two disagree the demo follows the phone.
enum AidenDemoFull {
    static let relayBotId = "bot_relay"
    static let archivedWorkspaceId = "workspace_prototype"
    static let gitWorkspaceId = "workspace_app"

    /// Registers the extra routes for one machine. `baseBotList` and
    /// `baseWorkspaces` are the standard answers this adds to. `scale` varies
    /// usage between machines so two hosts don't read the same.
    static func register(
        instanceId id: String,
        responder: AidenDemoResponder,
        baseBotList: Data,
        baseBotDetail: Data,
        baseWorkspaces: Data,
        scale: Double
    ) {
        let now = Date()
        responder.reply(instanceId: id, path: "/bots", status: 200, json: botList(base: baseBotList))
        responder.reply(instanceId: id, path: "/bots/\(relayBotId)", status: 200, json: relayDetail(base: baseBotDetail))
        responder.reply(instanceId: id, path: "/bots/\(relayBotId)/session", status: 200, json: data(relaySession(now: now)))
        // The running Bot stays live: its event stream never ends.
        _ = responder.hold(instanceId: id, path: "/bots/\(relayBotId)/session/events")
        for botId in ["bot_scout", relayBotId] {
            responder.reply(instanceId: id, path: "/bots/\(botId)/memory", status: 200, json: data(memory(botId: botId, now: now)))
        }
        responder.reply(instanceId: id, path: "/bots/routine-notifications", status: 200, json: data(routineFeed(now: now)))
        responder.reply(instanceId: id, path: "/workspaces", status: 200, json: workspaces(base: baseWorkspaces, now: now))
        responder.reply(instanceId: id, path: "/usage", status: 200) { url in
            let range = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "range" }?.value ?? "30d"
            return data(usage(range: range, now: Date(), scale: scale))
        }
        registerSchedules(instanceId: id, responder: responder, now: now)
        registerGit(instanceId: id, responder: responder)
    }

    // MARK: Bots

    private static func relaySummary() -> [String: Any] {
        [
            "id": relayBotId,
            "name": "Relay",
            "purpose": "Keeps the release on track",
            "avatar": ["semantic": ["version": 1, "shape": "hex", "color": "sky"]],
            "health": "ready",
            "sessionState": "running",
            "createdAt": timestamp(Date().addingTimeInterval(-6 * 86_400)),
            "updatedAt": timestamp(Date().addingTimeInterval(-120)),
            "revision": "bot_revision_4",
        ]
    }

    private static func botList(base: Data) -> Data {
        var list = object(base)
        list["bots"] = (list["bots"] as? [[String: Any]] ?? []) + [relaySummary()]
        return data(list)
    }

    private static func relayDetail(base: Data) -> Data {
        var detail = object(base)
        detail.merge(relaySummary()) { $1 }
        detail["instructions"] = "Watch the release checklist, chase what is late, and say when something needs a person."
        if var access = detail["access"] as? [String: Any] {
            access["botId"] = relayBotId
            detail["access"] = access
        }
        return data(detail)
    }

    private static func relaySession(now: Date) -> [String: Any] {
        [
            "botId": relayBotId,
            "epoch": "epoch_demo_02",
            "seq": 9,
            "state": "running",
            "interrupted": false,
            "partial": "Checking which release tasks are still open",
            "entries": [
                [
                    "type": "message", "id": "entry_relay_1", "role": "user",
                    "text": "What is left before Friday's release?",
                    "createdAt": timestamp(now.addingTimeInterval(-90)),
                ],
            ],
            "hasOlder": false,
            "question": NSNull(),
            "approval": NSNull(),
        ]
    }

    // MARK: Memory

    /// `GET /bots/{id}/memory`, built the way the Mac builds it: entry ids from
    /// the text, `usedChars` over the texts joined with `\n§\n`.
    static func memory(botId: String, now: Date) -> [String: Any] {
        let notes: (memory: [String], user: [String]) = botId == relayBotId
            ? (["Release builds go out on Fridays after the checklist is green."], [])
            : (
                ["The upload test is flaky on CI, not locally.", "Weekly review happens on Monday mornings."],
                ["Prefers short summaries with the decision first."]
            )
        func group(_ target: String, _ texts: [String], limit: Int) -> [String: Any] {
            let used = texts.joined(separator: "\n§\n").count
            return [
                "entries": texts.map { ["id": hex16("\(target)\u{0}\($0)"), "text": $0] },
                "usedChars": used,
                "limitChars": limit,
                "overBudget": used > limit,
            ]
        }
        return [
            "botId": botId,
            "revision": hex16((notes.memory + notes.user).joined(separator: "\u{0}") + botId),
            "readable": true,
            "memory": group("memory", notes.memory, limit: 4_400),
            "user": group("user", notes.user, limit: 2_750),
            "updatedAt": timestamp(now.addingTimeInterval(-5_400)),
        ]
    }

    // MARK: Routine results

    private static func routineFeed(now: Date) -> [String: Any] {
        [
            "notifications": [
                [
                    "id": "run_demo_relay_01", "botId": relayBotId, "botName": "Relay",
                    "routineId": "routine_release_check", "routineName": "Release check",
                    "status": "succeeded", "finishedAt": timestamp(now.addingTimeInterval(-1_800)),
                    "preview": "Two checklist items are still open.",
                ],
                [
                    "id": "run_demo_scout_01", "botId": "bot_scout", "botName": "Scout",
                    "routineId": "routine_morning_brief", "routineName": "Morning brief",
                    "status": "failed", "finishedAt": timestamp(now.addingTimeInterval(-10_800)),
                    "preview": "",
                ],
            ],
            "now": timestamp(now),
        ]
    }

    // MARK: Workspaces

    /// The standard list plus one workspace this device has archived.
    private static func workspaces(base: Data, now: Date) -> Data {
        var list = object(base)
        var items = list["workspaces"] as? [[String: Any]] ?? []
        let created = timestamp(now.addingTimeInterval(-20 * 86_400))
        items.append([
            "id": archivedWorkspaceId, "name": "Prototype", "permission": "ask", "memoryEnabled": true,
            "hasFolder": true, "isManagedWorktree": false,
            "createdAt": created, "updatedAt": created, "revision": "workspace_revision_3",
        ])
        list["workspaces"] = items
        return data(list)
    }

    // MARK: Usage

    /// `GET /usage?range=`, summarised the way `usage-store-core.ts` does it:
    /// sparse days, totals that are the sum of the days, streaks counted back
    /// from today (or yesterday), and models busiest first.
    static func usage(range: String, now: Date, scale: Double) -> [String: Any] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        let today = calendar.startOfDay(for: now)
        func key(_ daysAgo: Int) -> String {
            formatter.string(from: calendar.date(byAdding: .day, value: -daysAgo, to: today) ?? today)
        }

        // 120 days back; the last nine all active, older ones with gaps.
        struct Day { let daysAgo: Int; let hosted: Int; let local: Int; let failed: Int }
        let history: [Day] = (0..<120).compactMap { daysAgo in
            guard daysAgo < 9 || (daysAgo * 7) % 5 != 0, daysAgo != 9 else { return nil }
            let base = 3 + (daysAgo * 13) % 17
            let total = max(1, Int((Double(base) * scale).rounded()))
            let local = total / 3
            return Day(daysAgo: daysAgo, hosted: total - local, local: local, failed: daysAgo % 11 == 0 ? 1 : 0)
        }
        let rangeDays = ["7d": 7, "30d": 30, "90d": 90, "1y": 365][range]
        let oldest = history.map(\.daysAgo).max() ?? 0
        let span = rangeDays ?? (oldest + 1)
        let inRange = history.filter { $0.daysAgo < span }.sorted { $0.daysAgo > $1.daysAgo }

        func tokens(hosted requests: Int) -> [String: Any] {
            let input = 1_800 * requests, output = 420 * requests
            let cacheRead = 900 * requests, cacheWrite = 120 * requests
            return [
                "input": input, "output": output, "cacheRead": cacheRead, "cacheWrite": cacheWrite,
                "cacheWrite1h": 0, "reasoning": 60 * requests, "total": input + output + cacheRead + cacheWrite,
            ]
        }
        let costPerRequest = 0.0125
        let days: [[String: Any]] = inRange.map { day in
            [
                "date": key(day.daysAgo),
                "requests": day.hosted + day.local,
                "reportedTokenRequests": day.hosted,
                "unmeteredRequests": day.local,
                "tokens": tokens(hosted: day.hosted),
                "hostedCostUsd": Double(day.hosted) * costPerRequest,
            ]
        }
        let hosted = inRange.reduce(0) { $0 + $1.hosted }
        let local = inRange.reduce(0) { $0 + $1.local }
        let failed = inRange.reduce(0) { $0 + $1.failed }
        let cost = inRange.reduce(0.0) { $0 + Double($1.hosted) * costPerRequest }

        // Streaks over the active days in range, as the Mac counts them.
        let active = Set(inRange.map(\.daysAgo))
        var longest = 0, run = 0, previous: Int?
        for daysAgo in active.sorted(by: >) {
            run = previous == daysAgo + 1 ? run + 1 : 1
            longest = max(longest, run)
            previous = daysAgo
        }
        var current = 0
        var cursor: Int? = active.contains(0) ? 0 : active.contains(1) ? 1 : nil
        while let day = cursor, active.contains(day) {
            current += 1
            cursor = day + 1
        }

        let hostedModel: [String: Any] = [
            "providerId": "provider_demo", "providerLabel": "Demo Cloud",
            "modelId": "model_demo", "modelLabel": "Demo Large", "local": false,
            "requests": hosted, "reportedTokenRequests": hosted, "unmeteredRequests": 0,
            "tokens": tokens(hosted: hosted), "hostedCostUsd": cost,
        ]
        let localModel: [String: Any] = [
            "providerId": "provider_local", "providerLabel": "This Mac",
            "modelId": "model_local", "modelLabel": "Demo Local", "local": true,
            "requests": local, "reportedTokenRequests": 0, "unmeteredRequests": local,
            "tokens": tokens(hosted: 0), "hostedCostUsd": 0.0,
        ]
        let models = [hostedModel, localModel].filter { ($0["requests"] as? Int ?? 0) > 0 }
            .sorted { ($0["requests"] as? Int ?? 0) > ($1["requests"] as? Int ?? 0) }

        return [
            "range": range,
            "startDate": key(span - 1),
            "endDate": key(0),
            "totals": [
                "requests": hosted + local,
                "completedRequests": hosted + local - failed,
                "failedRequests": failed,
                "cancelledRequests": 0,
                "reportedTokenRequests": hosted,
                "unmeteredRequests": local,
                "localRequests": local,
                "costedRequests": hosted,
                "unpricedHostedRequests": 0,
                "hostedCostUsd": cost,
                "activeDays": active.count,
                "currentStreak": current,
                "longestStreak": longest,
                "tokens": tokens(hosted: hosted),
            ],
            "days": days,
            "models": models,
        ]
    }

    // MARK: Scheduled tasks

    static let backupScriptId = "script_" + base64url(sha256("demo-backup-notes"))

    private static func registerSchedules(instanceId id: String, responder: AidenDemoResponder, now: Date) {
        let tasks = scheduledTasks(now: now)
        responder.reply(instanceId: id, path: "/scheduled-tasks", status: 200, json: data(["tasks": tasks]))
        for task in tasks {
            guard let taskId = task["id"] as? String else { continue }
            responder.reply(instanceId: id, path: "/scheduled-tasks/\(taskId)", status: 200, json: data(task))
            responder.reply(
                instanceId: id,
                path: "/scheduled-tasks/\(taskId)/runs",
                status: 200,
                json: data(["runs": scheduledRuns(taskId: taskId, running: task["running"] as? Bool == true, now: now)])
            )
        }
        responder.reply(instanceId: id, path: "/scheduled-tasks/notifications", status: 200) { _ in
            data(scheduledNotifications(now: Date()))
        }
        responder.reply(instanceId: id, path: "/scheduled-tasks/settings", status: 200, json: data([
            "revision": "rev_settings_1", "enabled": true, "defaultMode": "llm",
            "defaultPermission": "read-only", "defaultMcpEnabled": false, "defaultNotify": true,
            "defaultTimezone": TimeZone.current.identifier,
        ]))
        responder.reply(instanceId: id, path: "/scheduled-tasks/scripts", status: 200, json: data([
            "scripts": [["id": backupScriptId, "name": "Back up notes"]],
        ]))
        responder.reply(instanceId: id, path: "/scheduled-tasks/mcp-servers", status: 200, json: data([
            "servers": [["id": "mcp_linear", "name": "Linear"], ["id": "mcp_github", "name": "GitHub"]],
        ]))
    }

    private static func scheduledTasks(now: Date) -> [[String: Any]] {
        let created = timestamp(now.addingTimeInterval(-14 * 86_400))
        let updated = timestamp(now.addingTimeInterval(-2 * 86_400))
        let zone = TimeZone.current.identifier
        return [
            [
                "id": "task_morning_brief", "revision": "rev_morning_brief_3", "name": "Morning brief",
                "enabled": true, "schedule": "0 8 * * 1-5", "timezone": zone, "mode": "llm",
                "permission": "read-only", "notify": true, "running": false,
                "workspaceId": gitWorkspaceId,
                "prompt": "Summarise yesterday's commits and open reviews.",
                "nextRunAt": timestamp(now.addingTimeInterval(16 * 3_600)),
                "lastRunAt": timestamp(now.addingTimeInterval(-8 * 3_600)),
                "lastResult": "success",
                "createdAt": created, "updatedAt": updated,
            ],
            [
                "id": "task_inbox_triage", "revision": "rev_inbox_triage_1", "name": "Triage new issues",
                "enabled": true, "schedule": "0 * * * *", "timezone": zone, "mode": "llm",
                "permission": "full", "notify": false, "running": true,
                "mcpServerIds": ["mcp_linear"],
                "prompt": "Label new issues and flag anything urgent.",
                "nextRunAt": timestamp(now.addingTimeInterval(3_000)),
                "lastRunAt": timestamp(now.addingTimeInterval(-600)),
                "createdAt": created, "updatedAt": updated,
            ],
            [
                "id": "task_backup_notes", "revision": "rev_backup_notes_2", "name": "Back up notes",
                "enabled": false, "schedule": "30 23 * * *", "timezone": zone, "mode": "script",
                "permission": "full", "notify": false, "running": false,
                "workspaceId": "workspace_notes", "scriptId": backupScriptId,
                "lastRunAt": timestamp(now.addingTimeInterval(-3 * 86_400)),
                "lastResult": "silent",
                "createdAt": created, "updatedAt": updated,
            ],
        ]
    }

    private static func scheduledRuns(taskId: String, running: Bool, now: Date) -> [[String: Any]] {
        var runs: [[String: Any]] = []
        if running {
            runs.append([
                "id": "\(taskId)_run_live", "taskId": taskId, "status": "running",
                "startedAt": timestamp(now.addingTimeInterval(-40)),
            ])
        }
        for day in 1...3 {
            let started = now.addingTimeInterval(-Double(day) * 86_400)
            let failed = day == 2 && taskId == "task_morning_brief"
            var run: [String: Any] = [
                "id": "\(taskId)_run_\(day)", "taskId": taskId,
                "status": failed ? "failed" : "succeeded",
                "startedAt": timestamp(started),
                "finishedAt": timestamp(started.addingTimeInterval(95)),
            ]
            if failed {
                run["errorCode"] = "provider_unavailable"
            } else {
                run["summary"] = "Finished with nothing unusual to report."
            }
            runs.append(run)
        }
        return runs
    }

    private static func scheduledNotifications(now: Date) -> [String: Any] {
        let started = now.addingTimeInterval(-8 * 3_600)
        return [
            "notifications": [
                [
                    "id": "task_morning_brief_run_1", "taskId": "task_morning_brief", "taskName": "Morning brief",
                    "status": "succeeded", "startedAt": timestamp(started),
                    "finishedAt": timestamp(started.addingTimeInterval(95)),
                    "summary": "Four commits landed and two reviews are waiting on you.", "notify": true,
                ],
            ],
            "now": Int64(now.timeIntervalSince1970 * 1_000),
        ]
    }

    // MARK: Git

    static let reviewFileIds = [fileId("Sources/Upload/Uploader.swift"), fileId("docs/release-notes.md")]

    private static func registerGit(instanceId id: String, responder: AidenDemoResponder) {
        let root = "/workspaces/\(gitWorkspaceId)/git"
        let snapshot = "snap_demo_01"
        func envelope(_ operation: String, _ result: [String: Any]) -> Data {
            data(["operationId": "op_\(operation)", "status": "snapshot", "snapshotId": snapshot, "result": result])
        }
        responder.reply(instanceId: id, path: "\(root)/review", status: 200, json: envelope("review_01", [
            "kind": "review", "branch": "feature/mobile", "uncommitted": 2,
            "files": [
                [
                    "id": reviewFileIds[0], "displayPath": "Sources/Upload/Uploader.swift",
                    "status": "modified", "staged": false, "additions": 12, "deletions": 4,
                ],
                [
                    "id": reviewFileIds[1], "displayPath": "docs/release-notes.md",
                    "status": "added", "staged": true, "additions": 18, "deletions": 0,
                ],
            ],
        ]))
        responder.reply(instanceId: id, path: "\(root)/branches", status: 200, json: envelope("branches_01", [
            "kind": "branches", "current": "feature/mobile", "branches": ["main", "feature/mobile", "fix/upload-retry"],
        ]))
        responder.reply(instanceId: id, path: "\(root)/push-capability", status: 200, json: envelope("push_01", [
            "kind": "push-capability", "allowed": true, "remote": "origin", "branch": "feature/mobile",
        ]))
        responder.reply(instanceId: id, path: "\(root)/worktrees", status: 200, json: data([
            "operationId": "op_worktrees_01", "status": "snapshot",
            "result": [
                "kind": "worktrees",
                "worktrees": [
                    ["id": "worktree_main", "name": "Aiden Agent", "branch": "feature/mobile", "managed": false],
                    ["id": "worktree_retry", "name": "Upload retry", "branch": "fix/upload-retry", "managed": true],
                ],
            ],
        ]))
        // The request body names the file, which a responder can't read, so
        // every diff shows the first changed file.
        responder.reply(instanceId: id, method: "POST", path: "\(root)/diff", status: 200, json: envelope("diff_01", [
            "kind": "diff", "displayPath": "Sources/Upload/Uploader.swift", "truncated": false,
            "diff": """
            @@ -40,7 +40,15 @@ final class Uploader {
            -        try await send(chunk)
            +        for attempt in 1...3 {
            +            do {
            +                try await send(chunk)
            +                return
            +            } catch where attempt < 3 {
            +                try await Task.sleep(for: .seconds(attempt))
            +            }
            +        }
            """,
        ]))
    }

    // MARK: Helpers

    /// An opaque `file_` id the way the Mac makes one: 43 base64url characters.
    static func fileId(_ seed: String) -> String {
        "file_" + base64url(sha256(seed))
    }

    private static func sha256(_ text: String) -> Data {
        Data(SHA256.hash(data: Data(text.utf8)))
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The first 16 lowercase hex digits of the text's SHA-256.
    private static func hex16(_ text: String) -> String {
        sha256(text).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static func object(_ json: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] ?? [:]
    }

    private static func data(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
#endif
