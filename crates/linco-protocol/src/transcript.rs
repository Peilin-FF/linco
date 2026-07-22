use thiserror::Error;
use uuid::Uuid;

use crate::LogicalChannel;

pub const PAIRING_SECRET_BYTES: usize = 32;
pub const PAIRING_CLIENT_NONCE_BYTES: usize = 32;
pub const PAIRING_CHALLENGE_BYTES: usize = 32;
pub const PAIRING_DEVICE_PUBLIC_KEY_BYTES: usize = 65;
pub const SERVER_IDENTITY_PUBLIC_KEY_BYTES: usize = 32;
pub const AUTH_CLIENT_NONCE_BYTES: usize = 32;
pub const AUTH_CHALLENGE_BYTES: usize = 32;
pub const SERVER_HELLO_SIGNATURE_BYTES: usize = 64;

const PAIRING_DOMAIN: &[u8; 14] = b"linco-pair-v1\0";
const AUTH_DOMAIN: &[u8; 14] = b"linco-auth-v1\0";
const SERVER_HELLO_DOMAIN: &[u8; 22] = b"linco-server-hello-v1\0";
const PAIRING_TRANSCRIPT_BYTES: usize = PAIRING_DOMAIN.len()
    + 16
    + PAIRING_CLIENT_NONCE_BYTES
    + PAIRING_CHALLENGE_BYTES
    + PAIRING_DEVICE_PUBLIC_KEY_BYTES
    + SERVER_IDENTITY_PUBLIC_KEY_BYTES;

/// Produces the exact bytes signed by a device and authenticated with the one-time pairing secret.
/// Every variable is fixed-width to make the transcript identical across Rust and Swift without
/// relying on JSON canonicalization or locale-sensitive string formatting.
pub fn pairing_transcript(
    pairing_id: Uuid,
    client_nonce: &[u8],
    challenge: &[u8],
    device_public_key: &[u8],
    server_identity: &[u8],
) -> Result<Vec<u8>, TranscriptError> {
    require_len("client_nonce", client_nonce, PAIRING_CLIENT_NONCE_BYTES)?;
    require_len("challenge", challenge, PAIRING_CHALLENGE_BYTES)?;
    require_len(
        "device_public_key",
        device_public_key,
        PAIRING_DEVICE_PUBLIC_KEY_BYTES,
    )?;
    require_len(
        "server_identity",
        server_identity,
        SERVER_IDENTITY_PUBLIC_KEY_BYTES,
    )?;

    let mut transcript = Vec::with_capacity(PAIRING_TRANSCRIPT_BYTES);
    transcript.extend_from_slice(PAIRING_DOMAIN);
    transcript.extend_from_slice(pairing_id.as_bytes());
    transcript.extend_from_slice(client_nonce);
    transcript.extend_from_slice(challenge);
    transcript.extend_from_slice(device_public_key);
    transcript.extend_from_slice(server_identity);
    debug_assert_eq!(transcript.len(), PAIRING_TRANSCRIPT_BYTES);
    Ok(transcript)
}

/// Binds ongoing device authentication to one daemon identity, epoch and connection. A captured
/// signature cannot be replayed after a daemon restart or against another paired server.
pub fn authentication_transcript(
    connection_id: Uuid,
    device_id: Uuid,
    server_epoch: Uuid,
    client_nonce: &[u8],
    challenge: &[u8],
    server_identity: &[u8],
) -> Result<Vec<u8>, TranscriptError> {
    require_len("client_nonce", client_nonce, AUTH_CLIENT_NONCE_BYTES)?;
    require_len("challenge", challenge, AUTH_CHALLENGE_BYTES)?;
    require_len(
        "server_identity",
        server_identity,
        SERVER_IDENTITY_PUBLIC_KEY_BYTES,
    )?;

    let mut transcript = Vec::with_capacity(
        AUTH_DOMAIN.len()
            + 16
            + 16
            + 16
            + AUTH_CLIENT_NONCE_BYTES
            + AUTH_CHALLENGE_BYTES
            + SERVER_IDENTITY_PUBLIC_KEY_BYTES,
    );
    transcript.extend_from_slice(AUTH_DOMAIN);
    transcript.extend_from_slice(connection_id.as_bytes());
    transcript.extend_from_slice(device_id.as_bytes());
    transcript.extend_from_slice(server_epoch.as_bytes());
    transcript.extend_from_slice(client_nonce);
    transcript.extend_from_slice(challenge);
    transcript.extend_from_slice(server_identity);
    Ok(transcript)
}

