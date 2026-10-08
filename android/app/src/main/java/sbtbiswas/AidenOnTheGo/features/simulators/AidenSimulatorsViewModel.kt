package sbtbiswas.AidenOnTheGo.features.simulators

import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorDevice
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorListing
import sbtbiswas.AidenOnTheGo.models.AidenSimulatorToolVersions
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorButton
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorInput
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorStreamFailure
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorStreamPhase
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorStreamSession
import sbtbiswas.AidenOnTheGo.networking.AidenSimulatorTouchPhase
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException

/** What the Mac's simulator routes need from the app; tests can supply a fake. */
interface AidenSimulatorRemote {
    /** The Mac offers `mobile-simulators-v1` and this pairing holds `simulators:mobile`. */
    val hasAccess: Boolean
    suspend fun simulators(chatId: String?): AidenSimulatorListing
    suspend fun open(deviceId: String): AidenSimulatorDevice
    suspend fun shutdown(deviceId: String)
    fun session(deviceId: String, scope: CoroutineScope): AidenSimulatorStreamSession<ImageBitmap>?
}

class AidenCoordinatorSimulatorRemote(private val coordinator: AidenRemoteCoordinator) : AidenSimulatorRemote {
    override val hasAccess: Boolean
        get() = coordinator.serverInfo.value?.supportsMobileSimulators == true &&
            coordinator.installationStore.activeInstallation
                ?.hasNegotiatedAccess(AidenRemoteCapability.SIMULATORS_MOBILE) == true

    private fun client() = coordinator.client.value ?: throw AidenRemoteClientException.MissingCredential

    override suspend fun simulators(chatId: String?) = client().simulators(chatId)
    override suspend fun open(deviceId: String) = client().openSimulator(deviceId)
    override suspend fun shutdown(deviceId: String) = client().shutdownSimulator(deviceId)

    override fun session(deviceId: String, scope: CoroutineScope): AidenSimulatorStreamSession<ImageBitmap>? {
        val client = coordinator.client.value ?: return null
        return AidenSimulatorStreamSession(
            httpClient = client.simulatorStreamingClient,
            mjpegRequest = client.simulatorMjpegRequest(deviceId),
            inputRequest = client.simulatorInputRequest(deviceId),
            scope = scope,
            decodeFrame = { jpeg -> BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)?.asImageBitmap() }
        )
    }
}

enum class AidenSimulatorViewerError {
    /** "Share with Aiden On The Go" is off on the Mac. */
    SHARING_OFF,
    /** The pairing lacks the simulator grant, or the credential was refused. */
    REFUSED,
    /** The Mac already relays as many streams as it allows for this phone. */
    CAPACITY,
    UNREACHABLE
}

data class AidenSimulatorViewerUiState(
    val open: Boolean = false,
    /** The chat's devices, in the order the desktop attached them. */
    val devices: List<AidenSimulatorDevice> = emptyList(),
    val selectedDeviceId: String? = null,
    /** Set while `POST /simulators/open` boots the selected device. */
    val startingDeviceName: String? = null,
    val shuttingDown: Boolean = false,
    val shutdownFailed: Boolean = false,
    val error: AidenSimulatorViewerError? = null,
    val toolVersions: AidenSimulatorToolVersions? = null,
    val offersHostRetry: Boolean = false
) {
    val selectedDevice: AidenSimulatorDevice? get() = devices.firstOrNull { it.id == selectedDeviceId }
}

/**
 * The chat's shared simulators and the full-screen viewer. The listing is read
 * once per chat open, on foreground and when the viewer closes; it is never
 * polled. Streams run only while the viewer is open and the app is started.
 */
