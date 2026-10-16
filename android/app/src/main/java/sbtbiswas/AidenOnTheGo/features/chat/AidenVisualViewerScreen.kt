package sbtbiswas.AidenOnTheGo.features.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.models.AidenChatVisual
import sbtbiswas.AidenOnTheGo.models.AidenMessageAttachment
import sbtbiswas.AidenOnTheGo.models.AidenVisualDocumentRequest
import sbtbiswas.AidenOnTheGo.models.AidenVisualDocumentScheme
import sbtbiswas.AidenOnTheGo.persistence.AidenVisualDocumentCache
import sbtbiswas.AidenOnTheGo.persistence.AidenVisualDocumentKey
import sbtbiswas.AidenOnTheGo.persistence.AidenVisualDocumentLoad
import sbtbiswas.AidenOnTheGo.persistence.AidenVisualDocumentLoader
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogConfirmButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenDialogDismissButton
import sbtbiswas.AidenOnTheGo.ui.theme.AidenShape
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTonalButton
import java.io.ByteArrayInputStream
import java.io.File

/** A visual the user tapped, with the snapshot the viewer can fall back to. */
@Immutable
data class AidenVisualViewerRequest(
    val visual: AidenChatVisual,
    val snapshot: AidenMessageAttachment?
)

private sealed interface AidenVisualViewerContent {
    data object Loading : AidenVisualViewerContent
    data class Document(val html: String, val stale: Boolean) : AidenVisualViewerContent
    data class Failed(val unavailable: Boolean) : AidenVisualViewerContent
}

/** The single name the viewer page posts to (`window.AidenVisualBridge.postMessage`). */
private const val AIDEN_VISUAL_BRIDGE_NAME = "AidenVisualBridge"

/** Without a `ready` message the indicator still clears, so a quiet page is never hidden. */
private const val READY_FALLBACK_MILLIS = 10_000L

/**
 * A visual opened full screen (contract revision 34). The Mac's self-contained
 * viewer page runs in a locked-down [WebView]: JavaScript on, no file, content,
 * storage, window or navigation access, and one message channel, which only ever
 * asks native to confirm a follow-up or a link. When the Mac cannot be reached the
 * last cached copy is shown with a note that it may be out of date.
 */
