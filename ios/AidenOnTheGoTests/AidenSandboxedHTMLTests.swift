import Network
import UIKit
import WebKit
import XCTest
@testable import AidenOnTheGo

/// The shared preview web view: what it lets a page navigate to, the rule
/// list that blocks every network scheme, and live proof that a page naming
/// remote resources reaches nothing.
@MainActor
final class AidenSandboxedHTMLTests: XCTestCase {
    // MARK: Navigation

    func testPreviewNavigationAllowsOnlyItsOwnDocumentAndOffersTappedHttpsLinks() throws {
        func decide(
            _ raw: String,
            mainFrame: Bool? = true,
            tap: Bool = false,
            loaded: Bool = true
        ) -> AidenPreviewNavigation.Decision {
            AidenPreviewNavigation.decision(
                url: URL(string: raw),
                isMainFrame: mainFrame,
                isLinkTap: tap,
                hasLoaded: loaded
            )
        }

        // The document the view loads itself.
        XCTAssertEqual(decide("about:blank", loaded: false), .allow)
        // Once it has loaded, the page cannot replace itself.
        XCTAssertEqual(decide("about:blank"), .cancel)
        // A redirect the page triggers (meta refresh, `location =`) is not a tap.
        XCTAssertEqual(decide("https://example.com"), .cancel)
        XCTAssertEqual(decide("https://example.com", loaded: false), .cancel)

        // A tapped https link is offered, never followed.
        let link = try XCTUnwrap(URL(string: "https://example.com/a"))
        XCTAssertEqual(decide("https://example.com/a", tap: true), .offerLink(link))
        for refused in ["https://u:p@example.com", "javascript:alert(1)", "file:///etc/hosts", "http://example.com"] {
            XCTAssertEqual(decide(refused, tap: true), .cancel, refused)
        }
        XCTAssertEqual(decide("https://example.com/a", mainFrame: nil, tap: false), .cancel)
        XCTAssertEqual(decide("about:blank", mainFrame: nil, tap: false), .cancel)
        XCTAssertEqual(decide("https://example.com/a", mainFrame: nil, tap: true), .offerLink(link))
        XCTAssertEqual(decide("http://example.com", mainFrame: nil, tap: true), .cancel)

        // In-page anchors scroll instead of navigating.
        XCTAssertEqual(decide("about:blank%23notes", tap: true), .anchor("notes"))
        XCTAssertEqual(decide("about:blank#notes", tap: true), .anchor("notes"))

        // Subframes may hold inline documents only.
        XCTAssertEqual(decide("about:srcdoc", mainFrame: false), .allow)
        XCTAssertEqual(decide("about:blank", mainFrame: false), .allow)
        XCTAssertEqual(decide("https://example.com/frame", mainFrame: false), .cancel)
        XCTAssertEqual(decide("data:text/html,hi", mainFrame: false), .cancel)
        XCTAssertEqual(AidenPreviewNavigation.decision(url: nil, isMainFrame: true, isLinkTap: false, hasLoaded: false), .cancel)
    }

    // MARK: Network rules

    func testPreviewRulesBlockEveryNetworkScheme() throws {
        let data = try XCTUnwrap(AidenPreviewNetworkBlock.rulesJSON.data(using: .utf8))
        let rules = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(rules.count, 2)

        var filters: [String] = []
        for rule in rules {
            let action = try XCTUnwrap(rule["action"] as? [String: Any])
            XCTAssertEqual(action["type"] as? String, "block")
            let trigger = try XCTUnwrap(rule["trigger"] as? [String: Any])
            filters.append(try XCTUnwrap(trigger["url-filter"] as? String))
        }
        XCTAssertEqual(Set(filters), ["^https?://", "^wss?://"])

        let expressions = try filters.map { try NSRegularExpression(pattern: $0) }
        func blocked(_ address: String) -> Bool {
            expressions.contains { expression in
                expression.firstMatch(in: address, range: NSRange(address.startIndex..., in: address)) != nil
            }
        }
        for address in ["http://a", "https://a", "ws://a", "wss://a"] {
            XCTAssertTrue(blocked(address), address)
        }
        for address in ["about:blank", "about:srcdoc", "data:image/svg+xml,"] {
            XCTAssertFalse(blocked(address), address)
        }
    }

