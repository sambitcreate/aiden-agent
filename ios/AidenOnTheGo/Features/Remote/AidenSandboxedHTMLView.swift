import GameController
import SwiftUI
import WebKit

/// What a preview page may navigate to. A preview shows the one document it
/// was handed: it never replaces it, never loads another page into a frame,
/// and only offers (never follows) a tapped https link.
enum AidenPreviewNavigation {
    enum Decision: Equatable {
        case allow
        case cancel
        /// A tapped https link without credentials; the caller asks first.
        case offerLink(URL)
        /// A tapped in-page link; the caller scrolls to the element with this id.
        case anchor(String)
    }

    /// `isMainFrame` is nil when the navigation would open a new window.
    /// `hasLoaded` is true once the view's own document has been allowed.
    static func decision(url: URL?, isMainFrame: Bool?, isLinkTap: Bool, hasLoaded: Bool) -> Decision {
        guard let url else { return .cancel }
        let address = url.absoluteString
        guard let isMainFrame else {
            return tappedLink(address, isLinkTap: isLinkTap)
        }
        if isMainFrame {
            if !hasLoaded { return address == "about:blank" ? .allow : .cancel }
            guard isLinkTap else { return .cancel }
            if let anchor = anchor(in: address) { return .anchor(anchor) }
            return tappedLink(address, isLinkTap: true)
        }
        if address == "about:blank" || address == "about:srcdoc" { return .allow }
        return tappedLink(address, isLinkTap: isLinkTap)
    }

    private static func tappedLink(_ address: String, isLinkTap: Bool) -> Decision {
        guard isLinkTap, let url = AidenVisualViewerMessage.externalURL(address) else { return .cancel }
        return .offerLink(url)
    }

    /// `#notes` on the loaded document resolves to `about:blank#notes`, which
    /// some paths hand over percent-encoded as `about:blank%23notes`.
    private static func anchor(in address: String) -> String? {
        for prefix in ["about:blank#", "about:blank%23"] where address.hasPrefix(prefix) {
            let raw = String(address.dropFirst(prefix.count))
            let name = raw.removingPercentEncoding ?? raw
            return name.isEmpty ? nil : name
        }
        return nil
    }
}

/// Decides whether a link offer may reach the person. A page with scripts on
/// can fake a link tap (`a.click()`) as often as it likes, so an offer is
/// admitted only right after a real tap on the preview, once per tap. A touch
/// that travels more than `tapSlop` (a scroll or drag) is not a tap.
///
/// A hardware keyboard (including Full Keyboard Access), VoiceOver and Switch
/// Control activate links without a touch the view can see. While one of them
/// may be in use, an offer is also admitted without a tap, at most once per
/// `touchlessInterval` and `touchlessLimit` times per loaded document.
struct AidenLinkOfferGate: Equatable, Sendable {
    static let interactionWindow: TimeInterval = 1.0
    static let tapSlop: Double = 10
    static let touchlessInterval: TimeInterval = 2.0
    static let touchlessLimit = 3

    private var lastInteraction: Date?
    private var lastAdmitted: Date?
    private var touchlessAdmitted = 0
    private var touchStart: CGPoint?
    private var touchTravelledTooFar = false

    // MARK: Touches

    mutating func touchBegan(at point: CGPoint) {
        touchStart = point
        touchTravelledTooFar = false
    }

    mutating func touchMoved(to point: CGPoint) {
        guard let touchStart else { return }
        if hypot(point.x - touchStart.x, point.y - touchStart.y) > Self.tapSlop {
            touchTravelledTooFar = true
        }
    }

    /// Returns whether the touch counted as a tap.
    @discardableResult
    mutating func touchEnded(at point: CGPoint, time: Date) -> Bool {
        touchMoved(to: point)
        defer { touchCancelled() }
        guard touchStart != nil, !touchTravelledTooFar else { return false }
        userInteracted(at: time)
        return true
    }

    mutating func touchCancelled() {
        touchStart = nil
        touchTravelledTooFar = false
    }

