package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenRemoteCoordinatorClientTest {
    @Test
    fun recoveryExplainsNetworkTrustAndProtocolFailuresWithoutOfferingTrustBypass() {
        val classify = sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionIssue.Companion
        val network = classify.classify(java.net.UnknownHostException("private-host-name"))
        org.junit.Assert.assertEquals("Check the network", network.title)
        org.junit.Assert.assertTrue(network.canRetry)
        val trust = classify.classify(javax.net.ssl.SSLPeerUnverifiedException("private certificate details"))
        org.junit.Assert.assertEquals("Verify this computer", trust.title)
        org.junit.Assert.assertFalse(trust.canRetry)
        org.junit.Assert.assertFalse(trust.message.contains("private certificate"))
        val protocol = classify.classify(sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException.InvalidProtocolVersion)
        org.junit.Assert.assertEquals("Update required", protocol.title)
    }

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
}
