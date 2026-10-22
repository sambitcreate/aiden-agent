package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenApprovalSchedule
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScheduleAction
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScheduleMode
import sbtbiswas.AidenOnTheGo.models.AidenApprovalSchedulePermission
import sbtbiswas.AidenOnTheGo.models.AidenApprovalScope
import sbtbiswas.AidenOnTheGo.models.AidenPendingApproval
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenApprovalCardUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val responses = mutableListOf<Pair<AidenApprovalDecision, AidenApprovalScope>>()

    private fun showCommand(lines: Int) {
        val command = (1..lines).joinToString("\n") { "echo step $it" }
        val approval = AidenPendingApproval(
            id = "a-1",
            summary = "Run command: $command",
            toolName = "run_command",
            expiresAt = Instant.now().plusSeconds(300),
            canRespond = true,
            hasRequiredWriteCapability = true,
            hostCanAllow = true,
            canAllow = true
        )
        compose.setContent {
            AidenTheme {
                // The chat's bottom bar does not scroll; this is about the height it has on a phone.
                Column(Modifier.fillMaxWidth().height(560.dp)) {
                    AidenApprovalCardContent(
                        approval = approval,
                        enabled = true,
                        onRespond = { decision, scope -> responses += decision to scope },
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }
        }
    }

    @Test
    fun anExpandedLongCommandLeavesTheCollapseAndDecisionControlsOnScreen() {
        showCommand(lines = 80)

        compose.onNodeWithText("Show all").performClick()

        compose.onNodeWithText("Show less").assertIsDisplayed()
        compose.onNodeWithText("Deny").assertIsDisplayed()
        compose.onNodeWithText("Allow once").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(listOf(AidenApprovalDecision.ALLOW to AidenApprovalScope.ONCE), responses)
        }
    }

    @Test
    fun anExpandedCommandSaysWhenItsEndIsBelowTheFold() {
        showCommand(lines = 80)
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()

        compose.onNodeWithText("Show all").performClick()
        compose.onNodeWithText("Scroll for more").assertIsDisplayed()

        // Once the last line is in view there is nothing more to scroll to.
        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()
    }

    @Test
    fun anExpandedCommandThatFitsHasNoScrollCue() {
        showCommand(lines = 8)

        compose.onNodeWithText("Show all").performClick()

        compose.onNodeWithText("Show less").assertIsDisplayed()
        compose.onNodeWithText("Scroll for more").assertDoesNotExist()
    }

    // Revision 39: the scheduled-task card.

    private fun schedule(
        action: AidenApprovalScheduleAction = AidenApprovalScheduleAction.CREATE,
        permission: AidenApprovalSchedulePermission = AidenApprovalSchedulePermission.READ_ONLY,
        workspaceName: String? = "Aiden Agent",
        nextRunAt: String? = Instant.now().plusSeconds(86_400).toString(),
        enabled: Boolean = true,
        schedulerEnabled: Boolean = true,
        prompt: String = "Summarize yesterday's commits and open pull requests."
    ) = AidenApprovalSchedule(
        action = action,
        name = "Morning briefing",
        cadence = "Weekdays at 9:00 AM",
        timezone = "America/Los_Angeles",
        nextRunAt = nextRunAt,
        mode = AidenApprovalScheduleMode.LLM,
        permission = permission,
        workspaceName = workspaceName,
        providerName = "OpenRouter",
        modelName = "Qwen3 Coder",
        notify = true,
        enabled = enabled,
        schedulerEnabled = schedulerEnabled,
        prompt = prompt
    )

    private fun scheduledTask(
        schedule: AidenApprovalSchedule?,
        toolName: String = "schedule_task",
        hostCanAllow: Boolean = true,
        hasRequiredWriteCapability: Boolean = true
    ) = AidenPendingApproval(
        id = "s-1",
        summary = "Create scheduled task \"Morning briefing\" · Weekdays at 9:00 AM · Read-only access",
        toolName = toolName,
        expiresAt = Instant.now().plusSeconds(300),
        canRespond = true,
        hasRequiredWriteCapability = hasRequiredWriteCapability,
        hostCanAllow = hostCanAllow,
        canAllow = hostCanAllow && hasRequiredWriteCapability,
        schedule = schedule
    )

    private val shown = mutableStateOf(scheduledTask(null))

    private fun showCard(approval: AidenPendingApproval, bodyMaxHeight: Dp = Dp.Unspecified) {
        shown.value = approval
        compose.setContent {
            AidenTheme {
                Column(Modifier.fillMaxWidth().height(640.dp)) {
                    AidenApprovalCardContent(
                        approval = shown.value,
                        enabled = true,
                        onRespond = { decision, scope -> responses += decision to scope },
                        modifier = Modifier.padding(16.dp),
                        scheduleBodyMaxHeight = bodyMaxHeight
                    )
                }
            }
        }
    }

    @Test
    fun aScheduledTaskCardAsksWhatApprovingWouldDoAndNamesTheNextRunOnlyWhenItWillRun() {
        val titles = mapOf(
            AidenApprovalScheduleAction.CREATE to "Save this scheduled task?",
            AidenApprovalScheduleAction.UPDATE to "Update this scheduled task?",
            AidenApprovalScheduleAction.PAUSE to "Pause this scheduled task?",
            AidenApprovalScheduleAction.RESUME to "Resume this scheduled task?",
            AidenApprovalScheduleAction.REMOVE to "Delete this scheduled task?",
            AidenApprovalScheduleAction.RUN_NOW to "Run this scheduled task now?"
        )
        showCard(scheduledTask(schedule()))
        for ((action, title) in titles) {
            compose.runOnIdle { shown.value = scheduledTask(schedule(action = action)) }
            compose.onNode(hasText(title) and isHeading()).assertIsDisplayed()
            compose.onNodeWithText("Morning briefing").assertIsDisplayed()
            compose.onNodeWithText("Weekdays at 9:00 AM").assertIsDisplayed()
            // A task being deleted never runs again.
            if (action == AidenApprovalScheduleAction.REMOVE) {
                compose.onNodeWithText("Next run", substring = true).assertDoesNotExist()
            } else {
                compose.onNodeWithText("Next run", substring = true).assertIsDisplayed()
            }
        }
        // The summary the card replaces is not shown beside it.
        compose.onNodeWithText("Create scheduled task", substring = true).assertDoesNotExist()

        compose.runOnIdle { shown.value = scheduledTask(schedule(nextRunAt = null)) }
        compose.onNodeWithText("Save this scheduled task?").assertIsDisplayed()
        compose.onNodeWithText("Next run", substring = true).assertDoesNotExist()
    }

    @Test
    fun aFullAccessTaskWithSchedulingOffSaysSoAndCanStillBeApproved() {
        showCard(scheduledTask(schedule(permission = AidenApprovalSchedulePermission.FULL, workspaceName = null, schedulerEnabled = false)))

        compose.onNodeWithContentDescription("Access, Full access").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Runs in, Anywhere on your computer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("Model, OpenRouter · Qwen3 Coder").assertExists()
        compose.onNodeWithText(
            "Scheduling is off. This task will be saved but will not run automatically until you enable scheduling."
        ).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("This task stays paused.").assertDoesNotExist()
        compose.onNodeWithText("Next run", substring = true).assertDoesNotExist()

        compose.onNodeWithText("Approve task").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(AidenApprovalDecision.ALLOW to AidenApprovalScope.ONCE), responses) }
    }

    @Test
    fun aPausedTaskSaysItStaysPausedAndAReadOnlyOneSaysWhereItRuns() {
        showCard(scheduledTask(schedule(action = AidenApprovalScheduleAction.UPDATE, enabled = false)))

        compose.onNodeWithText("Update this scheduled task?").assertIsDisplayed()
        compose.onNodeWithContentDescription("Access, Read-only").assertExists()
        compose.onNodeWithContentDescription("Runs in, Aiden Agent").assertExists()
        compose.onNodeWithText("This task stays paused.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Scheduling is off.", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Next run", substring = true).assertDoesNotExist()
    }

    @Test
    fun withoutAValidCardTheApprovalShowsItsSummaryAsBefore() {
        showCard(scheduledTask(null))

        compose.onNodeWithText("Create scheduled task", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Check the exact schedule and unattended access before Aiden saves it.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Runs in", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Morning briefing").assertDoesNotExist()
        compose.onNodeWithText("Scheduled work runs on your desktop", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Approve task").assertIsDisplayed()

        // A card on another tool's approval is not that tool's card.
        compose.runOnIdle { shown.value = scheduledTask(schedule(), toolName = "run_command") }
        compose.onNodeWithText("Run this command?").assertIsDisplayed()
        compose.onNodeWithContentDescription("Runs in", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Morning briefing").assertDoesNotExist()
        compose.onNodeWithText("Allow once").assertIsDisplayed()
    }

    @Test
    fun aCardThePhoneCannotAllowKeepsItsNoteAndOffersOnlyCancel() {
        showCard(scheduledTask(schedule(), hostCanAllow = false))

        compose.onNodeWithText("Save this scheduled task?").assertIsDisplayed()
        compose.onNodeWithText(
            "Review the full unattended access scope and confirm in Aiden on your paired desktop. You can deny it here."
        ).assertIsDisplayed()
        compose.onNodeWithText("Approve task").assertDoesNotExist()
        compose.onNodeWithText("Cancel").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf(AidenApprovalDecision.DENY to AidenApprovalScope.ONCE), responses) }

        compose.runOnIdle { shown.value = scheduledTask(schedule(), hasRequiredWriteCapability = false) }
        compose.onNodeWithText("Schedule write access is required to approve this task.").assertIsDisplayed()
        compose.onNodeWithText("Approve task").assertDoesNotExist()
    }

    @Test
    fun detailsBelowTheFoldHaveACueUntilTheyAreInView() {
        showCard(scheduledTask(schedule()), bodyMaxHeight = 240.dp)

        compose.onNodeWithText("Scroll for more details").assertIsDisplayed()
        compose.onNodeWithText("Approve task").assertIsDisplayed()

        compose.onNode(hasScrollAction()).performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 100_000f) }
        compose.onNodeWithText("Scroll for more details").assertDoesNotExist()
        compose.onNodeWithText("Scheduled work runs on your desktop", substring = true).assertIsDisplayed()
    }
}
