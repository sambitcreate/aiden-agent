import AVFoundation
import AVKit
import SwiftUI

struct AidenChronologicalTranscript: View {
    @Environment(\.aidenPalette) private var palette
    let rows: [AidenChronologicalRow]
    let active: Bool
    /// Draws a committed message's visual rows; the live stream has none.
    var visualContent: ((AidenChatVisual) -> AnyView)? = nil
    /// Present while the Mac serves browser recordings (revision 46).
    var loadRecording: ((AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad)? = nil
    /// Draws a committed message's images beneath their step; the live stream has none.
    var imageContent: (([AidenMessageAttachment]) -> AnyView)? = nil
    /// Draws a live `generate_image` placeholder beneath its step.
    var imageSlotContent: ((String) -> AnyView)? = nil

    /// Tells one run's groups from another's in the expansion state: the run's
    /// generation ID, which is the same for the live reply and the settled one.
    let groupScope: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(rows.groupedForDisplay(scope: groupScope, active: active)) { block in
                switch block {
                case .row(let row):
                    rowView(row)
                case .toolGroup(let group):
                    AidenToolStepGroupView(group: group, active: active)
                        .equatable()
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: AidenChronologicalRow) -> some View {
        switch row.kind {
        case .text:
            AidenMessageTextView(role: .assistant, content: row.text, isStreaming: active)
                .foregroundStyle(palette.foreground)
        case .reasoning:
            if let step = row.steps.first {
                let label = step.finishedAt == nil ? "Thinking" : "Thought \(AidenAgentActivityPresentation.duration(step.durationMs))"
                if row.text.isEmpty {
                    AidenActivityPhaseCard(label: label, active: active && step.finishedAt == nil)
                } else {
                    AidenReasoningCard(text: row.text, label: label, active: active && step.finishedAt == nil)
                }
            }
        case .tool:
            AidenToolStepBox(steps: row.steps, active: active)
        case .questionnaire:
            if let recap = row.steps.first?.questionnaire {
                AidenQuestionnaireRecapView(recap: recap)
            }
        case .extraction:
            if let recap = row.steps.first?.extraction {
                AidenWebExtractRecapView(recap: recap)
            }
        case .recording:
            if let recording = row.steps.first?.recording {
                AidenBrowserRecordingCardView(recording: recording, load: loadRecording)
            }
        case .visual(let visual):
            visualContent?(visual)
        case .images(let images):
            imageContent?(images)
        case .imageSlot(let call):
            imageSlotContent?(call)
        }
    }
}

/// Which groups the reader has opened or closed. It lives above the rows, so a
/// lazy stack rebuilding a row, or the live reply handing over to the settled
/// one, doesn't forget a choice. It isn't observed: a group that is toggled
/// redraws itself and no other group does.
///
/// A group nobody has chosen for shows open only when it has a failure. A
/// choice always wins, so a failed group the reader closed stays closed through
/// every later update, and one the reader opened stays open.
@MainActor
final class AidenToolStepGroupExpansion {
    private var opened = Set<String>()
    private var closed = Set<String>()
    /// Runs just before a group opens or closes, so the screen can stop
    /// following the end: the reader tapped a line, and the line shouldn't
    /// leave their screen when the group changes height.
    private let onToggle: (() -> Void)?

    init(onToggle: (() -> Void)? = nil) {
        self.onToggle = onToggle
    }

    func isExpanded(_ group: AidenToolStepGroup) -> Bool {
        if opened.contains(group.id) { return true }
        if closed.contains(group.id) { return false }
        return group.hasFailure
    }

    /// The reader's tap.
    func toggle(_ group: AidenToolStepGroup) {
        let expanded = !isExpanded(group)
        onToggle?()
        setExpanded(expanded, for: group.id)
    }

    func setExpanded(_ expanded: Bool, for id: String) {
        if expanded {
            opened.insert(id)
            closed.remove(id)
        } else {
            closed.insert(id)
            opened.remove(id)
        }
    }
}

private struct AidenToolGroupExpansionKey: EnvironmentKey {
    static let defaultValue: AidenToolStepGroupExpansion? = nil
}

extension EnvironmentValues {
    var aidenToolGroupExpansion: AidenToolStepGroupExpansion? {
        get { self[AidenToolGroupExpansionKey.self] }
        set { self[AidenToolGroupExpansionKey.self] = newValue }
    }
}

/// The step lines of one tool row, or of an open group.
private struct AidenToolStepBox: View {
    @Environment(\.aidenPalette) private var palette
    let steps: [AidenAgentStep]
    let active: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(steps) { step in
                AidenActivityStepLine(step: step, shimmer: active && step.isActive)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// A run of tool steps as one line: what it did, a chevron, and the latest step
/// while it runs. Open, it lists the steps. No glass: it's content, not a control layer.
struct AidenToolStepGroupView: View, Equatable {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenToolGroupExpansion) private var sharedExpansion
    /// Used only where nothing above holds the state, such as a bare preview.
    @State private var ownExpansion = AidenToolStepGroupExpansion()
    /// Bumped on a toggle, so this group redraws and no other does.
    @State private var toggles = 0
    let group: AidenToolStepGroup
    let active: Bool

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.group == rhs.group && lhs.active == rhs.active
    }

    private var expansion: AidenToolStepGroupExpansion { sharedExpansion ?? ownExpansion }

    var body: some View {
        let _ = toggles
        let isExpanded = expansion.isExpanded(group)
        VStack(alignment: .leading, spacing: 4) {
            header(isExpanded: isExpanded)
            if isExpanded {
                AidenToolStepBox(steps: group.steps.flatMap(\.steps), active: active)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func header(isExpanded: Bool) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                expansion.toggle(group)
                toggles += 1
            }
        } label: {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.summary)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .aidenActivityShimmer(active && group.isRunning)
                    if let line = group.runningLine {
                        Text(line)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if group.failureCount > 0 {
                    Text("\(group.failureCount) failed")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.danger)
                }
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.accessibilityLabel(isExpanded: isExpanded))
        .accessibilityHint(isExpanded ? "Hides the steps" : "Shows the steps")
    }
}

/// A settled `ask_user_question` card in the transcript: each question with
/// the owner's choice beneath it, right-aligned like the owner's own messages.
struct AidenQuestionnaireRecapView: View {
    @Environment(\.aidenPalette) private var palette
    let recap: AidenQuestionnaireRecap

