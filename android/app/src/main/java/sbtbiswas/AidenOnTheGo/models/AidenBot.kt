package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant
import java.util.Base64
import java.util.UUID

object AidenBotWire {
    const val MAX_NAME_LENGTH = 80
    const val MAX_PURPOSE_LENGTH = 280
    const val MAX_GREETING_LENGTH = 2_000
    const val MAX_INSTRUCTIONS_LENGTH = 32_000
    const val MAX_SUMMARY_LENGTH = 280
    const val MAX_PREVIEW_LENGTH = 500
    const val MAX_BOTS = 256
    const val MAX_FAVORITES = 20
    const val MAX_CONVERSATION_PAGE = 50
    const val MAX_CHAT_MESSAGES = 10_000
    const val MAX_CHAT_TITLE_LENGTH = 1_024
    const val MAX_PROVIDERS = 64
    const val MAX_MODELS = 256
    const val MAX_AGGREGATE_MODELS = 512
    const val MAX_FILE_SCOPES = 64
    const val MAX_CONNECTIONS = 128
    const val MAX_SKILLS = 256
    const val MAX_OTHER_CAPABILITIES = 128
    const val MAX_AVATAR_BASE64_LENGTH = 5_592_408
    const val MAX_AVATAR_BYTES = 4 * 1_048_576
    const val FULL_ACCESS_NOTICE_VERSION = "bot-full-access-v1"

    fun validateIdentifier(value: String, field: String, maxLength: Int = AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH) {
        validateString(value, field, maxLength, allowEmpty = false)
        if (!isSafeIdentifier(value)) {
            throw AidenBotContractException.InvalidField(field)
        }
    }

    fun isSafeIdentifier(value: String): Boolean {
        return value.all { c ->
            c in '0'..'9' || c in 'A'..'Z' || c in 'a'..'z' || c == '-' || c == '.' || c == ':' || c == '_'
        }
    }

    fun validateString(value: String, field: String, maxLength: Int, allowEmpty: Boolean = false) {
        if ((!allowEmpty && value.isEmpty()) || value.codePointCount(0, value.length) > maxLength) {
            throw AidenBotContractException.InvalidField(field)
        }
    }

    fun uniqueIdentifiers(values: List<String>, field: String, maxItems: Int, maxLength: Int = AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH): List<String> {
        if (values.size > maxItems || values.toSet().size != values.size) {
            throw AidenBotContractException.InvalidField(field)
        }
        for (v in values) {
            validateIdentifier(v, field, maxLength)
        }
        return values
    }
}

@Serializable
enum class AidenBotLegacyAvatar {
    @SerialName("spark") SPARK,
    @SerialName("orbit") ORBIT,
    @SerialName("leaf") LEAF,
    @SerialName("prism") PRISM,
    @SerialName("wave") WAVE,
    @SerialName("ember") EMBER
}

@Serializable
enum class AidenBotAvatarShape {
    @SerialName("wisp") WISP,
    @SerialName("orb") ORB,
    @SerialName("drop") DROP,
    @SerialName("hex") HEX,
    @SerialName("cloud") CLOUD,
    @SerialName("peak") PEAK,
    @SerialName("squircle") SQUIRCLE,
    @SerialName("capsule") CAPSULE
}

@Serializable
enum class AidenBotAvatarColor {
    @SerialName("lilac") LILAC,
    @SerialName("sky") SKY,
    @SerialName("mint") MINT,
    @SerialName("sun") SUN,
    @SerialName("periwinkle") PERIWINKLE,
    @SerialName("coral") CORAL,
    @SerialName("peach") PEACH,
    @SerialName("aqua") AQUA
}

@Serializable
enum class AidenBotAvatarEyes {
    @SerialName("dots") DOTS,
    @SerialName("wide") WIDE,
    @SerialName("happy") HAPPY,
    @SerialName("sleepy") SLEEPY,
    @SerialName("focus") FOCUS,
    @SerialName("wink") WINK
}

