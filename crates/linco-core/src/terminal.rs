use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
#[cfg(target_os = "linux")]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Weak};
use std::thread;
#[cfg(target_os = "linux")]
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use linco_protocol::SessionKind;
use parking_lot::{Mutex, RwLock};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};
use uuid::Uuid;

use crate::{ByteRing, CoreError, RingRange, RingReplayError, WorkspaceRoot};

const PROTOCOL_MAX_TERMINAL_CHUNK: usize = 32 * 1024;

#[cfg(target_os = "linux")]
const LINUX_SESSION_KILL_PASSES: usize = 8;

#[cfg(target_os = "linux")]
const LINUX_SESSION_KILL_RESCAN_DELAY: Duration = Duration::from_millis(10);

#[cfg(target_os = "linux")]
const LINUX_PTY_WRITE_TIMEOUT: Duration = Duration::from_secs(4);

#[cfg(target_os = "linux")]
const LINUX_PTY_READ_POLL_INTERVAL: Duration = Duration::from_millis(250);

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
    #[cfg(target_os = "linux")]
    process_start_time: Option<u64>,
    created_at_ms: u64,
    start_identity: StartIdentity,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    #[cfg(target_os = "linux")]
    poll_handle: OwnedFd,
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
        #[cfg(target_os = "linux")]
        linux_require_pidfd_support().map_err(|source| CoreError::Io {
            operation: "probe safe Linux terminal process termination",
            source,
        })?;
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
        #[cfg(target_os = "linux")]
        let poll_handle = prepare_linux_nonblocking_pty(pair.master.as_ref()).map_err(|error| {
            CoreError::Pty {
                operation: "configure bounded terminal I/O",
                message: error.to_string(),
            }
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
        #[cfg(target_os = "linux")]
        let process_start_time = match process_id {
            Some(process_id) => {
                let process_id = libc::pid_t::try_from(process_id).map_err(|_| CoreError::Io {
                    operation: "capture terminal process identity",
                    source: std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "terminal process id does not fit pid_t",
                    ),
                })?;
                match linux_process_status(process_id) {
                    Ok(Some(status)) => Some(status.start_time),
                    Ok(None) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(CoreError::Io {
                            operation: "capture terminal process identity",
                            source: std::io::Error::new(
                                std::io::ErrorKind::NotFound,
                                "terminal process disappeared before its Linux identity was captured",
                            ),
                        });
                    }
                    Err(source) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(CoreError::Io {
                            operation: "capture terminal process identity",
                            source,
                        });
                    }
                }
            }
            None => None,
        };
        let session = Arc::new(Session {
            id: request.session_id,
            generation,
            kind: request.kind,
            cwd,
            process_id,
            #[cfg(target_os = "linux")]
            process_start_time,
            created_at_ms: unix_time_ms(),
            start_identity,
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            #[cfg(target_os = "linux")]
            poll_handle,
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

        #[cfg(target_os = "linux")]
        return session.write_linux_input(data);

        #[cfg(not(target_os = "linux"))]
        {
            let mut writer_guard = session.writer.lock();
            let writer = writer_guard
                .as_mut()
                .ok_or(CoreError::SessionExited(session_id))?;
            writer.write_all(data).map_err(|source| CoreError::Io {
                operation: "write terminal input",
                source,
            })?;
            // A native PTY is unbuffered at the Rust layer; avoiding an unconstrained trait-object
            // flush keeps the same hard bound as the nonblocking writes above.
            Ok(())
        }
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

    #[cfg(target_os = "linux")]
    fn write_linux_input(&self, data: &[u8]) -> Result<(), CoreError> {
        let deadline = Instant::now() + LINUX_PTY_WRITE_TIMEOUT;
        let mut writer_guard = self.writer.lock();
        let writer = writer_guard
            .as_mut()
            .ok_or(CoreError::SessionExited(self.id))?;
        let mut written = 0;
        while written < data.len() {
            match writer.write(&data[written..]) {
                Ok(0) => {
                    return Err(CoreError::Io {
                        operation: "write terminal input",
                        source: std::io::Error::new(
                            std::io::ErrorKind::WriteZero,
                            "PTY writer accepted zero bytes",
                        ),
                    });
                }
                Ok(count) => written += count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    let ready = self
                        .wait_linux_pty(libc::POLLOUT, deadline)
                        .map_err(|source| CoreError::Io {
                            operation: "wait for terminal input capacity",
                            source,
                        })?;
                    if !ready {
                        return Err(CoreError::Io {
                            operation: "write terminal input",
                            source: std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "PTY input remained blocked for four seconds",
                            ),
                        });
                    }
                }
                Err(source) => {
                    return Err(CoreError::Io {
                        operation: "write terminal input",
                        source,
                    });
                }
            }
        }
        // A native PTY is unbuffered. Avoid a trait-object `flush` here because an arbitrary
        // implementation could block outside the deadline enforced above.
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn wait_linux_pty(&self, events: libc::c_short, deadline: Instant) -> std::io::Result<bool> {
        let mut descriptor = libc::pollfd {
            fd: self.poll_handle.as_raw_fd(),
            events,
            revents: 0,
        };
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            let timeout_ms = i32::try_from(remaining.as_millis().max(1)).unwrap_or(i32::MAX);
            // SAFETY: descriptor points to one initialized pollfd for the duration of the call.
            let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
            if result > 0 {
                if descriptor.revents & libc::POLLNVAL != 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "PTY poll handle became invalid",
                    ));
                }
                return Ok(true);
            }
            if result == 0 {
                return Ok(false);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn kill(&self) -> std::io::Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(process_id) = self.process_id {
            let session_leader = libc::pid_t::try_from(process_id).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "terminal process id does not fit pid_t",
                )
            })?;
            return self.kill_linux_session(session_leader, self.process_start_time);
        }

        self.killer.lock().kill()
    }

    #[cfg(target_os = "linux")]
    fn kill_linux_session(
        &self,
        expected_session: libc::pid_t,
        expected_start_time: Option<u64>,
    ) -> std::io::Result<()> {
        if expected_session <= 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "refusing to signal an invalid terminal session id",
            ));
        }
        if unix_session_id(0)? == Some(expected_session) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "refusing to signal the Linco server session",
            ));
        }

        // A reaped child PID can eventually be recycled. If the numeric session leader exists,
        // require the /proc start time captured immediately after spawn to still match before
        // treating it as our session. When the leader is absent, Linux keeps the SID allocated
        // while any of its process groups still have members; enumerating those members below is
        // therefore safe and is also what handles leaderless foreground/background groups.
        if let (Some(expected), Some(observed)) =
            (expected_start_time, linux_process_status(expected_session)?)
        {
            if observed.start_time != expected {
                return Ok(());
            }
        }

        let mut first_error = None;
        for pass in 0..LINUX_SESSION_KILL_PASSES {
            let members = linux_live_session_processes(expected_session)?;
            if members.is_empty() {
                return Ok(());
            }

            // A pidfd binds the signal target before we revalidate SID + start time. That avoids
            // both PID and process-group reuse races while repeated scans catch children forked
            // after an earlier /proc snapshot.
            for member in members {
                if let Err(error) = linux_kill_session_process(member, expected_session) {
                    first_error.get_or_insert(error);
                }
            }

            if pass + 1 < LINUX_SESSION_KILL_PASSES {
                thread::sleep(LINUX_SESSION_KILL_RESCAN_DELAY);
            }
        }

        let remaining = linux_live_session_processes(expected_session)?;
        if remaining.is_empty() {
            Ok(())
        } else if let Some(error) = first_error {
            Err(error)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!(
                    "{} Linux terminal session process(es) remained after bounded termination",
                    remaining.len()
                ),
            ))
        }
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

