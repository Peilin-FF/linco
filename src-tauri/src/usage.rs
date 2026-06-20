use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Default)]
pub struct UsageState(pub Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub version: u32,
    #[serde(default)]
    pub totals: UsageTotals,
    #[serde(default)]
    pub models: BTreeMap<String, ModelUsage>,
    #[serde(default)]
    pub days: BTreeMap<String, DayUsage>,
    #[serde(default)]
    pub sessions: BTreeMap<String, SessionUsage>,
}

impl Default for UsageStats {
    fn default() -> Self {
        Self {
            version: 1,
            totals: UsageTotals::default(),
            models: BTreeMap::new(),
            days: BTreeMap::new(),
            sessions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub turns: u64,
    #[serde(default)]
    pub cli_turns: u64,
    pub estimated_input_tokens: u64,
    pub reported_tokens: u64,
    #[serde(default)]
    pub cli_reported_tokens: u64,
    #[serde(default)]
    pub terminal_reported_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub key: String,
    pub label: String,
    pub agent_id: String,
    pub agent_name: String,
    pub provider: String,
    pub model: String,
    pub turns: u64,
    #[serde(default)]
    pub cli_turns: u64,
    pub estimated_input_tokens: u64,
    pub reported_tokens: u64,
    #[serde(default)]
    pub cli_reported_tokens: u64,
    #[serde(default)]
    pub terminal_reported_tokens: u64,
    pub first_at: String,
    pub last_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    pub turns: u64,
    #[serde(default)]
    pub cli_turns: u64,
    pub estimated_input_tokens: u64,
    pub reported_tokens: u64,
    #[serde(default)]
    pub cli_reported_tokens: u64,
    #[serde(default)]
    pub terminal_reported_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub session_id: String,
    pub model_key: String,
    pub last_reported_total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTurnInput {
    pub agent_id: String,
    pub agent_name: String,
    pub provider: String,
    pub model: String,
    pub host: Option<String>,
    pub cwd: Option<String>,
    pub prompt: String,
    pub day: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTerminalOutputInput {
    pub session_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub provider: String,
    pub model: String,
    pub text: String,
    pub day: String,
    pub at: String,
}

#[tauri::command]
pub fn usage_load(state: State<'_, UsageState>) -> Result<UsageStats, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let mut stats = load_stats()?;
    apply_cli_status_sources(&mut stats);
    Ok(stats)
}

#[tauri::command]
pub fn usage_record_turn(
    state: State<'_, UsageState>,
    input: UsageTurnInput,
) -> Result<UsageStats, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let mut stats = load_stats()?;
    apply_turn(&mut stats, input);
    save_stats(&stats)?;
    Ok(stats)
}

#[tauri::command]
pub fn usage_ingest_terminal_output(
    state: State<'_, UsageState>,
    input: UsageTerminalOutputInput,
) -> Result<UsageStats, String> {
    let _guard = state.0.lock().map_err(|e| e.to_string())?;
    let mut stats = load_stats()?;
    apply_terminal_output(&mut stats, input);
    save_stats(&stats)?;
    Ok(stats)
}

fn apply_turn(stats: &mut UsageStats, input: UsageTurnInput) {
    normalize(stats);
    let tokens = estimate_tokens(&input.prompt);
    let key = model_key(
        &input.provider,
        &input.agent_id,
        &input.agent_name,
        &input.model,
    );
    let label = model_label(&input.agent_id, &input.agent_name, &input.model);

    stats.totals.turns += 1;
    stats.totals.estimated_input_tokens += tokens;

    let model = stats
        .models
        .entry(key.clone())
        .or_insert_with(|| ModelUsage {
            key: key.clone(),
            label,
            agent_id: input.agent_id.clone(),
            agent_name: input.agent_name.clone(),
            provider: input.provider.clone(),
            model: input.model.clone(),
            first_at: input.at.clone(),
            ..ModelUsage::default()
        });
    model.turns += 1;
    model.estimated_input_tokens += tokens;
    model.last_at = input.at.clone();
    if model.first_at.is_empty() {
        model.first_at = input.at.clone();
    }

    let day = stats
        .days
        .entry(input.day.clone())
        .or_insert_with(|| DayUsage {
            day: input.day.clone(),
            ..DayUsage::default()
        });
    day.turns += 1;
    day.estimated_input_tokens += tokens;
}

fn apply_terminal_output(stats: &mut UsageStats, input: UsageTerminalOutputInput) {
    normalize(stats);
    let Some(total) = parse_reported_total_tokens(&input.text) else {
        return;
    };
    let key = model_key(
        &input.provider,
        &input.agent_id,
        &input.agent_name,
        &input.model,
    );
    let label = model_label(&input.agent_id, &input.agent_name, &input.model);

    let delta = {
        let session = stats
            .sessions
            .entry(input.session_id.clone())
            .or_insert_with(|| SessionUsage {
                session_id: input.session_id.clone(),
                model_key: key.clone(),
                last_reported_total_tokens: 0,
            });
        if session.model_key != key {
            session.model_key = key.clone();
            session.last_reported_total_tokens = 0;
        }
        let prev = session.last_reported_total_tokens;
        let delta = if total > prev {
            total - prev
        } else if total < prev {
            total
        } else {
            0
        };
        session.last_reported_total_tokens = total;
        delta
    };
    if delta == 0 {
        return;
    }

    stats.totals.terminal_reported_tokens += delta;
    stats.totals.reported_tokens += delta;
    let model = stats
        .models
        .entry(key.clone())
        .or_insert_with(|| ModelUsage {
            key,
            label,
            agent_id: input.agent_id.clone(),
            agent_name: input.agent_name.clone(),
            provider: input.provider.clone(),
            model: input.model.clone(),
            first_at: input.at.clone(),
            ..ModelUsage::default()
        });
    model.terminal_reported_tokens += delta;
    model.reported_tokens += delta;
    model.last_at = input.at.clone();
    if model.first_at.is_empty() {
        model.first_at = input.at.clone();
    }

    let day = stats
        .days
        .entry(input.day.clone())
        .or_insert_with(|| DayUsage {
            day: input.day.clone(),
            ..DayUsage::default()
        });
    day.terminal_reported_tokens += delta;
    day.reported_tokens += delta;
}

fn apply_cli_status_sources(stats: &mut UsageStats) {
    normalize(stats);
    reset_cli_reported_tokens(stats);

    let Ok(home) = crate::config::home_dir() else {
        return;
    };
    apply_claude_stats_cache_file(stats, &home.join(".claude").join("stats-cache.json"));
    apply_codex_sessions_dir(stats, &home.join(".codex").join("sessions"));
    apply_codex_sessions_dir(stats, &home.join(".codex").join("archived_sessions"));
}

fn apply_claude_stats_cache_file(stats: &mut UsageStats, path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let _ = apply_claude_stats_cache(stats, &text);
}

fn apply_claude_stats_cache(stats: &mut UsageStats, text: &str) -> Result<(), String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut imported_daily = false;

    if let Some(days) = root.get("dailyModelTokens").and_then(Value::as_array) {
        for entry in days {
            let Some(day) = entry.get("date").and_then(Value::as_str) else {
                continue;
            };
            let Some(models) = entry.get("tokensByModel").and_then(Value::as_object) else {
                continue;
            };
            for (model, tokens) in models {
                let tokens = json_u64(tokens);
                if tokens == 0 {
                    continue;
                }
                imported_daily = true;
                add_cli_reported_tokens(
                    stats,
                    "anthropic",
                    "claude",
                    "Claude",
                    model,
                    tokens,
                    day,
                    &format!("{day}T00:00:00.000Z"),
                );
            }
        }
    }

    if let Some(days) = root.get("dailyActivity").and_then(Value::as_array) {
        for entry in days {
            let Some(day) = entry.get("date").and_then(Value::as_str) else {
                continue;
            };
            let turns = json_field_u64(entry, &["messageCount", "message_count"]);
            add_cli_turns(
                stats,
                None,
                None,
                None,
                None,
                turns,
                day,
                &format!("{day}T00:00:00.000Z"),
            );
        }
    }

    if imported_daily {
        return Ok(());
    }

    let fallback_day = root
        .get("lastComputedDate")
        .and_then(Value::as_str)
        .filter(|d| is_day(d))
        .unwrap_or("unknown");
    if let Some(models) = root.get("modelUsage").and_then(Value::as_object) {
        for (model, usage) in models {
            let tokens = json_field_u64(usage, &["inputTokens", "input_tokens"])
                + json_field_u64(usage, &["outputTokens", "output_tokens"]);
            if tokens == 0 {
                continue;
            }
            add_cli_reported_tokens(
                stats,
                "anthropic",
                "claude",
                "Claude",
                model,
                tokens,
                fallback_day,
                &format!("{fallback_day}T00:00:00.000Z"),
            );
        }
    }

    Ok(())
}

fn apply_codex_sessions_dir(stats: &mut UsageStats, root: &Path) {
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files);
    files.sort();

    for path in files {
        apply_codex_session_file(stats, &path);
    }
}

fn apply_codex_session_file(stats: &mut UsageStats, path: &Path) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    let reader = BufReader::new(file);
    let mut session = CodexSessionImport::default();
    for line in reader.lines().map_while(Result::ok) {
        let _ = session.apply_line(stats, &line);
    }
}

