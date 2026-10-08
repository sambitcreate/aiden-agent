package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteStreamEvent
import sbtbiswas.AidenOnTheGo.protocol.*

@Serializable
data class AidenRemoteContractFixtureHealth(
    val ok: Boolean,
    val protocolVersion: Int
)

@Serializable
data class AidenBotCreateFixture(
    val request: AidenBotCreateRequest,
    val response: AidenBotDetail
)

@Serializable
data class AidenBotIdentityContractFixture(
    val request: AidenBotIdentityQuery? = null,
    val response: AidenBotDetail
)

@Serializable
data class AidenBotIdentityQuery(
    val openingGreeting: String? = null
)

@Serializable
data class AidenBotChatCreateContractFixture(
    val request: AidenBotChatCreateRequest,
    val response: AidenChatCreateResponse
)

@Serializable
data class AidenBotChatCreateRequest(
    val providerId: String? = null,
    val modelId: String? = null
)

@Serializable
data class AidenChatCreateResponse(
    val id: String,
    val workspaceId: String? = null,
    val botId: String? = null,
    val title: String,
    val providerId: String? = null,
    val modelId: String? = null,
    val messages: List<AidenChatMessage> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val revision: String = "rev_1"
) {
    val chat: AidenChat get() = AidenChat(
        id = id,
        workspaceId = workspaceId ?: "",
        botId = botId,
        title = title,
        providerId = providerId ?: "",
        modelId = modelId ?: "",
        messages = messages,
        createdAt = createdAt?.let { java.time.Instant.parse(it) } ?: java.time.Instant.now(),
        updatedAt = updatedAt?.let { java.time.Instant.parse(it) } ?: java.time.Instant.now(),
        revision = revision
    )
}

@Serializable
data class AidenBotPolicyUpdateFixture(
    val request: AidenBotAccessUpdate,
    val response: AidenBotAccessView
)

/** Revision 25 request/response pairs. */
@Serializable
data class AidenBotSessionSendFixture(
    val request: AidenBotSessionSendRequest,
    val response: AidenBotSessionSendResponse
)

@Serializable
data class AidenBotSessionControlFixture(
    val request: AidenBotEmptyRequest,
    val response: AidenBotSessionStateView
)

@Serializable
data class AidenBotRoutineCreateFixture(
    val request: AidenBotRoutineCreateRequest,
    val response: AidenBotRoutine
)

@Serializable
data class AidenBotRoutineUpdateFixture(
    val request: AidenBotRoutineUpdateRequest,
    val response: AidenBotRoutine
)

@Serializable
data class AidenBotConnectionRequestFixture(
    val request: AidenBotConnectionRequest,
    val response: AidenBotConnectionRequestReceipt
)

@Serializable
data class AidenBotPresetCreateFixture(
    val request: AidenBotPresetCreateRequest,
    val response: AidenBotPresetCreateResult
)

@Serializable
data class AidenBotAvatarUploadContractFixture(
    val request: AidenBotAvatarUpload,
    val response: AidenBotAvatarAsset
)

@Serializable
data class AidenDeviceCapabilitiesUpdateRequestFixture(
    val accepts: List<AidenRemoteCapability>
)

@Serializable
data class AidenDeviceCapabilitiesUpdateResponseFixture(
    val capabilities: List<AidenRemoteCapability>
)

@Serializable
data class AidenDeviceCapabilitiesUpdateFixture(
    val request: AidenDeviceCapabilitiesUpdateRequestFixture,
    val response: AidenDeviceCapabilitiesUpdateResponseFixture
)

@Serializable
data class AidenBotLegacyNonNegotiatingFixture(
    val pairingExchange: AidenPairingExchange,
    val server: AidenServer
)

@Serializable
data class AidenStreamInputFixture(
    val request: AidenStreamInputRequest,
    val response: AidenStreamInputResult
)

/** Raw question wire objects; tests decode them through the strict codec so
 * the shared fixture exercises the same bounds as the live SSE path. */
@Serializable
data class AidenQuestionFixture(
    val pending: JsonObject,
    val respondRequest: JsonObject,
    val respondResponse: JsonObject
)

/** Revision 16: one child stop and the refreshed current-turn roster. */
@Serializable
data class AidenAgentInterruptFixture(
    val agentId: String,
    val response: AidenChatAgentRoster
)

@Serializable
data class AidenRemoteContractFixture(
    val contractRevision: Int,
    val protocolVersion: Int,
    val generated: Boolean = false,
    val notice: String = "",
    val capabilities: List<AidenRemoteCapability>,
    val health: AidenRemoteContractFixtureHealth,
    val pairingBootstrap: AidenPairingBootstrap,
    val pairingExchange: AidenPairingExchange,
    val server: AidenServer,
    val workspaces: List<AidenWorkspace> = emptyList(),
    val memorySettings: AidenMemorySettings? = null,
    val chat: AidenChat,
    val chatSummaries: AidenChatSummaryPage? = null,
    val botSummary: AidenBotSummary,
    val botList: AidenBotList,
    val botDetail: AidenBotDetail,
    val botAvatar: AidenBotAvatarView,
    val botCreate: AidenBotCreateFixture,
    val botIdentity: AidenBotIdentityContractFixture,
    val botConversation: AidenBotConversationItem,
    val botConversations: AidenBotConversationPage,
    val botConversationQuery: AidenBotConversationQuery,
    val botChatCreate: AidenBotChatCreateContractFixture,
    val botCapabilityCatalog: AidenBotCapabilityCatalog,
    val botPolicy: AidenBotAccessView,
    val botPolicyUpdate: AidenBotPolicyUpdateFixture,
    val botAvatarUpload: AidenBotAvatarUploadContractFixture,
    val botAvatarMetadata: AidenBotAvatarAsset,
    val botSession: AidenBotSession,
    val botSessionNeedsModel: AidenBotSession,
    val botSessionEvents: List<AidenBotSessionEvent>,
    val botSessionSend: AidenBotSessionSendFixture,
    val botSessionResume: AidenBotSessionControlFixture,
    val botSessionDismiss: AidenBotSessionControlFixture,
    val botRoutines: AidenBotRoutineList,
    val botRoutineCreate: AidenBotRoutineCreateFixture,
    val botRoutineUpdate: AidenBotRoutineUpdateFixture,
    val botConnectionRequest: AidenBotConnectionRequestFixture,
    val botPresets: AidenBotPresetList,
    val botPresetCreate: AidenBotPresetCreateFixture,
    val taskProgress: AidenChatTaskProgress? = null,
    val agentRoster: AidenChatAgentRoster? = null,
    val agentInterrupt: AidenAgentInterruptFixture? = null,
    val deviceCapabilitiesUpdate: AidenDeviceCapabilitiesUpdateFixture? = null,
    val chatProgressEvents: List<AidenRemoteStreamEvent> = emptyList(),
    val streamInput: AidenStreamInputFixture? = null,
    val streamStatus: AidenStreamStatus? = null,
    val question: AidenQuestionFixture? = null,
    /** Raw catalog wire object; tests decode it through the strict codec so
     * the shared fixture exercises the same bounds as the live route. */
    val chatSkills: JsonObject? = null,
    val events: List<JsonObject> = emptyList(),
    val legacyNonNegotiating: AidenBotLegacyNonNegotiatingFixture,
    val scheduleRunNotification: AidenScheduledRunNotification? = null,
    val error: AidenRemoteErrorEnvelope? = null,
    /** Revision 19: a desktop run-control loser's error, decoded by the shared envelope. */
    val runControlError: AidenRemoteErrorEnvelope? = null
)