    var body: some View {
        AidenTrailingFractionLayout(fraction: 0.8) {
            VStack(alignment: .trailing, spacing: 8) {
                ForEach(Array(recap.items.enumerated()), id: \.offset) { _, item in
                    card(for: item)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Your answers")
    }

    private func card(for item: AidenQuestionnaireRecap.Item) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: item.question)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
            answer(for: item)
        }
        .foregroundStyle(palette.foreground)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(palette.raised, in: shape)
        .overlay(shape.stroke(palette.foreground.opacity(0.08), lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func answer(for item: AidenQuestionnaireRecap.Item) -> some View {
        switch item.answer(for: recap.outcome) {
        case .chosen(let text):
            Text(verbatim: text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.foreground)
        case .custom(let text):
            Text(verbatim: text)
                .font(.subheadline)
                .foregroundStyle(palette.foreground)
        case .unanswered(let label):
            // Tertiary level of the card's foreground, so it follows the theme.
            Text(verbatim: label)
                .font(.subheadline)
                .foregroundStyle(.tertiary)
        }
    }
}

/// The values a `web_fetch` extract call read, under its activity line: each
/// name and value with the page line it came from, so the owner can check a
/// number against its source without opening the page. Guesses and values
/// the page does not have are labelled as such, never shown as read.
struct AidenWebExtractRecapView: View {
    @Environment(\.aidenPalette) private var palette
    let recap: AidenWebExtractRecap

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text(verbatim: recap.host)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } icon: {
                Image(systemName: "globe")
                    .imageScale(.small)
            }
            .font(.footnote)
            .foregroundStyle(palette.secondary)

            if let failure = recap.error {
                Text(verbatim: "Couldn\u{2019}t read the values: \(failure.message). The page was read instead.")
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            } else {
                ForEach(recap.fields) { field in
                    fieldRow(field)
                }
            }

            if recap.cut {
                Text("Only the first part of the page was read.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "Values read from \(recap.host)"))
    }

    private func fieldRow(_ field: AidenWebExtractRecap.Field) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: field.label)
                .font(.footnote)
                .foregroundStyle(palette.secondary)
            value(for: field)
            source(for: field)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func value(for field: AidenWebExtractRecap.Field) -> some View {
        switch field.status {
        case .absent:
            Text("Not on the page")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
        case .extracted:
            Text(verbatim: field.value ?? "")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(palette.foreground)
        case .uncertain:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let value = field.value {
                    Text(verbatim: value)
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }
                Text("Guess")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.warning)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(palette.warning.opacity(0.12), in: Capsule())
            }
        }
    }

