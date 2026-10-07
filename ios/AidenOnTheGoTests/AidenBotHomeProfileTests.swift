import XCTest
@testable import AidenOnTheGo

final class AidenBotHomeProfileTests: XCTestCase {
    // MARK: Fixtures

    private func summary(
        id: String,
        name: String,
        purpose: String = "",
        updatedAt: String,
        archived: Bool = false
    ) throws -> AidenBotSummary {
        var object: [String: Any] = [
            "id": id,
            "name": name,
            "purpose": purpose,
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "sky", "eyes": "wide", "detail": "orbit"]],
            "health": archived ? "archived" : "ready",
            "createdAt": "2026-08-18T17:00:00.000Z",
            "updatedAt": updatedAt,
            "revision": "rev-\(id)",
        ]
        if archived { object["archivedAt"] = updatedAt }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotSummary.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }

    private func conversation(
        botID: String,
        preview: String?,
        state: String = "idle",
        updatedAt: String
    ) throws -> AidenBotConversationItem {
        var object: [String: Any] = [
            "chatId": "chat-\(botID)",
            "botId": botID,
            "title": "",
            "activityState": state,
            "canRespondToApproval": false,
            "createdAt": "2026-08-18T17:00:00.000Z",
            "updatedAt": updatedAt,
            "revision": "chat-rev-\(botID)",
        ]
        if let preview { object["preview"] = preview }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotConversationItem.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }

    private func fixtureDetail() throws -> AidenBotDetail {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let detail = try XCTUnwrap(object["botDetail"])
        return try AidenRemoteJSONDecoder.decode(
            AidenBotDetail.self,
            from: JSONSerialization.data(withJSONObject: detail)
        )
    }

    // MARK: Bots home

    func testHomeShowsOneRowPerBotNewestChatFirstAndHidesArchivedBots() throws {
        let bots = [
            try summary(id: "quiet", name: "Quiet", purpose: "Meal prepping", updatedAt: "2026-08-18T19:30:00.000Z"),
            try summary(id: "busy", name: "Busy", updatedAt: "2026-08-18T18:00:00.000Z"),
            try summary(id: "old", name: "Old", updatedAt: "2026-08-18T20:00:00.000Z", archived: true),
        ]
        let conversations = [
            try conversation(
                botID: "busy",
                preview: "Told them: every Sunday 8:41",
                state: "running",
                updatedAt: "2026-08-18T21:00:00.000Z"
            ),
            try conversation(botID: "old", preview: "Archived chat", updatedAt: "2026-08-18T22:00:00.000Z"),
        ]

        let rows = aidenBotHomeRows(bots: bots, conversations: conversations, query: "")

        XCTAssertEqual(rows.map(\.id), ["busy", "quiet"])
        XCTAssertEqual(rows[0].preview, "Told them: every Sunday 8:41")
        XCTAssertTrue(rows[0].isWorking)
        XCTAssertEqual(rows[1].preview, "Say hello")
        XCTAssertFalse(rows[1].isWorking)
    }

    func testHomeSearchMatchesNameSubtitlePreviewAndServerMatches() throws {
        let bots = [
            try summary(id: "chef", name: "Chef", purpose: "Meal prepping", updatedAt: "2026-08-18T18:00:00.000Z"),
            try summary(id: "inbox", name: "Inbox", updatedAt: "2026-08-18T18:00:00.000Z"),
            try summary(id: "notes", name: "Notes", updatedAt: "2026-08-18T18:00:00.000Z"),
        ]
        let conversations = [
            try conversation(botID: "inbox", preview: "Sent to alex@example.com", updatedAt: "2026-08-18T19:00:00.000Z"),
        ]

        XCTAssertEqual(aidenBotHomeRows(bots: bots, conversations: conversations, query: " meal ").map(\.id), ["chef"])
        XCTAssertEqual(aidenBotHomeRows(bots: bots, conversations: conversations, query: "alex").map(\.id), ["inbox"])
        XCTAssertEqual(
            aidenBotHomeRows(bots: bots, conversations: conversations, query: "budget", remoteMatchBotIDs: ["notes"])
                .map(\.id),
            ["notes"]
        )
    }

    // MARK: Delete

    func testDeleteConfirmationUsesTheExactSharedCopy() {
        let copy = AidenBotDeleteConfirmation(botName: " Scout ")

        XCTAssertEqual(copy.title, "Delete Scout?")
        XCTAssertEqual(
            copy.message,
            "This permanently erases Scout's chat, memory, instructions, routines, files, and photo. This can't be undone."
        )
        XCTAssertEqual(copy.confirmTitle, "Delete Bot")
    }

    func testDeleteIsOfferedOnlyWhenTheHostAdvertisesIt() {
        XCTAssertFalse(AidenBotDeletion.isAvailable(hostFeatures: nil, canWriteBots: true, isConnected: true))
        XCTAssertFalse(AidenBotDeletion.isAvailable(hostFeatures: ["tts-v1"], canWriteBots: true, isConnected: true))
        XCTAssertTrue(AidenBotDeletion.isAvailable(hostFeatures: ["bot-delete-v1"], canWriteBots: true, isConnected: true))
        XCTAssertFalse(AidenBotDeletion.isAvailable(hostFeatures: ["bot-delete-v1"], canWriteBots: false, isConnected: true))
        XCTAssertFalse(AidenBotDeletion.isAvailable(hostFeatures: ["bot-delete-v1"], canWriteBots: true, isConnected: false))
    }

    // MARK: Character

    func testCharacterResetRestoresTheDefaultLookAndSendsOnlyTheAvatar() throws {
        let detail = try fixtureDetail()
        var draft = AidenBotCharacterDraft(avatar: detail.avatar.semantic)
        XCTAssertFalse(draft.isDefault)

        draft.reset()

        XCTAssertTrue(draft.isDefault)
        XCTAssertEqual(draft.shape, .wisp)
        XCTAssertEqual(draft.color, .lilac)
        let patch = try XCTUnwrap(try draft.identityPatch(comparedTo: detail))
        XCTAssertEqual(patch.avatar, .recipe(AidenBotCharacter.defaultRecipe))
        XCTAssertNil(patch.name)
        XCTAssertNil(patch.purpose)
        XCTAssertNil(patch.instructions)
        XCTAssertNil(patch.openingGreeting)
    }

    func testCharacterChangesKeepTheOtherAxisAndUnchangedLookSendsNothing() throws {
        let detail = try fixtureDetail()
        var draft = AidenBotCharacterDraft(avatar: detail.avatar.semantic)
        XCTAssertNil(try draft.identityPatch(comparedTo: detail))

        draft.select(color: .coral)
        XCTAssertEqual(draft.shape, .orb)
        draft.select(shape: .drop)
        XCTAssertEqual(draft.color, .coral)

        let patch = try XCTUnwrap(try draft.identityPatch(comparedTo: detail))
        guard case let .recipe(recipe)? = patch.avatar else { return XCTFail("Expected a recipe avatar") }
        XCTAssertEqual(recipe.shape, .drop)
        XCTAssertEqual(recipe.color, .coral)
    }

    func testLegacyAvatarOpensWithItsDesktopColourAndShape() {
        let draft = AidenBotCharacterDraft(avatar: .legacy(.ember))
        XCTAssertEqual(draft.shape, .peak)
        XCTAssertEqual(draft.color, .coral)
    }

    // MARK: Create

    func testWhatItHelpsWithSeedsInstructionsAndEmptyKeepsTheDefault() {
        XCTAssertEqual(
            AidenBotEditorDraft.seededInstructions(helpWith: "  Plan meals for the week  "),
            "Plan meals for the week"
        )
        XCTAssertEqual(
            AidenBotEditorDraft.seededInstructions(helpWith: "   "),
            AidenBotEditorDraft.defaultInstructions
        )
    }
}
