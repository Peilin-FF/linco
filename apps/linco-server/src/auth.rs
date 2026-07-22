use std::{path::PathBuf, sync::Arc, time::SystemTime};

use anyhow::{anyhow, bail, Context};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer as _, SigningKey as IdentitySigningKey};
use hmac::{Hmac, Mac};
use linco_protocol::{
    authentication_transcript, pairing_transcript, server_hello_transcript, KeyAlgorithm,
    LogicalChannel, PairingPayload, Permission, RpcMethod, ServerMessage, AUTH_CHALLENGE_BYTES,
    AUTH_CLIENT_NONCE_BYTES, PAIRING_CHALLENGE_BYTES, PAIRING_CLIENT_NONCE_BYTES,
    PAIRING_DEVICE_PUBLIC_KEY_BYTES, PAIRING_SECRET_BYTES, SERVER_IDENTITY_PUBLIC_KEY_BYTES,
};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use qrcode::{render::unicode, QrCode};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
type StoredDevice = (String, String, Vec<u8>, String, Option<i64>);
type StoredIdempotency = (String, Vec<u8>, String, Option<Vec<u8>>);
const IDEMPOTENCY_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone)]
pub struct AuthStore {
    path: Arc<PathBuf>,
}

pub type PairingBundle = PairingPayload;

#[derive(Debug, Clone)]
pub struct AuthenticatedDevice {
    pub id: Uuid,
    pub name: String,
    pub permissions: Vec<Permission>,
}

impl AuthenticatedDevice {
    pub fn permits(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }
}

#[derive(Debug, Clone)]
pub struct DeviceSummary {
    pub id: Uuid,
    pub name: String,
    pub permissions: Vec<String>,
    pub revoked: bool,
}

#[derive(Debug, Clone)]
pub enum IdempotencyBegin {
    Execute,
    Completed(ServerMessage),
    Ambiguous,
    Conflict,
}

#[derive(Debug, Clone)]
pub struct ServerHelloProof {
    pub identity_b64: String,
    pub signature_b64: String,
}

#[derive(Debug, Clone)]
pub struct PairingCandidate {
    pub pairing_id: Uuid,
    pub device_name: String,
    pub device_key_algorithm: KeyAlgorithm,
    pub device_public_key: Vec<u8>,
    pub client_nonce: Vec<u8>,
}

impl AuthStore {
    pub async fn open(path: PathBuf) -> anyhow::Result<Self> {
        let store = Self {
            path: Arc::new(path),
        };
        let cloned = store.clone();
        tokio::task::spawn_blocking(move || cloned.initialize_sync())
            .await
            .context("auth initialization task")??;
        Ok(store)
    }

