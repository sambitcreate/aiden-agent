import SwiftUI

/// Shared with the Bot session chat (`AidenBotSessionChatView`). Matches the
/// desktop card: an icon tile, the action as a question, the exact request in a
/// code block, and two equal buttons with the remembered scopes behind Allow's
/// chevron. A `schedule_task` approval with a valid revision 39 `schedule` card
/// shows the structured schedule in place of the request.
struct AidenApprovalCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.locale) private var locale
    @Environment(\.calendar) private var calendar
    @Environment(\.timeZone) private var timeZone

    let summary: String
    var toolName: String = ""
    let kind: AidenApprovalKind
    let canRespond: Bool
    let hasRequiredWriteCapability: Bool
    let canAllow: Bool
    let scopes: [AidenApprovalScope]
    /// Contract revision 39: display-only. Nil, or any tool but `schedule_task`,
    /// keeps the summary card.
    var schedule: AidenApprovalSchedule? = nil
    let onDeny: () -> Void
    let onAllow: (AidenApprovalScope) -> Void

    private var broaderScopes: [AidenApprovalScope] { scopes.filter { $0 != .once } }

    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
    private let wellShape = RoundedRectangle(cornerRadius: 14, style: .continuous)

    private var request: String {
        kind == .scheduledTask ? summary : AidenApprovalPresentation.requestedAction(toolName: toolName, summary: summary)
    }

    /// The next run reads in the phone's own zone, locale and clock style.
    private var scheduleCard: AidenScheduleCardPresentation? {
        var calendar = calendar
        calendar.timeZone = timeZone
        return AidenApprovalSchedule.card(schedule, toolName: toolName).map {
            AidenScheduleCardPresentation($0, now: Date(), calendar: calendar, locale: locale)
        }
    }

    private var limit: AidenApprovalLimit? {
        AidenApprovalPresentation.limit(
            kind: kind,
            canRespond: canRespond,
            hasRequiredWriteCapability: hasRequiredWriteCapability,
            canAllow: canAllow
        )
    }

    var body: some View {
        let card = scheduleCard
        VStack(spacing: 0) {
            Image(systemName: card == nil ? AidenApprovalPresentation.symbol(toolName: toolName, kind: kind) : "calendar.badge.clock")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(palette.onFillAccent)
                .frame(width: 44, height: 44)
                .background(palette.fillAccent, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .accessibilityHidden(true)

            Text(card?.title ?? AidenApprovalPresentation.headline(toolName: toolName, kind: kind, summary: summary))
                .font(.headline)
                .foregroundStyle(palette.foreground)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
                .accessibilityAddTraits(.isHeader)

            if let card {
                AidenScheduleApprovalDetails(card: card)
                    .padding(.top, 14)
            } else {
                AidenApprovalFoldingText(
                    text: request,
                    font: .subheadline.monospaced(),
                    accessibilityLabel: kind == .scheduledTask ? "Scheduled task proposal" : "Requested action"
                )
                .padding(14)
                .background(palette.canvas, in: wellShape)
                .padding(.top, 14)
            }

            Group {
                if let limit {
                    Label(limit.text, systemImage: limit.symbol)
                } else if card != nil {
                    Text(AidenScheduleCardPresentation.footnote)
                } else {
                    Text(AidenApprovalPresentation.detail(for: kind))
                }
            }
            .font(.footnote)
            .foregroundStyle(palette.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)

            if canRespond {
                HStack(spacing: 10) {
                    Button(action: onDeny) {
                        Text(AidenApprovalPresentation.denyTitle(for: kind))
                            .font(.body.weight(.semibold))
                            .foregroundStyle(palette.foreground)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .contentShape(Capsule())
                            .aidenApprovalActionGlass()
                    }
                    .buttonStyle(.plain)

                    if canAllow {
                        allowButton
                    }
                }
                .padding(.top, 16)
            }
        }
        .padding(16)
        // Shadow only the surface: on the whole card it also blurs every glyph inside.
        .background {
            shape
                .fill(palette.raised)
                .shadow(color: palette.foreground.opacity(0.08), radius: 12, y: 4)
        }
        .accessibilityElement(children: .contain)
    }

    private var allowLabel: some View {
        Text(AidenApprovalPresentation.allowTitle(for: kind))
            .font(.body.weight(.semibold))
            .foregroundStyle(palette.onFillAccent)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
    }

    @ViewBuilder
    private var allowButton: some View {
        if broaderScopes.isEmpty {
            Button { onAllow(.once) } label: {
                allowLabel
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .contentShape(Capsule())
                    .aidenApprovalActionGlass(tint: palette.fillAccent)
            }
            .buttonStyle(.plain)
        } else {
            HStack(spacing: 0) {
                Button { onAllow(.once) } label: {
                    allowLabel
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
                    ForEach(broaderScopes, id: \.self) { scope in
                        Button { onAllow(scope) } label: {
                            Text(AidenApprovalPresentation.scopeTitle(scope))
                            if let detail = AidenApprovalPresentation.scopeDetail(scope, toolName: toolName) {
                                Text(detail)
                            }
                        }
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
                .accessibilityHint("Remember this approval for this chat or always")
            }
            .aidenApprovalActionGlass(tint: palette.fillAccent)
        }
    }
}

/// A request, instructions or script on an approval card. Past six lines it
/// folds behind Show all; expanded, it scrolls in a bounded box (the Bot chat
/// keeps the card in its footer) with a Scroll for more cue while text is hidden.
private struct AidenApprovalFoldingText: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var isExpanded = false
    @State private var hasMoreBelow = false

    let text: String
    let font: Font
    let accessibilityLabel: String

    /// Lines the text shows before Show all.
    private let collapsedLines = 6
    /// About twelve lines: the most expanded text takes before it scrolls.
    private let expandedMaxHeight: CGFloat = 240

    private var isLong: Bool {
        text.count > 320 || text.split(whereSeparator: \.isNewline).count > collapsedLines
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if isExpanded {
                ViewThatFits(in: .vertical) {
                    textView
                    ScrollView { textView }
                        .scrollIndicators(.visible)
                        .scrollIndicatorsFlash(onAppear: true)
                        // Only overflowing text gets here, and it opens at the top.
                        .onAppear { hasMoreBelow = true }
                        .onDisappear { hasMoreBelow = false }
                        .onScrollGeometryChange(for: Bool.self) { geometry in
                            geometry.visibleRect.maxY < geometry.contentSize.height - 1
                        } action: { _, more in
                            hasMoreBelow = more
                        }
                }
                .frame(maxHeight: expandedMaxHeight, alignment: .top)
            } else {
                textView
            }

            if isLong {
                HStack(spacing: 8) {
                    Button(isExpanded ? "Show less" : "Show all") {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                            isExpanded.toggle()
                        }
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .buttonStyle(.plain)

                    Spacer(minLength: 0)

                    // The end of long text must never sit hidden without a cue.
                    if isExpanded && hasMoreBelow {
                        Label("Scroll for more", systemImage: "arrow.down")
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                    }
                }
            }
        }
    }

    private var textView: some View {
        Text(text)
            .font(font)
            .foregroundStyle(palette.foreground)
            .lineLimit(isExpanded || !isLong ? nil : collapsedLines)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityValue(text)
    }
}

