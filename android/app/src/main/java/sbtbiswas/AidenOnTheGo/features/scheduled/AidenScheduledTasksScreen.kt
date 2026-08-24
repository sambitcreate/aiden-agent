package sbtbiswas.AidenOnTheGo.features.scheduled

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenScheduledTasksScreen(
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client = coordinator.client.collectAsState().value

    var tasks by remember { mutableStateOf<List<AidenScheduledTask>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }

    LaunchedEffect(client) {
        if (client != null) {
            try {
                tasks = client.scheduledTasks()
            } catch (_: Exception) {} finally {
                isLoading = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Scheduled Tasks", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = palette.foreground)
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
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            contentPadding = PaddingValues(vertical = 8.dp)
        ) {
            items(tasks) { task ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(16.dp)
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = task.name,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = palette.foreground
                            )
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = "Schedule: ${task.schedule}",
                                style = MaterialTheme.typography.bodySmall,
                                color = palette.secondary
                            )
                            task.lastResult?.let { res ->
                                Spacer(modifier = Modifier.height(2.dp))
                                Text(
                                    text = "Last run: ${res.name.lowercase()}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (res == AidenScheduledTaskResult.SUCCESS) palette.success else palette.warning
                                )
                            }
                        }

                        Switch(
                            checked = task.enabled,
                            onCheckedChange = { checked ->
                                scope.launch {
                                    if (client != null) {
                                        try {
                                            if (checked) {
                                                client.resumeScheduledTask(task.id, task.revision)
                                            } else {
                                                client.pauseScheduledTask(task.id, task.revision)
                                            }
                                            tasks = client.scheduledTasks()
                                        } catch (_: Exception) {}
                                    }
                                }
                            },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color.White,
                                checkedTrackColor = palette.accent
                            )
                        )
                    }
                }
            }
        }
    }
}
