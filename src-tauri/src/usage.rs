use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
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
    pub estimated_input_tokens: u64,
    pub reported_tokens: u64,
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
    pub estimated_input_tokens: u64,
    pub reported_tokens: u64,
    pub first_at: String,
    pub last_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    pub turns: u64,
    pub estimated_input_tokens: u64,
    pub reported_tokens: u64,
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
    load_stats()
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
    day.reported_tokens += delta;
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

fn strip_ansi(text: &str) -> String {
    ansi_re().replace_all(text, "").into_owned()
}

fn usage_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位 HOME 目录".to_string())?;
    Ok(PathBuf::from(home).join(".linco").join("usage.json"))
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
}
