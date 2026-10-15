package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File

/** R15: New Bot closes at once; Bots home shows the Bot on its way, and a failure offers Try Again. */
@RunWith(AndroidJUnit4::class)
class AidenBotCreatePendingUiTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var storage: File
    private lateinit var coordinator: AidenRemoteCoordinator

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        storage = File(context.cacheDir, "bot-create-pending-${System.nanoTime()}").apply { mkdirs() }
        coordinator = AidenRemoteCoordinator(
            installationStore = AidenInstallationStore(storage, InMemoryAidenSecureStore()),
            storageDir = storage,
            // Never connected: no Mac answers, so a create can only wait and fail.
            scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
        )
    }

    @After
    fun tearDown() {
        storage.deleteRecursively()
    }

    @Test
    fun aBotOnItsWayShowsOnBotsHomeAndAFailureReopensNewBotAsItWas() {
        val flow = coordinator.botCreateFlow()
        val viewModel = compose.runOnIdle { AidenBotsViewModel(coordinator, coordinator.botCache) }
        var reopened = 0
        compose.setContent {
            AidenTheme {
                AidenBotsHomeScreen(
                    coordinator = coordinator,
                    viewModel = viewModel,
                    onNavigateToChat = {},
                    onNavigateToBotProfile = {},
                    onNavigateToCreateBot = { reopened += 1 }
                )
            }
        }

        val draft = AidenBotCreateDraft(name = "Meal Planner", help = "Plans dinners")
        val attempt = compose.runOnIdle { flow.start(draft, null)!! }
        compose.onNodeWithText("Meal Planner").assertIsDisplayed()
        compose.onNodeWithText("Creating…").assertIsDisplayed()

        // No Mac to reach: the row goes and the failure says so.
        runBlocking { flow.send(attempt) }
        compose.onNodeWithText("Creating…").assertDoesNotExist()
        compose.onNodeWithText("Couldn’t Create Bot").assertIsDisplayed()
        compose.onNodeWithText("Try Again").performClick()

        compose.runOnIdle {
            assertEquals(1, reopened)
            assertEquals("New Bot opens with the same answers", draft, flow.reopening())
        }
        compose.onNodeWithText("Couldn’t Create Bot").assertDoesNotExist()
    }
}
