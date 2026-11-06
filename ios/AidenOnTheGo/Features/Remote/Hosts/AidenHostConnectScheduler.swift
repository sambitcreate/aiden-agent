import Foundation

/// Connects every paired machine while the app is in the foreground, a few at a
/// time, with each attempt bounded so one unreachable machine can't delay the
/// others. It only drives each machine's own connection: a failure stays on
/// that connection, and nothing here reaches the app-wide error or the pairing
/// screen.
@MainActor
final class AidenHostConnectScheduler {
    static let maxConcurrentConnects = 2
    static let probeTimeout: TimeInterval = 10

    private let registry: AidenHostRegistry
    private let connectLimit: Int
    private let connectTimeout: TimeInterval
    private var isForeground = false
    private var pending: [String] = []
    private var running: [UUID: AidenHostConnection] = [:]
    /// Machines whose `.connected` dates from before the app last left the
    /// foreground, so it says nothing about now.
    private var unverified: Set<String> = []
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private var pathWatch: Task<Void, Never>?

    init(
        registry: AidenHostRegistry,
        pathChanges: AsyncStream<Void>,
        maxConcurrentConnects: Int = AidenHostConnectScheduler.maxConcurrentConnects,
        probeTimeout: TimeInterval = AidenHostConnectScheduler.probeTimeout
    ) {
        self.registry = registry
        connectLimit = maxConcurrentConnects
        connectTimeout = probeTimeout
        pathWatch = Task { [weak self] in
            for await _ in pathChanges {
                self?.pathChanged()
            }
        }
    }

    deinit {
        pathWatch?.cancel()
    }

    /// Connects every machine that isn't connected, and returns once none is
    /// left to try.
    func foregrounded() async {
        isForeground = true
        enqueue(registry.ordered.filter(needsConnect))
        unverified = []
        await untilIdle()
    }

    /// Stops what is waiting and what is running. Contexts stay live: only a
    /// machine's connect attempt ends, so a chat keeps working on return.
    func backgrounded() {
        isForeground = false
        pending = []
        running.values.forEach { $0.cancelConnect() }
        unverified = Set(registry.connections.keys)
        finishIfIdle()
    }

    private func pathChanged() {
        guard isForeground else { return }
        enqueue(registry.ordered.filter { connection in
            guard case .offline = connection.connectionState else { return false }
            return canConnect(connection)
        })
    }

    private func needsConnect(_ connection: AidenHostConnection) -> Bool {
        canConnect(connection)
            && (connection.connectionState != .connected || unverified.contains(connection.instanceId))
    }

    /// `.connecting` alone doesn't mean an attempt is running, which is why
    /// this asks `isConnectInFlight`.
    private func canConnect(_ connection: AidenHostConnection) -> Bool {
        !connection.isRevoked && !connection.isConnectInFlight && connection.connectionState != .needsPairing
    }

    private func enqueue(_ connections: [AidenHostConnection]) {
        // The selected machine is the one a person is waiting on.
        let selectedFirst = connections.filter(\.isSelected) + connections.filter { !$0.isSelected }
        for connection in selectedFirst where !pending.contains(connection.instanceId) {
            pending.append(connection.instanceId)
        }
        startNext()
    }

    private func startNext() {
        while isForeground, running.count < connectLimit, !pending.isEmpty {
            let instanceId = pending.removeFirst()
            guard let connection = registry.connection(for: instanceId), canConnect(connection) else { continue }
            let id = UUID()
            running[id] = connection
            Task { [connectTimeout] in
                await connection.connect(over: .probe, timeout: connectTimeout)
                self.running[id] = nil
                self.startNext()
            }
        }
        finishIfIdle()
    }

    private func untilIdle() async {
        guard !running.isEmpty || !pending.isEmpty else { return }
        await withCheckedContinuation { idleWaiters.append($0) }
    }

    private func finishIfIdle() {
        guard running.isEmpty, pending.isEmpty else { return }
        idleWaiters.forEach { $0.resume() }
        idleWaiters = []
    }
}
