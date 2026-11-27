package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.aidenPairingFailedTlsVerification
import sbtbiswas.AidenOnTheGo.models.AidenDeviceType
import sbtbiswas.AidenOnTheGo.models.AidenInstallation
import sbtbiswas.AidenOnTheGo.models.AidenPairingTrust
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.networking.AidenServerTrust
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.protocol.AidenManualPairingException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Pairing and paired requests over real TLS: a private CA and a leaf like the ones a LAN desktop
 * issues, served by MockWebServer, reached through the app's own clients with nothing injected.
 */
class AidenRemotePairingTlsTest {
    @get:Rule val temp = TemporaryFolder()

    private val servers = mutableListOf<MockWebServer>()
    private val ca = HeldCertificate.Builder().certificateAuthority(0).commonName("Aiden Agent Local CA").build()
    private val trust = AidenPairingTrust("private-ca", Base64.getEncoder().encodeToString(ca.certificate.encoded))

    @After
    fun teardown() {
        servers.forEach { it.shutdown() }
    }

    private fun leaf(vararg names: String): HeldCertificate =
        HeldCertificate.Builder().signedBy(ca).commonName("Aiden Agent Local").apply { names.forEach(::addSubjectAlternativeName) }.build()

    private fun httpsServer(leaf: HeldCertificate): MockWebServer {
        val certificates = HandshakeCertificates.Builder().heldCertificate(leaf, ca.certificate).build()
        return MockWebServer().also {
            it.useHttps(certificates.sslSocketFactory(), false)
            it.start()
            servers += it
        }
    }

    private fun endpoint(server: MockWebServer, host: String = "localhost") = "https://$host:${server.port}/api/aiden/v1"

    private fun pin(leaf: HeldCertificate) = AidenServerTrust.spkiSHA256(leaf.certificate)

