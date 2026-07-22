use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use linco_core::{
    CoreError, TerminalEvent, TerminalManager, TerminalReplay, TerminalSessionInfo, TerminalSize,
    TerminalStart, TerminalSubscriptionFilter,
};
use linco_protocol::TerminalInputFaultCode;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::TerminalConfig;

const TERMINAL_CHUNK_BYTES: usize = 32 * 1024;
// Matches the iPhone ledger's maximum unacknowledged bytes per stream. A reconnect may replay any
// byte in that window, so retaining less would turn a valid large-paste retry into a false conflict.
const INPUT_HISTORY_BYTES: usize = 1024 * 1024;
const TERMINAL_INPUT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINAL_INPUT_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);
const INPUT_WRITE_QUEUED: u8 = 0;
const INPUT_WRITE_STARTED: u8 = 1;
const INPUT_WRITE_CANCELLED: u8 = 2;

#[derive(Debug)]
pub struct StreamBinding {
    pub stream_id: u32,
    pub session_id: Uuid,
    pub generation: u64,
    input: Mutex<InputState>,
}

#[derive(Debug, Default)]
struct InputState {
    through: u64,
    retained_from: u64,
    retained: Vec<u8>,
    ambiguous: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputPlan {
    Duplicate,
    Gap,
    OverlapMismatch,
    Write { from: usize, through: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputApply {
    Applied {
        through: u64,
    },
    Duplicate {
        through: u64,
    },
    Gap {
        expected: u64,
        received: u64,
    },
    OverlapMismatch {
        through: u64,
    },
    Rejected {
        through: u64,
        code: TerminalInputFaultCode,
    },
    Cancelled {
        through: u64,
    },
    Ambiguous {
        through: u64,
    },
}

struct CancelInputOnDrop {
    cancellation: CancellationToken,
    armed: bool,
}

impl CancelInputOnDrop {
    fn new(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancelInputOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

enum InputWriteResolution {
    Committed,
    CancelledBeforeWrite,
    OverloadedBeforeWrite,
    Rejected {
        code: TerminalInputFaultCode,
        error: anyhow::Error,
    },
    Ambiguous(anyhow::Error),
}

pub struct BackendSubscription {
    receiver: mpsc::Receiver<TerminalEvent>,
    cancelled: Arc<AtomicBool>,
    filter: TerminalSubscriptionFilter,
}

impl BackendSubscription {
    pub async fn recv(&mut self) -> Option<TerminalEvent> {
        self.receiver.recv().await
    }

    pub fn select(&self, session_id: Uuid, generation: u64) {
        self.filter.select(session_id, generation);
    }

    pub fn deselect(&self, session_id: Uuid, generation: u64) -> bool {
        self.filter.deselect(session_id, generation)
    }
}

impl Drop for BackendSubscription {
    fn drop(&mut self) {
        self.filter.clear();
        self.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Default)]
struct StreamMaps {
    by_session: HashMap<Uuid, u32>,
    by_stream: HashMap<u32, Arc<StreamBinding>>,
}

#[derive(Clone)]
pub struct CoreTerminalBackend {
    manager: TerminalManager,
    streams: Arc<RwLock<StreamMaps>>,
    next_stream: Arc<AtomicU32>,
    outbound_queue: usize,
}

impl CoreTerminalBackend {
    pub fn new(config: TerminalConfig) -> anyhow::Result<Self> {
        let core_config = linco_core::TerminalConfig {
            ring_capacity_bytes: config.replay_bytes,
            read_chunk_bytes: TERMINAL_CHUNK_BYTES,
            max_input_bytes: TERMINAL_CHUNK_BYTES,
            subscriber_queue_events: config.outbound_queue.max(8),
            ..linco_core::TerminalConfig::default()
        };
        Ok(Self {
            manager: TerminalManager::new(core_config)?,
            streams: Arc::new(RwLock::new(StreamMaps::default())),
            next_stream: Arc::new(AtomicU32::new(1)),
            outbound_queue: config.outbound_queue.max(8),
        })
    }

    pub async fn start(
        &self,
        request: TerminalStart,
    ) -> anyhow::Result<(TerminalSessionInfo, u32)> {
        let manager = self.manager.clone();
        let info = tokio::task::spawn_blocking(move || manager.start(request))
            .await
            .context("terminal start task")??;
        let stream_id = self.bind(&info)?;
        Ok((info, stream_id))
    }

    pub async fn stop(&self, session_id: Uuid, generation: u64) -> anyhow::Result<()> {
        let manager = self.manager.clone();
        tokio::task::spawn_blocking(move || manager.stop(session_id, generation))
            .await
            .context("terminal stop task")??;
        Ok(())
    }

    pub async fn resize(
        &self,
        session_id: Uuid,
        generation: u64,
        size: TerminalSize,
    ) -> anyhow::Result<()> {
        let manager = self.manager.clone();
        tokio::task::spawn_blocking(move || manager.resize(session_id, generation, size))
            .await
            .context("terminal resize task")??;
        Ok(())
    }

    pub async fn list(&self) -> anyhow::Result<Vec<(TerminalSessionInfo, u32)>> {
        let manager = self.manager.clone();
        let sessions = tokio::task::spawn_blocking(move || manager.list_sessions())
            .await
            .context("terminal list task")?;
        sessions
            .into_iter()
            .map(|info| {
                let stream = self.bind(&info)?;
                Ok((info, stream))
            })
            .collect()
    }

    pub fn binding(&self, stream_id: u32) -> anyhow::Result<Arc<StreamBinding>> {
        self.streams
            .read()
            .map_err(|_| anyhow!("terminal stream map poisoned"))?
            .by_stream
            .get(&stream_id)
            .cloned()
            .with_context(|| format!("terminal stream not found: {stream_id}"))
    }

    pub fn stream_for_session(&self, session_id: Uuid, generation: u64) -> Option<u32> {
        let maps = self.streams.read().ok()?;
        let stream_id = maps.by_session.get(&session_id).copied()?;
        maps.by_stream
            .get(&stream_id)
            .is_some_and(|binding| binding.generation == generation)
            .then_some(stream_id)
    }

    /// Returns the server-authoritative next terminal-input offset.
    ///
    /// The cursor is read under the same mutex that covers PTY writes and ledger commits. A resume
    /// therefore cannot observe a stale cursor while a write is in flight. If a cancelled write
    /// may have reached the PTY, the generation is deliberately non-resumable instead of guessing.
    pub async fn input_through(&self, stream_id: u32, generation: u64) -> anyhow::Result<u64> {
        let binding = self.binding(stream_id)?;
        if binding.generation != generation {
            return Err(anyhow!("terminal generation changed"));
        }
        let input = binding.input.lock().await;
        if input.ambiguous {
            return Err(anyhow!(
                "terminal input outcome is ambiguous for generation {generation}"
            ));
        }
        Ok(input.through)
    }

    pub async fn apply_input(
        &self,
        stream_id: u32,
        generation: u64,
        offset: u64,
        data: Vec<u8>,
    ) -> anyhow::Result<InputApply> {
        let binding = self.binding(stream_id)?;
        if binding.generation != generation {
            return Err(anyhow!(
                "terminal generation mismatch: expected {}, current {}",
                generation,
                binding.generation
            ));
        }
        let manager = self.manager.clone();
        let stop_manager = self.manager.clone();
        let transaction_failure_stop_manager = self.manager.clone();
        let session_id = binding.session_id;
        let transaction_failure_binding = Arc::clone(&binding);
        let cancellation = CancellationToken::new();
        let transaction_cancellation = cancellation.clone();
        let transaction =
            spawn_owned_input_transaction(binding, offset, data, move |suffix| async move {
                write_terminal_input(
                    manager,
                    stop_manager,
                    session_id,
                    generation,
                    suffix,
                    transaction_cancellation,
                )
                .await
            });
        let mut cancellation_guard = CancelInputOnDrop::new(cancellation);
        match transaction.await {
            Ok(result) => {
                cancellation_guard.disarm();
                result
            }
            Err(error) => {
                // A panic/cancellation inside the owned transaction can leave a detached blocking
                // PTY write with an unknowable result. Quarantine and terminate this generation.
                cancellation_guard.cancellation.cancel();
                let through = {
                    let mut input = transaction_failure_binding.input.lock().await;
                    input.ambiguous = true;
                    input.through
                };
                let _ = tokio::task::spawn_blocking(move || {
                    transaction_failure_stop_manager.stop(session_id, generation)
                })
                .await;
                cancellation_guard.disarm();
                tracing::error!(
                    error = %error,
                    session_id = %session_id,
                    generation,
                    "owned terminal input transaction failed; generation terminated"
                );
                Ok(InputApply::Ambiguous { through })
            }
        }
    }

    pub async fn replay(
        &self,
        stream_id: u32,
        generation: u64,
        offset: u64,
        max_bytes: usize,
    ) -> anyhow::Result<TerminalReplay> {
        let binding = self.binding(stream_id)?;
        if binding.generation != generation {
            return Err(anyhow!("terminal generation changed"));
        }
        let manager = self.manager.clone();
        let session_id = binding.session_id;
        tokio::task::spawn_blocking(move || {
            manager.replay(
                session_id,
                generation,
                offset,
                max_bytes.min(TERMINAL_CHUNK_BYTES),
            )
        })
        .await
        .context("terminal replay task")?
        .map_err(Into::into)
    }

    pub async fn snapshot(
        &self,
        stream_id: u32,
        generation: u64,
        max_bytes: usize,
    ) -> anyhow::Result<TerminalReplay> {
        let binding = self.binding(stream_id)?;
        if binding.generation != generation {
            return Err(anyhow!("terminal generation changed"));
        }
        let manager = self.manager.clone();
        let session_id = binding.session_id;
        tokio::task::spawn_blocking(move || manager.snapshot(session_id, generation, max_bytes))
            .await
            .context("terminal snapshot task")?
            .map_err(Into::into)
    }

    pub fn subscribe(&self) -> anyhow::Result<BackendSubscription> {
        let filter = TerminalSubscriptionFilter::default();
        let subscription = self.manager.subscribe_filtered(filter.clone())?;
        let (sender, receiver) = mpsc::channel(self.outbound_queue);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        tokio::task::spawn_blocking(move || {
            while !worker_cancelled.load(Ordering::Acquire) {
                match subscription.recv_timeout(Duration::from_millis(250)) {
                    Ok(event) => {
                        // Never let a slow socket block the PTY drain/replay producer. Gaps are
                        // recovered from the core ring by the interactive lane.
                        let _ = sender.try_send(event);
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        Ok(BackendSubscription {
            receiver,
            cancelled,
            filter,
        })
    }

    pub async fn shutdown(&self) {
        let manager = self.manager.clone();
        let _ = tokio::task::spawn_blocking(move || manager.shutdown()).await;
    }

    fn bind(&self, info: &TerminalSessionInfo) -> anyhow::Result<u32> {
        let mut maps = self
            .streams
            .write()
            .map_err(|_| anyhow!("terminal stream map poisoned"))?;
        if let Some(stream_id) = maps.by_session.get(&info.session_id).copied() {
            if maps
                .by_stream
                .get(&stream_id)
                .is_some_and(|binding| binding.generation == info.generation)
            {
                return Ok(stream_id);
            }
        }
        // A new process generation receives a fresh transport stream id. That keeps delayed input
        // from an old socket from ever being applied to the replacement process.
        let stream_id = self.allocate_stream_id(&maps)?;
        if let Some(previous_stream) = maps.by_session.insert(info.session_id, stream_id) {
            maps.by_stream.remove(&previous_stream);
        }
        maps.by_stream.insert(
            stream_id,
            Arc::new(StreamBinding {
                stream_id,
                session_id: info.session_id,
                generation: info.generation,
                input: Mutex::new(InputState::default()),
            }),
        );
        Ok(stream_id)
    }

    fn allocate_stream_id(&self, maps: &StreamMaps) -> anyhow::Result<u32> {
        for _ in 0..u32::MAX {
            let candidate = self.next_stream.fetch_add(1, Ordering::Relaxed);
            if candidate != 0 && !maps.by_stream.contains_key(&candidate) {
                return Ok(candidate);
            }
        }
        Err(anyhow!("terminal stream id space exhausted"))
    }
}

fn spawn_owned_input_transaction<W, F>(
    binding: Arc<StreamBinding>,
    offset: u64,
    data: Vec<u8>,
    writer: W,
) -> tokio::task::JoinHandle<anyhow::Result<InputApply>>
where
    W: FnOnce(Vec<u8>) -> F + Send + 'static,
    F: Future<Output = InputWriteResolution> + Send + 'static,
{
    tokio::spawn(async move {
        let mut input = binding.input.lock().await;
        if input.ambiguous {
            return Ok(InputApply::Ambiguous {
                through: input.through,
            });
        }
        let plan = match plan_input(&input, offset, &data) {
            Ok(plan) => plan,
            Err(error) => {
                tracing::info!(
                    error = %error,
                    stream_id = binding.stream_id,
                    offset,
                    "terminal input offset was invalid"
                );
                return Ok(InputApply::Gap {
                    expected: input.through,
                    received: offset,
                });
            }
        };
        let (write_from, end) = match plan {
            InputPlan::Duplicate => {
                return Ok(InputApply::Duplicate {
                    through: input.through,
                })
            }
            InputPlan::Gap => {
                return Ok(InputApply::Gap {
                    expected: input.through,
                    received: offset,
                })
            }
            InputPlan::OverlapMismatch => {
                return Ok(InputApply::OverlapMismatch {
                    through: input.through,
                })
            }
            InputPlan::Write { from, through } => (from, through),
        };
        match writer(data[write_from..].to_vec()).await {
            InputWriteResolution::Committed => {
                record_verified_input(&mut input, &data[write_from..], end);
                Ok(InputApply::Applied { through: end })
            }
            InputWriteResolution::Rejected { code, error } => {
                tracing::info!(
                    error = %error,
                    session_id = %binding.session_id,
                    ?code,
                    "terminal input was rejected before reaching the PTY"
                );
                Ok(InputApply::Rejected {
                    through: input.through,
                    code,
                })
            }
            InputWriteResolution::CancelledBeforeWrite => Ok(InputApply::Cancelled {
                through: input.through,
            }),
            InputWriteResolution::OverloadedBeforeWrite => Ok(InputApply::Rejected {
                through: input.through,
                code: TerminalInputFaultCode::Overloaded,
            }),
            InputWriteResolution::Ambiguous(error) => {
                input.ambiguous = true;
                tracing::warn!(
                    error = %error,
                    session_id = %binding.session_id,
                    "terminal input outcome is ambiguous; session terminated"
                );
                Ok(InputApply::Ambiguous {
                    through: input.through,
                })
            }
        }
    })
}

async fn write_terminal_input(
    manager: TerminalManager,
    stop_manager: TerminalManager,
    session_id: Uuid,
    generation: u64,
    suffix: Vec<u8>,
    cancellation: CancellationToken,
) -> InputWriteResolution {
    run_terminal_input_write(
        move || manager.write(session_id, generation, &suffix),
        move || stop_manager.stop(session_id, generation),
        session_id,
        generation,
        cancellation,
        TERMINAL_INPUT_WRITE_TIMEOUT,
        TERMINAL_INPUT_SETTLE_TIMEOUT,
    )
    .await
}

async fn run_terminal_input_write<W, S>(
    write_operation: W,
    stop_operation: S,
    session_id: Uuid,
    generation: u64,
    cancellation: CancellationToken,
    write_timeout: Duration,
    settle_timeout: Duration,
) -> InputWriteResolution
where
    W: FnOnce() -> Result<(), CoreError> + Send + 'static,
    S: Fn() -> Result<(), CoreError> + Send + Sync + 'static,
{
    if cancellation.is_cancelled() {
        return InputWriteResolution::CancelledBeforeWrite;
    }

    let stop_operation = Arc::new(stop_operation);
    let write_state = Arc::new(AtomicU8::new(INPUT_WRITE_QUEUED));
    let worker_state = Arc::clone(&write_state);
    let mut write = tokio::task::spawn_blocking(move || {
        if !try_start_terminal_input_write(&worker_state) {
            return None;
        }
        Some(write_operation())
    });
    let write_result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => {
            if cancel_terminal_input_write_if_queued(&write_state) {
                // The blocking closure may still be scheduled later. Its CAS observes CANCELLED
                // and returns without ever calling TerminalManager::write.
                return InputWriteResolution::CancelledBeforeWrite;
            }
            terminate_and_settle_started_input_write(
                Arc::clone(&stop_operation),
                session_id,
                generation,
                &mut write,
                "connection cancellation",
                settle_timeout,
            )
            .await;
            return InputWriteResolution::Ambiguous(anyhow!(
                "terminal input waiter was cancelled while the PTY write was in flight"
            ));
        }
        result = &mut write => result,
        _ = tokio::time::sleep(write_timeout) => {
            if cancel_terminal_input_write_if_queued(&write_state) {
                // Admission timed out before the blocking closure started. The CAS makes this a
                // definitive no-op even if Tokio schedules the closure after we return.
                return InputWriteResolution::OverloadedBeforeWrite;
            }
            terminate_and_settle_started_input_write(
                Arc::clone(&stop_operation),
                session_id,
                generation,
                &mut write,
                "write watchdog",
                settle_timeout,
            )
            .await;
            return InputWriteResolution::Ambiguous(anyhow!(
                "terminal input write exceeded the {:?} watchdog",
                write_timeout
            ));
        }
    };
    match write_result {
        Ok(Some(Ok(()))) => InputWriteResolution::Committed,
        Ok(Some(Err(error))) => {
            if let Some(code) = classify_terminal_input_error(&error) {
                return InputWriteResolution::Rejected {
                    code,
                    error: error.into(),
                };
            }
            stop_terminal_generation_bounded(
                Arc::clone(&stop_operation),
                session_id,
                generation,
                "terminal input I/O failure",
                settle_timeout,
            )
            .await;
            InputWriteResolution::Ambiguous(error.into())
        }
        Ok(None) => InputWriteResolution::CancelledBeforeWrite,
        Err(error) => {
            stop_terminal_generation_bounded(
                stop_operation,
                session_id,
                generation,
                "terminal input task failure",
                settle_timeout,
            )
            .await;
            InputWriteResolution::Ambiguous(anyhow!("terminal input task failed: {error}"))
        }
    }
}

async fn terminate_and_settle_started_input_write<S>(
    stop_operation: Arc<S>,
    session_id: Uuid,
    generation: u64,
    write: &mut tokio::task::JoinHandle<Option<Result<(), CoreError>>>,
    trigger: &'static str,
    settle_timeout: Duration,
) where
    S: Fn() -> Result<(), CoreError> + Send + Sync + 'static,
{
    stop_terminal_generation_bounded(
        stop_operation,
        session_id,
        generation,
        trigger,
        settle_timeout,
    )
    .await;
    if tokio::time::timeout(settle_timeout, write).await.is_err() {
        // The generation is quarantined by the caller before its input mutex is released. A
        // detached OS write can therefore never authorize a retry, even if a broken PTY driver
        // fails to wake after process termination.
        tracing::error!(
            session_id = %session_id,
            generation,
            trigger,
            "terminal input write did not settle after generation termination"
        );
    }
}

async fn stop_terminal_generation_bounded<S>(
    stop_operation: Arc<S>,
    session_id: Uuid,
    generation: u64,
    trigger: &'static str,
    settle_timeout: Duration,
) where
    S: Fn() -> Result<(), CoreError> + Send + Sync + 'static,
{
    let stop = tokio::task::spawn_blocking(move || stop_operation());
    match tokio::time::timeout(settle_timeout, stop).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => tracing::warn!(
            error = %error,
            session_id = %session_id,
            generation,
            trigger,
            "terminal generation stop was rejected"
        ),
        Ok(Err(error)) => tracing::error!(
            error = %error,
            session_id = %session_id,
            generation,
            trigger,
            "terminal generation stop task failed"
        ),
        Err(_) => tracing::error!(
            session_id = %session_id,
            generation,
            trigger,
            "terminal generation stop exceeded its deadline"
        ),
    }
}

fn try_start_terminal_input_write(state: &AtomicU8) -> bool {
    state
        .compare_exchange(
            INPUT_WRITE_QUEUED,
            INPUT_WRITE_STARTED,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
}

fn cancel_terminal_input_write_if_queued(state: &AtomicU8) -> bool {
    state
        .compare_exchange(
            INPUT_WRITE_QUEUED,
            INPUT_WRITE_CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
}

fn classify_terminal_input_error(error: &CoreError) -> Option<TerminalInputFaultCode> {
    match error {
        CoreError::SessionNotFound(_) => Some(TerminalInputFaultCode::NotFound),
        CoreError::SessionExited(_) => Some(TerminalInputFaultCode::SessionExited),
        CoreError::GenerationMismatch { .. } => Some(TerminalInputFaultCode::GenerationChanged),
        CoreError::TerminalInputTooLarge { .. } => Some(TerminalInputFaultCode::Conflict),
        _ => None,
    }
}

fn plan_input(input: &InputState, offset: u64, data: &[u8]) -> anyhow::Result<InputPlan> {
    let end = offset
        .checked_add(data.len() as u64)
        .context("terminal input offset overflow")?;
    if end <= input.through {
        if data.is_empty() {
            return Ok(InputPlan::Duplicate);
        }
        if offset < input.retained_from {
            return Ok(InputPlan::OverlapMismatch);
        }
        let retained_start = (offset - input.retained_from) as usize;
        return Ok(
            if input
                .retained
                .get(retained_start..retained_start + data.len())
                == Some(data)
            {
                InputPlan::Duplicate
            } else {
                InputPlan::OverlapMismatch
            },
        );
    }
    if offset > input.through {
        return Ok(InputPlan::Gap);
    }
    if offset == input.through {
        return Ok(InputPlan::Write {
            from: 0,
            through: end,
        });
    }
    if offset < input.retained_from {
        return Ok(InputPlan::OverlapMismatch);
    }
    let overlap = (input.through - offset) as usize;
    let retained_start = (offset - input.retained_from) as usize;
    if input.retained.get(retained_start..retained_start + overlap) != data.get(..overlap) {
        return Ok(InputPlan::OverlapMismatch);
    }
    Ok(InputPlan::Write {
        from: overlap,
        through: end,
    })
}

fn record_verified_input(input: &mut InputState, suffix: &[u8], through: u64) {
    input.retained.extend_from_slice(suffix);
    input.through = through;
    if input.retained.len() > INPUT_HISTORY_BYTES {
        let trim = input.retained.len() - INPUT_HISTORY_BYTES;
        input.retained.drain(..trim);
        input.retained_from = input.retained_from.saturating_add(trim as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_ids_never_use_zero() {
        let backend = CoreTerminalBackend::new(TerminalConfig {
            replay_bytes: 64 * 1024,
            outbound_queue: 8,
        })
        .unwrap();
        let maps = StreamMaps::default();
        assert_ne!(backend.allocate_stream_id(&maps).unwrap(), 0);
    }

    #[test]
    fn replacing_a_generation_removes_the_stale_stream_binding() {
        let backend = CoreTerminalBackend::new(TerminalConfig {
            replay_bytes: 64 * 1024,
            outbound_queue: 8,
        })
        .unwrap();
        let session_id = Uuid::new_v4();
        let info = |generation| TerminalSessionInfo {
            session_id,
            generation,
            kind: linco_protocol::SessionKind::Shell,
            cwd: std::path::PathBuf::from("."),
            process_id: None,
            created_at_ms: generation,
            output: linco_core::RingRange {
                available_from: 0,
                end: 0,
            },
            state: linco_core::TerminalSessionState::Running,
        };
        let first = backend.bind(&info(1)).unwrap();
        let second = backend.bind(&info(2)).unwrap();

        assert_ne!(first, second);
        assert!(backend.binding(first).is_err());
        assert_eq!(backend.stream_for_session(session_id, 1), None);
        assert_eq!(backend.stream_for_session(session_id, 2), Some(second));
    }

    #[test]
    fn overlapping_resend_verifies_prefix_and_writes_only_suffix() {
        let input = InputState {
            through: 5,
            retained_from: 0,
            retained: b"hello".to_vec(),
            ambiguous: false,
        };
        assert_eq!(
            plan_input(&input, 3, b"lo world").unwrap(),
            InputPlan::Write {
                from: 2,
                through: 11
            }
        );
        assert_eq!(
            plan_input(&input, 3, b"xx world").unwrap(),
            InputPlan::OverlapMismatch
        );
        assert_eq!(plan_input(&input, 1, b"ell").unwrap(), InputPlan::Duplicate);
        assert_eq!(
            plan_input(&input, 1, b"ELL").unwrap(),
            InputPlan::OverlapMismatch
        );
        assert_eq!(plan_input(&input, 8, b"later").unwrap(), InputPlan::Gap);

        let truncated = InputState {
            through: 10,
            retained_from: 5,
            retained: b"world".to_vec(),
            ambiguous: false,
        };
        assert_eq!(
            plan_input(&truncated, 0, b"hello").unwrap(),
            InputPlan::OverlapMismatch
        );
    }

    #[test]
    fn duplicate_verification_retains_the_mobile_ledgers_full_megabyte() {
        let chunk = vec![0x5a; TERMINAL_CHUNK_BYTES];
        let mut input = InputState::default();
        for index in 0..4_u64 {
            record_verified_input(
                &mut input,
                &chunk,
                (index + 1) * TERMINAL_CHUNK_BYTES as u64,
            );
        }
        assert!(input.retained.len() > 64 * 1024);
        assert_eq!(plan_input(&input, 0, &chunk).unwrap(), InputPlan::Duplicate);

        for index in 4..34_u64 {
            record_verified_input(
                &mut input,
                &chunk,
                (index + 1) * TERMINAL_CHUNK_BYTES as u64,
            );
        }
        assert_eq!(input.retained.len(), INPUT_HISTORY_BYTES);
        assert_eq!(input.retained_from, 2 * TERMINAL_CHUNK_BYTES as u64);
        assert_eq!(
            plan_input(&input, input.retained_from, &chunk).unwrap(),
            InputPlan::Duplicate
        );
        assert_eq!(
            plan_input(&input, 0, &chunk).unwrap(),
            InputPlan::OverlapMismatch
        );
    }

    #[tokio::test]
    async fn resume_reads_the_authoritative_cursor_after_an_owned_commit() {
        let backend = CoreTerminalBackend::new(TerminalConfig {
            replay_bytes: 64 * 1024,
            outbound_queue: 8,
        })
        .unwrap();
        let session_id = Uuid::new_v4();
        let generation = 11;
        let stream_id = backend
            .bind(&TerminalSessionInfo {
                session_id,
                generation,
                kind: linco_protocol::SessionKind::Shell,
                cwd: std::path::PathBuf::from("."),
                process_id: None,
                created_at_ms: 1,
                output: linco_core::RingRange {
                    available_from: 0,
                    end: 0,
                },
                state: linco_core::TerminalSessionState::Running,
            })
            .unwrap();
        let binding = backend.binding(stream_id).unwrap();
        let applied =
            spawn_owned_input_transaction(binding.clone(), 0, b"hello".to_vec(), |_| async {
                InputWriteResolution::Committed
            })
            .await
            .unwrap()
            .unwrap();

        assert_eq!(applied, InputApply::Applied { through: 5 });
        assert_eq!(
            backend.input_through(stream_id, generation).await.unwrap(),
            5
        );

        binding.input.lock().await.ambiguous = true;
        assert!(backend.input_through(stream_id, generation).await.is_err());
    }

    #[test]
    fn pre_write_terminal_failures_are_permanent_stream_faults() {
        let session_id = Uuid::new_v4();
        assert_eq!(
            classify_terminal_input_error(&CoreError::SessionNotFound(session_id)),
            Some(TerminalInputFaultCode::NotFound)
        );
        assert_eq!(
            classify_terminal_input_error(&CoreError::SessionExited(session_id)),
            Some(TerminalInputFaultCode::SessionExited)
        );
        assert_eq!(
            classify_terminal_input_error(&CoreError::GenerationMismatch {
                session_id,
                expected: 4,
                current: 5,
            }),
            Some(TerminalInputFaultCode::GenerationChanged)
        );
    }

    #[test]
    fn cancelled_blocking_write_cannot_start_when_scheduled_later() {
        let state = AtomicU8::new(INPUT_WRITE_QUEUED);
        assert!(cancel_terminal_input_write_if_queued(&state));
        assert!(!try_start_terminal_input_write(&state));
        assert_eq!(state.load(Ordering::Acquire), INPUT_WRITE_CANCELLED);
    }

    #[tokio::test]
    async fn cancelled_transaction_queued_behind_mutex_is_a_definitive_noop() {
        let binding = Arc::new(StreamBinding {
            stream_id: 13,
            session_id: Uuid::new_v4(),
            generation: 8,
            input: Mutex::new(InputState::default()),
        });
        let first_started = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());
        let first = spawn_owned_input_transaction(Arc::clone(&binding), 0, b"a".to_vec(), {
            let first_started = Arc::clone(&first_started);
            let release_first = Arc::clone(&release_first);
            move |_| async move {
                first_started.notify_one();
                release_first.notified().await;
                InputWriteResolution::Committed
            }
        });
        first_started.notified().await;

        let cancellation = CancellationToken::new();
        let stopped = Arc::new(AtomicBool::new(false));
        let second = spawn_owned_input_transaction(Arc::clone(&binding), 1, b"b".to_vec(), {
            let cancellation = cancellation.clone();
            let stopped = Arc::clone(&stopped);
            move |_| async move {
                if cancellation.is_cancelled() {
                    InputWriteResolution::CancelledBeforeWrite
                } else {
                    stopped.store(true, Ordering::Release);
                    InputWriteResolution::Ambiguous(anyhow!(
                        "queued transaction unexpectedly reached its writer"
                    ))
                }
            }
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        release_first.notify_one();

        assert_eq!(
            first.await.unwrap().unwrap(),
            InputApply::Applied { through: 1 }
        );
        assert_eq!(
            second.await.unwrap().unwrap(),
            InputApply::Cancelled { through: 1 }
        );
        assert!(!stopped.load(Ordering::Acquire));

        let third =
            spawn_owned_input_transaction(Arc::clone(&binding), 1, b"c".to_vec(), |_| async {
                InputWriteResolution::Committed
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(third, InputApply::Applied { through: 2 });
        let input = binding.input.lock().await;
        assert!(!input.ambiguous);
        assert_eq!(input.through, 2);
        assert_eq!(input.retained, b"ac");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn input_watchdog_bounds_started_write_and_releases_input_mutex() {
        let binding = Arc::new(StreamBinding {
            stream_id: 21,
            session_id: Uuid::new_v4(),
            generation: 12,
            input: Mutex::new(InputState::default()),
        });
        let session_id = binding.session_id;
        let generation = binding.generation;
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let started_at = std::time::Instant::now();
        let transaction =
            spawn_owned_input_transaction(Arc::clone(&binding), 0, b"blocked".to_vec(), {
                let stopped = Arc::clone(&stopped);
                move |_| async move {
                    run_terminal_input_write(
                        move || {
                            let _ = release_receiver.recv();
                            Ok(())
                        },
                        move || {
                            stopped.store(true, Ordering::Release);
                            let _ = release_sender.send(());
                            Ok(())
                        },
                        session_id,
                        generation,
                        CancellationToken::new(),
                        Duration::from_millis(50),
                        Duration::from_millis(500),
                    )
                    .await
                }
            });
        assert_eq!(
            transaction.await.unwrap().unwrap(),
            InputApply::Ambiguous { through: 0 }
        );
        assert!(stopped.load(Ordering::Acquire));
        assert!(started_at.elapsed() < Duration::from_secs(2));

        let input = tokio::time::timeout(Duration::from_millis(100), binding.input.lock())
            .await
            .expect("input mutex remained held after the watchdog");
        assert!(input.ambiguous);
        assert_eq!(input.through, 0);
    }

    #[test]
    fn queued_overload_is_zero_write_and_multiframe_replay_is_exactly_once() {
        use std::sync::atomic::AtomicUsize;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (blocker_started_sender, blocker_started_receiver) = std::sync::mpsc::channel();
            let (release_blocker_sender, release_blocker_receiver) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = blocker_started_sender.send(());
                let _ = release_blocker_receiver.recv();
            });
            blocker_started_receiver.recv().unwrap();

            let binding = Arc::new(StreamBinding {
                stream_id: 34,
                session_id: Uuid::new_v4(),
                generation: 15,
                input: Mutex::new(InputState::default()),
            });
            let session_id = binding.session_id;
            let generation = binding.generation;
            let writes = Arc::new(AtomicUsize::new(0));
            let stopped = Arc::new(AtomicBool::new(false));
            let first_frame = vec![b'a'; TERMINAL_CHUNK_BYTES];
            let second_frame = vec![b'b'; TERMINAL_CHUNK_BYTES];
            let overloaded =
                spawn_owned_input_transaction(Arc::clone(&binding), 0, first_frame.clone(), {
                    let writes = Arc::clone(&writes);
                    let stopped = Arc::clone(&stopped);
                    move |_| async move {
                        run_terminal_input_write(
                            move || {
                                writes.fetch_add(1, Ordering::AcqRel);
                                Ok(())
                            },
                            move || {
                                stopped.store(true, Ordering::Release);
                                Ok(())
                            },
                            session_id,
                            generation,
                            CancellationToken::new(),
                            Duration::from_millis(50),
                            Duration::from_millis(500),
                        )
                        .await
                    }
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                overloaded,
                InputApply::Rejected {
                    through: 0,
                    code: TerminalInputFaultCode::Overloaded,
                }
            );
            assert_eq!(writes.load(Ordering::Acquire), 0);
            assert!(!stopped.load(Ordering::Acquire));
            {
                let input = binding.input.lock().await;
                assert_eq!(input.through, 0);
                assert!(!input.ambiguous);
                assert!(input.retained.is_empty());
            }

            // Closing the old lane means its already-buffered second frame is never handed to
            // apply_input. Even when Tokio later schedules the first frame's blocking closure,
            // the CANCELLED gate keeps it a definitive zero-byte write.
            let _ = release_blocker_sender.send(());
            blocker.await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(writes.load(Ordering::Acquire), 0);

            let replayed_first =
                spawn_owned_input_transaction(Arc::clone(&binding), 0, first_frame.clone(), {
                    let writes = Arc::clone(&writes);
                    move |_| async move {
                        writes.fetch_add(1, Ordering::AcqRel);
                        InputWriteResolution::Committed
                    }
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                replayed_first,
                InputApply::Applied {
                    through: TERMINAL_CHUNK_BYTES as u64,
                }
            );
            let replayed_second = spawn_owned_input_transaction(
                Arc::clone(&binding),
                TERMINAL_CHUNK_BYTES as u64,
                second_frame.clone(),
                {
                    let writes = Arc::clone(&writes);
                    move |_| async move {
                        writes.fetch_add(1, Ordering::AcqRel);
                        InputWriteResolution::Committed
                    }
                },
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(
                replayed_second,
                InputApply::Applied {
                    through: (2 * TERMINAL_CHUNK_BYTES) as u64,
                }
            );
            assert_eq!(writes.load(Ordering::Acquire), 2);
            let input = binding.input.lock().await;
            assert!(!input.ambiguous);
            assert_eq!(input.through, (2 * TERMINAL_CHUNK_BYTES) as u64);
            assert_eq!(input.retained.len(), 2 * TERMINAL_CHUNK_BYTES);
            assert_eq!(&input.retained[..TERMINAL_CHUNK_BYTES], first_frame);
            assert_eq!(&input.retained[TERMINAL_CHUNK_BYTES..], second_frame);
        });
    }

    #[cfg(not(windows))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn input_watchdog_bounds_nonreading_real_pty_and_unblocks_resume() {
        let temp = tempfile::tempdir().unwrap();
        let backend = CoreTerminalBackend::new(TerminalConfig {
            replay_bytes: 64 * 1024,
            outbound_queue: 8,
        })
        .unwrap();
        let (info, stream_id) = backend
            .start(TerminalStart {
                session_id: Uuid::new_v4(),
                kind: linco_protocol::SessionKind::Shell,
                workspace: linco_core::WorkspaceRoot::open(temp.path()).unwrap(),
                relative_cwd: std::path::PathBuf::new(),
                size: TerminalSize::default(),
                environment: std::collections::BTreeMap::new(),
                agent_arguments: Vec::new(),
            })
            .await
            .unwrap();

        #[cfg(windows)]
        let nonreading_command = b"ping -n 30 127.0.0.1 >NUL\r\n".to_vec();
        #[cfg(not(windows))]
        let nonreading_command = b"sleep 30\n".to_vec();
        let command_end = nonreading_command.len() as u64;
        assert_eq!(
            backend
                .apply_input(stream_id, info.generation, 0, nonreading_command)
                .await
                .unwrap(),
            InputApply::Applied {
                through: command_end
            }
        );
        tokio::time::sleep(Duration::from_millis(150)).await;

        let ambiguous = tokio::time::timeout(Duration::from_secs(12), async {
            let chunk = vec![b'x'; TERMINAL_CHUNK_BYTES];
            let mut offset = command_end;
            for _ in 0..32 {
                match backend
                    .apply_input(stream_id, info.generation, offset, chunk.clone())
                    .await
                    .unwrap()
                {
                    InputApply::Applied { through } => offset = through,
                    InputApply::Ambiguous { through } => return through,
                    other => panic!("unexpected real PTY input result: {other:?}"),
                }
            }
            panic!("real non-reading PTY accepted 1 MiB without exercising the watchdog")
        })
        .await
        .expect("terminal input watchdog did not bound the blocked PTY write");
        assert!(ambiguous >= command_end);

        let resumed = tokio::time::timeout(
            Duration::from_secs(1),
            backend.input_through(stream_id, info.generation),
        )
        .await
        .expect("resume remained blocked behind the timed-out input transaction");
        assert!(resumed.is_err(), "ambiguous generation must not resume");
        backend.shutdown().await;
    }

    #[tokio::test]
    async fn revoked_large_paste_cannot_be_rewritten_by_a_second_device() {
        use std::sync::atomic::AtomicUsize;

        let chunk = vec![0x61; TERMINAL_CHUNK_BYTES];
        let binding = Arc::new(StreamBinding {
            stream_id: 9,
            session_id: Uuid::new_v4(),
            generation: 4,
            input: Mutex::new(InputState::default()),
        });
        {
            let mut input = binding.input.lock().await;
            for index in 0..3_u64 {
                record_verified_input(
                    &mut input,
                    &chunk,
                    (index + 1) * TERMINAL_CHUNK_BYTES as u64,
                );
            }
        }

        let cancellation = CancellationToken::new();
        let started = Arc::new(tokio::sync::Notify::new());
        let possibly_delivered = Arc::new(AtomicUsize::new(0));
        let generation_stopped = Arc::new(AtomicBool::new(false));
        let first = spawn_owned_input_transaction(
            Arc::clone(&binding),
            3 * TERMINAL_CHUNK_BYTES as u64,
            chunk.clone(),
            {
                let cancellation = cancellation.clone();
                let started = Arc::clone(&started);
                let possibly_delivered = Arc::clone(&possibly_delivered);
                let generation_stopped = Arc::clone(&generation_stopped);
                move |suffix| async move {
                    // Model write_all having delivered an unknown prefix before the revoked
                    // connection drops its waiter.
                    possibly_delivered.fetch_add(suffix.len(), Ordering::AcqRel);
                    started.notify_one();
                    cancellation.cancelled().await;
                    generation_stopped.store(true, Ordering::Release);
                    InputWriteResolution::Ambiguous(anyhow!("revoked during PTY write"))
                }
            },
        );
        let cancellation_guard = CancelInputOnDrop::new(cancellation);
        started.notified().await;
        drop(first);
        drop(cancellation_guard);

        let retry_writer_called = Arc::new(AtomicBool::new(false));
        let retry = spawn_owned_input_transaction(
            Arc::clone(&binding),
            3 * TERMINAL_CHUNK_BYTES as u64,
            chunk,
            {
                let retry_writer_called = Arc::clone(&retry_writer_called);
                move |_| async move {
                    retry_writer_called.store(true, Ordering::Release);
                    InputWriteResolution::Committed
                }
            },
        )
        .await
        .unwrap()
        .unwrap();

        assert!(matches!(retry, InputApply::Ambiguous { .. }));
        assert!(generation_stopped.load(Ordering::Acquire));
        assert!(!retry_writer_called.load(Ordering::Acquire));
        assert_eq!(
            possibly_delivered.load(Ordering::Acquire),
            TERMINAL_CHUNK_BYTES
        );
        let input = binding.input.lock().await;
        assert!(input.ambiguous);
        assert_eq!(input.through, 3 * TERMINAL_CHUNK_BYTES as u64);
    }
}
