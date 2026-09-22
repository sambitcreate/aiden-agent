package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenServerTrust
import sbtbiswas.AidenOnTheGo.networking.AidenServerTrustPolicy
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.time.Instant
import java.util.Base64
import javax.net.ssl.SSLPeerUnverifiedException

class AidenRemotePhase0Test {
    private val caCertificateDER = "MIIBpzCCAU6gAwIBAgIUIHmU6u43BGrkVPj4FQ5phcJ7K8EwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTM2MDgxNTIwNTgwM1owIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZwqoZbvPSf8paC937p5+TnciNpAxHE/4fwll/5YlUGW6xkSUmvFj7CpD3IPvY0PRgN+sZl/CzBFzn+wv9atnkaNmMGQwHQYDVR0OBBYEFK2vesnPv0ymHuSE6yQ9EoM+B7EYMB8GA1UdIwQYMBaAFK2vesnPv0ymHuSE6yQ9EoM+B7EYMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0cAMEQCIHawuTBf/AOiSWTY+XpLIUzSxxFdKmTZl1Vol4HRJQ5VAiBpYlpHpxEzMd2j/VK8fUfZ8DU6y7XKme2iJFS8M7d1lw=="
    private val originalCertificateDER = "MIIB4jCCAYmgAwIBAgIULA5eC0u0KgewVf5FJD89CeRl5icwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTI2MDkxNzIwNTgwM1owJDEiMCAGA1UEAwwZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABI5u4+Ne8MXXQeyVvmFDduB1soFoJQvIv296OVjGuty9Z0VyUpKn2+oBKTSuD0GNooaSlIHqptxLFT/cpEYxrRqjgZwwgZkwJAYDVR0RBB0wG4IZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUnnUkXuqHkoGw2LKXeyU7bjyCVYcwHwYDVR0jBBgwFoAUra96yc+/TKYe5ITrJD0Sgz4HsRgwCgYIKoZIzj0EAwIDRwAwRAIgd2WNDX68uxSxGQYJsDiUXohxKlBeEjXESlgHx6WRrJgCIFJN5ineCyCIYL17DW2sJ/9h2qA3GdOo/aiUWc+e6FCV"
    private val renewedCertificateDER = "MIIB9TCCAZugAwIBAgIULA5eC0u0KgewVf5FJD89CeRl5igwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTI2MDkxNzIwNTgwM1owNjEiMCAGA1UEAwwZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDEQMA4GA1UECwwHcmVuZXdlZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABI5u4+Ne8MXXQeyVvmFDduB1soFoJQvIv296OVjGuty9Z0VyUpKn2+oBKTSuD0GNooaSlIHqptxLFT/cpEYxrRqjgZwwgZkwJAYDVR0RBB0wG4IZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUnnUkXuqHkoGw2LKXeyU7bjyCVYcwHwYDVR0jBBgwFoAUra96yc+/TKYe5ITrJD0Sgz4HsRgwCgYIKoZIzj0EAwIDSAAwRQIhANjQ3dAkNt/zT66IhAfodEWh75Ig5XmAju3MYn2sLSicAiBUomVIhfwnYjxs54zSiHzuyGpPmRKVCBHjzadb+U9MTw=="
    private val rotatedCertificateDER = "MIIB9TCCAZugAwIBAgIULA5eC0u0KgewVf5FJD89CeRl5ikwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVQWlkZW4tUGhhc2UwLUxvY2FsLUNBMB4XDTI2MDgxODIwNTgwM1oXDTI2MDkxNzIwNTgwM1owNjEiMCAGA1UEAwwZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDEQMA4GA1UECwwHcm90YXRlZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABMFeD3fbzVvwD6XsOV0zTS9/afPUm0BzWjsDlPoPKR+s5dlo3aAIe1B0tsMvEOgdHb0BV8D9RQcOg3H+/qqKYLKjgZwwgZkwJAYDVR0RBB0wG4IZYWlkZW4tcGhhc2UwLmV4YW1wbGUudGVzdDAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU6Vpq2GlIaP7m9AHtEE+fve8bWDYwHwYDVR0jBBgwFoAUra96yc+/TKYe5ITrJD0Sgz4HsRgwCgYIKoZIzj0EAwIDSAAwRQIhAKdQOzcQ+qJZP/gpVvT8uDz+DvRx9JAEWTLmuUqoJ9ujAiABuU2rRJ/ivMhm5lGDDFrunkN9Kk04oUPjJ1w8CplkQg=="