    // MARK: Live web view

    func testAPreviewPageMakesNoNetworkConnections() async throws {
        // One page per way of naming a remote resource, so a leak names its vector.
        for vector in Self.networkVectors {
            try await assertNoConnections(vector.name, body: vector.body)
        }
    }

    /// Control first: the page in a plain web view does reach the listener,
    /// so a zero from the sandbox means it blocked the load, not that nothing tried.
    private func assertNoConnections(_ name: String, body: (UInt16) -> String) async throws {
        let controlListener = try await LoopbackListener.start()
        let controlConnected = expectation(description: "\(name): control page connects to localhost")
        controlConnected.assertForOverFulfill = false
        controlListener.onAccept = { controlConnected.fulfill() }

        let controlConfiguration = WKWebViewConfiguration()
        controlConfiguration.websiteDataStore = .nonPersistent()
        let control = WKWebView(frame: .zero, configuration: controlConfiguration)
        try host(control)
        let clock = ContinuousClock()
        let controlStart = clock.now
        control.loadHTMLString(Self.page(body(controlListener.port)), baseURL: nil)
        await fulfillment(of: [controlConnected], timeout: 10)
        let controlTook = clock.now - controlStart
        control.stopLoading()
        controlListener.stop()

        // Sandboxed: nothing connects, for as long as the control needed and more.
        let listener = try await LoopbackListener.start()
        let connected = expectation(description: "\(name): sandboxed page connects")
        connected.isInverted = true
        connected.assertForOverFulfill = false
        listener.onAccept = { connected.fulfill() }

        let finished = expectation(description: "\(name): sandboxed page finishes loading")
        let (webView, _) = try showSandboxed(Self.page(body(listener.port)), allowsScripts: true, onFinish: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 10)
        // The page's scripts did run; they were stopped at the network, not before it.
        let ran = try await webView.callAsyncJavaScript(
            "return document.documentElement.dataset.ran ?? null",
            contentWorld: .page
        ) as? String
        XCTAssertEqual(ran, "1", name)

        let wait = Double(controlTook.components.seconds) + Double(controlTook.components.attoseconds) / 1e18 + 2
        await fulfillment(of: [connected], timeout: wait)
        XCTAssertEqual(listener.accepted, 0, "\(name) reached the network")
        listener.stop()
        webView.stopLoading()
    }

    func testPreviewPagesCannotOpenWebRTCConnections() async throws {
        let page = """
        <!doctype html><html><body><p>main</p>\
        <iframe srcdoc="<p>child</p>"></iframe></body></html>
        """
        // The main frame, the srcdoc iframe, and a frame the page creates
        // itself afterwards to fetch a fresh copy of the constructor.
        let probe = """
        const made = document.createElement('iframe');
        document.body.appendChild(made);
        return [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof RTCDataChannel,
                typeof frames[0].RTCPeerConnection, typeof frames[0].webkitRTCPeerConnection,
                typeof frames[0].RTCDataChannel, typeof made.contentWindow.RTCPeerConnection,
                typeof WebTransport, typeof made.contentWindow.WebTransport]
        """

        // Control: WebRTC exists in a plain web view, so "undefined" below is the sandbox's doing.
        let controlConfiguration = WKWebViewConfiguration()
        controlConfiguration.websiteDataStore = .nonPersistent()
        let control = WKWebView(frame: .zero, configuration: controlConfiguration)
        let controlWaiter = FinishWaiter(expectation(description: "control finishes"))
        control.navigationDelegate = controlWaiter
        try host(control)
        control.loadHTMLString(page, baseURL: nil)
        await fulfillment(of: [controlWaiter.finished], timeout: 10)
        let controlTypes = try await control.callAsyncJavaScript(probe, contentWorld: .page) as? [String]
        XCTAssertEqual(controlTypes?.first, "function")
        XCTAssertEqual(controlTypes?[6], "function")

        let finished = expectation(description: "sandboxed page finishes loading")
        let (webView, _) = try showSandboxed(page, allowsScripts: true, onFinish: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 10)
        let types = try await webView.callAsyncJavaScript(probe, contentWorld: .page) as? [String]
        XCTAssertEqual(types, Array(repeating: "undefined", count: 9))
    }


    // MARK: Link offers

