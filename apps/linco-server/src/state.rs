use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant, SystemTime},
};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, Semaphore};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    auth::AuthStore, config::ServerConfig, terminal_backend::CoreTerminalBackend,
    tickets::TicketStore, workspace::WorkspaceRegistry,
};

#[derive(Clone)]
struct ActiveCall {
    registration_id: Uuid,
    cancellation: CancellationToken,
}

pub struct CallRegistration {
    pub registration_id: Uuid,
    pub cancellation: CancellationToken,
}

#[derive(Default)]
struct CallRegistry {
    calls: Mutex<HashMap<(Uuid, Uuid), ActiveCall>>,
}

const DEVICE_AUTHORIZATION_CACHE_TTL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
struct CachedAuthorization {
    active: bool,
    checked_at: Instant,
}

impl CallRegistry {
    fn register(&self, device_id: Uuid, call_id: Uuid) -> CallRegistration {
        let registration_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        if let Ok(mut calls) = self.calls.lock() {
            if let Some(previous) = calls.insert(
                (device_id, call_id),
                ActiveCall {
                    registration_id,
                    cancellation: cancellation.clone(),
                },
            ) {
                previous.cancellation.cancel();
            }
        }
        CallRegistration {
            registration_id,
            cancellation,
        }
    }

    fn finish(&self, device_id: Uuid, call_id: Uuid, registration_id: Uuid) {
        if let Ok(mut calls) = self.calls.lock() {
            let key = (device_id, call_id);
            if calls
                .get(&key)
                .is_some_and(|active| active.registration_id == registration_id)
            {
                calls.remove(&key);
            }
        }
    }

    fn cancel(&self, device_id: Uuid, call_id: Uuid) -> bool {
        self.calls
            .lock()
            .ok()
            .and_then(|calls| calls.get(&(device_id, call_id)).cloned())
            .is_some_and(|active| {
                active.cancellation.cancel();
                true
            })
    }

    fn cancel_device(&self, device_id: Uuid) {
        if let Ok(calls) = self.calls.lock() {
            for ((active_device, _), call) in calls.iter() {
                if *active_device == device_id {
                    call.cancellation.cancel();
                }
            }
        }
    }

    fn cancel_all(&self) {
        if let Ok(calls) = self.calls.lock() {
            for active in calls.values() {
                active.cancellation.cancel();
            }
        }
    }
}

pub struct AppState {
    pub config: ServerConfig,
    pub auth: AuthStore,
    pub workspaces: WorkspaceRegistry,
    pub terminal: CoreTerminalBackend,
    pub tickets: TicketStore,
    pub server_epoch: Uuid,
    pub started_at: SystemTime,
    pub call_slots: Arc<Semaphore>,
    calls: CallRegistry,
    authorization_cache: Mutex<HashMap<Uuid, CachedAuthorization>>,
    upload_locks: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
}

impl AppState {
    pub fn new(
        config: ServerConfig,
        auth: AuthStore,
        workspaces: WorkspaceRegistry,
        terminal: CoreTerminalBackend,
    ) -> Self {
        let max_inflight = config.max_inflight_calls;
        Self {
            config,
            auth,
            workspaces,
            terminal,
            tickets: TicketStore::default(),
            server_epoch: Uuid::new_v4(),
            started_at: SystemTime::now(),
            call_slots: Arc::new(Semaphore::new(max_inflight)),
            calls: CallRegistry::default(),
            authorization_cache: Mutex::new(HashMap::new()),
            upload_locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn register_call(&self, device_id: Uuid, call_id: Uuid) -> CallRegistration {
        self.calls.register(device_id, call_id)
    }

    pub fn finish_call(&self, device_id: Uuid, call_id: Uuid, registration_id: Uuid) {
        self.calls.finish(device_id, call_id, registration_id);
    }

    pub fn cancel_call(&self, device_id: Uuid, call_id: Uuid) -> bool {
        self.calls.cancel(device_id, call_id)
    }

    pub fn cancel_device_calls(&self, device_id: Uuid) {
        self.calls.cancel_device(device_id);
    }

    pub async fn device_authorization_is_active(&self, device_id: Uuid) -> bool {
        let now = Instant::now();
        if let Some(cached) = self
            .authorization_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&device_id).copied())
            .filter(|cached| now.duration_since(cached.checked_at) < DEVICE_AUTHORIZATION_CACHE_TTL)
        {
            return cached.active;
        }

        self.refresh_device_authorization(device_id).await
    }

    pub async fn refresh_device_authorization(&self, device_id: Uuid) -> bool {
        let active = match self.auth.device_is_active(device_id).await {
            Ok(active) => active,
            Err(error) => {
                tracing::warn!(error = %error, %device_id, "authorization liveness check failed closed");
                false
            }
        };
        if let Ok(mut cache) = self.authorization_cache.lock() {
            cache.insert(
                device_id,
                CachedAuthorization {
                    active,
                    checked_at: Instant::now(),
                },
            );
        }
        active
    }

    pub async fn lock_upload_target(&self, target: &Path) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .upload_locks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(target).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(target.to_path_buf(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    pub async fn shutdown(&self) {
        self.calls.cancel_all();
        self.terminal.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_is_cancellable_immediately_after_registration() {
        let registry = CallRegistry::default();
        let device_id = Uuid::new_v4();
        let call_id = Uuid::new_v4();
        let registration = registry.register(device_id, call_id);

        assert!(registry.cancel(device_id, call_id));
        assert!(registration.cancellation.is_cancelled());
    }

    #[test]
    fn stale_completion_cannot_unregister_a_replacement_call() {
        let registry = CallRegistry::default();
        let device_id = Uuid::new_v4();
        let call_id = Uuid::new_v4();
        let first = registry.register(device_id, call_id);
        let second = registry.register(device_id, call_id);
        assert!(first.cancellation.is_cancelled());

        registry.finish(device_id, call_id, first.registration_id);
        assert!(registry.cancel(device_id, call_id));
        assert!(second.cancellation.is_cancelled());
    }

    #[test]
    fn device_revocation_cancels_only_that_devices_calls() {
        let registry = CallRegistry::default();
        let revoked = Uuid::new_v4();
        let retained = Uuid::new_v4();
        let revoked_call = registry.register(revoked, Uuid::new_v4());
        let retained_call = registry.register(retained, Uuid::new_v4());

        registry.cancel_device(revoked);

        assert!(revoked_call.cancellation.is_cancelled());
        assert!(!retained_call.cancellation.is_cancelled());
    }
}
