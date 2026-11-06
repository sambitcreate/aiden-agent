#if DEBUG
import Foundation

// Fake machines for the real shell. Nothing here is compiled into Release.
//
// Every request goes to `https://<instanceId>.demo.invalid/api/aiden/v1/...`.
// One `URLProtocol` serves all of them and reads the machine from the host, so a
// test can ask "who was called" and make one machine slow, broken or offline.
// Responder paths are relative to the API root (`/server`, `/chat-summaries`).
//
// The coordinator built here never touches the person's Keychain, paired
// installations, or on-disk caches. It uses an in-memory Keychain and caches
// rooted in a fresh temporary directory.

/// A launch scenario, chosen with `-AidenDemoScenario <rawValue>`.
enum AidenDemoScenario: String, CaseIterable {
    case one, four, empty, busy
    case offlineMix = "offline-mix"
    case oldHost = "old-host"

    static let launchArgument = "-AidenDemoScenario"

    /// The scenario named in launch arguments, or nil when the flag is absent.
    /// A flag with a missing or unknown name stops the launch: a typo must not
    /// quietly open the app against the person's real machines.
    static func requested(in arguments: [String]) -> AidenDemoScenario? {
        guard let flag = arguments.firstIndex(of: launchArgument) else { return nil }
        guard arguments.indices.contains(flag + 1),
              let scenario = AidenDemoScenario(rawValue: arguments[flag + 1]) else {
            preconditionFailure(
                "\(launchArgument) needs one of: \(allCases.map(\.rawValue).joined(separator: ", "))"
            )
        }
        return scenario
    }

    static let tabShellArgument = "-AidenDemoTabShell"

    /// What a demo run asks of the tab shell flag. Nil unless it's a demo run that
    /// asks. Only a clear yes turns the shell on.
    static func tabShellOverride(in arguments: [String]) -> Bool? {
        guard arguments.contains(launchArgument),
              let flag = arguments.firstIndex(of: tabShellArgument) else { return nil }
        let value = arguments.indices.contains(flag + 1) ? arguments[flag + 1] : nil
        return AppConfig.isFlagEnabled(value)
    }
}

/// Answers every request the demo clients make. Register answers with `reply`,
/// `fail` and `hold`; an unregistered path is a 404, so no endpoint is invented.
/// The last registration for a machine, method and path wins.
final class AidenDemoResponder: @unchecked Sendable {
    /// Host-name suffix that marks a request as one of ours.
    static let hostSuffix = ".demo.invalid"
    static let apiRoot = "/api/aiden/v1"
    fileprivate static let routeHeader = "X-Aiden-Demo-Responder"

    private enum Outcome {
        case reply(status: Int, json: Data)
        /// An answer that depends on the request, such as a search.
        case computed(status: Int, json: @Sendable (URL) -> Data)
        case failure(URLError.Code)
    }

    private struct Route: Hashable {
        let instanceId: String
        /// `*` matches every method.
        let method: String
        /// `*` matches every path.
        let path: String
        /// Nil matches every query string.
        var query: String? = nil
    }

    private struct HoldKey: Hashable {
        let instanceId: String
        let path: String
    }

    private final class Hold {
        var isReleased = false
        var waiting: [() -> Void] = []
    }

    private let lock = NSLock()
    private var outcomes: [Route: Outcome] = [:]
    private var holds: [HoldKey: Hold] = [:]
    private var log: [String: [String]] = [:]
    private let token = UUID().uuidString

