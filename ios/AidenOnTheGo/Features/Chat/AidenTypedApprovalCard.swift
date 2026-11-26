import SwiftUI

/// Contract revision 61 (`approval:cards`): the Mac's own approval card, drawn
/// in its order for stream, host-run and Bot approvals alike. The title, then
/// the arguments, the body and what it replaces, the rows and the notes; the
/// buttons follow with Deny first. Each button sends exactly the decision and
/// scope it carries. A card without an allow button says where to allow it
/// (`allowOnMac`) instead of offering one.
struct AidenTypedApprovalCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// Revision 69: a shell card with plain words opens on them; this flips to the command.
    @State private var showsCommand = false
    @ScaledMetric(relativeTo: .headline) private var badgeGlyphSize: CGFloat = 20
    @ScaledMetric(relativeTo: .headline) private var badgeSize: CGFloat = 44

    let card: AidenApprovalCardModel
    /// False when this phone can't answer (no write access, or another device owns it).
    let canRespond: Bool
    /// The scopes the answer route takes for this approval. An allow button
    /// with any other scope is not shown, since it could not be sent.
    var sendableScopes: Set<AidenApprovalScope> = [.once]
    /// What to show instead of the buttons when `canRespond` is false.
    var readOnlyNote: String = "Answer this on your computer."
    /// False when this phone may deny but not allow (a scheduled task without
    /// schedule write access): only Deny shows, with `limitNote` beneath it.
    var allowsHere: Bool = true
    /// Why the allow buttons are missing when `allowsHere` is false.
    var limitNote: String?
    /// False while an answer can't be sent (offline, already answering). Only
    /// the answer buttons dim: the flip to the command still works.
    var answersEnabled: Bool = true
    let onAnswer: (AidenApprovalCardButton) -> Void

    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
    private let wellShape = RoundedRectangle(cornerRadius: 14, style: .continuous)

    private var symbol: String {
        switch card.kind {
        case .mac:
            switch card.mac {
            case .shell: "terminal"
            case .files: "folder"
            case .computerUse: "cursorarrow.click.2"
            case nil: "desktopcomputer"
            }
        case .heldChange: "arrow.triangle.2.circlepath"
        case .batch: "list.bullet.rectangle"
        case .schedule: "calendar.badge.clock"
        case .explicit: "hand.raised"
        case .generic: "checkmark.shield"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: min(badgeGlyphSize, 30), weight: .semibold))
                    .foregroundStyle(palette.onFillAccent)
                    .frame(width: min(badgeSize, 64), height: min(badgeSize, 64))
                    .background(palette.fillAccent, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                    .accessibilityHidden(true)
                Text(card.title)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
            }

            if !card.arguments.isEmpty {
                pairs(card.arguments.map { ($0.key, $0.value) })
                    .padding(.top, 12)
            }

            if let body = card.body {
                if let explanation = card.explanation {
                    plainWordsWell(explanation: explanation, command: body)
                        .padding(.top, 12)
                } else {
                    textWell(body, label: "Request")
                        .padding(.top, 12)
                }
            }

            if let tags = card.tags, !tags.isEmpty {
                AidenApprovalCardTags(tags: tags)
                    .padding(.top, 10)
            }

            if let previous = card.previous {
                Text("Before")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .padding(.top, 12)
                textWell(previous, label: "Before")
                    .padding(.top, 6)
            }

            if let rows = card.rows, !rows.isEmpty {
                pairs(rows.map { ($0.label, $0.value) })
                    .padding(12)
                    .background(palette.canvas, in: wellShape)
                    .padding(.top, 12)
            }

            if let notes = card.notes, !notes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                        Text(note)
                    }
                }
                .font(.footnote)
                .foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
            }

            if canRespond {
                buttons.padding(.top, 16)
                    .disabled(!answersEnabled)
                if !allowsHere, let limitNote {
                    Label(limitNote, systemImage: "lock")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                        .accessibilityIdentifier("aiden.approval-limit")
                } else if let allowOnMac = card.allowOnMac {
                    Label(allowOnMac, systemImage: "desktopcomputer")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                }
            } else {
                Label(readOnlyNote, systemImage: "lock")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .padding(.top, 14)
            }
        }
        .padding(16)
        .background {
            shape
                .fill(palette.raised)
                .shadow(color: palette.foreground.opacity(0.08), radius: 12, y: 4)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("aiden.approval-card")
    }

    private func pairs(_ items: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.0)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                        .frame(minWidth: 56, alignment: .leading)
                    Text(item.1.isEmpty ? "—" : item.1)
                        .font(.footnote)
                        .foregroundStyle(palette.foreground)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func textWell(_ text: AidenApprovalCardText, label: String) -> some View {
        AidenApprovalFoldingText(
            text: text.text,
            font: text.format == .command ? .subheadline.monospaced() : .subheadline,
            accessibilityLabel: label
        )
        .padding(14)
        .background(palette.canvas, in: wellShape)
    }

    /// Revision 69: what the command will do, in the model's words, with a
    /// flip to the exact command and back. Flipping never answers the card.
    private func plainWordsWell(explanation: String, command: AidenApprovalCardText) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if showsCommand {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Command")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                            .accessibilityAddTraits(.isHeader)
                        AidenApprovalFoldingText(
                            text: command.text,
                            font: .subheadline.monospaced(),
                            accessibilityLabel: "Command"
                        )
                    }
                    .transition(flipTransition)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("What it will do")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                            .accessibilityAddTraits(.isHeader)
                        Text(explanation)
                            .font(.subheadline)
                            .foregroundStyle(palette.foreground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .transition(flipTransition)
                }
            }
            .padding(.trailing, 40)
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                if reduceMotion {
                    showsCommand.toggle()
                } else {
                    withAnimation(.easeOut(duration: 0.2)) { showsCommand.toggle() }
                }
            } label: {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, -12)
            .padding(.trailing, -12)
            .accessibilityLabel(showsCommand ? "Show what it will do" : "Show the command")
            .accessibilityIdentifier("aiden.approval-flip")
        }
        .padding(14)
        .background(palette.canvas, in: wellShape)
    }

    private var flipTransition: AnyTransition {
        reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.98, anchor: .top))
    }

    private var buttons: some View {
        let allows = allowsHere ? card.allowButtons(sendable: sendableScopes) : []
        return HStack(spacing: 10) {
            Button { onAnswer(card.denyButton) } label: {
                Text(card.denyButton.label)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Capsule())
                    .aidenApprovalActionGlass()
            }
            .buttonStyle(.plain)

            if let primary = allows.first {
                allowControl(primary: primary, others: Array(allows.dropFirst()))
            }
        }
    }

    private func allowLabel(_ button: AidenApprovalCardButton) -> some View {
        Text(button.label)
            .font(.body.weight(.semibold))
            .foregroundStyle(palette.onFillAccent)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    @ViewBuilder
    private func allowControl(primary: AidenApprovalCardButton, others: [AidenApprovalCardButton]) -> some View {
        if others.isEmpty {
            Button { onAnswer(primary) } label: {
                allowLabel(primary)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Capsule())
                    .aidenApprovalActionGlass(tint: palette.fillAccent)
            }
            .buttonStyle(.plain)
        } else {
            HStack(spacing: 0) {
                Button { onAnswer(primary) } label: {
                    allowLabel(primary)
                        .padding(.leading, 8)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Rectangle()
                    .fill(palette.onFillAccent.opacity(0.25))
                    .frame(width: 1, height: 22)
                    .accessibilityHidden(true)

                Menu {
                    ForEach(others, id: \.self) { button in
                        Button(button.label) { onAnswer(button) }
                    }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(palette.onFillAccent)
                        .frame(width: 44, height: 50)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("More ways to allow")
            }
            .aidenApprovalActionGlass(tint: palette.fillAccent)
        }
    }
}

/// Revision 69: Aiden's own tags for a shell command, read by the Mac from the
/// command text. A risky step sits in a soft red fill, a calm one in grey.
struct AidenApprovalCardTags: View {
    @Environment(\.aidenPalette) private var palette
    let tags: [AidenApprovalCardTag]

    var body: some View {
        AidenApprovalTagFlow(spacing: 6) {
            ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in
                let risk = tag.tone == .risk
                HStack(spacing: 4) {
                    if risk {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.caption2.weight(.semibold))
                            .accessibilityHidden(true)
                    }
                    Text(tag.label)
                        .font(.caption)
                }
                .foregroundStyle(risk ? palette.dangerText : palette.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(risk ? palette.danger.opacity(0.14) : palette.canvas, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel(risk ? "Heads-up: \(tag.label)" : tag.label)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("What Aiden sees in this command")
        .accessibilityIdentifier("aiden.approval-tags")
    }
}

/// Lays tags out in rows, wrapping to the next row when one is full.
private struct AidenApprovalTagFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row { var indices: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = rows[rows.count - 1].indices.isEmpty ? size.width : rows[rows.count - 1].width + spacing + size.width
            if needed > width, !rows[rows.count - 1].indices.isEmpty {
                rows.append(Row())
            }
            var row = rows[rows.count - 1]
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows.filter { !$0.indices.isEmpty }
    }
}

/// The line a typed card leaves after a tap ("Allowed once", "Denied"), shown
/// before the Mac confirms and taken back if the answer doesn't land.
struct AidenApprovalAnsweredLine: View {
    @Environment(\.aidenPalette) private var palette
    let button: AidenApprovalCardButton

    var body: some View {
        Label(button.answered, systemImage: button.decision == .deny ? "xmark.circle" : "checkmark.circle")
            .font(.footnote)
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("aiden.approval-answered")
    }
}
