import SwiftUI

/// What a composer offers. Everything that changes with the conversation's
/// moment-to-moment state is in `AidenComposerControls`.
struct AidenComposerConfig: Equatable {
    var placeholder: String
    var showsModelChip: Bool
    var showsMic: Bool
    var showsAttachments: Bool
    var maxLines: Int

    /// `model` names the chat's model; nil when the chat has no model to show.
    static func chat(model: String?) -> Self {
        Self(
            placeholder: "Message Aiden",
            showsModelChip: model != nil,
            showsMic: true,
            showsAttachments: true,
            maxLines: 6
        )
    }

    /// A Bot's model is set on the Bot, never from its composer.
    static func bot() -> Self {
        Self(
            placeholder: "Message",
            showsModelChip: false,
            showsMic: true,
            showsAttachments: true,
            maxLines: 6
        )
    }
}

/// The conversation's current say over the composer's controls.
struct AidenComposerControls: Equatable {
    /// Nil allows Send whenever the session holds something to send.
    var canSend: Bool?
    var sendLabel = String(localized: "Send message")
    var canStop = true
    var stopLabel = String(localized: "Stop response")
    var fieldIsDisabled = false
    /// False while another control takes the mic's place.
    var offersMic = true
    var micIsEnabled = true
    var submitsOnReturn = false
}

enum AidenComposerLayout {
    /// A control grows with the text, but never below a full target, and never so
    /// far that a row of them leaves the screen at the largest text sizes.
    static func actionSize(scaled: CGFloat) -> CGFloat {
        min(max(44, scaled), 60)
    }

    /// Below this a chip no longer names its model, so it moves to its own line.
    static let shortestChip: CGFloat = 72

    /// The glyphs stop here so they stay inside a control that has stopped growing.
    static let largestGlyphSize = DynamicTypeSize.accessibility1

    static func lineRange(maxLines: Int) -> ClosedRange<Int> {
        1...max(1, maxLines)
    }

    /// The field's height for `lineCount` lines of text. It stops at `maxLines`;
    /// past that the field scrolls.
    static func fieldHeight(
        lineCount: Int,
        lineHeight: CGFloat,
        verticalInset: CGFloat,
        maxLines: Int
    ) -> CGFloat {
        let visibleLines = min(max(lineCount, 1), max(maxLines, 1))
        return CGFloat(visibleLines) * lineHeight + verticalInset * 2
    }
}

/// The side of a composer control at the current text size.
@propertyWrapper
struct AidenComposerActionSize: DynamicProperty {
    @ScaledMetric(relativeTo: .body) private var scaled: CGFloat = 40

    var wrappedValue: CGFloat { AidenComposerLayout.actionSize(scaled: scaled) }
}

/// The one composer chats and Bots share: a Liquid Glass surface around the
/// field and its controls. Input state lives in the session, so this view can
/// leave the hierarchy without ending anything.
///
/// The slots hold what only one kind of conversation has. `onStop` is non-nil
/// while a run can be stopped; `busyControl` sits beside Stop, in Send's place.
struct AidenComposerSurface<
    Accessory: View,
    AttachButton: View,
    ModelChip: View,
    BusyControl: View,
    Footer: View
