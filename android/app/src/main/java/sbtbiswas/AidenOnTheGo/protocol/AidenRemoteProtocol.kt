package sbtbiswas.AidenOnTheGo.protocol

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import java.time.Instant
import java.time.format.DateTimeFormatter

object AidenRemoteProtocol {
    const val VERSION = 1
    const val BASE_PATH = "/api/aiden/v1"
    const val MAX_IDENTIFIER_LENGTH = 128
    const val MAX_BOT_IDENTIFIER_LENGTH = 160
    const val MAX_ENDPOINT_LENGTH = 2_048
    const val MAX_ENDPOINT_PORT = 65_535
    const val MAX_EVENT_TYPE_LENGTH = 80
    const val MAX_EVENT_PAYLOAD_PROPERTIES = 32
    const val MAX_EVENT_ENVELOPE_PROPERTIES = 16_384
    const val MAX_JSON_TOTAL_OBJECT_KEYS = 16_384
    const val MAX_TEXT_LENGTH = 200_000
    const val MAX_TOOL_NAME_LENGTH = 120
    const val MAX_TIMELINE_LABEL_LENGTH = 500
    const val MAX_APPROVAL_SUMMARY_LENGTH = 2_000
    const val MAX_ERROR_MESSAGE_LENGTH = 2_000
    const val MAX_JSON_BODY_BYTES = 1_048_576
    const val MAX_FILE_JSON_BODY_BYTES = 6 * 1_048_576
    const val MAX_SSE_FRAME_BYTES = MAX_JSON_BODY_BYTES
    const val MAX_PAIRING_PAYLOAD_BYTES = 4_096
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    const val MAX_JSON_NESTING_DEPTH = 128

    val FORBIDDEN_WIRE_KEYS = setOf(
        "authorization", "credentialDigest", "providerFingerprint", "mcpServerBindings",
        "folderPath", "repositoryPath", "worktreePath", "worktreeGitDir",
        "ownershipToken", "worktreeDevice", "worktreeInode", "createdFromHead",
        "canonicalPath", "absolutePath", "scriptPath", "environment", "stdout", "stderr",
        "managedHomePath", "managedWorkspacePath", "workspacePath", "botHomePath",
        "systemPrompt", "skillContent", "skillContents", "skillPath", "skillPaths",
        "providerCredential", "mcpCredential", "connectionCredential",
        "authorizationHeader", "providerHeaders", "mcpHeaders", "connectionHeaders",
        "providerApiKey", "mcpApiKey", "connectionApiKey", "credentialMaterial",
        "assetFilename", "avatarAssetFilename", "temporaryAssetURL", "temporaryURL"
    )

    fun isCanonicalAidenEndpoint(rawEndpoint: String): Boolean {
        if (rawEndpoint.toByteArray(Charsets.UTF_8).size > MAX_ENDPOINT_LENGTH ||
            !rawEndpoint.startsWith("https://") ||
            !rawEndpoint.endsWith(BASE_PATH)
        ) {
            return false
        }
        val authority = rawEndpoint.removePrefix("https://").removeSuffix(BASE_PATH)
        if (authority.isEmpty()) return false
        return isCanonicalAidenAuthority(authority)
    }

    private fun isCanonicalAidenAuthority(value: String): Boolean {
        if (!value.all { it.code in 0x21..0x7E && it.code != 0x7F }) return false

        val host: String
        val rawPort: String?
        if (value.startsWith("[")) {
            val closingBracket = value.indexOf("]")
            if (closingBracket <= 1) return false
            val hostContent = value.substring(1, closingBracket)
            val suffix = value.substring(closingBracket + 1)
            if (hostContent.contains("[") || suffix.contains("]")) return false
            host = hostContent
            if (suffix.isEmpty()) {
                rawPort = null
            } else {
                if (!suffix.startsWith(":")) return false
                rawPort = suffix.removePrefix(":")
            }
            if (!isCanonicalAidenIPv6(host)) return false
        } else {
            if (value.contains("[") || value.contains("]")) return false
            val colon = value.indexOf(":")
            if (colon != -1) {
                if (colon != value.lastIndexOf(":")) return false
                host = value.substring(0, colon)
                rawPort = value.substring(colon + 1)
            } else {
                host = value
                rawPort = null
            }
            if (!isCanonicalAidenDNSHost(host) && !isCanonicalAidenIPv4(host)) return false
        }

        return if (rawPort != null) isCanonicalAidenPort(rawPort) else true
    }

