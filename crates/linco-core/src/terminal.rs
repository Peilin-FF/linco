use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Weak};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use linco_protocol::SessionKind;
use parking_lot::{Mutex, RwLock};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use uuid::Uuid;

use crate::{ByteRing, CoreError, RingRange, RingReplayError, WorkspaceRoot};

const PROTOCOL_MAX_TERMINAL_CHUNK: usize = 32 * 1024;

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    /// Replay retained independently for every session generation.
    pub ring_capacity_bytes: usize,
    /// Maximum bytes returned by a single blocking PTY read and live output event.
    pub read_chunk_bytes: usize,
    pub max_input_bytes: usize,
    pub max_sessions: usize,
    pub max_live_processes: usize,
    pub max_subscribers: usize,
    pub subscriber_queue_events: usize,
    pub shell_program: Option<PathBuf>,
    pub claude_program: PathBuf,
    pub codex_program: PathBuf,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            ring_capacity_bytes: 8 * 1024 * 1024,
            read_chunk_bytes: PROTOCOL_MAX_TERMINAL_CHUNK,
            max_input_bytes: PROTOCOL_MAX_TERMINAL_CHUNK,
            max_sessions: 128,
            max_live_processes: 128,
            max_subscribers: 32,
            subscriber_queue_events: 64,
            shell_program: None,
            claude_program: PathBuf::from("claude"),
            codex_program: PathBuf::from("codex"),
        }
    }
}

