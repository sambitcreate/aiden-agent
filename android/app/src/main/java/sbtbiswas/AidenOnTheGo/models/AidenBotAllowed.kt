package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.json.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import java.time.Instant

internal fun aidenBotApprovalCount(obj: JsonObject, key: String): Int? {
    if (!obj.containsKey(key)) return null
    val value = obj[key] as? JsonPrimitive
    val text = value?.takeIf { !it.isString }?.content ?: throw AidenBotContractException.InvalidField(key)
    return text.takeIf { Regex("[0-9]+").matches(it) }?.toIntOrNull()?.takeIf { it in 3..20 }
        ?: throw AidenBotContractException.InvalidField(key)
}
data class AidenBotAllowedEntry(val id: String, val kind: String, val what: String, val addedAt: Instant, val uses: Long?, val lastUsedAt: Instant?)
data class AidenBotAllowedList(val botId: String, val entries: List<AidenBotAllowedEntry>, val nextCursor: String?) {
    companion object {
        fun validId(id: String) = Regex("[A-Za-z0-9_-]{1,80}").matches(id)
        fun validCursor(cursor: String) = Regex("cur_[A-Za-z0-9_-]{43}").matches(cursor)
        fun parse(element: JsonElement): AidenBotAllowedList {
            fun fail(): Nothing = throw AidenBotContractException.InvalidField("allowed")
            fun obj(e: JsonElement) = e as? JsonObject ?: fail()
            fun text(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail()
            fun date(o: JsonObject, k: String) = try { AidenBotPlanWire.timestamp(text(o,k)) } catch (_: Exception) { fail() }
            val o = obj(element)
            if (!o.keys.containsAll(setOf("botId", "entries")) || (o.keys - setOf("botId", "entries", "nextCursor")).isNotEmpty()) fail()
            val botId = text(o,"botId")
            AidenBotWire.validateIdentifier(botId, "botId", 160)
            val rows = o["entries"] as? JsonArray ?: fail()
            if (rows.size > 50) fail()
            val entries = rows.map { e ->
                val r = obj(e)
                if ((r.keys - setOf("id", "kind", "what", "addedAt", "uses", "lastUsedAt")).isNotEmpty()) fail()
                val id = text(r,"id"); val kind = text(r,"kind"); val what = AidenBotPlanWire.text(r,"what",200)
                if (!validId(id) || what.isBlank() || what.codePointCount(0,what.length) > 200 || what.any { it.code < 9 || it.code in 14..31 || it.code in 127..159 }) fail()
                val uses = if (kind == "rule") {
                    val v = r["uses"] as? JsonPrimitive ?: fail()
                    if (v.isString || !Regex("[0-9]+").matches(v.content)) fail()
                    v.content.toLongOrNull()?.takeIf { it <= 9_007_199_254_740_991L } ?: fail()
                } else if (kind == "folder" && !r.containsKey("uses") && !r.containsKey("lastUsedAt")) null else fail()
                val last = if (r.containsKey("lastUsedAt")) { if (uses == 0L) fail(); date(r,"lastUsedAt") } else null
                AidenBotAllowedEntry(id,kind,what,date(r,"addedAt"),uses,last)
            }
            if (entries.map { it.id }.toSet().size != entries.size) fail()
            val cursor = if (o.containsKey("nextCursor")) text(o,"nextCursor").also { if (!validCursor(it)) fail() } else null
            return AidenBotAllowedList(botId, entries, cursor)
        }
    }
}