    /// Pass this to clients. Its requests never leave the process.
    let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenDemoURLProtocol.self]
        // The protocol finds its responder through this header, so every test
        // can own a responder even though machine ids repeat between them.
        configuration.httpAdditionalHeaders = [Self.routeHeader: token]
        session = URLSession(configuration: configuration)
        AidenDemoURLProtocol.register(self, token: token)
    }

    deinit {
        session.invalidateAndCancel()
        AidenDemoURLProtocol.unregister(token: token)
    }

    /// `query` answers one exact query string, such as one page of a list, ahead
    /// of the path's other answers.
    func reply(instanceId: String, method: String = "GET", path: String, query: String? = nil, status: Int, json: Data) {
        lock.lock()
        defer { lock.unlock() }
        // Only this method's answer is replaced; other methods on the path stay.
        outcomes[Route(instanceId: instanceId, method: method, path: path, query: query)] = .reply(status: status, json: json)
    }

    /// Answers `path` from the request's URL, for a route that reads a query.
    func reply(
        instanceId: String,
        method: String = "GET",
        path: String,
        status: Int,
        json: @escaping @Sendable (URL) -> Data
    ) {
        lock.lock()
        defer { lock.unlock() }
        outcomes[Route(instanceId: instanceId, method: method, path: path)] = .computed(status: status, json: json)
    }

    /// Fails every method on `path` with a transport error. `path: "*"` takes the
    /// whole machine offline and replaces its earlier answers.
    func fail(instanceId: String, path: String, code: URLError.Code) {
        lock.lock()
        defer { lock.unlock() }
        clearLocked(instanceId: instanceId, path: path)
        outcomes[Route(instanceId: instanceId, method: "*", path: path)] = .failure(code)
    }

    /// Parks requests to `path` until the returned closure is called. Requests
    /// that arrive after the release are answered at once.
    func hold(instanceId: String, path: String) -> @Sendable () -> Void {
        let hold = Hold()
        lock.lock()
        holds[HoldKey(instanceId: instanceId, path: path)] = hold
        lock.unlock()
        return { [weak self] in
            guard let self else { return }
            self.lock.lock()
            hold.isReleased = true
            let waiting = hold.waiting
            hold.waiting = []
            self.lock.unlock()
            waiting.forEach { $0() }
        }
    }

    /// `"METHOD /path"` for every request the machine received, oldest first.
    /// Query strings are left out so assertions do not depend on page size.
    func requests(instanceId: String) -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return log[instanceId] ?? []
    }

    fileprivate func handle(
        _ request: URLRequest,
        deliver: @escaping @Sendable (Result<(HTTPURLResponse, Data), URLError>) -> Void
    ) {
        guard let url = request.url, let host = url.host, host.hasSuffix(Self.hostSuffix) else {
            deliver(.failure(URLError(.badURL)))
            return
        }
        let instanceId = String(host.dropLast(Self.hostSuffix.count))
        let method = request.httpMethod ?? "GET"
        let path = url.path.hasPrefix(Self.apiRoot) ? String(url.path.dropFirst(Self.apiRoot.count)) : url.path

        lock.lock()
        log[instanceId, default: []].append("\(method) \(path)")
        if let hold = holds[HoldKey(instanceId: instanceId, path: path)], !hold.isReleased {
            hold.waiting.append { [self] in
                deliver(resolve(instanceId: instanceId, method: method, path: path, url: url))
            }
            lock.unlock()
            return
        }
        lock.unlock()
        deliver(resolve(instanceId: instanceId, method: method, path: path, url: url))
    }

    private func resolve(
        instanceId: String,
        method: String,
        path: String,
        url: URL
    ) -> Result<(HTTPURLResponse, Data), URLError> {
        if AidenDemoLongChat.isRequested, method == "GET", instanceId == "studio",
           path == "/chats/\(AidenDemoLongChat.chatId)/messages",
           let page = AidenDemoLongChat.window(for: url) {
            return .success((Self.response(url: url, status: 200), page))
        }
        lock.lock()
        let outcome = [
            Route(instanceId: instanceId, method: method, path: path, query: url.query),
            Route(instanceId: instanceId, method: method, path: path),
            Route(instanceId: instanceId, method: "*", path: path),
            Route(instanceId: instanceId, method: "*", path: "*"),
        ].lazy.compactMap { self.outcomes[$0] }.first
        lock.unlock()

        switch outcome {
        case .failure(let code):
            return .failure(URLError(code))
        case .reply(let status, let json):
            return .success((Self.response(url: url, status: status), json))
        case .computed(let status, let json):
            return .success((Self.response(url: url, status: status), json(url)))
        case nil:
            return .success((Self.response(url: url, status: 404), AidenDemoContent.notFound()))
        }
    }

    private static func response(url: URL, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
    }

    private func clearLocked(instanceId: String, path: String) {
        outcomes = outcomes.filter { key, _ in
            guard key.instanceId == instanceId else { return true }
            return path != "*" && key.path != path
        }
    }
}

private final class AidenDemoURLProtocol: URLProtocol, @unchecked Sendable {
    private struct WeakResponder {
        weak var value: AidenDemoResponder?
    }

    private static let lock = NSLock()
    private static var responders: [String: WeakResponder] = [:]

    static func register(_ responder: AidenDemoResponder, token: String) {
        lock.lock()
        responders[token] = WeakResponder(value: responder)
        lock.unlock()
    }

    static func unregister(token: String) {
        lock.lock()
        responders[token] = nil
        lock.unlock()
    }

    private static func responder(for request: URLRequest) -> AidenDemoResponder? {
        guard let token = request.value(forHTTPHeaderField: AidenDemoResponder.routeHeader) else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return responders[token]?.value
    }

    private let stateLock = NSLock()
    private var isStopped = false

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(AidenDemoResponder.hostSuffix) == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let responder = Self.responder(for: request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        responder.handle(request) { [weak self] result in
            guard let self, !self.stopped else { return }
            switch result {
            case .success(let (response, data)):
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                self.client?.urlProtocol(self, didLoad: data)
                self.client?.urlProtocolDidFinishLoading(self)
            case .failure(let error):
                self.client?.urlProtocol(self, didFailWithError: error)
            }
        }
    }