impl TerminalConfig {
    fn validate(&self) -> Result<(), CoreError> {
        if self.read_chunk_bytes == 0 || self.read_chunk_bytes > PROTOCOL_MAX_TERMINAL_CHUNK {
            return Err(CoreError::InvalidTerminalConfig(
                "read_chunk_bytes must be in 1..=32768",
            ));
        }
        if self.ring_capacity_bytes < self.read_chunk_bytes {
            return Err(CoreError::InvalidTerminalConfig(
                "ring_capacity_bytes must be at least read_chunk_bytes",
            ));
        }
        if self.max_input_bytes == 0 || self.max_input_bytes > PROTOCOL_MAX_TERMINAL_CHUNK {
            return Err(CoreError::InvalidTerminalConfig(
                "max_input_bytes must be in 1..=32768",
            ));
        }
        if self.max_sessions == 0
            || self.max_live_processes == 0
            || self.max_subscribers == 0
            || self.subscriber_queue_events == 0
        {
            return Err(CoreError::InvalidTerminalConfig(
                "session, process, subscriber and queue limits must be non-zero",
            ));
        }
        if self.claude_program.as_os_str().is_empty() || self.codex_program.as_os_str().is_empty() {
            return Err(CoreError::InvalidTerminalConfig(
                "agent program paths must be non-empty",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub columns: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            rows: 24,
            columns: 80,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

impl TerminalSize {
    fn validate(self) -> Result<Self, CoreError> {
        if self.rows == 0 || self.columns == 0 {
            return Err(CoreError::InvalidTerminalSize);
        }
        Ok(self)
    }

    fn as_pty(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.columns,
            pixel_width: self.pixel_width,
            pixel_height: self.pixel_height,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TerminalStart {
    pub session_id: Uuid,
    pub kind: SessionKind,
    pub workspace: WorkspaceRoot,
    /// A workspace-relative directory. Absolute paths and `..` are rejected.
    pub relative_cwd: PathBuf,
    pub size: TerminalSize,
    pub environment: BTreeMap<String, String>,
    /// Passed directly to Claude or Codex. Shell sessions reject this field.
    pub agent_arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionExit {
    pub exit_code: Option<u32>,
    pub success: bool,
    pub io_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalSessionState {
    Running,
    Exited(SessionExit),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSessionInfo {
    pub session_id: Uuid,
    pub generation: u64,
    pub kind: SessionKind,
    pub cwd: PathBuf,
    pub process_id: Option<u32>,
    pub created_at_ms: u64,
    pub output: RingRange,
    pub state: TerminalSessionState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Output {
        session_id: Uuid,
        generation: u64,
        offset: u64,
        /// Unmodified PTY bytes. Transport adapters must not base64-encode this field.
        data: Bytes,
    },
    Exited {
        session_id: Uuid,
        generation: u64,
        exit: SessionExit,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalReplay {
    pub session_id: Uuid,
    pub generation: u64,
    pub requested_offset: u64,
    pub next_offset: u64,
    pub range: RingRange,
    pub data: Bytes,
}

pub struct TerminalSubscription {
    id: u64,
    owner: Weak<Inner>,
    receiver: mpsc::Receiver<TerminalEvent>,
    filter: Option<TerminalSubscriptionFilter>,
}

impl TerminalSubscription {
    pub fn recv(&self) -> Result<TerminalEvent, mpsc::RecvError> {
        loop {
            let event = self.receiver.recv()?;
            if self.accepts(&event) {
                return Ok(event);
            }
        }
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<TerminalEvent, mpsc::RecvTimeoutError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let event = self.receiver.recv_timeout(remaining)?;
            if self.accepts(&event) {
                return Ok(event);
            }
        }
    }

    pub fn try_recv(&self) -> Result<TerminalEvent, mpsc::TryRecvError> {
        loop {
            let event = self.receiver.try_recv()?;
            if self.accepts(&event) {
                return Ok(event);
            }
        }
    }

    fn accepts(&self, event: &TerminalEvent) -> bool {
        self.filter
            .as_ref()
            .is_none_or(|filter| filter.accepts(event))
    }
}

/// A connection-owned, dynamically updateable allow-list for live terminal events.
///
/// Filtering happens before the subscriber's bounded queue, so output from an unselected PTY
/// cannot evict notifications for the terminal currently visible to a client. Updating the set
/// only takes an in-memory lock and never waits on terminal I/O or a network writer.
#[derive(Debug, Clone, Default)]
pub struct TerminalSubscriptionFilter {
    selected: Arc<RwLock<HashSet<(Uuid, u64)>>>,
}

impl TerminalSubscriptionFilter {
    pub fn select(&self, session_id: Uuid, generation: u64) {
        self.selected.write().insert((session_id, generation));
    }

    pub fn deselect(&self, session_id: Uuid, generation: u64) -> bool {
        self.selected.write().remove(&(session_id, generation))
    }

    pub fn clear(&self) {
        self.selected.write().clear();
    }

    fn accepts(&self, event: &TerminalEvent) -> bool {
        let identity = match event {
            TerminalEvent::Output {
                session_id,
                generation,
                ..
            }
            | TerminalEvent::Exited {
                session_id,
                generation,
                ..
            } => (*session_id, *generation),
        };
        self.selected.read().contains(&identity)
    }
}

impl Drop for TerminalSubscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner.subscribers.lock().remove(&self.id);
        }
    }
}

pub struct TerminalManager {
    inner: Arc<Inner>,
}

impl Clone for TerminalManager {
    fn clone(&self) -> Self {
        self.inner.manager_handles.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

struct Inner {
    config: TerminalConfig,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    start_lock: Mutex<()>,
    next_generation: AtomicU64,
    subscribers: Mutex<HashMap<u64, EventSubscriber>>,
    next_subscriber: AtomicU64,
    manager_handles: AtomicUsize,
    live_processes: Arc<AtomicUsize>,
    shutting_down: AtomicBool,
}

struct EventSubscriber {
    sender: mpsc::SyncSender<TerminalEvent>,
    filter: Option<TerminalSubscriptionFilter>,
}

struct Session {
    id: Uuid,
    generation: u64,
    kind: SessionKind,
    cwd: PathBuf,
    process_id: Option<u32>,
    created_at_ms: u64,
    start_identity: StartIdentity,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    ring: Mutex<ByteRing>,
    state: Mutex<TerminalSessionState>,
    active: AtomicBool,
    exit_published: AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StartIdentity {
    kind: SessionKind,
    cwd: PathBuf,
    size: TerminalSize,
    environment: BTreeMap<String, String>,
    agent_arguments: Vec<String>,
}

struct ProcessPermit {
    counter: Arc<AtomicUsize>,
}

impl Drop for ProcessPermit {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::AcqRel);
    }
}

impl TerminalManager {
    pub fn new(config: TerminalConfig) -> Result<Self, CoreError> {
        config.validate()?;
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                sessions: RwLock::new(HashMap::new()),
                start_lock: Mutex::new(()),
                next_generation: AtomicU64::new(1),
                subscribers: Mutex::new(HashMap::new()),
                next_subscriber: AtomicU64::new(1),
                manager_handles: AtomicUsize::new(1),
                live_processes: Arc::new(AtomicUsize::new(0)),
                shutting_down: AtomicBool::new(false),
            }),
        })
    }

    /// Creates a bounded, best-effort live event subscription.
    ///
    /// PTY draining never blocks on this queue. If a subscriber falls behind, output events are
    /// dropped for that subscriber and its next absolute offset reveals the gap; call `replay` to
    /// recover while bytes remain in the bounded session ring.
    pub fn subscribe(&self) -> Result<TerminalSubscription, CoreError> {
        self.subscribe_with_filter(None)
    }

    /// Creates a bounded live subscription whose selected session generations can change at
    /// runtime. Unselected events are discarded before occupying queue capacity.
    pub fn subscribe_filtered(
        &self,
        filter: TerminalSubscriptionFilter,
    ) -> Result<TerminalSubscription, CoreError> {
        self.subscribe_with_filter(Some(filter))
    }

    fn subscribe_with_filter(
        &self,
        filter: Option<TerminalSubscriptionFilter>,
    ) -> Result<TerminalSubscription, CoreError> {
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown);
        }
        let mut subscribers = self.inner.subscribers.lock();
        if subscribers.len() >= self.inner.config.max_subscribers {
            return Err(CoreError::SubscriberLimit(
                self.inner.config.max_subscribers,
            ));
        }
        let id = self.inner.next_subscriber.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::sync_channel(self.inner.config.subscriber_queue_events);
        subscribers.insert(
            id,
            EventSubscriber {
                sender,
                filter: filter.clone(),
            },
        );
        Ok(TerminalSubscription {
            id,
            owner: Arc::downgrade(&self.inner),
            receiver,
            filter,
        })
    }

    pub fn start(&self, request: TerminalStart) -> Result<TerminalSessionInfo, CoreError> {
        let _start_guard = self.inner.start_lock.lock();
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err(CoreError::ShuttingDown);
        }
        request.size.validate()?;
        if request.kind == SessionKind::Shell && !request.agent_arguments.is_empty() {
            return Err(CoreError::ShellArgumentsNotAllowed);
        }
        validate_environment(&request.environment)?;
        let cwd = request
            .workspace
            .resolve_existing_dir(&request.relative_cwd)?;
        let start_identity = StartIdentity {
            kind: request.kind,
            cwd: cwd.clone(),
            size: request.size,
            environment: request.environment.clone(),
            agent_arguments: request.agent_arguments.clone(),
        };

        {
            let mut sessions = self.inner.sessions.write();
            if let Some(existing) = sessions.get(&request.session_id) {
                return if existing.start_identity == start_identity {
                    Ok(existing.info())
                } else {
                    Err(CoreError::SessionIdentityConflict(request.session_id))
                };
            }
            if sessions.len() >= self.inner.config.max_sessions {
                prune_oldest_exited(&mut sessions);
            }
            if sessions.len() >= self.inner.config.max_sessions {
                return Err(CoreError::SessionLimit(self.inner.config.max_sessions));
            }
        }
        // Allocate the generation before spawning so exhaustion can never leave an untracked
        // child process behind. Gaps caused by a later spawn failure are intentional and safe.
        let generation = self.inner.next_generation()?;
        let permit = self.inner.reserve_process()?;

        let pty = portable_pty::native_pty_system();
        let pair = pty
            .openpty(request.size.as_pty())
            .map_err(|error| CoreError::Pty {
                operation: "open",
                message: error.to_string(),
            })?;
        let command = build_command(&self.inner.config, &request, &cwd)?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| CoreError::Pty {
                operation: "spawn",
                message: error.to_string(),
            })?;
        drop(pair.slave);

        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::Pty {
                    operation: "clone reader",
                    message: error.to_string(),
                });
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::Pty {
                    operation: "take writer",
                    message: error.to_string(),
                });
            }
        };
        let killer = child.clone_killer();
        let process_id = child.process_id();
        let session = Arc::new(Session {
            id: request.session_id,
            generation,
            kind: request.kind,
            cwd,
            process_id,
            created_at_ms: unix_time_ms(),
            start_identity,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(killer),
            ring: Mutex::new(
                ByteRing::new(self.inner.config.ring_capacity_bytes)
                    .expect("validated non-zero ring capacity"),
            ),
            state: Mutex::new(TerminalSessionState::Running),
            active: AtomicBool::new(false),
            exit_published: AtomicBool::new(false),
        });

        spawn_session_threads(
            Arc::downgrade(&self.inner),
            Arc::clone(&session),
            reader,
            child,
            permit,
            self.inner.config.read_chunk_bytes,
        )?;
        let old = self
            .inner
            .sessions
            .write()
            .insert(request.session_id, Arc::clone(&session));
        debug_assert!(
            old.is_none(),
            "start_lock must make session insertion unique"
        );
        session.activate(&self.inner);
        Ok(session.info())
    }

    pub fn write(
        &self,
        session_id: Uuid,
        expected_generation: u64,
        data: &[u8],
    ) -> Result<(), CoreError> {
        if data.len() > self.inner.config.max_input_bytes {
            return Err(CoreError::TerminalInputTooLarge {
                actual: data.len(),
                maximum: self.inner.config.max_input_bytes,
            });
        }
        let session = self.inner.session(session_id, expected_generation)?;
        if matches!(*session.state.lock(), TerminalSessionState::Exited(_)) {
            return Err(CoreError::SessionExited(session_id));
        }
        if data.is_empty() {
            return Ok(());
        }
        let mut writer_guard = session.writer.lock();
        let writer = writer_guard
            .as_mut()
            .ok_or(CoreError::SessionExited(session_id))?;
        writer.write_all(data).map_err(|source| CoreError::Io {
            operation: "write terminal input",
            source,
        })?;
        writer.flush().map_err(|source| CoreError::Io {
            operation: "flush terminal input",
            source,
        })
    }

    pub fn resize(
        &self,
        session_id: Uuid,
        expected_generation: u64,
        size: TerminalSize,
    ) -> Result<(), CoreError> {
        let size = size.validate()?;
        let session = self.inner.session(session_id, expected_generation)?;
        if matches!(*session.state.lock(), TerminalSessionState::Exited(_)) {
            return Err(CoreError::SessionExited(session_id));
        }
        let master_guard = session.master.lock();
        let master = master_guard
            .as_ref()
            .ok_or(CoreError::SessionExited(session_id))?;
        master
            .resize(size.as_pty())
            .map_err(|error| CoreError::Pty {
                operation: "resize",
                message: error.to_string(),
            })
    }

    pub fn stop(&self, session_id: Uuid, expected_generation: u64) -> Result<(), CoreError> {
        let session = self.inner.session(session_id, expected_generation)?;
        if matches!(*session.state.lock(), TerminalSessionState::Exited(_)) {
            return Ok(());
        }
        session.kill().map_err(|source| CoreError::Io {
            operation: "stop terminal child",
            source,
        })
    }

    pub fn replay(
        &self,
        session_id: Uuid,
        expected_generation: u64,
        offset: u64,
        max_bytes: usize,
    ) -> Result<TerminalReplay, CoreError> {
        let session = self.inner.session(session_id, expected_generation)?;
        let replay = session.ring.lock().replay(offset, max_bytes)?;
        Ok(TerminalReplay {
            session_id,
            generation: expected_generation,
            requested_offset: replay.requested_offset,
            next_offset: replay.next_offset,
            range: replay.range,
            data: replay.data,
        })
    }

    /// Returns the oldest still-retained bytes, suitable for rebuilding a terminal after a replay
    /// gap. The returned `range.end` remains the authoritative stream end at snapshot time.
    pub fn snapshot(
        &self,
        session_id: Uuid,
        expected_generation: u64,
        max_bytes: usize,
    ) -> Result<TerminalReplay, CoreError> {
        let session = self.inner.session(session_id, expected_generation)?;
        let ring = session.ring.lock();
        let offset = ring.range().available_from;
        let replay = ring.replay(offset, max_bytes)?;
        Ok(TerminalReplay {
            session_id,
            generation: expected_generation,
            requested_offset: replay.requested_offset,
            next_offset: replay.next_offset,
            range: replay.range,
            data: replay.data,
        })
    }

    pub fn session_info(
        &self,
        session_id: Uuid,
        expected_generation: u64,
    ) -> Result<TerminalSessionInfo, CoreError> {
        Ok(self.inner.session(session_id, expected_generation)?.info())
    }

    pub fn list_sessions(&self) -> Vec<TerminalSessionInfo> {
        let mut sessions: Vec<_> = self
            .inner
            .sessions
            .read()
            .values()
            .map(|session| session.info())
            .collect();
        sessions.sort_by_key(|session| (session.created_at_ms, session.session_id));
        sessions
    }

    pub fn shutdown(&self) {
        if self.inner.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }
        // A start that passed its initial state check must finish registering the child before we
        // take the snapshot below. Conversely, new starts observe `shutting_down` after this lock.
        let _start_guard = self.inner.start_lock.lock();
        let sessions: Vec<_> = self.inner.sessions.read().values().cloned().collect();
        for session in sessions {
            let _ = session.kill();
        }
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if self.inner.manager_handles.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.shutdown();
        }
    }
}

