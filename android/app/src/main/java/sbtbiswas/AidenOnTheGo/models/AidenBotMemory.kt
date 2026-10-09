@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package sbtbiswas.AidenOnTheGo.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.time.Instant

// Contract revision 27 (`bot-memory-v1`): what a Bot remembers, in two stores the person
// can read, edit and erase from the phone. The files live on the Mac.

/** Bounds shared with the host parsers in `aiden-remote-protocol.ts`. */
object AidenBotMemoryWire {
    const val MAX_ENTRY_LENGTH = 500
    const val MAX_ENTRIES = 64
    const val MAX_CHARS = 1_000_000
    private val ENTRY_ID = Regex("^[0-9a-f]{16}$")
    private val REVISION = Regex("^[0-9a-f]{16}$")

    fun validateEntryId(value: String, field: String) {
        if (!ENTRY_ID.matches(value)) throw AidenBotContractException.InvalidField(field)
    }

    fun validateRevision(value: String) {
        if (!REVISION.matches(value)) throw AidenBotContractException.InvalidField("memory.revision")
    }
}

/** `user` is what the Bot knows about the person ("About you"); `memory` is its own notes. */
@Serializable
enum class AidenBotMemoryTarget {
    @SerialName("user") USER,
    @SerialName("memory") MEMORY
}

@Serializable
data class AidenBotMemoryEntry(val id: String, val text: String) {
    init {
        AidenBotMemoryWire.validateEntryId(id, "memory.entry.id")
        AidenBotWire.validateString(text, "memory.entry.text", AidenBotMemoryWire.MAX_ENTRY_LENGTH)
    }
}

@Serializable
data class AidenBotMemoryStore(
    val entries: List<AidenBotMemoryEntry>,
    @Serializable(with = AidenStrictIntSerializer::class) val usedChars: Int,
    @Serializable(with = AidenStrictIntSerializer::class) val limitChars: Int,
    @Serializable(with = AidenStrictBooleanSerializer::class) val overBudget: Boolean
) {
    init {
        if (entries.size > AidenBotMemoryWire.MAX_ENTRIES || entries.map { it.id }.toSet().size != entries.size) {
            throw AidenBotContractException.InvalidField("memory.entries")
        }
        if (usedChars !in 0..AidenBotMemoryWire.MAX_CHARS || limitChars !in 1..AidenBotMemoryWire.MAX_CHARS) {
            throw AidenBotContractException.InvalidField("memory.chars")
        }
    }
}

/**
 * `GET /bots/{botId}/memory`. When [readable] is false the files on the Mac could not be read
 * (damaged or edited by hand); the only way forward is Erase.
 */
@Serializable
data class AidenBotMemory(
    val botId: String,
    val revision: String,
    @Serializable(with = AidenStrictBooleanSerializer::class) val readable: Boolean,
    val memory: AidenBotMemoryStore,
    val user: AidenBotMemoryStore,
    @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant?
) {
    init {
        AidenBotWire.validateIdentifier(botId, "memory.botId", AidenRemoteProtocol.MAX_BOT_IDENTIFIER_LENGTH)
        AidenBotMemoryWire.validateRevision(revision)
    }

    fun store(target: AidenBotMemoryTarget): AidenBotMemoryStore = when (target) {
        AidenBotMemoryTarget.USER -> user
        AidenBotMemoryTarget.MEMORY -> memory
    }

    /** Everything both stores hold. */
    val entryCount: Int get() = user.entries.size + memory.entries.size
}

/** One person edit, discriminated by `kind`. */
@Serializable
@JsonClassDiscriminator("kind")
sealed class AidenBotMemoryEdit {
    /** Rewrites one entry; the Mac gives the new text a new id. */
    @Serializable
    @SerialName("replace")
    data class Replace(val target: AidenBotMemoryTarget, val entryId: String, val text: String) : AidenBotMemoryEdit() {
        init {
            AidenBotMemoryWire.validateEntryId(entryId, "edit.entryId")
            AidenBotWire.validateString(text, "edit.text", AidenBotMemoryWire.MAX_ENTRY_LENGTH)
            if (text.trim() != text) throw AidenBotContractException.InvalidField("edit.text")
        }
    }

    @Serializable
    @SerialName("remove")
    data class Remove(val target: AidenBotMemoryTarget, val entryId: String) : AidenBotMemoryEdit() {
        init {
            AidenBotMemoryWire.validateEntryId(entryId, "edit.entryId")
        }
    }

    /** Erases both stores. */
    @Serializable
    @SerialName("clear")
    data object Clear : AidenBotMemoryEdit()
}

/** `POST /bots/{botId}/memory/edits` body; sent with an `Idempotency-Key`. */
@Serializable
data class AidenBotMemoryEditRequest(val edit: AidenBotMemoryEdit)

/** A successful edit answers with the fresh view. Errors carry no view: refetch instead. */
@Serializable
data class AidenBotMemoryEditResponse(
    @Serializable(with = AidenStrictBooleanSerializer::class) val ok: Boolean,
    val view: AidenBotMemory
) {
    init {
        if (!ok) throw AidenBotContractException.InvalidField("ok")
    }
}