#[cfg(test)]
fn apply_codex_session_jsonl(stats: &mut UsageStats, text: &str) -> Result<(), String> {
    let mut session = CodexSessionImport::default();
    for line in text.lines() {
        session.apply_line(stats, line)?;
    }
    Ok(())
}

#[derive(Default)]
struct CodexSessionImport {
    model: Option<String>,
    last_total_tokens: Option<u64>,
}

impl CodexSessionImport {
    fn apply_line(&mut self, stats: &mut UsageStats, line: &str) -> Result<(), String> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }

        let value: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        match value.get("type").and_then(Value::as_str) {
            Some("turn_context") => {
                if let Some(model) = value
                    .get("payload")
                    .and_then(|payload| payload.get("model"))
                    .and_then(Value::as_str)
                    .filter(|model| !model.trim().is_empty())
                {
                    self.model = Some(model.to_string());
                }
            }
            Some("event_msg") => {
                let Some(payload) = value.get("payload") else {
                    return Ok(());
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    return Ok(());
                }

                let Some(info) = payload.get("info") else {
                    return Ok(());
                };
                let tokens = codex_last_token_usage(info).or_else(|| {
                    let total = token_usage_total(info.get("total_token_usage")?)?;
                    let delta = match self.last_total_tokens {
                        Some(prev) if total >= prev => total - prev,
                        Some(_) => total,
                        None => total,
                    };
                    self.last_total_tokens = Some(total);
                    Some(delta)
                });
                let Some(tokens) = tokens.filter(|tokens| *tokens > 0) else {
                    return Ok(());
                };

                if let Some(total) = info.get("total_token_usage").and_then(token_usage_total) {
                    self.last_total_tokens = Some(total);
                }

                let at = value.get("timestamp").and_then(Value::as_str).unwrap_or("");
                let day = day_from_timestamp(at).unwrap_or("unknown");
                let model = self.model.as_deref().unwrap_or("Codex");
                add_cli_reported_tokens(stats, "openai", "codex", "Codex", model, tokens, day, at);
                add_cli_turns(
                    stats,
                    Some("openai"),
                    Some("codex"),
                    Some("Codex"),
                    Some(model),
                    1,
                    day,
                    at,
                );
            }
            _ => {}
        }

        Ok(())
    }
}

