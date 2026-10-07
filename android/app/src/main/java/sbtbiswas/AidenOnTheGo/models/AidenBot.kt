package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant
import java.util.Base64

object AidenBotWire {
    const val MAX_NAME_LENGTH = 80
    const val MAX_PURPOSE_LENGTH = 280
    const val MAX_GREETING_LENGTH = 2_000
    const val MAX_INSTRUCTIONS_LENGTH = 32_000
    const val MAX_SUMMARY_LENGTH = 280
    const val MAX_PREVIEW_LENGTH = 500
    const val MAX_BOTS = 256
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
    @SerialName("aqua") AQUA,
    @SerialName("rose") ROSE,
    @SerialName("lime") LIME,
    @SerialName("plum") PLUM,
    @SerialName("graphite") GRAPHITE
}

/**
 * A Bot's character on the wire: `{version:1, shape, color}`. Contract revision 26 retired
 * the `eyes` and `detail` axes; a host may still echo them, so decoding accepts and drops
 * them, and encoding never sends them.
 */
@Serializable(with = AidenBotAvatarRecipeSerializer::class)
data class AidenBotAvatarRecipe(
    val version: Int = 1,
    val shape: AidenBotAvatarShape,
    val color: AidenBotAvatarColor
) {
    init {
        if (version != 1) throw AidenBotContractException.InvalidField("avatar.version")
    }
}

object AidenBotAvatarRecipeSerializer : KSerializer<AidenBotAvatarRecipe> {
    private val ALLOWED_KEYS = setOf("version", "shape", "color", "eyes", "detail")

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("AidenBotAvatarRecipe") {
        element<Int>("version")
        element("shape", AidenBotAvatarShape.serializer().descriptor)
        element("color", AidenBotAvatarColor.serializer().descriptor)
    }

    override fun serialize(encoder: Encoder, value: AidenBotAvatarRecipe) {
        val jsonEncoder = encoder as? JsonEncoder ?: throw SerializationException("Avatar recipes are JSON only")
        jsonEncoder.encodeJsonElement(buildJsonObject {
            put("version", JsonPrimitive(value.version))
            put("shape", jsonEncoder.json.encodeToJsonElement(AidenBotAvatarShape.serializer(), value.shape))
            put("color", jsonEncoder.json.encodeToJsonElement(AidenBotAvatarColor.serializer(), value.color))
        })
    }