    func testLinkOffersNeedARecentTouchAndAdmitOneOfferPerTouch() {
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        var gate = AidenLinkOfferGate()
        XCTAssertFalse(gate.admit(at: start), "no touch yet")

        gate.userInteracted(at: start)
        XCTAssertTrue(gate.admit(at: start.addingTimeInterval(0.4)))
        XCTAssertFalse(gate.admit(at: start.addingTimeInterval(0.5)), "the same touch offers once")

        gate.userInteracted(at: start.addingTimeInterval(10))
        XCTAssertFalse(gate.admit(at: start.addingTimeInterval(11.5)), "the touch is too old")
        XCTAssertFalse(gate.admit(at: start.addingTimeInterval(11.6)))
    }

    func testOnlyATapOpensTheGateNotAScrollOrDrag() {
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        var gate = AidenLinkOfferGate()

        // A drag that comes back to where it started is still not a tap.
        gate.touchBegan(at: CGPoint(x: 100, y: 300))
        gate.touchMoved(to: CGPoint(x: 100, y: 200))
        XCTAssertFalse(gate.touchEnded(at: CGPoint(x: 100, y: 300), time: start))
        XCTAssertFalse(gate.admit(at: start.addingTimeInterval(0.2)), "a scroll must not open the gate")

        // A cancelled touch (WebKit or the system took it) is not a tap.
        gate.touchBegan(at: CGPoint(x: 100, y: 300))
        gate.touchCancelled()
        XCTAssertFalse(gate.touchEnded(at: CGPoint(x: 100, y: 300), time: start))
        XCTAssertFalse(gate.admit(at: start.addingTimeInterval(0.3)))

        // A tap that wobbles a few points is a tap.
        gate.touchBegan(at: CGPoint(x: 100, y: 300))
        gate.touchMoved(to: CGPoint(x: 104, y: 303))
        XCTAssertTrue(gate.touchEnded(at: CGPoint(x: 103, y: 304), time: start))
        XCTAssertTrue(gate.admit(at: start.addingTimeInterval(0.2)))
    }

    func testTouchlessLinkOffersAreSpacedOutAndCappedPerDocument() {
        let start = Date(timeIntervalSinceReferenceDate: 1_000)
        var gate = AidenLinkOfferGate()
        func admit(after seconds: TimeInterval) -> Bool {
            gate.admit(at: start.addingTimeInterval(seconds), touchlessActivationPossible: true)
        }
        XCTAssertTrue(admit(after: 0))
        XCTAssertFalse(admit(after: 1.9), "too soon after the last offer")
        XCTAssertTrue(admit(after: 2.1))
        XCTAssertFalse(admit(after: 2.2))
        XCTAssertTrue(admit(after: 4.5))
        // Three unprompted offers per document, however patient the page is.
        XCTAssertFalse(admit(after: 10))
        XCTAssertFalse(admit(after: 100))

        // A real tap still gets through after the cap.
        gate.userInteracted(at: start.addingTimeInterval(200))
        XCTAssertTrue(admit(after: 200.5))

        // A new document starts a fresh allowance.
        gate.documentDidLoad()
        XCTAssertTrue(admit(after: 300))
    }

    func testScriptedLinkClicksOfferNothingWithoutATouch() async throws {
        let page = """
        <!doctype html><html><body>\
        <a id="same" href="https://example.com/same">same</a>\
        <a id="blank" target="_blank" href="https://example.com/blank">blank</a>\
        </body></html>
        """
        let clicks = "for (let i = 0; i < 5; i++) { same.click(); blank.click(); }"
        var offers: [URL] = []
        let finished = expectation(description: "page finishes loading")
        let offered = expectation(description: "a link is offered")
        offered.isInverted = true
        offered.assertForOverFulfill = false
        var onOffer: (URL) -> Void = { _ in offered.fulfill() }
        let (webView, coordinator) = try showSandboxed(
            page,
            allowsScripts: true,
            onFinish: { finished.fulfill() },
            onLinkOffer: { url in
                offers.append(url)
                onOffer(url)
            }
        )
        // No keyboard or assistive technology: only a tap can open the gate.
        coordinator.touchlessActivationPossible = { false }
        await fulfillment(of: [finished], timeout: 10)

        // No touch: ten scripted clicks reach nobody.
        _ = try await webView.callAsyncJavaScript(clicks, contentWorld: .page)
        await fulfillment(of: [offered], timeout: 1.5)
        XCTAssertEqual(offers, [])

        // After a touch, the same burst produces exactly one offer.
        let offeredOnce = expectation(description: "one link is offered")
        offeredOnce.assertForOverFulfill = false
        onOffer = { _ in offeredOnce.fulfill() }
        coordinator.userInteracted()
        _ = try await webView.callAsyncJavaScript(clicks, contentWorld: .page)
        await fulfillment(of: [offeredOnce], timeout: 5)
        let settle = expectation(description: "settle")
        settle.isInverted = true
        await fulfillment(of: [settle], timeout: 1)
        // Which of the two scripted paths wins the one offer is not ordered.
        XCTAssertEqual(offers.count, 1)
        XCTAssertTrue(
            Set(["https://example.com/same", "https://example.com/blank"]).contains(offers.first?.absoluteString ?? ""),
            "\(offers)"
        )
    }