@Serializable
enum class AidenBotAvatarDetail {
    @SerialName("none") NONE,
    @SerialName("halo") HALO,
    @SerialName("orbit") ORBIT,
    @SerialName("sparkles") SPARKLES,
    @SerialName("antenna") ANTENNA,
    @SerialName("bolts") BOLTS
}

@Serializable
data class AidenBotAvatarRecipe(
    val version: Int = 1,
    val shape: AidenBotAvatarShape,
    val color: AidenBotAvatarColor,
    val eyes: AidenBotAvatarEyes,
    val detail: AidenBotAvatarDetail
) {
    init {
        if (version != 1) throw AidenBotContractException.InvalidField("avatar.version")
    }
}

@Serializable(with = AidenBotSemanticAvatarSerializer::class)
sealed class AidenBotSemanticAvatar {
    data class Legacy(val legacy: AidenBotLegacyAvatar) : AidenBotSemanticAvatar()
    data class Recipe(val recipe: AidenBotAvatarRecipe) : AidenBotSemanticAvatar()
}

object AidenBotSemanticAvatarSerializer : KSerializer<AidenBotSemanticAvatar> {
    override val descriptor: SerialDescriptor = AidenBotAvatarRecipe.serializer().descriptor

    override fun serialize(encoder: Encoder, value: AidenBotSemanticAvatar) {
        require(encoder is JsonEncoder)
        when (value) {
            is AidenBotSemanticAvatar.Legacy -> encoder.encodeSerializableValue(AidenBotLegacyAvatar.serializer(), value.legacy)
            is AidenBotSemanticAvatar.Recipe -> encoder.encodeSerializableValue(AidenBotAvatarRecipe.serializer(), value.recipe)
        }
    }

    override fun deserialize(decoder: Decoder): AidenBotSemanticAvatar {
        require(decoder is JsonDecoder)
        val element = decoder.decodeJsonElement()
        return if (element is JsonPrimitive && element.isString) {
            AidenBotSemanticAvatar.Legacy(decoder.json.decodeFromJsonElement(AidenBotLegacyAvatar.serializer(), element))
        } else {
            AidenBotSemanticAvatar.Recipe(decoder.json.decodeFromJsonElement(AidenBotAvatarRecipe.serializer(), element))
        }
    }
}

private object AidenBotLegacyAvatarWrapperSerializer : KSerializer<AidenBotSemanticAvatar.Legacy> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("LegacyAvatar", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenBotSemanticAvatar.Legacy) {
        encoder.encodeSerializableValue(AidenBotLegacyAvatar.serializer(), value.legacy)
    }
    override fun deserialize(decoder: Decoder): AidenBotSemanticAvatar.Legacy {
        return AidenBotSemanticAvatar.Legacy(decoder.decodeSerializableValue(AidenBotLegacyAvatar.serializer()))
    }
}

private object AidenBotAvatarRecipeWrapperSerializer : KSerializer<AidenBotSemanticAvatar.Recipe> {
    override val descriptor: SerialDescriptor = AidenBotAvatarRecipe.serializer().descriptor
    override fun serialize(encoder: Encoder, value: AidenBotSemanticAvatar.Recipe) {
        encoder.encodeSerializableValue(AidenBotAvatarRecipe.serializer(), value.recipe)
    }
    override fun deserialize(decoder: Decoder): AidenBotSemanticAvatar.Recipe {
        return AidenBotSemanticAvatar.Recipe(decoder.decodeSerializableValue(AidenBotAvatarRecipe.serializer()))
    }
}

@Serializable
enum class AidenBotAvatarAssetMimeType {
    @SerialName("image/png") PNG
}

@Serializable
enum class AidenBotAvatarUploadMimeType {
    @SerialName("image/png") PNG,
    @SerialName("image/jpeg") JPEG
}

@Serializable
data class AidenBotAvatarAsset(
    val assetRevision: String,
    val mimeType: AidenBotAvatarAssetMimeType,
    val width: Int,
    val height: Int,
    val byteSize: Int
) {
    init {
        AidenBotWire.validateIdentifier(assetRevision, "assetRevision")
        if (width != 512 || height != 512 || byteSize !in 1..AidenBotWire.MAX_AVATAR_BYTES) {
            throw AidenBotContractException.InvalidField("avatar.asset")
        }
    }
}

