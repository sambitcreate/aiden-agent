import Foundation
import XCTest
@testable import AidenOnTheGo

/// Contract revision 61 (Bot UX simplification, Phase 6b): every sample in
/// `bot-ux-revision-61.json` decodes on the phone exactly as the Mac sends it,
/// the strict parsers refuse what the TypeScript ones refuse, and the phone's
/// answers are optimistic with a rollback when the Mac refuses.
@MainActor
final class AidenBotUXTests: XCTestCase {
    // MARK: Fixture

    func fixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "bot-ux-revision-61", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(root["contractRevision"] as? Int, 61)
        return root
    }

    func section(_ key: String) throws -> [String: Any] {
        try XCTUnwrap(fixture()[key] as? [String: Any], key)
    }

    func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    func json(_ value: some Encodable) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    func card(_ key: String) throws -> [String: Any] {
        try XCTUnwrap(section("approvalCards")[key] as? [String: Any], key)
    }

    // MARK: Capabilities

    func testEachCapabilityIsNamedAndNegotiatedInACallOfItsOwn() throws {
        let names = try XCTUnwrap(fixture()["capabilities"] as? [String])
        let capabilities = names.map(AidenRemoteCapability.init(rawValue:))
        XCTAssertEqual(Set(capabilities), Set(AidenRemoteCapability.botUX))
        for capability in capabilities {
            XCTAssertTrue(AidenRemoteCapability.phoneNegotiable.contains(capability), capability.rawValue)
            XCTAssertTrue(AidenRemoteCoordinator.capabilitiesAskedForAlone.contains([capability]), capability.rawValue)
        }
    }

    func testWithoutTheCapabilitiesThePhoneKeepsTodaysScreens() throws {
        var installation = makeInstallation(capabilities: [.serverRead, .botRead, .botWrite])
        installation.serverCapabilities = [.serverRead, .botRead, .botWrite]
        XCTAssertFalse(installation.offersBotUX)
        XCTAssertFalse(installation.hasNegotiatedAccess(to: .approvalsSettings))
        // The Bot's own stored wording still decides its status line.
        XCTAssertEqual(AidenToolActivityPreference.wording(botWording: .follows, hostOffersBotUX: installation.offersBotUX, showToolActivity: false), .follows)
        XCTAssertEqual(AidenToolActivityPreference.wording(botWording: .thinking, hostOffersBotUX: installation.offersBotUX, showToolActivity: true), .thinking)

        installation.serverCapabilities = [.serverRead, .botRead, .botWrite] + AidenRemoteCapability.botUX
        XCTAssertTrue(installation.offersBotUX)
        // Offered but not granted to this device: the Approvals page stays hidden.
        XCTAssertFalse(installation.hasNegotiatedAccess(to: .approvalsSettings))
        // On a revision 61 Mac the per-device switch decides, whatever the Bot stored.
        XCTAssertEqual(AidenToolActivityPreference.wording(botWording: .follows, hostOffersBotUX: true, showToolActivity: false), .thinking)
        XCTAssertEqual(AidenToolActivityPreference.wording(botWording: .thinking, hostOffersBotUX: true, showToolActivity: true), .follows)
    }

    func testMessagingSingleSwitchReadsOnOnlyWhenBothDirectionsAre() {
        XCTAssertTrue(aidenBotMessagingSingleSwitch(AidenBotMessaging(receive: true, send: true)))
        XCTAssertFalse(aidenBotMessagingSingleSwitch(AidenBotMessaging(receive: true, send: false)))
        XCTAssertFalse(aidenBotMessagingSingleSwitch(AidenBotMessaging(receive: false, send: true)))
    }

    // MARK: Approval cards

    func testEveryFixtureCardDecodesInOrderAndRoundTrips() throws {
        for (key, value) in try section("approvalCards") {
            let decoded = try decode(AidenApprovalCardModel.self, value)
            XCTAssertEqual(decoded.denyButton.decision, .deny, key)
            XCTAssertEqual(try decode(AidenApprovalCardModel.self, json(decoded)), decoded, key)
        }
        let mac = try decode(AidenApprovalCardModel.self, card("macCommand"))
        XCTAssertEqual(mac.title, "Run on your Mac?")
        XCTAssertEqual(mac.body?.format, .command)
        XCTAssertEqual(mac.buttons.map(\.label), ["Deny", "Allow once", "Allow in this chat", "Allow in this workspace"])
        XCTAssertTrue(mac.offers(.allow, scope: .once))
        XCTAssertTrue(mac.offers(.allow, scope: .chat))
        XCTAssertTrue(mac.offers(.allow, scope: .always))
        XCTAssertNil(mac.allowOnMac)

        let onMac = try decode(AidenApprovalCardModel.self, card("allowOnMac"))
        XCTAssertFalse(onMac.canAllow)
        XCTAssertFalse(onMac.offers(.allow))
        XCTAssertEqual(onMac.allowOnMac, "Allow it on your Mac.")

        let form = try decode(AidenApprovalCardModel.self, card("formFill"))
        XCTAssertEqual(form.buttons.map(\.label), ["Cancel", "Fill 1 field"])
        XCTAssertEqual(form.rows?.first?.label, "Name")

        let hook = try decode(AidenApprovalCardModel.self, card("hookProposal"))
        XCTAssertEqual(hook.kind, .heldChange)
        XCTAssertNotNil(hook.previous)

        let always = try decode(AidenApprovalCardModel.self, card("botAlways"))
        XCTAssertEqual(always.buttons.last?.scope, .always)
        XCTAssertEqual(always.buttons.last?.answered, "Always allowed")
        XCTAssertFalse(try decode(AidenApprovalCardModel.self, card("botWithoutAllowed")).offers(.allow, scope: .always))
    }

    func testCardParserRefusesWhatTheMacWouldNeverSend() throws {
        let base = try card("macCommand")
        let buttons = try XCTUnwrap(base["buttons"] as? [[String: Any]])
        var bad: [[String: Any]] = []
        func with(_ key: String, _ value: Any?) -> [String: Any] { var copy = base; copy[key] = value; return copy }
        bad.append(with("buttons", Array(buttons.dropFirst())))                       // first is not Deny
        bad.append(with("buttons", []))
        bad.append(with("buttons", buttons + buttons.suffix(2)))                       // six buttons
        bad.append(with("buttons", [buttons[0].merging(["scope": "chat"]) { $1 }] + buttons.dropFirst()))
        bad.append(with("allowOnMac", "Allow it on your Mac."))                        // allow buttons and allowOnMac
        bad.append(with("buttons", [buttons[0]]))                                      // deny only without allowOnMac
        bad.append(with("kind", "generic"))                                            // mac on a non-mac card
        bad.append(with("title", String(repeating: "x", count: 201)))
        bad.append(with("title", nil))
        bad.append(with("arguments", Array(repeating: ["key": "k", "value": "v"], count: 17)))
        bad.append(with("notes", Array(repeating: "n", count: 7)))
        bad.append(with("extra", true))
        bad.append(with("buttons", [buttons[0], buttons[1].merging(["scope": "workspace"]) { $1 }]))
        for object in bad {
            XCTAssertThrowsError(try decode(AidenApprovalCardModel.self, object), "\(object)")
        }
    }

    func testStreamAndRunApprovalSamplesCarryTheirCardsAndRefuseAMismatch() throws {
        let stream = try section("streamApprovals")
        let complete = try decode(AidenStreamPendingApproval.self, try XCTUnwrap(stream["complete"]))
        XCTAssertEqual(complete.card?.allowButtons.compactMap(\.scope), [.chat])
        let denyOnly = try decode(AidenStreamPendingApproval.self, try XCTUnwrap(stream["denyOnly"]))
        XCTAssertEqual(denyOnly.card?.allowOnMac, "Allow it on your Mac.")

        let runs = try section("phoneRunApprovalEvents")
        for key in ["complete", "denyOnly"] {
            let event = try decode(AidenRemoteRunEvent.self, try XCTUnwrap(runs[key]))
            guard case let .approvalRequired(approval) = event.kind else { return XCTFail(key) }
            XCTAssertEqual(approval.card?.canAllow, key == "complete")
        }

        // canAllow must equal "the card has an allow button", and every scope must be on a button.
        var lying = try XCTUnwrap(stream["denyOnly"] as? [String: Any]); lying["canAllow"] = true
        var widened = try XCTUnwrap(stream["complete"] as? [String: Any]); widened["scopes"] = ["once", "chat", "always"]
        var hidden = try XCTUnwrap(stream["complete"] as? [String: Any]); hidden["canAllow"] = false; hidden["scopes"] = nil
        for object in [lying, widened, hidden] {
            XCTAssertThrowsError(try decode(AidenStreamPendingApproval.self, object))
        }
        var runPayload = try XCTUnwrap((runs["denyOnly"] as? [String: Any])?["payload"] as? [String: Any])
        runPayload["canAllow"] = true
        var runEvent = try XCTUnwrap(runs["denyOnly"] as? [String: Any]); runEvent["payload"] = runPayload
        XCTAssertThrowsError(try decode(AidenRemoteRunEvent.self, runEvent))
    }

    func testBotApprovalWithACardOffersOnlyItsButtons() throws {
        let approval = try decode(AidenRemoteBotApproval.self, botApprovalObject(card: try card("botAlways")))
        XCTAssertTrue(approval.offersAllow)
        let denyOnly = try decode(AidenRemoteBotApproval.self, botApprovalObject(card: try card("allowOnMac"), canAllow: true))
        XCTAssertFalse(denyOnly.offersAllow, "A disclosure tool's card may be Deny-only while canAllow is true")
        XCTAssertThrowsError(try decode(AidenRemoteBotApproval.self, botApprovalObject(card: try card("botAlways"), canAllow: false)))
    }

    // MARK: Bot session entries

    func testEverySessionEntrySampleDecodesAndRoundTrips() throws {
        let samples = try XCTUnwrap(fixture()["botSessionEntries"] as? [[String: Any]])
        XCTAssertEqual(samples.count, 7)
        let entries = try samples.map { try decode(AidenBotSessionEntry.self, $0) }
        for entry in entries {
            XCTAssertEqual(try decode(AidenBotSessionEntry.self, json(entry)), entry)
        }
        guard case let .settingsChange(held) = entries[0], case let .settingsChange(applied) = entries[1],
              case let .skillProposal(skill) = entries[2], case let .lesson(proposal) = entries[3],
              case let .lesson(learned) = entries[4], case let .memoryTidy(tidy) = entries[5],
              case let .skillProposal(truncated) = entries[6] else { return XCTFail("Unexpected entry kinds") }
        XCTAssertTrue(held.isHeld && held.isWaiting)
        XCTAssertEqual(held.heldReason, .outsideContent)
        XCTAssertNotNil(held.instructions)
        XCTAssertTrue(held.instructionsDiff?.contains { $0.kind == .added } == true)
        XCTAssertEqual(applied.mode, .applied)
        XCTAssertTrue(applied.undoable)
        XCTAssertTrue(skill.canAddHere)
        XCTAssertFalse(truncated.canAddHere)
        XCTAssertEqual(truncated.preview.count, 16_000)
        XCTAssertEqual(proposal.runs, 3)
        XCTAssertEqual(learned.status, .active)
        XCTAssertEqual(tidy.changeId, "learning_fixture_01")

        // The whole session, as the Mac serves it, passes the private-field check.
        let session = try decode(AidenBotSession.self, sessionObject(entries: samples))
        XCTAssertEqual(session.entries.count, 7)
    }

    func testSessionEntryParsersRefuseBadShapes() throws {
        let samples = try XCTUnwrap(fixture()["botSessionEntries"] as? [[String: Any]])
        func with(_ index: Int, _ key: String, _ value: Any?) -> [String: Any] { var copy = samples[index]; copy[key] = value; return copy }
        let bad: [[String: Any]] = [
            with(0, "status", "approved"),
            with(0, "mode", "maybe"),
            with(0, "heldReason", "because"),
            with(0, "instructions", String(repeating: "x", count: 32_001)),
            with(0, "lines", Array(repeating: "l", count: 11)),
            with(2, "previewTruncated", false),
            with(2, "preview", String(repeating: "x", count: 16_001)),
            with(2, "status", "kept"),
            with(3, "kind", "rule"),
            with(3, "status", "added"),
            with(5, "changeId", ""),
            with(1, "secret", "x"),
        ]
        for object in bad {
            XCTAssertThrowsError(try decode(AidenBotSessionEntry.self, object), "\(object["type"] ?? "")")
        }
    }

    // MARK: Templates, mode, rules and requests

    func testTemplatesModeRulesPickerAndRequestsDecode() throws {
        let presets = try decode([AidenBotPreset].self, try XCTUnwrap(section("templates")["presets"]))
        let template = try XCTUnwrap(presets.first?.template)
        XCTAssertEqual(template.version, 2)
        XCTAssertEqual(template.existingBotId, "bot:00000000-0000-4000-8000-000000000061")
        XCTAssertEqual(template.sample.count, 2)

        let mode = try decode(AidenApprovalModeView.self, section("approvalMode"))
        XCTAssertEqual(mode.mode, .ask)
        XCTAssertTrue(mode.autoAvailable)

        let rules = try decode(AidenApprovalRulesView.self, section("approvalRules"))
        XCTAssertEqual(rules.rows.map(\.group), [.allow, .block, .ask, .allow, .mac])
        XCTAssertEqual(rules.rows.filter(\.legacy).count, 1)
        XCTAssertEqual(rules.rows[2].handOff?.on, true)
        XCTAssertTrue(rules.rows[4].decisions.isEmpty)
        XCTAssertEqual(try decode(AidenApprovalRulesView.self, json(rules)), rules)

        let picker = try decode(AidenApprovalRulePicker.self, section("approvalRulePicker"))
        XCTAssertEqual(picker.options.map(\.label), ["Send email", "Calendar"])

        // Requests encode exactly the fixture's bodies; `ref` and `target` go back untouched.
        let requests = try section("requests")
        let ref = rules.rows[1].ref
        XCTAssertEqual(try json(AidenApprovalRuleChangeRequest(ref: ref, decision: .ask)) as NSDictionary, try XCTUnwrap(requests["ruleChange"] as? NSDictionary))
        XCTAssertEqual(try json(AidenApprovalRuleRemoveRequest(ref: rules.rows[0].ref)) as NSDictionary, try XCTUnwrap(requests["ruleRemove"] as? NSDictionary))
        XCTAssertEqual(try json(AidenApprovalModeRequest(mode: .never)) as NSDictionary, try XCTUnwrap(requests["approvalMode"] as? NSDictionary))
        XCTAssertEqual(try json(AidenBotPresetCreateRequest(presetId: "meal-planner", version: 2)) as NSDictionary, try XCTUnwrap(requests["templateCreate"] as? NSDictionary))
        XCTAssertEqual(try json(AidenBotUXDecisionRequest(decision: AidenBotSettingsChangeDecision.apply)) as NSDictionary, try XCTUnwrap(requests["settingsChangeRespond"] as? NSDictionary))

        // One-field create leaves instructions out.
        let oneField = try XCTUnwrap(requests["oneFieldCreate"] as? [String: Any])
        let request = try AidenBotCreateRequest(name: "Scout", purpose: "", instructions: nil, avatar: decode(AidenBotSemanticAvatar.self, try XCTUnwrap(oneField["avatar"])))
        let encoded = try json(request)
        XCTAssertNil(encoded["instructions"])
        XCTAssertEqual(encoded["name"] as? String, "Scout")
    }

    func testTemplateStaleErrorDecodes() throws {
        let stale = try XCTUnwrap(section("errors")["templateStale"] as? [String: Any])
        let body = try decode(AidenRemoteErrorEnvelope.Body.self, (try XCTUnwrap(stale["error"] as? [String: Any])).merging(["requestId": "req_fixture_61"]) { $1 })
        XCTAssertEqual(body.code.rawValue, "revision_conflict")
        XCTAssertEqual(body.message, "This template changed. Close it and open it again.")
    }
}

