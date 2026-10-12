package sbtbiswas.AidenOnTheGo.notifications

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CancellationException
import sbtbiswas.AidenOnTheGo.AidenOnTheGoApp
import sbtbiswas.AidenOnTheGo.MainActivity
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticArea
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticCode
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticEvent
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticOutcome
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnostics
import androidx.core.content.edit
import androidx.core.net.toUri
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenBotRoutineNotification
import sbtbiswas.AidenOnTheGo.models.AidenBotRoutineNotificationList
import sbtbiswas.AidenOnTheGo.models.AidenScheduledRunNotification
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import java.time.Instant

/** What the Bot routine feed remembers per paired Mac: the host's last `now`, and the run ids already posted. */
interface AidenBotRoutineNotificationLedger {
    fun cursor(instanceId: String): Instant?
    fun delivered(instanceId: String): List<String>
    fun save(instanceId: String, cursor: Instant, delivered: List<String>)
}

/**
 * The Bot variant of the scheduled-run notifier (contract revision 27, `bot-proactive-v1`).
 * It polls `GET /bots/routine-notifications?since=` with a cursor kept per paired Mac and posts
 * each finished routine run once. The first poll for a Mac only records where the feed stands,
 * so pairing never replays history. A post that fails stops the batch and keeps that run inside
 * the next poll's window; already posted ids are skipped, so overlapping polls never post twice.
 */
class AidenBotRoutineNotificationDelivery(
    private val ledger: AidenBotRoutineNotificationLedger,
    private val post: (instanceId: String, notification: AidenBotRoutineNotification) -> Boolean
) {
    /** Returns how many notifications were posted. */
    suspend fun deliver(
        instanceId: String,
        fetch: suspend (since: Instant?) -> AidenBotRoutineNotificationList
    ): Int = lock.withLock {
        val cursor = ledger.cursor(instanceId)
        val feed = try {
            fetch(cursor)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Keep the cursor so a later poll retries instead of skipping runs.
            return@withLock 0
        }
        val delivered = LinkedHashSet(ledger.delivered(instanceId))
        val oldestFirst = feed.notifications.sortedBy { it.finishedAt }
        if (cursor == null) {
            delivered.addAll(oldestFirst.map { it.id })
            ledger.save(instanceId, feed.now, delivered.toList().takeLast(MAX_DELIVERED_IDS))
            return@withLock 0
        }
        var nextCursor = feed.now
        var posted = 0
        for (item in oldestFirst) {
            if (item.id in delivered) continue
            if (!post(instanceId, item)) {
                nextCursor = maxOf(cursor, item.finishedAt.minusMillis(1))
                break
            }
            delivered.add(item.id)
            posted += 1
        }
        ledger.save(instanceId, nextCursor, delivered.toList().takeLast(MAX_DELIVERED_IDS))
        posted
    }

    companion object {
        const val MAX_DELIVERED_IDS = 500
        const val TAG_PREFIX = "aiden.bot-routine."

        /** One poll at a time across the app: foreground and Bots home can ask together. */
        private val lock = Mutex()

        fun tag(notification: AidenBotRoutineNotification): String = TAG_PREFIX + notification.id
    }
}

/**
 * Turns the `/scheduled-tasks/notifications` feed into local notifications.
 * Polling-only by design — Aiden Remote has no cloud push, so delivery happens
 * while the app is foregrounded (scheduled-list refreshes). The persisted
 * cursor + delivered-id set make duplicate and replayed runs idempotent.
 */
