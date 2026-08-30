package sbtbiswas.AidenOnTheGo

import android.app.Application
import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticArea
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticCode
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticEvent
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnosticOutcome
import sbtbiswas.AidenOnTheGo.diagnostics.AidenDiagnostics

class AidenOnTheGoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AidenDiagnostics.record(AidenDiagnosticArea.APP, AidenDiagnosticEvent.LAUNCH, AidenDiagnosticOutcome.STARTED)
        recordPriorTermination()
        createNotificationChannels()
    }

    private fun recordPriorTermination() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        try {
            val manager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return
            val latest = manager.getHistoricalProcessExitReasons(packageName, 0, 1).firstOrNull() ?: return
            val code = projectPriorTerminationReason(latest.reason) ?: return
            val preferences = getSharedPreferences("aiden_diagnostics", Context.MODE_PRIVATE)
            if (preferences.getLong("last_exit_timestamp", -1L) == latest.timestamp) return
            preferences.edit().putLong("last_exit_timestamp", latest.timestamp).apply()
            AidenDiagnostics.record(
                AidenDiagnosticArea.PRIOR_TERMINATION,
                AidenDiagnosticEvent.PRIOR_TERMINATION_OBSERVED,
                AidenDiagnosticOutcome.DEGRADED,
                code
            )
        } catch (_: RuntimeException) {
            // Prior-termination evidence must never interfere with application startup.
        }
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val name = "Aiden Agent Tasks"
            val descriptionText = "Live progress and notifications for running AI agents and bots"
            val importance = NotificationManager.IMPORTANCE_LOW
            val channel = NotificationChannel(AGENT_RUN_CHANNEL_ID, name, importance).apply {
                description = descriptionText
            }
            val notificationManager: NotificationManager =
                getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }

    companion object {
        const val AGENT_RUN_CHANNEL_ID = "aiden_agent_run_channel"

        internal fun projectPriorTerminationReason(reason: Int): AidenDiagnosticCode? = when (reason) {
            android.app.ApplicationExitInfo.REASON_CRASH,
            android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> AidenDiagnosticCode.CRASH
            android.app.ApplicationExitInfo.REASON_ANR -> AidenDiagnosticCode.ANR
            android.app.ApplicationExitInfo.REASON_LOW_MEMORY -> AidenDiagnosticCode.LOW_MEMORY
            else -> null
        }
    }
}
