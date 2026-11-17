import MarkdownUI
import SwiftUI
import UIKit

enum AidenMessageActionContent {
    static func copyText(
        for message: AidenChatMessage,
        presentationStyle: AidenChatPresentationStyle = .workspace
    ) -> String? {
        guard !message.text.isEmpty else { return nil }
        guard message.role == .assistant else { return message.text }
        let text = presentationStyle == .botMessages
            ? AidenBotReplyProjection.resolve(
                text: message.text,
                timeline: message.timeline,
                isActive: false
            ).finalText
            : message.text
        return text.isEmpty ? nil : text
    }
}

struct AidenMessageTextView: View {
    let role: AidenChatRole
    let content: String
    var isStreaming = false

    @ViewBuilder
    var body: some View {
        if role == .assistant {
            AidenMarkdownView(content: content, isStreaming: isStreaming)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(verbatim: content)
                .font(.body)
                .textSelection(.enabled)
        }
    }
}

enum AidenMarkdownFallbackReason: Equatable {
    case tooManyCharacters
    case tooManyLines
}

enum AidenMarkdownRenderingPolicy {
    static let maximumCharacterCount = 80_000
    static let maximumLineCount = 2_000

    static func fallbackReason(for content: String) -> AidenMarkdownFallbackReason? {
        if content.count > maximumCharacterCount { return .tooManyCharacters }

        var lineCount = 1
        var previousWasCarriageReturn = false
        for scalar in content.unicodeScalars {
            switch scalar.value {
            case 0x0A:
                if !previousWasCarriageReturn { lineCount += 1 }
                previousWasCarriageReturn = false
            case 0x0D:
                lineCount += 1
                previousWasCarriageReturn = true
            case 0x2028, 0x2029:
                lineCount += 1
                previousWasCarriageReturn = false
            default:
                previousWasCarriageReturn = false
            }
            if lineCount > maximumLineCount { return .tooManyLines }
        }
        return nil
    }
}

enum AidenMarkdownDocument {
    static func plainText(from content: String) -> String {
        MarkdownContent(content).renderPlainText()
    }
}

/// Renders a reply as one view per Markdown chunk: settled chunks reuse their
/// cached parse and skip re-rendering (`.equatable()`), and only the open tail
/// sees new text while a reply streams. Settled messages use the same layout,
/// so a finished reply keeps its exact position when it settles.
struct AidenMarkdownView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    let content: String
    /// While true, a chunk whose text was entirely off screen in the previous
    /// render fades in once. Text already on screen never fades (including a
    /// line that moves into its own chunk when its block seals), and nothing
    /// animates under Reduce Motion or Low Power Mode. The open tail is also
    /// drawn through `AidenStreamingMarkdownTail`, so half-received Markdown
    /// never flashes as raw syntax.
    var isStreaming = false
    @State private var renderedLength = AidenRenderedMarkdownLength()

    static let chunkFadeDuration: TimeInterval = 0.18

    var body: some View {
        Group {
            if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(verbatim: " ")
            } else if AidenMarkdownRenderingPolicy.fallbackReason(for: content) != nil {
                Text(verbatim: content)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                let chunks = AidenMarkdownContentCache.shared.chunks(for: content, streaming: isStreaming)
                let fading = isStreaming && !reduceMotion && !lowPowerMode
                    ? AidenMarkdownChunkReveal.newChunkIndices(
                        chunks,
                        previouslyRenderedUTF8Count: renderedLength.record(content)
                    )
                    : []
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(chunks, id: \.index) { chunk in
                        AidenMarkdownChunkView(chunk: chunk, fadesIn: fading.contains(chunk.index))
                            .equatable()
                    }
                }
                    .markdownTheme(.aidenChat(colorScheme: colorScheme))
                    .markdownImageProvider(AidenMarkdownNoNetworkImageProvider())
                    .markdownTextStyle {
                        ForegroundColor(.primary)
                        BackgroundColor(nil)
                    }
                    .markdownTextStyle(\.code) {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.88))
                        BackgroundColor(Color(.tertiarySystemGroupedBackground))
                    }
                    .markdownBlockStyle(\.paragraph) { configuration in
                        configuration.label
                            .fixedSize(horizontal: false, vertical: true)
                            .relativeLineSpacing(.em(0.18))
                            .markdownMargin(top: 0, bottom: AidenMarkdownChunkSpacing.paragraphBottom)
                    }
            }
        }
        .textSelection(.enabled)
    }
}

