#if DEBUG
import CryptoKit
import Foundation

/// The `full` scenario's extra answers: every screen the new direction draws
/// has data behind it. A second Bot (running), an archived workspace, usage
/// history, scheduled tasks, Bot memory and routines, routine results and
/// workspace git.
///
/// Shapes follow what the Mac sends (`main/services/aiden-remote-*.ts`), not
/// only what the phone's decoders accept: those are looser in places (an
/// optional git `capability`, an empty routine preview, any scheduled error
/// code), so passing them is not enough. Where `contract.json` and the phone
/// disagree, the demo follows the phone: a git `operationId` starts with
/// `op_`, a scheduled task's revision with `rev_`, and a task with MCP servers
/// is an llm task with full access and no workspace.
///
/// The two machines answer differently (`Host`), so a reply that lands on the
/// wrong machine shows.
enum AidenDemoFull {
    static let archivedWorkspaceId = "workspace_prototype"
    static let gitWorkspaceId = "workspace_app"
    static let worktreeWorkspaceId = "workspace_upload_retry"
    static let scoutBotId = "bot_scout"

    /// What one machine has beyond the standard answers.
    struct Host: Sendable {
        /// The second Bot, which is running.
        let botId: String
        let botName: String
        let botPurpose: String
        let botColor: String
        let routineName: String
        let routinePreview: String
        /// Usage volume, so two machines don't read the same.
        let scale: Double
        /// Whether the hourly triage task (running, with MCP servers) is here.
        let triages: Bool

        static let studio = Host(
            botId: "bot_relay", botName: "Relay", botPurpose: "Keeps the release on track", botColor: "sky",
            routineName: "Release check", routinePreview: "Two checklist items are still open.",
            scale: 1, triages: true
        )
        static let laptop = Host(
            botId: "bot_courier", botName: "Courier", botPurpose: "Sorts the travel inbox", botColor: "mint",
            routineName: "Inbox sweep", routinePreview: "Filed four receipts and one boarding pass.",
            scale: 0.4, triages: false
        )
    }

    /// Registers the extra routes for one machine. `baseBotList`,
    /// `baseBotDetail`, `baseWorkspaces` and `baseConversations` are the
    /// standard answers this adds to.
    static func register(
        instanceId id: String,
        host: Host,
        responder: AidenDemoResponder,
        baseBotList: Data,
        baseBotDetail: Data,
        baseWorkspaces: Data,
        baseConversations: @escaping @Sendable (URL) -> Data
    ) {
        // Whole seconds, so a timestamp the phone sends back as a cursor
        // names a run's time exactly.
        let now = Date(timeIntervalSince1970: Date().timeIntervalSince1970.rounded(.down))
        responder.reply(instanceId: id, path: "/bots", status: 200, json: botList(base: baseBotList, host: host, now: now))
        responder.reply(instanceId: id, path: "/bots/\(host.botId)", status: 200, json: botDetail(base: baseBotDetail, host: host, now: now))
        let session = runningSession(host: host, now: now)
        responder.reply(instanceId: id, path: "/bots/\(host.botId)/session", status: 200, json: data(session))
        // The running Bot stays live: its stream opens with a snapshot frame,
        // as the Mac's does, and stays open until the phone leaves.
        let frame = snapshotFrame(session: session)
        responder.stream(instanceId: id, path: "/bots/\(host.botId)/session/events") { frame }
        for botId in [scoutBotId, host.botId] {
            responder.reply(instanceId: id, path: "/bots/\(botId)/memory", status: 200, json: data(memory(botId: botId, host: host, now: now)))
            responder.reply(instanceId: id, path: "/bots/\(botId)/routines", status: 200, json: data([
                "routines": routines(host: host, now: now).filter { $0.botId == botId }.map { $0.object(host: host, now: now) },
            ]))
        }
        responder.reply(instanceId: id, path: "/bot-conversations", status: 200) { url in
            botConversations(base: baseConversations(url), host: host, url: url, now: now)
        }
        responder.reply(instanceId: id, path: "/bots/routine-notifications", status: 200) { url in
            data(routineFeed(host: host, since: query("since", in: url), now: now, current: Date()))
        }
        if AidenDemoBotUX.isRequested {
            // The revision 61 screens read per-Bot routes for the second Bot too.
            AidenDemoBotUX.register(instanceId: id, botId: host.botId, responder: responder)
        }
        responder.reply(instanceId: id, path: "/workspaces", status: 200, json: workspaces(base: baseWorkspaces, now: now))
        let scale = host.scale
        responder.reply(instanceId: id, path: "/usage", status: 200) { url in
            data(usage(range: query("range", in: url) ?? "30d", now: Date(), scale: scale))
        }
        registerSchedules(instanceId: id, host: host, responder: responder, now: now)
        registerGit(instanceId: id, responder: responder)
    }