    private fun b64url(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private val millis = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

    /** The QR payload a desktop writes, built as `JSON.stringify({kind, bootstrap, trust})`. */
    private fun payloadJson(endpoint: String, pin: String, expiresAt: String, instanceId: String = "desktop_lan") = buildJsonObject {
        put("kind", "aiden-pairing-v1")
        put("bootstrap", buildJsonObject {
            put("protocolVersion", 1)
            put("instanceId", instanceId)
            put("endpoint", endpoint)
            put("serverSpkiSha256", pin)
            put("secret", b64url(ByteArray(32) { (it * 7).toByte() }))
            put("expiresAt", expiresAt)
        })
        put("trust", buildJsonObject {
            put("mode", trust.mode)
            put("caCertificateDerBase64", trust.caCertificateDerBase64)
        })
    }.toString()

    /** Seals [plaintext] the way `main/services/aiden-remote-pairing.ts` does for a setup code. */
    private fun sealedBootstrap(code: String, plaintext: String, expiresAt: String, tamperTag: Boolean = false): String {
        val sessionId = "pairing_" + b64url(ByteArray(24) { (it + 1).toByte() })
        val salt = ByteArray(32) { (it * 3).toByte() }
        val nonce = ByteArray(12) { (it + 40).toByte() }
        val hmac = Mac.getInstance("HmacSHA256")
        hmac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = hmac.doFinal(code.toByteArray(Charsets.US_ASCII))
        hmac.init(SecretKeySpec(prk, "HmacSHA256"))
        val key = hmac.doFinal("aiden-manual-pairing-v1\n$sessionId".toByteArray() + byteArrayOf(1))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("aiden-manual-pairing-v1\n$sessionId\n$expiresAt".toByteArray())
        val sealed = cipher.doFinal(plaintext.toByteArray())
        val tag = sealed.takeLast(16).toByteArray().also { if (tamperTag) it[0] = (it[0].toInt() xor 1).toByte() }
        return buildJsonObject {
            put("kind", "aiden-manual-pairing-v1")
            put("protocolVersion", 1)
            put("sessionId", sessionId)
            put("expiresAt", expiresAt)
            put("salt", b64url(salt))
            put("nonce", b64url(nonce))
            put("ciphertext", b64url(sealed.dropLast(16).toByteArray()))
            put("tag", b64url(tag))
        }.toString()
    }

    private fun exchangeJson(endpoint: String, pin: String, instanceId: String = "desktop_lan") = buildJsonObject {
        put("protocolVersion", 1)
        put("instanceId", instanceId)
        put("deviceId", "device_phone")
        put("credential", b64url(ByteArray(32) { (it + 9).toByte() }))
        put("capabilities", buildJsonArray { add(JsonPrimitive("server:read")); add(JsonPrimitive("chat:read")) })
        put("endpoint", endpoint)
        put("serverSpkiSha256", pin)
        put("displayName", "Studio")
    }.toString()

    private fun serverJson(instanceId: String) =
        """{"protocolVersion":1,"instanceId":"$instanceId","name":"Studio","capabilities":["server:read"],"serverCapabilities":["server:read"],"appVersion":"1","connectionMode":"lan","serverTime":"2026-11-27T00:00:00.000Z"}"""

    private fun installation(endpoint: String, pin: String, instanceId: String = "desktop_lan") = AidenInstallation(
        instanceId = instanceId,
        deviceId = "device_phone",
        name = "Studio",
        endpoint = endpoint,
        serverSpkiSha256 = pin,
        pairingTrust = trust,
        deviceCapabilities = listOf(AidenRemoteCapability.SERVER_READ),
        serverCapabilities = listOf(AidenRemoteCapability.SERVER_READ),
        createdAt = Instant.now()
    )

    // A whole second makes the desktop's `.000Z` differ from Instant.toString(), as 1 in 1000 real windows do.
    private fun expiry() = millis.format(Instant.now().plusSeconds(120).truncatedTo(ChronoUnit.SECONDS))

    @Test
    fun setupCodePairsWithAPrivateCaLanDesktopAndATamperedEnvelopeFails() = runBlocking {
        val leaf = leaf("localhost")
        val server = httpsServer(leaf)
        val endpoint = endpoint(server)
        val code = "0123456789ABCDEFGHJK"
        val expiresAt = expiry()
        server.enqueue(MockResponse().setBody(sealedBootstrap(code, payloadJson(endpoint, pin(leaf), expiresAt), expiresAt)))
        server.enqueue(MockResponse().setBody(exchangeJson(endpoint, pin(leaf))))

        val result = AidenRemoteClient.pair(manualCode = "0123-4567-89AB-CDEF-GHJK", endpoint = endpoint, deviceName = "Phone", deviceType = AidenDeviceType.ANDROID_PHONE)

        assertEquals(pin(leaf), result.payload.bootstrap.serverSpkiSha256)
        assertEquals(trust, result.payload.trust)
        assertEquals("desktop_lan", result.exchange.instanceId)
        assertEquals("/api/aiden/v1/pairing/manual-bootstrap", server.takeRequest().path)
        assertEquals("/api/aiden/v1/pairing/exchange", server.takeRequest().path)

        server.enqueue(MockResponse().setBody(sealedBootstrap(code, payloadJson(endpoint, pin(leaf), expiresAt), expiresAt, tamperTag = true)))
        try {
            AidenRemoteClient.manualPairingPayload(code, endpoint)
            fail("A tampered envelope must not open")
        } catch (_: AidenManualPairingException.DecryptionFailed) {
        }
    }

    @Test
    fun pairedRequestsRefuseALeafThatDoesNotNameTheHostEvenWithTheRightPin() = runBlocking {
        val foreign = leaf("elsewhere.example")
        val foreignServer = httpsServer(foreign)
        foreignServer.enqueue(MockResponse().setBody(serverJson("desktop_lan")))
        val refused = AidenRemoteClient(installation(endpoint(foreignServer), pin(foreign)), "credential")
        try {
            refused.server()
            fail("A pinned leaf for another name must not be accepted")
        } catch (error: Exception) {
            assertTrue("The pairing screen reports it as an unverified desktop: $error", aidenPairingFailedTlsVerification(error))
        }
        assertEquals(0, foreignServer.requestCount)

        // The same CA and pin with the host in the SAN, by name or by IP literal, connect.
        val named = leaf("localhost", "127.0.0.1")
        val namedServer = httpsServer(named)
        namedServer.enqueue(MockResponse().setBody(serverJson("desktop_lan")))
        namedServer.enqueue(MockResponse().setBody(serverJson("desktop_lan")))
        assertEquals("Studio", AidenRemoteClient(installation(endpoint(namedServer), pin(named)), "credential").server().name)
        assertEquals("Studio", AidenRemoteClient(installation(endpoint(namedServer, "127.0.0.1"), pin(named)), "credential").server().name)
    }

    @Test
    fun neitherClientFollowsARedirectToAnotherServer() = runBlocking {
        val elsewhere = MockWebServer().also { it.start(); servers += it }
        elsewhere.enqueue(MockResponse().setBody(serverJson("desktop_lan")))
        elsewhere.enqueue(MockResponse().setBody("{}"))
        val leaf = leaf("localhost")
        val server = httpsServer(leaf)
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", elsewhere.url("/api/aiden/v1/server")))
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", elsewhere.url("/api/aiden/v1/pairing/manual-bootstrap")))

        try {
            AidenRemoteClient(installation(endpoint(server), pin(leaf)), "credential").server()
            fail("A redirect must not be followed")
        } catch (error: AidenRemoteClientException.Server) {
            assertEquals(302, error.statusCode)
        }
        try {
            AidenRemoteClient.manualPairingPayload("0123456789ABCDEFGHJK", endpoint(server))
            fail("A redirected setup-code request must not be followed")
        } catch (_: AidenManualPairingException.InvalidBootstrap) {
        }
        assertEquals(2, server.requestCount)
        assertEquals(0, elsewhere.requestCount)
    }

    @Test
    fun anExchangeForAnotherInstanceIsRefusedAndNothingIsStored() = runBlocking {
        val leaf = leaf("localhost")
        val server = httpsServer(leaf)
        val endpoint = endpoint(server)
        server.enqueue(MockResponse().setBody(exchangeJson(endpoint, pin(leaf), instanceId = "desktop_other")))
        val secure = InMemoryAidenSecureStore()
        val store = AidenInstallationStore(temp.root, secure)
        val scope = CoroutineScope(Dispatchers.Unconfined + Job())
        val coordinator = AidenRemoteCoordinator(store, temp.root, scope = scope)
        val payload = AidenRemoteClient.decodePairingPayload(payloadJson(endpoint, pin(leaf), expiry()))

        try {
            coordinator.pairWithQRCode(payload)
            fail("An exchange naming another desktop instance must be refused")
        } catch (_: AidenRemoteContractException.InvalidPairingExchange) {
        } finally {
            scope.cancel()
        }
        assertEquals(1, server.requestCount)
        assertTrue(store.installations.value.isEmpty())
        assertNull(store.activeInstallationId.value)
        assertNull(secure.getCredential("desktop_other:device_phone"))
        assertNull(secure.getCredential("desktop_lan:device_phone"))
    }

    @Test
    fun aServerAnswerFromAnotherInstanceStopsTheConnection() = runBlocking {
        // The first answer names another instance.
        connectExpectingInstanceMismatch(listOf(MockResponse().setBody(serverJson("desktop_other"))))
        // The answer re-read after the progress grants names another instance.
        val tasksServer = """{"protocolVersion":1,"instanceId":"desktop_lan","name":"Studio","capabilities":["server:read"],"serverCapabilities":["server:read","tasks:read"],"features":["chat-tasks-v1"],"appVersion":"1","connectionMode":"lan","serverTime":"2026-11-27T00:00:00.000Z"}"""
        val granted = connectExpectingInstanceMismatch(listOf(
            MockResponse().setBody(tasksServer),
            MockResponse().setBody("""{"capabilities":["server:read","tasks:read"]}"""),
            MockResponse().setBody(serverJson("desktop_other"))
        ))
        assertTrue(AidenRemoteCapability.TASKS_READ !in granted.deviceCapabilities)
    }

    // F4: only a decoded `credential_revoked` forgets the pairing, as on iOS.
    @Test
    fun onlyARevokedCredentialForgetsThePairing() = runBlocking {
        fun envelope(code: String) = """{"error":{"code":"$code","message":"Nope.","requestId":"req_1","retryable":false}}"""
        // Each answer, whether the pairing stays, and whether the banner offers Pair again.
        val cases = listOf(
            Triple(MockResponse().setResponseCode(403).setBody(envelope("capability_denied")), true, false),
            Triple(MockResponse().setResponseCode(401).setBody("not json"), true, false),
            // The computer forgot this device: the pairing stays, retrying can't help, Pair again can.
            Triple(MockResponse().setResponseCode(401).setBody(envelope("authentication_required")), true, true),
            Triple(MockResponse().setResponseCode(403).setBody(envelope("credential_revoked")), false, false)
        )
        for ((response, kept, pairAgain) in cases) {
            val leaf = leaf("localhost")
            val server = httpsServer(leaf)
            server.enqueue(response)
            val root = temp.newFolder()
            val secure = InMemoryAidenSecureStore()
            val store = AidenInstallationStore(root, secure)
            store.addInstallation(
                sbtbiswas.AidenOnTheGo.models.AidenPairingExchange(
                    instanceId = "desktop_lan", deviceId = "device_phone", credential = b64url(ByteArray(32)),
                    capabilities = listOf(AidenRemoteCapability.SERVER_READ), endpoint = endpoint(server),
                    serverSpkiSha256 = pin(leaf), displayName = "Studio"
                ),
                trust
            )
            val scope = CoroutineScope(Dispatchers.IO + Job())
            try {
                val coordinator = AidenRemoteCoordinator(store, root, scope = scope)
                withTimeout(10_000) {
                    while (coordinator.connectionState.value == AidenConnectionState.CONNECTING) delay(10)
                }
                val label = "${response.status} kept=$kept"
                assertEquals(label, if (kept) AidenConnectionState.OFFLINE else AidenConnectionState.NEEDS_PAIRING, coordinator.connectionState.value)
                assertEquals(label, kept, store.installations.value.any { it.instanceId == "desktop_lan" })
                assertEquals(label, kept, secure.getCredential("desktop_lan:device_phone") != null)
                if (kept) {
                    val issue = coordinator.connectionIssue.value!!
                    assertEquals(label, pairAgain, issue.pairAgain)
                    assertEquals(label, !pairAgain, issue.canRetry)
                }
            } finally {
                scope.cancel()
            }
        }
    }

    private suspend fun connectExpectingInstanceMismatch(responses: List<MockResponse>): AidenInstallation {
        val leaf = leaf("localhost")
        val server = httpsServer(leaf)
        responses.forEach(server::enqueue)
        val root = temp.newFolder()
        val store = AidenInstallationStore(root, InMemoryAidenSecureStore())
        store.addInstallation(
            sbtbiswas.AidenOnTheGo.models.AidenPairingExchange(
                instanceId = "desktop_lan", deviceId = "device_phone", credential = b64url(ByteArray(32)),
                capabilities = listOf(AidenRemoteCapability.SERVER_READ), endpoint = endpoint(server),
                serverSpkiSha256 = pin(leaf), displayName = "Studio"
            ),
            trust
        )
        val scope = CoroutineScope(Dispatchers.IO + Job())
        try {
            val coordinator = AidenRemoteCoordinator(store, root, scope = scope)
            withTimeout(10_000) {
                while (coordinator.connectionState.value != AidenConnectionState.OFFLINE && coordinator.serverInfo.value == null) delay(10)
            }
            assertEquals(responses.size, server.requestCount)
            assertEquals(AidenConnectionState.OFFLINE, coordinator.connectionState.value)
            assertNull(coordinator.serverInfo.value)
            if (responses.size == 1) assertNull(store.activeInstallation?.serverFeatures)
            return store.activeInstallation!!
        } finally {
            scope.cancel()
        }
    }
}
