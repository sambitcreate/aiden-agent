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
        XCTAssertEqual(slider.stops.map(\.id), [
            "stop_0a1b2c3d", "stop_1b2c3d4e", "stop_2c3d4e5f", "stop_3d4e5f6a", "stop_5f6a7b8c", "stop_4e5f6a7b",
        ])
        XCTAssertEqual(slider.homeStopId, "stop_1b2c3d4e")
        XCTAssertEqual(AidenAgentSliderResolver.homeStopIndex(slider), 1)
        XCTAssertNil(slider.stops[0].thinkingLevel, "a stop on a model with no levels sets none")
        XCTAssertEqual(slider.stops[3].availability, .notSignedIn)
        XCTAssertNil(slider.stops[3].providerId, "only a stop that can run names its provider")
        XCTAssertEqual(slider.stops[4].availability, .computerOnly)
        XCTAssertEqual(slider.stops[5].availability, .unassigned)
        XCTAssertNil(slider.stops[5].modelId)

        let views = AidenAgentSliderResolver.views(for: slider, catalog: catalog)
        XCTAssertEqual(views.map(\.isAvailable), [true, true, true, false, false, false])
        XCTAssertEqual(views[1].detail, "Fixture Model · Medium")
        XCTAssertEqual(views[0].detail, "Quick")
        // Words come from the Mac's display names: the phone never shows an id.
        XCTAssertEqual(views[3].detail, "Sign in to Other Provider on your computer")
        XCTAssertEqual(views[3].modelLabel, "Other Model")
        XCTAssertEqual(views[4].detail, "Only on your computer")
        XCTAssertEqual(views[5].detail, "Choose a model on your computer")
    }

    /// A newer Mac's reason, or a level this phone doesn't know, costs only
    /// that stop: it can't be chosen here and the rest of the slider stays.
    func testAnUnknownReasonOrLevelKeepsTheSliderAndOnlyThatStopCantRun() throws {
        var raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: fixtureData(at: ["agentSlider", "models"])) as? [String: Any]
        )
        var slider = try XCTUnwrap(raw["agentSlider"] as? [String: Any])
        var stops = try XCTUnwrap(slider["stops"] as? [[String: Any]])
        stops[0]["availability"] = "sleeping"
        stops[2]["thinkingLevel"] = "ultra"
        slider["stops"] = stops
        raw["agentSlider"] = slider
        let catalog = try AidenRemoteJSONDecoder.decode(AidenModelCatalog.self, from: JSONSerialization.data(withJSONObject: raw))
        let decoded = try XCTUnwrap(catalog.agentSlider)
        XCTAssertFalse(catalog.agentSliderUnreadable)
        XCTAssertEqual(decoded.stops.count, 6)
        let views = AidenAgentSliderResolver.views(for: decoded, catalog: catalog)
        XCTAssertEqual(views.map(\.isAvailable), [false, true, false, false, false, false])
        XCTAssertEqual(views[0].detail, "Update Aiden to use this stop")
        XCTAssertNil(views[2].turnSelection, "a level the phone can't name is never sent as the stop's")
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
            attachments: [],
            saveSelection: true
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
        XCTAssertFalse(try decode().agentSliderUnreadable, "no slider is not an unreadable one")
        XCTAssertEqual(try decode().providers.map(\.id), ["provider_fixture"])

        let broken: [(String, ([String: Any]) -> [String: Any])] = [
            ("home is not a stop", { var value = $0; value["homeStopId"] = "stop_gone"; return value }),
            ("fewer than three stops", { var value = $0; value["stops"] = Array(($0["stops"] as? [Any] ?? []).prefix(2)); return value }),
            ("a ready stop with no model", { value in
                var value = value
                var stops = value["stops"] as? [[String: Any]] ?? []
                stops[1]["providerId"] = nil
                stops[1]["modelId"] = nil
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
            XCTAssertTrue(catalog.agentSliderUnreadable, why)
            XCTAssertEqual(catalog.providers.map(\.id), ["provider_fixture"], why)
        }
        slider["homeStopId"] = "stop_2c3d4e5f"
        raw["agentSlider"] = slider
        XCTAssertEqual(try decode().agentSlider?.homeStopId, "stop_2c3d4e5f")
    }

    // MARK: - Resolver

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
    /// its model; the phone can't send it, says so, and never shows the raw id.
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
        XCTAssertEqual(views[1].detail, "Its model isn't on your computer")
        XCTAssertEqual(views[1].modelLabel, "A model on your computer")
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

    private static let providersJSON = #"[{"id":"acme","label":"Acme","models":[{"id":"small","label":"Small","thinkingLevels":["low","medium","high"],"defaultThinkingLevel":"medium"},{"id":"large","label":"Large","thinkingLevels":["low","high"],"defaultThinkingLevel":"high"}]}]"#

    private static let catalog = try! AidenRemoteJSONDecoder.decode(
        AidenModelCatalog.self,
        from: Data(#"{"providers":\#(providersJSON),"defaults":{"providerId":"acme","modelId":"small"}}"#.utf8)
    )

    /// The resolver's catalog, with the Mac's `defaults` replaced.
    private func catalog(defaults: [String: String]) throws -> AidenModelCatalog {
        let providers = try JSONSerialization.jsonObject(with: Data(Self.providersJSON.utf8))
        return try AidenRemoteJSONDecoder.decode(
            AidenModelCatalog.self,
            from: JSONSerialization.data(withJSONObject: ["providers": providers, "defaults": defaults])
        )
    }

    /// Plan decision 2: a new chat starts on the Mac's last model and level
    /// (`defaults`), not the home stop, which is only what Reset returns to.
    func testANewSliderChatWithNothingChosenOrRememberedStartsOnTheMacsLastModelAndLevel() throws {
        func landed(_ catalog: AidenModelCatalog, remembered: AidenChatModelSelection? = nil, exact: Bool = true) throws -> AidenChatModelSelection {
            AidenChatModelAuthority.resolvedSelection(
                chat: try newChat(), catalog: catalog,
                selectedProviderId: nil, selectedModelId: nil, selectedThinkingLevel: nil,
                remembered: remembered, exactLevels: exact
            )
        }
        let macOnLarge = try catalog(defaults: ["providerId": "acme", "modelId": "large", "thinkingLevel": "low"])
        XCTAssertEqual(try landed(macOnLarge), AidenChatModelSelection(providerId: "acme", modelId: "large", thinkingLevel: "low"))
        let onSlider = AidenAgentSliderState(slider: Self.slider, catalog: macOnLarge, selection: try landed(macOnLarge))
        XCTAssertNil(onSlider.currentStop, "Large at Low is no stop, so the chat starts in Custom")
        XCTAssertTrue(onSlider.canResetToHome)

        // The Mac's last stop is a stop: the chat starts on it, not on home.
        let macOnFast = try catalog(defaults: ["providerId": "acme", "modelId": "small", "thinkingLevel": "low"])
        let fast = AidenAgentSliderState(slider: Self.slider, catalog: macOnFast, selection: try landed(macOnFast))
        XCTAssertEqual(fast.currentStop?.id, "fast")

        // A level the model doesn't offer, or none, is the model's own setting.
        let unfit = try catalog(defaults: ["providerId": "acme", "modelId": "large", "thinkingLevel": "medium"])
        XCTAssertNil(try landed(unfit).thinkingLevel)
        let levelless = try catalog(defaults: ["providerId": "acme", "modelId": "large"])
        XCTAssertEqual(
            AidenAgentSliderState(slider: Self.slider, catalog: levelless, selection: try landed(levelless)).currentStop?.id,
            "big"
        )

        // A remembered choice still wins, with its level exactly.
        let remembered = AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "medium")
        XCTAssertEqual(try landed(macOnLarge, remembered: remembered), remembered)

        // Without the slider a new chat takes the Mac's model at the model's own default.
        XCTAssertEqual(
            try landed(macOnLarge, exact: false),
            AidenChatModelSelection(providerId: "acme", modelId: "large", thinkingLevel: "high")
        )
    }

    /// Two stops can name the same model and level. The one the person chose
    /// is the chat's, and steps and Reset go from it; once the chat moves off
    /// that selection, the first matching stop is.
    func testOfTwoStopsWithTheSameModelAndLevelTheChosenOneIsCurrent() {
        let slider = AidenAgentSlider(
            stops: [
                AidenAgentSliderStop(id: "a", label: "A", providerId: "acme", modelId: "small", thinkingLevel: "low", availability: .ready),
                AidenAgentSliderStop(id: "b", label: "B", providerId: "acme", modelId: "small", thinkingLevel: "medium", availability: .ready),
                AidenAgentSliderStop(id: "c", label: "C", providerId: "acme", modelId: "small", thinkingLevel: "low", availability: .ready),
            ],
            homeStopId: "a"
        )
        let low = AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "low")
        let onC = AidenAgentSliderState(slider: slider, catalog: Self.catalog, selection: low, chosenStopId: "c")
        XCTAssertEqual(onC.position, AidenAgentSliderPosition(stopIndex: 2, thumbIndex: 2))
        XCTAssertTrue(onC.canResetToHome, "C is not home even though it runs the same as home")
        XCTAssertNil(AidenAgentSliderResolver.step(onC.views, from: onC.position, direction: 1))
        XCTAssertEqual(AidenAgentSliderResolver.step(onC.views, from: onC.position, direction: -1), 1)

        let unchosen = AidenAgentSliderState(slider: slider, catalog: Self.catalog, selection: low)
        XCTAssertEqual(unchosen.currentStop?.id, "a")
        XCTAssertFalse(unchosen.canResetToHome)

        let movedOff = AidenAgentSliderState(
            slider: slider, catalog: Self.catalog,
            selection: AidenChatModelSelection(providerId: "acme", modelId: "small", thinkingLevel: "medium"),
            chosenStopId: "c"
        )
        XCTAssertEqual(movedOff.currentStop?.id, "b", "a chosen stop the chat no longer runs on is not current")
    }

    // MARK: - Drag

    /// Five stops on a 228-point track with 14-point insets sit at x = 14,
    /// 64, 114, 164 and 214.
    func testASidewaysDragPreviewsRunnableStopsAndLandsOnceWhereLetGo() {
        let available = [true, false, true, true, true]
        func stop(at x: CGFloat) -> Int? {
            AidenAgentSliderDrag.nearestAvailableStop(available, to: x, width: 228, inset: 14)
        }
        XCTAssertEqual(stop(at: 60), 0, "the stop nearest 60 can't run, so the nearest runnable one")
        XCTAssertEqual(stop(at: 170), 3)
        XCTAssertNil(AidenAgentSliderDrag.nearestAvailableStop([false, false, false], to: 50, width: 228, inset: 14))

        var drag = AidenAgentSliderDrag()
        drag.moved(translation: CGSize(width: 12, height: 3), to: stop(at: 120))
        XCTAssertEqual(drag.previewIndex, 2)
        drag.moved(translation: CGSize(width: 60, height: 40), to: stop(at: 170))
        XCTAssertEqual(drag.previewIndex, 3, "once sideways, the drag stays the slider's")
        XCTAssertEqual(drag.ended(), 3)
        XCTAssertNil(drag.ended(), "a drag lands once")
        XCTAssertNil(drag.previewIndex)
    }

    func testADragThatStartsUprightIsTheScrollsAndLandsNowhere() {
        var drag = AidenAgentSliderDrag()
        drag.moved(translation: CGSize(width: 3, height: 10), to: 1)
        drag.moved(translation: CGSize(width: 90, height: 12), to: 4)
        XCTAssertTrue(drag.isIgnored)
        XCTAssertNil(drag.previewIndex)
        XCTAssertNil(drag.ended())

        // The next drag starts fresh.
        drag.moved(translation: CGSize(width: 10, height: 1), to: 4)
        XCTAssertEqual(drag.ended(), 4)
    }

    // MARK: - Presentation across a fold

    /// An iPhone Duo fold swaps the chat's containers: the shell calls
    /// `rebuilding()`, a new view appears, the old one leaves, and the old
    /// sheet reports a close in any order around that. The open sheet stays
    /// open for the new view; only the new view's close closes it.
    @MainActor
    func testAnOpenSheetSurvivesAFoldWhicheverOrderTheViewsReport() {
        for newViewFirst in [true, false] {
            let screen = AidenChatScreen(isOpen: { true }, pause: { _ in })
            var presentation = AidenAgentSliderPresentationState()
            let before = UUID(), after = UUID()
            screen.appeared()
            presentation.appeared(before)
            presentation.isPresented = true
            XCTAssertTrue(presentation.isShown(by: before))

            screen.rebuilding()
            presentation.closed(by: before, whileRebuilding: screen.isRebuilding)
            XCTAssertTrue(presentation.isPresented, "a close during the swap is the swap's")

            func oldLeaves() {
                presentation.disappeared(before)
                screen.disappeared(hidden: {}, left: {})
            }
            func newAppears() {
                screen.appeared()
                presentation.appeared(after)
            }
            if newViewFirst { newAppears(); oldLeaves() } else { oldLeaves(); newAppears() }

            presentation.closed(by: before, whileRebuilding: screen.isRebuilding)
            XCTAssertTrue(presentation.isPresented, "a late close from the old view (new first: \(newViewFirst))")
            XCTAssertTrue(presentation.isShown(by: after))
            XCTAssertFalse(presentation.isShown(by: before))

            presentation.closed(by: after, whileRebuilding: screen.isRebuilding)
            XCTAssertFalse(presentation.isPresented, "the new view's close is the person's")
        }
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
