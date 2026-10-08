import CoreGraphics
import Foundation
import ImageIO

/// The installation's pinned trust, copied from the client that made it.
struct AidenSimulatorTransportTrust: Sendable {
    let host: String
    let port: Int?
    let fingerprint: String
    let policy: AidenServerTrustPolicy
}

/// One viewer's pinned URLSession for the hub relay's MJPEG stream and input
/// socket. Trust and redirects go through `AidenPinnedServerSessionDelegate`,
/// exactly as for every other Aiden request. Close it when the viewer closes.
final class AidenSimulatorTransport: @unchecked Sendable {
    /// Idle limit between bytes. A static simulator screen may send nothing
    /// for a while, so the stream is bounded by the viewer, not the clock.
    static let idleTimeout: TimeInterval = 60 * 60

    let session: URLSession
    private let router: AidenSimulatorSessionRouter

    init(trust: AidenSimulatorTransportTrust) {
        router = AidenSimulatorSessionRouter(trust: AidenPinnedServerSessionDelegate(
            expectedHost: trust.host,
            expectedPort: trust.port,
            expectedFingerprint: trust.fingerprint,
            trustPolicy: trust.policy
        ))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = Self.idleTimeout
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
        queue.name = "AidenSimulatorTransport"
        session = URLSession(configuration: configuration, delegate: router, delegateQueue: queue)
    }

    deinit {
        session.invalidateAndCancel()
    }

    func close() {
        session.invalidateAndCancel()
    }

    func makeFrameStream(
        request: URLRequest,
        onEvent: @escaping @Sendable (AidenSimulatorFrameStream.Event) -> Void
    ) -> AidenSimulatorFrameStream {
        AidenSimulatorFrameStream(session: session, router: router, request: request, onEvent: onEvent)
    }

    func makeInputSocket(
        request: URLRequest,
        onEvent: @escaping @Sendable (AidenSimulatorInputSocket.Event) -> Void
    ) -> AidenSimulatorInputSocket {
        AidenSimulatorInputSocket(session: session, router: router, request: request, onEvent: onEvent)
    }
}

/// Per-task callbacks routed by the transport's session delegate.
protocol AidenSimulatorTaskReceiver: AnyObject, Sendable {
    func didReceive(response: URLResponse) -> URLSession.ResponseDisposition
    func didReceive(data: Data)
    func didOpenSocket()
    func didCloseSocket(code: Int)
    func didComplete(task: URLSessionTask, error: Error?)
}

extension AidenSimulatorTaskReceiver {
    func didReceive(response: URLResponse) -> URLSession.ResponseDisposition { .allow }
    func didReceive(data: Data) {}
    func didOpenSocket() {}
    func didCloseSocket(code: Int) {}
}

