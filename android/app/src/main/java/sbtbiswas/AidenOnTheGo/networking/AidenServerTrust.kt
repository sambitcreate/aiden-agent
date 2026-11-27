package sbtbiswas.AidenOnTheGo.networking

import sbtbiswas.AidenOnTheGo.protocol.AidenPairingBootstrapException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.io.ByteArrayInputStream
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Instant
import java.util.Base64
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

sealed class AidenServerTrustPolicy {
    object System : AidenServerTrustPolicy()
    data class PrivateCA(val caCertificateDER: ByteArray) : AidenServerTrustPolicy() {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (javaClass != other?.javaClass) return false
            other as PrivateCA
            return caCertificateDER.contentEquals(other.caCertificateDER)
        }
        override fun hashCode(): Int = caCertificateDER.contentHashCode()
    }
}

object AidenServerTrust {
    private val cf = CertificateFactory.getInstance("X.509")

    fun spkiSHA256(certificate: X509Certificate): String {
        val spkiBytes = certificate.publicKey.encoded
        val digest = MessageDigest.getInstance("SHA-256").digest(spkiBytes)
        val base64 = Base64.getEncoder().encodeToString(digest)
        return "sha256/$base64"
    }

    fun spkiSHA256(p256ExternalRepresentation: ByteArray): String {
        if (p256ExternalRepresentation.size != 65 || p256ExternalRepresentation[0] != 0x04.toByte()) {
            throw IllegalArgumentException("Invalid P-256 uncompressed external representation")
        }
        val p256SpkiHeader = byteArrayOf(
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x02, 0x01,
            0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00
        )
        val spkiBytes = p256SpkiHeader + p256ExternalRepresentation
        val digest = MessageDigest.getInstance("SHA-256").digest(spkiBytes)
        return "sha256/" + Base64.getEncoder().encodeToString(digest)
    }

    fun parseCertificate(derBytes: ByteArray): X509Certificate {
        return cf.generateCertificate(ByteArrayInputStream(derBytes)) as X509Certificate
    }

    fun evaluate(
        chain: Array<X509Certificate>,
        expectedHost: String,
        expectedFingerprint: String,
        policy: AidenServerTrustPolicy,
        verificationDate: Instant? = null
    ) {
        if (chain.isEmpty()) throw SSLPeerUnverifiedException("Certificate chain is empty")
        val leaf = chain[0]

        // 1. Check expiration / validity date
        val checkTime = verificationDate?.toEpochMilli() ?: System.currentTimeMillis()
        val checkDate = java.util.Date(checkTime)
        leaf.checkValidity(checkDate)

        // 2. Evaluate SPKI Pinning
        val actualPin = spkiSHA256(leaf)
        if (!MessageDigest.isEqual(actualPin.toByteArray(Charsets.UTF_8), expectedFingerprint.toByteArray(Charsets.UTF_8))) {
            throw SSLPeerUnverifiedException("SPKI SHA-256 fingerprint mismatch. Expected $expectedFingerprint, got $actualPin")
        }

        // 3. Evaluate Host matching (Subject Alternative Names or Common Name)
        if (expectedHost.isNotEmpty() && !matchesHost(leaf, expectedHost)) {
            throw SSLPeerUnverifiedException("Certificate subject does not match host $expectedHost")
        }

        // 4. Policy evaluation
        when (policy) {
            is AidenServerTrustPolicy.System -> {
                // If system policy, leaf or intermediate must be trusted by system trust manager
                val systemTrustManager = getSystemTrustManager()
                try {
                    systemTrustManager.checkServerTrusted(chain, "ECDHE_ECDSA")
                } catch (e: Exception) {
                    try {
                        systemTrustManager.checkServerTrusted(chain, "RSA")
                    } catch (_: Exception) {
                        throw SSLPeerUnverifiedException("Chain not trusted by system root store: ${e.message}")
                    }
                }
            }
            is AidenServerTrustPolicy.PrivateCA -> {
                val caCert = parseCertificate(policy.caCertificateDER)
                caCert.checkValidity(checkDate)
                // Verify leaf is issued by this CA
                try {
                    leaf.verify(caCert.publicKey)
                } catch (e: Exception) {
                    // Check if CA is directly in chain
                    var verified = false
                    for (parent in chain) {
                        try {
                            if (parent == caCert || parent.publicKey == caCert.publicKey) {
                                leaf.verify(parent.publicKey)
                                verified = true
                                break
                            }
                        } catch (_: Exception) {}
                    }
                    if (!verified) {
                        throw SSLPeerUnverifiedException("Certificate was not signed by the pinned private CA: ${e.message}")
                    }
                }
            }
        }
    }

    fun isCanonicalEndpoint(endpointStr: String): Boolean {
        return AidenRemoteProtocol.isCanonicalAidenEndpoint(endpointStr)
    }