>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @AidenComposerActionSize private var actionSize
    @ScaledMetric(relativeTo: .body) private var lineHeight: CGFloat = 22
    @FocusState private var ownFocus: Bool
    @Bindable private var session: AidenComposerSession

    private let config: AidenComposerConfig
    private let controls: AidenComposerControls
    private let focus: FocusState<Bool>.Binding?
    private let onSend: () -> Void
    private let onStop: (() -> Void)?
    private let onToggleVoice: (() -> Void)?
    private let accessory: Accessory
    private let attachButton: AttachButton
    private let modelChip: ModelChip
    private let busyControl: BusyControl
    private let footer: Footer

    init(
        session: AidenComposerSession,
        config: AidenComposerConfig,
        controls: AidenComposerControls = AidenComposerControls(),
        focus: FocusState<Bool>.Binding? = nil,
        onSend: @escaping () -> Void,
        onStop: (() -> Void)?,
        onToggleVoice: (() -> Void)? = nil,
        @ViewBuilder accessory: () -> Accessory = { EmptyView() },
        @ViewBuilder attachButton: () -> AttachButton = { EmptyView() },
        @ViewBuilder modelChip: () -> ModelChip = { EmptyView() },
        @ViewBuilder busyControl: () -> BusyControl = { EmptyView() },
        @ViewBuilder footer: () -> Footer = { EmptyView() }
    ) {
        self.session = session
        self.config = config
        self.controls = controls
        self.focus = focus
        self.onSend = onSend
        self.onStop = onStop
        self.onToggleVoice = onToggleVoice
        self.accessory = accessory()
        self.attachButton = attachButton()
        self.modelChip = modelChip()
        self.busyControl = busyControl()
        self.footer = footer()
    }

    /// The chip needs a row of its own, and so do accessibility text sizes.
    private var isStacked: Bool { config.showsModelChip || dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        AidenComposerGlassContainer {
            VStack(alignment: .leading, spacing: AidenSpacing.s) {
                Group { accessory }
                    .padding(.horizontal, AidenSpacing.s)
                    .padding(.top, AidenSpacing.xs)
                if isStacked {
                    field
                    stackedControls
                } else {
                    HStack(alignment: .bottom, spacing: AidenSpacing.xs) {
                        if config.showsAttachments { attachButton }
                        field
                        actions
                    }
                }
                Group {
                    footer
                    if let error = session.voiceErrorMessage, !session.isRecording {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(.horizontal, AidenSpacing.s)
                .padding(.bottom, AidenSpacing.xs)
            }
            .padding(AidenSpacing.xs)
            // The surface is stable around its own controls: plain, not
            // interactive, glass, so streamed updates don't recompute it.
            .aidenComposerGlass()
        }
    }

    /// One row, where a chip short of room shortens, so at the usual sizes a run
    /// starting doesn't change the composer's height. When even a short chip won't
    /// fit, and always at accessibility sizes, the chip takes its own line.
    @ViewBuilder
    private var stackedControls: some View {
        if dynamicTypeSize.isAccessibilitySize {
            chipLineControls
        } else {
            ViewThatFits(in: .horizontal) {
                controlRow
                chipLineControls
            }
        }
    }

    private var controlRow: some View {
        HStack(spacing: AidenSpacing.xs) {
            attachment
            chip
                .frame(
                    minWidth: AidenComposerLayout.shortestChip,
                    idealWidth: AidenComposerLayout.shortestChip,
                    maxWidth: 180,
                    alignment: .leading
                )
                .layoutPriority(1)
            Spacer(minLength: 0)
            // The chip is what shortens, never these.
            HStack(spacing: AidenSpacing.xs) { actions }
                .fixedSize(horizontal: true, vertical: false)
        }
    }

    /// The run controls take a further line of their own if they need it.
    private var chipLineControls: some View {
        VStack(alignment: .leading, spacing: AidenSpacing.xs) {
            chip
            ViewThatFits(in: .horizontal) {
                HStack(spacing: AidenSpacing.xs) {
                    attachment
                    Spacer(minLength: 0)
                    actions
                }
                VStack(alignment: .leading, spacing: AidenSpacing.xs) {
                    HStack(spacing: AidenSpacing.xs) {
                        attachment
                        mic
                    }
                    HStack(spacing: AidenSpacing.xs) {
                        Spacer(minLength: 0)
                        runControls
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var attachment: some View {
        if config.showsAttachments { attachButton }
    }

    @ViewBuilder
    private var chip: some View {
        if config.showsModelChip { modelChip }
    }

    private var field: some View {
        let verticalInset = isStacked ? AidenSpacing.s : AidenSpacing.m
        return TextField(config.placeholder, text: $session.text, axis: .vertical)
            .lineLimit(AidenComposerLayout.lineRange(maxLines: config.maxLines))
            .focused(focus ?? $ownFocus)
            .padding(.horizontal, isStacked ? AidenSpacing.m : AidenSpacing.xs)
            .padding(.leading, !isStacked && !config.showsAttachments ? AidenSpacing.s : 0)
            .padding(.vertical, verticalInset)
            .frame(
                minHeight: isStacked ? nil : actionSize,
                maxHeight: AidenComposerLayout.fieldHeight(
                    lineCount: config.maxLines,
                    lineHeight: lineHeight,
                    verticalInset: verticalInset,
                    maxLines: config.maxLines
                )
            )
            .fixedSize(horizontal: false, vertical: true)
            .disabled(controls.fieldIsDisabled || session.isVoiceBusy)
            .submitLabel(controls.submitsOnReturn ? .send : .return)
            .onSubmit {
                guard controls.submitsOnReturn, onStop == nil else { return }
                send()
            }
    }

    @ViewBuilder
    private var actions: some View {
        mic
        runControls
    }

    @ViewBuilder
    private var mic: some View {
        // A dictation already running keeps its stop control, whatever else
        // has taken the mic's place.
        if config.showsMic, controls.offersMic || session.isRecording {
            micButton
        }
    }

    @ViewBuilder
    private var runControls: some View {
        if let onStop {
            busyControl
            AidenComposerStopButton(label: controls.stopLabel, isEnabled: controls.canStop, action: onStop)
        } else {
            AidenComposerSendButton(
                label: controls.sendLabel,
                isEnabled: controls.canSend ?? session.hasContent,
                action: send
            )
        }
    }

    private var micButton: some View {
        Button {
            if let onToggleVoice {
                onToggleVoice()
            } else {
                Task { await session.toggleVoice() }
            }
        } label: {
            Group {
                if session.isRecording {
                    AidenListeningWaveform(isAnimated: !reduceMotion)
                } else {
                    Image(systemName: "mic")
                        .font(.body.weight(.medium))
                        .dynamicTypeSize(...AidenComposerLayout.largestGlyphSize)
                }
            }
            .frame(width: actionSize, height: actionSize)
        }
        .disabled(!session.isRecording && (!controls.micIsEnabled || session.isVoiceBusy))
        .accessibilityLabel(session.isRecording ? "Stop voice input" : "Start voice input")
    }

    /// Dictation ends before Send reads the words, so nothing lands after it.
    private func send() {
        session.stopVoice()
        onSend()
    }
}

/// Send, on the surface and wherever a conversation puts it beside Stop.
struct AidenComposerSendButton: View {
    @AidenComposerActionSize private var actionSize
    let label: String
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.body.weight(.semibold))
                .dynamicTypeSize(...AidenComposerLayout.largestGlyphSize)
                .frame(width: actionSize, height: actionSize)
        }
        .buttonStyle(AidenSolidFillButtonStyle(shape: Circle()))
        .disabled(!isEnabled)
        .accessibilityLabel(label)
    }
}

/// Stop stays its own control, apart from the busy pill.
struct AidenComposerStopButton: View {
    @Environment(\.aidenPalette) private var palette
    @AidenComposerActionSize private var actionSize
    let label: String
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "stop.fill")
                .font(.body.weight(.semibold))
                .dynamicTypeSize(...AidenComposerLayout.largestGlyphSize)
                .foregroundStyle(palette.danger)
                .frame(width: actionSize, height: actionSize)
                .background(palette.danger.opacity(0.14), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(label)
    }
}

/// The +: Files, Camera and Photos. It reports its center so the picker can
/// grow out of it, in the conversation's own coordinate space.
struct AidenComposerAttachButton: View {
    @Environment(\.aidenPalette) private var palette
    @AidenComposerActionSize private var actionSize
    let isOpen: Bool
    let isBusy: Bool
    /// False while the upload bar shows progress: it is then the only spinner.
    let showsSpinner: Bool
    let hint: String
    let coordinateSpace: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.title3.weight(.medium))
                .dynamicTypeSize(...AidenComposerLayout.largestGlyphSize)
                .foregroundStyle(palette.foreground)
                .frame(width: actionSize, height: actionSize)
                .rotationEffect(.degrees(isOpen ? 45 : 0))
                .opacity(isBusy ? 0.48 : 1)
                .overlay(alignment: .bottomTrailing) {
                    if isBusy, showsSpinner {
                        ProgressView()
                            .controlSize(.mini)
                            .padding(3)
                            .aidenChromeGlass(in: Circle())
                    }
                }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add attachment")
        .accessibilityValue(isOpen ? "Open" : "Closed")
        .accessibilityHint(hint)
        .background {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .named(coordinateSpace))
                Color.clear.preference(
                    key: AidenAttachmentButtonCenterPreferenceKey.self,
                    value: CGPoint(x: frame.midX, y: frame.midY)
                )
            }
        }
    }
}

