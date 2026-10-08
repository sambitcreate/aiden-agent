import Foundation

// MARK: - Contract revision 25: mobile simulator viewer (`mobile-simulators-v1`)
//
// Phones that negotiated `simulators:mobile` may list the Mac's shared
// simulators, open or shut one down, watch its MJPEG stream and send touches,
// hardware buttons and rotations through the hub relay. Wire shapes live in
// `protocol/aiden-remote/v1/fixtures/contract.json` (`mobileSimulators`).

extension AidenRemoteCapability {
    /// Phone-scoped simulator viewing and input, negotiated only behind
    /// `mobile-simulators-v1`.
    static let simulatorsMobile = Self(rawValue: "simulators:mobile")
}

/// Platform of a listed device. Only iOS Simulators stream as MJPEG; anything
/// else (Android emulators stream H.264 only) is listed but opened on the Mac.
enum AidenSimulatorPlatform: Equatable, Sendable {
    case ios
    case android
    case other(String)

    init(rawValue: String) {
        switch rawValue {
        case "ios": self = .ios
        case "android": self = .android
        default: self = .other(rawValue)
        }
    }

    var isViewableOnPhone: Bool { self == .ios }
}

enum AidenSimulatorKind: String, Equatable, Sendable {
    case iphone
    case ipad
    case other

    /// Unknown kinds fall back to `.other` instead of failing the listing.
    init(wireValue: String) {
        self = Self(rawValue: wireValue) ?? .other
    }
}

enum AidenSimulatorHostStatus: String, Equatable, Sendable {
    case disabled
    case needsConsent = "needs-consent"
    case installing
    case starting
    case ready
    case stopped
    case unavailable
    case error

    /// Unknown statuses are treated as unavailable.
    init(wireValue: String) {
        self = Self(rawValue: wireValue) ?? .unavailable
    }

    /// The viewer offers Retry (an explicit listing refetch) in these states.
    var offersRetry: Bool { self == .error || self == .stopped }
}

struct AidenSimulatorDevice: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let platform: AidenSimulatorPlatform
    let version: String
    let booted: Bool
    let kind: AidenSimulatorKind

    init(
        id: String,
        name: String,
        platform: AidenSimulatorPlatform,
        version: String,
        booted: Bool,
        kind: AidenSimulatorKind
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.version = version
        self.booted = booted
        self.kind = kind
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        let platformValue = try values.decode(String.self, forKey: .platform)
        version = try values.decode(String.self, forKey: .version)
        booted = try values.decode(Bool.self, forKey: .booted)
        let kindValue = try values.decode(String.self, forKey: .kind)
        guard Self.isValidIdentifier(id),
              !name.isEmpty, name.count <= 256,
              platformValue.count <= 32,
              version.count <= 64,
              kindValue.count <= 32 else {
            throw AidenRemoteContractError.unsafePayloadField("simulator device")
        }
        platform = AidenSimulatorPlatform(rawValue: platformValue)
        kind = AidenSimulatorKind(wireValue: kindValue)
    }

    /// `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, the desktop's `DEVICE_ID_PATTERN`:
    /// a simulator UDID, an adb serial (`emulator-5554`) or a stopped AVD's
    /// name (`Pixel_9_API_35`). The first byte is alphanumeric, so an id is
    /// never a dot segment or a flag.
    static func isValidIdentifier(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard (1...128).contains(bytes.count), isAlphanumeric(bytes[0]) else { return false }
        return bytes.allSatisfy { isAlphanumeric($0) || $0 == 45 || $0 == 46 || $0 == 95 }
    }

    private static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
    }

    private enum CodingKeys: String, CodingKey { case id, name, platform, version, booted, kind }
}

struct AidenSimulatorToolVersions: Decodable, Equatable, Sendable {
    let hub: String
    let agent: String

    init(hub: String, agent: String) {
        self.hub = hub
        self.agent = agent
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        hub = try values.decode(String.self, forKey: .hub)
        agent = try values.decode(String.self, forKey: .agent)
        guard hub.count <= 64, agent.count <= 64 else {
            throw AidenRemoteContractError.unsafePayloadField("toolVersions")
        }
    }

    private enum CodingKeys: String, CodingKey { case hub, agent }
}

struct AidenSimulatorListing: Decodable, Equatable, Sendable {
    let sharing: Bool
    let status: AidenSimulatorHostStatus
    let detail: String?
    let devices: [AidenSimulatorDevice]
    /// Devices the desktop attached to the requested chat, in server order.
    /// Present only for `GET /simulators?chatId=`; ids not in `devices` are dropped.
    let chatDeviceIds: [String]
    let toolVersions: AidenSimulatorToolVersions?

