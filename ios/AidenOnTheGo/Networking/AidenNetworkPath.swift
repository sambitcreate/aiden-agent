import Foundation
import Network

/// The device's network reachability as stream recovery sees it.
///
/// Only a path the system positively reports as unsatisfied counts as
/// offline; an unknown or not-yet-reported path counts as available, so a
/// missing signal never blocks a reconnect.
@MainActor
protocol AidenNetworkPathSource: AnyObject {
    var isNetworkAvailable: Bool { get }
    /// Suspends until availability equals `available`, returning at once when
    /// it already does. Throws `CancellationError` when the task is cancelled.
    func waitUntil(available: Bool) async throws
}

/// Main-actor availability state plus its waiters. The production path
/// monitor feeds it; tests drive it directly through `setAvailable(_:)`.
@MainActor
final class AidenNetworkAvailability: AidenNetworkPathSource {
    private(set) var isNetworkAvailable: Bool
    private var waiters: [UUID: (available: Bool, continuation: CheckedContinuation<Void, Error>)] = [:]

    init(isNetworkAvailable: Bool = true) {
        self.isNetworkAvailable = isNetworkAvailable
    }

    func setAvailable(_ available: Bool) {
        // Repeated identical paths change nothing and wake nobody.
        guard available != isNetworkAvailable else { return }
        isNetworkAvailable = available
        let ready = waiters.filter { $0.value.available == available }
        for (id, waiter) in ready {
            waiters[id] = nil
            waiter.continuation.resume()
        }
    }

    func waitUntil(available: Bool) async throws {
        try Task.checkCancellation()
        if isNetworkAvailable == available { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                MainActor.assumeIsolated {
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else if isNetworkAvailable == available {
                        continuation.resume()
                    } else {
                        waiters[id] = (available, continuation)
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelWaiter(id) }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        guard let waiter = waiters.removeValue(forKey: id) else { return }
        waiter.continuation.resume(throwing: CancellationError())
    }
}

/// Process-wide `NWPathMonitor` that publishes into `AidenNetworkAvailability`.
@MainActor
final class AidenNetworkPathMonitor {
    static let shared = AidenNetworkPathMonitor()

    let availability = AidenNetworkAvailability()
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "sbtbiswas.AidenOnTheGo.network-path")

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let available = path.status != .unsatisfied
            Task { @MainActor [weak self] in self?.availability.setAvailable(available) }
        }
        monitor.start(queue: queue)
    }
}

enum AidenStreamRecoveryDecision: Equatable {
    /// Park without probing, warning, or spending backoff until the path returns.
    case waitForNetwork
    /// Ask the Mac for the stream's status before deciding.
    case probeStatus
    /// Sleep the jittered delay for this attempt, then reopen the stream.
    case backoff(attempt: Int)
}

/// The reconnect decision table shared with Android's `AidenStreamRecoveryPolicy`.
///
/// | Event                          | Offline          | Online                     |
/// |--------------------------------|------------------|----------------------------|
/// | Event stream failed            | waitForNetwork   | probeStatus                |
/// | Status probe failed            | waitForNetwork   | backoff(attempt), attempt+1|
/// | Path dropped during a backoff  | refund attempt, waitForNetwork               |
/// | Healthy event or status        | attempt reset to 0                           |
///
/// Network return reopens the stream from its last applied sequence through
/// the one consumer loop, so a flapping path cannot start a second stream.
struct AidenStreamRecoveryPolicy: Equatable {
    private(set) var retryAttempt = 0

    func afterStreamFailure(isNetworkAvailable: Bool) -> AidenStreamRecoveryDecision {
        isNetworkAvailable ? .probeStatus : .waitForNetwork
    }

    mutating func afterProbeFailure(isNetworkAvailable: Bool) -> AidenStreamRecoveryDecision {
        guard isNetworkAvailable else { return .waitForNetwork }
        defer { retryAttempt += 1 }
        return .backoff(attempt: retryAttempt)
    }

