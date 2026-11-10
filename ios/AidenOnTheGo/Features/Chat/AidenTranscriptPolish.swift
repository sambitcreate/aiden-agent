import SwiftUI
import UIKit

/// Elapsed-time presentation for assistant turns. Durations come from the
/// Mac-owned generation timeline already carried by the Remote protocol, so a
/// settled "Worked for" row never guesses from phone-local clocks.
enum AidenTurnElapsed {
    /// Seconds a completed assistant turn took, or nil when the turn has no
    /// trustworthy completed timeline (running, failed, cancelled, legacy).
    static func completedSeconds(for message: AidenChatMessage) -> TimeInterval? {
        guard message.role == .assistant,
              let timeline = message.timeline,
              timeline.status == .completed,
              let finishedAt = timeline.finishedAt,
              finishedAt >= timeline.startedAt else { return nil }
        return (finishedAt - timeline.startedAt) / 1_000
    }

    static func workedForLabel(for message: AidenChatMessage) -> String? {
        completedSeconds(for: message).map { "Worked for \(format($0))" }
    }

    /// Start of the running turn: the live timeline's start when one has
    /// arrived, otherwise the newest user message that opened the turn.
    static func liveStart(
        timeline: AidenGenerationTimeline?,
        messages: [AidenChatMessage]
    ) -> Date? {
        if let timeline {
            return Date(timeIntervalSince1970: timeline.startedAt / 1_000)
        }
        return messages.last(where: { $0.role == .user })?.createdAt
    }

    static func workingLabel(since start: Date, now: Date) -> String {
        "Working for \(format(now.timeIntervalSince(start)))"
    }

    /// Compact `42s`, `1m 5s`, `2m`, `1h 3m` duration. Negative clock skew
    /// between the Mac and the phone clamps to zero.
    static func format(_ seconds: TimeInterval) -> String {
        let total = seconds.isFinite ? max(0, Int(seconds.rounded(.down))) : 0
        if total < 60 { return "\(total)s" }
        let hours = total / 3_600
        let minutes = (total % 3_600) / 60
        let remainder = total % 60
        if hours > 0 { return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m" }
        return remainder == 0 ? "\(minutes)m" : "\(minutes)m \(remainder)s"
    }
}

/// Per-message timestamp text: time only today, "Yesterday" plus time, then
/// month/day (and year when it differs) plus time.
enum AidenMessageTimestamp {
    static func label(
        for date: Date,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let time = formatter(template: "jmm", calendar: calendar, locale: locale).string(from: date)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday \(time)"
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return formatter(
            template: sameYear ? "MMMdjmm" : "yMMMdjmm",
            calendar: calendar,
            locale: locale
        ).string(from: date)
    }

    static func accessibilityLabel(for date: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        return "Sent \(formatter.string(from: date))"
    }

    private static func formatter(template: String, calendar: Calendar, locale: Locale) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }
}

/// Builds the composer draft for "Ask About This": the selection becomes a
/// Markdown blockquote appended after any existing draft, leaving the caret on
/// a fresh line for the question.
enum AidenSelectionQuote {
    static let maximumQuotedCharacters = 2_000

    static func draft(quoting selection: String, into draft: String) -> String? {
        let trimmed = selection.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let bounded = trimmed.count > maximumQuotedCharacters
            ? String(trimmed.prefix(maximumQuotedCharacters)) + "…"
            : trimmed
        let quote = bounded
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                let text = line.trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
                return text.isEmpty ? ">" : "> \(text)"
            }
            .joined(separator: "\n")
        var existing = draft
        while let last = existing.last, last.isWhitespace || last.isNewline { existing.removeLast() }
        return (existing.isEmpty ? "" : existing + "\n\n") + quote + "\n\n"
    }

    /// Plain text a person selects from: assistant Markdown is flattened so
    /// quoted selections carry prose rather than syntax.
    static func selectableText(for message: AidenChatMessage, visibleText: String) -> String {
        message.role == .assistant ? AidenMarkdownDocument.plainText(from: visibleText) : visibleText
    }
}

struct AidenSelectTextRequest: Identifiable {
    let id = UUID()
    let text: String
}

