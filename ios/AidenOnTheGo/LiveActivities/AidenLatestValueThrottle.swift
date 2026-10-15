import Foundation

/// Coalesces a high-frequency value stream into at most one delivery per
/// `interval`, always delivering the newest value. Urgent values bypass the
/// window and discard any older pending value, so phase changes are never
/// delayed behind (or overwritten by) a stale coalesced update.
///
/// The clock and sleep are injected so the window is testable without waiting
/// on wall time.
@MainActor
final class AidenLatestValueThrottle<Value: Equatable> {
    typealias Deliver = @MainActor (Value) async -> Void

    private let interval: Duration
    private let now: @MainActor () -> ContinuousClock.Instant
    private let sleep: @MainActor (Duration) async throws -> Void
    private let deliver: Deliver

    private var lastDelivered: Value?
    private var lastDeliveredAt: ContinuousClock.Instant?
    private(set) var pendingValue: Value?
    private var flushTask: Task<Void, Never>?
    private var generation = 0

    init(
        interval: Duration,
        now: @escaping @MainActor () -> ContinuousClock.Instant = { ContinuousClock.now },
        sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        deliver: @escaping Deliver
    ) {
        self.interval = interval
        self.now = now
        self.sleep = sleep
        self.deliver = deliver
    }

    /// Records a value that reached the consumer outside the throttle, such as
    /// the initial content passed to `Activity.request`.
    func markDelivered(_ value: Value) {
        lastDelivered = value
        lastDeliveredAt = now()
    }

    /// Delivers now when the window is open; otherwise keeps only the newest
    /// value and schedules a single trailing delivery when the window closes.
    func submit(_ value: Value) async {
        if pendingValue == nil, value == lastDelivered { return }
        let current = now()
        if let lastDeliveredAt {
            let elapsed = current - lastDeliveredAt
            if elapsed < interval {
                pendingValue = value
                scheduleFlush(after: interval - elapsed)
                return
            }
        }
        cancelPending()
        await deliverNow(value)
    }

    /// Delivers immediately, superseding any pending coalesced value.
    func submitUrgent(_ value: Value) async {
        cancelPending()
        await deliverNow(value)
    }

    /// Drops any pending value without delivering it.
    func cancel() {
        cancelPending()
    }

    /// Waits for a scheduled trailing delivery, if any. Test seam.
    func waitForScheduledFlush() async {
        await flushTask?.value
    }

    private func cancelPending() {
        pendingValue = nil
        generation &+= 1
        flushTask?.cancel()
        flushTask = nil
    }

    private func deliverNow(_ value: Value) async {
        lastDelivered = value
        lastDeliveredAt = now()
        await deliver(value)
    }

    private func scheduleFlush(after delay: Duration) {
        guard flushTask == nil else { return }
        generation &+= 1
        let scheduledGeneration = generation
        let sleep = sleep
        flushTask = Task { @MainActor [weak self] in
            do {
                try await sleep(delay)
            } catch {
                return
            }
            guard let self, self.generation == scheduledGeneration else { return }
            self.flushTask = nil
            guard let value = self.pendingValue else { return }
            self.pendingValue = nil
            guard value != self.lastDelivered else { return }
            await self.deliverNow(value)
        }
    }
}
