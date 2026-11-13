import SwiftUI

/// Contract revision 61 (`approval:cards`): the Mac's own approval card, drawn
/// in its order for stream, host-run and Bot approvals alike. The title, then
/// the arguments, the body and what it replaces, the rows and the notes; the
/// buttons follow with Deny first. Each button sends exactly the decision and
/// scope it carries. A card without an allow button says where to allow it
/// (`allowOnMac`) instead of offering one.
struct AidenTypedApprovalCard: View {
    @Environment(\.aidenPalette) private var palette
    @ScaledMetric(relativeTo: .headline) private var badgeGlyphSize: CGFloat = 20
    @ScaledMetric(relativeTo: .headline) private var badgeSize: CGFloat = 44

    let card: AidenApprovalCardModel
    /// False when this phone can't answer (no write access, or another device owns it).
    let canRespond: Bool
    /// The scopes the answer route takes for this approval. An allow button
    /// with any other scope is not shown, since it could not be sent.
    var sendableScopes: Set<AidenApprovalScope> = [.once]
    /// What to show instead of the buttons when `canRespond` is false.
    var readOnlyNote: String = "Answer this on your machine."
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
                textWell(body, label: "Request")
                    .padding(.top, 12)
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
                if let allowOnMac = card.allowOnMac {
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

    private var buttons: some View {
        let allows = card.allowButtons(sendable: sendableScopes)
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

/// The line a typed card leaves after a tap ("Allowed once"), shown before the
/// Mac confirms and taken back if it refuses.
struct AidenApprovalAnsweredLine: View {
    @Environment(\.aidenPalette) private var palette
    let text: String

    var body: some View {
        Label(text, systemImage: "checkmark.circle")
            .font(.footnote)
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("aiden.approval-answered")
    }
}
