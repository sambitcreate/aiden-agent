package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBotAvatarDetail

class AidenBotExpressivePresentationTest {
    @Test
    fun newBotFabIsACircleAtRestAndASquircleWhilePressedOrScrolling() {
        val resting = aidenBotsDockFabCornerRadius(pressed = false, scrolling = false)
        val pressed = aidenBotsDockFabCornerRadius(pressed = true, scrolling = false)
        val scrolling = aidenBotsDockFabCornerRadius(pressed = false, scrolling = true)

        // A 54dp FAB is a full circle when its radius is half its size.
        assertEquals(27.dp, resting)
        assertTrue(pressed < resting)
        assertEquals(pressed, scrolling)
        assertTrue(pressed in 12.dp..24.dp)
    }

    @Test
    fun onlyHeroAvatarsWithAnAccessoryFloatAndOnlyWhenMotionIsAllowed() {
        assertTrue(aidenBotAvatarAccessoryFloats(112.dp, AidenBotAvatarDetail.HALO, reduceMotion = false))
        assertTrue(aidenBotAvatarAccessoryFloats(64.dp, AidenBotAvatarDetail.ORBIT, reduceMotion = false))

        assertFalse(aidenBotAvatarAccessoryFloats(112.dp, AidenBotAvatarDetail.HALO, reduceMotion = true))
        assertFalse(aidenBotAvatarAccessoryFloats(52.dp, AidenBotAvatarDetail.HALO, reduceMotion = false))
        assertFalse(aidenBotAvatarAccessoryFloats(112.dp, AidenBotAvatarDetail.NONE, reduceMotion = false))
    }
}
