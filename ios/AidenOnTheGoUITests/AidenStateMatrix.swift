import XCTest

/// Launches the real app shell against the demo machines and captures screens.
///
/// A UI test cannot import the app, so this file knows the launch contract only
/// by name: `-AidenDemoScenario` (Debug builds), the appearance keys the app
/// reads from `UserDefaults`, and the system content size override. Launch
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

        var label: String {
            switch self {
            case .large: "large"
            case .accessibilityExtraExtraExtraLarge: "accessibilityExtraExtraExtraLarge"
            }
        }
    }

    /// Launches the app. `theme` is a preset id (`aiden`, `slate`, ...) applied
    /// to both appearances; nil keeps the app default.
    static func launch(
        scenario: Scenario,
        appearance: Appearance = .light,
        contentSize: ContentSize = .large,
        theme: String? = nil
    ) -> XCUIApplication {
        let app = XCUIApplication()
        var arguments = [
            "-AidenDemoScenario", scenario.rawValue,
            "-aiden.appearance.mode", appearance.rawValue,
            "-UIPreferredContentSizeCategoryName", contentSize.rawValue,
            // The first-run tour is not what these tests are about.
            "-aiden.mobileOnboarding.v1.complete", "YES",
            // Every launch starts on the shell's default area with no chat open. The
            // app stores its navigation as Data, so a string here reads as "nothing
            // saved" and the stored value from an earlier launch is ignored.
            "-aiden.product-navigation.v1", "reset",
            // Keep the simulator in the same language as the strings the tests look for.
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        if let theme {
            arguments += ["-aiden.appearance.lightPreset", theme, "-aiden.appearance.darkPreset", theme]
        }
        app.launchArguments = arguments
        app.launch()
        return app
    }

    /// The Aiden menu button every connected screen of the current shell shows.
    /// Its label names the area, so it doubles as "the first screen is up".
    static func areaSwitcher(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Aiden. Current area:")).firstMatch
    }

    /// Closes the one-time "Bots or Workspaces" tip when it is showing.
    static func dismissTipIfPresent(in app: XCUIApplication) {
        let gotIt = app.buttons["Got it"]
        if gotIt.waitForExistence(timeout: 2) { gotIt.tap() }
    }

    /// Switches to an area through the Aiden menu (`Bots` or `Workspaces`).
    static func openArea(_ title: String, in app: XCUIApplication) {
        dismissTipIfPresent(in: app)
        let switcher = areaSwitcher(in: app)
        guard switcher.waitForExistence(timeout: 10) else { return }
        if switcher.label.hasSuffix(title) { return }
        switcher.tap()
        // The menu is a collection of buttons. The other shell can hold a
        // button with the same label, so take the one that is on top.
        let entry = app.collectionViews.buttons[title].firstMatch
        if entry.waitForExistence(timeout: 5) { entry.tap() }
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
