//! Observable, cancellable local paper-reading requests, independent of SSH agents.
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

const LIMIT: Duration = Duration::from_secs(90);
static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> { JOBS.get_or_init(|| Mutex::new(HashMap::new())) }

pub struct Job {
    started: Instant,
    cancelled: AtomicBool,
    stage: Mutex<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    stage: String,
    elapsed_ms: u64,
    timeout_ms: u64,
    execution: &'static str,
}

pub struct Request { id: String, pub job: Arc<Job> }
impl Request {
    pub fn start(request_id: Option<String>) -> Result<Self, String> {
        let id = request_id.unwrap_or_else(|| format!("native-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
        if id.is_empty() || id.len() > 100 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err("Invalid paper analysis request ID".into());
        }
        let mut registry = jobs().lock().map_err(|e| e.to_string())?;
        if registry.contains_key(&id) { return Err("This paper analysis is already running".into()); }
        if registry.len() >= 8 { return Err("Too many paper analyses are running. Cancel one before starting another.".into()); }
        let job = Arc::new(Job { started: Instant::now(), cancelled: AtomicBool::new(false), stage: Mutex::new("preparing".into()) });
        registry.insert(id.clone(), job.clone());
        Ok(Self { id, job })
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        self.job.cancelled.store(true, Ordering::Release);
        if let Ok(mut registry) = jobs().lock() { registry.remove(&self.id); }
    }
}
impl Job {
    pub fn stage(&self, stage: &str) { if let Ok(mut value) = self.stage.lock() { *value = stage.into(); } }
    pub fn check(&self) -> Result<(), String> {
        if self.started.elapsed() >= LIMIT {
            return Err("Local AI analysis exceeded 90 seconds. Check the local agent's sign-in and network/Clash connection, then retry. Saved highlights are unchanged.".into());
        }
        if self.cancelled.load(Ordering::Acquire) { return Err("Paper analysis cancelled. Saved highlights are unchanged.".into()); }
        Ok(())
    }
    pub async fn controlled<T>(&self, future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        tokio::select! {
            result = future => { self.check()?; result }
            error = async { loop { if let Err(error) = self.check() { break error; } tokio::time::sleep(Duration::from_millis(100)).await; } } => Err(error),
        }
    }
}

#[tauri::command]
pub fn latex_ai_pdf_progress(request_id: String) -> Option<Progress> {
    let registry = jobs().lock().ok()?;
    let job = registry.get(&request_id)?;
    let stage = job.stage.lock().ok()?.clone();
    Some(Progress { stage, elapsed_ms: job.started.elapsed().as_millis() as u64, timeout_ms: LIMIT.as_millis() as u64, execution: "local" })
}

#[tauri::command]
pub fn latex_ai_pdf_cancel(request_id: String) -> bool {
    if let Some(job) = jobs().lock().ok().and_then(|registry| registry.get(&request_id).cloned()) {
        job.cancelled.store(true, Ordering::Release);
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_scoped_and_completed_jobs_are_removed() {
        let first = Request::start(Some("unit-reading-cancel".into())).unwrap();
        let other = Request::start(Some("unit-reading-other".into())).unwrap();
        first.job.stage("reading");
        assert_eq!(latex_ai_pdf_progress("unit-reading-cancel".into()).unwrap().stage, "reading");
        assert!(latex_ai_pdf_cancel("unit-reading-cancel".into()));
        assert!(first.job.check().unwrap_err().contains("cancelled"));
        assert!(other.job.check().is_ok());
        drop(first);
        assert!(latex_ai_pdf_progress("unit-reading-cancel".into()).is_none());
        assert!(!latex_ai_pdf_cancel("not-running".into()));
        assert!(Request::start(Some("../bad".into())).is_err());
        let expired = Job { started: Instant::now() - LIMIT, cancelled: AtomicBool::new(false), stage: Mutex::new("reading".into()) };
        assert!(expired.check().unwrap_err().contains("90 seconds"));
    }
}