/// Transcript signed by the daemon's long-lived Ed25519 identity before the client reveals a
/// pairing proof or device signature.
pub fn server_hello_transcript(
    protocol_version: u8,
    lane: LogicalChannel,
    connection_id: Uuid,
    server_epoch: Uuid,
    client_nonce: &[u8],
    challenge: &[u8],
    server_identity: &[u8],
) -> Result<Vec<u8>, TranscriptError> {
    require_len("client_nonce", client_nonce, AUTH_CLIENT_NONCE_BYTES)?;
    require_len("challenge", challenge, AUTH_CHALLENGE_BYTES)?;
    require_len(
        "server_identity",
        server_identity,
        SERVER_IDENTITY_PUBLIC_KEY_BYTES,
    )?;

    let mut transcript = Vec::with_capacity(
        SERVER_HELLO_DOMAIN.len()
            + 2
            + 16
            + 16
            + AUTH_CLIENT_NONCE_BYTES
            + AUTH_CHALLENGE_BYTES
            + SERVER_IDENTITY_PUBLIC_KEY_BYTES,
    );
    transcript.extend_from_slice(SERVER_HELLO_DOMAIN);
    transcript.push(protocol_version);
    transcript.push(lane as u8);
    transcript.extend_from_slice(connection_id.as_bytes());
    transcript.extend_from_slice(server_epoch.as_bytes());
    transcript.extend_from_slice(client_nonce);
    transcript.extend_from_slice(challenge);
    transcript.extend_from_slice(server_identity);
    Ok(transcript)
}

fn require_len(field: &'static str, bytes: &[u8], expected: usize) -> Result<(), TranscriptError> {
    if bytes.len() == expected {
        Ok(())
    } else {
        Err(TranscriptError::InvalidLength {
            field,
            expected,
            actual: bytes.len(),
        })
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TranscriptError {
    #[error("{field} has {actual} bytes; expected {expected}")]
    InvalidLength {
        field: &'static str,
        expected: usize,
        actual: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_transcript_has_stable_layout() {
        let id = Uuid::parse_str("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let transcript = pairing_transcript(
            id,
            &[0x11; PAIRING_CLIENT_NONCE_BYTES],
            &[0x22; PAIRING_CHALLENGE_BYTES],
            &[0x04; PAIRING_DEVICE_PUBLIC_KEY_BYTES],
            &[0x44; SERVER_IDENTITY_PUBLIC_KEY_BYTES],
        )
        .unwrap();

        assert_eq!(transcript.len(), PAIRING_TRANSCRIPT_BYTES);
        assert_eq!(&transcript[..PAIRING_DOMAIN.len()], PAIRING_DOMAIN);
        assert_eq!(
            &transcript[PAIRING_DOMAIN.len()..PAIRING_DOMAIN.len() + 16],
            id.as_bytes()
        );
        assert_eq!(transcript[PAIRING_DOMAIN.len() + 16], 0x11);
        assert_eq!(transcript.last(), Some(&0x44));
    }

    #[test]
    fn pairing_transcript_rejects_noncanonical_lengths() {
        let error = pairing_transcript(
            Uuid::nil(),
            &[0; PAIRING_CLIENT_NONCE_BYTES - 1],
            &[0; PAIRING_CHALLENGE_BYTES],
            &[0; PAIRING_DEVICE_PUBLIC_KEY_BYTES],
            &[0; SERVER_IDENTITY_PUBLIC_KEY_BYTES],
        )
        .unwrap_err();
        assert_eq!(
            error,
            TranscriptError::InvalidLength {
                field: "client_nonce",
                expected: PAIRING_CLIENT_NONCE_BYTES,
                actual: PAIRING_CLIENT_NONCE_BYTES - 1,
            }
        );
    }

    #[test]
    fn authentication_transcript_binds_device_server_and_epoch() {
        let connection = Uuid::new_v4();
        let device = Uuid::new_v4();
        let epoch = Uuid::new_v4();
        let base = authentication_transcript(
            connection,
            device,
            epoch,
            &[1; AUTH_CLIENT_NONCE_BYTES],
            &[2; AUTH_CHALLENGE_BYTES],
            &[3; SERVER_IDENTITY_PUBLIC_KEY_BYTES],
        )
        .unwrap();
        let other_epoch = authentication_transcript(
            connection,
            device,
            Uuid::new_v4(),
            &[1; AUTH_CLIENT_NONCE_BYTES],
            &[2; AUTH_CHALLENGE_BYTES],
            &[3; SERVER_IDENTITY_PUBLIC_KEY_BYTES],
        )
        .unwrap();
        assert_ne!(base, other_epoch);
        assert_eq!(&base[..AUTH_DOMAIN.len()], AUTH_DOMAIN);
    }

    #[test]
    fn server_hello_transcript_binds_every_handshake_nonce() {
        let connection = Uuid::new_v4();
        let epoch = Uuid::new_v4();
        let base = server_hello_transcript(
            1,
            LogicalChannel::Control,
            connection,
            epoch,
            &[1; AUTH_CLIENT_NONCE_BYTES],
            &[2; AUTH_CHALLENGE_BYTES],
            &[3; SERVER_IDENTITY_PUBLIC_KEY_BYTES],
        )
        .unwrap();
        let changed = server_hello_transcript(
            1,
            LogicalChannel::Control,
            connection,
            epoch,
            &[9; AUTH_CLIENT_NONCE_BYTES],
            &[2; AUTH_CHALLENGE_BYTES],
            &[3; SERVER_IDENTITY_PUBLIC_KEY_BYTES],
        )
        .unwrap();
        assert_ne!(base, changed);
        assert_eq!(&base[..SERVER_HELLO_DOMAIN.len()], SERVER_HELLO_DOMAIN);
        assert_eq!(base[SERVER_HELLO_DOMAIN.len()], 1);
        assert_eq!(base[SERVER_HELLO_DOMAIN.len() + 1], 0);
    }
}
