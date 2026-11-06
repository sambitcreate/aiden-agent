package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingIdentity
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private class AidenRemoteRoutineModelTransport(val coordinator:AidenRemoteCoordinator,val pairing:AidenPairingIdentity,val botId:String,val routineId:String):AidenBotRoutineModelsTransport {
    private suspend fun <T> request(action:suspend(AidenRemoteClient)->T):T {
        val client=coordinator.client.value ?: throw AidenRemoteClientException.Disconnected()
        check(coordinator.holdsPairing(pairing) && coordinator.holdsReadAuthority(client,pairing.instanceId))
        val value=action(client)
        check(coordinator.holdsPairing(pairing) && coordinator.holdsReadAuthority(client,pairing.instanceId))
        return value
    }
    override suspend fun settings()=request { it.botRoutineModelSettings(botId,routineId) }
    override suspend fun catalog()=request { it.botRoutineModelCatalog(botId,routineId) }
    override suspend fun runs()=request { it.botRoutineModelRuns(botId,routineId) }
    override suspend fun save(request:AidenRoutineModelSave)=request { it.saveBotRoutineModel(request) }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AidenBotRoutineModelsScreen(botId:String,coordinator:AidenRemoteCoordinator,onNavigateBack:()->Unit) {
    val client by coordinator.client.collectAsStateWithLifecycle()
    val server by coordinator.serverInfo.collectAsStateWithLifecycle()
    val pairing=coordinator.activePairing
    val palette=AidenTheme.palette
    var selectedId by rememberSaveable(pairing,botId) { mutableStateOf<String?>(null) }
    var directory by remember(pairing,botId) { mutableStateOf<AidenRoutineModelDirectory?>(null) }
    var failed by remember(pairing,botId) { mutableStateOf(false) }
    val scope=rememberCoroutineScope()
    fun readable()=pairing!=null && coordinator.holdsPairing(pairing) && coordinator.serverInfo.value?.supportsBotRoutineModels==true
    fun writable()=readable() && coordinator.installationStore.activeInstallation?.canWriteBots==true
    val selected=selectedId
    if(selected!=null && pairing!=null) {
        val controller=remember(pairing,botId,selected) { coordinator.pairingMemo("routine-models:$botId|$selected") {
            AidenBotRoutineModelsController(botId,selected,AidenRemoteRoutineModelTransport(coordinator,pairing,botId,selected),::readable,::writable,
                coordinator.botRoutineControlJournals.journal(pairing.instanceId,pairing.deviceId,pairing.pairedAt,"$botId|routine|$selected"){coordinator.holdsPairing(pairing)})
        } }
        val ui by controller.state.collectAsStateWithLifecycle()
        LifecycleResumeEffect(controller,client,server?.supportsBotRoutineModels) {
            val job=scope.launch { controller.refreshWhileActive() }; onPauseOrDispose { job.cancel() }
        }
        AidenRoutineModelDetail(directory?.routines?.find { it.id==selected }?.name,ui,controller,readable(),writable(),{selectedId=null})
        return
    }
    LifecycleResumeEffect(pairing,client,server?.supportsBotRoutineModels) {
        val job=scope.launch {
            while(isActive) {
                val cl=coordinator.client.value
                if(readable() && cl!=null) try {
                    val rows=cl.botRoutineModelDirectory(botId)
                    if(readable() && coordinator.holdsReadAuthority(cl,pairing?.instanceId)) { directory=rows;failed=false }
                } catch(e:kotlinx.coroutines.CancellationException) { throw e }
                catch(_:Exception) { if(readable())failed=true }
                delay(15_000)
            }
        }
        onPauseOrDispose { job.cancel() }
    }
    Scaffold(containerColor=palette.canvas,topBar={TopAppBar(title={Text(stringResource(R.string.bot_routine_models_title))},navigationIcon={IconButton(onClick=onNavigateBack){Icon(Icons.AutoMirrored.Filled.ArrowBack,stringResource(R.string.action_back))}},colors=TopAppBarDefaults.topAppBarColors(containerColor=palette.canvas))}) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).aidenReadableWidth().verticalScroll(rememberScrollState()).padding(AidenUi.ScreenGutter),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.bot_routine_models_description),color=palette.secondary)
            when {
                !readable()->Text(stringResource(R.string.bot_routine_models_old_host),color=palette.secondary)
                failed->Text(stringResource(R.string.bot_routine_models_failed),color=palette.secondary)
                directory==null->CircularProgressIndicator()
                directory!!.routines.isEmpty()->Text(stringResource(R.string.bot_routine_models_empty),color=palette.secondary)
            }
            if(readable())directory?.routines?.forEach { row ->
                Surface(onClick={selectedId=row.id},color=palette.raised,shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) { Text(row.name,style=MaterialTheme.typography.titleMedium);Text(routineKind(row.kind),style=MaterialTheme.typography.bodySmall,color=palette.secondary) }
                }
            }
        }
    }
}
@Composable private fun routineKind(kind:AidenRoutineModelKind)=stringResource(when(kind){AidenRoutineModelKind.SCHEDULED->R.string.bot_routine_model_kind_scheduled;AidenRoutineModelKind.EVENT->R.string.bot_routine_model_kind_event;AidenRoutineModelKind.WATCH->R.string.bot_routine_model_kind_watch})
@OptIn(ExperimentalMaterial3Api::class,ExperimentalLayoutApi::class)
@Composable
internal fun AidenRoutineModelDetail(name:String?,ui:AidenBotRoutineModelsUiState,controller:AidenBotRoutineModelsController,readable:Boolean,writable:Boolean,onBack:()->Unit) {
    val palette=AidenTheme.palette;val scope=rememberCoroutineScope()
    var picker by remember(controller) { mutableStateOf<Boolean?>(null) }
    val editable=readable && writable && controller.editable()
    Scaffold(containerColor=palette.canvas,topBar={TopAppBar(title={Text(name ?: stringResource(R.string.bot_routine_models_title))},navigationIcon={IconButton(onClick=onBack){Icon(Icons.AutoMirrored.Filled.ArrowBack,stringResource(R.string.action_back))}},colors=TopAppBarDefaults.topAppBarColors(containerColor=palette.canvas))}) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).aidenReadableWidth().verticalScroll(rememberScrollState()).padding(AidenUi.ScreenGutter),verticalArrangement=Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.bot_routine_models_grant),color=palette.secondary)
            if(!readable)Text(stringResource(R.string.bot_routine_models_old_host),color=palette.secondary)
            else {
                if(!writable)Text(stringResource(R.string.bot_open_work_read_only),color=palette.secondary)
                ui.problem?.let { problem -> Text(stringResource(when(problem){
                    AidenRoutineControlProblem.FAILED->R.string.bot_routine_models_failed
                    AidenRoutineControlProblem.UNCERTAIN->R.string.bot_routine_models_uncertain
                    AidenRoutineControlProblem.STORAGE->R.string.bot_routine_models_storage
                    AidenRoutineControlProblem.EXPIRED->R.string.bot_routine_models_expired
                }),color=palette.secondary) }
                AidenTonalButton(stringResource(R.string.bot_open_work_refresh),enabled=!ui.busy && !ui.loading,onClick={scope.launch{controller.load()}})
                if(ui.loading && ui.settings==null)AidenSkeletonBlock(height=100.dp,shape=MaterialTheme.shapes.large)
                ui.pending?.let {
                    AidenTonalButton(stringResource(R.string.bot_watch_retry),enabled=writable && !ui.busy && controller.retryAllowed(),onClick={scope.launch{controller.retry()}})
                    if(!controller.retryAllowed())Text(stringResource(R.string.bot_routine_models_expired),color=palette.secondary)
                }
                if(ui.needsReview) {
                    Text(stringResource(R.string.bot_routine_models_conflict),color=palette.secondary)
                    ui.settings?.let { AidenRoutineModelSelectionSummary(stringResource(R.string.bot_routine_models_saved),it.selection,ui.catalog) }
                    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        AidenTonalButton(stringResource(R.string.bot_routine_models_keep_draft),enabled=editable,onClick=controller::reviewKeepingDraft)
                        AidenTonalButton(stringResource(R.string.bot_routine_models_use_saved),enabled=editable,onClick=controller::useSaved)
                    }
                }
                ui.settings?.let { AidenRoutineModelSelectionSummary(stringResource(R.string.bot_routine_models_saved),it.selection,ui.catalog) }
                ui.draft?.let { draft ->
                    AidenRoutineModelSelectionSummary(stringResource(R.string.bot_routine_models_draft),draft,ui.catalog)
                    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        AidenTonalButton(stringResource(R.string.bot_routine_models_inherit),enabled=editable,onClick=controller::inherit)
                        AidenTonalButton(stringResource(R.string.bot_routine_models_primary),enabled=editable && ui.catalog!=null,onClick={picker=false})
                    }
                    if(draft.primary!=null)FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        AidenTonalButton(stringResource(R.string.bot_routine_models_fallback),enabled=editable && ui.catalog!=null,onClick={picker=true})
                        if(draft.fallback!=null)AidenTonalButton(stringResource(R.string.bot_routine_models_remove_fallback),enabled=editable,onClick=controller::clearFallback)
                    }
                    AidenTonalButton(stringResource(R.string.action_save),enabled=readable && writable && controller.saveAllowed(),onClick={scope.launch{controller.save()}})
                }
                Text(stringResource(R.string.bot_routine_models_runs),style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
                if(ui.runs.isEmpty())Text(stringResource(R.string.bot_routine_models_no_runs),color=palette.secondary)
                ui.runs.forEach { run -> AidenRoutineModelRunRow(run) }
            }
        }
    }
    if(readable) picker?.let { fallback ->
        ModalBottomSheet(onDismissRequest={picker=null},containerColor=palette.canvas) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(AidenUi.ScreenGutter),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text(stringResource(if(fallback)R.string.bot_routine_models_fallback else R.string.bot_routine_models_primary),style=MaterialTheme.typography.titleLarge)
                ui.catalog?.providers?.forEach { provider ->
                    Text(provider.label,style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
                    provider.models.forEach { model ->
                        Text(model.label,style=MaterialTheme.typography.bodyLarge)
                        if(!provider.available || !model.available || model.thinkingLevels.isEmpty())Text(stringResource(R.string.bot_routine_models_unavailable),color=palette.secondary)
                        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) { model.thinkingLevels.forEach { level ->
                            AidenTonalButton(level.name.lowercase(),enabled=editable && provider.available && model.available,onClick={controller.select(AidenRoutineModelChoice(provider.id,model.id,level),fallback);picker=null})
                        } }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}
@Composable private fun AidenRoutineModelSelectionSummary(title:String,selection:AidenRoutineModelSelection,catalog:AidenRoutineModelCatalog?) {
    Surface(color=AidenTheme.palette.raised,shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text(title,style=MaterialTheme.typography.titleMedium,modifier=Modifier.semantics{heading()})
            if(selection.mode==AidenRoutineModelMode.INHERIT)Text(stringResource(R.string.bot_routine_models_inherit))
            listOfNotNull(selection.primary?.let { stringResource(R.string.bot_routine_models_primary_label) to it },selection.fallback?.let { stringResource(R.string.bot_routine_models_fallback_label) to it }).forEach { (role,choice)->
                Text("$role: ${catalog?.label(choice) ?: stringResource(R.string.bot_routine_models_saved_choice)} · ${choice.thinkingLevel.name.lowercase()}")
                if(catalog!=null && !catalog.admits(choice))Text(stringResource(R.string.bot_routine_models_unavailable),style=MaterialTheme.typography.bodySmall,color=AidenTheme.palette.secondary)
            }
        }
    }
}
@Composable private fun AidenRoutineModelRunRow(run:AidenRoutineModelRun) {
    val model=run.model
    Surface(color=AidenTheme.palette.raised,shape=MaterialTheme.shapes.large,modifier=Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.bot_routine_models_chosen,model.chosenProviderLabel,model.chosenModelLabel,model.chosen.thinkingLevel.name.lowercase()))
            Text(stringResource(R.string.bot_routine_models_actual,model.providerLabel,model.modelLabel,model.actual.thinkingLevel.name.lowercase()))
            model.fallbackReason?.let { Text(stringResource(if(it==AidenRoutineFallbackReason.MODEL_UNAVAILABLE)R.string.bot_routine_models_fallback_model else R.string.bot_routine_models_fallback_credentials),color=AidenTheme.palette.secondary) }
            val zone=run.timezone?.let(ZoneId::of) ?: ZoneId.systemDefault()
            val format=DateTimeFormatter.ofPattern("MMM d, yyyy HH:mm:ss z").withZone(zone)
            Text(stringResource(R.string.bot_routine_models_admitted,format.format(Instant.ofEpochMilli(run.admittedAt))),style=MaterialTheme.typography.bodySmall)
            run.startedAt?.let { Text(stringResource(R.string.bot_routine_models_started,format.format(Instant.ofEpochMilli(it))),style=MaterialTheme.typography.bodySmall) }
            run.scheduledFor?.let { scheduled ->
                Text(stringResource(R.string.bot_routine_models_scheduled,format.format(Instant.ofEpochMilli(scheduled)),run.timezone!!),style=MaterialTheme.typography.bodySmall)
                aidenRoutineRunDelayMinutes(run)?.let { late -> Text(stringResource(R.string.bot_routine_models_late,late),style=MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

/** A queued admission is not an actual start; missing start time cannot claim lateness. */
internal fun aidenRoutineRunDelayMinutes(run:AidenRoutineModelRun):Long? {
    val start=run.startedAt ?: return null
    val scheduled=run.scheduledFor ?: return null
    return ((start-scheduled)/60_000).takeIf{it>=1}
}