    @ViewBuilder
    private func source(for field: AidenWebExtractRecap.Field) -> some View {
        if field.status != .absent {
            if let line = field.sourceLine {
                Text(verbatim: "\u{201C}\(line)\u{201D}")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else if field.notFound == true {
                Text("Not found on the page")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

/// The video the agent recorded of a browser tab, under its activity line
/// (contract revision 46). The bytes stay on the Mac until Play is pressed;
/// a WebM fallback, or a Mac that does not serve recordings, is watched on
/// the Mac instead.
struct AidenBrowserRecordingCardView: View {
    @Environment(\.aidenPalette) private var palette
    let recording: AidenBrowserRecordingRecap
    /// Present while the Mac announces `chat-browser-recordings-v1`.
    var load: ((AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad)? = nil
    @State private var isLoading = false
    @State private var failure: AidenBrowserRecordingLoad?
    @State private var playback: AidenBrowserRecordingPlayback?
    /// The saved copy the player is showing, removed when it closes.
    @State private var lastPlayedFile: URL?

    private var playsHere: Bool { load != nil && recording.playsOnPhone }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "video")
                    .imageScale(.small)
                    .foregroundStyle(palette.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Browser recording")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(palette.foreground)
                    Text(verbatim: "\(recording.durationLabel) \u{00B7} \(recording.sizeLabel)")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: recording.accessibilityLabel))
                Spacer(minLength: 8)
                if playsHere {
                    playButton
                }
            }
            if !playsHere {
                Text(verbatim: AidenBrowserRecordingLoad.watchOnMacMessage)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            } else if let failure {
                Text(verbatim: failure == .missing
                    ? AidenBrowserRecordingLoad.missingMessage
                    : AidenBrowserRecordingLoad.failedMessage)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: recording.accessibilityLabel))
        .fullScreenCover(item: $playback, onDismiss: {
            // The copy on the phone exists only while it plays.
            if let file = lastPlayedFile { AidenBrowserRecordingFile.remove(file) }
            lastPlayedFile = nil
        }) { item in
            AidenBrowserRecordingPlayerView(url: item.url)
        }
    }

    private var playButton: some View {
        Button {
            Task { await play() }
        } label: {
            HStack(spacing: 6) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "play.fill")
                        .imageScale(.small)
                }
                Text(isLoading ? "Loading\u{2026}" : "Play")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.accent)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .accessibilityLabel(Text(verbatim: "Play browser recording, \(recording.durationLabel)"))
    }

    @MainActor
    private func play() async {
        guard let load, !isLoading else { return }
        isLoading = true
        failure = nil
        let result = await load(recording)
        isLoading = false
        switch result {
        case .ready(let url):
            lastPlayedFile = url
            playback = AidenBrowserRecordingPlayback(url: url)
        case .missing, .failed:
            failure = result
        }
    }
}

/// One presentation of the player for a saved recording file.
struct AidenBrowserRecordingPlayback: Identifiable, Equatable {
    let url: URL
    var id: String { url.path }
}

/// The recording full screen with the system playback controls.
private struct AidenBrowserRecordingPlayerView: View {
    @Environment(\.dismiss) private var dismiss
    let url: URL
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let player {
                    VideoPlayer(player: player)
                        .accessibilityLabel("Browser recording")
                }
            }
            .navigationTitle("Browser recording")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            guard player == nil else { return }
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
        }
        .onDisappear {
            player?.pause()
            player = nil
        }
    }
}

/// Places its single child against the trailing edge and caps it at a
/// fraction of the offered width, while letting it shrink to fit its content.
private struct AidenTrailingFractionLayout: Layout {
    let fraction: CGFloat

