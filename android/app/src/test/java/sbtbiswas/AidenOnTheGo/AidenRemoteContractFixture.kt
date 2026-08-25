package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.models.*
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
data class AidenBotArchiveResponse(
    val id: String,
    val name: String,
    val purpose: String,
    val instructions: String,
    val avatar: AidenBotAvatarView,
    val health: AidenBotHealth,
    val access: AidenBotAccessView,
    val createdAt: String,
    val updatedAt: String,
    val archivedAt: String? = null,
    val revision: String
) {
    val bot: AidenBotDetail get() = AidenBotDetail(
        id = id,
        name = name,
        purpose = purpose,
        instructions = instructions,
        avatar = avatar,
        health = health,
        access = access,
        createdAt = java.time.Instant.parse(createdAt),
        updatedAt = java.time.Instant.parse(updatedAt),
        archivedAt = archivedAt?.let { java.time.Instant.parse(it) },
        revision = revision
    )
}

@Serializable
data class AidenBotRestoreResponse(
    val id: String,
    val name: String,
    val purpose: String,
    val instructions: String,
    val avatar: AidenBotAvatarView,
    val health: AidenBotHealth,
    val access: AidenBotAccessView,
    val createdAt: String,
    val updatedAt: String,
    val revision: String
) {
    val bot: AidenBotDetail get() = AidenBotDetail(
        id = id,
        name = name,
        purpose = purpose,
        instructions = instructions,
        avatar = avatar,
        health = health,
        access = access,
        createdAt = java.time.Instant.parse(createdAt),
        updatedAt = java.time.Instant.parse(updatedAt),
        revision = revision
    )
}

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

@Serializable
data class AidenBotChatSubsetUpdateFixture(
    val request: AidenBotChatAccessUpdate,
    val response: AidenBotChatAccessView
)

@Serializable
data class AidenBotFavoritesUpdateContractFixture(
    val request: AidenBotFavoritesUpdateRequest,
    val response: AidenBotFavorites
)

@Serializable
data class AidenBotFavoritesUpdateRequest(
    val botIds: List<String>
)

@Serializable
data class AidenBotNoticeAcknowledgementContractFixture(
    val request: AidenBotNoticeAcknowledgementRequest,
    val response: AidenBotNoticeAcknowledgementResponse
)

@Serializable
data class AidenBotNoticeAcknowledgementRequest(
    val version: String,
    val decision: String,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenBotNoticeAcknowledgementResponse(
    val version: String,
    val requiresAcknowledgement: Boolean,
    val acceptedAt: String,
    val acceptedDecision: AidenBotDecision
)

@Serializable
data class AidenBotAvatarUploadContractFixture(
    val request: AidenBotAvatarUpload,
    val response: AidenBotAvatarAsset
)

@Serializable
data class AidenBotLegacyNonNegotiatingFixture(
    val pairingExchange: AidenPairingExchange,
    val server: AidenServer
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
    val chat: AidenChat,
    val botSummary: AidenBotSummary,
    val botList: AidenBotList,
    val botDetail: AidenBotDetail,
    val botAvatar: AidenBotAvatarView,
    val botCreate: AidenBotCreateFixture,
    val botIdentity: AidenBotIdentityContractFixture,
    val botArchive: AidenBotArchiveResponse,
    val botRestore: AidenBotRestoreResponse,
    val botConversation: AidenBotConversationItem,
    val botConversations: AidenBotConversationPage,
    val botConversationQuery: AidenBotConversationQuery,
    val botChatCreate: AidenBotChatCreateContractFixture,
    val botCapabilityCatalog: AidenBotCapabilityCatalog,
    val botPolicy: AidenBotAccessView,
    val botPolicyUpdate: AidenBotPolicyUpdateFixture,
    val botChatSubset: AidenBotChatAccessView,
    val botChatSubsetUpdate: AidenBotChatSubsetUpdateFixture,
    val botFavorites: AidenBotFavorites,
    val botFavoritesUpdate: AidenBotFavoritesUpdateContractFixture,
    val botNotice: AidenBotNoticeStatus,
    val botNoticeAcknowledgement: AidenBotNoticeAcknowledgementContractFixture,
    val botAvatarUpload: AidenBotAvatarUploadContractFixture,
    val botAvatarMetadata: AidenBotAvatarAsset,
    val legacyNonNegotiating: AidenBotLegacyNonNegotiatingFixture,
    val error: AidenRemoteErrorEnvelope? = null
)
