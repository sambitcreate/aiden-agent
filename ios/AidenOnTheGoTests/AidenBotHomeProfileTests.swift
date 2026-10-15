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

    // MARK: Model choice (New Bot and Advanced)

    private func fixtureCatalog() throws -> AidenBotCapabilityCatalog {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: JSONSerialization.data(withJSONObject: try XCTUnwrap(object["botCapabilityCatalog"]))
        )
    }

    /// The fixture has a text-only `model_fixture` and an image-reading
    /// `vision_model_fixture` under `provider_fixture`.
    func testChoosingAModelPairsAPhotoModelOnlyWhenItReadsTextOnly() throws {
        let catalog = try fixtureCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))

        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.visionModelID, "vision_model_fixture")

        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "vision_model_fixture", catalog: catalog))
        XCTAssertNil(draft.visionModelID)

        XCTAssertFalse(draft.selectModel(providerID: "provider_fixture", modelID: "missing", catalog: catalog))
        XCTAssertEqual(draft.customAccess.modelID, "vision_model_fixture", "an unknown model changes nothing")
        XCTAssertFalse(draft.selectVisionModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog),
                       "a text-only model can't read photos")

        draft.name = "Seer"
        let request = try draft.createRequest(catalog: catalog)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let access = try XCTUnwrap(body["access"] as? [String: Any])
        XCTAssertEqual(access["modelId"] as? String, "vision_model_fixture", "Create sends the chosen model")
    }

    /// Re-confirming the checked primary or photo row must leave the draft equal to before, so
    /// the create view keeps a committed Bot's recovery state instead of posting a duplicate.
    func testReSelectingTheCurrentModelsLeavesTheDraftEqual() throws {
        let catalog = try fixtureCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.visionModelID, "vision_model_fixture")

        let beforePrimary = draft
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft, beforePrimary, "the checked primary model is a no-op")

        let beforePhotos = draft
        XCTAssertTrue(draft.selectVisionModel(providerID: "provider_fixture", modelID: "vision_model_fixture", catalog: catalog))
        XCTAssertEqual(draft, beforePhotos, "the checked photo model is a no-op")
    }

    func testModelListOffersOnlyImageModelsForPhotosAndFiltersBySearch() throws {
        let catalog = try fixtureCatalog()
        XCTAssertEqual(
            aidenBotModelListSections(catalog: catalog, imagesOnly: true, query: "").flatMap { $0.models.map(\.id) },
            ["vision_model_fixture"]
        )
        XCTAssertEqual(
            aidenBotModelListSections(catalog: catalog, imagesOnly: false, query: "VISION").flatMap { $0.models.map(\.id) },
            ["vision_model_fixture"]
        )
        XCTAssertTrue(aidenBotModelListSections(catalog: catalog, imagesOnly: false, query: "zzz").isEmpty)
    }

    /// The fixture catalog with extra models: `second_vision` (an image reader
    /// that is available), `offline_vision` (an image reader that is not), and
    /// a whole `offline_provider` that is not set up.
    private func extendedCatalog(secondVisionAvailable: Bool = true) throws -> AidenBotCapabilityCatalog {
        try editedCatalog { providers in
            var first = providers[0]
            var models = try XCTUnwrap(first["models"] as? [[String: Any]])
            models.append([
                "id": "second_vision", "label": "Second Vision",
                "available": secondVisionAvailable, "supportsImages": true,
            ])
            models.append(["id": "offline_vision", "label": "Offline Vision", "available": false, "supportsImages": true])
            first["models"] = models
            providers[0] = first
            providers.append([
                "id": "offline_provider", "label": "Offline Provider", "available": false,
                "models": [["id": "offline_model", "label": "Offline Model", "available": true, "supportsImages": true]],
            ])
        }
    }

    /// The fixture catalog with its providers changed by `edit`.
    private func editedCatalog(_ edit: (inout [[String: Any]]) throws -> Void) throws -> AidenBotCapabilityCatalog {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var raw = try XCTUnwrap(object["botCapabilityCatalog"] as? [String: Any])
        var providers = try XCTUnwrap(raw["providers"] as? [[String: Any]])
        try edit(&providers)
        raw["providers"] = providers
        return try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: JSONSerialization.data(withJSONObject: raw)
        )
    }

    /// The fixture catalog where the only image reader is not set up, so
    /// nothing on the Mac can read photos.
    private func textOnlyCatalog() throws -> AidenBotCapabilityCatalog {
        try editedCatalog { providers in
            var first = providers[0]
            var models = try XCTUnwrap(first["models"] as? [[String: Any]])
            for index in models.indices where models[index]["id"] as? String == "vision_model_fixture" {
                models[index]["available"] = false
            }
            first["models"] = models
            providers[0] = first
        }
    }

    func testUnavailableModelsAndProvidersAreNeverSelected() throws {
        let catalog = try extendedCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        let before = draft

        XCTAssertFalse(draft.selectModel(providerID: "provider_fixture", modelID: "offline_vision", catalog: catalog),
                       "an unavailable model")
        XCTAssertFalse(draft.selectModel(providerID: "offline_provider", modelID: "offline_model", catalog: catalog),
                       "an available model of an unavailable provider")
        XCTAssertFalse(draft.selectVisionModel(providerID: "provider_fixture", modelID: "offline_vision", catalog: catalog))
        XCTAssertFalse(draft.selectVisionModel(providerID: "offline_provider", modelID: "offline_model", catalog: catalog))
        XCTAssertEqual(draft, before, "refused picks change nothing")
    }

    func testTextOnlyChoiceKeepsAStillUsablePhotoModel() throws {
        let catalog = try extendedCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertTrue(draft.selectVisionModel(providerID: "provider_fixture", modelID: "second_vision", catalog: catalog))

        // Picking the text-only model again keeps the manually chosen photo model.
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.visionModelID, "second_vision")

        // An image-reading primary model clears it; going back to text-only re-suggests the first.
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "vision_model_fixture", catalog: catalog))
        XCTAssertNil(draft.visionModelID)
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.visionModelID, "vision_model_fixture")
    }

    func testAPhotoModelThatIsNoLongerUsableIsReplacedWithTheFirstUsableOne() throws {
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: try extendedCatalog(), defaultAccess: .recommended))
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: try extendedCatalog()))
        XCTAssertTrue(draft.selectVisionModel(providerID: "provider_fixture", modelID: "second_vision",
                                              catalog: try extendedCatalog()))

        // Second Vision's service signs it out before the Bot's model is picked again.
        let catalog = try extendedCatalog(secondVisionAvailable: false)
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.visionProviderID, "provider_fixture")
        XCTAssertEqual(draft.visionModelID, "vision_model_fixture")
        XCTAssertNoThrow(try draft.accessUpdate(catalog: catalog))
    }

    func testATextOnlyModelWithNoImageReaderOnTheMacStillSavesAndSaysWhy() throws {
        let catalog = try textOnlyCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))
        XCTAssertEqual(draft.customAccess.modelID, "model_fixture")
        XCTAssertNil(draft.visionModelID)
        XCTAssertEqual(draft.photoModelNeed(catalog: catalog), .unavailable, "New Bot and Advanced explain it")
        XCTAssertEqual(
            draft.noImageModelNote(catalog: catalog),
            "Fixture Model reads text only, and no model that reads images is set up on your Mac."
        )

        // New Bot creates it reading text only, and Advanced saves it the same way.
        draft.name = "Writer"
        let request = try draft.createRequest(catalog: catalog)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let access = try XCTUnwrap(body["access"] as? [String: Any])
        XCTAssertEqual(access["modelId"] as? String, "model_fixture")
        XCTAssertTrue(access["visionModel"] == nil || access["visionModel"] is NSNull, "no photo model is sent")
        XCTAssertNoThrow(try draft.accessUpdate(catalog: catalog))
    }

    func testPhotosRowShowsOnlyForATextOnlyModelWhenAnImageReaderIsSetUp() throws {
        let catalog = try fixtureCatalog()
        var draft = try XCTUnwrap(AidenBotEditorDraft(catalog: catalog, defaultAccess: .recommended))
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        XCTAssertEqual(draft.photoModelNeed(catalog: catalog), .choose)
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "vision_model_fixture", catalog: catalog))
        XCTAssertEqual(draft.photoModelNeed(catalog: catalog), .none)

        // With an image reader set up, a text-only Bot still can't be saved without a photo model.
        XCTAssertTrue(draft.selectModel(providerID: "provider_fixture", modelID: "model_fixture", catalog: catalog))
        draft.visionProviderID = nil
        draft.visionModelID = nil
        XCTAssertThrowsError(try draft.accessUpdate(catalog: catalog))
    }
}

