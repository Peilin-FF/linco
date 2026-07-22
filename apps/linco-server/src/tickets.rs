use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use anyhow::{bail, Context};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use linco_protocol::{LaneTicket, LogicalChannel, Permission};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct LaneGrant {
    pub connection_id: Uuid,
    pub device_id: Uuid,
    pub permissions: Vec<Permission>,
    pub lane: LogicalChannel,
    pub resume_streams: BTreeMap<u32, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpCapabilityKind {
    BulkRead,
    BulkWrite,
    PreviewBootstrap,
    PreviewSession,
}

#[derive(Debug, Clone)]
pub struct HttpGrant {
    pub device_id: Uuid,
    pub workspace_id: Uuid,
    pub relative_path: String,
    pub kind: HttpCapabilityKind,
    pub expected_etag: Option<String>,
    pub max_bytes: u64,
    pub content_length: Option<u64>,
}

#[derive(Clone, Default)]
pub struct TicketStore {
    inner: Arc<Mutex<Tickets>>,
}

#[derive(Default)]
struct Tickets {
    lanes: HashMap<[u8; 32], Expiring<LaneGrant>>,
    http: HashMap<[u8; 32], Expiring<HttpGrant>>,
}

struct Expiring<T> {
    value: T,
    expires: Instant,
}

impl TicketStore {
    pub fn issue_lane(&self, grant: LaneGrant, ttl: Duration) -> anyhow::Result<LaneTicket> {
        if grant.lane != LogicalChannel::Interactive {
            bail!("only the interactive lane may use an attach ticket");
        }
        let (raw, digest) = new_ticket();
        let expires = Instant::now() + ttl;
        let expires_at_ms = now_ms().saturating_add(ttl.as_millis() as u64);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("ticket store poisoned"))?;
        inner.prune();
        inner.lanes.insert(
            digest,
            Expiring {
                value: grant.clone(),
                expires,
            },
        );
        Ok(LaneTicket {
            lane: grant.lane,
            ticket_b64: URL_SAFE_NO_PAD.encode(raw),
            expires_at_ms,
        })
    }

    pub fn consume_lane(
        &self,
        token_b64: &str,
        connection_id: Uuid,
        lane: LogicalChannel,
    ) -> anyhow::Result<LaneGrant> {
        let digest = digest_token(token_b64)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("ticket store poisoned"))?;
        inner.prune();
        let grant = inner
            .lanes
            .remove(&digest)
            .context("attach ticket is invalid, expired, or already used")?
            .value;
        if grant.connection_id != connection_id || grant.lane != lane {
            bail!("attach ticket does not match this connection/lane");
        }
        Ok(grant)
    }

    pub fn issue_http(&self, grant: HttpGrant, ttl: Duration) -> anyhow::Result<String> {
        let (raw, digest) = new_ticket();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("ticket store poisoned"))?;
        inner.prune();
        inner.http.insert(
            digest,
            Expiring {
                value: grant,
                expires: Instant::now() + ttl,
            },
        );
        Ok(URL_SAFE_NO_PAD.encode(raw))
    }

    pub fn redeem_http(
        &self,
        token_b64: &str,
        expected: HttpCapabilityKind,
    ) -> anyhow::Result<HttpGrant> {
        let digest = digest_token(token_b64)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("ticket store poisoned"))?;
        inner.prune();
        let grant = inner
            .http
            .get(&digest)
            .context("HTTP capability is invalid or expired")?
            .value
            .clone();
        if grant.kind != expected {
            bail!("HTTP capability is not valid for this route");
        }
        Ok(grant)
    }

    pub fn consume_http(
        &self,
        token_b64: &str,
        expected: HttpCapabilityKind,
    ) -> anyhow::Result<HttpGrant> {
        let digest = digest_token(token_b64)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| anyhow::anyhow!("ticket store poisoned"))?;
        inner.prune();
        let grant = inner
            .http
            .remove(&digest)
            .context("HTTP capability is invalid, expired, or already used")?
            .value;
        if grant.kind != expected {
            bail!("HTTP capability is not valid for this route");
        }
        Ok(grant)
    }
}

impl Tickets {
    fn prune(&mut self) {
        let now = Instant::now();
        self.lanes.retain(|_, value| value.expires > now);
        self.http.retain(|_, value| value.expires > now);
    }
}

fn new_ticket() -> ([u8; 32], [u8; 32]) {
    let mut raw = [0_u8; 32];
    OsRng.fill_bytes(&mut raw);
    let digest: [u8; 32] = Sha256::digest(raw).into();
    (raw, digest)
}

fn digest_token(value: &str) -> anyhow::Result<[u8; 32]> {
    let raw = URL_SAFE_NO_PAD
        .decode(value)
        .context("invalid ticket encoding")?;
    if raw.len() != 32 {
        bail!("invalid ticket length");
    }
    Ok(Sha256::digest(raw).into())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lane_tickets_are_bound_and_single_use() {
        let store = TicketStore::default();
        let connection_id = Uuid::new_v4();
        let ticket = store
            .issue_lane(
                LaneGrant {
                    connection_id,
                    device_id: Uuid::new_v4(),
                    permissions: vec![Permission::Terminal],
                    lane: LogicalChannel::Interactive,
                    resume_streams: BTreeMap::new(),
                },
                Duration::from_secs(30),
            )
            .unwrap();
        assert!(store
            .consume_lane(
                &ticket.ticket_b64,
                Uuid::new_v4(),
                LogicalChannel::Interactive
            )
            .is_err());
        // A mismatched use consumes the bearer to prevent online probing/replay.
        assert!(store
            .consume_lane(
                &ticket.ticket_b64,
                connection_id,
                LogicalChannel::Interactive
            )
            .is_err());
    }

    #[test]
    fn http_capabilities_are_route_scoped() {
        let store = TicketStore::default();
        let token = store
            .issue_http(
                HttpGrant {
                    device_id: Uuid::new_v4(),
                    workspace_id: Uuid::new_v4(),
                    relative_path: "artifact.html".into(),
                    kind: HttpCapabilityKind::PreviewBootstrap,
                    expected_etag: None,
                    max_bytes: 0,
                    content_length: None,
                },
                Duration::from_secs(30),
            )
            .unwrap();
        assert!(store
            .redeem_http(&token, HttpCapabilityKind::BulkRead)
            .is_err());
        assert!(store
            .redeem_http(&token, HttpCapabilityKind::PreviewBootstrap)
            .is_ok());
    }
}