#[cfg(target_os = "linux")]
fn prepare_linux_nonblocking_pty(master: &dyn MasterPty) -> std::io::Result<OwnedFd> {
    let descriptor = master.as_raw_fd().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "native Linux PTY did not expose a file descriptor",
        )
    })?;
    // SAFETY: descriptor is owned by master and remains valid for these fcntl calls.
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // O_NONBLOCK is shared by the master's duplicated reader and writer handles. The reader uses
    // poll below; the writer therefore has a kernel-enforced upper bound even if a slave holder
    // escapes the original process session.
    if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: F_DUPFD_CLOEXEC returns a new owned descriptor on success.
    let poll_descriptor = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 0) };
    if poll_descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: poll_descriptor was created above and ownership transfers to OwnedFd exactly once.
    Ok(unsafe { OwnedFd::from_raw_fd(poll_descriptor) })
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy)]
struct LinuxProcessStatus {
    session_id: libc::pid_t,
    start_time: u64,
    state: u8,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy)]
struct LinuxSessionProcess {
    process_id: libc::pid_t,
    start_time: u64,
}

#[cfg(target_os = "linux")]
fn linux_process_status(process_id: libc::pid_t) -> std::io::Result<Option<LinuxProcessStatus>> {
    let stat = match std::fs::read(format!("/proc/{process_id}/stat")) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    parse_linux_process_status(process_id, &stat).map(Some)
}

#[cfg(target_os = "linux")]
fn parse_linux_process_status(
    process_id: libc::pid_t,
    stat: &[u8],
) -> std::io::Result<LinuxProcessStatus> {
    // The comm field is parenthesized and may contain spaces or parentheses, so split after its
    // final closing delimiter. The remaining zero-based fields start at Linux proc field 3.
    let close = stat
        .windows(2)
        .rposition(|window| window == b") ")
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("malformed /proc/{process_id}/stat command field"),
            )
        })?;
    let suffix = std::str::from_utf8(&stat[close + 2..]).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("non-ASCII fields in /proc/{process_id}/stat: {error}"),
        )
    })?;
    let fields: Vec<_> = suffix.split_whitespace().collect();
    if fields.len() <= 19 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("truncated /proc/{process_id}/stat record"),
        ));
    }
    let session_id = fields[3].parse::<libc::pid_t>().map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid session id in /proc/{process_id}/stat: {error}"),
        )
    })?;
    let start_time = fields[19].parse::<u64>().map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid start time in /proc/{process_id}/stat: {error}"),
        )
    })?;
    let state = fields[0].as_bytes().first().copied().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("missing state in /proc/{process_id}/stat"),
        )
    })?;
    Ok(LinuxProcessStatus {
        session_id,
        start_time,
        state,
    })
}

