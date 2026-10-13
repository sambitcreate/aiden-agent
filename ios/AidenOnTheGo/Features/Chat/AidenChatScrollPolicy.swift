import SwiftUI

// Portions adapted from Hermex (`ChatScrollPolicy`), MIT License,
// Copyright (c) 2026 Uzair Ansar. See THIRD_PARTY_NOTICES.md.

/// Transcript auto-scroll rules, ported from Hermex's `ChatScrollPolicy`.
///
/// Auto-follow is an explicit latch rather than a distance test.
///
/// Follow switches **off** when a drag begins, when a live gesture moves the
/// offset, or when a scroll with no gesture carries the reader away from the
/// bottom (a status-bar tap, VoiceOver, or a hardware-keyboard scroll).
///
/// Follow switches **on** when Jump to latest or a send resets it, when a
/// gesture settles at the true bottom, or when a non-gesture offset change
/// lands at the true bottom from nearby (a collapse near the end clamping the
/// offset). Landing at the bottom from far above is a relayout artifact, never
/// a reason to follow.
///
/// Layout growth from streaming tokens and keyboard insets never flips the
/// latch on its own, so a reader parked above the end stays parked. Distance
/// only decides whether the Jump to latest button is visible.
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

    /// Distance (pt) from the bottom within which Jump to latest stays hidden
    /// while idle.
    static let bottomDetectionThreshold: CGFloat = 80

    /// Looser threshold while a response streams, so layout jitter from
    /// incoming tokens does not flash the button.
    static let streamingBottomDetectionThreshold: CGFloat = 160

    /// Strict bottom tolerance (pt) that re-arms follow when a gesture ends there.
    static let followReArmThreshold: CGFloat = 12

    /// How long a finished drag waits for momentum to announce itself before
    /// the release position is treated as final. Finger-lift velocity is not a
    /// reliable signal: a gentle fling can report zero and still decelerate.
    static let dragSettleDelay: TimeInterval = 0.16

    /// Gap between momentum ticks that means deceleration has stopped.
    static let momentumSettleDelay: TimeInterval = 0.05

    /// Jump to latest appears only after the reader has been away this long,
    /// and hides immediately on return.
    static let jumpButtonRevealDelay: Duration = .milliseconds(150)

    /// How long an animated follow scroll (0.2s ease-out) gets to come to rest
    /// before its landing is checked.
    static let animatedFollowSettleDelay: Duration = .milliseconds(260)

    /// Scroll events that drive the follow latch.
    enum FollowEvent: Equatable {
        /// An explicit jump to the latest content: Jump to latest or a send.
        case reset
        /// The user started dragging the transcript.
        case userScrollBegin
        /// The user's gesture settled: a drag with no momentum after
        /// `dragSettleDelay`, or deceleration coming to rest. Re-arms at the
        /// bottom; elsewhere it keeps the current latch, so a send or jump that
        /// landed while the gesture was settling is not undone by the late
        /// settle report.
        case userScrollEnd(isAtBottom: Bool)
        /// The content offset changed for any other reason: streaming growth,
        /// keyboard presentation, a programmatic scroll, or a live gesture.
        /// `movedAwayFromBottom` marks a scroll with no gesture that carried
        /// the reader away from the bottom (see `isScrollingAwayFromBottom`);
        /// `wasNearBottom` is where the previous report left the reader.
        case contentScrolled(
            isAtBottom: Bool,
            isUserScrolling: Bool,
            movedAwayFromBottom: Bool = false,
            wasNearBottom: Bool = true
        )
    }

    /// The scroll geometry one metrics report is derived from.
    struct ScrollGeometry: Equatable {
        var offsetY: CGFloat
        var contentHeight: CGFloat
        var visibleHeight: CGFloat

        var distanceFromBottom: CGFloat {
            max(0, contentHeight - visibleHeight - offsetY)
        }
    }

    /// True when a report without a gesture shows the reader farther from the
    /// bottom than the last one, past the streaming threshold, in the same
    /// viewport. While follow is on, the bottom anchor snaps each size change
    /// back to zero distance, so only an actual scroll (status-bar tap,
    /// VoiceOver, hardware keyboard) can carry the reader out that far.
    /// Keyboard insets change the viewport and are excluded.
    /// Offset movement is required: content growth at an unchanged reader offset
    /// (e.g., streaming tokens) must not opt out of following.
    static func isScrollingAwayFromBottom(previous: ScrollGeometry?, current: ScrollGeometry) -> Bool {
        guard let previous, previous.visibleHeight == current.visibleHeight else { return false }
        let offsetMoved = current.offsetY > previous.offsetY + 0.5
        let distance = current.distanceFromBottom
        return offsetMoved
            && distance > previous.distanceFromBottom + 0.5
            && distance > streamingBottomDetectionThreshold
    }

    /// The follow latch. `isFollowing` is the answer; the second flag lets an
    /// explicit reset outlive a gesture that was still coasting when it landed.
    struct FollowLatch: Equatable {
        var isFollowing = true
        /// Set by `.reset`. Until the gesture settles or a new drag begins,
        /// live offset changes still flagged as user scrolling belong to
        /// momentum that predates the explicit action and must not switch
        /// follow off.
        var ignoresCoastingGesture = false
    }

    /// Reduces one event onto the current latch state.
    static func resolveFollow(current: FollowLatch, event: FollowEvent) -> FollowLatch {
        var latch = current
        switch event {
        case .reset:
            latch.isFollowing = true
            latch.ignoresCoastingGesture = true
        case .userScrollBegin:
            latch.isFollowing = false
            latch.ignoresCoastingGesture = false
        case .userScrollEnd(let isAtBottom):
            latch.isFollowing = isAtBottom || current.isFollowing
            latch.ignoresCoastingGesture = false
        case .contentScrolled(let isAtBottom, let isUserScrolling, let movedAwayFromBottom, let wasNearBottom):
            if isUserScrolling {
                if !current.ignoresCoastingGesture {
                    latch.isFollowing = false
                }
            } else if movedAwayFromBottom {
                latch.isFollowing = false
            } else if isAtBottom, wasNearBottom {
                latch.isFollowing = true
            }
        }
        return latch
    }

    /// Proximity, not the follow latch, hides the button at the bottom.
    static func showsScrollToBottomButton(isNearBottom: Bool, isStreaming: Bool, isFollowing: Bool) -> Bool {
        !isNearBottom && (!isStreaming || !isFollowing)
    }

    static func isAtBottom(distanceFromBottom: CGFloat) -> Bool {
        distanceFromBottom <= followReArmThreshold
    }

    static func bottomThreshold(isStreaming: Bool) -> CGFloat {
        isStreaming ? streamingBottomDetectionThreshold : bottomDetectionThreshold
    }

    static func isNearBottom(distanceFromBottom: CGFloat, isStreaming: Bool) -> Bool {
        distanceFromBottom <= bottomThreshold(isStreaming: isStreaming)
    }

    // MARK: Task list

    /// The task-list sheet keeps its simpler distance follow: it has no
    /// streaming tail, only rows that change in place.
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

    /// Every rendered task field, compared structurally so free-text values
    /// containing separators cannot collide.
    static func taskListFollowKey(_ tasks: [AidenRemoteChatTask]) -> [AidenRemoteChatTask] {
        tasks
    }

    static func taskListAnchorID<Task: Identifiable>(_ tasks: [Task]) -> Task.ID? {
        tasks.last?.id
    }
}