/// Contract revision 39: the body of a scheduled-task approval with a
/// `schedule` card. What runs and when, then where, with what access and model,
/// then the instructions or script and a note when it will not run on its own.
private struct AidenScheduleApprovalDetails: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let card: AidenScheduleCardPresentation

    private let wellShape = RoundedRectangle(cornerRadius: 14, style: .continuous)
    /// Row separators start under the label, past the icon column.
    private let rowInset: CGFloat = 14 + 22 + 10

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                hero
                    .padding(14)
                Divider()
                    .padding(.leading, 14)
                ForEach(Array(card.rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 {
                        Divider()
                            .padding(.leading, rowInset)
                    }
                    rowView(row)
                }
            }
            .background(palette.canvas, in: wellShape)

            if let content = card.content {
                VStack(alignment: .leading, spacing: 6) {
                    Text(card.contentTitle)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .accessibilityHidden(true)
                    AidenApprovalFoldingText(
                        text: content,
                        font: card.contentIsScript ? .subheadline.monospaced() : .subheadline,
                        accessibilityLabel: card.contentTitle
                    )
                    if card.isTruncated {
                        Label(AidenScheduleCardPresentation.truncatedNote, systemImage: "scissors")
                            .font(.footnote)
                            .foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.canvas, in: wellShape)
            }

            if let note = card.note {
                Label {
                    Text(note.text)
                        .foregroundStyle(note.isWarning ? palette.foreground : palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: note.symbol)
                        .foregroundStyle(note.isWarning ? palette.warning : palette.secondary)
                }
                .font(.footnote)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(note.isWarning ? palette.warning.opacity(0.14) : palette.canvas, in: wellShape)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(card.name)
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.foreground)
                .lineLimit(2)
            Text(card.cadence)
                .font(.body)
                .foregroundStyle(palette.foreground)
                .fixedSize(horizontal: false, vertical: true)
            if let nextRun = card.nextRun {
                Label("Next run \(nextRun)", systemImage: "clock")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .padding(.top, 3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func rowView(_ row: AidenScheduleCardPresentation.Row) -> some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: row.symbol)
                .font(.subheadline)
                .foregroundStyle(row.isWarning ? palette.warning : palette.secondary)
                .frame(width: 22)
            layout {
                Text(row.label)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                if !stacked {
                    Spacer(minLength: 0)
                }
                if row == card.access {
                    accessChip(row)
                } else {
                    Text(row.value)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)
                        .multilineTextAlignment(stacked ? .leading : .trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
    }

    /// Read-only sits on a neutral soft fill; Full access on a warning one. The
    /// text stays foreground: light-mode warning orange is too faint to read.
    private func accessChip(_ row: AidenScheduleCardPresentation.Row) -> some View {
        Text(row.value)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(palette.foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background((row.isWarning ? palette.warning : palette.secondary).opacity(0.14), in: Capsule())
    }
}

/// Interactive `ask_user_question` card. Each question offers its option list
/// plus a custom-answer field; a non-empty custom draft wins over selections.
/// Submit requires at least one addressed question; skipping the card resolves
/// the whole prompt as cancelled.
/// Shared with the Bot session chat (`AidenBotSessionChatView`).
struct AidenQuestionCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion

    /// The workspace chat whose run the card can stop.
    var model: AidenChatViewModel? = nil
    let prompt: AidenPendingQuestion
    /// Stop for a conversation with no chat model behind the card, while it has
    /// a run to stop.
    var stop: AidenDockStop? = nil
    let onSubmit: (AidenQuestionRespondRequest) -> Void

    @State private var draft: AidenQuestionComposerDraft

    init(
        model: AidenChatViewModel? = nil,
        prompt: AidenPendingQuestion,
        stop: AidenDockStop? = nil,
        onSubmit: @escaping (AidenQuestionRespondRequest) -> Void
    ) {
        self.model = model
        self.prompt = prompt
        self.stop = stop
        self.onSubmit = onSubmit
        // Callers key the card by prompt id, so a new prompt starts fresh.
        _draft = State(initialValue: AidenQuestionComposerDraft(questions: prompt.questions))
    }

    var stopButton: AidenChatStopButton? { model.map { AidenChatStopButton(model: $0) } }

    private var answers: [AidenQuestionAnswer] { draft.answers(for: prompt.questions) }

    private var hint: String {
        let recommended = !AidenQuestionAnswerDraft.recommendedSelections(for: prompt.questions).isEmpty
        switch (prompt.questions.count > 1, recommended) {
        case (true, true):
            return String(localized: "Recommended answers are already selected. Questions you leave blank are skipped.")
        case (true, false):
            return String(localized: "Answer what you can — unanswered questions are skipped.")
        case (false, true):
            return String(localized: "The recommended answer is already selected. Change it or type your own.")
        case (false, false):
            return String(localized: "Choose an option or type your own answer.")
        }
    }

    private func binding(for index: Int) -> Binding<String> {
        Binding(
            get: { draft.customAnswers[index] ?? "" },
            set: { draft.customAnswers[index] = $0.isEmpty ? nil : $0 }
        )
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "questionmark.bubble")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(palette.accent)
                        .frame(width: 32, height: 32)
                        .background(palette.accent.opacity(0.12), in: Circle())
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Aiden needs your input")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(palette.foreground)

                        Text(hint)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if let stopButton {
                        stopButton
                    } else if let stop {
                        // The card greys out while an answer is on its way. The run
                        // can still be stopped, so Stop answers only to itself.
                        AidenComposerStopButton(label: stop.label, isEnabled: stop.isEnabled, action: stop.action)
                            .environment(\.isEnabled, true)
                    }
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Array(prompt.questions.enumerated()), id: \.offset) { index, question in
                            Button { draft.move(to: index, questions: prompt.questions) } label: {
                                Text("\(index + 1). \(question.header)")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(index == draft.activeIndex ? palette.foreground : palette.secondary)
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 44)
                                    .background(index == draft.activeIndex ? palette.canvas : .clear,
                                                in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(index == draft.activeIndex ? .isSelected : [])
                            .accessibilityLabel("Question \(index + 1) of \(prompt.questions.count), \(question.header)")
                        }
                    }
                }
                ForEach(Array(prompt.questions.enumerated()).filter { $0.offset == draft.activeIndex }, id: \.offset) { index, question in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Text(question.header)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(palette.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(palette.canvas, in: Capsule())
                            if question.multiSelect {
                                Text("Select all that apply")
                                    .font(.caption2)
                                    .foregroundStyle(palette.secondary)
                            }
                        }
                        .accessibilityHidden(true)

                        Text(question.question)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(palette.foreground)
                            .fixedSize(horizontal: false, vertical: true)

                        ForEach(question.options, id: \.label) { option in
                            let selected = draft.selections[index]?.contains(option.label) == true
                            let label = AidenQuestionAnswerDraft.recommendedLabel(option.label)
                            Button {
                                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.15)) {
                                    draft.toggle(option.label, questions: prompt.questions)
                                }
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: question.multiSelect
                                          ? (selected ? "checkmark.square.fill" : "square")
                                          : (selected ? "checkmark.circle.fill" : "circle"))
                                        .font(.system(size: 16))
                                        .foregroundStyle(selected ? palette.accent : palette.secondary)
                                        .frame(width: 20)
                                        .accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(label.text)
                                                .font(.callout)
                                                .foregroundStyle(palette.foreground)
                                            if label.recommended {
                                                Text("Recommended")
                                                    .font(.caption2.weight(.semibold))
                                                    .foregroundStyle(palette.accent)
                                                    .padding(.horizontal, 6)
                                                    .padding(.vertical, 2)
                                                    .background(palette.accent.opacity(0.12), in: Capsule())
                                            }
                                        }
                                        Text(option.description)
                                            .font(.caption)
                                            .foregroundStyle(palette.secondary)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .background(
                                selected ? palette.accent.opacity(0.10) : palette.canvas,
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                            )
                            .accessibilityLabel(label.recommended
                                ? String(localized: "\(label.text), recommended")
                                : label.text)
                            .accessibilityValue(selected
                                ? String(localized: "Selected")
                                : String(localized: "Not selected"))
                            .accessibilityHint(option.description)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                        }

                        if draft.customOpen.contains(index) {
                            TextField(
                                String(localized: "Type your answer"),
                                text: binding(for: index),
                                axis: .vertical
                            )
                                .font(.callout)
                                .lineLimit(1...4)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .accessibilityLabel(String(localized: "Custom answer"))
                                .accessibilityHint(String(localized: "Overrides the selected options for this question"))
                        } else {
                            Button {
                                draft.customOpen.insert(index)
                            } label: {
                                Label("Type something.", systemImage: "text.cursor")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(palette.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 8)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint(String(localized: "Shows a field for a custom answer"))
                        }
                    }
                    .accessibilityElement(children: .contain)
                }

                if !prompt.canRespond {
                    Label("This paired device cannot respond to prompts.", systemImage: "lock.fill")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                } else {
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)

                        Button {
                            onSubmit(AidenQuestionRespondRequest(cancelled: true, answers: []))
                        } label: {
                            Text("Skip")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.foreground)
                                .padding(.horizontal, 13)
                                .frame(height: 34)
                                .aidenApprovalActionGlass()
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 5)
                        .accessibilityHint(String(localized: "Dismisses the prompt without answers"))

                        Button {
                            if draft.activeIndex < prompt.questions.count - 1 {
                                draft.move(to: draft.activeIndex + 1, questions: prompt.questions)
                            } else {
                                onSubmit(AidenQuestionRespondRequest(cancelled: false, answers: answers))
                            }
                        } label: {
                            Text(draft.activeIndex < prompt.questions.count - 1 ? "Next" : "Submit")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(palette.onFillAccent)
                                .padding(.horizontal, 13)
                                .frame(height: 34)
                                .aidenApprovalActionGlass(tint: palette.fillAccent)
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 5)
                        .disabled(draft.activeIndex == prompt.questions.count - 1 && answers.isEmpty)
                        .opacity(draft.activeIndex == prompt.questions.count - 1 && answers.isEmpty ? 0.5 : 1)
                        .accessibilityHint(draft.activeIndex < prompt.questions.count - 1
                            ? String(localized: "Moves to the next question and keeps your answers")
                            : answers.isEmpty
                            ? String(localized: "Select an option or type an answer first")
                            : String(localized: "Sends your answers to your Mac"))
                    }
                }
            }
            .padding(12)
        }
        .frame(maxHeight: 360)
        .aidenComposerGlass()
        .shadow(color: palette.foreground.opacity(0.08), radius: 8, y: 3)
        .accessibilityElement(children: .contain)
    }
}