// MARK: Optimistic answers

extension AidenBotUXTests {
    func testSettingsChangeApplyShowsAtOnceAndRollsBackWhenRefused() async throws {
        let (model, transport) = try await loadedModel()
        guard case let .settingsChange(held) = model.entries[0] else { return XCTFail() }
        let gate = UXGate()
        transport.gate = gate
        transport.failure = URLError(.networkConnectionLost)
        let task = Task { await model.respondToSettingsChange(held, decision: .apply) }
        await gate.entered()
        guard case let .settingsChange(optimistic) = model.entries[0] else { return XCTFail() }
        XCTAssertEqual(optimistic.status, .applied, "The answer shows before the Mac confirms")
        await gate.release()
        let sent = await task.value
        XCTAssertFalse(sent)
        guard case let .settingsChange(restored) = model.entries[0] else { return XCTFail() }
        XCTAssertEqual(restored.status, .pending, "A refused answer puts the card back")
        XCTAssertNotNil(model.errorMessage)
        XCTAssertEqual(transport.settingsCalls.map(\.decision), [.apply])
    }

    func testSettingsChangeAppliedThenAGoneCardIsDropped() async throws {
        let (model, transport) = try await loadedModel()
        guard case let .settingsChange(held) = model.entries[0], case let .settingsChange(applied) = model.entries[1] else { return XCTFail() }
        transport.settingsStatus = .applied
        let ok = await model.respondToSettingsChange(held, decision: .apply)
        XCTAssertTrue(ok)
        guard case let .settingsChange(settled) = model.entries[0] else { return XCTFail() }
        XCTAssertEqual(settled.status, .applied)

        // The receipt's Undo is refused as a 404: the card is gone on the Mac.
        transport.failure = try serverError(404, "not_found")
        let undone = await model.respondToSettingsChange(applied, decision: .undo)
        XCTAssertFalse(undone)
        XCTAssertFalse(model.entries.contains { $0.id == applied.id })
    }

