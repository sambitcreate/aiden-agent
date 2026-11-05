import SwiftUI

struct AidenActivityFeed: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let timeline: AidenGenerationTimeline
    let active: Bool
    let progressText: String?
    let showsRunningRowsWhenCollapsed: Bool
    var steps: [AidenAgentStep]? = nil
    @State private var isExpanded = false

    private var visibleSteps: [AidenAgentStep] { steps ?? timeline.steps }
    private var rows: [AidenAgentStep] { Array(visibleSteps.suffix(3)) }
    private var isRunning: Bool { active && timeline.status == .running }
    private var compactOnly: Bool { AidenAgentActivityPresentation.isCompactContextOnly(visibleSteps) }
    /// A healthy lone compaction is fully told by its own line in the header, so the
    /// expanded list would only repeat it; progress text still needs the disclosure.
    private var stepInHeader: Bool { compactOnly && timeline.issueCount == 0 }
    private var allowsDisclosure: Bool {
        !stepInHeader || !(progressText ?? "").isEmpty
    }
    private var showsCollapsedTicker: Bool {
        isRunning && (!isExpanded || !allowsDisclosure) && showsRunningRowsWhenCollapsed
    }
    private var headline: String {
        if stepInHeader, let last = visibleSteps.last {
            return AidenAgentActivityPresentation.line(for: last)
        }
        return AidenAgentActivityPresentation.summary(timeline)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded && allowsDisclosure ? 4 : 0) {
            header
            if allowsDisclosure, isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if !stepInHeader {
                        ForEach(visibleSteps) { step in
                            AidenActivityStepLine(step: step, shimmer: isRunning && step.isActive)
                        }
                    }
                    if let progressText, !progressText.isEmpty {
                        Divider()
                            .padding(.vertical, 4)
                        Text("Updates")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                        Text(verbatim: progressText)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .padding(.top, 1)
                    }
                }
                .padding(.top, 2)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: timeline.steps.last?.id)
        .onAppear {
            if timeline.issueCount > 0 { isExpanded = true }
        }
    }

    @ViewBuilder
    private var header: some View {
        if allowsDisclosure {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                headerRow.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(headline)
            .accessibilityHint(isExpanded ? "Collapses activity" : "Expands activity")
        } else {
            headerRow
                .accessibilityElement(children: .combine)
                .accessibilityLabel(headline)
        }
    }

    private var headerRow: some View {
        HStack(alignment: showsCollapsedTicker ? .bottom : .center, spacing: 8) {
            Group {
                if showsCollapsedTicker {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { step in
                            AidenActivityStepLine(step: step, shimmer: step.id == rows.last?.id && step.isActive)
                                .frame(height: 24)
                                .id(step.id)
                                .transition(.opacity)
                        }
                    }
                    .frame(height: CGFloat(rows.count) * 24, alignment: .bottom)
                    .clipped()
                } else {
                    Text(headline)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                        .aidenActivityShimmer(isRunning)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if timeline.issueCount > 0 {
                Text(timeline.issueCount == 1 ? "1 issue" : "\(timeline.issueCount) issues")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.warning)
            }

            if allowsDisclosure {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
    }
}

struct AidenActivityStepLine: View {
    @Environment(\.aidenPalette) private var palette
    let step: AidenAgentStep
    let shimmer: Bool

    private var tone: Color {
        switch step.status {
        case .failed: palette.danger
        case .blocked, .cancelled, .awaitingApproval: palette.warning
        default: palette.secondary
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(AidenAgentActivityPresentation.line(for: step))
                .lineLimit(1)
                .truncationMode(.tail)
            if let file = step.producedFile {
                Text("File \(file.operation) · \(file.relativePath.components(separatedBy: "/").last ?? file.relativePath)")
                    .font(.caption2)
                    .lineLimit(1)
                    .accessibilityLabel("File \(file.operation): \(file.relativePath)")
            }
            if let changes = step.lineChanges, changes.additions > 0 || changes.deletions > 0 {
                Text("+\(changes.additions) −\(changes.deletions)")
                    .font(.caption2.monospaced().weight(.medium))
            }
        }
        .font(.caption)
        .foregroundStyle(tone)
        .aidenActivityShimmer(shimmer)
        .accessibilityElement(children: .combine)
    }
}

private struct AidenActivityShimmerModifier: ViewModifier {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    let active: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if active && !reduceMotion && !lowPowerMode {
            content.overlay {
                GeometryReader { proxy in
                    TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                        let cycle = context.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: 1.8) / 1.8
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.42), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: max(proxy.size.width * 0.55, 36))
                        .offset(x: (proxy.size.width * 1.55 * cycle) - proxy.size.width * 0.55)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        } else {
            content
        }
    }
}

extension View {
    func aidenActivityShimmer(_ active: Bool) -> some View {
        modifier(AidenActivityShimmerModifier(active: active))
    }
}
