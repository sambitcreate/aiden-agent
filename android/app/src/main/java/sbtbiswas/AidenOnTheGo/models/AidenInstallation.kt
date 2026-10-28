package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant

@Serializable
enum class AidenConnectionMode {
    @SerialName("lan") LAN,
    @SerialName("tailscale") TAILSCALE,
    @SerialName("both") BOTH
}

@Serializable
enum class AidenDeviceType {
    @SerialName("iphone") IPHONE,
    @SerialName("ipad") IPAD,
    @SerialName("android_phone") ANDROID_PHONE,
    @SerialName("android_tablet") ANDROID_TABLET;

    /** Android identity requires a desktop that supports Android pairing. */
    val wireValue: String
        get() = when (this) {
            IPHONE -> "iphone"
            IPAD -> "ipad"
            ANDROID_PHONE, ANDROID_TABLET -> "android"
        }
}

@Serializable
data class AidenServer(
    val protocolVersion: Int = AidenRemoteProtocol.VERSION,
    val instanceId: String,
    val name: String,
    val appVersion: String = "1.0.0",
    val capabilities: List<AidenRemoteCapability>,
    val serverCapabilities: List<AidenRemoteCapability>? = null,
    val features: List<String> = emptyList(),
    val deviceName: String? = null,
    val connectionMode: AidenConnectionMode = AidenConnectionMode.LAN,
    val minimumClientVersion: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val serverTime: Instant = Instant.now()
) {
    init {
        if (instanceId.isEmpty() || instanceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            capabilities.toSet().size != capabilities.size ||
            features.size > 32 ||
            features.toSet().size != features.size ||
            features.any { feature ->
                feature.length !in 1..64 || !FEATURE_TOKEN.matches(feature)
            } ||
            (capabilities.contains(AidenRemoteCapability.BOT_WRITE) && !capabilities.contains(AidenRemoteCapability.BOT_READ)) ||
            (serverCapabilities != null && (serverCapabilities.toSet().size != serverCapabilities.size || !serverCapabilities.containsAll(capabilities)))
        ) {
            throw AidenRemoteContractException.InvalidJson("Invalid Server model")
        }
        if (deviceName != null && (deviceName.isEmpty() || deviceName.length > 80 || deviceName.any { Character.isISOControl(it) })) {
            throw AidenRemoteContractException.InvalidJson("Invalid deviceName in Server model")
        }
    }

    val supportsChatSummaries: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_SUMMARIES_FEATURE)

    /** Revision 25: each Bot has one durable session addressed by Bot id. */
    val supportsBotDurableSession: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_DURABLE_SESSION_FEATURE)

    val supportsBotRoutines: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_ROUTINES_FEATURE)

    val supportsBotConnectionRequests: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_CONNECTION_REQUESTS_FEATURE)

    val supportsBotPresets: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_PRESETS_FEATURE)

    val supportsChatTasks: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_TASKS_FEATURE)

    val supportsChatAgents: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_AGENTS_FEATURE)

    val supportsChatRunInput: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_RUN_INPUT_FEATURE)

    val supportsQuestionPrompts: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_QUESTION_PROMPTS_FEATURE)

    val supportsChatSkills: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_SKILLS_FEATURE)

    /** The Mac renders conversation app control panels natively (revision 32). */
    val supportsChatUiPanels: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_UI_PANELS_FEATURE)

    /** The Mac can stop one running delegated agent; only meaningful with chat-agents-v1. */
    val supportsChatAgentInterrupt: Boolean
        get() = supportsChatAgents && features.contains(AidenRemoteProtocol.CHAT_AGENT_INTERRUPT_FEATURE)

    /** Row states, unread markers, and `POST /chats/{id}/read` (revision 18). */
    val supportsChatReadState: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_READ_STATE_FEATURE)

    /**
     * `GET /chats/{chatId}/messages` pages that also carry the chat's metadata
     * (revisions 19 and 23). A revision-19 to 22 page has no title or model, so
     * refreshing from it would leave a desktop rename or model change unseen;
     * without both tokens the client keeps reading whole chats.
     */
    val supportsChatMessagesWindow: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_MESSAGES_WINDOW_FEATURE) &&
            features.contains(AidenRemoteProtocol.CHAT_MESSAGES_WINDOW_METADATA_FEATURE)

    /** `POST /chats/{id}/fork` (revision 21). */
    val supportsChatFork: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_FORK_FEATURE)

    /** Fork summaries and their retry, skip and cancel actions; only meaningful with chat-fork-v1. */
    val supportsChatForkSummary: Boolean
        get() = supportsChatFork && features.contains(AidenRemoteProtocol.CHAT_FORK_SUMMARY_FEATURE)

    /** The Mac offers the phone-scoped `runs:observe` / `runs:control` subset. */
    val supportsPhoneRunControl: Boolean
        get() = features.contains(AidenRemoteProtocol.PHONE_RUN_CONTROL_FEATURE)

    /** The Mac offers the phone-scoped `simulators:mobile` grant (revision 26). */
    val supportsMobileSimulators: Boolean
        get() = features.contains(AidenRemoteProtocol.MOBILE_SIMULATORS_FEATURE)

    /** A Bot's memory can be read and edited from this phone (revision 27). */
    val supportsBotMemory: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_MEMORY_FEATURE)

    /** Routine proposals, the daily check-in suggestion and the routine notification feed (revision 27). */
    val supportsBotProactive: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_PROACTIVE_FEATURE)

    /** Only a Mac that can send memory or proposal cards is asked for `bot:cards`. */
    val offersBotCards: Boolean
        get() = supportsBotMemory || supportsBotProactive

    /**
     * The Mac offers `bot:activity` (revision 30) in its capability list, so this phone asks for
     * it (FR-m3: the same rule as iOS). A Mac offers it only while it announces `bot-activity-v1`.
     */
    val offersBotActivity: Boolean
        get() = serverCapabilities?.contains(AidenRemoteCapability.BOT_ACTIVITY) == true

    /** Announced and held: show the status line, Steer and Queue, Queued bubbles and Chat activity. */
    val supportsBotActivity: Boolean
        get() = features.contains(AidenRemoteProtocol.BOT_ACTIVITY_FEATURE) && capabilities.contains(AidenRemoteCapability.BOT_ACTIVITY)

    /**
     * The Mac offers `bot:handoffs` (revision 37). There is no `/server` feature token: the
     * offer in `serverCapabilities` is the whole signal, and this phone asks for it in a call of
     * its own, so a Mac that refuses the name can't take another grant down with it.
     */
    val offersBotHandoffs: Boolean
        get() = serverCapabilities?.contains(AidenRemoteCapability.BOT_HANDOFFS) == true

    /** The Mac offers `bot:handoff-notes` (revision 40). Only a Mac serving hand-offs offers it. */
    val offersBotHandoffNotes: Boolean
        get() = offersBotHandoffs && serverCapabilities?.contains(AidenRemoteCapability.BOT_HANDOFF_NOTES) == true

    /** Offered and held: show hand-off cards, the paused state, and Pause and Resume. */
    val supportsBotHandoffs: Boolean
        get() = offersBotHandoffs && capabilities.contains(AidenRemoteCapability.BOT_HANDOFFS)

    /**
     * The Mac offers `schedule:cards` (revision 39). Like `bot:handoffs`, the offer
     * in `serverCapabilities` is the whole signal, and this phone asks for it in a call of its own.
     */
    val offersScheduleCards: Boolean
        get() = serverCapabilities?.contains(AidenRemoteCapability.SCHEDULE_CARDS) == true

    /**
     * Offered and held: scheduled-task approvals may carry a `schedule` card. Informational
     * only; the card renders whenever an approval carries a valid one.
     */
    val supportsScheduleCards: Boolean
        get() = offersScheduleCards && capabilities.contains(AidenRemoteCapability.SCHEDULE_CARDS)

    /**
     * The Mac offers `bot:images` (revision 44). Like `schedule:cards`, the offer in
     * `serverCapabilities` is the whole signal, and this phone asks for it in a call of its own.
     */
    val offersBotImages: Boolean
        get() = serverCapabilities?.contains(AidenRemoteCapability.BOT_IMAGES) == true

    /** Offered and held: a Bot's chat shows the images it shared instead of a line about them. */
    val supportsBotImages: Boolean
        get() = offersBotImages && capabilities.contains(AidenRemoteCapability.BOT_IMAGES)

    /**
     * The Mac offers `bot:issues` (revision 42). There is no `/server` feature token: the offer
     * in `serverCapabilities` is the whole signal, and this phone asks for it in a call of its own.
     */
    val offersBotIssues: Boolean
        get() = serverCapabilities?.contains(AidenRemoteCapability.BOT_ISSUES) == true

    /** Offered and held: show the Bot's "Needs you" cards and their actions. */
    val supportsBotIssues: Boolean
        get() = offersBotIssues && capabilities.contains(AidenRemoteCapability.BOT_ISSUES)

    /**
     * Chat messages may carry inline `visuals` (revision 28). Informational:
     * the transcript renders whatever visuals a message carries.
     */
    val supportsChatVisuals: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_VISUALS_FEATURE)

    /** A tapped visual snapshot opens the Mac's interactive viewer document (revision 35). */
    val supportsChatVisualViewer: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_VISUAL_VIEWER_FEATURE)

    /** A browser recording's Play reads the video from the Mac (revision 45). */
    val supportsBrowserRecordings: Boolean
        get() = features.contains(AidenRemoteProtocol.CHAT_BROWSER_RECORDINGS_FEATURE)

    companion object {
        private val FEATURE_TOKEN = Regex("^[a-z0-9][a-z0-9-]{0,63}$")
    }
}