/// Which settled message shows its footer. Footers are hidden until a message
/// is tapped; a second tap on it, or a tap anywhere else in the transcript,
/// hides it again, and only one shows at a time. A message being read aloud
/// keeps its footer, so Stop stays in reach.
///
/// The transcript's own tap (`AidenTranscriptTap`, for the keyboard) also sees a
/// tap on a message, in either order. It asks after a short beat and does
/// nothing if a message, or a footer button, took the same tap.
struct AidenMessageFooterReveal: Equatable {
    /// How close a transcript tap and a message tap are to count as one.
    static let sameTap: TimeInterval = 0.35

    private(set) var shownID: String?
    private var messageTouchedAt = Date.distantPast

    func shows(_ messageID: String, readingAloud: Bool = false) -> Bool {
        readingAloud || shownID == messageID
    }

    /// A tap on a message: shows its footer, or hides it if it already shows.
    mutating func tapMessage(_ messageID: String, at now: Date = .now) {
        shownID = shownID == messageID ? nil : messageID
        messageTouchedAt = now
    }

    /// A tap on a shown footer's own button, which leaves the footer up.
    mutating func touchFooter(at now: Date = .now) {
        messageTouchedAt = now
    }

    /// A tap anywhere in the transcript. Hides the footer unless a message or
    /// footer took the same tap.
    mutating func tapTranscript(at now: Date = .now) {
        guard abs(now.timeIntervalSince(messageTouchedAt)) > Self.sameTap else { return }
        shownID = nil
    }
}

/// A tap on one message, which shows its footer. A UIKit recogniser like
/// `AidenTranscriptTap`, because on iOS 26 a SwiftUI tap on selectable text
/// never fires. It lets the touch through, so links, Copy buttons, text
/// selection and the long-press menu keep working, and it waits for the
/// transcript's scroll to fail, so a drag or a fling never counts as a tap.
struct AidenMessageTap: UIGestureRecognizerRepresentable {
    /// How far the finger may travel and still tap.
    static let slop: CGFloat = 10

    let onTap: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
        let recognizer = UITapGestureRecognizer()
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesEnded = false
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(_ recognizer: UITapGestureRecognizer, context: Context) {
        guard recognizer.state == .ended else { return }
        let end = recognizer.location(in: nil)
        if let start = context.coordinator.touchStart,
           hypot(end.x - start.x, end.y - start.y) > Self.slop {
            return
        }
        onTap()
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var touchStart: CGPoint?

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            touchStart = touch.location(in: nil)
            return true
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            otherGestureRecognizer is UIPanGestureRecognizer && otherGestureRecognizer.view is UIScrollView
        }
    }
}

/// What VoiceOver hears for a message's footer without tapping for it: the
/// time it was sent, and how long the turn worked.
enum AidenMessageFooterAccessibility {
    static func value(for message: AidenChatMessage) -> String {
        [
            AidenMessageTimestamp.accessibilityLabel(for: message.createdAt),
            AidenTurnElapsed.workedForLabel(for: message),
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
    }
}

/// Compact footer under a settled message: timestamp, the completed turn's
/// "Worked for" duration, copy, and (latest reply only) Read Aloud. Shown on
/// tap (`AidenMessageFooterReveal`).
struct AidenMessageFooter: View {
    /// The footer row's height, which the live reply's "Working for" row shares
    /// while the turn runs.
    static let minimumHeight: CGFloat = 32

    @Environment(\.aidenPalette) private var palette
    let message: AidenChatMessage
    let copyText: String?
    var readAloudAction: (() -> Void)?
    var readAloudActive = false
    /// A tap on the footer, its buttons included, so the transcript's own tap
    /// doesn't hide the footer under the finger. A UIKit recogniser like the
    /// transcript's, so both see the same touch and the buttons still get it.
    var onTouch: () -> Void = {}