#[cfg(target_os = "linux")]
fn linux_live_session_processes(
    expected_session: libc::pid_t,
) -> std::io::Result<Vec<LinuxSessionProcess>> {
    let mut members = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let Ok(entry) = entry else { continue };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok(process_id) = name.parse::<libc::pid_t>() else {
            continue;
        };
        if process_id <= 1
            || !matches!(
                unix_session_id(process_id),
                Ok(Some(session_id)) if session_id == expected_session
            )
        {
            continue;
        }
        let Some(status) = linux_process_status(process_id)? else {
            continue;
        };
        if status.session_id != expected_session || matches!(status.state, b'Z' | b'X' | b'x') {
            continue;
        }
        members.push(LinuxSessionProcess {
            process_id,
            start_time: status.start_time,
        });
    }
    members.sort_unstable_by_key(|member| member.process_id);
    Ok(members)
}

#[cfg(target_os = "linux")]
fn linux_kill_session_process(
    member: LinuxSessionProcess,
    expected_session: libc::pid_t,
) -> std::io::Result<()> {
    let Some(pidfd) = linux_open_pidfd(member.process_id)? else {
        return Ok(());
    };
    let Some(status) = linux_process_status(member.process_id)? else {
        return Ok(());
    };
    if status.start_time != member.start_time
        || status.session_id != expected_session
        || matches!(status.state, b'Z' | b'X' | b'x')
    {
        return Ok(());
    }
    linux_signal_pidfd(&pidfd, libc::SIGKILL)
}

#[cfg(target_os = "linux")]
fn linux_open_pidfd(process_id: libc::pid_t) -> std::io::Result<Option<OwnedFd>> {
    // SAFETY: pidfd_open copies the numeric PID and flags; it does not dereference user memory.
    let raw_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, process_id, 0_u32) };
    if raw_fd >= 0 {
        let raw_fd = i32::try_from(raw_fd).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "pidfd_open returned a descriptor that does not fit RawFd",
            )
        })?;
        // SAFETY: a successful pidfd_open returns a new owned file descriptor.
        return Ok(Some(unsafe { OwnedFd::from_raw_fd(raw_fd) }));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(None)
    } else {
        Err(error)
    }
}

#[cfg(target_os = "linux")]
fn unix_session_id(process: libc::pid_t) -> std::io::Result<Option<libc::pid_t>> {
    // SAFETY: getsid only reads kernel process metadata for the supplied positive PID.
    let session = unsafe { libc::getsid(process) };
    if session >= 0 {
        return Ok(Some(session));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(None)
    } else {
        Err(error)
    }
}

#[cfg(target_os = "linux")]
fn linux_signal_pidfd(pidfd: &OwnedFd, signal: libc::c_int) -> std::io::Result<()> {
    // SAFETY: pidfd is owned and valid; a null siginfo with zero flags requests a plain signal.
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            pidfd.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0_u32,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(target_os = "linux")]
fn linux_require_pidfd_support() -> std::io::Result<()> {
    // Probe both syscalls with signal 0 so an unsupported kernel or seccomp profile is rejected at
    // startup, before Linco can create a PTY that it cannot terminate safely.
    let process_id = unsafe { libc::getpid() };
    let pidfd = linux_open_pidfd(process_id)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the Linco process disappeared during pidfd capability detection",
        )
    })?;
    linux_signal_pidfd(&pidfd, 0)
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
                    #[cfg(target_os = "linux")]
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        let deadline = Instant::now() + LINUX_PTY_READ_POLL_INTERVAL;
                        match session.wait_linux_pty(libc::POLLIN, deadline) {
                            Ok(true) => {}
                            Ok(false) => match exit_receiver.try_recv() {
                                Ok(status) => {
                                    early_status = Some(status.ok());
                                    break;
                                }
                                Err(mpsc::TryRecvError::Empty) => {}
                                Err(mpsc::TryRecvError::Disconnected) => break,
                            },
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

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_proc_stat_parser_ignores_non_utf8_command_names() {
        let mut stat = b"123 (linco-".to_vec();
        stat.push(0xff);
        stat.extend_from_slice(b"-) name) ");
        let mut fields = vec!["S", "1", "2", "123"];
        fields.extend(std::iter::repeat_n("0", 15));
        fields.push("456");
        stat.extend_from_slice(fields.join(" ").as_bytes());

        let status = parse_linux_process_status(123, &stat).unwrap();

        assert_eq!(status.session_id, 123);
        assert_eq!(status.start_time, 456);
        assert_eq!(status.state, b'S');
    }

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
