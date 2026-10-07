package sbtbiswas.AidenOnTheGo

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenBotCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import java.io.File
import java.time.Instant

class AidenBotCacheTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun testBotListAndAvatarCaching() {
        val cache = AidenBotCache(tempFolder.root)
        cache.activate("mac_1", "device_1")

        val recipe = AidenBotAvatarRecipe(
            shape = AidenBotAvatarShape.ORB,
            color = AidenBotAvatarColor.LILAC
        )
        val botSummary = AidenBotSummary(
            id = "bot_123",
            name = "Test Bot",
            purpose = "Automated test helper",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(recipe)),
            health = AidenBotHealth.READY,
            createdAt = Instant.now(),
            updatedAt = Instant.now(),
            revision = "rev_1"
        )
        val botList = AidenBotList(
            bots = listOf(botSummary)
        )

        cache.putBotList(botList)
        assertEquals(1, cache.botList.value?.bots?.size)
        assertEquals("bot_123", cache.botList.value?.bots?.first()?.id)

        // Avatar binary cache
        val avatarBytes = byteArrayOf(1, 2, 3, 4, 5)
        cache.putAvatarData("bot_123", "rev_1", avatarBytes)
        val loadedBytes = cache.getAvatarData("bot_123", "rev_1")
        assertArrayEquals(avatarBytes, loadedBytes)
    }

    @Test
    fun testBotCachePreservesDetailsAcrossListRefresh() {
        val cache = AidenBotCache(tempFolder.root)
        cache.activate("mac_1", "device_1")

        val detail = AidenBotDetail(
            id = "bot_1",
            name = "Helper",
            purpose = "Assists with coding",
            instructions = "Be concise.",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(AidenBotAvatarRecipe(shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.LILAC))),
            health = AidenBotHealth.READY,
            createdAt = Instant.now(),
            updatedAt = Instant.now(),
            revision = "rev_1",
            access = AidenBotAccessView(
                botId = "bot_1",
                accessMode = AidenBotAccessMode.FULL,
                revision = "pol_rev_1",
                policyEpoch = "epoch_1",
                summary = "Full access"
            )
        )
        cache.putBotDetail(detail)
        assertEquals(detail, cache.getBotDetail("bot_1"))

        // Update list with same bot
        val summary = AidenBotSummary(
            id = "bot_1",
            name = "Helper Renamed",
            purpose = "Assists with coding",
            avatar = detail.avatar,
            health = AidenBotHealth.READY,
            createdAt = detail.createdAt,
            updatedAt = Instant.now(),
            revision = "rev_2"
        )
        cache.putBotList(AidenBotList(bots = listOf(summary)))

        // Detail should still be preserved
        assertNotNull(cache.getBotDetail("bot_1"))
    }

    @Test
    fun testBotDetailWithNonPrefixedIdSurvivesFreshCacheLoad() {
        val detail = AidenBotDetail(
            id = "assistant-1",
            name = "Helper",
            purpose = "Assists with coding",
            instructions = "Be concise.",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(AidenBotAvatarRecipe(shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.LILAC))),
            health = AidenBotHealth.READY,
            createdAt = Instant.now(),
            updatedAt = Instant.now(),
            revision = "rev_1",
            access = AidenBotAccessView(
                botId = "assistant-1",
                accessMode = AidenBotAccessMode.FULL,
                revision = "pol_rev_1",
                policyEpoch = "epoch_1",
                summary = "Full access"
            )
        )

        AidenBotCache(tempFolder.root).apply {
            activate("mac_1", "device_1")
            putBotDetail(detail)
        }
        val reloaded = AidenBotCache(tempFolder.root).apply { activate("mac_1", "device_1") }

        assertEquals(detail, reloaded.getBotDetail("assistant-1"))
    }

    @Test
    fun testBotPurgeRemovesOnlyRequestedInstallationAndClearsActiveState() {
        val cache = AidenBotCache(tempFolder.root)
        fun list(name: String) = AidenBotList(
            bots = listOf(
                AidenBotSummary(
                    id = "bot_1",
                    name = name,
                    purpose = "",
                    avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(AidenBotAvatarRecipe(shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.LILAC))),
                    health = AidenBotHealth.READY,
                    createdAt = Instant.EPOCH,
                    updatedAt = Instant.EPOCH,
                    revision = "rev_1"
                )
            )
        )
        cache.activate("mac-a", "device-a")
        cache.putBotList(list("Mac A"))
        cache.activate("mac-b", "device-b")
        cache.putBotList(list("Mac B"))

        cache.purge("mac-b", "device-b")
        assertNull(cache.botList.value)

        cache.activate("mac-a", "device-a")
        assertEquals("Mac A", cache.botList.value?.bots?.single()?.name)
        cache.activate("mac-b", "device-b")
        assertNull(cache.botList.value)
    }

    @Test
    fun testDraftStoreIsInstallationAndChatScoped() {
        val draftStore = AidenChatDraftStore(tempFolder.root)

        val instance1 = "mac_1"
        val instance2 = "mac_2"
        val chat1 = "chat_1"
        val chat2 = "chat_2"

        draftStore.setDraft(instance1, chat1, "Draft for Mac 1 Chat 1")
        draftStore.setDraft(instance1, chat2, "Draft for Mac 1 Chat 2")
        draftStore.setDraft(instance2, chat1, "Draft for Mac 2 Chat 1")

        assertEquals("Draft for Mac 1 Chat 1", draftStore.getDraft(instance1, chat1))
        assertEquals("Draft for Mac 1 Chat 2", draftStore.getDraft(instance1, chat2))
        assertEquals("Draft for Mac 2 Chat 1", draftStore.getDraft(instance2, chat1))
        assertNull(draftStore.getDraft(instance2, chat2))

        // Purge removes only specified installation
        draftStore.purge(instance1)
        assertNull(draftStore.getDraft(instance1, chat1))
        assertNull(draftStore.getDraft(instance1, chat2))
        assertEquals("Draft for Mac 2 Chat 1", draftStore.getDraft(instance2, chat1))
    }

    @Test
    fun testBotCacheIsIsolatedByInstallationAndDevice() {
        val cache = AidenBotCache(tempFolder.root)
        val summary = AidenBotSummary(
            id = "bot_1",
            name = "Mac A Bot",
            purpose = "Scoped helper",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Recipe(AidenBotAvatarRecipe(shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.LILAC))),
            health = AidenBotHealth.READY,
            createdAt = Instant.now(),
            updatedAt = Instant.now(),
            revision = "rev_1"
        )

        cache.activate("mac_a", "device_a")
        cache.putBotList(
            AidenBotList(
                bots = listOf(summary)
            )
        )

        cache.activate("mac_b", "device_b")
        assertNull(cache.botList.value)

        cache.activate("mac_a", "device_a")
        assertEquals("Mac A Bot", cache.botList.value?.bots?.single()?.name)

        cache.activate("mac_a", "device_repaired")
        assertNull(cache.botList.value)
    }
}
