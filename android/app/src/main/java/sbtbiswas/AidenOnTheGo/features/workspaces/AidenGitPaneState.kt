package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.runtime.*
import androidx.lifecycle.ViewModel
import sbtbiswas.AidenOnTheGo.models.*
import java.util.UUID

/** Session state survives pane transitions and Activity recreation. */
class AidenGitPaneState : ViewModel() {
    val contentScroll = androidx.compose.foundation.ScrollState(0)
    val listScroll = androidx.compose.foundation.lazy.LazyListState()
    fun connectionChanged() {
        if (isOperating) lastError = "The connection changed during a Git operation. Review its result before trying again."
        isOperating = false
        isCheckingPush = false
        pushCapability = null
        lastFailedOperation = null
    }
    var hasRequested = false
    var loadedClient: Any? = null
    var gitReviewResult by mutableStateOf<AidenGitResult?>(null)
    var selectedDiff by mutableStateOf<AidenGitDiff?>(null)
    var isLoading by mutableStateOf(true)
    var lastError by mutableStateOf<String?>(null)

    // Last operation for retry
    var lastFailedOperation by mutableStateOf<(() -> Unit)?>(null)
    var lastIdempotencyKey by mutableStateOf(UUID.randomUUID())

    // Sheets & Dialogs
    var showCommitSheet by mutableStateOf(false)
    var showBranchSheet by mutableStateOf(false)
    var showPushDialog by mutableStateOf(false)
    var showCompareDialog by mutableStateOf(false)
    var showWorktreesSheet by mutableStateOf(false)
    var pushCapability by mutableStateOf<AidenGitPushCapability?>(null)
    var pushRemote by mutableStateOf("origin")
    var pushBranch by mutableStateOf("")
    var isCheckingPush by mutableStateOf(false)
    var isOperating by mutableStateOf(false)

}