    private fun isCanonicalAidenPort(value: String): Boolean {
        if (value.isEmpty() || value.length > 5 || value.startsWith("0")) return false
        val port = value.toIntOrNull() ?: return false
        return port in 1..MAX_ENDPOINT_PORT
    }

    private fun isCanonicalAidenDNSHost(value: String): Boolean {
        if (value.isEmpty() || value.length > 253) return false
        val labels = value.split(".")
        if (labels.any { it.isEmpty() }) return false
        if (labels.all { label -> label.all { it.isDigit() } }) {
            return isCanonicalAidenIPv4(value)
        }
        if (labels.last().all { it.isDigit() }) return false
        return labels.all { isCanonicalAidenDNSLabel(it) }
    }

    private fun isCanonicalAidenDNSLabel(label: String): Boolean {
        if (label.isEmpty() || label.length > 63) return false
        val first = label.first()
        val last = label.last()
        if (!first.isLetterOrDigit() || !last.isLetterOrDigit()) return false
        return label.all { it.isLetterOrDigit() || it == '-' }
    }

    private fun isCanonicalAidenIPv4(value: String): Boolean {
        val parts = value.split(".")
        if (parts.size != 4) return false
        return parts.all { part ->
            if (part.isEmpty() || part.length > 3 || !part.all { it.isDigit() }) return false
            if (part.length > 1 && part.startsWith("0")) return false
            val num = part.toIntOrNull() ?: return false
            num in 0..255
        }
    }

    private fun parseAidenIPv6Side(value: String): Int? {
        if (value.isEmpty()) return 0
        val groups = value.split(":")
        if (groups.any { it.isEmpty() }) return null
        var count = 0
        for ((index, group) in groups.withIndex()) {
            if (group.contains(".")) {
                if (index != groups.size - 1 || !isCanonicalAidenIPv4(group)) return null
                count += 2
            } else {
                if (group.length !in 1..4 || !group.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
                    return null
                }
                count += 1
            }
        }
        return count
    }

    private fun isCanonicalAidenIPv6(value: String): Boolean {
        if (value.isEmpty() || !value.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == '.' || it == ':' }) {
            return false
        }
        val sides = value.split("::")
        if (sides.size > 2) return false
        if (sides.size == 2) {
            if (sides[0].contains(".")) return false
            val left = parseAidenIPv6Side(sides[0]) ?: return false
            val right = parseAidenIPv6Side(sides[1]) ?: return false
            return left + right < 8
        }
        return parseAidenIPv6Side(value) == 8
    }
}

sealed class AidenBotPrivateResponseScope {
    data class Root(val root: String) : AidenBotPrivateResponseScope()
    object BotClassifiedChat : AidenBotPrivateResponseScope()
    object SharedFixture : AidenBotPrivateResponseScope()
}

object AidenBotPrivateResponseValidator {
    private val normalizedPrivateKeys: Set<String> = run {
        val keys = mutableSetOf(
            "credential", "credentials", "secret", "secrets", "apikey", "token",
            "accesstoken", "refreshtoken", "header", "headers", "endpoint", "path",
            "prompt", "instructions", "openinggreeting", "argument", "arguments", "args",
            "toolargument", "toolarguments", "toolargs", "result", "results", "toolresult",
            "toolresults", "reasoning", "reasoningcontent"
        )
        keys.addAll(AidenRemoteProtocol.FORBIDDEN_WIRE_KEYS.map { normalize(it) })
        keys
    }

    private val fixtureBotRoots: Set<String> = setOf(
        "chat", "botSummary", "botList", "botDetail", "botAvatar", "botCreate",
        "botIdentity", "botArchive", "botRestore", "botConversation", "botConversations",
        "botConversationQuery", "botChatCreate", "botCapabilityCatalog", "botPolicy",
        "botPolicyUpdate", "botChatSubset", "botChatSubsetUpdate", "botFavorites",
        "botFavoritesUpdate", "botNotice", "botNoticeAcknowledgement", "botAvatarUpload",
        "botAvatarMetadata"
    )

    private val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    fun validate(jsonString: String, scope: AidenBotPrivateResponseScope) {
        val element = try {
            json.parseToJsonElement(jsonString)
        } catch (e: Exception) {
            throw AidenRemoteContractException.InvalidJson("Invalid JSON")
        }
        validate(element, scope)
    }

