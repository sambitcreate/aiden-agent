package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException

class AidenVisualDocumentCacheTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private var now = 1_700_000_000_000L
    private val clock = { now }

    private fun key(visualId: String, scheme: String = "dark", theme: String = "dusk", host: String = "mac-1\u001fphone-1") =
        AidenVisualDocumentKey(host, "chat-1", visualId, scheme, theme)

    private fun cache(entries: Int = 20, totalBytes: Long = 40L * 1_024 * 1_024, entryBytes: Int = 12 * 1_024 * 1_024) =
        AidenVisualDocumentCache(tempFolder.root, entries, totalBytes, entryBytes, clock)

    @Test
    fun theFileNameIsTheSha256OfEveryKeyField() {
        // Independent oracle: SHA-256 of "mac-1\u001fphone-1\0chat-1\0visual-1\0dark\0dusk".
        assertEquals(
            "c40ef22cb5e804dd2b5a43b708409c15dba0da9febda6c821e32b0741be2a4ef",
            key("visual-1").fileName
        )
        val variants = listOf(
            key("visual-1", scheme = "light"),
            key("visual-1", theme = "aiden"),
            key("visual-2"),
            key("visual-1", host = "mac-1\u001fphone-2"),
            AidenVisualDocumentKey("mac-1\u001fphone-1", "chat-2", "visual-1", "dark", "dusk"),
            // Field boundaries cannot be shifted to collide.
            AidenVisualDocumentKey("mac-1\u001fphone-1", "chat-1visual-1", "", "dark", "dusk")
        )
        assertEquals(variants.size + 1, (variants.map { it.fileName } + key("visual-1").fileName).toSet().size)
    }

    @Test
    fun aDocumentSurvivesANewCacheInstanceAndIsKeyedBySchemeAndTheme() {
        cache().store(key("visual-1"), "<html>dark dusk ✓</html>")

        val reopened = cache()
        assertEquals("<html>dark dusk ✓</html>", reopened.load(key("visual-1")))
        assertNull(reopened.load(key("visual-1", scheme = "light")))
        assertNull(reopened.load(key("visual-1", theme = "aiden")))
        assertNull(reopened.load(key("visual-1", host = "mac-2\u001fphone-1")))
    }

    @Test
    fun evictsTheLeastRecentlyUsedBeyondTheEntryLimit() {
        val cache = cache(entries = 3)
        for (id in listOf("a", "b", "c")) {
            cache.store(key(id), "<html>$id</html>")
            now += 10
        }
        // Reading "a" makes "b" the least recently used.
        assertEquals("<html>a</html>", cache.load(key("a")))
        now += 10
        cache.store(key("d"), "<html>d</html>")

        assertNull(cache.load(key("b")))
        assertEquals("<html>a</html>", cache.load(key("a")))
        assertEquals("<html>c</html>", cache.load(key("c")))
        assertEquals("<html>d</html>", cache.load(key("d")))
        assertEquals(3, tempFolder.root.listFiles { file -> file.extension == "html" }!!.size)
    }

    @Test
    fun evictsTheLeastRecentlyUsedBeyondTheByteLimit() {
        val cache = cache(totalBytes = 10)
        cache.store(key("a"), "aaaa")
        cache.store(key("b"), "bbbb")
        cache.store(key("c"), "cccc")

        assertNull(cache.load(key("a")))
        assertEquals("bbbb", cache.load(key("b")))
        assertEquals("cccc", cache.load(key("c")))
    }

    @Test
    fun recencySurvivesARelaunch() {
        cache(entries = 2).store(key("a"), "aaaa")
        cache(entries = 2).store(key("b"), "bbbb")
        // A later launch whose clock reads earlier than the stamps already on disk.
        now -= 60_000
        val relaunched = cache(entries = 2)
        assertEquals("aaaa", relaunched.load(key("a")))
        relaunched.store(key("c"), "cccc")

        assertNull(relaunched.load(key("b")))
        assertEquals("aaaa", relaunched.load(key("a")))
    }

    @Test
    fun aDocumentTooLargeToKeepDropsTheOlderCopy() {
        val cache = cache(entryBytes = 8)
        assertTrue(cache.store(key("a"), "small"))
        assertFalse(cache.store(key("a"), "much too large"))
        assertNull(cache.load(key("a")))
    }

    @Test
    fun theLoaderCachesFreshDocumentsAndFallsBackWhenTheMacIsUnreachable() = runBlocking {
        val cache = cache()
        var answer: () -> String = { "<html>v1</html>" }
        val loader = AidenVisualDocumentLoader(cache, fetch = { answer() })

        assertEquals(AidenVisualDocumentLoad.Fresh("<html>v1</html>"), loader.load(key("a")))
        answer = { throw IOException("offline") }
        assertEquals(AidenVisualDocumentLoad.Cached("<html>v1</html>"), loader.load(key("a")))
        assertEquals(AidenVisualDocumentLoad.Failed(unavailable = false), loader.load(key("never-seen")))

        answer = { "<html>v2</html>" }
        assertEquals(AidenVisualDocumentLoad.Fresh("<html>v2</html>"), loader.load(key("a")))
        assertEquals("<html>v2</html>", cache.load(key("a")))
    }

    @Test
    fun aVisualTheMacNoLongerHasIsDroppedFromTheCache() = runBlocking {
        val cache = cache()
        cache.store(key("a"), "<html>old</html>")
        val loader = AidenVisualDocumentLoader(
            cache,
            fetch = {
                throw AidenRemoteClientException.Server(
                    404,
                    AidenRemoteErrorEnvelope.Body(AidenRemoteErrorCode.NOT_FOUND, "Visual not found.", "req_1", false)
                )
            }
        )

        assertEquals(AidenVisualDocumentLoad.Failed(unavailable = true), loader.load(key("a")))
        assertNull(cache.load(key("a")))
    }

    @Test
    fun aRevokedOrRefusingMacNeverServesTheSavedCopyAndDropsIt() = runBlocking {
        val refusals = listOf(
            serverError(401, AidenRemoteErrorCode.CREDENTIAL_REVOKED),
            serverError(403, AidenRemoteErrorCode.CREDENTIAL_REVOKED),
            serverError(400, AidenRemoteErrorCode.NOT_FOUND),
            AidenRemoteClientException.InvalidResponse()
        )
        for (refusal in refusals) {
            val cache = cache()
            cache.store(key("a"), "<html>private</html>")
            val loader = AidenVisualDocumentLoader(cache, fetch = { throw refusal })

            assertEquals("$refusal", AidenVisualDocumentLoad.Failed(unavailable = false), loader.load(key("a")))
            assertNull("$refusal", cache.load(key("a")))
        }
    }

    @Test
    fun aTransientServerFailureStillFallsBackToTheSavedCopy() = runBlocking {
        val cache = cache()
        cache.store(key("a"), "<html>saved</html>")
        val loader = AidenVisualDocumentLoader(cache, fetch = { throw serverError(503, AidenRemoteErrorCode.NOT_FOUND) })

        assertEquals(AidenVisualDocumentLoad.Cached("<html>saved</html>"), loader.load(key("a")))
    }

    @Test
    fun aPurgeDuringALoadKeepsTheDocumentFromBeingSavedAgain() = runBlocking {
        val cache = cache()
        cache.store(key("a"), "<html>old</html>")
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<String>()
        val loader = AidenVisualDocumentLoader(cache, fetch = { started.complete(Unit); release.await() })

        val load = async { loader.load(key("a")) }
        started.await()
        cache.purgeAll()
        release.complete("<html>after removal</html>")

        assertEquals(AidenVisualDocumentLoad.Fresh("<html>after removal</html>"), load.await())
        assertNull(cache.load(key("a")))
        assertTrue(tempFolder.root.listFiles { file -> file.extension == "html" }!!.isEmpty())
    }
}

private fun serverError(status: Int, code: AidenRemoteErrorCode) =
    AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, "Refused.", "req_1", false))
