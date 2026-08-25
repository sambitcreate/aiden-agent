package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.shared.AidenProviderIcon
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.util.UUID

enum class AidenBotEditorDefaultAccess {
    RECOMMENDED,
    FULL,
    CUSTOM
}

sealed class AidenBotEditorMode {
    data class Create(val defaultAccess: AidenBotEditorDefaultAccess = AidenBotEditorDefaultAccess.RECOMMENDED) : AidenBotEditorMode()
    data class Edit(val botID: String) : AidenBotEditorMode()
}

data class AidenBotCustomAccessDraft(
    var providerID: String,
    var modelID: String,
    var fileScopeIDs: Set<String>,
    var shellEnabled: Boolean,
    var connectionIDs: Set<String>,
    var skillIDs: Set<String>,
    var otherCapabilityIDs: Set<String>
) {
    companion object {
        fun fromCatalog(catalog: AidenBotCapabilityCatalog): AidenBotCustomAccessDraft? {
            val provider = catalog.providers.firstOrNull { it.available && it.models.any { m -> m.available } } ?: return null
            val model = provider.models.firstOrNull { it.available } ?: return null
            return AidenBotCustomAccessDraft(
                providerID = provider.id,
                modelID = model.id,
                fileScopeIDs = catalog.fileScopes.filter { it.available }.map { it.id }.toSet(),
                shellEnabled = catalog.shellAvailable,
                connectionIDs = catalog.connections.filter { it.available }.map { it.id }.toSet(),
                skillIDs = catalog.skills.filter { it.available }.map { it.id }.toSet(),
                otherCapabilityIDs = catalog.otherCapabilities.filter { it.available }.map { it.id }.toSet()
            )
        }

        fun fromAccess(access: AidenBotAccessView, catalog: AidenBotCapabilityCatalog): AidenBotCustomAccessDraft? {
            val custom = access.custom
            if (custom != null) {
                return AidenBotCustomAccessDraft(
                    providerID = custom.providerId,
                    modelID = custom.modelId,
                    fileScopeIDs = custom.fileScopeIds.toSet(),
                    shellEnabled = custom.shellEnabled,
                    connectionIDs = custom.connectionIds.toSet(),
                    skillIDs = custom.skillIds.toSet(),
                    otherCapabilityIDs = custom.otherCapabilityIds.toSet()
                )
            }
            return fromCatalog(catalog)
        }
    }

    fun selection(): AidenBotCustomSelection {
        return AidenBotCustomSelection(
            fileScopeIds = fileScopeIDs.sorted(),
            shellEnabled = shellEnabled,
            connectionIds = connectionIDs.sorted(),
            skillIds = skillIDs.sorted(),
            otherCapabilityIds = otherCapabilityIDs.sorted(),
            providerId = providerID,
            modelId = modelID
        )
    }

    fun isSaveable(catalog: AidenBotCapabilityCatalog): Boolean {
        return try {
            val sel = selection()
            catalog.containsAvailable(sel)
        } catch (_: Exception) {
            false
        }
    }
}

