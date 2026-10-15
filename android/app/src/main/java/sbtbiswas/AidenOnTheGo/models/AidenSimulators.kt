package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

/**
 * Simulator sharing (Aiden Remote contract revision 26, `mobile-simulators-v1`).
 *
 * Platform, kind and host status are open vocabularies: a value this version
 * does not know is kept as-is and treated conservatively, so a newer Mac never
 * breaks the whole listing. Device ids are strict because they become path and
 * query segments of hub relay URLs.
 */
object AidenSimulators {
    /**
     * The desktop's `DEVICE_ID_PATTERN`: a simulator UDID, an adb serial
     * (`emulator-5554`) or a stopped AVD's name (`Pixel_9_API_35`). The first
     * character is alphanumeric, so an id is never a dot segment or a flag.
     */
    val DEVICE_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

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
    /** Devices this version cannot use (bad id, missing field, a repeat) are skipped. */
    @Serializable(with = AidenSimulatorDeviceListSerializer::class)
    val devices: List<AidenSimulatorDevice>,
    /**
     * Present only on `GET /simulators?chatId=`: devices the desktop attached to
     * that chat. Read through [chatDevices], which drops ids that are not listed.
     */
    val chatDeviceIds: List<String>? = null,
    val toolVersions: AidenSimulatorToolVersions? = null
) {

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

/**
 * Decodes `devices` one entry at a time and skips any entry that is not a
 * usable device, so one odd device never fails the whole listing.
 */
object AidenSimulatorDeviceListSerializer : KSerializer<List<AidenSimulatorDevice>> {
    private val delegate = ListSerializer(AidenSimulatorDevice.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor
    override fun serialize(encoder: Encoder, value: List<AidenSimulatorDevice>) = delegate.serialize(encoder, value)
    override fun deserialize(decoder: Decoder): List<AidenSimulatorDevice> {
        val json = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        val seen = HashSet<String>()
        return json.decodeJsonElement().jsonArray.mapNotNull { entry ->
            runCatching { json.json.decodeFromJsonElement(AidenSimulatorDevice.serializer(), entry) }
                .getOrNull()
                ?.takeIf { seen.add(it.id) }
        }
    }
}

@Serializable
data class AidenSimulatorOpenResponse(val device: AidenSimulatorDevice)

@Serializable
data class AidenSimulatorShutdownResponse(val ok: Boolean)

@Serializable
data class AidenSimulatorDeviceRequest(val deviceId: String)