struct AidenScrollFollowGeometry: Equatable {
    var isAwayFromLatest: Bool
    var contentHeight: CGFloat
}

/// The transcript's follow state: the latch, bottom proximity, the debounced
/// Jump to latest visibility, and the deferred follow scroll. Kept out of the
/// view so the jump's generation token and timing are testable.
@MainActor
@Observable
final class AidenTranscriptFollowController {
    private(set) var latch = AidenChatScrollPolicy.FollowLatch()
    private(set) var isNearBottom = true
    private(set) var showsJumpButton = false
    private(set) var isStreaming = false

    /// Runs between scheduling a follow scroll and performing it, so the
    /// transcript has laid out the change being followed. Hermex waits one
    /// `Task.yield()` and 16ms.
    @ObservationIgnored private let followPause: @MainActor () async -> Void
    @ObservationIgnored private let jumpButtonDelay: @MainActor () async -> Void
    /// Runs after an animated follow scroll before checking where it landed,
    /// and after a gesture-free scroll lands at the bottom before re-arming.
    @ObservationIgnored private let animationSettle: @MainActor () async -> Void
    /// The newest reported distance from the bottom.
    @ObservationIgnored private var distanceFromBottom: CGFloat = 0
    @ObservationIgnored private var followGeneration: UInt64 = 0
    @ObservationIgnored private var bottomArrivalGeneration: UInt64 = 0
    @ObservationIgnored private var jumpButtonGeneration: UInt64 = 0
    @ObservationIgnored private var isJumpButtonRevealPending = false

