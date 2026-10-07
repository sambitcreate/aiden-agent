import Foundation
@testable import AidenOnTheGo

// The shared cross-platform contract fixture
// (`protocol/aiden-remote/v1/fixtures/contract.json`) and its request/response
// pairs. These decoders only exist to test the contract; production code
// decodes the pairing types through `AidenRemotePairing`.

private func fixtureRequireKeys(_ decoder: Decoder, _ allowed: Set<String>) throws {
    let dynamic = try decoder.container(keyedBy: AidenBotDynamicCodingKey.self)
    if dynamic.allKeys.contains(where: { !allowed.contains($0.stringValue) }) {
        throw AidenRemoteContractError.unsafePayloadField("fixture")
    }
}

func aidenBotSelectionsSemanticallyEqual(
    _ left: AidenBotCustomSelection?,
    _ right: AidenBotCustomSelection?
) -> Bool {
    switch (left, right) {
    case (nil, nil):
        return true
    case let (left?, right?):
        return left.providerId == right.providerId
            && left.modelId == right.modelId
            && left.shellEnabled == right.shellEnabled
            && Set(left.fileScopeIds) == Set(right.fileScopeIds)
            && Set(left.connectionIds) == Set(right.connectionIds)
            && Set(left.skillIds) == Set(right.skillIds)
            && Set(left.otherCapabilityIds) == Set(right.otherCapabilityIds)
    default:
        return false
    }
}

private func aidenBotAccessViewsSemanticallyEqual(
    _ left: AidenBotAccessView,
    _ right: AidenBotAccessView
) -> Bool {
    left.botId == right.botId
        && left.accessMode == right.accessMode
        && left.revision == right.revision
        && left.policyEpoch == right.policyEpoch
        && left.summary == right.summary
        && aidenBotSelectionsSemanticallyEqual(left.custom, right.custom)
}

// MARK: - Request/response pairs

struct AidenBotCreateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotCreateRequest
    let response: AidenBotDetail

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotCreateRequest.self, forKey: .request)
        response = try values.decode(AidenBotDetail.self, forKey: .response)
        guard response.name == request.name,
              response.purpose == request.purpose,
              response.openingGreeting == request.openingGreeting,
              response.instructions == request.instructions,
              response.avatar.semantic == request.avatar else {
            throw AidenBotContractError.invalidCombination("bot create fixture")
        }
        switch request.access {
        case nil, .full:
            guard response.access.accessMode == .full else {
                throw AidenBotContractError.invalidCombination("bot create access fixture")
            }
        case let .custom(_, selection, _):
            guard response.access.accessMode == .custom,
                  aidenBotSelectionsSemanticallyEqual(response.access.custom, selection) else {
                throw AidenBotContractError.invalidCombination("bot create access fixture")
            }
        }
    }
}

struct AidenBotIdentityContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotIdentityPatch
    let response: AidenBotDetail

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotIdentityPatch.self, forKey: .request)
        response = try values.decode(AidenBotDetail.self, forKey: .response)
        let greetingMatches: Bool
        if let greeting = request.openingGreeting {
            greetingMatches = greeting.isEmpty
                ? response.openingGreeting == nil
                : response.openingGreeting == greeting
        } else {
            greetingMatches = true
        }
        guard request.name.map({ $0 == response.name }) ?? true,
              request.purpose.map({ $0 == response.purpose }) ?? true,
              greetingMatches,
              request.instructions.map({ $0 == response.instructions }) ?? true,
              request.avatar.map({ $0 == response.avatar.semantic }) ?? true else {
            throw AidenBotContractError.invalidCombination("bot identity fixture")
        }
    }
}

struct AidenBotChatCreateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotChatCreateRequest
    let response: AidenBotChatCreateResponse

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotChatCreateRequest.self, forKey: .request)
        response = try values.decode(AidenBotChatCreateResponse.self, forKey: .response)
        guard request.providerId.map({ $0 == response.chat.providerId }) ?? true,
              request.modelId.map({ $0 == response.chat.modelId }) ?? true else {
            throw AidenBotContractError.invalidCombination("bot chat create fixture")
        }
    }
}

struct AidenBotPolicyUpdateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotAccessUpdate
    let response: AidenBotAccessView

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotAccessUpdate.self, forKey: .request)
        response = try values.decode(AidenBotAccessView.self, forKey: .response)
        switch request {
        case .full:
            guard response.accessMode == .full else {
                throw AidenBotContractError.invalidCombination("bot policy fixture")
            }
        case let .custom(_, selection, _):
            guard response.accessMode == .custom,
                  aidenBotSelectionsSemanticallyEqual(response.custom, selection) else {
                throw AidenBotContractError.invalidCombination("bot policy fixture")
            }
        }
    }
}

struct AidenBotAvatarUploadContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotAvatarUpload
    let response: AidenBotAvatarAsset
}

/// A request body paired with the host's response, decoded with the same
/// strict parsers production uses.
struct AidenBotRequestResponseFixture<Request: Codable & Equatable & Sendable, Response: Codable & Equatable & Sendable>:
    Codable, Equatable, Sendable {
    let request: Request
    let response: Response

    init(from decoder: Decoder) throws {
        try fixtureRequireKeys(decoder, ["request", "response"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(Request.self, forKey: .request)
        response = try values.decode(Response.self, forKey: .response)
    }
}

typealias AidenBotSessionSendFixture = AidenBotRequestResponseFixture<AidenBotMessageRequest, AidenBotMessageReceipt>
typealias AidenBotSessionActionFixture = AidenBotRequestResponseFixture<AidenBotSessionActionRequest, AidenBotSessionStateView>
typealias AidenBotRoutineCreateFixture = AidenBotRequestResponseFixture<AidenBotRoutineCreateRequest, AidenBotRoutine>
typealias AidenBotRoutineUpdateFixture = AidenBotRequestResponseFixture<AidenBotRoutineUpdateRequest, AidenBotRoutine>
typealias AidenBotConnectionRequestFixture = AidenBotRequestResponseFixture<
    AidenBotConnectionRequest,
    AidenBotConnectionRequestReceipt
>
typealias AidenBotPresetCreateFixture = AidenBotRequestResponseFixture<AidenBotPresetCreateRequest, AidenBotPresetCreateResult>

struct AidenBotLegacyNonNegotiatingFixture: Decodable, Equatable {
    let pairingExchange: AidenRemotePairing.PairingExchange
    let server: AidenServer

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pairingExchange = try values.decode(AidenRemotePairing.PairingExchange.self, forKey: .pairingExchange)
        server = try values.decode(AidenServer.self, forKey: .server)
        let legacyCapabilities = Set(pairingExchange.capabilities)
        guard legacyCapabilities == Set(server.capabilities),
              server.serverCapabilities == nil,
              !legacyCapabilities.contains(.botRead),
              !legacyCapabilities.contains(.botWrite) else {
            throw AidenBotContractError.invalidCombination("legacy Bot negotiation fixture")
        }
    }

    private enum CodingKeys: String, CodingKey { case pairingExchange, server }
}

extension AidenBotCreateContractFixture: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botCreate") }
}

extension AidenBotIdentityContractFixture: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botIdentity") }
}

extension AidenBotChatCreateContractFixture: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botChatCreate") }
}

extension AidenBotPolicyUpdateContractFixture: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botPolicyUpdate") }
}

extension AidenBotAvatarUploadContractFixture: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botAvatarUpload") }
}

// MARK: - Whole fixture

struct AidenRemoteContractFixture: Decodable {
    typealias Health = AidenRemotePairing.Health
    typealias ManualPairingBootstrap = AidenRemotePairing.ManualPairingBootstrap
    typealias PairingBootstrap = AidenRemotePairing.PairingBootstrap
    typealias PairingTrust = AidenRemotePairing.PairingTrust
    typealias PairingPayload = AidenRemotePairing.PairingPayload
    typealias PairingExchange = AidenRemotePairing.PairingExchange
    typealias BotCreateFixture = AidenBotCreateContractFixture
    typealias BotPolicyUpdateFixture = AidenBotPolicyUpdateContractFixture

    struct DeviceCapabilitiesUpdateFixture: Decodable {
        let request: AidenRemoteDeviceCapabilitiesUpdateRequest
        let response: AidenRemoteDeviceCapabilitiesUpdateResponse