fn collect_jsonl_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn add_cli_reported_tokens(
    stats: &mut UsageStats,
    provider: &str,
    agent_id: &str,
    agent_name: &str,
    model_name: &str,
    tokens: u64,
    day_key: &str,
    at: &str,
) {
    if tokens == 0 {
        return;
    }

    let key = model_key(provider, agent_id, agent_name, model_name);
    let label = model_label(agent_id, agent_name, model_name);

    stats.totals.cli_reported_tokens += tokens;
    stats.totals.reported_tokens += tokens;

    let model = stats
        .models
        .entry(key.clone())
        .or_insert_with(|| ModelUsage {
            key,
            label,
            agent_id: agent_id.to_string(),
            agent_name: agent_name.to_string(),
            provider: provider.to_string(),
            model: model_name.to_string(),
            first_at: at.to_string(),
            ..ModelUsage::default()
        });
    model.cli_reported_tokens += tokens;
    model.reported_tokens += tokens;
    touch_time(&mut model.first_at, &mut model.last_at, at);

    let day = stats
        .days
        .entry(day_key.to_string())
        .or_insert_with(|| DayUsage {
            day: day_key.to_string(),
            ..DayUsage::default()
        });
    day.cli_reported_tokens += tokens;
    day.reported_tokens += tokens;
}

