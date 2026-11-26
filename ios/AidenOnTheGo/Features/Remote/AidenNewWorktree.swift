import SwiftUI

/// Revision 53 (`chat:new-worktree`): the first message of an empty Workspace
/// chat can start it in a new worktree on the Mac. The Mac picks the base the
/// way a desktop draft does and names the branch from the message. The words
/// match the Mac and Android.
enum AidenNewWorktreeCopy {
    static let toggle = "New worktree"
    static let settingUp = "Setting up worktree…"
    static let hint = "Your first message starts this chat in its own worktree on your computer."
    static let noLongerOffered = "New worktree isn’t available for this chat any more, so your message wasn’t sent. Send it again to use the chat’s own folder."
}

/// Which key the next New worktree request carries.
enum AidenNewWorktreeRetry {
    /// The Mac keeps each answer under its key for a day, structured refusals
    /// included, so a structured server refusal spends the key unless it is
    /// `idempotency_in_flight` or carries a transient status (`408`, `429` or
    /// `5xx`). Requests with no settled structured refusal (connection loss,
    /// timeout, Cancel, invalid response, unparsed status, `idempotency_in_flight`,
    /// or a transient status) keep their key so replay cannot duplicate the worktree.
    static func spendsKey(_ error: Error) -> Bool {
        AidenRemoteFailureClassification.spendsDurableKey(error)
    }
}

/// Whether the phone offers New worktree for a chat.
enum AidenNewWorktreeAvailability {
    /// Offered for an empty Workspace chat whose workspace has a folder Aiden
    /// may use and is not already a worktree, while the Mac offers and this
    /// phone holds `chat:new-worktree`, `git:write` and `chat:write`.
    /// `hasCommits` is what a `git:read` branch list showed: false (not a
    /// repository, or no commits yet) hides it, and nil (not read) leaves the
    /// Mac to refuse with its own reason.
    static func isOffered(
        chat: AidenChat,
        workspace: AidenWorkspace?,
        server: AidenServer?,
        hasCommits: Bool?
    ) -> Bool {
        guard !chat.isBotChat, chat.messages.isEmpty,
              let workspace, workspace.id == chat.workspaceId else { return false }
        return isOffered(in: workspace, server: server, hasCommits: hasCommits)
    }

    /// The workspace half of the rule, for a chat that doesn't exist yet
    /// (Home's composer): a folder Aiden may use that is not already a
    /// worktree, on a Mac that offers it to this phone.
    static func isOffered(in workspace: AidenWorkspace, server: AidenServer?, hasCommits: Bool? = nil) -> Bool {
        guard workspace.hasFolder, !workspace.isManagedWorktree, workspace.permission != .none,
              let server,
              server.serverCapabilities?.contains(.chatNewWorktree) == true,
              server.capabilities.contains(.chatNewWorktree),
              server.capabilities.contains(.gitWrite),
              server.capabilities.contains(.chatWrite) else { return false }
        return hasCommits != false
    }

    /// A branch list from `GET /workspaces/{id}/git/branches`: a folder that
    /// is not a repository lists none, and a repository with no commits is
    /// marked `unborn` (it still lists its branch).
    static func hasCommits(_ result: AidenGitResult) -> Bool? {
        guard case .branches(let branches)? = result.result else { return nil }
        return branches.unborn != true && !branches.branches.isEmpty
    }
}

/// The composer chip: on, the first message makes the worktree before it sends.
struct AidenNewWorktreeChip: View {
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            AidenProgressChipLabel(
                systemImage: isOn ? "checkmark.circle.fill" : "arrow.triangle.branch",
                title: AidenNewWorktreeCopy.toggle,
                stale: false
            )
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(Text(AidenNewWorktreeCopy.toggle))
        .accessibilityValue(Text(isOn ? "On" : "Off"))
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(Text(AidenNewWorktreeCopy.hint))
    }
}

/// Above the composer while the Mac makes the worktree. Cancel stops waiting
/// and puts the message back in the composer.
struct AidenNewWorktreeSetupRow: View {
    @Environment(\.aidenPalette) private var palette

    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .accessibilityHidden(true)
            Text(AidenNewWorktreeCopy.settingUp)
                .font(.footnote)
                .foregroundStyle(palette.foreground)
                .accessibilityAddTraits(.updatesFrequently)
            Spacer(minLength: 8)
            Button("Cancel", action: onCancel)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .accessibilityHint(Text("Stops setting up the worktree and keeps your message"))
        }
        .padding(12)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}
