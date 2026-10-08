package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.activity.compose.BackHandler
import sbtbiswas.AidenOnTheGo.ui.theme.rememberAidenFullSheetState
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.CompareArrows
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import sbtbiswas.AidenOnTheGo.persistence.AidenReadSnapshotKeys
import sbtbiswas.AidenOnTheGo.ui.theme.AidenActivityDot
import sbtbiswas.AidenOnTheGo.ui.theme.AidenEmptyState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenPrimaryButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSkeletonList
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReadableWidth
import java.util.UUID
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.platform.LocalResources
import sbtbiswas.AidenOnTheGo.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenGitScreen(
    workspaceId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsStateWithLifecycle().value

    val instanceId = coordinator.activeInstanceId
    val snapshots = coordinator.readSnapshotCache
    // The last review of this Workspace renders at once. Its snapshot id is stale until a
    // fresh read lands, so actions that send it (commit, diffs, checkout, push) wait for that.
    var gitReviewResult by remember(workspaceId, instanceId) {
        mutableStateOf(
            instanceId?.let { snapshots.load(it, AidenReadSnapshotKeys.gitReview(workspaceId), AidenGitResult.serializer()) }
        )
    }
    var reviewIsFresh by remember(workspaceId, instanceId) { mutableStateOf(false) }
    var selectedDiff by remember { mutableStateOf<AidenGitDiff?>(null) }
    BackHandler(enabled = selectedDiff != null) { selectedDiff = null }
    var isLoading by remember { mutableStateOf(true) }
    var reviewLoadFailed by remember { mutableStateOf(false) }
    var lastError by remember { mutableStateOf<String?>(null) }
    // Git writes can be refused (conflicts, dirty trees, remotes), so they are never
    // shown as done early; the branch card carries an in-place pending label instead.
    var pendingOperation by remember { mutableStateOf<String?>(null) }

    // Last operation for retry
    var lastFailedOperation by remember { mutableStateOf<(() -> Unit)?>(null) }
    var lastIdempotencyKey by remember { mutableStateOf(UUID.randomUUID()) }

    // Sheets & Dialogs
    var showCommitSheet by remember { mutableStateOf(false) }
    var showBranchSheet by remember { mutableStateOf(false) }
    var showPushDialog by remember { mutableStateOf(false) }
    var showCompareDialog by remember { mutableStateOf(false) }
    var showWorktreesSheet by remember { mutableStateOf(false) }
    var pushCapability by remember { mutableStateOf<AidenGitPushCapability?>(null) }
    var pushRemote by remember { mutableStateOf("origin") }
    var pushBranch by remember { mutableStateOf("") }
    var isCheckingPush by remember { mutableStateOf(false) }
    var isOperating by remember { mutableStateOf(false) }

    fun refreshGit() {
        if (client != null) {
            val requestClient = client
            val requestInstance = instanceId
            isLoading = true
            reviewLoadFailed = false
            scope.launch {
                try {
                    val res = requestClient.gitReview(workspaceId)
                    // A pairing removed or switched mid-read must not get this response back.
                    if (!coordinator.storeReadSnapshotIfCurrent(requestClient, requestInstance, AidenReadSnapshotKeys.gitReview(workspaceId), res, AidenGitResult.serializer())) return@launch
                    gitReviewResult = res
                    reviewIsFresh = true
                    lastError = null
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    reviewLoadFailed = true
                    lastError = e.localizedMessage
                } finally {
                    isLoading = false
                }
            }
        } else {
            isLoading = false
        }
    }

    /** Runs one Git write with a pending label, then rereads the review. */
    fun runGitOperation(label: String, onFailure: (Exception) -> Unit = {}, write: suspend () -> Unit) {
        if (pendingOperation != null) return
        pendingOperation = label
        scope.launch {
            try {
                write()
                lastError = null
                // The write moved the repository on; snapshot actions wait for the reread.
                reviewIsFresh = false
                refreshGit()
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                lastError = e.localizedMessage
                onFailure(e)
            } finally {
                pendingOperation = null
            }
        }
    }

    LaunchedEffect(client, workspaceId) {
        refreshGit()
    }

    val review = gitReviewResult?.review
    val diffColors = aidenDiffColors(palette)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (selectedDiff != null) selectedDiff!!.displayPath else stringResource(R.string.git_review_title), fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            if (selectedDiff != null) {
                                selectedDiff = null
                            } else {
                                onNavigateBack()
                            }
                        }
                    ) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back), tint = palette.foreground)
                    }
                },
                actions = {
                    if (selectedDiff == null) {
                        IconButton(onClick = { refreshGit() }) {
                            Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.action_refresh), tint = palette.foreground)
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = palette.canvas,
                    titleContentColor = palette.foreground
                )
            )
        },
        containerColor = palette.canvas
    ) { padding ->
        val diff = selectedDiff
        if (diff != null) {
            // Unified Diff View
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                if (diff.truncated) {
                    Surface(
                        color = palette.warning.copy(alpha = 0.15f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                        ) {
                            Icon(Icons.Default.Warning, contentDescription = null, tint = palette.warning, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(stringResource(R.string.git_diff_truncated), style = MaterialTheme.typography.bodySmall, color = palette.foreground)
                        }
                    }
                }

                Card(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState()),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = MaterialTheme.shapes.medium
                ) {
                    Column(modifier = Modifier.padding(vertical = 12.dp)) {
                        diff.diff.lines().forEach { line ->
                            val kind = aidenDiffLineKind(line)
                            Text(
                                text = line,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                color = diffColors.ink(kind),
                                fontSize = 12.sp,
                                lineHeight = 18.sp,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(diffColors.fill(kind))
                                    .padding(horizontal = 12.dp)
                            )
                        }
                    }
                }
            }
        } else {
            // Main Review & Tools view
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .aidenReadableWidth()
            ) {
                if (lastError != null) {
                    Surface(
                        color = palette.danger.copy(alpha = 0.15f),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                        ) {
                            Icon(Icons.Default.Error, contentDescription = null, tint = palette.danger, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text(
                                text = lastError!!,
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.danger,
                                modifier = Modifier.weight(1f)
                            )
                            if (lastFailedOperation != null) {
                                TextButton(
                                    onClick = {
                                        lastFailedOperation?.invoke()
                                    }
                                ) {
                                    Text(stringResource(R.string.action_retry), color = palette.accent, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }
                }

                if (review == null) {
                    if (isLoading || (!reviewLoadFailed && client != null)) {
                        AidenSkeletonList(count = 6, loadingDescription = stringResource(R.string.git_loading_changes))
                    } else {
                        AidenEmptyState(
                            icon = Icons.Default.CloudOff,
                            title = stringResource(R.string.git_changes_unavailable),
                            body = if (client == null) stringResource(R.string.git_changes_connect) else stringResource(R.string.git_changes_read_failed),
                            modifier = Modifier.fillMaxWidth().padding(top = 32.dp),
                            action = if (client != null) {
                                { AidenTonalButton(text = stringResource(R.string.action_try_again), onClick = { refreshGit() }) }
                            } else null
                        )
                    }
                }
                if (review != null) {
                    // Branch & Info Card
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = MaterialTheme.shapes.medium
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.ForkRight, contentDescription = null, tint = palette.accent)
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = stringResource(R.string.git_branch_label, review.branch),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f)
                                )
                                Surface(
                                    color = if (review.uncommitted > 0) palette.warning.copy(alpha = 0.15f) else palette.success.copy(alpha = 0.15f),
                                    shape = MaterialTheme.shapes.small
                                ) {
                                    Text(
                                        text = if (review.uncommitted > 0) pluralStringResource(R.plurals.git_uncommitted_count, review.uncommitted, review.uncommitted) else stringResource(R.string.git_clean),
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (review.uncommitted > 0) palette.warning else palette.success,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            val status = pendingOperation ?: if (!reviewIsFresh && isLoading) stringResource(R.string.git_checking_changes) else null
                            if (status != null) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .padding(top = 8.dp)
                                        .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
                                ) {
                                    AidenActivityDot(color = palette.secondary, size = 6.dp)
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(status, style = MaterialTheme.typography.bodySmall, color = palette.secondary)
                                }
                            }

                            Spacer(modifier = Modifier.height(12.dp))

                            AidenGitActionBar(
                                pushInFlight = isCheckingPush,
                                onBranch = { showBranchSheet = true },
                                onPush = {
                                    if (client != null && !isCheckingPush && reviewIsFresh && pendingOperation == null) {
                                        isCheckingPush = true
                                        scope.launch {
                                            try {
                                                val cap = client.gitPushCapability(workspaceId)
                                                pushCapability = cap.pushCapability
                                                pushRemote = cap.pushCapability?.remote ?: "origin"
                                                pushBranch = cap.pushCapability?.branch ?: review.branch
                                                showPushDialog = true
                                            } catch (e: Exception) {
                                                lastError = e.localizedMessage
                                            } finally {
                                                isCheckingPush = false
                                            }
                                        }
                                    }
                                },
                                onCompare = { showCompareDialog = true },
                                onWorktrees = { showWorktreesSheet = true }
                            )
                        }
                    }

                    // Changed files or Clean state
                    if (review.files.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(40.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Icon(Icons.Default.CheckCircle, contentDescription = null, tint = palette.success, modifier = Modifier.size(56.dp))
                                Spacer(modifier = Modifier.height(12.dp))
                                Text(stringResource(R.string.git_clean_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = palette.foreground)
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(stringResource(R.string.git_clean_body), style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                            }
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
                        ) {
                            items(review.files, key = { it.id }) { file ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 3.dp)
                                        .clip(MaterialTheme.shapes.small)
                                        .clickable(enabled = reviewIsFresh) {
                                            scope.launch {
                                                if (client != null) {
                                                    try {
                                                        val snapshotId = gitReviewResult?.snapshotId ?: ""
                                                        val res = client.gitDiff(workspaceId, snapshotId, file.id)
                                                        selectedDiff = res.diff
                                                    } catch (e: Exception) {
                                                        lastError = e.localizedMessage
                                                    }
                                                }
                                            }
                                        },
                                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                                    shape = MaterialTheme.shapes.small
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp)
                                    ) {
                                        val statusTint = aidenGitStatusTint(file.status, palette)
                                        Surface(
                                            color = statusTint.copy(alpha = 0.15f),
                                            shape = MaterialTheme.shapes.small
                                        ) {
                                            Text(
                                                text = file.status.symbol,
                                                style = MaterialTheme.typography.labelMedium,
                                                fontWeight = FontWeight.Bold,
                                                color = statusTint,
                                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                            )
                                        }
                                        Spacer(modifier = Modifier.width(10.dp))
                                        Text(
                                            text = file.displayPath,
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = palette.foreground,
                                            modifier = Modifier.weight(1f)
                                        )
                                        if (file.additions != null || file.deletions != null) {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                file.additions?.let { adds ->
                                                    Text("+$adds", color = diffColors.additionInk, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                                                    Spacer(modifier = Modifier.width(4.dp))
                                                }
                                                file.deletions?.let { dels ->
                                                    Text("-$dels", color = diffColors.deletionInk, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Commit Bottom Bar
                        Surface(
                            color = palette.canvas,
                            shadowElevation = 8.dp,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            AidenPrimaryButton(
                                text = pendingOperation ?: pluralStringResource(R.plurals.git_commit_changes_count, review.files.size, review.files.size),
                                onClick = { showCommitSheet = true },
                                enabled = reviewIsFresh && pendingOperation == null,
                                leadingIcon = Icons.Default.Check,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp)
                            )
                        }
                    }
                }
            }
        }
    }

    // --- Commit Sheet ---
    if (showCommitSheet && gitReviewResult != null) {
        var commitMessage by remember { mutableStateOf("") }
        var stagedOnly by remember { mutableStateOf(false) }
        var showConfirmDialog by remember { mutableStateOf(false) }

        ModalBottomSheet(
            onDismissRequest = { showCommitSheet = false },
            containerColor = palette.canvas
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
            ) {
                Text(
                    text = stringResource(R.string.git_commit_changes),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = palette.foreground
                )
                Spacer(modifier = Modifier.height(12.dp))

                TextField(

                    colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                    value = commitMessage,
                    onValueChange = { commitMessage = it },
                    label = { Text(stringResource(R.string.git_commit_message)) },
                    placeholder = { Text(stringResource(R.string.git_commit_message_placeholder)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(120.dp),
                    maxLines = 5
                )

                Spacer(modifier = Modifier.height(12.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { stagedOnly = !stagedOnly }
                        .padding(vertical = 4.dp)
                ) {
                    Checkbox(
                        checked = stagedOnly,
                        onCheckedChange = { stagedOnly = it },
                        colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = stringResource(R.string.git_stage_reviewed_only),
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.foreground
                    )
                }

                Spacer(modifier = Modifier.height(16.dp))

                AidenPrimaryButton(
                    text = stringResource(R.string.git_review_and_commit),
                    onClick = {
                        if (commitMessage.trim().isNotEmpty()) {
                            showConfirmDialog = true
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = commitMessage.trim().isNotEmpty() && !isOperating
                )
            }

            if (showConfirmDialog) {
                AidenWorkspaceAlertDialog(
                    title = stringResource(R.string.git_confirm_commit),
                    onDismissRequest = { showConfirmDialog = false },
                    confirmText = stringResource(R.string.git_commit),
                    onConfirm = confirm@{
                        showConfirmDialog = false
                        showCommitSheet = false
                        val snapshotId = gitReviewResult?.snapshotId ?: return@confirm
                        val key = UUID.randomUUID()
                        lastIdempotencyKey = key
                        val message = commitMessage.trim()
                        var op: (() -> Unit)? = null
                        op = {
                            if (client != null) {
                                isOperating = true
                                runGitOperation(
                                    label = resources.getString(R.string.git_committing),
                                    onFailure = { lastFailedOperation = op }
                                ) {
                                    try {
                                        client.commitGit(
                                            workspaceId = workspaceId,
                                            snapshotId = snapshotId,
                                            message = message,
                                            stagedOnly = stagedOnly,
                                            idempotencyKey = key
                                        )
                                        lastFailedOperation = null
                                    } finally {
                                        isOperating = false
                                    }
                                }
                            }
                        }
                        op.invoke()
                    }
                ) {
                    Text(stringResource(R.string.git_commit_confirm_body, review?.branch.orEmpty(), commitMessage.trim()))
                }
            }
        }
    }

    // --- Branch Selector Sheet ---
    if (showBranchSheet) {
        var branchesResult by remember {
            mutableStateOf(instanceId?.let { snapshots.load(it, AidenReadSnapshotKeys.gitBranches(workspaceId), AidenGitBranches.serializer()) })
        }
        var showNewBranchDialog by remember { mutableStateOf(false) }
        var branchToCheckout by remember { mutableStateOf<String?>(null) }

        LaunchedEffect(Unit) {
            if (client != null) {
                val requestClient = client
                val requestInstance = instanceId
                try {
                    val res = requestClient.gitBranches(workspaceId)
                    if (!coordinator.holdsReadAuthority(requestClient, requestInstance)) return@LaunchedEffect
                    branchesResult = res.branches
                    res.branches?.let { branches ->
                        coordinator.storeReadSnapshotIfCurrent(requestClient, requestInstance, AidenReadSnapshotKeys.gitBranches(workspaceId), branches, AidenGitBranches.serializer())
                    }
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    // The saved list stays; a first read that fails says so in the review banner.
                    if (branchesResult == null) lastError = e.localizedMessage
                }
            }
        }

        ModalBottomSheet(
            onDismissRequest = { showBranchSheet = false },
            sheetState = rememberAidenFullSheetState(),
            containerColor = palette.canvas,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = stringResource(R.string.git_branches_title),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { showNewBranchDialog = true }) {
                        Icon(Icons.Default.Add, contentDescription = null, tint = palette.accent)
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(stringResource(R.string.git_new_branch), color = palette.accent, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                val branches = branchesResult?.branches ?: emptyList()
                val current = branchesResult?.current ?: review?.branch ?: ""

                if (branchesResult == null && client != null) {
                    AidenSkeletonList(count = 4, loadingDescription = stringResource(R.string.git_loading_branches))
                }
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                ) {
                    items(branches, key = { it }) { branch ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 3.dp)
                                .clip(MaterialTheme.shapes.small)
                                .clickable(enabled = reviewIsFresh && pendingOperation == null) {
                                    if (branch != current) {
                                        branchToCheckout = branch
                                    }
                                },
                            colors = CardDefaults.cardColors(
                                containerColor = if (branch == current) palette.accent.copy(alpha = 0.15f) else palette.raised
                            ),
                            shape = MaterialTheme.shapes.small
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(12.dp)
                            ) {
                                Icon(
                                    Icons.Default.ForkRight,
                                    contentDescription = null,
                                    tint = if (branch == current) palette.accent else palette.secondary
                                )
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(
                                    text = branch,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = if (branch == current) FontWeight.Bold else FontWeight.Normal,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f)
                                )
                                if (branch == current) {
                                    Icon(Icons.Default.Check, contentDescription = stringResource(R.string.git_active_branch_cd), tint = palette.accent)
                                }
                            }
                        }
                    }
                }
            }

            // Checkout branch confirmation
            if (branchToCheckout != null) {
                val targetBranch = branchToCheckout!!
                AidenWorkspaceAlertDialog(
                    title = stringResource(R.string.git_checkout_title),
                    onDismissRequest = { branchToCheckout = null },
                    confirmText = stringResource(R.string.git_checkout),
                    onConfirm = {
                        val branch = targetBranch
                        branchToCheckout = null
                        showBranchSheet = false
                        val snapshotId = gitReviewResult?.snapshotId ?: ""
                        if (client != null) {
                            runGitOperation(resources.getString(R.string.git_switching_to, branch)) {
                                client.checkoutGitBranch(workspaceId, branch, snapshotId)
                            }
                        }
                    }
                ) {
                    Text(stringResource(R.string.git_checkout_body, targetBranch))
                }
            }

            // Create new branch dialog
            if (showNewBranchDialog) {
                var newBranchName by remember { mutableStateOf("") }
                var startPoint by remember { mutableStateOf(review?.branch ?: "main") }

                AidenWorkspaceAlertDialog(
                    title = stringResource(R.string.git_create_branch_title),
                    onDismissRequest = { showNewBranchDialog = false },
                    confirmText = stringResource(R.string.action_create),
                    onConfirm = {
                        val name = newBranchName.trim()
                        val start = startPoint.trim()
                        if (name.isNotEmpty()) {
                            showNewBranchDialog = false
                            showBranchSheet = false
                            if (client != null) {
                                runGitOperation(resources.getString(R.string.git_creating_branch, name)) {
                                    client.createGitBranch(workspaceId, name, start)
                                }
                            }
                        }
                    }
                ) {
                    Column {
                        TextField(
                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = newBranchName,
                            onValueChange = { newBranchName = it },
                            label = { Text(stringResource(R.string.git_branch_name)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        TextField(
                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = startPoint,
                            onValueChange = { startPoint = it },
                            label = { Text(stringResource(R.string.git_start_point)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
        }
    }

    // --- Push Dialog ---
    if (showPushDialog) {
        val cap = pushCapability
        AidenWorkspaceAlertDialog(
            title = stringResource(R.string.git_push_title),
            onDismissRequest = { showPushDialog = false },
            confirmText = if (cap?.allowed != false) stringResource(R.string.git_push) else null,
            onConfirm = {
                showPushDialog = false
                val snapshotId = gitReviewResult?.snapshotId ?: ""
                if (client != null) {
                    runGitOperation(resources.getString(R.string.git_pushing, pushBranch)) {
                        client.pushGit(workspaceId, snapshotId, pushRemote, pushBranch)
                    }
                }
            }
        ) {
            Column {
                if (cap?.allowed == false) {
                    Text(
                        text = stringResource(R.string.git_push_not_allowed, cap.reason ?: stringResource(R.string.git_permission_denied)),
                        color = palette.danger
                    )
                } else {
                    Text(stringResource(R.string.git_push_body, pushBranch, pushRemote))
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.git_never_force_push),
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.secondary
                    )
                }
            }
        }
    }

    // --- Compare Dialog ---
    if (showCompareDialog) {
        var baseRef by remember { mutableStateOf("main") }
        var comparisonResult by remember { mutableStateOf<AidenGitComparison?>(null) }
        var isComparing by remember { mutableStateOf(false) }

        ModalBottomSheet(
            onDismissRequest = { showCompareDialog = false },
            sheetState = rememberAidenFullSheetState(),
            containerColor = palette.canvas,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
            ) {
                Text(stringResource(R.string.git_compare_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = palette.foreground)
                Spacer(modifier = Modifier.height(12.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = baseRef,
                        onValueChange = { baseRef = it },
                        label = { Text(stringResource(R.string.git_base_branch)) },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        enabled = !isComparing,
                        onClick = {
                            if (client != null && baseRef.trim().isNotEmpty() && !isComparing) {
                                isComparing = true
                                scope.launch {
                                    try {
                                        val res = client.compareGit(workspaceId, baseRef.trim())
                                        comparisonResult = res.comparison
                                    } catch (e: Exception) {
                                        lastError = e.localizedMessage
                                    } finally {
                                        isComparing = false
                                    }
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = palette.accent,
                            contentColor = palette.onAccent,
                            disabledContainerColor = palette.accent.copy(alpha = 0.6f),
                            disabledContentColor = palette.onAccent
                        ),
                        shape = AidenShape.Button
                    ) {
                        Text(if (isComparing) stringResource(R.string.git_comparing) else stringResource(R.string.git_compare))
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // A comparison is a read: its result previews as rows, not a spinner.
                if (isComparing && comparisonResult == null) {
                    AidenSkeletonList(count = 4, leading = false, loadingDescription = stringResource(R.string.git_comparing_branches))
                }
                comparisonResult?.let { comp ->
                    Text(
                        text = pluralStringResource(R.plurals.git_compare_summary, comp.files.size, comp.files.size, comp.base, comp.head),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.secondary
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    LazyColumn(modifier = Modifier.weight(1f, fill = false)) {
                        items(comp.files, key = { it.id }) { file ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 2.dp),
                                colors = CardDefaults.cardColors(containerColor = palette.raised),
                                shape = MaterialTheme.shapes.small
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(10.dp)
                                ) {
                                    Text(
                                        text = file.status.symbol,
                                        color = aidenGitStatusTint(file.status, palette),
                                        fontWeight = FontWeight.Bold,
                                        style = MaterialTheme.typography.labelSmall
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(
                                        text = file.displayPath,
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = palette.foreground
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // --- Worktrees Sheet ---
    if (showWorktreesSheet) {
        var worktreesList by remember {
            mutableStateOf(
                instanceId?.let { snapshots.load(it, AidenReadSnapshotKeys.gitWorktrees(workspaceId), AidenGitWorktrees.serializer()) }
                    ?.worktrees
            )
        }
        var showNewWorktreeDialog by remember { mutableStateOf(false) }

        LaunchedEffect(Unit) {
            if (client != null) {
                val requestClient = client
                val requestInstance = instanceId
                try {
                    val res = requestClient.gitWorktrees(workspaceId)
                    val fresh = res.worktrees ?: AidenGitWorktrees(worktrees = emptyList())
                    if (!coordinator.storeReadSnapshotIfCurrent(requestClient, requestInstance, AidenReadSnapshotKeys.gitWorktrees(workspaceId), fresh, AidenGitWorktrees.serializer())) return@LaunchedEffect
                    worktreesList = fresh.worktrees
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    if (worktreesList == null) {
                        worktreesList = emptyList()
                        lastError = e.localizedMessage
                    }
                }
            }
        }

        ModalBottomSheet(
            onDismissRequest = { showWorktreesSheet = false },
            sheetState = rememberAidenFullSheetState(),
            containerColor = palette.canvas,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = stringResource(R.string.git_worktrees_title),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { showNewWorktreeDialog = true }) {
                        Icon(Icons.Default.Add, contentDescription = null, tint = palette.accent)
                        Spacer(modifier = Modifier.width(4.dp))
                        Text(stringResource(R.string.git_new_worktree), color = palette.accent, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                if (worktreesList == null && client != null) {
                    AidenSkeletonList(count = 3, loadingDescription = stringResource(R.string.git_loading_worktrees))
                }
                LazyColumn(modifier = Modifier.weight(1f, fill = false)) {
                    items(worktreesList.orEmpty(), key = { it.id }) { wt ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 3.dp),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = MaterialTheme.shapes.small
                        ) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(12.dp)
                            ) {
                                Icon(Icons.Default.AccountTree, contentDescription = null, tint = palette.accent)
                                Spacer(modifier = Modifier.width(10.dp))
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = wt.name,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Bold,
                                        color = palette.foreground
                                    )
                                    Text(
                                        text = stringResource(R.string.git_branch_label, wt.branch),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                }
                                if (wt.managed) {
                                    Surface(
                                        color = palette.accent.copy(alpha = 0.15f),
                                        shape = MaterialTheme.shapes.extraSmall
                                    ) {
                                        Text(
                                            text = stringResource(R.string.git_worktree_managed),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = palette.accent,
                                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if (showNewWorktreeDialog) {
                var wtBranch by remember { mutableStateOf("") }
                var wtName by remember { mutableStateOf("") }

                AidenWorkspaceAlertDialog(
                    title = stringResource(R.string.git_create_worktree_title),
                    onDismissRequest = { showNewWorktreeDialog = false },
                    confirmText = stringResource(R.string.action_create),
                    onConfirm = {
                        val branch = wtBranch.trim()
                        val name = wtName.trim()
                        if (branch.isNotEmpty() && name.isNotEmpty()) {
                            showNewWorktreeDialog = false
                            showWorktreesSheet = false
                            if (client != null) {
                                runGitOperation(resources.getString(R.string.git_creating_worktree, name)) {
                                    client.createGitWorktree(workspaceId, branch, name)
                                    coordinator.refreshWorkspaces()
                                }
                            }
                        }
                    }
                ) {
                    Column {
                        TextField(
                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = wtBranch,
                            onValueChange = { wtBranch = it },
                            label = { Text(stringResource(R.string.git_branch_name)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        TextField(
                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = wtName,
                            onValueChange = { wtName = it },
                            label = { Text(stringResource(R.string.git_worktree_name)) },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }
        }
    }
}

/**
 * Connected tonal action bar for the git review card. Each segment keeps its own action;
 * Push shows the activity dot while its capability check is in flight.
 */
@Composable
internal fun AidenGitActionBar(
    pushInFlight: Boolean,
    onBranch: () -> Unit,
    onPush: () -> Unit,
    onCompare: () -> Unit,
    onWorktrees: () -> Unit,
    modifier: Modifier = Modifier
) {
    val pushLabel = stringResource(R.string.git_push)
    val actions = listOf(
        Triple(stringResource(R.string.git_action_branch), Icons.Default.ForkRight, onBranch),
        Triple(pushLabel, Icons.Default.CloudUpload, onPush),
        Triple(stringResource(R.string.git_compare), Icons.AutoMirrored.Filled.CompareArrows, onCompare),
        Triple(stringResource(R.string.git_action_worktrees), Icons.Default.AccountTree, onWorktrees)
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(AidenShape.GroupGap)
    ) {
        actions.forEachIndexed { index, (label, icon, action) ->
            AidenConnectedActionSegment(
                index = index,
                count = actions.size,
                label = label,
                icon = icon,
                onClick = action,
                stacked = true,
                loading = label == pushLabel && pushInFlight,
                modifier = Modifier.weight(1f)
            )
        }
    }
}
