import Foundation
import LincoCore
import XCTest
@testable import Linco

final class HTTPCapabilityTests: XCTestCase {
    func testCapabilityStaysInAuthorizationHeader() throws {
        let value = JSONValue.object([
            "url": .string("https://server.example/v1/bulk"),
            "authorization_scheme": .string("LincoCapability"),
            "capability": .string("opaque-secret"),
            "expires_in_ms": .unsignedInteger(300_000)
        ])
        let capability = try HTTPCapability(response: value)

        XCTAssertNil(capability.url.query)
        XCTAssertEqual(capability.authorizationValue, "LincoCapability opaque-secret")
    }

    func testRejectsCapabilityInQueryString() {
        let value = JSONValue.object([
            "url": .string("https://server.example/v1/bulk?token=leak"),
            "authorization_scheme": .string("LincoCapability"),
            "capability": .string("opaque-secret"),
            "expires_in_ms": .unsignedInteger(300_000)
        ])
        XCTAssertThrowsError(try HTTPCapability(response: value))
    }

    func testBoundedAccumulatorRejectsBeforeAllocatingPastLimit() throws {
        var accumulator = BoundedDataAccumulator(maximumBytes: 3)
        try accumulator.append(Data([1, 2]))
        try accumulator.append(Data([3]))
        XCTAssertThrowsError(try accumulator.append(Data([4]))) { error in
            XCTAssertEqual(error as? HTTPTransferError, .downloadTooLarge)
        }
        XCTAssertEqual(accumulator.data.count, 3)
    }

    func testBoundedAccumulatorRejectsWholeOversizedChunkWithoutPartialAppend() throws {
        var accumulator = BoundedDataAccumulator(maximumBytes: 3)
        try accumulator.append(Data([1, 2]))

        XCTAssertThrowsError(try accumulator.append(Data([3, 4]))) { error in
            XCTAssertEqual(error as? HTTPTransferError, .downloadTooLarge)
        }
        XCTAssertEqual(accumulator.data, Data([1, 2]))
    }

    func testDownloadCancellationGatePreventsLateTaskStart() {
        var gate = DownloadCancellationGate()
        XCTAssertTrue(gate.allowsStart(taskIsCancelled: false))

        gate.cancel()

        XCTAssertFalse(gate.allowsStart(taskIsCancelled: false))
        XCTAssertFalse(gate.allowsStart(taskIsCancelled: true))
    }

    func testPreconditionFailureIsAnEditConflict() {
        XCTAssertThrowsError(try HTTPTransferClient.validateUploadStatus(412)) { error in
            XCTAssertEqual(error as? HTTPTransferError, .editConflict)
        }
    }

    func testOnlyStrongEntityTagsCanDriveConflictSafeWrites() {
        XCTAssertTrue(HTTPTransferClient.isStrongEntityTag("\"sha256-deadbeef\""))
        XCTAssertFalse(HTTPTransferClient.isStrongEntityTag("W/\"deadbeef\""))
        XCTAssertFalse(HTTPTransferClient.isStrongEntityTag("deadbeef"))
    }
}
