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

    /**
     * Wire value transmitted during /pairing/exchange.
     * Note: The current Mac desktop server (aiden-remote-pairing.ts / aiden-remote-state.ts / openapi.json)
     * strictly validates `deviceType: "iphone" | "ipad"`.
     * To maintain 100% wire compatibility with the existing Mac server without requiring immediate Mac-side changes,
     * ANDROID_PHONE maps to "iphone" and ANDROID_TABLET maps to "ipad" on the wire.
     * 
     * TODO(future): When the Mac backend expands `AidenRemoteDeviceType` to include "android_phone" / "android_tablet",
     * update this mapping to return `name.lowercase()`.
     */
    val wireValue: String
        get() = when (this) {
            IPHONE, ANDROID_PHONE -> "iphone"
            IPAD, ANDROID_TABLET -> "ipad"
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
    val deviceName: String? = null,
    val connectionMode: AidenConnectionMode = AidenConnectionMode.LAN,
    val minimumClientVersion: String? = null,
    @Serializable(with = InstantIso8601Serializer::class) val serverTime: Instant = Instant.now()
) {
    init {
        if (instanceId.isEmpty() || instanceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH ||
            capabilities.toSet().size != capabilities.size ||
            (capabilities.contains(AidenRemoteCapability.BOT_WRITE) && !capabilities.contains(AidenRemoteCapability.BOT_READ)) ||
            (serverCapabilities != null && (serverCapabilities.toSet().size != serverCapabilities.size || !serverCapabilities.containsAll(capabilities)))
        ) {
            throw AidenRemoteContractException.InvalidJson("Invalid Server model")
        }
        if (deviceName != null && (deviceName.isEmpty() || deviceName.length > 80 || deviceName.any { Character.isISOControl(it) })) {
            throw AidenRemoteContractException.InvalidJson("Invalid deviceName in Server model")
        }
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
    @Serializable(with = InstantIso8601Serializer::class) var lastConnectedAt: Instant? = null
) {
    val id: String get() = instanceId

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