    /// A backoff the path cut short never reached its reconnect, so it does
    /// not count toward the growing delay.
    mutating func backoffInterruptedByNetworkLoss() {
        retryAttempt = max(0, retryAttempt - 1)
    }

    mutating func recordHealthy() {
        retryAttempt = 0
    }
}

/// Runs the decision table's waits against an injected path source and
/// sleeper. The chat stream consumer owns one value per stream, so every
/// reconnect it triggers is the consumer's own single-flight next iteration.
@MainActor
struct AidenStreamNetworkRecovery {
    enum ProbeFailureOutcome: Equatable {
        /// The path was offline (or dropped mid-backoff) and has returned.
        case networkReturned
        /// The backoff delay elapsed while online.
        case backoffElapsed
    }

    let path: AidenNetworkPathSource
    private(set) var policy = AidenStreamRecoveryPolicy()
    private let sleep: @MainActor (Int) async throws -> Void
    private let delayMilliseconds: (Int) -> Int

    init(
        path: AidenNetworkPathSource,
        sleep: @escaping @MainActor (Int) async throws -> Void = { try await Task.sleep(for: .milliseconds($0)) },
        delayMilliseconds: @escaping (Int) -> Int = { AidenTerminalReconciliation.retryDelayMilliseconds(attempt: $0) }
    ) {
        self.path = path
        self.sleep = sleep
        self.delayMilliseconds = delayMilliseconds
    }

    mutating func recordHealthy() { policy.recordHealthy() }

    /// After the event stream fails. Returns `true` when the caller should
    /// probe status, or `false` after parking offline until the path returned,
    /// in which case the caller reopens the stream directly.
    func shouldProbeAfterStreamFailure(onWaiting: (Bool) async -> Void) async throws -> Bool {
        guard policy.afterStreamFailure(isNetworkAvailable: path.isNetworkAvailable) == .waitForNetwork else {
            return true
        }
        try await park(onWaiting: onWaiting)
        return false
    }

    /// After the status probe fails. `onBackoff` runs before an online backoff
    /// sleep (the caller's warning); offline parking never calls it.
    mutating func recoverAfterProbeFailure(
        onBackoff: () async -> Void,
        onWaiting: (Bool) async -> Void
    ) async throws -> ProbeFailureOutcome {
        switch policy.afterProbeFailure(isNetworkAvailable: path.isNetworkAvailable) {
        case .waitForNetwork, .probeStatus:
            try await park(onWaiting: onWaiting)
            return .networkReturned
        case .backoff(let attempt):
            await onBackoff()
            if try await sleepUnlessNetworkLost(milliseconds: delayMilliseconds(attempt)) {
                return .backoffElapsed
            }
            policy.backoffInterruptedByNetworkLoss()
            try await park(onWaiting: onWaiting)
            return .networkReturned
        }
    }

    private func park(onWaiting: (Bool) async -> Void) async throws {
        await onWaiting(true)
        do {
            try await path.waitUntil(available: true)
        } catch {
            await onWaiting(false)
            throw error
        }
        await onWaiting(false)
    }

    /// Returns `true` when the delay elapsed, `false` when the path dropped first.
    private func sleepUnlessNetworkLost(milliseconds: Int) async throws -> Bool {
        let path = path
        let sleep = sleep
        let elapsed = await withTaskGroup(of: Bool?.self) { group -> Bool? in
            group.addTask { @MainActor in
                do { try await sleep(milliseconds) } catch { return Task.isCancelled ? nil : true }
                return true
            }
            group.addTask { @MainActor in
                do { try await path.waitUntil(available: false); return false } catch { return nil }
            }
            defer { group.cancelAll() }
            while let result = await group.next() {
                if let result { return result }
                if Task.isCancelled { return nil }
            }
            return nil
        }
        try Task.checkCancellation()
        guard let elapsed else { throw CancellationError() }
        return elapsed
    }
}
