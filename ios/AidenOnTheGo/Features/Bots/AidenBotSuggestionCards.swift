import SwiftUI

// Contract revision 61: the Bot session cards a phone that holds
// `bot:settings-changes` or `bot:suggestions` sees, matching the Mac's copy.
// A held settings change shows its whole proposed text and the line diff with
// Apply and Dismiss (Edit happens on the Mac); an applied one is a receipt
// with Undo. Skills, lessons and memory tidy-ups answer through their routes.

/// "Update instructions?" with the full proposed text, or "Instructions
/// updated · Undo" for a change the Bot already made.
struct AidenBotSettingsChangeCardView: View {
    let change: AidenBotSettingsChangeEntry
    var botName: String = "This Bot"
    let canRespond: Bool
    let isBusy: Bool
    let onRespond: (AidenBotSettingsChangeDecision) -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        if change.isHeld {
            held
        } else {
            receipt
        }
    }

    private var receiptLabel: String {
        change.fields == [.instructions] ? "Instructions updated" : "Settings updated"
    }

    private var receiptText: String {
        let detail = change.fields == [.instructions] || change.lines.isEmpty ? "" : " · \(change.lines.joined(separator: ", "))"
        switch change.status {
        case .restored: return "\(receiptLabel)\(detail) · Restored"
        case .undoRefused: return "\(receiptLabel)\(detail) · Changed again since, so not undone"
        default: return "\(receiptLabel)\(detail)"
        }
    }

    private var receipt: some View {
        AidenBotReceiptLine(
            symbol: "slider.horizontal.3",
            text: receiptText,
            action: change.undoable && change.status == .pending && canRespond ? "Undo" : nil,
            isBusy: isBusy
        ) { onRespond(.undo) }
    }

    private var heldReason: String {
        switch change.heldReason ?? .notOwner {
        case .notOwner: "\(botName) asked to change its settings in a run you didn’t start."
        case .outsideContent: "\(botName) asked to change its settings after this chat read content from outside it, like a web page or an app’s data."
        case .widens: "\(botName) asked to reach out to you more on its own."
        }
    }

    private var held: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(change.title, systemImage: "slider.horizontal.3")
                .font(.headline)
                .foregroundStyle(palette.foreground)
                .accessibilityAddTraits(.isHeader)
            Text(heldReason)
                .font(.subheadline)
                .foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            let other = change.lines.filter { $0 != "Instructions" }
            if !other.isEmpty {
                Text(other.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            if let instructions = change.instructions {
                Text("Apply replaces \(botName)’s instructions with this text.")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                AidenBotInstructionsDiffView(
                    lines: change.instructionsDiff
                        ?? instructions.components(separatedBy: "\n").map { .init(kind: .same, text: $0) }
                )
            }
            status.padding(.top, 4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var status: some View {
        switch change.status {
        case .pending:
            if canRespond {
                HStack(spacing: 10) {
                    Button("Dismiss") { onRespond(.dismiss) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                    Button("Apply") { onRespond(.apply) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
                }
                .disabled(isBusy)
                Text("To edit it first, open this Bot on your computer.")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            } else {
                Text(AidenBotSessionCopy.finishOnMacReadOnly)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
        case .applied:
            Label("Applied", systemImage: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(palette.success)
        case .edited:
            Label("Edited and applied on your computer", systemImage: "checkmark").font(.subheadline).foregroundStyle(palette.success)
        case .dismissed:
            Text("Dismissed").font(.subheadline).foregroundStyle(palette.secondary)
        case .restored:
            Text("Restored").font(.subheadline).foregroundStyle(palette.secondary)
        case .undoRefused:
            Text("Changed again since, so not undone").font(.subheadline).foregroundStyle(palette.secondary)
        }
    }
}

/// The proposed instructions, every line readable before Apply, with added and
/// removed lines marked in soft fills and named for VoiceOver.
struct AidenBotInstructionsDiffView: View {
    let lines: [AidenBotSettingsChangeEntry.DiffLine]

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(.footnote)
                        .foregroundStyle(line.kind == .same ? palette.secondary : palette.foreground)
                        .strikethrough(line.kind == .removed)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                        .background(fill(line.kind), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        .accessibilityLabel(accessibilityText(line))
                }
            }
            .padding(6)
        }
        .frame(maxHeight: 192)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel("Proposed instructions")
    }

    private func fill(_ kind: AidenBotSettingsChangeEntry.DiffLine.Kind) -> Color {
        switch kind {
        case .same: .clear
        case .added: palette.success.opacity(0.16)
        case .removed: palette.danger.opacity(0.14)
        }
    }

    private func accessibilityText(_ line: AidenBotSettingsChangeEntry.DiffLine) -> String {
        switch line.kind {
        case .same: line.text
        case .added: "Added: \(line.text)"
        case .removed: "Removed: \(line.text)"
        }
    }
}

/// "Add a skill?" with what would load. One whose preview is cut short can
/// only be put off here; the Mac shows it whole.
struct AidenBotSkillProposalCardView: View {
    let proposal: AidenBotSkillProposalEntry
    let canRespond: Bool
    let isBusy: Bool
    let onRespond: (AidenBotSkillProposalDecision) -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        switch proposal.status {
        case .added:
            AidenBotReceiptLine(symbol: "checkmark", text: "Added skill: \(proposal.name)", tint: palette.success)
        case .dismissed:
            AidenBotReceiptLine(symbol: "sparkles", text: "Not added: \(proposal.name)")
        case .pending:
            card
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(proposal.update ? "Update a skill?" : "Add a skill?", systemImage: "sparkles")
                .font(.headline)
                .foregroundStyle(palette.foreground)
                .accessibilityAddTraits(.isHeader)
            Text("\(proposal.name) · \(proposal.description)")
                .font(.subheadline)
                .foregroundStyle(palette.foreground)
                .fixedSize(horizontal: false, vertical: true)
            if let reason = proposal.reason {
                Text(reason).font(.footnote).foregroundStyle(palette.secondary)
            }
            AidenApprovalFoldingText(text: proposal.preview, font: .footnote.monospaced(), accessibilityLabel: "What would load")
                .padding(10)
                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            if proposal.previewTruncated {
                Label("This skill is too long to review here. Add it on your computer.", systemImage: "desktopcomputer")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if canRespond {
                HStack(spacing: 10) {
                    Button(AidenBotSessionCopy.notNow) { onRespond(.dismiss) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                    if proposal.canAddHere {
                        Button(proposal.update ? "Update" : "Add") { onRespond(.add) }
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                            .aidenSolidFillTint()
                    }
                }
                .disabled(isBusy)
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// A lesson from a routine's runs (Keep / Not now), or a Learned line with Undo.
struct AidenBotLessonCardView: View {
    let lesson: AidenBotLessonEntry
    let canRespond: Bool
    let isBusy: Bool
    let onRespond: (AidenBotLessonDecision) -> Void
    let onUndo: () -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        switch (lesson.kind, lesson.status) {
        case (.proposal, .pending):
            card
        case (.learned, .active):
            AidenBotReceiptLine(symbol: "lightbulb", text: "Learned: \(lesson.text)", action: canRespond ? "Undo" : nil, isBusy: isBusy, perform: onUndo)
        case (.learned, _):
            AidenBotReceiptLine(symbol: "lightbulb", text: "Learned: \(lesson.text) (undone)")
        case (.proposal, .active):
            AidenBotReceiptLine(symbol: "checkmark", text: "Added lesson: \(lesson.text)", tint: palette.success)
        case (.proposal, _):
            AidenBotReceiptLine(symbol: "lightbulb", text: "Not added: \(lesson.text)")
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(lesson.routineName.map { "I learned something about \($0)" } ?? "I learned something", systemImage: "lightbulb")
                .font(.headline)
                .foregroundStyle(palette.foreground)
                .accessibilityAddTraits(.isHeader)
            Text(lesson.text)
                .font(.subheadline)
                .foregroundStyle(palette.foreground)
                .fixedSize(horizontal: false, vertical: true)
            if let runs = lesson.runs, runs > 0 {
                Text("Based on \(runs) recent run\(runs == 1 ? "" : "s")")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
            if canRespond {
                HStack(spacing: 10) {
                    Button(AidenBotSessionCopy.notNow) { onRespond(.dismiss) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                    Button("Add") { onRespond(.keep) }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
                }
                .disabled(isBusy)
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// "Tidied memory · Undo", and "(undone)" once undone.
struct AidenBotMemoryTidyLine: View {
    let tidy: AidenBotMemoryTidyEntry
    let canUndo: Bool
    let onUndo: () -> Void

    var body: some View {
        AidenBotReceiptLine(
            symbol: "memorychip",
            text: tidy.changeId == nil ? "Tidied memory (undone)" : "Tidied memory",
            action: tidy.changeId != nil && canUndo ? "Undo" : nil,
            perform: onUndo
        )
    }
}

/// A quiet one-line receipt with an optional trailing action.
struct AidenBotReceiptLine: View {
    let symbol: String
    let text: String
    var tint: Color? = nil
    var action: String? = nil
    var isBusy = false
    var perform: () -> Void = {}

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tint ?? palette.secondary)
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let action {
                Button(action, action: perform)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .frame(minHeight: 44)
                    .disabled(isBusy)
                    .accessibilityLabel("\(action): \(text)")
            }
        }
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
    }
}