    fun validate(bytes: ByteArray, scope: AidenBotPrivateResponseScope) {
        validate(String(bytes, Charsets.UTF_8), scope)
    }

    fun validate(element: kotlinx.serialization.json.JsonElement, scope: AidenBotPrivateResponseScope) {
        when (scope) {
            is AidenBotPrivateResponseScope.Root -> {
                validateElement(element, root = scope.root, path = emptyList())
            }
            is AidenBotPrivateResponseScope.BotClassifiedChat -> {
                val obj = element as? kotlinx.serialization.json.JsonObject ?: return
                if (obj["botId"] is kotlinx.serialization.json.JsonPrimitive) {
                    validateElement(element, root = "chat", path = emptyList())
                }
            }
            is AidenBotPrivateResponseScope.SharedFixture -> {
                val obj = element as? kotlinx.serialization.json.JsonObject
                    ?: throw AidenRemoteContractException.InvalidJson("Expected JSON object for fixture")
                for (root in fixtureBotRoots) {
                    val botValue = obj[root]
                    if (botValue != null) {
                        validateElement(botValue, root = root, path = emptyList())
                    }
                }
            }
        }
    }

    private fun validateElement(
        element: kotlinx.serialization.json.JsonElement,
        root: String,
        path: List<String>
    ) {
        when (element) {
            is kotlinx.serialization.json.JsonObject -> {
                for ((key, child) in element) {
                    if (normalizedPrivateKeys.contains(normalize(key)) &&
                        !isAllowedKnownIdentityKey(key, root, path)
                    ) {
                        throw AidenRemoteContractException.UnsafePayloadField(key)
                    }
                    validateElement(child, root, path + key)
                }
            }
            is kotlinx.serialization.json.JsonArray -> {
                for (child in element) {
                    validateElement(child, root, path + "[]")
                }
            }
            else -> {}
        }
    }

    fun normalize(key: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < key.length) {
            val codePoint = key.codePointAt(i)
            i += Character.charCount(codePoint)
            when (codePoint) {
                0x2D, 0x2E, 0x5F,
                0x0009, 0x000A, 0x000B, 0x000C, 0x000D, 0x0020, 0x00A0, 0x1680,
                0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
                0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF -> {
                    // ignore
                }
                else -> {
                    sb.append(String(Character.toChars(codePoint)))
                }
            }
        }
        return sb.toString().lowercase(java.util.Locale.US)
    }

    private fun isAllowedKnownIdentityKey(
        key: String,
        root: String,
        parentPath: List<String>
    ): Boolean {
        if (key != "instructions" && key != "openingGreeting") return false
        if (root in listOf("botDetail", "botArchive", "botRestore")) {
            return parentPath.isEmpty()
        }
        if (root in listOf("botCreate", "botIdentity")) {
            return parentPath.size == 1 && (parentPath[0] == "request" || parentPath[0] == "response")
        }
        return false
    }
}

object InstantIso8601Serializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Instant", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Instant) {
        encoder.encodeString(DateTimeFormatter.ISO_INSTANT.format(value))
    }

    override fun deserialize(decoder: Decoder): Instant {
        val string = decoder.decodeString()
        return Instant.parse(string)
    }
}

@Serializable(with = AidenRemoteCapabilitySerializer::class)
data class AidenRemoteCapability(val rawValue: String) {
    companion object {
        val SERVER_READ = AidenRemoteCapability("server:read")
        val CHAT_READ = AidenRemoteCapability("chat:read")
        val CHAT_WRITE = AidenRemoteCapability("chat:write")
        val APPROVAL_RESPOND = AidenRemoteCapability("approval:respond")
        val WORKSPACE_READ = AidenRemoteCapability("workspace:read")
        val WORKSPACE_BROWSE = AidenRemoteCapability("workspace:browse")
        val WORKSPACE_MANAGE = AidenRemoteCapability("workspace:manage")
        val FILES_READ = AidenRemoteCapability("files:read")
        val FILES_WRITE = AidenRemoteCapability("files:write")
        val GIT_READ = AidenRemoteCapability("git:read")
        val GIT_WRITE = AidenRemoteCapability("git:write")
        val SCHEDULE_READ = AidenRemoteCapability("schedule:read")
        val SCHEDULE_WRITE = AidenRemoteCapability("schedule:write")
        val BOT_READ = AidenRemoteCapability("bot:read")
        val BOT_WRITE = AidenRemoteCapability("bot:write")

        val V1_KNOWN = listOf(
            SERVER_READ, CHAT_READ, CHAT_WRITE, APPROVAL_RESPOND,
            WORKSPACE_READ, WORKSPACE_BROWSE, WORKSPACE_MANAGE,
            FILES_READ, FILES_WRITE, GIT_READ, GIT_WRITE,
            SCHEDULE_READ, SCHEDULE_WRITE, BOT_READ, BOT_WRITE
        )
    }
}