class AidenSimulatorsViewModel(
    private val chatId: String,
    private val remote: AidenSimulatorRemote
) : ViewModel() {
    private val _listing = MutableStateFlow<AidenSimulatorListing?>(null)
    val listing: StateFlow<AidenSimulatorListing?> = _listing.asStateFlow()

    private val _chatDevices = MutableStateFlow<List<AidenSimulatorDevice>>(emptyList())
    /** Drives the device button above the composer. */
    val chatDevices: StateFlow<List<AidenSimulatorDevice>> = _chatDevices.asStateFlow()

    private val _viewer = MutableStateFlow(AidenSimulatorViewerUiState())
    val viewer: StateFlow<AidenSimulatorViewerUiState> = _viewer.asStateFlow()

    private val _controls = MutableStateFlow(AidenSimulatorControls())
    val controls: StateFlow<AidenSimulatorControls> = _controls.asStateFlow()

    private val _session = MutableStateFlow<AidenSimulatorStreamSession<ImageBitmap>?>(null)
    val session: StateFlow<AidenSimulatorStreamSession<ImageBitmap>?> = _session.asStateFlow()

    private var refreshJob: Job? = null
    private var sessionWatch: Job? = null
    private var openJob: Job? = null
    private var openingDeviceId: String? = null
    private var foreground = true

    fun refreshChatDevices() {
        if (!remote.hasAccess) {
            applyListing(null)
            return
        }
        if (refreshJob?.isActive == true) return
        refreshJob = viewModelScope.launch {
            try {
                applyListing(remote.simulators(chatId))
            } catch (error: CancellationException) {
                throw error
            } catch (error: AidenRemoteClientException.Server) {
                // A refused grant, hidden chat, or sharing turned off hides the button.
                if (error.statusCode in 400..499) applyListing(null)
            } catch (_: Exception) {
                // Offline: keep the last answer rather than flicker the button.
            }
        }
    }

    fun openViewer() {
        val devices = _chatDevices.value
        if (devices.isEmpty()) return
        val listing = _listing.value
        val selected = devices.firstOrNull { it.isViewableOnPhone } ?: devices.first()
        _viewer.value = AidenSimulatorViewerUiState(
            open = true,
            devices = devices,
            selectedDeviceId = selected.id,
            toolVersions = listing?.toolVersions,
            offersHostRetry = listing?.status?.offersRetry == true
        )
        _controls.value = AidenSimulatorControls()
        connectSelected()
    }

    fun closeViewer() {
        stopSession()
        openJob?.cancel()
        openJob = null
        openingDeviceId = null
        _viewer.value = AidenSimulatorViewerUiState()
        _controls.value = AidenSimulatorControls()
        refreshChatDevices()
    }

    fun selectDevice(deviceId: String) {
        val state = _viewer.value
        if (!state.open || state.selectedDeviceId == deviceId) return
        if (state.devices.none { it.id == deviceId && it.isViewableOnPhone }) return
        _viewer.update { it.copy(selectedDeviceId = deviceId, error = null, startingDeviceName = null) }
        connectSelected()
    }

    fun reloadStream() {
        if (!_viewer.value.open) return
        _viewer.update { it.copy(error = null) }
        connectSelected()
    }

    /** Refetches the listing; the unscoped read may start an installed hub on the Mac. */
    fun retryHost() {
        if (!_viewer.value.open) return
        _viewer.update { it.copy(error = null) }
        viewModelScope.launch {
            try {
                remote.simulators(null)
                applyListing(remote.simulators(chatId))
                if (_viewer.value.open && _viewer.value.error == null) connectSelected()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _viewer.update { it.copy(error = errorFor(error)) }
            }
        }
    }

    /** ON_STOP, or the viewer leaving the screen: close the stream and socket; the last frame stays. */
    fun pauseStreaming() {
        foreground = false
        stopSession()
    }

    /** ON_START: reconnect while the viewer is open. */
    fun resumeStreaming() {
        if (foreground) return
        foreground = true
        val state = _viewer.value
        if (state.open && state.error == null) connectSelected()
    }

    fun shutdownSelected() {
        val device = _viewer.value.selectedDevice ?: return
        if (_viewer.value.shuttingDown) return
        _viewer.update { it.copy(shuttingDown = true, shutdownFailed = false) }
        viewModelScope.launch {
            try {
                remote.shutdown(device.id)
                closeViewer()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                _viewer.update { it.copy(shuttingDown = false, shutdownFailed = true) }
            }
        }
    }

    fun dismissShutdownFailure() = _viewer.update { it.copy(shutdownFailed = false) }

    fun toggleControls() = _controls.update { it.toggled() }
    fun showControls() = _controls.update { it.shown() }
    fun backdropTapped() = _controls.update { it.backdropTapped() }

    /** Returns true when Back should close the viewer. */
    fun back(): Boolean {
        val (next, exits) = _controls.value.back()
        _controls.value = next
        return exits
    }

    fun touch(phase: AidenSimulatorTouchPhase, x: Double, y: Double) {
        val session = _session.value ?: return
        session.send(AidenSimulatorInput.touch(phase, x, y, session.state.value.screen))
    }

    fun press(button: AidenSimulatorButton) {
        _session.value?.send(AidenSimulatorInput.button(button))
    }

    fun rotate() {
        val session = _session.value ?: return
        session.send(AidenSimulatorInput.rotate(session.state.value.screen))
    }

    private fun applyListing(listing: AidenSimulatorListing?) {
        _listing.value = listing
        val devices = listing?.chatDevices.orEmpty()
        _chatDevices.value = devices
        val state = _viewer.value
        if (!state.open || listing == null) return
        if (!listing.sharing) {
            stopSession()
            _viewer.update { it.copy(error = AidenSimulatorViewerError.SHARING_OFF) }
            return
        }
        if (devices.isEmpty()) {
            closeViewer()
            return
        }
        val selected = devices.firstOrNull { it.id == state.selectedDeviceId }
            ?: devices.firstOrNull { it.isViewableOnPhone }
            ?: devices.first()
        _viewer.update {
            it.copy(
                devices = devices,
                selectedDeviceId = selected.id,
                toolVersions = listing.toolVersions,
                offersHostRetry = listing.status.offersRetry
            )
        }
    }

    private fun connectSelected() {
        stopSession()
        val state = _viewer.value
        val device = state.selectedDevice ?: return
        if (!state.open || !foreground || !device.isViewableOnPhone) return
        if (!device.booted) {
            boot(device)
            return
        }
        val session = remote.session(device.id, viewModelScope)
        if (session == null) {
            _viewer.update { it.copy(error = AidenSimulatorViewerError.UNREACHABLE) }
            return
        }
        _session.value = session
        _controls.update { it.withInputConnected(false) }
        sessionWatch = viewModelScope.launch {
            session.state.collect { stream ->
                _controls.update { it.withInputConnected(stream.inputConnected) }
                if (stream.phase == AidenSimulatorStreamPhase.FAILED) {
                    _viewer.update { it.copy(error = errorFor(stream.failure)) }
                }
            }
        }
        session.start()
    }

    private fun boot(device: AidenSimulatorDevice) {
        if (openJob?.isActive == true && openingDeviceId == device.id) return
        openJob?.cancel()
        openingDeviceId = device.id
        _viewer.update { it.copy(startingDeviceName = device.name, error = null) }
        openJob = viewModelScope.launch {
            try {
                val booted = remote.open(device.id)
                _viewer.update { state ->
                    state.copy(
                        devices = state.devices.map { if (it.id == booted.id) booted else it },
                        startingDeviceName = null
                    )
                }
                openingDeviceId = null
                if (_viewer.value.selectedDeviceId == booted.id) connectSelected()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                openingDeviceId = null
                _viewer.update { it.copy(startingDeviceName = null, error = errorFor(error)) }
            }
        }
    }

    private fun stopSession() {
        sessionWatch?.cancel()
        sessionWatch = null
        _session.value?.stop()
        _session.value = null
        _controls.update { it.withInputConnected(false) }
    }

    override fun onCleared() {
        stopSession()
        super.onCleared()
    }

    companion object {
        fun errorFor(failure: AidenSimulatorStreamFailure?): AidenSimulatorViewerError = when (failure) {
            AidenSimulatorStreamFailure.REFUSED -> AidenSimulatorViewerError.REFUSED
            AidenSimulatorStreamFailure.NOT_FOUND -> AidenSimulatorViewerError.SHARING_OFF
            AidenSimulatorStreamFailure.CAPACITY -> AidenSimulatorViewerError.CAPACITY
            AidenSimulatorStreamFailure.NETWORK, null -> AidenSimulatorViewerError.UNREACHABLE
        }

        fun errorFor(error: Exception): AidenSimulatorViewerError = when {
            error is AidenRemoteClientException.Server && (error.statusCode == 401 || error.statusCode == 403) ->
                AidenSimulatorViewerError.REFUSED
            error is AidenRemoteClientException.Server && error.statusCode == 404 -> AidenSimulatorViewerError.SHARING_OFF
            error is AidenRemoteClientException.Server && error.statusCode == 429 -> AidenSimulatorViewerError.CAPACITY
            else -> AidenSimulatorViewerError.UNREACHABLE
        }

        fun factory(chatId: String, coordinator: AidenRemoteCoordinator): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T =
                    AidenSimulatorsViewModel(chatId, AidenCoordinatorSimulatorRemote(coordinator)) as T
            }
    }
}