impl Inner {
    fn next_generation(&self) -> Result<u64, CoreError> {
        self.next_generation
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| CoreError::GenerationExhausted)
    }

    fn session(&self, id: Uuid, expected_generation: u64) -> Result<Arc<Session>, CoreError> {
        let session = self
            .sessions
            .read()
            .get(&id)
            .cloned()
            .ok_or(CoreError::SessionNotFound(id))?;
        validate_generation(id, session.generation, expected_generation)?;
        Ok(session)
    }

    fn reserve_process(&self) -> Result<ProcessPermit, CoreError> {
        let mut current = self.live_processes.load(Ordering::Acquire);
        loop {
            if current >= self.config.max_live_processes {
                return Err(CoreError::ProcessLimit(self.config.max_live_processes));
            }
            match self.live_processes.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Ok(ProcessPermit {
                        counter: Arc::clone(&self.live_processes),
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }

    fn publish(&self, event: TerminalEvent) {
        let mut subscribers = self.subscribers.lock();
        subscribers.retain(|_, subscriber| {
            if subscriber
                .filter
                .as_ref()
                .is_some_and(|filter| !filter.accepts(&event))
            {
                return true;
            }
            match subscriber.sender.try_send(event.clone()) {
                Ok(()) | Err(mpsc::TrySendError::Full(_)) => true,
                Err(mpsc::TrySendError::Disconnected(_)) => false,
            }
        });
    }
}

impl Session {
    fn info(&self) -> TerminalSessionInfo {
        TerminalSessionInfo {
            session_id: self.id,
            generation: self.generation,
            kind: self.kind,
            cwd: self.cwd.clone(),
            process_id: self.process_id,
            created_at_ms: self.created_at_ms,
            output: self.ring.lock().range(),
            state: self.state.lock().clone(),
        }
    }

    fn kill(&self) -> std::io::Result<()> {
        self.killer.lock().kill()
    }

    /// Closing the control handles after the child is reaped is required for ConPTY to deliver
    /// EOF to the cloned reader. Buffered output remains readable from that clone.
    fn close_control_handles(&self) {
        self.writer.lock().take();
        self.master.lock().take();
    }

    fn activate(&self, owner: &Inner) {
        self.active.store(true, Ordering::Release);
        if let TerminalSessionState::Exited(exit) = self.state.lock().clone() {
            self.publish_exit_once(owner, exit);
        }
    }

    fn publish_exit_once(&self, owner: &Inner, exit: SessionExit) {
        if self.active.load(Ordering::Acquire) && !self.exit_published.swap(true, Ordering::AcqRel)
        {
            owner.publish(TerminalEvent::Exited {
                session_id: self.id,
                generation: self.generation,
                exit,
            });
        }
    }
}

fn spawn_session_threads(
    owner: Weak<Inner>,
    session: Arc<Session>,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    permit: ProcessPermit,
    read_chunk_bytes: usize,
) -> Result<(), CoreError> {
    let (exit_sender, exit_receiver) = mpsc::sync_channel(1);
    let session_name = session.id.to_string();
    let session_for_wait = Arc::clone(&session);
    let session_for_failure = Arc::clone(&session);
    let wait_result = thread::Builder::new()
        .name(format!("linco-pty-wait-{session_name}"))
        .spawn(move || {
            let _permit = permit;
            let status = child.wait();
            let _ = exit_sender.send(status);
            session_for_wait.close_control_handles();
        });
    if let Err(source) = wait_result {
        let _ = session_for_failure.kill();
        return Err(CoreError::Io {
            operation: "spawn PTY wait thread",
            source,
        });
    }

    let session_for_failure = Arc::clone(&session);
    let read_result = thread::Builder::new()
        .name(format!("linco-pty-read-{session_name}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; read_chunk_bytes];
            let mut io_error = None;
            let mut early_status = None;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        let bytes = Bytes::copy_from_slice(&buffer[..read]);
                        let offset = {
                            let mut ring = session.ring.lock();
                            match ring.append(bytes.clone()) {
                                Ok(offset) => offset,
                                Err(RingReplayError::OffsetOverflow) => {
                                    io_error = Some("terminal stream offset overflow".to_string());
                                    let _ = session.kill();
                                    break;
                                }
                                Err(_) => unreachable!("append only reports offset overflow"),
                            }
                        };
                        if session.active.load(Ordering::Acquire) {
                            if let Some(owner) = owner.upgrade() {
                                owner.publish(TerminalEvent::Output {
                                    session_id: session.id,
                                    generation: session.generation,
                                    offset,
                                    data: bytes,
                                });
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        match exit_receiver.try_recv() {
                            Ok(status) => early_status = Some(status.ok()),
                            Err(mpsc::TryRecvError::Empty) => {
                                io_error = Some(error.to_string());
                                let _ = session.kill();
                            }
                            Err(mpsc::TryRecvError::Disconnected) => {
                                io_error = Some(error.to_string());
                            }
                        }
                        break;
                    }
                }
            }

            let status = early_status.unwrap_or_else(|| {
                exit_receiver
                    .recv_timeout(Duration::from_secs(5))
                    .ok()
                    .and_then(Result::ok)
            });
            let exit = SessionExit {
                exit_code: status.as_ref().map(|value| value.exit_code()),
                success: status.as_ref().is_some_and(|value| value.success()),
                io_error,
            };
            *session.state.lock() = TerminalSessionState::Exited(exit.clone());
            if let Some(owner) = owner.upgrade() {
                session.publish_exit_once(&owner, exit);
            }
        });
    match read_result {
        Ok(_) => Ok(()),
        Err(source) => {
            let _ = session_for_failure.kill();
            Err(CoreError::Io {
                operation: "spawn PTY drain thread",
                source,
            })
        }
    }
}

fn build_command(
    config: &TerminalConfig,
    request: &TerminalStart,
    cwd: &std::path::Path,
) -> Result<CommandBuilder, CoreError> {
    let mut command = match request.kind {
        SessionKind::Shell => default_shell_command(config),
        SessionKind::Claude => {
            let mut command = CommandBuilder::new(&config.claude_program);
            command.args(&request.agent_arguments);
            command
        }
        SessionKind::Codex => {
            let mut command = CommandBuilder::new(&config.codex_program);
            command.args(&request.agent_arguments);
            command
        }
    };
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Linco");
    #[cfg(windows)]
    {
        command.env("PYTHONUTF8", "1");
        command.env("PYTHONIOENCODING", "utf-8");
    }
    for (key, value) in &request.environment {
        command.env(key, value);
    }
    Ok(command)
}

fn default_shell_command(config: &TerminalConfig) -> CommandBuilder {
    #[cfg(windows)]
    {
        let shell = config
            .shell_program
            .clone()
            .or_else(|| std::env::var_os("ComSpec").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("cmd.exe"));
        let mut command = CommandBuilder::new(shell);
        command.arg("/K");
        command.arg("chcp 65001>nul");
        command
    }

    #[cfg(not(windows))]
    {
        let shell = config
            .shell_program
            .clone()
            .or_else(|| std::env::var_os("SHELL").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        command
    }
}

fn validate_environment(environment: &BTreeMap<String, String>) -> Result<(), CoreError> {
    let valid = environment.iter().all(|(key, value)| {
        !key.is_empty() && !key.contains('=') && !key.contains('\0') && !value.contains('\0')
    });
    if valid {
        Ok(())
    } else {
        Err(CoreError::InvalidEnvironment)
    }
}

fn validate_generation(session_id: Uuid, current: u64, expected: u64) -> Result<(), CoreError> {
    if current == expected {
        Ok(())
    } else {
        Err(CoreError::GenerationMismatch {
            session_id,
            expected,
            current,
        })
    }
}

fn prune_oldest_exited(sessions: &mut HashMap<Uuid, Arc<Session>>) {
    let oldest = sessions
        .iter()
        .filter(|(_, session)| matches!(*session.state.lock(), TerminalSessionState::Exited(_)))
        .min_by_key(|(_, session)| (session.created_at_ms, session.generation))
        .map(|(id, _)| *id);
    if let Some(id) = oldest {
        sessions.remove(&id);
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_generation_is_rejected_without_touching_the_session() {
        let id = Uuid::new_v4();
        assert!(validate_generation(id, 9, 9).is_ok());
        assert!(matches!(
            validate_generation(id, 9, 8),
            Err(CoreError::GenerationMismatch {
                session_id,
                expected: 8,
                current: 9,
            }) if session_id == id
        ));
    }

    #[test]
    fn invalid_sizes_and_unbounded_buffers_are_rejected() {
        assert!(TerminalSize {
            rows: 0,
            ..TerminalSize::default()
        }
        .validate()
        .is_err());

        let config = TerminalConfig {
            read_chunk_bytes: PROTOCOL_MAX_TERMINAL_CHUNK + 1,
            ..TerminalConfig::default()
        };
        assert!(TerminalManager::new(config).is_err());
    }

    #[test]
    fn filtered_subscription_rejects_detached_flood_before_its_queue() {
        let active_session = Uuid::new_v4();
        let detached_session = Uuid::new_v4();
        let manager = TerminalManager::new(TerminalConfig {
            subscriber_queue_events: 1,
            ..TerminalConfig::default()
        })
        .unwrap();
        let filter = TerminalSubscriptionFilter::default();
        filter.select(active_session, 4);
        let subscription = manager.subscribe_filtered(filter.clone()).unwrap();

        for offset in 0..10_000 {
            manager.inner.publish(TerminalEvent::Output {
                session_id: detached_session,
                generation: 7,
                offset,
                data: Bytes::from_static(b"noise"),
            });
        }
        manager.inner.publish(TerminalEvent::Output {
            session_id: active_session,
            generation: 4,
            offset: 42,
            data: Bytes::from_static(b"active"),
        });

        assert!(matches!(
            subscription.try_recv(),
            Ok(TerminalEvent::Output {
                session_id,
                generation: 4,
                offset: 42,
                ..
            }) if session_id == active_session
        ));
        assert!(matches!(
            subscription.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        assert!(filter.deselect(active_session, 4));
        manager.inner.publish(TerminalEvent::Output {
            session_id: active_session,
            generation: 4,
            offset: 48,
            data: Bytes::from_static(b"stale"),
        });
        assert!(matches!(
            subscription.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn unfiltered_subscription_keeps_existing_all_session_behavior() {
        let manager = TerminalManager::new(TerminalConfig::default()).unwrap();
        let subscription = manager.subscribe().unwrap();
        let session_id = Uuid::new_v4();
        manager.inner.publish(TerminalEvent::Output {
            session_id,
            generation: 1,
            offset: 0,
            data: Bytes::from_static(b"all"),
        });
        assert!(matches!(
            subscription.try_recv(),
            Ok(TerminalEvent::Output {
                session_id: received,
                ..
            }) if received == session_id
        ));
    }

    #[test]
    fn agent_commands_launch_the_binary_directly() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = WorkspaceRoot::open(temp.path()).unwrap();
        let request = TerminalStart {
            session_id: Uuid::new_v4(),
            kind: SessionKind::Claude,
            workspace,
            relative_cwd: PathBuf::from("."),
            size: TerminalSize::default(),
            environment: BTreeMap::new(),
            agent_arguments: vec!["--continue".to_string()],
        };
        let config = TerminalConfig::default();
        let command = build_command(&config, &request, temp.path()).unwrap();
        assert_eq!(command.get_argv()[0], config.claude_program.as_os_str());
        assert_eq!(command.get_argv()[1], "--continue");
    }

    #[test]
    fn environment_validation_rejects_command_injection_shapes() {
        let mut environment = BTreeMap::new();
        environment.insert("VALID_NAME".to_string(), "value".to_string());
        assert!(validate_environment(&environment).is_ok());
        environment.insert("BAD=NAME".to_string(), "value".to_string());
        assert!(validate_environment(&environment).is_err());
    }

    #[test]
    fn duplicate_session_start_is_idempotent_and_never_replaces_the_process() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = WorkspaceRoot::open(temp.path()).unwrap();
        let mut config = TerminalConfig::default();

        #[cfg(windows)]
        let arguments = {
            config.claude_program = std::env::var_os("ComSpec")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("cmd.exe"));
            vec![
                "/D".to_string(),
                "/C".to_string(),
                "ping -n 6 127.0.0.1 >NUL".to_string(),
            ]
        };
        #[cfg(not(windows))]
        let arguments = {
            config.claude_program = PathBuf::from("/bin/sh");
            vec!["-c".to_string(), "sleep 5".to_string()]
        };

        let manager = TerminalManager::new(config).unwrap();
        let request = TerminalStart {
            session_id: Uuid::new_v4(),
            kind: SessionKind::Claude,
            workspace,
            relative_cwd: PathBuf::from("."),
            size: TerminalSize::default(),
            environment: BTreeMap::new(),
            agent_arguments: arguments,
        };

        let first = manager.start(request.clone()).unwrap();
        let retried = manager.start(request.clone()).unwrap();
        assert_eq!(retried, first);
        assert_eq!(manager.list_sessions().len(), 1);

        let mut conflicting = request;
        conflicting.agent_arguments.push("different".to_string());
        assert!(matches!(
            manager.start(conflicting),
            Err(CoreError::SessionIdentityConflict(session_id)) if session_id == first.session_id
        ));
        assert_eq!(
            manager
                .session_info(first.session_id, first.generation)
                .unwrap()
                .process_id,
            first.process_id
        );

        manager.shutdown();
    }

    #[test]
    fn drains_and_replays_child_output_without_any_subscriber() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = WorkspaceRoot::open(temp.path()).unwrap();
        let mut config = TerminalConfig {
            ring_capacity_bytes: 64 * 1024,
            read_chunk_bytes: 4 * 1024,
            ..TerminalConfig::default()
        };

        #[cfg(windows)]
        let arguments = {
            config.claude_program = std::env::var_os("ComSpec")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("cmd.exe"));
            vec![
                "/D".to_string(),
                "/C".to_string(),
                "echo drain-ok".to_string(),
            ]
        };
        #[cfg(not(windows))]
        let arguments = {
            config.claude_program = PathBuf::from("/bin/sh");
            vec!["-c".to_string(), "printf drain-ok".to_string()]
        };

        let manager = TerminalManager::new(config).unwrap();
        let started = manager
            .start(TerminalStart {
                session_id: Uuid::new_v4(),
                kind: SessionKind::Claude,
                workspace,
                relative_cwd: PathBuf::from("."),
                size: TerminalSize::default(),
                environment: BTreeMap::new(),
                agent_arguments: arguments,
            })
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let info = manager
                .session_info(started.session_id, started.generation)
                .unwrap();
            if matches!(info.state, TerminalSessionState::Exited(_)) {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "child did not exit");
            thread::sleep(Duration::from_millis(20));
        }

        let replay = manager
            .snapshot(started.session_id, started.generation, 64 * 1024)
            .unwrap();
        assert!(
            replay
                .data
                .as_ref()
                .windows(b"drain-ok".len())
                .any(|part| part == b"drain-ok"),
            "raw PTY output did not reach the replay ring: {:?}",
            replay.data
        );

        manager.shutdown();
    }
}
