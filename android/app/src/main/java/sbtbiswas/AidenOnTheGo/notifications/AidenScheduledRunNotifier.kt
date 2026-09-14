package sbtbiswas.AidenOnTheGo.notifications

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
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

    suspend fun deliver(instanceId: String, client: AidenRemoteClient) {
        if (!NotificationManagerCompat.from(appContext).areNotificationsEnabled()) return
        val cursorKey = "cursor_$instanceId"
        val deliveredKey = "delivered_$instanceId"
        val cursor = preferences.getLong(cursorKey, -1L).takeIf { it >= 0L }
        // Baseline the first poll to now so a fresh install never replays
        // historical runs as a notification storm.
        val baseline = Instant.now()
        val items = try {
            client.scheduledRunNotifications(cursor?.let { Instant.ofEpochMilli(it) } ?: baseline)
        } catch (_: Exception) {
            return
        }
        val delivered = preferences.getStringSet(deliveredKey, emptySet()).orEmpty().toMutableSet()
        for (item in pendingNotifications(items, delivered)) {
            delivered.add(item.id)
            post(item)
        }
        preferences.edit()
            .putLong(cursorKey, cursorAfter(items) ?: cursor ?: baseline.toEpochMilli())
            .putStringSet(deliveredKey, delivered.toList().takeLast(MAX_DELIVERED_IDS).toSet())
            .apply()
    }

    private fun post(item: AidenScheduledRunNotification) {
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
        val title = item.taskName.take(120)
        val body = when {
            failed -> "Scheduled run failed (${item.errorCode ?: "error"})."
            !item.summary.isNullOrEmpty() -> item.summary.take(200)
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
        try {
            notificationManager.notify(item.id.hashCode(), notification)
        } catch (_: SecurityException) {
            AidenDiagnostics.record(AidenDiagnosticArea.NOTIFICATION, AidenDiagnosticEvent.NOTIFICATION_FAILED, AidenDiagnosticOutcome.DEGRADED, AidenDiagnosticCode.UNAVAILABLE)
        }
    }

    companion object {
        private const val PREFS_NAME = "aiden_scheduled_notifications"
        private const val MAX_DELIVERED_IDS = 500

        /** Feed items that still need a local notification (respects `notify` + dedup). */
        fun pendingNotifications(
            items: List<AidenScheduledRunNotification>,
            deliveredIds: Set<String>
        ): List<AidenScheduledRunNotification> = items.filter { it.notify && it.id !in deliveredIds }

        /** The `since` cursor after consuming `items`. */
        fun cursorAfter(items: List<AidenScheduledRunNotification>): Long? =
            items.maxOfOrNull { it.finishedAt.toEpochMilli() }
    }
}
