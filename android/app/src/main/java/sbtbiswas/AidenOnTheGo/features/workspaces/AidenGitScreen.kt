package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenUi
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenGitScreen(
    workspaceId: String,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsState().value

    var gitReviewResult by remember { mutableStateOf<AidenGitResult?>(null) }
    var selectedDiff by remember { mutableStateOf<AidenGitDiff?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var lastError by remember { mutableStateOf<String?>(null) }

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
            isLoading = true
            scope.launch {
                try {
                    val res = client.gitReview(workspaceId)
                    gitReviewResult = res
                    lastError = null
                } catch (e: Exception) {
                    lastError = e.localizedMessage
                } finally {
                    isLoading = false
                }
            }
        }
    }

    LaunchedEffect(client, workspaceId) {
        refreshGit()
    }

    val review = gitReviewResult?.review

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (selectedDiff != null) selectedDiff!!.displayPath else "Git Review", fontWeight = FontWeight.Bold) },
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
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = palette.foreground)
                    }
                },
                actions = {
                    if (selectedDiff == null) {
                        IconButton(onClick = { refreshGit() }) {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = palette.foreground)
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
                            Text("Diff truncated: payload limit exceeded", style = MaterialTheme.typography.bodySmall, color = palette.foreground)
                        }
                    }
                }

                Card(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState()),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        diff.diff.lines().forEach { line ->
                            val color = when {
                                line.startsWith("+") -> Color(0xFF4CAF50)
                                line.startsWith("-") -> Color(0xFFE53935)
                                line.startsWith("@@") -> palette.accent
                                else -> palette.foreground
                            }
                            Text(
                                text = line,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                color = color,
                                fontSize = 12.sp,
                                lineHeight = 18.sp
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
                                    Text("Retry", color = palette.accent, fontWeight = FontWeight.Bold)
                                }
                            }
                        }
                    }
                }

                if (review != null) {
                    // Branch & Info Card
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        colors = CardDefaults.cardColors(containerColor = palette.raised),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.ForkRight, contentDescription = null, tint = palette.accent)
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(
                                    text = "Branch: ${review.branch}",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = palette.foreground,
                                    modifier = Modifier.weight(1f)
                                )
                                Surface(
                                    color = if (review.uncommitted > 0) palette.warning.copy(alpha = 0.15f) else palette.success.copy(alpha = 0.15f),
                                    shape = RoundedCornerShape(8.dp)
                                ) {
                                    Text(
                                        text = if (review.uncommitted > 0) "${review.uncommitted} uncommitted" else "Clean",
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (review.uncommitted > 0) palette.warning else palette.success,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                        fontWeight = FontWeight.Bold
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(12.dp))

                            // Git action buttons row
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                OutlinedButton(
                                    border = null,
                                    onClick = { showBranchSheet = true },
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.weight(1f),
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp)
                                ) {
                                    Text("Branch", fontSize = 12.sp, maxLines = 1)
                                }

                                OutlinedButton(
                                    border = null,
                                    onClick = {
                                        if (client != null && !isCheckingPush) {
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
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.weight(1f),
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp)
                                ) {
                                    Text("Push", fontSize = 12.sp, maxLines = 1)
                                }

                                OutlinedButton(
                                    border = null,
                                    onClick = { showCompareDialog = true },
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.weight(1f),
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp)
                                ) {
                                    Text("Compare", fontSize = 12.sp, maxLines = 1)
                                }

                                OutlinedButton(
                                    border = null,
                                    onClick = { showWorktreesSheet = true },
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier.weight(1f),
                                    contentPadding = PaddingValues(horizontal = 6.dp, vertical = 4.dp)
                                ) {
                                    Text("Worktrees", fontSize = 12.sp, maxLines = 1)
                                }
                            }
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
                                Text("Working tree is clean", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = palette.foreground)
                                Spacer(modifier = Modifier.height(4.dp))
                                Text("No uncommitted changes in this workspace.", style = MaterialTheme.typography.bodyMedium, color = palette.secondary)
                            }
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
                        ) {
                            items(review.files) { file ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 3.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .clickable {
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
                                    shape = RoundedCornerShape(10.dp)
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp)
                                    ) {
                                        Surface(
                                            color = file.status.tint.copy(alpha = 0.15f),
                                            shape = RoundedCornerShape(6.dp)
                                        ) {
                                            Text(
                                                text = file.status.symbol,
                                                style = MaterialTheme.typography.labelMedium,
                                                fontWeight = FontWeight.Bold,
                                                color = file.status.tint,
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
                                                    Text("+$adds", color = Color(0xFF4CAF50), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                                                    Spacer(modifier = Modifier.width(4.dp))
                                                }
                                                file.deletions?.let { dels ->
                                                    Text("-$dels", color = Color(0xFFE53935), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
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
                            Button(
                                onClick = { showCommitSheet = true },
                                colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                                shape = RoundedCornerShape(12.dp),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp)
                            ) {
                                Icon(Icons.Default.Check, contentDescription = null, tint = Color.White)
                                Spacer(modifier = Modifier.width(8.dp))
                                Text("Commit Changes (${review.files.size} files)", color = Color.White, fontWeight = FontWeight.Bold)
                            }
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
                    text = "Commit Changes",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = palette.foreground
                )
                Spacer(modifier = Modifier.height(12.dp))

                TextField(

                    colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                    value = commitMessage,
                    onValueChange = { commitMessage = it },
                    label = { Text("Commit message") },
                    placeholder = { Text("Describe your changes...") },
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
                        text = "Stage only reviewed changes",
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.foreground
                    )
                }

                Spacer(modifier = Modifier.height(16.dp))

                Button(
                    onClick = {
                        if (commitMessage.trim().isNotEmpty()) {
                            showConfirmDialog = true
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = commitMessage.trim().isNotEmpty() && !isOperating
                ) {
                    Text("Review & Commit", color = Color.White, fontWeight = FontWeight.Bold)
                }
            }

            if (showConfirmDialog) {
                AlertDialog(
                    onDismissRequest = { showConfirmDialog = false },
                    title = { Text("Confirm Commit", fontWeight = FontWeight.Bold) },
                    text = {
                        Text("Create a commit on branch \"${review?.branch}\" with message:\n\n\"${commitMessage.trim()}\"")
                    },
                    confirmButton = {
                        Button(
                            onClick = {
                                showConfirmDialog = false
                                showCommitSheet = false
                                val snapshotId = gitReviewResult?.snapshotId ?: return@Button
                                val key = UUID.randomUUID()
                                lastIdempotencyKey = key
                                var op: (() -> Unit)? = null
                                op = {
                                    if (client != null) {
                                        isOperating = true
                                        scope.launch {
                                            try {
                                                client.commitGit(
                                                    workspaceId = workspaceId,
                                                    snapshotId = snapshotId,
                                                    message = commitMessage.trim(),
                                                    stagedOnly = stagedOnly,
                                                    idempotencyKey = key
                                                )
                                                refreshGit()
                                                lastError = null
                                            } catch (e: Exception) {
                                                lastError = e.localizedMessage
                                                lastFailedOperation = op
                                            } finally {
                                                isOperating = false
                                            }
                                        }
                                    }
                                }
                                op.invoke()
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                        ) {
                            Text("Commit", color = Color.White)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showConfirmDialog = false }) {
                            Text("Cancel", color = palette.foreground)
                        }
                    }
                )
            }
        }
    }

    // --- Branch Selector Sheet ---
    if (showBranchSheet) {
        var branchesResult by remember { mutableStateOf<AidenGitBranches?>(null) }
        var showNewBranchDialog by remember { mutableStateOf(false) }
        var branchToCheckout by remember { mutableStateOf<String?>(null) }

        LaunchedEffect(Unit) {
            if (client != null) {
                try {
                    val res = client.gitBranches(workspaceId)
                    branchesResult = res.branches
                } catch (_: Exception) {}
            }
        }

        ModalBottomSheet(
            onDismissRequest = { showBranchSheet = false },
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
                        text = "Git Branches",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { showNewBranchDialog = true }) {
                        Icon(Icons.Default.Add, contentDescription = null, tint = palette.accent)
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("New Branch", color = palette.accent, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                val branches = branchesResult?.branches ?: emptyList()
                val current = branchesResult?.current ?: review?.branch ?: ""

                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f, fill = false)
                ) {
                    items(branches) { branch ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 3.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .clickable {
                                    if (branch != current) {
                                        branchToCheckout = branch
                                    }
                                },
                            colors = CardDefaults.cardColors(
                                containerColor = if (branch == current) palette.accent.copy(alpha = 0.15f) else palette.raised
                            ),
                            shape = RoundedCornerShape(8.dp)
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
                                    Icon(Icons.Default.Check, contentDescription = "Active", tint = palette.accent)
                                }
                            }
                        }
                    }
                }
            }

            // Checkout branch confirmation
            if (branchToCheckout != null) {
                val targetBranch = branchToCheckout!!
                AlertDialog(
                    onDismissRequest = { branchToCheckout = null },
                    title = { Text("Checkout Branch?", fontWeight = FontWeight.Bold) },
                    text = { Text("Switch working tree to branch \"$targetBranch\"?") },
                    confirmButton = {
                        Button(
                            onClick = {
                                val branch = targetBranch
                                branchToCheckout = null
                                showBranchSheet = false
                                val snapshotId = gitReviewResult?.snapshotId ?: ""
                                scope.launch {
                                    if (client != null) {
                                        try {
                                            client.checkoutGitBranch(workspaceId, branch, snapshotId)
                                            refreshGit()
                                        } catch (e: Exception) {
                                            lastError = e.localizedMessage
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                        ) {
                            Text("Checkout", color = Color.White)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { branchToCheckout = null }) {
                            Text("Cancel", color = palette.foreground)
                        }
                    }
                )
            }

            // Create new branch dialog
            if (showNewBranchDialog) {
                var newBranchName by remember { mutableStateOf("") }
                var startPoint by remember { mutableStateOf(review?.branch ?: "main") }

                AlertDialog(
                    onDismissRequest = { showNewBranchDialog = false },
                    title = { Text("Create New Branch", fontWeight = FontWeight.Bold) },
                    text = {
                        Column {
                            TextField(
                                colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                                value = newBranchName,
                                onValueChange = { newBranchName = it },
                                label = { Text("Branch name") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            TextField(
                                colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                                value = startPoint,
                                onValueChange = { startPoint = it },
                                label = { Text("Start point (branch / commit)") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    },
                    confirmButton = {
                        Button(
                            onClick = {
                                val name = newBranchName.trim()
                                val start = startPoint.trim()
                                if (name.isNotEmpty()) {
                                    showNewBranchDialog = false
                                    showBranchSheet = false
                                    scope.launch {
                                        if (client != null) {
                                            try {
                                                client.createGitBranch(workspaceId, name, start)
                                                refreshGit()
                                            } catch (e: Exception) {
                                                lastError = e.localizedMessage
                                            }
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                        ) {
                            Text("Create", color = Color.White)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showNewBranchDialog = false }) {
                            Text("Cancel", color = palette.foreground)
                        }
                    }
                )
            }
        }
    }

    // --- Push Dialog ---
    if (showPushDialog) {
        val cap = pushCapability
        AlertDialog(
            onDismissRequest = { showPushDialog = false },
            title = { Text("Push to Remote", fontWeight = FontWeight.Bold) },
            text = {
                Column {
                    if (cap?.allowed == false) {
                        Text(
                            text = "Push is not allowed: ${cap.reason ?: "Permission denied"}",
                            color = palette.danger
                        )
                    } else {
                        Text("Push branch \"$pushBranch\" to remote \"$pushRemote\"?")
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Aiden never force-pushes.",
                            style = MaterialTheme.typography.bodySmall,
                            color = palette.secondary
                        )
                    }
                }
            },
            confirmButton = {
                if (cap?.allowed != false) {
                    Button(
                        onClick = {
                            showPushDialog = false
                            val snapshotId = gitReviewResult?.snapshotId ?: ""
                            scope.launch {
                                if (client != null) {
                                    try {
                                        client.pushGit(workspaceId, snapshotId, pushRemote, pushBranch)
                                        refreshGit()
                                    } catch (e: Exception) {
                                        lastError = e.localizedMessage
                                    }
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                    ) {
                        Text("Push", color = Color.White)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { showPushDialog = false }) {
                    Text("Cancel", color = palette.foreground)
                }
            }
        )
    }

    // --- Compare Dialog ---
    if (showCompareDialog) {
        var baseRef by remember { mutableStateOf("main") }
        var comparisonResult by remember { mutableStateOf<AidenGitComparison?>(null) }
        var isComparing by remember { mutableStateOf(false) }

        ModalBottomSheet(
            onDismissRequest = { showCompareDialog = false },
            containerColor = palette.canvas,
            dragHandle = null,
            sheetGesturesEnabled = AidenUi.ScrollableSheetGesturesEnabled
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp)
            ) {
                Text("Compare Branches", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = palette.foreground)
                Spacer(modifier = Modifier.height(12.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = baseRef,
                        onValueChange = { baseRef = it },
                        label = { Text("Base branch") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Button(
                        onClick = {
                            if (client != null && baseRef.trim().isNotEmpty()) {
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
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                        shape = RoundedCornerShape(8.dp)
                    ) {
                        if (isComparing) {
                            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(16.dp))
                        } else {
                            Text("Compare")
                        }
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                comparisonResult?.let { comp ->
                    Text(
                        text = "${comp.files.size} changed files between ${comp.base} and ${comp.head}:",
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.secondary
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    LazyColumn(modifier = Modifier.weight(1f, fill = false)) {
                        items(comp.files) { file ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 2.dp),
                                colors = CardDefaults.cardColors(containerColor = palette.raised),
                                shape = RoundedCornerShape(8.dp)
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(10.dp)
                                ) {
                                    Text(
                                        text = file.status.symbol,
                                        color = file.status.tint,
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
        var worktreesList by remember { mutableStateOf<List<AidenGitWorktree>>(emptyList()) }
        var showNewWorktreeDialog by remember { mutableStateOf(false) }

        LaunchedEffect(Unit) {
            if (client != null) {
                try {
                    val res = client.gitWorktrees(workspaceId)
                    worktreesList = res.worktrees?.worktrees ?: emptyList()
                } catch (_: Exception) {}
            }
        }

        ModalBottomSheet(
            onDismissRequest = { showWorktreesSheet = false },
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
                        text = "Git Worktrees",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = palette.foreground,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { showNewWorktreeDialog = true }) {
                        Icon(Icons.Default.Add, contentDescription = null, tint = palette.accent)
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("New Worktree", color = palette.accent, fontWeight = FontWeight.Bold)
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                LazyColumn(modifier = Modifier.weight(1f, fill = false)) {
                    items(worktreesList) { wt ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 3.dp),
                            colors = CardDefaults.cardColors(containerColor = palette.raised),
                            shape = RoundedCornerShape(8.dp)
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
                                        text = "Branch: ${wt.branch}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = palette.secondary
                                    )
                                }
                                if (wt.managed) {
                                    Surface(
                                        color = palette.accent.copy(alpha = 0.15f),
                                        shape = RoundedCornerShape(4.dp)
                                    ) {
                                        Text(
                                            text = "Managed",
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

                AlertDialog(
                    onDismissRequest = { showNewWorktreeDialog = false },
                    title = { Text("Create Managed Worktree", fontWeight = FontWeight.Bold) },
                    text = {
                        Column {
                            TextField(
                                colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                                value = wtBranch,
                                onValueChange = { wtBranch = it },
                                label = { Text("Branch name") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            TextField(
                                colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                                value = wtName,
                                onValueChange = { wtName = it },
                                label = { Text("Worktree name") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                    },
                    confirmButton = {
                        Button(
                            onClick = {
                                val branch = wtBranch.trim()
                                val name = wtName.trim()
                                if (branch.isNotEmpty() && name.isNotEmpty()) {
                                    showNewWorktreeDialog = false
                                    showWorktreesSheet = false
                                    scope.launch {
                                        if (client != null) {
                                            try {
                                                client.createGitWorktree(workspaceId, branch, name)
                                                coordinator.refreshWorkspaces()
                                            } catch (e: Exception) {
                                                lastError = e.localizedMessage
                                            }
                                        }
                                    }
                                }
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = palette.accent)
                        ) {
                            Text("Create", color = Color.White)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showNewWorktreeDialog = false }) {
                            Text("Cancel", color = palette.foreground)
                        }
                    }
                )
            }
        }
    }
}
