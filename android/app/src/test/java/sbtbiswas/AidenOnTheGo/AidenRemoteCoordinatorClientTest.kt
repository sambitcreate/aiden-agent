package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.models.AidenWorkspace
import sbtbiswas.AidenOnTheGo.models.AidenWorkspacePermission
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenReadSnapshotKeys
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenRemoteCoordinatorClientTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private fun exchange(instance: String, spki: String) = AidenPairingExchange(
        instanceId = instance,
        deviceId = "device-$instance",
        endpoint = "https://$instance.test/api/aiden/v1",
        serverSpkiSha256 = spki,
        credential = "secret-$instance",
        capabilities = listOf(AidenRemoteCapability.CHAT_READ)
    )

    @Test
    fun reconnectingTheSameInstallationReusesItsPinnedHttpClient() {
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        val first = installations.addInstallation(exchange("one", "sha256/one"), null)
        val coordinator = AidenRemoteCoordinator(
            installationStore = installations,
            storageDir = tempFolder.root,
            scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
        )

        coordinator.refreshClient()
        val initial = coordinator.client.value!!
        coordinator.refreshClient()
        val retried = coordinator.client.value!!

        assertNotSame("each activation still gets a fresh Remote client", initial, retried)
        assertSame(initial.customOkHttpClient, retried.customOkHttpClient)

        // A different trust anchor must never share a pinned connection pool.
        installations.addInstallation(exchange("two", "sha256/two"), null)
        coordinator.refreshClient()
        val other = coordinator.client.value!!
        assertNotSame(initial.customOkHttpClient, other.customOkHttpClient)

        installations.setActiveInstallation(first.id)
        coordinator.refreshClient()
        assertNotSame(other.customOkHttpClient, coordinator.client.value!!.customOkHttpClient)
    }

    @Test
    fun activationShowsTheLastWorkspaceListOfThatInstallationBeforeTheDesktopAnswers() {
        val installations = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        val first = installations.addInstallation(exchange("one", "sha256/one"), null)
        val saved = listOf(
            AidenWorkspace(id = "w1", name = "Aiden", permission = AidenWorkspacePermission.ASK, revision = "r1")
        )
        // Written by an earlier run after a successful /workspaces read.
        AidenRemoteCoordinator(
            installationStore = installations,
            storageDir = tempFolder.root,
            scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
        ).readSnapshotCache.store("one", AidenReadSnapshotKeys.WORKSPACES, saved, ListSerializer(AidenWorkspace.serializer()))
        val coordinator = AidenRemoteCoordinator(
            installationStore = installations,
            storageDir = tempFolder.root,
            // A cancelled scope means no request ever reaches the desktop.
            scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
        )

        coordinator.refreshClient()
        assertEquals(saved, coordinator.workspaces.value)

        // Another pairing never shows the first Mac's Workspaces.
        installations.addInstallation(exchange("two", "sha256/two"), null)
        coordinator.refreshClient()
        assertEquals(emptyList<AidenWorkspace>(), coordinator.workspaces.value)

        installations.setActiveInstallation(first.id)
        coordinator.refreshClient()
        assertEquals(saved, coordinator.workspaces.value)
    }
}
