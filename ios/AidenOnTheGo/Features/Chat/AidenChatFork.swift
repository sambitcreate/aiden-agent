import SwiftUI

/// The fork actions a settled transcript message offers (contract revision 21).
enum AidenChatForkMenuAction: String, CaseIterable, Equatable, Hashable, Sendable {
    /// Plain fork that keeps this assistant reply.
    case forkHere
    /// Fork that keeps this reply and summarizes what followed it.
    case forkWithSummary
    /// Fork that cuts just before this prompt so it can be edited and resent.
    case editInFork

    var position: AidenChatForkPosition {
        self == .editInFork ? .before : .after
    }

    var menuTitle: LocalizedStringKey {
        switch self {
        case .forkHere: "Fork from Here"
        case .forkWithSummary: "Fork with Summary…"
        case .editInFork: "Edit in Fork"
        }
    }

    var accessibilityTitle: LocalizedStringKey {
        switch self {
        case .forkHere: "Fork from here"
        case .forkWithSummary: "Fork with summary"
        case .editInFork: "Edit in fork"
        }
    }

    var systemImage: String {
        switch self {
        case .forkHere: "arrow.triangle.branch"
        case .forkWithSummary: "text.append"
        case .editInFork: "square.and.pencil"
        }
    }
}

/// The message a Fork with Summary sheet forks at.
struct AidenForkSummaryRequest: Identifiable, Equatable {
    let id: String
}

/// Fork support negotiated with the paired Mac for a writable Workspace chat.
struct AidenChatForkAvailability: Equatable, Sendable {
    /// `chat-fork-summary-v1`: offer Fork with Summary.
    let supportsSummary: Bool
}

/// The "Forked from" row's source, resolved after the fork opens.
enum AidenChatForkSource: Equatable, Sendable {
    /// Not looked up yet, or the lookup failed: the row stays hidden.
    case unresolved
    case titled(String)
    /// The Mac reports the source chat no longer exists.
    case deleted

    var label: String? {
        switch self {
        case .unresolved: nil
        case .titled(let title): AidenChatForkEligibility.forkedFromLabel(title)
        case .deleted: AidenChatForkEligibility.forkedFromLabel(nil)
        }
    }
}

/// Which settled messages can be forked, mirroring the desktop rules in
/// `forkTurnEligibility` and `forkSummaryRows`.
enum AidenChatForkEligibility {
    /// Fork actions keyed by message id. A reply forks only once a prompt
    /// precedes it. Fork with summary needs a later message to summarize.
    /// Edit in fork needs an earlier prompt, otherwise the fork would be empty.
    static func actions(
        for messages: [AidenChatMessage],
        supportsSummary: Bool
    ) -> [String: [AidenChatForkMenuAction]] {
        var result: [String: [AidenChatForkMenuAction]] = [:]
        var hasEarlierPrompt = false
        for (index, message) in messages.enumerated() {
            switch message.role {
            case .assistant:
                guard hasEarlierPrompt else { continue }
                var actions: [AidenChatForkMenuAction] = [.forkHere]
                if supportsSummary, index < messages.count - 1 {
                    actions.append(.forkWithSummary)
                }
                result[message.id] = actions
            case .user:
                if hasEarlierPrompt { result[message.id] = [.editInFork] }
                hasEarlierPrompt = true
            }
        }
        return result
    }

    /// Plain-language provenance. A missing title means the source is gone.
    static func forkedFromLabel(_ sourceTitle: String?) -> String {
        let title = sourceTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty
            ? String(localized: "Forked from a deleted chat")
            : String(localized: "Forked from “\(title)”")
    }
}

/// Carries restaged attachments from an Edit in fork to the composer of the
/// fork it opens. The prefill text travels through the per-chat draft store;
/// attachments cannot, because the store deliberately holds text only.
@MainActor
enum AidenChatForkPrefillHandoff {
    struct Entry {
        let attachments: [AidenAttachmentReference]
        let context: AidenRemoteRequestContext
        let client: AidenRemoteClient
    }

    private static var entries: [String: Entry] = [:]

    static func stage(_ entry: Entry, chatId: String) {
        entries[key(instanceId: entry.context.instanceId, chatId: chatId)] = entry
    }

    /// Removes and returns the entry so attachments seed exactly one composer.
    static func take(instanceId: String, chatId: String) -> Entry? {
        entries.removeValue(forKey: key(instanceId: instanceId, chatId: chatId))
    }

    /// Unpairing invalidates every staged attachment for that installation.
    static func purge(instanceId: String) {
        entries = entries.filter { $0.value.context.instanceId != instanceId }
    }

    private static func key(instanceId: String, chatId: String) -> String {
        "\(instanceId)\u{1f}\(chatId)"
    }
}

