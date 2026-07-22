use std::convert::TryFrom;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Fixed per-message header. The physical WebSocket identifies the logical lane and already carries
/// the message length, so neither is duplicated here.
///
/// Layout (network byte order): `version:u8, kind:u8, flags:u16, stream:u32, offset:u64`.
pub const BINARY_HEADER_LEN: usize = 16;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, Ord, PartialOrd,
)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
pub enum LogicalChannel {
    Control = 0,
    Interactive = 1,
}

impl LogicalChannel {
    pub const fn accepts_binary(self) -> bool {
        matches!(self, Self::Interactive)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
pub enum BinaryKind {
    TerminalOutput = 1,
    TerminalInput = 2,
    TerminalSnapshot = 3,
}

impl BinaryKind {
    pub const fn max_payload_bytes(self) -> usize {
        match self {
            Self::TerminalOutput | Self::TerminalInput => 32 * 1024,
            Self::TerminalSnapshot => 256 * 1024,
        }
    }
}

impl TryFrom<u8> for BinaryKind {
    type Error = BinaryDecodeError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::TerminalOutput),
            2 => Ok(Self::TerminalInput),
            3 => Ok(Self::TerminalSnapshot),
            other => Err(BinaryDecodeError::UnknownKind(other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinaryFrameHeader {
    pub version: u8,
    pub kind: BinaryKind,
    pub flags: u16,
    pub stream_id: u32,
    pub sequence: u64,
}

impl BinaryFrameHeader {
    pub const FLAG_END_OF_STREAM: u16 = 1 << 0;
    pub const FLAG_REPLAY: u16 = 1 << 1;
    pub const KNOWN_FLAGS: u16 = Self::FLAG_END_OF_STREAM | Self::FLAG_REPLAY;

    pub fn encode(self) -> [u8; BINARY_HEADER_LEN] {
        let mut out = [0_u8; BINARY_HEADER_LEN];
        out[0] = self.version;
        out[1] = self.kind as u8;
        out[2..4].copy_from_slice(&self.flags.to_be_bytes());
        out[4..8].copy_from_slice(&self.stream_id.to_be_bytes());
        out[8..16].copy_from_slice(&self.sequence.to_be_bytes());
        out
    }

    pub fn decode(channel: LogicalChannel, bytes: &[u8]) -> Result<Self, BinaryDecodeError> {
        if bytes.len() < BINARY_HEADER_LEN {
            return Err(BinaryDecodeError::TruncatedHeader(bytes.len()));
        }
        if !channel.accepts_binary() {
            return Err(BinaryDecodeError::BinaryOnControlLane);
        }
        let version = bytes[0];
        if version != crate::PROTOCOL_VERSION {
            return Err(BinaryDecodeError::UnsupportedVersion(version));
        }
        let kind = BinaryKind::try_from(bytes[1])?;
        let flags = u16::from_be_bytes(bytes[2..4].try_into().expect("fixed slice"));
        if flags & !Self::KNOWN_FLAGS != 0 {
            return Err(BinaryDecodeError::UnknownFlags(flags));
        }
        let stream_id = u32::from_be_bytes(bytes[4..8].try_into().expect("fixed slice"));
        let sequence = u64::from_be_bytes(bytes[8..16].try_into().expect("fixed slice"));
        Ok(Self {
            version,
            kind,
            flags,
            stream_id,
            sequence,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryFrame {
    pub header: BinaryFrameHeader,
    pub payload: Vec<u8>,
}

impl BinaryFrame {
    pub fn new(
        kind: BinaryKind,
        stream_id: u32,
        sequence: u64,
        flags: u16,
        payload: Vec<u8>,
    ) -> Result<Self, BinaryDecodeError> {
        if payload.len() > kind.max_payload_bytes() {
            return Err(BinaryDecodeError::PayloadTooLarge {
                actual: payload.len(),
                max: kind.max_payload_bytes(),
            });
        }
        if flags & !BinaryFrameHeader::KNOWN_FLAGS != 0 {
            return Err(BinaryDecodeError::UnknownFlags(flags));
        }
        Ok(Self {
            header: BinaryFrameHeader {
                version: crate::PROTOCOL_VERSION,
                kind,
                flags,
                stream_id,
                sequence,
            },
            payload,
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(BINARY_HEADER_LEN + self.payload.len());
        out.extend_from_slice(&self.header.encode());
        out.extend_from_slice(&self.payload);
        out
    }

    pub fn decode(channel: LogicalChannel, bytes: &[u8]) -> Result<Self, BinaryDecodeError> {
        let header = BinaryFrameHeader::decode(channel, bytes)?;
        let actual = bytes.len() - BINARY_HEADER_LEN;
        if actual > header.kind.max_payload_bytes() {
            return Err(BinaryDecodeError::PayloadTooLarge {
                actual,
                max: header.kind.max_payload_bytes(),
            });
        }
        Ok(Self {
            header,
            payload: bytes[BINARY_HEADER_LEN..].to_vec(),
        })
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BinaryDecodeError {
    #[error("binary frame header is truncated: {0} bytes")]
    TruncatedHeader(usize),
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u8),
    #[error("unknown binary frame kind {0}")]
    UnknownKind(u8),
    #[error("binary frames are forbidden on the control lane")]
    BinaryOnControlLane,
    #[error("unknown binary frame flags {0:#06x}")]
    UnknownFlags(u16),
    #[error("payload is too large: {actual} bytes (max {max})")]
    PayloadTooLarge { actual: usize, max: usize },
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn terminal_bytes_round_trip_without_utf8_or_base64() {
        let payload = vec![0, 0x1b, b'[', b'2', b'J', 0xff, 0x80, 0];
        let frame = BinaryFrame::new(BinaryKind::TerminalOutput, 42, 9, 0, payload.clone())
            .expect("valid frame");
        let decoded = BinaryFrame::decode(LogicalChannel::Interactive, &frame.encode())
            .expect("decode frame");
        assert_eq!(decoded.payload, payload);
        assert_eq!(decoded.header.sequence, 9);
    }

    #[test]
    fn binary_data_on_control_lane_is_rejected() {
        let frame = BinaryFrame::new(BinaryKind::TerminalOutput, 1, 1, 0, vec![1, 2, 3])
            .expect("valid frame");
        assert!(matches!(
            BinaryFrame::decode(LogicalChannel::Control, &frame.encode()),
            Err(BinaryDecodeError::BinaryOnControlLane)
        ));
    }

    #[test]
    fn unknown_flags_are_rejected() {
        assert!(matches!(
            BinaryFrame::new(BinaryKind::TerminalInput, 1, 1, 0x8000, vec![]),
            Err(BinaryDecodeError::UnknownFlags(0x8000))
        ));
    }

    #[test]
    fn kind_specific_payload_limit_is_enforced() {
        let oversized = vec![0_u8; BinaryKind::TerminalOutput.max_payload_bytes() + 1];
        assert!(matches!(
            BinaryFrame::new(BinaryKind::TerminalOutput, 1, 0, 0, oversized),
            Err(BinaryDecodeError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn wire_encoding_matches_cross_language_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/v1-conformance.json"))
                .expect("valid conformance fixture");
        let expected = fixture["binary_cases"][0]["encoded_hex"]
            .as_str()
            .expect("encoded hex");
        let frame = BinaryFrame::new(
            BinaryKind::TerminalOutput,
            0x0102_0304,
            0x0102_0304_0506_0708,
            BinaryFrameHeader::FLAG_REPLAY,
            vec![0x00, 0x1b, 0xff],
        )
        .expect("valid frame");
        use std::fmt::Write as _;

        let encoded = frame.encode();
        let mut actual = String::with_capacity(encoded.len() * 2);
        for byte in encoded {
            write!(&mut actual, "{byte:02x}").expect("writing to a string cannot fail");
        }
        assert_eq!(actual, expected);
    }

    proptest! {
        #[test]
        fn arbitrary_interactive_payload_round_trips(
            payload in proptest::collection::vec(
                any::<u8>(),
                0..=BinaryKind::TerminalOutput.max_payload_bytes(),
            ),
            stream_id in any::<u32>(),
            sequence in any::<u64>(),
        ) {
            let frame = BinaryFrame::new(
                BinaryKind::TerminalOutput,
                stream_id,
                sequence,
                0,
                payload.clone(),
            ).expect("within channel limit");
            let decoded = BinaryFrame::decode(LogicalChannel::Interactive, &frame.encode())
                .expect("decode");
            prop_assert_eq!(decoded.payload, payload);
            prop_assert_eq!(decoded.header.stream_id, stream_id);
            prop_assert_eq!(decoded.header.sequence, sequence);
        }
    }
}