/// How much text the previous render of one markdown view showed. Read and
/// updated while the body is evaluated; it is not observed, so recording a
/// render never triggers another one.
private final class AidenRenderedMarkdownLength {
    private var utf8Count: Int?

    /// Returns the previous render's length (nil on the first render) and
    /// records `content` as the latest.
    func record(_ content: String) -> Int? {
        defer { utf8Count = content.utf8.count }
        return utf8Count
    }
}

/// One chunk of a rendered reply. Equal chunks skip their body, so a sealed
/// chunk is not re-laid out while the tail streams.
private struct AidenMarkdownChunkView: View, Equatable {
    let chunk: AidenMarkdownChunk
    @State private var isRevealed: Bool

    init(chunk: AidenMarkdownChunk, fadesIn: Bool) {
        self.chunk = chunk
        _isRevealed = State(initialValue: !fadesIn)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.chunk.leadingGap == rhs.chunk.leadingGap && lhs.chunk.text == rhs.chunk.text
    }

    var body: some View {
        Group {
            if let open = chunk.openCode {
                // Drawn here, not through Markdown, so the block keeps its identity (and
                // the copy button its state) as its text grows token by token.
                AidenCodeBlockView(
                    source: open.code,
                    language: AidenCodeBlockView.languageName(fromFenceInfo: open.info)
                )
            } else {
                MarkdownUI.Markdown(chunk.content)
            }
        }
            .padding(.top, chunk.leadingGap)
            .opacity(isRevealed ? 1 : 0)
            .onAppear {
                guard !isRevealed else { return }
                withAnimation(.easeOut(duration: AidenMarkdownView.chunkFadeDuration)) { isRevealed = true }
            }
    }
}

private struct AidenMarkdownNoNetworkImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        EmptyView()
    }
}

private extension MarkdownUI.Theme {
    /// The text size stays 16 here on purpose. MarkdownUI scales whatever size the
    /// theme gives it with the reader's text size (a `@ScaledMetric` relative to
    /// `.body`), so handing it an already scaled size would scale it twice.
    static func aidenChat(colorScheme: ColorScheme) -> MarkdownUI.Theme {
        MarkdownUI.Theme.gitHub
            .text {
                ForegroundColor(.primary)
                BackgroundColor(nil)
                FontSize(AidenMarkdownMetrics.baseBodySize)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(AidenMarkdownMetrics.codeScale))
                BackgroundColor(AidenMarkdownMetrics.codeBackground(for: colorScheme))
            }
            .codeBlock { configuration in
                AidenCodeBlockView(
                    source: configuration.content,
                    language: AidenCodeBlockView.languageName(fromFenceInfo: configuration.language)
                )
            }
    }
}

/// How big chat text is. Body text is 16 pt at the default text size and follows
/// the reader's text size from there, the way the system's body style does.
/// MarkdownUI scales its own text by itself, so `bodySize(for:)` is for what is
/// drawn outside it, such as the code block.
enum AidenMarkdownMetrics {
    static let baseBodySize: CGFloat = 16
    /// Code is drawn a little smaller than the text around it.
    static let codeScale: CGFloat = 0.85

    /// Looked up per render, so each text size is worked out once.
    private static let bodySizes: [DynamicTypeSize: CGFloat] = {
        let metrics = UIFontMetrics(forTextStyle: .body)
        return Dictionary(uniqueKeysWithValues: DynamicTypeSize.allCases.map { size in
            let traits = UITraitCollection(preferredContentSizeCategory: contentSizeCategory(for: size))
            return (size, metrics.scaledValue(for: baseBodySize, compatibleWith: traits))
        })
    }()

    static func bodySize(for size: DynamicTypeSize) -> CGFloat {
        bodySizes[size] ?? baseBodySize
    }

    static func codeBackground(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark
            ? Color(red: 0.08, green: 0.09, blue: 0.12)
            : Color(.tertiarySystemGroupedBackground)
    }

