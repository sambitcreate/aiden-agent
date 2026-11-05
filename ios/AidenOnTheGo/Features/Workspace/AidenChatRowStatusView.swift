import SwiftUI

/// Trailing chat-row status. Attention states use soft semantic fills with no
/// borders; Working shows the desktop's turning ring; the unread dot is independent
/// because a chat can be both working and holding unseen earlier output.
/// Unseen output from a failed turn says Failed in place of the dot.
struct AidenChatRowStatusView: View {
    let state: AidenChatRowState
    let unread: Bool
    /// True while the unseen output is a failed turn (`showsFailed`).
    let failed: Bool
    let palette: AidenPalette

    var body: some View {
        HStack(spacing: 6) {
            switch state {
            case .needsApproval:
                pill("Approve", systemImage: "checkmark.shield", tint: palette.warning, label: state.accessibilityLabel)
            case .needsInput:
                pill("Reply", systemImage: "questionmark.bubble", tint: palette.accent, label: state.accessibilityLabel)
            case .working:
                AidenWorkingIndicator(size: 16, tint: palette.accent, accessibilityLabel: state.accessibilityLabel)
            case .idle:
                EmptyView()
            }
            if failed {
                pill("Failed", systemImage: "exclamationmark.circle", tint: palette.danger, label: "Failed")
            } else if unread {
                Circle()
                    .fill(palette.accent)
                    .frame(width: 8, height: 8)
                    .accessibilityElement()
                    .accessibilityLabel("Unread")
            }
        }
    }

    private func pill(_ title: String, systemImage: String, tint: Color, label: String) -> some View {
        Label(title, systemImage: systemImage)
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
    }
}
