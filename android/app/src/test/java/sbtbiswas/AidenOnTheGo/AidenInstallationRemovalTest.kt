package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotFavorites
import sbtbiswas.AidenOnTheGo.models.AidenBotList
import sbtbiswas.AidenOnTheGo.models.AidenChatSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatSummaryActivity
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import sbtbiswas.AidenOnTheGo.models.AidenUsageTokens
import sbtbiswas.AidenOnTheGo.models.AidenUsageTotals
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileIndex
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.time.Instant

class AidenInstallationRemovalTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun coordinatorRemovalPurgesEveryInstallationScopedStore() {
        val secureStore = InMemoryAidenSecureStore()
        val installationStore = AidenInstallationStore(tempFolder.root, secureStore)
        val chatCache = AidenChatCache(tempFolder.root)
        val draftStore = AidenChatDraftStore(tempFolder.root)
        val navigationStore = AidenProductNavigationStore(tempFolder.root)
        val cancelledJob = Job().apply { cancel() }
        val coordinator = AidenRemoteCoordinator(
            installationStore = installationStore,
            storageDir = tempFolder.root,
            chatCache = chatCache,
            draftStore = draftStore,
            navigationStore = navigationStore,
            scope = CoroutineScope(Dispatchers.Unconfined + cancelledJob)
        )
        val installation = installationStore.addInstallation(
            AidenPairingExchange(
                instanceId = "instance-one",
                deviceId = "device-one",
                endpoint = "https://aiden.test/api/aiden/v1",
                serverSpkiSha256 = "sha256/test",
                credential = "secret",
                capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ),
                displayName = "Test Mac"
            ),
            trust = null
        )

        chatCache.saveChats(emptyList(), installation.instanceId, "workspace-one")
        chatCache.saveSummaries(
            listOf(
                AidenChatSummary(
                    id = "chat-one",
                    workspaceId = "workspace-one",
                    title = "Cached summary",
                    titlePending = false,
                    createdAt = Instant.parse("2026-09-01T12:00:00Z"),
                    updatedAt = Instant.parse("2026-09-01T12:01:00Z"),
                    revision = "rev-one",
                    activity = AidenChatSummaryActivity.IDLE
                )
            ),
            installation.instanceId
        )
        draftStore.setDraft(installation.instanceId, "chat-one", "private draft")
        navigationStore.setSelectedArea(installation.instanceId, AidenProductArea.WORKSPACES)
        coordinator.archiveStore.archive("workspace-one", installation.instanceId)
        coordinator.scheduledCache.store(installation.instanceId, emptyList(), null)
        coordinator.workspaceCache.store(
            AidenWorkspaceFileIndex("snapshot-one", emptyList(), false, 100, 10),
            installation.instanceId,
            "workspace-one"
        )
        coordinator.usageCache.store(installation.instanceId, emptyUsageSummary())
        coordinator.botCache.activate(installation.instanceId, installation.deviceId)
        coordinator.botCache.putBotList(
            AidenBotList(
                bots = emptyList(),
                favorites = AidenBotFavorites(botIds = emptyList(), revision = "favorites-one")
            )
        )

        coordinator.removeInstallation(installation.id)

        assertTrue(installationStore.installations.value.isEmpty())
        assertNull(secureStore.getCredential(installation.credentialScope))
        assertNull(chatCache.loadChats(installation.instanceId, "workspace-one"))
        assertNull(chatCache.loadSummaries(installation.instanceId))
        assertNull(draftStore.getDraft(installation.instanceId, "chat-one"))
        assertEquals(AidenProductArea.BOTS, navigationStore.selectedArea(installation.instanceId))
        assertFalse(coordinator.archiveStore.isArchived("workspace-one", installation.instanceId))
        assertNull(coordinator.scheduledCache.load(installation.instanceId))
        assertNull(coordinator.workspaceCache.load(installation.instanceId, "workspace-one"))
        assertNull(coordinator.usageCache.load(installation.instanceId))
        coordinator.botCache.activate(installation.instanceId, installation.deviceId)
        assertNull(coordinator.botCache.botList.value)
    }

    private fun emptyUsageSummary(): AidenUsageSummary {
        val tokens = AidenUsageTokens(0, 0, 0, 0, reasoning = 0, total = 0)
        return AidenUsageSummary(
            range = "30d",
            startDate = "2026-07-26",
            endDate = "2026-08-24",
            totals = AidenUsageTotals(
                requests = 0,
                completedRequests = 0,
                failedRequests = 0,
                cancelledRequests = 0,
                reportedTokenRequests = 0,
                unmeteredRequests = 0,
                localRequests = 0,
                costedRequests = 0,
                unpricedHostedRequests = 0,
                hostedCostUsd = 0.0,
                activeDays = 0,
                currentStreak = 0,
                longestStreak = 0,
                tokens = tokens
            ),
            days = emptyList(),
            models = emptyList()
        )
    }
}