private struct AidenApprovalActionGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let tint: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if !reduceTransparency {
            if let tint {
                content.glassEffect(.regular.tint(tint).interactive(), in: Capsule())
            } else {
                content.glassEffect(.regular.interactive(), in: Capsule())
            }
        } else if let tint {
            content.background(tint, in: Capsule())
        } else {
            content
                .background(palette.canvas, in: Capsule())
                .overlay(Capsule().stroke(palette.foreground.opacity(0.14), lineWidth: 0.5))
        }
    }
}

private extension View {
    func aidenApprovalActionGlass(tint: Color? = nil) -> some View {
        modifier(AidenApprovalActionGlassModifier(tint: tint))
    }
}

struct AidenNativeAppControlPanel: View {
    @Environment(\.aidenPalette) private var palette
    let panel: AidenAppControlPanel
    let available: Bool
    var cache: AidenAppControlCache? = nil
    let load: ((AidenAppControlPanel) async throws -> AidenAppControlSnapshot)?
    let apply: ((AidenAppControlPanel, AidenAppControlOperation) async throws -> AidenAppControlReceipt)?
    @State private var localSnapshot: AidenAppControlSnapshot?
    @State private var pending = false
    @State private var status = ""
    @State private var confirmation: AidenAppControlOperation?
    @State private var retryOperation: AidenAppControlOperation?
    private var snapshot: AidenAppControlSnapshot? { if let cache { return cache.snapshots[panel.id] }; return localSnapshot }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(snapshot?.title ?? "Aiden settings").font(.headline)
            Text("Paired host · These controls change the serving app, not this phone.").font(.caption).foregroundStyle(palette.secondary)
            if available, let snapshot {
                ForEach(snapshot.rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        if let options = row.options {
                            Picker(row.label, selection: Binding(get: { row.value.label }, set: { propose(row, .text($0)) })) {
                                ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
                            }.disabled(pending || row.disabledReason != nil || snapshot.policy == "disabled")
                        } else if case .boolean(let flag) = row.value {
                            Toggle(row.label, isOn: Binding(get: { flag }, set: { propose(row, .boolean($0)) }))
                                .disabled(pending || row.disabledReason != nil || snapshot.policy == "disabled")
                        }
                        Text(row.description).font(.caption).foregroundStyle(palette.secondary)
                        Text(row.scope).font(.caption2).foregroundStyle(palette.secondary)
                        if let reason = row.disabledReason { Text(reason).font(.caption).foregroundStyle(palette.secondary) }
                    }
                }
            } else { Text(panel.fallback).font(.subheadline) }
            if !status.isEmpty { Text(status).font(.caption).accessibilityAddTraits(.updatesFrequently) }
            HStack {
                Button("Refresh") { Task { await refresh() } }.disabled(pending || !available)
                if retryOperation != nil { Button("Check change") { if let operation = retryOperation { Task { await commit(operation) } } }.disabled(pending || !available) }
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .task(id: available) { localSnapshot = nil; confirmation = nil; if available { await refresh() } else { cache?.remove(panel) } }
        .onDisappear { cache?.remove(panel) }
        .confirmationDialog("Change this preference on the paired host?", isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            Button("Apply change") { if let operation = confirmation { confirmation = nil; Task { await commit(operation) } } }
            Button("Cancel", role: .cancel) { confirmation = nil }
        } message: { Text(snapshot?.rows.first { $0.id == confirmation?.control }?.scope ?? "Paired host") }
    }
    private func propose(_ row: AidenAppControlRow, _ value: AidenAppControlValue) {
        guard !pending, row.disabledReason == nil, value != row.value else { return }
        confirmation = AidenAppControlOperation(control: row.id, value: value, expectedRevision: row.revision, operationId: UUID().uuidString)
    }
    @MainActor private func refresh() async {
        do { guard available, let load else { return }; let value = try await load(panel); if cache == nil { localSnapshot = value } }
        catch is CancellationError { return }
        catch { localSnapshot = nil; status = "Current settings are unavailable. Reconnect or enable paired chat controls on the desktop." }
    }
    @MainActor private func commit(_ operation: AidenAppControlOperation) async {
        guard !pending, available, let apply else { return }
        pending = true; retryOperation = operation
        defer { pending = false }
        do {
            let receipt = try await apply(panel, operation)
            if receipt.status == "outcome_unknown" { status = "The change could not be confirmed. Refresh its current value; checking the change will not repeat it." }
            else { retryOperation = nil; status = receipt.warning ?? (receipt.effective == "now" ? "Saved." : "Saved. Applies to subsequent agent work.") }
            await refresh()
        } catch { localSnapshot = nil; status = "The change could not be confirmed. Check the change after reconnecting." }
    }
}
