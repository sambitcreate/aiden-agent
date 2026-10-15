package sbtbiswas.AidenOnTheGo.ui.theme

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

class AidenAdaptiveTest {
    @Test
    fun windowWidthClassesFollowTheMaterialBreakpoints() {
        assertEquals(AidenWindowWidthClass.Compact, AidenWindowWidthClass.forWidth(0.dp))
        assertEquals(AidenWindowWidthClass.Compact, AidenWindowWidthClass.forWidth(411.dp))
        assertEquals(AidenWindowWidthClass.Compact, AidenWindowWidthClass.forWidth(599.9.dp))
        assertEquals(AidenWindowWidthClass.Medium, AidenWindowWidthClass.forWidth(600.dp))
        assertEquals(AidenWindowWidthClass.Medium, AidenWindowWidthClass.forWidth(839.dp))
        assertEquals(AidenWindowWidthClass.Expanded, AidenWindowWidthClass.forWidth(840.dp))
        assertEquals("large and extra-large windows share the expanded layout", AidenWindowWidthClass.Expanded, AidenWindowWidthClass.forWidth(1600.dp))
    }
}
