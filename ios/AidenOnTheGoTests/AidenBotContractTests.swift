import Foundation
import XCTest
@testable import AidenOnTheGo

final class AidenBotContractTests: XCTestCase {
    private var sharedContractFixtureURL: URL? {
        Bundle(for: Self.self).url(forResource: "contract", withExtension: "json")
    }

    private func sharedFixtureObject() throws -> [String: Any] {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any]
        )
    }

    private func data<Value>(for value: Value) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    private func assertSharedFixtureRejected(
        file: StaticString = #filePath,
        line: UInt = #line,
        _ mutation: (inout [String: Any]) throws -> Void
    ) throws {
        var fixture = try sharedFixtureObject()
        try mutation(&fixture)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.self,
                from: data(for: fixture)
            ),
            file: file,
            line: line
        )
    }

    private func assertCanonicalChatRejected(
        file: StaticString = #filePath,
        line: UInt = #line,
        _ mutation: (inout [String: Any]) throws -> Void
    ) throws {
        let fixture = try sharedFixtureObject()
        var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
        try mutation(&chat)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat)),
            file: file,
            line: line
        )
    }

    func testBotContractErrorsGiveSafeActionableRecoveryCopy() {
        let providerError = AidenBotContractError.invalidCombination(
            "no available provider and model"
        ).localizedDescription
        XCTAssertTrue(providerError.contains("Settings → Providers"))
        XCTAssertTrue(providerError.contains("chat model"))
        XCTAssertTrue(providerError.contains("Try Again"))
        XCTAssertFalse(providerError.contains("error 1"))

        XCTAssertTrue(
            AidenBotContractError.invalidCombination("unavailable custom access")
                .localizedDescription.contains("Review this Bot’s access choices"),
        )
        XCTAssertTrue(
            AidenBotContractError.invalidCombination("chat access exceeds bot")
                .localizedDescription.contains("Reduce the chat’s access"),
        )
        XCTAssertTrue(
            AidenBotContractError.invalidCombination("full access notice")
                .localizedDescription.contains("Full Access notice"),
        )

        let invalidField = AidenBotContractError.invalidField("providerId").localizedDescription
        let invalidCombination = AidenBotContractError.invalidCombination(
            "private internal invariant"
        ).localizedDescription
        XCTAssertEqual(invalidField, invalidCombination)
        XCTAssertFalse(invalidField.contains("providerId"))
        XCTAssertFalse(invalidCombination.contains("private internal invariant"))
        XCTAssertTrue(invalidField.contains("Update Aiden Agent"))
    }

    func testBotEditorNoProviderBranchReturnsProviderSetupRecovery() throws {
        var fixture = try sharedFixtureObject()
        let decodedFixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: try data(for: fixture)
        )
        var catalogObject = try XCTUnwrap(fixture["botCapabilityCatalog"] as? [String: Any])
        catalogObject["providers"] = []
        fixture["botCapabilityCatalog"] = catalogObject
        let catalog = try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: data(for: catalogObject)
        )

        XCTAssertThrowsError(
            try aidenBotEditorResolvedDraft(
                mode: .create(defaultAccess: .recommended),
                catalog: catalog,
                bot: nil
            )
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("Settings → Providers"))
            XCTAssertTrue(error.localizedDescription.contains("Try Again"))
        }
        XCTAssertThrowsError(
            try aidenBotEditorResolvedDraft(
                mode: .edit(botID: decodedFixture.botDetail.id),
                catalog: catalog,
                bot: decodedFixture.botDetail
            )
        ) { error in
            XCTAssertTrue(error.localizedDescription.contains("Settings → Providers"))
            XCTAssertTrue(error.localizedDescription.contains("Try Again"))
        }
    }

    func testCheckedInSharedFixtureDecodesEveryBotProjectionDirectly() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )

        XCTAssertEqual(fixture.botSummary.id, "bot_fixture_01")
        XCTAssertEqual(fixture.botList.maxBots, 256)
        XCTAssertEqual(fixture.botDetail.id, fixture.botPolicy.botId)
        XCTAssertEqual(fixture.botAvatarMetadata.mimeType, .png)
        XCTAssertEqual(fixture.botAvatarMetadata.width, 512)
        XCTAssertEqual(fixture.botCreate.response.avatar.semantic, fixture.botCreate.request.avatar)
        XCTAssertEqual(
            fixture.botCreate.request.access.catalogRevision,
            fixture.botCapabilityCatalog.revision
        )
        XCTAssertNil(fixture.botIdentity.response.openingGreeting)
        XCTAssertEqual(fixture.botArchive.bot.health, .archived)
        XCTAssertEqual(fixture.botRestore.bot.health, .ready)
        XCTAssertEqual(fixture.botConversation.activityState, .waitingForApproval)
        XCTAssertEqual(fixture.botConversations.conversations, [fixture.botConversation])
        XCTAssertEqual(fixture.botConversationQuery.limit, 30)
        XCTAssertEqual(fixture.botChatCreate.response.chat.botId, fixture.botDetail.id)
        XCTAssertTrue(fixture.botCapabilityCatalog.shellAvailable)
        XCTAssertEqual(fixture.botPolicy.accessMode, .full)
        XCTAssertEqual(fixture.botPolicyUpdate.response.accessMode, .custom)
        XCTAssertEqual(
            fixture.botPolicyUpdate.request.catalogRevision,
            fixture.botCapabilityCatalog.revision
        )
        XCTAssertEqual(fixture.botChatSubset.mode, .inherit)
        XCTAssertEqual(fixture.botChatSubsetUpdate.response.mode, .custom)
        XCTAssertEqual(
            fixture.botChatSubsetUpdate.request.expectedBotPolicyRevision,
            fixture.botPolicyUpdate.response.revision
        )
        XCTAssertEqual(fixture.botFavorites, fixture.botFavoritesUpdate.response)
        XCTAssertTrue(fixture.botNotice.requiresAcknowledgement)
        XCTAssertEqual(
            fixture.botNoticeAcknowledgement.response.acceptedDecision,
            .continueFull
        )
        XCTAssertEqual(fixture.botAvatarUpload.response, fixture.botAvatarMetadata)
        XCTAssertFalse(fixture.legacyNonNegotiating.server.capabilities.contains(.botRead))
    }

    func testBotResponsesTolerateUnknownAdditiveFieldsAtEveryNestingLevel() throws {
        let fixture = try sharedFixtureObject()
        var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        detail["futureDetail"] = true

        var avatar = try XCTUnwrap(detail["avatar"] as? [String: Any])
        avatar["futureAvatar"] = true
        var semantic = try XCTUnwrap(avatar["semantic"] as? [String: Any])
        semantic["futureRecipe"] = true
        avatar["semantic"] = semantic
        var asset = try XCTUnwrap(avatar["asset"] as? [String: Any])
        asset["futureAsset"] = true
        avatar["asset"] = asset
        detail["avatar"] = avatar

        var access = try XCTUnwrap(detail["access"] as? [String: Any])
        access["futureAccess"] = true
        detail["access"] = access

        let decoded = try AidenRemoteJSONDecoder.decode(
            AidenBotDetail.self,
            from: data(for: detail)
        )
        XCTAssertEqual(decoded.id, "bot_fixture_01")
        XCTAssertEqual(decoded.avatar.asset?.assetRevision, "avatar_revision_3")

        var notice = try XCTUnwrap(fixture["botNotice"] as? [String: Any])
        notice["futureNotice"] = ["displayHint": "safe"]
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenBotNoticeStatus.self,
                from: data(for: notice)
            )
        )

        detail["managedHomePath"] = "/Users/example/.aiden/bots/private"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: data(for: detail))
        )

        detail.removeValue(forKey: "managedHomePath")
        for forbiddenKey in [
            "authorizationHeader", "providerHeaders", "mcpHeaders", "connectionHeaders",
            "providerApiKey", "mcpApiKey", "connectionApiKey", "credentialMaterial",
            "skillPath", "skillPaths", "assetFilename", "avatarAssetFilename",
            "temporaryAssetURL", "temporaryURL",
        ] {
            detail["futureNested"] = [forbiddenKey: "private"]
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: data(for: detail)),
                "Expected recursive rejection for \(forbiddenKey)"
            )
        }

        detail.removeValue(forKey: "futureNested")
        detail["futureNested"] = ["systemPrompt": "private authority"]
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: data(for: detail))
        )

        for normalizedPrivateKey in [
            "Credential", "S_e.c-r e t", "API-Key", "access.token", "HEADERS",
            "end_point", "p a t h", "Tool-Args", "tool_results",
            "Reasoning.Content", "Instructions", "Opening-Greeting", "A\u{FEFF}PIKEY",
        ] {
            detail["futureNested"] = [normalizedPrivateKey: "private"]
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: data(for: detail)),
                "Expected normalized recursive rejection for \(normalizedPrivateKey)"
            )
        }

        for forbiddenKey in AidenRemoteProtocol.forbiddenWireKeys.sorted() {
            let alias = forbiddenKey
                .uppercased(with: Locale(identifier: "en_US"))
                .map { String($0) }
                .joined(separator: "_")
            detail["futureNested"] = [alias: "private"]
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: data(for: detail)),
                "Expected separator/case alias rejection for \(forbiddenKey)"
            )
        }

        let pairingBootstrap = try XCTUnwrap(fixture["pairingBootstrap"] as? [String: Any])
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.PairingBootstrap.self,
                from: data(for: pairingBootstrap)
            )
        )
        let pairingExchange = try XCTUnwrap(fixture["pairingExchange"] as? [String: Any])
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.PairingExchange.self,
                from: data(for: pairingExchange)
            )
        )
    }

    func testStandaloneAndSharedBotChatsRejectPrivateAdditionsButKeepKnownTimeline() throws {
        let fixture = try sharedFixtureObject()
        var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
        var messages = try XCTUnwrap(chat["messages"] as? [[String: Any]])
        messages[1]["timeline"] = Self.validTimeline()
        messages[1]["futureDisplay"] = ["safe": true]
        chat["futureChatDisplay"] = true
        chat["messages"] = messages
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat))
        )

        for privateKey in ["Reasoning_Content", "Tool-Arguments", "tool.result", "API Key"] {
            var unsafe = chat
            var unsafeMessages = try XCTUnwrap(unsafe["messages"] as? [[String: Any]])
            unsafeMessages[0]["futurePrivate"] = [privateKey: "private"]
            unsafe["messages"] = unsafeMessages
            XCTAssertThrowsError(
                try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: unsafe)),
                "Expected Bot Chat rejection for \(privateKey)"
            )
        }

        var createResponse = try XCTUnwrap(
            (fixture["botChatCreate"] as? [String: Any])?["response"] as? [String: Any]
        )
        createResponse["futureDisplay"] = ["safe": true]
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateResponse.self,
                from: data(for: createResponse)
            )
        )
        createResponse["futureDisplay"] = ["end-point": "https://private.invalid"]
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateResponse.self,
                from: data(for: createResponse)
            )
        )

        try assertSharedFixtureRejected { fixture in
            var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
            detail["futureDisplay"] = ["API_Key": "private"]
            fixture["botDetail"] = detail
        }
        try assertSharedFixtureRejected { fixture in
            var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
            var messages = try XCTUnwrap(chat["messages"] as? [[String: Any]])
            messages[0]["futureDisplay"] = ["Reasoning-Content": "private"]
            chat["messages"] = messages
            fixture["chat"] = chat
        }

        for alias in [
            "Provider_API-Key", "Authorization-Header", "Skill.Path",
            "Temporary Asset URL", "Avatar_Asset-Filename",
        ] {
            try assertSharedFixtureRejected { fixture in
                var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
                summary["futureDisplay"] = [alias: "private"]
                fixture["botSummary"] = summary
            }
        }
    }

    func testBotListNeverFavoritesAnArchivedBot() throws {
        let fixture = try sharedFixtureObject()
        var list = try XCTUnwrap(fixture["botList"] as? [String: Any])
        var bots = try XCTUnwrap(list["bots"] as? [[String: Any]])
        bots[0]["health"] = "archived"
        bots[0]["archivedAt"] = "2026-08-18T19:10:00.000Z"
        list["bots"] = bots

        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotList.self, from: data(for: list))
        )

        var favorites = try XCTUnwrap(list["favorites"] as? [String: Any])
        favorites["botIds"] = []
        list["favorites"] = favorites
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenBotList.self, from: data(for: list))
        )
    }

    func testReplacingFavoritesPreservesTheCurrentBotProjectionAndRevalidatesMembership() throws {
        let fixture = try sharedFixtureObject()
        let listObject = try XCTUnwrap(fixture["botList"] as? [String: Any])
        let list = try AidenRemoteJSONDecoder.decode(AidenBotList.self, from: data(for: listObject))
        let emptyFavorites = try AidenBotFavorites(botIds: [], revision: "favorites-next")
        let updated = try list.replacingFavorites(emptyFavorites)

        XCTAssertEqual(updated.bots, list.bots)
        XCTAssertEqual(updated.maxBots, list.maxBots)
        XCTAssertEqual(updated.favorites, emptyFavorites)

        let unknownFavorites = try AidenBotFavorites(
            botIds: ["bot-not-in-current-list"],
            revision: "favorites-invalid"
        )
        XCTAssertThrowsError(try list.replacingFavorites(unknownFavorites))
    }

    func testRequiredIdentityRevisionEpochAndPathSafeGrantFieldsFailClosed() throws {
        let fixture = try sharedFixtureObject()
        var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
        summary.removeValue(forKey: "id")
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: data(for: summary))
        )

        summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
        summary.removeValue(forKey: "revision")
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: data(for: summary))
        )

        var policy = try XCTUnwrap(fixture["botPolicy"] as? [String: Any])
        policy.removeValue(forKey: "policyEpoch")
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotAccessView.self, from: data(for: policy))
        )

        let unsafeGrant = Data(#"""
        {
          "providerId":"provider","modelId":"model","fileScopeIds":["../Documents"],
          "shellEnabled":false,"connectionIds":[],"skillIds":[],"otherCapabilityIds":[]
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotCustomSelection.self, from: unsafeGrant)
        )

        let missingModel = Data(#"""
        {
          "providerId":"provider","fileScopeIds":[],"shellEnabled":false,
          "connectionIds":[],"skillIds":[],"otherCapabilityIds":[]
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotCustomSelection.self, from: missingModel)
        )
    }

    func testSharedFixtureCrossIdentitiesFailClosed() throws {
        try assertSharedFixtureRejected { fixture in
            var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
            chat["botId"] = "bot_other"
            fixture["chat"] = chat
        }
        try assertSharedFixtureRejected { fixture in
            var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
            var access = try XCTUnwrap(detail["access"] as? [String: Any])
            access["botId"] = "bot_other"
            detail["access"] = access
            fixture["botDetail"] = detail
        }
        try assertSharedFixtureRejected { fixture in
            var favorites = try XCTUnwrap(fixture["botFavorites"] as? [String: Any])
            favorites["botIds"] = ["bot_unlisted"]
            fixture["botFavorites"] = favorites
        }
        try assertSharedFixtureRejected { fixture in
            var chatAccess = try XCTUnwrap(fixture["botChatSubset"] as? [String: Any])
            chatAccess["chatId"] = "chat_other"
            fixture["botChatSubset"] = chatAccess
        }
        try assertSharedFixtureRejected { fixture in
            var create = try XCTUnwrap(fixture["botChatCreate"] as? [String: Any])
            var response = try XCTUnwrap(create["response"] as? [String: Any])
            response["botId"] = "bot_other"
            create["response"] = response
            fixture["botChatCreate"] = create
        }
        try assertSharedFixtureRejected { fixture in
            var page = try XCTUnwrap(fixture["botConversations"] as? [String: Any])
            var conversations = try XCTUnwrap(page["conversations"] as? [[String: Any]])
            var unlisted = try XCTUnwrap(conversations.first)
            unlisted["chatId"] = "chat_unlisted_bot"
            unlisted["botId"] = "bot_unlisted"
            conversations.append(unlisted)
            page["conversations"] = conversations
            fixture["botConversations"] = page
        }
    }

    func testSharedFixtureBindsRevisionPairingAndInstallationIdentity() throws {
        var futureFixture = try sharedFixtureObject()
        futureFixture["contractRevision"] = 8
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.self,
                from: data(for: futureFixture)
            )
        )

        try assertSharedFixtureRejected { fixture in
            fixture["contractRevision"] = 6
        }
        try assertSharedFixtureRejected { fixture in
            var exchange = try XCTUnwrap(fixture["pairingExchange"] as? [String: Any])
            exchange["instanceId"] = "instance_other"
            fixture["pairingExchange"] = exchange
        }
        try assertSharedFixtureRejected { fixture in
            var exchange = try XCTUnwrap(fixture["pairingExchange"] as? [String: Any])
            exchange["endpoint"] = "https://other-fixture.example.test/api/aiden/v1"
            fixture["pairingExchange"] = exchange
        }
        try assertSharedFixtureRejected { fixture in
            var server = try XCTUnwrap(fixture["server"] as? [String: Any])
            server["instanceId"] = "instance_other"
            fixture["server"] = server
        }
        try assertSharedFixtureRejected { fixture in
            var server = try XCTUnwrap(fixture["server"] as? [String: Any])
            var grants = try XCTUnwrap(server["capabilities"] as? [String])
            grants.removeAll { $0 == "workspace:manage" }
            server["capabilities"] = grants
            fixture["server"] = server
        }
        try assertSharedFixtureRejected { fixture in
            var server = try XCTUnwrap(fixture["server"] as? [String: Any])
            var supported = try XCTUnwrap(server["serverCapabilities"] as? [String])
            supported.removeAll { $0 == "workspace:manage" }
            server["serverCapabilities"] = supported
            fixture["server"] = server
        }
        try assertSharedFixtureRejected { fixture in
            var legacy = try XCTUnwrap(fixture["legacyNonNegotiating"] as? [String: Any])
            var exchange = try XCTUnwrap(legacy["pairingExchange"] as? [String: Any])
            var server = try XCTUnwrap(legacy["server"] as? [String: Any])
            exchange["instanceId"] = "instance_other"
            server["instanceId"] = "instance_other"
            legacy["pairingExchange"] = exchange
            legacy["server"] = server
            fixture["legacyNonNegotiating"] = legacy
        }
    }

    func testSharedFixtureTreatsCustomSelectionArraysAsUnorderedSets() throws {
        var fixture = try sharedFixtureObject()

        var policyUpdate = try XCTUnwrap(fixture["botPolicyUpdate"] as? [String: Any])
        var policyResponse = try XCTUnwrap(policyUpdate["response"] as? [String: Any])
        var policyResponseCustom = try XCTUnwrap(policyResponse["custom"] as? [String: Any])
        policyResponseCustom["fileScopeIds"] = ["scope.documents", "scope.bot_home"]
        policyResponse["custom"] = policyResponseCustom
        policyUpdate["response"] = policyResponse
        fixture["botPolicyUpdate"] = policyUpdate

        var chatUpdate = try XCTUnwrap(fixture["botChatSubsetUpdate"] as? [String: Any])
        var chatRequest = try XCTUnwrap(chatUpdate["request"] as? [String: Any])
        var chatRequestCustom = try XCTUnwrap(chatRequest["custom"] as? [String: Any])
        chatRequestCustom["fileScopeIds"] = ["scope.bot_home", "scope.documents"]
        chatRequest["custom"] = chatRequestCustom
        chatUpdate["request"] = chatRequest
        var chatResponse = try XCTUnwrap(chatUpdate["response"] as? [String: Any])
        var chatResponseCustom = try XCTUnwrap(chatResponse["custom"] as? [String: Any])
        chatResponseCustom["fileScopeIds"] = ["scope.documents", "scope.bot_home"]
        chatResponse["custom"] = chatResponseCustom
        chatUpdate["response"] = chatResponse
        fixture["botChatSubsetUpdate"] = chatUpdate

        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.self,
                from: data(for: fixture)
            )
        )
    }

    func testSameRevisionPolicyProjectionUsesSemanticCustomEquality() throws {
        var fixture = try sharedFixtureObject()
        let update = try XCTUnwrap(fixture["botPolicyUpdate"] as? [String: Any])
        let updateResponse = try XCTUnwrap(update["response"] as? [String: Any])
        let canonicalCustom = try XCTUnwrap(updateResponse["custom"] as? [String: Any])

        var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
        var detailAccess = try XCTUnwrap(detail["access"] as? [String: Any])
        detailAccess["accessMode"] = "custom"
        detailAccess["custom"] = canonicalCustom
        detail["access"] = detailAccess
        fixture["botDetail"] = detail

        var policy = try XCTUnwrap(fixture["botPolicy"] as? [String: Any])
        var reorderedCustom = canonicalCustom
        reorderedCustom["fileScopeIds"] = ["scope.documents", "scope.bot_home"]
        policy["accessMode"] = "custom"
        policy["custom"] = reorderedCustom
        fixture["botPolicy"] = policy

        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.self,
                from: data(for: fixture)
            )
        )

        try assertSharedFixtureRejected { fixture in
            var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
            var detailAccess = try XCTUnwrap(detail["access"] as? [String: Any])
            detailAccess["summary"] = "A conflicting same-revision summary."
            detail["access"] = detailAccess
            fixture["botDetail"] = detail
        }
    }

    func testDifferingPolicyRevisionsMayRepresentAStaleProjection() throws {
        var fixture = try sharedFixtureObject()
        var policy = try XCTUnwrap(fixture["botPolicy"] as? [String: Any])
        policy["revision"] = "bot_policy_revision_stale"
        policy["policyEpoch"] = "bot_policy_epoch_stale"
        policy["summary"] = "A valid older policy projection."
        fixture["botPolicy"] = policy

        var chatSubset = try XCTUnwrap(fixture["botChatSubset"] as? [String: Any])
        chatSubset["botPolicyRevision"] = "bot_policy_revision_stale"
        fixture["botChatSubset"] = chatSubset

        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.self,
                from: data(for: fixture)
            )
        )
    }

    func testSharedFixtureProjectionAndLifecycleInvariantsFailClosed() throws {
        try assertSharedFixtureRejected { fixture in
            var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
            summary["health"] = "degraded"
            fixture["botSummary"] = summary

            var list = try XCTUnwrap(fixture["botList"] as? [String: Any])
            var bots = try XCTUnwrap(list["bots"] as? [[String: Any]])
            bots[0]["health"] = "degraded"
            list["bots"] = bots
            fixture["botList"] = list
        }
        try assertSharedFixtureRejected { fixture in
            var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
            summary["updatedAt"] = "2026-08-18T18:46:00.000Z"
            fixture["botSummary"] = summary

            var list = try XCTUnwrap(fixture["botList"] as? [String: Any])
            var bots = try XCTUnwrap(list["bots"] as? [[String: Any]])
            bots[0]["updatedAt"] = "2026-08-18T18:46:00.000Z"
            list["bots"] = bots
            fixture["botList"] = list
        }
        try assertSharedFixtureRejected { fixture in
            var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
            summary["health"] = "archived"
            summary["archivedAt"] = "2026-08-18T18:45:00.000Z"
            fixture["botSummary"] = summary

            var list = try XCTUnwrap(fixture["botList"] as? [String: Any])
            var bots = try XCTUnwrap(list["bots"] as? [[String: Any]])
            bots[0]["health"] = "archived"
            bots[0]["archivedAt"] = "2026-08-18T18:45:00.000Z"
            list["bots"] = bots
            fixture["botList"] = list
        }
        try assertSharedFixtureRejected { fixture in
            var archive = try XCTUnwrap(fixture["botArchive"] as? [String: Any])
            archive["openingGreeting"] = "A changed greeting"
            fixture["botArchive"] = archive
        }
        try assertSharedFixtureRejected { fixture in
            var restore = try XCTUnwrap(fixture["botRestore"] as? [String: Any])
            var avatar = try XCTUnwrap(restore["avatar"] as? [String: Any])
            var semantic = try XCTUnwrap(avatar["semantic"] as? [String: Any])
            semantic["color"] = "mint"
            avatar["semantic"] = semantic
            restore["avatar"] = avatar
            fixture["botRestore"] = restore
        }
        try assertSharedFixtureRejected { fixture in
            var archive = try XCTUnwrap(fixture["botArchive"] as? [String: Any])
            archive["createdAt"] = "2026-08-18T16:59:00.000Z"
            fixture["botArchive"] = archive
        }
    }

    func testAccessViewsAndMutationUnionsEnforceTheirDiscriminants() throws {
        XCTAssertEqual(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAccessUpdate.self,
                from: Data(
                    #"{"accessMode":"full","catalogRevision":"catalog_revision","confirmedForeground":true}"#.utf8
                )
            ),
            .full(catalogRevision: "catalog_revision")
        )
        XCTAssertEqual(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAccessUpdate.self,
                from: Data(
                    #"{"accessMode":"full","catalogRevision":"catalog_revision","confirmedForeground":true,"providerId":"provider_fixture","modelId":"model_fixture"}"#.utf8
                )
            ),
            .full(
                catalogRevision: "catalog_revision",
                selection: AidenBotModelSelection(
                    providerId: "provider_fixture",
                    modelId: "model_fixture"
                )
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAccessUpdate.self,
                from: Data(
                    #"{"accessMode":"full","catalogRevision":"catalog_revision","confirmedForeground":true,"providerId":"provider_fixture"}"#.utf8
                )
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAccessUpdate.self,
                from: Data(
                    #"{"accessMode":"full","catalogRevision":"catalog_revision","confirmedForeground":false}"#.utf8
                )
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAccessUpdate.self,
                from: Data(#"{"accessMode":"full","confirmedForeground":true}"#.utf8)
            )
        )

        let custom = Data(#"""
        {
          "accessMode":"custom","catalogRevision":"catalog_revision","custom":{
            "providerId":"provider","modelId":"model","fileScopeIds":[],
            "shellEnabled":false,"connectionIds":[],"skillIds":[],"otherCapabilityIds":[]
          }
        }
        """#.utf8)
        guard case let .custom(catalogRevision, selection) = try AidenRemoteJSONDecoder.decode(
            AidenBotAccessUpdate.self,
            from: custom
        ) else {
            return XCTFail("Expected Custom access")
        }
        XCTAssertEqual(catalogRevision, "catalog_revision")
        XCTAssertFalse(selection.shellEnabled)

        let nestedExtra = Data(#"""
        {
          "accessMode":"custom","catalogRevision":"catalog_revision","custom":{
            "providerId":"provider","modelId":"model","fileScopeIds":[],
            "shellEnabled":false,"connectionIds":[],"skillIds":[],"otherCapabilityIds":[],
            "unexpected":true
          }
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotAccessUpdate.self, from: nestedExtra)
        )

        let invalidFullView = Data(#"""
        {
          "botId":"bot_1","accessMode":"full","revision":"revision_1",
          "policyEpoch":"epoch_1","summary":"Full Access",
          "custom":{"providerId":"provider","modelId":"model","fileScopeIds":[],
            "shellEnabled":false,"connectionIds":[],"skillIds":[],"otherCapabilityIds":[]}
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotAccessView.self, from: invalidFullView)
        )

        let invalidInheritedView = Data(#"""
        {
          "chatId":"chat_1","botId":"bot_1","mode":"inherit","revision":"revision_1",
          "botPolicyRevision":"policy_1","summary":"Inherited",
          "custom":{"providerId":"provider","modelId":"model","fileScopeIds":[],
            "shellEnabled":false,"connectionIds":[],"skillIds":[],"otherCapabilityIds":[]}
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotChatAccessView.self, from: invalidInheritedView)
        )

        XCTAssertEqual(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatAccessUpdate.self,
                from: Data(
                    #"{"mode":"inherit","catalogRevision":"catalog_revision","expectedBotPolicyRevision":"policy_revision"}"#.utf8
                )
            ),
            .inherit(
                catalogRevision: "catalog_revision",
                expectedBotPolicyRevision: "policy_revision"
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatAccessUpdate.self,
                from: Data(#"{"mode":"inherit","catalogRevision":"catalog_revision"}"#.utf8)
            )
        )
    }

    func testMutationAvatarsAreNestedExactWhileResponseRecipesRemainAdditive() throws {
        let createWithExtraRecipeKey = Data(#"""
        {
          "name":"Scout","purpose":"","instructions":"Help.",
          "avatar":{"version":1,"shape":"orb","color":"sky","eyes":"wide","detail":"orbit","unexpected":true},
          "access":{"accessMode":"full","catalogRevision":"catalog_revision","confirmedForeground":true}
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotCreateRequest.self,
                from: createWithExtraRecipeKey
            )
        )

        let responseRecipe = Data(#"""
        {
          "semantic":{"version":1,"shape":"orb","color":"sky","eyes":"wide","detail":"orbit","future":true}
        }
        """#.utf8)
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenBotAvatarView.self, from: responseRecipe)
        )

        let createWithoutAccess = Data(#"""
        {
          "name":"Scout","purpose":"","instructions":"Help.",
          "avatar":{"version":1,"shape":"orb","color":"sky","eyes":"wide","detail":"orbit"}
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotCreateRequest.self, from: createWithoutAccess)
        )
    }

    func testBotChatCreateOverridePairAndProjectionBoundsFailClosed() throws {
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateRequest.self,
                from: Data(#"{}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateRequest.self,
                from: Data(#"{"providerId":"provider_fixture"}"#.utf8)
            )
        )

        let fixture = try sharedFixtureObject()
        let create = try XCTUnwrap(fixture["botChatCreate"] as? [String: Any])
        var response = try XCTUnwrap(create["response"] as? [String: Any])
        let messages: [[String: Any]] = (0..<10_000).map { index in
            [
                "id": "message_\(index)",
                "role": "user",
                "text": "",
                "createdAt": "2026-08-18T19:04:00.000Z",
            ]
        }
        response["messages"] = messages
        let maximumMessagesData = try data(for: response)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateResponse.self,
                from: maximumMessagesData
            )
        ) { error in
            XCTAssertEqual(error as? AidenRemoteContractError, .payloadTooLarge)
        }
        XCTAssertNoThrow(
            try JSONDecoder.aidenRemote().decode(
                AidenBotChatCreateResponse.self,
                from: maximumMessagesData
            )
        )

        var oversizedMessages = messages
        oversizedMessages.append([
            "id": "message_10000",
            "role": "user",
            "text": "",
            "createdAt": "2026-08-18T19:04:00.000Z",
        ])
        response["messages"] = oversizedMessages
        XCTAssertThrowsError(
            try JSONDecoder.aidenRemote().decode(
                AidenBotChatCreateResponse.self,
                from: data(for: response)
            )
        )

        response["messages"] = []
        response["title"] = String(repeating: "T", count: 1_025)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateResponse.self,
                from: data(for: response)
            )
        )

        response["title"] = ""
        response["createdAt"] = "2026-08-18T19:04:01.000Z"
        response["updatedAt"] = "2026-08-18T19:04:00.000Z"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateResponse.self,
                from: data(for: response)
            )
        )
    }

    func testGenericChatDecoderEnforcesBotAndMessageBoundsButToleratesAdditions() throws {
        let fixture = try sharedFixtureObject()
        var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
        chat["botId"] = "Bot.alpha:1_test-2"
        chat["futureChatField"] = ["safe": true]
        var messages = try XCTUnwrap(chat["messages"] as? [[String: Any]])
        messages[0]["futureMessageField"] = "safe"
        chat["messages"] = messages
        let decoded = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat))
        XCTAssertEqual(decoded.botId, "Bot.alpha:1_test-2")

        for unsafeBotID in ["../bot", "bot/slash", "bot\\windows", "bot space", "bót"] {
            try assertCanonicalChatRejected { candidate in
                candidate["botId"] = unsafeBotID
            }
        }
        try assertCanonicalChatRejected { candidate in
            var candidateMessages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            candidateMessages[0]["id"] = ""
            candidate["messages"] = candidateMessages
        }
        try assertCanonicalChatRejected { candidate in
            var candidateMessages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            candidateMessages[0]["id"] = String(repeating: "m", count: 129)
            candidate["messages"] = candidateMessages
        }
        try assertCanonicalChatRejected { candidate in
            var candidateMessages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            candidateMessages[0]["text"] = String(repeating: "t", count: 200_001)
            candidate["messages"] = candidateMessages
        }
        try assertCanonicalChatRejected { candidate in
            var candidateMessages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            candidateMessages[0]["attachments"] = (0..<21).map { index in
                [
                    "id": "attachment_\(index)",
                    "name": "note.txt",
                    "mimeType": "text/plain",
                    "kind": "text",
                    "size": 1,
                ] as [String: Any]
            }
            candidate["messages"] = candidateMessages
        }
        try assertCanonicalChatRejected { candidate in
            candidate["titlePending"] = false
        }
    }

    func testChatProviderModelPairAndPresentOptionalHintsFailClosed() throws {
        try assertCanonicalChatRejected { candidate in
            candidate.removeValue(forKey: "modelId")
        }
        try assertCanonicalChatRejected { candidate in
            candidate.removeValue(forKey: "providerId")
        }
        try assertCanonicalChatRejected { candidate in
            candidate["providerId"] = NSNull()
        }
        try assertCanonicalChatRejected { candidate in
            candidate["modelId"] = NSNull()
        }
        try assertCanonicalChatRejected { candidate in
            candidate["providerId"] = NSNull()
            candidate["modelId"] = NSNull()
        }
        try assertCanonicalChatRejected { candidate in
            candidate["titlePending"] = NSNull()
        }

        let fixture = try sharedFixtureObject()
        var response = try XCTUnwrap(
            (fixture["botChatCreate"] as? [String: Any])?["response"] as? [String: Any]
        )
        response["providerId"] = NSNull()
        response["modelId"] = NSNull()
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotChatCreateResponse.self,
                from: data(for: response)
            )
        )
    }

    func testChatTimelineValidatesCancellationClaimAndLegacyOffsets() throws {
        let fixture = try sharedFixtureObject()
        var validCancellation = try XCTUnwrap(fixture["chat"] as? [String: Any])
        var cancellationMessages = try XCTUnwrap(validCancellation["messages"] as? [[String: Any]])
        var cancellationTimeline = Self.validTimeline()
        cancellationTimeline["status"] = "cancelled"
        cancellationTimeline["cancellationOrigin"] = "user_stop"
        cancellationMessages[1]["timeline"] = cancellationTimeline
        validCancellation["messages"] = cancellationMessages
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: validCancellation))
        )

        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            timeline["cancellationOrigin"] = "user_stop"
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            timeline["status"] = "cancelled"
            timeline["cancellationOrigin"] = "future_origin"
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            timeline["status"] = "cancelled"
            timeline["cancellationOrigin"] = NSNull()
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }

        var validClaim = try XCTUnwrap(fixture["chat"] as? [String: Any])
        var claimMessages = try XCTUnwrap(validClaim["messages"] as? [[String: Any]])
        var claimTimeline = Self.validTimeline()
        var claimSteps = try XCTUnwrap(claimTimeline["steps"] as? [[String: Any]])
        claimSteps[0]["status"] = "failed"
        claimTimeline["steps"] = claimSteps
        claimTimeline["claimCheck"] = [
            "kind": "unverified_success",
            "stepIds": ["tool-1"],
        ]
        claimMessages[1]["timeline"] = claimTimeline
        validClaim["messages"] = claimMessages
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: validClaim))
        )

        for invalidStepIDs: [Any] in [[], ["tool-1", "tool-1"], ["tool-404"]] {
            try assertCanonicalChatRejected { candidate in
                var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
                var timeline = claimTimeline
                timeline["claimCheck"] = [
                    "kind": "unverified_success",
                    "stepIds": invalidStepIDs,
                ]
                messages[1]["timeline"] = timeline
                candidate["messages"] = messages
            }
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = claimTimeline
            timeline["status"] = "running"
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = claimTimeline
            timeline["claimCheck"] = NSNull()
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            timeline["version"] = 2
            var steps = try XCTUnwrap(timeline["steps"] as? [[String: Any]])
            steps[0]["contentOffset"] = -1
            timeline["steps"] = steps
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            var steps = try XCTUnwrap(timeline["steps"] as? [[String: Any]])
            steps[0]["order"] = 200
            timeline["steps"] = steps
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
    }

    func testGenericChatDecoderRejectsUnsafeNestedAttachmentOutcomeAndTimelineFields() throws {
        let fixture = try sharedFixtureObject()
        var validChat = try XCTUnwrap(fixture["chat"] as? [String: Any])
        var validMessages = try XCTUnwrap(validChat["messages"] as? [[String: Any]])
        validMessages[0]["attachments"] = [[
            "id": "attachment_fixture_01",
            "name": "protocol.txt",
            "mimeType": "text/plain",
            "kind": "text",
            "size": 42,
        ]]
        validMessages[0]["outcome"] = [
            "status": "failed",
            "category": "timeout",
            "attempts": 2,
            "retryExhausted": true,
        ]
        validMessages[1]["timeline"] = Self.validTimeline()
        validChat["messages"] = validMessages
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: validChat))
        )

        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["attachments"] = [[
                "id": "attachment/secret",
                "name": "protocol.txt",
                "mimeType": "text/plain",
                "kind": "text",
                "size": 42,
            ]]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["attachments"] = [[
                "id": "attachment_fixture_01",
                "name": "../protocol.txt",
                "mimeType": "text/plain",
                "kind": "text",
                "size": 42,
            ]]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["attachments"] = [[
                "id": "attachment_fixture_01",
                "name": "protocol.txt",
                "mimeType": String(repeating: "m", count: 121),
                "kind": "text",
                "size": 42,
            ]]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["attachments"] = [[
                "id": "attachment_fixture_01",
                "name": "protocol.txt",
                "mimeType": "text/plain",
                "kind": "text",
                "size": AidenRemoteProtocol.maxSafeInteger + 1,
            ]]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["outcome"] = [
                "status": "failed",
                "category": "private-provider-detail",
            ]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["outcome"] = [
                "status": "failed",
                "attempts": 17,
            ]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[0]["outcome"] = [
                "status": "failed",
                "category": NSNull(),
            ]
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            var steps = try XCTUnwrap(timeline["steps"] as? [[String: Any]])
            steps[0]["target"] = "/Users/private/secret"
            timeline["steps"] = steps
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            var steps = try XCTUnwrap(timeline["steps"] as? [[String: Any]])
            steps[0].removeValue(forKey: "toolCallId")
            timeline["steps"] = steps
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            var timeline = Self.validTimeline()
            var steps = try XCTUnwrap(timeline["steps"] as? [[String: Any]])
            steps[0]["contentOffset"] = 10_000
            timeline["steps"] = steps
            messages[1]["timeline"] = timeline
            candidate["messages"] = messages
        }
        try assertCanonicalChatRejected { candidate in
            var messages = try XCTUnwrap(candidate["messages"] as? [[String: Any]])
            messages[1]["timeline"] = NSNull()
            candidate["messages"] = messages
        }
    }

    func testGenericChatTimelineOffsetsUseJavaScriptUTF16CodeUnits() throws {
        let fixture = try sharedFixtureObject()
        var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
        var messages = try XCTUnwrap(chat["messages"] as? [[String: Any]])
        messages[1]["text"] = "😀"
        var timeline = Self.validTimeline()
        var steps = try XCTUnwrap(timeline["steps"] as? [[String: Any]])
        steps[0]["contentOffset"] = 2
        timeline["steps"] = steps
        messages[1]["timeline"] = timeline
        chat["messages"] = messages

        let decoded = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat))
        XCTAssertEqual(decoded.messages[1].timeline?.steps.first?.contentOffset, 2)

        steps[0]["contentOffset"] = 3
        timeline["steps"] = steps
        messages[1]["timeline"] = timeline
        chat["messages"] = messages
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat))
        )
    }

    func testConversationApprovalResponseRequiresWaitingState() throws {
        let fixture = try sharedFixtureObject()
        var conversation = try XCTUnwrap(fixture["botConversation"] as? [String: Any])
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenBotConversationItem.self,
                from: data(for: conversation)
            )
        )

        conversation["activityState"] = "idle"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotConversationItem.self,
                from: data(for: conversation)
            )
        )

        conversation["canRespondToApproval"] = false
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenBotConversationItem.self,
                from: data(for: conversation)
            )
        )
    }

    private static func validTimeline() -> [String: Any] {
        [
            "version": 3,
            "generationId": "stream_fixture_01",
            "status": "completed",
            "startedAt": 1_000,
            "finishedAt": 2_000,
            "steps": [[
                "id": "tool-1",
                "order": 0,
                "kind": "tool",
                "toolCallId": "call-1",
                "toolName": "read_file",
                "label": "Read file",
                "status": "completed",
                "startedAt": 1_000,
                "updatedAt": 2_000,
                "finishedAt": 2_000,
                "contentOffset": 0,
                "target": "README.md",
            ]],
        ]
    }

    func testIdentityPatchUsesEmptyGreetingToClearAndRejectsNullOrEmptyPatch() throws {
        let patch = try AidenRemoteJSONDecoder.decode(
            AidenBotIdentityPatch.self,
            from: Data(#"{"openingGreeting":""}"#.utf8)
        )
        XCTAssertEqual(patch.openingGreeting, "")
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotIdentityPatch.self,
                from: Data(#"{"openingGreeting":null}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotIdentityPatch.self, from: Data(#"{}"#.utf8))
        )
    }

    func testNoticeAndAvatarContractsFailClosedAtAuthorityBoundaries() throws {
        let incoherentNotice = Data(#"""
        {
          "version":"bot-full-access-v1","requiresAcknowledgement":true,
          "acceptedAt":"2026-08-18T19:03:00.000Z","acceptedDecision":"continue_full"
        }
        """#.utf8)
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotNoticeStatus.self, from: incoherentNotice)
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotNoticeStatus.self,
                from: Data(
                    #"{"version":"bot-full-access-v2","requiresAcknowledgement":true}"#.utf8
                )
            )
        )

        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotNoticeAcknowledgement.self,
                from: Data(#"{"version":"bot-full-access-v1","decision":"continue_full","confirmedForeground":false}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotNoticeAcknowledgement.self,
                from: Data(#"{"version":"bot-full-access-v2","decision":"continue_full","confirmedForeground":true}"#.utf8)
            )
        )

        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAvatarUpload.self,
                from: Data(#"{"mimeType":"image/jpeg","data":"AQID"}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAvatarUpload.self,
                from: Data(#"{"mimeType":"image/png","data":"AQID","unexpected":true}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAvatarAsset.self,
                from: Data(#"{"assetRevision":"asset_1","mimeType":"image/jpeg","width":512,"height":512,"byteSize":1}"#.utf8)
            )
        )
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotAvatarAsset.self,
                from: Data(#"{"assetRevision":"asset_1","mimeType":"image/png","width":511,"height":512,"byteSize":1}"#.utf8)
            )
        )
    }

    func testBotAndConversationTimestampsCannotMoveBackwards() throws {
        let fixture = try sharedFixtureObject()
        var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
        summary["updatedAt"] = "2026-08-18T16:59:59.000Z"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: data(for: summary))
        )

        var conversation = try XCTUnwrap(fixture["botConversation"] as? [String: Any])
        conversation["updatedAt"] = "2026-08-18T18:49:59.000Z"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotConversationItem.self,
                from: data(for: conversation)
            )
        )
    }

    func testSubMillisecondTimestampOrderingFailsClosed() throws {
        let fixture = try sharedFixtureObject()

        var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
        chat["createdAt"] = "2026-08-18T19:04:00.1239Z"
        chat["updatedAt"] = "2026-08-18T19:04:00.1230Z"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat))
        )

        var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
        summary["createdAt"] = "2026-08-18T19:04:00.1239Z"
        summary["updatedAt"] = "2026-08-18T19:04:00.1230Z"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenBotSummary.self, from: data(for: summary))
        )

        var conversation = try XCTUnwrap(fixture["botConversation"] as? [String: Any])
        conversation["createdAt"] = "2026-08-18T19:04:00.1239Z"
        conversation["updatedAt"] = "2026-08-18T19:04:00.1230Z"
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotConversationItem.self,
                from: data(for: conversation)
            )
        )

        chat["createdAt"] = "2026-08-18T19:04:00.1239000000000Z"
        chat["updatedAt"] = "2026-08-18T19:04:00.1239Z"
        XCTAssertNoThrow(
            try AidenRemoteJSONDecoder.decode(AidenChat.self, from: data(for: chat))
        )
    }

    func testSharedFixtureComparesCrossProjectionTimestampsAtFullWirePrecision() throws {
        try assertSharedFixtureRejected { fixture in
            var summary = try XCTUnwrap(fixture["botSummary"] as? [String: Any])
            summary["updatedAt"] = "2026-08-18T18:45:00.1239Z"
            fixture["botSummary"] = summary

            var list = try XCTUnwrap(fixture["botList"] as? [String: Any])
            var bots = try XCTUnwrap(list["bots"] as? [[String: Any]])
            bots[0]["updatedAt"] = "2026-08-18T18:45:00.1239Z"
            list["bots"] = bots
            fixture["botList"] = list

            var detail = try XCTUnwrap(fixture["botDetail"] as? [String: Any])
            detail["updatedAt"] = "2026-08-18T18:45:00.1230Z"
            fixture["botDetail"] = detail
        }

        try assertSharedFixtureRejected { fixture in
            var identity = try XCTUnwrap(fixture["botIdentity"] as? [String: Any])
            var response = try XCTUnwrap(identity["response"] as? [String: Any])
            response["createdAt"] = "2026-08-18T17:00:00.1239Z"
            identity["response"] = response
            fixture["botIdentity"] = identity

            var archive = try XCTUnwrap(fixture["botArchive"] as? [String: Any])
            archive["createdAt"] = "2026-08-18T17:00:00.1230Z"
            fixture["botArchive"] = archive

            var restore = try XCTUnwrap(fixture["botRestore"] as? [String: Any])
            restore["createdAt"] = "2026-08-18T17:00:00.1230Z"
            fixture["botRestore"] = restore
        }

        try assertSharedFixtureRejected { fixture in
            var conversation = try XCTUnwrap(fixture["botConversation"] as? [String: Any])
            conversation["updatedAt"] = "2026-08-18T19:00:00.1239Z"
            fixture["botConversation"] = conversation

            var page = try XCTUnwrap(fixture["botConversations"] as? [String: Any])
            var conversations = try XCTUnwrap(page["conversations"] as? [[String: Any]])
            conversations[0]["updatedAt"] = "2026-08-18T19:00:00.1230Z"
            page["conversations"] = conversations
            fixture["botConversations"] = page
        }
    }

    func testCatalogEnforces512AggregateModelCeiling() throws {
        let models: [[String: Any]] = (0..<256).map {
            ["id": "model_\($0)", "label": "Model \($0)", "available": true]
        }
        let catalog: [String: Any] = [
            "revision": "catalog_revision",
            "providers": [
                ["id": "provider_one", "label": "One", "available": true, "models": models],
                ["id": "provider_two", "label": "Two", "available": true, "models": models],
            ],
            "fileScopes": [],
            "shellAvailable": true,
            "connections": [],
            "skills": [],
            "otherCapabilities": [],
            "notice": [
                "version": "bot-full-access-v1",
                "requiresAcknowledgement": true,
            ],
        ]
        let decoded = try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: data(for: catalog)
        )
        XCTAssertEqual(decoded.providers.reduce(0) { $0 + $1.models.count }, 512)

        var oversizedCatalog = catalog
        var providers = try XCTUnwrap(oversizedCatalog["providers"] as? [[String: Any]])
        providers.append([
            "id": "provider_three",
            "label": "Three",
            "available": true,
            "models": [["id": "model_extra", "label": "Extra", "available": true]],
        ])
        oversizedCatalog["providers"] = providers
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenBotCapabilityCatalog.self,
                from: data(for: oversizedCatalog)
            )
        )
    }

    func testCatalogKeepsResponseTombstonesButRejectsUnavailableMutationSelections() throws {
        let fixture = try sharedFixtureObject()
        var catalogObject = try XCTUnwrap(fixture["botCapabilityCatalog"] as? [String: Any])
        var connections = try XCTUnwrap(catalogObject["connections"] as? [[String: Any]])
        connections[0]["available"] = false
        catalogObject["connections"] = connections
        let catalog = try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityCatalog.self,
            from: data(for: catalogObject)
        )

        let policyUpdate = try XCTUnwrap(fixture["botPolicyUpdate"] as? [String: Any])
        let request = try XCTUnwrap(policyUpdate["request"] as? [String: Any])
        let selectionObject = try XCTUnwrap(request["custom"] as? [String: Any])
        let selection = try AidenRemoteJSONDecoder.decode(
            AidenBotCustomSelection.self,
            from: data(for: selectionObject)
        )
        XCTAssertTrue(catalog.contains(selection))
        XCTAssertFalse(catalog.containsAvailable(selection))

        try assertSharedFixtureRejected { fixture in
            var catalog = try XCTUnwrap(fixture["botCapabilityCatalog"] as? [String: Any])
            var providers = try XCTUnwrap(catalog["providers"] as? [[String: Any]])
            providers[0]["available"] = false
            catalog["providers"] = providers
            fixture["botCapabilityCatalog"] = catalog
        }
        try assertSharedFixtureRejected { fixture in
            var catalog = try XCTUnwrap(fixture["botCapabilityCatalog"] as? [String: Any])
            var connections = try XCTUnwrap(catalog["connections"] as? [[String: Any]])
            connections[0]["available"] = false
            catalog["connections"] = connections
            fixture["botCapabilityCatalog"] = catalog
        }
        try assertSharedFixtureRejected { fixture in
            var catalog = try XCTUnwrap(fixture["botCapabilityCatalog"] as? [String: Any])
            catalog["shellAvailable"] = false
            fixture["botCapabilityCatalog"] = catalog

            var update = try XCTUnwrap(fixture["botPolicyUpdate"] as? [String: Any])
            var updateRequest = try XCTUnwrap(update["request"] as? [String: Any])
            var requestCustom = try XCTUnwrap(updateRequest["custom"] as? [String: Any])
            requestCustom["shellEnabled"] = true
            updateRequest["custom"] = requestCustom
            update["request"] = updateRequest
            var updateResponse = try XCTUnwrap(update["response"] as? [String: Any])
            var responseCustom = try XCTUnwrap(updateResponse["custom"] as? [String: Any])
            responseCustom["shellEnabled"] = true
            updateResponse["custom"] = responseCustom
            update["response"] = updateResponse
            fixture["botPolicyUpdate"] = update
        }
    }

    func testBotChatCreateResponseCannotSelectAnUnavailableProviderModelPair() throws {
        try assertSharedFixtureRejected { fixture in
            var catalog = try XCTUnwrap(fixture["botCapabilityCatalog"] as? [String: Any])
            var providers = try XCTUnwrap(catalog["providers"] as? [[String: Any]])
            providers.append([
                "id": "provider_tombstone",
                "label": "Unavailable provider",
                "available": true,
                "models": [[
                    "id": "model_tombstone",
                    "label": "Unavailable model",
                    "available": false,
                ]],
            ])
            catalog["providers"] = providers
            fixture["botCapabilityCatalog"] = catalog

            var create = try XCTUnwrap(fixture["botChatCreate"] as? [String: Any])
            var request = try XCTUnwrap(create["request"] as? [String: Any])
            request.removeValue(forKey: "providerId")
            request.removeValue(forKey: "modelId")
            create["request"] = request
            var response = try XCTUnwrap(create["response"] as? [String: Any])
            response["providerId"] = "provider_tombstone"
            response["modelId"] = "model_tombstone"
            create["response"] = response
            fixture["botChatCreate"] = create
        }
    }

    func testCanonicalBotChatCannotSelectAMissingProvider() throws {
        try assertSharedFixtureRejected { fixture in
            var chat = try XCTUnwrap(fixture["chat"] as? [String: Any])
            chat["providerId"] = "provider_missing"
            fixture["chat"] = chat
        }
    }

    func testSharedFixtureBindsMutationsToCatalogRevisionAndBotCeiling() throws {
        try assertSharedFixtureRejected { fixture in
            var update = try XCTUnwrap(fixture["botPolicyUpdate"] as? [String: Any])
            var request = try XCTUnwrap(update["request"] as? [String: Any])
            request["catalogRevision"] = "stale_catalog_revision"
            update["request"] = request
            fixture["botPolicyUpdate"] = update
        }
        try assertSharedFixtureRejected { fixture in
            var update = try XCTUnwrap(fixture["botChatSubsetUpdate"] as? [String: Any])
            var request = try XCTUnwrap(update["request"] as? [String: Any])
            request["expectedBotPolicyRevision"] = "stale_policy_revision"
            update["request"] = request
            fixture["botChatSubsetUpdate"] = update
        }
        try assertSharedFixtureRejected { fixture in
            var update = try XCTUnwrap(fixture["botChatSubsetUpdate"] as? [String: Any])
            var request = try XCTUnwrap(update["request"] as? [String: Any])
            var requestCustom = try XCTUnwrap(request["custom"] as? [String: Any])
            requestCustom["shellEnabled"] = true
            request["custom"] = requestCustom
            update["request"] = request
            var response = try XCTUnwrap(update["response"] as? [String: Any])
            var responseCustom = try XCTUnwrap(response["custom"] as? [String: Any])
            responseCustom["shellEnabled"] = true
            response["custom"] = responseCustom
            update["response"] = response
            fixture["botChatSubsetUpdate"] = update
        }
        try assertSharedFixtureRejected { fixture in
            var create = try XCTUnwrap(fixture["botCreate"] as? [String: Any])
            var request = try XCTUnwrap(create["request"] as? [String: Any])
            request["access"] = [
                "accessMode": "custom",
                "catalogRevision": "bot_catalog_revision_3",
                "custom": [
                    "providerId": "provider_fixture",
                    "modelId": "model_fixture",
                    "fileScopeIds": ["scope.bot_home"],
                    "shellEnabled": false,
                    "connectionIds": [],
                    "skillIds": [],
                    "otherCapabilityIds": [],
                ],
            ]
            create["request"] = request
            fixture["botCreate"] = create
        }
    }

    func testBotWriteAuthorityCannotExistWithoutBotRead() throws {
        let fixture = try sharedFixtureObject()
        var pairingExchange = try XCTUnwrap(fixture["pairingExchange"] as? [String: Any])
        let pairingCapabilities = try XCTUnwrap(pairingExchange["capabilities"] as? [String])
        pairingExchange["capabilities"] = pairingCapabilities.filter { $0 != "bot:read" }
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenRemoteContractFixture.PairingExchange.self,
                from: data(for: pairingExchange)
            )
        )

        var server = try XCTUnwrap(fixture["server"] as? [String: Any])
        let serverGrants = try XCTUnwrap(server["capabilities"] as? [String])
        server["capabilities"] = serverGrants.filter { $0 != "bot:read" }
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(AidenServer.self, from: data(for: server))
        )

        let installation: [String: Any] = [
            "instanceId": "instance_fixture_01",
            "deviceId": "device_fixture_01",
            "name": "Fixture Aiden",
            "endpoint": "https://aiden-fixture.example.test/api/aiden/v1",
            "serverSpkiSha256": "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "credentialScope": "fixture_scope",
            "capabilities": ["server:read", "bot:write"],
            "deviceCapabilities": ["server:read", "bot:write"],
            "serverCapabilities": ["server:read", "bot:read", "bot:write"],
            "createdAt": "2026-08-18T19:00:00.000Z",
        ]
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenInstallation.self,
                from: data(for: installation)
            )
        )

        let installationWithUnsupportedGrant: [String: Any] = [
            "instanceId": "instance_fixture_01",
            "deviceId": "device_fixture_01",
            "name": "Fixture Aiden",
            "endpoint": "https://aiden-fixture.example.test/api/aiden/v1",
            "serverSpkiSha256": "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "credentialScope": "fixture_scope",
            "capabilities": ["server:read", "workspace:manage"],
            "deviceCapabilities": ["server:read", "workspace:manage"],
            "serverCapabilities": ["server:read"],
            "createdAt": "2026-08-18T19:00:00.000Z",
        ]
        XCTAssertThrowsError(
            try AidenRemoteJSONDecoder.decode(
                AidenInstallation.self,
                from: data(for: installationWithUnsupportedGrant)
            )
        )

        try assertSharedFixtureRejected { fixture in
            let capabilities = try XCTUnwrap(fixture["capabilities"] as? [String])
            fixture["capabilities"] = capabilities.filter { $0 != "bot:read" }
        }
    }

    func testCustomAccessDraftStartsFromAllAvailableFullAccessChoices() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let draft = try XCTUnwrap(
            AidenBotCustomAccessDraft(
                access: fixture.botPolicy,
                catalog: fixture.botCapabilityCatalog
            )
        )

        XCTAssertTrue(draft.isSaveable(in: fixture.botCapabilityCatalog))
        XCTAssertEqual(
            draft.connectionIDs,
            Set(fixture.botCapabilityCatalog.connections.filter(\.available).map(\.id))
        )
        XCTAssertEqual(
            draft.skillIDs,
            Set(fixture.botCapabilityCatalog.skills.filter(\.available).map(\.id))
        )
        XCTAssertEqual(draft.shellEnabled, fixture.botCapabilityCatalog.shellAvailable)
    }

    func testCustomAccessDraftPreservesAnExistingCustomReduction() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let access = fixture.botPolicyUpdate.response
        let draft = try XCTUnwrap(
            AidenBotCustomAccessDraft(
                access: access,
                catalog: fixture.botCapabilityCatalog
            )
        )

        XCTAssertEqual(try draft.selection(), try XCTUnwrap(access.custom))
    }

    func testBotEditorCustomizeFirstBuildsCustomCreateRequestOnlyOnSave() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        var draft = try XCTUnwrap(
            AidenBotEditorDraft(catalog: fixture.botCapabilityCatalog, defaultAccess: .custom)
        )
        draft.name = "  Research Helper  "
        draft.purpose = "  Finds and explains sources  "
        draft.openingGreeting = "  What should we investigate?  "
        draft.instructions = "  Verify important claims before answering.  "

        XCTAssertFalse(draft.usesFullAccess)
        let request = try draft.createRequest(catalog: fixture.botCapabilityCatalog)
        XCTAssertEqual(request.name, "Research Helper")
        XCTAssertEqual(request.purpose, "Finds and explains sources")
        XCTAssertEqual(request.openingGreeting, "What should we investigate?")
        XCTAssertEqual(request.instructions, "Verify important claims before answering.")
        XCTAssertEqual(request.avatar, .recipe(AidenBotEditorDraft.defaultAvatar))
        guard case let .custom(revision, selection) = request.access else {
            return XCTFail("Customize First must create a Custom Bot")
        }
        XCTAssertEqual(revision, fixture.botCapabilityCatalog.revision)
        XCTAssertTrue(fixture.botCapabilityCatalog.containsAvailable(selection))
    }

    func testBotEditorIdentityDraftDoesNotCreateEmptyPatch() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let draft = try XCTUnwrap(
            AidenBotEditorDraft(
                detail: fixture.botDetail,
                catalog: fixture.botCapabilityCatalog
            )
        )

        XCTAssertNil(try draft.identityPatch(comparedTo: fixture.botDetail))
    }

    func testFullAccessBotModelIsOwnedByNewAndEditBotSettings() throws {
        var object = try sharedFixtureObject()
        var catalog = try XCTUnwrap(object["botCapabilityCatalog"] as? [String: Any])
        var providers = try XCTUnwrap(catalog["providers"] as? [[String: Any]])
        var provider = try XCTUnwrap(providers.first)
        var models = try XCTUnwrap(provider["models"] as? [[String: Any]])
        models.append(["id": "model_fixture_2", "label": "Fixture Model 2", "available": true])
        provider["models"] = models
        providers[0] = provider
        catalog["providers"] = providers
        let acceptedNotice: [String: Any] = [
            "version": "bot-full-access-v1",
            "requiresAcknowledgement": false,
            "acceptedAt": "2026-08-23T19:55:00.000Z",
            "acceptedDecision": "continue_full",
        ]
        catalog["notice"] = acceptedNotice
        object["botCapabilityCatalog"] = catalog
        object["botNotice"] = acceptedNotice
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: data(for: object)
        )
        var draft = try XCTUnwrap(
            AidenBotEditorDraft(detail: fixture.botDetail, catalog: fixture.botCapabilityCatalog)
        )
        XCTAssertEqual(draft.customAccess.modelID, "model_fixture")
        XCTAssertFalse(try draft.changesAccess(
            comparedTo: fixture.botDetail,
            catalog: fixture.botCapabilityCatalog
        ))

        draft.customAccess.modelID = "model_fixture_2"
        XCTAssertTrue(try draft.changesAccess(
            comparedTo: fixture.botDetail,
            catalog: fixture.botCapabilityCatalog
        ))
        guard case let .full(_, selection) = try draft.accessUpdate(catalog: fixture.botCapabilityCatalog) else {
            return XCTFail("Full Access must carry the model selected in Edit Bot")
        }
        XCTAssertEqual(selection?.providerId, "provider_fixture")
        XCTAssertEqual(selection?.modelId, "model_fixture_2")
    }

    func testBotEditorConflictRebasePreservesOnlyUserEditedFields() throws {
        var originalObject = try sharedFixtureObject()
        var originalCatalog = try XCTUnwrap(
            originalObject["botCapabilityCatalog"] as? [String: Any]
        )
        var providers = try XCTUnwrap(originalCatalog["providers"] as? [[String: Any]])
        var provider = try XCTUnwrap(providers.first)
        var models = try XCTUnwrap(provider["models"] as? [[String: Any]])
        models.append(["id": "model_fixture_2", "label": "Fixture Model 2", "available": true])
        provider["models"] = models
        providers[0] = provider
        originalCatalog["providers"] = providers
        originalObject["botCapabilityCatalog"] = originalCatalog
        let original = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: data(for: originalObject)
        )
        var userDraft = try XCTUnwrap(
            AidenBotEditorDraft(
                detail: original.botDetail,
                catalog: original.botCapabilityCatalog
            )
        )
        userDraft.name = "User-edited Scout"

        var authoritativeObject = originalObject
        var authoritativeBot = try XCTUnwrap(
            authoritativeObject["botDetail"] as? [String: Any]
        )
        authoritativeBot["purpose"] = "Purpose changed on the Mac"
        authoritativeBot["instructions"] = "Instructions changed on the Mac."
        authoritativeBot["revision"] = "bot_revision_8"
        authoritativeBot["modelSelection"] = [
            "providerId": "provider_fixture",
            "modelId": "model_fixture_2",
        ]
        authoritativeObject["botDetail"] = authoritativeBot
        let authoritative = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: data(for: authoritativeObject)
        )

        let rebased = try aidenBotEditorRebasedDraft(
            userDraft,
            baseline: original.botDetail,
            baselineCatalog: original.botCapabilityCatalog,
            authoritative: authoritative.botDetail,
            authoritativeCatalog: authoritative.botCapabilityCatalog
        )

        XCTAssertEqual(rebased.name, "User-edited Scout")
        XCTAssertEqual(rebased.purpose, "Purpose changed on the Mac")
        XCTAssertEqual(rebased.instructions, "Instructions changed on the Mac.")
        XCTAssertEqual(rebased.customAccess.modelID, "model_fixture_2")
    }

    func testBotEditorDirtyStateDistinguishesCleanCreateAndEditBaselines() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let cleanCreate = try XCTUnwrap(
            AidenBotEditorDraft(catalog: fixture.botCapabilityCatalog, defaultAccess: .custom)
        )
        XCTAssertFalse(aidenBotEditorIsDirty(
            draft: cleanCreate,
            cleanCreateDraft: cleanCreate,
            baselineBot: nil,
            catalog: fixture.botCapabilityCatalog,
            isCreating: true
        ))
        var dirtyCreate = cleanCreate
        dirtyCreate.name = "Helper"
        XCTAssertTrue(aidenBotEditorIsDirty(
            draft: dirtyCreate,
            cleanCreateDraft: cleanCreate,
            baselineBot: nil,
            catalog: fixture.botCapabilityCatalog,
            isCreating: true
        ))

        var editDraft = try XCTUnwrap(
            AidenBotEditorDraft(detail: fixture.botDetail, catalog: fixture.botCapabilityCatalog)
        )
        XCTAssertFalse(aidenBotEditorIsDirty(
            draft: editDraft,
            cleanCreateDraft: nil,
            baselineBot: fixture.botDetail,
            catalog: fixture.botCapabilityCatalog,
            isCreating: false
        ))
        XCTAssertTrue(aidenBotEditorIsDirty(
            draft: editDraft,
            cleanCreateDraft: nil,
            baselineBot: fixture.botDetail,
            catalog: fixture.botCapabilityCatalog,
            isCreating: false,
            hasAvatarCandidate: true
        ), "An accepted photo preview must require an explicit use or discard decision.")
        XCTAssertFalse(
            aidenBotEditorCanSubmitSettings(hasAvatarCandidate: true),
            "Settings Save must not dismiss and destroy an accepted photo preview."
        )
        editDraft.purpose += " updated"
        XCTAssertTrue(aidenBotEditorIsDirty(
            draft: editDraft,
            cleanCreateDraft: nil,
            baselineBot: fixture.botDetail,
            catalog: fixture.botCapabilityCatalog,
            isCreating: false
        ))
    }

    func testBotEditorCreateFailureFreezesOnlyAmbiguousOutcomes() {
        XCTAssertTrue(
            aidenBotEditorCreateFailureIsAmbiguous(URLError(.networkConnectionLost)),
            "A lost response may follow a committed POST and must retain the exact key."
        )
        XCTAssertTrue(
            aidenBotEditorCreateFailureIsAmbiguous(AidenRemoteClientError.invalidResponse),
            "A malformed success response is still ambiguous."
        )
        XCTAssertTrue(
            aidenBotEditorCreateFailureIsAmbiguous(AidenRemoteClientError.unexpectedStatus(503))
        )
        XCTAssertFalse(
            aidenBotEditorCreateFailureIsAmbiguous(AidenRemoteClientError.unexpectedStatus(409)),
            "A definite conflict must unlock the draft for correction."
        )
        XCTAssertFalse(
            aidenBotEditorCreateFailureIsAmbiguous(AidenRemoteClientError.unexpectedStatus(422)),
            "A validation response must unlock the draft for correction."
        )
    }

    func testCustomAccessDirtyStateUsesLoadedOrReconciledBaseline() throws {
        let fixtureURL = try XCTUnwrap(sharedContractFixtureURL)
        let fixture = try AidenRemoteJSONDecoder.decode(
            AidenRemoteContractFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
        let clean = try XCTUnwrap(
            AidenBotCustomAccessDraft(
                access: fixture.botPolicyUpdate.response,
                catalog: fixture.botCapabilityCatalog
            )
        )
        XCTAssertFalse(aidenBotCustomAccessIsDirty(draft: clean, cleanDraft: clean))
        var changed = clean
        changed.shellEnabled.toggle()
        XCTAssertTrue(aidenBotCustomAccessIsDirty(draft: changed, cleanDraft: clean))
        XCTAssertFalse(aidenBotCustomAccessIsDirty(draft: changed, cleanDraft: changed))
    }

    func testCustomAccessOnlyShowsAvailableOptionsAndSelectedTombstones() throws {
        let available = try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityOption.self,
            from: data(for: [
                "id": "skill:available",
                "label": "Available skill",
                "available": true,
                "description": "Ready to use",
            ])
        )
        let rejected = try AidenRemoteJSONDecoder.decode(
            AidenBotCapabilityOption.self,
            from: data(for: [
                "id": "skill:rejected",
                "label": "Invalid skill",
                "available": false,
                "description": "Unavailable",
            ])
        )

        XCTAssertEqual(
            aidenBotVisibleCapabilityOptions([available, rejected], selectedIDs: []),
            [available]
        )
        XCTAssertEqual(
            aidenBotVisibleCapabilityOptions(
                [available, rejected],
                selectedIDs: [rejected.id]
            ),
            [available, rejected]
        )
        XCTAssertEqual(
            aidenBotCapabilityOptionTitle(rejected, isSelected: true),
            "Previously selected skill — unavailable"
        )
    }

    func testCustomAccessOnlyRebasesExpectedRevisionConflicts() throws {
        let conflictEnvelope = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.self,
            from: data(for: [
                "error": [
                    "code": "operation_stale",
                    "message": "The capability catalog changed.",
                    "requestId": "request_test",
                    "retryable": false,
                ],
            ])
        )
        XCTAssertEqual(
            aidenBotAccessSaveFailureKind(
                AidenRemoteClientError.server(statusCode: 409, body: conflictEnvelope.error)
            ),
            .conflict
        )
        XCTAssertEqual(
            aidenBotAccessSaveFailureKind(
                AidenRemoteClientError.server(statusCode: 500, body: conflictEnvelope.error)
            ),
            .retryable
        )
        XCTAssertEqual(
            aidenBotAccessSaveFailureKind(AidenRemoteClientError.invalidResponse),
            .retryable
        )
    }

    func testFavoriteOrderSupportsMembershipAndStableReordering() {
        XCTAssertEqual(aidenBotFavoriteOrder(["a", "b"], moving: "c", .add), ["a", "b", "c"])
        XCTAssertEqual(aidenBotFavoriteOrder(["a", "b", "c"], moving: "b", .earlier), ["b", "a", "c"])
        XCTAssertEqual(aidenBotFavoriteOrder(["a", "b", "c"], moving: "b", .later), ["a", "c", "b"])
        XCTAssertEqual(aidenBotFavoriteOrder(["a", "b", "c"], moving: "b", .remove), ["a", "c"])
    }

    func testConversationDeletionRequiresIdleActiveWritableBot() throws {
        var fixture = try sharedFixtureObject()
        var conversation = try XCTUnwrap(fixture["botConversation"] as? [String: Any])
        conversation["activityState"] = "idle"
        conversation["canRespondToApproval"] = false
        fixture["botConversation"] = conversation
        let item = try AidenRemoteJSONDecoder.decode(
            AidenBotConversationItem.self,
            from: data(for: conversation)
        )

        XCTAssertTrue(aidenBotConversationCanDelete(item, botHealth: .ready, canWrite: true))
        XCTAssertFalse(aidenBotConversationCanDelete(item, botHealth: .archived, canWrite: true))
        XCTAssertFalse(aidenBotConversationCanDelete(item, botHealth: .ready, canWrite: false))
    }

    func testConversationSelectionAccessibilityExposesSelectedAndArchivedReadOnlyState() {
        let selected = aidenBotConversationSelectionAccessibility(
            isSelecting: true,
            isSelected: true,
            canDelete: true,
            botHealth: .ready,
            canWrite: true,
            activityState: .idle
        )
        XCTAssertEqual(selected.value, "Selected")
        XCTAssertTrue(selected.isSelected)
        XCTAssertEqual(selected.hint, "Selects this chat for deletion.")

        let archived = aidenBotConversationSelectionAccessibility(
            isSelecting: true,
            isSelected: false,
            canDelete: false,
            botHealth: .archived,
            canWrite: true,
            activityState: .idle
        )
        XCTAssertEqual(archived.value, "Not selected")
        XCTAssertFalse(archived.isSelected)
        XCTAssertEqual(archived.hint, "Archived Bot chats are read-only.")
    }

    func testSemanticAvatarPresentationPreservesRecipeAndMapsLegacyIdentity() {
        let recipe = AidenBotAvatarRecipe(
            shape: .hex,
            color: .coral,
            eyes: .wink,
            detail: .antenna
        )
        XCTAssertEqual(
            aidenBotAvatarPresentation(.recipe(recipe)),
            AidenBotAvatarPresentation(
                shape: .hex,
                color: .coral,
                eyes: .wink,
                detail: .antenna
            )
        )
        XCTAssertEqual(
            aidenBotAvatarPresentation(.legacy(.orbit)),
            AidenBotAvatarPresentation(
                shape: .orb,
                color: .lilac,
                eyes: .focus,
                detail: .orbit
            )
        )
    }
}