object AidenRemoteCapabilitySerializer : KSerializer<AidenRemoteCapability> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("AidenRemoteCapability", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenRemoteCapability) = encoder.encodeString(value.rawValue)
    override fun deserialize(decoder: Decoder): AidenRemoteCapability {
        val raw = decoder.decodeString()
        if (raw.isEmpty() || raw.length > AidenRemoteProtocol.MAX_EVENT_TYPE_LENGTH) {
            throw AidenRemoteContractException.UnsafePayloadField("capability")
        }
        return AidenRemoteCapability(raw)
    }
}

@Serializable(with = AidenRemoteErrorCodeSerializer::class)
data class AidenRemoteErrorCode(val rawValue: String) {
    companion object {
        val INVALID_REQUEST = AidenRemoteErrorCode("invalid_request")
        val PAYLOAD_TOO_LARGE = AidenRemoteErrorCode("payload_too_large")
        val RATE_LIMITED = AidenRemoteErrorCode("rate_limited")
        val AUTHENTICATION_REQUIRED = AidenRemoteErrorCode("authentication_required")
        val CREDENTIAL_REVOKED = AidenRemoteErrorCode("credential_revoked")
        val CAPABILITY_DENIED = AidenRemoteErrorCode("capability_denied")
        val PAIRING_CLOSED = AidenRemoteErrorCode("pairing_closed")
        val PAIRING_EXPIRED = AidenRemoteErrorCode("pairing_expired")
        val PAIRING_ALREADY_USED = AidenRemoteErrorCode("pairing_already_used")
        val SERVER_IDENTITY_CHANGED = AidenRemoteErrorCode("server_identity_changed")
        val NOT_FOUND = AidenRemoteErrorCode("not_found")
        val ALREADY_EXISTS = AidenRemoteErrorCode("already_exists")
        val REVISION_CONFLICT = AidenRemoteErrorCode("revision_conflict")
        val IDEMPOTENCY_CONFLICT = AidenRemoteErrorCode("idempotency_conflict")
        val IDEMPOTENCY_CAPACITY = AidenRemoteErrorCode("idempotency_capacity")
        val IDEMPOTENCY_IN_FLIGHT = AidenRemoteErrorCode("idempotency_in_flight")
        val BOT_ARCHIVED = AidenRemoteErrorCode("bot_archived")
        val WORKSPACE_UNAVAILABLE = AidenRemoteErrorCode("workspace_unavailable")
        val WORKSPACE_CHANGING = AidenRemoteErrorCode("workspace_changing")
        val PERMISSION_CONFIRMATION_REQUIRED = AidenRemoteErrorCode("permission_confirmation_required")
        val HANDLE_INVALID = AidenRemoteErrorCode("handle_invalid")
        val HANDLE_EXPIRED = AidenRemoteErrorCode("handle_expired")
        val HANDLE_WRONG_DEVICE = AidenRemoteErrorCode("handle_wrong_device")
        val ROOT_POLICY_CHANGED = AidenRemoteErrorCode("root_policy_changed")
        val FILESYSTEM_IDENTITY_CHANGED = AidenRemoteErrorCode("filesystem_identity_changed")
        val PATH_OUTSIDE_ROOT = AidenRemoteErrorCode("path_outside_root")
        val HANDLE_CAPACITY = AidenRemoteErrorCode("handle_capacity")
        val TURN_ALREADY_ACTIVE = AidenRemoteErrorCode("turn_already_active")
        val STREAM_GONE = AidenRemoteErrorCode("stream_gone")
        val APPROVAL_ALREADY_RESOLVED = AidenRemoteErrorCode("approval_already_resolved")
        val APPROVAL_EXPIRED = AidenRemoteErrorCode("approval_expired")
        val OPERATION_IN_PROGRESS = AidenRemoteErrorCode("operation_in_progress")
        val OPERATION_STALE = AidenRemoteErrorCode("operation_stale")
        val GIT_CAPABILITY_DENIED = AidenRemoteErrorCode("git_capability_denied")
        val SCHEDULE_DISABLED = AidenRemoteErrorCode("schedule_disabled")
        val SCHEDULE_RUN_IN_PROGRESS = AidenRemoteErrorCode("schedule_run_in_progress")
        val SERVER_INTERRUPTED = AidenRemoteErrorCode("server_interrupted")
        val INTERNAL_ERROR = AidenRemoteErrorCode("internal_error")

        val V1_KNOWN = setOf(
            INVALID_REQUEST, PAYLOAD_TOO_LARGE, RATE_LIMITED, AUTHENTICATION_REQUIRED,
            CREDENTIAL_REVOKED, CAPABILITY_DENIED, PAIRING_CLOSED, PAIRING_EXPIRED,
            PAIRING_ALREADY_USED, SERVER_IDENTITY_CHANGED, NOT_FOUND, ALREADY_EXISTS,
            REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_CAPACITY, IDEMPOTENCY_IN_FLIGHT,
            BOT_ARCHIVED, WORKSPACE_UNAVAILABLE, WORKSPACE_CHANGING, PERMISSION_CONFIRMATION_REQUIRED,
            HANDLE_INVALID, HANDLE_EXPIRED, HANDLE_WRONG_DEVICE, ROOT_POLICY_CHANGED,
            FILESYSTEM_IDENTITY_CHANGED, PATH_OUTSIDE_ROOT, HANDLE_CAPACITY, TURN_ALREADY_ACTIVE,
            STREAM_GONE, APPROVAL_ALREADY_RESOLVED, APPROVAL_EXPIRED, OPERATION_IN_PROGRESS,
            OPERATION_STALE, GIT_CAPABILITY_DENIED, SCHEDULE_DISABLED, SCHEDULE_RUN_IN_PROGRESS,
            SERVER_INTERRUPTED, INTERNAL_ERROR
        )
    }
}

