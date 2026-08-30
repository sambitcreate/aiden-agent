import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import AidenOnTheGo

final class AidenChatTests: XCTestCase {
    func testJumpToLatestThresholdOnlyAppearsWhenTranscriptIsMeaningfullyAboveBottom() {
        XCTAssertFalse(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 0,
                containerHeight: 700,
                contentHeight: 650,
                bottomInset: 0
            )
        )
        XCTAssertFalse(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 220,
                containerHeight: 700,
                contentHeight: 980,
                bottomInset: 0
            )
        )
        XCTAssertTrue(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 100,
                containerHeight: 700,
                contentHeight: 980,
                bottomInset: 0
            )
        )
        XCTAssertTrue(
            aidenChatIsScrolledAwayFromLatest(
                contentOffsetY: 180,
                containerHeight: 700,
                contentHeight: 980,
                bottomInset: 24
            )
        )
    }

    func testBotBubbleIsRoundedWithoutATail() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 50)
        let bubble = AidenBotMessageBubbleShape().path(in: rect)

        XCTAssertEqual(bubble.boundingRect, rect)
        XCTAssertTrue(bubble.contains(CGPoint(x: 50, y: 25)))
        XCTAssertFalse(bubble.contains(CGPoint(x: 1, y: 1)))
        XCTAssertFalse(bubble.contains(CGPoint(x: 99, y: 49)))
    }

    func testBotMessageGroupingOnlyJoinsNearbyMessagesFromTheSameSpeaker() {
        let start = Date(timeIntervalSince1970: 1_000)
        let first = AidenChatMessage(
            id: "first",
            role: .assistant,
            text: "First",
            createdAt: start
        )
        let nearby = AidenChatMessage(
            id: "nearby",
            role: .assistant,
            text: "Second",
            createdAt: start.addingTimeInterval(30)
        )
        let later = AidenChatMessage(
            id: "later",
            role: .assistant,
            text: "Later",
            createdAt: start.addingTimeInterval(61)
        )
        let reply = AidenChatMessage(
            id: "reply",
            role: .user,
            text: "Reply",
            createdAt: start.addingTimeInterval(15)
        )

        XCTAssertTrue(aidenMessagesJoin(first, nearby))
        XCTAssertFalse(aidenMessagesJoin(first, later))
        XCTAssertFalse(aidenMessagesJoin(first, reply))
        XCTAssertFalse(aidenMessagesJoin(nil, nearby))
    }

    func testFailedSendRestoresSubmittedTextWithoutClobberingTheNextDraft() {
        XCTAssertEqual(
            AidenDraftSendReconciliation.failedDraft(submitted: "First message", current: ""),
            "First message"
        )
        XCTAssertEqual(
            AidenDraftSendReconciliation.failedDraft(
                submitted: "First message",
                current: "Next message"
            ),
            "First message\n\nNext message"
        )
    }

    @MainActor
    func testLiveChatMutationAuthorizationCanBeRevokedAndRestored() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-bot","workspaceId":"managed-home","botId":"bot-1","title":"Bot","messages":[],"createdAt":"2026-08-23T12:00:00Z","updatedAt":"2026-08-23T12:00:01Z","revision":"rev-1"}"#.utf8
            )
        )
        let model = AidenChatViewModel(
            coordinator: AidenRemoteCoordinator(),
            chat: chat,
            allowsMutations: true
        )

        XCTAssertFalse(model.isReadOnlyPresentation)
        model.setAllowsMutations(false)
        XCTAssertTrue(model.isReadOnlyPresentation)
        model.setAllowsMutations(true)
        XCTAssertFalse(model.isReadOnlyPresentation)
    }

    func testRemoteChatDecodesOptionalBotIdentityAndWorkspaceProjectionStaysDisjoint() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chats = try decoder.decode(
            [AidenChat].self,
            from: Data(
                """
                [{"id":"chat-workspace","workspaceId":"workspace-1","title":"Workspace",
                "messages":[],"createdAt":"2026-08-20T12:00:00Z",
                "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-workspace"},
                {"id":"chat-bot","workspaceId":"managed-bot-home","botId":"bot-1",
                "title":"Bot","messages":[],"createdAt":"2026-08-20T12:00:00Z",
                "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-bot",
                "futurePresentation":{"safe":true}}]
                """.utf8
            )
        )

        XCTAssertNil(chats[0].botId)
        XCTAssertEqual(chats[1].botId, "bot-1")
        XCTAssertFalse(chats[0].isBotChat)
        XCTAssertTrue(chats[1].isBotChat)
        XCTAssertEqual(
            AidenChat.regularWorkspaceChats(from: chats).map(\.id),
            ["chat-workspace"]
        )
    }

    func testRemoteChatRejectsMalformedPresentBotIdentity() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for botMember in ["\"botId\":null", "\"botId\":\"\""] {
            let data = Data(
                """
                {"id":"chat-1","workspaceId":"workspace-1",\(botMember),"title":"Bot",
                "messages":[],"createdAt":"2026-08-20T12:00:00Z",
                "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-1"}
                """.utf8
            )
            XCTAssertThrowsError(try decoder.decode(AidenChat.self, from: data))
        }

        let oversizedBotID = String(
            repeating: "b",
            count: AidenRemoteProtocol.maxBotIdentifierLength + 1
        )
        let oversized = Data(
            """
            {"id":"chat-1","workspaceId":"workspace-1","botId":"\(oversizedBotID)",
            "title":"Bot","messages":[],"createdAt":"2026-08-20T12:00:00Z",
            "updatedAt":"2026-08-20T12:00:01Z","revision":"rev-1"}
            """.utf8
        )
        XCTAssertThrowsError(try decoder.decode(AidenChat.self, from: oversized))
    }

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

    func testRemoteChatDecodesAssistantImageAttachmentsForTheSharedGallery() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Image","messages":[{"id":"message-1","role":"assistant","text":"Here it is.","createdAt":"2026-08-20T12:00:00Z","attachments":[{"id":"attachment-1","name":"Result.png","mimeType":"image/png","kind":"image","size":70}]}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1"}"#.utf8
            )
        )

        XCTAssertEqual(chat.messages.first?.role, .assistant)
        XCTAssertEqual(chat.messages.first?.attachments?.first?.name, "Result.png")
        XCTAssertEqual(AidenMessageMediaEdge.forRole(chat.messages.first?.role ?? .user), .leading)
    }

    func testRemoteChatDecodesHtmlArtifactsWithoutRenderingThem() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Viz","messages":[{"id":"message-1","role":"assistant","text":"Chart.","createdAt":"2026-08-20T12:00:00Z","htmlArtifacts":[{"id":"html-1","title":"Dependencies"}]}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1"}"#.utf8
            )
        )

        XCTAssertEqual(chat.messages.first?.htmlArtifacts?.first?.id, "html-1")
        XCTAssertEqual(chat.messages.first?.htmlArtifacts?.first?.title, "Dependencies")
        XCTAssertTrue(chat.messages.first?.htmlArtifacts?.first?.isWireSafe ?? false)
    }

    func testRemoteChatDecodesDurableMacActivityAndUsesMacPresentationLanguage() throws {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let chat = try decoder.decode(
            AidenChat.self,
            from: Data(
                #"{"id":"chat-1","workspaceId":"workspace-1","title":"Activity","messages":[{"id":"message-1","role":"assistant","text":"Done.","createdAt":"2026-08-20T12:00:00Z","timeline":{"version":3,"generationId":"stream-1","status":"completed","startedAt":1000,"finishedAt":3000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"read_file","label":"Read file","status":"completed","startedAt":1000,"updatedAt":1500,"finishedAt":1500,"contentOffset":0,"target":"README.md"},{"id":"think-1","order":1,"kind":"thinking","startedAt":1500,"updatedAt":2500,"finishedAt":2500,"contentOffset":0,"durationMs":1000},{"id":"tool-2","order":2,"kind":"tool","toolCallId":"call-2","toolName":"run_command","label":"Run command","status":"completed","startedAt":2500,"updatedAt":3000,"finishedAt":3000,"contentOffset":0,"detail":"Run tests"}]}}],"createdAt":"2026-08-20T12:00:00Z","updatedAt":"2026-08-20T12:00:01Z","revision":"rev_1"}"#.utf8
            )
        )

        let timeline = try XCTUnwrap(chat.messages.first?.timeline)
        XCTAssertTrue(timeline.isRendererSafe)
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: timeline.steps[0]), "Read README.md")
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: timeline.steps[1]), "Thought briefly")
        XCTAssertEqual(AidenAgentActivityPresentation.line(for: timeline.steps[2]), "Ran Run tests")
        XCTAssertEqual(AidenAgentActivityPresentation.summary(timeline), "Explored 1 file, ran 1 command")
    }

    func testReasoningActivityUsesOneDisclosureAndSurfacesVisualizationPhase() throws {
        let activeThinking = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-thinking",
            status: .running,
            startedAt: 1_000,
            finishedAt: nil,
            steps: [
                AidenAgentStep(
                    id: "think-1",
                    order: 0,
                    kind: .thinking,
                    toolName: nil,
                    label: nil,
                    status: nil,
                    startedAt: 1_000,
                    updatedAt: 1_500,
                    finishedAt: nil,
                    contentOffset: 0,
                    durationMs: nil,
                    target: nil,
                    detail: nil,
                    lineChanges: nil
                )
            ]
        )
        XCTAssertTrue(AidenAgentActivityPresentation.hasActiveThinkingStep(activeThinking))
        XCTAssertEqual(
            AidenAgentActivityPresentation.reasoningLabel(activeThinking, active: true),
            "Thinking"
        )

        let visualizing = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-visualizing",
            status: .running,
            startedAt: 1_000,
            finishedAt: nil,
            steps: [
                AidenAgentStep(
                    id: "think-1",
                    order: 0,
                    kind: .thinking,
                    toolName: nil,
                    label: nil,
                    status: nil,
                    startedAt: 1_000,
                    updatedAt: 2_000,
                    finishedAt: 2_000,
                    contentOffset: 0,
                    durationMs: 1_000,
                    target: nil,
                    detail: nil,
                    lineChanges: nil
                ),
                AidenAgentStep(
                    id: "tool-1",
                    order: 1,
                    kind: .tool,
                    toolCallId: "call-1",
                    toolName: AidenAgentActivityPresentation.renderArtifactToolName,
                    label: "Render artifact",
                    status: .running,
                    startedAt: 2_000,
                    updatedAt: 2_500,
                    finishedAt: nil,
                    contentOffset: 0,
                    durationMs: nil,
                    target: nil,
                    detail: nil,
                    lineChanges: nil
                )
            ]
        )
        XCTAssertFalse(AidenAgentActivityPresentation.hasActiveThinkingStep(visualizing))
        XCTAssertTrue(
            AidenAgentActivityPresentation.hasActiveToolStep(
                visualizing,
                named: AidenAgentActivityPresentation.renderArtifactToolName
            )
        )
        XCTAssertEqual(AidenAgentActivityPresentation.visualizingLabel(visualizing), "Visualizing")
        XCTAssertEqual(
            AidenAgentActivityPresentation.reasoningLabel(visualizing, active: false),
            "Thought briefly"
        )
        XCTAssertEqual(
            AidenAgentActivityPresentation.activitySteps(visualizing, reasoningVisible: true).map(\.kind),
            [.tool]
        )
        XCTAssertEqual(
            AidenAgentActivityPresentation.activitySteps(visualizing, reasoningVisible: false).map(\.kind),
            [.thinking, .tool]
        )
        XCTAssertNil(AidenAgentActivityPresentation.visualizingLabel(activeThinking))
    }

    func testActivityTimelineRejectsAbsoluteTargetsBeforePresentation() throws {
        let timeline = try JSONDecoder().decode(
            AidenGenerationTimeline.self,
            from: Data(
                #"{"version":3,"generationId":"stream-1","status":"running","startedAt":1000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolName":"read_file","label":"Read file","status":"running","startedAt":1000,"updatedAt":1000,"contentOffset":0,"target":"/Users/private/secret"}]}"#.utf8
            )
        )
        XCTAssertFalse(timeline.isRendererSafe)
    }

    func testActivityTimelineRejectsWindowsAbsoluteAndTraversalTargets() throws {
        for target in [#"C:\Users\private\secret"#, #"folder\..\secret"#, #"\\server\share\secret"#] {
            let timeline = AidenGenerationTimeline(
                version: 3,
                generationId: "stream-1",
                status: .running,
                startedAt: 1_000,
                finishedAt: nil,
                steps: [
                    AidenAgentStep(
                        id: "tool-1",
                        order: 0,
                        kind: .tool,
                        toolName: "read_file",
                        label: "Read file",
                        status: .running,
                        startedAt: 1_000,
                        updatedAt: 1_000,
                        finishedAt: nil,
                        contentOffset: 0,
                        durationMs: nil,
                        target: target,
                        detail: nil,
                        lineChanges: nil
                    )
                ]
            )
            XCTAssertFalse(timeline.isRendererSafe, "Expected to reject unsafe target: \(target)")
        }
    }

    func testActivitySummaryMatchesMacCategories() throws {
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-1",
            status: .completed,
            startedAt: 1_000,
            finishedAt: 2_000,
            steps: ["web_search", "computer_use", "compact_context", "custom_tool"].enumerated().map { index, name in
                AidenAgentStep(
                    id: "tool-\(index)", order: index, kind: .tool, toolName: name,
                    label: "Tool", status: .completed, startedAt: 1_000, updatedAt: 2_000,
                    finishedAt: 2_000, contentOffset: 0, durationMs: 1_000,
                    target: nil, detail: nil, lineChanges: nil
                )
            }
        )
        XCTAssertEqual(
            AidenAgentActivityPresentation.summary(timeline),
            "1 web search, 1 Mac action, compacted context, 1 tool call"
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
                #"{"providers":[{"id":"opencode-go","label":"OpenCode Go","models":[{"id":"ox-alpha-free","label":"Ox Alpha","supportsImages":false,"thinkingLevels":["low","high","max"],"defaultThinkingLevel":"high","thinkingCanDisable":false},{"id":"legacy","label":"Legacy","supportsImages":true,"thinkingLevels":["low","high"]}]}],"defaults":{}}"#.utf8
            )
        )

        let models = try XCTUnwrap(catalog.providers.first?.models)
        XCTAssertEqual(models[0].effectiveThinkingLevel, "high")
        XCTAssertEqual(models[0].thinkingLabel(for: "off"), "Hide")
        XCTAssertFalse(models[0].acceptsImageInput)
        XCTAssertTrue(models[1].acceptsImageInput)
        XCTAssertEqual(models[1].effectiveThinkingLevel, "high")
    }

    func testBotChatModelAuthorityPinsEachChatsPersistedPairInsteadOfCatalogDefaults() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"openai","label":"OpenAI","models":[{"id":"gpt-5.6","label":"GPT-5.6","thinkingLevels":["low","max"],"defaultThinkingLevel":"max"}]},{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        var chat = sampleChat()
        chat.botId = "bot-life-manager"

        let resolved = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: "google",
            selectedModelId: "gemini-flash",
            selectedThinkingLevel: "low"
        )
        let turn = AidenChatModelAuthority.turnSelection(
            chat: chat,
            selectedProviderId: "google",
            selectedModelId: "gemini-flash",
            selectedThinkingLevel: resolved.thinkingLevel
        )

        XCTAssertEqual(resolved.providerId, "openai")
        XCTAssertEqual(resolved.modelId, "gpt-5.6")
        XCTAssertEqual(resolved.thinkingLevel, "max")
        XCTAssertEqual(turn.providerId, "openai")
        XCTAssertEqual(turn.modelId, "gpt-5.6")
    }

    func testBotChatModelAuthorityNeverFallsBackWhenPersistedPairIsUnavailable() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        var chat = sampleChat()
        chat.botId = "bot-life-manager"
        chat.providerId = "saved-provider"
        chat.modelId = "saved-model"

        let resolved = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: "google",
            selectedModelId: "gemini-flash",
            selectedThinkingLevel: "high"
        )

        XCTAssertEqual(resolved.providerId, "saved-provider")
        XCTAssertEqual(resolved.modelId, "saved-model")
        XCTAssertNil(resolved.thinkingLevel)
    }

    func testBotChatModelAuthorityRemainsScopedToEachBotsSingleChat() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"openai","label":"OpenAI","models":[{"id":"gpt-5.6","label":"GPT-5.6"}]},{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        var firstChat = sampleChat()
        firstChat.botId = "bot-life-manager"
        firstChat.providerId = "openai"
        firstChat.modelId = "gpt-5.6"
        var secondChat = sampleChat()
        secondChat.botId = "bot-travel"
        secondChat.providerId = "google"
        secondChat.modelId = "gemini-flash"

        let firstSelection = AidenChatModelAuthority.resolvedSelection(
            chat: firstChat,
            catalog: catalog,
            selectedProviderId: secondChat.providerId,
            selectedModelId: secondChat.modelId,
            selectedThinkingLevel: nil
        )
        let secondSelection = AidenChatModelAuthority.resolvedSelection(
            chat: secondChat,
            catalog: catalog,
            selectedProviderId: firstChat.providerId,
            selectedModelId: firstChat.modelId,
            selectedThinkingLevel: nil
        )

        XCTAssertEqual(firstSelection.providerId, "openai")
        XCTAssertEqual(firstSelection.modelId, "gpt-5.6")
        XCTAssertEqual(secondSelection.providerId, "google")
        XCTAssertEqual(secondSelection.modelId, "gemini-flash")
    }

    func testWorkspaceChatModelAuthorityRetainsExistingCatalogFallbackBehavior() throws {
        let catalog = try JSONDecoder().decode(
            AidenModelCatalog.self,
            from: Data(
                #"{"providers":[{"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}],"defaults":{"providerId":"google","modelId":"gemini-flash"}}"#.utf8
            )
        )
        let chat = sampleChat()

        let resolved = AidenChatModelAuthority.resolvedSelection(
            chat: chat,
            catalog: catalog,
            selectedProviderId: "missing-provider",
            selectedModelId: "missing-model",
            selectedThinkingLevel: nil
        )
        let turn = AidenChatModelAuthority.turnSelection(
            chat: chat,
            selectedProviderId: resolved.providerId,
            selectedModelId: resolved.modelId,
            selectedThinkingLevel: resolved.thinkingLevel
        )

        XCTAssertEqual(resolved.providerId, "google")
        XCTAssertEqual(resolved.modelId, "gemini-flash")
        XCTAssertEqual(turn.providerId, "google")
        XCTAssertEqual(turn.modelId, "gemini-flash")
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

    func testBotReplyKeepsOnlyPostToolFinalTextVisible() {
        let progress = "Checking the workspace 🍎\n\nI found the destination.\n\n"
        let final = "## Done\n\nThe repository is ready."
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-1",
            status: .completed,
            startedAt: 1_000,
            finishedAt: 2_000,
            steps: [
                AidenAgentStep(
                    id: "tool-1", order: 0, kind: .tool, toolName: "list_dir",
                    label: "List directory", status: .completed,
                    startedAt: 1_000, updatedAt: 1_500, finishedAt: 1_500,
                    contentOffset: 0, durationMs: nil, target: nil,
                    detail: nil, lineChanges: nil
                ),
                AidenAgentStep(
                    id: "tool-2", order: 1, kind: .tool, toolName: "run_command",
                    label: "Run command", status: .completed,
                    startedAt: 1_500, updatedAt: 2_000, finishedAt: 2_000,
                    contentOffset: progress.utf16.count, durationMs: nil, target: nil,
                    detail: "Clone repository", lineChanges: nil
                )
            ]
        )

        let projection = AidenBotReplyProjection.resolve(
            text: progress + final,
            timeline: timeline,
            isActive: false
        )

        XCTAssertEqual(projection.progressText, progress.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertEqual(projection.finalText, final)

        let message = AidenChatMessage(
            id: "assistant-bot",
            role: .assistant,
            text: progress + final,
            timeline: timeline,
            createdAt: Date(timeIntervalSince1970: 1)
        )
        XCTAssertEqual(
            AidenMessageActionContent.copyText(for: message, presentationStyle: .botMessages),
            final
        )
        XCTAssertEqual(
            AidenMessageActionContent.copyText(for: message, presentationStyle: .workspace),
            progress + final
        )
    }

    func testActiveBotReplyCollapsesAndDeduplicatesProgressUntilTerminal() {
        let repeated = "Locating the workspace.\n\nLocating   the workspace.\n\nRunning the clone."
        let projection = AidenBotReplyProjection.resolve(
            text: repeated,
            timeline: nil,
            isActive: true
        )

        XCTAssertEqual(projection.finalText, "")
        XCTAssertEqual(projection.progressText, "Locating the workspace.\n\nRunning the clone.")
    }

    func testBotReplyWithoutToolActivityRemainsAVisibleFinalAnswer() {
        let timeline = AidenGenerationTimeline(
            version: 3,
            generationId: "stream-plain",
            status: .completed,
            startedAt: 1_000,
            finishedAt: 1_100,
            steps: []
        )
        let projection = AidenBotReplyProjection.resolve(
            text: "A direct answer.",
            timeline: timeline,
            isActive: false
        )

        XCTAssertEqual(projection.finalText, "A direct answer.")
        XCTAssertEqual(projection.progressText, "")
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

    func testInstallationPurgeClearsV1AndV2CachesWithoutTouchingAnotherInstallation() async throws {
        let base = FileManager.default.temporaryDirectory
            .appending(path: "aiden-versioned-chat-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: base) }
        let legacyRoot = base.appending(path: "RemoteChatCache-v1", directoryHint: .isDirectory)
        let currentRoot = base.appending(path: "RemoteChatCache-v2", directoryHint: .isDirectory)
        let legacyCache = AidenChatCache(root: legacyRoot)
        let currentCache = AidenChatCache(root: currentRoot, legacyRoots: [legacyRoot])
        let chat = sampleChat()

        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let png = renderer.pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let attachment = AidenMessageAttachment(
            id: "attachment-versioned-cache",
            name: "Versioned.png",
            mimeType: "image/png",
            kind: .image,
            size: png.count
        )

        for cache in [legacyCache, currentCache] {
            try await cache.saveChats([chat], instanceId: "instance-a", workspaceId: chat.workspaceId)
            try await cache.saveChat(chat, instanceId: "instance-a")
            try await cache.saveActiveStream(
                .init(deviceId: "device-a", streamId: "stream-a", turnId: "turn-a", lastSequence: 1),
                instanceId: "instance-a",
                chatId: chat.id
            )
            try await cache.saveAttachmentImage(
                png,
                instanceId: "instance-a",
                deviceId: "device-a",
                chatId: chat.id,
                attachment: attachment
            )

            try await cache.saveChats([chat], instanceId: "instance-b", workspaceId: chat.workspaceId)
            try await cache.saveChat(chat, instanceId: "instance-b")
            try await cache.saveActiveStream(
                .init(deviceId: "device-b", streamId: "stream-b", turnId: "turn-b", lastSequence: 2),
                instanceId: "instance-b",
                chatId: chat.id
            )
            try await cache.saveAttachmentImage(
                png,
                instanceId: "instance-b",
                deviceId: "device-b",
                chatId: chat.id,
                attachment: attachment
            )
        }

        await currentCache.purge(instanceId: "instance-a")

        for cache in [legacyCache, currentCache] {
            let removedList = await cache.loadChats(instanceId: "instance-a", workspaceId: chat.workspaceId)
            let removedChat = await cache.loadChat(instanceId: "instance-a", chatId: chat.id)
            let removedStream = await cache.loadActiveStream(instanceId: "instance-a", chatId: chat.id)
            let removedAttachment = await cache.attachmentImage(
                instanceId: "instance-a",
                deviceId: "device-a",
                chatId: chat.id,
                attachment: attachment
            )
            XCTAssertNil(removedList)
            XCTAssertNil(removedChat)
            XCTAssertNil(removedStream)
            XCTAssertNil(removedAttachment)

            let retainedList = await cache.loadChats(instanceId: "instance-b", workspaceId: chat.workspaceId)
            let retainedChat = await cache.loadChat(instanceId: "instance-b", chatId: chat.id)
            let retainedStream = await cache.loadActiveStream(instanceId: "instance-b", chatId: chat.id)
            let retainedAttachment = await cache.attachmentImage(
                instanceId: "instance-b",
                deviceId: "device-b",
                chatId: chat.id,
                attachment: attachment
            )
            XCTAssertEqual(retainedList, [chat])
            XCTAssertEqual(retainedChat, chat)
            XCTAssertEqual(retainedStream?.streamId, "stream-b")
            XCTAssertEqual(retainedAttachment, png)
        }
    }

    func testTerminalCleanupCannotDeleteANewerActiveStream() async throws {
        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-stream-generation-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        try await cache.saveActiveStream(
            .init(deviceId: "device-a", streamId: "stream-new", turnId: "turn-new", lastSequence: 0),
            instanceId: "instance-a",
            chatId: "chat-1"
        )

        let staleRemoval = await cache.removeActiveStream(
            instanceId: "instance-a",
            chatId: "chat-1",
            ifStreamId: "stream-old"
        )
        XCTAssertFalse(staleRemoval)
        let retained = await cache.loadActiveStream(instanceId: "instance-a", chatId: "chat-1")
        XCTAssertEqual(retained?.streamId, "stream-new")
        let currentRemoval = await cache.removeActiveStream(
            instanceId: "instance-a",
            chatId: "chat-1",
            ifStreamId: "stream-new"
        )
        XCTAssertTrue(currentRemoval)
    }

    func testApprovalSnapshotMustBeLiveAndBoundToTheExactStreamAndChat() {
        let now = Date(timeIntervalSince1970: 10_000)
        let valid = AidenStreamPendingApproval(
            approvalId: "approval-1",
            streamId: "stream-1",
            chatId: "chat-1",
            summary: "Review",
            toolCallId: "tool-1",
            toolName: "run",
            expiresAt: now.addingTimeInterval(60),
            canAllow: false
        )
        XCTAssertEqual(
            AidenPendingApprovalResolution.resolve(valid, streamId: "stream-1", chatId: "chat-1", now: now)?.canAllow,
            false
        )
        XCTAssertNil(AidenPendingApprovalResolution.resolve(nil, streamId: "stream-1", chatId: "chat-1", now: now))
        XCTAssertNil(AidenPendingApprovalResolution.resolve(valid, streamId: "stream-2", chatId: "chat-1", now: now))
        XCTAssertNil(AidenPendingApprovalResolution.resolve(valid, streamId: "stream-1", chatId: "chat-2", now: now))
        XCTAssertNil(
            AidenPendingApprovalResolution.resolve(
                .init(
                    approvalId: valid.approvalId,
                    streamId: valid.streamId,
                    chatId: valid.chatId,
                    summary: valid.summary,
                    toolCallId: valid.toolCallId,
                    toolName: valid.toolName,
                    expiresAt: now,
                    canAllow: true
                ),
                streamId: "stream-1",
                chatId: "chat-1",
                now: now
            )
        )
    }

    func testScheduledTaskApprovalRequiresResponseAndScheduleWriteCapabilities() {
        let now = Date(timeIntervalSince1970: 10_000)
        let proposal = AidenStreamPendingApproval(
            approvalId: "approval-schedule-1",
            streamId: "stream-1",
            chatId: "chat-1",
            summary: "Daily report · weekdays at 9:00 AM · Read Only",
            toolCallId: "tool-1",
            toolName: "schedule_task",
            expiresAt: now.addingTimeInterval(60),
            canAllow: true
        )

        let allowed = AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: true, canWriteSchedules: true),
            now: now
        )
        XCTAssertEqual(allowed?.kind, .scheduledTask)
        XCTAssertEqual(allowed?.summary, proposal.summary)
        XCTAssertEqual(allowed?.canRespond, true)
        XCTAssertEqual(allowed?.hasRequiredWriteCapability, true)
        XCTAssertEqual(allowed?.hostCanAllow, true)
        XCTAssertEqual(allowed?.canAllow, true)

        let readOnlySchedules = AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: true, canWriteSchedules: false),
            now: now
        )
        XCTAssertEqual(readOnlySchedules?.canRespond, true)
        XCTAssertEqual(readOnlySchedules?.hasRequiredWriteCapability, false)
        XCTAssertEqual(readOnlySchedules?.canAllow, false)

        let cannotRespond = AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: false, canWriteSchedules: true),
            now: now
        )
        XCTAssertEqual(cannotRespond?.canRespond, false)
        XCTAssertEqual(cannotRespond?.hasRequiredWriteCapability, true)
        XCTAssertEqual(cannotRespond?.canAllow, false)

        let hostOnly = AidenPendingApprovalResolution.resolve(
            AidenStreamPendingApproval(
                approvalId: proposal.approvalId,
                streamId: proposal.streamId,
                chatId: proposal.chatId,
                summary: proposal.summary,
                toolCallId: proposal.toolCallId,
                toolName: proposal.toolName,
                expiresAt: proposal.expiresAt,
                canAllow: false
            ),
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .init(canRespond: true, canWriteSchedules: true),
            now: now
        )
        XCTAssertEqual(hostOnly?.canRespond, true)
        XCTAssertEqual(hostOnly?.hasRequiredWriteCapability, true)
        XCTAssertEqual(hostOnly?.hostCanAllow, false)
        XCTAssertEqual(hostOnly?.canAllow, false)
    }

    func testScheduledTaskApprovalPresentationUsesUnattendedWorkCopy() {
        XCTAssertEqual(AidenApprovalKind(toolName: "schedule_task"), .scheduledTask)
        XCTAssertEqual(AidenApprovalKind(toolName: "edit_automation"), .scheduledTask)
        XCTAssertEqual(AidenApprovalKind(toolName: "run_command"), .action)
        XCTAssertEqual(AidenApprovalPresentation.title(for: .scheduledTask), "Review scheduled task")
        XCTAssertEqual(AidenApprovalPresentation.allowTitle(for: .scheduledTask), "Approve task")
        XCTAssertEqual(AidenApprovalPresentation.denyTitle(for: .scheduledTask), "Cancel")
    }

    func testScheduledTaskApprovalRechecksNarrowedCapabilitiesBeforeResponding() throws {
        let now = Date(timeIntervalSince1970: 10_000)
        let proposal = AidenStreamPendingApproval(
            approvalId: "approval-schedule-current",
            streamId: "stream-1",
            chatId: "chat-1",
            summary: "Daily report · weekdays at 9:00 AM · Read Only",
            toolCallId: "tool-1",
            toolName: "schedule_task",
            expiresAt: now.addingTimeInterval(60),
            canAllow: true
        )
        let approval = try XCTUnwrap(AidenPendingApprovalResolution.resolve(
            proposal,
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .unrestricted,
            now: now
        ))

        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: approval,
                decision: .allow,
                capabilities: .init(canRespond: true, canWriteSchedules: false)
            ),
            .scheduleWriteRequired
        )
        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: approval,
                decision: .deny,
                capabilities: .init(canRespond: true, canWriteSchedules: false)
            ),
            .allowed,
            "Deny remains available without schedule write authority."
        )
        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: approval,
                decision: .allow,
                capabilities: .init(canRespond: false, canWriteSchedules: true)
            ),
            .approvalResponseRequired
        )

        let hostOnly = try XCTUnwrap(AidenPendingApprovalResolution.resolve(
            .init(
                approvalId: proposal.approvalId,
                streamId: proposal.streamId,
                chatId: proposal.chatId,
                summary: proposal.summary,
                toolCallId: proposal.toolCallId,
                toolName: proposal.toolName,
                expiresAt: proposal.expiresAt,
                canAllow: false
            ),
            streamId: "stream-1",
            chatId: "chat-1",
            capabilities: .unrestricted,
            now: now
        ))
        XCTAssertEqual(
            AidenApprovalResponseAuthorization.resolve(
                approval: hostOnly,
                decision: .allow,
                capabilities: .unrestricted
            ),
            .hostApprovalRequired
        )
    }

    func testApprovalSummaryCollapsesWhitespaceForCompactDisclosure() {
        XCTAssertEqual(
            AidenApprovalPresentation.oneLineSummary("Run command:\n  find ~/Downloads   -type f"),
            "Run command: find ~/Downloads -type f"
        )
        XCTAssertEqual(AidenApprovalPresentation.oneLineSummary(" \n\t "), "Review requested action")
    }

    func testAttachmentImageValidationAndProtectedCacheFailClosed() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 16))
        let png = renderer.pngData { context in
            UIColor.systemPink.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 24, height: 16))
        }
        let attachment = AidenMessageAttachment(
            id: "attachment-image-1",
            name: "Preview.png",
            mimeType: "image/png",
            kind: .image,
            size: png.count
        )
        XCTAssertEqual(
            AidenAttachmentImageValidation.validatedData(
                png,
                mimeType: attachment.mimeType,
                declaredSize: attachment.size
            ),
            png
        )
        XCTAssertNil(AidenAttachmentImageValidation.validatedData(
            png,
            mimeType: "image/jpeg",
            declaredSize: png.count
        ))
        XCTAssertNil(AidenAttachmentImageValidation.validatedData(
            png,
            mimeType: "image/png",
            declaredSize: png.count + 1
        ))

        let root = FileManager.default.temporaryDirectory
            .appending(path: "aiden-attachment-cache-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = AidenChatCache(root: root)
        try await cache.saveAttachmentImage(
            png,
            instanceId: "instance-a",
            deviceId: "device-a",
            chatId: "chat-a",
            attachment: attachment
        )
        let cachedImage = await cache.attachmentImage(
            instanceId: "instance-a",
            deviceId: "device-a",
            chatId: "chat-a",
            attachment: attachment
        )
        XCTAssertEqual(cachedImage, png)
        let wrongDeviceImage = await cache.attachmentImage(
            instanceId: "instance-a",
            deviceId: "device-b",
            chatId: "chat-a",
            attachment: attachment
        )
        XCTAssertNil(wrongDeviceImage)
        await cache.removeChat(instanceId: "instance-a", chatId: "chat-a")
        let removedImage = await cache.attachmentImage(
            instanceId: "instance-a",
            deviceId: "device-a",
            chatId: "chat-a",
            attachment: attachment
        )
        XCTAssertNil(removedImage)
    }

    func testAttachmentThumbnailDownsamplesOffTheDisplayPath() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1_200, height: 800))
        let data = renderer.pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1_200, height: 800))
        }
        let decodedImage = await AidenAttachmentImageDecoding.thumbnail(
            data: data,
            maximumPixelSize: 320
        )
        let image = try XCTUnwrap(decodedImage)
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height), 320)
        XCTAssertEqual(image.size.width / image.size.height, 1.5, accuracy: 0.02)
    }

    func testPersistedMessageOutcomesUseFixedSafePresentation() {
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .failed,
                category: "authentication",
                attempts: 1,
                retryExhausted: false
            )),
            .init(
                title: "Generation failed",
                detail: "The model provider rejected its credentials. Check Provider Settings on your Mac.",
                symbol: "exclamationmark.triangle",
                isFailure: true
            )
        )
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .failed,
                category: "invalid_request",
                attempts: 1,
                retryExhausted: false
            )).detail,
            "The model provider could not accept this request. For a Bot, change its model in Edit Bot; for a Workspace chat, use the composer."
        )
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .failed,
                category: "private-provider-detail",
                attempts: nil,
                retryExhausted: nil
            )).detail,
            "The model provider could not complete this response."
        )
        XCTAssertEqual(
            AidenMessageOutcomePresentation.make(.init(
                status: .cancelled,
                category: nil,
                attempts: nil,
                retryExhausted: nil
            )).title,
            "Response cancelled"
        )
    }

    func testTerminalStreamCursorGetsExactlyOneFinalReplayBeforeCleanup() {
        var gate = AidenTerminalReplayGate()
        XCTAssertFalse(gate.shouldReplay(.running))
        XCTAssertTrue(gate.shouldReplay(.cancelled))
        XCTAssertFalse(gate.shouldReplay(.cancelled))
        XCTAssertFalse(gate.shouldReplay(.error))
    }

    func testTerminalReconciliationRetriesIndefinitelyWithACappedBackoff() {
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: -1), 1_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 0), 1_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 1), 2_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 4), 16_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 5), 30_000)
        XCTAssertEqual(AidenTerminalReconciliation.retryDelayMilliseconds(attempt: 500), 30_000)
    }

    func testTypedMissingStreamFallsBackToDurableChatReconciliation() throws {
        let gone = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"stream_gone","message":"Gone","requestId":"req-1","retryable":false}}"#.utf8)
        )
        let notFound = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"not_found","message":"Missing","requestId":"req-2","retryable":false}}"#.utf8)
        )
        let transient = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: Data(#"{"error":{"code":"internal_error","message":"Retry","requestId":"req-3","retryable":true}}"#.utf8)
        )

        XCTAssertTrue(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.server(statusCode: 404, body: gone.error)
        ))
        XCTAssertTrue(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.server(statusCode: 404, body: notFound.error)
        ))
        XCTAssertFalse(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.server(statusCode: 503, body: transient.error)
        ))
        XCTAssertFalse(AidenTerminalReconciliation.isDefinitiveMissingStream(
            AidenRemoteClientError.unexpectedStatus(404)
        ))
    }

    func testMissingStreamResolutionNeverReusesAnEarlierTurnOutcome() {
        let earlierFailed = AidenChatMessage(
            id: "assistant-old",
            role: .assistant,
            text: "",
            outcome: AidenMessageOutcome(
                status: .failed,
                category: "network",
                attempts: 1,
                retryExhausted: false
            ),
            createdAt: Date(timeIntervalSince1970: 1)
        )
        let earlierComplete = AidenChatMessage(
            id: "assistant-complete",
            role: .assistant,
            text: "Done",
            createdAt: Date(timeIntervalSince1970: 2)
        )
        let currentUser = AidenChatMessage(
            id: "user-current",
            role: .user,
            text: "Continue",
            createdAt: Date(timeIntervalSince1970: 3)
        )

        XCTAssertEqual(
            AidenMissingStreamResolution.resolve(messages: [earlierFailed, currentUser]),
            .interrupted
        )
        XCTAssertEqual(
            AidenMissingStreamResolution.resolve(messages: [earlierComplete, currentUser]),
            .interrupted
        )
        XCTAssertEqual(
            AidenMissingStreamResolution.resolve(messages: [currentUser, earlierComplete]),
            .complete
        )
    }

    func testFullscreenAttachmentGalleryOnlyKeepsTheSelectedPageAndNeighborsActive() {
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 0, selectedIndex: 0, count: 20))
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 9, selectedIndex: 10, count: 20))
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 10, selectedIndex: 10, count: 20))
        XCTAssertTrue(AidenAttachmentGalleryWindow.contains(index: 11, selectedIndex: 10, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: 8, selectedIndex: 10, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: 19, selectedIndex: 10, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: -1, selectedIndex: 0, count: 20))
        XCTAssertFalse(AidenAttachmentGalleryWindow.contains(index: 0, selectedIndex: 0, count: 0))
    }

    func testInlineCardDeckPagesWithBoundedVisibleNeighborsAndFlicks() {
        XCTAssertEqual(AidenInlineCardDeckLayout.viewportAspectRatio, 1)
        XCTAssertEqual(AidenInlineCardDeckLayout.singleImageCornerRadius, 16)
        XCTAssertEqual(AidenInlineCardDeckLayout.cardCornerRadius, 18)
        XCTAssertTrue(AidenInlineCardDeckLayout.isVisible(index: 0, selection: 0, count: 5))
        XCTAssertTrue(AidenInlineCardDeckLayout.isVisible(index: 1, selection: 0, count: 5))
        XCTAssertFalse(AidenInlineCardDeckLayout.isVisible(index: 2, selection: 0, count: 5))
        XCTAssertFalse(AidenInlineCardDeckLayout.isVisible(index: 3, selection: 0, count: 5))
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resistedTranslation(
                current: 0,
                count: 5,
                translation: 100
            ),
            22,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resistedTranslation(
                current: 1,
                count: 5,
                translation: -100
            ),
            -100,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.dragProgress(translation: -80, width: 320),
            0.25,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.selectedCardOffset(translation: -80),
            -70.4,
            accuracy: 0.001
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.preferredBackgroundIndex(
                selection: 2,
                count: 5,
                translation: -40
            ),
            3
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.preferredBackgroundIndex(
                selection: 2,
                count: 5,
                translation: 40
            ),
            1
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.preferredBackgroundIndex(
                selection: 0,
                count: 5,
                translation: 40
            ),
            1
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resolvedSelection(
                current: 1,
                count: 5,
                translation: -20,
                predictedTranslation: -120
            ),
            2
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resolvedSelection(
                current: 1,
                count: 5,
                translation: 20,
                predictedTranslation: 30
            ),
            1
        )
        XCTAssertEqual(
            AidenInlineCardDeckLayout.resolvedSelection(
                current: 0,
                count: 5,
                translation: 120,
                predictedTranslation: 160
            ),
            0
        )
    }

    func testInlineCardDeckAnchorsToTheMessageSenderEdge() {
        XCTAssertEqual(AidenMessageMediaEdge.forRole(.user), .trailing)
        XCTAssertEqual(AidenMessageMediaEdge.forRole(.assistant), .leading)
        XCTAssertLessThan(AidenMessageMediaEdge.trailing.backgroundRotationDegrees, 0)
        XCTAssertGreaterThan(AidenMessageMediaEdge.leading.backgroundRotationDegrees, 0)
    }

    func testUserImageAttachmentsSitOutsideTheTextBubble() {
        XCTAssertTrue(AidenMessageContentSurface.usesRaisedBubble(role: .user, content: .text))
        XCTAssertTrue(AidenMessageContentSurface.usesRaisedBubble(
            role: .user,
            content: .fallbackAttachment
        ))
        XCTAssertFalse(AidenMessageContentSurface.usesRaisedBubble(
            role: .user,
            content: .imageAttachment
        ))
        XCTAssertFalse(AidenMessageContentSurface.usesRaisedBubble(
            role: .assistant,
            content: .text
        ))
    }

    func testAttachmentThumbnailCacheSeparatesContentAndRequestedResolution() {
        let imageA = Data("image-a".utf8)
        let imageB = Data("image-b".utf8)
        let key = AidenAttachmentThumbnailCacheKey.make(data: imageA, maximumPixelSize: 960)

        XCTAssertEqual(
            key,
            AidenAttachmentThumbnailCacheKey.make(data: imageA, maximumPixelSize: 960)
        )
        XCTAssertNotEqual(
            key,
            AidenAttachmentThumbnailCacheKey.make(data: imageB, maximumPixelSize: 960)
        )
        XCTAssertNotEqual(
            key,
            AidenAttachmentThumbnailCacheKey.make(data: imageA, maximumPixelSize: 2_560)
        )
    }

    func testPhotoLibraryUsageDescriptionIsExplicitAndSaveOnly() throws {
        let value = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryAddUsageDescription") as? String
        )
        XCTAssertTrue(value.contains("only when you choose"))
        XCTAssertTrue(value.contains("Save Image"))
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

    func testImageAttachmentPreparationPreservesValidPNGBytesAndExtension() throws {
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
        XCTAssertEqual(name, "camera.png")
        XCTAssertEqual(mimeType, "image/png")
        XCTAssertEqual(data, source)
        XCTAssertLessThanOrEqual(data.count, AidenAttachmentPreparation.maximumImageBytes)
    }

    func testImageAttachmentPreparationDoesNotFlattenTransparentPNG() throws {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = false
        let source = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32), format: format).pngData { context in
            UIColor.clear.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
            UIColor.systemPink.withAlphaComponent(0.5).setFill()
            context.fill(CGRect(x: 8, y: 8, width: 16, height: 16))
        }
        let upload = try AidenAttachmentPreparation.imageUpload(data: source, name: "diagram.png")
        guard case .image(let name, let mimeType, let data) = upload else {
            return XCTFail("Expected an image upload")
        }
        XCTAssertEqual(name, "diagram.png")
        XCTAssertEqual(mimeType, "image/png")
        XCTAssertEqual(data, source)
    }

    func testImageAttachmentValidationRejectsTruncatedPixelData() throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).pngData { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        let truncated = Data(source.prefix(source.count / 2))
        XCTAssertNil(AidenAttachmentImageValidation.validatedData(
            truncated,
            mimeType: "image/png",
            declaredSize: truncated.count
        ))
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

    func testPhotoTransferPreservesOriginalNameWithoutDependingOnTemporaryExtension() throws {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "aiden-extensionless-photo-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        let source = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
            UIColor.systemPurple.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        try source.write(to: url)

        let upload = try AidenAttachmentPreparation.fileUpload(
            url: url,
            preferredName: "Summer Photo.PNG",
            forceImage: true
        )
        guard case .image(let name, let mimeType, _) = upload else {
            return XCTFail("Expected an image upload")
        }
        XCTAssertEqual(name, "Summer Photo.png")
        XCTAssertEqual(mimeType, "image/png")
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

#if DEBUG
    @MainActor
    func testBotChatViewModelRejectsProviderAndModelPickerMutations() {
        var chat = sampleChat()
        chat.botId = "bot-life-manager"
        let model = AidenChatViewModel(readOnlyFixture: chat)

        model.selectProvider("google")
        model.selectModel("gemini-flash")

        XCTAssertTrue(model.usesPersistedBotModelAuthority)
        XCTAssertFalse(model.showsComposerModelControl)
        XCTAssertEqual(model.selectedProviderId, "openai")
        XCTAssertEqual(model.selectedModelId, "gpt-5.6")

        var workspaceChat = sampleChat()
        workspaceChat.botId = nil
        let workspaceModel = AidenChatViewModel(readOnlyFixture: workspaceChat)
        XCTAssertFalse(workspaceModel.usesPersistedBotModelAuthority)
        XCTAssertTrue(workspaceModel.showsComposerModelControl)
    }

    @MainActor
    func testBotImageAuthorityFailsClosedAndUsesSetupRecoveryForPendingImages() {
        var chat = sampleChat()
        chat.botId = "bot-life-manager"
        let model = AidenChatViewModel(readOnlyFixture: chat)

        XCTAssertFalse(model.acceptsImageAttachments)
        XCTAssertEqual(
            aidenImageSendRecovery(
                isBotChat: true,
                acceptsImages: model.acceptsImageAttachments,
                hasPendingImage: true
            ),
            .configureBotVision
        )

        model.setBotVisionModelSelection(AidenBotModelSelection(
            providerId: "provider-vision",
            modelId: "model-vision"
        ))
        XCTAssertTrue(model.acceptsImageAttachments)
        model.setBotVisionModelSelection(nil)
        model.setBotPrimarySupportsImages(true)
        XCTAssertTrue(model.acceptsImageAttachments)
    }

    @MainActor
    func testReadOnlyFixtureChatRejectsEveryLiveEntryPointWithoutMutatingItsChat() async {
        let chat = sampleChat()
        let model = AidenChatViewModel(readOnlyFixture: chat)

        XCTAssertFalse(model.isConnected)
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.isLoading)
        XCTAssertFalse(model.isStreaming)
        XCTAssertTrue(model.isReadOnlyPresentation)

        model.draft = "This must stay local"
        await model.load()
        await model.send()
        let rejectedUploads = await model.upload([
            .text(name: "fixture.txt", mimeType: "text/plain", text: "fixture")
        ])
        await model.stop()
        await model.respondToApproval(.allow)

        XCTAssertEqual(rejectedUploads, 1)
        XCTAssertEqual(model.chat, chat)
        XCTAssertEqual(model.draft, "This must stay local")
        XCTAssertTrue(model.pendingAttachments.isEmpty)
        XCTAssertNil(model.presentedError)
    }
#endif

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

final class AidenHapticTests: XCTestCase {
    @MainActor
    private final class RecordingEmitter: AidenHapticEmitting {
        private(set) var events: [AidenHapticEvent] = []

        func activate(scope: UUID) {}
        func deactivate(scope: UUID) {}

        func emit(_ event: AidenHapticEvent, scope: UUID?, dedupeKey: String?) {
            events.append(event)
        }
    }

    @MainActor
    func testPreferenceDefaultsOnAndPersistsDeviceLocally() throws {
        let suiteName = "AidenHapticTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let initial = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )
        XCTAssertTrue(initial.isEnabled)
        initial.isEnabled = false

        let restored = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )
        XCTAssertFalse(restored.isEnabled)
    }

    @MainActor
    func testDeliveryRequiresHardwareForegroundPreferenceAudioSilenceAndActiveScope() throws {
        let suiteName = "AidenHapticGateTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var isActive = false
        var isCapturing = false
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { isActive },
            isAudioCaptureActive: { isCapturing },
            supportsHaptics: true
        )
        let scope = UUID()

        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        isActive = true
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        center.activate(scope: scope)
        isCapturing = true
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        isCapturing = false
        center.isEnabled = false
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 0)
        center.isEnabled = true
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 1)
        center.deactivate(scope: scope)
        center.play(.error, scope: scope)
        XCTAssertEqual(center.pulse.sequence, 1)
    }

    @MainActor
    func testUnsupportedHardwareNeverAdvancesPulse() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "AidenHapticUnsupportedTests.\(UUID().uuidString)"))
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: false
        )
        center.play(.success)
        XCTAssertEqual(center.pulse.sequence, 0)
    }

    @MainActor
    func testDedupeIsConsumedBeforeDeliveryGatesAndIncludesSemanticEvent() throws {
        let suiteName = "AidenHapticDedupeTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var isActive = false
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { isActive },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )

        center.play(.warning, dedupeKey: "operation-1")
        isActive = true
        center.play(.warning, dedupeKey: "operation-1")
        XCTAssertEqual(center.pulse.sequence, 0, "A background observation must never replay later")
        center.play(.success, dedupeKey: "operation-1")
        XCTAssertEqual(center.pulse.sequence, 1, "A different semantic outcome may share a caller key")
        center.play(.success, dedupeKey: "operation-1")
        XCTAssertEqual(center.pulse.sequence, 1)
    }

    @MainActor
    func testProtocolConveniencePlayDelegatesOnceWithoutRecursion() {
        let emitter = RecordingEmitter()
        emitter.play(.warning, dedupeKey: "approval-1")
        XCTAssertEqual(emitter.events, [.warning])
    }

    @MainActor
    func testDeliveryTimeGateRechecksForegroundAudioCaptureAndOriginatingScope() throws {
        let suiteName = "AidenHapticDeliveryRaceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var isActive = true
        var isCapturing = false
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { isActive },
            isAudioCaptureActive: { isCapturing },
            supportsHaptics: true
        )
        let scope = UUID()

        center.activate(scope: scope)
        center.play(.success, scope: scope)
        XCTAssertEqual(center.pulse.scope, scope)
        XCTAssertTrue(center.shouldDeliverNow(scope: center.pulse.scope))
        center.deactivate(scope: scope)
        XCTAssertFalse(
            center.shouldDeliverNow(scope: center.pulse.scope),
            "A queued pulse must not survive its view being dismissed in the same render batch"
        )
        center.activate(scope: scope)
        isActive = false
        XCTAssertFalse(center.shouldDeliverNow(scope: center.pulse.scope))
        isActive = true
        isCapturing = true
        XCTAssertFalse(center.shouldDeliverNow(scope: center.pulse.scope))
    }

    func testCancellationRecognitionIncludesURLSessionCancellation() {
        XCTAssertTrue(aidenIsCancellation(CancellationError()))
        XCTAssertTrue(aidenIsCancellation(URLError(.cancelled)))
        XCTAssertFalse(aidenIsCancellation(URLError(.timedOut)))
    }

    func testOnlyLocallyStartedStreamsMayAnnounceFeedback() {
        XCTAssertTrue(AidenStreamFeedbackPolicy.localTurn.allowsFeedback)
        XCTAssertFalse(AidenStreamFeedbackPolicy.restoredStream.allowsFeedback)
        XCTAssertTrue(AidenStreamFeedbackDecision.announcesApproval(.localTurn))
        XCTAssertFalse(AidenStreamFeedbackDecision.announcesApproval(.restoredStream))
        XCTAssertEqual(
            AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .localTurn),
            .error
        )
        XCTAssertEqual(
            AidenStreamFeedbackDecision.terminalEvent(for: .interrupted, policy: .localTurn),
            .error
        )
        XCTAssertNil(AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .restoredStream))
        XCTAssertNil(AidenStreamFeedbackDecision.terminalEvent(for: .cancelled, policy: .localTurn))
        XCTAssertNil(AidenStreamFeedbackDecision.terminalEvent(for: .complete, policy: .localTurn))
    }

    @MainActor
    func testLocalStreamFeedbackIsExactlyOnceWhileRestoredAndDismissedFlowsStaySilent() throws {
        let suiteName = "AidenHapticStreamRaceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let center = AidenHapticCenter(
            defaults: defaults,
            isApplicationActive: { true },
            isAudioCaptureActive: { false },
            supportsHaptics: true
        )
        let scope = UUID()
        center.activate(scope: scope)

        if AidenStreamFeedbackDecision.announcesApproval(.localTurn) {
            center.play(.warning, scope: scope, dedupeKey: "approval:approval-1")
        }
        if AidenStreamFeedbackDecision.announcesApproval(.restoredStream) {
            center.play(.warning, scope: scope, dedupeKey: "approval:approval-1")
        }
        XCTAssertEqual(center.pulse.sequence, 1)

        if let event = AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .localTurn) {
            center.play(event, scope: scope, dedupeKey: "terminal:stream-1")
            center.play(event, scope: scope, dedupeKey: "terminal:stream-1")
        }
        XCTAssertEqual(center.pulse.sequence, 2, "Response and SSE convergence must announce one terminal outcome")

        if let event = AidenStreamFeedbackDecision.terminalEvent(for: .failed, policy: .restoredStream) {
            center.play(event, scope: scope, dedupeKey: "terminal:restored-stream")
        }
        center.play(.actionStopped, scope: scope, dedupeKey: "turn-stop:stream-1")
        center.play(.actionStopped, scope: scope, dedupeKey: "turn-stop:stream-1")
        XCTAssertEqual(center.pulse.sequence, 3, "Stop response and SSE convergence must announce once")

        center.play(.success, scope: scope, dedupeKey: "pairing:pair-1")
        center.deactivate(scope: scope)
        XCTAssertFalse(center.shouldDeliverNow(scope: center.pulse.scope), "Dismissed pairing must not vibrate")
    }

    func testMutationOutcomesSeparateDefinitiveFailureFromSilentNonOutcomes() {
        let success = AidenRemoteMutationOutcome.success("workspace-1")
        let failure = AidenRemoteMutationOutcome<String>.failure
        let cancelled = AidenRemoteMutationOutcome<String>.cancelled
        let stale = AidenRemoteMutationOutcome<String>.stale
        let busy = AidenRemoteMutationOutcome<String>.busy

        XCTAssertEqual(success.value, "workspace-1")
        XCTAssertFalse(success.isDefinitiveFailure)
        XCTAssertTrue(failure.isDefinitiveFailure)
        XCTAssertFalse(cancelled.isDefinitiveFailure)
        XCTAssertFalse(stale.isDefinitiveFailure)
        XCTAssertFalse(busy.isDefinitiveFailure)
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

    func testUnifiedWorkspaceSidebarProjectsOwnedChatsWithoutDuplicates() {
        let base = Date(timeIntervalSince1970: 1_000)
        let workspaces = [
            AidenWorkspace(
                id: "alpha",
                name: "Alpha",
                permission: .ask,
                hasFolder: true,
                isManagedWorktree: false,
                branchName: nil,
                repositoryName: nil,
                git: nil,
                createdAt: base,
                updatedAt: base.addingTimeInterval(20),
                revision: "alpha-r1"
            ),
            AidenWorkspace(
                id: "beta",
                name: "Beta",
                permission: .ask,
                hasFolder: false,
                isManagedWorktree: false,
                branchName: nil,
                repositoryName: nil,
                git: nil,
                createdAt: base,
                updatedAt: base.addingTimeInterval(10),
                revision: "beta-r1"
            ),
        ]
        let chats = [
            AidenChat(
                id: "alpha-chat",
                workspaceId: "alpha",
                title: "Review API",
                providerId: nil,
                modelId: nil,
                messages: [],
                createdAt: base,
                updatedAt: base.addingTimeInterval(30),
                revision: "chat-r1"
            ),
            AidenChat(
                id: "orphan-chat",
                workspaceId: "removed",
                title: "Removed",
                providerId: nil,
                modelId: nil,
                messages: [],
                createdAt: base,
                updatedAt: base.addingTimeInterval(40),
                revision: "chat-r2"
            ),
        ]

        let projection = AidenWorkspaceSidebarProjection.make(
            workspaces: workspaces,
            chats: chats,
            searchText: ""
        )
        XCTAssertEqual(projection.sections.map(\.workspace.id), ["alpha", "beta"])
        XCTAssertEqual(projection.sections[0].chats.map(\.id), ["alpha-chat"])
        XCTAssertEqual(projection.sections[1].chats, [])
        XCTAssertEqual(projection.recents.map(\.id), ["alpha-chat"])

        let search = AidenWorkspaceSidebarProjection.make(
            workspaces: workspaces,
            chats: chats,
            searchText: "api"
        )
        XCTAssertEqual(search.sections.map(\.workspace.id), ["alpha"])
        XCTAssertEqual(search.recents.map(\.id), ["alpha-chat"])
    }

    @MainActor
    func testUnifiedWorkspaceSidebarPreferencesPersistPerInstallation() throws {
        let suiteName = "AidenWorkspaceSidebarTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(store.workspaceSidebarOrganization(for: "mac-one"), .workspace)
        store.setWorkspaceSidebarOrganization(.recent, for: "mac-one")
        store.toggleExpandedSidebarWorkspace("alpha", for: "mac-one")
        store.toggleExpandedSidebarWorkspace("beta", for: "mac-two")

        let restored = AidenProductNavigationStore(defaults: defaults)
        XCTAssertEqual(restored.workspaceSidebarOrganization(for: "mac-one"), .recent)
        XCTAssertEqual(restored.workspaceSidebarOrganization(for: "mac-two"), .workspace)
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-one"), ["alpha"])
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-two"), ["beta"])

        restored.pruneExpandedSidebarWorkspaces(validWorkspaceIDs: ["other"], for: "mac-one")
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-one"), [])
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-two"), ["beta"])

        restored.purge(instanceID: "mac-one")
        XCTAssertEqual(restored.workspaceSidebarOrganization(for: "mac-one"), .workspace)
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-one"), [])
        XCTAssertEqual(restored.expandedSidebarWorkspaceIDs(for: "mac-two"), ["beta"])
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
        XCTAssertEqual(
            AidenWorkspaceNavigation.compactPath(
                enteringFromSplit: true,
                current: ["workspace-a"],
                selectedWorkspaceID: "workspace-a",
                workspaceIDs: ids,
                preservingSelectedChat: true
            ),
            [],
            "A selected chat should remain the compact destination across a size-class transition"
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