/// Quiet provenance row at the top of a forked transcript.
struct AidenChatForkLineageRow: View {
    @Environment(\.aidenPalette) private var palette
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
                .accessibilityHidden(true)
            Text(label)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .font(.caption)
        .foregroundStyle(palette.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("aiden.chat.forkedFrom")
    }
}

/// A chat-list title that carries the fork glyph when the chat was forked.
struct AidenForkableChatTitle: View {
    let title: String
    let isFork: Bool

    var body: some View {
        HStack(spacing: 5) {
            if isFork {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Fork")
            }
            Text(title)
        }
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

/// "What happened after this point": the fork summary the model sees, shown
/// right after the last copied message.
struct AidenForkSummaryCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let summary: AidenChatForkSummary
    let isBusy: Bool
    let onCancel: (() -> Void)?
    let onRetry: (() -> Void)?
    let onSkip: (() -> Void)?
    @State private var isExpanded = false

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(alignment: .leading, spacing: 10) {
            header
            switch summary.state {
            case .pending:
                if let onCancel {
                    HStack {
                        actionButton("Cancel", prominent: false, action: onCancel)
                        Spacer(minLength: 0)
                    }
                }
            case .failed:
                Text(failureText)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if onRetry != nil || onSkip != nil {
                    HStack(spacing: 8) {
                        if let onRetry { actionButton("Retry", prominent: true, action: onRetry) }
                        if let onSkip { actionButton("Continue without summary", prominent: false, action: onSkip) }
                        Spacer(minLength: 0)
                    }
                }
            case .ready:
                if isExpanded { readyDetails }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: shape)
        .overlay(shape.stroke(palette.foreground.opacity(0.08), lineWidth: 0.5))
        .shadow(color: palette.foreground.opacity(0.08), radius: 8, y: 3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("aiden.chat.forkSummary")
    }

    @ViewBuilder
    private var header: some View {
        switch summary.state {
        case .pending:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Summarizing the original chat…")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
            }
            .accessibilityElement(children: .combine)
        case .failed:
            Label {
                Text("What happened after this point")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(palette.warning)
            }
        case .ready:
            Button {
                if reduceMotion {
                    isExpanded.toggle()
                } else {
                    withAnimation(.snappy(duration: 0.2)) { isExpanded.toggle() }
                }
            } label: {
                HStack(spacing: 8) {
                    Text("What happened after this point")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(palette.foreground)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded ? Text("Expanded") : Text("Collapsed"))
            .accessibilityHint("Shows the summary the model sees.")
        }
    }

    private var failureText: String {
        let reason = summary.error ?? String(localized: "The summary could not be generated.")
        return "\(reason) " + String(localized: "Messages you send wait until you retry or continue without it.")
    }

    @ViewBuilder
    private var readyDetails: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("The model sees this summary. None of it happened in this chat.")
                .font(.caption)
                .foregroundStyle(palette.secondary)
            if let focus = summary.focus {
                Text("Focus: \(focus)")
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }
            if let text = summary.text {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(palette.foreground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func actionButton(_ title: LocalizedStringKey, prominent: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(prominent ? palette.canvas : palette.foreground)
                .padding(.horizontal, 13)
                .frame(minHeight: 34)
                .background(
                    prominent ? palette.accent : palette.canvas,
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .opacity(isBusy ? 0.5 : 1)
    }
}

/// Fork with summary: an optional focus for the summary, then Fork.
struct AidenForkSummarySheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    let onFork: (String) -> Void
    @State private var focus = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "For example: the decisions about the parser",
                        text: Binding(
                            get: { focus },
                            set: { focus = Self.bounded($0) }
                        ),
                        axis: .vertical
                    )
                    .lineLimit(2...5)
                    .accessibilityLabel("Focus the summary on (optional)")
                    .accessibilityIdentifier("aiden.chat.forkSummary.focus")
                } header: {
                    Text("Focus the summary on (optional)")
                } footer: {
                    Text("The new chat keeps the conversation up to this point. Aiden summarizes what happened after it in the original chat and gives that summary to the model.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Fork with Summary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fork") {
                        onFork(focus)
                        dismiss()
                    }
                    .accessibilityIdentifier("aiden.chat.forkSummary.confirm")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// The Mac accepts at most 1,000 UTF-16 code units of focus text.
    static func bounded(_ value: String) -> String {
        guard value.utf16.count > AidenChatForkSummary.maximumFocusLength else { return value }
        var result = ""
        var used = 0
        for character in value {
            let width = character.utf16.count
            guard used + width <= AidenChatForkSummary.maximumFocusLength else { break }
            result.append(character)
            used += width
        }
        return result
    }
}