    /// A tap on the preview ended.
    mutating func userInteracted(at date: Date) {
        lastInteraction = date
    }

    // MARK: Offers

    /// A new document loaded; its touchless allowance starts over.
    mutating func documentDidLoad() {
        touchlessAdmitted = 0
        lastInteraction = nil
    }

    mutating func admit(at date: Date, touchlessActivationPossible: Bool = false) -> Bool {
        if let interaction = lastInteraction {
            let elapsed = date.timeIntervalSince(interaction)
            if elapsed >= 0, elapsed <= Self.interactionWindow {
                lastInteraction = nil
                lastAdmitted = date
                return true
            }
        }
        guard touchlessActivationPossible, touchlessAdmitted < Self.touchlessLimit else { return false }
        if let lastAdmitted, date.timeIntervalSince(lastAdmitted) < Self.touchlessInterval {
            return false
        }
        touchlessAdmitted += 1
        lastAdmitted = date
        return true
    }
}

/// The content rule list that keeps preview pages off the network. WebKit's
/// `url-filter` has no alternation, so http(s) and ws(s) are separate rules.
/// WebRTC is outside what rule lists filter; the view removes it by script.
enum AidenPreviewNetworkBlock {
    static let identifier = "aiden-preview-no-network"
    static let rulesJSON = """
    [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},\
    {"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}}]
    """

    enum CompileError: Error {
        case unavailable
    }

    @MainActor private static var compiled: Task<WKContentRuleList, Error>?

    /// Compiled once per launch; a failed compile is retried on the next call.
    @MainActor
    static func ruleList() async throws -> WKContentRuleList {
        let task = compiled ?? Task { @MainActor in
            guard let store = WKContentRuleListStore.default(),
                  let list = try await store.compileContentRuleList(
                      forIdentifier: identifier,
                      encodedContentRuleList: rulesJSON
                  ) else { throw CompileError.unavailable }
            return list
        }
        compiled = task
        do {
            return try await task.value
        } catch {
            if compiled == task { compiled = nil }
            throw error
        }
    }
}

/// A locked-down `WKWebView` for previewing an HTML string: nothing on disk,
/// no network, no script message handlers, no windows and no navigation. It
/// stays transparent until the page finishes, so a dark page never flashes
/// white. It loads once; callers reload by changing its SwiftUI `.id(…)`.
struct AidenSandboxedHTMLView: UIViewRepresentable {
    let html: String
    let allowsScripts: Bool
    /// Inserted as the first child of `<html>` before the page parses.
    let themeCSS: String?
    let scrolls: Bool
    let onLinkOffer: (URL) -> Void
    /// The rule list could not be installed, the page failed to load, or the
    /// content process keeps dying.
    let onFailure: () -> Void