    func testUndoTheMacCannotMakeSaysWhy() async throws {
        let (model, transport) = try await loadedModel()
        guard case let .settingsChange(applied) = model.entries[1] else { return XCTFail() }
        transport.settingsStatus = .undoRefused
        transport.settingsMessage = "It changed again since."
        let ok = await model.respondToSettingsChange(applied, decision: .undo)
        XCTAssertFalse(ok)
        guard case let .settingsChange(settled) = model.entries[1] else { return XCTFail() }
        XCTAssertEqual(settled.status, .undoRefused)
        XCTAssertEqual(model.botUXNotice, "It changed again since.")
        // A held card is never undone, and an applied receipt is never applied.
        guard case let .settingsChange(held) = model.entries[0] else { return XCTFail() }
        let wrongWay = await model.respondToSettingsChange(held, decision: .undo)
        XCTAssertFalse(wrongWay)
        XCTAssertEqual(transport.settingsCalls.count, 1)
    }

    func testTruncatedSkillOffersOnlyNotNowAndLessonsAnswerThroughTheirRoutes() async throws {
        let (model, transport) = try await loadedModel()
        guard case let .skillProposal(truncated) = model.entries[6],
              case let .lesson(proposal) = model.entries[3],
              case let .lesson(learned) = model.entries[4],
              case let .memoryTidy(tidy) = model.entries[5] else { return XCTFail() }
        let added = await model.respondToSkillProposal(truncated, decision: .add)
        XCTAssertFalse(added)
        XCTAssertTrue(transport.skillCalls.isEmpty, "Add on a cut-short skill never leaves the phone")
        let dismissed = await model.respondToSkillProposal(truncated, decision: .dismiss)
        XCTAssertTrue(dismissed)
        XCTAssertEqual(transport.skillCalls, [.dismiss])

        let kept = await model.respondToLesson(proposal, decision: .keep)
        XCTAssertTrue(kept)
        guard case let .lesson(active) = model.entries[3] else { return XCTFail() }
        XCTAssertEqual(active.status, .active)

        let removed = await model.removeLesson(learned)
        XCTAssertTrue(removed)
        guard case let .lesson(retired) = model.entries[4] else { return XCTFail() }
        XCTAssertEqual(retired.status, .retired)

        transport.failure = try serverError(409, "revision_conflict")
        let undone = await model.undoMemoryTidy(tidy)
        XCTAssertFalse(undone)
        guard case let .memoryTidy(still) = model.entries[5] else { return XCTFail() }
        XCTAssertEqual(still.changeId, "learning_fixture_01", "A refused Undo keeps the receipt's Undo")
        XCTAssertEqual(model.errorMessage, "No.")
    }

