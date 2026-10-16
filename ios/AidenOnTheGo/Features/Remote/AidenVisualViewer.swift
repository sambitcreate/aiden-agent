import SwiftUI
import WebKit

// MARK: - Viewer

/// One visual full screen in a locked-down web view (revision 34). The page
/// comes from the Mac in the phone's own theme and scheme; it reaches native
/// code only through the `aidenVisual` message channel.
struct AidenVisualViewer: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenThemePreset) private var themePreset
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    let title: String
    let loadDocument: (AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad
    /// Appends a confirmed prompt to the chat composer; nil ignores prompts
    /// (a read-only chat).
    var onAddToMessage: ((String) -> Void)? = nil
    /// Closes the viewer and opens the snapshot in the image viewer.
    var onViewImage: (() -> Void)? = nil

    @State private var phase: Phase = .loading
    @State private var documentID = 0
    @State private var isPageReady = false
    @State private var pendingPrompt: String?
    @State private var pendingLink: URL?
    @State private var attempt = 0

    private enum Phase {
        case loading
        case document(html: String, outdated: Bool)
        case failed(String)
    }

    private struct LoadKey: Hashable {
        let appearance: AidenVisualViewerAppearance
        let attempt: Int
    }

    private var appearance: AidenVisualViewerAppearance {
        AidenVisualViewerAppearance(scheme: AidenVisualViewerScheme(colorScheme), theme: themePreset)
    }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.canvas.ignoresSafeArea())
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(palette.canvas, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                            .accessibilityLabel("Close \(title)")
                    }
                    if let onViewImage {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                onViewImage()
                                dismiss()
                            } label: {
                                Label("View image", systemImage: "photo")
                            }
                            .accessibilityHint("Opens the snapshot in the image viewer")
                        }
                    }
                }
        }
        .task(id: LoadKey(appearance: appearance, attempt: attempt)) {
            await load(appearance)
        }
        .alert(
            "Open link?",
            isPresented: Binding(
                get: { pendingLink != nil },
                set: { if !$0 { pendingLink = nil } }
            ),
            presenting: pendingLink
        ) { link in
            Button("Open") {
                pendingLink = nil
                openURL(link)
            }
            Button("Cancel", role: .cancel) { pendingLink = nil }
        } message: { link in
            Text(link.host() ?? link.absoluteString)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
                .tint(palette.secondary)
                .accessibilityLabel("Loading \(title)")
        case .failed(let message):
            failure(message)
        case .document(let html, let outdated):
            AidenVisualWebView(html: html, documentID: documentID, onMessage: handle)
                .opacity(isPageReady ? 1 : 0)
                .overlay {
                    if !isPageReady {
                        ProgressView()
                            .tint(palette.secondary)
                            .accessibilityLabel("Loading \(title)")
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    if outdated { outdatedNote }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if let pendingPrompt { promptBar(pendingPrompt) }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isPageReady)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: pendingPrompt)
                .task(id: documentID) {
                    // A page that never reports ready still shows itself.
                    try? await Task.sleep(for: .seconds(4))
                    guard !Task.isCancelled else { return }
                    isPageReady = true
                }
        }
    }

    private var outdatedNote: some View {
        Label("May be out of date. Your Mac couldn't be reached.", systemImage: "clock.arrow.circlepath")
            .font(.caption)
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(palette.raised)
            .accessibilityElement(children: .combine)
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title2)
                .foregroundStyle(palette.warning)
                .accessibilityHidden(true)
            Text(message)
                .font(.callout)
                .foregroundStyle(palette.foreground)
                .multilineTextAlignment(.center)
            Button {
                attempt += 1
            } label: {
                Text("Retry")
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
            }
            .buttonStyle(AidenSolidFillButtonStyle(shape: Capsule()))
            if let onViewImage {
                Button("View image") {
                    onViewImage()
                    dismiss()
                }
                .font(.callout)
                .foregroundStyle(palette.accent)
            }
        }
        .padding(24)
    }

    private func promptBar(_ prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Suggested follow-up")
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.secondary)
            Text(prompt)
                .font(.callout)
                .foregroundStyle(palette.foreground)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 12) {
                Spacer(minLength: 0)
                Button("Dismiss") { pendingPrompt = nil }
                    .font(.callout)
                    .foregroundStyle(palette.secondary)
                    .frame(minHeight: 44)
                Button {
                    addToMessage(prompt)
                } label: {
                    Text("Add to message")
                        .font(.callout.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                }
                .buttonStyle(AidenSolidFillButtonStyle(shape: Capsule()))
            }
        }
        .padding(14)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested follow-up")
    }

    private func addToMessage(_ prompt: String) {
        pendingPrompt = nil
        onAddToMessage?(prompt)
        dismiss()
    }

    private func handle(_ message: AidenVisualViewerMessage) {
        switch message {
        case .ready:
            isPageReady = true
        case .prompt(let text):
            // A newer suggestion replaces one still waiting.
            guard onAddToMessage != nil else { return }
            pendingPrompt = text
        case .openURL(let url):
            pendingLink = url
        }
    }

    private func load(_ appearance: AidenVisualViewerAppearance) async {
        isPageReady = false
        pendingPrompt = nil
        phase = .loading
        let result = await loadDocument(appearance)
        guard !Task.isCancelled else { return }
        switch result {
        case .live(let html):
            documentID += 1
            phase = .document(html: html, outdated: false)
        case .cached(let html):
            documentID += 1
            phase = .document(html: html, outdated: true)
        case .failed(let message):
            phase = .failed(message)
        }
    }
}