    private func cappedWidth(_ proposal: ProposedViewSize) -> CGFloat? {
        guard let width = proposal.width, width.isFinite else { return nil }
        return width * fraction
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let size = child.sizeThatFits(.init(width: cappedWidth(proposal), height: nil))
        guard let width = proposal.width, width.isFinite else { return size }
        return CGSize(width: width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let maximum = bounds.width * fraction
        let size = child.sizeThatFits(.init(width: maximum, height: nil))
        child.place(
            at: CGPoint(x: bounds.maxX, y: bounds.minY),
            anchor: .topTrailing,
            proposal: .init(width: min(size.width, maximum), height: size.height)
        )
    }
}

/// One inline visual in a committed reply: the Mac's snapshot image when the
/// message carries it, then the visual's text description; the description
/// alone without a snapshot; and the title alone when there is neither.
/// When the Mac announces `chat-visual-viewer-v1` (revision 35), tapping the
/// snapshot opens the visual full screen and interactive; the image viewer
/// stays one step away from there.
struct AidenVisualRowView: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let visual: AidenChatVisual
    let snapshot: AidenMessageAttachment?
    let loadData: (AidenMessageAttachment) async -> Data?
    /// Present while the Mac announces the interactive viewer.
    var loadDocument: ((AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad)? = nil
    var onAddToMessage: ((String) -> Void)? = nil
    @State private var imageAspectRatio: CGFloat?
    @State private var gallerySelection: AidenAttachmentGallerySelection?
    @State private var isViewerPresented = false
    /// The viewer asked for the image viewer; it opens once the viewer is gone.
    @State private var opensGalleryAfterViewer = false
    @State private var isDescriptionExpanded = false
    @State private var limitedDescriptionHeight: CGFloat = 0
    @State private var fullDescriptionHeight: CGFloat = 0

    private static let collapsedDescriptionLines = 6

    private var action: AidenVisualRowAction {
        AidenVisualRowAction.resolve(viewerAvailable: loadDocument != nil, hasSnapshot: snapshot != nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let snapshot {
                snapshotImage(snapshot)
            }
            if let description = visual.fallbackText {
                descriptionText(description)
            } else if snapshot == nil {
                Text(visual.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.foreground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if snapshot == nil, action == .openInteractive {
                openInteractiveButton
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .fullScreenCover(isPresented: $isViewerPresented, onDismiss: {
            guard opensGalleryAfterViewer else { return }
            opensGalleryAfterViewer = false
            if let snapshot {
                gallerySelection = AidenAttachmentGallerySelection(id: snapshot.id)
            }
        }) {
            if let loadDocument {
                AidenVisualViewer(
                    title: visual.title,
                    loadDocument: loadDocument,
                    onAddToMessage: onAddToMessage,
                    onViewImage: snapshot == nil ? nil : { opensGalleryAfterViewer = true }
                )
            }
        }
    }

    private var openInteractiveButton: some View {
        Button {
            isViewerPresented = true
        } label: {
            Label("Open interactive", systemImage: "hand.tap")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.accent)
                .frame(minHeight: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(visual.title) interactively")
    }

    private func openSnapshot(_ attachment: AidenMessageAttachment) {
        switch action {
        case .openInteractive:
            isViewerPresented = true
        case .viewImage, .textOnly:
            gallerySelection = AidenAttachmentGallerySelection(id: attachment.id)
        }
    }

    private func snapshotImage(_ attachment: AidenMessageAttachment) -> some View {
        AidenAttachmentThumbnailView(
            attachment: attachment,
            loadData: loadData,
            contentMode: .fit,
            imageCornerRadius: AidenInlineCardDeckLayout.singleImageCornerRadius,
            imageAlignment: .leading,
            onImageLoaded: { image in
                guard image.size.width > 0, image.size.height > 0 else { return }
                imageAspectRatio = image.size.width / image.size.height
            }
        )
        // Hold a typical landscape frame until the image reports its own shape.
        .aspectRatio(imageAspectRatio ?? 16 / 9, contentMode: .fit)
        .frame(maxWidth: visual.layout == .wide ? .infinity : 560, alignment: .leading)
        // Claim the snapshot's own height. Left flexible, the message stack
        // squeezes it to nothing when the reply also carries image attachments,
        // leaving the space it should fill as a gap below them.
        .fixedSize(horizontal: false, vertical: true)
        .clipShape(RoundedRectangle(cornerRadius: AidenInlineCardDeckLayout.singleImageCornerRadius, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { openSnapshot(attachment) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(visual.title)
        .accessibilityHint(action == .openInteractive
            ? Text("Double-tap to open the interactive visual")
            : Text("Double-tap to open the image viewer"))
        .accessibilityAddTraits([.isImage, .isButton])
        .accessibilityAction { openSnapshot(attachment) }
        .accessibilityActions {
            if action == .openInteractive {
                Button("Open interactive") { isViewerPresented = true }
                Button("View image") {
                    gallerySelection = AidenAttachmentGallerySelection(id: attachment.id)
                }
            }
        }
        .fullScreenCover(item: $gallerySelection) { selection in
            AidenAttachmentGalleryView(
                attachments: [attachment],
                initialAttachmentID: selection.id,
                loadData: loadData
            )
        }
    }

    private func descriptionText(_ description: String) -> some View {
        let isTruncated = fullDescriptionHeight > limitedDescriptionHeight + 1
        return VStack(alignment: .leading, spacing: 4) {
            Text(description)
                .font(.callout)
                // Secondary beneath a snapshot; the primary content without one.
                .foregroundStyle(snapshot == nil ? palette.foreground : palette.secondary)
                .lineLimit(isDescriptionExpanded ? nil : Self.collapsedDescriptionLines)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { limitedDescriptionHeight = $0 }
                .background(alignment: .topLeading) {
                    // Measures the untruncated description at the same width.
                    Text(description)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                        .hidden()
                        .accessibilityHidden(true)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullDescriptionHeight = $0 }
                }
            if isDescriptionExpanded || isTruncated {
                Button(isDescriptionExpanded ? "Show less" : "Show more") {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                        isDescriptionExpanded.toggle()
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.accent)
                .buttonStyle(.plain)
                .accessibilityLabel(isDescriptionExpanded
                    ? "Show less of \(visual.title)"
                    : "Show more of \(visual.title)")
            }
        }
    }
}

/// A one-row view of reasoning that never opens or closes on its own. While
/// the model thinks, the row shows the latest finished line in place, so a fast
/// turn with many short thoughts never moves the transcript. Opening it is the
/// reader's choice.
struct AidenReasoningCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let text: String
    let label: String
    let active: Bool
    @State private var isExpanded = false
    /// Keeps its last text once thinking ends so the line can fade out in place.
    @State private var liveLine = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Text(label)
                        .font(.caption.weight(.semibold))
                        .aidenActivityShimmer(active)
                        .layoutPriority(1)
                    ZStack(alignment: .leading) {
                        if !liveLine.isEmpty {
                            Text(liveLine)
                                .id(liveLine)
                                .transition(.asymmetric(
                                    insertion: .opacity.combined(with: .offset(y: 4)),
                                    removal: .opacity
                                ))
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(active && !isExpanded ? 1 : 0)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: active)
                    .accessibilityHidden(true)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .frame(height: 36)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                ScrollView {
                    Text(text)
                        .font(.caption)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                .frame(maxHeight: 144, alignment: .top)
                .padding(.bottom, 10)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .onChange(of: text, initial: true) { refreshLiveLine() }
        .onChange(of: active) { refreshLiveLine() }
    }

    private func refreshLiveLine() {
        guard active else { return }
        let line = AidenAgentActivityPresentation.latestReasoningLine(text)
        guard !line.isEmpty, line != liveLine else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) {
            liveLine = line
        }
    }
}

struct AidenActivityPhaseCard: View {
    @Environment(\.aidenPalette) private var palette
    let label: String
    var active: Bool = true

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.secondary)
            .aidenActivityShimmer(active)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .padding(.horizontal, 12)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel(label)
    }
}

struct AidenToolActivityCard: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let tools: [AidenLiveTool]
    @State private var isExpanded = false

    private var isComplete: Bool {
        !tools.isEmpty && tools.allSatisfy { tool in
            guard let status = tool.status?.lowercased() else { return false }
            return ["completed", "complete", "succeeded", "success"].contains(status)
        }
    }
    private var hasIssue: Bool {
        tools.contains { tool in
            guard let status = tool.status?.lowercased() else { return false }
            return ["failed", "blocked", "cancelled", "canceled", "denied"].contains(status)
        }
    }
    private var summary: String {
        let names = Array(Set(tools.map(\.name))).sorted()
        let visible = names.prefix(3).joined(separator: ", ")
        return names.count > 3 ? "\(visible), +\(names.count - 3)" : visible
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 8 : 0) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: hasIssue ? "exclamationmark.circle.fill" : (isComplete ? "checkmark.circle.fill" : "wrench.and.screwdriver.fill"))
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(palette.secondary)
                        .frame(width: 18, height: 18)
                    Text(hasIssue ? "Tool issue" : (isComplete ? "Tools used" : "Using tools"))
                        .font(.caption.weight(.semibold))
                    Text(summary).font(.caption).foregroundStyle(palette.secondary).lineLimit(1)
                    Spacer(minLength: 6)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(tools) { tool in
                        HStack(spacing: 8) {
                            Image(systemName: legacySymbol(for: tool.status))
                            Text(tool.name).lineLimit(1)
                            Spacer()
                            Text(tool.status ?? "Running").foregroundStyle(palette.secondary)
                        }
                        .font(.caption)
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func legacySymbol(for status: String?) -> String {
        guard let status = status?.lowercased() else { return "circle.dotted" }
        if ["completed", "complete", "succeeded", "success"].contains(status) { return "checkmark.circle" }
        if ["failed", "blocked", "cancelled", "canceled", "denied"].contains(status) {
            return "exclamationmark.circle"
        }
        return "circle.dotted"
    }
}