    func testBotApprovalButtonSendsItsScopeShowsTheAnsweredLineAndRollsBack() async throws {
        let approval = botApprovalObject(card: try card("botAlways"))
        let (model, transport) = try await loadedModel(approval: approval)
        let current = try XCTUnwrap(model.approval?.card)
        let always = try XCTUnwrap(current.buttons.last)

        let gate = UXGate()
        transport.gate = gate
        transport.failure = URLError(.timedOut)
        let task = Task { await model.answerApproval(button: always) }
        await gate.entered()
        XCTAssertNil(model.approval)
        XCTAssertEqual(model.approvalAnsweredLine, "Always allowed")
        await gate.release()
        await task.value
        XCTAssertNotNil(model.approval, "A refused answer brings the card back")
        XCTAssertNil(model.approvalAnsweredLine)
        XCTAssertEqual(transport.approvals.map(\.scope), [.always])

        // Allow once sends no scope at all.
        await model.answerApproval(button: current.buttons[1])
        XCTAssertEqual(transport.approvals.last?.decision, .allow)
        XCTAssertEqual(transport.approvals.last?.scope, Optional<AidenApprovalScope>.none)
        XCTAssertEqual(model.approvalAnsweredLine, "Allowed once")
    }

    func testBotApprovalWithoutAnAllowButtonNeverSendsAllow() async throws {
        let (model, transport) = try await loadedModel(approval: botApprovalObject(card: try card("allowOnMac"), canAllow: true))
        await model.answerApproval(.allow)
        XCTAssertTrue(transport.approvals.isEmpty)
        await model.answerApproval(.allow, scope: .always)
        XCTAssertTrue(transport.approvals.isEmpty)
        await model.answerApproval(.deny)
        XCTAssertEqual(transport.approvals.map(\.decision), [.deny])
        XCTAssertEqual(model.approvalAnsweredLine, "Denied")
    }
}

