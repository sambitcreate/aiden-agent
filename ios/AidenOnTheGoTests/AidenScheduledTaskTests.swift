import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenScheduledTaskTests: XCTestCase {
    override func tearDown() {
        ScheduledMockURLProtocol.handler = nil
        super.tearDown()
    }

    func testScheduledDTORejectsInternalMetadataAndInvalidScriptHandle() throws {
        let valid = try AidenRemoteJSONDecoder.decode(
            AidenScheduledTask.self,
            from: Data(Self.taskJSON.utf8)
        )
        XCTAssertEqual(try AidenScheduledTaskValidation.tasks([valid]).first?.name, "Daily")

        let contaminatedJSON = String(Self.taskJSON.dropLast()) + #", "providerFingerprint":"private"}"#
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenScheduledTask.self,
            from: Data(contaminatedJSON.utf8)
        ))
        let invalid = AidenScheduledTask(
            id: valid.id, revision: valid.revision, name: valid.name, enabled: valid.enabled,
            schedule: valid.schedule, timezone: valid.timezone, mode: .script, permission: .full,
            workspaceId: nil, providerId: nil, modelId: nil, mcpServerIds: nil,
            scriptId: "../../unsafe.sh", prompt: nil, notify: true, running: false,
            nextRunAt: nil, lastRunAt: nil, lastResult: nil,
            createdAt: valid.createdAt, updatedAt: valid.updatedAt
        )
        XCTAssertThrowsError(try AidenScheduledTaskValidation.tasks([invalid]))
    }

    func testScheduledTaskValidationBoundsIdentifiersAndEnforcesModeMCPRelations() throws {
        let valid = Self.makeTask()
        XCTAssertEqual(try AidenScheduledTaskValidation.tasks([valid]), [valid])
        let script = Self.makeTask(
            mode: .script,
            permission: .full,
            mcpServerIds: nil,
            scriptId: "script_" + String(repeating: "s", count: 43),
            prompt: nil
        )
        XCTAssertEqual(try AidenScheduledTaskValidation.tasks([script]), [script])

        let invalidTasks = [
            Self.makeTask(id: "task/escape"),
            Self.makeTask(providerId: String(repeating: "p", count: 257)),
            Self.makeTask(modelId: String(repeating: "m", count: 257)),
            Self.makeTask(workspaceId: String(repeating: "w", count: 129)),
            Self.makeTask(mcpServerIds: ["mcp-1", "mcp-1"]),
            Self.makeTask(mcpServerIds: ["mcp-\u{202e}unsafe"]),
            Self.makeTask(permission: .readOnly, mcpServerIds: ["mcp-1"]),
            Self.makeTask(workspaceId: "workspace-1", mcpServerIds: ["mcp-1"]),
            Self.makeTask(scriptId: "script_" + String(repeating: "s", count: 43)),
            Self.makeTask(mode: .script, permission: .readOnly, mcpServerIds: nil, prompt: nil),
            Self.makeTask(createdAt: Date(timeIntervalSince1970: 3), updatedAt: Date(timeIntervalSince1970: 2))
        ]
        for task in invalidTasks {
            XCTAssertThrowsError(try AidenScheduledTaskValidation.tasks([task]), "Expected \(task.id) to fail validation")
        }
        XCTAssertThrowsError(try AidenScheduledTaskValidation.tasks([valid, valid]))
        XCTAssertThrowsError(try AidenScheduledTaskValidation.tasks([
            Self.makeTask(mcpServerIds: (0...AidenScheduledTaskDraft.maximumMcpServerCount).map { "mcp-\($0)" })
        ]))
    }

    func testScheduledRunValidationBoundsFieldsAndEnforcesStatusRelations() throws {
        let succeeded = AidenScheduledRun(
            id: "run-1", taskId: "task-1", status: "succeeded",
            startedAt: Date(timeIntervalSince1970: 1), finishedAt: Date(timeIntervalSince1970: 2),
            summary: "Done", errorCode: nil
        )
        let failed = AidenScheduledRun(
            id: "run-2", taskId: "task-1", status: "failed",
            startedAt: Date(timeIntervalSince1970: 3), finishedAt: Date(timeIntervalSince1970: 4),
            summary: "Blocked", errorCode: "execution_failed"
        )
        XCTAssertEqual(
            try AidenScheduledTaskValidation.runs([succeeded, failed], taskId: "task-1"),
            [succeeded, failed]
        )

        let invalidRuns = [
            AidenScheduledRun(
                id: "run\nunsafe", taskId: "task-1", status: "succeeded",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: nil, errorCode: nil
            ),
            AidenScheduledRun(
                id: "run-3", taskId: "other-task", status: "succeeded",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: nil, errorCode: nil
            ),
            AidenScheduledRun(
                id: "run-4", taskId: "task-1", status: "unknown",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: nil, errorCode: nil
            ),
            AidenScheduledRun(
                id: "run-5", taskId: "task-1", status: "running",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: nil, errorCode: nil
            ),
            AidenScheduledRun(
                id: "run-6", taskId: "task-1", status: "succeeded",
                startedAt: succeeded.startedAt, finishedAt: nil,
                summary: nil, errorCode: nil
            ),
            AidenScheduledRun(
                id: "run-7", taskId: "task-1", status: "failed",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: nil, errorCode: nil
            ),
            AidenScheduledRun(
                id: "run-8", taskId: "task-1", status: "succeeded",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: nil, errorCode: "unexpected_error"
            ),
            AidenScheduledRun(
                id: "run-9", taskId: "task-1", status: "failed",
                startedAt: Date(timeIntervalSince1970: 2), finishedAt: Date(timeIntervalSince1970: 1),
                summary: nil, errorCode: "execution_failed"
            )
        ]
        for run in invalidRuns {
            XCTAssertThrowsError(try AidenScheduledTaskValidation.runs([run], taskId: "task-1"))
        }
        XCTAssertThrowsError(try AidenScheduledTaskValidation.runs([succeeded, succeeded], taskId: "task-1"))
        XCTAssertThrowsError(try AidenScheduledTaskValidation.runs([
            AidenScheduledRun(
                id: "run-long", taskId: "task-1", status: "succeeded",
                startedAt: succeeded.startedAt, finishedAt: succeeded.finishedAt,
                summary: String(repeating: "s", count: 20_001), errorCode: nil
            )
        ], taskId: "task-1"))
    }

    func testLegacyGlobalFullTaskRequiresInventoryAndFreezesExactEnabledMCPServers() throws {
        let legacy = AidenScheduledTask(
            id: "task-legacy", revision: "rev_legacy", name: "Legacy monitor", enabled: true,
            schedule: "0 9 * * 1-5", timezone: "UTC", mode: .llm, permission: .full,
            workspaceId: nil, providerId: "provider-1", modelId: "model-1", mcpServerIds: nil,
            scriptId: nil, prompt: "Review updates", notify: true, running: false,
            nextRunAt: nil, lastRunAt: nil, lastResult: nil,
            createdAt: Date(timeIntervalSince1970: 1), updatedAt: Date(timeIntervalSince1970: 2)
        )

        XCTAssertTrue(legacy.usesLegacyInheritedMcpAccess)
        XCTAssertEqual(legacy.mcpAccessSummary, "All enabled MCP servers (legacy)")
        XCTAssertFalse(legacy.canBeginEdit(hasCurrentMcpInventory: false))

        let unresolved = AidenScheduledTaskDraft(task: legacy, currentMcpServers: nil)
        XCTAssertFalse(unresolved.hasResolvedMcpScope)
        XCTAssertNotNil(unresolved.reviewValidationMessage(
            replacing: legacy,
            currentMcpServers: nil
        ))
        XCTAssertNil(unresolved.mutation.mcpServerIds)

        let enabled = [
            AidenScheduledMcpServer(id: "mcp-github", name: "GitHub"),
            AidenScheduledMcpServer(id: "mcp-linear", name: "Linear")
        ]
        let resolved = AidenScheduledTaskDraft(task: legacy, currentMcpServers: enabled)
        XCTAssertTrue(legacy.canBeginEdit(hasCurrentMcpInventory: true))
        XCTAssertTrue(resolved.hasResolvedMcpScope)
        XCTAssertNil(resolved.reviewValidationMessage(
            replacing: legacy,
            currentMcpServers: enabled
        ))
        XCTAssertEqual(resolved.mutation.mcpServerIds, ["mcp-github", "mcp-linear"])
        XCTAssertEqual(resolved.mcpAccessReviewSummary(currentMcpServers: enabled), "GitHub, Linear")

        let noEnabledServers = AidenScheduledTaskDraft(task: legacy, currentMcpServers: [])
        XCTAssertEqual(noEnabledServers.mutation.mcpServerIds, [])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(noEnabledServers.mutation))
        let object = try XCTUnwrap(encoded as? [String: Any])
        XCTAssertEqual(object["mcpServerIds"] as? [String], [])
    }

    func testScheduledTaskPresentationHumanizesCommonCadencesWithoutExposingUnknownCron() {
        let locale = Locale(identifier: "en_US")
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "*/15 * * * *", locale: locale),
            "Every 15 minutes"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "0 */2 * * *", locale: locale),
            "Every 2 hours"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "20 * * * *", locale: locale),
            "Every hour at 20 minutes past"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "0 9 * * *", locale: locale),
            "Every day at 9:00 AM"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "0 16 * * 1-5", locale: locale),
            "Weekdays at 4:00 PM"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "0 9 * * 1", locale: locale),
            "Every Monday at 9:00 AM"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "0 9 1 * *", locale: locale),
            "Custom schedule"
        )
        XCTAssertEqual(
            AidenScheduledTaskPresentation.cadence(schedule: "5 0 9 * * *", locale: locale),
            "Custom schedule"
        )
    }

    func testScheduledMcpSelectionEnforcesFullGlobalScopeCapAndUnavailableNarrowing() {
        var draft = AidenScheduledTaskDraft()
        draft.name = "Monitor"
        draft.schedule = "0 9 * * *"
        draft.prompt = "Review updates"
        draft.workspaceId = "workspace-1"
        draft.permission = .readOnly

        XCTAssertTrue(draft.setMcpServer(id: "mcp-1", selected: true))
        XCTAssertEqual(draft.permission, .full)
        XCTAssertNil(draft.workspaceId)
        XCTAssertEqual(draft.mcpServerIds, ["mcp-1"])

        draft.setWorkspace("workspace-2")
        XCTAssertEqual(draft.workspaceId, "workspace-2")
        XCTAssertTrue(draft.mcpServerIds.isEmpty)

        XCTAssertTrue(draft.setMcpServer(id: "mcp-1", selected: true))
        draft.setPermission(.readOnly)
        XCTAssertEqual(draft.permission, .readOnly)
        XCTAssertTrue(draft.mcpServerIds.isEmpty)

        draft.permission = .full
        for index in 0..<AidenScheduledTaskDraft.maximumMcpServerCount {
            XCTAssertTrue(draft.setMcpServer(id: "mcp-\(index)", selected: true))
        }
        XCTAssertFalse(draft.setMcpServer(id: "mcp-over-limit", selected: true))
        XCTAssertEqual(draft.mcpServerIds.count, AidenScheduledTaskDraft.maximumMcpServerCount)

        draft.mcpServerIds = ["mcp-stale"]
        XCTAssertNotNil(draft.reviewValidationMessage(
            replacing: nil,
            currentMcpServers: [AidenScheduledMcpServer(id: "mcp-current", name: "Current")]
        ))
        XCTAssertEqual(
            draft.mcpAccessReviewSummary(currentMcpServers: []),
            "Unavailable connection: mcp-stale"
        )
        XCTAssertTrue(draft.setMcpServer(id: "mcp-stale", selected: false))
        XCTAssertNil(draft.reviewValidationMessage(replacing: nil, currentMcpServers: []))

        draft.mcpServerIds = ["mcp-1"]
        draft.permission = .readOnly
        XCTAssertEqual(draft.validationMessage, "MCP access requires Full permission.")
        draft.permission = .full
        draft.workspaceId = "workspace-1"
        XCTAssertEqual(draft.validationMessage, "MCP access is available only without a workspace binding.")
    }

    func testScheduledOfflineCacheIsInstallationScopedAndRetainsBoundedHistory() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenScheduledTaskTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenScheduledTaskCache(root: root)
        let task = try AidenRemoteJSONDecoder.decode(AidenScheduledTask.self, from: Data(Self.taskJSON.utf8))
        let settings = AidenScheduledSettings(
            revision: "rev_settings", enabled: true, defaultMode: .llm,
            defaultPermission: .readOnly, defaultMcpEnabled: false,
            defaultNotify: true, defaultTimezone: "UTC"
        )
        try await cache.store(instanceId: "instance-1", tasks: [task], settings: settings)
        let runs = (0..<60).map { index in
            AidenScheduledRun(
                id: "run-\(index)", taskId: task.id, status: "succeeded",
                startedAt: Date(timeIntervalSince1970: TimeInterval(index)), finishedAt: nil,
                summary: nil, errorCode: nil
            )
        }
        try await cache.store(runs: runs, taskId: task.id, instanceId: "instance-1")

        let loaded = await cache.load(instanceId: "instance-1")
        let restored = try XCTUnwrap(loaded)
        XCTAssertEqual(restored.tasks, [task])
        XCTAssertEqual(restored.settings, settings)
        XCTAssertEqual(restored.runs[task.id]?.count, 50)
        let other = await cache.load(instanceId: "instance-2")
        XCTAssertNil(other)

        let updatedSettings = AidenScheduledSettings(
            revision: "rev_settings_2", enabled: false, defaultMode: .llm,
            defaultPermission: .full, defaultMcpEnabled: true,
            defaultNotify: false, defaultTimezone: "America/New_York"
        )
        try await cache.store(instanceId: "instance-1", tasks: [], settings: updatedSettings)
        try await cache.store(runs: runs, taskId: task.id, instanceId: "instance-1")
        let reloadedAfterDeletion = await cache.load(instanceId: "instance-1")
        let afterDeletion = try XCTUnwrap(reloadedAfterDeletion)
        XCTAssertEqual(afterDeletion.tasks, [])
        XCTAssertEqual(afterDeletion.settings, updatedSettings)
        XCTAssertNil(afterDeletion.runs[task.id])

        try await cache.store(instanceId: "instance-2", tasks: [task], settings: settings)
        await cache.purge(instanceId: "instance-1")
        let purged = await cache.load(instanceId: "instance-1")
        let retained = await cache.load(instanceId: "instance-2")
        XCTAssertNil(purged)
        XCTAssertEqual(retained?.tasks, [task])
        XCTAssertEqual(retained?.settings, settings)
    }

    @MainActor
    func testScheduledAccessFailsClosedAndPurgesCacheWithoutNegotiatedRead() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenScheduledAccessTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenScheduledTaskCache(root: root)
        let task = try AidenRemoteJSONDecoder.decode(AidenScheduledTask.self, from: Data(Self.taskJSON.utf8))
        try await cache.store(instanceId: "instance-no-read", tasks: [task], settings: nil)

        let keychain = ScheduledMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = Self.exchange(
            instanceId: "instance-no-read",
            deviceId: "device-1",
            capabilities: [.serverRead]
        )
        _ = try store.savePairing(
            exchange,
            trust: AidenRemoteContractFixture.PairingTrust(mode: .system),
            name: "Read disabled",
            validatedServer: Self.server(
                instanceId: exchange.instanceId,
                deviceCapabilities: exchange.capabilities,
                serverCapabilities: [.serverRead, .scheduleRead, .scheduleWrite]
            )
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, _ in
                XCTFail("Missing schedule read authority must not create a remote client.")
                throw URLError(.userAuthenticationRequired)
            }
        )
        let model = AidenScheduledTasksModel(coordinator: coordinator, cache: cache)

        XCTAssertFalse(model.canReadSchedules)
        XCTAssertFalse(model.canWriteSchedules)
        await model.load()
        XCTAssertTrue(model.tasks.isEmpty)
        let purged = await cache.load(instanceId: "instance-no-read")
        XCTAssertNil(purged)
    }

    @MainActor
    func testScheduledReadOnlyAccessRestoresCacheButDisablesManagement() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "AidenScheduledReadOnlyTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenScheduledTaskCache(root: root)
        let task = try AidenRemoteJSONDecoder.decode(AidenScheduledTask.self, from: Data(Self.taskJSON.utf8))
        try await cache.store(instanceId: "instance-read-only", tasks: [task], settings: nil)

        let keychain = ScheduledMemoryKeychain()
        let store = AidenInstallationStore(keychain: keychain)
        let exchange = Self.exchange(
            instanceId: "instance-read-only",
            deviceId: "device-1",
            capabilities: [.serverRead, .scheduleRead]
        )
        _ = try store.savePairing(
            exchange,
            trust: AidenRemoteContractFixture.PairingTrust(mode: .system),
            name: "Read only",
            validatedServer: Self.server(
                instanceId: exchange.instanceId,
                deviceCapabilities: exchange.capabilities,
                serverCapabilities: [.serverRead, .scheduleRead, .scheduleWrite]
            )
        )
        let coordinator = AidenRemoteCoordinator(
            installationStore: store,
            clientFactory: { _, _ in throw URLError(.notConnectedToInternet) }
        )
        let model = AidenScheduledTasksModel(coordinator: coordinator, cache: cache)

        XCTAssertTrue(model.canReadSchedules)
        XCTAssertFalse(model.canWriteSchedules)
        XCTAssertFalse(model.canManageSchedules)
        await model.load()
        XCTAssertEqual(model.tasks, [task])
    }

    func testScheduledAccessRequiresMatchingCurrentInstallationAndBothGrantInventories() {
        let exchange = Self.exchange(
            instanceId: "instance-1",
            deviceId: "device-1",
            capabilities: [.serverRead, .scheduleRead, .scheduleWrite]
        )
        var installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: .init(mode: .system),
            name: "Mac"
        )
        installation.serverCapabilities = [.serverRead, .scheduleRead, .scheduleWrite]

        XCTAssertEqual(
            AidenScheduledTaskAccess.resolve(
                installation: installation,
                instanceId: "instance-1",
                deviceId: "device-1",
                isCurrent: true
            ),
            .init(canRead: true, canWrite: true)
        )
        installation.serverCapabilities = [.serverRead, .scheduleRead]
        XCTAssertEqual(
            AidenScheduledTaskAccess.resolve(
                installation: installation,
                instanceId: "instance-1",
                deviceId: "device-1",
                isCurrent: true
            ),
            .init(canRead: true, canWrite: false)
        )
        XCTAssertEqual(
            AidenScheduledTaskAccess.resolve(
                installation: installation,
                instanceId: "instance-1",
                deviceId: "other-device",
                isCurrent: true
            ),
            .unavailable
        )
        XCTAssertEqual(
            AidenScheduledTaskAccess.resolve(
                installation: installation,
                instanceId: "instance-1",
                deviceId: "device-1",
                isCurrent: false
            ),
            .unavailable
        )
    }

    func testScheduledClientUsesCanonicalRoutesRevisionsConfirmationAndStableRunKey() async throws {
        let recorder = ScheduledRequestRecorder()
        ScheduledMockURLProtocol.handler = { request in
            recorder.record(request)
            let path = request.url?.path ?? ""
            switch (request.httpMethod, path) {
            case ("GET", "/api/aiden/v1/scheduled-tasks"):
                return Self.response(request, 200, #"{"tasks":["# + Self.taskJSON + "]}")
            case ("POST", "/api/aiden/v1/scheduled-tasks"):
                return Self.response(request, 201, Self.taskJSON)
            case ("PATCH", "/api/aiden/v1/scheduled-tasks/task-1"):
                return Self.response(request, 200, Self.taskJSON)
            case ("POST", "/api/aiden/v1/scheduled-tasks/task-1/pause"):
                return Self.response(request, 202, Self.taskJSON.replacingOccurrences(of: #""enabled":true"#, with: #""enabled":false"#))
            case ("POST", "/api/aiden/v1/scheduled-tasks/task-1/run"):
                return Self.response(request, 202, #"{"taskId":"task-1","runId":"run-1","status":"accepted","acceptedAt":"2026-08-19T12:00:00.000Z"}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/task-1/runs"):
                return Self.response(request, 200, #"{"runs":[{"id":"run-1","taskId":"task-1","status":"succeeded","startedAt":"2026-08-19T12:00:00.000Z","finishedAt":"2026-08-19T12:00:01.000Z","summary":"Done"}]}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/scripts"):
                return Self.response(request, 200, #"{"scripts":[{"id":"script_sssssssssssssssssssssssssssssssssssssssssss","name":"daily.sh"}]}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/mcp-servers"):
                return Self.response(request, 200, #"{"servers":[{"id":"mcp-1","name":"GitHub"}]}"#)
            case ("GET", "/api/aiden/v1/scheduled-tasks/settings"):
                return Self.response(request, 200, #"{"revision":"rev-settings","enabled":true,"defaultMode":"llm","defaultPermission":"read-only","defaultMcpEnabled":false,"defaultNotify":true,"defaultTimezone":"UTC"}"#)
            default:
                throw URLError(.unsupportedURL)
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScheduledMockURLProtocol.self]
        let client = AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            credential: "credential",
            session: URLSession(configuration: configuration)
        )
        let mutation = AidenScheduledTaskMutation(
            name: "Daily", schedule: "0 8 * * *", timezone: "UTC", mode: .llm,
            permission: .readOnly, workspaceId: nil, providerId: "provider-1", modelId: "model-1",
            mcpServerIds: nil, scriptId: nil, prompt: "Summarize", notify: true
        )
        _ = try await client.scheduledTasks()
        _ = try await client.createScheduledTask(mutation)
        _ = try await client.updateScheduledTask(id: "task-1", revision: "rev_task_1", mutation: mutation)
        _ = try await client.pauseScheduledTask(id: "task-1", revision: "rev_task_1")
        let key = UUID()
        _ = try await client.runScheduledTask(id: "task-1", idempotencyKey: key)
        _ = try await client.runScheduledTask(id: "task-1", idempotencyKey: key)
        _ = try await client.scheduledRuns(taskId: "task-1")
        _ = try await client.scheduledScripts(workspaceId: "workspace-1")
        let mcpServers = try await client.scheduledMcpServers()
        XCTAssertEqual(mcpServers, [
            AidenScheduledMcpServer(id: "mcp-1", name: "GitHub")
        ])
        _ = try await client.scheduledSettings()

        let requests = recorder.requests
        let create = try XCTUnwrap(requests.first { $0.httpMethod == "POST" && $0.url?.path == "/api/aiden/v1/scheduled-tasks" })
        XCTAssertEqual(try Self.body(create)["confirmedForeground"] as? Bool, true)
        let update = try XCTUnwrap(requests.first { $0.httpMethod == "PATCH" && $0.url?.path.hasSuffix("/task-1") == true })
        XCTAssertEqual(update.value(forHTTPHeaderField: "If-Match"), "rev_task_1")
        let pause = try XCTUnwrap(requests.first { $0.url?.path.hasSuffix("/pause") == true })
        XCTAssertEqual(pause.value(forHTTPHeaderField: "If-Match"), "rev_task_1")
        XCTAssertNotNil(pause.value(forHTTPHeaderField: "Idempotency-Key"))
        let runKeys = requests.filter { $0.url?.path.hasSuffix("/run") == true }
            .compactMap { $0.value(forHTTPHeaderField: "Idempotency-Key") }
        XCTAssertEqual(runKeys, [key.uuidString.lowercased(), key.uuidString.lowercased()])
        let scripts = try XCTUnwrap(requests.first { $0.url?.path.hasSuffix("/scripts") == true })
        XCTAssertEqual(URLComponents(url: scripts.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "workspace-1")
        XCTAssertFalse(requests.contains { ($0.url?.absoluteString ?? "").contains("/Users/") })
    }

    private static let taskJSON = #"{"id":"task-1","revision":"rev_task_1","name":"Daily","enabled":true,"schedule":"0 8 * * *","timezone":"UTC","mode":"llm","permission":"read-only","providerId":"provider-1","modelId":"model-1","prompt":"Summarize","notify":true,"running":false,"createdAt":"2026-08-19T12:00:00.000Z","updatedAt":"2026-08-19T12:00:00.000Z"}"#

    private static func makeTask(
        id: String = "task-1",
        mode: AidenScheduledTaskMode = .llm,
        permission: AidenScheduledTaskPermission = .full,
        workspaceId: String? = nil,
        providerId: String? = "provider-1",
        modelId: String? = "model-1",
        mcpServerIds: [String]? = [],
        scriptId: String? = nil,
        prompt: String? = "Summarize",
        createdAt: Date = Date(timeIntervalSince1970: 1),
        updatedAt: Date = Date(timeIntervalSince1970: 2)
    ) -> AidenScheduledTask {
        AidenScheduledTask(
            id: id, revision: "rev_task_1", name: "Daily", enabled: true,
            schedule: "0 8 * * *", timezone: "UTC", mode: mode, permission: permission,
            workspaceId: workspaceId, providerId: providerId, modelId: modelId,
            mcpServerIds: mcpServerIds, scriptId: scriptId, prompt: prompt,
            notify: true, running: false, nextRunAt: nil, lastRunAt: nil, lastResult: nil,
            createdAt: createdAt, updatedAt: updatedAt
        )
    }

    private static func exchange(
        instanceId: String,
        deviceId: String,
        capabilities: [AidenRemoteCapability]
    ) -> AidenRemoteContractFixture.PairingExchange {
        AidenRemoteContractFixture.PairingExchange(
            protocolVersion: 1,
            instanceId: instanceId,
            deviceId: deviceId,
            credential: "credential",
            capabilities: capabilities,
            endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
            serverSpkiSha256: "sha256/\(Data(repeating: 7, count: 32).base64EncodedString())"
        )
    }

    private static func server(
        instanceId: String,
        deviceCapabilities: [AidenRemoteCapability],
        serverCapabilities: [AidenRemoteCapability]
    ) -> AidenServer {
        AidenServer(
            protocolVersion: 1,
            instanceId: instanceId,
            name: "Mac",
            appVersion: "1.0",
            capabilities: deviceCapabilities,
            serverCapabilities: serverCapabilities,
            connectionMode: .lan,
            minimumClientVersion: nil,
            serverTime: Date(timeIntervalSince1970: 10_000)
        )
    }

    private static func response(_ request: URLRequest, _ status: Int, _ json: String) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data(json.utf8))
    }

    private static func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody {
            data = body
        } else {
            let stream = try XCTUnwrap(request.httpBodyStream)
            stream.open()
            defer { stream.close() }
            var received = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
                if count == 0 { break }
                received.append(buffer, count: count)
            }
            data = received
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class ScheduledRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [URLRequest] = []
    func record(_ request: URLRequest) { lock.lock(); stored.append(request); lock.unlock() }
    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return stored }
}

private final class ScheduledMemoryKeychain: KeychainStoring {
    private var values: [String: String] = [:]

    func save(_ value: String, forKey key: KeychainStore.Key) throws {
        values[key.rawValue] = value
    }

    func load(_ key: KeychainStore.Key) throws -> String? {
        values[key.rawValue]
    }

    func delete(_ key: KeychainStore.Key) throws {
        values[key.rawValue] = nil
    }

    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = value
    }

    func load(_ key: KeychainStore.Key, scope: String) throws -> String? {
        values[KeychainStore.scopedKey(key, scope: scope)]
    }

    func delete(_ key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = nil
    }
}

private final class ScheduledMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (response, data) = try Self.handler?(request) ?? { throw URLError(.badServerResponse) }()
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