    override func stopLoading() {
        stateLock.lock()
        isStopped = true
        stateLock.unlock()
    }

    private var stopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return isStopped
    }
}

/// An in-memory Keychain so the demo never reads or writes the real one.
private final class AidenDemoMemoryKeychain: KeychainStoring {
    private var values: [String: String] = [:]

    func save(_ value: String, forKey key: KeychainStore.Key) throws { values[key.rawValue] = value }
    func load(_ key: KeychainStore.Key) throws -> String? { values[key.rawValue] }
    func delete(_ key: KeychainStore.Key) throws { values[key.rawValue] = nil }

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

enum AidenDemoHosts {
    private struct Machine {
        let installation: AidenInstallation
        var rowCount: Int
        var isOnline = true
        /// Where in the row-state pattern this machine starts. The first machine
        /// opens on the busiest rows, the others on quieter ones.
        var patternStart = 0
        /// Whether the machine has one Bot. The empty scenario has none, so the
        /// Bots empty state stays reachable.
        var hasBot = true
        /// Whether the machine fails when asked for Bot conversations. Online
        /// otherwise, so the Search tab has a machine that errors.
        var botSearchFails = false
    }

    /// A paired machine as the app stores it after pairing and a first `/server`:
    /// every v1 capability granted, every contract feature offered.
    static func installation(instanceId: String, name: String) -> AidenInstallation {
        let exchange = AidenRemotePairing.PairingExchange(
            protocolVersion: AidenRemoteProtocol.version,
            instanceId: instanceId,
            deviceId: "demo-device",
            credential: credential(for: instanceId),
            capabilities: AidenRemoteCapability.v1Known,
            endpoint: URL(string: "https://\(instanceId)\(AidenDemoResponder.hostSuffix)\(AidenDemoResponder.apiRoot)")!,
            serverSpkiSha256: "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            displayName: name
        )
        var installation = AidenInstallation(
            exchange: exchange,
            pairingTrust: .init(mode: .system),
            name: name
        )
        installation.serverCapabilities = AidenRemoteCapability.v1Known
        installation.serverFeatures = AidenDemoContent.features
        return installation
    }

    @MainActor
    static func coordinator(
        _ scenario: AidenDemoScenario,
        responder: AidenDemoResponder,
        haptics: (any AidenHapticEmitting)? = nil,
        machinePreferences: AidenMachinePreferencesStore = .shared
    ) -> AidenRemoteCoordinator {
        func machine(
            _ id: String,
            _ name: String,
            rows: Int,
            online: Bool = true,
            start: Int = 0,
            hasBot: Bool = true,
            botSearchFails: Bool = false
        ) -> Machine {
            Machine(
                installation: installation(instanceId: id, name: name),
                rowCount: rows,
                isOnline: online,
                patternStart: start,
                hasBot: hasBot,
                botSearchFails: botSearchFails
            )
        }
        let studio = machine("studio", "Studio Mac", rows: 6)
        let laptop = machine("laptop", "Laptop", rows: 3, start: 4)
        let mini = machine("mini", "Home Mini", rows: 2, start: 4)

        let machines: [Machine]
        switch scenario {
        case .one:
            machines = [machine("studio", "Studio Mac", rows: 4)]
        case .four:
            machines = [studio, laptop, mini, machine("build", "Build Box", rows: 0, online: false)]
        case .empty:
            machines = [machine("studio", "Studio Mac", rows: 0, hasBot: false)]
        case .busy:
            machines = [machine("studio", "Studio Mac", rows: 14)]
        case .offlineMix:
            machines = [
                studio,
                machine("laptop", "Laptop", rows: 3, online: false, start: 4),
                machine("mini", "Home Mini", rows: 2, start: 4, botSearchFails: true),
                machine("build", "Build Box", rows: 0, online: false),
            ]
        case .oldHost:
            machines = [Machine(
                installation: legacyInstallation(installation(instanceId: "studio", name: "Studio Mac")),
                rowCount: 4
            )]
        }
        return makeCoordinator(machines, responder: responder, haptics: haptics, machinePreferences: machinePreferences)
    }

    /// For tests that need machines of their own. Each gets the standard answers
    /// (`/server`, `/workspaces`, `/chat-summaries`, and `/bots`, or `/chats` when
    /// the installation has no server inventory). The first is the selected machine.
    /// `keychain` and `workspaceEnvironmentCache` let a test reach those two stores.
    @MainActor
    static func coordinator(
        installations: [AidenInstallation],
        responder: AidenDemoResponder,
        haptics: (any AidenHapticEmitting)? = nil,
        keychain: (any KeychainStoring)? = nil,
        workspaceEnvironmentCache: AidenWorkspaceEnvironmentCache? = nil,
        machinePreferences: AidenMachinePreferencesStore = .shared
    ) -> AidenRemoteCoordinator {
        makeCoordinator(
            installations.map { Machine(installation: $0, rowCount: 4) },
            responder: responder,
            haptics: haptics,
            keychain: keychain,
            workspaceEnvironmentCache: workspaceEnvironmentCache,
            machinePreferences: machinePreferences
        )
    }

