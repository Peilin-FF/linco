import XCTest

final class LincoSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAppLaunchesIntoAnActionableScreen() {
        let app = XCUIApplication()
        app.launch()

        let pairingButton = app.buttons["pair-server"]
        let newSessionButton = app.buttons["new-session"]
        XCTAssertTrue(pairingButton.waitForExistence(timeout: 5) || newSessionButton.waitForExistence(timeout: 1))
    }
}