    init(
        sharing: Bool,
        status: AidenSimulatorHostStatus,
        detail: String? = nil,
        devices: [AidenSimulatorDevice],
        chatDeviceIds: [String] = [],
        toolVersions: AidenSimulatorToolVersions? = nil
    ) {
        self.sharing = sharing
        self.status = status
        self.detail = detail
        self.devices = devices
        let listed = Set(devices.map(\.id))
        self.chatDeviceIds = chatDeviceIds.filter(listed.contains)
        self.toolVersions = toolVersions
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let sharing = try values.decode(Bool.self, forKey: .sharing)
        let status = try values.decode(String.self, forKey: .status)
        let detail = try values.decodeIfPresent(String.self, forKey: .detail)
        // A device this version cannot use (an id it does not admit, a missing
        // field, a repeat) is skipped, so one odd entry never hides the rest.
        let entries = try values.decode([AidenSimulatorLossyDevice].self, forKey: .devices)
        var listed = Set<String>()
        let devices = entries.compactMap(\.device).filter { listed.insert($0.id).inserted }
        let chatDeviceIds = try values.decodeIfPresent([String].self, forKey: .chatDeviceIds) ?? []
        let toolVersions = try values.decodeIfPresent(AidenSimulatorToolVersions.self, forKey: .toolVersions)
        guard status.count <= 32,
              (detail?.count ?? 0) <= 2_000,
              entries.count <= 256,
              sharing || entries.isEmpty,
              chatDeviceIds.count <= 256 else {
            throw AidenRemoteContractError.unsafePayloadField("simulator listing")
        }
        var seen = Set<String>()
        self.init(
            sharing: sharing,
            status: AidenSimulatorHostStatus(wireValue: status),
            detail: detail,
            devices: devices,
            chatDeviceIds: chatDeviceIds.filter { seen.insert($0).inserted },
            toolVersions: toolVersions
        )
    }

    /// The chat's devices in `chatDeviceIds` order.
    var chatDevices: [AidenSimulatorDevice] {
        chatDeviceIds.compactMap { id in devices.first { $0.id == id } }
    }

    /// Whether the chat composer offers the device button.
    var showsChatDeviceButton: Bool { sharing && !chatDeviceIds.isEmpty }

    /// The device the viewer opens first: the first viewable chat device, else
    /// the first chat device, else the first viewable device.
    var defaultViewerDeviceId: String? {
        let chat = chatDevices
        return chat.first { $0.platform.isViewableOnPhone }?.id
            ?? chat.first?.id
            ?? devices.first { $0.platform.isViewableOnPhone }?.id
    }

    /// The same listing with the chat attachment of `previous`, for refetches
    /// made without `chatId` (Retry), which never carry `chatDeviceIds`.
    func keepingChatDevices(of previous: AidenSimulatorListing?) -> AidenSimulatorListing {
        guard chatDeviceIds.isEmpty, let previous else { return self }
        return AidenSimulatorListing(
            sharing: sharing,
            status: status,
            detail: detail,
            devices: devices,
            chatDeviceIds: previous.chatDeviceIds,
            toolVersions: toolVersions ?? previous.toolVersions
        )
    }

    private enum CodingKeys: String, CodingKey {
        case sharing, status, detail, devices, chatDeviceIds, toolVersions
    }
}

/// One `devices` entry, or nil when it does not decode as a usable device.
private struct AidenSimulatorLossyDevice: Decodable {
    let device: AidenSimulatorDevice?

    init(from decoder: Decoder) throws {
        device = try? AidenSimulatorDevice(from: decoder)
    }
}

struct AidenSimulatorOpenResponse: Decodable, Equatable, Sendable {
    let device: AidenSimulatorDevice
}

struct AidenSimulatorShutdownResponse: Decodable, Equatable, Sendable {
    let ok: Bool

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decode(Bool.self, forKey: .ok)
        guard ok else { throw AidenRemoteContractError.unsafePayloadField("ok") }
    }

    private enum CodingKeys: String, CodingKey { case ok }
}

// MARK: - Helper socket messages

enum AidenSimulatorOrientation: String, CaseIterable, Equatable, Sendable {
    case portrait
    case landscapeLeft = "landscape_left"
    case portraitUpsideDown = "portrait_upside_down"
    case landscapeRight = "landscape_right"

