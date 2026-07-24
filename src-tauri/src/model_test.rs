use crate::config::AgentConfig;

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTestResult {
    pub ok: bool,
    pub message: String,
    pub status: Option<u16>,
    pub latency_ms: u64,
}

#[derive(Debug, Clone)]
struct ModelTestRequest {
    url: String,
    headers: Vec<(String, String)>,
    body: Value,
}

impl ModelTestRequest {
    #[cfg(test)]
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[tauri::command]
pub async fn test_model_connection(agent: AgentConfig) -> Result<ModelTestResult, String> {
    if agent.auth_mode == "subscription" {
        return crate::blocking::run(move || test_cli_health(&agent)).await;
    }

    let request = match build_model_test_request(&agent) {
        Ok(request) => request,
        Err(message) => return Ok(failure(message, None, 0)),
    };

    let start = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.post(&request.url);
    for (key, value) in &request.headers {
        builder = builder.header(key, value);
    }

    let response = match builder.json(&request.body).send().await {
        Ok(response) => response,
        Err(err) => return Ok(failure(format!("连接失败: {err}"), None, elapsed_ms(start))),
    };

    let status = response.status();
    let status_code = status.as_u16();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(ModelTestResult {
            ok: true,
            message: "模型连通性测试通过".into(),
            status: Some(status_code),
            latency_ms: elapsed_ms(start),
        })
    } else {
        Ok(failure(
            format!(
                "模型返回 HTTP {status_code}: {}",
                response_error_message(&text)
            ),
            Some(status_code),
            elapsed_ms(start),
        ))
    }
}

fn build_model_test_request(agent: &AgentConfig) -> Result<ModelTestRequest, String> {
    let provider = agent.provider.trim().to_ascii_lowercase();
    let model = selected_model(agent)
        .ok_or_else(|| "请先填写模型名".to_string())?
        .to_string();
    let api_key = agent.api_key.trim();
    if api_key.is_empty() {
        return Err("请先填写 API Key，或切换到订阅登录后在终端完成 CLI 登录".into());
    }

    if provider == "anthropic" {
        let base = defaulted_base_url(agent, "https://api.anthropic.com")?;
        let url = append_anthropic_messages_path(&base);
        return Ok(ModelTestRequest {
            url,
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("x-api-key".into(), api_key.into()),
                ("anthropic-version".into(), "2023-06-01".into()),
            ],
            body: json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ping"}]
            }),
        });
    }

    let default_base = if provider == "openrouter" {
        "https://openrouter.ai/api/v1"
    } else if provider == "custom" {
        ""
    } else {
        "https://api.openai.com/v1"
    };
    let base = defaulted_base_url(agent, default_base)?;
    Ok(ModelTestRequest {
        url: append_path(&base, "/chat/completions"),
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("authorization".into(), format!("Bearer {api_key}")),
        ],
        body: json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}]
        }),
    })
}

fn selected_model(agent: &AgentConfig) -> Option<&str> {
    let model = agent.model.trim();
    if !model.is_empty() {
        return Some(model);
    }
    agent
        .models
        .iter()
        .map(|m| m.trim())
        .find(|m| !m.is_empty())
}

fn defaulted_base_url(agent: &AgentConfig, default_base: &str) -> Result<String, String> {
    let raw = agent.base_url.trim();
    let base = if raw.is_empty() { default_base } else { raw };
    if base.is_empty() {
        return Err("自定义供应商需要填写 Base URL".into());
    }
    Ok(base.trim_end_matches('/').to_string())
}

fn append_path(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn append_anthropic_messages_path(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        append_path(base, "/messages")
    } else {
        append_path(base, "/v1/messages")
    }
}

fn response_error_message(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "响应为空".into();
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(message) = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
        {
            return message.to_string();
        }
    }
    trimmed.chars().take(300).collect()
}

