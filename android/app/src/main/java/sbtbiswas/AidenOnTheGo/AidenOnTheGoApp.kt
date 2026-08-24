package sbtbiswas.AidenOnTheGo

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

class AidenOnTheGoApp : Application() {
    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
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
    }
}