final class AidenSimulatorSessionRouter: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate,
    @unchecked Sendable {
    private let trust: AidenPinnedServerSessionDelegate
    private let lock = NSLock()
    private var receivers: [Int: any AidenSimulatorTaskReceiver] = [:]

    init(trust: AidenPinnedServerSessionDelegate) {
        self.trust = trust
    }

    func register(_ receiver: any AidenSimulatorTaskReceiver, for task: URLSessionTask) {
        lock.withLock { receivers[task.taskIdentifier] = receiver }
    }

    private func receiver(for task: URLSessionTask) -> (any AidenSimulatorTaskReceiver)? {
        lock.withLock { receivers[task.taskIdentifier] }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        trust.urlSession(session, didReceive: challenge, completionHandler: completionHandler)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        // The relay never redirects; refuse rather than re-send the bearer.
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        completionHandler(receiver(for: dataTask)?.didReceive(response: response) ?? .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        receiver(for: dataTask)?.didReceive(data: data)
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        receiver(for: webSocketTask)?.didOpenSocket()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        receiver(for: webSocketTask)?.didCloseSocket(code: closeCode.rawValue)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let receiver = lock.withLock { receivers.removeValue(forKey: task.taskIdentifier) }
        receiver?.didComplete(task: task, error: error)
    }
}

/// Holds at most one JPEG waiting for the decoder. A frame offered while a
/// decode runs replaces the waiting one, so the viewer never falls behind.
struct AidenLatestFrameMailbox {
    private(set) var pending: Data?
    private(set) var isDecoding = false

    /// Returns true when the caller should start a decode pass.
    mutating func offer(_ frame: Data) -> Bool {
        pending = frame
        guard !isDecoding else { return false }
        isDecoding = true
        return true
    }

    /// The next frame to decode, or nil when the pass is over.
    mutating func take() -> Data? {
        guard let frame = pending else {
            isDecoding = false
            return nil
        }
        pending = nil
        return frame
    }
}

/// Decodes JPEGs on a background queue, newest first, dropping stale frames.
final class AidenSimulatorFrameDecoder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "AidenSimulatorFrameDecoder", qos: .userInitiated)
    private let lock = NSLock()
    private var mailbox = AidenLatestFrameMailbox()
    private let output: @Sendable (CGImage) -> Void

    init(output: @escaping @Sendable (CGImage) -> Void) {
        self.output = output
    }

    func submit(_ jpeg: Data) {
        guard lock.withLock({ mailbox.offer(jpeg) }) else { return }
        queue.async { [self] in
            while let next = lock.withLock({ mailbox.take() }) {
                if let image = Self.decode(next) { output(image) }
            }
        }
    }

    static func decode(_ jpeg: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(
            jpeg as CFData,
            [kCGImageSourceShouldCache: false] as CFDictionary
        ) else { return nil }
        return CGImageSourceCreateImageAtIndex(
            source,
            0,
            [kCGImageSourceShouldCacheImmediately: true] as CFDictionary
        )
    }
}

enum AidenSimulatorStreamFailure: Error, Equatable, Sendable {
    /// HTTP 401/403: the credential or `simulators:mobile` grant was refused.
    case refused
    /// HTTP 404: sharing is off or the device is no longer listed.
    case notFound
    /// HTTP 429: the relay's per-device handle limit.
    case capacity
    case status(Int)
    case partTooLarge
    case disconnected

    init(httpStatus: Int) {
        switch httpStatus {
        case 401, 403: self = .refused
        case 404: self = .notFound
        case 429: self = .capacity
        default: self = .status(httpStatus)
        }
    }
}

/// The MJPEG stream of one device: parses parts on the session's delegate
/// queue and hands only the newest JPEG to the background decoder.
final class AidenSimulatorFrameStream: AidenSimulatorTaskReceiver, @unchecked Sendable {
    enum Event: Sendable {
        /// The first body bytes arrived, so screen capture is running and the
        /// input socket may connect.
        case receiving
        case frame(CGImage)
        case failed(AidenSimulatorStreamFailure)
    }

    private let session: URLSession
    private let router: AidenSimulatorSessionRouter
    private let request: URLRequest
    private let onEvent: @Sendable (Event) -> Void
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var parser = AidenMJPEGMultipartParser()
    private var sawBytes = false
    private var isCancelled = false
    private lazy var decoder = AidenSimulatorFrameDecoder { [weak self] image in
        self?.emit(.frame(image))
    }

    fileprivate init(
        session: URLSession,
        router: AidenSimulatorSessionRouter,
        request: URLRequest,
        onEvent: @escaping @Sendable (Event) -> Void
    ) {
        self.session = session
        self.router = router
        self.request = request
        self.onEvent = onEvent
    }

    func start() {
        let task = session.dataTask(with: request)
        lock.withLock { self.task = task }
        router.register(self, for: task)
        task.resume()
    }

    func cancel() {
        let task = lock.withLock { () -> URLSessionDataTask? in
            isCancelled = true
            return self.task
        }
        task?.cancel()
    }

