package sbtbiswas.AidenOnTheGo.features.remote

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.tactilePress

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenPairingScreen(
    coordinator: AidenRemoteCoordinator,
    installationStore: AidenInstallationStore,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val installations by installationStore.installations.collectAsState()
    val activeId by installationStore.activeInstallationId.collectAsState()

    var manualCode by remember { mutableStateOf("") }
    var endpointUrl by remember { mutableStateOf("") }
    var qrJsonInput by remember { mutableStateOf("") }
    var selectedTab by remember { mutableStateOf(0) } // 0: Scan QR, 1: Setup Code, 2: Paste JSON
    var isPairing by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var installationPendingRemoval by remember { mutableStateOf<AidenInstallation?>(null) }

    fun formatCrockfordCode(input: String): String {
        val clean = input.uppercase().replace("-", "").filter { it in "0123456789ABCDEFGHJKMNPQRSTVWXYZIL" }.take(20)
        val chunks = clean.chunked(4)
        return chunks.joinToString("-")
    }

    fun handleScannedQRCode(scannedText: String) {
        scope.launch {
            isPairing = true
            errorMessage = null
            try {
                val json = Json { ignoreUnknownKeys = true }
                val payload = json.decodeFromString<AidenPairingPayload>(scannedText.trim())
                coordinator.pairWithQRCode(payload)
                onDismiss()
            } catch (e: Exception) {
                errorMessage = e.message ?: "Invalid QR Code payload format"
            } finally {
                isPairing = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Paired Macs", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
        ) {
            // Paired Macs List
            if (installations.isNotEmpty()) {
                Text(
                    text = "Active Installations",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    color = palette.secondary
                )
                Spacer(modifier = Modifier.height(8.dp))

                installations.forEach { install ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .tactilePress {
                                installationStore.setActiveInstallation(install.id)
                                coordinator.refreshClient()
                            },
                        colors = CardDefaults.cardColors(
                            containerColor = if (install.id == activeId) palette.accent.copy(alpha = 0.12f) else palette.raised
                        ),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(14.dp)
                        ) {
                            Icon(
                                imageVector = Icons.Default.Laptop,
                                contentDescription = null,
                                tint = if (install.id == activeId) palette.accent else palette.secondary
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = install.name,
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = palette.foreground
                                    )
                                    if (install.id == activeId) {
                                        Spacer(modifier = Modifier.width(6.dp))
                                        Surface(
                                            color = palette.accent,
                                            shape = RoundedCornerShape(4.dp)
                                        ) {
                                            Text(
                                                text = "ACTIVE",
                                                style = MaterialTheme.typography.labelSmall,
                                                fontSize = 9.sp,
                                                color = Color.White,
                                                modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp)
                                            )
                                        }
                                    }
                                }
                                Spacer(modifier = Modifier.height(2.dp))
                                Text(
                                    text = install.endpoint,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = palette.secondary
                                )
                            }
                            IconButton(
                                onClick = { installationPendingRemoval = install }
                            ) {
                                Icon(
                                    Icons.Default.DeleteOutline,
                                    contentDescription = "Remove ${install.name}",
                                    tint = palette.danger
                                )
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(24.dp))
            }

            // Pair New Mac Section
            Text(
                text = "Pair New Mac",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = palette.secondary
            )
            Spacer(modifier = Modifier.height(8.dp))

            // M3 Expressive 3-Tab Pill Segmented Group
            Surface(
                color = palette.raised,
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(4.dp)
                ) {
                    // Tab 0: Scan QR
                    Surface(
                        color = if (selectedTab == 0) palette.accent else Color.Transparent,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier
                            .weight(1f)
                            .tactilePress { selectedTab = 0 }
                    ) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier.padding(vertical = 8.dp)
                        ) {
                            Text(
                                text = "Scan QR",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = if (selectedTab == 0) Color.White else palette.secondary
                            )
                        }
                    }

                    // Tab 1: Setup Code
                    Surface(
                        color = if (selectedTab == 1) palette.accent else Color.Transparent,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier
                            .weight(1f)
                            .tactilePress { selectedTab = 1 }
                    ) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier.padding(vertical = 8.dp)
                        ) {
                            Text(
                                text = "Setup Code",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = if (selectedTab == 1) Color.White else palette.secondary
                            )
                        }
                    }

                    // Tab 2: Paste JSON
                    Surface(
                        color = if (selectedTab == 2) palette.accent else Color.Transparent,
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier
                            .weight(1f)
                            .tactilePress { selectedTab = 2 }
                    ) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier.padding(vertical = 8.dp)
                        ) {
                            Text(
                                text = "Paste JSON",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = if (selectedTab == 2) Color.White else palette.secondary
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            errorMessage?.let { msg ->
                Surface(
                    color = palette.danger.copy(alpha = 0.12f),
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = msg,
                        style = MaterialTheme.typography.bodySmall,
                        color = palette.danger,
                        modifier = Modifier.padding(12.dp)
                    )
                }
                Spacer(modifier = Modifier.height(12.dp))
            }

            when (selectedTab) {
                0 -> {
                    // Live Camera QR Code Scanner
                    AidenQRCodeScanner(
                        onCodeScanned = { scanned ->
                            handleScannedQRCode(scanned)
                        }
                    )
                    if (isPairing) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            CircularProgressIndicator(color = palette.accent, modifier = Modifier.size(20.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Pairing with Mac...", style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                        }
                    }
                }
                1 -> {
                    // Manual 20-character Crockford code
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = manualCode,
                        onValueChange = { manualCode = formatCrockfordCode(it) },
                        label = { Text("20-Character Setup Code") },
                        placeholder = { Text("0123-4567-89AB-CDEF-GHJK") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, letterSpacing = 2.sp),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    TextField(

                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = endpointUrl,
                        onValueChange = { endpointUrl = it },
                        label = { Text("Mac Address (HTTPS Endpoint)") },
                        placeholder = { Text("https://your-mac/api/aiden/v1") },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = {
                            scope.launch {
                                isPairing = true
                                errorMessage = null
                                try {
                                    coordinator.pairWithManualCode(manualCode, endpointUrl)
                                    onDismiss()
                                } catch (e: Exception) {
                                    errorMessage = e.message ?: "Failed to pair with setup code"
                                } finally {
                                    isPairing = false
                                }
                            }
                        },
                        enabled = manualCode.replace("-", "").length == 20 && endpointUrl.isNotBlank() && !isPairing,
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .tactilePress()
                    ) {
                        if (isPairing) {
                            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp))
                        } else {
                            Text("Connect & Pair", color = Color.White, fontWeight = FontWeight.Bold)
                        }
                    }
                }
                2 -> {
                    // QR Payload JSON Input Fallback
                    TextField(
                        colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                        value = qrJsonInput,
                        onValueChange = { qrJsonInput = it },
                        label = { Text("QR Code Payload JSON") },
                        placeholder = { Text("Paste QR code JSON string from Aiden Agent") },
                        minLines = 4,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(modifier = Modifier.height(16.dp))

                    Button(
                        onClick = {
                            handleScannedQRCode(qrJsonInput)
                        },
                        enabled = qrJsonInput.trim().isNotEmpty() && !isPairing,
                        colors = ButtonDefaults.buttonColors(containerColor = palette.accent),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .tactilePress()
                    ) {
                        if (isPairing) {
                            CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp))
                        } else {
                            Text("Import & Pair", color = Color.White, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }

    installationPendingRemoval?.let { installation ->
        AlertDialog(
            onDismissRequest = { installationPendingRemoval = null },
            title = { Text("Remove ${installation.name}?") },
            text = {
                Text("This removes the pairing credential and all cached chats, Bots, usage, drafts, and workspace data for this Mac from this device.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        coordinator.removeInstallation(installation.id)
                        installationPendingRemoval = null
                    }
                ) {
                    Text("Remove", color = palette.danger, fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = {
                TextButton(onClick = { installationPendingRemoval = null }) {
                    Text("Cancel", color = palette.foreground)
                }
            },
            containerColor = palette.raised,
            titleContentColor = palette.foreground,
            textContentColor = palette.secondary
        )
    }
}
