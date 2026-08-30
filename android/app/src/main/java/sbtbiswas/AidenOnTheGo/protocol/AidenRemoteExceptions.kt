package sbtbiswas.AidenOnTheGo.protocol

sealed class AidenRemoteContractException(message: String) : Exception(message) {
    class DuplicateJsonKey(val key: String) : AidenRemoteContractException("Duplicate JSON key: $key")
    class InvalidJson(message: String = "Invalid JSON") : AidenRemoteContractException(message)
    class UnknownTerminalEvent(val eventType: String) : AidenRemoteContractException("Unknown terminal event: $eventType")
    class UnsafePayloadField(val field: String) : AidenRemoteContractException("Unsafe or forbidden payload field: $field")
    object PayloadTooLarge : AidenRemoteContractException("Payload exceeds maximum size bounds")
    class UnknownErrorCode(val code: String) : AidenRemoteContractException("Unknown error code: $code")
    object InvalidTerminalClassification : AidenRemoteContractException("Invalid terminal event classification")
    object InvalidProtocolVersion : AidenRemoteContractException("Invalid protocol version")
    object InvalidStreamIdentity : AidenRemoteContractException("Invalid stream identity")
    object InvalidSequence : AidenRemoteContractException("Invalid sequence number")
    object InvalidPairingExchange : AidenRemoteContractException("Invalid pairing exchange")
    class ProtocolViolation(message: String = "Protocol violation") : AidenRemoteContractException(message)
}

sealed class AidenBotContractException(val reason: String, message: String = reason) : Exception(message) {
    class InvalidField(val field: String) : AidenBotContractException("invalid field: $field", "Aiden Agent returned Bot information this version of Aiden On The Go can’t use. Update Aiden Agent and Aiden On The Go, then try again.")
    class InvalidCombination(val combination: String) : AidenBotContractException(
        combination,
        when (combination) {
            "no available provider and model" -> "Set up a provider and model on your paired desktop. In Aiden Agent, open Settings → Providers, connect or refresh a provider, and make at least one chat model available. Then tap Try Again."
            "unavailable custom access" -> "One or more selected AI, Files, Connections, or Skills are no longer available. Review this Bot’s access choices and try again."
            "chat access exceeds bot" -> "This chat is asking for more access than the Bot currently allows. Reduce the chat’s access or expand the Bot’s access, then try again."
            "full access notice" -> "Review and accept the Full Access notice before giving this Bot full access."
            else -> "Aiden Agent returned Bot information this version of Aiden On The Go can’t use. Update Aiden Agent and Aiden On The Go, then try again."
        }
    )
}

sealed class AidenManualPairingException(message: String) : Exception(message) {
    object InvalidCode : AidenManualPairingException("Enter the 20-character setup code shown on your desktop.")
    object InvalidBootstrap : AidenManualPairingException("Aiden Agent returned an invalid manual pairing response.")
    object DecryptionFailed : AidenManualPairingException("The setup code is incorrect or belongs to a different pairing window.")
    object EndpointMismatch : AidenManualPairingException("The setup code belongs to a different Aiden Agent address.")
}

sealed class AidenPairingBootstrapException(message: String) : Exception(message) {
    object UnsupportedProtocol : AidenPairingBootstrapException("Unsupported protocol")
    object InvalidInstance : AidenPairingBootstrapException("Invalid instance")
    object InvalidEndpoint : AidenPairingBootstrapException("Invalid endpoint")
    object InvalidFingerprint : AidenPairingBootstrapException("Invalid fingerprint")
    object WeakSecret : AidenPairingBootstrapException("Weak secret")
    object Expired : AidenPairingBootstrapException("Pairing secret expired")
    object ExcessiveTTL : AidenPairingBootstrapException("Excessive pairing TTL")
}

sealed class AidenPairingPayloadException(message: String) : Exception(message) {
    object InvalidKind : AidenPairingPayloadException("Invalid kind")
    object InvalidTrust : AidenPairingPayloadException("Invalid trust")
    object InvalidCACertificateData : AidenPairingPayloadException("Invalid CA certificate data")
}

sealed class AidenSSEParserException(message: String) : Exception(message) {
    object FrameTooLarge : AidenSSEParserException("SSE frame exceeds maximum allowed size")
    object InvalidEventID : AidenSSEParserException("Invalid SSE event ID")
    object EventIDMismatch : AidenSSEParserException("SSE event ID mismatch with sequence number")
    object EventNameMismatch : AidenSSEParserException("SSE event name mismatch with payload type")
    object MissingData : AidenSSEParserException("SSE event missing data payload")
}

sealed class AidenRemoteClientException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    object MissingCredential : AidenRemoteClientException("No credential available for this installation.")
    object MissingTrustConfiguration : AidenRemoteClientException("This Aiden installation must be paired again to establish secure server trust.")
    object InstallationChanged : AidenRemoteClientException("The active Aiden Agent changed. Try again on the selected desktop.")
    object InvalidEndpoint : AidenRemoteClientException("The Aiden Agent address is invalid.")
    class UnexpectedStatus(val statusCode: Int) : AidenRemoteClientException("Aiden Agent returned HTTP status $statusCode.")
    data class Server(val statusCode: Int, val body: AidenRemoteErrorEnvelope.Body) : AidenRemoteClientException(body.message) {
        val isCredentialRevoked: Boolean
            get() = statusCode == 401 || statusCode == 403 || body.code == AidenRemoteErrorCode.CREDENTIAL_REVOKED
    }
    class InvalidResponse(message: String = "Aiden Agent returned an invalid response.") : AidenRemoteClientException(message)
    class Disconnected(message: String = "Disconnected from Aiden Agent.") : AidenRemoteClientException(message)
    class IdempotencyConflict(message: String = "Operation already in progress.") : AidenRemoteClientException(message)
}