// MARK: - Web view

/// A `WKWebView` that loads one HTML string with no base URL, keeps nothing
/// on disk, opens no windows, follows no links, and hears only main-frame
/// `aidenVisual` messages.
private struct AidenVisualWebView: UIViewRepresentable {
    let html: String
    /// Changes whenever a new document should replace the loaded one.
    let documentID: Int
    let onMessage: (AidenVisualViewerMessage) -> Void

    func makeCoordinator() -> AidenVisualWebViewCoordinator {
        AidenVisualWebViewCoordinator(onMessage: onMessage)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.dataDetectorTypes = []
        let contentController = WKUserContentController()
        contentController.add(
            AidenVisualScriptMessageProxy(target: context.coordinator),
            name: AidenVisualViewerMessage.handlerName
        )
        configuration.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        context.coordinator.load(html, documentID: documentID, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onMessage = onMessage
        if context.coordinator.loadedDocumentID != documentID {
            context.coordinator.load(html, documentID: documentID, in: webView)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: AidenVisualWebViewCoordinator) {
        // The content controller retains its handlers; removing them breaks
        // the controller -> proxy chain as the view goes away.
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }
}

@MainActor
private final class AidenVisualWebViewCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var onMessage: (AidenVisualViewerMessage) -> Void
    private(set) var loadedDocumentID: Int?
    private var loadedHTML: String?
    private var navigationPolicy = AidenVisualNavigationPolicy()

    init(onMessage: @escaping (AidenVisualViewerMessage) -> Void) {
        self.onMessage = onMessage
    }

    func load(_ html: String, documentID: Int, in webView: WKWebView) {
        loadedDocumentID = documentID
        loadedHTML = html
        navigationPolicy = AidenVisualNavigationPolicy()
        webView.loadHTMLString(html, baseURL: nil)
    }

    func receive(_ message: WKScriptMessage) {
        guard message.name == AidenVisualViewerMessage.handlerName,
              message.frameInfo.isMainFrame,
              let parsed = AidenVisualViewerMessage.parse(message.body) else { return }
        onMessage(parsed)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        navigationPolicy.allows(
            url: navigationAction.request.url,
            targetIsMainFrame: navigationAction.targetFrame?.isMainFrame
        ) ? .allow : .cancel
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Redraw the same document after the content process is reclaimed.
        guard let loadedHTML, let loadedDocumentID else { return }
        load(loadedHTML, documentID: loadedDocumentID, in: webView)
    }
}

/// Holds the coordinator weakly so the content controller's strong reference
/// to its handler never keeps the viewer alive.
@MainActor
private final class AidenVisualScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: AidenVisualWebViewCoordinator?

    init(target: AidenVisualWebViewCoordinator) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.receive(message)
    }
}