object AidenRemoteErrorCodeSerializer : KSerializer<AidenRemoteErrorCode> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("AidenRemoteErrorCode", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenRemoteErrorCode) = encoder.encodeString(value.rawValue)
    override fun deserialize(decoder: Decoder): AidenRemoteErrorCode {
        val raw = decoder.decodeString()
        val candidate = AidenRemoteErrorCode(raw)
        if (!AidenRemoteErrorCode.V1_KNOWN.contains(candidate)) {
            throw AidenRemoteContractException.UnknownErrorCode(raw)
        }
        return candidate
    }
}

@Serializable(with = AidenRemoteEventTypeSerializer::class)
data class AidenRemoteEventType(val rawValue: String) {
    val isTerminal: Boolean
        get() = this == DONE || this == ERROR || this == CANCELLED

    companion object {
        val SNAPSHOT = AidenRemoteEventType("snapshot")
        val STATUS = AidenRemoteEventType("status")
        val TEXT_DELTA = AidenRemoteEventType("text_delta")
        val REASONING_DELTA = AidenRemoteEventType("reasoning_delta")
        val TOOL_STARTED = AidenRemoteEventType("tool_started")
        val TOOL_FINISHED = AidenRemoteEventType("tool_finished")
        val TIMELINE = AidenRemoteEventType("timeline")
        val APPROVAL_REQUIRED = AidenRemoteEventType("approval_required")
        val DONE = AidenRemoteEventType("done")
        val ERROR = AidenRemoteEventType("error")
        val CANCELLED = AidenRemoteEventType("cancelled")
        val HEARTBEAT = AidenRemoteEventType("heartbeat")

        val V1_KNOWN = listOf(
            SNAPSHOT, STATUS, TEXT_DELTA, REASONING_DELTA,
            TOOL_STARTED, TOOL_FINISHED, TIMELINE, APPROVAL_REQUIRED,
            DONE, ERROR, CANCELLED, HEARTBEAT
        )
    }
}

object AidenRemoteEventTypeSerializer : KSerializer<AidenRemoteEventType> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("AidenRemoteEventType", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: AidenRemoteEventType) = encoder.encodeString(value.rawValue)
    override fun deserialize(decoder: Decoder): AidenRemoteEventType {
        val raw = decoder.decodeString()
        return AidenRemoteEventType(raw)
    }
}
