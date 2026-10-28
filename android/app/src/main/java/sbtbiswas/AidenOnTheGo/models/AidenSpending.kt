package sbtbiswas.AidenOnTheGo.models

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/** Whose spending a request reads: a Workspace chat's total, or a Bot's month (revision 44). */
sealed interface AidenSpendingOwner {
    data class Chat(val chatId: String) : AidenSpendingOwner
    data class Bot(val botId: String) : AidenSpendingOwner
}

/** Revision 44 (`spending-limits-v1`). Amounts are US dollars. */
@Serializable
data class AidenSpending(
    val period: Period,
    val state: State,
    val limitUsd: Double,
    val allowedUsd: Double,
    val spentUsd: Double,
    val allowMoreUsd: Double,
    val periodStart: String? = null,
    val periodEnd: String? = null,
    val revision: String
) {
    @Serializable
    enum class Period {
        @SerialName("chat") CHAT,
        @SerialName("month") MONTH
    }

    @Serializable
    enum class State {
        @SerialName("under") UNDER,
        @SerialName("nearing") NEARING,
        @SerialName("reached") REACHED
    }

    /** The Mac's own bounds; a status outside them is not shown. */
    val isValid: Boolean
        get() = limitUsd > 0 && allowedUsd >= limitUsd && spentUsd >= 0 && allowMoreUsd > 0 &&
            revision.isNotEmpty() && revision.length <= 128 &&
            (period == Period.MONTH) == (periodStart != null && periodEnd != null)
}

/** `spending` is null when no limit applies. */
@Serializable
data class AidenSpendingStatus(val spending: AidenSpending?)

/** What a chat or Bot says about its limit above the composer. The words match the Mac and iOS. */
object AidenSpendingCopy {
    data class Notice(val title: String, val body: String, val allowMore: String)

    /** "$5.00", "$1,250.00"; an amount under half a cent reads "less than $0.01". */
    fun usd(amount: Double): String {
        if (!amount.isFinite() || amount <= 0) return "$0.00"
        if (amount < 0.005) return "less than $0.01"
        return "$" + DecimalFormat("#,##0.00", DecimalFormatSymbols(Locale.US)).format(amount)
    }

    /** Nothing while the chat or Bot is under 80% of its limit. */
    fun notice(spending: AidenSpending, botName: String?): Notice? {
        val isBot = spending.period == AidenSpending.Period.MONTH
        val who = if (isBot) botName?.trim()?.takeIf { it.isNotEmpty() } ?: "This Bot" else "This chat"
        val period = if (isBot) " this month" else ""
        val allowMore = "Allow ${usd(spending.allowMoreUsd)} more"
        return when (spending.state) {
            AidenSpending.State.UNDER -> null
            AidenSpending.State.NEARING -> Notice(
                title = "$who has used ${usd(spending.spentUsd)} of its ${usd(spending.allowedUsd)} limit$period.",
                body = if (isBot) "$who stops when it reaches the limit." else "Replies stop when the chat reaches its limit.",
                allowMore = allowMore
            )
            AidenSpending.State.REACHED -> Notice(
                title = "$who reached its ${usd(spending.allowedUsd)} spending limit$period.",
                body = "It has spent ${usd(spending.spentUsd)}. $allowMore to keep going, or change the limit on your Mac.",
                allowMore = allowMore
            )
        }
    }
}

/** The spending routes, so [AidenSpendingNoticeState] can be driven without a Mac. */
interface AidenSpendingTransport {
    suspend fun spending(owner: AidenSpendingOwner): AidenSpendingStatus
    suspend fun allowMoreSpending(owner: AidenSpendingOwner, revision: String): AidenSpendingStatus
}

/** What the notice shows, and Allow more. A Mac without the feature shows nothing. */
class AidenSpendingNoticeState {
    var spending: AidenSpending? by mutableStateOf(null)
        private set
    var isAllowing: Boolean by mutableStateOf(false)
        private set
    var errorMessage: String? by mutableStateOf(null)
        private set
    private var owner: AidenSpendingOwner? = null

    /** A failed read keeps what was shown: the Mac still refuses a send over the limit. */
    suspend fun refresh(owner: AidenSpendingOwner, transport: AidenSpendingTransport?) {
        if (this.owner != owner) {
            this.owner = owner
            spending = null
            errorMessage = null
        }
        if (transport == null) {
            spending = null
            return
        }
        val status = try {
            transport.spending(owner)
        } catch (_: Exception) {
            return
        }
        if (this.owner == owner) spending = status.spending
    }

    /** Allow more once. A tap another device already answered re-reads instead of adding twice. */
    suspend fun allowMore(transport: AidenSpendingTransport?) {
        val owner = owner ?: return
        val current = spending ?: return
        if (transport == null || isAllowing) return
        isAllowing = true
        errorMessage = null
        try {
            val status = transport.allowMoreSpending(owner, current.revision)
            if (this.owner == owner) spending = status.spending
        } catch (error: AidenRemoteClientException.Server) {
            if (error.statusCode == 409 || error.body.code == AidenRemoteErrorCode.REVISION_CONFLICT) {
                isAllowing = false
                refresh(owner, transport)
            } else {
                errorMessage = error.message
            }
        } catch (error: Exception) {
            errorMessage = error.message ?: "Couldn't reach your Mac."
        } finally {
            isAllowing = false
        }
    }
}