/// Dictation carries on while a question card has the composer's place, so the
/// way to end it stays on screen.
struct AidenComposerListeningBar: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let session: AidenComposerSession

    var body: some View {
        Group {
            if session.isRecording {
                HStack(spacing: AidenSpacing.s) {
                    AidenListeningWaveform(isAnimated: !reduceMotion)
                    Text("Listening")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                    Spacer(minLength: 0)
                    Button {
                        Task { await session.toggleVoice() }
                    } label: {
                        Text("Stop voice input")
                            .font(.footnote.weight(.semibold))
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, AidenSpacing.m)
                .aidenChromeGlass(in: Capsule())
                .padding(.bottom, AidenSpacing.s)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: session.isRecording)
    }
}

struct AidenListeningWaveform: View {
    let isAnimated: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 12, paused: !isAnimated)) { context in
            let phase = isAnimated ? context.date.timeIntervalSinceReferenceDate * 7 : 0
            HStack(alignment: .center, spacing: 2) {
                ForEach(0..<5, id: \.self) { index in
                    let offset = Double(index) * 0.85
                    let amplitude = isAnimated ? abs(sin(phase + offset)) : 0.45
                    Capsule(style: .continuous)
                        .frame(width: 2.5, height: 19)
                        .scaleEffect(
                            x: 1,
                            y: (7 + (amplitude * 12)) / 19,
                            anchor: .center
                        )
                }
            }
            .frame(width: 24, height: 22)
        }
        .accessibilityHidden(true)
    }
}

