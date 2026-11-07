import Foundation

/// The chats Catch Up walks: the rows that need the person on machines that are
/// online, in the Inbox's order, across every machine.
///
/// Rows change under a run, so build one from the store at each step and don't
/// keep it. A chat answered elsewhere, or on a machine that has dropped, is then
/// simply not here.
struct AidenCatchUpQueue: Equatable {
    private let ids: [AidenHostObjectID]

    init(rows: [AidenUnifiedInboxRow]) {
        ids = rows.filter(\.isOnline).map(\.id)
    }

    var first: AidenHostObjectID? { ids.first }
    var count: Int { ids.count }

    /// The row after `id`. A row that has left the queue has no place in it, so
    /// the oldest row left comes next.
    func next(after id: AidenHostObjectID) -> AidenHostObjectID? {
        guard let index = ids.firstIndex(of: id) else { return ids.first }
        let next = ids.index(after: index)
        return ids.indices.contains(next) ? ids[next] : nil
    }
}

/// One walk through the queue. It holds only what a fresh queue can't know: which
/// chats this run has shown. Next answers nothing, so a chat passed over stays in
/// the queue and would otherwise come round again.
struct AidenCatchUpRun: Equatable {
    private(set) var current: AidenHostObjectID
    private var shown: Set<AidenHostObjectID>

    init(startingAt id: AidenHostObjectID) {
        current = id
        shown = [id]
    }

    /// Moves to the queue's first chat this run hasn't shown. Nil when there's
    /// none, which leaves `current` where it was.
    mutating func advance(in queue: AidenCatchUpQueue) -> AidenHostObjectID? {
        var candidate = queue.first
        while let id = candidate, shown.contains(id) {
            candidate = queue.next(after: id)
        }
        guard let candidate else { return nil }
        current = candidate
        shown.insert(candidate)
        return candidate
    }
}