    func makeCoordinator() -> AidenSandboxedHTMLCoordinator {
        AidenSandboxedHTMLCoordinator(onLinkOffer: onLinkOffer, onFailure: onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = makeWebView(coordinator: context.coordinator)
        context.coordinator.start(html, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onLinkOffer = onLinkOffer
        context.coordinator.onFailure = onFailure
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: AidenSandboxedHTMLCoordinator) {
        coordinator.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    /// The configured, still-empty web view. Nothing loads until the
    /// coordinator has installed the network rule list.
    func makeWebView(coordinator: AidenSandboxedHTMLCoordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = allowsScripts
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.dataDetectorTypes = []
        let contentController = WKUserContentController()
        contentController.addUserScript(WKUserScript(
            source: Self.documentStartScript(themeCSS: themeCSS),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .defaultClient
        ))
        if allowsScripts {
            contentController.addUserScript(WKUserScript(
                source: Self.removeWebRTCScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false,
                in: .page
            ))
        }
        configuration.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = coordinator
        webView.uiDelegate = coordinator
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = scrolls
        webView.scrollView.bounces = scrolls
        webView.alpha = 0
        webView.addGestureRecognizer(AidenTouchRecorder(coordinator: coordinator))
        return webView
    }

    /// Runs in the app's own world, so it works with page scripts off. The
    /// theme goes in before anything parses; the viewport meta waits for
    /// `<head>` and is added only when the page has none.
    static func documentStartScript(themeCSS: String?) -> String {
        let css = themeCSS.flatMap { try? String(data: JSONEncoder().encode($0), encoding: .utf8) } ?? "null"
        return """
        (() => {
          const css = \(css);
          if (css !== null && document.documentElement) {
            const style = document.createElement('style');
            style.id = 'aiden-preview-theme';
            style.textContent = css;
            document.documentElement.insertBefore(style, document.documentElement.firstChild);
          }
          document.addEventListener('DOMContentLoaded', () => {
            if (document.querySelector('meta[name="viewport" i]')) return;
            const meta = document.createElement('meta');
            meta.name = 'viewport';
            meta.content = 'width=device-width, initial-scale=1';
            (document.head || document.documentElement).appendChild(meta);
          }, { once: true });
        })();
        """
    }

    /// Content rule lists do not cover WebRTC (or WebTransport, where a
    /// release exposes it), so the page world loses them in every frame
    /// before the page's own scripts run.
    static let removeWebRTCScript = """
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
      try { delete window[name]; } catch (_) {}
    }
    """
}

@MainActor
final class AidenSandboxedHTMLCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var onLinkOffer: (URL) -> Void
    var onFailure: () -> Void
    /// Test hook: the document finished loading and the view is visible.
    var onDidFinish: (() -> Void)?

    private var html: String?
    private var navigation: WKNavigation?
    private var hasLoadedDocument = false
    private var recovery = AidenWebContentRecovery()
    private var offerGate = AidenLinkOfferGate()
    private var startTask: Task<Void, Never>?

    init(onLinkOffer: @escaping (URL) -> Void, onFailure: @escaping () -> Void) {
        self.onLinkOffer = onLinkOffer
        self.onFailure = onFailure
    }

    /// Installs the network rule list, then loads `html`. If the list cannot
    /// be compiled the preview fails closed and nothing loads.
    func start(_ html: String, in webView: WKWebView) {
        startTask?.cancel()
        startTask = Task { [weak self, weak webView] in
            let rules: WKContentRuleList
            do {
                rules = try await AidenPreviewNetworkBlock.ruleList()
            } catch {
                guard !Task.isCancelled else { return }
                self?.onFailure()
                return
            }
            guard !Task.isCancelled, let self, let webView else { return }
            // The rules must be installed before `loadHTMLString`, or the
            // first load could reach the network.
            webView.configuration.userContentController.add(rules)
            self.html = html
            self.recovery.newDocument()
            self.offerGate.documentDidLoad()
            self.load(in: webView)
        }
    }

    /// A real tap on the web view ended; the next link offer may go through.
    func userInteracted(at date: Date = Date()) {
        offerGate.userInteracted(at: date)
    }

    func touchBegan(at point: CGPoint) { offerGate.touchBegan(at: point) }
    func touchMoved(to point: CGPoint) { offerGate.touchMoved(to: point) }
    func touchEnded(at point: CGPoint) { offerGate.touchEnded(at: point, time: Date()) }
    func touchCancelled() { offerGate.touchCancelled() }

#if DEBUG
    /// Set by the Debug preview fixture: the simulator passes the Mac's
    /// keyboard through as a `GCKeyboard`, which would let scripted clicks in
    /// through the touchless path and hide what a UI test means to check.
    static var touchlessActivationOverride: Bool?
#endif

    /// A hardware keyboard, VoiceOver or Switch Control can activate a link
    /// without a touch. Voice Control has no public signal, so a Voice
    /// Control activation is only admitted when one of these is also present.
    /// Replaceable so tests do not depend on the simulator's keyboard.
    var touchlessActivationPossible: @MainActor () -> Bool = {
#if DEBUG
        if let override = AidenSandboxedHTMLCoordinator.touchlessActivationOverride { return override }
#endif
        return UIAccessibility.isVoiceOverRunning
            || UIAccessibility.isSwitchControlRunning
            || GCKeyboard.coalesced != nil
    }

    /// Passes a link offer on only if `AidenLinkOfferGate` admits it.
    private func offer(_ url: URL) {
        guard offerGate.admit(at: Date(), touchlessActivationPossible: touchlessActivationPossible()) else { return }
        onLinkOffer(url)
    }

    func cancel() {
        startTask?.cancel()
        startTask = nil
    }

    private func load(in webView: WKWebView) {
        guard let html else { return }
        hasLoadedDocument = false
        webView.alpha = 0
        navigation = webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: Navigation

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
        let isMainFrame = navigationAction.targetFrame?.isMainFrame
        switch AidenPreviewNavigation.decision(
            url: navigationAction.request.url,
            isMainFrame: isMainFrame,
            isLinkTap: navigationAction.navigationType == .linkActivated,
            hasLoaded: hasLoadedDocument
        ) {
        case .allow:
            if isMainFrame == true { hasLoadedDocument = true }
            return .allow
        case .cancel:
            return .cancel
        case let .offerLink(url):
            offer(url)
            return .cancel
        case let .anchor(name):
            scroll(to: name, in: webView)
            return .cancel
        }
    }

    private func scroll(to name: String, in webView: WKWebView) {
        webView.callAsyncJavaScript(
            "(document.getElementById(name) ?? document.getElementsByName(name)[0])?.scrollIntoView()",
            arguments: ["name": name],
            in: nil,
            in: .defaultClient
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === self.navigation else { return }
        webView.alpha = 1
        onDidFinish?()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard navigation === self.navigation else { return }
        onFailure()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        guard navigation === self.navigation else { return }
        onFailure()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Redraw whenever the content process is reclaimed; a page that
        // kills it again right after the reload fails instead of reloading
        // forever.
        guard html != nil else { return }
        switch recovery.processDidTerminate() {
        case .reload:
            load(in: webView)
        case .fail:
            webView.alpha = 0
            onFailure()
        }
    }

    // MARK: UI

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if case let .offerLink(url) = AidenPreviewNavigation.decision(
            url: navigationAction.request.url,
            isMainFrame: nil,
            isLinkTap: navigationAction.navigationType == .linkActivated,
            hasLoaded: hasLoadedDocument
        ) {
            offer(url)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.deny)
    }

    func webView(
        _ webView: WKWebView,
        requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.deny)
    }
}

/// Follows each single-finger touch on the web view so the gate can tell a
/// tap from a scroll. It never recognizes, so it cannot take a tap or a pan
/// from WebKit: it runs alongside every other recognizer and is never
/// required to fail or made to wait for one. A recognizer on the web view
/// sees touches that hit WebKit's content subview, and sees a touch end
/// before WebKit's link activation comes back over IPC to the navigation
/// delegate (proven by `AidenSandboxedHTMLUITests`).
private final class AidenTouchRecorder: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private weak var coordinator: AidenSandboxedHTMLCoordinator?
    private var tracked: UITouch?

    init(coordinator: AidenSandboxedHTMLCoordinator) {
        self.coordinator = coordinator
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard tracked == nil, (event.allTouches?.count ?? touches.count) == 1, let touch = touches.first else {
            // A second finger means this is not a tap.
            giveUp()
            return
        }
        tracked = touch
        coordinator?.touchBegan(at: touch.location(in: nil))
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let tracked, touches.contains(tracked) else { return }
        coordinator?.touchMoved(to: tracked.location(in: nil))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        if let tracked, touches.contains(tracked) {
            coordinator?.touchEnded(at: tracked.location(in: nil))
        }
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        giveUp()
    }

    override func reset() {
        super.reset()
        tracked = nil
    }

    private func giveUp() {
        coordinator?.touchCancelled()
        state = .failed
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
        false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        false
    }
}