    // MARK: Bots

    private static func summary(host: Host, now: Date) -> [String: Any] {
        [
            "id": host.botId,
            "name": host.botName,
            "purpose": host.botPurpose,
            "avatar": ["semantic": ["version": 1, "shape": "hex", "color": host.botColor]],
            "health": "ready",
            "sessionState": "running",
            "createdAt": timestamp(now.addingTimeInterval(-6 * 86_400)),
            "updatedAt": timestamp(now.addingTimeInterval(-120)),
            "revision": "bot_revision_4",
        ]
    }

    private static func botList(base: Data, host: Host, now: Date) -> Data {
        var list = object(base)
        list["bots"] = (list["bots"] as? [[String: Any]] ?? []) + [summary(host: host, now: now)]
        return data(list)
    }

    private static func botDetail(base: Data, host: Host, now: Date) -> Data {
        var detail = object(base)
        detail.merge(summary(host: host, now: now)) { $1 }
        detail["instructions"] = "\(host.botPurpose). Chase what is late, and say when something needs a person."
        if var access = detail["access"] as? [String: Any] {
            access["botId"] = host.botId
            detail["access"] = access
        }
        return data(detail)
    }

    private static func runningSession(host: Host, now: Date) -> [String: Any] {
        [
            "botId": host.botId,
            "epoch": "epoch_demo_02",
            "seq": 9,
            "state": "running",
            "interrupted": false,
            "partial": "Checking what is still open",
            "entries": [
                [
                    "type": "message", "id": "entry_\(host.botId)_1", "role": "user",
                    "text": "What is left before Friday?",
                    "createdAt": timestamp(now.addingTimeInterval(-90)),
                ],
            ],
            "hasOlder": false,
            "question": NSNull(),
            "approval": NSNull(),
        ]
    }

    /// The first frame of `GET /bots/{id}/session/events`: the whole session.
    private static func snapshotFrame(session: [String: Any]) -> Data {
        let frame: [String: Any] = [
            "protocolVersion": 1,
            "botId": session["botId"] as Any,
            "epoch": session["epoch"] as Any,
            "seq": session["seq"] as Any,
            "type": "snapshot",
            "payload": ["session": session],
        ]
        return Data("data: \(String(decoding: data(frame), as: UTF8.self))\n\n".utf8)
    }

    /// The standard search answer plus the second Bot's chat when it matches.
    private static func botConversations(base: Data, host: Host, url: URL, now: Date) -> Data {
        var list = object(base)
        let search = query("query", in: url)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preview = host.routinePreview
        if search.isEmpty || host.botName.localizedCaseInsensitiveContains(search)
            || preview.localizedCaseInsensitiveContains(search) {
            // Newest first: the running Bot's chat moved most recently.
            let conversation: [String: Any] = [
                "chatId": "chat_\(host.botId)", "botId": host.botId, "title": host.botName,
                "preview": preview, "activityState": "running", "canRespondToApproval": false,
                "createdAt": timestamp(now.addingTimeInterval(-6 * 86_400)),
                "updatedAt": timestamp(now.addingTimeInterval(-120)),
                "revision": "bot_conversation_revision_3",
            ]
            list["conversations"] = [conversation] + (list["conversations"] as? [[String: Any]] ?? [])
        }
        return data(list)
    }

    // MARK: Routines

    /// A Bot routine and its last run, which the routine-results feed reports.
    private struct Routine {
        let id: String
        let botId: String
        let name: String
        let botName: String
        let time: String
        let label: String
        let message: String
        let ranAgo: TimeInterval
        let failed: Bool
        let preview: String