    init(
        followPause: @escaping @MainActor () async -> Void = {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(16))
        },
        jumpButtonDelay: @escaping @MainActor () async -> Void = {
            try? await Task.sleep(for: AidenChatScrollPolicy.jumpButtonRevealDelay)
        },
        animationSettle: @escaping @MainActor () async -> Void = {
            try? await Task.sleep(for: AidenChatScrollPolicy.animatedFollowSettleDelay)
        }
    ) {
        self.followPause = followPause
        self.jumpButtonDelay = jumpButtonDelay
        self.animationSettle = animationSettle
    }

    var isFollowing: Bool { latch.isFollowing }

    func handle(_ event: AidenChatScrollPolicy.FollowEvent) {
        if case .userScrollBegin = event {
            bottomArrivalGeneration &+= 1
            followGeneration &+= 1
        }
        let resolved = AidenChatScrollPolicy.resolveFollow(current: latch, event: event)
        if resolved != latch { latch = resolved }
        updateJumpButton()
    }

    func updateMetrics(_ metrics: AidenChatScrollMetrics) {
        let nearBottom = AidenChatScrollPolicy.isNearBottom(
            distanceFromBottom: metrics.distanceFromBottom,
            isStreaming: isStreaming
        )
        let wasNearBottom = isNearBottom
        distanceFromBottom = metrics.distanceFromBottom
        if nearBottom != isNearBottom { isNearBottom = nearBottom }
        let isAtBottom = AidenChatScrollPolicy.isAtBottom(distanceFromBottom: metrics.distanceFromBottom)
        handle(.contentScrolled(
            isAtBottom: isAtBottom,
            isUserScrolling: metrics.isUserInteracting,
            movedAwayFromBottom: metrics.movedAwayFromBottom,
            wasNearBottom: wasNearBottom
        ))
        if metrics.isUserInteracting || metrics.movedAwayFromBottom {
            bottomArrivalGeneration &+= 1
        } else if isAtBottom, !wasNearBottom, !latch.isFollowing {
            confirmBottomArrival()
        }
    }

    /// A scroll with no drag (a hardware keyboard, VoiceOver, a pointer
    /// scroll that skips the pan callbacks) can land at the bottom from far
    /// above in one report, and nothing reports again while the reader stays
    /// there. One report from far above may also be a transient layout
    /// correction, so follow re-arms only if the reader is still at the bottom
    /// once the scroll has settled and nothing has scrolled it away or dragged
    /// since. Reply growth in the meantime is allowed: the check uses the
    /// same near-bottom tolerance as streaming.
    private func confirmBottomArrival() {
        bottomArrivalGeneration &+= 1
        let generation = bottomArrivalGeneration
        let settle = animationSettle
        Task { @MainActor [weak self] in
            await settle()
            guard let self, generation == self.bottomArrivalGeneration, !self.latch.isFollowing,
                  self.isNearBottom else { return }
            self.handle(.contentScrolled(isAtBottom: true, isUserScrolling: false, wasNearBottom: true))
        }
    }

    func setStreaming(_ streaming: Bool) {
        guard streaming != isStreaming else { return }
        isStreaming = streaming
        // Recompute proximity when the threshold changes, since the cached
        // isNearBottom was computed with the old streaming state.
        let nearBottom = AidenChatScrollPolicy.isNearBottom(
            distanceFromBottom: distanceFromBottom,
            isStreaming: streaming
        )
        if nearBottom != isNearBottom { isNearBottom = nearBottom }
        updateJumpButton()
    }

    /// Schedules a scroll to the latest content. A user-initiated jump resets
    /// the latch first; an automatic follow runs only while following. Only
    /// the newest scheduled scroll performs, and an automatic one re-checks
    /// the latch when it fires, so a drag that began in the pause wins.
    /// `perform` receives whether to animate: never while streaming, because
    /// the next reveal tick would cut the animation off before it settles.
    ///
    /// An animated scroll targets the bottom sentinel through a lazy stack's
    /// estimated row heights, so it can land short once the rows it passed
    /// are measured. After it settles, one non-animated scroll finishes the
    /// trip if the reader is still more than the re-arm tolerance away and
    /// nothing newer (a drag, another follow) has happened since.
    @discardableResult
    func scheduleFollowScroll(
        isUserInitiated: Bool,
        animated: Bool,
        perform: @escaping @MainActor (_ animated: Bool) -> Void
    ) -> Task<Void, Never>? {
        if isUserInitiated {
            handle(.reset)
        } else if !latch.isFollowing {
            return nil
        }
        followGeneration &+= 1
        let generation = followGeneration
        let pause = followPause
        return Task { @MainActor [weak self] in
            await pause()
            guard let self, !Task.isCancelled, generation == self.followGeneration else { return }
            if !isUserInitiated, !self.latch.isFollowing { return }
            let animates = animated && !self.isStreaming
            perform(animates)
            guard animates else { return }
            await self.animationSettle()
            guard !Task.isCancelled, generation == self.followGeneration, self.latch.isFollowing,
                  !AidenChatScrollPolicy.isAtBottom(distanceFromBottom: self.distanceFromBottom) else { return }
            perform(false)
        }
    }

    private func updateJumpButton() {
        let wanted = AidenChatScrollPolicy.showsScrollToBottomButton(
            isNearBottom: isNearBottom,
            isStreaming: isStreaming,
            isFollowing: latch.isFollowing
        )
        if !wanted {
            if isJumpButtonRevealPending {
                jumpButtonGeneration &+= 1
                isJumpButtonRevealPending = false
            }
            if showsJumpButton { showsJumpButton = false }
            return
        }
        // Already shown, or the reveal is already counting down from when the
        // reader first left: further reports must not postpone it.
        guard !showsJumpButton, !isJumpButtonRevealPending else { return }
        jumpButtonGeneration &+= 1
        isJumpButtonRevealPending = true
        let generation = jumpButtonGeneration
        let delay = jumpButtonDelay
        Task { @MainActor [weak self] in
            await delay()
            guard let self, generation == self.jumpButtonGeneration else { return }
            self.isJumpButtonRevealPending = false
            self.showsJumpButton = true
        }
    }
}
