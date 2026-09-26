import SwiftUI

/// Transcript auto-scroll rules adapted from Hermex's `ChatScrollPolicy`.
/// Existing chats must enter at their latest content during the scroll view's
/// first layout, then stay bottom-pinned while the reader is following.
enum AidenChatScrollPolicy {
    static let transcriptBottomAnchorID = "chat-bottom"

    /// Existing transcripts should enter at their latest content as part of the
    /// scroll view's first layout, before the destination becomes visible.
    static let initialTranscriptAnchor = UnitPoint.bottom

    /// Rich Markdown can finish measuring after the first layout. Keep those
    /// size changes bottom-pinned only while follow is latched on.
    static func sizeChangeAnchor(shouldFollowLatest: Bool) -> UnitPoint? {
        shouldFollowLatest ? .bottom : nil
    }

    /// Content growth can report "away from latest" for a frame before size
    /// pinning reapplies. Keep the previous follow latch in that window.
    static func shouldTreatAsScrolledAway(
        wasScrolledAway: Bool,
        isAwayFromLatest: Bool,
        contentGrew: Bool
    ) -> Bool {
        if !wasScrolledAway && contentGrew {
            return false
        }
        return isAwayFromLatest
    }

    static func shouldPinTaskListAfterGrowth(wasFollowingLatest: Bool) -> Bool {
        wasFollowingLatest
    }

    static func taskListFollowKey(_ tasks: [AidenRemoteChatTask]) -> String {
        tasks.map { task in
            let blockedBy = (task.blockedBy ?? []).map(String.init).joined(separator: ",")
            return "\(task.id):\(task.status.rawValue):\(task.subject):\(task.activeForm ?? ""):\(blockedBy)"
        }.joined(separator: "|")
    }

    static func taskListAnchorID<Task: Identifiable>(_ tasks: [Task]) -> Task.ID? {
        tasks.last?.id
    }
}

struct AidenScrollFollowGeometry: Equatable {
    var isAwayFromLatest: Bool
    var contentHeight: CGFloat
}
