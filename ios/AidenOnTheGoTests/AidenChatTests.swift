import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

final class AidenChatTests: XCTestCase {
    func testRemoteChatDecodesPendingBackgroundTitleAndUsesABoundedRetryWindow() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Tell me about this repo","messages":[],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1","titlePending":true}"#.utf8
            )
        )

        XCTAssertTrue(chat.isTitlePending)
        XCTAssertFalse(AidenChatTitleReconciliation.retryMilliseconds.isEmpty)
        XCTAssertLessThanOrEqual(
            AidenChatTitleReconciliation.retryMilliseconds.reduce(0, +),
            15_000
        )
    }

    func testModelCatalogHidesPresentationOnlyModelsWithoutDroppingTheirIdentity() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"google","label":"Google","models":[{"id":"gemini-pro","label":"Gemini Pro","hidden":true},{"id":"gemini-flash","label":"Gemini Flash"}]},{"id":"all-hidden","label":"Hidden","models":[{"id":"legacy","label":"Legacy","hidden":true}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )

        XCTAssertEqual(catalog.providers.first?.models.map(\.id), ["gemini-pro", "gemini-flash"])
        XCTAssertEqual(catalog.visibleProviders.map(\.id), ["google"])
        XCTAssertEqual(catalog.visibleProviders.first?.models.map(\.id), ["gemini-flash"])
    }

    func testModelCatalogPreservesThinkingDefaultAndRequiredThinkingPresentation() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"opencode-go","label":"OpenCode Go","models":[{"id":"ox-alpha-free","label":"Ox Alpha","thinkingLevels":["low","high","max"],"defaultThinkingLevel":"high","thinkingCanDisable":false},{"id":"legacy","label":"Legacy","thinkingLevels":["low","high"]}]}],"defaults":{}}"#.utf8
            )
        )

        let models = try XCTUnwrap(catalog.providers.first?.models)
        XCTAssertEqual(models[0].effectiveThinkingLevel, "high")
        XCTAssertEqual(models[0].thinkingLabel(for: "off"), "Hide")
        XCTAssertEqual(models[1].effectiveThinkingLevel, "high")
    }

    func testModelCatalogKeepsNormalizedCustomProviderArtworkThroughVisibleProjection() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"custom:server","label":"Server","artwork":{"mimeType":"image/png","dataBase64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="},"models":[{"id":"chat","label":"Chat"}]}],"defaults":{}}"#.utf8
            )
        )

        XCTAssertEqual(catalog.visibleProviders.first?.artwork?.mimeType, "image/png")
        XCTAssertNotNil(catalog.visibleProviders.first?.artwork?.boundedPNGData)

        var oversizedHeader = Data(repeating: 0, count: 24)
        oversizedHeader.replaceSubrange(0..<8, with: [137, 80, 78, 71, 13, 10, 26, 10])
        oversizedHeader.replaceSubrange(12..<16, with: [73, 72, 68, 82])
        oversizedHeader.replaceSubrange(16..<20, with: [0, 0, 0, 65])
        oversizedHeader.replaceSubrange(20..<24, with: [0, 0, 0, 1])
        XCTAssertNil(
            AidenProviderArtwork(
                mimeType: "image/png",
                dataBase64: oversizedHeader.base64EncodedString()
            ).boundedPNGData
        )
    }

    func testRelativeTimestampUsesProductSpecificBoundaries() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now, now: now), "just now")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-59), now: now), "just now")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-60), now: now), "1 min ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-120), now: now), "2 mins ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-3_600), now: now), "1 hr ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-7_200), now: now), "2 hrs ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-86_400), now: now), "1 day ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(-172_800), now: now), "2 days ago")
        XCTAssertEqual(AidenRelativeTimestamp.text(for: now.addingTimeInterval(30), now: now), "just now")
    }

    func testNewAgentPopoverKeepsTheThreeReviewedWorkspaceChoices() {
        XCTAssertEqual(
            AidenNewAgentChoice.allCases,
            [.existingWorkspace, .newWorkspace, .scratchWorkspace]
        )
        XCTAssertEqual(
            AidenNewAgentChoice.allCases.map(\.title),
            ["Existing Workspace", "New Workspace", "Managed Scratch Workspace"]
        )
        XCTAssertEqual(
            AidenNewAgentChoice.allCases.map(\.symbol),
            ["folder", "folder.badge.plus", "hammer.fill"]
        )
        XCTAssertTrue(AidenNewAgentChoice.allCases.allSatisfy { !$0.detail.isEmpty })
    }

    func testProviderIconResolverMatchesDesktopAliasesAndFallbackRules() {
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "openai"), "openai")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "concentrate"), "concentrate")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "gemini"), "google")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "moonshot"), "moonshotai")
        XCTAssertEqual(
            AidenProviderIconResolver.slug(providerID: "anthropic", modelID: "claude-sonnet-4"),
            "claude"
        )
        XCTAssertEqual(
            AidenProviderIconResolver.slug(providerID: "xai", modelID: "grok-4-fast"),
            "grok"
        )
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "custom:lmstudio-2"), "lmstudio")
        XCTAssertEqual(AidenProviderIconResolver.slug(providerID: "custom:ollama-42"), "ollama")
        XCTAssertNil(AidenProviderIconResolver.slug(providerID: "custom:lmstudio-1"))
        XCTAssertNil(AidenProviderIconResolver.slug(providerID: "future-provider"))
    }

    func testAgentReplyCopyKeepsOriginalMarkdownAndRejectsNonReplies() {
        let assistant = AidenChatMessage(
            id: "assistant-1",
            role: .assistant,
            text: "## Result\n\nUse `xcodebuild test`.",
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let user = AidenChatMessage(
            id: "user-1",
            role: .user,
            text: "Please test it",
            createdAt: Date(timeIntervalSince1970: 2)
        )
        let emptyAssistant = AidenChatMessage(
            id: "assistant-2",
            role: .assistant,
            text: "",
            createdAt: Date(timeIntervalSince1970: 3)
        )

        XCTAssertEqual(
            AidenMessageActionContent.copyText(for: assistant),
            "## Result\n\nUse `xcodebuild test`."
        )
        XCTAssertNil(AidenMessageActionContent.copyText(for: user))
        XCTAssertNil(AidenMessageActionContent.copyText(for: emptyAssistant))
    }

    func testMarkdownDocumentParsesHeadingsListsAndInlineEmphasis() {
        let markdown = """
        I'll explore the repository to understand what it is.

        ## Long Live Kodak 📷

        - **Film Frame Editor** — adjustable parameters
        - `Batch processing` and export
        """

        let plainText = AidenMarkdownDocument.plainText(from: markdown)
        XCTAssertTrue(plainText.hasPrefix("I'll explore"))
        XCTAssertTrue(plainText.contains("Long Live Kodak 📷"))
        XCTAssertTrue(plainText.contains("Film Frame Editor — adjustable parameters"))
        XCTAssertTrue(plainText.contains("Batch processing and export"))
        XCTAssertFalse(plainText.contains("##"))
        XCTAssertFalse(plainText.contains("**"))
        XCTAssertFalse(plainText.contains("`"))
    }

    func testMarkdownRenderingPolicyBoundsCharactersAndCrossPlatformLineBreaks() {
        XCTAssertNil(AidenMarkdownRenderingPolicy.fallbackReason(
            for: String(repeating: "a", count: AidenMarkdownRenderingPolicy.maximumCharacterCount)
        ))
        XCTAssertEqual(
            AidenMarkdownRenderingPolicy.fallbackReason(
                for: String(repeating: "a", count: AidenMarkdownRenderingPolicy.maximumCharacterCount + 1)
            ),
            .tooManyCharacters
        )

        let allowedLines = Array(
            repeating: "line",
            count: AidenMarkdownRenderingPolicy.maximumLineCount
        ).joined(separator: "\r\n")
        XCTAssertNil(AidenMarkdownRenderingPolicy.fallbackReason(for: allowedLines))
        XCTAssertEqual(
            AidenMarkdownRenderingPolicy.fallbackReason(for: allowedLines + "\u{2028}overflow"),
            .tooManyLines
        )
    }

    @MainActor
    func testMarkdownViewRendersBlockContentAtTheFullProposedWidth() throws {
        let renderer = ImageRenderer(content: AidenMarkdownView(content: """
        ## Heading

        - First item
        - Second item
        """).frame(width: 320))
        renderer.scale = 1

        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, 320, accuracy: 0.5)
        XCTAssertGreaterThan(try XCTUnwrap(image.pngData()).count, 1_000)
    }

    @MainActor
    func testUserTextStaysContentSizedWhileAssistantMarkdownUsesTranscriptWidth() {
        let userHost = UIHostingController(rootView: AidenMessageTextView(
            role: .user,
            content: "Short prompt"
        ))
        let assistantHost = UIHostingController(rootView: AidenMessageTextView(
            role: .assistant,
            content: "A short reply"
        ))
        let proposal = CGSize(width: 320, height: 1_000)

        let userSize = userHost.sizeThatFits(in: proposal)
        let assistantSize = assistantHost.sizeThatFits(in: proposal)

        XCTAssertLessThan(userSize.width, 200)
        XCTAssertEqual(assistantSize.width, proposal.width, accuracy: 0.5)
    }

    @MainActor
    func testAssistantMarkdownKeepsTheFirstGlyphInsideItsRenderedBounds() throws {
        let renderer = ImageRenderer(content: AidenMessageTextView(
            role: .assistant,
            content: "Sounds good — the first letter must remain visible."
        ).frame(width: 320, alignment: .leading))
        renderer.scale = 3

        let image = try XCTUnwrap(renderer.cgImage)
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        let firstPaintedColumn = (0..<width).first { x in
            (0..<height).contains { y in pixels[((y * width + x) * 4) + 3] > 8 }
        }
        XCTAssertGreaterThan(try XCTUnwrap(firstPaintedColumn), 0)
    }

    func testSSEParserAcceptsCanonicalFrameAndRejectsIdentityMismatches() throws {
        let json = eventJSON(sequence: 1, type: "text_delta", payload: "{\"text\":\"Hello\"}")
        var parser = AidenSSEParser()
        XCTAssertNil(try parser.consume(line: "id: 1"))
        XCTAssertNil(try parser.consume(line: "event: text_delta"))
        XCTAssertNil(try parser.consume(line: "data: \(json)"))
        let event = try XCTUnwrap(parser.consume(line: ""))
        XCTAssertEqual(event.sequence, 1)
        XCTAssertEqual(event.payload?.text, "Hello")

        var wrongID = AidenSSEParser()
        _ = try wrongID.consume(line: "id: 2")
        _ = try wrongID.consume(line: "data: \(json)")
        XCTAssertThrowsError(try wrongID.consume(line: "")) {
            XCTAssertEqual($0 as? AidenSSEParserError, .eventIDMismatch)
        }

        var wrongName = AidenSSEParser()
        _ = try wrongName.consume(line: "id: 1")
        _ = try wrongName.consume(line: "event: reasoning_delta")
        _ = try wrongName.consume(line: "data: \(json)")
        XCTAssertThrowsError(try wrongName.consume(line: "")) {
            XCTAssertEqual($0 as? AidenSSEParserError, .eventNameMismatch)
        }
    }

    func testSSEParserRejectsDuplicateJSONKeysAndOversizedFrames() throws {
        let duplicate = """
        {"protocolVersion":1,"streamId":"stream-1","sequence":1,"sequence":1,
        "timestamp":"2026-08-19T07:00:00.000Z","type":"heartbeat","terminal":false,"payload":{}}
        """
        var parser = AidenSSEParser()
        _ = try parser.consume(line: "id: 1")
        _ = try parser.consume(line: "data: \(duplicate)")
        XCTAssertThrowsError(try parser.consume(line: "")) {
            guard case .duplicateJSONKey("sequence") = $0 as? AidenRemoteContractError else {
                return XCTFail("Expected duplicate key rejection, received \($0)")
            }
        }

        var oversized = AidenSSEParser()
        XCTAssertThrowsError(
            try oversized.consume(line: String(repeating: "x", count: AidenRemoteProtocol.maxSSEFrameBytes + 1))
        ) {
            XCTAssertEqual($0 as? AidenSSEParserError, .frameTooLarge)
        }
    }

    func testChatCacheIsScopedByInstallationAndRestoresStreamCursor() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-chat-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        let chat = sampleChat()

        try await cache.saveChats([chat], instanceId: "instance-a", workspaceId: "workspace-1")
        try await cache.saveChat(chat, instanceId: "instance-a")
        try await cache.saveActiveStream(
            .init(deviceId: "device-a", streamId: "stream-1", turnId: "turn-1", lastSequence: 14),
            instanceId: "instance-a",
            chatId: chat.id
        )
        try await cache.saveChats([chat], instanceId: "instance-b", workspaceId: "workspace-1")
        try await cache.saveActiveStream(
            .init(deviceId: "device-b", streamId: "stream-2", turnId: "turn-2", lastSequence: 3),
            instanceId: "instance-b",
            chatId: chat.id
        )

        let chatsA = await cache.loadChats(instanceId: "instance-a", workspaceId: "workspace-1")
        let chatsB = await cache.loadChats(instanceId: "instance-b", workspaceId: "workspace-1")
        let cachedChatA = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        let cachedChatB = await cache.loadChat(instanceId: "instance-b", chatId: chat.id)
        let stream = await cache.loadActiveStream(instanceId: "instance-a", chatId: chat.id)
        XCTAssertEqual(chatsA, [chat])
        XCTAssertEqual(chatsB, [chat])
        XCTAssertEqual(cachedChatA, chat)
        XCTAssertNil(cachedChatB)
        XCTAssertEqual(
            stream,
            .init(deviceId: "device-a", streamId: "stream-1", turnId: "turn-1", lastSequence: 14)
        )

        await cache.removeChat(instanceId: "instance-a", chatId: chat.id)
        let removedChat = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
        let removedStream = await cache.loadActiveStream(instanceId: "instance-a", chatId: chat.id)
        XCTAssertNil(removedChat)
        XCTAssertNil(removedStream)

        let legacyStreamURL = root
            .appending(path: "streams", directoryHint: .isDirectory)
            .appending(path: "legacy-stream.json")
        try Data("""
        {"instanceId":"instance-a","chatId":"legacy-chat","stream":{
        "streamId":"legacy-stream","turnId":"legacy-turn","lastSequence":2}}
        """.utf8).write(to: legacyStreamURL, options: .atomic)

        await cache.purge(instanceId: "instance-a")
        let purgedChats = await cache.loadChats(instanceId: "instance-a", workspaceId: "workspace-1")
        let retainedChats = await cache.loadChats(instanceId: "instance-b", workspaceId: "workspace-1")
        let retainedActiveStream = await cache.loadActiveStream(instanceId: "instance-b", chatId: chat.id)
        XCTAssertNil(purgedChats)
        XCTAssertNotNil(retainedChats)
        XCTAssertNotNil(retainedActiveStream)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyStreamURL.path))
    }

    func testAttachmentModelsRoundTripMetadataWithoutInlineContents() throws {
        let json = """
        {"id":"message-1","role":"user","text":"",
        "attachments":[{"id":"att_\(String(repeating: "A", count: 43))","name":"notes.md",
        "mimeType":"text/markdown","kind":"text","size":7}],
        "createdAt":"2026-08-19T07:00:00.000Z"}
        """
        let message = try AidenRemoteJSONDecoder.decode(AidenChatMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.attachments?.first?.name, "notes.md")
        let encoded = try JSONEncoder().encode(message)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let attachment = try XCTUnwrap((object["attachments"] as? [[String: Any]])?.first)
        XCTAssertNil(attachment["text"])
        XCTAssertNil(attachment["data"])
        XCTAssertNil(attachment["path"])
    }

    func testAttachmentReferenceValidationFailsClosed() {
        let valid = AidenAttachmentReference(
            id: "att_\(String(repeating: "A", count: 43))",
            name: "notes.md",
            mimeType: "text/markdown",
            kind: .text,
            size: 7,
            expiresAt: Date().addingTimeInterval(60)
        )
        XCTAssertTrue(valid.isValid())
        XCTAssertFalse(AidenAttachmentReference(
            id: valid.id,
            name: "../notes.md",
            mimeType: valid.mimeType,
            kind: valid.kind,
            size: valid.size,
            expiresAt: valid.expiresAt
        ).isValid())
        XCTAssertFalse(AidenAttachmentReference(
            id: "attachment-1",
            name: valid.name,
            mimeType: "application/octet-stream",
            kind: valid.kind,
            size: valid.size,
            expiresAt: valid.expiresAt
        ).isValid())
        XCTAssertFalse(AidenAttachmentReference(
            id: valid.id,
            name: valid.name,
            mimeType: valid.mimeType,
            kind: valid.kind,
            size: valid.size,
            expiresAt: Date().addingTimeInterval(-1)
        ).isValid())
    }

    func testTextAttachmentPreparationIsBoundedUTF8AndAllowlisted() throws {
        let upload = try AidenAttachmentPreparation.textUpload(
            data: Data("let value = 1".utf8),
            name: "Example.swift",
            mimeType: "application/octet-stream"
        )
        XCTAssertEqual(
            upload,
            .text(name: "Example.swift", mimeType: "text/plain", text: "let value = 1")
        )
        XCTAssertThrowsError(
            try AidenAttachmentPreparation.textUpload(
                data: Data([0xC3, 0x28]),
                name: "bad.txt",
                mimeType: "text/plain"
            )
        ) { XCTAssertEqual($0 as? AidenAttachmentPreparationError, .invalidText) }
        XCTAssertThrowsError(
            try AidenAttachmentPreparation.textUpload(
                data: Data(repeating: 0x61, count: AidenAttachmentPreparation.maximumTextBytes + 1),
                name: "large.txt",
                mimeType: "text/plain"
            )
        ) { XCTAssertEqual($0 as? AidenAttachmentPreparationError, .fileTooLarge) }
    }

    func testImageAttachmentPreparationTranscodesAndBoundsDimensions() throws {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(
            size: CGSize(width: 4_096, height: 2_048),
            format: format
        )
        let source = renderer.pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4_096, height: 2_048))
        }
        let upload = try AidenAttachmentPreparation.imageUpload(data: source, name: "camera.heic")
        guard case .image(let name, let mimeType, let data) = upload else {
            return XCTFail("Expected an image upload")
        }
        XCTAssertEqual(name, "camera.jpg")
        XCTAssertEqual(mimeType, "image/jpeg")
        XCTAssertLessThanOrEqual(data.count, AidenAttachmentPreparation.maximumImageBytes)
        let image = try XCTUnwrap(UIImage(data: data))
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height), 3_072)
    }

    func testTextFilePreparationReadsABoundedPrefixAndMarksTruncation() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "aiden-attachment-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(repeating: 0x61, count: AidenAttachmentPreparation.maximumTextBytes + 100).write(to: url)
        let upload = try AidenAttachmentPreparation.fileUpload(url: url)
        guard case .text(_, let mimeType, let text) = upload else {
            return XCTFail("Expected a text upload")
        }
        XCTAssertEqual(mimeType, "text/plain")
        XCTAssertTrue(text.hasSuffix("… [truncated]"))
        XCTAssertLessThanOrEqual(text.unicodeScalars.count, AidenAttachmentPreparation.maximumTextScalars)
        XCTAssertLessThanOrEqual(Data(text.utf8).count, AidenAttachmentPreparation.maximumTextBytes)
    }

    func testTurnAttemptTrackerReusesOnlyTheExactAmbiguousRequestKey() {
        var tracker = AidenTurnAttemptTracker()
        let request = AidenTurnStart(text: "Hello", attachmentIds: ["att_\(String(repeating: "A", count: 43))"])
        let first = tracker.key(for: request)
        XCTAssertEqual(tracker.key(for: request), first)
        XCTAssertNotEqual(tracker.key(for: AidenTurnStart(text: "Edited")), first)
        tracker.reset()
        XCTAssertNotEqual(tracker.key(for: request), first)
    }

    func testTurnRequestBuilderPreservesUploadedAttachmentReferences() {
        let firstID = "att_\(String(repeating: "A", count: 43))"
        let secondID = "att_\(String(repeating: "B", count: 43))"
        let attachments = [
            AidenAttachmentReference(
                id: firstID,
                name: "photo.jpg",
                mimeType: "image/jpeg",
                kind: .image,
                size: 128,
                expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
            ),
            AidenAttachmentReference(
                id: secondID,
                name: "notes.md",
                mimeType: "text/markdown",
                kind: .text,
                size: 64,
                expiresAt: Date(timeIntervalSince1970: 2_000_000_000)
            ),
        ]

        let request = AidenTurnRequestBuilder.make(
            text: "Review these",
            providerId: "provider",
            modelId: "model",
            thinkingLevel: "high",
            attachments: attachments
        )

        XCTAssertEqual(request.attachmentIds, [firstID, secondID])
        XCTAssertNil(AidenTurnRequestBuilder.make(
            text: "No files",
            providerId: nil,
            modelId: nil,
            thinkingLevel: nil,
            attachments: []
        ).attachmentIds)
    }

    private func eventJSON(sequence: Int, type: String, payload: String) -> String {
        """
        {"protocolVersion":1,"streamId":"stream-1","sequence":\(sequence),
        "timestamp":"2026-08-19T07:00:00.000Z","type":"\(type)","terminal":false,"payload":\(payload)}
        """
    }

    private func sampleChat() -> AidenChat {
        AidenChat(
            id: "chat-1",
            workspaceId: "workspace-1",
            title: "Aiden chat",
            providerId: "openai",
            modelId: "gpt-5.6",
            messages: [
                AidenChatMessage(
                    id: "message-1",
                    role: .user,
                    text: "Hello",
                    createdAt: Date(timeIntervalSince1970: 1_787_100_000)
                ),
            ],
            createdAt: Date(timeIntervalSince1970: 1_787_100_000),
            updatedAt: Date(timeIntervalSince1970: 1_787_100_001),
            revision: "revision-1"
        )
    }
}

