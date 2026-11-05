import MarkdownUI
import SwiftUI

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
                    .markdownCodeSyntaxHighlighter(.plainText)
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
        MarkdownUI.Markdown(chunk.content)
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
    static func aidenChat(colorScheme: ColorScheme) -> MarkdownUI.Theme {
        MarkdownUI.Theme.gitHub
            .text {
                ForegroundColor(.primary)
                BackgroundColor(nil)
                FontSize(16)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.85))
                BackgroundColor(
                    colorScheme == .dark
                        ? Color(red: 0.08, green: 0.09, blue: 0.12)
                        : Color(.tertiarySystemGroupedBackground)
                )
            }
    }
}
