import XCTest
@testable import AidenOnTheGo

/// Contract revision 66: the phone's Agent Slider. The shared fixture's
/// slider, the resolver's stop, step and Custom rules (expected values worked
/// out by hand from the stop lists below), and how a chat's selection lands.
final class AidenAgentSliderTests: XCTestCase {
    // MARK: - Shared fixture

    private func fixtureData(at keyPath: [String]) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        var value: Any = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        for key in keyPath { value = try XCTUnwrap((value as? [String: Any])?[key], key) }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    func testTheFixtureSliderDecodesWithEachStopsAvailabilityAndHome() throws {
        let catalog = try AidenRemoteJSONDecoder.decode(
            AidenModelCatalog.self, from: fixtureData(at: ["agentSlider", "models"])
        )
        let slider = try XCTUnwrap(catalog.agentSlider)
        XCTAssertEqual(slider.stops.map(\.id), ["stop_0a1b2c3d", "stop_1b2c3d4e", "stop_2c3d4e5f", "stop_3d4e5f6a", "stop_4e5f6a7b"])
        XCTAssertEqual(slider.homeStopId, "stop_1b2c3d4e")
        XCTAssertEqual(AidenAgentSliderResolver.homeStopIndex(slider), 1)
        XCTAssertNil(slider.stops[0].thinkingLevel, "a stop on a model with no levels sets none")
        XCTAssertEqual(slider.stops[3].availability, .notSignedIn)
        XCTAssertEqual(slider.stops[4].availability, .unassigned)
        XCTAssertNil(slider.stops[4].modelId)

        let views = AidenAgentSliderResolver.views(for: slider, catalog: catalog)
        XCTAssertEqual(views.map(\.isAvailable), [true, true, true, false, false])
        XCTAssertEqual(views[1].detail, "Fixture Model · Medium")
        XCTAssertEqual(views[0].detail, "Quick")
        // The provider isn't in this phone's catalog, so the slider names it by id.
        XCTAssertEqual(views[3].detail, "Sign in to provider_fixture_other")
        XCTAssertEqual(views[4].detail, "Choose a model")
    }

    func testTheFixtureChatSitsOnItsStopAndATurnOnThatStopIsTheFixtureRequest() throws {
        let catalog = try AidenRemoteJSONDecoder.decode(
            AidenModelCatalog.self, from: fixtureData(at: ["agentSlider", "models"])
        )
        let slider = try XCTUnwrap(catalog.agentSlider)
        let chat = try AidenRemoteJSONDecoder.decode(AidenChat.self, from: fixtureData(at: ["agentSlider", "chat"]))
        XCTAssertEqual(chat.thinkingLevel, "high")
        let state = AidenAgentSliderState(
            slider: slider,
            catalog: catalog,
            selection: AidenChatModelSelection(providerId: chat.providerId, modelId: chat.modelId, thinkingLevel: chat.thinkingLevel)
        )
        XCTAssertEqual(state.currentStop?.label, "Deep")

        let selection = try XCTUnwrap(state.currentStop?.turnSelection)
        let request = AidenTurnRequestBuilder.make(
            text: "Think harder about this.",
            providerId: selection.providerId,
            modelId: selection.modelId,
            thinkingLevel: selection.thinkingLevel,
            attachments: []
        )
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? NSDictionary
        let expected = try JSONSerialization.jsonObject(with: fixtureData(at: ["agentSlider", "turnRequest"])) as? NSDictionary
        XCTAssertEqual(encoded, expected)
    }