/// R15: New Bot, Profile and Advanced apply at once, never wait on the
/// connection, and roll back with an error when the Mac doesn't take a change.
@MainActor
final class AidenBotInstantEditTests: XCTestCase {
    private struct Refused: Error {}

    private func shared() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func detail(id: String = "bot_fixture_01", revision: String = "bot_revision_7", name: String = "Scout") throws -> AidenBotDetail {
        var object = try XCTUnwrap(try shared()["botDetail"] as? [String: Any])
        object["id"] = id
        object["revision"] = revision
        object["name"] = name
        var access = try XCTUnwrap(object["access"] as? [String: Any])
        access["botId"] = id
        object["access"] = access
        return try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The fixture catalog, or the same catalog at another revision (the Mac changed something unrelated).
    private func catalog(revision: String? = nil) throws -> AidenBotCapabilityCatalog {
        var object = try XCTUnwrap(try shared()["botCapabilityCatalog"] as? [String: Any])
        if let revision { object["revision"] = revision }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }

    private func conflict() throws -> Error {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"revision_conflict","message":"changed","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        return AidenRemoteClientError.server(statusCode: 409, body: body)
    }

    // MARK: Profile

    func testProfileEditsGoInOrderOnTheNewestRevision() async throws {
        var sent: [(String?, String)] = []
        let saver = AidenBotIdentitySaver(
            send: { patch, revision in
                sent.append((patch.name, revision))
                return try self.detail(revision: "rev_\(sent.count + 7)", name: patch.name ?? "Scout")
            },
            refresh: { try self.detail() }
        )
        saver.adopt(try detail())
        let (one, two) = (try AidenBotIdentityPatch(name: "Scout II"), try AidenBotIdentityPatch(name: "Scout III"))
        async let first = saver.save(one)
        async let second = saver.save(two)
        let outcomes = await [first, second]
        XCTAssertEqual(sent.map(\.1), ["bot_revision_7", "rev_8"], "the second waits and goes on the first's revision")
        XCTAssertEqual(outcomes, [.saved(try detail(revision: "rev_8", name: "Scout II")), .saved(try detail(revision: "rev_9", name: "Scout III"))])
    }

    func testAProfileEditTheMacSavedThoughItsAnswerWasLostCountsAsSaved() async throws {
        let saver = AidenBotIdentitySaver(
            send: { _, _ in throw URLError(.networkConnectionLost) },
            refresh: { try self.detail(revision: "bot_revision_8", name: "Scout II") }
        )
        saver.adopt(try detail())
        let outcome = await saver.save(try AidenBotIdentityPatch(name: "Scout II"))
        XCTAssertEqual(outcome, .saved(try detail(revision: "bot_revision_8", name: "Scout II")))
    }

    func testARefusedProfileEditRollsBackToWhatTheMacHolds() async throws {
        var sent = 0
        let saver = AidenBotIdentitySaver(
            send: { _, _ in sent += 1; throw try self.conflict() },
            refresh: { try self.detail(revision: "bot_revision_9", name: "Scout (Mac)") }
        )
        saver.adopt(try detail())
        let outcome = await saver.save(try AidenBotIdentityPatch(name: "Scout II"))
        XCTAssertEqual(outcome, .failed(authoritative: try detail(revision: "bot_revision_9", name: "Scout (Mac)")))
        XCTAssertEqual(sent, 1)

        // Unreadable afterwards too: the page goes back to what it showed before.
        let unreadable = AidenBotIdentitySaver(send: { _, _ in throw Refused() }, refresh: { throw Refused() })
        unreadable.adopt(try detail())
        let lost = await unreadable.save(try AidenBotIdentityPatch(name: "Scout II"))
        XCTAssertEqual(lost, .failed(authoritative: nil))
    }

    func testAProfileEditWaitsForTheConnectionAndNeverSendsWithoutOne() async throws {
        var sent = 0
        var asked: [Duration] = []
        let saver = AidenBotIdentitySaver(
            send: { _, _ in sent += 1; return try self.detail(revision: "bot_revision_8") },
            refresh: { throw Refused() },
            waitForConnection: { hold in asked.append(hold); return false }
        )
        saver.adopt(try detail())
        let outcome = await saver.save(try AidenBotIdentityPatch(name: "Scout II"))
        XCTAssertEqual(outcome, .failed(authoritative: nil))
        XCTAssertEqual(sent, 0, "nothing goes out without the Mac")
        XCTAssertEqual(asked, [.seconds(8)], "it waits briefly for the connection first")
    }

    // MARK: Advanced

    private func operations(
        connected: Bool = true,
        identity: @escaping @MainActor (String, AidenBotIdentityPatch) async throws -> AidenBotDetail,
        readBot: @escaping @MainActor () async throws -> AidenBotDetail
    ) throws -> AidenBotAdvancedSaveOperations {
        let catalog = try catalog()
        return AidenBotAdvancedSaveOperations(
            waitForConnection: { _ in connected },
            updateIdentity: identity,
            updateAccess: { _, _ in },
            readBot: readBot,
            readCatalog: { catalog }
        )
    }

    func testAnAdvancedSaveSendsTheEditOnTheRevisionItWasMadeOn() async throws {
        let baseline = try detail()
        var draft = try XCTUnwrap(AidenBotEditorDraft(detail: baseline, catalog: try catalog()))
        draft.name = "Scout II"
        var revisions: [String] = []
        let outcome = await aidenBotAdvancedSave(
            draft: draft, baseline: baseline, catalog: try catalog(),
            operations: try operations(identity: { revision, patch in
                revisions.append(revision)
                return try self.detail(revision: "bot_revision_8", name: patch.name ?? "")
            }, readBot: { throw Refused() })
        )
        XCTAssertEqual(revisions, ["bot_revision_7"])
        XCTAssertEqual(outcome, .saved(try detail(revision: "bot_revision_8", name: "Scout II")))
    }

    func testAnAdvancedSaveWhoseAnswerWasLostButLandedIsSaved() async throws {
        let baseline = try detail()
        var draft = try XCTUnwrap(AidenBotEditorDraft(detail: baseline, catalog: try catalog()))
        draft.name = "Scout II"
        let outcome = await aidenBotAdvancedSave(
            draft: draft, baseline: baseline, catalog: try catalog(),
            operations: try operations(
                identity: { _, _ in throw URLError(.networkConnectionLost) },
                readBot: { try self.detail(revision: "bot_revision_8", name: "Scout II") }
            )
        )
        XCTAssertEqual(outcome, .saved(try detail(revision: "bot_revision_8", name: "Scout II")))
    }

    func testAnAdvancedSaveThatDidNotStickSaysSoBehindTheClosedPage() async throws {
        let baseline = try detail()
        var draft = try XCTUnwrap(AidenBotEditorDraft(detail: baseline, catalog: try catalog()))
        draft.name = "Scout II"
        let changed = await aidenBotAdvancedSave(
            draft: draft, baseline: baseline, catalog: try catalog(),
            operations: try operations(
                identity: { _, _ in throw try self.conflict() },
                readBot: { try self.detail(revision: "bot_revision_9", name: "Scout") }
            )
        )
        XCTAssertEqual(changed, .failed(AidenBotAdvancedCopy.changedOnMac))

        var sent = 0
        let offline = await aidenBotAdvancedSave(
            draft: draft, baseline: baseline, catalog: try catalog(),
            operations: try operations(connected: false, identity: { _, _ in
                sent += 1
                return try self.detail()
            }, readBot: { try self.detail() })
        )
        XCTAssertEqual(offline, .failed(AidenBotAdvancedCopy.unreachable))
        XCTAssertEqual(sent, 0)
    }

    // MARK: New Bot

    /// A scripted Mac for New Bot, recording what reached it.
    private final class CreateMac {
        var creates: [(request: AidenBotCreateRequest, key: UUID)] = []
        var chats: [UUID] = []
        var createErrors: [Error] = []
        var chatErrors: [Error] = []
        var hold: CheckedContinuation<Void, Never>?
        var holds = false
    }

    private func createOperations(
        _ mac: CreateMac,
        connected: Bool = true,
        durable: Bool = true,
        catalogRevision: String? = nil
    ) throws -> AidenBotCreateOperations {
        let catalog = try catalog(revision: catalogRevision)
        return AidenBotCreateOperations(
            scope: "mac_a|device_1",
            usesDurableSession: durable,
            waitForConnection: { _ in connected },
            catalog: { catalog },
            create: { request, key in
                mac.creates.append((request, key))
                if mac.holds { await withCheckedContinuation { mac.hold = $0 } }
                if !mac.createErrors.isEmpty { throw mac.createErrors.removeFirst() }
                return try self.detail(id: "bot_new_01", revision: "bot_revision_1", name: request.name)
            },
            createChat: { _, _, key in
                mac.chats.append(key)
                if !mac.chatErrors.isEmpty { throw mac.chatErrors.removeFirst() }
            },
            readBot: { id in try self.detail(id: id, revision: "bot_revision_2", name: "Planner") }
        )
    }

    private let input = AidenBotCreateInput(name: "  Planner ", purpose: "Plans my week", draft: nil)

    func testCreateShowsTheBotAtOnceAndOpensItOnceTheMacHasIt() async throws {
        let mac = CreateMac()
        mac.holds = true
        let flow = AidenBotCreateFlow()
        var created: [AidenBotDetail] = []
        let operations = try createOperations(mac)
        let task = Task { await flow.submit(self.input, operations: operations) { created.append($0) } }
        let deadline = Date().addingTimeInterval(5)
        while mac.hold == nil {
            guard Date() < deadline else { return XCTFail("the create never went out") }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(flow.pending?.name, "Planner", "the row shows before the Mac answers")
        mac.hold?.resume()
        await task.value
        XCTAssertNil(flow.pending)
        XCTAssertNil(flow.failure)
        XCTAssertEqual(created.map(\.revision), ["bot_revision_2"], "the Mac's own Bot opens")
        let sent = try XCTUnwrap(mac.creates.first?.request)
        XCTAssertEqual(sent.name, "Planner")
        XCTAssertNotNil(sent.access, "no model picked: the Mac's recommended one")
    }

    func testAFailedCreateOffersTryAgainWithTheSameBotAndNeverMakesTwo() async throws {
        let mac = CreateMac()
        let flow = AidenBotCreateFlow()
        var created = 0

        // Lost on the way: Try Again replays the same key.
        mac.createErrors = [URLError(.networkConnectionLost)]
        await flow.submit(input, operations: try createOperations(mac)) { _ in created += 1 }
        let failure = try XCTUnwrap(flow.failure)
        XCTAssertEqual(failure.input, input, "Try Again brings New Bot back as it was")
        XCTAssertNil(flow.pending, "the row goes")
        await flow.submit(failure.input, operations: try createOperations(mac)) { _ in created += 1 }
        XCTAssertEqual(mac.creates.count, 2)
        XCTAssertEqual(mac.creates[0].key, mac.creates[1].key, "the Mac may have made it: same key")
        XCTAssertEqual(created, 1)

        // Refused outright: the next try is a new request.
        mac.createErrors = [try conflict()]
        await flow.submit(input, operations: try createOperations(mac)) { _ in created += 1 }
        await flow.submit(input, operations: try createOperations(mac)) { _ in created += 1 }
        XCTAssertNotEqual(mac.creates[2].key, mac.creates[3].key)
    }

    func testTryAgainAfterALostCreateReplaysTheSameRequestThroughACatalogChange() async throws {
        let mac = CreateMac()
        mac.createErrors = [URLError(.networkConnectionLost)]
        let flow = AidenBotCreateFlow()
        var created = 0

        // The Create answer is lost; while the person is away the Mac's catalog moves on.
        await flow.submit(input, operations: try createOperations(mac, catalogRevision: "catalog_rev_4")) { _ in created += 1 }
        let failure = try XCTUnwrap(flow.failure)
        await flow.submit(failure.input, operations: try createOperations(mac, catalogRevision: "catalog_rev_5")) { _ in created += 1 }

        XCTAssertEqual(mac.creates.count, 2)
        XCTAssertEqual(mac.creates[1].request, mac.creates[0].request, "Try Again sends the frozen body, not one built from the new catalog")
        XCTAssertEqual(mac.creates[1].key, mac.creates[0].key, "the Mac may have made the Bot: same Idempotency-Key")
        XCTAssertEqual(created, 1, "one Bot")

        // Lost again, then the person renames it: that is a new ask, on a new key.
        mac.createErrors = [URLError(.networkConnectionLost)]
        await flow.submit(input, operations: try createOperations(mac, catalogRevision: "catalog_rev_5")) { _ in created += 1 }
        var renamed = try XCTUnwrap(flow.failure).input
        renamed.name = "Weekly Planner"
        await flow.submit(renamed, operations: try createOperations(mac, catalogRevision: "catalog_rev_5")) { _ in created += 1 }
        XCTAssertEqual(mac.creates.count, 4)
        XCTAssertNotEqual(mac.creates[3].key, mac.creates[2].key)
        XCTAssertEqual(mac.creates[3].request.name, "Weekly Planner")
    }

    func testABotMadeBeforeItsChatFailedIsNotMadeAgain() async throws {
        let mac = CreateMac()
        mac.chatErrors = [URLError(.timedOut)]
        let flow = AidenBotCreateFlow()
        await flow.submit(input, operations: try createOperations(mac, durable: false)) { _ in }
        XCTAssertNotNil(flow.failure)
        await flow.submit(input, operations: try createOperations(mac, durable: false)) { _ in }
        XCTAssertEqual(mac.creates.count, 1, "the Bot already made is kept")
        XCTAssertEqual(mac.chats.count, 2)
        XCTAssertEqual(mac.chats[0], mac.chats[1], "its chat retries under the same key")
        XCTAssertNil(flow.failure)
    }

    func testACreateThatNeverReachesTheMacSaysSoAndSendsNothing() async throws {
        let mac = CreateMac()
        let flow = AidenBotCreateFlow()
        await flow.submit(input, operations: try createOperations(mac, connected: false)) { _ in }
        XCTAssertEqual(flow.failure?.message, AidenBotCreateFlow.unreachable)
        XCTAssertEqual(mac.creates.count, 0)
        XCTAssertNil(flow.pending)
    }
}
