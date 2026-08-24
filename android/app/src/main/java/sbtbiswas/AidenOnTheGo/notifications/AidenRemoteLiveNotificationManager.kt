package sbtbiswas.AidenOnTheGo.notifications

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import sbtbiswas.AidenOnTheGo.AidenOnTheGoApp
import sbtbiswas.AidenOnTheGo.MainActivity
import sbtbiswas.AidenOnTheGo.R

class AidenRemoteLiveNotificationManager(private val context: Context) {
    private val notificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun showAgentProgressNotification(
        instanceId: String,
        sessionId: String,
        sessionTitle: String,
        status: AgentRunActivityStatus,
        currentActivity: String,
        responseExcerpt: String
    ) {
        val deepLinkUri = Uri.parse(AidenDeepLink.chatUrl(instanceId, sessionId))
        val intent = Intent(Intent.ACTION_VIEW, deepLinkUri, context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            sessionId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, AidenOnTheGoApp.AGENT_RUN_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(AgentRunActivitySanitizer.sessionTitle(sessionTitle))
            .setContentText("${status.title}: ${AgentRunActivitySanitizer.activityLine(currentActivity)}")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(
                        if (responseExcerpt.isNotEmpty()) {
                            "${status.title}: $currentActivity\n\n$responseExcerpt"
                        } else {
                            "${status.title}: $currentActivity"
                        }
                    )
            )
            .setContentIntent(pendingIntent)
            .setOngoing(status != AgentRunActivityStatus.COMPLETE && status != AgentRunActivityStatus.FAILED && status != AgentRunActivityStatus.CANCELLED)
            .setAutoCancel(true)
            .build()

        notificationManager.notify(sessionId.hashCode(), notification)
    }

    fun dismissNotification(sessionId: String) {
        notificationManager.cancel(sessionId.hashCode())
    }
}
