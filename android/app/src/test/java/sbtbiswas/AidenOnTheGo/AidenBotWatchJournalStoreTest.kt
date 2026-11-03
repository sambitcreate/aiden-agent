package sbtbiswas.AidenOnTheGo

import java.time.Instant
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.persistence.AidenBotWatchJournalStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenBotWatchJournalStoreTest {
    @Test fun recreatedStoreKeepsEachPairingsBotJournalSeparate() {
        val secure = InMemoryAidenSecureStore()
        val store = AidenBotWatchJournalStore(secure)
        store.journal("host", "device", Instant.EPOCH, "bot-a") { true }.write("first exact request")
        store.journal("host", "device", Instant.EPOCH, "bot-b") { true }.write("second exact request")
        val restored = AidenBotWatchJournalStore(secure)
        assertEquals("first exact request", restored.journal("host", "device", Instant.EPOCH, "bot-a") { true }.read())
        assertEquals("second exact request", restored.journal("host", "device", Instant.EPOCH, "bot-b") { true }.read())
        assertNull(restored.journal("other-host", "device", Instant.EPOCH, "bot-a") { true }.read())
        assertNull(restored.journal("host", "device", Instant.EPOCH.plusSeconds(1), "bot-a") { true }.read())
    }
    @Test fun purgeDeletesRecordsAndFencesLateJournalWrites() {
        val secure = InMemoryAidenSecureStore(); val store = AidenBotWatchJournalStore(secure)
        val old = store.journal("host", "device", Instant.EPOCH, "bot-a") { true }
        old.write("pending identity")
        store.purge("host", "device", Instant.EPOCH)
        assertNull(old.read()); assertTrue(runCatching { old.write("late callback") }.isFailure)
        assertNull(AidenBotWatchJournalStore(secure).journal("host", "device", Instant.EPOCH, "bot-a") { true }.read())
    }
    @Test fun forgettingPairingPurgesItsSecureDraftAndRequest() {
        val dir = Files.createTempDirectory("aiden-watch-pairing-").toFile()
        try {
            val secure = InMemoryAidenSecureStore(); val installations = AidenInstallationStore(dir, secure)
            val pairing = installations.addInstallation(AidenPairingExchange(instanceId = "host", deviceId = "device",
                endpoint = "https://example.test/api/aiden/v1", serverSpkiSha256 = "sha256/test", credential = "pairing-credential",
                capabilities = listOf(AidenRemoteCapability.BOT_READ)), null)
            val disk = AidenBotWatchJournalStore(secure)
            val oldHandle = disk.journal(pairing.instanceId, pairing.deviceId, pairing.createdAt, "bot-a") {
                installations.activeInstallation?.createdAt == pairing.createdAt
            }
            oldHandle.write("saved draft and exact request")
            installations.removeInstallation(pairing.id)
            assertNull(AidenBotWatchJournalStore(secure).journal(pairing.instanceId, pairing.deviceId, pairing.createdAt, "bot-a") { true }.read())
            assertNull(secure.getCredential(pairing.credentialScope))
            assertTrue(runCatching { oldHandle.write("late request") }.isFailure)
        } finally { dir.deleteRecursively() }
    }
    @Test fun aggregateCapacityRefusesInsteadOfEvictingExistingPendingIdentity() {
        val secure = InMemoryAidenSecureStore(); val store = AidenBotWatchJournalStore(secure)
        repeat(64) { store.journal("host", "device", Instant.EPOCH, "bot-$it") { true }.write("identity-$it") }
        assertTrue(runCatching { store.journal("host", "device", Instant.EPOCH, "overflow") { true }.write("new identity") }.isFailure)
        assertEquals("identity-0", AidenBotWatchJournalStore(secure).journal("host", "device", Instant.EPOCH, "bot-0") { true }.read())
    }
}
