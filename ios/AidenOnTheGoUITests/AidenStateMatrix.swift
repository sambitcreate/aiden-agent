import XCTest

/// Launches the real app shell against the demo machines and captures screens.
///
/// A UI test cannot import the app, so this file knows the launch contract only
/// by name: `-AidenDemoScenario` (Debug builds), the
/// appearance keys the app reads from `UserDefaults`, and the system content size
/// override. Launch
/// arguments of the form `-key value` land in the app's argument domain, so the
/// app reads them like any stored preference and nothing is written to disk.
enum AidenStateMatrix {
    enum Scenario: String, CaseIterable {
        case one, four, empty, busy
        case offlineMix = "offline-mix"
        case oldHost = "old-host"
    }

    enum Appearance: String, CaseIterable {
        case light, dark
    }

    /// The content sizes the matrix covers. `UICTContentSizeCategory…` is the
    /// spelling `UIPreferredContentSizeCategoryName` expects.
    enum ContentSize: String, CaseIterable {
        case large = "UICTContentSizeCategoryL"
        case accessibilityExtraExtraExtraLarge = "UICTContentSizeCategoryAccessibilityXXXL"
        /// Whatever the simulator is set to, with no override. The audit's Dynamic
        /// Type checks change the size themselves, which an override would pin.
        case system = ""

        static var allCases: [Self] { [.large, .accessibilityExtraExtraExtraLarge] }

        var label: String {
            switch self {
            case .large: "large"
            case .accessibilityExtraExtraExtraLarge: "accessibilityExtraExtraExtraLarge"
            case .system: "system"
            }
        }
    }

    /// Launches the app. `theme` is a preset id (`aiden`, `slate`, ...) applied
    /// to both appearances; nil keeps the app default.
    static func launch(
        scenario: Scenario,
        appearance: Appearance = .light,
        contentSize: ContentSize = .large,
        theme: String? = nil,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var arguments = [
            "-AidenDemoScenario", scenario.rawValue,
            "-aiden.appearance.mode", appearance.rawValue,
            // The first-run tour is not what these tests are about.
            "-aiden.mobileOnboarding.v1.complete", "YES",
            // Every launch starts on the shell's default area with no chat open. The
            // app stores its navigation as Data, so a string here reads as "nothing
            // saved" and the stored value from an earlier launch is ignored.
            "-aiden.product-navigation.v1", "reset",
            "-aiden.product-navigation.v2", "reset",
            // Keep the simulator in the same language as the strings the tests look for.
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        if contentSize != .system {
            arguments += ["-UIPreferredContentSizeCategoryName", contentSize.rawValue]
        }
        if let theme {
            arguments += ["-aiden.appearance.lightPreset", theme, "-aiden.appearance.darkPreset", theme]
        }
        app.launchArguments = arguments + extraArguments
        app.launch()
        return app
    }

    /// What shows once the first screen is up.
    static func firstScreen(in app: XCUIApplication) -> XCUIElement {
        tab("Inbox", in: app)
    }

    /// A tab, in a bottom bar or a sidebar.
    static func tab(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let inBar = app.tabBars.buttons[title].firstMatch
        if inBar.exists { return inBar }
        let inSidebar = sidebarRow(title, in: app)
        return inSidebar.exists ? inSidebar : app.buttons[title].firstMatch
    }

    /// A tab's row in the list a regular-width window shows the tabs in.
    static func sidebarRow(_ title: String, in app: XCUIApplication) -> XCUIElement {
        // A row with a badge reads "Inbox, 3".
        app.cells.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", title, "\(title), ")).firstMatch
    }

    /// The window the app draws in. An iPad's first window can keep the size the
    /// scene started at, so it says nothing about the size on screen.
    static func window(of app: XCUIApplication) -> XCUIElement {
        app.windows.allElementsBoundByIndex.last ?? app.windows.firstMatch
    }

    /// Taps beside an open popover, inside the window.
    static func tapOutsidePopover(in app: XCUIApplication) {
        window(of: app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)).tap()
    }

    /// Drags a bottom corner of the window to `x`, as a person resizes one.
    private static func dragCorner(of app: XCUIApplication, left: Bool, toX x: CGFloat) {
        let frame = window(of: app).frame
        let screen = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            .coordinate(withNormalizedOffset: .zero)
        let y = frame.maxY - 6
        let corner = screen.withOffset(CGVector(dx: left ? frame.minX + 6 : frame.maxX - 6, dy: y))
        corner.press(forDuration: 0.6, thenDragTo: screen.withOffset(CGVector(dx: x, dy: y)))
        Thread.sleep(forTimeInterval: 2)
    }

    /// Makes the window narrow enough for compact width. Skips when it can't, so a
    /// simulator without resizable windows says so instead of passing. The system
    /// keeps a window's size between launches.
    static func narrowTheWindow(of app: XCUIApplication) throws {
        guard window(of: app).frame.width > compactWidth else { return }
        dragCorner(of: app, left: false, toX: window(of: app).frame.minX + 320)
        guard window(of: app).frame.width <= compactWidth else {
            throw XCTSkip("This simulator's windows do not resize")
        }
    }

    /// Makes the window wide enough for regular width, the other way round.
    static func widenTheWindow(of app: XCUIApplication) throws {
        let screenWidth = XCUIApplication(bundleIdentifier: "com.apple.springboard").frame.width
        if window(of: app).frame.width <= compactWidth {
            dragCorner(of: app, left: false, toX: screenWidth - 1)
        }
        if window(of: app).frame.width < screenWidth - 1 {
            dragCorner(of: app, left: true, toX: 1)
        }
        if window(of: app).frame.width < screenWidth - 1 {
            dragCorner(of: app, left: false, toX: screenWidth - 1)
        }
        guard window(of: app).frame.width > compactWidth else {
            throw XCTSkip("This simulator's windows do not resize")
        }
    }

    static let compactWidth: CGFloat = 500

    /// The running chats, above the tab bar or as the Inbox's first row.
    static func runningAccessory(in app: XCUIApplication) -> XCUIElement {
        app.buttons["aiden.running-accessory"].firstMatch
    }

    static func catchUpRow(in app: XCUIApplication) -> XCUIElement {
        app.buttons["aiden.catch-up"].firstMatch
    }

    /// The Search tab folds the tab bar away while its field is up, and Close
    /// brings it back.
    static func leaveSearch(in app: XCUIApplication) {
        guard app.searchFields.firstMatch.exists else { return }
        let close = app.buttons["Close"].firstMatch
        if close.exists { close.tap() }
    }

    /// Switches to a tab.
    static func openArea(_ title: String, in app: XCUIApplication) {
        leaveSearch(in: app)
        let tab = tab(title, in: app)
        if tab.waitForExistence(timeout: 10) { tab.tap() }
    }

    /// Attaches a screenshot of the whole screen. It stays in the `.xcresult`
    /// whether the test passes or fails.
    static func capture(_ name: String, in testCase: XCTestCase) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        testCase.add(attachment)
    }
}
