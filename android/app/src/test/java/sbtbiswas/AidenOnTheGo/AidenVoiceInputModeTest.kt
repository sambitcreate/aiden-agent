package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Test
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputMode

class AidenVoiceInputModeTest {
    @Test fun unknownPersistedValuesFailClosedToOnDevice() {
        assertEquals(AidenVoiceInputMode.ON_DEVICE, AidenVoiceInputMode.fromWireValue("future-mode"))
    }

    @Test fun pairedMacRoundTripsItsStableValue() {
        assertEquals(
            AidenVoiceInputMode.PAIRED_MAC,
            AidenVoiceInputMode.fromWireValue(AidenVoiceInputMode.PAIRED_MAC.wireValue)
        )
    }
}
