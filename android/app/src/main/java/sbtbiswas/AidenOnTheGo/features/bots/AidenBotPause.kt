package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import sbtbiswas.AidenOnTheGo.models.AidenBotDetail
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionState
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionStateView
import sbtbiswas.AidenOnTheGo.models.AidenServer
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import java.util.UUID

/** Contract revision 37 (`bot:handoffs`): the routes Pause Bot and Resume Bot use. */
interface AidenBotPauseTransport {
    /** `POST /bots/{id}/pause` with `{}`. */
    suspend fun pause(botId: String, key: UUID): AidenBotSessionStateView
    /** A body-less `DELETE /bots/{id}/pause`. */
    suspend fun unpause(botId: String, key: UUID): AidenBotSessionStateView
}

class AidenRemoteBotPauseTransport(private val client: AidenRemoteClient) : AidenBotPauseTransport {
    override suspend fun pause(botId: String, key: UUID) = client.pauseBot(botId, key)
    override suspend fun unpause(botId: String, key: UUID) = client.unpauseBot(botId, key)
}

/**
 * The profile's ••• menu offers Pause Bot or Resume Bot only when the Mac sends this phone
 * hand-offs and the paused state (it offers `bot:handoffs` and this phone holds it), this phone
 * may change Bots, and the Bot has a durable session to pause.
 */
fun aidenBotOffersPause(server: AidenServer?, canWriteBots: Boolean, bot: AidenBotDetail?): Boolean =
    server?.supportsBotHandoffs == true && canWriteBots && bot?.sessionState != null

/** The Bot as the Mac's answer to Pause or Resume leaves it: its `paused` flag follows the state. */
fun AidenBotDetail.withSessionState(view: AidenBotSessionStateView): AidenBotDetail =
    copy(sessionState = view.state, paused = view.state == AidenBotSessionState.PAUSED)

/**
 * Pause Bot and Resume Bot from the profile, one at a time. A request that may have reached the
 * Mac (a dropped connection or no answer in time) keeps its Idempotency-Key, so trying again
 * replays the Mac's first answer instead of acting twice; once the Mac answers, the next tap is a
 * new request.
 */
class AidenBotPauseControl(
    private val keys: AidenBotActionKeys = AidenBotActionKeys(),
    private val requestLimitMillis: Long = AidenBotSessionController.REQUEST_LIMIT_MILLIS
) {
    var isBusy: Boolean = false
        private set

    /**
     * Pauses [bot] when [pause] is true, otherwise lifts its pause. Returns the Bot as the Mac's
     * answer leaves it, or null when another Pause or Resume is already on its way. A failure is
     * rethrown for the screen to report.
     */
    suspend fun set(transport: AidenBotPauseTransport, bot: AidenBotDetail, pause: Boolean): AidenBotDetail? {
        if (isBusy) return null
        isBusy = true
        val action = if (pause) "$PAUSE:${bot.id}" else "$UNPAUSE:${bot.id}"
        return try {
            val view = withTimeoutOrNull(requestLimitMillis) {
                if (pause) transport.pause(bot.id, keys.key(action)) else transport.unpause(bot.id, keys.key(action))
            } ?: throw AidenBotSessionTimeout()
            keys.complete(action)
            bot.withSessionState(view)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            keys.failed(action, error)
            throw error
        } finally {
            isBusy = false
        }
    }

    private companion object {
        const val PAUSE = "pause"
        const val UNPAUSE = "unpause"
    }
}