@Serializable
data class AidenPairingBootstrap(
    val protocolVersion: Int = AidenRemoteProtocol.VERSION,
    val instanceId: String,
    val endpoint: String,
    val serverSpkiSha256: String,
    val secret: String,
    @Serializable(with = InstantIso8601Serializer::class) val expiresAt: Instant
) {
    fun validated(at: Instant = Instant.now()): AidenPairingBootstrap {
        if (protocolVersion != AidenRemoteProtocol.VERSION) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.UnsupportedProtocol
        if (instanceId.isEmpty() || instanceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.InvalidInstance
        if (!AidenRemoteProtocol.isCanonicalAidenEndpoint(endpoint)) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.InvalidEndpoint
        if (!serverSpkiSha256.startsWith("sha256/") || serverSpkiSha256.length != 51) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.InvalidFingerprint
        if (secret.length < 32) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.WeakSecret
        if (!expiresAt.isAfter(at)) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.Expired
        if (java.time.Duration.between(at, expiresAt).seconds > 300) throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException.ExcessiveTTL
        return this
    }

    fun isValidAt(now: Instant): Boolean = try {
        validated(now)
        true
    } catch (_: Exception) {
        false
    }
}

@Serializable
data class AidenPairingTrust(
    val mode: String,
    @SerialName("caCertificateDerBase64") val caCertificateDerBase64: String? = null
) {
    val caCertificateDER: String? get() = caCertificateDerBase64
}

@Serializable
data class AidenPairingPayload(
    val kind: String = "aiden-pairing-v1",
    val bootstrap: AidenPairingBootstrap,
    val trust: AidenPairingTrust
) {
    fun validated(at: Instant = Instant.now()): AidenPairingPayload {
        if (kind != "aiden-pairing-v1") throw sbtbiswas.AidenOnTheGo.protocol.AidenPairingPayloadException.InvalidKind
        bootstrap.validated(at)
        return this
    }

    fun isValidAt(now: Instant): Boolean = try {
        validated(now)
        true
    } catch (_: Exception) {
        false
    }
}

@Serializable
data class AidenManualPairingBootstrap(
    val kind: String = "aiden-manual-pairing-v1",
    val protocolVersion: Int = AidenRemoteProtocol.VERSION,
    val sessionId: String,
    @Serializable(with = InstantIso8601Serializer::class) val expiresAt: Instant,
    val salt: String,
    val nonce: String,
    val ciphertext: String,
    val tag: String
)

@Serializable
data class AidenManualPairingResponse(
    val code: String,
    val payload: String,
    val bootstrap: AidenManualPairingBootstrap
)

@Serializable
data class AidenPairingExchange(
    val protocolVersion: Int = AidenRemoteProtocol.VERSION,
    val instanceId: String,
    val deviceId: String,
    val credential: String,
    val capabilities: List<AidenRemoteCapability>,
    val endpoint: String,
    val serverSpkiSha256: String,
    val displayName: String? = null
)

@Serializable
data class AidenInstallation(
    val instanceId: String,
    val deviceId: String,
    var name: String,
    val endpoint: String,
    val serverSpkiSha256: String,
    val pairingTrust: AidenPairingTrust? = null,
    val credentialScope: String = makeCredentialScope(instanceId, deviceId),
    var deviceCapabilities: List<AidenRemoteCapability>,
    var serverCapabilities: List<AidenRemoteCapability>? = null,
    @Serializable(with = InstantIso8601Serializer::class) val createdAt: Instant,
    @Serializable(with = InstantIso8601Serializer::class) var lastConnectedAt: Instant? = null,
    /**
     * The feature tokens the Mac's `/server` last announced to this pairing, or null before it
     * first answered. With the persisted grants they stand in for `/server` while it is still on
     * its way (R21), so a cold offline start keeps what this pairing could do.
     */
    val serverFeatures: List<String>? = null
) {
    val id: String get() = instanceId

    /** The Mac last announced `bot-activity-v1` and this pairing holds `bot:activity` (R21). */
    val cachedBotActivitySupported: Boolean
        get() = serverFeatures?.contains(AidenRemoteProtocol.BOT_ACTIVITY_FEATURE) == true &&
            hasNegotiatedAccess(AidenRemoteCapability.BOT_ACTIVITY)

    val isBotsEligible: Boolean
        get() = hasNegotiatedAccess(AidenRemoteCapability.BOT_READ)

    val canWriteBots: Boolean
        get() = isBotsEligible && hasNegotiatedAccess(AidenRemoteCapability.BOT_WRITE)

    fun hasNegotiatedAccess(capability: AidenRemoteCapability): Boolean {
        return deviceCapabilities.contains(capability) &&
                serverCapabilities?.contains(capability) == true
    }

    init {
        if (instanceId.isEmpty() || instanceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            deviceId.isEmpty() || deviceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            deviceCapabilities.toSet().size != deviceCapabilities.size ||
            (deviceCapabilities.contains(AidenRemoteCapability.BOT_WRITE) && !deviceCapabilities.contains(AidenRemoteCapability.BOT_READ)) ||
            (serverCapabilities != null && (serverCapabilities!!.toSet().size != serverCapabilities!!.size || !serverCapabilities!!.containsAll(deviceCapabilities)))
        ) {
            throw AidenRemoteContractException.InvalidJson("Invalid Installation model")
        }
    }

    companion object {
        fun makeCredentialScope(instanceId: String, deviceId: String): String = "$instanceId:$deviceId"
    }
}
