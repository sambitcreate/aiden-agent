import XCTest
@testable import AidenOnTheGo

final class AidenBotHomeProfileTests: XCTestCase {
    // MARK: Fixtures

    private func summary(
        id: String,
        name: String,
        purpose: String = "",
        updatedAt: String,
        sessionState: String? = nil
    ) throws -> AidenBotSummary {
        var object: [String: Any] = [
            "id": id,
            "name": name,
            "purpose": purpose,
            "avatar": ["semantic": ["version": 1, "shape": "orb", "color": "sky"]],
            "health": "ready",
            "createdAt": "2026-08-18T17:00:00.000Z",
            "updatedAt": updatedAt,
            "revision": "rev-\(id)",
        ]
        if let sessionState { object["sessionState"] = sessionState }
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

    func testHomeShowsOneRowPerBotNewestChatFirst() throws {
        let bots = [
            try summary(id: "quiet", name: "Quiet", purpose: "Meal prepping", updatedAt: "2026-08-18T19:30:00.000Z"),
            try summary(id: "busy", name: "Busy", updatedAt: "2026-08-18T18:00:00.000Z"),
        ]
        let conversations = [
            try conversation(
                botID: "busy",
                preview: "Told them: every Sunday 8:41",
                state: "running",
                updatedAt: "2026-08-18T21:00:00.000Z"
            ),
        ]

        let rows = aidenBotHomeRows(bots: bots, conversations: conversations, query: "")

        XCTAssertEqual(rows.map(\.id), ["busy", "quiet"])
        XCTAssertEqual(rows[0].preview, "Told them: every Sunday 8:41")
        XCTAssertTrue(rows[0].isWorking)
        XCTAssertEqual(rows[1].preview, "Say hello")
        XCTAssertFalse(rows[1].isWorking)
    }

    func testHomeRowSubtitleReportsAPausedTurnOrAMissingModel() throws {
        let bots = [
            try summary(id: "paused", name: "Paused", updatedAt: "2026-08-18T18:00:00.000Z", sessionState: "interrupted"),
            try summary(id: "fresh", name: "Fresh", updatedAt: "2026-08-18T17:30:00.000Z", sessionState: "needs_model"),
            try summary(id: "working", name: "Working", updatedAt: "2026-08-18T17:00:00.000Z", sessionState: "running"),
        ]
        let conversations = [
            try conversation(botID: "paused", preview: "Your first meeting is", updatedAt: "2026-08-18T18:00:00.000Z"),
        ]

        let rows = Dictionary(uniqueKeysWithValues: aidenBotHomeRows(
            bots: bots,
            conversations: conversations,
            query: ""
        ).map { ($0.id, $0) })

        XCTAssertEqual(rows["paused"]?.preview, "Paused — tap to resume")
        XCTAssertEqual(rows["fresh"]?.preview, "Needs an AI model")
        XCTAssertEqual(rows["working"]?.preview, "Say hello")
        XCTAssertEqual(rows["working"]?.isWorking, true)
        XCTAssertEqual(rows["paused"]?.isWorking, false)
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

    func testCharacterColoursMatchTheSharedDesktopPalette() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let palette = try XCTUnwrap(object["botAvatarPalette"] as? [String: Any])
        let colors = try XCTUnwrap(palette["colors"] as? [String: String])
        func hex(_ rgb: UInt32) -> String { String(format: "#%06X", rgb) }
        XCTAssertEqual(Set(colors.keys), Set(AidenBotAvatarColor.allCases.map(\.rawValue)))
        for color in AidenBotAvatarColor.allCases {
            XCTAssertEqual(hex(color.rgb), colors[color.rawValue], "\(color.rawValue) differs from desktop")
        }
        XCTAssertEqual(hex(aidenBotAvatarFaceRGB), palette["face"] as? String)
    }

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

    // MARK: Advanced without the opening greeting

    /// An older Mac may still send `openingGreeting`. Advanced has no greeting
    /// field any more, so opening and saving it unchanged sends nothing, and
    /// an edit never carries a greeting.
    func testAdvancedIgnoresAGreetingFromAnOlderMacAndNeverSendsOne() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let catalog = try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: JSONSerialization.data(withJSONObject: try XCTUnwrap(object["botCapabilityCatalog"]))
        )
        let rawDetail = try XCTUnwrap(object["botDetail"] as? [String: Any])
        let detail = try AidenRemoteJSONDecoder.decode(
            AidenBotDetail.self,
            from: JSONSerialization.data(withJSONObject: rawDetail.merging(["openingGreeting": "Hi there!"]) { $1 })
        )
        var draft = try XCTUnwrap(AidenBotEditorDraft(detail: detail, catalog: catalog))
        XCTAssertNil(try draft.identityPatch(comparedTo: detail), "an untouched Advanced page saves nothing")

        draft.purpose = "Plans the week"
        let patch = try XCTUnwrap(try draft.identityPatch(comparedTo: detail))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["purpose"])
    }

    // MARK: Profile → Memory row

    private func memory(user: [String], notes: [String], readable: Bool = true) throws -> AidenBotMemory {
        func group(_ texts: [String], limit: Int) -> [String: Any] {
            [
                "entries": texts.enumerated().map { index, text in
                    ["id": String(format: "%016x", index + (limit == 1_375 ? 0 : 100)), "text": text]
                },
                "usedChars": texts.reduce(0) { $0 + $1.count },
                "limitChars": limit,
                "overBudget": false,
            ]
        }
        let object: [String: Any] = [
            "botId": "bot_fixture_01",
            "revision": "9f2c1a0b7d3e4f51",
            "readable": readable,
            "user": group(user, limit: 1_375),
            "memory": group(notes, limit: 2_200),
            "updatedAt": NSNull(),
        ]
        return try AidenRemoteJSONDecoder.decode(AidenBotMemory.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testMemoryRowCountReadsQuietly() throws {
        XCTAssertEqual(AidenBotMemoryCopy.count(try memory(user: [], notes: [])), "Nothing yet")
        XCTAssertEqual(AidenBotMemoryCopy.count(try memory(user: ["Prefers tea"], notes: [])), "1 thing")
        XCTAssertEqual(
            AidenBotMemoryCopy.count(try memory(user: ["a", "b", "c"], notes: ["d", "e", "f"])),
            "6 things"
        )
        XCTAssertEqual(
            AidenBotMemoryCopy.count(try memory(user: ["a"], notes: [], readable: false)),
            "Couldn’t be read"
        )
    }
}
