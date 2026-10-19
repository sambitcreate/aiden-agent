package sbtbiswas.AidenOnTheGo.persistence

import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.io.File
import java.security.MessageDigest

/** Identifies one cached viewer document: the pairing, chat, visual, scheme and theme. */
data class AidenVisualDocumentKey(
    /** The paired Mac and this phone's pairing, so a re-pair never reads another pairing's copy. */
    val hostIdentity: String,
    val chatId: String,
    val visualId: String,
    val scheme: String,
    val theme: String
) {
    /** SHA-256 hex of the fields, NUL-separated so no two keys can run together. */
    val fileName: String
        get() = MessageDigest.getInstance("SHA-256")
            .digest(listOf(hostIdentity, chatId, visualId, scheme, theme).joinToString("\u0000").toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}

/**
 * The last viewer document per [AidenVisualDocumentKey], shown when the Mac is
 * unreachable (contract revision 35, "Offline"). Plain JVM code over [directory]
 * (the app's caches directory in production). At most [maximumEntries] files and
 * [maximumTotalBytes] in all are kept; the least recently used go first. Reads
 * and writes mark a file used. Cache failures never block the live document.
 * [purgeAll] runs when any pairing is removed or revoked; a load that started
 * before it cannot write its document back afterwards.
 */
class AidenVisualDocumentCache(
    private val directory: File,
    private val maximumEntries: Int = 20,
    private val maximumTotalBytes: Long = 40L * 1_024 * 1_024,
    private val maximumEntryBytes: Int = 12 * 1_024 * 1_024,
    private val clock: () -> Long = System::currentTimeMillis
) {
    private var lastStamp = 0L

    /** Bumped by [purgeAll]; a store for an older generation is refused. */
    @Volatile
    var generation = 0L
        private set
    private var stampInitialized = false

    init {
        require(maximumEntries > 0) { "Entry limit must be positive" }
        require(maximumTotalBytes > 0) { "Size limit must be positive" }
        require(maximumEntryBytes > 0) { "Entry size limit must be positive" }
    }

    @Synchronized
    fun load(key: AidenVisualDocumentKey): String? = try {
        val file = file(key)
        if (!file.isFile || file.length() !in 1..maximumEntryBytes.toLong()) {
            null
        } else {
            val html = file.readBytes().toString(Charsets.UTF_8)
            file.setLastModified(nextStamp())
            html
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Returns false when the document was too large to keep, the write failed, or
     * the cache was purged since [expectedGeneration] was read.
     */
    @Synchronized
    fun store(key: AidenVisualDocumentKey, html: String, expectedGeneration: Long = generation): Boolean = try {
        val target = file(key)
        val bytes = html.toByteArray(Charsets.UTF_8)
        if (expectedGeneration != generation) {
            false
        } else if (bytes.isEmpty() || bytes.size > maximumEntryBytes || bytes.size > maximumTotalBytes) {
            // A stale copy must not outlive a newer document that could not be kept.
            target.delete()
            false
        } else {
            directory.mkdirs()
            val temporary = File(directory, ".${target.name}.tmp")
            temporary.writeBytes(bytes)
            if (target.exists()) target.delete()
            if (!temporary.renameTo(target)) {
                temporary.delete()
                false
            } else {
                target.setLastModified(nextStamp())
                evictOverflow()
                true
            }
        }
    } catch (_: Exception) {
        false
    }

    @Synchronized
    fun remove(key: AidenVisualDocumentKey) {
        file(key).delete()
    }

    /** Drops every saved document; called when a pairing is removed or revoked. */
    @Synchronized
    fun purgeAll() {
        generation++
        try {
            directory.listFiles()?.forEach { if (it.isFile) it.delete() }
        } catch (_: Exception) {
        }
    }

    private fun evictOverflow() {
        val entries = directory.listFiles { file -> file.isFile && file.extension == EXTENSION }
            ?.sortedWith(compareByDescending<File> { it.lastModified() }.thenByDescending { it.name })
            ?: return
        var count = 0
        var total = 0L
        for (entry in entries) {
            val size = entry.length()
            if (count < maximumEntries && total + size <= maximumTotalBytes) {
                count++
                total += size
            } else {
                entry.delete()
            }
        }
    }

    // A strictly increasing file time orders eviction by use. Steps are a whole second
    // so file systems with coarse modification times keep the order, and the first
    // stamp after launch continues from the newest file already on disk.
    private fun nextStamp(): Long {
        if (!stampInitialized) {
            stampInitialized = true
            val newest = directory.listFiles { file -> file.isFile && file.extension == EXTENSION }
                ?.maxOfOrNull { it.lastModified() } ?: 0L
            lastStamp = maxOf(lastStamp, newest)
        }
        lastStamp = maxOf(clock(), lastStamp + 1_000)
        return lastStamp
    }

    private fun file(key: AidenVisualDocumentKey): File = File(directory, "${key.fileName}.$EXTENSION")

    private companion object {
        const val EXTENSION = "html"
    }
}

/** What the viewer shows after one load attempt. */
sealed interface AidenVisualDocumentLoad {
    /** The Mac's current document, now also cached. */
    data class Fresh(val html: String) : AidenVisualDocumentLoad

    /** The Mac could not be reached; the last cached copy, which may be out of date. */
    data class Cached(val html: String) : AidenVisualDocumentLoad

    /** Nothing to show. [unavailable] is the Mac's `not_found`: the visual or the viewer is gone. */
    data class Failed(val unavailable: Boolean) : AidenVisualDocumentLoad
}

/** Why a viewer document fetch failed, which decides whether the cached copy may be shown. */
enum class AidenVisualDocumentFailure {
    /** The Mac's `404`: the chat, the visual or the viewer is gone. */
    NOT_FOUND,

    /** The Mac answered and refused (auth, revocation, a bad request) or broke the contract. */
    DENIED,

    /** The Mac could not be reached or failed transiently; the cached copy may be shown. */
    UNREACHABLE;

    companion object {
        fun classify(error: Throwable): AidenVisualDocumentFailure = when (error) {
            is AidenRemoteClientException.Server -> when {
                error.statusCode == 404 -> NOT_FOUND
                error.statusCode == 408 || error.statusCode == 429 || error.statusCode >= 500 -> UNREACHABLE
                else -> DENIED
            }
            is AidenRemoteClientException.UnexpectedStatus ->
                if (error.statusCode == 408 || error.statusCode == 429 || error.statusCode >= 500) UNREACHABLE else DENIED
            is AidenRemoteClientException.InvalidResponse,
            AidenRemoteClientException.MissingCredential,
            AidenRemoteClientException.MissingTrustConfiguration,
            AidenRemoteClientException.InvalidEndpoint -> DENIED
            else -> UNREACHABLE
        }
    }
}

/**
 * Fetches a viewer document and keeps the cache in step: a fresh document replaces
 * the cached copy; only an unreachable Mac falls back to it. A `404` or a refusal
 * drops the copy, so a revoked pairing never shows its saved documents.
 */
class AidenVisualDocumentLoader(
    private val cache: AidenVisualDocumentCache,
    private val fetch: suspend () -> String,
    private val classify: (Throwable) -> AidenVisualDocumentFailure = AidenVisualDocumentFailure::classify
) {
    suspend fun load(key: AidenVisualDocumentKey): AidenVisualDocumentLoad {
        val generation = cache.generation
        val html = try {
            fetch()
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: Exception) {
            return when (classify(error)) {
                AidenVisualDocumentFailure.NOT_FOUND -> {
                    cache.remove(key)
                    AidenVisualDocumentLoad.Failed(unavailable = true)
                }
                AidenVisualDocumentFailure.DENIED -> {
                    cache.remove(key)
                    AidenVisualDocumentLoad.Failed(unavailable = false)
                }
                AidenVisualDocumentFailure.UNREACHABLE ->
                    cache.load(key)?.let { AidenVisualDocumentLoad.Cached(it) }
                        ?: AidenVisualDocumentLoad.Failed(unavailable = false)
            }
        }
        cache.store(key, html, generation)
        return AidenVisualDocumentLoad.Fresh(html)
    }
}