    // MARK: Theme

    func testPreviewThemeCarriesTheAidenPaletteAsLowPriorityVariables() throws {
        let css = AidenHTMLPreviewTheme.css(
            palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light),
            colorScheme: .light,
            uiFont: .system,
            codeFont: .sfMono,
            bodySize: 16
        )
        // Aiden light, as the catalog defines it.
        XCTAssertTrue(css.contains("--surface-background:#F6F7F9"), css)
        XCTAssertTrue(css.contains("--accent:#006AD6"), css)
        XCTAssertTrue(css.contains("--text-primary:#3D3F41"), css)
        XCTAssertTrue(css.contains("--border-separator:rgb(61 63 65 / 0.087)"), css)
        XCTAssertTrue(css.contains("color-scheme:light"), css)
        XCTAssertTrue(css.contains("font-size:16.0px"), css)

        // Every rule has zero specificity, so any rule of the page's own wins.
        let selectors = Self.selectors(in: css)
        XCTAssertGreaterThanOrEqual(selectors.count, 4, css)
        for selector in selectors {
            XCTAssertTrue(selector.hasPrefix(":where(") && selector.hasSuffix(")"), "unwrapped selector: \(selector)")
        }
    }

    func testDarkSchemeAndFontsChangeTheTheme() {
        let dark = AidenHTMLPreviewTheme.css(
            palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .dark),
            colorScheme: .dark,
            uiFont: .rounded,
            codeFont: .menlo,
            bodySize: 19
        )
        XCTAssertTrue(dark.contains("color-scheme:dark"), dark)
        XCTAssertFalse(dark.contains("color-scheme:light"), dark)
        XCTAssertTrue(dark.contains("--surface-background:#181B21"), dark)
        XCTAssertTrue(dark.contains("--font-ui-family:ui-rounded"), dark)
        XCTAssertTrue(dark.contains("--font-code-family:Menlo"), dark)
        XCTAssertTrue(dark.contains("--ui-font-size:19.0px"), dark)

        let humanist = AidenHTMLPreviewTheme.css(
            palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light),
            colorScheme: .light,
            uiFont: .humanist,
            codeFont: .monaco,
            bodySize: 16
        )
        XCTAssertTrue(humanist.contains("--font-ui-family:\"Avenir Next\""), humanist)
        XCTAssertTrue(humanist.contains("--font-code-family:Monaco"), humanist)
    }

    func testThemeStylesAnUnstyledPageAndThePagesOwnRulesWin() async throws {
        let css = AidenHTMLPreviewTheme.css(
            palette: AidenThemeCatalog.palette(preset: .aiden, scheme: .light),
            colorScheme: .light,
            uiFont: .system,
            codeFont: .sfMono,
            bodySize: 16
        )
        let probe = """
        const style = (element) => getComputedStyle(element);
        const p = document.querySelector('p');
        return [style(document.documentElement).backgroundColor, style(document.body).backgroundColor,
                style(document.body).color, style(p).color, style(document.body).fontSize,
                style(document.body).paddingTop, style(document.querySelector('a')).color]
        """
        let page = "<!doctype html><html><body><p>plain</p><a href=\"#x\">link</a></body></html>"

        // Unstyled: the canvas behind the page, the palette's text, Aiden's body size.
        let finished = expectation(description: "unstyled page finishes")
        let (plain, _) = try showSandboxed(page, allowsScripts: false, themeCSS: css, onFinish: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 10)
        let plainStyles = try await plain.callAsyncJavaScript(probe, contentWorld: .defaultClient) as? [String]
        XCTAssertEqual(plainStyles, [
            "rgb(246, 247, 249)", "rgba(0, 0, 0, 0)", "rgb(61, 63, 65)", "rgb(61, 63, 65)",
            "16px", "16px", "rgb(0, 106, 214)",
        ])

        // The page's own rules, even bare element selectors, beat the theme.
        let styled = """
        <!doctype html><html><head><style>html{background:rgb(9, 9, 9)}\
        body{background:rgb(1, 2, 3);padding:0;font-size:10px}p{color:rgb(4, 5, 6)}a{color:rgb(7, 8, 9)}</style>\
        </head><body><p>plain</p><a href="#x">link</a></body></html>
        """
        let styledFinished = expectation(description: "styled page finishes")
        let (own, _) = try showSandboxed(styled, allowsScripts: false, themeCSS: css, onFinish: { styledFinished.fulfill() })
        await fulfillment(of: [styledFinished], timeout: 10)
        let ownStyles = try await own.callAsyncJavaScript(probe, contentWorld: .defaultClient) as? [String]
        XCTAssertEqual(ownStyles, [
            "rgb(9, 9, 9)", "rgb(1, 2, 3)", "rgb(61, 63, 65)", "rgb(4, 5, 6)",
            "10px", "0px", "rgb(7, 8, 9)",
        ])
    }

    // MARK: Workspace files

    func testHtmlWorkspaceFilesOpenOnPreviewUnlessTruncated() {
        func document(_ path: String, truncated: Bool = false) -> AidenWorkspaceFileDocument {
            AidenWorkspaceFileDocument(
                id: path, displayPath: path, content: "<p>hi</p>", version: "1",
                truncated: truncated, warning: nil
            )
        }

        let report = document("site/report.html")
        XCTAssertTrue(AidenWorkspaceHTMLPreview.canPreview(report))
        XCTAssertEqual(AidenWorkspaceHTMLPreview.initialMode(for: report), .preview)

        let upper = document("Report.HTM")
        XCTAssertTrue(AidenWorkspaceHTMLPreview.isHTML(upper.displayPath))
        XCTAssertEqual(AidenWorkspaceHTMLPreview.initialMode(for: upper), .preview)

        let notes = document("notes.md")
        XCTAssertFalse(AidenWorkspaceHTMLPreview.isHTML(notes.displayPath))
        XCTAssertFalse(AidenWorkspaceHTMLPreview.canPreview(notes))
        XCTAssertEqual(AidenWorkspaceHTMLPreview.initialMode(for: notes), .source)

        // Over the size cap: half a page must not pass for the whole one.
        let big = document("big.html", truncated: true)
        XCTAssertTrue(AidenWorkspaceHTMLPreview.isHTML(big.displayPath))
        XCTAssertFalse(AidenWorkspaceHTMLPreview.canPreview(big))
        XCTAssertEqual(AidenWorkspaceHTMLPreview.initialMode(for: big), .source)

        let bare = document("html")
        XCTAssertFalse(AidenWorkspaceHTMLPreview.isHTML(bare.displayPath))
        XCTAssertEqual(AidenWorkspaceHTMLPreview.initialMode(for: bare), .source)
    }

    /// The selector list before each `{`, split at top-level commas.
    private static func selectors(in css: String) -> [String] {
        var result: [String] = []
        for chunk in css.components(separatedBy: "{").dropLast() {
            let prelude = chunk.components(separatedBy: "}").last ?? chunk
            var depth = 0
            var current = ""
            for character in prelude {
                switch character {
                case "(": depth += 1
                case ")": depth -= 1
                case "," where depth == 0:
                    result.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
                    current = ""
                    continue
                default: break
                }
                current.append(character)
            }
            result.append(current.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return result
    }

    // MARK: Helpers

    /// Every way a page can name a remote resource, each pointing at the listener.
    private static let networkVectors: [(name: String, body: (UInt16) -> String)] = [
        ("img and stylesheet", { port in
            "<link rel=\"stylesheet\" href=\"http://localhost:\(port)/s.css\"><img src=\"http://localhost:\(port)/i.png\">"
        }),
        // dns-prefetch cannot be seen by a TCP listener and WebTransport is
        // not exposed on this iOS; they ride along with fetch and WebSocket.
        ("fetch, WebSocket, WebTransport, dns-prefetch", { port in
            """
            <link rel="dns-prefetch" href="//localhost">
            <script>fetch('http://localhost:\(port)/f');new WebSocket('ws://localhost:\(port)/w');
            try { new WebTransport('https://localhost:\(port)/wt') } catch (_) {}</script>
            """
        }),
        ("meta refresh", { port in "<meta http-equiv=\"refresh\" content=\"0;url=http://localhost:\(port)/r\">" }),
        ("preconnect http", { port in "<link rel=\"preconnect\" href=\"http://localhost:\(port)\">" }),
        ("preconnect https", { port in "<link rel=\"preconnect\" href=\"https://localhost:\(port)\">" }),
        ("video", { port in "<video preload=\"auto\" src=\"http://localhost:\(port)/v.mp4\" muted playsinline></video>" }),
        ("audio", { port in "<audio preload=\"auto\" src=\"http://localhost:\(port)/a.mp3\"></audio>" }),
    ]

    private static func page(_ body: String) -> String {
        """
        <!doctype html><html><head></head><body>
        <script>document.documentElement.dataset.ran = '1'</script>
        \(body)
        <p>preview</p>
        </body></html>
        """
    }

    /// Builds the preview exactly as `makeUIView` does, in a window.
    private func showSandboxed(
        _ html: String,
        allowsScripts: Bool,
        themeCSS: String? = nil,
        onFinish: @escaping () -> Void,
        onLinkOffer: @escaping (URL) -> Void = { _ in }
    ) throws -> (WKWebView, AidenSandboxedHTMLCoordinator) {
        let view = AidenSandboxedHTMLView(
            html: html,
            allowsScripts: allowsScripts,
            themeCSS: themeCSS,
            scrolls: true,
            onLinkOffer: onLinkOffer,
            onFailure: { XCTFail("preview failed") }
        )
        let coordinator = view.makeCoordinator()
        coordinator.onDidFinish = onFinish
        let webView = view.makeWebView(coordinator: coordinator)
        try host(webView)
        coordinator.start(html, in: webView)
        addTeardownBlock { @MainActor in _ = coordinator }
        return (webView, coordinator)
    }

    private func host(_ webView: WKWebView) throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        let controller = UIViewController()
        window.rootViewController = controller
        webView.frame = controller.view.bounds
        controller.view.addSubview(webView)
        window.isHidden = false
        addTeardownBlock { @MainActor in
            webView.stopLoading()
            webView.removeFromSuperview()
            window.isHidden = true
        }
    }
}

