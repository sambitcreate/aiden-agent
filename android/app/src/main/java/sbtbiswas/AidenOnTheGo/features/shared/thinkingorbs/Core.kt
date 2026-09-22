package sbtbiswas.AidenOnTheGo.features.shared.thinkingorbs

import kotlin.math.*

data class Dot(
    var x: Double,
    var y: Double,
    var z: Double,
    var r: Double,
    var white: Double,
    var a: Double = 1.0
)

data class Line(
    var x1: Double,
    var y1: Double,
    var x2: Double,
    var y2: Double,
    var white: Double,
    var a: Double,
    var w: Double
)

data class OrbFrame(
    val dots: List<Dot>,
    val lines: List<Line>
)

fun hashD(a: Double, b: Double): Double {
    val h = sin(a * 12.9898 + b * 78.233) * 43758.5453
    return h - floor(h)
}

fun vnoise(x: Double, y: Double): Double {
    val xi = floor(x)
    val yi = floor(y)
    var fx = x - xi
    var fy = y - yi
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    val a = hashD(xi, yi)
    val b = hashD(xi + 1.0, yi)
    val c = hashD(xi, yi + 1.0)
    val d = hashD(xi + 1.0, yi + 1.0)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

fun fibDir(i: Int, n: Int): Triple<Double, Double, Double> {
    val golden = Math.PI * (3.0 - sqrt(5.0))
    val y = 1.0 - (2.0 * (i.toDouble() + 0.5)) / n.toDouble()
    val rad = sqrt(max(0.0, 1.0 - y * y))
    val a = i.toDouble() * golden
    return Triple(rad * cos(a), y, rad * sin(a))
}

class Projector(
    val yaw: Double,
    val tilt: Double,
    val cx: Double,
    val cy: Double,
    val scale: Double
) {
    private val st = sin(tilt)
    private val ct = cos(tilt)
    private val sy = sin(yaw)
    private val cyw = cos(yaw)

    fun project(x: Double, y: Double, z: Double): Triple<Double, Double, Double> {
        val x1 = x * cyw + z * sy
        val z1 = -x * sy + z * cyw
        val y1 = y * ct - z1 * st
        val z2 = y * st + z1 * ct
        return Triple(cx + x1 * scale, cy - y1 * scale, z2)
    }
}

fun finalizeFrame(dots: List<Dot>, lines: List<Line>, rMin: Double = 0.3): OrbFrame {
    val visible = dots.filter { it.a >= 0.02 }.map {
        it.copy(r = max(rMin, it.r))
    }
    val sorted = visible.sortedWith(compareBy<Dot> { it.z })
    return OrbFrame(dots = sorted, lines = lines.filter { it.a >= 0.02 })
}
