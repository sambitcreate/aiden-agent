import Foundation

/// Pure lifecycle state machine for one paired machine's connection.
///
/// Consolidates the eight coupled axes previously tracked across
/// `AidenHostConnection`:
/// - terminal custody (`active` vs `revoked(purgePending:)`)
/// - visible connection state and issue (`connectionState`, `connectionIssue`)
/// - prior settled state (`settledState`) for `isKnownOnline`, `isKnownOffline`,
///   and cancel-rollback
/// - in-flight connect attempt (`attemptState`: `.idle` vs `.inFlight`)
/// - monotonic lease generations (`generation`, `hostGeneration`,
///   `connectionGeneration`)
struct AidenHostConnectionLifecycle: Equatable {
    enum Custody: Equatable, Sendable {
        case active
        case revoked(purgePending: Bool)
    }

    struct SettledState: Equatable {
        let connectionState: AidenRemoteConnectionState
        let connectionIssue: AidenConnectionIssue?
    }

    enum AttemptState: Equatable, Sendable {
        case idle
        case inFlight(attempt: Int, route: AidenHostConnection.ConnectRoute)
    }

    struct BeginConnectResult: Equatable, Sendable {
        let attempt: Int
        let notifyWillConnect: Bool
    }

    struct CancelConnectResult: Equatable, Sendable {
        let cancelledAttempt: Int
        let route: AidenHostConnection.ConnectRoute
    }

    private(set) var custody: Custody
    private(set) var connectionState: AidenRemoteConnectionState
    private(set) var connectionIssue: AidenConnectionIssue?
    private(set) var settledState: SettledState?
    private(set) var attemptState: AttemptState
    private(set) var generation: Int
    private(set) var hostGeneration: Int
    private(set) var connectionGeneration: Int

    init(
        generation: Int = 0,
        hostGeneration: Int = 0,
        connectionGeneration: Int = 0,
        connectionState: AidenRemoteConnectionState = .connecting,
        connectionIssue: AidenConnectionIssue? = nil,
        custody: Custody = .active
    ) {
        self.custody = custody
        self.connectionState = connectionState
        self.connectionIssue = connectionIssue
        self.settledState = nil
        self.attemptState = .idle
        self.generation = generation
        self.hostGeneration = hostGeneration
        self.connectionGeneration = connectionGeneration
    }

    // MARK: - Derived queries

    var isRevoked: Bool {
        if case .revoked = custody { return true }
        return false
    }

    /// Revoked with its cached data still in place, because a view is showing
    /// it. `purgeStarted()` ends this.
    var isPurgePending: Bool {
        if case .revoked(purgePending: true) = custody { return true }
        return false
    }

    /// True while the newest attempt is running. `connectionState` can't say:
    /// it starts at `.connecting`, and `disconnect()` returns it there, with
    /// nothing in flight either time.
    var isConnectInFlight: Bool {
        guard !isRevoked, case .inFlight(let attempt, _) = attemptState else { return false }
        return attempt == connectionGeneration
    }

    var inFlightRoute: AidenHostConnection.ConnectRoute? {
        guard isConnectInFlight, case .inFlight(_, let route) = attemptState else { return nil }
        return route
    }

    /// Offline, or checking again after being offline. Each probe passes through
    /// `.connecting`, and that isn't news of the machine coming back.
    var isKnownOffline: Bool {
        switch connectionState {
        case .offline: true
        case .connecting:
            if case .offline = settledState?.connectionState { true } else { false }
        default: false
        }
    }

    /// Connected, or checking again after being connected. A machine that
    /// hasn't answered since launch isn't known online, whatever its saved rows
    /// say.
    var isKnownOnline: Bool {
        switch connectionState {
        case .connected: true
        case .connecting: settledState?.connectionState == .connected
        default: false
        }
    }

    /// Whether `attempt` is still the current attempt on an active connection.
    func isCurrent(attempt: Int) -> Bool {
        !isRevoked && connectionGeneration == attempt
    }

    /// Whether a poll failure observed at `generation` should be recorded.
    /// Revocation always counts while active; transport errors are dropped if
    /// another connect started, one is in flight, or the connection is already
    /// revoked.
    func acceptsPollError(sinceConnect generation: Int, isRevocation: Bool) -> Bool {
        if isRevocation { return !isRevoked }
        return !isRevoked && connectionGeneration == generation && !isConnectInFlight
    }

    // MARK: - Pure transitions

    /// Starts a new connect attempt when custody is `.active`. Returns nil once
    /// revoked because terminal custody never reconnects.
    mutating func beginConnect(over route: AidenHostConnection.ConnectRoute) -> BeginConnectResult? {
        guard !isRevoked else { return nil }
        connectionGeneration &+= 1
        let attempt = connectionGeneration
        if connectionState != .connecting {
            settledState = SettledState(connectionState: connectionState, connectionIssue: connectionIssue)
        }
        connectionState = .connecting
        connectionIssue = nil
        attemptState = .inFlight(attempt: attempt, route: route)
        return BeginConnectResult(attempt: attempt, notifyWillConnect: route == .interactive)
    }