    override fun deserialize(decoder: Decoder): AidenBotAvatarRecipe {
        val jsonDecoder = decoder as? JsonDecoder ?: throw SerializationException("Avatar recipes are JSON only")
        val obj = jsonDecoder.decodeJsonElement() as? JsonObject
            ?: throw AidenBotContractException.InvalidField("avatar")
        if (!ALLOWED_KEYS.containsAll(obj.keys)) throw AidenBotContractException.InvalidField("avatar")
        for (retired in listOf("eyes", "detail")) {
            val value = obj[retired] ?: continue
            if (value !is JsonPrimitive || !value.isString) throw AidenBotContractException.InvalidField("avatar.$retired")
        }
        val version = (obj["version"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
            ?: throw AidenBotContractException.InvalidField("avatar.version")
        val shape = obj["shape"] ?: throw AidenBotContractException.InvalidField("avatar.shape")
        val color = obj["color"] ?: throw AidenBotContractException.InvalidField("avatar.color")
        return AidenBotAvatarRecipe(
            version = version,
            shape = jsonDecoder.json.decodeFromJsonElement(AidenBotAvatarShape.serializer(), shape),
            color = jsonDecoder.json.decodeFromJsonElement(AidenBotAvatarColor.serializer(), color)
        )
    }
}

/**
 * A Bot's semantic avatar. Since contract revision 26 it is always the
 * `{version:1, shape, color}` recipe; the retired legacy string ids are rejected.
 */
@Serializable(with = AidenBotSemanticAvatarSerializer::class)
sealed class AidenBotSemanticAvatar {
    data class Recipe(val recipe: AidenBotAvatarRecipe) : AidenBotSemanticAvatar()
}

object AidenBotSemanticAvatarSerializer : KSerializer<AidenBotSemanticAvatar> {
    override val descriptor: SerialDescriptor = AidenBotAvatarRecipe.serializer().descriptor

    override fun serialize(encoder: Encoder, value: AidenBotSemanticAvatar) {
        when (value) {
            is AidenBotSemanticAvatar.Recipe -> encoder.encodeSerializableValue(AidenBotAvatarRecipe.serializer(), value.recipe)
        }
    }

    override fun deserialize(decoder: Decoder): AidenBotSemanticAvatar =
        AidenBotSemanticAvatar.Recipe(decoder.decodeSerializableValue(AidenBotAvatarRecipe.serializer()))
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
    @SerialName("unavailable") UNAVAILABLE
}

/** Durable Bot session state (contract revision 26, `bot-durable-session-v1`). */
@Serializable
enum class AidenBotSessionState {
    @SerialName("idle") IDLE,
    @SerialName("running") RUNNING,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("needs_model") NEEDS_MODEL,
    @SerialName("unavailable") UNAVAILABLE
}

@Serializable
data class AidenBotSummary(
    val id: String,
    val name: String,
    val purpose: String,
    val avatar: AidenBotAvatarView,
    val health: AidenBotHealth,
    /** Present when the host advertises `bot-durable-session-v1`. */
    val sessionState: AidenBotSessionState? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String
) {
    init {
        AidenBotWire.validateIdentifier(id, "id", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(name, "name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(purpose, "purpose", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        if (updatedAt.isBefore(createdAt)) {
            throw AidenBotContractException.InvalidCombination("bot timestamps")
        }
    }
}

@Serializable
data class AidenBotList(
    val bots: List<AidenBotSummary>,
    val maxBots: Int = AidenBotWire.MAX_BOTS
) {
    init {
        val allIds = bots.map { it.id }.toSet()
        if (bots.size > AidenBotWire.MAX_BOTS || maxBots != AidenBotWire.MAX_BOTS || bots.size > maxBots ||
            allIds.size != bots.size
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
    /** Present when the host advertises `bot-durable-session-v1`. */
    val sessionState: AidenBotSessionState? = null,
    val access: AidenBotAccessView,
    val modelSelection: AidenBotModelSelection? = null,
    val visionModelSelection: AidenBotModelSelection? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant,
    val revision: String
) {
    init {
        AidenBotWire.validateIdentifier(id, "id", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotWire.validateString(name, "name", AidenBotWire.MAX_NAME_LENGTH)
        AidenBotWire.validateString(purpose, "purpose", AidenBotWire.MAX_PURPOSE_LENGTH, allowEmpty = true)
        openingGreeting?.let { AidenBotWire.validateString(it, "openingGreeting", AidenBotWire.MAX_GREETING_LENGTH, allowEmpty = true) }
        AidenBotWire.validateString(instructions, "instructions", AidenBotWire.MAX_INSTRUCTIONS_LENGTH)
        AidenBotWire.validateString(revision, "revision", AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH)
        if (access.botId != id) {
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
    /** Optional since revision 26: omitted means Full access. */
    val access: AidenBotAccessUpdate? = null
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
    val available: Boolean,
    val supportsImages: Boolean? = null
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

object AidenBotSkillsEnabledSerializer : KSerializer<Boolean> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("AidenBotSkillsEnabled", PrimitiveKind.BOOLEAN)

    override fun deserialize(decoder: Decoder): Boolean {
        if (decoder !is JsonDecoder) return decoder.decodeBoolean()
        val value = decoder.decodeJsonElement() as? JsonPrimitive
        if (value == null || value.isString) {
            throw AidenBotContractException.InvalidField("skillsEnabled")
        }
        return value.booleanOrNull ?: throw AidenBotContractException.InvalidField("skillsEnabled")
    }

    override fun serialize(encoder: Encoder, value: Boolean) = encoder.encodeBoolean(value)
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
    @Serializable(with = AidenBotSkillsEnabledSerializer::class)
    val skillsEnabled: Boolean = true
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
        // Disabled catalogs expose only authenticated saved skill choices; new choices stay disabled.
        val availableSkills = skills.filter { it.available || !skillsEnabled }.map { it.id }.toSet()
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

sealed class AidenBotDeepLinkResolution {
    /** Open this Bot's canonical conversation. */
    data class OpenChat(val chatId: String) : AidenBotDeepLinkResolution()
    /** The Bot has no conversation yet; land on the Bot without creating one. */
    object ShowBot : AidenBotDeepLinkResolution()
}

/**
 * Chooses the chat an `aiden-otg://bot/{id}/chat` link opens. Items owned by another Bot are
 * ignored, and duplicates use the same canonical rule as Bots Home so a link and a tap agree.
 */
fun aidenResolvedBotDeepLink(
    botId: String,
    conversations: List<AidenBotConversationItem>
): AidenBotDeepLinkResolution {
    val chat = aidenCanonicalBotConversations(conversations.filter { it.botId == botId }).firstOrNull()
        ?: return AidenBotDeepLinkResolution.ShowBot
    return AidenBotDeepLinkResolution.OpenChat(chat.chatId)
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