class AidenScheduledRunNotifier(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val notificationManager =
        appContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    /** App-level enablement plus the scheduled-runs channel's own importance. */
    private fun notificationsEnabled(): Boolean {
        if (!NotificationManagerCompat.from(appContext).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = notificationManager.getNotificationChannel(AidenOnTheGoApp.SCHEDULED_RUNS_CHANNEL_ID)
            if (channel != null && channel.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        return true
    }

    suspend fun deliver(instanceId: String, client: AidenRemoteClient) {
        if (!notificationsEnabled()) return
        val cursorKey = "cursor_$instanceId"
        val deliveredKey = "delivered_$instanceId"
        val deliveredOrderKey = "delivered_order_$instanceId"
        val cursor = preferences.getLong(cursorKey, -1L).takeIf { it >= 0L }
        val feed = try {
            client.scheduledRunNotifications(cursor?.let { Instant.ofEpochMilli(it) })
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Fetch/validation failure: keep cursor state so a later poll
            // retries instead of silently skipping runs.
            return
        }
        // Insertion-ordered (a StringSet is unordered) so trimming to the cap
        // evicts the OLDEST ids; the legacy set seeds it once.
        val storedOrder = preferences.getString(deliveredOrderKey, null)
        val delivered = LinkedHashSet<String>(
            storedOrder?.split('\n')?.filter { it.isNotEmpty() }
                ?: preferences.getStringSet(deliveredKey, emptySet()).orEmpty().toList()
        )
        if (cursor == null) {
            // First poll: baseline to the SERVER clock so device-clock skew can
            // neither replay history nor permanently skip runs. All returned
            // ids are marked delivered so nothing storms.
            delivered.addAll(feed.notifications.sortedBy { it.finishedAt }.map { it.id })
            preferences.edit()
                .putLong(cursorKey, feed.serverNow.toEpochMilli())
                .putString(deliveredOrderKey, delivered.toList().takeLast(MAX_DELIVERED_IDS).joinToString("\n"))
                .remove(deliveredKey)
                .apply()
            return
        }
        // Cursor advances only past CONTIGUOUSLY handled items (oldest first):
        // a failed post must keep its finishedAt inside the next poll's window
        // or the run is lost even though it was never posted.
        var nextCursor = cursor
        for (item in feed.notifications.sortedBy { it.finishedAt }) {
            if (!item.notify || item.id in delivered) {
                // History-only or already posted — safe to advance past.
                nextCursor = item.finishedAt.toEpochMilli()
                continue
            }
            if (!post(item)) break // retry this item on the next poll
            delivered.add(item.id)
            nextCursor = item.finishedAt.toEpochMilli()
        }
        preferences.edit()
            .putLong(cursorKey, nextCursor)
            .putString(deliveredOrderKey, delivered.toList().takeLast(MAX_DELIVERED_IDS).joinToString("\n"))
            .remove(deliveredKey)
            .apply()
    }

    private val botDelivery = AidenBotRoutineNotificationDelivery(
        ledger = object : AidenBotRoutineNotificationLedger {
            override fun cursor(instanceId: String): Instant? =
                preferences.getString("bot_cursor_$instanceId", null)?.let { runCatching { Instant.parse(it) }.getOrNull() }

            override fun delivered(instanceId: String): List<String> =
                preferences.getString("bot_delivered_$instanceId", null)?.split('\n')?.filter { it.isNotEmpty() }.orEmpty()

            override fun save(instanceId: String, cursor: Instant, delivered: List<String>) {
                preferences.edit {
                    putString("bot_cursor_$instanceId", cursor.toString())
                    putString("bot_delivered_$instanceId", delivered.joinToString("\n"))
                }
            }
        },
        post = ::postBotRoutine
    )

    /**
     * Posts finished Bot routine runs for the active pairing. Called when the app comes to the
     * foreground and when Bots home refreshes; a Mac without `bot-proactive-v1` is never asked.
     */
    suspend fun deliverBotRoutines(coordinator: AidenRemoteCoordinator) {
        if (coordinator.serverInfo.value?.supportsBotProactive != true) return
        val client = coordinator.client.value ?: return
        val instanceId = coordinator.activeInstanceId ?: return
        if (!notificationsEnabled()) return
        botDelivery.deliver(instanceId) { since ->
            val feed = client.botRoutineNotifications(since)
            // A pairing switched mid-poll must not advance the other Mac's cursor.
            if (!coordinator.holdsReadAuthority(client, instanceId)) throw IllegalStateException("pairing changed")
            feed
        }
    }

    private fun postBotRoutine(instanceId: String, item: AidenBotRoutineNotification): Boolean {
        val link = AidenDeepLink.botChatUrl(item.botId, instanceId)
        val intent = Intent(appContext, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            link?.let { data = it.toUri() }
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val tag = AidenBotRoutineNotificationDelivery.tag(item)
        val pendingIntent = PendingIntent.getActivity(
            appContext,
            tag.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val routineName = displaySafe(item.routineName, 120)
        val preview = displaySafe(item.preview, 200)
        val body = if (preview.isEmpty()) routineName
        else appContext.getString(R.string.notification_bot_routine_body, routineName, preview)
        val notification = NotificationCompat.Builder(appContext, AidenOnTheGoApp.SCHEDULED_RUNS_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(displaySafe(item.botName, 80))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        return try {
            notificationManager.notify(tag, BOT_ROUTINE_NOTIFICATION_ID, notification)
            true
        } catch (_: SecurityException) {
            AidenDiagnostics.record(AidenDiagnosticArea.NOTIFICATION, AidenDiagnosticEvent.NOTIFICATION_FAILED, AidenDiagnosticOutcome.DEGRADED, AidenDiagnosticCode.UNAVAILABLE)
            false
        }
    }

    private fun post(item: AidenScheduledRunNotification): Boolean {
        val intent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            appContext,
            item.id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val failed = item.status == "failed"
        val title = displaySafe(item.taskName, 120)
        val body = when {
            failed -> appContext.getString(
                R.string.notification_scheduled_failed,
                item.errorCode ?: appContext.getString(R.string.notification_scheduled_failed_default_code)
            )
            !item.summary.isNullOrEmpty() -> displaySafe(item.summary, 200)
            else -> appContext.getString(R.string.notification_scheduled_completed)
        }
        val notification = NotificationCompat.Builder(appContext, AidenOnTheGoApp.SCHEDULED_RUNS_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        return try {
            notificationManager.notify(item.id.hashCode(), notification)
            true
        } catch (_: SecurityException) {
            AidenDiagnostics.record(AidenDiagnosticArea.NOTIFICATION, AidenDiagnosticEvent.NOTIFICATION_FAILED, AidenDiagnosticOutcome.DEGRADED, AidenDiagnosticCode.UNAVAILABLE)
            false
        }
    }

    companion object {
        private const val PREFS_NAME = "aiden_scheduled_notifications"
        private const val MAX_DELIVERED_IDS = 500
        /** Bot routine notifications are told apart by their `aiden.bot-routine.<runId>` tag. */
        private const val BOT_ROUTINE_NOTIFICATION_ID = 0x0B07

        /** Lock-screen display text: bounded and free of control/bidi characters. */
        fun displaySafe(value: String, limit: Int): String = buildString {
            var codePoints = 0
            var index = 0
            while (index < value.length && codePoints < limit) {
                val codePoint = value.codePointAt(index)
                // Drop C0/C1 controls and bidi-override/isolate characters.
                if (codePoint > 0x1f && codePoint !in 0x7f..0x9f &&
                    codePoint !in 0x202a..0x202e && codePoint !in 0x2066..0x2069
                ) {
                    appendCodePoint(codePoint)
                    codePoints += 1
                }
                index += Character.charCount(codePoint)
            }
        }
    }
}