/// A TCP listener on an ephemeral loopback port that counts accepted connections.
@MainActor
private final class LoopbackListener {
    private let listener: NWListener
    private(set) var accepted = 0
    var onAccept: (() -> Void)?

    var port: UInt16 { listener.port?.rawValue ?? 0 }

    private init(listener: NWListener) {
        self.listener = listener
    }

    static func start() async throws -> LoopbackListener {
        let listener = try NWListener(using: .tcp, on: .any)
        let box = LoopbackListener(listener: listener)
        listener.newConnectionHandler = { connection in
            MainActor.assumeIsolated {
                box.accepted += 1
                box.onAccept?()
            }
            connection.cancel()
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let once = ResumeOnce()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.claim() { continuation.resume() }
                case let .failed(error):
                    if once.claim() { continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            listener.start(queue: .main)
        }
        return box
    }

    func stop() {
        onAccept = nil
        listener.cancel()
    }
}

/// The listener reports state on the main queue; this keeps the
/// continuation from resuming twice.
private final class ResumeOnce: @unchecked Sendable {
    private var claimed = false

    func claim() -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        defer { claimed = true }
        return !claimed
    }
}

@MainActor
private final class FinishWaiter: NSObject, WKNavigationDelegate {
    let finished: XCTestExpectation

    init(_ finished: XCTestExpectation) {
        self.finished = finished
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finished.fulfill()
    }
}