fn add_cli_turns(
    stats: &mut UsageStats,
    provider: Option<&str>,
    agent_id: Option<&str>,
    agent_name: Option<&str>,
    model_name: Option<&str>,
    turns: u64,
    day_key: &str,
    at: &str,
) {
    if turns == 0 {
        return;
    }

    stats.totals.cli_turns += turns;

    if let (Some(provider), Some(agent_id), Some(agent_name), Some(model_name)) =
        (provider, agent_id, agent_name, model_name)
    {
        let key = model_key(provider, agent_id, agent_name, model_name);
        let label = model_label(agent_id, agent_name, model_name);
        let model = stats
            .models
            .entry(key.clone())
            .or_insert_with(|| ModelUsage {
                key,
                label,
                agent_id: agent_id.to_string(),
                agent_name: agent_name.to_string(),
                provider: provider.to_string(),
                model: model_name.to_string(),
                first_at: at.to_string(),
                ..ModelUsage::default()
            });
        model.cli_turns += turns;
        touch_time(&mut model.first_at, &mut model.last_at, at);
    }

    let day = stats
        .days
        .entry(day_key.to_string())
        .or_insert_with(|| DayUsage {
            day: day_key.to_string(),
            ..DayUsage::default()
        });
    day.cli_turns += turns;
}

fn estimate_tokens(text: &str) -> u64 {
    let mut cjk = 0u64;
    let mut ascii = 0u64;
    let mut other = 0u64;
    for ch in text.chars() {
        if ch.is_whitespace() {
            continue;
        }
        if is_cjk(ch) {
            cjk += 1;
        } else if ch.is_ascii() {
            ascii += 1;
        } else {
            other += 1;
        }
    }
    cjk + other + ascii.div_ceil(4)
}

fn parse_reported_total_tokens(text: &str) -> Option<u64> {
    let clean = strip_ansi(text).replace(['\r', '\n'], " ");
    if clean.to_ascii_lowercase().contains("context left") {
        return None;
    }

    let mut best = None;
    for caps in input_output_re().captures_iter(&clean) {
        let a = caps.get(1).and_then(|m| parse_token_number(m.as_str()));
        let b = caps.get(2).and_then(|m| parse_token_number(m.as_str()));
        if let (Some(a), Some(b)) = (a, b) {
            best = Some(best.unwrap_or(0).max(a + b));
        }
    }
    for caps in token_line_re().captures_iter(&clean) {
        if let Some(n) = caps.get(1).and_then(|m| parse_token_number(m.as_str())) {
            best = Some(best.unwrap_or(0).max(n));
        }
    }
    for caps in token_suffix_re().captures_iter(&clean) {
        if let Some(n) = caps.get(1).and_then(|m| parse_token_number(m.as_str())) {
            best = Some(best.unwrap_or(0).max(n));
        }
    }
    best
}

fn normalize(stats: &mut UsageStats) {
    if stats.version == 0 {
        stats.version = 1;
    }
    migrate_reported_sources(
        &mut stats.totals.reported_tokens,
        &mut stats.totals.cli_reported_tokens,
        &mut stats.totals.terminal_reported_tokens,
    );
    for model in stats.models.values_mut() {
        migrate_reported_sources(
            &mut model.reported_tokens,
            &mut model.cli_reported_tokens,
            &mut model.terminal_reported_tokens,
        );
    }
    for day in stats.days.values_mut() {
        migrate_reported_sources(
            &mut day.reported_tokens,
            &mut day.cli_reported_tokens,
            &mut day.terminal_reported_tokens,
        );
    }
}

fn migrate_reported_sources(reported: &mut u64, cli: &mut u64, terminal: &mut u64) {
    if *reported > 0 && *cli == 0 && *terminal == 0 {
        *terminal = *reported;
    }
    *reported = *cli + *terminal;
}