    /// Marks the active attempt as connected while preserving `attemptState` so
    /// post-connect capability negotiation stays fenced to the same attempt.
    @discardableResult
    mutating func markConnected(attempt: Int) -> Bool {
        guard isCurrent(attempt: attempt) else { return false }
        connectionIssue = nil
        connectionState = .connected
        return true
    }

    /// Clears `attemptState` when `attempt`'s task exits, without disturbing a
    /// newer superseding attempt.
    mutating func finishConnect(attempt: Int) {
        if case .inFlight(let current, _) = attemptState, current == attempt {
            attemptState = .idle
        }
    }

    /// Stops the attempt in flight (optionally filtered to `route`) and puts
    /// the machine back where it stood before it. Only `connectionGeneration`
    /// moves, so every live context stays live.
    @discardableResult
    mutating func cancelConnect(over route: AidenHostConnection.ConnectRoute? = nil) -> CancelConnectResult? {
        guard isConnectInFlight, case .inFlight(let currentAttempt, let currentRoute) = attemptState else {
            return nil
        }
        if let route, currentRoute != route { return nil }
        attemptState = .idle
        connectionGeneration &+= 1
        if connectionState == .connecting, let settledState {
            connectionState = settledState.connectionState
            connectionIssue = settledState.connectionIssue
        }
        return CancelConnectResult(cancelledAttempt: currentAttempt, route: currentRoute)
    }

    /// Expires a still-connecting attempt whose deadline elapsed. Returns false
    /// if the connection is revoked, superseded, or has already settled.
    @discardableResult
    mutating func expireConnect(attempt: Int) -> Bool {
        guard isCurrent(attempt: attempt), connectionState == .connecting else { return false }
        connectionGeneration &+= 1
        attemptState = .idle
        return true
    }

    /// Records a non-revocation failure. A structured server error on an
    /// already-settled connection leaves it `.connected`; any other failure
    /// takes it `.offline`. No-op once revoked.
    @discardableResult
    mutating func recordNonRevocationFailure(
        isServerError: Bool,
        issue: @autoclosure () -> AidenConnectionIssue
    ) -> Bool {
        guard !isRevoked else { return false }
        if isServerError, connectionState != .connecting {
            connectionIssue = nil
            connectionState = .connected
        } else {
            let resolved = issue()
            connectionIssue = resolved
            connectionState = .offline(message: resolved.message)
        }
        return true
    }

    /// Ends this connection's lease: contexts and answers from before this call
    /// go stale. Custody stays terminal if already revoked.
    mutating func disconnect() {
        generation &+= 1
        hostGeneration &+= 1
        connectionGeneration &+= 1
        attemptState = .idle
        settledState = nil
        connectionIssue = nil
        connectionState = isRevoked ? .needsPairing : .connecting
    }

    /// Adopts an externally provided connection state. Revoked connections only
    /// accept `.needsPairing`. Returns true when `.needsPairing` is adopted so
    /// the owner can notify `hostConnectionNeedsPairing`.
    @discardableResult
    mutating func adopt(connectionState: AidenRemoteConnectionState) -> Bool {
        if isRevoked, connectionState != .needsPairing { return false }
        self.connectionState = connectionState
        settledState = nil
        return connectionState == .needsPairing
    }

    mutating func adopt(connectionIssue: AidenConnectionIssue?) {
        self.connectionIssue = connectionIssue
    }

    mutating func advanceGeneration() {
        generation &+= 1
    }

    mutating func advanceHostGeneration() {
        hostGeneration &+= 1
    }

    mutating func advanceConnectionGeneration() {
        connectionGeneration &+= 1
    }

    /// Terminal custody transition: once revoked, the connection never issues a
    /// context or client and never connects again. Preserves `purgePending` if
    /// already set.
    mutating func markRevoked() {
        custody = .revoked(purgePending: isPurgePending)
        hostGeneration &+= 1
        connectionGeneration &+= 1
        attemptState = .idle
        settledState = nil
    }

    /// Terminal custody transition with cached data held until on-screen views
    /// leave. Stops at `.needsPairing` and returns true so the owner notifies
    /// `hostConnectionNeedsPairing`.
    @discardableResult
    mutating func markRevokedWithPurgePending() -> Bool {
        custody = .revoked(purgePending: true)
        hostGeneration &+= 1
        connectionGeneration &+= 1
        attemptState = .idle
        settledState = nil
        connectionIssue = nil
        connectionState = .needsPairing
        return true
    }

    /// Clears `purgePending` once purge starts without changing whether the
    /// connection is revoked.
    mutating func purgeStarted() {
        if case .revoked = custody {
            custody = .revoked(purgePending: false)
        }
    }

    /// Standalone revocation (no delegate): revokes, ends the lease, and stops
    /// at `.needsPairing`.
    mutating func revokeStandalone() {
        markRevoked()
        disconnect()
    }
}