data class AidenBotAvatarContent(
    val data: ByteArray,
    val assetRevision: String
)

@Serializable
data class AidenBotAvatarView(
    val semantic: AidenBotSemanticAvatar,
    val asset: AidenBotAvatarAsset? = null
)

typealias AidenBotAvatar = AidenBotAvatarView

@Serializable
enum class AidenBotHealth {
    @SerialName("ready") READY,
    @SerialName("degraded") DEGRADED,
    @SerialName("unavailable") UNAVAILABLE,
    @SerialName("archived") ARCHIVED
}

@Serializable
data class AidenBotSummary(
    val id: String,
    val name: String,
    val purpose: String,
    val avatar: AidenBotAvatarView,
    val health: AidenBotHealth,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String,
    @Serializable(with = InstantIso8601Serializer::class) val archivedAt: Instant? = null
) {
    init {
        AidenBotWire.validateIdentifier(id, "id", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(name, "name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(purpose, "purpose", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        if ((health == AidenBotHealth.ARCHIVED) != (archivedAt != null)) {
            throw AidenBotContractException.InvalidCombination("bot health/timestamps")
        }
        if (updatedAt.isBefore(createdAt)) {
            throw AidenBotContractException.InvalidCombination("bot timestamps")
        }
    }
}

@Serializable
data class AidenBotList(
    val bots: List<AidenBotSummary>,
    val maxBots: Int = AidenBotWire.MAX_BOTS,
    val favorites: AidenBotFavorites
) {
    init {
        val archivedIds = bots.filter { it.health == AidenBotHealth.ARCHIVED }.map { it.id }.toSet()
        val allIds = bots.map { it.id }.toSet()
        if (bots.size > AidenBotWire.MAX_BOTS || maxBots != AidenBotWire.MAX_BOTS || bots.size > maxBots ||
            allIds.size != bots.size ||
            !allIds.containsAll(favorites.botIds) ||
            favorites.botIds.any { archivedIds.contains(it) }
        ) {
            throw AidenBotContractException.InvalidField("bots")
        }
    }
}

@Serializable
data class AidenBotModelSelection(
    val providerId: String,
    val modelId: String
) {
    init {
        AidenBotWire.validateString(providerId, "providerId", 256)
        AidenBotWire.validateString(modelId, "modelId", 512)
    }
}

@Serializable
data class AidenBotDetail(
    val id: String,
    val name: String,
    val purpose: String,
    val openingGreeting: String? = null,
    val instructions: String,
    val avatar: AidenBotAvatarView,
    val health: AidenBotHealth,
    val access: AidenBotAccessView,
    val modelSelection: AidenBotModelSelection? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String,
    @Serializable(with = InstantIso8601Serializer::class) val archivedAt: Instant? = null
) {
    init {
        AidenBotWire.validateIdentifier(id, "id", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(name, "name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(purpose, "purpose", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true)
        openingGreeting?.let { AidenBotWire.validateString(it, "openingGreeting", AidenBotWire.MAX_GREETING_LENGTH, allowEmpty = true) }
        AidenBotWire.validateString(instructions, "instructions", AidenBotWire.MAX_INSTRUCTIONS_LENGTH)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        if (access.botId != id || (health == AidenBotHealth.ARCHIVED) != (archivedAt != null)) {
            throw AidenBotContractException.InvalidCombination("bot detail identity/state")
        }
        if (updatedAt.isBefore(createdAt)) {
            throw AidenBotContractException.InvalidCombination("bot timestamps")
        }
    }
}

@Serializable
data class AidenBotCreateRequest(
    val name: String,
    val purpose: String,
    val openingGreeting: String? = null,
    val instructions: String,
    val avatar: AidenBotSemanticAvatar,
    val access: AidenBotAccessUpdate
) {
    init {
        AidenBotWire.validateString(name, "name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(purpose, "purpose", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true)
        openingGreeting?.let { AidenBotWire.validateString(it, "openingGreeting", AidenBotWire.MAX_GREETING_LENGTH, allowEmpty = true) }
        AidenBotWire.validateString(instructions, "instructions", AidenBotWire.MAX_INSTRUCTIONS_LENGTH)
    }
}

@Serializable
data class AidenBotIdentityPatch(
    val name: String? = null,
    val purpose: String? = null,
    val openingGreeting: String? = null,
    val instructions: String? = null,
    val avatar: AidenBotSemanticAvatar? = null
) {
    init {
        if (name == null && purpose == null && openingGreeting == null && instructions == null && avatar == null) {
            throw AidenBotContractException.InvalidCombination("empty identity patch")
        }
        name?.let { AidenBotWire.validateString(it, "name", AidenBotWire.MAX_NAME_LENGTH) }
        purpose?.let { AidenBotWire.validateString(it, "purpose", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true) }
        openingGreeting?.let { AidenBotWire.validateString(it, "openingGreeting", AidenBotWire.MAX_GREETING_LENGTH, allowEmpty = true) }
        instructions?.let { AidenBotWire.validateString(it, "instructions", AidenBotWire.MAX_INSTRUCTIONS_LENGTH) }
    }
}

@Serializable
enum class AidenBotConversationActivityState {
    @SerialName("idle") IDLE,
    @SerialName("queued") QUEUED,
    @SerialName("running") RUNNING,
    @SerialName("waiting_for_approval") WAITING_FOR_APPROVAL,
    @SerialName("reconciling") RECONCILING
}

@Serializable
data class AidenBotConversationItem(
    val chatId: String,
    val botId: String,
    val title: String,
    val preview: String? = null,
    val activityState: AidenBotConversationActivityState,
    val canRespondToApproval: Boolean,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String
) {
    init {
        AidenBotWire.validateString(chatId, "chatId", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateIdentifier(botId, "botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(title, "title", 1_024, allowEmpty = true)
        preview?.let { AidenBotWire.validateString(it, "preview", AidenBotWire.MAX_PREVIEW_LENGTH, allowEmpty = true) }
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        if (updatedAt.isBefore(createdAt) || (canRespondToApproval && activityState != AidenBotConversationActivityState.WAITING_FOR_APPROVAL)) {
            throw AidenBotContractException.InvalidCombination("conversation activity/timestamps")
        }
    }
}

@Serializable
data class AidenBotConversationPage(
    val conversations: List<AidenBotConversationItem>,
    val nextCursor: String? = null
) {
    init {
        if (conversations.size > AidenBotWire.MAX_CONVERSATION_PAGE || conversations.map { it.chatId }.toSet().size != conversations.size) {
            throw AidenBotContractException.InvalidField("conversations")
        }
    }
}

@Serializable
data class AidenBotCapabilityOption(
    val id: String,
    val label: String,
    val available: Boolean,
    val description: String? = null
) {
    init {
        AidenBotWire.validateIdentifier(id, "id")
        AidenBotWire.validateString(label, "label", 120)
        description?.let { AidenBotWire.validateString(it, "description", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true) }
    }
}

@Serializable
enum class AidenBotFileScopeKind {
    @SerialName("full_mac") FULL_MAC,
    @SerialName("bot_home") BOT_HOME,
    @SerialName("approved_location") APPROVED_LOCATION
}

@Serializable
data class AidenBotFileScopeOption(
    val id: String,
    val label: String,
    val available: Boolean,
    val description: String? = null,
    val kind: AidenBotFileScopeKind
) {
    init {
        AidenBotWire.validateIdentifier(id, "id")
        AidenBotWire.validateString(label, "label", 120)
        description?.let { AidenBotWire.validateString(it, "description", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true) }
    }
}

@Serializable
data class AidenBotModelOption(
    val id: String,
    val label: String,
    val available: Boolean
) {
    init {
        AidenBotWire.validateString(id, "id", 512)
        AidenBotWire.validateString(label, "label", 160)
    }
}

@Serializable
data class AidenBotProviderOption(
    val id: String,
    val label: String,
    val available: Boolean,
    val models: List<AidenBotModelOption>
) {
    init {
        AidenBotWire.validateString(id, "id", 256)
        AidenBotWire.validateString(label, "label", 120)
        if (models.size > AidenBotWire.MAX_MODELS || models.map { it.id }.toSet().size != models.size) {
            throw AidenBotContractException.InvalidField("models")
        }
    }
}

@Serializable
data class AidenBotCapabilityCatalog(
    val revision: String,
    val providers: List<AidenBotProviderOption>,
    val fileScopes: List<AidenBotFileScopeOption>,
    val shellAvailable: Boolean,
    val connections: List<AidenBotCapabilityOption>,
    val skills: List<AidenBotCapabilityOption>,
    val otherCapabilities: List<AidenBotCapabilityOption>,
    val notice: AidenBotNoticeStatus
) {
    init {
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        val totalModels = providers.sumOf { it.models.size }
        if (providers.size > AidenBotWire.MAX_PROVIDERS || totalModels > AidenBotWire.MAX_AGGREGATE_MODELS ||
            fileScopes.size > AidenBotWire.MAX_FILE_SCOPES || connections.size > AidenBotWire.MAX_CONNECTIONS ||
            skills.size > AidenBotWire.MAX_SKILLS || otherCapabilities.size > AidenBotWire.MAX_OTHER_CAPABILITIES ||
            providers.map { it.id }.toSet().size != providers.size ||
            fileScopes.map { it.id }.toSet().size != fileScopes.size ||
            connections.map { it.id }.toSet().size != connections.size ||
            skills.map { it.id }.toSet().size != skills.size ||
            otherCapabilities.map { it.id }.toSet().size != otherCapabilities.size
        ) {
            throw AidenBotContractException.InvalidField("capability catalog")
        }
    }

    fun contains(selection: AidenBotCustomSelection): Boolean {
        val provider = providers.firstOrNull { it.id == selection.providerId } ?: return false
        if (provider.models.none { it.id == selection.modelId }) return false
        val fileScopeIds = fileScopes.map { it.id }.toSet()
        val connectionIds = connections.map { it.id }.toSet()
        val skillIds = skills.map { it.id }.toSet()
        val otherCapIds = otherCapabilities.map { it.id }.toSet()
        return fileScopeIds.containsAll(selection.fileScopeIds) &&
                connectionIds.containsAll(selection.connectionIds) &&
                skillIds.containsAll(selection.skillIds) &&
                otherCapIds.containsAll(selection.otherCapabilityIds)
    }

    fun containsAvailable(selection: AidenBotCustomSelection): Boolean {
        val provider = providers.firstOrNull { it.id == selection.providerId && it.available } ?: return false
        if (provider.models.none { it.id == selection.modelId && it.available }) return false
        if (selection.shellEnabled && !shellAvailable) return false
        val availableFileScopes = fileScopes.filter { it.available }.map { it.id }.toSet()
        val availableConnections = connections.filter { it.available }.map { it.id }.toSet()
        val availableSkills = skills.filter { it.available }.map { it.id }.toSet()
        val availableOtherCaps = otherCapabilities.filter { it.available }.map { it.id }.toSet()
        return availableFileScopes.containsAll(selection.fileScopeIds) &&
                availableConnections.containsAll(selection.connectionIds) &&
                availableSkills.containsAll(selection.skillIds) &&
                availableOtherCaps.containsAll(selection.otherCapabilityIds)
    }

    fun containsAvailable(providerId: String, modelId: String): Boolean {
        val provider = providers.firstOrNull { it.id == providerId && it.available } ?: return false
        return provider.models.any { it.id == modelId && it.available }
    }
}

@Serializable
data class AidenBotCustomSelection(
    val fileScopeIds: List<String>,
    val shellEnabled: Boolean,
    val connectionIds: List<String>,
    val skillIds: List<String>,
    val otherCapabilityIds: List<String>,
    val providerId: String,
    val modelId: String
) {
    init {
        AidenBotWire.uniqueIdentifiers(fileScopeIds, "fileScopeIds", AidenBotWire.MAX_FILE_SCOPES)
        AidenBotWire.uniqueIdentifiers(connectionIds, "connectionIds", AidenBotWire.MAX_CONNECTIONS)
        AidenBotWire.uniqueIdentifiers(skillIds, "skillIds", AidenBotWire.MAX_SKILLS)
        AidenBotWire.uniqueIdentifiers(otherCapabilityIds, "otherCapabilityIds", AidenBotWire.MAX_OTHER_CAPABILITIES)
        AidenBotWire.validateString(providerId, "providerId", 256)
        AidenBotWire.validateString(modelId, "modelId", 512)
    }

    fun isSubset(ceiling: AidenBotCustomSelection): Boolean {
        return providerId == ceiling.providerId &&
                modelId == ceiling.modelId &&
                (!shellEnabled || ceiling.shellEnabled) &&
                ceiling.fileScopeIds.toSet().containsAll(fileScopeIds) &&
                ceiling.connectionIds.toSet().containsAll(connectionIds) &&
                ceiling.skillIds.toSet().containsAll(skillIds) &&
                ceiling.otherCapabilityIds.toSet().containsAll(otherCapabilityIds)
    }
}

@Serializable
enum class AidenBotAccessMode {
    @SerialName("full") FULL,
    @SerialName("custom") CUSTOM
}

@Serializable
data class AidenBotAccessView(
    val botId: String,
    val accessMode: AidenBotAccessMode,
    val revision: String,
    val policyEpoch: String,
    val summary: String,
    val custom: AidenBotCustomSelection? = null
) {
    init {
        AidenBotWire.validateIdentifier(botId, "botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(policyEpoch, "policyEpoch", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(summary, "summary", AidenBotWire.MAX_SUMMARY_LENGTH)
        if ((accessMode == AidenBotAccessMode.CUSTOM) != (custom != null)) {
            throw AidenBotContractException.InvalidCombination("bot access mode/custom")
        }
    }

    fun permits(selection: AidenBotCustomSelection): Boolean {
        return when (accessMode) {
            AidenBotAccessMode.FULL -> true
            AidenBotAccessMode.CUSTOM -> custom?.let { selection.isSubset(it) } ?: false
        }
    }
}

@Serializable
data class AidenBotAccessUpdate(
    val accessMode: AidenBotAccessMode,
    val catalogRevision: String,
    val confirmedForeground: Boolean? = null,
    val custom: AidenBotCustomSelection? = null,
    val providerId: String? = null,
    val modelId: String? = null
) {
    init {
        AidenBotWire.validateString(catalogRevision, "catalogRevision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        when (accessMode) {
            AidenBotAccessMode.FULL -> {
                if (confirmedForeground != true || custom != null) {
                    throw AidenBotContractException.InvalidCombination("full access update")
                }
                if ((providerId == null) != (modelId == null)) {
                    throw AidenBotContractException.InvalidCombination("full access provider/model")
                }
            }
            AidenBotAccessMode.CUSTOM -> {
                if (confirmedForeground != null || providerId != null || modelId != null || custom == null) {
                    throw AidenBotContractException.InvalidCombination("custom access update")
                }
            }
        }
    }

    companion object {
        fun full(catalogRevision: String, selection: AidenBotModelSelection? = null): AidenBotAccessUpdate {
            return AidenBotAccessUpdate(
                accessMode = AidenBotAccessMode.FULL,
                catalogRevision = catalogRevision,
                confirmedForeground = true,
                providerId = selection?.providerId,
                modelId = selection?.modelId
            )
        }

        fun custom(catalogRevision: String, selection: AidenBotCustomSelection): AidenBotAccessUpdate {
            return AidenBotAccessUpdate(
                accessMode = AidenBotAccessMode.CUSTOM,
                catalogRevision = catalogRevision,
                custom = selection
            )
        }
    }
}

@Serializable
enum class AidenBotChatAccessMode {
    @SerialName("inherit") INHERIT,
    @SerialName("custom") CUSTOM
}

@Serializable
data class AidenBotChatAccessView(
    val chatId: String,
    val botId: String,
    val mode: AidenBotChatAccessMode,
    val revision: String,
    val botPolicyRevision: String,
    val summary: String,
    val custom: AidenBotCustomSelection? = null
) {
    init {
        AidenBotWire.validateString(chatId, "chatId", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateIdentifier(botId, "botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(botPolicyRevision, "botPolicyRevision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(summary, "summary", AidenBotWire.MAX_SUMMARY_LENGTH)
        if ((mode == AidenBotChatAccessMode.CUSTOM) != (custom != null)) {
            throw AidenBotContractException.InvalidCombination("chat access mode/custom")
        }
    }
}

@Serializable
data class AidenBotChatAccessUpdate(
    val mode: AidenBotChatAccessMode,
    val catalogRevision: String,
    val expectedBotPolicyRevision: String,
    val custom: AidenBotCustomSelection? = null
) {
    init {
        AidenBotWire.validateString(catalogRevision, "catalogRevision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(expectedBotPolicyRevision, "expectedBotPolicyRevision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        if ((mode == AidenBotChatAccessMode.CUSTOM) != (custom != null)) {
            throw AidenBotContractException.InvalidCombination("inherited chat access")
        }
    }

    companion object {
        fun inherit(catalogRevision: String, expectedBotPolicyRevision: String) = AidenBotChatAccessUpdate(
            mode = AidenBotChatAccessMode.INHERIT,
            catalogRevision = catalogRevision,
            expectedBotPolicyRevision = expectedBotPolicyRevision
        )

        fun custom(catalogRevision: String, expectedBotPolicyRevision: String, selection: AidenBotCustomSelection) = AidenBotChatAccessUpdate(
            mode = AidenBotChatAccessMode.CUSTOM,
            catalogRevision = catalogRevision,
            expectedBotPolicyRevision = expectedBotPolicyRevision,
            custom = selection
        )
    }
}

@Serializable
data class AidenBotFavorites(
    val botIds: List<String>,
    val revision: String
) {
    init {
        AidenBotWire.uniqueIdentifiers(botIds, "botIds", AidenBotWire.MAX_FAVORITES, AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
    }
}

@Serializable
data class AidenBotFavoritesUpdateRequest(
    val botIds: List<String>
) {
    init {
        AidenBotWire.uniqueIdentifiers(botIds, "botIds", AidenBotWire.MAX_FAVORITES, AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
    }
}

@Serializable
enum class AidenBotNoticeDecision {
    @SerialName("continue_full") CONTINUE_FULL,
    @SerialName("customize_first") CUSTOMIZE_FIRST
}

typealias AidenBotDecision = AidenBotNoticeDecision

@Serializable
data class AidenBotNoticeStatus(
    val version: String,
    val requiresAcknowledgement: Boolean,
    @Serializable(with = InstantIso8601Serializer::class) val acceptedAt: Instant? = null,
    val acceptedDecision: AidenBotNoticeDecision? = null
) {
    init {
        AidenBotWire.validateString(version, "version", 80)
        if (version != AidenBotWire.FULL_ACCESS_NOTICE_VERSION ||
            (requiresAcknowledgement && (acceptedAt != null || acceptedDecision != null)) ||
            (!requiresAcknowledgement && (acceptedAt == null || acceptedDecision == null))
        ) {
            throw AidenBotContractException.InvalidCombination("notice acknowledgement")
        }
    }
}

@Serializable
data class AidenBotNoticeAcknowledgement(
    val version: String,
    val decision: AidenBotNoticeDecision,
    val confirmedForeground: Boolean = true
) {
    init {
        if (version != AidenBotWire.FULL_ACCESS_NOTICE_VERSION || !confirmedForeground) {
            throw AidenBotContractException.InvalidField("notice acknowledgement")
        }
    }
}

@Serializable
data class AidenBotAvatarUpload(
    val data: String,
    val mimeType: AidenBotAvatarUploadMimeType = AidenBotAvatarUploadMimeType.PNG
) {
    init {
        if (data.length > AidenBotWire.MAX_AVATAR_BASE64_LENGTH) {
            throw AidenBotContractException.InvalidField("avatar.data")
        }
        val decoded = try {
            Base64.getDecoder().decode(data)
        } catch (_: Exception) {
            throw AidenBotContractException.InvalidField("avatar.data")
        }
        if (decoded.isEmpty() || decoded.size > AidenBotWire.MAX_AVATAR_BYTES || Base64.getEncoder().encodeToString(decoded) != data) {
            throw AidenBotContractException.InvalidField("avatar.data")
        }
    }
}

@Serializable
data class AidenBotChatCreateRequest(
    val providerId: String? = null,
    val modelId: String? = null
) {
    init {
        if ((providerId == null) != (modelId == null)) {
            throw AidenBotContractException.InvalidCombination("chat provider/model override")
        }
        providerId?.let { AidenBotWire.validateString(it, "providerId", 256) }
        modelId?.let { AidenBotWire.validateString(it, "modelId", 512) }
    }
}

enum class AidenBotFavoriteOrderMove {
    ADD, EARLIER, LATER, REMOVE
}

fun aidenBotFavoriteOrder(
    botIds: List<String>,
    movingBotId: String,
    move: AidenBotFavoriteOrderMove
): List<String> {
    val result = botIds.filter { it != movingBotId }.toMutableList()
    when (move) {
        AidenBotFavoriteOrderMove.ADD -> result.add(movingBotId)
        AidenBotFavoriteOrderMove.REMOVE -> {}
        AidenBotFavoriteOrderMove.EARLIER, AidenBotFavoriteOrderMove.LATER -> {
            val oldIndex = botIds.indexOf(movingBotId)
            if (oldIndex == -1) return botIds
            val destination = if (move == AidenBotFavoriteOrderMove.EARLIER) {
                maxOf(0, oldIndex - 1)
            } else {
                minOf(botIds.size - 1, oldIndex + 1)
            }
            result.add(destination, movingBotId)
        }
    }
    return result
}

fun aidenCanonicalBotConversations(
    conversations: List<AidenBotConversationItem>
): List<AidenBotConversationItem> {
    val canonicalByBotId = mutableMapOf<String, AidenBotConversationItem>()
    for (conversation in conversations) {
        val current = canonicalByBotId[conversation.botId]
        if (current == null) {
            canonicalByBotId[conversation.botId] = conversation
            continue
        }
        if (conversation.updatedAt.isAfter(current.updatedAt) ||
            (conversation.updatedAt == current.updatedAt && (
                conversation.createdAt.isAfter(current.createdAt) ||
                (conversation.createdAt == current.createdAt && conversation.chatId < current.chatId)
            ))
        ) {
            canonicalByBotId[conversation.botId] = conversation
        }
    }
    return conversations.filter { conversation ->
        canonicalByBotId[conversation.botId]?.chatId == conversation.chatId
    }
}

data class AidenBotsFavoriteMutation(
    val id: UUID,
    val botID: String
)

data class AidenBotsFavoriteMutationFinish(
    val favoriteOverride: List<String>?,
    val favoriteError: String?
)

fun aidenBotsFinishFavoriteMutation(
    current: AidenBotsFavoriteMutation?,
    finishing: AidenBotsFavoriteMutation,
    restoring: List<String>?,
    error: String? = null
): AidenBotsFavoriteMutationFinish? {
    if (current != finishing) return null
    return AidenBotsFavoriteMutationFinish(
        favoriteOverride = restoring,
        favoriteError = error
    )
}

@Serializable
data class AidenBotArchiveResponse(
    val bot: AidenBotDetail
)

@Serializable
data class AidenBotRestoreResponse(
    val bot: AidenBotDetail
)

@Serializable
data class AidenBotChatCreateResponse(
    val chat: AidenChat
)

@Serializable
data class AidenBotConversationQuery(
    val cursor: String? = null,
    val query: String? = null,
    val botId: String? = null,
    val limit: Int? = null
)
