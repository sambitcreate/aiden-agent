import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import AidenOnTheGo

/// Contract revision 25 (`mobile-simulators-v1`): the phone simulator viewer's
/// wire shapes, MJPEG parsing, helper messages and viewer state.
final class AidenSimulatorViewerTests: XCTestCase {
    override func tearDown() {
        AidenSimulatorMockURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: Fixture

    private func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(root["mobileSimulators"] as? [String: Any])
    }

    private func fixtureData(_ key: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture()[key]))
    }

    private func mjpegFixture() throws -> [String: Any] {
        try XCTUnwrap(fixture()["mjpeg"] as? [String: Any])
    }

    private func base64(_ value: Any?) throws -> Data {
        try XCTUnwrap(Data(base64Encoded: XCTUnwrap(value as? String)))
    }

    private func base64List(_ value: Any?) throws -> [Data] {
        try XCTUnwrap(value as? [String]).map { try XCTUnwrap(Data(base64Encoded: $0)) }
    }

    private func screen(from value: Any?) throws -> AidenSimulatorScreenConfig? {
        guard let record = value as? [String: Any] else { return nil }
        return AidenSimulatorScreenConfig(
            width: try XCTUnwrap(record["width"] as? Double),
            height: try XCTUnwrap(record["height"] as? Double),
            orientation: try XCTUnwrap(AidenSimulatorOrientation(rawValue: XCTUnwrap(record["orientation"] as? String)))
        )
    }

    // MARK: MJPEG

    private func parse(_ chunks: [Data], boundary: String) throws -> [Data] {
        var parser = AidenMJPEGMultipartParser(boundary: boundary)
        return try chunks.flatMap { try parser.append($0) }
    }

    func testMJPEGParserEmitsExactlyTheFixtureFramesHoweverTheStreamIsChunked() throws {
        let mjpeg = try mjpegFixture()
        let boundary = AidenMJPEGMultipartParser.boundary(fromContentType: mjpeg["contentType"] as? String)
        XCTAssertEqual(boundary, "frame")
        let cases = [
            (try base64(mjpeg["streamBase64"]), try base64List(mjpeg["framesBase64"])),
            (try base64(mjpeg["unlengthedStreamBase64"]), try base64List(mjpeg["unlengthedFramesBase64"])),
        ]
        for (stream, frames) in cases {
            XCTAssertEqual(try parse([stream], boundary: boundary), frames, "whole stream")
            XCTAssertEqual(try parse(stream.map { Data([$0]) }, boundary: boundary), frames, "byte by byte")
            for split in 0...stream.count {
                XCTAssertEqual(
                    try parse([stream.prefix(split), stream.dropFirst(split)].map { Data($0) }, boundary: boundary),
                    frames,
                    "split at \(split)"
                )
            }
        }
    }

    func testMJPEGParserHonoursContentLengthWhenTheJPEGContainsTheBoundary() throws {
        let mjpeg = try mjpegFixture()
        let frames = try base64List(mjpeg["framesBase64"])
        // The fixture's second frame embeds `\r\n--frame`; a boundary scan would cut it.
        XCTAssertNotNil(frames[1].range(of: Data("\r\n--frame".utf8)))
        XCTAssertEqual(try parse([base64(mjpeg["streamBase64"])], boundary: "frame").last, frames[1])
    }

    func testMJPEGParserNeverEmitsAPartialFrame() throws {
        let mjpeg = try mjpegFixture()
        let lengthed = try base64(mjpeg["streamBase64"])
        let lengthedFrames = try base64List(mjpeg["framesBase64"])
        // Missing the last JPEG bytes: only the first frame is complete.
        XCTAssertEqual(try parse([lengthed.dropLast(4)], boundary: "frame"), [lengthedFrames[0]])

        let unlengthed = try base64(mjpeg["unlengthedStreamBase64"])
        let unlengthedFrames = try base64List(mjpeg["unlengthedFramesBase64"])
        // Without the closing delimiter the second part's end is unknown.
        let withoutTerminator = unlengthed.dropLast("\r\n--frame\r\n".utf8.count)
        XCTAssertEqual(try parse([withoutTerminator], boundary: "frame"), [unlengthedFrames[0]])

        // Every prefix yields a prefix of the frame list, never a truncated frame.
        for length in 0...lengthed.count {
            let emitted = try parse([lengthed.prefix(length)], boundary: "frame")
            XCTAssertEqual(emitted, Array(lengthedFrames.prefix(emitted.count)), "prefix \(length)")
        }
    }

    func testMJPEGParserRejectsPartsLargerThanEightMebibytes() throws {
        var lengthed = AidenMJPEGMultipartParser()
        let header = "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: \(8 * 1_048_576 + 1)\r\n\r\n"
        XCTAssertThrowsError(try lengthed.append(Data(header.utf8))) { error in
            XCTAssertEqual(error as? AidenMJPEGMultipartParser.Failure, .partTooLarge)
        }

        var unlengthed = AidenMJPEGMultipartParser()
        XCTAssertEqual(try unlengthed.append(Data("--frame\r\nContent-Type: image/jpeg\r\n\r\n".utf8)), [])
        let chunk = Data(repeating: 0xAB, count: 1_048_576)
        var thrown: Error?
        for _ in 0..<9 where thrown == nil {
            do { _ = try unlengthed.append(chunk) } catch { thrown = error }
        }
        XCTAssertEqual(thrown as? AidenMJPEGMultipartParser.Failure, .partTooLarge)
    }

    func testMJPEGBoundaryComesFromTheContentTypeHeader() throws {
        XCTAssertEqual(AidenMJPEGMultipartParser.boundary(fromContentType: nil), "frame")
        XCTAssertEqual(AidenMJPEGMultipartParser.boundary(fromContentType: "multipart/x-mixed-replace"), "frame")
        XCTAssertEqual(
            AidenMJPEGMultipartParser.boundary(fromContentType: "multipart/x-mixed-replace;boundary=\"--sim42\""),
            "sim42"
        )
        let boundary = AidenMJPEGMultipartParser.boundary(
            fromContentType: "multipart/x-mixed-replace; charset=binary; BOUNDARY=sim42"
        )
        XCTAssertEqual(boundary, "sim42")
        let jpeg = Data([0xFF, 0xD8, 0x01, 0xFF, 0xD9])
        let stream = Data("--sim42\r\nContent-Type: image/jpeg\r\n\r\n".utf8) + jpeg + Data("\r\n--sim42--\r\n".utf8)
        XCTAssertEqual(try parse([stream], boundary: boundary), [jpeg])
        // A parser expecting the default boundary sees no part at all.
        XCTAssertEqual(try parse([stream], boundary: "frame"), [])
    }

    func testDecoderMailboxKeepsOnlyTheNewestWaitingFrame() {
        var mailbox = AidenLatestFrameMailbox()
        XCTAssertTrue(mailbox.offer(Data([1])), "an idle decoder starts a pass")
        XCTAssertEqual(mailbox.take(), Data([1]))
        XCTAssertFalse(mailbox.offer(Data([2])), "a running pass picks frames up itself")
        XCTAssertFalse(mailbox.offer(Data([3])))
        XCTAssertEqual(mailbox.take(), Data([3]), "the stale frame was dropped")
        XCTAssertNil(mailbox.take())
        XCTAssertTrue(mailbox.offer(Data([4])), "the pass ended, so the next frame starts another")
    }

    func testFrameDecoderDecodesARealJPEG() throws {
        let data = NSMutableData()
        let context = try XCTUnwrap(CGContext(
            data: nil, width: 6, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 6, height: 4))
        let image = try XCTUnwrap(context.makeImage())
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))

        let decoded = try XCTUnwrap(AidenSimulatorFrameDecoder.decode(data as Data))
        XCTAssertEqual(decoded.width, 6)
        XCTAssertEqual(decoded.height, 4)
        XCTAssertNil(AidenSimulatorFrameDecoder.decode(Data([0xFF, 0xD8, 0xFF, 0xD9])))
    }

    // MARK: Helper messages

    private func message(for vector: [String: Any]) throws -> Data {
        let command = try XCTUnwrap(vector["command"] as? [String: Any])
        let screen = try screen(from: vector["screen"])
        switch command["kind"] as? String {
        case "hardwareKeyboard":
            return AidenSimulatorHelperMessage.hardwareKeyboard(enabled: try XCTUnwrap(command["enabled"] as? Bool))
        case "touch":
            let phase = try XCTUnwrap(AidenSimulatorTouchPhase(rawValue: XCTUnwrap(command["phase"] as? String)))
            return AidenSimulatorHelperMessage.touch(
                phase,
                x: try XCTUnwrap(command["x"] as? Double),
                y: try XCTUnwrap(command["y"] as? Double),
                screen: screen
            )
        case "button":
            let button: AidenSimulatorButton
            switch command["button"] as? String {
            case "home": button = .home
            case "lock": button = .lock
            case "appSwitcher": button = .appSwitcher
            default: throw XCTSkip("Unknown button in fixture")
            }
            return AidenSimulatorHelperMessage.button(button)
        case "rotate":
            return AidenSimulatorHelperMessage.rotate(from: screen)
        default:
            XCTFail("Unknown command \(command)")
            return Data()
        }
    }

    func testHelperMessagesMatchEveryFixtureVector() throws {
        let vectors = try XCTUnwrap(fixture()["inputMessages"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let encoded = try message(for: vector)
            XCTAssertEqual(encoded.first, try XCTUnwrap((vector["tag"] as? NSNumber)?.uint8Value), "\(vector)")
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded.dropFirst()) as? NSDictionary)
            let expected = try XCTUnwrap(vector["payload"] as? NSDictionary)
            XCTAssertEqual(payload, expected, "\(vector["command"] ?? "")")
        }
    }

    func testTouchTrackerPairsEveryBeginWithOneEndEvenWhenTheGestureIsCancelled() {
        typealias Touch = AidenSimulatorTouchTracker.Touch
        var tracker = AidenSimulatorTouchTracker()
        // A touch that starts in the letterbox never begins.
        XCTAssertNil(tracker.changed(inside: nil, clamped: CGPoint(x: 0, y: 0.5)))
        XCTAssertNil(tracker.ended(clamped: CGPoint(x: 0, y: 0.5)))

        XCTAssertEqual(tracker.changed(inside: CGPoint(x: 0.2, y: 0.3), clamped: CGPoint(x: 0.2, y: 0.3)),
                       Touch(phase: .begin, point: CGPoint(x: 0.2, y: 0.3)))
        // Once down, the finger follows the clamped point off the frame's edge.
        XCTAssertEqual(tracker.changed(inside: nil, clamped: CGPoint(x: 1, y: 0.4)),
                       Touch(phase: .move, point: CGPoint(x: 1, y: 0.4)))

        // The system cancels the gesture (edge swipe, Notification Center): no onEnded.
        // The finger is lifted where it last was, exactly once.
        XCTAssertEqual(tracker.cancel(), Touch(phase: .end, point: CGPoint(x: 1, y: 0.4)))
        XCTAssertNil(tracker.cancel())
        XCTAssertNil(tracker.ended(clamped: CGPoint(x: 1, y: 0.4)))

        // The next touch begins again rather than moving a finger the helper already lifted.
        XCTAssertEqual(tracker.changed(inside: CGPoint(x: 0.5, y: 0.5), clamped: CGPoint(x: 0.5, y: 0.5))?.phase, .begin)
        // A normal end followed by the gesture state reset sends one end, not two.
        XCTAssertEqual(tracker.ended(clamped: CGPoint(x: 0.6, y: 0.5)), Touch(phase: .end, point: CGPoint(x: 0.6, y: 0.5)))
        XCTAssertNil(tracker.cancel())

        // A dropped socket forgets the contact without sending anything.
        _ = tracker.changed(inside: CGPoint(x: 0.1, y: 0.1), clamped: CGPoint(x: 0.1, y: 0.1))
        tracker.reset()
        XCTAssertFalse(tracker.isTracking)
        XCTAssertEqual(tracker.changed(inside: CGPoint(x: 0.1, y: 0.2), clamped: CGPoint(x: 0.1, y: 0.2))?.phase, .begin)
    }

    func testTouchesAreClampedToTheFrame() throws {
        let encoded = AidenSimulatorHelperMessage.touch(.move, x: -0.2, y: 1.7, screen: nil)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded.dropFirst()) as? [String: Any])
        XCTAssertEqual(payload["x"] as? Double, 0)
        XCTAssertEqual(payload["y"] as? Double, 1)
    }

    func testScreenConfigDecodingMatchesEveryFixtureVector() throws {
        let vectors = try XCTUnwrap(fixture()["screenConfigs"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let tag = try XCTUnwrap((vector["tag"] as? NSNumber)?.uint8Value)
            let payload = try JSONSerialization.data(withJSONObject: XCTUnwrap(vector["payload"]))
            let decoded = AidenSimulatorHelperMessage.screenConfig(from: Data([tag]) + payload)
            XCTAssertEqual(decoded, try screen(from: vector["screen"]), "\(vector)")
        }
        XCTAssertNil(AidenSimulatorHelperMessage.screenConfig(from: Data([0x82]) + Data("not json".utf8)))
        XCTAssertNil(AidenSimulatorHelperMessage.screenConfig(
            from: Data([0x82]) + Data(#"{"width":true,"height":10,"orientation":"portrait"}"#.utf8)
        ))
    }

    func testInputCloseRefusalsStopAndOtherClosesRetryOnce() {
        typealias Policy = AidenSimulatorInputRetryPolicy
        for code in [1008, 4401] {
            XCTAssertEqual(Policy.decision(closeCode: code, httpStatus: nil, retriesUsed: 0), .refused)
        }
        // A dropped socket is not a refusal: the HTTP status says when the upgrade was refused.
        XCTAssertEqual(Policy.decision(closeCode: 1006, httpStatus: 101, retriesUsed: 0), .retry(after: 1))
        for status in [401, 403] {
            XCTAssertEqual(Policy.decision(closeCode: nil, httpStatus: status, retriesUsed: 0), .refused)
        }
        XCTAssertEqual(Policy.decision(closeCode: 1001, httpStatus: 101, retriesUsed: 0), .retry(after: 1))
        XCTAssertEqual(Policy.decision(closeCode: nil, httpStatus: nil, retriesUsed: 0), .retry(after: 1))
        XCTAssertEqual(Policy.decision(closeCode: 1001, httpStatus: 101, retriesUsed: 1), .giveUp)
    }

    // MARK: Listing

    func testFixtureListingDecodesChatDevicesAndToolVersions() throws {
        let listing = try AidenRemoteJSONDecoder.decode(AidenSimulatorListing.self, from: fixtureData("listing"))
        XCTAssertTrue(listing.sharing)
        XCTAssertEqual(listing.status, .ready)
        XCTAssertEqual(listing.devices.map(\.platform), [.ios, .ios, .android, .android])
        XCTAssertEqual(listing.devices.map(\.kind), [.iphone, .ipad, .other, .other])
        XCTAssertEqual(listing.devices.map(\.booted), [true, false, true, false])
        // A stopped emulator is listed by its AVD name, as the desktop lists it.
        XCTAssertEqual(listing.devices.last?.id, "Pixel_9_API_35")
        XCTAssertEqual(listing.devices.filter(\.platform.isViewableOnPhone).count, 2)
        XCTAssertEqual(listing.chatDevices.map(\.name), ["iPhone 17 Pro", "Pixel 9"])
        XCTAssertEqual(listing.toolVersions, AidenSimulatorToolVersions(hub: "0.12.0", agent: "0.21.12"))
        XCTAssertTrue(listing.showsChatDeviceButton)
        XCTAssertEqual(listing.defaultViewerDeviceId, "5A0C1F3E-0000-4000-8000-000000000001")

        let off = try AidenRemoteJSONDecoder.decode(AidenSimulatorListing.self, from: fixtureData("sharingOff"))
        XCTAssertFalse(off.sharing)
        XCTAssertTrue(off.devices.isEmpty)
        XCTAssertFalse(off.showsChatDeviceButton)
        XCTAssertNil(off.defaultViewerDeviceId)

        let opened = try AidenRemoteJSONDecoder.decode(AidenSimulatorOpenResponse.self, from: fixtureData("openResponse"))
        XCTAssertTrue(opened.device.booted)
        XCTAssertEqual(opened.device.kind, .ipad)
        XCTAssertTrue(try AidenRemoteJSONDecoder.decode(
            AidenSimulatorShutdownResponse.self,
            from: fixtureData("shutdownResponse")
        ).ok)
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenSimulatorShutdownResponse.self,
            from: Data(#"{"ok":false}"#.utf8)
        ))
    }

    private func mutatedListing(_ mutate: (inout [String: Any]) -> Void) throws -> Data {
        var listing = try XCTUnwrap(fixture()["listing"] as? [String: Any])
        mutate(&listing)
        return try JSONSerialization.data(withJSONObject: listing)
    }

    private func mutateFirstDevice(_ listing: inout [String: Any], _ change: (inout [String: Any]) -> Void) {
        var devices = listing["devices"] as? [[String: Any]] ?? []
        change(&devices[0])
        listing["devices"] = devices
    }

    func testUnknownPlatformKindAndStatusDoNotFailTheListing() throws {
        let data = try mutatedListing { listing in
            listing["status"] = "warming-up"
            listing["futureField"] = ["nested": true]
            mutateFirstDevice(&listing) { device in
                device["platform"] = "visionos"
                device["kind"] = "headset"
                device["futureField"] = 1
            }
        }
        let listing = try AidenRemoteJSONDecoder.decode(AidenSimulatorListing.self, from: data)
        XCTAssertEqual(listing.status, .unavailable)
        XCTAssertEqual(listing.devices[0].platform, .other("visionos"))
        XCTAssertFalse(listing.devices[0].platform.isViewableOnPhone)
        XCTAssertEqual(listing.devices[0].kind, .other)
        XCTAssertEqual(listing.devices.count, 4)
    }

    func testIdentifiersFollowTheDesktopDevicePattern() {
        for id in ["5A0C1F3E-0000-4000-8000-000000000001", "emulator-5554", "Pixel_9_API_35", "Pixel.9", "a"] {
            XCTAssertTrue(AidenSimulatorDevice.isValidIdentifier(id), id)
        }
        for id in ["", ".hidden", "_x", "-flag", "../etc/passwd", "bad id", "a/b", String(repeating: "a", count: 129)] {
            XCTAssertFalse(AidenSimulatorDevice.isValidIdentifier(id), id)
        }
    }

    func testListingSkipsDevicesItCannotUseAndKeepsTheRest() throws {
        let skipped: [(String, Data)] = [
            ("bad id", try mutatedListing { listing in mutateFirstDevice(&listing) { $0["id"] = "../etc/passwd" } }),
            ("long id", try mutatedListing { listing in
                mutateFirstDevice(&listing) { $0["id"] = String(repeating: "a", count: 129) }
            }),
            ("missing platform", try mutatedListing { listing in mutateFirstDevice(&listing) { $0["platform"] = nil } }),
            ("missing booted", try mutatedListing { listing in mutateFirstDevice(&listing) { $0["booted"] = nil } }),
        ]
        for (label, data) in skipped {
            let listing = try AidenRemoteJSONDecoder.decode(AidenSimulatorListing.self, from: data)
            XCTAssertEqual(
                listing.devices.map(\.id),
                ["5A0C1F3E-0000-4000-8000-000000000002", "emulator-5554", "Pixel_9_API_35"],
                label
            )
            // The skipped device leaves the chat; the emulator keeps the button.
            XCTAssertEqual(listing.chatDeviceIds, ["emulator-5554"], label)
            XCTAssertTrue(listing.showsChatDeviceButton, label)
        }
        let duplicate = try AidenRemoteJSONDecoder.decode(
            AidenSimulatorListing.self,
            from: mutatedListing { listing in
                var devices = listing["devices"] as? [[String: Any]] ?? []
                devices.append(devices[0])
                listing["devices"] = devices
            }
        )
        XCTAssertEqual(duplicate.devices.count, 4)

        let rejected: [(String, Data)] = [
            ("missing sharing", try mutatedListing { $0["sharing"] = nil }),
            ("devices while sharing off", try mutatedListing { $0["sharing"] = false }),
        ]
        for (label, data) in rejected {
            XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(AidenSimulatorListing.self, from: data), label)
        }
        // A chat id that is not a listed device is dropped, not trusted.
        let badChatId = try AidenRemoteJSONDecoder.decode(
            AidenSimulatorListing.self,
            from: mutatedListing { $0["chatDeviceIds"] = ["bad id", "emulator-5554"] }
        )
        XCTAssertEqual(badChatId.chatDeviceIds, ["emulator-5554"])
        // A chat id the listing does not contain is dropped, not trusted.
        let stray = try AidenRemoteJSONDecoder.decode(
            AidenSimulatorListing.self,
            from: mutatedListing { $0["chatDeviceIds"] = ["emulator-5554", "Missing-Device"] }
        )
        XCTAssertEqual(stray.chatDeviceIds, ["emulator-5554"])
        XCTAssertEqual(stray.defaultViewerDeviceId, "emulator-5554")
    }

    func testRetryRefetchKeepsTheChatAttachment() throws {
        let chatListing = try AidenRemoteJSONDecoder.decode(AidenSimulatorListing.self, from: fixtureData("listing"))
        let refreshed = try AidenRemoteJSONDecoder.decode(
            AidenSimulatorListing.self,
            from: mutatedListing { listing in
                listing["chatDeviceIds"] = nil
                listing["toolVersions"] = nil
                listing["devices"] = (listing["devices"] as? [[String: Any]])?.filter { $0["id"] as? String != "emulator-5554" }
            }
        )
        let merged = refreshed.keepingChatDevices(of: chatListing)
        XCTAssertEqual(merged.chatDeviceIds, ["5A0C1F3E-0000-4000-8000-000000000001"])
        XCTAssertEqual(merged.toolVersions, chatListing.toolVersions)
    }

    // MARK: Client

    private func makeClient() -> AidenRemoteClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AidenSimulatorMockURLProtocol.self]
        return AidenRemoteClient(
            endpoint: URL(string: "https://aiden.test:7443/api/aiden/v1")!,
            credential: "device-credential",
            session: URLSession(configuration: configuration)
        )
    }

    private static func response(_ request: URLRequest, status: Int = 200, data: Data) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!, data)
    }

    func testClientRoutesListOpenAndShutdownThroughTheSimulatorEndpoints() async throws {
        let listingData = try fixtureData("listing")
        let openData = try fixtureData("openResponse")
        let shutdownData = try fixtureData("shutdownResponse")
        var requests: [String] = []
        var openBodies: [NSDictionary] = []
        AidenSimulatorMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            requests.append("\(request.httpMethod ?? "?") \(url.path)?\(url.query ?? "")")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            switch (request.httpMethod, url.path) {
            case ("GET", "/api/aiden/v1/simulators"):
                return Self.response(request, data: listingData)
            case ("POST", "/api/aiden/v1/simulators/open"):
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.body(of: request)) as? NSDictionary)
                openBodies.append(body)
                XCTAssertGreaterThanOrEqual(request.timeoutInterval, 120)
                return Self.response(request, data: openData)
            case ("POST", "/api/aiden/v1/simulators/shutdown"):
                let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.body(of: request)) as? NSDictionary)
                XCTAssertEqual(body, ["deviceId": "5A0C1F3E-0000-4000-8000-000000000001"])
                return Self.response(request, data: shutdownData)
            default:
                XCTFail("Unexpected request \(url)")
                return Self.response(request, status: 500, data: Data("{}".utf8))
            }
        }
        let client = makeClient()
        let listing = try await client.simulators(chatId: "chat_fixture_01")
        XCTAssertEqual(listing.chatDeviceIds.count, 2)
        _ = try await client.simulators()
        let opened = try await client.openSimulator(deviceId: "5A0C1F3E-0000-4000-8000-000000000002")
        XCTAssertTrue(opened.booted)
        XCTAssertEqual(openBodies, [["deviceId": "5A0C1F3E-0000-4000-8000-000000000002"]])
        try await client.shutdownSimulator(deviceId: "5A0C1F3E-0000-4000-8000-000000000001")
        XCTAssertEqual(requests, [
            "GET /api/aiden/v1/simulators?chatId=chat_fixture_01",
            "GET /api/aiden/v1/simulators?",
            "POST /api/aiden/v1/simulators/open?",
            "POST /api/aiden/v1/simulators/shutdown?",
        ])

        // An open response naming another device is a contract violation.
        do {
            _ = try await client.openSimulator(deviceId: "5A0C1F3E-0000-4000-8000-000000000009")
            XCTFail("Expected a mismatched device to be rejected")
        } catch {
            XCTAssertEqual((error as? AidenRemoteClientError)?.errorDescription, AidenRemoteClientError.invalidResponse.errorDescription)
        }
        // An unsafe device id never reaches the network.
        let before = requests.count
        do {
            try await client.shutdownSimulator(deviceId: "../escape")
            XCTFail("Expected an unsafe device id to be rejected")
        } catch {}
        XCTAssertEqual(requests.count, before)
    }

    func testRefusalsAndSharingOffMapToTheirViewerMessages() async throws {
        let refusal = try fixtureData("refusal")
        AidenSimulatorMockURLProtocol.handler = { request in
            if request.url?.path.hasSuffix("/shutdown") == true {
                return Self.response(request, status: 404, data: Data(
                    #"{"error":{"code":"not_found","message":"Simulator sharing is off on this Mac.","requestId":"r1","retryable":false}}"#.utf8
                ))
            }
            return Self.response(request, status: 403, data: refusal)
        }
        let client = makeClient()
        do {
            _ = try await client.simulators(chatId: "chat_fixture_01")
            XCTFail("Expected a refusal")
        } catch {
            XCTAssertEqual(AidenSimulatorViewerCopy.message(for: error), AidenSimulatorViewerCopy.refused)
        }
        do {
            try await client.shutdownSimulator(deviceId: "5A0C1F3E-0000-4000-8000-000000000001")
            XCTFail("Expected sharing off")
        } catch {
            XCTAssertEqual(AidenSimulatorViewerCopy.message(for: error), AidenSimulatorViewerCopy.sharingOff)
        }
        XCTAssertEqual(AidenSimulatorViewerCopy.message(for: URLError(.timedOut)), AidenSimulatorViewerCopy.generic)
        XCTAssertEqual(AidenSimulatorViewerCopy.message(for: AidenSimulatorStreamFailure(httpStatus: 403)), AidenSimulatorViewerCopy.refused)
        XCTAssertEqual(AidenSimulatorViewerCopy.message(for: AidenSimulatorStreamFailure(httpStatus: 404)), AidenSimulatorViewerCopy.sharingOff)
        XCTAssertEqual(AidenSimulatorViewerCopy.message(for: AidenSimulatorStreamFailure(httpStatus: 429)), AidenSimulatorViewerCopy.generic)
    }

    func testHubRelayRequestsCarryCredentialsAndNoOrigin() throws {
        let client = makeClient()
        let deviceId = "5A0C1F3E-0000-4000-8000-000000000001"
        let routes = try XCTUnwrap(fixture()["hubRoutes"] as? [String: String])

        let stream = try client.simulatorStreamRequest(deviceId: deviceId)
        XCTAssertEqual(stream.httpMethod, "GET")
        XCTAssertEqual(stream.url?.scheme, "https")
        XCTAssertEqual(stream.url?.port, 7443)
        let mjpeg = try XCTUnwrap(routes["mjpeg"]).replacingOccurrences(of: "{deviceId}", with: deviceId)
        XCTAssertEqual(stream.url?.path, "/api/aiden/v1" + mjpeg)
        let socket = try client.simulatorInputRequest(deviceId: deviceId)
        XCTAssertEqual(socket.url?.scheme, "wss")
        XCTAssertEqual(socket.url?.host, "aiden.test")
        XCTAssertEqual(socket.url?.port, 7443)
        let input = try XCTUnwrap(routes["input"]).replacingOccurrences(of: "{deviceId}", with: deviceId)
        XCTAssertEqual(
            "\(try XCTUnwrap(socket.url?.path))?\(try XCTUnwrap(socket.url?.query))",
            "/api/aiden/v1" + input
        )
        for request in [stream, socket] {
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer device-credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Aiden-Protocol-Version"), "1")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertFalse(request.url?.absoluteString.contains("device-credential") ?? true, "no credential in URLs")
        }
        XCTAssertThrowsError(try client.simulatorStreamRequest(deviceId: "a/b"))
        XCTAssertThrowsError(try client.simulatorInputRequest(deviceId: "a&b=c"))
        // A client without pinned trust cannot open the viewer's own session.
        XCTAssertThrowsError(try client.makeSimulatorTransport())
    }

    func testServerAdvertisesTheViewerOnlyWithItsFeatureToken() throws {
        func server(features: [String]) throws -> AidenServer {
            let json = """
            {"protocolVersion":1,"instanceId":"instance-sim","name":"Sim Mac","appVersion":"1.0",
            "capabilities":["server:read","simulators:mobile"],"serverCapabilities":["server:read","simulators:mobile"],
            "features":\(String(decoding: try JSONSerialization.data(withJSONObject: features), as: UTF8.self)),
            "connectionMode":"lan","serverTime":"2026-10-08T10:00:00Z"}
            """
            return try AidenRemoteJSONDecoder.decode(AidenServer.self, from: Data(json.utf8))
        }
        let feature = try XCTUnwrap(fixture()["feature"] as? String)
        XCTAssertTrue(try server(features: [feature]).supportsMobileSimulators)
        XCTAssertFalse(try server(features: ["phone-run-control-v1"]).supportsMobileSimulators)
        XCTAssertEqual(
            AidenRemoteCapability.simulatorsMobile.rawValue,
            try XCTUnwrap(fixture()["capability"] as? String)
        )
    }

    // MARK: Viewer state

    func testControlsGreetWhileConnectingThenHideOnceInputConnects() {
        var controls = AidenSimulatorControlsState()
        XCTAssertTrue(controls.isVisible)
        XCTAssertFalse(controls.showsBackdrop, "no backdrop to dismiss before input works")

        controls.apply(.backdropTapped)
        XCTAssertTrue(controls.isVisible, "the backdrop cannot hide controls while connecting")

        controls.apply(.inputConnected)
        XCTAssertFalse(controls.isVisible)
        XCTAssertTrue(controls.inputConnected)

        controls.apply(.toggle)
        XCTAssertTrue(controls.isVisible)
        XCTAssertTrue(controls.showsBackdrop)
        controls.apply(.backdropTapped)
        XCTAssertFalse(controls.isVisible)

        controls.apply(.reveal)
        XCTAssertTrue(controls.isVisible)
        controls.apply(.toggle)
        XCTAssertFalse(controls.isVisible)

        controls.apply(.inputDisconnected)
        XCTAssertTrue(controls.isVisible, "a lost socket brings the controls back")
        XCTAssertFalse(controls.inputConnected)

        controls.apply(.inputConnected)
        controls.apply(.connecting)
        XCTAssertTrue(controls.isVisible, "reloading shows the controls again")
        XCTAssertFalse(controls.showsBackdrop)
    }

    func testShakeNeedsTwoStrongJoltsWithinTheWindowAndThenCoolsDown() {
        var detector = AidenShakeDetector()
        // Resting phone: 1 g of gravity, never a jolt.
        XCTAssertFalse(detector.ingest(x: 0, y: 0, z: -1, timestamp: 0))
        XCTAssertFalse(detector.ingest(x: 0, y: 0, z: -1, timestamp: 0.05))

        // A single jolt is a bump, not a shake.
        XCTAssertFalse(detector.ingest(x: 1.5, y: 0, z: -1.2, timestamp: 1.0))
        // A second jolt within 600 ms completes the shake.
        XCTAssertTrue(detector.ingest(x: -1.6, y: 0.2, z: -1.0, timestamp: 1.4))

        // Cooldown: two more jolts within a second of the shake are ignored.
        XCTAssertFalse(detector.ingest(x: 2, y: 0, z: 0, timestamp: 1.6))
        XCTAssertFalse(detector.ingest(x: 2, y: 0, z: 0, timestamp: 1.8))

        // After the cooldown, jolts farther apart than 600 ms never pair up.
        XCTAssertFalse(detector.ingest(x: 2, y: 0, z: 0, timestamp: 3.0))
        XCTAssertFalse(detector.ingest(x: 2, y: 0, z: 0, timestamp: 3.7))
        XCTAssertFalse(detector.ingest(x: 2, y: 0, z: 0, timestamp: 4.4))

        // Below the 1.8 g threshold nothing counts, however often.
        var calm = AidenShakeDetector()
        for step in 0..<20 {
            XCTAssertFalse(calm.ingest(x: 1.0, y: 1.0, z: 0.9, timestamp: Double(step) * 0.05))
        }
    }

    func testTouchMappingFollowsTheAspectFitFrameAndIgnoresTheLetterbox() throws {
        // A 1:2 frame in a 300x300 container is 150x300, centered at x 75...225.
        let imageSize = CGSize(width: 1206, height: 2412)
        let container = CGSize(width: 300, height: 300)
        XCTAssertEqual(
            AidenSimulatorTouchMapping.fittedRect(imageSize: imageSize, in: container),
            CGRect(x: 75, y: 0, width: 150, height: 300)
        )
        let center = try XCTUnwrap(AidenSimulatorTouchMapping.normalizedPoint(
            CGPoint(x: 150, y: 150), imageSize: imageSize, container: container
        ))
        XCTAssertEqual(center.x, 0.5, accuracy: 0.0001)
        XCTAssertEqual(center.y, 0.5, accuracy: 0.0001)
        let corner = try XCTUnwrap(AidenSimulatorTouchMapping.normalizedPoint(
            CGPoint(x: 112.5, y: 225), imageSize: imageSize, container: container
        ))
        XCTAssertEqual(corner.x, 0.25, accuracy: 0.0001)
        XCTAssertEqual(corner.y, 0.75, accuracy: 0.0001)
        XCTAssertNil(AidenSimulatorTouchMapping.normalizedPoint(
            CGPoint(x: 20, y: 150), imageSize: imageSize, container: container
        ), "letterbox touches never reach the device")
        XCTAssertEqual(
            AidenSimulatorTouchMapping.normalizedPoint(
                CGPoint(x: 20, y: 400), imageSize: imageSize, container: container, clamped: true
            ),
            CGPoint(x: 0, y: 1),
            "a drag that leaves the frame stays pinned to its edge"
        )
        XCTAssertNil(AidenSimulatorTouchMapping.normalizedPoint(
            CGPoint(x: 1, y: 1), imageSize: .zero, container: container
        ))
    }

    func testRotationCyclesThroughTheFourOrientations() {
        XCTAssertEqual(
            AidenSimulatorOrientation.allCases.map(\.next),
            [.landscapeLeft, .portraitUpsideDown, .landscapeRight, .portrait]
        )
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class AidenSimulatorMockURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