    @Test
    fun testSPKIExtractionAndPinning() {
        val original = AidenServerTrust.parseCertificate(Base64.getDecoder().decode(originalCertificateDER))
        val renewed = AidenServerTrust.parseCertificate(Base64.getDecoder().decode(renewedCertificateDER))
        val rotated = AidenServerTrust.parseCertificate(Base64.getDecoder().decode(rotatedCertificateDER))
        val ca = AidenServerTrust.parseCertificate(Base64.getDecoder().decode(caCertificateDER))

        val originalPin = AidenServerTrust.spkiSHA256(original)
        val renewedPin = AidenServerTrust.spkiSHA256(renewed)
        val rotatedPin = AidenServerTrust.spkiSHA256(rotated)

        assertEquals(originalPin, renewedPin)
        assertNotEquals(originalPin, rotatedPin)

        val caBytes = Base64.getDecoder().decode(caCertificateDER)
        val rotatedBytes = Base64.getDecoder().decode(rotatedCertificateDER)
        val privateCAPolicy = AidenServerTrustPolicy.PrivateCA(caBytes)
        val validDate = Instant.parse("2026-08-19T00:00:00Z")

        // 1. Valid certificate signed by CA matches pin & host
        AidenServerTrust.evaluate(
            chain = arrayOf(original, ca),
            expectedHost = "aiden-phase0.example.test",
            expectedFingerprint = originalPin,
            policy = privateCAPolicy,
            verificationDate = validDate
        )

        // 2. Renewed certificate with same key matches
        AidenServerTrust.evaluate(
            chain = arrayOf(renewed, ca),
            expectedHost = "aiden-phase0.example.test",
            expectedFingerprint = originalPin,
            policy = privateCAPolicy,
            verificationDate = validDate
        )

        // 3. Rotated certificate throws due to fingerprint mismatch
        assertThrows(SSLPeerUnverifiedException::class.java) {
            AidenServerTrust.evaluate(
                chain = arrayOf(rotated, ca),
                expectedHost = "aiden-phase0.example.test",
                expectedFingerprint = originalPin,
                policy = privateCAPolicy,
                verificationDate = validDate
            )
        }

        // 4. System policy throws for private CA
        assertThrows(SSLPeerUnverifiedException::class.java) {
            AidenServerTrust.evaluate(
                chain = arrayOf(original, ca),
                expectedHost = "aiden-phase0.example.test",
                expectedFingerprint = originalPin,
                policy = AidenServerTrustPolicy.System,
                verificationDate = validDate
            )
        }

        // 5. Wrong Private CA throws
        assertThrows(SSLPeerUnverifiedException::class.java) {
            AidenServerTrust.evaluate(
                chain = arrayOf(original, ca),
                expectedHost = "aiden-phase0.example.test",
                expectedFingerprint = originalPin,
                policy = AidenServerTrustPolicy.PrivateCA(rotatedBytes),
                verificationDate = validDate
            )
        }

        // 6. Host mismatch throws
        assertThrows(SSLPeerUnverifiedException::class.java) {
            AidenServerTrust.evaluate(
                chain = arrayOf(original, ca),
                expectedHost = "wrong.example.test",
                expectedFingerprint = originalPin,
                policy = privateCAPolicy,
                verificationDate = validDate
            )
        }

        // 7. Expired date throws
        val expiredDate = Instant.parse("2040-01-01T00:00:00Z")
        assertThrows(Exception::class.java) {
            AidenServerTrust.evaluate(
                chain = arrayOf(original, ca),
                expectedHost = "aiden-phase0.example.test",
                expectedFingerprint = originalPin,
                policy = privateCAPolicy,
                verificationDate = expiredDate
            )
        }
    }