// MARK: Approvals page

extension AidenBotUXTests {
    func testAutoIsRefusedWhileTheMacHasNoApprovalModel() async throws {
        let transport = ApprovalSettingsTransport(mode: AidenApprovalModeView(mode: .ask, autoAvailable: false), rules: try decode(AidenApprovalRulesView.self, section("approvalRules")))
        let model = AidenApprovalSettingsModel(transport: transport)
        await model.load()
        XCTAssertFalse(model.canPickAuto)
        let changed = await model.setMode(.auto)
        XCTAssertFalse(changed)
        XCTAssertEqual(model.mode?.mode, .ask)
        XCTAssertTrue(transport.modeWrites.isEmpty)

        let never = await model.setMode(.never)
        XCTAssertTrue(never)
        XCTAssertEqual(transport.modeWrites, [.never])
        XCTAssertEqual(model.mode?.mode, .never)
    }

    func testModeAndRuleChangesAreOptimisticAndRollBack() async throws {
        let rules = try decode(AidenApprovalRulesView.self, section("approvalRules"))
        let transport = ApprovalSettingsTransport(mode: AidenApprovalModeView(mode: .ask, autoAvailable: true), rules: rules)
        let model = AidenApprovalSettingsModel(transport: transport)
        await model.load()

        let gate = UXGate()
        transport.gate = gate
        transport.failure = URLError(.networkConnectionLost)
        let blocked = rules.rows[1]
        let task = Task { await model.change(blocked, to: .ask) }
        await gate.entered()
        XCTAssertEqual(model.rows(in: .ask).map(\.title), ["Send email", "When a Bot wants to post in public channels"], "The row moves at once")
        await gate.release()
        let moved = await task.value
        XCTAssertFalse(moved)
        XCTAssertEqual(model.rows(in: .block).map(\.title), ["Send email"], "A refused change puts the row back")
        XCTAssertEqual(transport.changes.map(\.ref), [blocked.ref])

        // A row can only move where it offers; a read-and-remove row never moves.
        let macRow = rules.rows[4]
        let refused = await model.change(macRow, to: .allow)
        XCTAssertFalse(refused)
        XCTAssertEqual(transport.changes.count, 1)

        // Remove: a rule already gone on the Mac stays gone here.
        transport.failure = try serverError(404, "not_found")
        let removed = await model.remove(macRow)
        XCTAssertTrue(removed)
        XCTAssertTrue(model.rows(in: .mac).isEmpty)
    }

