package sbtbiswas.AidenOnTheGo.features.bots

/**
 * Revision 45 (`bot:images`): the bytes of images a Bot shared, kept while its chat is open within
 * a byte budget. The least recently drawn image goes first; one that is dropped is read from the
 * Mac again the next time it is drawn. An image larger than the whole budget is never kept.
 */
class AidenSharedImageBytes(private val maxBytes: Long = DEFAULT_MAX_BYTES) {
    private val images = LinkedHashMap<String, ByteArray>(16, 0.75f, true)
    private var total = 0L

    /** Bytes held now. */
    val byteCount: Long
        @Synchronized get() = total

    @Synchronized
    operator fun get(id: String): ByteArray? = images[id]

    @Synchronized
    fun put(id: String, data: ByteArray) {
        images.remove(id)?.let { total -= it.size }
        if (data.size > maxBytes) return
        images[id] = data
        total += data.size
        val oldestFirst = images.entries.iterator()
        while (total > maxBytes && oldestFirst.hasNext()) {
            val image = oldestFirst.next()
            if (image.key == id) continue
            total -= image.value.size
            oldestFirst.remove()
        }
    }

    /** Drops every image the transcript no longer shows. */
    @Synchronized
    fun retainOnly(ids: Set<String>) {
        val each = images.entries.iterator()
        while (each.hasNext()) {
            val image = each.next()
            if (image.key in ids) continue
            total -= image.value.size
            each.remove()
        }
    }

    @Synchronized
    fun clear() {
        images.clear()
        total = 0
    }

    companion object {
        /** About four of the largest images the Mac sends (8 MiB each). */
        const val DEFAULT_MAX_BYTES: Long = 32L * 1024 * 1024
    }
}