data class AidenBotEditorDraft(
    var name: String,
    var purpose: String,
    var openingGreeting: String,
    var instructions: String,
    var avatar: AidenBotAvatarRecipe,
    var usesFullAccess: Boolean,
    var customAccess: AidenBotCustomAccessDraft
) {
    companion object {
        val DEFAULT_AVATAR = AidenBotAvatarRecipe(
            shape = AidenBotAvatarShape.ORB,
            color = AidenBotAvatarColor.SKY,
            eyes = AidenBotAvatarEyes.HAPPY,
            detail = AidenBotAvatarDetail.SPARKLES
        )

        const val DEFAULT_INSTRUCTIONS = "Help clearly, use the selected tools when useful, and keep me in control."

        fun fullAccessAccepted(catalog: AidenBotCapabilityCatalog): Boolean {
            return catalog.notice.acceptedDecision == AidenBotNoticeDecision.CONTINUE_FULL
        }

        fun createDefault(catalog: AidenBotCapabilityCatalog, defaultAccess: AidenBotEditorDefaultAccess): AidenBotEditorDraft? {
            val customAccess = AidenBotCustomAccessDraft.fromCatalog(catalog) ?: return null
            val usesFull = when (defaultAccess) {
                AidenBotEditorDefaultAccess.CUSTOM -> false
                AidenBotEditorDefaultAccess.FULL, AidenBotEditorDefaultAccess.RECOMMENDED -> fullAccessAccepted(catalog)
            }
            return AidenBotEditorDraft(
                name = "",
                purpose = "",
                openingGreeting = "",
                instructions = DEFAULT_INSTRUCTIONS,
                avatar = DEFAULT_AVATAR,
                usesFullAccess = usesFull,
                customAccess = customAccess
            )
        }

        fun fromDetail(detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog): AidenBotEditorDraft? {
            val customAccess = AidenBotCustomAccessDraft.fromAccess(detail.access, catalog) ?: return null
            if (detail.modelSelection != null) {
                val prov = catalog.providers.firstOrNull { it.id == detail.modelSelection?.providerId }
                if (prov?.models?.any { it.id == detail.modelSelection?.modelId } == true) {
                    customAccess.providerID = detail.modelSelection!!.providerId
                    customAccess.modelID = detail.modelSelection!!.modelId
                }
            }
            val recipe = when (val s = detail.avatar.semantic) {
                is AidenBotSemanticAvatar.Recipe -> s.recipe
                is AidenBotSemanticAvatar.Legacy -> {
                    val pres = aidenBotAvatarPresentation(s)
                    AidenBotAvatarRecipe(shape = pres.shape, color = pres.color, eyes = pres.eyes, detail = pres.detail)
                }
            }
            return AidenBotEditorDraft(
                name = detail.name,
                purpose = detail.purpose,
                openingGreeting = detail.openingGreeting ?: "",
                instructions = detail.instructions,
                avatar = recipe,
                usesFullAccess = detail.access.accessMode == AidenBotAccessMode.FULL,
                customAccess = customAccess
            )
        }
    }

    fun accessUpdate(catalog: AidenBotCapabilityCatalog): AidenBotAccessUpdate {
        val modelSelection = AidenBotModelSelection(
            providerId = customAccess.providerID,
            modelId = customAccess.modelID
        )
        if (!catalog.containsAvailable(modelSelection.providerId, modelSelection.modelId)) {
            throw AidenBotContractException.InvalidCombination("unavailable Bot model")
        }
        return if (usesFullAccess) {
            AidenBotAccessUpdate.full(catalog.revision, modelSelection)
        } else {
            val sel = customAccess.selection()
            if (!catalog.containsAvailable(sel)) {
                throw AidenBotContractException.InvalidCombination("unavailable custom access")
            }
            AidenBotAccessUpdate.custom(catalog.revision, sel)
        }
    }

    fun createRequest(catalog: AidenBotCapabilityCatalog): AidenBotCreateRequest {
        return AidenBotCreateRequest(
            name = name.trim(),
            purpose = purpose.trim(),
            openingGreeting = openingGreeting.trim().ifEmpty { null },
            instructions = instructions.trim(),
            avatar = AidenBotSemanticAvatar.Recipe(avatar),
            access = accessUpdate(catalog)
        )
    }

    fun identityPatch(comparedTo: AidenBotDetail): AidenBotIdentityPatch? {
        val nextName = name.trim()
        val nextPurpose = purpose.trim()
        val nextGreeting = openingGreeting.trim().ifEmpty { null }
        val nextInstructions = instructions.trim()
        val nextAvatar = AidenBotSemanticAvatar.Recipe(avatar)
        val greetingChanged = nextGreeting != comparedTo.openingGreeting
        if (nextName == comparedTo.name && nextPurpose == comparedTo.purpose && !greetingChanged && nextInstructions == comparedTo.instructions && nextAvatar == comparedTo.avatar.semantic) {
            return null
        }
        return AidenBotIdentityPatch(
            name = if (nextName == comparedTo.name) null else nextName,
            purpose = if (nextPurpose == comparedTo.purpose) null else nextPurpose,
            openingGreeting = if (greetingChanged) nextGreeting else null,
            instructions = if (nextInstructions == comparedTo.instructions) null else nextInstructions,
            avatar = if (nextAvatar == comparedTo.avatar.semantic) null else nextAvatar
        )
    }

    fun changesAccess(comparedTo: AidenBotDetail, catalog: AidenBotCapabilityCatalog): Boolean {
        val next = accessUpdate(catalog)
        return when (next.accessMode) {
            AidenBotAccessMode.FULL -> comparedTo.access.accessMode != AidenBotAccessMode.FULL || (comparedTo.modelSelection?.providerId != next.providerId || comparedTo.modelSelection?.modelId != next.modelId)
            AidenBotAccessMode.CUSTOM -> comparedTo.access.accessMode != AidenBotAccessMode.CUSTOM || comparedTo.access.custom != next.custom
        }
    }

    fun isSaveable(catalog: AidenBotCapabilityCatalog): Boolean {
        return (try { createRequest(catalog) } catch (_: Exception) { null }) != null
    }

    fun isSatisfied(detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog): Boolean {
        return identityPatch(detail) == null && !changesAccess(detail, catalog)
    }
}