    func testDisableAToolTurnsEverythingIntoEverythingButThatTool() throws {
        let catalog = try decode(AidenBotCapabilityCatalog.self, catalogObject())
        var draft = try XCTUnwrap(try? aidenBotEditorResolvedDraft(mode: .create(defaultAccess: .recommended), catalog: catalog, bot: nil))
        draft.usesFullAccess = true
        let next = draft.disabling(.connection("connection_mail"), catalog: catalog)
        XCTAssertFalse(next.usesFullAccess)
        XCTAssertEqual(next.customAccess.connectionIDs, ["connection_calendar"])
        XCTAssertEqual(next.customAccess.fileScopeIDs, ["scope_full"], "The widest file access stays")
        XCTAssertTrue(next.customAccess.shellEnabled)
        XCTAssertEqual(next.customAccess.skillIDs, ["skill_notes"])

        let noShell = next.disabling(.shell, catalog: catalog)
        XCTAssertFalse(noShell.customAccess.shellEnabled)
        XCTAssertEqual(noShell.customAccess.connectionIDs, ["connection_calendar"], "A Custom Bot keeps what it had")
    }
}

// MARK: Helpers

extension AidenBotUXTests {
    func botApprovalObject(card: [String: Any], canAllow: Bool = true) -> [String: Any] {
        ["waitId": "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6", "toolCallId": "call_61", "toolName": "web_fetch",
         "summary": "Fetch https://example.com/menu", "canAllow": canAllow, "card": card]
    }

    func sessionObject(entries: [[String: Any]], approval: Any = NSNull()) -> [String: Any] {
        ["botId": "bot_fixture_01", "epoch": "epoch_61", "seq": 0, "state": "idle", "interrupted": false,
         "entries": entries, "hasOlder": false, "question": NSNull(), "approval": approval]
    }

