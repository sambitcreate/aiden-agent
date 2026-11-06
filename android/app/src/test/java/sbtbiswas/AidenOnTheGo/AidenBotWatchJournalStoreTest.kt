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
            val work = AidenBotWatchJournalStore(secure,"bot-open-work").journal(pairing.instanceId,pairing.deviceId,pairing.createdAt,"bot-a"){ installations.activeInstallation?.createdAt == pairing.createdAt }
            work.write("Open work attempt")
            val models=AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).journal(pairing.instanceId,pairing.deviceId,pairing.createdAt,"bot-a|routine|routine-a"){true}
            models.write("Exact routine model save")
            val resume=AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).journal(pairing.instanceId,pairing.deviceId,pairing.createdAt,"bot-a|resume"){true}
            resume.write("Exact source acknowledgement and UUID")
            installations.removeInstallation(pairing.id)
            assertNull(models.read());assertNull(resume.read())
            assertTrue(runCatching{models.write("late save")}.isFailure)
            assertTrue(runCatching{resume.write("late consent")}.isFailure)
            assertNull(AidenBotWatchJournalStore(secure).journal(pairing.instanceId, pairing.deviceId, pairing.createdAt, "bot-a") { true }.read())
            assertNull(secure.getCredential(pairing.credentialScope))
            assertNull(work.read())
            assertNull(AidenBotWatchJournalStore(secure,"bot-open-work").journal(pairing.instanceId,pairing.deviceId,pairing.createdAt,"bot-a"){true}.read())
            assertTrue(runCatching { oldHandle.write("late request") }.isFailure)
        } finally { dir.deleteRecursively() }
    }
    @Test fun openWorkNamespaceIsIsolatedAndCompareAndReplaceFencesAnotherWindow() {
        val secure=InMemoryAidenSecureStore()
        val watches=AidenBotWatchJournalStore(secure).journal("host","device",Instant.EPOCH,"bot-a"){true}
        val work=AidenBotWatchJournalStore(secure,"bot-open-work").journal("host","device",Instant.EPOCH,"bot-a"){true}
        val other=AidenBotWatchJournalStore(secure,"bot-open-work").journal("host","device",Instant.EPOCH,"bot-a"){true}
        watches.write("watch request")
        assertTrue(work.replace(null,"frozen Open work request"))
        assertFalse(other.replace(null,"replacement UUID"))
        assertEquals("frozen Open work request",other.read())
        AidenBotWatchJournalStore(secure,"bot-open-work").purge("host","device",Instant.EPOCH)
        assertNull(other.read());assertEquals("watch request",watches.read())
        assertTrue("another window cannot resurrect a purged scope",runCatching { other.write("late callback") }.isFailure)
    }

    @Test fun temporaryPairingInactivityKeepsGenerationButConfirmedBotPurgeInvalidatesIt() {
        val secure=InMemoryAidenSecureStore();val store=AidenBotWatchJournalStore(secure,"bot-routine-controls",1088)
        var active=true
        val journal=store.journal("host","device",Instant.EPOCH,"bot-a|resume"){active}
        journal.write("Exact pending request");var invalidations=0;journal.onInvalidated{invalidations++}
        active=false
        assertTrue(journal.isCurrent);assertNull(journal.read())
        assertTrue(runCatching{journal.write("Wrong active pairing")}.isFailure)
        active=true
        assertEquals("Exact pending request",journal.read());assertEquals(0,invalidations)
        AidenBotWatchJournalStore(secure,"bot-routine-controls",1088).purgeBot("host","device",Instant.EPOCH,"bot-a")
        assertFalse(journal.isCurrent);assertNull(journal.read());assertEquals(1,invalidations)
        assertTrue(runCatching{journal.write("Late callback")}.isFailure)
    }

    @Test fun aggregateCapacityRefusesInsteadOfEvictingExistingPendingIdentity() {
        val secure = InMemoryAidenSecureStore(); val store = AidenBotWatchJournalStore(secure)
        repeat(64) { store.journal("host", "device", Instant.EPOCH, "bot-$it") { true }.write("identity-$it") }
        assertTrue(runCatching { store.journal("host", "device", Instant.EPOCH, "overflow") { true }.write("new identity") }.isFailure)
        assertEquals("identity-0", AidenBotWatchJournalStore(secure).journal("host", "device", Instant.EPOCH, "bot-0") { true }.read())
    }
}