/// Groups the composer's glass so nearby glass blends; a plain stack under Reduce Transparency.
private struct AidenComposerGlassContainer<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ViewBuilder let content: () -> Content

    var body: some View {
        if !reduceTransparency {
            GlassEffectContainer(spacing: AidenSpacing.s) { content() }
        } else {
            content()
        }
    }
}

private struct AidenComposerGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let enabled: Bool
    private let shape = RoundedRectangle(cornerRadius: AidenRadius.composer, style: .continuous)

    @ViewBuilder
    func body(content: Content) -> some View {
        if !enabled {
            content
        } else if !reduceTransparency {
            // The whole composer is a stable surface containing its own
            // interactive controls. Marking the container interactive causes
            // Liquid Glass to recompute multiple times during streamed updates.
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(palette.raised, in: shape)
        }
    }
}

/// Messages scroll under the floating composer: the edge softens so the words
/// stay readable; under Reduce Transparency it stays plain.
private struct AidenComposerSoftScrollEdge: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    func body(content: Content) -> some View {
        if !reduceTransparency {
            content.scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            content
        }
    }
}

extension View {
    func aidenComposerGlass(enabled: Bool = true) -> some View {
        modifier(AidenComposerGlassModifier(enabled: enabled))
    }

    func aidenComposerSoftScrollEdge() -> some View {
        modifier(AidenComposerSoftScrollEdge())
    }

    /// Tells the follow whether the transcript fits between the insets
    /// (`containerSize` is that space). A transcript that fits has nothing to keep
    /// in view, and scrolling it would pull it down from the top.
    func aidenReportsTranscriptFit(to follow: AidenTranscriptFollowController) -> some View {
        onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height <= geometry.containerSize.height
        } action: { _, fits in
            follow.updateTranscriptFit(fits)
        }
    }

    /// Rows added above the reader push them down the content. With `anchorID`
    /// set, the next time the content grows the transcript scrolls that row to
    /// the top again, so the reader stays on what they were reading. The scroll
    /// waits for the growth because that is when the new rows have been laid
    /// out; asked any sooner, the scroll resolves against the old layout and does
    /// nothing. The request lapses after a second so later growth, such as a
    /// streaming reply, never moves the reader.
    func aidenKeepsPlaceOnPrepend(anchorID: Binding<String?>, proxy: ScrollViewProxy) -> some View {
        modifier(AidenKeepsPlaceOnPrepend(anchorID: anchorID, proxy: proxy))
    }

    /// The composer is the transcript's bottom inset, and an inset moving scrolls
    /// nothing: without this the latest words slide under a composer that grew.
    func aidenOnComposerInsetChange(_ action: @escaping () -> Void) -> some View {
        onScrollGeometryChange(for: CGFloat?.self) { geometry in
            geometry.contentSize.height > geometry.containerSize.height ? geometry.contentInsets.bottom : nil
        } action: { _, bottomInset in
            if bottomInset != nil { action() }
        }
    }
}

private struct AidenKeepsPlaceOnPrepend: ViewModifier {
    @Binding var anchorID: String?
    let proxy: ScrollViewProxy

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, new in
                guard let id = anchorID, new > old else { return }
                anchorID = nil
                proxy.scrollTo(id, anchor: .top)
            }
            .task(id: anchorID) {
                guard anchorID != nil else { return }
                try? await Task.sleep(for: .seconds(1))
                if !Task.isCancelled { anchorID = nil }
            }
    }
}
