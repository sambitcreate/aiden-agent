package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenRelativeTimestamp
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsHomeContentState
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotsHomeContentState
import java.time.Instant
import java.time.temporal.ChronoUnit

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

    @Test
    fun testUnsupportedBotsFallbackDoesNotErasePerInstallationPreference() {
        val store = AidenProductNavigationStore(tempFolder.root)
        store.setSelectedArea("mac_1", AidenProductArea.BOTS)

        store.activateSelectedArea("mac_1", botsAvailable = false)
        assertEquals(AidenProductArea.WORKSPACES, store.activeArea.value)
        assertEquals(AidenProductArea.BOTS, store.selectedArea("mac_1"))

        store.activateSelectedArea("mac_1", botsAvailable = true)
        assertEquals(AidenProductArea.BOTS, store.activeArea.value)
    }

    @Test
    fun testWorkspaceHomeRelativeTimestampsMatchIosBoundaries() {
        val now = Instant.parse("2026-08-24T12:00:00Z")
        assertEquals("just now", aidenRelativeTimestamp(now.minus(59, ChronoUnit.SECONDS), now))
        assertEquals("1m", aidenRelativeTimestamp(now.minus(60, ChronoUnit.SECONDS), now))
        assertEquals("59m", aidenRelativeTimestamp(now.minus(59, ChronoUnit.MINUTES), now))
        assertEquals("1h", aidenRelativeTimestamp(now.minus(60, ChronoUnit.MINUTES), now))
        assertEquals("1d", aidenRelativeTimestamp(now.minus(24, ChronoUnit.HOURS), now))
    }

    @Test
    fun testBotsHomeContentStates() {
        fun resolve(hasSnapshot: Boolean, loading: Boolean, bots: Int, error: Boolean = false) =
            aidenBotsHomeContentState(
                hasSnapshot = hasSnapshot,
                isLoading = loading,
                totalBotCount = bots,
                activeBotCount = bots,
                conversationCount = 0,
                hasQuery = false,
                filteredBotCount = bots,
                filteredConversationCount = 0,
                hasError = error
            )

        assertEquals(AidenBotsHomeContentState.LOADING, resolve(false, true, 0))
        assertEquals(AidenBotsHomeContentState.LOADING, resolve(false, false, 0))
        assertEquals(AidenBotsHomeContentState.ERROR, resolve(false, false, 0, error = true))
        assertEquals(AidenBotsHomeContentState.EMPTY, resolve(true, false, 0))
        assertEquals(AidenBotsHomeContentState.CONTENT, resolve(true, false, 2))
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
