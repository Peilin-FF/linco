# Linco protocol v1

Linco uses two authenticated WebSocket connections per device:

- `control`: JSON RPC, pairing, cancellation, heartbeat and recovery metadata.
- `interactive`: uncompressed binary terminal input/output only.

Files and preview assets travel over authenticated HTTPS with `Range`, `ETag` and conditional
requests. This prevents a large transfer from blocking a keystroke behind the same TCP stream.

Every interactive frame starts with a 16-byte, network-byte-order header:

```text
version:u8 | kind:u8 | flags:u16 | stream_id:u32 | sequence_or_offset:u64
```

The payload follows unchanged. Terminal payloads are limited to 32 KiB and control messages to
64 KiB. Mutating RPC methods require an idempotency key; a daemon restart may produce an
`ambiguous` result, but the server must never silently repeat terminal input, session creation or
filesystem mutations.

`fixtures/v1-conformance.json` is language-neutral test data shared with native clients. Any wire
change requires a new protocol version or a backward-compatible optional field.

The v1 RPC surface is intentionally small: system/workspace discovery, terminal session
lifecycle (including explicit stream detachment), paginated file listing, capability-based file
read/write, and preview resolution.
Every request and response has a typed Rust DTO exported by `linco-protocol`; native clients must
consume the same fixture in CI. File-list responses use an opaque `next_cursor` and are additionally
bounded by encoded control-frame bytes on the server.

Pairing signs and HMACs one fixed-width transcript:

```text
"linco-pair-v1\0" (14) | pairing UUID (16) | client nonce (32) |
server challenge (32) | device P-256 X9.63 public key (65) |
server Ed25519 identity public key (32)
```

The HMAC is SHA-256 with the 32-byte one-time QR secret. The device signature is DER-encoded
ECDSA-P256. Implementations reject noncanonical field lengths before cryptographic verification.

Ongoing authentication signs another fixed-width transcript:

```text
"linco-auth-v1\0" (14) | connection UUID (16) | device UUID (16) |
server epoch UUID (16) | client nonce (32) | server challenge (32) |
server Ed25519 identity public key (32)
```

Before either client proof is sent, the daemon proves possession of that Ed25519 identity by
signing:

```text
"linco-server-hello-v1\0" (22) | protocol version (1) | lane (1) |
connection UUID (16) | server epoch UUID (16) | client nonce (32) |
server challenge (32) | server identity public key (32)
```
