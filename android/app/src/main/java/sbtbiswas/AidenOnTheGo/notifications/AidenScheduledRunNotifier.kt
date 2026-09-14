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
import sbtbiswas.AidenOnTheGo.models.AidenScheduledRunNotification
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import java.time.Instant

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
        val delivered = preferences.getStringSet(deliveredKey, emptySet()).orEmpty().toMutableSet()
        if (cursor == null) {
            // First poll: baseline to the SERVER clock so device-clock skew can
            // neither replay history nor permanently skip runs. All returned
            // ids are marked delivered so nothing storms.
            delivered.addAll(feed.notifications.map { it.id })
            preferences.edit()
                .putLong(cursorKey, feed.serverNow.toEpochMilli())
                .putStringSet(deliveredKey, delivered.toList().takeLast(MAX_DELIVERED_IDS).toSet())
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
            .putStringSet(deliveredKey, delivered.toList().takeLast(MAX_DELIVERED_IDS).toSet())
            .apply()
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
            failed -> "Scheduled run failed (${item.errorCode ?: "error"})."
            !item.summary.isNullOrEmpty() -> displaySafe(item.summary, 200)
            else -> "Scheduled run completed."
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