fn test_cli_health(agent: &AgentConfig) -> Result<ModelTestResult, String> {
    let exe = command_head(&agent.command).unwrap_or_else(|| default_command(&agent.provider));
    if exe.is_empty() {
        return Ok(failure("请先填写启动命令".into(), None, 0));
    }

    let args: Vec<&str> = if is_codex(agent, &exe) {
        vec!["doctor", "--summary", "--no-color", "--ascii"]
    } else {
        vec!["--version"]
    };
    let start = Instant::now();
    let mut c = Command::new(&exe);
    c.args(&args).stdin(Stdio::null());
    crate::proc_ext::no_window(&mut c);
    let output = c.output().map_err(|e| format!("无法运行 {exe}: {e}"))?;
    let message = command_output_summary(&output.stdout, &output.stderr);
    if output.status.success() {
        Ok(ModelTestResult {
            ok: true,
            message: if message.is_empty() {
                "CLI 健康检查通过。订阅模式的模型额度由 CLI 登录状态控制。".into()
            } else {
                format!("{message}。订阅模式的模型额度由 CLI 登录状态控制。")
            },
            status: output.status.code().map(|c| c as u16),
            latency_ms: elapsed_ms(start),
        })
    } else {
        Ok(failure(
            if message.is_empty() {
                format!("{exe} 检查失败")
            } else {
                message
            },
            output.status.code().map(|c| c as u16),
            elapsed_ms(start),
        ))
    }
}

fn command_output_summary(stdout: &[u8], stderr: &[u8]) -> String {
    let text = if stderr.is_empty() { stdout } else { stderr };
    String::from_utf8_lossy(text)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(180)
        .collect()
}

fn command_head(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn default_command(provider: &str) -> String {
    if provider == "openai" {
        "codex".into()
    } else {
        "claude".into()
    }
}

fn is_codex(agent: &AgentConfig, exe: &str) -> bool {
    agent.provider == "openai" || exe.rsplit('/').next() == Some("codex")
}

fn failure(message: String, status: Option<u16>, latency_ms: u64) -> ModelTestResult {
    ModelTestResult {
        ok: false,
        message,
        status,
        latency_ms,
    }
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(provider: &str) -> AgentConfig {
        AgentConfig {
            id: provider.into(),
            name: provider.into(),
            provider: provider.into(),
            command: String::new(),
            api_key: "test-key".into(),
            base_url: String::new(),
            model: "test-model".into(),
            models: Vec::new(),
            permission: String::new(),
            effort: String::new(),
            auth_mode: "api".into(),
        }
    }

    #[test]
    fn openai_compatible_request_uses_chat_completions() {
        let mut a = agent("openai");
        a.base_url = "https://example.test/v1/".into();

        let req = build_model_test_request(&a).expect("request");

        assert_eq!(req.url, "https://example.test/v1/chat/completions");
        assert_eq!(req.header("authorization"), Some("Bearer test-key"));
        assert_eq!(req.body["model"], "test-model");
        assert_eq!(req.body["messages"][0]["content"], "ping");
    }

    #[test]
    fn anthropic_request_uses_messages_api() {
        let mut a = agent("anthropic");
        a.base_url = "https://anthropic.example".into();

        let req = build_model_test_request(&a).expect("request");

        assert_eq!(req.url, "https://anthropic.example/v1/messages");
        assert_eq!(req.header("x-api-key"), Some("test-key"));
        assert_eq!(req.header("anthropic-version"), Some("2023-06-01"));
        assert_eq!(req.body["model"], "test-model");
        assert_eq!(req.body["messages"][0]["content"], "ping");
    }

    #[test]
    fn api_mode_requires_key_and_model() {
        let mut a = agent("openai");
        a.api_key.clear();
        assert!(build_model_test_request(&a)
            .expect_err("missing key")
            .contains("API Key"));

        a.api_key = "test-key".into();
        a.model.clear();
        assert!(build_model_test_request(&a)
            .expect_err("missing model")
            .contains("模型"));
    }
}
