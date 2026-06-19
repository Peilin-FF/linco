pub async fn run<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn run_returns_closure_result() {
        let got = tauri::async_runtime::block_on(super::run(|| Ok::<_, String>(42)))
            .expect("blocking task should succeed");

        assert_eq!(got, 42);
    }

    #[test]
    fn run_propagates_closure_error() {
        let err =
            tauri::async_runtime::block_on(super::run(|| Err::<(), String>("boom".to_string())))
                .expect_err("blocking task error should propagate");

        assert_eq!(err, "boom");
    }
}