    // MARK: Assembly

    @MainActor
    private static func makeCoordinator(
        _ machines: [Machine],
        responder: AidenDemoResponder,
        haptics: (any AidenHapticEmitting)?,
        keychain: (any KeychainStoring)? = nil,
        workspaceEnvironmentCache: AidenWorkspaceEnvironmentCache? = nil,
        machinePreferences: AidenMachinePreferencesStore = .shared
    ) -> AidenRemoteCoordinator {
        let store = AidenInstallationStore(keychain: keychain ?? AidenDemoMemoryKeychain())
        let cacheRoot = FileManager.default.temporaryDirectory
            .appending(path: "AidenDemoHosts-\(UUID().uuidString)", directoryHint: .isDirectory)
        let defaults = isolatedDefaults()

        for machine in machines {
            register(machine, with: responder)
            let installation = machine.installation
            do {
                // A legacy installation has no `/server` inventory to validate against.
                let validatedServer = installation.serverCapabilities == nil
                    ? nil
                    : try AidenRemoteJSONDecoder.decode(
                        AidenServer.self,
                        from: AidenDemoContent.serverJSON(for: installation)
                    )
                _ = try store.savePairing(
                    AidenRemotePairing.PairingExchange(
                        protocolVersion: AidenRemoteProtocol.version,
                        instanceId: installation.instanceId,
                        deviceId: installation.deviceId,
                        credential: credential(for: installation.instanceId),
                        capabilities: installation.deviceCapabilities,
                        endpoint: installation.endpoint,
                        serverSpkiSha256: installation.serverSpkiSha256,
                        displayName: installation.name
                    ),
                    trust: .init(mode: .system),
                    name: installation.name,
                    validatedServer: validatedServer
                )
            } catch {
                preconditionFailure("Demo machine \(installation.instanceId) could not be saved: \(error)")
            }
        }
        if let first = machines.first {
            try? store.setActive(first.installation.instanceId)
        }

        func directory(_ name: String) -> URL {
            cacheRoot.appending(path: name, directoryHint: .isDirectory)
        }
        return AidenRemoteCoordinator(
            installationStore: store,
            workspaceArchiveStore: AidenWorkspaceArchiveStore(defaults: defaults),
            chatCache: AidenChatCache(root: directory("chats")),
            chatDraftStore: AidenChatDraftStore(root: directory("drafts")),
            scheduledTaskCache: AidenScheduledTaskCache(root: directory("schedules")),
            workspaceEnvironmentCache: workspaceEnvironmentCache
                ?? AidenWorkspaceEnvironmentCache(directory: directory("environment")),
            haptics: haptics,
            machinePreferences: machinePreferences,
            clientFactory: { installation, credential in
                AidenRemoteClient(
                    endpoint: installation.endpoint,
                    credential: credential,
                    session: responder.session
                )
            }
        )
    }

    /// A defaults domain of its own, so "archived on this device" state stays out
    /// of the real one and two coordinators cannot clobber each other.
    static func isolatedDefaults() -> UserDefaults {
        let suiteName = "AidenDemoHosts-\(UUID().uuidString)"
        // A new name is always empty, but clear it anyway in case of a reused name.
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        return UserDefaults(suiteName: suiteName) ?? UserDefaults()
    }