@Composable
internal fun AidenVisualViewerScreen(
    request: AidenVisualViewerRequest,
    chatId: String,
    hostIdentity: String,
    fetch: suspend (visualId: String, scheme: AidenVisualDocumentScheme, theme: String) -> String,
    onShowImage: (() -> Unit)?,
    /** Appends a confirmed follow-up to the composer and closes; null ignores prompts (read-only). */
    onAddToMessage: ((String) -> Unit)?,
    onDismiss: () -> Unit
) {
    val palette = AidenTheme.palette
    val scheme = AidenVisualDocumentScheme.forDarkTheme(palette.isDark)
    val theme = AidenVisualDocumentRequest.themeId(AidenTheme.config.preset)
    val context = LocalContext.current
    val cache = remember(context) { AidenVisualDocumentCacheStore.get(context) }
    val currentFetch by rememberUpdatedState(fetch)
    val visualId = request.visual.id

    var content by remember(visualId) { mutableStateOf<AidenVisualViewerContent>(AidenVisualViewerContent.Loading) }
    var ready by remember(visualId) { mutableStateOf(false) }
    var attempt by remember(visualId) { mutableIntStateOf(0) }
    var rendererGeneration by remember(visualId) { mutableIntStateOf(0) }
    var rendererGone by remember(visualId) { mutableStateOf(false) }
    var pendingPrompt by remember(visualId) { mutableStateOf<String?>(null) }
    var pendingUrl by remember(visualId) { mutableStateOf<String?>(null) }
    val throttle = remember(visualId) { AidenVisualBridgeThrottle { SystemClock.elapsedRealtime() } }

    LaunchedEffect(visualId, scheme, theme, attempt) {
        content = AidenVisualViewerContent.Loading
        ready = false
        rendererGone = false
        val key = AidenVisualDocumentKey(hostIdentity, chatId, visualId, scheme.wire, theme)
        val loader = AidenVisualDocumentLoader(
            cache = cache,
            fetch = { currentFetch(visualId, scheme, theme) },
            isNotFound = { error -> error is AidenRemoteClientException.Server && error.statusCode == 404 }
        )
        content = when (val result = withContext(Dispatchers.IO) { loader.load(key) }) {
            is AidenVisualDocumentLoad.Fresh -> AidenVisualViewerContent.Document(result.html, stale = false)
            is AidenVisualDocumentLoad.Cached -> AidenVisualViewerContent.Document(result.html, stale = true)
            is AidenVisualDocumentLoad.Failed -> AidenVisualViewerContent.Failed(result.unavailable)
        }
    }
    LaunchedEffect(content, rendererGeneration) {
        if (content is AidenVisualViewerContent.Document) {
            delay(READY_FALLBACK_MILLIS)
            ready = true
        }
    }

    val onBridgeMessage: (AidenVisualBridgeMessage) -> Unit = { message ->
        when (message) {
            AidenVisualBridgeMessage.Ready -> {
                ready = true
            }
            is AidenVisualBridgeMessage.Prompt -> {
                // A newer prompt replaces one still waiting for an answer.
                if (onAddToMessage != null && throttle.tryAcquire()) pendingPrompt = message.text
            }
            is AidenVisualBridgeMessage.OpenUrl -> {
                if (throttle.tryAcquire()) pendingUrl = message.url
            }
        }
        Unit
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)
    ) {
        Surface(color = palette.canvas, contentColor = palette.foreground, modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.fillMaxSize().systemBarsPadding()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    IconButton(onClick = onDismiss) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.chat_visual_viewer_close))
                    }
                    Text(
                        text = request.visual.title,
                        style = MaterialTheme.typography.titleMedium,
                        color = palette.foreground,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp)
                            .semantics { heading() }
                    )
                    if (onShowImage != null) {
                        IconButton(onClick = onShowImage) {
                            Icon(Icons.Default.Image, contentDescription = stringResource(R.string.chat_visual_viewer_show_image))
                        }
                    }
                }

                val current = content
                if (current is AidenVisualViewerContent.Document && current.stale) {
                    AidenVisualViewerNotice(
                        text = stringResource(R.string.chat_visual_viewer_stale),
                        onRetry = { attempt++ }
                    )
                }

                Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                    when {
                        current is AidenVisualViewerContent.Failed -> AidenVisualViewerMessage(
                            text = stringResource(
                                if (current.unavailable) R.string.chat_visual_viewer_unavailable
                                else R.string.chat_visual_viewer_failed
                            ),
                            onRetry = { attempt++ }
                        )
                        current is AidenVisualViewerContent.Document && rendererGone -> AidenVisualViewerMessage(
                            text = stringResource(R.string.chat_visual_viewer_stopped),
                            onRetry = {
                                rendererGone = false
                                ready = false
                                rendererGeneration++
                            }
                        )
                        current is AidenVisualViewerContent.Document -> key(current.html, rendererGeneration) {
                            AidenVisualWebView(
                                html = current.html,
                                onMessage = onBridgeMessage,
                                onRendererGone = { rendererGone = true },
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                    }
                    val loading = current is AidenVisualViewerContent.Loading ||
                        (current is AidenVisualViewerContent.Document && !rendererGone && !ready)
                    if (loading) {
                        val loadingLabel = stringResource(R.string.chat_visual_viewer_loading)
                        CircularProgressIndicator(
                            color = palette.secondary,
                            modifier = Modifier
                                .align(Alignment.Center)
                                .size(28.dp)
                                .semantics { contentDescription = loadingLabel }
                        )
                    }
                }
            }
        }

        pendingPrompt?.let { prompt ->
            AlertDialog(
                onDismissRequest = { pendingPrompt = null },
                title = { Text(stringResource(R.string.chat_visual_prompt_title)) },
                text = {
                    Column(
                        modifier = Modifier.heightIn(max = 280.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Text(
                            text = stringResource(R.string.chat_visual_prompt_body),
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.secondary
                        )
                        Text(
                            text = stringResource(R.string.chat_visual_prompt_quote, prompt),
                            style = MaterialTheme.typography.bodyLarge,
                            color = palette.foreground
                        )
                    }
                },
                confirmButton = {
                    AidenDialogConfirmButton(
                        text = stringResource(R.string.chat_visual_prompt_add),
                        onClick = {
                            pendingPrompt = null
                            onAddToMessage?.invoke(prompt)
                        }
                    )
                },
                dismissButton = {
                    AidenDialogDismissButton(
                        text = stringResource(R.string.chat_visual_prompt_dismiss),
                        onClick = { pendingPrompt = null }
                    )
                },
                shape = AidenShape.Dialog,
                containerColor = palette.raised
            )
        }

        pendingUrl?.let { url ->
            AlertDialog(
                onDismissRequest = { pendingUrl = null },
                title = { Text(stringResource(R.string.chat_visual_link_title)) },
                text = {
                    Text(
                        text = url,
                        style = MaterialTheme.typography.bodyMedium,
                        color = palette.secondary,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis
                    )
                },
                confirmButton = {
                    AidenDialogConfirmButton(
                        text = stringResource(R.string.chat_visual_link_open),
                        onClick = {
                            pendingUrl = null
                            openAidenVisualLink(context, url)
                        }
                    )
                },
                dismissButton = { AidenDialogDismissButton(onClick = { pendingUrl = null }) },
                shape = AidenShape.Dialog,
                containerColor = palette.raised
            )
        }
    }
}

@Composable
private fun AidenVisualViewerNotice(text: String, onRetry: () -> Unit) {
    val palette = AidenTheme.palette
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)
    ) {
        Row(
            modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodySmall,
                color = palette.secondary,
                modifier = Modifier
                    .weight(1f)
                    .semantics { liveRegion = LiveRegionMode.Polite }
            )
            AidenTonalButton(text = stringResource(R.string.action_retry), onClick = onRetry)
        }
    }
}

