import CryptoKit
import Foundation
import Security

enum AidenServerTrustError: Error, Equatable {
    case missingLeafCertificate
    case invalidAnchorCertificate
    case missingPublicKey
    case unsupportedPublicKey
    case invalidPublicKeyRepresentation
    case trustConfigurationFailed(OSStatus)
    case hostnameOrCertificateInvalid
    case publicKeyPinMismatch
}

enum AidenServerTrustPolicy: Equatable, Sendable {
    case system
    case privateCA(Data)

    init(pairingTrust: AidenRemoteContractFixture.PairingTrust) throws {
        switch pairingTrust.mode {
        case .system:
            self = .system
        case .privateCA:
            guard let certificate = pairingTrust.caCertificateDER,
                  SecCertificateCreateWithData(nil, certificate as CFData) != nil else {
                throw AidenServerTrustError.invalidAnchorCertificate
            }
            self = .privateCA(certificate)
        }
    }
}

enum AidenServerTrust {
    // ASN.1 SubjectPublicKeyInfo prefix for an uncompressed P-256 public key.
    private static let p256SPKIPrefix = Data([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE,
        0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D,
        0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ])

    static func spkiSHA256(p256ExternalRepresentation: Data) throws -> String {
        guard p256ExternalRepresentation.count == 65,
              p256ExternalRepresentation.first == 0x04 else {
            throw AidenServerTrustError.invalidPublicKeyRepresentation
        }
        let digest = SHA256.hash(data: p256SPKIPrefix + p256ExternalRepresentation)
        return "sha256/\(Data(digest).base64EncodedString())"
    }

    static func spkiSHA256(certificate: SecCertificate) throws -> String {
        guard let publicKey = SecCertificateCopyKey(certificate) else {
            throw AidenServerTrustError.missingPublicKey
        }
        guard let attributes = SecKeyCopyAttributes(publicKey) as? [CFString: Any],
              let keyType = attributes[kSecAttrKeyType] as? String,
              keyType == (kSecAttrKeyTypeECSECPrimeRandom as String),
              let keySize = attributes[kSecAttrKeySizeInBits] as? Int,
              keySize == 256 else {
            throw AidenServerTrustError.unsupportedPublicKey
        }
        var error: Unmanaged<CFError>?
        guard let representation = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw error?.takeRetainedValue() ?? AidenServerTrustError.invalidPublicKeyRepresentation
        }
        return try spkiSHA256(p256ExternalRepresentation: representation)
    }

    static func evaluate(
        serverTrust: SecTrust,
        expectedHost: String,
        expectedFingerprint: String,
        policy: AidenServerTrustPolicy,
        verificationDate: Date? = nil
    ) throws {
        guard let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
              let leaf = chain.first else {
            throw AidenServerTrustError.missingLeafCertificate
        }
        let policyStatus = SecTrustSetPolicies(
            serverTrust,
            SecPolicyCreateSSL(true, expectedHost as CFString)
        )
        guard policyStatus == errSecSuccess else {
            throw AidenServerTrustError.trustConfigurationFailed(policyStatus)
        }
        switch policy {
        case .system:
            let anchorStatus = SecTrustSetAnchorCertificates(serverTrust, nil)
            guard anchorStatus == errSecSuccess else {
                throw AidenServerTrustError.trustConfigurationFailed(anchorStatus)
            }
            let anchorsOnlyStatus = SecTrustSetAnchorCertificatesOnly(serverTrust, false)
            guard anchorsOnlyStatus == errSecSuccess else {
                throw AidenServerTrustError.trustConfigurationFailed(anchorsOnlyStatus)
            }
        case .privateCA(let certificateData):
            guard let trustAnchor = SecCertificateCreateWithData(nil, certificateData as CFData) else {
                throw AidenServerTrustError.invalidAnchorCertificate
            }
            let anchorStatus = SecTrustSetAnchorCertificates(serverTrust, [trustAnchor] as CFArray)
            guard anchorStatus == errSecSuccess else {
                throw AidenServerTrustError.trustConfigurationFailed(anchorStatus)
            }
            let anchorsOnlyStatus = SecTrustSetAnchorCertificatesOnly(serverTrust, true)
            guard anchorsOnlyStatus == errSecSuccess else {
                throw AidenServerTrustError.trustConfigurationFailed(anchorsOnlyStatus)
            }
        }
        if let verificationDate {
            let dateStatus = SecTrustSetVerifyDate(serverTrust, verificationDate as CFDate)
            guard dateStatus == errSecSuccess else {
                throw AidenServerTrustError.trustConfigurationFailed(dateStatus)
            }
        }
        var evaluationError: CFError?
        guard SecTrustEvaluateWithError(serverTrust, &evaluationError) else {
            throw AidenServerTrustError.hostnameOrCertificateInvalid
        }
        let actualFingerprint = try spkiSHA256(certificate: leaf)
        guard constantTimeEqual(actualFingerprint, expectedFingerprint) else {
            throw AidenServerTrustError.publicKeyPinMismatch
        }
    }

    private static func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let lhs = Array(left.utf8)
        let rhs = Array(right.utf8)
        var difference = lhs.count ^ rhs.count
        for index in 0..<max(lhs.count, rhs.count) {
            let leftByte = index < lhs.count ? lhs[index] : 0
            let rightByte = index < rhs.count ? rhs[index] : 0
            difference |= Int(leftByte ^ rightByte)
        }
        return difference == 0
    }
}

final class AidenPinnedServerSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let expectedHost: String
    private let expectedPort: Int
    private let expectedFingerprint: String
    private let trustPolicy: AidenServerTrustPolicy
    private let failureLock = NSLock()
    private var recordedTrustError: AidenServerTrustError?

    var lastTrustError: AidenServerTrustError? {
        failureLock.lock()
        defer { failureLock.unlock() }
        return recordedTrustError
    }

    init(
        expectedHost: String,
        expectedPort: Int? = nil,
        expectedFingerprint: String,
        trustPolicy: AidenServerTrustPolicy
    ) {
        self.expectedHost = expectedHost
        self.expectedPort = expectedPort ?? 443
        self.expectedFingerprint = expectedFingerprint
        self.trustPolicy = trustPolicy
    }

    func allowsRedirect(to destination: URL) -> Bool {
        destination.scheme?.lowercased() == "https" &&
            destination.host == expectedHost &&
            (destination.port ?? 443) == expectedPort
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == expectedHost,
              challenge.protectionSpace.port == expectedPort,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        do {
            try AidenServerTrust.evaluate(
                serverTrust: serverTrust,
                expectedHost: expectedHost,
                expectedFingerprint: expectedFingerprint,
                policy: trustPolicy
            )
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } catch let error as AidenServerTrustError {
            failureLock.lock()
            recordedTrustError = error
            failureLock.unlock()
            completionHandler(.cancelAuthenticationChallenge, nil)
        } catch {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        guard let destination = request.url, allowsRedirect(to: destination) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}