fn reset_cli_reported_tokens(stats: &mut UsageStats) {
    stats.totals.cli_turns = 0;
    stats.totals.cli_reported_tokens = 0;
    stats.totals.reported_tokens = stats.totals.terminal_reported_tokens;
    for model in stats.models.values_mut() {
        model.cli_turns = 0;
        model.cli_reported_tokens = 0;
        model.reported_tokens = model.terminal_reported_tokens;
    }
    for day in stats.days.values_mut() {
        day.cli_turns = 0;
        day.cli_reported_tokens = 0;
        day.reported_tokens = day.terminal_reported_tokens;
    }
}

fn model_label(agent_id: &str, agent_name: &str, model: &str) -> String {
    let model = model.trim();
    if !model.is_empty() {
        model.to_string()
    } else if !agent_name.trim().is_empty() {
        agent_name.trim().to_string()
    } else {
        agent_id.trim().to_string()
    }
}

fn model_key(provider: &str, agent_id: &str, agent_name: &str, model: &str) -> String {
    let provider = if provider.trim().is_empty() {
        "unknown"
    } else {
        provider.trim()
    };
    format!("{provider}:{}", model_label(agent_id, agent_name, model))
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0x2A700..=0x2B73F
    )
}

fn parse_token_number(raw: &str) -> Option<u64> {
    let mut s = raw.trim().replace([',', ' '], "").to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    let mult = match s.chars().last()? {
        'k' => {
            s.pop();
            1_000.0
        }
        'm' => {
            s.pop();
            1_000_000.0
        }
        'b' => {
            s.pop();
            1_000_000_000.0
        }
        _ => 1.0,
    };
    let n = s.parse::<f64>().ok()?;
    Some((n * mult).round() as u64)
}

fn json_field_u64(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(*name).map(json_u64))
        .unwrap_or(0)
}

fn json_u64(value: &Value) -> u64 {
    if let Some(n) = value.as_u64() {
        return n;
    }
    if let Some(n) = value.as_i64() {
        return n.max(0) as u64;
    }
    value
        .as_f64()
        .map(|n| n.max(0.0).round() as u64)
        .unwrap_or(0)
}

fn codex_last_token_usage(info: &Value) -> Option<u64> {
    token_usage_total(info.get("last_token_usage")?)
}

fn token_usage_total(usage: &Value) -> Option<u64> {
    let total = json_field_u64(usage, &["total_tokens", "totalTokens"]);
    if total > 0 {
        return Some(total);
    }
    let input = json_field_u64(usage, &["input_tokens", "inputTokens"]);
    let output = json_field_u64(usage, &["output_tokens", "outputTokens"]);
    let total = input + output;
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

fn day_from_timestamp(timestamp: &str) -> Option<&str> {
    timestamp.get(0..10).filter(|day| is_day(day))
}

fn is_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn touch_time(first_at: &mut String, last_at: &mut String, at: &str) {
    if at.is_empty() {
        return;
    }
    if first_at.is_empty() || at < first_at.as_str() {
        *first_at = at.to_string();
    }
    if last_at.is_empty() || at > last_at.as_str() {
        *last_at = at.to_string();
    }
}

fn strip_ansi(text: &str) -> String {
    ansi_re().replace_all(text, "").into_owned()
}

fn usage_path() -> Result<PathBuf, String> {
    Ok(crate::config::linco_home()?.join("usage.json"))
}

fn load_stats() -> Result<UsageStats, String> {
    let path = usage_path()?;
    if !path.exists() {
        return Ok(UsageStats::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut stats: UsageStats =
        serde_json::from_str(&text).map_err(|e| format!("使用统计解析失败: {e}"))?;
    normalize(&mut stats);
    Ok(stats)
}

fn save_stats(stats: &UsageStats) -> Result<(), String> {
    let path = usage_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(stats).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

fn ansi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").expect("ansi regex"))
}

fn input_output_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:input|prompt)\s*(?:tokens?)?[^0-9]{0,20}([0-9][0-9,\s]*(?:\.[0-9]+)?\s*[kmb]?).{0,100}(?:output|completion|response)\s*(?:tokens?)?[^0-9]{0,20}([0-9][0-9,\s]*(?:\.[0-9]+)?\s*[kmb]?)",
        )
        .expect("input/output token regex")
    })
}

fn token_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)tokens?\s*(?:used|usage)?\s*[:=]?\s*([0-9][0-9,\s]*(?:\.[0-9]+)?\s*[kmb]?)",
        )
        .expect("token line regex")
    })
}