    var body: some View {
        HStack(spacing: 10) {
            if message.role == .user { Spacer(minLength: 0) }
            Text(AidenMessageTimestamp.label(for: message.createdAt))
                .accessibilityLabel(AidenMessageTimestamp.accessibilityLabel(for: message.createdAt))
            if let workedFor = AidenTurnElapsed.workedForLabel(for: message) {
                Text(verbatim: "·").accessibilityHidden(true)
                Text(workedFor)
                    .monospacedDigit()
                    .accessibilityIdentifier("aiden.message.workedFor")
            }
            if let copyText {
                Button {
                    UIPasteboard.general.string = copyText
                } label: {
                    Image(systemName: "doc.on.doc")
                        .frame(minWidth: 32, minHeight: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(message.role == .user ? "Copy message" : "Copy response")
            }
            if let readAloudAction {
                Button(action: readAloudAction) {
                    Image(systemName: readAloudActive ? "stop.fill" : "speaker.wave.2")
                        .frame(minWidth: 32, minHeight: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(readAloudActive ? "Stop reading aloud" : "Read response aloud")
            }
            if message.role == .assistant { Spacer(minLength: 0) }
        }
        .font(.caption)
        .foregroundStyle(palette.secondary)
        .buttonStyle(.borderless)
        .frame(minHeight: Self.minimumHeight)
        .contentShape(Rectangle())
        .gesture(AidenTranscriptTap(onTap: onTouch))
    }
}

/// The VoiceOver actions on a settled message, in order. The footer's Copy and
/// Read Aloud are here too, so VoiceOver reaches them without the tap that
/// shows the footer.
enum AidenMessageAccessibilityAction: Hashable {
    case copy
    case selectText
    case askAbout
    case readAloud
    case stopReadingAloud

    static func actions(
        canCopy: Bool,
        canAskAbout: Bool,
        canReadAloud: Bool,
        readAloudActive: Bool
    ) -> [Self] {
        var actions: [Self] = []
        if canCopy {
            actions.append(.copy)
            actions.append(.selectText)
            if canAskAbout { actions.append(.askAbout) }
        }
        if canReadAloud { actions.append(readAloudActive ? .stopReadingAloud : .readAloud) }
        return actions
    }

    func title(role: AidenChatRole) -> String {
        switch self {
        case .copy: role == .user ? "Copy message" : "Copy response"
        case .selectText: "Select text"
        case .askAbout: "Ask about this"
        case .readAloud: "Read response aloud"
        case .stopReadingAloud: "Stop reading aloud"
        }
    }
}

/// Live "Working for Xs" row while a turn runs; ticks once per second.
struct AidenLiveElapsedLabel: View {
    @Environment(\.aidenPalette) private var palette
    let start: Date

    var body: some View {
        TimelineView(.periodic(from: start, by: 1)) { context in
            Text(AidenTurnElapsed.workingLabel(since: start, now: context.date))
                .monospacedDigit()
        }
        .font(.caption)
        .foregroundStyle(palette.secondary)
        .accessibilityIdentifier("aiden.live.workingFor")
    }
}

/// Sheet that exposes a message as native selectable text with an extra
/// "Ask About This" edit-menu action that quotes the selection.
struct AidenSelectTextSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    let text: String
    let onAskAbout: ((String) -> Void)?

    var body: some View {
        NavigationStack {
            AidenSelectableTextView(text: text) { selection in
                guard let onAskAbout else { return }
                onAskAbout(selection)
                dismiss()
            }
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Select Text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if let onAskAbout {
                    ToolbarItem(placement: .bottomBar) {
                        Button {
                            onAskAbout(text)
                            dismiss()
                        } label: {
                            Label("Ask About Whole Message", systemImage: "text.bubble")
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct AidenSelectableTextView: UIViewRepresentable {
    let text: String
    let onAskAbout: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onAskAbout: onAskAbout) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 24, right: 12)
        view.alwaysBounceVertical = true
        view.delegate = context.coordinator
        view.text = text
        view.accessibilityIdentifier = "aiden.selectText.body"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        context.coordinator.onAskAbout = onAskAbout
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var onAskAbout: (String) -> Void

        init(onAskAbout: @escaping (String) -> Void) {
            self.onAskAbout = onAskAbout
        }

        func textView(
            _ textView: UITextView,
            editMenuForTextIn range: NSRange,
            suggestedActions: [UIMenuElement]
        ) -> UIMenu? {
            guard range.length > 0,
                  let text = textView.text,
                  let swiftRange = Range(range, in: text) else { return nil }
            let selection = String(text[swiftRange])
            let ask = UIAction(
                title: "Ask About This",
                image: UIImage(systemName: "text.bubble")
            ) { [weak self] _ in
                self?.onAskAbout(selection)
            }
            return UIMenu(children: [ask] + suggestedActions)
        }
    }
}
