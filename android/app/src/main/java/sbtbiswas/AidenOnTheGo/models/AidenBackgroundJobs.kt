package sbtbiswas.AidenOnTheGo.models

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.time.Duration
import java.time.Instant

/**
 * Contract revision 48 (`chat:jobs`): one of a chat's background jobs. It runs on the Mac, so
 * its ports are addresses there, not on the phone.
 */
@Serializable
data class AidenBackgroundJob(
    val id: String,
    val label: String,
    val state: State,
    val startedAt: String,
    val endedAt: String? = null,
    val exitCode: Int? = null,
    /** Why a stopped job stopped: `person`, `agent`, `output-limit` and others the Mac may add. */
    val endReason: String? = null,
    /** A command the agent ran left these processes running; they have no exit code. */
    val fromCommand: Boolean? = null,
    /** TCP ports it listens on, on the Mac, while it runs. */
    val ports: List<Int>
) {
    @Serializable
    enum class State {
        @SerialName("running") RUNNING,
        @SerialName("exited") EXITED,
        @SerialName("failed") FAILED,
        @SerialName("stopped") STOPPED
    }

    val isRunning: Boolean get() = state == State.RUNNING
    val isFromCommand: Boolean get() = fromCommand == true

    /** The Mac's own bounds; a list with a job outside them is not shown. */
    val isValid: Boolean
        get() = ID.matches(id) && label.isNotEmpty() && label.codePointCount(0, label.length) <= MAX_LABEL &&
            isTime(startedAt) && (endedAt == null || isTime(endedAt)) &&
            isRunning == (endedAt == null) &&
            (exitCode == null || state == State.EXITED || state == State.FAILED) &&
            (endReason != null) == (state == State.STOPPED) &&
            fromCommand != false && !(isFromCommand && state == State.FAILED) &&
            ports.size <= MAX_PORTS && ports.all { it in 1..65_535 } && (isRunning || ports.isEmpty())

    companion object {
        const val MAX_LABEL = 200
        const val MAX_PORTS = 5
        val ID = Regex("^job_[0-9a-f]{8}$")
        internal val KEYS = setOf("id", "label", "state", "startedAt", "endedAt", "exitCode", "endReason", "fromCommand", "ports")

        private fun isTime(value: String): Boolean = runCatching { Instant.parse(value) }.isSuccess
    }
}

/** `GET /chats/{chatId}/jobs` and the stop response: running jobs first, newest first. */
@Serializable
data class AidenBackgroundJobs(val jobs: List<AidenBackgroundJob>) {
    companion object {
        const val MAX_JOBS = 40
        private val json = Json { ignoreUnknownKeys = false }

        /** Strict: an unknown field, a repeated id or a job the Mac could not send is refused. */
        fun decode(text: String): AidenBackgroundJobs {
            val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
                ?: throw AidenRemoteClientException.InvalidResponse()
            val items = root["jobs"] as? kotlinx.serialization.json.JsonArray
            if (root.keys != setOf("jobs") || items == null || items.size > MAX_JOBS ||
                items.any { (it as? JsonObject)?.keys?.all(AidenBackgroundJob.KEYS::contains) != true }
            ) {
                throw AidenRemoteClientException.InvalidResponse()
            }
            val list = runCatching { json.decodeFromString<AidenBackgroundJobs>(text) }.getOrNull()
                ?: throw AidenRemoteClientException.InvalidResponse()
            if (list.jobs.any { !it.isValid } || list.jobs.map { it.id }.toSet().size != list.jobs.size) {
                throw AidenRemoteClientException.InvalidResponse()
            }
            return list
        }
    }
}

/** What the background job list says. The words match the Mac and iOS. */
object AidenBackgroundJobCopy {
    /** "45s", "2m", "1h 5m". */
    fun elapsed(from: Instant, to: Instant): String {
        val seconds = maxOf(0L, Math.round(Duration.between(from, to).toMillis() / 1000.0))
        if (seconds < 60) return "${seconds}s"
        val minutes = seconds / 60
        if (minutes < 60) return "${minutes}m"
        return "${minutes / 60}h ${minutes % 60}m"
    }

    fun status(job: AidenBackgroundJob, now: Instant): String = when (job.state) {
        AidenBackgroundJob.State.RUNNING -> "Running for ${elapsed(Instant.parse(job.startedAt), now)}"
        AidenBackgroundJob.State.STOPPED -> if (job.endReason == "output-limit") "Stopped: too much output" else "Stopped"
        AidenBackgroundJob.State.EXITED, AidenBackgroundJob.State.FAILED -> when {
            job.isFromCommand -> "Ended"
            job.exitCode == null -> if (job.state == AidenBackgroundJob.State.FAILED) "Failed" else "Ended"
            job.exitCode == 0 -> "Finished"
            else -> "Failed with code ${job.exitCode}"
        }
    }

    /** The addresses a running job serves. They are on the Mac, so the phone shows them as text. */
    fun addresses(job: AidenBackgroundJob): String? =
        if (!job.isRunning || job.ports.isEmpty()) null
        else job.ports.joinToString(", ") { "localhost:$it" } + " on your Mac"

    /** The chip above the composer: shown only while something runs. */
    fun chip(running: Int): String? = if (running > 0) "$running in background" else null

    fun chipDescription(running: Int): String =
        if (running == 1) "1 background job running" else "$running background jobs running"
}

/** The job routes, so [AidenBackgroundJobsState] can be driven without a Mac. */
interface AidenBackgroundJobTransport {
    suspend fun backgroundJobs(chatId: String): AidenBackgroundJobs
    suspend fun stopBackgroundJob(chatId: String, jobId: String): AidenBackgroundJobs
}

/** A chat's jobs and Stop. A Mac without `chat:jobs`, or a failed read, shows nothing. */
class AidenBackgroundJobsState {
    var jobs: List<AidenBackgroundJob> by mutableStateOf(emptyList())
        private set
    var stoppingJobIds: Set<String> by mutableStateOf(emptySet())
        private set
    var errorMessage: String? by mutableStateOf(null)
        private set
    private var chatId: String? = null

    val runningCount: Int get() = jobs.count { it.isRunning }

    suspend fun refresh(chatId: String, transport: AidenBackgroundJobTransport?) {
        if (this.chatId != chatId) {
            this.chatId = chatId
            jobs = emptyList()
            stoppingJobIds = emptySet()
            errorMessage = null
        }
        if (transport == null) {
            jobs = emptyList()
            return
        }
        val list = try {
            transport.backgroundJobs(chatId)
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            return
        }
        if (this.chatId == chatId) jobs = list.jobs
    }

    /** Stops one job; the Mac answers once it has ended. A job the Mac no longer has re-reads the list. */
    suspend fun stop(jobId: String, transport: AidenBackgroundJobTransport?) {
        val chatId = chatId ?: return
        if (transport == null || jobId in stoppingJobIds) return
        stoppingJobIds = stoppingJobIds + jobId
        errorMessage = null
        try {
            val list = transport.stopBackgroundJob(chatId, jobId)
            if (this.chatId == chatId) jobs = list.jobs
        } catch (error: AidenRemoteClientException.Server) {
            if (error.statusCode == 404) {
                refresh(chatId, transport)
            } else if (this.chatId == chatId) {
                errorMessage = error.message
            }
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            if (this.chatId == chatId) errorMessage = error.message ?: "Couldn't reach your Mac."
        } finally {
            stoppingJobIds = stoppingJobIds - jobId
        }
    }
}
