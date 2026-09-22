package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenInstallationStoreTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testAddAndRemoveInstallation() {
        val secureStore = InMemoryAidenSecureStore()
        val store = AidenInstallationStore(tempFolder.root, secureStore)

        val exchange = AidenPairingExchange(
            instanceId = "inst_123",
            deviceId = "dev_123",
            endpoint = "https://aiden.test/api/aiden/v1",
            serverSpkiSha256 = "sha256/test",
            credential = "secret_credential",
            capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ),
            displayName = "Sambit's MacBook"
        )

        val installation = store.addInstallation(exchange, null)
        assertEquals("inst_123", installation.instanceId)
        assertEquals("Sambit's MacBook", installation.name)
        assertEquals("secret_credential", secureStore.getCredential(installation.credentialScope))
        assertEquals(1, store.installations.value.size)
        assertEquals("inst_123", store.activeInstallationId.value)

        // Verify capability negotiation
        assertTrue(installation.isBotsEligible)
        assertFalse(installation.canWriteBots) // did not have bot:write

        // Remove installation
        store.removeInstallation("inst_123")
        assertEquals(0, store.installations.value.size)
        assertNull(secureStore.getCredential(installation.credentialScope))
        assertNull(store.activeInstallationId.value)
    }

    @Test
    fun testMultipleInstallationsAndActiveSwitching() {
        val secureStore = InMemoryAidenSecureStore()
        val store = AidenInstallationStore(tempFolder.root, secureStore)

        val exchange1 = AidenPairingExchange(
            instanceId = "inst_1",
            deviceId = "dev_1",
            endpoint = "https://aiden-1.test/api/aiden/v1",
            serverSpkiSha256 = "sha256/test1",
            credential = "cred_1",
            capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE),
            displayName = "Mac Mini"
        )
        val exchange2 = AidenPairingExchange(
            instanceId = "inst_2",
            deviceId = "dev_2",
            endpoint = "https://aiden-2.test/api/aiden/v1",
            serverSpkiSha256 = "sha256/test2",
            credential = "cred_2",
            capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.WORKSPACE_READ, AidenRemoteCapability.WORKSPACE_MANAGE),
            displayName = "Mac Studio"
        )

        val inst1 = store.addInstallation(exchange1, null)
        assertEquals("inst_1", store.activeInstallationId.value)
        assertTrue(inst1.canWriteBots)

        val inst2 = store.addInstallation(exchange2, null)
        assertEquals("inst_2", store.activeInstallationId.value)
        assertTrue(inst2.deviceCapabilities.contains(AidenRemoteCapability.WORKSPACE_MANAGE))
        assertFalse(inst2.isBotsEligible) // No bot:read capability

        assertEquals(2, store.installations.value.size)

        // Switch active installation
        store.setActiveInstallation("inst_1")
        assertEquals("inst_1", store.activeInstallationId.value)
        assertEquals("inst_1", store.activeInstallation?.instanceId)

        // Reload store from disk
        val reloadedStore = AidenInstallationStore(tempFolder.root, secureStore)
        assertEquals(2, reloadedStore.installations.value.size)
        assertEquals("inst_1", reloadedStore.activeInstallationId.value)
    }

    private fun pairedStore(
        capabilities: List<AidenRemoteCapability>
    ): Pair<AidenInstallationStore, sbtbiswas.AidenOnTheGo.models.AidenInstallation> {
        val store = AidenInstallationStore(tempFolder.root, InMemoryAidenSecureStore())
        val installation = store.addInstallation(
            AidenPairingExchange(
                instanceId = "inst_caps",
                deviceId = "dev_caps",
                endpoint = "https://aiden.test/api/aiden/v1",
                serverSpkiSha256 = "sha256/test",
                credential = "secret_credential",
                capabilities = capabilities,
                displayName = "Mac"
            ),
            null
        )
        return store to installation
    }

    @Test
    fun testServerRefreshNarrowsWithdrawnDeviceGrants() {
        val (store, installation) = pairedStore(
            listOf(
                AidenRemoteCapability.CHAT_READ,
                AidenRemoteCapability.TASKS_READ,
                AidenRemoteCapability.AGENTS_READ
            )
        )
        assertTrue(installation.hasNegotiatedAccess(AidenRemoteCapability.TASKS_READ))

        // The server withdraws tasks:read on refresh. The stored model must
        // narrow instead of breaking the serverCapabilities superset
        // invariant — the pairing stays connected with progress hidden.
        store.updateServerCapabilities(
            instanceId = installation.instanceId,
            serverCapabilities = listOf(
                AidenRemoteCapability.SERVER_READ,
                AidenRemoteCapability.CHAT_READ
            ),
            serverName = "Mac",
            deviceCapabilities = listOf(
                AidenRemoteCapability.SERVER_READ,
                AidenRemoteCapability.CHAT_READ
            )
        )

        val narrowed = store.installations.value.single { it.instanceId == installation.instanceId }
        assertEquals(
            listOf(AidenRemoteCapability.CHAT_READ),
            narrowed.deviceCapabilities
        )
        assertFalse(narrowed.hasNegotiatedAccess(AidenRemoteCapability.TASKS_READ))
        assertFalse(narrowed.hasNegotiatedAccess(AidenRemoteCapability.AGENTS_READ))
    }

    @Test
    fun testNegotiatedCapabilitiesMustPreserveNonProgressGrants() {
        val (store, installation) = pairedStore(
            listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ)
        )
        store.updateServerCapabilities(
            instanceId = installation.instanceId,
            serverCapabilities = listOf(
                AidenRemoteCapability.CHAT_READ,
                AidenRemoteCapability.BOT_READ,
                AidenRemoteCapability.TASKS_READ
            ),
            serverName = null,
            deviceCapabilities = listOf(
                AidenRemoteCapability.CHAT_READ,
                AidenRemoteCapability.BOT_READ
            )
        )

        // A contract-invalid response that silently drops bot:read must not
        // be persisted.
        store.updateDeviceCapabilities(
            installation.instanceId,
            listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.TASKS_READ)
        )
        val unchanged = store.installations.value.single { it.instanceId == installation.instanceId }
        assertTrue(unchanged.deviceCapabilities.contains(AidenRemoteCapability.BOT_READ))
        assertFalse(unchanged.deviceCapabilities.contains(AidenRemoteCapability.TASKS_READ))

        // A response that widens non-progress authority is equally invalid.
        store.updateDeviceCapabilities(
            installation.instanceId,
            listOf(
                AidenRemoteCapability.CHAT_READ,
                AidenRemoteCapability.BOT_READ,
                AidenRemoteCapability.BOT_WRITE,
                AidenRemoteCapability.TASKS_READ
            )
        )
        val stillUnchanged = store.installations.value.single { it.instanceId == installation.instanceId }
        assertFalse(stillUnchanged.deviceCapabilities.contains(AidenRemoteCapability.BOT_WRITE))

        // A valid response that only adds a progress grant persists.
        store.updateDeviceCapabilities(
            installation.instanceId,
            listOf(
                AidenRemoteCapability.CHAT_READ,
                AidenRemoteCapability.BOT_READ,
                AidenRemoteCapability.TASKS_READ
            )
        )
        val updated = store.installations.value.single { it.instanceId == installation.instanceId }
        assertTrue(updated.deviceCapabilities.contains(AidenRemoteCapability.TASKS_READ))
        assertTrue(updated.hasNegotiatedAccess(AidenRemoteCapability.TASKS_READ))
    }
}
