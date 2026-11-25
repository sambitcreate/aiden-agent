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
        /// Every screen has data: two Bots (one running), an archived
        /// workspace, usage, scheduled tasks, Bot memory and git.
        case full
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
    /// to both appearances; nil keeps the app default. `startingTab` is the
    /// tab's saved name (`chats`, `inbox`, `bots`, `workspaces`); nil starts
    /// where a first launch does.
    static func launch(
        scenario: Scenario,
        appearance: Appearance = .light,
        contentSize: ContentSize = .large,
        theme: String? = nil,
        startingTab: String? = "inbox",
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var arguments = [
            "-AidenDemoScenario", scenario.rawValue,
            "-aiden.appearance.mode", appearance.rawValue,
            // Every launch starts on the shell's default area with no chat open. The
            // app stores its navigation as Data, so a string here reads as "nothing
            // saved" and the stored value from an earlier launch is ignored.
            "-aiden.product-navigation.v1", "reset",
            "-aiden.product-navigation.v2", "reset",
            "-aiden.product-navigation.v3", navigationArgument(startingTab: startingTab),
            // No drawer pins left from an earlier launch: the store reads Data.
            "-aiden.drawer-pins.v1", "reset",
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
        // The ambient background stays off unless a test turns it on, so
        // screenshots and element queries are not affected by its motion.
        if !extraArguments.contains("-aiden.appearance.aurora") {
            arguments += ["-aiden.appearance.aurora", "off"]
        }
        app.launchArguments = arguments + extraArguments
        app.launch()
        return app
    }

    /// The saved navigation a launch starts from: only a tab, no chat open.
    /// Data in a launch argument is written `<hex>`; nil reads as nothing
    /// saved, as on a first launch.
    static func navigationArgument(startingTab: String?) -> String {
        guard let startingTab else { return "reset" }
        let json = Data("{\"tab\":\"\(startingTab)\"}".utf8)
        return "<" + json.map { String(format: "%02x", $0) }.joined() + ">"
    }

    /// What shows once the first screen is up.
    static func firstScreen(in app: XCUIApplication) -> XCUIElement {
        tab("Inbox", in: app)
    }

    /// Chats' root: Home's own header at compact width, where the navigation
    /// bar is hidden, or the Chats list's navigation bar beside the list.
    static func homeRoot(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(
            format: "identifier == %@ OR (elementType == %d AND identifier == %@)",
            "aiden.home.menu", XCUIElement.ElementType.navigationBar.rawValue, "Chats"
        )).firstMatch
    }

    /// What shows at a tab's root: Home's header for Chats, else the tab's
    /// navigation bar.
    static func tabRoot(_ title: String, in app: XCUIApplication) -> XCUIElement {
        title == "Chats" ? homeRoot(in: app) : app.navigationBars[title]
    }

    /// The compact-width dock Aiden draws in place of the system tab bar.
    static func dock(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["aiden.dock"].firstMatch
    }

    /// A tab in the dock, by its name. Found by identifier, since the Inbox's
    /// name carries how many chats need the person ("Inbox, 3 chats need you").
    static func dockTab(_ title: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons["aiden.dock.\(title.lowercased())"].firstMatch
    }

    /// The tabs' bar along the bottom: the dock at compact width, else
    /// whatever system tab bar there is.
    static func bottomTabs(in app: XCUIApplication) -> XCUIElement {
        let dock = dock(in: app)
        return dock.exists ? dock : app.tabBars.firstMatch
    }

    /// A tab, in the dock, a system bottom bar or a sidebar. Before any of
    /// them shows, a button that will be the tab once it does.
    static func tab(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let inDock = dockTab(title, in: app)
        if inDock.exists { return inDock }
        let inBar = app.tabBars.buttons[title].firstMatch
        if inBar.exists { return inBar }
        let inSidebar = sidebarRow(title, in: app)
        if inSidebar.exists { return inSidebar }
        return app.buttons.matching(NSPredicate(
            format: "identifier == %@ OR label == %@", "aiden.dock.\(title.lowercased())", title
        )).firstMatch
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

    /// The drawer's search field. Only the drawer has one.
    static func drawerSearchField(in app: XCUIApplication) -> XCUIElement {
        app.textFields["Search chats and Bots"].firstMatch
    }

    /// Opens the drawer from the showing tab's menu button, which sits in the
    /// list's bar. A chat chosen in a list laid over the detail (an iPad in
    /// portrait) put the list away, and the detail's column toggle brings it
    /// back. An open sidebar over the page takes the first tap, so a tap that
    /// doesn't open the drawer is tried once more.
    @discardableResult
    static func openDrawer(in app: XCUIApplication) -> Bool {
        let close = app.buttons["Close menu"].firstMatch
        if close.exists { return true }
        let menu = app.buttons["Open menu"].firstMatch
        let showList = app.buttons["Show Sidebar"].firstMatch
        if !menu.waitForExistence(timeout: 3), showList.exists { showList.tap() }
        guard menu.waitForExistence(timeout: 10) else { return false }
        for _ in 0..<2 {
            menu.tap()
            if close.waitForExistence(timeout: 2) { return true }
        }
        return close.exists
    }

    /// Closes the drawer if it's open.
    static func closeDrawer(in app: XCUIApplication) {
        let close = app.buttons["Close menu"].firstMatch
        guard close.exists else { return }
        close.tap()
        _ = close.waitForNonExistence(timeout: 3)
    }

    /// Switches to a tab.
    static func openArea(_ title: String, in app: XCUIApplication) {
        closeDrawer(in: app)
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