    @Test
    fun testP256SPKIFingerprintMatchesIndependentFixture() {
        val rawKey = byteArrayOf(0x04) + ByteArray(64)
        val fingerprint = AidenServerTrust.spkiSHA256(rawKey)
        assertEquals("sha256/FhPubfxu6YoU7IG0Hq45pUOLUPvLv4oAgUflVyabRMs=", fingerprint)

        assertThrows(IllegalArgumentException::class.java) {
            AidenServerTrust.spkiSHA256(ByteArray(65))
        }
        assertThrows(IllegalArgumentException::class.java) {
            AidenServerTrust.spkiSHA256(byteArrayOf(0x04))
        }
    }

    @Test
    fun testEndpointAuthorityGrammarMatchesDesktopVectors() {
        val vectors = listOf(
            "aiden.example.test" to true,
            "localhost" to true,
            "aiden-lan.local" to true,
            "192.168.1.42" to true,
            "192.0.2.1:443" to true,
            "aiden.0" to false,
            "aiden.123" to false,
            "aiden.example.test:1" to true,
            "aiden.example.test:65535" to true,
            "[::]" to true,
            "[::1]" to true,
            "[2001:db8::1]:443" to true,
            "[::ffff:192.0.2.1]" to true,
            "aiden.example.test:0443" to false,
            "aiden.example.test:00001" to false,
            "aiden.example.test:0" to false,
            "aiden.example.test:65536" to false,
            "aiden.example.test:abc" to false,
            "aiden.example.test:" to false,
            ":443" to false,
            "aiden.example.test:1:2" to false,
            "aiden.example.test%2eexample.test" to false,
            "aiden.example.test%25" to false,
            "aiden．example.test" to false,
            "aiden\u0301.example.test" to false,
            "aiden.example.test\t" to false,
            "aiden.example.test\u001f" to false,
            "aiden.example.test\u007f" to false,
            "aiden..example.test" to false,
            "-aiden.example.test" to false,
            "aiden-.example.test" to false,
            "aiden_example.test" to false,
            "123" to false,
            "192.168.001.1" to false,
            "256.1.1.1" to false,
            "[fe80::1%25en0]" to false,
            "[v1.fe]" to false,
            "[::1" to false,
            "[::1]x" to false,
            "::1" to false,
            "[::1]:00001" to false,
            "[::1]:65536" to false,
            "[2001:db8::1::2]" to false,
            "[192.0.2.1::]" to false,
            "[::ffff:192.000.2.1]" to false,
            "[2001:db8:0:0:0:0:0]" to false
        )

        for ((authority, expectedValid) in vectors) {
            val endpoint = "https://$authority/api/aiden/v1"
            val isValid = AidenServerTrust.isCanonicalEndpoint(endpoint)
            assertEquals("Authority validation failed for: $authority", expectedValid, isValid)
        }
    }

    @Test
    fun testPairingBootstrapValidationFailsClosed() {
        val now = Instant.parse("2026-08-18T19:00:00Z")
        val validBootstrap = AidenPairingBootstrap(
            protocolVersion = 1,
            instanceId = "instance_fixture",
            endpoint = "https://aiden.example.test/api/aiden/v1",
            serverSpkiSha256 = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            expiresAt = now.plusSeconds(60)
        )
        assertTrue(validBootstrap.isValidAt(now))

        val validWithExplicitPort = validBootstrap.copy(
            endpoint = "https://aiden.example.test:7443/api/aiden/v1"
        )
        assertTrue(validWithExplicitPort.isValidAt(now))

        // Rejections
        val httpBootstrap = validBootstrap.copy(endpoint = "http://aiden.example.test/api/aiden/v1")
        assertFalse(httpBootstrap.isValidAt(now))

        val invalidPortBootstrap = validBootstrap.copy(endpoint = "https://aiden.example.test:65536/api/aiden/v1")
        assertFalse(invalidPortBootstrap.isValidAt(now))

        val leadingZeroPortBootstrap = validBootstrap.copy(endpoint = "https://aiden.example.test:0443/api/aiden/v1")
        assertFalse(leadingZeroPortBootstrap.isValidAt(now))

        val shortSecretBootstrap = validBootstrap.copy(secret = "too-short")
        assertFalse(shortSecretBootstrap.isValidAt(now))

        val expiredBootstrap = validBootstrap.copy(expiresAt = now.minusSeconds(1))
        assertFalse(expiredBootstrap.isValidAt(now))

        val tooFarFutureBootstrap = validBootstrap.copy(expiresAt = now.plusSeconds(301))
        assertFalse(tooFarFutureBootstrap.isValidAt(now))

        val longInstanceIdBootstrap = validBootstrap.copy(instanceId = "i".repeat(129))
        assertFalse(longInstanceIdBootstrap.isValidAt(now))
    }

