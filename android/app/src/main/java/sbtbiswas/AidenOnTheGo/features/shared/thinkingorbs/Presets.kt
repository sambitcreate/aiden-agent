package sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs

object OrbPresets {
    val IDLE = OrbSpec(mode = OrbMode.IDLE, dotCount = 80, speed = 0.5)
    val THINKING = OrbSpec(mode = OrbMode.THINKING, dotCount = 140, speed = 1.2)
    val CONNECTING = OrbSpec(mode = OrbMode.CONNECTING, dotCount = 100, speed = 1.0)
    val PLANNING = OrbSpec(mode = OrbMode.PLANNING, dotCount = 120, speed = 0.8)
    val READING = OrbSpec(mode = OrbMode.READING, dotCount = 100, speed = 1.0)
    val WRITING = OrbSpec(mode = OrbMode.WRITING, dotCount = 120, speed = 1.2)
    val SUCCESS = OrbSpec(mode = OrbMode.SUCCESS, dotCount = 90, speed = 0.7)
    val ERROR = OrbSpec(mode = OrbMode.ERROR, dotCount = 80, speed = 0.4)

    fun forMode(mode: OrbMode): OrbSpec {
        return when (mode) {
            OrbMode.IDLE -> IDLE
            OrbMode.THINKING -> THINKING
            OrbMode.CONNECTING -> CONNECTING
            OrbMode.PLANNING -> PLANNING
            OrbMode.READING -> READING
            OrbMode.WRITING -> WRITING
            OrbMode.SUCCESS -> SUCCESS
            OrbMode.ERROR -> ERROR
        }
    }
}