        func object(host: Host, now: Date) -> [String: Any] {
            var routine: [String: Any] = [
                "id": id, "botId": botId, "name": name, "message": message,
                "schedule": ["kind": "daily", "time": time],
                "timezone": TimeZone.current.identifier, "label": label, "enabled": true,
                "nextRunAt": timestamp(now.addingTimeInterval(86_400 - ranAgo)),
                "lastRunAt": timestamp(now.addingTimeInterval(-ranAgo)),
                "lastResult": failed ? "error" : "success",
                "updatedAt": timestamp(now.addingTimeInterval(-4 * 86_400)),
                "revision": "routine_revision_2",
            ]
            if failed { routine["lastError"] = "The calendar connection needs signing in again." }
            return routine
        }
    }

    private static func routines(host: Host, now: Date) -> [Routine] {
        [
            Routine(
                id: "routine_\(host.botId)_daily", botId: host.botId, name: host.routineName, botName: host.botName,
                time: "09:00", label: "Every day at 9:00 AM", message: "Go through today's list and report what is open.",
                ranAgo: 1_800, failed: false, preview: host.routinePreview
            ),
            Routine(
                id: "routine_morning_brief", botId: scoutBotId, name: "Morning brief", botName: "Scout",
                time: "08:00", label: "Every day at 8:00 AM", message: "Brief me on yesterday's work.",
                ranAgo: 10_800, failed: true,
                // The Mac's text for every failed routine.
                preview: "I couldn't finish this routine."
            ),
        ]
    }

    /// `GET /bots/routine-notifications?since=`: the routines' last runs that
    /// finished after `since` (ISO), newest first.
    private static func routineFeed(host: Host, since: String?, now: Date, current: Date) -> [String: Any] {
        let cutoff = since.flatMap(date(fromISO:))
        let items: [[String: Any]] = routines(host: host, now: now)
            .map { ($0, now.addingTimeInterval(-$0.ranAgo)) }
            .filter { cutoff == nil || $0.1 > cutoff! }
            .sorted { $0.1 > $1.1 }
            .map { routine, finished in
                [
                    "id": "run_\(routine.id)_latest", "botId": routine.botId, "botName": routine.botName,
                    "routineId": routine.id, "routineName": routine.name,
                    "status": routine.failed ? "failed" : "succeeded",
                    "finishedAt": timestamp(finished), "preview": routine.preview,
                ]
            }
        return ["notifications": items, "now": timestamp(current)]
    }

    // MARK: Memory