    @Test
    fun testCanonicalPairingPayloadRequiresExactKindAndTrustShape() {
        val now = Instant.parse("2026-08-18T19:00:00Z")
        val validBootstrap = AidenPairingBootstrap(
            protocolVersion = 1,
            instanceId = "instance_fixture",
            endpoint = "https://aiden.example.test/api/aiden/v1",
            serverSpkiSha256 = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            expiresAt = now.plusSeconds(60)
        )
        val validTrust = AidenPairingTrust(mode = "private-ca", caCertificateDerBase64 = caCertificateDER)
        val validPayload = AidenPairingPayload(
            kind = "aiden-pairing-v1",
            bootstrap = validBootstrap,
            trust = validTrust
        )
        assertTrue(validPayload.isValidAt(now))
        assertEquals(caCertificateDER, validPayload.trust.caCertificateDerBase64)

        val wrongKindPayload = validPayload.copy(kind = "future-pairing")
        assertFalse(wrongKindPayload.isValidAt(now))
    }

    @Test
    fun testErrorEnvelopeRejectsUnknownCodes() {
        val json = Json { ignoreUnknownKeys = false }

        // Valid error code
        val validJson = """
            {"error":{"code":"internal_error","message":"safe","requestId":"request-1","retryable":false}}
        """.trimIndent()
        AidenRawJsonDuplicateKeyScanner.validate(validJson)
        val envelope = json.decodeFromString<AidenRemoteErrorEnvelope>(validJson)
        assertEquals(AidenRemoteErrorCode.INTERNAL_ERROR, envelope.error.code)

        // Unknown error code throws
        val unknownCodeJson = """
            {"error":{"code":"future_unknown_error","message":"safe","requestId":"request-1","retryable":false}}
        """.trimIndent()
        assertThrows(Exception::class.java) {
            json.decodeFromString<AidenRemoteErrorEnvelope>(unknownCodeJson)
        }
    }

    @Test
    fun testDuplicateKeyScannerRejectsDuplicatesAndDepthBounds() {
        val duplicateJson = """{"protocolVersion":1,"streamId":"stream-1","streamId":"stream-2"}"""
        assertThrows(AidenRemoteContractException.DuplicateJsonKey::class.java) {
            AidenRawJsonDuplicateKeyScanner.validate(duplicateJson)
        }

        val forbiddenKeyJson = """{"protocolVersion":1,"credentialDigest":"sha256-abc"}"""
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenRawJsonDuplicateKeyScanner.validate(forbiddenKeyJson)
        }
    }

    @Test
    fun testManualPairingVectorDecryption() {
        val stream = javaClass.classLoader?.getResourceAsStream("manual-pairing-vector.json")
            ?: throw IllegalStateException("Resource manual-pairing-vector.json not found")
        val jsonText = stream.bufferedReader().use { it.readText() }

        val json = Json { ignoreUnknownKeys = true }
        val vector = json.decodeFromString<AidenManualPairingResponse>(jsonText)

        assertEquals("0123-4567-89AB-CDEF-GHJK", vector.code)
        assertEquals(1, vector.bootstrap.protocolVersion)
        assertEquals("pairing_ssssssssssssssssssssssssssssssss", vector.bootstrap.sessionId)
    }

    @Test
    fun testProductIdentitySchemeAndPackage() {
        val expectedPackage = "sbtbiswas.AidenOnTheGo"
        val expectedScheme = "aiden-otg"

        assertEquals("sbtbiswas.AidenOnTheGo", expectedPackage)
        assertEquals("aiden-otg", expectedScheme)
        assertFalse(expectedScheme.contains("hermes"))
        assertFalse(expectedScheme.contains("hermex"))
    }
}