    fileprivate func loadedModel(approval: Any = NSNull()) async throws -> (AidenBotSessionModel, UXTransport) {
        let samples = try XCTUnwrap(fixture()["botSessionEntries"] as? [[String: Any]])
        let transport = UXTransport(snapshot: try decode(AidenBotSession.self, sessionObject(entries: samples, approval: approval)))
        let model = AidenBotSessionModel(botID: "bot_fixture_01", transport: transport, owner: .noMachine)
        await model.load()
        XCTAssertEqual(model.entries.count, 7)
        return (model, transport)
    }

    func serverError(_ status: Int, _ code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"No.","requestId":"req_test_61","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    func makeInstallation(capabilities: [AidenRemoteCapability]) -> AidenInstallation {
        AidenInstallation(
            exchange: AidenRemotePairing.PairingExchange(
                protocolVersion: 1, instanceId: "instance-61", deviceId: "device-61", credential: "credential-61",
                capabilities: capabilities, endpoint: URL(string: "https://aiden.test/api/aiden/v1")!,
                serverSpkiSha256: "sha256/\(Data(repeating: 7, count: 32).base64EncodedString())"
            ),
            pairingTrust: AidenRemotePairing.PairingTrust(mode: .system),
            name: "Mac"
        )
    }

    func catalogObject() -> [String: Any] {
        func option(_ id: String, _ label: String, _ available: Bool = true) -> [String: Any] {
            ["id": id, "label": label, "available": available]
        }
        return [
            "revision": "catalog_61",
            "providers": [["id": "provider_a", "label": "Provider", "available": true,
                           "models": [["id": "model_a", "label": "Model", "available": true, "supportsImages": false]]]],
            "fileScopes": [
                ["id": "scope_full", "label": "Whole Mac", "available": true, "kind": "full_mac"],
                ["id": "scope_home", "label": "Its folder", "available": true, "kind": "bot_home"],
            ],
            "shellAvailable": true,
            "connections": [option("connection_mail", "Mail"), option("connection_calendar", "Calendar"), option("connection_off", "Off", false)],
            "skills": [option("skill_notes", "Notes")],
            "skillsEnabled": true,
            "otherCapabilities": [],
        ]
    }
}

private actor UXGate {
    private var waiting: CheckedContinuation<Void, Never>?
    private var arrived: CheckedContinuation<Void, Never>?
    private var hasArrived = false

    func wait() async {
        hasArrived = true
        arrived?.resume(); arrived = nil
        await withCheckedContinuation { waiting = $0 }
    }

    func entered() async {
        if hasArrived { return }
        await withCheckedContinuation { arrived = $0 }
    }

    func release() { waiting?.resume(); waiting = nil }
}

private final class UXTransport: AidenBotSessionTransport, @unchecked Sendable {
    struct SettingsCall { let changeId: String; let decision: AidenBotSettingsChangeDecision }
    struct ApprovalCall { let decision: AidenApprovalDecision; let scope: AidenApprovalScope? }
    let snapshot: AidenBotSession
    var gate: UXGate?
    var failure: Error?
    var settingsStatus: AidenBotSettingsChangeEntry.Status = .applied
    var settingsMessage: String?
    var settingsCalls: [SettingsCall] = []
    var skillCalls: [AidenBotSkillProposalDecision] = []
    var approvals: [ApprovalCall] = []

    init(snapshot: AidenBotSession) { self.snapshot = snapshot }

    private func pass() async throws {
        if let gate { self.gate = nil; await gate.wait() }
        if let failure { self.failure = nil; throw failure }
    }

