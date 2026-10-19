package sbtbiswas.AidenOnTheGo.persistence

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
 */
class AidenVisualDocumentCache(
    private val directory: File,
    private val maximumEntries: Int = 20,
    private val maximumTotalBytes: Long = 40L * 1_024 * 1_024,
    private val maximumEntryBytes: Int = 12 * 1_024 * 1_024,
    private val clock: () -> Long = System::currentTimeMillis
) {
    private var lastStamp = 0L
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

    /** Returns false when the document was too large to keep or the write failed. */
    @Synchronized
    fun store(key: AidenVisualDocumentKey, html: String): Boolean = try {
        val target = file(key)
        val bytes = html.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > maximumEntryBytes || bytes.size > maximumTotalBytes) {
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

/**
 * Fetches a viewer document and keeps the cache in step: a fresh document replaces
 * the cached copy; a failed fetch falls back to it; a `404` drops it, since the
 * chat or visual no longer exists on the Mac.
 */
class AidenVisualDocumentLoader(
    private val cache: AidenVisualDocumentCache,
    private val fetch: suspend () -> String,
    private val isNotFound: (Throwable) -> Boolean
) {
    suspend fun load(key: AidenVisualDocumentKey): AidenVisualDocumentLoad {
        val html = try {
            fetch()
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: Exception) {
            if (isNotFound(error)) {
                cache.remove(key)
                return AidenVisualDocumentLoad.Failed(unavailable = true)
            }
            return cache.load(key)?.let { AidenVisualDocumentLoad.Cached(it) }
                ?: AidenVisualDocumentLoad.Failed(unavailable = false)
        }
        cache.store(key, html)
        return AidenVisualDocumentLoad.Fresh(html)
    }
}