    private static func register(_ machine: Machine, with responder: AidenDemoResponder) {
        let installation = machine.installation
        let id = installation.instanceId
        guard machine.isOnline else {
            responder.fail(instanceId: id, path: "*", code: .notConnectedToInternet)
            return
        }
        let rows = AidenDemoContent.rows(
            instanceId: id,
            count: machine.rowCount,
            patternStart: machine.patternStart
        )
        responder.reply(instanceId: id, path: "/server", status: 200, json: AidenDemoContent.serverJSON(for: installation))
        responder.reply(instanceId: id, path: "/workspaces", status: 200, json: AidenDemoContent.workspacesJSON())
        // Served for old hosts too, but only reached when a host advertises it.
        responder.reply(instanceId: id, path: "/chat-summaries", status: 200, json: AidenDemoContent.summariesJSON(rows))
        // The Settings screen reads memory settings.
        responder.reply(instanceId: id, path: "/memory/settings", status: 200, json: AidenDemoContent.memorySettingsJSON())
        // The chat composer's model chip reads the catalog.
        responder.reply(instanceId: id, path: "/models", status: 200, json: AidenDemoContent.modelsJSON())
        // Opening a row reads the whole chat.
        for (index, row) in rows.enumerated() {
            guard let chatId = row["id"] as? String else { continue }
            responder.reply(
                instanceId: id,
                path: "/chats/\(chatId)",
                status: 200,
                json: AidenDemoContent.chatJSON(row: row, index: index)
            )
        }
        if installation.serverCapabilities == nil {
            responder.reply(instanceId: id, path: "/chats", status: 200, json: AidenDemoContent.legacyChatsJSON(rows))
        } else if machine.hasBot {
            let botPath = "/bots/\(AidenDemoContent.botId)"
            responder.reply(instanceId: id, path: "/bots", status: 200, json: AidenDemoContent.botListJSON())
            responder.reply(instanceId: id, path: botPath, status: 200, json: AidenDemoContent.botDetailJSON())
            responder.reply(instanceId: id, path: "\(botPath)/session", status: 200, json: AidenDemoContent.botSessionJSON())
            let fails = machine.botSearchFails
            responder.reply(instanceId: id, path: "/bot-conversations", status: fails ? 503 : 200) { url in
                fails ? AidenDemoContent.notFound() : AidenDemoContent.botConversationsJSON(for: url)
            }
        } else {
            responder.reply(instanceId: id, path: "/bots", status: 200, json: AidenDemoContent.emptyBotsJSON())
            responder.reply(instanceId: id, path: "/bot-conversations", status: 200, json: Data(#"{"conversations":[]}"#.utf8))
        }
    }

    /// The same machine as an older Mac: no server inventory, no features, no Bot grants.
    private static func legacyInstallation(_ installation: AidenInstallation) -> AidenInstallation {
        var legacy = installation
        legacy.serverCapabilities = nil
        legacy.serverFeatures = []
        legacy.deviceCapabilities.removeAll { $0 == .botRead || $0 == .botWrite }
        return legacy
    }

    private static func credential(for instanceId: String) -> String {
        "demo-credential-\(instanceId)"
    }
}

/// JSON in the shapes of `protocol/aiden-remote/v1/fixtures/contract.json`.
private enum AidenDemoContent {
    /// The feature tokens of the contract fixture's `/server`.
    static let features = [
        "chat-summaries-v1", "chat-visuals-v1", "chat-tasks-v1", "chat-agents-v1",
        "chat-run-input-v1", "chat-question-prompts-v1", "chat-skills-v1",
        "chat-agent-interrupt-v1", "chat-read-state-v1", "bot-delete-v1",
        "bot-durable-session-v1", "bot-routines-v1", "bot-connection-requests-v1",
        "bot-presets-v1", "bot-memory-v1", "bot-proactive-v1", "speech-request-gzip-v1",
        "chat-triage-v1",
    ] + (AidenDemoLongChat.isRequested ? ["chat-messages-window-v1", "chat-messages-window-metadata-v1"] : [])

    private static let titles = [
        "Fix the flaky upload test", "Plan the Q3 roadmap", "Summarise the design review",
        "Refactor the settings screen", "Draft release notes", "Triage new crash reports",
        "Compare two caching strategies", "Rename the onboarding assets", "Review the auth change",
        "Tidy up the CI config", "Write migration notes", "Check the invoice export",
        "Sketch the empty state", "Audit unused dependencies",
    ]

    static func serverJSON(for installation: AidenInstallation) -> Data {
        var object: [String: Any] = [
            "protocolVersion": AidenRemoteProtocol.version,
            "instanceId": installation.instanceId,
            "name": installation.name,
            "appVersion": installation.serverCapabilities == nil ? "0.12.0" : "0.30.0",
            "capabilities": installation.deviceCapabilities.map(\.rawValue),
            "connectionMode": "both",
            "minimumClientVersion": "1.0.0",
            "serverTime": timestamp(Date()),
        ]
        if let serverCapabilities = installation.serverCapabilities {
            object["serverCapabilities"] = serverCapabilities.map(\.rawValue)
        }
        if !installation.serverFeatures.isEmpty {
            object["features"] = installation.serverFeatures
        }
        return data(object)
    }

    static func workspacesJSON() -> Data {
        let created = timestamp(Date().addingTimeInterval(-86_400))
        func workspace(_ id: String, _ name: String, revision: Int, extra: [String: Any] = [:]) -> [String: Any] {
            var object: [String: Any] = [
                "id": id, "name": name, "permission": "ask", "memoryEnabled": true,
                "hasFolder": true, "isManagedWorktree": false,
                "createdAt": created, "updatedAt": created, "revision": "workspace_revision_\(revision)",
            ]
            object.merge(extra) { $1 }
            return object
        }
        return data(["workspaces": [
            workspace("workspace_app", "Aiden Agent", revision: 7, extra: [
                "git": ["isRepo": true, "branch": "feature/mobile", "uncommitted": 2],
            ]),
            workspace("workspace_notes", "Notes", revision: 1),
            workspace("default", "No workspace", revision: 2, extra: ["noWorkspace": true]),
        ]])
    }

    static func emptyBotsJSON() -> Data {
        data(["bots": [Any](), "maxBots": 256])
    }

    static func modelsJSON() -> Data {
        data([
            "providers": [[
                "id": "anthropic",
                "label": "Anthropic",
                "models": [[
                    "id": "claude-sonnet-4-5",
                    "label": "Claude Sonnet 4.5",
                    "thinkingLevels": ["low", "medium", "high"],
                    "defaultThinkingLevel": "medium",
                ]],
            ]],
            "defaults": ["providerId": "anthropic", "modelId": "claude-sonnet-4-5"],
        ])
    }

    static func memorySettingsJSON() -> Data {
        data(["enabled": true, "revision": "memory_settings_revision_1"])
    }

    // MARK: Chat

    private static let answers = [
        "I found the cause. The upload test waits on a timer that the fixture never advances.\n\n- Advance the clock in the fixture\n- Drop the fixed sleep\n\n```swift\nawait clock.advance(by: .seconds(5))\n```",
        "Here is a first pass.\n\n1. Ship the inbox rework\n2. Cut the old shell\n3. Fold Bots into the same list\n\nThe risky item is step two.",
        "The review had three themes: spacing, empty states, and the composer. Spacing is mostly done.",
    ]

    /// A whole chat for a summary row, as `GET /chats/{id}` returns it.
    static func chatJSON(row: [String: Any], index: Int) -> Data {
        let updated = row["updatedAt"] as? String ?? timestamp(Date())
        let created = row["createdAt"] as? String ?? updated
        let title = row["title"] as? String ?? "Chat"
        return data([
            "id": row["id"] as Any,
            "workspaceId": row["workspaceId"] as Any,
            "title": title,
            "messages": [
                ["id": "message_\(index + 1)_user", "role": "user", "text": "\(title). Where do we stand?", "createdAt": created],
                ["id": "message_\(index + 1)_assistant", "role": "assistant", "text": answers[index % answers.count], "createdAt": updated],
            ],
            "createdAt": created,
            "updatedAt": updated,
            "revision": "chat_revision_\(index + 1)",
        ])
    }

    // MARK: Bot

    static let botId = "bot_scout"

    private static func botSummaryObject() -> [String: Any] {
        let created = timestamp(Date().addingTimeInterval(-3 * 86_400))
        return [
            "id": botId,
            "name": "Scout",
            "purpose": "Finds the signal in a busy week",
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "rose"]],
            "health": "ready",
            "sessionState": "idle",
            "createdAt": created,
            "updatedAt": timestamp(Date().addingTimeInterval(-3_600)),
            "revision": "bot_revision_1",
        ]
    }

