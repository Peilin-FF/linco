import Foundation

public enum LogicalChannel: String, Sendable, Codable, CaseIterable {
    case control
    case interactive

    public var wireValue: UInt8 {
        switch self {
        case .control: 0
        case .interactive: 1
        }
    }
}

public enum BinaryKind: UInt8, Sendable, Codable, CaseIterable {
    case terminalOutput = 1
    case terminalInput = 2
    case terminalSnapshot = 3

    public var expectedChannel: LogicalChannel {
        .interactive
    }

    public var maximumPayloadBytes: Int {
        switch self {
        case .terminalInput, .terminalOutput:
            32 * 1_024
        case .terminalSnapshot:
            256 * 1_024
        }
    }
}

public struct BinaryFlags: OptionSet, Sendable, Equatable {
    public let rawValue: UInt16

    public init(rawValue: UInt16) {
        self.rawValue = rawValue
    }

    public static let endOfStream = BinaryFlags(rawValue: 1 << 0)
    public static let replay = BinaryFlags(rawValue: 1 << 1)
    public static let known: BinaryFlags = [.endOfStream, .replay]
}

public struct BinaryFrame: Sendable, Equatable {
    public static let protocolVersion: UInt8 = 1
    public static let headerLength = 16

    public let version: UInt8
    public let kind: BinaryKind
    public let flags: BinaryFlags
    public let streamID: UInt32
    public let sequence: UInt64
    public let payload: Data

    public init(
        kind: BinaryKind,
        flags: BinaryFlags = [],
        streamID: UInt32,
        sequence: UInt64,
        payload: Data
    ) throws {
        try Self.validate(kind: kind, flags: flags, payloadCount: payload.count)
        self.version = Self.protocolVersion
        self.kind = kind
        self.flags = flags
        self.streamID = streamID
        self.sequence = sequence
        self.payload = payload
    }

    public func encoded() -> Data {
        var data = Data(capacity: Self.headerLength + payload.count)
        data.append(version)
        data.append(kind.rawValue)
        data.appendBigEndian(flags.rawValue)
        data.appendBigEndian(streamID)
        data.appendBigEndian(sequence)
        data.append(payload)
        return data
    }

    public static func decode(_ data: Data, on channel: LogicalChannel) throws -> BinaryFrame {
        guard channel != .control else { throw BinaryProtocolError.binaryOnControlLane }
        guard data.count >= headerLength else {
            throw BinaryProtocolError.truncatedHeader(actualBytes: data.count)
        }

        let version = data[data.startIndex]
        guard version == protocolVersion else {
            throw BinaryProtocolError.unsupportedVersion(version)
        }
        guard let kind = BinaryKind(rawValue: data[data.startIndex + 1]) else {
            throw BinaryProtocolError.unknownKind(data[data.startIndex + 1])
        }
        guard kind.expectedChannel == channel else {
            throw BinaryProtocolError.channelKindMismatch(channel: channel, kind: kind)
        }

        let flagsRaw: UInt16 = data.readBigEndian(at: 2)
        let flags = BinaryFlags(rawValue: flagsRaw)
        guard flags.subtracting(.known).isEmpty else {
            throw BinaryProtocolError.unknownFlags(flagsRaw)
        }

        let streamID: UInt32 = data.readBigEndian(at: 4)
        let sequence: UInt64 = data.readBigEndian(at: 8)
        let payload = data.subdata(in: headerLength..<data.count)
        try validate(kind: kind, flags: flags, payloadCount: payload.count)

        return BinaryFrame(
            version: version,
            kind: kind,
            flags: flags,
            streamID: streamID,
            sequence: sequence,
            payload: payload
        )
    }

    private init(
        version: UInt8,
        kind: BinaryKind,
        flags: BinaryFlags,
        streamID: UInt32,
        sequence: UInt64,
        payload: Data
    ) {
        self.version = version
        self.kind = kind
        self.flags = flags
        self.streamID = streamID
        self.sequence = sequence
        self.payload = payload
    }

    private static func validate(kind: BinaryKind, flags: BinaryFlags, payloadCount: Int) throws {
        guard flags.subtracting(.known).isEmpty else {
            throw BinaryProtocolError.unknownFlags(flags.rawValue)
        }
        guard payloadCount <= kind.maximumPayloadBytes else {
            throw BinaryProtocolError.payloadTooLarge(actual: payloadCount, maximum: kind.maximumPayloadBytes)
        }
    }
}

public enum BinaryProtocolError: Error, Sendable, Equatable {
    case truncatedHeader(actualBytes: Int)
    case unsupportedVersion(UInt8)
    case unknownKind(UInt8)
    case binaryOnControlLane
    case unknownFlags(UInt16)
    case channelKindMismatch(channel: LogicalChannel, kind: BinaryKind)
    case payloadTooLarge(actual: Int, maximum: Int)
}

private extension Data {
    mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        var encoded = value.bigEndian
        Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
    }

    func readBigEndian<T: FixedWidthInteger>(at offset: Int) -> T {
        let width = MemoryLayout<T>.size
        return self[(startIndex + offset)..<(startIndex + offset + width)].reduce(T.zero) { result, byte in
            (result << 8) | T(byte)
        }
    }
}
