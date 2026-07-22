import XCTest
@testable import Linco

final class AsyncTimeoutTests: XCTestCase {
    actor Probe {
        var operationWasCancelled = false
        var timeoutActionRan = false

        func markCancelled() { operationWasCancelled = true }
        func markTimedOut() { timeoutActionRan = true }
    }

    func testTimeoutRunsCleanupAndCancelsOperation() async {
        let probe = Probe()

        do {
            _ = try await withLincoTimeout(.milliseconds(20), onTimeout: {
                await probe.markTimedOut()
            }) {
                do {
                    try await Task.sleep(for: .seconds(10))
                    return 1
                } catch is CancellationError {
                    await probe.markCancelled()
                    throw CancellationError()
                }
            }
            XCTFail("expected timeout")
        } catch {
            XCTAssertEqual(error as? NetworkTimeoutError, .timedOut)
        }

        let timeoutActionRan = await probe.timeoutActionRan
        let operationWasCancelled = await probe.operationWasCancelled
        XCTAssertTrue(timeoutActionRan)
        XCTAssertTrue(operationWasCancelled)
    }
}
