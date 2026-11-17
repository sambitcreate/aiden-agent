import SwiftUI

enum AidenNewAgentChoice: String, CaseIterable, Identifiable {
    case noWorkspace
    case existingWorkspace
    case newWorkspace
    case scratchWorkspace

    var id: String { rawValue }

    /// The choices to offer: No Workspace only when the Mac lists a Chats home (revision 51).
    static func available(noWorkspace: Bool) -> [AidenNewAgentChoice] {
        allCases.filter { noWorkspace || $0 != .noWorkspace }
    }

    var title: String {
        switch self {
        case .noWorkspace: "No Workspace"
        case .existingWorkspace: "Existing Workspace"
        case .newWorkspace: "New Workspace"
        case .scratchWorkspace: "Managed Scratch Workspace"
        }
    }

    var detail: String {
        switch self {
        case .noWorkspace: "Use your global settings. Aiden keeps a private folder for this chat."
        case .existingWorkspace: "Start another chat without creating a folder."
        case .newWorkspace: "Create a reusable workspace for ongoing work."
        case .scratchWorkspace: "Use an isolated workspace Aiden can clean up later."
        }
    }

    var symbol: String {
        switch self {
        case .noWorkspace: "bubble.left.and.bubble.right"
        case .existingWorkspace: "folder"
        case .newWorkspace: "folder.badge.plus"
        case .scratchWorkspace: "hammer.fill"
        }
    }
}

struct AidenNewAgentPopover: View {
    @Environment(\.aidenPalette) private var palette

    let choices: [AidenNewAgentChoice]
    let canUseExistingWorkspace: Bool
    /// Which machine the chat goes to, when there is more than one to choose.
    var machinePicker: AidenNewWorkMachinePicker?
    /// False while the machine in the picker can't take the chat.
    var canStart = true
    let onSelect: (AidenNewAgentChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                Text("New Chat")
                    .font(.title3.bold())
                    .foregroundStyle(palette.foreground)

                Text("Choose where this chat runs.")
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 10)

            if let machinePicker {
                machinePicker
                    .padding(.horizontal, 18)
                    .padding(.bottom, 12)
            }

            ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                Button {
                    onSelect(choice)
                } label: {
                    HStack(alignment: .center, spacing: 13) {
                        Image(systemName: choice.symbol)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(palette.accent)
                            .frame(width: 38, height: 38)
                            .background(palette.accent.opacity(0.12), in: Circle())

                        VStack(alignment: .leading, spacing: 3) {
                            Text(choice.title)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                                .lineLimit(1)

                            Text(detail(for: choice))
                                .font(.caption)
                                .foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        Spacer(minLength: 6)

                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canStart || (choice == .existingWorkspace && !canUseExistingWorkspace))
                .opacity(!canStart || (choice == .existingWorkspace && !canUseExistingWorkspace) ? 0.45 : 1)
                .accessibilityHint(detail(for: choice))

                if index < choices.count - 1 {
                    Divider()
                        .overlay(palette.secondary.opacity(0.18))
                        .padding(.leading, 69)
                }
            }
        }
        .padding(.bottom, 8)
        .background(palette.canvas.opacity(0.001))
        .accessibilityElement(children: .contain)
    }

    private func detail(for choice: AidenNewAgentChoice) -> String {
        if choice == .existingWorkspace, !canUseExistingWorkspace {
            return String(localized: "Add a workspace before using this option.")
        }
        return choice.detail
    }
}