    private func emit(_ event: Event) {
        guard !lock.withLock({ isCancelled }) else { return }
        onEvent(event)
    }

    func didReceive(response: URLResponse) -> URLSession.ResponseDisposition {
        guard let http = response as? HTTPURLResponse else {
            emit(.failed(.disconnected))
            return .cancel
        }
        guard http.statusCode == 200 else {
            emit(.failed(AidenSimulatorStreamFailure(httpStatus: http.statusCode)))
            cancel()
            return .cancel
        }
        let boundary = AidenMJPEGMultipartParser.boundary(
            fromContentType: http.value(forHTTPHeaderField: "Content-Type")
        )
        lock.withLock { parser = AidenMJPEGMultipartParser(boundary: boundary) }
        return .allow
    }

    func didReceive(data: Data) {
        let result = lock.withLock { () -> (first: Bool, frames: [Data]?) in
            let first = !sawBytes
            sawBytes = true
            return (first, try? parser.append(data))
        }
        if result.first { emit(.receiving) }
        guard let frames = result.frames else {
            emit(.failed(.partTooLarge))
            cancel()
            return
        }
        // Only the newest complete frame of a chunk is worth decoding.
        if let latest = frames.last { decoder.submit(latest) }
    }

    func didComplete(task: URLSessionTask, error: Error?) {
        emit(.failed(.disconnected))
    }
}

/// The helper input socket of one device.
final class AidenSimulatorInputSocket: AidenSimulatorTaskReceiver, @unchecked Sendable {
    enum Event: Sendable {
        case connected
        case screen(AidenSimulatorScreenConfig)
        case closed(closeCode: Int?, httpStatus: Int?)
    }

    private let session: URLSession
    private let router: AidenSimulatorSessionRouter
    private let request: URLRequest
    private let onEvent: @Sendable (Event) -> Void
    private let lock = NSLock()
    private var task: URLSessionWebSocketTask?
    private var isOpen = false
    private var isClosed = false
    private var closeCode: Int?

    fileprivate init(
        session: URLSession,
        router: AidenSimulatorSessionRouter,
        request: URLRequest,
        onEvent: @escaping @Sendable (Event) -> Void
    ) {
        self.session = session
        self.router = router
        self.request = request
        self.onEvent = onEvent
    }

    func start() {
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 64 * 1_024
        lock.withLock { self.task = task }
        router.register(self, for: task)
        task.resume()
        receive(on: task)
    }

    func send(_ message: Data) {
        let task = lock.withLock { isOpen && !isClosed ? self.task : nil }
        task?.send(.data(message)) { _ in }
    }

    func close() {
        let task = lock.withLock { () -> URLSessionWebSocketTask? in
            isClosed = true
            isOpen = false
            return self.task
        }
        task?.cancel(with: .normalClosure, reason: nil)
    }

    private func emit(_ event: Event) {
        guard !lock.withLock({ isClosed }) else { return }
        onEvent(event)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, case .success(let message) = result else { return }
            if case .data(let data) = message,
               let screen = AidenSimulatorHelperMessage.screenConfig(from: data) {
                emit(.screen(screen))
            }
            guard !lock.withLock({ self.isClosed }) else { return }
            receive(on: task)
        }
    }

    func didOpenSocket() {
        let task = lock.withLock { () -> URLSessionWebSocketTask? in
            guard !isClosed else { return nil }
            isOpen = true
            return self.task
        }
        guard let task else { return }
        task.send(.data(AidenSimulatorHelperMessage.hardwareKeyboard(enabled: false))) { _ in }
        emit(.connected)
    }

    func didCloseSocket(code: Int) {
        lock.withLock { closeCode = code }
    }

    func didComplete(task: URLSessionTask, error: Error?) {
        let code = lock.withLock { () -> Int? in
            isOpen = false
            return closeCode
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        emit(.closed(closeCode: code, httpStatus: status))
    }
}