@Composable
private fun AidenVisualViewerMessage(text: String, onRetry: () -> Unit) {
    val palette = AidenTheme.palette
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = palette.secondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
        )
        AidenTonalButton(text = stringResource(R.string.action_retry), onClick = onRetry)
    }
}

@Composable
private fun AidenVisualWebView(
    html: String,
    onMessage: (AidenVisualBridgeMessage) -> Unit,
    onRendererGone: () -> Unit,
    modifier: Modifier = Modifier
) {
    val currentOnMessage by rememberUpdatedState(onMessage)
    val currentOnRendererGone by rememberUpdatedState(onRendererGone)
    val bridge = remember { AidenVisualBridgeInterface { message -> currentOnMessage(message) } }
    DisposableEffect(bridge) {
        onDispose { bridge.close() }
    }
    AndroidView(
        factory = { context ->
            createAidenVisualWebView(context, bridge) { currentOnRendererGone() }.also { webView ->
                // No base URL: the page gets an opaque origin and nothing to resolve against.
                webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }
        },
        modifier = modifier,
        onRelease = { webView ->
            webView.stopLoading()
            webView.removeJavascriptInterface(AIDEN_VISUAL_BRIDGE_NAME)
            webView.webChromeClient = null
            webView.destroy()
        }
    )
}

@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
private fun createAidenVisualWebView(
    context: Context,
    bridge: AidenVisualBridgeInterface,
    onRendererGone: () -> Unit
): WebView = WebView(context).apply {
    settings.apply {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
        mediaPlaybackRequiresUserGesture = true
        domStorageEnabled = false
        setGeolocationEnabled(false)
        cacheMode = WebSettings.LOAD_NO_CACHE
    }
    // The page paints its own themed background; transparency avoids a white flash in dark mode.
    setBackgroundColor(android.graphics.Color.TRANSPARENT)
    webViewClient = AidenVisualWebViewClient(onRendererGone)
    webChromeClient = AidenVisualWebChromeClient()
    addJavascriptInterface(bridge, AIDEN_VISUAL_BRIDGE_NAME)
}

/**
 * The one object the page can reach. JavaScript interface calls arrive on a WebView
 * background thread, so parsed messages hop to the main thread, and nothing is
 * delivered once the viewer has gone.
 */
private class AidenVisualBridgeInterface(
    private val onMessage: (AidenVisualBridgeMessage) -> Unit
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var open = true

    fun close() {
        open = false
        mainHandler.removeCallbacksAndMessages(null)
    }

    @JavascriptInterface
    fun postMessage(json: String?) {
        if (!open || json == null) return
        val message = AidenVisualBridgeMessage.parse(json) ?: return
        mainHandler.post { if (open) onMessage(message) }
    }
}

/** Denies every navigation after the initial document and every subresource fetch. */
private class AidenVisualWebViewClient(
    private val onRendererGone: () -> Unit
) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        val scheme = request?.url?.scheme?.lowercase() ?: return null
        if (scheme !in BLOCKED_SCHEMES) return null
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Forbidden",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0))
        )
    }

    override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        // The view is unusable now; the screen replaces it, which destroys this one.
        onRendererGone()
        return true
    }

    private companion object {
        val BLOCKED_SCHEMES = setOf("http", "https", "file", "content")
    }
}

/** Denies permissions, windows, file pickers and JavaScript dialogs. */
private class AidenVisualWebChromeClient : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest?) {
        request?.deny()
    }

    override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
        callback?.invoke(origin, false, false)
    }

    override fun onCreateWindow(view: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean = false

    override fun onShowFileChooser(
        webView: WebView?,
        filePathCallback: ValueCallback<Array<Uri>>?,
        fileChooserParams: WebChromeClient.FileChooserParams?
    ): Boolean {
        filePathCallback?.onReceiveValue(null)
        return true
    }

    override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        result?.cancel()
        return true
    }

    override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
        result?.cancel()
        return true
    }

    override fun onJsPrompt(
        view: WebView?,
        url: String?,
        message: String?,
        defaultValue: String?,
        result: JsPromptResult?
    ): Boolean {
        result?.cancel()
        return true
    }
}

private fun openAidenVisualLink(context: Context, url: String) {
    // Checked again here: only a confirmed https link without user info leaves the app.
    if (!AidenVisualBridgeMessage.isOpenableUrl(url)) return
    try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        )
    } catch (_: Exception) {
        // No browser; the link stays unopened.
    }
}

/** One cache per process over the app's caches directory. */
private object AidenVisualDocumentCacheStore {
    @Volatile private var cache: AidenVisualDocumentCache? = null

    fun get(context: Context): AidenVisualDocumentCache = cache ?: synchronized(this) {
        cache ?: AidenVisualDocumentCache(File(context.applicationContext.cacheDir, "visual_documents"))
            .also { cache = it }
    }
}