    static func botListJSON() -> Data {
        data(["bots": [botSummaryObject()], "maxBots": 256])
    }

    /// `GET /bot-conversations`: Scout's one chat, when it matches the `query` item.
    static func botConversationsJSON(for url: URL) -> Data {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "query" }?.value?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title = "Scout"
        let preview = "Flagged the flaky upload test again this week"
        let matches = query.isEmpty
            || title.localizedCaseInsensitiveContains(query)
            || preview.localizedCaseInsensitiveContains(query)
        let conversation: [String: Any] = [
            "chatId": "chat_bot_scout",
            "botId": botId,
            "title": title,
            "preview": preview,
            "activityState": "idle",
            "canRespondToApproval": false,
            "createdAt": timestamp(Date().addingTimeInterval(-3 * 86_400)),
            "updatedAt": timestamp(Date().addingTimeInterval(-3_600)),
            "revision": "bot_conversation_revision_1",
        ]
        return data(["conversations": matches ? [conversation] : [Any]()])
    }

    static func botDetailJSON() -> Data {
        var detail = botSummaryObject()
        detail["instructions"] = "Find the important signal, explain it plainly, and keep the owner in control."
        detail["access"] = [
            "botId": botId,
            "accessMode": "full",
            "revision": "bot_policy_revision_1",
            "policyEpoch": "bot_policy_epoch_1",
            "summary": "Can use your Mac, shell, enabled connections, and skills.",
        ]
        detail["modelSelection"] = ["providerId": "provider_demo", "modelId": "model_demo"]
        return data(detail)
    }