    private static func contentSizeCategory(for size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}

/// Copies a code block and shows that it did for a moment. The moment is one
/// timer, and it is cancelled when the block leaves the screen, so no timer
/// outlives its row.
@MainActor
@Observable
final class AidenCodeCopyController {
    /// How long "Copied" shows. Short enough to be gone by the time the reader
    /// looks again, long enough to read.
    static let confirmationDuration: Duration = .milliseconds(1500)
    static let announcement = "Copied code"

    private(set) var isConfirming = false

    @ObservationIgnored private let write: @MainActor (String) -> Void
    @ObservationIgnored private let announce: @MainActor (String) -> Void
    @ObservationIgnored private let sleep: @MainActor (Duration) async throws -> Void
    @ObservationIgnored private var timer: Task<Void, Never>?

    nonisolated init(
        write: @escaping @MainActor (String) -> Void = { UIPasteboard.general.string = $0 },
        announce: @escaping @MainActor (String) -> Void = { AccessibilityNotification.Announcement($0).post() },
        sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.write = write
        self.announce = announce
        self.sleep = sleep
    }

    var hasPendingConfirmation: Bool { timer != nil }

    /// Copies `source` as it is now. Copying again while "Copied" shows starts the
    /// moment over, and the earlier timer cannot end the new one early.
    func copy(_ source: String) {
        write(source)
        timer?.cancel()
        isConfirming = true
        announce(Self.announcement)
        let sleep = sleep
        timer = Task { [weak self] in
            do { try await sleep(Self.confirmationDuration) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.isConfirming = false
            self.timer = nil
        }
    }

    /// The block left the screen: end the moment and drop the timer.
    func cancel() {
        timer?.cancel()
        timer = nil
        isConfirming = false
    }

    func waitForConfirmationToEnd() async {
        await timer?.value
    }
}

/// A fenced or indented code block with a copy button. Long lines scroll
/// sideways, under a header that stays put. There is no syntax highlighting.
struct AidenCodeBlockView: View {
    let source: String
    let language: String?

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var copy: AidenCodeCopyController

    init(source: String, language: String?, copyController: AidenCodeCopyController = AidenCodeCopyController()) {
        self.source = source
        self.language = language
        _copy = State(initialValue: copyController)
    }

    static let cornerRadius: CGFloat = 12

    /// The language word of a fence's info string: "swift" from `swift title="a"`.
    /// Anything that is not a plain language name (`{.numberLines}`) is dropped.
    static func languageName(fromFenceInfo info: String?) -> String? {
        guard let word = info?.split(whereSeparator: \.isWhitespace).first else { return nil }
        guard word.allSatisfy({ $0.isLetter || $0.isNumber || "+#-_.".contains($0) }), word.first != "." else { return nil }
        return String(word)
    }

    private var buttonLabel: String {
        if copy.isConfirming { return AidenCodeCopyController.announcement }
        return language.map { "Copy \($0) code" } ?? "Copy code"
    }

    var body: some View {
        let codeSize = AidenMarkdownMetrics.bodySize(for: dynamicTypeSize) * AidenMarkdownMetrics.codeScale
        VStack(alignment: .leading, spacing: 0) {
            header
            ScrollView(.horizontal) {
                Text(verbatim: source)
                    .font(.system(size: codeSize, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineSpacing(codeSize * 0.225)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AidenMarkdownMetrics.codeBackground(for: colorScheme))
        .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
        .markdownMargin(top: 0, bottom: AidenMarkdownChunkSpacing.blockBottom)
        .onDisappear { copy.cancel() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            if let language {
                // `.secondary` reads under 4.5:1 on the code background.
                Text(verbatim: language)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .padding(.leading, 12)
            }
            Spacer(minLength: 8)
            Button {
                copy.copy(source)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: copy.isConfirming ? "checkmark" : "doc.on.doc")
                        .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
                    Text(copy.isConfirming ? "Copied" : "Copy")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(source.isEmpty)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: copy.isConfirming)
            .accessibilityLabel(buttonLabel)
        }
        .frame(minHeight: 44)
    }
}