    /// An older Mac sends no slider, and a slider that breaks the contract is
    /// dropped without costing the phone its model list.
    func testAMissingOrBrokenSliderLeavesTheModelListAndNoSlider() throws {
        var raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: fixtureData(at: ["agentSlider", "models"])) as? [String: Any]
        )
        func decode() throws -> AidenModelCatalog {
            try AidenRemoteJSONDecoder.decode(AidenModelCatalog.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        var slider = try XCTUnwrap(raw["agentSlider"] as? [String: Any])

        raw["agentSlider"] = nil
        XCTAssertNil(try decode().agentSlider)
        XCTAssertEqual(try decode().providers.map(\.id), ["provider_fixture"])

        let broken: [(String, ([String: Any]) -> [String: Any])] = [
            ("home is not a stop", { var value = $0; value["homeStopId"] = "stop_gone"; return value }),
            ("fewer than three stops", { var value = $0; value["stops"] = Array(($0["stops"] as? [Any] ?? []).prefix(2)); return value }),
            ("an unknown availability", { value in
                var value = value
                var stops = value["stops"] as? [[String: Any]] ?? []
                stops[0]["availability"] = "sleeping"
                value["stops"] = stops
                return value
            }),
            ("a model with no provider", { value in
                var value = value
                var stops = value["stops"] as? [[String: Any]] ?? []
                stops[1]["providerId"] = nil
                value["stops"] = stops
                return value
            }),
        ]
        for (why, breakSlider) in broken {
            raw["agentSlider"] = breakSlider(slider)
            let catalog = try decode()
            XCTAssertNil(catalog.agentSlider, why)
            XCTAssertEqual(catalog.providers.map(\.id), ["provider_fixture"], why)
        }
        slider["homeStopId"] = "stop_2c3d4e5f"
        raw["agentSlider"] = slider
        XCTAssertEqual(try decode().agentSlider?.homeStopId, "stop_2c3d4e5f")
    }

    // MARK: - Resolver

    private static let catalog = try! AidenRemoteJSONDecoder.decode(
        AidenModelCatalog.self,
        from: Data(#"{"providers":[{"id":"acme","label":"Acme","models":[{"id":"small","label":"Small","thinkingLevels":["low","medium","high"],"defaultThinkingLevel":"medium"},{"id":"large","label":"Large","thinkingLevels":["low","high"],"defaultThinkingLevel":"high"}]}],"defaults":{"providerId":"acme","modelId":"small"}}"#.utf8)
    )

    /// Index: 0 Fast (ready), 1 Off (no model), 2 Mid (home, ready),
    /// 3 Gone (provider removed), 4 Big (ready, no level).
    private static let slider = AidenAgentSlider(
        stops: [
            AidenAgentSliderStop(id: "fast", label: "Fast", providerId: "acme", modelId: "small", thinkingLevel: "low", availability: .ready),
            AidenAgentSliderStop(id: "off", label: "Off", availability: .unassigned),
            AidenAgentSliderStop(id: "mid", label: "Mid", providerId: "acme", modelId: "small", thinkingLevel: "medium", availability: .ready),
            AidenAgentSliderStop(id: "gone", label: "Gone", providerId: "old", modelId: "m", thinkingLevel: "high", availability: .providerMissing),
            AidenAgentSliderStop(id: "big", label: "Big", providerId: "acme", modelId: "large", availability: .ready),
        ],
        homeStopId: "mid"
    )

    private func state(_ providerId: String?, _ modelId: String?, _ level: String?) -> AidenAgentSliderState {
        AidenAgentSliderState(
            slider: Self.slider,
            catalog: Self.catalog,
            selection: AidenChatModelSelection(providerId: providerId, modelId: modelId, thinkingLevel: level)
        )
    }

    func testTheActiveStopNeedsTheExactLevelAndAMissingLevelMatchesOnlyALevellessStop() {
        XCTAssertEqual(state("acme", "small", "medium").position, AidenAgentSliderPosition(stopIndex: 2, thumbIndex: 2))
        XCTAssertEqual(state("acme", "small", "low").position.stopIndex, 0)
        // The same model at a level no stop names is Custom, with the thumb home.
        XCTAssertEqual(state("acme", "small", "high").position, AidenAgentSliderPosition(stopIndex: nil, thumbIndex: 2))
        // Big sets no level: only a selection with no level sits on it.
        XCTAssertEqual(state("acme", "large", nil).position.stopIndex, 4)
        XCTAssertNil(state("acme", "large", "high").position.stopIndex, "the model's default level is not the stop's nil")
        XCTAssertNil(state("acme", "small", nil).position.stopIndex)
        XCTAssertNil(state(nil, nil, nil).position.stopIndex)
    }

    func testAStepSkipsStopsThatCantRunAndStopsAtTheEnds() {
        let views = state("acme", "small", "low").views
        func step(from stop: Int?, _ direction: Int) -> Int? {
            AidenAgentSliderResolver.step(views, from: AidenAgentSliderPosition(stopIndex: stop, thumbIndex: stop ?? 2), direction: direction)
        }
        XCTAssertEqual(step(from: 0, 1), 2, "Off has no model")
        XCTAssertEqual(step(from: 2, 1), 4, "Gone's provider was removed")
        XCTAssertEqual(step(from: 2, -1), 0)
        XCTAssertNil(step(from: 4, 1))
        XCTAssertNil(step(from: 0, -1))
        // From Custom the step starts at home.
        XCTAssertEqual(step(from: nil, 1), 4)
        XCTAssertEqual(step(from: nil, -1), 0)
    }

    func testFromCustomWithNothingThatWayARunnableHomeIsTheStep() {
        let slider = AidenAgentSlider(
            stops: [
                AidenAgentSliderStop(id: "a", label: "A", availability: .unassigned),
                AidenAgentSliderStop(id: "b", label: "B", providerId: "acme", modelId: "small", thinkingLevel: "low", availability: .ready),
                AidenAgentSliderStop(id: "c", label: "C", providerId: "acme", modelId: "large", thinkingLevel: "low", availability: .hidden),
            ],
            homeStopId: "b"
        )
        let views = AidenAgentSliderResolver.views(for: slider, catalog: Self.catalog)
        let custom = AidenAgentSliderPosition(stopIndex: nil, thumbIndex: 1)
        XCTAssertEqual(AidenAgentSliderResolver.step(views, from: custom, direction: -1), 1)
        XCTAssertEqual(AidenAgentSliderResolver.step(views, from: custom, direction: 1), 1)
        XCTAssertNil(AidenAgentSliderResolver.step(views, from: AidenAgentSliderPosition(stopIndex: 1, thumbIndex: 1), direction: 1))
    }

    /// The Mac may call a stop ready while this phone's catalog doesn't list
    /// its model; the phone can't send it, so it reads "Model not found".
    func testAReadyStopWhoseModelThisPhoneCantSeeCantRun() {
        let slider = AidenAgentSlider(
            stops: [
                AidenAgentSliderStop(id: "a", label: "A", providerId: "acme", modelId: "small", thinkingLevel: "low", availability: .ready),
                AidenAgentSliderStop(id: "b", label: "B", providerId: "acme", modelId: "secret", availability: .ready),
                AidenAgentSliderStop(id: "c", label: "C", providerId: "elsewhere", modelId: "x", availability: .ready),
            ],
            homeStopId: "a"
        )
        let views = AidenAgentSliderResolver.views(for: slider, catalog: Self.catalog)
        XCTAssertEqual(views.map(\.isAvailable), [true, false, false])
        XCTAssertEqual(views[1].detail, "Model not found")
        XCTAssertEqual(views[1].modelLabel, "secret")
        XCTAssertNil(views[1].turnSelection)
        XCTAssertEqual(views[0].turnSelection, AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "low"))
    }

    func testNoRunnableStopIsCustomAndResetNeedsARunnableHomeOffHome() {
        let slider = AidenAgentSlider(
            stops: [
                AidenAgentSliderStop(id: "a", label: "A", providerId: "old", modelId: "m", availability: .providerMissing),
                AidenAgentSliderStop(id: "b", label: "B", providerId: "acme", modelId: "small", thinkingLevel: "low", availability: .notSignedIn),
                AidenAgentSliderStop(id: "c", label: "C", availability: .unassigned),
            ],
            homeStopId: "b"
        )
        let stuck = AidenAgentSliderState(
            slider: slider, catalog: Self.catalog,
            selection: AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "low")
        )
        XCTAssertTrue(stuck.position.isCustom, "a slider where nothing can run shows no stop")
        XCTAssertFalse(stuck.canResetToHome)

        XCTAssertFalse(state("acme", "small", "medium").canResetToHome, "already home")
        XCTAssertTrue(state("acme", "small", "low").canResetToHome)
        XCTAssertTrue(state("acme", "small", "high").canResetToHome, "Custom goes back home")
    }

    func testVoiceOverReadsTheStopOrCustomWithTheModel() {
        let onStop = state("acme", "small", "low")
        XCTAssertEqual(
            AidenAgentSliderResolver.valueText(onStop.views, position: onStop.position, customModelLabel: "ignored"),
            "Fast, Small, Low"
        )
        let onBig = state("acme", "large", nil)
        XCTAssertEqual(
            AidenAgentSliderResolver.valueText(onBig.views, position: onBig.position, customModelLabel: "ignored"),
            "Big, Large"
        )
        let custom = state("acme", "small", "high")
        XCTAssertEqual(
            AidenAgentSliderResolver.valueText(custom.views, position: custom.position, customModelLabel: "Small · High"),
            "Custom: Small · High"
        )
    }

    // MARK: - Selection policy

    private func newChat(withMessage: Bool = false, providerId: String? = nil, modelId: String? = nil, level: String? = nil) throws -> AidenChat {
        var json: [String: Any] = [
            "id": "chat-1", "workspaceId": "workspace-1", "title": "Chat",
            "messages": withMessage ? [["id": "u1", "role": "user", "text": "Hi", "createdAt": "2026-11-24T12:00:00Z"]] : [],
            "createdAt": "2026-11-24T12:00:00Z", "updatedAt": "2026-11-24T12:00:00Z", "revision": "r1",
        ]
        json["providerId"] = providerId
        json["modelId"] = modelId
        json["thinkingLevel"] = level
        return try AidenRemoteJSONDecoder.decode(AidenChat.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testANewSliderChatWithNothingChosenOrRememberedStartsOnHome() throws {
        let home = AidenChatModelSelection(providerId: "acme", modelId: "large", thinkingLevel: nil)
        let landed = AidenChatModelAuthority.resolvedSelection(
            chat: try newChat(), catalog: Self.catalog,
            selectedProviderId: nil, selectedModelId: nil, selectedThinkingLevel: nil,
            exactLevels: true, homeSelection: home
        )
        XCTAssertEqual(landed, home)

        // A remembered choice still wins over home, with its level exactly.
        let remembered = AidenChatModelAuthority.resolvedSelection(
            chat: try newChat(), catalog: Self.catalog,
            selectedProviderId: nil, selectedModelId: nil, selectedThinkingLevel: nil,
            remembered: AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "low"),
            exactLevels: true, homeSelection: home
        )
        XCTAssertEqual(remembered, AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "low"))

        // Without the slider a new chat takes the Mac's default, at the model's own level.
        let menu = AidenChatModelAuthority.resolvedSelection(
            chat: try newChat(), catalog: Self.catalog,
            selectedProviderId: nil, selectedModelId: nil, selectedThinkingLevel: nil,
            homeSelection: home
        )
        XCTAssertEqual(menu, AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "medium"))
    }

    func testWithTheSliderAChatsSavedLevelIsKeptExactlyAndAMissingOneStaysMissing() throws {
        func resolved(level: String?, exact: Bool) throws -> AidenChatModelSelection {
            AidenChatModelAuthority.resolvedSelection(
                chat: try newChat(withMessage: true, providerId: "acme", modelId: "large", level: level),
                catalog: Self.catalog,
                selectedProviderId: "acme", selectedModelId: "large", selectedThinkingLevel: nil,
                exactLevels: exact
            )
        }
        XCTAssertEqual(try resolved(level: "low", exact: true).thinkingLevel, "low")
        XCTAssertNil(try resolved(level: nil, exact: true).thinkingLevel, "no saved level runs on the model's own setting")
        XCTAssertEqual(try resolved(level: nil, exact: false).thinkingLevel, "high", "the menu shows the model's default")
    }
}
