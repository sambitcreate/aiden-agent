package sbtbiswas.AidenOnTheGo.features.workspaces

import android.annotation.SuppressLint
import android.content.Context
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenDevBrowser
import sbtbiswas.AidenOnTheGo.ui.theme.aidenTextFieldColors
import java.io.ByteArrayInputStream
import java.util.UUID

/** Workspace-owned live pages survive adaptive scene and tool remounts. No page state is persisted. */
class AidenBrowserInput {
    val address = mutableStateOf("")
    val edited = mutableStateOf(false)
    val invalid = mutableStateOf(false)
}

class AidenBrowserPaneState : ViewModel() {
    val input = AidenBrowserInput()
    val tabs = mutableStateListOf<AidenWebTab>()
    var selectedId by mutableStateOf<String?>(null)
    val selected: AidenWebTab? get() = tabs.firstOrNull { it.id == selectedId }
    private var instanceId: String? = null

    fun configure(instance: String) { instanceId = instance; owners.add(this) }
    fun add(context: Context): AidenWebTab? {
        if (tabs.size >= 8) return null
        val tab = AidenWebTab(context.applicationContext)
        tabs.add(tab)
        selectedId = tab.id
        return tab
    }
    /** Called only from a user link action; tool output alone never loads a page. */
    fun openUserPreview(context: Context, url: String): Boolean {
        val validated = AidenDevBrowser.url(url) ?: return false
        tabs.firstOrNull { it.address == validated }?.let { selectedId = it.id; return true }
        val tab = add(context) ?: return false
        return tab.load(validated)
    }
    fun close(tab: AidenWebTab) {
        tab.destroy()
        tabs.remove(tab)
        if (selectedId == tab.id) selectedId = tabs.lastOrNull()?.id
    }
    fun clear() { tabs.toList().forEach(::close); input.address.value = ""; input.edited.value = false; input.invalid.value = false }
    override fun onCleared() { clear(); owners.remove(this) }
    companion object {
        private val owners = mutableSetOf<AidenBrowserPaneState>()
        fun purge(instance: String) { owners.filter { it.instanceId == instance }.forEach { it.clear() } }
        fun activate(instance: String?) { owners.filter { it.instanceId != instance }.forEach { it.clear() } }
    }
}

class AidenWebTab(context: Context) {
    val input = AidenBrowserInput()
    val id = UUID.randomUUID().toString()
    var title by mutableStateOf("New tab")
    var address by mutableStateOf("")
    var canBack by mutableStateOf(false)
    var canForward by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    val webView = createWebView(context)

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(context: Context): WebView = WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = AidenDevBrowser.url(request.url.toString()) == null
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // Subresources cannot escape into local file/content providers either.
                return if (request.url.scheme in setOf("http", "https", "data", "blob")) null else
                    WebResourceResponse("text/plain", "UTF-8", 403, "Unsupported scheme", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) { loading = true; error = null; update(view) }
            override fun onPageFinished(view: WebView, url: String?) { loading = false; update(view) }
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) { update(view) }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) { loading = false; this@AidenWebTab.error = "Cannot reach this site. Check the address, Tailscale connection, and that the dev server listens on 0.0.0.0." }
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, value: String?) { this@AidenWebTab.title = value?.take(100).orEmpty().ifBlank { "Web page" } }
        }
    }
    private fun update(view: WebView) { address = view.url.orEmpty(); canBack = view.canGoBack(); canForward = view.canGoForward() }
    fun load(value: String): Boolean {
        val validated = AidenDevBrowser.url(value) ?: return false
        error = null
        address = validated
        webView.loadUrl(validated)
        return true
    }
    fun destroy() { (webView.parent as? ViewGroup)?.removeView(webView); webView.stopLoading(); webView.destroy() }
}

