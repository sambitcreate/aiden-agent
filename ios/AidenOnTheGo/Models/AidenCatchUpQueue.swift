import Foundation

/// The chats Catch Up walks: the rows that need the person on machines that are
/// online, in the Inbox's order, across every machine.
///
/// Rows change under a run, so build one from the store at each step and don't
/// keep it. A chat answered elsewhere, or on a machine that has dropped, is then
/// simply not here.
struct AidenCatchUpQueue: Equatable {
    private let ids: [AidenHostObjectID]
    /// Rows that need the person and can't be opened yet.
    private let offline: Set<AidenHostObjectID>

    init(rows: [AidenUnifiedInboxRow]) {
        ids = rows.filter(\.isOnline).map(\.id)
        offline = Set(rows.filter { !$0.isOnline }.map(\.id))
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

    /// How a run that showed `shown` ends. A chat shown before its machine dropped
    /// has been seen, so it isn't left over.
    func ending(after shown: Set<AidenHostObjectID> = []) -> AidenCatchUpEnding {
        AidenCatchUpEnding(walked: !shown.isEmpty, unreached: offline.subtracting(shown).count)
    }
}

/// What the last screen of a Catch Up can truthfully say. The queue leaves out
/// offline machines, so its end isn't the end of what needs the person.
struct AidenCatchUpEnding: Hashable, Codable {
    /// False when there was nothing to show from the start.
    let walked: Bool
    /// Chats that need the person on offline machines, which this run didn't show.
    let unreached: Int

    var title: String {
        if walked { return String(localized: "Catch Up finished") }
        return unreached == 0 ? String(localized: "Nothing to catch up on") : String(localized: "Nothing to catch up on yet")
    }

    var message: String {
        switch (walked, unreached) {
        case (true, 0): String(localized: "You’ve been through every chat in Catch Up.")
        case (true, 1): String(localized: "You’ve been through every chat you can reach. 1 more is on an offline machine.")
        case (true, _): String(localized: "You’ve been through every chat you can reach. \(unreached) more are on offline machines.")
        case (false, 0): String(localized: "There’s nothing in Catch Up right now.")
        case (false, 1): String(localized: "1 chat needs you on an offline machine.")
        case (false, _): String(localized: "\(unreached) chats need you on offline machines.")
        }
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

    func ending(in queue: AidenCatchUpQueue) -> AidenCatchUpEnding {
        queue.ending(after: shown)
    }
}