final class AidenAppearanceTests: XCTestCase {
    private struct Fixture: Decodable {
        let version: Int
        let presets: [Preset]
    }

    private struct Preset: Decodable {
        let id: String
        let label: String
        let light: Palette
        let dark: Palette
    }

    private struct Palette: Decodable, Equatable {
        let canvas: String
        let sidebar: String
        let raised: String
        let foreground: String
        let secondary: String
        let accent: String
        let success: String
        let warning: String
        let danger: String

        init(_ value: AidenPalette) {
            canvas = value.canvasHex
            sidebar = value.sidebarHex
            raised = value.raisedHex
            foreground = value.foregroundHex
            secondary = value.secondaryHex
            accent = value.accentHex
            success = value.successHex
            warning = value.warningHex
            danger = value.dangerHex
        }
    }

    func testSwiftPalettesExactlyMatchSharedElectronFixture() throws {
        let bundle = Bundle(for: AidenAppearanceTests.self)
        let url = try XCTUnwrap(bundle.url(forResource: "aiden-appearance-v1", withExtension: "json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.version, 1)
        XCTAssertEqual(fixture.presets.map(\.id), AidenThemePresetID.allCases.map(\.rawValue))

        for entry in fixture.presets {
            let preset = try XCTUnwrap(AidenThemePresetID(rawValue: entry.id))
            XCTAssertEqual(entry.label, preset.title)
            XCTAssertEqual(entry.light, Palette(AidenThemeCatalog.palette(preset: preset, scheme: .light)))
            XCTAssertEqual(entry.dark, Palette(AidenThemeCatalog.palette(preset: preset, scheme: .dark)))
        }
    }

    @MainActor
    func testAppearanceSelectionIsDeviceLocalAndPersistsAllChoices() throws {
        let suiteName = "AidenAppearanceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let initial = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(initial.mode, .system)
        XCTAssertEqual(initial.lightPreset, .aiden)
        XCTAssertEqual(initial.darkPreset, .aiden)
        initial.mode = .dark
        initial.lightPreset = .berry
        initial.darkPreset = .moss
        initial.lightUIFont = .rounded
        initial.darkUIFont = .humanist
        initial.lightCodeFont = .menlo
        initial.darkCodeFont = .monaco
        initial.lightContrast = 72
        initial.darkContrast = 84
        initial.lightTranslucentSidebar = false
        initial.darkTranslucentSidebar = false
        initial.reduceMotion = .on
        initial.uiFontSize = 18
        initial.codeFontSize = 17
        initial.diffMarkers = .color

        let restored = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(restored.mode, .dark)
        XCTAssertEqual(restored.lightPreset, .berry)
        XCTAssertEqual(restored.darkPreset, .moss)
        XCTAssertEqual(restored.lightUIFont, .rounded)
        XCTAssertEqual(restored.darkUIFont, .humanist)
        XCTAssertEqual(restored.lightCodeFont, .menlo)
        XCTAssertEqual(restored.darkCodeFont, .monaco)
        XCTAssertEqual(restored.lightContrast, 72)
        XCTAssertEqual(restored.darkContrast, 84)
        XCTAssertFalse(restored.lightTranslucentSidebar)
        XCTAssertFalse(restored.darkTranslucentSidebar)
        XCTAssertEqual(restored.reduceMotion, .on)
        XCTAssertEqual(restored.uiFontSize, 18)
        XCTAssertEqual(restored.codeFontSize, 17)
        XCTAssertEqual(restored.diffMarkers, .color)
        XCTAssertEqual(restored.palette(for: .light).accentHex, "#B42C70")
        XCTAssertEqual(restored.palette(for: .dark).accentHex, "#42B596")
        XCTAssertNotEqual(restored.palette(for: .light).secondaryHex, "#6E6470")
        XCTAssertTrue(restored.resolvedReduceMotion(system: false))

        restored.lightContrast = -10
        restored.darkContrast = 110
        restored.uiFontSize = 99
        restored.codeFontSize = 1
        let normalized = AidenAppearanceStore(defaults: defaults)
        XCTAssertEqual(normalized.lightContrast, 0)
        XCTAssertEqual(normalized.darkContrast, 100)
        XCTAssertEqual(normalized.uiFontSize, 18)
        XCTAssertEqual(normalized.codeFontSize, 10)
    }

    func testWorkspaceSelectionSurvivesAdaptiveLayoutChangesAndReconcilesCRUD() {
        let ids = ["workspace-a", "workspace-b", "workspace-c"]
        var selected = AidenWorkspaceNavigation.reconciledSelection(current: nil, workspaceIDs: ids)
        XCTAssertEqual(selected, "workspace-a")

        selected = "workspace-b"
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledSelection(current: selected, workspaceIDs: ids),
            "workspace-b",
            "Compact/regular layout changes must not replace a valid selection"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledSelection(current: selected, workspaceIDs: ["workspace-a", "workspace-c"]),
            "workspace-a",
            "Removing the selected workspace should converge on an available detail"
        )
        XCTAssertNil(AidenWorkspaceNavigation.reconciledSelection(current: selected, workspaceIDs: []))
    }

    func testCompactWorkspacePathPreservesOnlyAnAvailableDestination() {
        let ids = ["workspace-a", "workspace-b", "workspace-c"]

        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledCompactPath(
                current: ["workspace-a", "workspace-b"],
                workspaceIDs: ids
            ),
            ["workspace-b"],
            "Compact navigation should preserve the visible workspace when SwiftUI reports a deeper path"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledCompactPath(
                current: ["workspace-b"],
                workspaceIDs: ["workspace-a", "workspace-c"]
            ),
            [],
            "Deleting the visible workspace should pop back to the workspace list"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.reconciledCompactPath(current: [], workspaceIDs: ids),
            []
        )
    }