@Composable
fun AidenBrowserPane(workspaceId: String, chatId: String, coordinator: AidenRemoteCoordinator) {
    val context = LocalContext.current
    val instance = coordinator.activeInstanceId.orEmpty()
    val state: AidenBrowserPaneState = viewModel(
        viewModelStoreOwner = LocalActivity.current as ViewModelStoreOwner,
        key = "native-browser:$instance:${coordinator.installationStore.activeInstallation?.deviceId}:$workspaceId:$chatId"
    )
    SideEffect { state.configure(instance) }
    val server by coordinator.serverInfo.collectAsState()
    val hint = AidenDevBrowser.validatedHost(server?.developmentHost)
    val macHost = hint ?: AidenDevBrowser.host(coordinator.installationStore.activeInstallation?.endpoint)
    val defaultAddress = hint?.let { "http://$it:3000" } ?: AidenDevBrowser.defaultUrl(coordinator.installationStore.activeInstallation?.endpoint).orEmpty()
    val tab = state.selected
    val input = tab?.input ?: state.input
    var address by input.address
    var edited by input.edited
    var invalid by input.invalid
    LaunchedEffect(defaultAddress, input) { if (!edited && tab?.address.isNullOrBlank()) address = defaultAddress }
    LaunchedEffect(tab?.address) { if (!edited && !tab?.address.isNullOrBlank()) address = tab!!.address }
    val destination = AidenDevBrowser.resolveForMac(address, macHost)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(tab, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) tab?.webView?.onPause()
            if (event == Lifecycle.Event.ON_START) tab?.webView?.onResume()
        }
        lifecycle.addObserver(observer)
        tab?.webView?.onResume()
        onDispose { lifecycle.removeObserver(observer); tab?.webView?.onPause() }
    }
    BackHandler(enabled = tab?.canBack == true) { tab?.webView?.goBack() }
    Column(Modifier.fillMaxSize().padding(8.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            state.tabs.forEach { item ->
                TextButton(onClick = { state.selectedId = item.id }) { Text(if (item == tab) "• ${item.title}" else item.title) }
            }
            TextButton(enabled = state.tabs.size < 8, onClick = { state.add(context) }) { Text("New tab") }
            if (tab != null) TextButton(onClick = { state.close(tab) }) { Text("Close tab") }
        }
        if (state.tabs.size >= 8) Text("Close a tab to open another (8 tab limit).")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextField(value = address, onValueChange = { address = it; edited = true; invalid = false },
                label = { Text("Site URL") }, singleLine = true, colors = aidenTextFieldColors(), modifier = Modifier.weight(1f))
            TextButton(onClick = {
                if (destination == null) invalid = true
                else { (tab ?: state.add(context))?.load(destination); address = destination; edited = false }
            }) { Text("Go") }
        }
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            TextButton(enabled = tab?.canBack == true, onClick = { tab?.webView?.goBack() }) { Text("Back") }
            TextButton(enabled = tab?.canForward == true, onClick = { tab?.webView?.goForward() }) { Text("Forward") }
            TextButton(enabled = !tab?.address.isNullOrBlank(), onClick = { tab?.webView?.reload() }) { Text("Reload") }
            if (tab?.loading == true) TextButton(onClick = { tab.webView.stopLoading(); tab.loading = false }) { Text("Stop") }
        }
        if (destination != null && destination != address.trim()) Text("Opens on your Mac: $destination")
        if (invalid) Text("Enter a full HTTP or HTTPS URL without embedded credentials. For localhost links, enter your Mac’s Tailscale address if its host hint is unavailable.")
        tab?.error?.let { Text(it) }
        if (tab == null || tab.address.isBlank()) Text("Open a dev site directly on this device, for example http://100.64.0.1:3000. Run the Mac dev server on 0.0.0.0 and connect both devices to Tailscale.")
        if (tab != null) key(tab.id) { AndroidView(
            factory = { (tab.webView.parent as? ViewGroup)?.removeView(tab.webView); tab.webView },
            modifier = Modifier.weight(1f).fillMaxWidth(),
            onRelease = { (it.parent as? ViewGroup)?.removeView(it) }
        ) }
    }
}