fn token_suffix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:used|usage|total|cost).{0,120}?([0-9][0-9,\s]*(?:\.[0-9]+)?\s*[kmb]?)\s*(?:tokens?|tok)\s*(?:used)?",
        )
        .expect("token suffix regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(model: &str, prompt: &str, day: &str) -> UsageTurnInput {
        UsageTurnInput {
            agent_id: "codex".into(),
            agent_name: "Codex".into(),
            provider: "openai".into(),
            model: model.into(),
            host: None,
            cwd: Some("/tmp/app".into()),
            prompt: prompt.into(),
            day: day.into(),
            at: format!("{day}T08:00:00.000Z"),
        }
    }

    #[test]
    fn usage_turns_roll_up_by_model_and_day() {
        let mut stats = UsageStats::default();

        apply_turn(&mut stats, turn("gpt-5", "hello world", "2026-06-20"));
        apply_turn(&mut stats, turn("gpt-5", "你好世界", "2026-06-20"));

        assert_eq!(stats.version, 1);
        assert_eq!(stats.totals.turns, 2);
        assert_eq!(stats.totals.estimated_input_tokens, 7);

        let model = stats.models.get("openai:gpt-5").expect("model stats");
        assert_eq!(model.label, "gpt-5");
        assert_eq!(model.turns, 2);
        assert_eq!(model.estimated_input_tokens, 7);

        let day = stats.days.get("2026-06-20").expect("day stats");
        assert_eq!(day.turns, 2);
        assert_eq!(day.estimated_input_tokens, 7);
    }

    #[test]
    fn legacy_usage_json_missing_new_fields_loads_with_defaults() {
        let legacy = r#"{
          "version": 1,
          "totals": {
            "turns": 1,
            "estimatedInputTokens": 4,
            "reportedTokens": 12
          },
          "models": {
            "openai:gpt-5": {
              "key": "openai:gpt-5",
              "label": "gpt-5",
              "agentId": "codex",
              "agentName": "Codex",
              "provider": "openai",
              "model": "gpt-5",
              "turns": 1,
              "estimatedInputTokens": 4,
              "reportedTokens": 12,
              "firstAt": "2026-06-20T08:00:00.000Z",
              "lastAt": "2026-06-20T08:01:00.000Z"
            }
          },
          "days": {
            "2026-06-20": {
              "day": "2026-06-20",
              "turns": 1,
              "estimatedInputTokens": 4,
              "reportedTokens": 12
            }
          },
          "sessions": {}
        }"#;

        let mut stats: UsageStats = serde_json::from_str(legacy).expect("legacy stats should load");
        normalize(&mut stats);

        assert_eq!(stats.totals.cli_turns, 0);
        assert_eq!(stats.totals.terminal_reported_tokens, 12);
        assert_eq!(stats.totals.reported_tokens, 12);
        assert_eq!(
            stats
                .models
                .get("openai:gpt-5")
                .expect("model stats")
                .cli_turns,
            0
        );
        assert_eq!(
            stats
                .days
                .get("2026-06-20")
                .expect("day stats")
                .terminal_reported_tokens,
            12
        );
    }

    #[test]
    fn reported_terminal_tokens_are_counted_as_session_deltas() {
        let mut stats = UsageStats::default();
        let mut event = UsageTerminalOutputInput {
            session_id: "chat:local:codex:/tmp/app".into(),
            agent_id: "codex".into(),
            agent_name: "Codex".into(),
            provider: "openai".into(),
            model: "gpt-5".into(),
            text: "cost $0.04 · 1.2k tokens used".into(),
            day: "2026-06-20".into(),
            at: "2026-06-20T08:01:00.000Z".into(),
        };

        apply_terminal_output(&mut stats, event.clone());
        event.text = "cost $0.07 · 1.8k tokens used".into();
        apply_terminal_output(&mut stats, event.clone());
        event.text = "cost $0.07 · 1.8k tokens used".into();
        apply_terminal_output(&mut stats, event);

        assert_eq!(stats.totals.reported_tokens, 1800);
        assert_eq!(
            stats
                .models
                .get("openai:gpt-5")
                .expect("model stats")
                .reported_tokens,
            1800
        );
        assert_eq!(
            stats
                .days
                .get("2026-06-20")
                .expect("day stats")
                .reported_tokens,
            1800
        );
    }

    #[test]
    fn token_parser_ignores_context_remaining_lines() {
        assert_eq!(
            parse_reported_total_tokens("Tokens used: 1,234"),
            Some(1234)
        );
        assert_eq!(
            parse_reported_total_tokens("usage 12.5k tokens"),
            Some(12500)
        );
        assert_eq!(
            parse_reported_total_tokens("context left 200k tokens"),
            None
        );
    }

    #[test]
    fn token_estimate_handles_ascii_and_cjk() {
        assert_eq!(estimate_tokens("hello world"), 3);
        assert_eq!(estimate_tokens("你好世界"), 4);
    }

    #[test]
    fn claude_status_cache_adds_official_tokens_by_model_and_day() {
        let mut stats = UsageStats::default();
        let cache = r#"{
            "version": 3,
            "dailyModelTokens": [
                {
                    "date": "2026-06-20",
                    "tokensByModel": {
                        "claude-opus-4-8": 150
                    }
                }
            ],
            "modelUsage": {
                "claude-opus-4-8": {
                    "inputTokens": 100,
                    "outputTokens": 50,
                    "cacheReadInputTokens": 900,
                    "cacheCreationInputTokens": 300
                }
            }
        }"#;

        apply_claude_stats_cache(&mut stats, cache).expect("claude status import");

        assert_eq!(stats.totals.cli_reported_tokens, 150);
        assert_eq!(stats.totals.reported_tokens, 150);
        assert_eq!(
            stats
                .models
                .get("anthropic:claude-opus-4-8")
                .expect("claude model")
                .cli_reported_tokens,
            150
        );
        assert_eq!(
            stats
                .days
                .get("2026-06-20")
                .expect("day")
                .cli_reported_tokens,
            150
        );
    }

    #[test]
    fn codex_session_jsonl_adds_token_count_events_with_current_model() {
        let mut stats = UsageStats::default();
        let jsonl = r#"
{"timestamp":"2026-06-20T01:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}
{"timestamp":"2026-06-20T01:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":40,"output_tokens":10,"total_tokens":50},"total_token_usage":{"total_tokens":50}}}}
{"timestamp":"2026-06-21T01:00:00.000Z","type":"turn_context","payload":{"model":"o3"}}
{"timestamp":"2026-06-21T01:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":7,"output_tokens":3},"total_token_usage":{"total_tokens":60}}}}
"#;

        apply_codex_session_jsonl(&mut stats, jsonl).expect("codex session import");

        assert_eq!(stats.totals.cli_reported_tokens, 60);
        assert_eq!(
            stats
                .models
                .get("openai:gpt-5.5")
                .expect("gpt model")
                .cli_reported_tokens,
            50
        );
        assert_eq!(
            stats
                .models
                .get("openai:o3")
                .expect("o3 model")
                .cli_reported_tokens,
            10
        );
        assert_eq!(
            stats
                .days
                .get("2026-06-20")
                .expect("first day")
                .cli_reported_tokens,
            50
        );
        assert_eq!(
            stats
                .days
                .get("2026-06-21")
                .expect("second day")
                .cli_reported_tokens,
            10
        );
        assert_eq!(stats.totals.cli_turns, 2);
        assert_eq!(
            stats
                .models
                .get("openai:gpt-5.5")
                .expect("gpt model")
                .cli_turns,
            1
        );
        assert_eq!(
            stats.days.get("2026-06-20").expect("first day").cli_turns,
            1
        );
    }

    #[test]
    fn claude_status_cache_adds_daily_activity_as_cli_turns() {
        let mut stats = UsageStats::default();
        let cache = r#"{
            "version": 3,
            "dailyActivity": [
                {
                    "date": "2026-06-20",
                    "messageCount": 4,
                    "sessionCount": 1,
                    "toolCallCount": 2
                }
            ],
            "dailyModelTokens": [],
            "modelUsage": {}
        }"#;

        apply_claude_stats_cache(&mut stats, cache).expect("claude status import");

        assert_eq!(stats.totals.cli_turns, 4);
        assert_eq!(stats.days.get("2026-06-20").expect("day").cli_turns, 4);
    }
}
