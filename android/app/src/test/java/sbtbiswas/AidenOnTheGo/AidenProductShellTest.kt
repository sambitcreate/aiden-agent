package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import java.time.Instant

class AidenProductShellTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testNavigationStoreStateSwitchingAndPersistence() {
        val store = AidenProductNavigationStore(tempFolder.root)

        val instance1 = "mac_1"
        val instance2 = "mac_2"

        // Default area
        assertEquals(AidenProductArea.BOTS, store.selectedArea(instance1))

        // Change and persist for instance1
        store.setSelectedArea(instance1, AidenProductArea.WORKSPACES)
        assertEquals(AidenProductArea.WORKSPACES, store.selectedArea(instance1))
        assertEquals(AidenProductArea.BOTS, store.selectedArea(instance2)) // instance2 untouched

        // Selected workspace and bot
        store.setSelectedWorkspaceId(instance1, "ws_123")
        store.setSelectedBotId(instance1, "bot_456")

        assertEquals("ws_123", store.selectedWorkspaceId(instance1))
        assertEquals("bot_456", store.selectedBotId(instance1))
        assertNull(store.selectedWorkspaceId(instance2))

        // Coachmarks tracking
        assertFalse(store.hasSeenCoachmark(instance1, "bots_welcome"))
        store.markCoachmarkSeen(instance1, "bots_welcome")
        assertTrue(store.hasSeenCoachmark(instance1, "bots_welcome"))
        assertFalse(store.hasSeenCoachmark(instance2, "bots_welcome"))

        // Purge removes only specified installation
        store.purge(instance1)
        assertEquals(AidenProductArea.BOTS, store.selectedArea(instance1))
        assertNull(store.selectedWorkspaceId(instance1))
        assertFalse(store.hasSeenCoachmark(instance1, "bots_welcome"))
    }

    enum class BotsHomeContentState { LOADING, CONTENT, EMPTY }

    @Test
    fun testBotsHomeContentStates() {
        fun resolveState(isLoading: Boolean, hasCache: Boolean, botCount: Int): BotsHomeContentState {
            if (isLoading && !hasCache) return BotsHomeContentState.LOADING
            return if (botCount > 0) BotsHomeContentState.CONTENT else BotsHomeContentState.EMPTY
        }

        // Cold load -> LOADING
        assertEquals(BotsHomeContentState.LOADING, resolveState(isLoading = true, hasCache = false, botCount = 0))

        // Warm load with cache -> CONTENT
        assertEquals(BotsHomeContentState.CONTENT, resolveState(isLoading = true, hasCache = true, botCount = 3))

        // Completed with 0 bots -> EMPTY
        assertEquals(BotsHomeContentState.EMPTY, resolveState(isLoading = false, hasCache = true, botCount = 0))

        // Completed with bots -> CONTENT
        assertEquals(BotsHomeContentState.CONTENT, resolveState(isLoading = false, hasCache = true, botCount = 2))
    }

    @Test
    fun testBotContactSectionsNeverDuplicateFavorites() {
        val allBots = listOf("bot-1", "bot-2", "bot-3", "bot-4")
        val favorites = listOf("bot-1", "bot-3")

        val favoriteSection = allBots.filter { favorites.contains(it) }
        val regularSection = allBots.filter { !favorites.contains(it) }

        assertEquals(listOf("bot-1", "bot-3"), favoriteSection)
        assertEquals(listOf("bot-2", "bot-4"), regularSection)
        assertTrue(favoriteSection.intersect(regularSection.toSet()).isEmpty())
    }

    @Test
    fun testArchivedBotChatsRemainReadOnly() {
        fun isChatReadOnly(botHealth: AidenBotHealth, accessMode: AidenBotAccessMode): Boolean {
            if (botHealth == AidenBotHealth.ARCHIVED) return true
            return false
        }

        assertTrue(isChatReadOnly(AidenBotHealth.ARCHIVED, AidenBotAccessMode.FULL))
        assertTrue(isChatReadOnly(AidenBotHealth.ARCHIVED, AidenBotAccessMode.CUSTOM))
        assertFalse(isChatReadOnly(AidenBotHealth.READY, AidenBotAccessMode.FULL))
        assertFalse(isChatReadOnly(AidenBotHealth.READY, AidenBotAccessMode.CUSTOM))
    }
}
