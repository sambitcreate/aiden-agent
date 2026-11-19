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
        // Control: the same page in a plain web view does reach the listener,
        // so a zero below means the sandbox blocked it, not that nothing tried.
        let controlListener = try await LoopbackListener.start()
        let controlConnected = expectation(description: "control page connects to localhost")
        controlConnected.assertForOverFulfill = false
        controlListener.onAccept = { controlConnected.fulfill() }

        let controlConfiguration = WKWebViewConfiguration()
        controlConfiguration.websiteDataStore = .nonPersistent()
        let control = WKWebView(frame: .zero, configuration: controlConfiguration)
        try host(control)
        let clock = ContinuousClock()
        let controlStart = clock.now
        control.loadHTMLString(Self.remotePage(port: controlListener.port), baseURL: nil)
        await fulfillment(of: [controlConnected], timeout: 10)
        let controlTook = clock.now - controlStart
        control.stopLoading()
        controlListener.stop()

        // Sandboxed: nothing connects, for as long as the control needed and more.
        let listener = try await LoopbackListener.start()
        let connected = expectation(description: "sandboxed page connects")
        connected.isInverted = true
        connected.assertForOverFulfill = false
        listener.onAccept = { connected.fulfill() }

        let finished = expectation(description: "sandboxed page finishes loading")
        let page = Self.remotePage(port: listener.port)
        let webView = try showSandboxed(page, allowsScripts: true, onFinish: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 10)
        // The page's scripts did run; they were stopped at the network, not before it.
        let ran = try await webView.callAsyncJavaScript(
            "return document.documentElement.dataset.ran ?? null",
            contentWorld: .page
        ) as? String
        XCTAssertEqual(ran, "1")

        let wait = Double(controlTook.components.seconds) + Double(controlTook.components.attoseconds) / 1e18 + 2
        await fulfillment(of: [connected], timeout: wait)
        XCTAssertEqual(listener.accepted, 0)
        listener.stop()
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
                typeof frames[0].RTCDataChannel, typeof made.contentWindow.RTCPeerConnection]
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
        XCTAssertEqual(controlTypes?.last, "function")

        let finished = expectation(description: "sandboxed page finishes loading")
        let webView = try showSandboxed(page, allowsScripts: true, onFinish: { finished.fulfill() })
        await fulfillment(of: [finished], timeout: 10)
        let types = try await webView.callAsyncJavaScript(probe, contentWorld: .page) as? [String]
        XCTAssertEqual(types, Array(repeating: "undefined", count: 7))
    }


    // MARK: Helpers

    /// Every way a page can name a remote resource, all pointing at the listener.
    private static func remotePage(port: UInt16) -> String {
        let origin = "http://localhost:\(port)"
        return """
        <!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=\(origin)/r">
        <link rel="stylesheet" href="\(origin)/s.css">
        </head><body>
        <script>document.documentElement.dataset.ran = '1'</script>
        <img src="\(origin)/i.png">
        <script>fetch('\(origin)/f');new WebSocket('ws://localhost:\(port)/w')</script>
        </body></html>
        """
    }

    /// Builds the preview exactly as `makeUIView` does, in a window.
    private func showSandboxed(
        _ html: String,
        allowsScripts: Bool,
        onFinish: @escaping () -> Void
    ) throws -> WKWebView {
        let view = AidenSandboxedHTMLView(
            html: html,
            allowsScripts: allowsScripts,
            themeCSS: nil,
            scrolls: true,
            onLinkOffer: { _ in },
            onFailure: { XCTFail("preview failed") }
        )
        let coordinator = view.makeCoordinator()
        coordinator.onDidFinish = onFinish
        let webView = view.makeWebView(coordinator: coordinator)
        try host(webView)
        coordinator.start(html, in: webView)
        addTeardownBlock { @MainActor in _ = coordinator }
        return webView
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