    static func botSessionJSON() -> Data {
        let now = Date()
        return data([
            "botId": botId,
            "epoch": "epoch_demo_01",
            "seq": 4,
            "state": "idle",
            "interrupted": false,
            "entries": [
                [
                    "type": "message", "id": "entry_1", "role": "user",
                    "text": "Plan my week, please.", "createdAt": timestamp(now.addingTimeInterval(-7_200)),
                ],
                [
                    "type": "message", "id": "entry_2", "role": "assistant",
                    "text": "Here is a first pass at your week.\n\n- Monday: roadmap review\n- Wednesday: design critique\n- Friday: release notes",
                    "createdAt": timestamp(now.addingTimeInterval(-7_180)),
                ],
            ],
            "hasOlder": false,
            "question": NSNull(),
            "approval": NSNull(),
        ])
    }

    static func notFound() -> Data {
        data(["error": [
            "code": "not_found",
            "message": "The Mac does not serve that path.",
            "requestId": "request_demo_not_found",
            "retryable": false,
        ]])
    }

    /// Chat summaries, newest first. Row `n` takes pattern slot `patternStart + n`:
    /// needs approval, working, needs input, failed, unread, pinned, then read.
    static func rows(instanceId: String, count: Int, patternStart: Int) -> [[String: Any]] {
        let now = Date()
        return (0..<count).map { index in
            let updatedAt = now.addingTimeInterval(-Double(5 + index * 37) * 60)
            let createdAt = updatedAt.addingTimeInterval(-30 * 60)
            var row: [String: Any] = [
                "id": "chat_\(instanceId)_\(index + 1)",
                "workspaceId": index % 3 == 2 ? "workspace_notes" : "workspace_app",
                "title": titles[index % titles.count],
                "titlePending": false,
                "createdAt": timestamp(createdAt),
                "updatedAt": timestamp(updatedAt),
                "revision": "rev_" + String(format: "%043d", index + 1),
                "activity": "idle",
                "rowState": "idle",
                "unread": false,
            ]
            let updated = timestamp(updatedAt)
            let started = timestamp(updatedAt.addingTimeInterval(-2 * 60))
            switch patternStart + index {
            case 0:
                row.merge([
                    "activity": "active", "rowState": "needs_approval", "attentionSince": updated,
                    "runStartedAt": started, "inboxBucket": "needs_you", "inboxSortAt": updated,
                ]) { $1 }
            case 1:
                row.merge([
                    "activity": "active", "rowState": "working", "runStartedAt": started,
                    "inboxBucket": "working", "inboxSortAt": started,
                ]) { $1 }
            case 2:
                row.merge([
                    "activity": "active", "rowState": "needs_input", "attentionSince": updated,
                    "runStartedAt": started, "inboxBucket": "needs_you", "inboxSortAt": updated,
                ]) { $1 }
            case 3:
                row.merge([
                    "unread": true, "lastRunFailed": true, "lastAssistantAt": updated,
                    "inboxBucket": "needs_you", "inboxSortAt": updated,
                ]) { $1 }
            case 4:
                row.merge([
                    "unread": true, "lastAssistantAt": updated,
                    "inboxBucket": "updates", "inboxSortAt": updated,
                ]) { $1 }
            case 5:
                row.merge(["pinnedAt": updated, "inboxBucket": "pinned", "inboxSortAt": updated]) { $1 }
            default:
                row.merge(["inboxBucket": "earlier", "inboxSortAt": updated]) { $1 }
            }
            return row
        }
    }

    static func summariesJSON(_ rows: [[String: Any]]) -> Data {
        data(["summaries": rows])
    }

