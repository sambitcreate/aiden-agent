package sbtbiswas.AidenOnTheGo.persistence

import java.security.MessageDigest

internal object AidenSha256 {
    fun hex(value: String): String = hex(value.toByteArray(Charsets.UTF_8))

    fun hex(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(value)
            .joinToString("") { "%02x".format(it) }
}