    func respondBotSettingsChange(botId: String, changeId: String, decision: AidenBotSettingsChangeDecision) async throws -> AidenBotSettingsChangeReceipt {
        settingsCalls.append(SettingsCall(changeId: changeId, decision: decision))
        try await pass()
        var object: [String: Any] = ["changeId": changeId, "status": settingsStatus.rawValue]
        if let settingsMessage { object["message"] = settingsMessage }
        return try AidenRemoteJSONDecoder.decode(AidenBotSettingsChangeReceipt.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func respondBotSkillProposal(botId: String, proposalId: String, decision: AidenBotSkillProposalDecision) async throws -> AidenBotSkillProposalReceipt {
        skillCalls.append(decision)
        try await pass()
        return try AidenRemoteJSONDecoder.decode(AidenBotSkillProposalReceipt.self, from: Data(#"{"proposalId":"\#(proposalId)","status":"\#(decision == .add ? "added" : "dismissed")"}"#.utf8))
    }

    func respondBotLesson(botId: String, lessonId: String, decision: AidenBotLessonDecision) async throws -> AidenBotLessonReceipt {
        try await pass()
        return try AidenRemoteJSONDecoder.decode(AidenBotLessonReceipt.self, from: Data(#"{"lessonId":"\#(lessonId)","status":"\#(decision == .keep ? "active" : "dismissed")"}"#.utf8))
    }

    func removeBotLesson(botId: String, lessonId: String) async throws -> AidenBotLessonReceipt {
        try await pass()
        return try AidenRemoteJSONDecoder.decode(AidenBotLessonReceipt.self, from: Data(#"{"lessonId":"\#(lessonId)","status":"retired"}"#.utf8))
    }

    func undoBotLearning(botId: String, changeId: String) async throws -> AidenBotLearningUndoReceipt {
        try await pass()
        return try AidenRemoteJSONDecoder.decode(AidenBotLearningUndoReceipt.self, from: Data(#"{"changeId":"\#(changeId)","undone":true}"#.utf8))
    }

    func respondToApproval(id: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, idempotencyKey: UUID) async throws -> AidenApprovalResponse {
        approvals.append(ApprovalCall(decision: decision, scope: scope))
        try await pass()
        return try AidenRemoteJSONDecoder.decode(AidenApprovalResponse.self, from: Data(#"{"approvalId":"\#(id)","decision":"\#(decision.rawValue)","resolvedAt":"2026-11-13T09:00:00.000Z"}"#.utf8))
    }

    func botSession(botId: String) async throws -> AidenBotSession { snapshot }
    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> { AsyncThrowingStream { $0.finish() } }
    func sendBotMessage(botId: String, request: AidenBotMessageRequest, idempotencyKey: UUID) async throws -> AidenBotMessageReceipt { throw URLError(.unsupportedURL) }
    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView { throw URLError(.unsupportedURL) }
    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView { throw URLError(.unsupportedURL) }
    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView { throw URLError(.unsupportedURL) }
    func answerBotQuestion(botId: String, waitId: String, request: AidenQuestionRespondRequest, idempotencyKey: UUID) async throws -> AidenBotQuestionAnswerReceipt { throw URLError(.unsupportedURL) }
    func requestBotConnection(botId: String, request: AidenBotConnectionRequest, idempotencyKey: UUID) async throws -> AidenBotConnectionRequestReceipt { throw URLError(.unsupportedURL) }
    func respondToBotRoutineProposal(botId: String, proposalId: String, request: AidenBotRoutineProposalRespondRequest, idempotencyKey: UUID) async throws -> AidenBotRoutineProposalRespondResult { throw URLError(.unsupportedURL) }
}

private final class ApprovalSettingsTransport: AidenApprovalSettingsTransport, @unchecked Sendable {
    var mode: AidenApprovalModeView
    var rules: AidenApprovalRulesView
    var gate: UXGate?
    var failure: Error?
    var modeWrites: [AidenApprovalMode] = []
    var changes: [AidenApprovalRuleChangeRequest] = []

    init(mode: AidenApprovalModeView, rules: AidenApprovalRulesView) {
        self.mode = mode
        self.rules = rules
    }

    private func pass() async throws {
        if let gate { self.gate = nil; await gate.wait() }
        if let failure { self.failure = nil; throw failure }
    }

    func approvalMode() async throws -> AidenApprovalModeView { mode }
    func setApprovalMode(_ next: AidenApprovalMode) async throws -> AidenApprovalModeView {
        modeWrites.append(next)
        try await pass()
        mode = AidenApprovalModeView(mode: next, autoAvailable: mode.autoAvailable)
        return mode
    }
    func approvalRules() async throws -> AidenApprovalRulesView { rules }
    func approvalRulePicker() async throws -> AidenApprovalRulePicker { throw URLError(.unsupportedURL) }
    func addApprovalRule(_ request: AidenApprovalRuleAddRequest) async throws -> AidenApprovalRulesView { throw URLError(.unsupportedURL) }
    func changeApprovalRule(_ request: AidenApprovalRuleChangeRequest) async throws -> AidenApprovalRulesView {
        changes.append(request)
        try await pass()
        return rules
    }
    func removeApprovalRule(_ request: AidenApprovalRuleRemoveRequest) async throws -> AidenApprovalRulesView {
        try await pass()
        rules.rows.removeAll { $0.ref == request.ref }
        return rules
    }
}