    /// Rotate cycles portrait → landscape left → upside down → landscape right.
    var next: Self {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
}

/// The helper's last reported screen: the raw framebuffer size and the
/// device orientation. Extra fields are ignored.
struct AidenSimulatorScreenConfig: Equatable, Sendable {
    let width: Double
    let height: Double
    let orientation: AidenSimulatorOrientation
}

enum AidenSimulatorTouchPhase: String, Equatable, Sendable {
    case begin, move, end
}

enum AidenSimulatorButton: String, Equatable, Sendable {
    case home
    case lock
    case appSwitcher = "app_switcher"
}

/// Binary `[tag][UTF-8 JSON]` messages for the serve-sim helper socket.
/// Adapted from t3code packages/client-runtime/src/device/stream.ts (MIT), via
/// Aiden's desktop encoder in renderer/lib/device-stream.ts.
enum AidenSimulatorHelperMessage {
    static let touchTag: UInt8 = 0x03
    static let buttonTag: UInt8 = 0x04
    static let orientationTag: UInt8 = 0x07
    static let hardwareKeyboardTag: UInt8 = 0x0D
    static let screenConfigTag: UInt8 = 0x82
    static let controlReplyTag: UInt8 = 0x90

    static func hardwareKeyboard(enabled: Bool) -> Data {
        tagged(hardwareKeyboardTag, ["enabled": enabled])
    }

    /// `x` and `y` are normalized to the displayed frame (0,0 top-left).
    static func touch(
        _ phase: AidenSimulatorTouchPhase,
        x: Double,
        y: Double,
        screen: AidenSimulatorScreenConfig?
    ) -> Data {
        let point = rawPoint(x: clamp(x), y: clamp(y), screen: screen)
        return tagged(touchTag, ["type": phase.rawValue, "x": point.x, "y": point.y])
    }

    static func button(_ button: AidenSimulatorButton) -> Data {
        tagged(buttonTag, ["button": button.rawValue])
    }

    static func rotate(from screen: AidenSimulatorScreenConfig?) -> Data {
        let next = (screen?.orientation ?? .portrait).next
        return tagged(orientationTag, ["orientation": next.rawValue])
    }

    /// serve-sim streams the raw portrait framebuffer, so a rotated device
    /// needs touches remapped into that raw space.
    static func rawPoint(
        x: Double,
        y: Double,
        screen: AidenSimulatorScreenConfig?
    ) -> (x: Double, y: Double) {
        guard let screen, screen.width <= screen.height else { return (x, y) }
        switch screen.orientation {
        case .landscapeLeft: return (y, 1 - x)
        case .landscapeRight: return (1 - y, x)
        case .portraitUpsideDown: return (1 - x, 1 - y)
        case .portrait: return (x, y)
        }
    }

    /// Decodes a helper → client screen config (`0x82`). Any other tag,
    /// malformed JSON, a non-positive size or an unknown orientation is nil.
    static func screenConfig(from message: Data) -> AidenSimulatorScreenConfig? {
        guard message.first == screenConfigTag,
              let object = try? JSONSerialization.jsonObject(with: message.dropFirst()),
              let record = object as? [String: Any],
              let width = finitePositive(record["width"]),
              let height = finitePositive(record["height"]),
              let rawOrientation = record["orientation"] as? String,
              let orientation = AidenSimulatorOrientation(rawValue: rawOrientation) else {
            return nil
        }
        return AidenSimulatorScreenConfig(width: width, height: height, orientation: orientation)
    }

    private static func finitePositive(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        return double.isFinite && double > 0 ? double : nil
    }

    private static func clamp(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(max(value, 0), 1)
    }

    private static func tagged(_ tag: UInt8, _ payload: [String: Any]) -> Data {
        var data = Data([tag])
        // Dictionaries of strings, booleans and finite doubles always serialize.
        data.append((try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8))
        return data
    }
}

/// How the input socket reacts to a close. Close codes 1008 and 4401, or
/// HTTP 401/403 on the upgrade, mean the credential or grant was refused:
/// stop and show an error. Other closes, including an abnormal 1006 when the
/// Mac or the network drops the socket, retry once after about a second.
/// (A browser reports a refused upgrade as 1006; URLSession reports the HTTP
/// status instead, so 1006 is not a refusal here.)
enum AidenSimulatorInputRetryPolicy {
    enum Decision: Equatable {
        case retry(after: TimeInterval)
        case refused
        case giveUp
    }

    static let retryDelay: TimeInterval = 1
    static let maximumRetries = 1

    static func decision(closeCode: Int?, httpStatus: Int?, retriesUsed: Int) -> Decision {
        if let httpStatus, httpStatus == 401 || httpStatus == 403 { return .refused }
        if let closeCode, [1008, 4401].contains(closeCode) { return .refused }
        return retriesUsed < maximumRetries ? .retry(after: retryDelay) : .giveUp
    }
}
