import SwiftUI
import UIKit

// Adapted from Hermex (`ChatScrollObserver`, `StreamingFollowTrigger`),
// MIT License, Copyright (c) 2026 Uzair Ansar. See THIRD_PARTY_NOTICES.md.

struct AidenChatScrollMetrics: Equatable {
    let distanceFromBottom: CGFloat
    let isUserInteracting: Bool
    /// A scroll with no gesture carried the reader away from the bottom since
    /// the last delivered report; see `AidenChatScrollPolicy.isScrollingAwayFromBottom`.
    let movedAwayFromBottom: Bool
}

/// Reports the transcript's scroll geometry and the gesture events that drive
/// the follow latch. Metrics arrive on offset or size changes, coalesced to
/// one delivery per run loop; follow events arrive when a drag begins and when
/// the gesture, including any momentum, has settled.
///
/// Place it in the scrolled content's background: it finds the enclosing
/// `UIScrollView`, adds a target to its pan gesture, and observes
/// `contentOffset` and `contentSize` with KVO.
struct AidenChatScrollObserver: UIViewRepresentable {
    let onFollowEvent: @MainActor (AidenChatScrollPolicy.FollowEvent) -> Void
    let onMetrics: @MainActor (AidenChatScrollMetrics) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFollowEvent: onFollowEvent, onMetrics: onMetrics)
    }

    func makeUIView(context: Context) -> ObserverView {
        ObserverView(coordinator: context.coordinator)
    }

    func updateUIView(_ uiView: ObserverView, context: Context) {
        context.coordinator.onMetrics = onMetrics
        context.coordinator.onFollowEvent = onFollowEvent
        uiView.coordinator = context.coordinator
        context.coordinator.attachIfNeeded(from: uiView)
    }

    static func dismantleUIView(_ uiView: ObserverView, coordinator: Coordinator) {
        uiView.coordinator = nil
        coordinator.detach()
    }

    @MainActor
    final class ObserverView: UIView {
        weak var coordinator: Coordinator?

        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            backgroundColor = .clear
            isAccessibilityElement = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            coordinator?.attachIfNeeded(from: self)
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            coordinator?.attachIfNeeded(from: self)
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            coordinator?.reportMetrics()
        }
    }

    @MainActor
    final class Coordinator: NSObject {
        var onMetrics: @MainActor (AidenChatScrollMetrics) -> Void
        var onFollowEvent: @MainActor (AidenChatScrollPolicy.FollowEvent) -> Void

        private weak var scrollView: UIScrollView?
        private weak var observedPanGesture: UIPanGestureRecognizer?
        private var observations: [NSKeyValueObservation] = []
        private var lastMetrics: AidenChatScrollMetrics?
        private var pendingMetrics: AidenChatScrollMetrics?
        /// Geometry behind the last report the transcript received. Reports
        /// coalesce per run loop, so the away-from-bottom check compares
        /// delivered states, not every intermediate KVO tick.
        private var deliveredGeometry: AidenChatScrollPolicy.ScrollGeometry?
        private var pendingGeometry: AidenChatScrollPolicy.ScrollGeometry?
        private var hasScheduledMetricDelivery = false
        /// True from the first drag movement until the gesture, including any
        /// momentum, comes to rest.
        private var isUserScrollSessionActive = false
        private var settleWorkItem: DispatchWorkItem?

        init(
            onFollowEvent: @escaping @MainActor (AidenChatScrollPolicy.FollowEvent) -> Void,
            onMetrics: @escaping @MainActor (AidenChatScrollMetrics) -> Void
        ) {
            self.onFollowEvent = onFollowEvent
            self.onMetrics = onMetrics
        }

        func attachIfNeeded(from view: UIView) {
            guard let scrollView = enclosingScrollView(for: view) else { return }
            guard scrollView !== self.scrollView else {
                reportMetrics()
                return
            }

            observations.removeAll()
            lastMetrics = nil
            deliveredGeometry = nil
            endUserScrollSessionSilently()
            self.scrollView = scrollView

            observedPanGesture?.removeTarget(self, action: nil)
            scrollView.panGestureRecognizer.addTarget(self, action: #selector(handlePanGesture(_:)))
            observedPanGesture = scrollView.panGestureRecognizer

            observations = [
                scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                    Self.reportObservedMetrics(for: self)
                },
                scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                    Self.reportObservedMetrics(for: self)
                }
            ]
            reportMetrics()
        }

        func detach() {
            observations.removeAll()
            observedPanGesture?.removeTarget(self, action: nil)
            observedPanGesture = nil
            endUserScrollSessionSilently()
            lastMetrics = nil
            deliveredGeometry = nil
            pendingMetrics = nil
            pendingGeometry = nil
            hasScheduledMetricDelivery = false
            scrollView = nil
        }

        // MARK: Follow latch events

        @objc private func handlePanGesture(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                cancelSettle()
                isUserScrollSessionActive = true
                onFollowEvent(.userScrollBegin)
            case .ended, .cancelled, .failed:
                guard isUserScrollSessionActive, let scrollView else { return }
                // Remember where the finger lifted: streaming growth during the
                // momentum-detection window must not turn a release at the live
                // edge into an opt-out from follow.
                let releaseIsAtBottom = isAtBottom(scrollView)
                scheduleSettle(after: AidenChatScrollPolicy.dragSettleDelay) { [weak self] in
                    guard let self, let scrollView = self.scrollView else { return }
                    // Momentum announced itself; its ticks now own the session.
                    if scrollView.isDecelerating { return }
                    self.finishUserScrollSession(isAtBottom: releaseIsAtBottom)
                }
            default:
                break
            }
        }

        /// Each momentum tick pushes the settle check out; the check that
        /// survives runs once deceleration has stopped moving the content.
        private func trackMomentum(_ scrollView: UIScrollView) {
            guard isUserScrollSessionActive, scrollView.isDecelerating else { return }
            scheduleSettle(after: AidenChatScrollPolicy.momentumSettleDelay) { [weak self] in
                self?.finishUserScrollSessionIfSettled()
            }
        }

        private func finishUserScrollSessionIfSettled() {
            guard isUserScrollSessionActive, let scrollView else { return }
            if scrollView.isDragging { return }
            // A finger resting on the glass (tracking but not dragging) may not
            // produce a pan .failed event, so reschedule the settle check instead
            // of returning. Once the finger lifts or movement starts, UIKit will
            // send pan .ended/.began to cancel/replace this check.
            if scrollView.isTracking {
                scheduleSettle(after: AidenChatScrollPolicy.momentumSettleDelay) { [weak self] in
                    self?.finishUserScrollSessionIfSettled()
                }
                return
            }
            if scrollView.isDecelerating {
                scheduleSettle(after: AidenChatScrollPolicy.momentumSettleDelay) { [weak self] in
                    self?.finishUserScrollSessionIfSettled()
                }
                return
            }
            finishUserScrollSession(isAtBottom: isAtBottom(scrollView))
        }

        private func finishUserScrollSession(isAtBottom: Bool) {
            cancelSettle()
            isUserScrollSessionActive = false
            onFollowEvent(.userScrollEnd(isAtBottom: isAtBottom))
        }

        private func endUserScrollSessionSilently() {
            cancelSettle()
            isUserScrollSessionActive = false
        }

        private func scheduleSettle(after delay: TimeInterval, _ body: @escaping @MainActor () -> Void) {
            cancelSettle()
            let workItem = DispatchWorkItem {
                MainActor.assumeIsolated(body)
            }
            settleWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
        }

        private func cancelSettle() {
            settleWorkItem?.cancel()
            settleWorkItem = nil
        }

        private func isAtBottom(_ scrollView: UIScrollView) -> Bool {
            guard let geometry = geometry(of: scrollView) else { return false }
            return AidenChatScrollPolicy.isAtBottom(distanceFromBottom: geometry.distanceFromBottom)
        }

        private func geometry(of scrollView: UIScrollView) -> AidenChatScrollPolicy.ScrollGeometry? {
            let inset = scrollView.adjustedContentInset
            let visibleHeight = scrollView.bounds.height - inset.top - inset.bottom
            guard visibleHeight > 0 else { return nil }
            return AidenChatScrollPolicy.ScrollGeometry(
                offsetY: scrollView.contentOffset.y + inset.top,
                contentHeight: scrollView.contentSize.height,
                visibleHeight: visibleHeight
            )
        }

        func reportMetrics() {
            guard let scrollView else { return }
            trackMomentum(scrollView)

            guard let geometry = geometry(of: scrollView) else { return }
            // A finger resting on the glass (a tap, a long press, a pause
            // before a drag) sets `isTracking` without moving anything, and no
            // pan ends to re-arm follow afterwards. Only a drag that has moved
            // the content, or its momentum, counts as the reader scrolling.
            let isUserInteracting = scrollView.isDragging || scrollView.isDecelerating
            let metrics = AidenChatScrollMetrics(
                distanceFromBottom: geometry.distanceFromBottom,
                isUserInteracting: isUserInteracting,
                movedAwayFromBottom: !isUserInteracting
                    && AidenChatScrollPolicy.isScrollingAwayFromBottom(previous: deliveredGeometry, current: geometry)
            )
            guard metrics != lastMetrics else { return }
            lastMetrics = metrics

            // Coalesce: deliver the newest report once per run loop.
            pendingMetrics = metrics
            pendingGeometry = geometry
            guard !hasScheduledMetricDelivery else { return }
            hasScheduledMetricDelivery = true
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let metrics = self.pendingMetrics
                    let geometry = self.pendingGeometry
                    self.pendingMetrics = nil
                    self.pendingGeometry = nil
                    self.hasScheduledMetricDelivery = false
                    guard let metrics, self.lastMetrics == metrics else { return }
                    self.deliveredGeometry = geometry
                    self.onMetrics(metrics)
                }
            }
        }

        nonisolated private static func reportObservedMetrics(for coordinator: Coordinator?) {
            guard Thread.isMainThread else {
                DispatchQueue.main.async { [weak coordinator] in
                    MainActor.assumeIsolated { coordinator?.reportMetrics() }
                }
                return
            }
            MainActor.assumeIsolated { coordinator?.reportMetrics() }
        }

        private func enclosingScrollView(for view: UIView) -> UIScrollView? {
            var current = view.superview
            while let candidate = current {
                if let scrollView = candidate as? UIScrollView { return scrollView }
                current = candidate.superview
            }
            return nil
        }
    }
}

/// Fires `onFire` whenever `trigger()` changes. It is a leaf that reads the
/// trigger itself, so a per-tick bump re-runs only this view, never the
/// transcript or the chat screen that own it.
struct AidenStreamingFollowTrigger: View {
    let trigger: () -> Int
    let onFire: () -> Void

    var body: some View {
        Color.clear
            .accessibilityHidden(true)
            .onChange(of: trigger()) { onFire() }
    }
}