    /// The pre-summaries list an older Mac serves from `/chats`.
    static func legacyChatsJSON(_ rows: [[String: Any]]) -> Data {
        data(["chats": rows.enumerated().map { index, row in
            [
                "id": row["id"] as Any,
                "workspaceId": row["workspaceId"] as Any,
                "title": row["title"] as Any,
                "messages": [Any](),
                "createdAt": row["createdAt"] as Any,
                "updatedAt": row["updatedAt"] as Any,
                "revision": "chat_revision_\(index + 1)",
            ]
        }])
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func data(_ object: Any) -> Data {
        // Every value here is built above from literals, so serialization cannot fail.
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

/// A long chat on the studio machine, served a window at a time, for screens
/// and UI tests that need Load earlier. Only with `-AidenDemoLongChat YES`, so
/// no other launch sees it. Its newest replies carry fenced code.
enum AidenDemoLongChat {
    static let chatId = "chat_studio_8"

    static var isRequested: Bool {
        ProcessInfo.processInfo.arguments.contains("-AidenDemoLongChat")
    }

    static func window(for url: URL) -> Data? {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let limit = Int(query.first { $0.name == "limit" }?.value ?? "") ?? 50
        let before = query.first { $0.name == "before" }?.value
        let all = messages
        let end = before.flatMap { cursor in all.firstIndex { ($0["id"] as? String) == cursor } } ?? all.count
        let start = max(0, end - limit)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let created = iso.string(from: Date().addingTimeInterval(-8 * 3600))
        let updated = iso.string(from: Date().addingTimeInterval(-60))
        let object: [String: Any] = [
            "chatId": chatId, "revision": "rev_long", "messages": Array(all[start..<end]), "hasOlder": start > 0,
            "workspaceId": "workspace_app", "title": "Rename the onboarding assets",
            "createdAt": created, "updatedAt": updated,
        ]
        return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static let messages: [[String: Any]] = {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let base = Date().addingTimeInterval(-7 * 3600)
        let paragraphs = [
            "Short answer: yes.",
            "I checked the onboarding assets and the naming is inconsistent between the light and dark sets, which is why the catalog shows two entries for each illustration.",
            "Here is what I would do.\n\n- Rename every asset to the kebab-case form\n- Move the dark variants into the same catalog entry\n- Drop the three unused illustrations\n\nNone of this changes behaviour, so it is safe to land on its own.",
            "The longer version: the asset catalog treats a name with a space as a different key from the same name with a hyphen. The loader normalises the key at runtime, so nothing broke, but the Xcode asset preview shows duplicates and the lint step complains. Renaming fixes both.",
        ]
        let codeReply = "Here is the rename as a small script.\n\n```swift\nlet assetName = name\n    .replacingOccurrences(of: \" \", with: \"-\")\n    .lowercased()\nprint(assetName)\n```\n\nAnd the command that checks the catalog, which is long enough that it needs to scroll sideways instead of wrapping:\n\n```sh\nxcrun actool --output-format human-readable-text --notices --warnings --platform iphonesimulator --minimum-deployment-target 26.0 Assets.xcassets\n```\n\nThat is all it takes."
        let tools: [(String, String?)] = [
            ("read_file", "AidenOnboardingArtwork.swift"), ("grep", "onboarding-art in ios"), ("read_file", "Assets.xcassets/Contents.json"),
            ("list_dir", "Resources"), ("read_file", "AidenOnboardingVignettes.swift"), ("run_command", "git status"),
            ("edit_file", "AidenOnboardingArtwork.swift"), ("run_command", "swift test"), ("glob", "**/*.imageset"),
            ("read_file", "AidenPairingView.swift"), ("grep", "Image(\"onboarding"), ("web_search", nil),
        ]
        func step(_ n: Int, _ i: Int, offset: Int, failed: Bool = false) -> [String: Any] {
            let (name, detail) = tools[i % tools.count]
            var d: [String: Any] = [
                "id": "tool-\(n)", "order": n - 1, "kind": "tool", "toolCallId": "call-\(n)", "toolName": name,
                "label": name, "status": failed ? "failed" : "completed",
                "startedAt": 1000 + n, "updatedAt": 1000 + n, "finishedAt": 1000 + n, "contentOffset": offset,
            ]
            if let detail { d["detail"] = detail }
            return d
        }
        var out: [[String: Any]] = []
        let turns = 70
        for turn in 0..<turns {
            let t = base.addingTimeInterval(Double(turn) * 240)
            out.append([
                "id": "m\(turn * 2 + 1)", "role": "user", "createdAt": iso.string(from: t),
                "text": turn % 4 == 0 ? "Can you also check turn \(turn)? The names still look odd in the dark set and I would like a second opinion before I ship." : "Turn \(turn).",
            ])
            let p1 = paragraphs[turn % paragraphs.count]
            let p2 = paragraphs[(turn + 2) % paragraphs.count]
            let text = turn >= turns - 2 ? codeReply : (turn % 3 == 1 ? p1 : p1 + "\n\n" + p2)
            var message: [String: Any] = [
                "id": "m\(turn * 2 + 2)", "role": "assistant", "text": text,
                "createdAt": iso.string(from: t.addingTimeInterval(60)),
            ]
            let isLast = turn == turns - 1
            if turn % 3 == 0 || isLast {
                let firstRun = isLast ? 14 : 3 + (turn % 9)
                let secondRun = isLast ? 9 : 2 + (turn % 4)
                var steps: [[String: Any]] = []
                var n = 1
                for i in 0..<firstRun { steps.append(step(n, i, offset: 0)); n += 1 }
                let split = (p1 + "\n\n").utf16.count
                if text.utf16.count > split, text != codeReply {
                    for i in 0..<secondRun {
                        steps.append(step(n, i + 4, offset: split, failed: isLast && i == secondRun - 2)); n += 1
                    }
                }
                message["timeline"] = [
                    "version": 3, "generationId": "gen-\(turn)", "status": "completed",
                    "startedAt": 1000, "finishedAt": 2000, "steps": steps,
                ] as [String: Any]
            }
            out.append(message)
        }
        return out
    }()
}
#endif
