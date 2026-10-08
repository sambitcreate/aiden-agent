package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

/**
 * Simulator sharing (Aiden Remote contract revision 25, `mobile-simulators-v1`).
 *
 * Platform, kind and host status are open vocabularies: a value this version
 * does not know is kept as-is and treated conservatively, so a newer Mac never
 * breaks the whole listing. Device ids are strict because they become path and
 * query segments of hub relay URLs.
 */
object AidenSimulators {
    val DEVICE_ID_PATTERN = Regex("^[A-Za-z0-9-]{1,128}$")

    fun isValidDeviceId(id: String): Boolean = DEVICE_ID_PATTERN.matches(id)
}

@Serializable(with = AidenSimulatorPlatformSerializer::class)
data class AidenSimulatorPlatform(val rawValue: String) {
    /** Only iOS simulators stream MJPEG the phone can show; others open on the Mac. */
    val isViewableOnPhone: Boolean get() = this == IOS

    companion object {
        val IOS = AidenSimulatorPlatform("ios")
        val ANDROID = AidenSimulatorPlatform("android")
    }
}

object AidenSimulatorPlatformSerializer : KSerializer<AidenSimulatorPlatform> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("AidenSimulatorPlatform", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenSimulatorPlatform) = encoder.encodeString(value.rawValue)
    override fun deserialize(decoder: Decoder) = AidenSimulatorPlatform(decoder.decodeString())
}

@Serializable(with = AidenSimulatorKindSerializer::class)
data class AidenSimulatorKind(val rawValue: String) {
    companion object {
        val IPHONE = AidenSimulatorKind("iphone")
        val IPAD = AidenSimulatorKind("ipad")
        val OTHER = AidenSimulatorKind("other")
    }
}

object AidenSimulatorKindSerializer : KSerializer<AidenSimulatorKind> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("AidenSimulatorKind", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenSimulatorKind) = encoder.encodeString(value.rawValue)
    override fun deserialize(decoder: Decoder) = AidenSimulatorKind(decoder.decodeString())
}

/** The Mac's simulator hub state. Unknown values read as [UNAVAILABLE]. */
@Serializable(with = AidenSimulatorHostStatusSerializer::class)
data class AidenSimulatorHostStatus(val rawValue: String) {
    val effective: AidenSimulatorHostStatus get() = if (this in KNOWN) this else UNAVAILABLE

    /** The host failed or stopped; the viewer offers Retry, which refetches the listing. */
    val offersRetry: Boolean get() = effective == ERROR || effective == STOPPED

    companion object {
        val DISABLED = AidenSimulatorHostStatus("disabled")
        val NEEDS_CONSENT = AidenSimulatorHostStatus("needs-consent")
        val INSTALLING = AidenSimulatorHostStatus("installing")
        val STARTING = AidenSimulatorHostStatus("starting")
        val READY = AidenSimulatorHostStatus("ready")
        val STOPPED = AidenSimulatorHostStatus("stopped")
        val UNAVAILABLE = AidenSimulatorHostStatus("unavailable")
        val ERROR = AidenSimulatorHostStatus("error")

        val KNOWN = setOf(DISABLED, NEEDS_CONSENT, INSTALLING, STARTING, READY, STOPPED, UNAVAILABLE, ERROR)
    }
}

object AidenSimulatorHostStatusSerializer : KSerializer<AidenSimulatorHostStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("AidenSimulatorHostStatus", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenSimulatorHostStatus) = encoder.encodeString(value.rawValue)
    override fun deserialize(decoder: Decoder) = AidenSimulatorHostStatus(decoder.decodeString())
}

@Serializable
data class AidenSimulatorDevice(
    val id: String,
    val name: String,
    val platform: AidenSimulatorPlatform,
    val version: String,
    val booted: Boolean,
    val kind: AidenSimulatorKind
) {
    init {
        if (!AidenSimulators.isValidDeviceId(id)) {
            throw AidenRemoteContractException.InvalidJson("Invalid simulator device id")
        }
    }

    val isViewableOnPhone: Boolean get() = platform.isViewableOnPhone
}

@Serializable
data class AidenSimulatorToolVersions(
    val hub: String? = null,
    val agent: String? = null
)

@Serializable
data class AidenSimulatorListing(
    val sharing: Boolean,
    val status: AidenSimulatorHostStatus,
    val detail: String? = null,
    val devices: List<AidenSimulatorDevice>,
    /** Present only on `GET /simulators?chatId=`: devices the desktop attached to that chat. */
    val chatDeviceIds: List<String>? = null,
    val toolVersions: AidenSimulatorToolVersions? = null
) {
    init {
        if (chatDeviceIds != null && chatDeviceIds.any { !AidenSimulators.isValidDeviceId(it) }) {
            throw AidenRemoteContractException.InvalidJson("Invalid simulator chat device id")
        }
    }

    /**
     * The chat's devices in the order the desktop attached them. Sharing off
     * hides every device, and ids the listing does not describe are skipped.
     */
    val chatDevices: List<AidenSimulatorDevice>
        get() {
            if (!sharing) return emptyList()
            val byId = devices.associateBy { it.id }
            return chatDeviceIds.orEmpty().distinct().mapNotNull { byId[it] }
        }
}

@Serializable
data class AidenSimulatorOpenResponse(val device: AidenSimulatorDevice)

@Serializable
data class AidenSimulatorShutdownResponse(val ok: Boolean)

@Serializable
data class AidenSimulatorDeviceRequest(val deviceId: String)