fun aidenBotEditorIsDirty(
    draft: AidenBotEditorDraft?,
    cleanCreateDraft: AidenBotEditorDraft?,
    baselineBot: AidenBotDetail?,
    catalog: AidenBotCapabilityCatalog?,
    isCreating: Boolean,
    hasAvatarCandidate: Boolean = false
): Boolean {
    if (hasAvatarCandidate) return true
    if (draft == null) return false
    if (isCreating) return draft != cleanCreateDraft
    if (baselineBot == null || catalog == null) return false
    val identityChanged = draft.identityPatch(baselineBot) != null
    val accessChanged = try { draft.changesAccess(baselineBot, catalog) } catch (_: Exception) { false }
    return identityChanged || accessChanged
}

fun aidenBotEditorCreateFailureIsAmbiguous(error: Throwable): Boolean {
    return aidenBotAvatarMutationFailureIsAmbiguous(error)
}

fun aidenBotEditorCanSubmitSettings(hasAvatarCandidate: Boolean): Boolean {
    return !hasAvatarCandidate
}

fun aidenBotEditorResolvedDraft(
    mode: AidenBotEditorMode,
    catalog: AidenBotCapabilityCatalog,
    bot: AidenBotDetail?
): AidenBotEditorDraft {
    return when (mode) {
        is AidenBotEditorMode.Create -> {
            AidenBotEditorDraft.createDefault(catalog, mode.defaultAccess)
                ?: throw AidenBotContractException.InvalidCombination("no available provider and model")
        }
        is AidenBotEditorMode.Edit -> {
            val b = bot ?: throw AidenBotContractException.InvalidCombination("missing bot detail")
            AidenBotEditorDraft.fromDetail(b, catalog)
                ?: throw AidenBotContractException.InvalidCombination("no available provider and model")
        }
    }
}