    pub async fn server_identity_b64(&self) -> anyhow::Result<String> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.server_identity_sync())
            .await
            .context("read server identity task")?
    }

    pub async fn server_hello_proof(
        &self,
        protocol_version: u8,
        lane: LogicalChannel,
        connection_id: Uuid,
        server_epoch: Uuid,
        client_nonce: Vec<u8>,
        challenge: Vec<u8>,
    ) -> anyhow::Result<ServerHelloProof> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.server_hello_proof_sync(
                protocol_version,
                lane,
                connection_id,
                server_epoch,
                &client_nonce,
                &challenge,
            )
        })
        .await
        .context("server hello proof task")?
    }

    pub async fn create_pairing(
        &self,
        server_url: &str,
        ttl_seconds: u64,
    ) -> anyhow::Result<PairingBundle> {
        let this = self.clone();
        let server_url = server_url.to_owned();
        tokio::task::spawn_blocking(move || {
            this.create_pairing_sync(&server_url, ttl_seconds.clamp(30, 120))
        })
        .await
        .context("create pairing task")?
    }

    pub async fn check_pairing(&self, pairing_id: Uuid) -> anyhow::Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.check_pairing_sync(pairing_id))
            .await
            .context("check pairing task")?
    }

    pub async fn finish_pairing(
        &self,
        candidate: PairingCandidate,
        connection_id: Uuid,
        server_challenge: Vec<u8>,
        proof: Vec<u8>,
        device_signature: Vec<u8>,
    ) -> anyhow::Result<AuthenticatedDevice> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.finish_pairing_sync(
                candidate,
                connection_id,
                &server_challenge,
                &proof,
                &device_signature,
            )
        })
        .await
        .context("finish pairing task")?
    }

    pub async fn authenticate_device(
        &self,
        device_id: Uuid,
        connection_id: Uuid,
        server_epoch: Uuid,
        server_challenge: Vec<u8>,
        client_nonce: Vec<u8>,
        signature: Vec<u8>,
    ) -> anyhow::Result<AuthenticatedDevice> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.authenticate_device_sync(
                device_id,
                connection_id,
                server_epoch,
                &server_challenge,
                &client_nonce,
                &signature,
            )
        })
        .await
        .context("device authentication task")?
    }

    pub async fn list_devices(&self) -> anyhow::Result<Vec<DeviceSummary>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.list_devices_sync())
            .await
            .context("list devices task")?
    }

    pub async fn revoke_device(&self, id: Uuid) -> anyhow::Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.revoke_device_sync(id))
            .await
            .context("revoke device task")?
    }

    pub async fn device_is_active(&self, id: Uuid) -> anyhow::Result<bool> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.device_is_active_sync(id))
            .await
            .context("device authorization liveness task")?
    }

    pub async fn begin_idempotent(
        &self,
        device_id: Uuid,
        key: Uuid,
        method: RpcMethod,
        params_hash: [u8; 32],
    ) -> anyhow::Result<IdempotencyBegin> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.begin_idempotent_sync(device_id, key, method, params_hash)
        })
        .await
        .context("idempotency reservation task")?
    }

    pub async fn complete_idempotent(
        &self,
        device_id: Uuid,
        key: Uuid,
        method: RpcMethod,
        params_hash: [u8; 32],
        response: ServerMessage,
    ) -> anyhow::Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            this.complete_idempotent_sync(device_id, key, method, params_hash, response)
        })
        .await
        .context("idempotency completion task")?
    }

    fn initialize_sync(&self) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = self.connection()?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS meta (
               key TEXT PRIMARY KEY,
               value BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS devices (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               key_algorithm TEXT NOT NULL DEFAULT 'p256',
               public_key BLOB NOT NULL,
               permissions TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL,
               revoked_at_ms INTEGER
             );
             CREATE TABLE IF NOT EXISTS pairings (
               id TEXT PRIMARY KEY,
               secret BLOB NOT NULL,
               expires_at_ms INTEGER NOT NULL,
               consumed_at_ms INTEGER
             );
             CREATE TABLE IF NOT EXISTS idempotency (
               device_id TEXT NOT NULL,
               idempotency_key TEXT NOT NULL,
               method TEXT NOT NULL,
               params_hash BLOB NOT NULL,
               state TEXT NOT NULL CHECK(state IN ('pending', 'completed')),
               response_json BLOB,
               created_at_ms INTEGER NOT NULL,
               completed_at_ms INTEGER,
               PRIMARY KEY(device_id, idempotency_key)
             );
             CREATE INDEX IF NOT EXISTS idempotency_created_at
               ON idempotency(created_at_ms);
             CREATE INDEX IF NOT EXISTS idempotency_completed_at
               ON idempotency(completed_at_ms);",
        )?;
        prune_idempotency(&conn)?;

        let has_key_algorithm: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('devices') WHERE name='key_algorithm'",
            [],
            |row| row.get(0),
        )?;
        if has_key_algorithm == 0 {
            conn.execute(
                "ALTER TABLE devices ADD COLUMN key_algorithm TEXT NOT NULL DEFAULT 'p256'",
                [],
            )?;
        }

        let existing: Option<Vec<u8>> = conn
            .query_row(
                "SELECT value FROM meta WHERE key='server_signing_key'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_none() {
            let mut secret = [0_u8; 32];
            OsRng.fill_bytes(&mut secret);
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('server_signing_key', ?1)",
                params![secret.as_slice()],
            )?;
        }
        secure_file(&self.path)?;
        Ok(())
    }

    fn connection(&self) -> anyhow::Result<Connection> {
        let conn = Connection::open(self.path.as_ref())
            .with_context(|| format!("open auth database {}", self.path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(3))?;
        Ok(conn)
    }

    fn signing_key_sync(&self) -> anyhow::Result<IdentitySigningKey> {
        let conn = self.connection()?;
        let bytes: Vec<u8> = conn.query_row(
            "SELECT value FROM meta WHERE key='server_signing_key'",
            [],
            |row| row.get(0),
        )?;
        let key: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("stored server signing key has invalid length"))?;
        Ok(IdentitySigningKey::from_bytes(&key))
    }

    fn server_identity_sync(&self) -> anyhow::Result<String> {
        let key = self.signing_key_sync()?;
        Ok(URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()))
    }

    fn server_hello_proof_sync(
        &self,
        protocol_version: u8,
        lane: LogicalChannel,
        connection_id: Uuid,
        server_epoch: Uuid,
        client_nonce: &[u8],
        challenge: &[u8],
    ) -> anyhow::Result<ServerHelloProof> {
        let key = self.signing_key_sync()?;
        let identity = key.verifying_key().to_bytes();
        let transcript = server_hello_transcript(
            protocol_version,
            lane,
            connection_id,
            server_epoch,
            client_nonce,
            challenge,
            &identity,
        )?;
        let signature = key.sign(&transcript).to_bytes();
        Ok(ServerHelloProof {
            identity_b64: URL_SAFE_NO_PAD.encode(identity),
            signature_b64: URL_SAFE_NO_PAD.encode(signature),
        })
    }

    fn create_pairing_sync(
        &self,
        server_url: &str,
        ttl_seconds: u64,
    ) -> anyhow::Result<PairingBundle> {
        let conn = self.connection()?;
        let id = Uuid::new_v4();
        let mut secret = [0_u8; 32];
        OsRng.fill_bytes(&mut secret);
        let expires_at_ms = now_ms().saturating_add(ttl_seconds.saturating_mul(1000));
        conn.execute(
            "DELETE FROM pairings WHERE consumed_at_ms IS NOT NULL OR expires_at_ms < ?1",
            params![now_ms() as i64],
        )?;
        conn.execute(
            "INSERT INTO pairings(id, secret, expires_at_ms) VALUES(?1, ?2, ?3)",
            params![id.to_string(), secret.as_slice(), expires_at_ms as i64],
        )?;

        let server_identity_b64 = self.server_identity_sync()?;
        let identity = URL_SAFE_NO_PAD.decode(&server_identity_b64)?;
        let _digest = Sha256::digest(identity);
        Ok(PairingPayload {
            protocol_version: linco_protocol::PROTOCOL_VERSION,
            endpoint: server_url.to_owned(),
            server_identity_b64,
            pairing_id: id,
            pairing_secret_b64: URL_SAFE_NO_PAD.encode(secret),
            expires_at_ms,
        })
    }

    fn check_pairing_sync(&self, pairing_id: Uuid) -> anyhow::Result<()> {
        let conn = self.connection()?;
        let row: Option<(i64, Option<i64>)> = conn
            .query_row(
                "SELECT expires_at_ms, consumed_at_ms FROM pairings WHERE id=?1",
                params![pairing_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match row {
            Some((expires, None)) if expires >= now_ms() as i64 => Ok(()),
            Some((_, Some(_))) => bail!("pairing token has already been consumed"),
            Some(_) => bail!("pairing token has expired"),
            None => bail!("pairing token not found"),
        }
    }

    fn finish_pairing_sync(
        &self,
        candidate: PairingCandidate,
        _connection_id: Uuid,
        challenge: &[u8],
        proof: &[u8],
        signature: &[u8],
    ) -> anyhow::Result<AuthenticatedDevice> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(Vec<u8>, i64, Option<i64>)> = tx
            .query_row(
                "SELECT secret, expires_at_ms, consumed_at_ms FROM pairings WHERE id=?1",
                params![candidate.pairing_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (secret, expires_at_ms, consumed_at_ms) = row.context("pairing token not found")?;
        if consumed_at_ms.is_some() {
            bail!("pairing token has already been consumed");
        }
        if expires_at_ms < now_ms() as i64 {
            bail!("pairing token has expired");
        }
        if candidate.device_key_algorithm != KeyAlgorithm::P256 {
            bail!("unsupported device key algorithm");
        }
        require_exact("pairing secret", &secret, PAIRING_SECRET_BYTES)?;
        require_exact(
            "pairing client nonce",
            &candidate.client_nonce,
            PAIRING_CLIENT_NONCE_BYTES,
        )?;
        require_exact("pairing challenge", challenge, PAIRING_CHALLENGE_BYTES)?;
        require_exact(
            "device public key",
            &candidate.device_public_key,
            PAIRING_DEVICE_PUBLIC_KEY_BYTES,
        )?;
        require_exact("pairing proof", proof, PAIRING_SECRET_BYTES)?;

        let server_identity = self.signing_key_sync()?.verifying_key().to_bytes();
        let transcript = pairing_transcript(
            candidate.pairing_id,
            &candidate.client_nonce,
            challenge,
            &candidate.device_public_key,
            &server_identity,
        )?;
        let mut mac = HmacSha256::new_from_slice(&secret).expect("HMAC accepts any key length");
        mac.update(&transcript);
        mac.verify_slice(proof)
            .map_err(|_| anyhow!("invalid pairing secret proof"))?;
        verify_p256(&candidate.device_public_key, &transcript, signature)
            .context("invalid device pairing signature")?;

        let device_id = Uuid::new_v4();
        let permissions = vec![Permission::Read, Permission::Terminal, Permission::Write];
        let permission_names = permissions
            .iter()
            .copied()
            .map(permission_name)
            .collect::<Vec<_>>();
        tx.execute(
            "INSERT INTO devices(id, name, key_algorithm, public_key, permissions, created_at_ms)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                device_id.to_string(),
                candidate.device_name.trim(),
                key_algorithm_name(candidate.device_key_algorithm),
                candidate.device_public_key.as_slice(),
                serde_json::to_string(&permission_names)?,
                now_ms() as i64
            ],
        )?;
        tx.execute(
            "UPDATE pairings SET consumed_at_ms=?2, secret=zeroblob(0) WHERE id=?1",
            params![candidate.pairing_id.to_string(), now_ms() as i64],
        )?;
        tx.commit()?;
        Ok(AuthenticatedDevice {
            id: device_id,
            name: candidate.device_name,
            permissions,
        })
    }

    fn authenticate_device_sync(
        &self,
        device_id: Uuid,
        connection_id: Uuid,
        server_epoch: Uuid,
        challenge: &[u8],
        client_nonce: &[u8],
        signature: &[u8],
    ) -> anyhow::Result<AuthenticatedDevice> {
        let conn = self.connection()?;
        let row: Option<StoredDevice> = conn
            .query_row(
                "SELECT name, key_algorithm, public_key, permissions, revoked_at_ms FROM devices WHERE id=?1",
                params![device_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let (name, algorithm, public_key, permissions_json, revoked_at) =
            row.context("device is not paired")?;
        if revoked_at.is_some() {
            bail!("device has been revoked");
        }
        if algorithm != key_algorithm_name(KeyAlgorithm::P256) {
            bail!("stored device key algorithm is unsupported");
        }
        require_exact("auth client nonce", client_nonce, AUTH_CLIENT_NONCE_BYTES)?;
        require_exact("auth challenge", challenge, AUTH_CHALLENGE_BYTES)?;
        require_exact(
            "server identity",
            &self.signing_key_sync()?.verifying_key().to_bytes(),
            SERVER_IDENTITY_PUBLIC_KEY_BYTES,
        )?;
        let server_identity = self.signing_key_sync()?.verifying_key().to_bytes();
        let transcript = authentication_transcript(
            connection_id,
            device_id,
            server_epoch,
            client_nonce,
            challenge,
            &server_identity,
        )?;
        verify_p256(&public_key, &transcript, signature)
            .context("invalid device authentication signature")?;
        let names: Vec<String> = serde_json::from_str(&permissions_json)?;
        let permissions = names
            .iter()
            .filter_map(|name| permission_from_name(name))
            .collect();
        Ok(AuthenticatedDevice {
            id: device_id,
            name,
            permissions,
        })
    }

    fn list_devices_sync(&self) -> anyhow::Result<Vec<DeviceSummary>> {
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "SELECT id, name, permissions, revoked_at_ms IS NOT NULL FROM devices ORDER BY created_at_ms",
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let permissions: String = row.get(2)?;
            Ok(DeviceSummary {
                id: Uuid::parse_str(&id).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        id.len(),
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                name: row.get(1)?,
                permissions: serde_json::from_str(&permissions).unwrap_or_default(),
                revoked: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn revoke_device_sync(&self, id: Uuid) -> anyhow::Result<()> {
        let conn = self.connection()?;
        let changed = conn.execute(
            "UPDATE devices SET revoked_at_ms=?2 WHERE id=?1 AND revoked_at_ms IS NULL",
            params![id.to_string(), now_ms() as i64],
        )?;
        if changed == 0 {
            bail!("active device not found");
        }
        Ok(())
    }

    fn device_is_active_sync(&self, id: Uuid) -> anyhow::Result<bool> {
        let conn = self.connection()?;
        conn.query_row(
            "SELECT revoked_at_ms IS NULL FROM devices WHERE id=?1",
            params![id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map(|active| active.unwrap_or(false))
        .map_err(Into::into)
    }

    fn begin_idempotent_sync(
        &self,
        device_id: Uuid,
        key: Uuid,
        method: RpcMethod,
        params_hash: [u8; 32],
    ) -> anyhow::Result<IdempotencyBegin> {
        let mut conn = self.connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        prune_idempotency(&tx)?;
        let existing: Option<StoredIdempotency> = tx
            .query_row(
                "SELECT method, params_hash, state, response_json
                 FROM idempotency WHERE device_id=?1 AND idempotency_key=?2",
                params![device_id.to_string(), key.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let method_name = serde_json::to_string(&method)?;
        let result = match existing {
            Some((stored_method, stored_hash, _, _))
                if stored_method != method_name || stored_hash.as_slice() != params_hash =>
            {
                IdempotencyBegin::Conflict
            }
            Some((_, _, state, Some(response))) if state == "completed" => {
                IdempotencyBegin::Completed(serde_json::from_slice(&response)?)
            }
            Some((_, _, state, _)) if state == "pending" => IdempotencyBegin::Ambiguous,
            Some(_) => bail!("invalid persisted idempotency state"),
            None => {
                tx.execute(
                    "INSERT INTO idempotency(
                       device_id, idempotency_key, method, params_hash, state, created_at_ms
                     ) VALUES(?1, ?2, ?3, ?4, 'pending', ?5)",
                    params![
                        device_id.to_string(),
                        key.to_string(),
                        method_name,
                        params_hash.as_slice(),
                        now_ms() as i64,
                    ],
                )?;
                IdempotencyBegin::Execute
            }
        };
        tx.commit()?;
        Ok(result)
    }

    fn complete_idempotent_sync(
        &self,
        device_id: Uuid,
        key: Uuid,
        method: RpcMethod,
        params_hash: [u8; 32],
        response: ServerMessage,
    ) -> anyhow::Result<()> {
        let conn = self.connection()?;
        let method_name = serde_json::to_string(&method)?;
        let response = serde_json::to_vec(&response)?;
        let changed = conn.execute(
            "UPDATE idempotency
             SET state='completed', response_json=?5, completed_at_ms=?6
             WHERE device_id=?1 AND idempotency_key=?2 AND method=?3
               AND params_hash=?4 AND state='pending'",
            params![
                device_id.to_string(),
                key.to_string(),
                method_name,
                params_hash.as_slice(),
                response,
                now_ms() as i64,
            ],
        )?;
        if changed != 1 {
            bail!("idempotency reservation was not pending");
        }
        Ok(())
    }
}

fn prune_idempotency(conn: &Connection) -> rusqlite::Result<usize> {
    let cutoff = now_ms().saturating_sub(IDEMPOTENCY_RETENTION_MS) as i64;
    conn.execute(
        "DELETE FROM idempotency
         WHERE (state='pending' AND created_at_ms < ?1)
            OR (state='completed' AND COALESCE(completed_at_ms, created_at_ms) < ?1)",
        params![cutoff],
    )
}

fn verify_p256(public_key: &[u8], message: &[u8], signature: &[u8]) -> anyhow::Result<()> {
    let key = VerifyingKey::from_sec1_bytes(public_key)?;
    let signature = Signature::from_der(signature)?;
    key.verify(message, &signature)?;
    Ok(())
}

fn require_exact(label: &str, bytes: &[u8], expected: usize) -> anyhow::Result<()> {
    if bytes.len() != expected {
        bail!("{label} has {} bytes; expected {expected}", bytes.len());
    }
    Ok(())
}

fn key_algorithm_name(value: KeyAlgorithm) -> &'static str {
    match value {
        KeyAlgorithm::P256 => "p256",
    }
}

fn permission_name(permission: Permission) -> &'static str {
    match permission {
        Permission::Read => "read",
        Permission::Terminal => "terminal",
        Permission::Write => "write",
    }
}

fn permission_from_name(value: &str) -> Option<Permission> {
    Some(match value {
        "read" => Permission::Read,
        "terminal" => Permission::Terminal,
        "write" => Permission::Write,
        _ => return None,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn secure_file(_path: &std::path::Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn render_pairing_qr(bundle: &PairingBundle) -> anyhow::Result<String> {
    let payload = serde_json::to_vec(bundle)?;
    let code = QrCode::new(payload)?;
    Ok(code
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Dark)
        .light_color(unicode::Dense1x2::Light)
        .build())
}

pub fn decode_b64<const N: usize>(value: &str, label: &str) -> anyhow::Result<[u8; N]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .with_context(|| format!("invalid {label} base64"))?;
    bytes
        .try_into()
        .map_err(|v: Vec<u8>| anyhow!("invalid {label} length {}, expected {N}", v.len()))
}

pub fn decode_b64_vec(value: &str, label: &str, max: usize) -> anyhow::Result<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .with_context(|| format!("invalid {label} base64"))?;
    if bytes.len() > max {
        bail!("{label} is too large");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature as Ed25519Signature, VerifyingKey as IdentityVerifyingKey};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};

    async fn store() -> (tempfile::TempDir, AuthStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = AuthStore::open(temp.path().join("auth.db")).await.unwrap();
        (temp, store)
    }

    #[tokio::test]
    async fn pairing_is_single_use_and_device_signature_is_verified() {
        let (_temp, store) = store().await;
        let bundle = store
            .create_pairing("https://linco.example", 120)
            .await
            .unwrap();
        let connection_id = Uuid::new_v4();
        let challenge = vec![7; 32];
        let client_nonce = vec![8; 32];
        let signing = SigningKey::random(&mut OsRng);
        let candidate = PairingCandidate {
            pairing_id: bundle.pairing_id,
            device_name: "test phone".into(),
            device_key_algorithm: KeyAlgorithm::P256,
            device_public_key: signing
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
            client_nonce: client_nonce.clone(),
        };
        let server_identity = URL_SAFE_NO_PAD.decode(&bundle.server_identity_b64).unwrap();
        let message = pairing_transcript(
            bundle.pairing_id,
            &client_nonce,
            &challenge,
            &candidate.device_public_key,
            &server_identity,
        )
        .unwrap();
        let secret = URL_SAFE_NO_PAD.decode(&bundle.pairing_secret_b64).unwrap();
        let mut mac = HmacSha256::new_from_slice(&secret).unwrap();
        mac.update(&message);
        let proof = mac.finalize().into_bytes().to_vec();
        let signature: Signature = signing.sign(&message);
        let signature = signature.to_der().as_bytes().to_vec();

        let device = store
            .finish_pairing(
                candidate.clone(),
                connection_id,
                challenge.clone(),
                proof.clone(),
                signature.clone(),
            )
            .await
            .unwrap();
        assert!(device.permits(Permission::Terminal));
        assert!(store
            .finish_pairing(candidate, connection_id, challenge, proof, signature,)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn server_hello_proves_pinned_identity_and_binds_challenge() {
        let (_temp, store) = store().await;
        let connection = Uuid::new_v4();
        let epoch = Uuid::new_v4();
        let nonce = vec![1; 32];
        let challenge = vec![2; 32];
        let proof = store
            .server_hello_proof(
                linco_protocol::PROTOCOL_VERSION,
                LogicalChannel::Control,
                connection,
                epoch,
                nonce.clone(),
                challenge.clone(),
            )
            .await
            .unwrap();
        let identity = decode_b64::<32>(&proof.identity_b64, "identity").unwrap();
        let signature = decode_b64::<64>(&proof.signature_b64, "signature").unwrap();
        let signature = Ed25519Signature::from_bytes(&signature);
        let transcript = server_hello_transcript(
            linco_protocol::PROTOCOL_VERSION,
            LogicalChannel::Control,
            connection,
            epoch,
            &nonce,
            &challenge,
            &identity,
        )
        .unwrap();
        let verifying = IdentityVerifyingKey::from_bytes(&identity).unwrap();
        verifying.verify_strict(&transcript, &signature).unwrap();

        let mut tampered = challenge;
        tampered[0] ^= 1;
        let tampered_transcript = server_hello_transcript(
            linco_protocol::PROTOCOL_VERSION,
            LogicalChannel::Control,
            connection,
            epoch,
            &nonce,
            &tampered,
            &identity,
        )
        .unwrap();
        assert!(verifying
            .verify_strict(&tampered_transcript, &signature)
            .is_err());
        let wrong = IdentitySigningKey::from_bytes(&[9; 32]).verifying_key();
        assert!(wrong.verify_strict(&transcript, &signature).is_err());
    }

    #[tokio::test]
    async fn wrong_pairing_proof_is_rejected_without_consuming_ticket() {
        let (_temp, store) = store().await;
        let bundle = store
            .create_pairing("https://linco.example", 120)
            .await
            .unwrap();
        let signing = SigningKey::random(&mut OsRng);
        let candidate = PairingCandidate {
            pairing_id: bundle.pairing_id,
            device_name: "phone".into(),
            device_key_algorithm: KeyAlgorithm::P256,
            device_public_key: signing
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
            client_nonce: vec![1; 32],
        };
        let result = store
            .finish_pairing(
                candidate,
                Uuid::new_v4(),
                vec![2; 32],
                vec![0; 32],
                vec![0; 64],
            )
            .await;
        assert!(result.is_err());
        store.check_pairing(bundle.pairing_id).await.unwrap();
    }

    #[tokio::test]
    async fn pairing_ttl_is_never_longer_than_ios_accepts() {
        let (_temp, store) = store().await;
        let before = now_ms();
        let bundle = store
            .create_pairing("https://linco.example", u64::MAX)
            .await
            .unwrap();
        assert!(bundle.expires_at_ms <= before + 120_500);
    }

    #[tokio::test]
    async fn authorization_liveness_turns_false_after_revocation_or_deletion() {
        let (_temp, store) = store().await;
        let device_id = Uuid::new_v4();
        store
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO devices(
                   id, name, key_algorithm, public_key, permissions, created_at_ms
                 ) VALUES(?1, 'phone', 'p256', ?2, '[]', ?3)",
                params![
                    device_id.to_string(),
                    [4_u8; 65].as_slice(),
                    now_ms() as i64
                ],
            )
            .unwrap();

        assert!(store.device_is_active(device_id).await.unwrap());
        store.revoke_device(device_id).await.unwrap();
        assert!(!store.device_is_active(device_id).await.unwrap());
        assert!(!store.device_is_active(Uuid::new_v4()).await.unwrap());
    }

    #[tokio::test]
    async fn expired_idempotency_records_are_pruned_on_open_and_reservation() {
        let (temp, store) = store().await;
        let method = serde_json::to_string(&RpcMethod::SessionStart).unwrap();
        let old = now_ms()
            .saturating_sub(IDEMPOTENCY_RETENTION_MS)
            .saturating_sub(1_000) as i64;
        let fresh = now_ms() as i64;
        {
            let conn = store.connection().unwrap();
            conn.execute(
                "INSERT INTO idempotency(
                   device_id, idempotency_key, method, params_hash, state, created_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 'pending', ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    &method,
                    [1_u8; 32].as_slice(),
                    old,
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO idempotency(
                   device_id, idempotency_key, method, params_hash, state,
                   response_json, created_at_ms, completed_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 'completed', ?5, ?6, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    &method,
                    [2_u8; 32].as_slice(),
                    b"{}".as_slice(),
                    old,
                ],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO idempotency(
                   device_id, idempotency_key, method, params_hash, state,
                   response_json, created_at_ms, completed_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 'completed', ?5, ?6, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    &method,
                    [3_u8; 32].as_slice(),
                    b"{}".as_slice(),
                    fresh,
                ],
            )
            .unwrap();
        }
        drop(store);

        let reopened = AuthStore::open(temp.path().join("auth.db")).await.unwrap();
        let count: i64 = reopened
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM idempotency", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "open should retain only the fresh record");

        let stale_device = Uuid::new_v4();
        let stale_key = Uuid::new_v4();
        reopened
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO idempotency(
                   device_id, idempotency_key, method, params_hash, state, created_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 'pending', ?5)",
                params![
                    stale_device.to_string(),
                    stale_key.to_string(),
                    &method,
                    [4_u8; 32].as_slice(),
                    old,
                ],
            )
            .unwrap();
        reopened
            .begin_idempotent(
                Uuid::new_v4(),
                Uuid::new_v4(),
                RpcMethod::SessionStart,
                [5; 32],
            )
            .await
            .unwrap();
        let stale_count: i64 = reopened
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM idempotency
                 WHERE device_id=?1 AND idempotency_key=?2",
                params![stale_device.to_string(), stale_key.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_count, 0, "reservation should prune stale records");
    }

    #[tokio::test]
    async fn concurrent_mutation_duplicates_never_both_execute() {
        let (_temp, store) = store().await;
        let device = Uuid::new_v4();
        let key = Uuid::new_v4();
        let hash = [9; 32];
        let a = store.begin_idempotent(device, key, RpcMethod::SessionStart, hash);
        let b = store.begin_idempotent(device, key, RpcMethod::SessionStart, hash);
        let (a, b) = tokio::join!(a, b);
        let results = [a.unwrap(), b.unwrap()];
        assert_eq!(
            results
                .iter()
                .filter(|value| matches!(value, IdempotencyBegin::Execute))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|value| matches!(value, IdempotencyBegin::Ambiguous))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn pending_record_survives_reopen_as_ambiguous() {
        let (temp, store) = store().await;
        let device = Uuid::new_v4();
        let key = Uuid::new_v4();
        let hash = [7; 32];
        assert!(matches!(
            store
                .begin_idempotent(device, key, RpcMethod::SessionStart, hash)
                .await
                .unwrap(),
            IdempotencyBegin::Execute
        ));
        drop(store);
        let reopened = AuthStore::open(temp.path().join("auth.db")).await.unwrap();
        assert!(matches!(
            reopened
                .begin_idempotent(device, key, RpcMethod::SessionStart, hash)
                .await
                .unwrap(),
            IdempotencyBegin::Ambiguous
        ));
        assert!(matches!(
            reopened
                .begin_idempotent(device, key, RpcMethod::SessionStart, [8; 32])
                .await
                .unwrap(),
            IdempotencyBegin::Conflict
        ));
    }

    #[tokio::test]
    async fn completed_result_is_replayed_after_reopen() {
        let (temp, store) = store().await;
        let device = Uuid::new_v4();
        let key = Uuid::new_v4();
        let hash = [3; 32];
        let id = Uuid::new_v4();
        store
            .begin_idempotent(device, key, RpcMethod::SessionStart, hash)
            .await
            .unwrap();
        store
            .complete_idempotent(
                device,
                key,
                RpcMethod::SessionStart,
                hash,
                ServerMessage::Result {
                    id,
                    value: serde_json::json!({"stopped": true}),
                },
            )
            .await
            .unwrap();
        drop(store);
        let reopened = AuthStore::open(temp.path().join("auth.db")).await.unwrap();
        assert!(matches!(
            reopened
                .begin_idempotent(device, key, RpcMethod::SessionStart, hash)
                .await
                .unwrap(),
            IdempotencyBegin::Completed(ServerMessage::Result { id: stored, .. }) if stored == id
        ));
    }
}