    private fun isCanonicalAuthority(value: String): Boolean {
        if (value.any { it.code <= 0x20 || it.code > 0x7F }) return false
        val host: String
        val port: Int?
        if (value.startsWith("[")) {
            val closeIndex = value.indexOf(']')
            if (closeIndex <= 1) return false
            host = value.substring(1, closeIndex)
            val remainder = value.substring(closeIndex + 1)
            if (remainder.isNotEmpty()) {
                if (!remainder.startsWith(":")) return false
                val portStr = remainder.drop(1)
                port = portStr.toIntOrNull() ?: return false
                if (port !in 1..AidenRemoteProtocol.MAX_ENDPOINT_PORT || portStr.startsWith("0")) return false
            } else {
                port = null
            }
            if (!isCanonicalIPv6(host)) return false
        } else {
            if (value.contains("[") || value.contains("]")) return false
            if (value.contains(":")) {
                val parts = value.split(":")
                if (parts.size != 2) return false
                host = parts[0]
                val portStr = parts[1]
                port = portStr.toIntOrNull() ?: return false
                if (port !in 1..AidenRemoteProtocol.MAX_ENDPOINT_PORT || portStr.startsWith("0")) return false
            } else {
                host = value
                port = null
            }
            if (!isCanonicalDNSHost(host) && !isCanonicalIPv4(host)) return false
        }
        return true
    }

    private fun isCanonicalDNSHost(host: String): Boolean {
        if (host.isEmpty() || host.length > 253) return false
        val labels = host.split(".")
        if (labels.any { it.isEmpty() }) return false
        if (labels.all { label -> label.all { it in '0'..'9' } }) {
            return isCanonicalIPv4(host)
        }
        if (labels.last().all { it in '0'..'9' }) return false
        return labels.all { label ->
            label.length in 1..63 &&
                    label.first().isLetterOrDigit() &&
                    label.last().isLetterOrDigit() &&
                    label.all { it.isLetterOrDigit() || it == '-' }
        }
    }

    private fun isCanonicalIPv4(value: String): Boolean {
        val octets = value.split(".")
        if (octets.size != 4) return false
        return octets.all { octet ->
            if (octet.isEmpty() || octet.length > 3 || !octet.all { it in '0'..'9' }) return false
            if (octet.length > 1 && octet.startsWith("0")) return false
            val num = octet.toIntOrNull() ?: return false
            num in 0..255
        }
    }

    private fun isCanonicalIPv6(value: String): Boolean {
        if (value.isEmpty()) return false
        val parts = value.split("::")
        if (parts.size > 2) return false
        return true
    }

    /**
     * Whether the leaf names [host] in its subject alternative names, the way TLS hostname
     * verification reads them: an IP literal matches an IP entry by address, a DNS name matches a
     * DNS entry case-insensitively, and a wildcard covers exactly one left-most label.
     */
    private fun matchesHost(cert: X509Certificate, host: String): Boolean {
        val target = host.trim('[', ']').lowercase(java.util.Locale.US).trimEnd('.')
        val targetAddress = ipLiteralBytes(target)
        val altNames = try {
            cert.subjectAlternativeNames
        } catch (_: Exception) {
            null
        } ?: return false
        for (item in altNames) {
            val type = item.getOrNull(0) as? Int ?: continue
            val name = item.getOrNull(1) as? String ?: continue
            when {
                type == SAN_IP_ADDRESS && targetAddress != null ->
                    if (ipLiteralBytes(name.trim('[', ']'))?.contentEquals(targetAddress) == true) return true
                type == SAN_DNS_NAME && targetAddress == null ->
                    if (dnsNameMatches(name.lowercase(java.util.Locale.US).trimEnd('.'), target)) return true
            }
        }
        return false
    }

    private const val SAN_DNS_NAME = 2
    private const val SAN_IP_ADDRESS = 7

    private fun dnsNameMatches(pattern: String, host: String): Boolean {
        if (!pattern.startsWith("*.")) return pattern == host
        val suffix = pattern.substring(1)
        if (suffix.count { it == '.' } < 2) return false
        val label = host.removeSuffix(suffix)
        return host.endsWith(suffix) && label.isNotEmpty() && !label.contains('.')
    }

    /** The address bytes of an IPv4 or IPv6 literal, or null for a name. Never touches DNS. */
    private fun ipLiteralBytes(value: String): ByteArray? {
        val isIPv4 = value.matches(Regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$"))
        val isIPv6 = value.contains(':') && value.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' || it == ':' || it == '.' }
        if (!isIPv4 && !isIPv6) return null
        return try {
            java.net.InetAddress.getByName(value).address
        } catch (_: Exception) {
            null
        }
    }

    private fun getSystemTrustManager(): X509TrustManager {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        return tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
    }
}