fun aidenBotEditorRebasedDraft(
    draft: AidenBotEditorDraft,
    baseline: AidenBotDetail,
    baselineCatalog: AidenBotCapabilityCatalog,
    authoritative: AidenBotDetail,
    authoritativeCatalog: AidenBotCapabilityCatalog
): AidenBotEditorDraft {
    val baselineDraft = AidenBotEditorDraft.fromDetail(baseline, baselineCatalog)
        ?: throw AidenBotContractException.InvalidCombination("no available provider and model")
    val rebased = AidenBotEditorDraft.fromDetail(authoritative, authoritativeCatalog)
        ?: throw AidenBotContractException.InvalidCombination("no available provider and model")

    val identityPatch = draft.identityPatch(baseline)
    if (identityPatch != null) {
        if (identityPatch.name != null) rebased.name = draft.name
        if (identityPatch.purpose != null) rebased.purpose = draft.purpose
        if (identityPatch.openingGreeting != null) rebased.openingGreeting = draft.openingGreeting
        if (identityPatch.instructions != null) rebased.instructions = draft.instructions
        if (identityPatch.avatar != null) rebased.avatar = draft.avatar
    }

    if (draft.usesFullAccess != baselineDraft.usesFullAccess) {
        rebased.usesFullAccess = draft.usesFullAccess
    }
    val modelBindingChanged = draft.customAccess.providerID != baselineDraft.customAccess.providerID ||
            draft.customAccess.modelID != baselineDraft.customAccess.modelID
    if (modelBindingChanged) {
        rebased.customAccess.providerID = draft.customAccess.providerID
        rebased.customAccess.modelID = draft.customAccess.modelID
    }
    if (draft.customAccess.fileScopeIDs != baselineDraft.customAccess.fileScopeIDs) {
        rebased.customAccess.fileScopeIDs = draft.customAccess.fileScopeIDs
    }
    if (draft.customAccess.shellEnabled != baselineDraft.customAccess.shellEnabled) {
        rebased.customAccess.shellEnabled = draft.customAccess.shellEnabled
    }
    if (draft.customAccess.connectionIDs != baselineDraft.customAccess.connectionIDs) {
        rebased.customAccess.connectionIDs = draft.customAccess.connectionIDs
    }
    if (draft.customAccess.skillIDs != baselineDraft.customAccess.skillIDs) {
        rebased.customAccess.skillIDs = draft.customAccess.skillIDs
    }
    if (draft.customAccess.otherCapabilityIDs != baselineDraft.customAccess.otherCapabilityIDs) {
        rebased.customAccess.otherCapabilityIDs = draft.customAccess.otherCapabilityIDs
    }
    return rebased
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotEditorScreen(
    botId: String? = null,
    coordinator: AidenRemoteCoordinator,
    onNavigateBack: () -> Unit,
    onBotSaved: (String) -> Unit
) {
    val palette = AidenTheme.palette
    val scope = rememberCoroutineScope()
    val client by coordinator.client.collectAsState()

    var catalog by remember { mutableStateOf<AidenBotCapabilityCatalog?>(null) }
    var baselineBot by remember { mutableStateOf<AidenBotDetail?>(null) }
    var draft by remember { mutableStateOf<AidenBotEditorDraft?>(null) }
    var cleanCreateDraft by remember { mutableStateOf<AidenBotEditorDraft?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var isSaving by remember { mutableStateOf(false) }
    var isConfirmingDiscard by remember { mutableStateOf(false) }
    var showImagePlaygroundSheet by remember { mutableStateOf(false) }
    var avatarModel by remember { mutableStateOf<AidenBotGeneratedAvatarModel?>(null) }
    var saveError by remember { mutableStateOf<String?>(null) }

    val isCreating = botId == null
    val isDirty = aidenBotEditorIsDirty(
        draft = draft,
        cleanCreateDraft = cleanCreateDraft,
        baselineBot = baselineBot,
        catalog = catalog,
        isCreating = isCreating,
        hasAvatarCandidate = avatarModel?.hasCandidate == true
    )

    LaunchedEffect(botId, client) {
        val cl = client ?: return@LaunchedEffect
        isLoading = true
        try {
            val cat = cl.botCapabilityCatalog(botId)
            catalog = cat
            if (botId != null) {
                val detail = cl.bot(botId)
                baselineBot = detail
                val d = AidenBotEditorDraft.fromDetail(detail, cat)
                draft = d
                avatarModel = AidenBotGeneratedAvatarModel(coordinator = coordinator, botId = botId)
            } else {
                val d = AidenBotEditorDraft.createDefault(cat, AidenBotEditorDefaultAccess.RECOMMENDED)
                draft = d
                cleanCreateDraft = d?.copy()
            }
        } catch (e: Exception) {
            saveError = e.message
        } finally {
            isLoading = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (isCreating) "New Bot" else "Edit Bot", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = {
                        if (isDirty) {
                            isConfirmingDiscard = true
                        } else {
                            onNavigateBack()
                        }
                    }) {
                        Icon(Icons.Default.Close, contentDescription = "Close", tint = palette.foreground)
                    }
                },
                actions = {
                    TextButton(
                        onClick = {
                            val curDraft = draft ?: return@TextButton
                            val curCat = catalog ?: return@TextButton
                            val cl = client ?: return@TextButton
                            if (!curDraft.isSaveable(curCat) || isSaving) return@TextButton

                            scope.launch {
                                isSaving = true
                                saveError = null
                                try {
                                    if (isCreating) {
                                        val req = curDraft.createRequest(curCat)
                                        val botKey = UUID.randomUUID()
                                        val chatKey = UUID.randomUUID()
                                        val created = cl.createBot(req, botKey)
                                        try {
                                            cl.createBotChat(created.id, AidenBotChatCreateRequest(), chatKey)
                                        } catch (_: Exception) {}
                                        onBotSaved(created.id)
                                    } else {
                                        val bot = baselineBot ?: return@launch
                                        val patch = curDraft.identityPatch(bot)
                                        var currentBot = bot
                                        if (patch != null) {
                                            currentBot = cl.updateBotIdentity(bot.id, currentBot.revision, patch)
                                        }
                                        if (curDraft.changesAccess(bot, curCat)) {
                                            val accessUpdate = curDraft.accessUpdate(curCat)
                                            cl.updateBotAccess(bot.id, currentBot.access.revision, accessUpdate)
                                        }
                                        onBotSaved(currentBot.id)
                                    }
                                } catch (e: Exception) {
                                    saveError = e.message ?: "Failed to save Bot"
                                } finally {
                                    isSaving = false
                                }
                            }
                        },
                        enabled = draft?.let { d -> catalog?.let { c -> d.isSaveable(c) } } == true && !isSaving
                    ) {
                        Text(if (isSaving) "Saving…" else "Save", color = if (draft?.let { d -> catalog?.let { c -> d.isSaveable(c) } } == true) palette.accent else palette.secondary, fontWeight = FontWeight.Bold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.canvas, titleContentColor = palette.foreground)
            )
        },
        containerColor = palette.canvas
    ) { padding ->
        val currentDraft = draft
        val currentCat = catalog

        if (isLoading) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = palette.accent)
            }
        } else if (currentDraft != null && currentCat != null) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(20.dp)
            ) {
                // Identity Section
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("Identity", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)

                        TextField(

                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = currentDraft.name,
                            onValueChange = { draft = currentDraft.copy(name = it.take(80)) },
                            label = { Text("Name") },
                            placeholder = { Text("e.g. Python Pro, Code Reviewer") },
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        )

                        TextField(

                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = currentDraft.purpose,
                            onValueChange = { draft = currentDraft.copy(purpose = it.take(280)) },
                            label = { Text("Purpose (Optional)") },
                            placeholder = { Text("Briefly describe what this bot does") },
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        )

                        TextField(

                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = currentDraft.openingGreeting,
                            onValueChange = { draft = currentDraft.copy(openingGreeting = it.take(2000)) },
                            label = { Text("Opening Greeting (Optional)") },
                            placeholder = { Text("First message sent when starting a chat") },
                            minLines = 2,
                            maxLines = 4,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        )

                        TextField(

                            colors = sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors(),
                            value = currentDraft.instructions,
                            onValueChange = { draft = currentDraft.copy(instructions = it.take(32000)) },
                            label = { Text("Instructions") },
                            placeholder = { Text("System instructions and behavior rules...") },
                            minLines = 4,
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }

                // Avatar Studio
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text("Avatar Studio", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary, modifier = Modifier.align(Alignment.Start))

                        AidenBotSemanticAvatarView(
                            avatar = AidenBotSemanticAvatar.Recipe(currentDraft.avatar),
                            name = currentDraft.name.ifEmpty { "Bot" },
                            size = 84.dp
                        )

                        // Shape selector
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("Shape", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                                items(AidenBotAvatarShape.values()) { shape ->
                                    FilterChip(
                                        border = null,
                                        selected = currentDraft.avatar.shape == shape,
                                        onClick = { draft = currentDraft.copy(avatar = currentDraft.avatar.copy(shape = shape)) },
                                        label = { Text(shape.name.lowercase().replaceFirstChar { it.uppercase() }) }
                                    )
                                }
                            }
                        }

                        // Color selector
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("Color", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                                items(AidenBotAvatarColor.values()) { col ->
                                    val grad = AidenBotAvatarColors.getGradient(col)
                                    Box(
                                        modifier = Modifier
                                            .size(34.dp)
                                            .clip(CircleShape)
                                            .background(grad.first())
                                            .clickable { draft = currentDraft.copy(avatar = currentDraft.avatar.copy(color = col)) }
                                            .then(if (currentDraft.avatar.color == col) Modifier.padding(3.dp) else Modifier)
                                    )
                                }
                            }
                        }

                        // Eyes selector
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("Eyes", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                                items(AidenBotAvatarEyes.values()) { eyes ->
                                    FilterChip(
                                        border = null,
                                        selected = currentDraft.avatar.eyes == eyes,
                                        onClick = { draft = currentDraft.copy(avatar = currentDraft.avatar.copy(eyes = eyes)) },
                                        label = { Text(AidenBotAvatarColors.getEyeGlyph(eyes)) }
                                    )
                                }
                            }
                        }

                        // Accessory selector
                        Column(modifier = Modifier.fillMaxWidth()) {
                            Text("Accessory", style = MaterialTheme.typography.labelSmall, color = palette.secondary)
                            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                                items(AidenBotAvatarDetail.entries) { detail ->
                                    FilterChip(
                                        border = null,
                                        selected = currentDraft.avatar.detail == detail,
                                        onClick = { draft = currentDraft.copy(avatar = currentDraft.avatar.copy(detail = detail)) },
                                        label = { Text(detail.name.lowercase().replaceFirstChar { it.uppercase() }) }
                                    )
                                }
                            }
                        }

                        // Generated Photo section if editing bot
                        avatarModel?.let { model ->
                            Divider(modifier = Modifier.padding(vertical = 8.dp), color = palette.canvas)
                            AidenBotGeneratedAvatarLifecycleView(
                                model = model,
                                semanticAvatar = AidenBotSemanticAvatar.Recipe(currentDraft.avatar),
                                botName = currentDraft.name.ifEmpty { "Bot" }
                            )
                        }

                        OutlinedButton(
                            border = null,
                            onClick = { showImagePlaygroundSheet = true },
                            shape = RoundedCornerShape(10.dp),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Icon(Icons.Default.AutoAwesome, contentDescription = null, tint = palette.accent, modifier = Modifier.size(18.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Create with Image Studio")
                        }
                    }
                }

                // Capability Access Section
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = palette.raised),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text("Access Mode", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, color = palette.secondary)

                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            FilterChip(
                                border = null,
                                selected = currentDraft.usesFullAccess,
                                onClick = { draft = currentDraft.copy(usesFullAccess = true) },
                                label = { Text("Full Access") },
                                modifier = Modifier.weight(1f)
                            )
                            FilterChip(
                                border = null,
                                selected = !currentDraft.usesFullAccess,
                                onClick = { draft = currentDraft.copy(usesFullAccess = false) },
                                label = { Text("Custom Access") },
                                modifier = Modifier.weight(1f)
                            )
                        }

                        // AI Provider and Model picker
                        Text("AI Provider & Model", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                        currentCat.providers.forEach { provider ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AidenProviderIcon(providerId = provider.id, providerLabel = provider.label, size = 20.dp)
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(provider.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                            }
                            provider.models.forEach { model ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(8.dp))
                                        .clickable {
                                            draft = currentDraft.copy(
                                                customAccess = currentDraft.customAccess.copy(
                                                    providerID = provider.id,
                                                    modelID = model.id
                                                )
                                            )
                                        }
                                        .padding(horizontal = 10.dp, vertical = 4.dp)
                                ) {
                                    RadioButton(
                                        selected = currentDraft.customAccess.providerID == provider.id && currentDraft.customAccess.modelID == model.id,
                                        onClick = {
                                            draft = currentDraft.copy(
                                                customAccess = currentDraft.customAccess.copy(
                                                    providerID = provider.id,
                                                    modelID = model.id
                                                )
                                            )
                                        },
                                        colors = RadioButtonDefaults.colors(selectedColor = palette.accent)
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                    Text(model.label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                                }
                            }
                        }

                        // Detailed custom switches if in custom mode
                        AnimatedVisibility(visible = !currentDraft.usesFullAccess) {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Divider(color = palette.canvas)

                                // File scopes
                                Text("Mac File Scopes", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                                currentCat.fileScopes.forEach { scopeItem ->
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable {
                                                val nextSet = if (currentDraft.customAccess.fileScopeIDs.contains(scopeItem.id))
                                                    currentDraft.customAccess.fileScopeIDs - scopeItem.id
                                                else
                                                    currentDraft.customAccess.fileScopeIDs + scopeItem.id
                                                draft = currentDraft.copy(customAccess = currentDraft.customAccess.copy(fileScopeIDs = nextSet))
                                            }
                                            .padding(vertical = 4.dp)
                                    ) {
                                        Checkbox(
                                            checked = currentDraft.customAccess.fileScopeIDs.contains(scopeItem.id),
                                            onCheckedChange = { checked ->
                                                val nextSet = if (checked)
                                                    currentDraft.customAccess.fileScopeIDs + scopeItem.id
                                                else
                                                    currentDraft.customAccess.fileScopeIDs - scopeItem.id
                                                draft = currentDraft.copy(customAccess = currentDraft.customAccess.copy(fileScopeIDs = nextSet))
                                            },
                                            colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                                        )
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Text(scopeItem.label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                                    }
                                }

                                // Shell
                                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                    Text("Terminal Execution", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground, modifier = Modifier.weight(1f))
                                    Switch(
                                        checked = currentDraft.customAccess.shellEnabled,
                                        onCheckedChange = { draft = currentDraft.copy(customAccess = currentDraft.customAccess.copy(shellEnabled = it)) },
                                        enabled = currentCat.shellAvailable,
                                        colors = SwitchDefaults.colors(checkedTrackColor = palette.accent)
                                    )
                                }

                                // Connections
                                if (currentCat.connections.isNotEmpty()) {
                                    Text("MCP Connections", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = palette.foreground)
                                    currentCat.connections.forEach { conn ->
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .clickable {
                                                    val nextSet = if (currentDraft.customAccess.connectionIDs.contains(conn.id))
                                                        currentDraft.customAccess.connectionIDs - conn.id
                                                    else
                                                        currentDraft.customAccess.connectionIDs + conn.id
                                                    draft = currentDraft.copy(customAccess = currentDraft.customAccess.copy(connectionIDs = nextSet))
                                                }
                                                .padding(vertical = 4.dp)
                                        ) {
                                            Checkbox(
                                                checked = currentDraft.customAccess.connectionIDs.contains(conn.id),
                                                onCheckedChange = { checked ->
                                                    val nextSet = if (checked)
                                                        currentDraft.customAccess.connectionIDs + conn.id
                                                    else
                                                        currentDraft.customAccess.connectionIDs - conn.id
                                                    draft = currentDraft.copy(customAccess = currentDraft.customAccess.copy(connectionIDs = nextSet))
                                                },
                                                colors = CheckboxDefaults.colors(checkedColor = palette.accent)
                                            )
                                            Spacer(modifier = Modifier.width(8.dp))
                                            Text(conn.label, style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                saveError?.let { err ->
                    Text(err, color = palette.danger, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    if (showImagePlaygroundSheet) {
        ModalBottomSheet(
            onDismissRequest = { showImagePlaygroundSheet = false },
            containerColor = palette.canvas
        ) {
            AidenBotImagePlaygroundSheet(
                botName = draft?.name ?: "Bot",
                botPurpose = draft?.purpose ?: "",
                onDismiss = { showImagePlaygroundSheet = false },
                onImageSelected = { bytes ->
                    showImagePlaygroundSheet = false
                    avatarModel?.let { model ->
                        scope.launch { model.ingestCopiedCandidate(bytes) }
                    }
                }
            )
        }
    }

    if (isConfirmingDiscard) {
        AlertDialog(
            onDismissRequest = { isConfirmingDiscard = false },
            title = { Text("Discard changes?") },
            text = { Text("You have unsaved changes to this Bot. If you leave now, your changes will be discarded.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        isConfirmingDiscard = false
                        onNavigateBack()
                    }
                ) {
                    Text("Discard", color = palette.danger, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { isConfirmingDiscard = false }) {
                    Text("Cancel", color = palette.secondary)
                }
            },
            containerColor = palette.raised
        )
    }
}
