package sbtbiswas.AidenOnTheGo.persistence

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus

class AidenSettingsCacheTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private fun snapshot(instanceId: String) = AidenSettingsSnapshot(
        instanceId = instanceId,
        providers = listOf(AidenSettingsProvider("openai", "OpenAI", modelCount = 4)),
        canCreateProvider = true,
        memory = AidenMemorySettings(enabled = false, revision = "rev-2"),
        readAloud = AidenReadAloudStatus(enabled = true, ready = true, settingsRevision = "tts-1")
    )

    @Test
    fun snapshotsSurviveANewCacheInstanceAndStayPerInstallation() {
        AidenSettingsCache(tempFolder.root).apply {
            store(snapshot("mac-1"))
            store(snapshot("mac-2").copy(providers = emptyList()))
        }

        val reopened = AidenSettingsCache(tempFolder.root)
        assertEquals(snapshot("mac-1"), reopened.load("mac-1"))
        assertEquals(emptyList<AidenSettingsProvider>(), reopened.load("mac-2")?.providers)
        assertNull(reopened.load("mac-3"))
    }

    @Test
    fun aLaterStoreReplacesTheEarlierSnapshot() {
        val cache = AidenSettingsCache(tempFolder.root)
        cache.store(snapshot("mac-1"))
        cache.store(snapshot("mac-1").copy(memory = AidenMemorySettings(enabled = true, revision = "rev-3")))

        assertEquals(AidenMemorySettings(enabled = true, revision = "rev-3"), cache.load("mac-1")?.memory)
    }

    @Test
    fun unreadableSnapshotsLoadAsNothingCached() {
        val cache = AidenSettingsCache(tempFolder.root)
        cache.store(snapshot("mac-1"))
        tempFolder.root.listFiles()!!.single().writeText("{ not json")

        assertNull(cache.load("mac-1"))
    }

    @Test
    fun unpairedInstallationsLoseTheirCachedSettings() {
        val cache = AidenSettingsCache(tempFolder.root)
        cache.store(snapshot("mac-1"))
        cache.store(snapshot("mac-2"))
        cache.store(snapshot("mac-3"))

        cache.purge("mac-3")
        cache.retainOnly(setOf("mac-2"))

        assertNull(cache.load("mac-1"))
        assertEquals(snapshot("mac-2"), cache.load("mac-2"))
        assertNull(cache.load("mac-3"))
        assertEquals(1, tempFolder.root.listFiles()!!.size)
    }
}
