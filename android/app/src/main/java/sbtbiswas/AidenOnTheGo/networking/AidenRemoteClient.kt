package sbtbiswas.AidenOnTheGo.networking

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import sbtbiswas.AidenOnTheGo.AidenAppVersion
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.*
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticArea
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticCode
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticEvent
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticOutcome
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnostics
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.net.URLEncoder
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class AidenPreferredChatSummaryPage(
    val summaries: List<AidenChatSummary>,
    val nextCursor: String?,
    val usedLegacyEndpoint: Boolean
)

class AidenRemoteClient(
    val endpoint: String,
    val credential: String?,
    val customOkHttpClient: OkHttpClient? = null
) {
    constructor(
        installation: AidenInstallation,
        credential: String,
        customOkHttpClient: OkHttpClient? = null
    ) : this(
        endpoint = installation.endpoint.trimEnd('/'),
        credential = credential,
        customOkHttpClient = customOkHttpClient ?: createOkHttpClient(
            serverSpkiSha256 = installation.serverSpkiSha256,
            trust = installation.pairingTrust
        )
    )

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val httpClient: OkHttpClient = customOkHttpClient ?: createOkHttpClient(
        serverSpkiSha256 = "",
        trust = null
    )

    companion object {
        private val jsonParser = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        fun createOkHttpClient(
            serverSpkiSha256: String,
            trust: AidenPairingTrust?
        ): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)

            val trustPolicy = if (trust?.mode == "private-ca" && !trust.caCertificateDerBase64.isNullOrEmpty()) {
                val caBytes = Base64.getDecoder().decode(trust.caCertificateDerBase64)
                AidenServerTrustPolicy.PrivateCA(caBytes)
            } else {
                AidenServerTrustPolicy.System
            }

            val trustManager = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    if (chain.isNullOrEmpty()) throw IOException("Empty certificate chain")
                    @Suppress("UNCHECKED_CAST")
                    AidenServerTrust.evaluate(
                        chain = chain as Array<X509Certificate>,
                        expectedHost = "",
                        expectedFingerprint = serverSpkiSha256,
                        policy = trustPolicy
                    )
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }

            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(null, arrayOf(trustManager), SecureRandom())
            builder.sslSocketFactory(sslContext.socketFactory, trustManager)
            builder.hostnameVerifier { _, _ -> true }
            return builder.build()
        }

        fun normalizeManualPairingCode(value: String): String {
            for (ch in value) {
                if (!((ch.code in 48..57) || (ch.code in 65..90) || (ch.code in 97..122) || ch == ' ' || ch == '-')) {
                    throw AidenManualPairingException.InvalidCode
                }
            }
            val normalized = value.replace("-", "").replace(" ", "").uppercase(java.util.Locale.US)
            val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toSet()
            if (normalized.length != 20 || !normalized.all { alphabet.contains(it) }) {
                throw AidenManualPairingException.InvalidCode
            }
            return normalized
        }

        suspend fun pair(
            payload: AidenPairingPayload,
            deviceName: String,
            deviceType: AidenDeviceType,
            clientVersion: String = AidenAppVersion.NAME,
            acceptsBotCapabilities: Boolean = true,
            customOkHttpClient: OkHttpClient? = null
        ): AidenPairingExchange = withContext(Dispatchers.IO) {
            val bootstrap = payload.bootstrap
            if (bootstrap.protocolVersion != AidenRemoteProtocol.VERSION) {
                throw AidenPairingBootstrapException.UnsupportedProtocol
            }
            if (bootstrap.expiresAt.isBefore(Instant.now())) {
                throw AidenPairingBootstrapException.Expired
            }
            if (bootstrap.instanceId.isEmpty() || bootstrap.instanceId.length > AidenRemoteProtocol.MAX_IDENTIFIER_LENGTH) {
                throw AidenPairingBootstrapException.InvalidInstance
            }
            if (!AidenServerTrust.isCanonicalEndpoint(bootstrap.endpoint)) {
                throw AidenPairingBootstrapException.InvalidEndpoint
            }

            val client = customOkHttpClient ?: createOkHttpClient(bootstrap.serverSpkiSha256, payload.trust)
            val pairUrl = "${bootstrap.endpoint.trimEnd('/')}/pairing/exchange"

            val requestObj = PairingExchangeRequest(
                secret = bootstrap.secret,
                deviceName = deviceName,
                deviceType = deviceType.wireValue,
                clientVersion = clientVersion,
                acceptsDisplayName = true,
                acceptsBotCapabilities = acceptsBotCapabilities
            )
            val bodyJson = jsonParser.encodeToString(requestObj)

            val request = Request.Builder()
                .url(pairUrl)
                .addHeader("Aiden-Protocol-Version", "1")
                .addHeader("Accept", "application/json")
                .post(bodyJson.toRequestBody("application/json".toMediaType()))
                .build()

            val response = client.newCall(request).await()
            val responseBytes = response.body?.bytes() ?: throw AidenRemoteClientException.InvalidResponse()

            if (!response.isSuccessful) {
                val error = parseError(response.code, responseBytes)
                if (response.code == 400 && error.code == AidenRemoteErrorCode.INVALID_REQUEST) {
                    // Retry with legacy four-field shape
                    val legacyRequestObj = PairingExchangeRequest(
                        secret = bootstrap.secret,
                        deviceName = deviceName,
                        deviceType = deviceType.wireValue,
                        clientVersion = clientVersion,
                        acceptsDisplayName = null,
                        acceptsBotCapabilities = null
                    )
                    val legacyBodyJson = jsonParser.encodeToString(legacyRequestObj)
                    val retryRequest = Request.Builder()
                        .url(pairUrl)
                        .addHeader("Aiden-Protocol-Version", "1")
                        .addHeader("Accept", "application/json")
                        .post(legacyBodyJson.toRequestBody("application/json".toMediaType()))
                        .build()
                    val retryResponse = client.newCall(retryRequest).await()
                    val retryBytes = retryResponse.body?.bytes() ?: throw AidenRemoteClientException.InvalidResponse()
                    if (!retryResponse.isSuccessful) {
                        val retryError = parseError(retryResponse.code, retryBytes)
                        throw AidenRemoteClientException.Server(retryResponse.code, retryError)
                    }
                    AidenRawJsonDuplicateKeyScanner.validate(retryBytes)
                    return@withContext jsonParser.decodeFromString<AidenPairingExchange>(String(retryBytes, Charsets.UTF_8))
                }
                throw AidenRemoteClientException.Server(response.code, error)
            }

            AidenRawJsonDuplicateKeyScanner.validate(responseBytes)
            jsonParser.decodeFromString<AidenPairingExchange>(String(responseBytes, Charsets.UTF_8))
        }

        suspend fun pair(
            manualCode: String,
            endpoint: String,
            deviceName: String,
            deviceType: AidenDeviceType,
            clientVersion: String = AidenAppVersion.NAME,
            acceptsBotCapabilities: Boolean = true,
            customOkHttpClient: OkHttpClient? = null
        ): PairResult = withContext(Dispatchers.IO) {
            val payload = manualPairingPayload(manualCode, endpoint, customOkHttpClient)
            val exchange = pair(
                payload = payload,
                deviceName = deviceName,
                deviceType = deviceType,
                clientVersion = clientVersion,
                acceptsBotCapabilities = acceptsBotCapabilities,
                customOkHttpClient = customOkHttpClient
            )
            PairResult(payload, exchange)
        }

        suspend fun manualPairingPayload(
            code: String,
            endpoint: String,
            customOkHttpClient: OkHttpClient? = null,
            now: Instant = Instant.now()
        ): AidenPairingPayload = withContext(Dispatchers.IO) {
            val normalizedCode = normalizeManualPairingCode(code)
            if (!AidenServerTrust.isCanonicalEndpoint(endpoint)) {
                throw AidenRemoteClientException.InvalidEndpoint
            }

            val tempClient = customOkHttpClient ?: OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build()

            val bootstrapUrl = "${endpoint.trimEnd('/')}/pairing/manual-bootstrap"
            val request = Request.Builder()
                .url(bootstrapUrl)
                .addHeader("Aiden-Protocol-Version", "1")
                .addHeader("Accept", "application/json")
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()

            val response = tempClient.newCall(request).await()
            val responseBytes = response.body?.bytes() ?: throw AidenManualPairingException.InvalidBootstrap
            if (!response.isSuccessful) {
                throw AidenManualPairingException.InvalidBootstrap
            }

            AidenRawJsonDuplicateKeyScanner.validate(responseBytes)
            val sealed = jsonParser.decodeFromString<AidenManualPairingBootstrap>(String(responseBytes, Charsets.UTF_8))

            if (sealed.kind != "aiden-manual-pairing-v1" ||
                sealed.protocolVersion != AidenRemoteProtocol.VERSION ||
                !sealed.sessionId.matches(Regex("^pairing_[A-Za-z0-9_-]{32}$")) ||
                sealed.expiresAt.isBefore(now) ||
                sealed.expiresAt.toEpochMilli() - now.toEpochMilli() > 5 * 60 * 1000
            ) {
                throw AidenManualPairingException.InvalidBootstrap
            }

            val decryptedJson = decryptManualPairing(normalizedCode, sealed)
            AidenRawJsonDuplicateKeyScanner.validate(decryptedJson)
            val payload = jsonParser.decodeFromString<AidenPairingPayload>(decryptedJson)

            if (payload.bootstrap.endpoint.trimEnd('/') != endpoint.trimEnd('/') ||
                payload.bootstrap.expiresAt != sealed.expiresAt
            ) {
                throw AidenManualPairingException.EndpointMismatch
            }

            payload
        }

        private fun decryptManualPairing(normalizedCode: String, bootstrap: AidenManualPairingBootstrap): String {
            try {
                val ikm = normalizedCode.toByteArray(Charsets.US_ASCII)
                val salt = Base64.getUrlDecoder().decode(bootstrap.salt)
                val nonce = Base64.getUrlDecoder().decode(bootstrap.nonce)
                val ciphertext = Base64.getUrlDecoder().decode(bootstrap.ciphertext)
                val tag = Base64.getUrlDecoder().decode(bootstrap.tag)

                // HKDF-Extract: PRK = HMAC-SHA256(salt, ikm)
                val mac = Mac.getInstance("HmacSHA256")
                mac.init(SecretKeySpec(salt, "HmacSHA256"))
                val prk = mac.doFinal(ikm)

                // HKDF-Expand: key = HMAC-SHA256(prk, info || 0x01)
                val info = "aiden-manual-pairing-v1\n${bootstrap.sessionId}".toByteArray(Charsets.UTF_8)
                mac.init(SecretKeySpec(prk, "HmacSHA256"))
                mac.update(info)
                mac.update(0x01.toByte())
                val keyBytes = mac.doFinal()

                // AES-GCM-256 AAD
                val rawExpiresAt = DateTimeFormatter.ISO_INSTANT.format(bootstrap.expiresAt)
                val aad = "aiden-manual-pairing-v1\n${bootstrap.sessionId}\n$rawExpiresAt".toByteArray(Charsets.UTF_8)

                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                val combined = ByteArray(ciphertext.size + tag.size)
                System.arraycopy(ciphertext, 0, combined, 0, ciphertext.size)
                System.arraycopy(tag, 0, combined, ciphertext.size, tag.size)

                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, nonce))
                cipher.updateAAD(aad)
                val decrypted = cipher.doFinal(combined)
                return String(decrypted, Charsets.UTF_8)
            } catch (_: Exception) {
                throw AidenManualPairingException.DecryptionFailed
            }
        }

        fun parseError(statusCode: Int, bytes: ByteArray): AidenRemoteErrorEnvelope.Body {
            return try {
                AidenRawJsonDuplicateKeyScanner.validate(bytes)
                val envelope = jsonParser.decodeFromString<AidenRemoteErrorEnvelope>(String(bytes, Charsets.UTF_8))
                envelope.error
            } catch (_: Exception) {
                AidenRemoteErrorEnvelope.Body(
                    code = AidenRemoteErrorCode.INTERNAL_ERROR,
                    message = "Aiden Agent returned HTTP status $statusCode.",
                    requestId = "",
                    retryable = false
                )
            }
        }
    }

    data class PairResult(val payload: AidenPairingPayload, val exchange: AidenPairingExchange)

    private suspend fun <T> executeRequest(
        path: String,
        method: String = "GET",
        bodyJson: String? = null,
        idempotencyKey: UUID? = null,
        ifMatchRevision: String? = null,
        headers: Map<String, String> = emptyMap(),
        authenticated: Boolean = true,
        acceptHeader: String = "application/json",
        acceptedStatus: Set<Int> = setOf(200),
        botScope: AidenBotPrivateResponseScope? = null,
        requestTimeoutSeconds: Long? = null,
        maximumResponseBytes: Int? = null,
        deserializer: (ByteArray) -> T
    ): T = try {
        withContext(Dispatchers.IO) {
        val url = if (path.startsWith("http")) path else "$endpoint$path"
        val requestBuilder = Request.Builder()
            .url(url)
            .addHeader("Aiden-Protocol-Version", "1")
            .addHeader("Accept", acceptHeader)

        if (authenticated) {
            if (credential.isNullOrEmpty()) {
                AidenDiagnostics.record(AidenDiagnosticArea.AUTHENTICATION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.UNAUTHORIZED)
                throw AidenRemoteClientException.MissingCredential
            }
            requestBuilder.addHeader("Authorization", "Bearer $credential")
        }

        if (idempotencyKey != null) {
            requestBuilder.addHeader("Idempotency-Key", idempotencyKey.toString().lowercase())
        }
        if (ifMatchRevision != null) {
            requestBuilder.addHeader("If-Match", ifMatchRevision)
        }
        for ((k, v) in headers) {
            requestBuilder.addHeader(k, v)
        }

        val requestBody = bodyJson?.toRequestBody("application/json".toMediaType())
        when (method.uppercase()) {
            "GET" -> requestBuilder.get()
            "POST" -> requestBuilder.post(requestBody ?: ByteArray(0).toRequestBody("application/json".toMediaType()))
            "PUT" -> requestBuilder.put(requestBody ?: ByteArray(0).toRequestBody("application/json".toMediaType()))
            "PATCH" -> requestBuilder.patch(requestBody ?: ByteArray(0).toRequestBody("application/json".toMediaType()))
            "DELETE" -> if (requestBody != null) requestBuilder.delete(requestBody) else requestBuilder.delete()
        }

        val callClient = requestTimeoutSeconds?.let {
            httpClient.newBuilder()
                .readTimeout(it, TimeUnit.SECONDS)
                .callTimeout(it, TimeUnit.SECONDS)
                .build()
        } ?: httpClient
        val response = try {
            callClient.newCall(requestBuilder.build()).await()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CONNECTION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.NETWORK)
            throw error
        }
        val bytes = try {
            if (maximumResponseBytes != null) {
                response.body.readBounded(maximumResponseBytes)
            } else {
                response.body?.bytes() ?: ByteArray(0)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: ResponseBodyLimitExceededException) {
            AidenDiagnostics.record(AidenDiagnosticArea.CONTRACT, AidenDiagnosticEvent.CONTRACT_REJECTED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.INVALID_RESPONSE)
            throw AidenRemoteContractException.PayloadTooLarge
        } catch (error: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CONNECTION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.NETWORK)
            throw error
        }

        if (!acceptedStatus.contains(response.code)) {
            val errorBody = parseError(response.code, bytes)
            AidenDiagnostics.record(
                if (response.code == 401 || response.code == 403) AidenDiagnosticArea.AUTHENTICATION else AidenDiagnosticArea.CONNECTION,
                AidenDiagnosticEvent.REQUEST_FAILED,
                AidenDiagnosticOutcome.FAILED,
                if (response.code == 401 || response.code == 403) AidenDiagnosticCode.UNAUTHORIZED else AidenDiagnosticCode.NETWORK
            )
            throw AidenRemoteClientException.Server(response.code, errorBody)
        }

        try {
            if (bytes.isNotEmpty() && acceptHeader.contains("json")) {
                AidenRawJsonDuplicateKeyScanner.validate(bytes)
                if (botScope != null) {
                    AidenBotPrivateResponseValidator.validate(bytes, botScope)
                }
            }
            deserializer(bytes)
        } catch (error: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CONTRACT, AidenDiagnosticEvent.CONTRACT_REJECTED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.INVALID_RESPONSE)
            throw error
        }
        }
    } catch (error: CancellationException) {
        AidenDiagnostics.record(AidenDiagnosticArea.CONNECTION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.CANCELLED, AidenDiagnosticCode.NETWORK)
        throw error
    }

    // --- Server & Identity ---
    suspend fun server(): AidenServer = executeRequest("/server") { bytes ->
        val s = json.decodeFromString<AidenServer>(String(bytes, Charsets.UTF_8))
        if (s.protocolVersion != AidenRemoteProtocol.VERSION) {
            throw AidenRemoteContractException.InvalidProtocolVersion
        }
        s
    }

    suspend fun updateDeviceIdentity(name: String) {
        val resp = executeRequest<DeviceIdentityResponse>(
            "/device/identity",
            method = "PATCH",
            bodyJson = json.encodeToString(DeviceIdentityRequest(name = name))
        ) { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }
        if (resp.name != name) {
            throw AidenRemoteClientException.InvalidResponse()
        }
    }

    // --- Workspaces ---
    suspend fun workspaces(): List<AidenWorkspace> = executeRequest("/workspaces") { bytes ->
        val resp = json.decodeFromString<WorkspaceListResponse>(String(bytes, Charsets.UTF_8))
        resp.workspaces
    }

    suspend fun workspace(id: String): AidenWorkspace = executeRequest("/workspaces/$id") { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun createWorkspace(
        create: AidenWorkspaceCreate,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenWorkspace = executeRequest(
        "/workspaces",
        method = "POST",
        bodyJson = json.encodeToString(create),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(201)
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun updateWorkspace(
        id: String,
        revision: String,
        patch: AidenWorkspacePatch
    ): AidenWorkspace = executeRequest(
        "/workspaces/$id",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(patch)
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun memorySettings(): AidenMemorySettings =
        executeRequest("/memory/settings") { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }

    suspend fun updateMemorySettings(revision: String, enabled: Boolean): AidenMemorySettings =
        executeRequest(
            "/memory/settings",
            method = "PATCH",
            ifMatchRevision = revision,
            bodyJson = json.encodeToString(AidenMemorySettingsMutation(enabled = enabled))
        ) { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }

    suspend fun removeWorkspace(id: String, revision: String) =
        executeRequest<Unit>(
            "/workspaces/$id",
            method = "DELETE",
            ifMatchRevision = revision,
            acceptedStatus = setOf(204)
        ) {}

    suspend fun browserRoots(): List<AidenBrowserRoot> = executeRequest("/workspace-browser/roots") { bytes ->
        val resp = json.decodeFromString<BrowserRootListResponse>(String(bytes, Charsets.UTF_8))
        resp.roots
    }

    suspend fun browserChildren(location: String, cursor: String? = null): AidenBrowserPage {
        val query = if (cursor != null) "?location=$location&cursor=$cursor" else "?location=$location"
        return executeRequest("/workspace-browser/children$query") { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }
    }

    suspend fun createWorkspaceSelection(location: String): AidenWorkspaceSelection =
        executeRequest(
            "/workspace-browser/selections",
            method = "POST",
            bodyJson = json.encodeToString(BrowserSelectionRequest(location = location)),
            acceptedStatus = setOf(201)
        ) { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }

    // --- Chats ---
    suspend fun chats(workspaceId: String? = null): List<AidenChat> {
        val query = if (workspaceId != null) "?workspaceId=$workspaceId" else ""
        return executeRequest(
            "/chats$query",
            botScope = AidenBotPrivateResponseScope.ChatProjection
        ) { bytes ->
            val resp = json.decodeFromString<ChatListResponse>(String(bytes, Charsets.UTF_8))
            resp.chats
        }
    }

    suspend fun chatSummaryPage(
        limit: Int = AidenRemoteProtocol.DEFAULT_CHAT_SUMMARY_PAGE_SIZE,
        cursor: String? = null
    ): AidenChatSummaryPage {
        if (limit !in 1..AidenRemoteProtocol.MAX_CHAT_SUMMARY_PAGE_SIZE ||
            (cursor != null && !AidenRemoteProtocol.CHAT_SUMMARY_CURSOR_PATTERN.matches(cursor))
        ) {
            throw AidenRemoteClientException.InvalidResponse("Invalid chat summary pagination request.")
        }
        val encodedCursor = cursor?.let {
            URLEncoder.encode(it, Charsets.UTF_8.name()).replace("+", "%20")
        }
        val path = buildString {
            append("/chat-summaries?limit=")
            append(limit)
            if (encodedCursor != null) {
                append("&cursor=")
                append(encodedCursor)
            }
        }
        return executeRequest(
            path,
            botScope = AidenBotPrivateResponseScope.ChatSummaryProjection,
            maximumResponseBytes = AidenRemoteProtocol.MAX_JSON_BODY_BYTES
        ) { bytes ->
            val page = json.decodeFromString<AidenChatSummaryPage>(String(bytes, Charsets.UTF_8)).validatedWire()
            if (page.summaries.size > limit) {
                throw AidenRemoteContractException.InvalidJson("Chat Summary page exceeds requested limit")
            }
            page
        }
    }

    suspend fun preferredChatSummaryPage(
        supportsChatSummaries: Boolean,
        limit: Int = AidenRemoteProtocol.DEFAULT_CHAT_SUMMARY_PAGE_SIZE,
        cursor: String? = null
    ): AidenPreferredChatSummaryPage {
        if (!supportsChatSummaries) {
            if (cursor != null) {
                throw AidenRemoteClientException.InvalidResponse("Legacy chat loading does not support cursors.")
            }
            return legacyChatSummaryPage()
        }
        val page = chatSummaryPage(limit, cursor)
        return AidenPreferredChatSummaryPage(
            summaries = page.summaries,
            nextCursor = page.nextCursor,
            usedLegacyEndpoint = false
        )
    }

    private suspend fun legacyChatSummaryPage(): AidenPreferredChatSummaryPage {
        val summaries = AidenChat.regularWorkspaceChats(chats()).map { AidenChatSummary.fromChat(it) }
        return AidenPreferredChatSummaryPage(
            summaries = summaries,
            nextCursor = null,
            usedLegacyEndpoint = true
        )
    }

    suspend fun chat(id: String): AidenChat = executeRequest(
        "/chats/$id",
        botScope = AidenBotPrivateResponseScope.ChatProjection
    ) { bytes ->
        val c = json.decodeFromString<AidenChat>(String(bytes, Charsets.UTF_8))
        if (c.id != id) throw AidenRemoteClientException.InvalidResponse()
        c
    }

    suspend fun createChat(
        workspaceId: String,
        providerId: String? = null,
        modelId: String? = null,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenChat = executeRequest(
        "/chats",
        method = "POST",
        bodyJson = json.encodeToString(ChatCreateRequest(workspaceId, providerId, modelId)),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(201),
        botScope = AidenBotPrivateResponseScope.ChatProjection
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun updateChat(
        id: String,
        revision: String,
        title: String
    ): AidenChat = executeRequest(
        "/chats/$id",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(ChatUpdateRequest(title = title)),
        botScope = AidenBotPrivateResponseScope.ChatProjection
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun removeChat(id: String, revision: String) =
        executeRequest<Unit>(
            "/chats/$id",
            method = "DELETE",
            ifMatchRevision = revision,
            acceptedStatus = setOf(204)
        ) {}

    suspend fun moveChat(
        id: String,
        revision: String,
        workspaceId: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenChat = executeRequest(
        "/chats/$id/move",
        method = "POST",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        bodyJson = json.encodeToString(ChatMoveRequest(workspaceId = workspaceId)),
        botScope = AidenBotPrivateResponseScope.ChatProjection
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun uploadAttachment(
        chatId: String,
        upload: AidenAttachmentUpload
    ): AidenAttachmentReference = executeRequest(
        "/chats/$chatId/attachments",
        method = "POST",
        bodyJson = json.encodeToString(upload),
        acceptedStatus = setOf(201)
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun removeAttachment(chatId: String, attachmentId: String) =
        executeRequest<Unit>(
            "/chats/$chatId/attachments/$attachmentId",
            method = "DELETE",
            acceptedStatus = setOf(204)
        ) {}

    suspend fun attachmentContent(chatId: String, attachmentId: String): AidenAttachmentContent = try {
        withContext(Dispatchers.IO) {
        if (credential.isNullOrEmpty()) {
            AidenDiagnostics.record(AidenDiagnosticArea.AUTHENTICATION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.UNAUTHORIZED)
            throw AidenRemoteClientException.MissingCredential
        }
        val url = "$endpoint/chats/$chatId/attachments/$attachmentId/content"
        val request = Request.Builder()
            .url(url)
            .addHeader("Aiden-Protocol-Version", "1")
            .addHeader("Accept", "image/jpeg, image/png")
            .addHeader("Authorization", "Bearer $credential")
            .get()
            .build()

        val attachmentResponse = try {
            httpClient.newCall(request).await()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            AidenDiagnostics.record(AidenDiagnosticArea.CONNECTION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.NETWORK)
            throw error
        }
        attachmentResponse.use { response ->
            if (!response.isSuccessful) {
                val bytes = try { response.body.readBounded(1_048_576) } catch (_: Exception) { ByteArray(0) }
                AidenDiagnostics.record(
                    if (response.code == 401 || response.code == 403) AidenDiagnosticArea.AUTHENTICATION else AidenDiagnosticArea.CONNECTION,
                    AidenDiagnosticEvent.REQUEST_FAILED,
                    AidenDiagnosticOutcome.FAILED,
                    if (response.code == 401 || response.code == 403) AidenDiagnosticCode.UNAUTHORIZED else AidenDiagnosticCode.NETWORK
                )
                throw AidenRemoteClientException.Server(response.code, parseError(response.code, bytes))
            }
            val contentType = response.header("Content-Type")?.split(";")?.firstOrNull()?.trim()?.lowercase()
            if (contentType != "image/jpeg" && contentType != "image/png") {
                AidenDiagnostics.record(AidenDiagnosticArea.CONTRACT, AidenDiagnosticEvent.CONTRACT_REJECTED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.INVALID_RESPONSE)
                throw AidenRemoteClientException.InvalidResponse()
            }
            val bytes = try {
                response.body.readBounded(AidenAttachmentImageValidation.MAXIMUM_BYTES)
            } catch (error: CancellationException) {
                throw error
            } catch (_: ResponseBodyLimitExceededException) {
                AidenDiagnostics.record(AidenDiagnosticArea.CONTRACT, AidenDiagnosticEvent.CONTRACT_REJECTED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.INVALID_RESPONSE)
                throw AidenRemoteClientException.InvalidResponse()
            } catch (error: IOException) {
                AidenDiagnostics.record(AidenDiagnosticArea.CONNECTION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.NETWORK)
                throw error
            }
            AidenAttachmentContent(data = bytes, mimeType = contentType)
        }
        }
    } catch (error: CancellationException) {
        AidenDiagnostics.record(AidenDiagnosticArea.CONNECTION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.CANCELLED, AidenDiagnosticCode.NETWORK)
        throw error
    }

    suspend fun startTurn(
        chatId: String,
        request: AidenTurnStart,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenTurnStartResponse = executeRequest(
        "/chats/$chatId/turns",
        method = "POST",
        bodyJson = json.encodeToString(request),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202),
        botScope = AidenBotPrivateResponseScope.ChatProjection
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun streamStatus(id: String): AidenStreamStatus = executeRequest("/streams/$id") { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun streamStatus(chatId: String, streamId: String): AidenStreamStatus = streamStatus(streamId)

    suspend fun streamApproval(id: String): AidenStreamApprovalSnapshot = executeRequest("/streams/$id/approval") { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun pendingApproval(chatId: String, streamId: String): AidenStreamPendingApproval? =
        streamApproval(streamId).approval

    suspend fun cancelStream(
        id: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenStreamStatus = executeRequest(
        "/streams/$id/cancel",
        method = "POST",
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun cancelTurn(chatId: String, turnId: String) {
        cancelStream(turnId)
    }

    suspend fun respondToApproval(
        id: String,
        decision: AidenApprovalDecision,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenApprovalResponse = executeRequest(
        "/approvals/$id/respond",
        method = "POST",
        bodyJson = json.encodeToString(ApprovalRequest(decision = decision)),
        idempotencyKey = idempotencyKey
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun respondToApproval(
        chatId: String,
        approvalId: String,
        decision: AidenApprovalDecision,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenApprovalResponse = respondToApproval(approvalId, decision, idempotencyKey)

    fun streamEvents(
        id: String,
        after: Int = 0
    ): Flow<AidenRemoteStreamEvent> = callbackFlow {
        if (credential.isNullOrEmpty()) {
            AidenDiagnostics.record(AidenDiagnosticArea.AUTHENTICATION, AidenDiagnosticEvent.REQUEST_FAILED, AidenDiagnosticOutcome.FAILED, AidenDiagnosticCode.UNAUTHORIZED)
            close(AidenRemoteClientException.MissingCredential)
            return@callbackFlow
        }
        val query = if (after > 0) "?after=$after" else ""
        val url = "$endpoint/streams/$id/events$query"
        val requestBuilder = Request.Builder()
            .url(url)
            .addHeader("Aiden-Protocol-Version", "1")
            .addHeader("Accept", "text/event-stream")

        if (!credential.isNullOrEmpty()) {
            requestBuilder.addHeader("Authorization", "Bearer $credential")
        }
        if (after > 0) {
            requestBuilder.addHeader("Last-Event-ID", after.toString())
        }

        val call = httpClient.newCall(requestBuilder.build())
        val readerJob = launch(Dispatchers.IO) {
            try {
                call.execute().use { response ->
                    if (!response.isSuccessful) {
                        val bytes = response.body?.bytes() ?: ByteArray(0)
                        val errorBody = parseError(response.code, bytes)
                        throw AidenRemoteClientException.Server(response.code, errorBody)
                    }
                    val stream = response.body?.byteStream()
                        ?: throw AidenRemoteClientException.InvalidResponse()
                    AidenSSEParser.parseStream(stream, expectedStreamId = id, startSequence = after)
                        .collect { event -> send(event) }
                }
                close()
            } catch (error: Exception) {
                if (isActive) {
                    val area: AidenDiagnosticArea
                    val code: AidenDiagnosticCode
                    when (error) {
                        is AidenRemoteClientException.Server -> {
                            area = if (error.statusCode == 401 || error.statusCode == 403) AidenDiagnosticArea.AUTHENTICATION else AidenDiagnosticArea.CONNECTION
                            code = if (area == AidenDiagnosticArea.AUTHENTICATION) AidenDiagnosticCode.UNAUTHORIZED else AidenDiagnosticCode.NETWORK
                        }
                        is IOException -> {
                            area = AidenDiagnosticArea.CONNECTION
                            code = AidenDiagnosticCode.NETWORK
                        }
                        else -> {
                            area = AidenDiagnosticArea.STREAM
                            code = AidenDiagnosticCode.INVALID_RESPONSE
                        }
                    }
                    AidenDiagnostics.record(area, AidenDiagnosticEvent.STREAM_INTERRUPTED, AidenDiagnosticOutcome.FAILED, code)
                    close(error)
                }
            }
        }
        awaitClose {
            call.cancel()
            readerJob.cancel()
        }
    }

    fun openStream(chatId: String, streamId: String, lastEventId: Int? = null): Flow<AidenRemoteStreamEvent> =
        streamEvents(streamId, lastEventId ?: 0)

    // --- Bots ---
    suspend fun bots(includeArchived: Boolean = false): AidenBotList = executeRequest(
        "/bots?includeArchived=$includeArchived",
        botScope = AidenBotPrivateResponseScope.Root("botList")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun bot(id: String): AidenBotDetail = executeRequest(
        "/bots/$id",
        botScope = AidenBotPrivateResponseScope.Root("botDetail")
    ) { bytes ->
        val detail = json.decodeFromString<AidenBotDetail>(String(bytes, Charsets.UTF_8))
        if (detail.id != id) throw AidenRemoteClientException.InvalidResponse()
        detail
    }

    suspend fun createBot(
        request: AidenBotCreateRequest,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenBotDetail = executeRequest(
        "/bots",
        method = "POST",
        bodyJson = json.encodeToString(request),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(201),
        botScope = AidenBotPrivateResponseScope.Root("botDetail")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun updateBotIdentity(
        id: String,
        revision: String,
        patch: AidenBotIdentityPatch
    ): AidenBotDetail = executeRequest(
        "/bots/$id",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(patch),
        botScope = AidenBotPrivateResponseScope.Root("botDetail")
    ) { bytes ->
        val detail = json.decodeFromString<AidenBotDetail>(String(bytes, Charsets.UTF_8))
        if (detail.id != id) throw AidenRemoteClientException.InvalidResponse()
        detail
    }

    suspend fun archiveBot(id: String, revision: String): AidenBotDetail = executeRequest(
        "/bots/$id",
        method = "DELETE",
        ifMatchRevision = revision,
        botScope = AidenBotPrivateResponseScope.Root("botArchive")
    ) { bytes ->
        val response = json.decodeFromString<AidenBotArchiveResponse>(String(bytes, Charsets.UTF_8))
        if (response.bot.id != id) throw AidenRemoteClientException.InvalidResponse()
        response.bot
    }

    suspend fun restoreBot(
        id: String,
        revision: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenBotDetail = executeRequest(
        "/bots/$id/restore",
        method = "POST",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        bodyJson = json.encodeToString(AidenForegroundConfirmation()),
        botScope = AidenBotPrivateResponseScope.Root("botRestore")
    ) { bytes ->
        val response = json.decodeFromString<AidenBotRestoreResponse>(String(bytes, Charsets.UTF_8))
        if (response.bot.id != id) throw AidenRemoteClientException.InvalidResponse()
        response.bot
    }

    suspend fun botConversations(
        spec: AidenBotConversationQuery
    ): AidenBotConversationPage {
        val params = mutableListOf<String>()
        if (spec.cursor != null) params.add("cursor=${spec.cursor}")
        if (spec.query != null) params.add("query=${spec.query}")
        if (spec.botId != null) params.add("botId=${spec.botId}")
        if (spec.limit != null) params.add("limit=${spec.limit}")
        val queryString = if (params.isNotEmpty()) "?${params.joinToString("&")}" else ""

        return executeRequest(
            "/bot-conversations$queryString",
            botScope = AidenBotPrivateResponseScope.Root("botConversations")
        ) { bytes ->
            val page = json.decodeFromString<AidenBotConversationPage>(String(bytes, Charsets.UTF_8))
            if (spec.botId != null && !page.conversations.all { it.botId == spec.botId }) {
                throw AidenRemoteClientException.InvalidResponse()
            }
            page
        }
    }

    suspend fun botConversations(
        botId: String? = null,
        cursor: String? = null,
        query: String? = null,
        limit: Int? = null
    ): AidenBotConversationPage = botConversations(
        AidenBotConversationQuery(cursor = cursor, query = query, botId = botId, limit = limit)
    )

    suspend fun createBotChat(
        botId: String,
        request: AidenBotChatCreateRequest = AidenBotChatCreateRequest(),
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenChat = executeRequest(
        "/bots/$botId/chats",
        method = "POST",
        bodyJson = json.encodeToString(request),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(201),
        botScope = AidenBotPrivateResponseScope.Root("botChatCreate")
    ) { bytes ->
        val resp = json.decodeFromString<AidenBotChatCreateResponse>(String(bytes, Charsets.UTF_8))
        if (resp.chat.botId != botId) throw AidenRemoteClientException.InvalidResponse()
        resp.chat
    }

    suspend fun botCapabilityCatalog(botId: String? = null): AidenBotCapabilityCatalog {
        val query = if (botId != null) "?botId=$botId" else ""
        return executeRequest(
            "/bot-capabilities$query",
            botScope = AidenBotPrivateResponseScope.Root("botCapabilityCatalog")
        ) { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }
    }

    suspend fun updateBotAccess(
        botId: String,
        revision: String,
        update: AidenBotAccessUpdate
    ): AidenBotAccessView = executeRequest(
        "/bots/$botId/capabilities",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(update),
        botScope = AidenBotPrivateResponseScope.Root("botPolicy")
    ) { bytes ->
        val resp = json.decodeFromString<AidenBotAccessView>(String(bytes, Charsets.UTF_8))
        if (resp.botId != botId) throw AidenRemoteClientException.InvalidResponse()
        resp
    }

    suspend fun botChatAccess(chatId: String): AidenBotChatAccessView = executeRequest(
        "/chats/$chatId/capabilities",
        botScope = AidenBotPrivateResponseScope.Root("botChatSubset")
    ) { bytes ->
        val resp = json.decodeFromString<AidenBotChatAccessView>(String(bytes, Charsets.UTF_8))
        if (resp.chatId != chatId) throw AidenRemoteClientException.InvalidResponse()
        resp
    }

    suspend fun updateBotChatAccess(
        chatId: String,
        revision: String,
        update: AidenBotChatAccessUpdate
    ): AidenBotChatAccessView = executeRequest(
        "/chats/$chatId/capabilities",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(update),
        botScope = AidenBotPrivateResponseScope.Root("botChatSubset")
    ) { bytes ->
        val resp = json.decodeFromString<AidenBotChatAccessView>(String(bytes, Charsets.UTF_8))
        if (resp.chatId != chatId) throw AidenRemoteClientException.InvalidResponse()
        resp
    }

    suspend fun botFavorites(): AidenBotFavorites = executeRequest(
        "/bot-favorites",
        botScope = AidenBotPrivateResponseScope.Root("botFavorites")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun updateBotFavorites(
        update: AidenBotFavoritesUpdateRequest,
        revision: String
    ): AidenBotFavorites = executeRequest(
        "/bot-favorites",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(update),
        botScope = AidenBotPrivateResponseScope.Root("botFavorites")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }
    suspend fun updateFavorites(botIds: List<String>, revision: String = ""): AidenBotFavorites =
        updateBotFavorites(AidenBotFavoritesUpdateRequest(botIds), revision)

    suspend fun botAccessNotice(): AidenBotNoticeStatus = executeRequest(
        "/bot-access-notice",
        botScope = AidenBotPrivateResponseScope.Root("botNotice")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun acknowledgeBotAccessNotice(
        acknowledgement: AidenBotNoticeAcknowledgement,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenBotNoticeStatus = executeRequest(
        "/bot-access-notice/acknowledgement",
        method = "POST",
        bodyJson = json.encodeToString(acknowledgement),
        idempotencyKey = idempotencyKey,
        botScope = AidenBotPrivateResponseScope.Root("botNotice")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun botConversationFiles(chatId: String): AidenWorkspaceFileIndex = executeRequest(
        "/bot-conversations/$chatId/files"
    ) { bytes ->
        val index = json.decodeFromString<AidenWorkspaceFileIndex>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(index)
    }

    suspend fun botConversationFile(chatId: String, fileId: String): AidenWorkspaceFileDocument = executeRequest(
        "/bot-conversations/$chatId/files/$fileId"
    ) { bytes ->
        val doc = json.decodeFromString<AidenWorkspaceFileDocument>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(doc, fileId)
    }

    suspend fun writeBotConversationFile(
        chatId: String,
        fileId: String,
        content: String,
        expectedVersion: String
    ): AidenWorkspaceFileDocument = executeRequest(
        "/bot-conversations/$chatId/files/$fileId",
        method = "PUT",
        bodyJson = json.encodeToString(AidenWorkspaceFileWriteRequest(content, expectedVersion))
    ) { bytes ->
        val doc = json.decodeFromString<AidenWorkspaceFileDocument>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(doc, fileId)
    }

    suspend fun putBotAvatar(
        botId: String,
        revision: String,
        upload: AidenBotAvatarUpload,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenBotAvatarAsset = executeRequest(
        "/bots/$botId/avatar",
        method = "PUT",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        bodyJson = json.encodeToString(upload),
        botScope = AidenBotPrivateResponseScope.Root("botAvatarMetadata")
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun deleteBotAvatar(botId: String, revision: String): AidenBotDetail = executeRequest(
        "/bots/$botId/avatar",
        method = "DELETE",
        ifMatchRevision = revision,
        botScope = AidenBotPrivateResponseScope.Root("botDetail")
    ) { bytes ->
        val detail = json.decodeFromString<AidenBotDetail>(String(bytes, Charsets.UTF_8))
        if (detail.id != botId) throw AidenRemoteClientException.InvalidResponse()
        detail
    }

    suspend fun botAvatar(botId: String, assetRevision: String): AidenBotAvatarContent = withContext(Dispatchers.IO) {
        if (credential.isNullOrEmpty()) throw AidenRemoteClientException.MissingCredential
        val url = "$endpoint/bots/$botId/avatar/$assetRevision"
        val request = Request.Builder()
            .url(url)
            .addHeader("Aiden-Protocol-Version", "1")
            .addHeader("Accept", "image/png")
            .addHeader("Authorization", "Bearer $credential")
            .get()
            .build()

        val response = httpClient.newCall(request).await()
        val bytes = response.body?.bytes() ?: ByteArray(0)
        if (!response.isSuccessful) {
            val errorBody = parseError(response.code, bytes)
            throw AidenRemoteClientException.Server(response.code, errorBody)
        }

        val contentType = response.header("Content-Type")?.split(";")?.firstOrNull()?.trim()?.lowercase()
        val cacheControl = response.header("Cache-Control")?.lowercase()
        val nosniff = response.header("X-Content-Type-Options")?.lowercase()

        if (contentType != "image/png" || cacheControl != "no-store" || nosniff != "nosniff") {
            throw AidenRemoteClientException.InvalidResponse()
        }

        AidenBotAvatarContent(data = bytes, assetRevision = assetRevision)
    }

    // --- Scheduled Tasks ---
    suspend fun scheduledTasks(): List<AidenScheduledTask> = executeRequest("/scheduled-tasks") { bytes ->
        val resp = json.decodeFromString<ScheduledTaskListResponse>(String(bytes, Charsets.UTF_8))
        AidenScheduledTaskValidation.tasks(resp.tasks)
    }

    suspend fun scheduledTask(id: String): AidenScheduledTask = executeRequest("/scheduled-tasks/$id") { bytes ->
        decodeScheduledTask(bytes)
    }

    suspend fun createScheduledTask(
        mutation: AidenScheduledTaskMutation,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenScheduledTask = executeRequest(
        "/scheduled-tasks",
        method = "POST",
        bodyJson = json.encodeToString(mutation),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(201)
    ) { bytes ->
        decodeScheduledTask(bytes)
    }

    suspend fun updateScheduledTask(
        id: String,
        revision: String,
        mutation: AidenScheduledTaskMutation
    ): AidenScheduledTask = executeRequest(
        "/scheduled-tasks/$id",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(mutation)
    ) { bytes ->
        decodeScheduledTask(bytes)
    }

    suspend fun removeScheduledTask(id: String, revision: String) =
        executeRequest<Unit>(
            "/scheduled-tasks/$id",
            method = "DELETE",
            ifMatchRevision = revision,
            acceptedStatus = setOf(204)
        ) { _ -> Unit }

    suspend fun pauseScheduledTask(
        id: String,
        revision: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenScheduledTask = executeRequest(
        "/scheduled-tasks/$id/pause",
        method = "POST",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        decodeScheduledTask(bytes)
    }

    suspend fun resumeScheduledTask(
        id: String,
        revision: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenScheduledTask = executeRequest(
        "/scheduled-tasks/$id/resume",
        method = "POST",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        decodeScheduledTask(bytes)
    }

    suspend fun runScheduledTask(
        id: String,
        revision: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenScheduledRunAccepted = executeRequest(
        "/scheduled-tasks/$id/run",
        method = "POST",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun scheduledRuns(taskId: String): List<AidenScheduledRun> = executeRequest(
        "/scheduled-tasks/$taskId/runs"
    ) { bytes ->
        val resp = json.decodeFromString<ScheduledRunListResponse>(String(bytes, Charsets.UTF_8))
        AidenScheduledTaskValidation.runs(resp.runs, taskId)
    }

    suspend fun previewSchedule(cron: String, timezone: String, count: Int = 3): List<Instant> = executeRequest(
        "/scheduled-tasks/preview",
        method = "POST",
        bodyJson = json.encodeToString(ScheduledPreviewRequest(cron, timezone, count.coerceIn(1, 20)))
    ) { bytes ->
        val resp = json.decodeFromString<AidenScheduledPreview>(String(bytes, Charsets.UTF_8))
        resp.dates
    }

    suspend fun scheduledScripts(workspaceId: String? = null): List<AidenScheduledScript> {
        val query = if (workspaceId != null) "?workspaceId=$workspaceId" else ""
        return executeRequest("/scheduled-tasks/scripts$query") { bytes ->
            val resp = json.decodeFromString<ScheduledScriptListResponse>(String(bytes, Charsets.UTF_8))
            resp.scripts
        }
    }

    suspend fun scheduledMcpServers(): List<AidenScheduledMcpServer> = executeRequest("/scheduled-tasks/mcp-servers") { bytes ->
        val resp = json.decodeFromString<ScheduledMcpServerListResponse>(String(bytes, Charsets.UTF_8))
        resp.servers
    }

    suspend fun scheduledSettings(): AidenScheduledSettings = executeRequest("/scheduled-tasks/settings") { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun updateScheduledSettings(
        revision: String,
        mutation: AidenScheduledSettingsMutation
    ): AidenScheduledSettings = executeRequest(
        "/scheduled-tasks/settings",
        method = "PATCH",
        ifMatchRevision = revision,
        bodyJson = json.encodeToString(mutation)
    ) { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun speechStatus(): AidenSpeechStatus = executeRequest("/speech") { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun selectSpeechModel(modelId: String): AidenSpeechStatus = executeRequest(
        "/speech",
        method = "PATCH",
        bodyJson = json.encodeToString(AidenSpeechSelectionRequest(modelId))
    ) { bytes -> json.decodeFromString(String(bytes, Charsets.UTF_8)) }

    suspend fun downloadSpeechModel(modelId: String): AidenSpeechStatus = executeRequest(
        "/speech/models/$modelId/download",
        method = "POST",
        acceptedStatus = setOf(202)
    ) { bytes -> json.decodeFromString(String(bytes, Charsets.UTF_8)) }

    suspend fun cancelSpeechModelDownload(modelId: String): AidenSpeechStatus = executeRequest(
        "/speech/models/$modelId/download",
        method = "DELETE"
    ) { bytes -> json.decodeFromString(String(bytes, Charsets.UTF_8)) }

    suspend fun deleteSpeechModel(modelId: String): AidenSpeechStatus = executeRequest(
        "/speech/models/$modelId",
        method = "DELETE"
    ) { bytes -> json.decodeFromString(String(bytes, Charsets.UTF_8)) }

    suspend fun transcribeSpeech(pcmBase64: String, modelId: String): AidenSpeechTranscription {
        val body = withContext(Dispatchers.Default) {
            json.encodeToString(AidenSpeechTranscriptionRequest(pcmBase64 = pcmBase64, modelId = modelId))
        }
        return executeRequest(
            "/speech/transcriptions",
            method = "POST",
            bodyJson = body,
            requestTimeoutSeconds = 120
        ) { bytes -> json.decodeFromString(String(bytes, Charsets.UTF_8)) }
    }

    // --- Files & Git ---
    suspend fun workspaceFiles(workspaceId: String): AidenWorkspaceFileIndex = executeRequest(
        "/workspaces/$workspaceId/files"
    ) { bytes ->
        val index = json.decodeFromString<AidenWorkspaceFileIndex>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(index)
    }

    suspend fun fileIndex(workspaceId: String): AidenWorkspaceFileIndex = workspaceFiles(workspaceId)

    suspend fun workspaceFile(workspaceId: String, fileId: String): AidenWorkspaceFileDocument = executeRequest(
        "/workspaces/$workspaceId/files/$fileId"
    ) { bytes ->
        val doc = json.decodeFromString<AidenWorkspaceFileDocument>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(doc, fileId)
    }

    suspend fun readFile(workspaceId: String, fileId: String): AidenWorkspaceFileDocument = workspaceFile(workspaceId, fileId)

    suspend fun writeWorkspaceFile(
        workspaceId: String,
        fileId: String,
        content: String,
        expectedVersion: String
    ): AidenWorkspaceFileDocument = executeRequest(
        "/workspaces/$workspaceId/files/$fileId",
        method = "PUT",
        bodyJson = json.encodeToString(AidenWorkspaceFileWriteRequest(content = content, expectedVersion = expectedVersion))
    ) { bytes ->
        val doc = json.decodeFromString<AidenWorkspaceFileDocument>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(doc, fileId)
    }

    suspend fun writeFile(workspaceId: String, fileId: String, content: String, expectedVersion: String): AidenWorkspaceFileDocument =
        writeWorkspaceFile(workspaceId, fileId, content, expectedVersion)

    suspend fun gitReview(workspaceId: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/review"
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun gitDiff(workspaceId: String, snapshotId: String, fileId: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/diff",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitDiffRequest(snapshotId = snapshotId, fileId = fileId))
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun gitBranches(workspaceId: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/branches"
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun createGitBranch(
        workspaceId: String,
        name: String,
        startPoint: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/branches",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitCreateBranchRequest(name = name, startPoint = startPoint)),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun checkoutGitBranch(
        workspaceId: String,
        branch: String,
        snapshotId: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/checkout",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitCheckoutRequest(branch = branch, snapshotId = snapshotId)),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun commitGit(
        workspaceId: String,
        snapshotId: String,
        message: String,
        stagedOnly: Boolean,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/commit",
        method = "POST",
        bodyJson = json.encodeToString(
            AidenGitCommitRequest(
                snapshotId = snapshotId,
                message = message,
                scope = if (stagedOnly) "staged-reviewed" else "all-reviewed"
            )
        ),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun gitCommit(
        workspaceId: String,
        snapshotId: String,
        message: String,
        scope: String
    ): AidenGitResult = commitGit(
        workspaceId = workspaceId,
        snapshotId = snapshotId,
        message = message,
        stagedOnly = scope == "staged-reviewed"
    )

    suspend fun gitCommit(
        workspaceId: String,
        snapshotId: String,
        message: String,
        stagedOnly: Boolean,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = commitGit(workspaceId, snapshotId, message, stagedOnly, idempotencyKey)

    suspend fun gitPushCapability(workspaceId: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/push-capability"
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun pushGit(
        workspaceId: String,
        snapshotId: String,
        remote: String,
        branch: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/push",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitPushRequest(snapshotId = snapshotId, remote = remote, branch = branch)),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun compareGit(workspaceId: String, baseRef: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/compare",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitCompareRequest(baseRef = baseRef))
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun gitComparisonDiff(workspaceId: String, comparisonId: String, fileId: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/comparison-diff",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitComparisonDiffRequest(comparisonId = comparisonId, fileId = fileId))
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun gitWorktrees(workspaceId: String): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/worktrees"
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun createGitWorktree(
        workspaceId: String,
        branch: String,
        name: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/worktrees",
        method = "POST",
        bodyJson = json.encodeToString(AidenGitCreateWorktreeRequest(branch = branch, name = name)),
        idempotencyKey = idempotencyKey,
        acceptedStatus = setOf(202)
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    suspend fun deleteManagedGitWorktree(
        workspaceId: String,
        revision: String,
        idempotencyKey: UUID = UUID.randomUUID()
    ): AidenGitResult = executeRequest(
        "/workspaces/$workspaceId/git/managed-worktree",
        method = "DELETE",
        ifMatchRevision = revision,
        idempotencyKey = idempotencyKey,
        bodyJson = json.encodeToString(AidenForegroundConfirmation()),
        acceptedStatus = setOf(202)
    ) { bytes ->
        val result = json.decodeFromString<AidenGitResult>(String(bytes, Charsets.UTF_8))
        AidenWorkspaceEnvironmentValidation.validated(result)
    }

    // --- Models & Usage ---
    suspend fun modelCatalog(): AidenModelCatalog = executeRequest("/models") { bytes ->
        json.decodeFromString(String(bytes, Charsets.UTF_8))
    }

    suspend fun usage(range: String = "30d"): AidenUsageSummary {
        if (!listOf("7d", "30d", "90d", "1y", "all").contains(range)) {
            throw AidenRemoteClientException.InvalidResponse()
        }
        return executeRequest("/usage?range=$range") { bytes ->
            json.decodeFromString(String(bytes, Charsets.UTF_8))
        }
    }

    private fun decodeScheduledTask(bytes: ByteArray): AidenScheduledTask {
        val task = json.decodeFromString<AidenScheduledTask>(String(bytes, Charsets.UTF_8))
        return AidenScheduledTaskValidation.tasks(listOf(task)).first()
    }

    // Request/Response helper DTOs
    @Serializable
    private data class PairingExchangeRequest(
        val secret: String,
        val deviceName: String,
        val deviceType: String,
        val clientVersion: String,
        val acceptsDisplayName: Boolean? = null,
        val acceptsBotCapabilities: Boolean? = null
    )

    @Serializable
    private data class DeviceIdentityRequest(val name: String)

    @Serializable
    private data class DeviceIdentityResponse(val name: String)

    @Serializable
    private data class WorkspaceListResponse(val workspaces: List<AidenWorkspace>)

    @Serializable
    private data class BrowserRootListResponse(val roots: List<AidenBrowserRoot>)

    @Serializable
    private data class BrowserSelectionRequest(val location: String)

    @Serializable
    private data class ChatListResponse(val chats: List<AidenChat>)

    @Serializable
    private data class ChatCreateRequest(
        val workspaceId: String,
        val providerId: String? = null,
        val modelId: String? = null
    )

    @Serializable
    private data class ChatUpdateRequest(val title: String)

    @Serializable
    private data class ChatMoveRequest(
        val workspaceId: String,
        val confirmedForeground: Boolean = true
    )

    @Serializable
    private data class ApprovalRequest(val decision: AidenApprovalDecision)

    @Serializable
    private data class ScheduledTaskListResponse(val tasks: List<AidenScheduledTask>)

    @Serializable
    private data class ScheduledRunListResponse(val runs: List<AidenScheduledRun>)

    @Serializable
    private data class ScheduledScriptListResponse(val scripts: List<AidenScheduledScript>)

    @Serializable
    private data class ScheduledMcpServerListResponse(val servers: List<AidenScheduledMcpServer>)

    @Serializable
    private data class ScheduledPreviewRequest(
        val cron: String,
        val timezone: String,
        val count: Int
    )
}

@Serializable
data class AidenWorkspaceFileWriteRequest(
    val content: String,
    val expectedVersion: String
)

@Serializable
data class AidenGitDiffRequest(
    val snapshotId: String,
    val fileId: String
)

@Serializable
data class AidenGitCreateBranchRequest(
    val name: String,
    val startPoint: String,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenGitCheckoutRequest(
    val branch: String,
    val snapshotId: String,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenGitCommitRequest(
    val snapshotId: String,
    val message: String,
    val scope: String,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenGitPushRequest(
    val snapshotId: String,
    val remote: String,
    val branch: String,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenGitCompareRequest(
    val baseRef: String
)

@Serializable
data class AidenGitComparisonDiffRequest(
    val comparisonId: String,
    val fileId: String
)

@Serializable
data class AidenGitCreateWorktreeRequest(
    val branch: String,
    val name: String,
    val confirmedForeground: Boolean = true
)

@Serializable
data class AidenForegroundConfirmation(
    val confirmedForeground: Boolean = true
)

private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation {
        cancel()
    }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            continuation.resume(response)
        }
        override fun onFailure(call: Call, e: IOException) {
            continuation.resumeWithException(e)
        }
    })
}

private class ResponseBodyLimitExceededException : IOException("response body exceeds limit")

private fun ResponseBody?.readBounded(maximumBytes: Int): ByteArray {
    val body = this ?: return ByteArray(0)
    if (body.contentLength() > maximumBytes) throw ResponseBodyLimitExceededException()
    val output = ByteArrayOutputStream(minOf(maximumBytes, 64 * 1024))
    body.byteStream().use { input ->
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maximumBytes) throw ResponseBodyLimitExceededException()
            output.write(buffer, 0, read)
        }
    }
    return output.toByteArray()
}
