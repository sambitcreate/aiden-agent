package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class AidenNativeBrowserTest {
    @Test fun nativeWebSocketDeliversHotReloadMessage() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val server = ServerSocket(0)
        val done = CountDownLatch(1)
        val worker = Thread {
            try {
                while (!server.isClosed) {
                    val socket = server.accept()
                    Thread {
                        socket.use {
                            val reader = it.getInputStream().bufferedReader()
                            val first = reader.readLine().orEmpty()
                            val headers = mutableMapOf<String, String>()
                            while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break; headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim() }
                            if (first.contains(" /hmr ")) {
                                val digest = java.security.MessageDigest.getInstance("SHA-1").digest((headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray())
                                val accept = android.util.Base64.encodeToString(digest, android.util.Base64.NO_WRAP)
                                it.getOutputStream().write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                                it.getOutputStream().write(byteArrayOf(0x81.toByte(), 3, 'h'.code.toByte(), 'o'.code.toByte(), 't'.code.toByte()))
                                it.getOutputStream().flush()
                            } else {
                                val body = "<html><head><title>Waiting</title></head><body><script>window.socket = new WebSocket('ws://127.0.0.1:${server.localPort}/hmr'); socket.onmessage = e => document.title = e.data;</script></body></html>"
                                it.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body".toByteArray())
                                it.getOutputStream().flush()
                            }
                        }
                    }.apply { isDaemon = true; start() }
                }
            } catch (_: java.net.SocketException) { }
        }.apply { isDaemon = true; start() }
        lateinit var tab: AidenWebTab
        try {
            instrumentation.runOnMainSync { tab = AidenWebTab(instrumentation.targetContext); tab.load("http://127.0.0.1:${server.localPort}") }
            repeat(200) {
                instrumentation.runOnMainSync { if (tab.title == "hot") done.countDown() }
                if (done.count != 0L) Thread.sleep(50)
            }
            assertEquals("WebView must receive native ws:// hot reload messages", 0L, done.count)
        } finally { server.close(); worker.join(1000); instrumentation.runOnMainSync { tab.destroy() } }
    }

    @Test fun httpLoadsWithoutApiCredentialsAndLiveTabSurvivesDetach() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val server = ServerSocket(0)
        val request = AtomicReference<String>()
        val received = CountDownLatch(1)
        val thread = Thread {
            server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                val lines = mutableListOf<String>()
                while (true) { val line = reader.readLine() ?: break; if (line.isBlank()) break; lines.add(line) }
                request.set(lines.joinToString("\n"))
                val body = "<html><head><title>Native dev site</title></head><body>Actual HTML<input id='draft'></body></html>"
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body".toByteArray())
                socket.getOutputStream().flush()
                received.countDown()
            }
        }.apply { isDaemon = true; start() }
        lateinit var state: AidenBrowserPaneState
        lateinit var tab: AidenWebTab
        try {
            instrumentation.runOnMainSync {
                state = AidenBrowserPaneState(); state.configure("native-test")
                tab = state.add(instrumentation.targetContext)!!
                assertFalse(tab.webView.settings.allowFileAccess)
                assertFalse(tab.webView.settings.allowContentAccess)
                assertEquals("", tab.address)
                assertTrue(state.openUserPreview(instrumentation.targetContext, "http://127.0.0.1:${server.localPort}"))
                tab = state.selected!!
                assertTrue(state.openUserPreview(instrumentation.targetContext, "http://127.0.0.1:${server.localPort}"))
                assertEquals(2, state.tabs.size)
                assertFalse(tab.load("javascript:alert(1)"))
            }
            assertTrue(received.await(10, TimeUnit.SECONDS))
            assertFalse(request.get().contains("Authorization", ignoreCase = true))
            assertFalse(request.get().contains("Bearer", ignoreCase = true))
            val loaded = CountDownLatch(1)
            repeat(100) {
                instrumentation.runOnMainSync { if (tab.title == "Native dev site") loaded.countDown() }
                if (loaded.count == 0L) return@repeat
                Thread.sleep(50)
            }
            assertEquals(0L, loaded.count)
            val wrote = CountDownLatch(1)
            instrumentation.runOnMainSync { tab.webView.evaluateJavascript("document.getElementById('draft').value = 'unsent'", { wrote.countDown() }) }
            assertTrue(wrote.await(5, TimeUnit.SECONDS))
            val read = CountDownLatch(1)
            val draft = AtomicReference<String>()
            instrumentation.runOnMainSync {
                val original = tab.webView
                val container = android.widget.FrameLayout(instrumentation.targetContext)
                container.addView(original); container.removeView(original); container.addView(original)
                assertSame(original, state.selected!!.webView)
                container.removeView(original)
                state.add(instrumentation.targetContext)
                state.selectedId = tab.id
                assertSame(original, state.selected!!.webView)
                original.evaluateJavascript("document.getElementById('draft').value") { value -> draft.set(value); read.countDown() }
            }
            assertTrue(read.await(5, TimeUnit.SECONDS))
            assertEquals("\"unsent\"", draft.get())
            instrumentation.runOnMainSync {
                repeat(8) { state.add(instrumentation.targetContext) }
                assertEquals(8, state.tabs.size)
                assertNull(state.add(instrumentation.targetContext))
                AidenBrowserPaneState.purge("native-test")
                assertTrue(state.tabs.isEmpty())
            }
        } finally {
            server.close(); thread.join(1000)
            instrumentation.runOnMainSync { state.clear() }
        }
    }
}