    func testCompactWorkspacePathOnlyPushesWhenTransitioningFromSplitView() {
        let ids = ["workspace-a", "workspace-b"]

        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: [],
                selectedWorkspaceID: "workspace-b",
                workspaceIDs: ids
            ),
            ["workspace-b"],
            "An iPad size-class transition should preserve the workspace that was visible in split view"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: false,
                current: [],
                selectedWorkspaceID: "workspace-a",
                workspaceIDs: ids
            ),
            [],
            "Launching on iPhone should start at the workspace list instead of auto-pushing the first row"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: ["workspace-a"],
                selectedWorkspaceID: "workspace-b",
                workspaceIDs: ids
            ),
            ["workspace-a"],
            "An existing compact destination should win over stale split-view selection"
        )
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: [],
                selectedWorkspaceID: "workspace-missing",
                workspaceIDs: ids
            ),
            []
        )
    }

    @MainActor
    func testWorkspaceArchivesAreDeviceLocalPersistentAndInstallationScoped() throws {
        let suiteName = "AidenWorkspaceArchiveTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenWorkspaceArchiveStore(defaults: defaults)
        XCTAssertFalse(store.hasAcknowledgedDeviceOnlyArchive)
        XCTAssertEqual(store.archivedWorkspaceIDs(for: "mac-one"), [])

        store.acknowledgeDeviceOnlyArchive()
        store.archive(workspaceID: "workspace-a", instanceID: "mac-one")
        store.archive(workspaceID: "workspace-b", instanceID: "mac-one")
        store.archive(workspaceID: "workspace-a", instanceID: "mac-two")

        let restored = AidenWorkspaceArchiveStore(defaults: defaults)
        XCTAssertTrue(restored.hasAcknowledgedDeviceOnlyArchive)
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-one"), ["workspace-a", "workspace-b"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-two"), ["workspace-a"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: nil), [])

        restored.unarchive(workspaceID: "workspace-a", instanceID: "mac-one")
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-one"), ["workspace-b"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-two"), ["workspace-a"])
    }

    @MainActor
    func testWorkspaceArchivePruningOnlyDropsMissingServerRecordsForActiveInstallation() throws {
        let suiteName = "AidenWorkspaceArchivePruneTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenWorkspaceArchiveStore(defaults: defaults)
        store.archive(workspaceID: "keep", instanceID: "mac-one")
        store.archive(workspaceID: "removed", instanceID: "mac-one")
        store.archive(workspaceID: "other-installation", instanceID: "mac-two")

        store.prune(instanceID: "mac-one", validWorkspaceIDs: ["keep", "active"])

        XCTAssertEqual(store.archivedWorkspaceIDs(for: "mac-one"), ["keep"])
        XCTAssertEqual(store.archivedWorkspaceIDs(for: "mac-two"), ["other-installation"])

        let restored = AidenWorkspaceArchiveStore(defaults: defaults)
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-one"), ["keep"])
        XCTAssertEqual(restored.archivedWorkspaceIDs(for: "mac-two"), ["other-installation"])
    }
}