        init(from decoder: Decoder) throws {
            try fixtureRequireKeys(decoder, ["request", "response"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            request = try values.decode(AidenRemoteDeviceCapabilitiesUpdateRequest.self, forKey: .request)
            response = try values.decode(AidenRemoteDeviceCapabilitiesUpdateResponse.self, forKey: .response)
        }

        private enum CodingKeys: String, CodingKey { case request, response }
    }

    /// Revision 16: one child stop and the refreshed current-turn roster.
    struct AgentInterruptFixture: Decodable {
        let agentId: String
        let response: AidenRemoteChatAgentRoster

        init(from decoder: Decoder) throws {
            try fixtureRequireKeys(decoder, ["agentId", "response"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            agentId = try values.decode(String.self, forKey: .agentId)
            response = try values.decode(AidenRemoteChatAgentRoster.self, forKey: .response)
        }

        private enum CodingKeys: String, CodingKey { case agentId, response }
    }

    struct StreamInputFixture: Decodable {
        let request: AidenStreamInputRequest
        let response: AidenStreamInputResult

        init(from decoder: Decoder) throws {
            try fixtureRequireKeys(decoder, ["request", "response"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            request = try values.decode(AidenStreamInputRequest.self, forKey: .request)
            response = try values.decode(AidenStreamInputResult.self, forKey: .response)
        }

        private enum CodingKeys: String, CodingKey { case request, response }
    }

    struct QuestionFixture: Decodable {
        let pending: AidenStreamPendingQuestion
        let respondRequest: AidenQuestionRespondRequest
        let respondResponse: AidenQuestionRespondResponse

        init(from decoder: Decoder) throws {
            try fixtureRequireKeys(decoder, ["pending", "respondRequest", "respondResponse"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            pending = try values.decode(AidenStreamPendingQuestion.self, forKey: .pending)
            respondRequest = try values.decode(AidenQuestionRespondRequest.self, forKey: .respondRequest)
            respondResponse = try values.decode(AidenQuestionRespondResponse.self, forKey: .respondResponse)
        }

        private enum CodingKeys: String, CodingKey { case pending, respondRequest, respondResponse }
    }

    /// Timestamps compared exactly as they appeared on the wire.
    private struct BotTimestampProjection: Decodable {
        let id: String
        let revision: String
        let createdAt: String
        let updatedAt: String

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            revision = try values.decode(String.self, forKey: .revision)
            createdAt = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt).rawValue
            updatedAt = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt).rawValue
        }

        func hasSameLifecycleTimestamps(as other: Self) -> Bool {
            createdAt == other.createdAt && updatedAt == other.updatedAt
        }

        private enum CodingKeys: String, CodingKey { case id, revision, createdAt, updatedAt }
    }

    private struct BotListTimestampProjection: Decodable {
        let bots: [BotTimestampProjection]
    }

    private struct ConversationTimestampProjection: Decodable, Equatable {
        let chatId: String
        let botId: String
        let revision: String
        let createdAt: String
        let updatedAt: String

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            chatId = try values.decode(String.self, forKey: .chatId)
            botId = try values.decode(String.self, forKey: .botId)
            revision = try values.decode(String.self, forKey: .revision)
            createdAt = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt).rawValue
            updatedAt = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt).rawValue
        }

        private enum CodingKeys: String, CodingKey { case chatId, botId, revision, createdAt, updatedAt }
    }

    private struct ConversationPageTimestampProjection: Decodable {
        let conversations: [ConversationTimestampProjection]
    }

    let contractRevision: Int
    let protocolVersion: Int
    let capabilities: [AidenRemoteCapability]
    let health: Health
    let pairingBootstrap: PairingBootstrap
    let pairingExchange: PairingExchange
    let server: AidenServer
    let chat: AidenChat
    let chatSummaries: AidenChatSummaryPage
    let botSummary: AidenBotSummary
    let botList: AidenBotList
    let botDetail: AidenBotDetail
    let botAvatar: AidenBotAvatarView
    let botCreate: BotCreateFixture
    let botIdentity: AidenBotIdentityContractFixture
    let botConversation: AidenBotConversationItem
    let botConversations: AidenBotConversationPage
    let botConversationQuery: AidenBotConversationQuery
    let botChatCreate: AidenBotChatCreateContractFixture
    let botCapabilityCatalog: AidenBotCapabilityCatalog
    let botPolicy: AidenBotAccessView
    let botPolicyUpdate: BotPolicyUpdateFixture
    let botAvatarUpload: AidenBotAvatarUploadContractFixture
    let botAvatarMetadata: AidenBotAvatarAsset
    let botSession: AidenBotSession
    let botSessionNeedsModel: AidenBotSession
    let botSessionEvents: [AidenBotSessionEvent]
    let botSessionSend: AidenBotSessionSendFixture
    let botSessionResume: AidenBotSessionActionFixture
    let botSessionDismiss: AidenBotSessionActionFixture
    let botRoutines: AidenBotRoutineList
    let botRoutineCreate: AidenBotRoutineCreateFixture
    let botRoutineUpdate: AidenBotRoutineUpdateFixture
    let botConnectionRequest: AidenBotConnectionRequestFixture
    let botPresets: AidenBotPresetList
    let botPresetCreate: AidenBotPresetCreateFixture
    let legacyNonNegotiating: AidenBotLegacyNonNegotiatingFixture
    let taskProgress: AidenRemoteChatTaskProgress?
    let agentRoster: AidenRemoteChatAgentRoster?
    let agentInterrupt: AgentInterruptFixture?
    let deviceCapabilitiesUpdate: DeviceCapabilitiesUpdateFixture?
    let chatProgressEvents: [AidenRemoteStreamEvent]
    let streamStatus: AidenStreamStatus
    let streamApproval: AidenStreamApprovalSnapshot
    let streamInput: StreamInputFixture?
    let question: QuestionFixture?
    let chatSkills: AidenRemoteSkillCatalog?
    let events: [AidenRemoteStreamEvent]
    let speechStatus: AidenSpeechStatus
    let speechTranscription: AidenSpeechTranscription
    let scheduleRunNotification: AidenScheduledRunNotification
    let error: AidenRemoteErrorEnvelope
    let runControlError: AidenRemoteErrorEnvelope?
    let phoneRunEvents: [AidenRemoteRunEvent]

    // swiftlint:disable:next function_body_length
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        contractRevision = try values.decode(Int.self, forKey: .contractRevision)
        guard contractRevision >= 9 else {
            throw AidenBotContractError.invalidCombination("contract revision")
        }
        protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
        capabilities = try values.decode([AidenRemoteCapability].self, forKey: .capabilities)
        health = try values.decode(Health.self, forKey: .health)
        pairingBootstrap = try values.decode(PairingBootstrap.self, forKey: .pairingBootstrap)
        pairingExchange = try values.decode(PairingExchange.self, forKey: .pairingExchange)
        _ = try pairingExchange.validated(against: pairingBootstrap)
        server = try values.decode(AidenServer.self, forKey: .server)
        chat = try values.decode(AidenChat.self, forKey: .chat)
        chatSummaries = try values.decode(AidenChatSummaryPage.self, forKey: .chatSummaries)
        botSummary = try values.decode(AidenBotSummary.self, forKey: .botSummary)
        botList = try values.decode(AidenBotList.self, forKey: .botList)
        botDetail = try values.decode(AidenBotDetail.self, forKey: .botDetail)
        botAvatar = try values.decode(AidenBotAvatarView.self, forKey: .botAvatar)
        botCreate = try values.decode(BotCreateFixture.self, forKey: .botCreate)
        botIdentity = try values.decode(AidenBotIdentityContractFixture.self, forKey: .botIdentity)
        botConversation = try values.decode(AidenBotConversationItem.self, forKey: .botConversation)
        botConversations = try values.decode(AidenBotConversationPage.self, forKey: .botConversations)
        botConversationQuery = try values.decode(AidenBotConversationQuery.self, forKey: .botConversationQuery)
        botChatCreate = try values.decode(AidenBotChatCreateContractFixture.self, forKey: .botChatCreate)
        botCapabilityCatalog = try values.decode(AidenBotCapabilityCatalog.self, forKey: .botCapabilityCatalog)
        botPolicy = try values.decode(AidenBotAccessView.self, forKey: .botPolicy)
        botPolicyUpdate = try values.decode(BotPolicyUpdateFixture.self, forKey: .botPolicyUpdate)
        botAvatarUpload = try values.decode(AidenBotAvatarUploadContractFixture.self, forKey: .botAvatarUpload)
        botAvatarMetadata = try values.decode(AidenBotAvatarAsset.self, forKey: .botAvatarMetadata)
        botSession = try values.decode(AidenBotSession.self, forKey: .botSession)
        botSessionNeedsModel = try values.decode(AidenBotSession.self, forKey: .botSessionNeedsModel)
        botSessionEvents = try values.decode([AidenBotSessionEvent].self, forKey: .botSessionEvents)
        botSessionSend = try values.decode(AidenBotSessionSendFixture.self, forKey: .botSessionSend)
        botSessionResume = try values.decode(AidenBotSessionActionFixture.self, forKey: .botSessionResume)
        botSessionDismiss = try values.decode(AidenBotSessionActionFixture.self, forKey: .botSessionDismiss)
        botRoutines = try values.decode(AidenBotRoutineList.self, forKey: .botRoutines)
        botRoutineCreate = try values.decode(AidenBotRoutineCreateFixture.self, forKey: .botRoutineCreate)
        botRoutineUpdate = try values.decode(AidenBotRoutineUpdateFixture.self, forKey: .botRoutineUpdate)
        botConnectionRequest = try values.decode(AidenBotConnectionRequestFixture.self, forKey: .botConnectionRequest)
        botPresets = try values.decode(AidenBotPresetList.self, forKey: .botPresets)
        botPresetCreate = try values.decode(AidenBotPresetCreateFixture.self, forKey: .botPresetCreate)
        legacyNonNegotiating = try values.decode(AidenBotLegacyNonNegotiatingFixture.self, forKey: .legacyNonNegotiating)
        taskProgress = try values.decodeIfPresent(AidenRemoteChatTaskProgress.self, forKey: .taskProgress)
        agentRoster = try values.decodeIfPresent(AidenRemoteChatAgentRoster.self, forKey: .agentRoster)
        agentInterrupt = try values.decodeIfPresent(AgentInterruptFixture.self, forKey: .agentInterrupt)
        deviceCapabilitiesUpdate = try values.decodeIfPresent(
            DeviceCapabilitiesUpdateFixture.self,
            forKey: .deviceCapabilitiesUpdate
        )
        chatProgressEvents = try values.decodeIfPresent(
            [AidenRemoteStreamEvent].self,
            forKey: .chatProgressEvents
        ) ?? []
        streamStatus = try values.decode(AidenStreamStatus.self, forKey: .streamStatus)
        streamApproval = try values.decode(AidenStreamApprovalSnapshot.self, forKey: .streamApproval)
        streamInput = try values.decodeIfPresent(StreamInputFixture.self, forKey: .streamInput)
        question = try values.decodeIfPresent(QuestionFixture.self, forKey: .question)
        chatSkills = try values.decodeIfPresent(AidenRemoteSkillCatalog.self, forKey: .chatSkills)
        events = try values.decode([AidenRemoteStreamEvent].self, forKey: .events)
        speechStatus = try values.decode(AidenSpeechStatus.self, forKey: .speechStatus)
        speechTranscription = try values.decode(AidenSpeechTranscription.self, forKey: .speechTranscription)
        scheduleRunNotification = try values.decode(
            AidenScheduledRunNotification.self,
            forKey: .scheduleRunNotification
        )
        error = try values.decode(AidenRemoteErrorEnvelope.self, forKey: .error)
        runControlError = try values.decodeIfPresent(AidenRemoteErrorEnvelope.self, forKey: .runControlError)
        phoneRunEvents = try values.decodeIfPresent([AidenRemoteRunEvent].self, forKey: .phoneRunEvents) ?? []

        let summaryTimestamps = try values.decode(BotTimestampProjection.self, forKey: .botSummary)
        let listTimestamps = try values.decode(BotListTimestampProjection.self, forKey: .botList)
        let detailTimestamps = try values.decode(BotTimestampProjection.self, forKey: .botDetail)
        let conversationTimestamps = try values.decode(ConversationTimestampProjection.self, forKey: .botConversation)
        let pageTimestamps = try values.decode(ConversationPageTimestampProjection.self, forKey: .botConversations)

        let botID = botDetail.id
        let sameRevisionSummaryMatchesDetail = botSummary.revision != botDetail.revision || (
            botSummary.name == botDetail.name
                && botSummary.purpose == botDetail.purpose
                && botSummary.avatar == botDetail.avatar
                && botSummary.health == botDetail.health
                && summaryTimestamps.hasSameLifecycleTimestamps(as: detailTimestamps)
        )
        let listContainsSummaryTimestamps = listTimestamps.bots.contains {
            $0.id == summaryTimestamps.id && $0.revision == summaryTimestamps.revision
                && $0.hasSameLifecycleTimestamps(as: summaryTimestamps)
        }
        let samePolicyMatches = botPolicy.botId != botDetail.access.botId
            || botPolicy.revision != botDetail.access.revision
            || aidenBotAccessViewsSemanticallyEqual(botPolicy, botDetail.access)
        let grantedCapabilities = Set(server.capabilities)
        let supportedCapabilities = Set(server.serverCapabilities ?? [])
        let responseSelections: [AidenBotCustomSelection?] = [
            botDetail.access.custom, botCreate.response.access.custom, botIdentity.response.access.custom,
            botPolicy.custom, botPolicyUpdate.response.custom,
        ]
        let modelAvailable: (String?, String?) -> Bool = { providerId, modelId in
            switch (providerId, modelId) {
            case (nil, nil): true
            case let (providerId?, modelId?):
                self.botCapabilityCatalog.containsAvailable(providerId: providerId, modelId: modelId)
            default: false
            }
        }
        guard protocolVersion == AidenRemoteProtocol.version,
              server.protocolVersion == AidenRemoteProtocol.version,
              server.supportsChatSummaries,
              !chatSummaries.summaries.isEmpty,
              server.instanceId == pairingBootstrap.instanceId,
              pairingExchange.capabilities == server.capabilities,
              legacyNonNegotiating.pairingExchange.instanceId == pairingBootstrap.instanceId,
              legacyNonNegotiating.server.instanceId == pairingBootstrap.instanceId,
              Set(capabilities).isSuperset(of: [.botRead, .botWrite]),
              grantedCapabilities.isSuperset(of: [.botRead, .botWrite]),
              supportedCapabilities.isSuperset(of: [.botRead, .botWrite]),
              grantedCapabilities.isSubset(of: supportedCapabilities),
              botList.bots.contains(botSummary),
              listContainsSummaryTimestamps,
              botSummary.id == botID,
              sameRevisionSummaryMatchesDetail,
              botAvatar == botDetail.avatar,
              botCreate.response.id == botID,
              botIdentity.response.id == botID,
              botConversation.botId == botID,
              botConversations.conversations.contains(botConversation),
              pageTimestamps.conversations.contains(conversationTimestamps),
              botConversationQuery.botId.map({ $0 == botID }) ?? true,
              botChatCreate.response.chat.botId == botID,
              chat.botId == botID,
              modelAvailable(chat.providerId, chat.modelId),
              botPolicy.botId == botID,
              samePolicyMatches,
              botPolicyUpdate.response.botId == botID,
              botCreate.request.access.map({ $0.catalogRevision == botCapabilityCatalog.revision }) ?? true,
              botPolicyUpdate.request.catalogRevision == botCapabilityCatalog.revision,
              responseSelections.compactMap({ $0 }).allSatisfy(botCapabilityCatalog.contains),
              botPolicyUpdate.request.customSelection.map(botCapabilityCatalog.containsAvailable) ?? true,
              modelAvailable(botChatCreate.request.providerId, botChatCreate.request.modelId),
              modelAvailable(botChatCreate.response.chat.providerId, botChatCreate.response.chat.modelId),
              botAvatarUpload.response == botAvatarMetadata,
              botAvatarMetadata == botDetail.avatar.asset,
              botSession.botId == botID,
              botRoutines.routines.allSatisfy({ $0.botId == botID }),
              botPresetCreate.response.bot.name
                == botPresets.presets.first(where: { $0.id == botPresetCreate.request.presetId })?.name else {
            throw AidenBotContractError.invalidCombination("shared Bot fixture")
        }
    }

    private enum CodingKeys: String, CodingKey {
        case contractRevision, protocolVersion, capabilities, health
        case pairingBootstrap, pairingExchange, server, chat, chatSummaries
        case botSummary, botList, botDetail, botAvatar, botCreate, botIdentity
        case botConversation, botConversations, botConversationQuery
        case botChatCreate, botCapabilityCatalog, botPolicy, botPolicyUpdate
        case botAvatarUpload, botAvatarMetadata
        case botSession, botSessionNeedsModel, botSessionEvents, botSessionSend
        case botSessionResume, botSessionDismiss, botRoutines, botRoutineCreate, botRoutineUpdate
        case botConnectionRequest, botPresets, botPresetCreate
        case legacyNonNegotiating
        case taskProgress, agentRoster, agentInterrupt, deviceCapabilitiesUpdate, chatProgressEvents
        case streamStatus, streamApproval, streamInput, question, chatSkills, events, speechStatus, speechTranscription
        case scheduleRunNotification, error, runControlError, phoneRunEvents
    }
}

extension AidenRemoteContractFixture: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .sharedFixture }
}
