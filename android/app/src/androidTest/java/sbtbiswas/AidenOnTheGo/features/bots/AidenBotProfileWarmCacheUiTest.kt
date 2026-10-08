package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessMode
import sbtbiswas.AidenOnTheGo.models.AidenBotAccessView
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarView
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotHealth
import sbtbiswas.AidenOnTheGo.models.AidenBotLegacyAvatar
import sbtbiswas.AidenOnTheGo.models.AidenBotSemanticAvatar
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File
import java.time.Instant

/** A Bot the phone has seen renders from its saved profile with no loading state. */
@RunWith(AndroidJUnit4::class)
class AidenBotProfileWarmCacheUiTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var storage: File
    private lateinit var coordinator: AidenRemoteCoordinator

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        storage = File(context.cacheDir, "bot-profile-warm-${System.nanoTime()}").apply { mkdirs() }
        coordinator = AidenRemoteCoordinator(
            installationStore = AidenInstallationStore(storage, InMemoryAidenSecureStore()),
            storageDir = storage,
            // Never connected: anything on screen came from the saved cache.
            scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
        )
        coordinator.botCache.activate("mac-1", "device-1")
    }

    @After
    fun tearDown() {
        storage.deleteRecursively()
    }

    @Test
    fun aSavedBotProfileRendersImmediatelyWithoutPlaceholdersOrSpinners() {
        coordinator.botCache.putBotDetail(detail("bot-1", "Release Helper"))

        compose.setContent {
            AidenTheme {
                AidenBotProfileScreen(
                    botId = "bot-1",
                    coordinator = coordinator,
                    onNavigateBack = {},
                    onNavigateToChat = {},
                    onNavigateToEditBot = {}
                )
            }
        }

        compose.onNodeWithText("Release Helper").assertIsDisplayed()
        compose.onNodeWithContentDescription("Loading Bot").assertDoesNotExist()
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertDoesNotExist()
    }

    @Test
    fun anUnsavedBotWhileDisconnectedSaysSoInsteadOfLoadingForever() {
        compose.setContent {
            AidenTheme {
                AidenBotProfileScreen(
                    botId = "bot-unknown",
                    coordinator = coordinator,
                    onNavigateBack = {},
                    onNavigateToChat = {},
                    onNavigateToEditBot = {}
                )
            }
        }

        compose.onNodeWithText("Bot unavailable").assertIsDisplayed()
        compose.onNodeWithContentDescription("Loading Bot").assertDoesNotExist()
    }

    private fun detail(id: String, name: String): AidenBotDetail {
        val now = Instant.parse("2026-10-01T12:00:00Z")
        return AidenBotDetail(
            id = id,
            name = name,
            purpose = "Ships builds",
            instructions = "Be concise.",
            avatar = AidenBotAvatarView(semantic = AidenBotSemanticAvatar.Legacy(AidenBotLegacyAvatar.ORBIT)),
            health = AidenBotHealth.READY,
            createdAt = now,
            updatedAt = now,
            revision = "rev-1",
            access = AidenBotAccessView(
                botId = id,
                accessMode = AidenBotAccessMode.FULL,
                revision = "policy-1",
                policyEpoch = "epoch-1",
                summary = "Full access"
            )
        )
    }
}
