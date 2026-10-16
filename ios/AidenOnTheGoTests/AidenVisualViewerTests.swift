import Foundation
import XCTest
@testable import AidenOnTheGo

/// Revision 34 (`chat-visual-viewer-v1`): the viewer's message channel, its
/// navigation lock, the offline copy and the host feature gate.
final class AidenVisualViewerTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        super.setUp()
        root = FileManager.default.temporaryDirectory.appending(path: "aiden-visual-viewer-\(UUID())")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root)
        super.tearDown()
    }

    // MARK: Messages

    func testViewerAcceptsTheThreeMessageTypes() {
        XCTAssertEqual(AidenVisualViewerMessage.parse(["type": "ready"]), .ready)
        XCTAssertEqual(
            AidenVisualViewerMessage.parse(["type": "prompt", "text": "  Break Q3 down by month\n"]),
            .prompt("Break Q3 down by month")
        )
        XCTAssertEqual(
            AidenVisualViewerMessage.parse(["type": "openUrl", "url": "https://example.com/report?q=1#top"]),
            .openURL(URL(string: "https://example.com/report?q=1#top")!)
        )
        // A bridged JavaScript object arrives as an NSDictionary.
        let bridged: NSDictionary = ["type": "prompt", "text": "Compare regions"]
        XCTAssertEqual(AidenVisualViewerMessage.parse(bridged), .prompt("Compare regions"))
    }

    func testViewerIgnoresUnknownAndMalformedMessages() {
        let ignored: [Any] = [
            "ready",
            ["kind": "ready"] as [String: Any],
            ["type": "READY"] as [String: Any],
            ["type": "sendPrompt", "text": "Hi"] as [String: Any],
            ["type": "navigate", "url": "https://example.com"] as [String: Any],
            ["type": "prompt"] as [String: Any],
            ["type": "prompt", "text": 42] as [String: Any],
            ["type": "prompt", "text": ["Hi"]] as [String: Any],
            ["type": "prompt", "text": " \n\t "] as [String: Any],
            ["type": "prompt", "text": String(repeating: "a", count: 2_001)] as [String: Any],
            ["type": "openUrl"] as [String: Any],
            ["type": "openUrl", "url": 7] as [String: Any],
            ["type": 1] as [String: Any],
        ]
        for message in ignored {
            XCTAssertNil(AidenVisualViewerMessage.parse(message), "\(message)")
        }
        // The page's own 2,000-character bound is accepted as is.
        let longest = String(repeating: "a", count: 2_000)
        XCTAssertEqual(AidenVisualViewerMessage.parse(["type": "prompt", "text": longest]), .prompt(longest))
    }

    func testOnlyHttpsLinksWithoutCredentialsCanBeOffered() {
        let refused = [
            "http://example.com",
            "javascript:alert(1)",
            "file:///etc/hosts",
            "data:text/html,<p>hi</p>",
            "aiden-otg://chat/1",
            "about:blank",
            "https://user@example.com/",
            "https://user:secret@example.com/",
            "https:///no-host",
            "/relative/path",
            "https://example.com/ spaced",
            "https://example.com/\u{202e}",
            "https://example.com/" + String(repeating: "a", count: 2_048),
            "",
        ]
        for raw in refused {
            XCTAssertNil(AidenVisualViewerMessage.parse(["type": "openUrl", "url": raw]), raw)
        }
        XCTAssertNotNil(AidenVisualViewerMessage.externalURL("HTTPS://Example.com/a"), "The scheme is case-insensitive.")
    }

    func testConfirmedPromptFollowsTheExistingDraft() {
        XCTAssertEqual(AidenVisualViewerMessage.draft(appending: "Show Q3", to: ""), "Show Q3")
        XCTAssertEqual(AidenVisualViewerMessage.draft(appending: "Show Q3", to: " \n"), "Show Q3")
        XCTAssertEqual(
            AidenVisualViewerMessage.draft(appending: "Show Q3", to: "Compare regions\n\n"),
            "Compare regions\n\nShow Q3"
        )
    }

    // MARK: Navigation

    func testOnlyTheViewersOwnDocumentAndItsFramesMayLoad() {
        var policy = AidenVisualNavigationPolicy()
        let blank = URL(string: "about:blank")!
        let srcdoc = URL(string: "about:srcdoc")!

        XCTAssertFalse(policy.allows(url: URL(string: "https://example.com")!, targetIsMainFrame: true))
        XCTAssertTrue(policy.allows(url: blank, targetIsMainFrame: true), "The loadHTMLString document")
        XCTAssertFalse(policy.allows(url: blank, targetIsMainFrame: true), "A second top-level load is refused")
        XCTAssertTrue(policy.allows(url: srcdoc, targetIsMainFrame: false), "The visual's sandboxed frame")
        XCTAssertTrue(policy.allows(url: blank, targetIsMainFrame: false))
        XCTAssertFalse(policy.allows(url: URL(string: "https://example.com")!, targetIsMainFrame: false))
        XCTAssertFalse(policy.allows(url: URL(string: "data:text/html,hi")!, targetIsMainFrame: false))
        XCTAssertFalse(policy.allows(url: srcdoc, targetIsMainFrame: true))
        XCTAssertFalse(policy.allows(url: srcdoc, targetIsMainFrame: nil), "New windows are refused")
        XCTAssertFalse(policy.allows(url: nil, targetIsMainFrame: false))
    }

    // MARK: Offline copy

    func testCachedCopyIsKeptPerHostDeviceChatVisualSchemeAndTheme() async {
        let cache = AidenVisualDocumentCache(root: root)
        let key = makeKey(visualId: "visual-1")
        let stored = await cache.store("<p>Revenue</p>", for: key)
        XCTAssertTrue(stored)

        // A fresh cache over the same folder finds it under the same key.
        let reopened = AidenVisualDocumentCache(root: root)
        let reloaded = await reopened.load(makeKey(visualId: "visual-1"))
        XCTAssertEqual(reloaded, "<p>Revenue</p>")

        let neighbours = [
            makeKey(instanceId: "instance-2", visualId: "visual-1"),
            makeKey(deviceId: "device-2", visualId: "visual-1"),
            makeKey(chatId: "chat-2", visualId: "visual-1"),
            makeKey(visualId: "visual-2"),
            makeKey(visualId: "visual-1", scheme: .dark),
            makeKey(visualId: "visual-1", theme: .berry),
            // Joined parts never collide by moving characters between ids.
            makeKey(chatId: "chat-1v", visualId: "isual-1"),
        ]
        for neighbour in neighbours {
            let found = await reopened.load(neighbour)
            XCTAssertNil(found, "\(neighbour)")
            XCTAssertNotEqual(neighbour.fileName, key.fileName)
        }
        XCTAssertFalse(key.fileName.contains("visual-1"), "No id reaches the file system.")
        XCTAssertFalse(key.fileName.contains("chat-1"))
    }

    func testLeastRecentlyUsedCopiesAreEvictedFirst() async {
        let clock = AidenVisualTestClock()
        let cache = AidenVisualDocumentCache(root: root, maximumFiles: 3, now: { clock.tick() })
        for id in ["a", "b", "c"] {
            await cache.store("<p>\(id)</p>", for: makeKey(visualId: id))
        }
        // Opening `a` makes `b` the least recently used.
        let opened = await cache.load(makeKey(visualId: "a"))
        XCTAssertEqual(opened, "<p>a</p>")
        await cache.store("<p>d</p>", for: makeKey(visualId: "d"))

        let b = await cache.load(makeKey(visualId: "b"))
        XCTAssertNil(b)
        for id in ["a", "c", "d"] {
            let kept = await cache.load(makeKey(visualId: id))
            XCTAssertEqual(kept, "<p>\(id)</p>")
        }
    }

    func testByteBudgetEvictsAcrossHostsButKeepsTheNewestCopy() async {
        let clock = AidenVisualTestClock()
        let cache = AidenVisualDocumentCache(root: root, maximumFiles: 20, maximumBytes: 250, now: { clock.tick() })
        let hundred = String(repeating: "x", count: 100)
        await cache.store(hundred, for: makeKey(instanceId: "instance-1", visualId: "old"))
        await cache.store(hundred, for: makeKey(instanceId: "instance-2", visualId: "middle"))
        await cache.store(hundred, for: makeKey(instanceId: "instance-1", visualId: "new"))

        let old = await cache.load(makeKey(instanceId: "instance-1", visualId: "old"))
        let middle = await cache.load(makeKey(instanceId: "instance-2", visualId: "middle"))
        let new = await cache.load(makeKey(instanceId: "instance-1", visualId: "new"))
        XCTAssertNil(old)
        XCTAssertEqual(middle, hundred)
        XCTAssertEqual(new, hundred)

        let tooLarge = await cache.store(String(repeating: "y", count: 251), for: makeKey(visualId: "huge"))
        XCTAssertFalse(tooLarge, "A document larger than the whole budget is not kept.")
    }

    func testPurgeForgetsOnlyThatMacsCopies() async {
        let cache = AidenVisualDocumentCache(root: root)
        await cache.store("<p>1</p>", for: makeKey(instanceId: "instance-1", visualId: "v"))
        await cache.store("<p>2</p>", for: makeKey(instanceId: "instance-2", visualId: "v"))
        await cache.purge(instanceId: "instance-1")
        let purged = await cache.load(makeKey(instanceId: "instance-1", visualId: "v"))
        let kept = await cache.load(makeKey(instanceId: "instance-2", visualId: "v"))
        XCTAssertNil(purged)
        XCTAssertEqual(kept, "<p>2</p>")
    }

    func testOnlyAnUnreachableOrFailingMacFallsBackToTheCachedCopy() throws {
        XCTAssertTrue(AidenVisualDocumentLoad.fallsBackToCache(after: URLError(.notConnectedToInternet)))
        XCTAssertTrue(AidenVisualDocumentLoad.fallsBackToCache(after: URLError(.timedOut)))
        XCTAssertTrue(AidenVisualDocumentLoad.fallsBackToCache(after: AidenRemoteClientError.unexpectedStatus(502)))
        XCTAssertTrue(AidenVisualDocumentLoad.fallsBackToCache(after: try serverError(503, code: "internal_error")))

        XCTAssertFalse(AidenVisualDocumentLoad.fallsBackToCache(after: try serverError(404, code: "not_found")))
        XCTAssertFalse(AidenVisualDocumentLoad.fallsBackToCache(after: try serverError(400, code: "invalid_request")))
        XCTAssertFalse(AidenVisualDocumentLoad.fallsBackToCache(after: AidenRemoteClientError.invalidResponse))
        XCTAssertFalse(AidenVisualDocumentLoad.fallsBackToCache(after: AidenRemoteClientError.missingCredential))
        XCTAssertFalse(AidenVisualDocumentLoad.fallsBackToCache(after: CancellationError()))

        XCTAssertNotEqual(
            AidenVisualDocumentLoad.failureMessage(for: try serverError(404, code: "not_found")),
            AidenVisualDocumentLoad.failureMessage(for: URLError(.notConnectedToInternet)),
            "A visual gone from the Mac reads differently from a Mac that can't be reached."
        )
    }

    // MARK: Feature gate

    func testServerAnnouncesTheViewerOnlyWithItsToken() throws {
        let announcing = try decodeServer(features: ["chat-visuals-v1", "chat-visual-viewer-v1"])
        XCTAssertTrue(announcing.supportsChatVisualViewer)
        let older = try decodeServer(features: ["chat-visuals-v1"])
        XCTAssertFalse(older.supportsChatVisualViewer)
        let legacy = try decodeServer(features: nil)
        XCTAssertFalse(legacy.supportsChatVisualViewer)
    }

    func testTapOpensTheViewerOnlyWhenTheMacAnnouncesIt() {
        XCTAssertEqual(AidenVisualRowAction.resolve(viewerAvailable: true, hasSnapshot: true), .openInteractive)
        XCTAssertEqual(AidenVisualRowAction.resolve(viewerAvailable: true, hasSnapshot: false), .openInteractive)
        XCTAssertEqual(AidenVisualRowAction.resolve(viewerAvailable: false, hasSnapshot: true), .viewImage)
        XCTAssertEqual(AidenVisualRowAction.resolve(viewerAvailable: false, hasSnapshot: false), .textOnly)
    }

    // MARK: Helpers

    private func makeKey(
        instanceId: String = "instance-1",
        deviceId: String = "device-1",
        chatId: String = "chat-1",
        visualId: String,
        scheme: AidenVisualViewerScheme = .light,
        theme: AidenThemePresetID = .aiden
    ) -> AidenVisualDocumentCache.Key {
        AidenVisualDocumentCache.Key(
            instanceId: instanceId,
            deviceId: deviceId,
            chatId: chatId,
            visualId: visualId,
            appearance: AidenVisualViewerAppearance(scheme: scheme, theme: theme)
        )
    }

    private func serverError(_ status: Int, code: String) throws -> AidenRemoteClientError {
        let envelope = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"\#(code)","message":"Failed","requestId":"request-1","retryable":false}}"#.utf8)
        )
        return .server(statusCode: status, body: envelope.error)
    }

    private func decodeServer(features: [String]?) throws -> AidenServer {
        var object: [String: Any] = [
            "protocolVersion": 1,
            "instanceId": "instance-1",
            "name": "Mac",
            "appVersion": "1.0",
            "capabilities": ["server:read", "chat:read"],
            "connectionMode": "lan",
            "serverTime": "2026-10-16T12:00:00Z",
        ]
        if let features { object["features"] = features }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try AidenRemoteJSONDecoder.decode(AidenServer.self, from: data)
    }
}

/// A clock that moves one minute per reading, so least-recently-used order
/// never depends on file-system timestamp resolution.
private final class AidenVisualTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)

    func tick() -> Date {
        lock.withLock {
            current = current.addingTimeInterval(60)
            return current
        }
    }
}