    /// `GET /bots/{id}/memory`, built the way the Mac builds it: entry ids from
    /// the text, `usedChars` in UTF-16 units (JavaScript's `length`) over the
    /// texts joined with `\n§\n`.
    static func memory(botId: String, host: Host, now: Date) -> [String: Any] {
        let notes: (memory: [String], user: [String]) = botId == host.botId
            ? (["\(host.botName) reports on Fridays after the checklist is green."], [])
            : (
                ["The upload test is flaky on CI, not locally.", "Weekly review happens on Monday mornings."],
                ["Prefers short summaries with the decision first."]
            )
        func group(_ target: String, _ texts: [String], limit: Int) -> [String: Any] {
            let used = texts.joined(separator: "\n§\n").utf16.count
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

    // MARK: Workspaces

    /// The standard list plus one workspace this device has archived and the
    /// managed worktree `GET .../git/worktrees` lists.
    private static func workspaces(base: Data, now: Date) -> Data {
        var list = object(base)
        var items = list["workspaces"] as? [[String: Any]] ?? []
        let created = timestamp(now.addingTimeInterval(-20 * 86_400))
        items.append([
            "id": archivedWorkspaceId, "name": "Prototype", "permission": "ask", "memoryEnabled": true,
            "hasFolder": true, "isManagedWorktree": false,
            "createdAt": created, "updatedAt": created, "revision": "workspace_revision_3",
        ])
        items.append([
            "id": worktreeWorkspaceId, "name": "Upload retry", "permission": "ask", "memoryEnabled": true,
            "hasFolder": true, "isManagedWorktree": true,
            "git": ["isRepo": true, "branch": "fix/upload-retry", "uncommitted": 0],
            "createdAt": created, "updatedAt": created, "revision": "workspace_revision_1",
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

    /// One stored run, which `/runs`, the notifications feed and the task's
    /// `lastRunAt` all read, as on the Mac.
    private struct Run {
        enum Result { case success, error, silent }
        let id: String
        let taskId: String
        let started: Date
        let finished: Date
        let result: Result
        let output: String?
        let error: String?

        /// `mapRun` in `aiden-remote-schedules.ts`.
        var object: [String: Any] {
            var run: [String: Any] = [
                "id": id, "taskId": taskId,
                "status": result == .error ? "failed" : "succeeded",
                "startedAt": timestamp(started), "finishedAt": timestamp(finished),
            ]
            if let summary = error ?? output, !summary.isEmpty { run["summary"] = summary }
            if result == .error { run["errorCode"] = "execution_failed" }
            return run
        }
    }

    private static func runs(host: Host, now: Date) -> [String: [Run]] {
        func run(_ taskId: String, _ index: Int, ago: TimeInterval, _ result: Run.Result, output: String? = nil, error: String? = nil) -> Run {
            let finished = now.addingTimeInterval(-ago)
            return Run(
                id: "\(taskId)_run_\(index)", taskId: taskId, started: finished.addingTimeInterval(-95),
                finished: finished, result: result, output: output, error: error
            )
        }
        var runs = [
            "task_morning_brief": [
                run("task_morning_brief", 3, ago: 8 * 3_600, .success, output: "Four commits landed and two reviews are waiting on you."),
                run("task_morning_brief", 2, ago: 32 * 3_600, .error, error: "The workspace folder could not be read."),
                run("task_morning_brief", 1, ago: 56 * 3_600, .success, output: "A quiet day: one commit, no reviews."),
            ],
            "task_backup_notes": [run("task_backup_notes", 1, ago: 3 * 86_400, .silent)],
        ]
        if host.triages {
            // The task is running again now, but `/runs` lists finished runs only.
            runs["task_inbox_triage"] = [
                run("task_inbox_triage", 3, ago: 600, .success, output: "Labelled three new issues; one looks urgent."),
                run("task_inbox_triage", 2, ago: 4_200, .success, output: "Labelled one new issue."),
                run("task_inbox_triage", 1, ago: 7_800, .silent),
            ]
        }
        return runs
    }

    private static func registerSchedules(instanceId id: String, host: Host, responder: AidenDemoResponder, now: Date) {
        let runs = runs(host: host, now: now)
        let tasks = scheduledTasks(host: host, runs: runs, now: now)
        responder.reply(instanceId: id, path: "/scheduled-tasks", status: 200, json: data(["tasks": tasks]))
        for task in tasks {
            guard let taskId = task["id"] as? String else { continue }
            responder.reply(instanceId: id, path: "/scheduled-tasks/\(taskId)", status: 200, json: data(task))
            responder.reply(
                instanceId: id,
                path: "/scheduled-tasks/\(taskId)/runs",
                status: 200,
                json: data(["runs": (runs[taskId] ?? []).map(\.object)])
            )
        }
        let notify = Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            (task["id"] as? String).map { ($0, task["notify"] as? Bool ?? false) }
        })
        let names = Dictionary(uniqueKeysWithValues: tasks.compactMap { task in
            (task["id"] as? String).map { ($0, task["name"] as? String ?? "") }
        })
        let all = runs.values.flatMap { $0 }
        responder.reply(instanceId: id, path: "/scheduled-tasks/notifications", status: 200) { url in
            let since = query("since", in: url).flatMap(Double.init).map { Date(timeIntervalSince1970: $0 / 1_000) }
            return data(scheduledNotifications(runs: all, since: since, names: names, notify: notify, now: Date()))
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

    private static func scheduledTasks(host: Host, runs: [String: [Run]], now: Date) -> [[String: Any]] {
        let created = timestamp(now.addingTimeInterval(-14 * 86_400))
        let updated = timestamp(now.addingTimeInterval(-2 * 86_400))
        let zone = TimeZone.current.identifier
        var tasks: [[String: Any]] = [
            [
                "id": "task_morning_brief", "revision": "rev_morning_brief_3", "name": "Morning brief",
                "enabled": true, "schedule": "0 8 * * 1-5", "timezone": zone, "mode": "llm",
                "permission": "read-only", "notify": true, "running": false,
                "workspaceId": gitWorkspaceId,
                "prompt": "Summarise yesterday's commits and open reviews.",
                "nextRunAt": timestamp(now.addingTimeInterval(16 * 3_600)),
                "createdAt": created, "updatedAt": updated,
            ],
            [
                "id": "task_backup_notes", "revision": "rev_backup_notes_2", "name": "Back up notes",
                "enabled": false, "schedule": "30 23 * * *", "timezone": zone, "mode": "script",
                "permission": "full", "notify": false, "running": false,
                "workspaceId": "workspace_notes", "scriptId": backupScriptId,
                "createdAt": created, "updatedAt": updated,
            ],
        ]
        if host.triages {
            tasks.insert([
                "id": "task_inbox_triage", "revision": "rev_inbox_triage_1", "name": "Triage new issues",
                "enabled": true, "schedule": "0 * * * *", "timezone": zone, "mode": "llm",
                "permission": "full", "notify": false, "running": true,
                "mcpServerIds": ["mcp_linear"],
                "prompt": "Label new issues and flag anything urgent.",
                "nextRunAt": timestamp(now.addingTimeInterval(3_000)),
                "createdAt": created, "updatedAt": updated,
            ], at: 1)
        }
        // The last run is the newest stored run, as the Mac records it.
        return tasks.map { task in
            var task = task
            if let id = task["id"] as? String, let last = runs[id]?.max(by: { $0.finished < $1.finished }) {
                task["lastRunAt"] = timestamp(last.finished)
                task["lastResult"] = switch last.result {
                case .success: "success"
                case .error: "error"
                case .silent: "silent"
                }
            }
            return task
        }
    }

    /// `GET /scheduled-tasks/notifications?since=`: every task's runs that
    /// finished at or after `since`, quiet ones left out, newest first, at
    /// most 100, as `notifications()` in `aiden-remote-schedules.ts` builds it.
    private static func scheduledNotifications(
        runs: [Run],
        since: Date?,
        names: [String: String],
        notify: [String: Bool],
        now: Date
    ) -> [String: Any] {
        let items = runs
            .filter { run in run.result != .silent && since.map { run.finished >= $0 } != false }
            .sorted { $0.finished < $1.finished }
            .prefix(100)
            .reversed()
            .map { run in
                var item = run.object
                item["taskName"] = names[run.taskId] ?? ""
                item["notify"] = notify[run.taskId] ?? false
                return item
            }
        return ["notifications": Array(items), "now": Int64(now.timeIntervalSince1970 * 1_000)]
    }

    // MARK: Git

    static let reviewFileIds = [fileId("Sources/Upload/Uploader.swift"), fileId("docs/release-notes.md")]

    private static func registerGit(instanceId id: String, responder: AidenDemoResponder) {
        let root = "/workspaces/\(gitWorkspaceId)/git"
        let snapshot = "snap_demo_01"
        // Review, branches and push-capability carry the snapshot's capability,
        // as the Mac sends them; here everything is allowed.
        func envelope(_ operation: String, _ result: [String: Any], capability: Bool = true) -> Data {
            var body: [String: Any] = ["operationId": "op_\(operation)", "status": "snapshot", "snapshotId": snapshot, "result": result]
            if capability { body["capability"] = ["allowed": true] }
            return data(body)
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
        // Only worktrees that are registered workspaces, under their workspace ids.
        responder.reply(instanceId: id, path: "\(root)/worktrees", status: 200, json: data([
            "operationId": "op_worktrees_01", "status": "snapshot",
            "result": [
                "kind": "worktrees",
                "worktrees": [
                    ["id": gitWorkspaceId, "name": "Aiden Agent", "branch": "feature/mobile", "managed": false],
                    ["id": worktreeWorkspaceId, "name": "Upload retry", "branch": "fix/upload-retry", "managed": true],
                ],
            ],
        ]))
        // The request body names the file, which a responder can't read, so
        // every diff shows the first changed file. A diff has no capability.
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
        ], capability: false))
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

    private static func query(_ name: String, in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
    }

    private static func date(fromISO text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
#endif
