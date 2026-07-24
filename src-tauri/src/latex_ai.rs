use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::AgentConfig;

const MAX_DISCOVERED_FILES: usize = 400;
const MAX_EVIDENCE_FILES: usize = 12;
const MAX_EVIDENCE_CHARS: usize = 24_000;
const MAX_FILE_CHARS: usize = 3_200;

#[derive(Debug, Clone)]
struct Candidate {
    path: String,
    relative: String,
    name: String,
    priority: i32,
}

#[derive(Debug, Clone)]
struct Evidence {
    path: String,
    excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexAiSuggestion {
    suggestion: String,
    edits: Vec<LatexPolishEdit>,
    evidence: Vec<String>,
    agent: String,
    model: String,
    files_considered: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexPolishEdit {
    original: String,
    replacement: String,
    reason: String,
    evidence: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexReviewSegment {
    id: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexReviewIssue {
    segment_id: String,
    original: String,
    replacement: String,
    reason: String,
    category: String,
    evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexReviewResult {
    issues: Vec<LatexReviewIssue>,
    agent: String,
    model: String,
    files_considered: usize,
}

#[derive(Debug, Deserialize)]
struct ModelSuggestion {
    #[serde(default)]
    suggestion: String,
    #[serde(default)]
    edits: Vec<ModelPolishEdit>,
    #[serde(default)]
    evidence: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ModelPolishEdit {
    #[serde(default)]
    original: String,
    #[serde(default)]
    replacement: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    evidence: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelReviewIssue {
    #[serde(default)]
    segment_id: String,
    #[serde(default)]
    original: String,
    #[serde(default)]
    replacement: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    evidence: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ModelReview {
    #[serde(default)]
    issues: Vec<ModelReviewIssue>,
}

fn is_skipped_directory(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | ".linco-latex"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".cache"
            | "outputs"
            | "checkpoints"
            | "wandb"
    ) || name.starts_with('.')
}

fn is_context_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("readme")
        || matches!(
            lower.as_str(),
            "cargo.toml"
                | "package.json"
                | "pyproject.toml"
                | "requirements.txt"
                | "environment.yml"
                | "go.mod"
                | "pom.xml"
                | "makefile"
        )
    {
        return true;
    }
    matches!(
        Path::new(&lower)
            .extension()
            .and_then(|value| value.to_str()),
        Some(
            "md" | "rst"
                | "txt"
                | "py"
                | "rs"
                | "ts"
                | "tsx"
                | "js"
                | "jsx"
                | "c"
                | "cc"
                | "cpp"
                | "h"
                | "hpp"
                | "go"
                | "java"
                | "kt"
                | "toml"
                | "yaml"
                | "yml"
                | "json"
                | "tex"
                | "bib"
                | "sty"
                | "cls"
        )
    )
}

fn context_terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for raw in text.split(|character: char| !character.is_alphanumeric() && character != '_') {
        let token = raw.trim().to_ascii_lowercase();
        if token.len() < 4
            || token.len() > 48
            || matches!(
                token.as_str(),
                "this"
                    | "that"
                    | "with"
                    | "from"
                    | "have"
                    | "will"
                    | "which"
                    | "their"
                    | "there"
                    | "using"
                    | "section"
                    | "begin"
                    | "end"
                    | "text"
                    | "document"
                    | "figure"
                    | "table"
                    | "equation"
                    | "cite"
                    | "citep"
                    | "citet"
                    | "label"
                    | "includegraphics"
                    | "textbf"
                    | "emph"
            )
            || !seen.insert(token.clone())
        {
            continue;
        }
        terms.push(token);
        if terms.len() >= 24 {
            break;
        }
    }
    terms
}

fn candidate_priority(relative: &str, name: &str, terms: &[String]) -> i32 {
    let lower_name = name.to_ascii_lowercase();
    let lower_path = relative.to_ascii_lowercase();
    let mut score = 0;
    if lower_name.starts_with("readme") {
        score += 120;
    }
    if matches!(
        lower_name.as_str(),
        "cargo.toml" | "package.json" | "pyproject.toml" | "requirements.txt" | "environment.yml"
    ) {
        score += 100;
    }
    match Path::new(&lower_name)
        .extension()
        .and_then(|value| value.to_str())
    {
        Some("tex" | "bib") => score += 65,
        Some("py" | "rs" | "ts" | "tsx" | "cpp" | "cc" | "go" | "java") => score += 45,
        Some("md" | "rst") => score += 35,
        _ => {}
    }
    score += terms
        .iter()
        .filter(|term| lower_path.contains(term.as_str()))
        .count() as i32
        * 35;
    score - relative.matches('/').count() as i32 * 2
}

fn relative_local(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn discover_local(root: &str, terms: &[String]) -> Result<Vec<Candidate>, String> {
    let root_path = PathBuf::from(root);
    if !root_path.is_dir() {
        return Err("The repository directory does not exist.".into());
    }
    let mut queue = VecDeque::from([(root_path.clone(), 0usize)]);
    let mut candidates = Vec::new();
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 5 || candidates.len() >= MAX_DISCOVERED_FILES {
            continue;
        }
        for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = match entry {
                Ok(value) => value,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = match entry.file_type() {
                Ok(value) => value,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if !is_skipped_directory(&name) {
                    queue.push_back((entry.path(), depth + 1));
                }
                continue;
            }
            if !file_type.is_file() || !is_context_file(&name) {
                continue;
            }
            let path = entry.path();
            let relative = relative_local(&root_path, &path);
            candidates.push(Candidate {
                path: path.to_string_lossy().to_string(),
                priority: candidate_priority(&relative, &name, terms),
                relative,
                name,
            });
            if candidates.len() >= MAX_DISCOVERED_FILES {
                break;
            }
        }
    }
    Ok(candidates)
}

fn remote_relative(root: &str, path: &str) -> String {
    path.trim_start_matches(root.trim_end_matches('/'))
        .trim_start_matches('/')
        .to_string()
}

fn discover_remote(host: &str, root: &str, terms: &[String]) -> Result<Vec<Candidate>, String> {
    let mut queue = VecDeque::from([(root.to_string(), 0usize)]);
    let mut candidates = Vec::new();
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 5 || candidates.len() >= MAX_DISCOVERED_FILES {
            continue;
        }
        for entry in crate::remote::list_dir(host, &directory)? {
            if entry.is_dir {
                if !is_skipped_directory(&entry.name) {
                    queue.push_back((entry.path, depth + 1));
                }
                continue;
            }
            if !is_context_file(&entry.name) {
                continue;
            }
            let relative = remote_relative(root, &entry.path);
            candidates.push(Candidate {
                path: entry.path,
                priority: candidate_priority(&relative, &entry.name, terms),
                relative,
                name: entry.name,
            });
            if candidates.len() >= MAX_DISCOVERED_FILES {
                break;
            }
        }
    }
    Ok(candidates)
}

fn search_pattern(terms: &[String]) -> Option<String> {
    let pattern = terms
        .iter()
        .filter(|term| term.len() >= 5)
        .take(14)
        .map(|term| regex::escape(term))
        .collect::<Vec<_>>()
        .join("|");
    (!pattern.is_empty()).then_some(pattern)
}

fn normalize_search_path(value: &str) -> String {
    value.trim().trim_start_matches("./").replace('\\', "/")
}

fn matching_repository_paths(repo: &str, terms: &[String], host: Option<&str>) -> HashSet<String> {
    let Some(pattern) = search_pattern(terms) else {
        return HashSet::new();
    };
    let output = if let Some(remote_host) = host.filter(|value| !value.is_empty()) {
        let command = format!(
            "cd -- {repo} && if command -v rg >/dev/null 2>&1; then \
             rg --files-with-matches --ignore-case --max-count 1 --max-filesize 1M \
             -- {pattern} . | head -n 100; fi",
            repo = crate::remote::shq(repo),
            pattern = crate::remote::shq(&pattern)
        );
        crate::remote::run_remote(remote_host, &command)
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_default()
    } else {
        let arguments = [
            "--files-with-matches",
            "--ignore-case",
            "--max-count",
            "1",
            "--max-filesize",
            "1M",
            "--",
            pattern.as_str(),
            ".",
        ];
        let mut command: Command = crate::proc_ext::cli_command("rg", &arguments);
        command
            .current_dir(repo)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::proc_ext::no_window(&mut command);
        command
            .output()
            .ok()
            .filter(|result| result.status.success())
            .map(|result| String::from_utf8_lossy(&result.stdout).to_string())
            .unwrap_or_default()
    };
    output
        .lines()
        .map(normalize_search_path)
        .filter(|path| !path.is_empty())
        .take(100)
        .collect()
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

fn useful_excerpt(source: &str, name: &str, terms: &[String]) -> String {
    let lower_name = name.to_ascii_lowercase();
    let keep_leading = lower_name.starts_with("readme")
        || matches!(
            lower_name.as_str(),
            "cargo.toml"
                | "package.json"
                | "pyproject.toml"
                | "requirements.txt"
                | "environment.yml"
        );
    let declaration = regex::Regex::new(
        r"(?i)^\s*(class|struct|enum|trait|interface|def|fn|function|const|pub\s+fn|export\s+(?:default\s+)?(?:class|function|const))\b",
    )
    .expect("valid declaration regex");
    let mut selected = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        let matches_term = terms.iter().any(|term| lower.contains(term));
        if (keep_leading && index < 36) || matches_term || declaration.is_match(line) {
            let trimmed = line.trim_end();
            if !trimmed.is_empty() {
                selected.push(trimmed);
            }
        }
        if selected.len() >= 55 {
            break;
        }
    }
    let excerpt = if selected.is_empty() {
        source.lines().take(45).collect::<Vec<_>>().join("\n")
    } else {
        selected.join("\n")
    };
    truncate_chars(&excerpt, MAX_FILE_CHARS)
}

fn collect_evidence(
    repo: &str,
    current_file: &str,
    text: &str,
    host: Option<&str>,
) -> Result<(Vec<Evidence>, usize), String> {
    let terms = context_terms(text);
    let mut candidates = if let Some(remote_host) = host.filter(|value| !value.is_empty()) {
        discover_remote(remote_host, repo, &terms)?
    } else {
        discover_local(repo, &terms)?
    };
    candidates.retain(|candidate| candidate.path != current_file);
    let matched_paths = matching_repository_paths(repo, &terms, host);
    for candidate in &mut candidates {
        if matched_paths.contains(&normalize_search_path(&candidate.relative)) {
            candidate.priority += 180;
        }
    }
    candidates.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then(left.relative.cmp(&right.relative))
    });
    let files_considered = candidates.len();
    let mut evidence = Vec::new();
    let mut total = 0usize;
    for candidate in candidates.into_iter().take(40) {
        let source = if let Some(remote_host) = host.filter(|value| !value.is_empty()) {
            crate::remote::read_file(remote_host, &candidate.path)
        } else {
            std::fs::read_to_string(&candidate.path).map_err(|error| error.to_string())
        };
        let Ok(source) = source else {
            continue;
        };
        if source.len() > 1_000_000 || source.as_bytes().iter().take(8_000).any(|byte| *byte == 0) {
            continue;
        }
        let excerpt = useful_excerpt(&source, &candidate.name, &terms);
        if excerpt.trim().is_empty() {
            continue;
        }
        let remaining = MAX_EVIDENCE_CHARS.saturating_sub(total);
        if remaining < 300 {
            break;
        }
        let excerpt = truncate_chars(&excerpt, remaining.min(MAX_FILE_CHARS));
        total += excerpt.chars().count();
        evidence.push(Evidence {
            path: candidate.relative,
            excerpt,
        });
        if evidence.len() >= MAX_EVIDENCE_FILES || total >= MAX_EVIDENCE_CHARS {
            break;
        }
    }
    Ok((evidence, files_considered))
}

fn selected_agent() -> Result<AgentConfig, String> {
    let config = crate::config::load_config()?;
    config
        .agents
        .iter()
        .find(|agent| agent.id == config.default_agent)
        .or_else(|| config.agents.first())
        .cloned()
        .ok_or_else(|| "Configure an agent before requesting repository suggestions.".into())
}

fn selected_model(agent: &AgentConfig) -> String {
    if !agent.model.trim().is_empty() {
        return agent.model.trim().to_string();
    }
    agent
        .models
        .iter()
        .find(|model| !model.trim().is_empty())
        .map(|model| model.trim().to_string())
        .unwrap_or_default()
}

fn prompt_for(
    repo: &str,
    current_file: &str,
    before: &str,
    selection: &str,
    after: &str,
    evidence: &[Evidence],
    project_aware: bool,
) -> String {
    let evidence_text = if evidence.is_empty() {
        "(No repository evidence matched this passage.)".to_string()
    } else {
        evidence
            .iter()
            .map(|item| format!("--- {} ---\n{}", item.path, item.excerpt))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let editor_role = if project_aware {
        "You are Linco's repository-aware scientific writing editor."
    } else {
        "You are Linco's scientific writing editor."
    };
    let grounding_rules = if project_aware {
        r#"- Use concrete class, function, dataset, metric, configuration, or method names only when supported by REPOSITORY EVIDENCE.
- Do not invent numerical results, implementation details, citations, or terminology.
- Every repository-specific claim must be supported by at least one path in evidence.
- General spelling, grammar, and clarity improvements to selected text do not require repository evidence."#
    } else {
        r#"- Use only SELECTED TEXT and the surrounding prose supplied below.
- Do not inspect or rely on repository files, tools, or external sources.
- Do not invent numerical results, implementation details, citations, or terminology.
- Keep every edit's evidence array and the top-level evidence array empty."#
    };
    let repository_context = if project_aware {
        format!(
            "Repository: {repo}\nCurrent manuscript: {current_file}\n\nREPOSITORY EVIDENCE:\n{evidence_text}"
        )
    } else {
        format!("Current manuscript: {current_file}")
    };
    format!(
        r#"{editor_role}
Polish the selected LaTeX passage or continue the manuscript exactly at <CURSOR>. Return JSON only:
{{"suggestion":"complete revised selected text","edits":[{{"original":"exact text from the selection","replacement":"replacement text","reason":"brief explanation","evidence":["relative/path.ext"]}}],"evidence":["relative/path.ext"]}}

Rules:
- If SELECTED TEXT is non-empty, make only necessary local edits for correctness and clarity. Preserve every phrase that does not need changing so the result can be reviewed as a concise word-level diff.
- Do not rewrite the passage wholesale, change its voice, or introduce stylistic alternatives when the original wording is already clear.
- Check connections between sentences and between this passage and the surrounding paragraphs. An edit may replace a word, phrase, or complete sentence when cohesion requires it.
- Put every independent change in edits. Each original must be a non-empty, exact, uniquely occurring substring of SELECTED TEXT. Edits must not overlap and must appear in source order.
- suggestion must equal SELECTED TEXT after applying edits. If no change is needed, return SELECTED TEXT unchanged with an empty edits array.
- Never return an empty suggestion for non-empty SELECTED TEXT. If no change is needed, return the original selection unchanged.
- If SELECTED TEXT is empty, insert one concise phrase or at most three sentences at <CURSOR>.
- Preserve LaTeX syntax and the manuscript's language and terminology.
{grounding_rules}
- Return an empty suggestion only when SELECTED TEXT is empty and no useful cursor completion can be made.
- Return insertion text only in suggestion, without quotation commentary or Markdown fences.

TEXT BEFORE CURSOR:
{before}
<CURSOR>
SELECTED TEXT TO REPLACE:
{selection}
TEXT AFTER CURSOR:
{after}

{repository_context}
"#
    )
}

fn review_prompt_for(
    repo: &str,
    current_file: &str,
    segments: &[LatexReviewSegment],
    evidence: &[Evidence],
) -> Result<String, String> {
    let segment_text = serde_json::to_string(segments).map_err(|error| error.to_string())?;
    let evidence_text = if evidence.is_empty() {
        "(No repository evidence matched these paragraphs.)".to_string()
    } else {
        evidence
            .iter()
            .map(|item| format!("--- {} ---\n{}", item.path, item.excerpt))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    Ok(format!(
        r#"You are Linco's scientific writing reviewer.
Review each LaTeX prose segment independently. Return JSON only:
{{"issues":[{{"segmentId":"segment id","original":"exact substring","replacement":"replacement text","reason":"short explanation","category":"spelling|grammar|clarity|consistency","evidence":["relative/path.ext"]}}]}}

Rules:
- Review only SEGMENTS JSON below. Do not inspect files, call tools, or search the repository.
- Report only clear, actionable problems. Do not offer optional stylistic rewrites.
- `original` must be an exact, contiguous substring copied from that segment and must identify the smallest useful correction.
- Preserve all LaTeX commands, citations, references, math, labels, and braces exactly unless the command itself is malformed.
- Use category `consistency` when repository terminology or implementation names disagree with the manuscript.
- Repository-specific corrections must cite supporting paths from REPOSITORY EVIDENCE.
- Spelling and grammar corrections do not require repository evidence.
- Do not invent results, numbers, citations, APIs, datasets, or implementation details.
- Return at most two issues per segment and at most twenty issues in total.
- If a segment has no clear problem, return no issue for it.

Repository: {repo}
Current manuscript: {current_file}

SEGMENTS JSON:
{segment_text}

REPOSITORY EVIDENCE:
{evidence_text}
"#
    ))
}

fn append_path(base: &str, suffix: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), suffix)
}

fn parse_openai_response(value: &Value) -> Option<String> {
    value
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            value
                .get("output")
                .and_then(Value::as_array)?
                .iter()
                .flat_map(|item| {
                    item.get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .find_map(|item| item.get("text").and_then(Value::as_str).map(str::to_string))
        })
}

async fn call_api(
    agent: &AgentConfig,
    prompt: &str,
    max_output_tokens: usize,
) -> Result<String, String> {
    let provider = agent.provider.trim().to_ascii_lowercase();
    let model = selected_model(agent);
    if model.is_empty() {
        return Err("Select a model before requesting LaTeX suggestions.".into());
    }
    let key = agent.api_key.trim();
    if key.is_empty() {
        return Err("The selected agent has no API key.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(75))
        .build()
        .map_err(|error| error.to_string())?;

    let (_url, builder, body) = if provider == "anthropic" {
        let base = if agent.base_url.trim().is_empty() {
            "https://api.anthropic.com".to_string()
        } else {
            agent.base_url.trim_end_matches('/').to_string()
        };
        let url = if base.ends_with("/v1") {
            append_path(&base, "/messages")
        } else {
            append_path(&base, "/v1/messages")
        };
        let builder = client
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
        (
            url,
            builder,
            json!({
                "model": model,
                "max_tokens": max_output_tokens,
                "messages": [{"role": "user", "content": prompt}]
            }),
        )
    } else if provider == "openai" {
        let base = if agent.base_url.trim().is_empty() {
            "https://api.openai.com/v1".to_string()
        } else {
            agent.base_url.trim_end_matches('/').to_string()
        };
        let url = append_path(&base, "/responses");
        let builder = client.post(&url).bearer_auth(key);
        (
            url,
            builder,
            json!({
                "model": model,
                "input": prompt,
                "max_output_tokens": max_output_tokens
            }),
        )
    } else {
        let base = if agent.base_url.trim().is_empty() {
            "https://openrouter.ai/api/v1".to_string()
        } else {
            agent.base_url.trim_end_matches('/').to_string()
        };
        let url = append_path(&base, "/chat/completions");
        let builder = client.post(&url).bearer_auth(key);
        (
            url,
            builder,
            json!({
                "model": model,
                "max_tokens": max_output_tokens,
                "messages": [{"role": "user", "content": prompt}]
            }),
        )
    };
    let response = builder
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("LaTeX suggestion request failed: {error}"))?;
    let status = response.status();
    let response_text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "LaTeX suggestion model returned HTTP {}: {}",
            status.as_u16(),
            truncate_chars(&response_text, 400)
        ));
    }
    let value: Value = serde_json::from_str(&response_text)
        .map_err(|error| format!("Invalid model response: {error}"))?;
    if provider == "anthropic" {
        return value
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find_map(|item| item.get("text").and_then(Value::as_str))
            })
            .map(str::to_string)
            .ok_or_else(|| "The model returned no suggestion text.".into());
    }
    if provider == "openai" {
        return parse_openai_response(&value)
            .ok_or_else(|| "The model returned no suggestion text.".into());
    }
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "The model returned no suggestion text.".into())
}

fn command_head(command: &str, fallback: &str) -> String {
    command
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .trim_matches('"')
        .to_string()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentPromptKind {
    Completion,
    Review,
}

fn run_local_cli(
    agent: &AgentConfig,
    repo: &str,
    prompt: &str,
    kind: AgentPromptKind,
) -> Result<String, String> {
    let fallback = if agent.provider == "openai" {
        "codex"
    } else {
        "claude"
    };
    let executable = command_head(&agent.command, fallback);
    let is_codex = agent.provider == "openai"
        || executable
            .to_ascii_lowercase()
            .trim_end_matches(".exe")
            .ends_with("codex");
    let model = selected_model(agent);
    let mut arguments = if is_codex {
        let mut values = vec![
            "exec".to_string(),
            "--ephemeral".to_string(),
            "--ignore-rules".to_string(),
            "-c".to_string(),
            "mcp_servers={}".to_string(),
            "--sandbox".to_string(),
            "read-only".to_string(),
            "--skip-git-repo-check".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "-C".to_string(),
            repo.to_string(),
        ];
        if kind == AgentPromptKind::Review {
            values.extend([
                "-c".to_string(),
                "model_reasoning_effort=\"low\"".to_string(),
            ]);
        }
        values
    } else {
        vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "text".to_string(),
            "--permission-mode".to_string(),
            "plan".to_string(),
        ]
    };
    if !model.is_empty() {
        arguments.extend(["--model".to_string(), model]);
    }
    if is_codex {
        arguments.push("-".to_string());
    }
    let refs = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    let mut command = crate::proc_ext::cli_command(&executable, &refs);
    command
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start {executable}: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{} suggestion failed: {}",
            executable,
            truncate_chars(&String::from_utf8_lossy(&output.stderr), 500)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_remote_cli(
    agent: &AgentConfig,
    host: &str,
    repo: &str,
    prompt: &str,
    kind: AgentPromptKind,
) -> Result<String, String> {
    let fallback = if agent.provider == "openai" {
        "codex"
    } else {
        "claude"
    };
    let executable = command_head(&agent.command, fallback);
    let is_codex = agent.provider == "openai" || executable.ends_with("codex");
    let model = selected_model(agent);
    let mut command = if is_codex {
        let mut value = format!(
            "cd -- {repo} && {exe} exec --ephemeral --ignore-rules -c {mcp} --sandbox read-only --skip-git-repo-check --color never",
            repo = crate::remote::shq(repo),
            exe = crate::remote::shq(&executable),
            mcp = crate::remote::shq("mcp_servers={}")
        );
        if kind == AgentPromptKind::Review {
            value.push_str(&format!(
                " -c {}",
                crate::remote::shq("model_reasoning_effort=\"low\"")
            ));
        }
        value
    } else {
        format!(
            "cd -- {repo} && {exe} -p --output-format text --permission-mode plan",
            repo = crate::remote::shq(repo),
            exe = crate::remote::shq(&executable)
        )
    };
    if !model.is_empty() {
        command.push_str(&format!(" --model {}", crate::remote::shq(&model)));
    }
    if is_codex {
        command.push_str(" -");
    }
    let output = crate::remote::run_remote_oneshot_pub(host, &command, Some(prompt.as_bytes()))?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

async fn run_agent_prompt(
    agent: &AgentConfig,
    repo: &str,
    prompt: &str,
    host: Option<&str>,
    max_output_tokens: usize,
    kind: AgentPromptKind,
) -> Result<String, String> {
    if agent.auth_mode != "subscription" && !agent.api_key.trim().is_empty() {
        return call_api(agent, prompt, max_output_tokens).await;
    }
    let agent_for_cli = agent.clone();
    let repo_for_cli = repo.to_string();
    let prompt_for_cli = prompt.to_string();
    let host_for_cli = host.map(str::to_string);
    crate::blocking::run(move || {
        if let Some(remote_host) = host_for_cli.as_deref().filter(|value| !value.is_empty()) {
            run_remote_cli(
                &agent_for_cli,
                remote_host,
                &repo_for_cli,
                &prompt_for_cli,
                kind,
            )
        } else {
            run_local_cli(&agent_for_cli, &repo_for_cli, &prompt_for_cli, kind)
        }
    })
    .await
}

fn json_object_slice(raw: &str) -> &str {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end >= start => &trimmed[start..=end],
        _ => trimmed,
    }
}

fn parse_model_suggestion(
    raw: &str,
    selection: &str,
    available: &[String],
) -> Result<ModelSuggestion, String> {
    let trimmed = raw.trim();
    let json_slice = json_object_slice(raw);
    let mut parsed =
        serde_json::from_str::<ModelSuggestion>(json_slice).unwrap_or_else(|_| ModelSuggestion {
            suggestion: trimmed.to_string(),
            edits: Vec::new(),
            evidence: Vec::new(),
        });
    parsed.suggestion = truncate_chars(parsed.suggestion.trim(), 6_000);
    parsed.evidence.retain(|path| available.contains(path));
    parsed.evidence.dedup();
    if parsed.suggestion.is_empty() {
        return Err("No text was available to polish at the current cursor.".into());
    }
    let mut mapped = Vec::new();
    for mut edit in parsed.edits {
        edit.original = edit.original.trim().to_string();
        edit.replacement = edit.replacement.trim().to_string();
        edit.reason = truncate_chars(edit.reason.trim(), 300);
        edit.evidence.retain(|path| available.contains(path));
        edit.evidence.dedup();
        if edit.original.is_empty() || edit.original == edit.replacement {
            continue;
        }
        let Some(offset) = selection.find(&edit.original) else {
            continue;
        };
        if selection[offset + edit.original.len()..].contains(&edit.original) {
            continue;
        }
        mapped.push((offset, edit));
    }
    mapped.sort_by_key(|(offset, _)| *offset);

    let mut accepted = Vec::new();
    let mut previous_end = 0;
    for (offset, edit) in mapped {
        if offset < previous_end {
            continue;
        }
        previous_end = offset + edit.original.len();
        accepted.push((offset, edit));
        if accepted.len() >= 20 {
            break;
        }
    }

    if !selection.is_empty() {
        if accepted.is_empty() {
            if parsed.suggestion == selection {
                parsed.edits = Vec::new();
                return Ok(parsed);
            }
            return Err(
                "The model did not return any individually reviewable polish edits.".into(),
            );
        }
        let mut revised = String::with_capacity(selection.len());
        let mut cursor = 0;
        for (offset, edit) in &accepted {
            revised.push_str(&selection[cursor..*offset]);
            revised.push_str(&edit.replacement);
            cursor = offset + edit.original.len();
        }
        revised.push_str(&selection[cursor..]);
        parsed.suggestion = revised;
    }
    parsed.edits = accepted.into_iter().map(|(_, edit)| edit).collect();
    Ok(parsed)
}

fn parse_model_review(
    raw: &str,
    segments: &[LatexReviewSegment],
    available: &[String],
) -> Result<Vec<LatexReviewIssue>, String> {
    let parsed = serde_json::from_str::<ModelReview>(json_object_slice(raw))
        .map_err(|error| format!("Invalid paragraph review response: {error}"))?;
    let mut issues = Vec::new();
    let mut seen = HashSet::new();
    for mut issue in parsed.issues {
        if issues.len() >= 20 {
            break;
        }
        let Some(segment) = segments
            .iter()
            .find(|segment| segment.id == issue.segment_id)
        else {
            continue;
        };
        if issue.original.trim().is_empty()
            || issue.replacement.trim().is_empty()
            || issue.original == issue.replacement
            || issue.original.chars().count() > 1_600
            || issue.replacement.chars().count() > 1_600
            || segment.text.match_indices(&issue.original).take(2).count() != 1
        {
            continue;
        }
        let signature = format!(
            "{}\0{}\0{}",
            issue.segment_id, issue.original, issue.replacement
        );
        if !seen.insert(signature) {
            continue;
        }
        issue.evidence.retain(|path| available.contains(path));
        issue.evidence.sort();
        issue.evidence.dedup();
        let category = match issue.category.trim().to_ascii_lowercase().as_str() {
            "spelling" => "spelling",
            "grammar" => "grammar",
            "consistency" => "consistency",
            _ => "clarity",
        };
        if category == "consistency" && issue.evidence.is_empty() {
            continue;
        }
        issues.push(LatexReviewIssue {
            segment_id: issue.segment_id,
            original: issue.original,
            replacement: issue.replacement,
            reason: truncate_chars(issue.reason.trim(), 280),
            category: category.to_string(),
            evidence: issue.evidence,
        });
    }
    Ok(issues)
}

#[tauri::command]
pub async fn latex_ai_suggest(
    repo: String,
    current_file: String,
    before: String,
    selection: String,
    after: String,
    project_aware: bool,
    host: Option<String>,
) -> Result<LatexAiSuggestion, String> {
    if repo.trim().is_empty() || current_file.trim().is_empty() {
        return Err("Open a repository LaTeX file before requesting a suggestion.".into());
    }
    let (evidence, files_considered) = if project_aware {
        let host_for_context = host.clone();
        let repo_for_context = repo.clone();
        let file_for_context = current_file.clone();
        let context_text = format!("{before}\n{selection}\n{after}");
        crate::blocking::run(move || {
            collect_evidence(
                &repo_for_context,
                &file_for_context,
                &context_text,
                host_for_context.as_deref(),
            )
        })
        .await?
    } else {
        (Vec::new(), 0)
    };
    let prompt = prompt_for(
        &repo,
        &current_file,
        &before,
        &selection,
        &after,
        &evidence,
        project_aware,
    );
    let agent = selected_agent()?;
    let raw = run_agent_prompt(
        &agent,
        &repo,
        &prompt,
        host.as_deref(),
        1_500,
        AgentPromptKind::Completion,
    )
    .await?;
    let available = evidence
        .iter()
        .map(|item| item.path.clone())
        .collect::<Vec<_>>();
    let parsed = parse_model_suggestion(&raw, &selection, &available)?;
    let model = selected_model(&agent);
    Ok(LatexAiSuggestion {
        suggestion: parsed.suggestion,
        edits: parsed
            .edits
            .into_iter()
            .map(|edit| LatexPolishEdit {
                original: edit.original,
                replacement: edit.replacement,
                reason: edit.reason,
                evidence: edit.evidence,
            })
            .collect(),
        evidence: if parsed.evidence.is_empty() {
            available.into_iter().take(3).collect()
        } else {
            parsed.evidence
        },
        agent: agent.name,
        model,
        files_considered,
    })
}

#[tauri::command]
pub async fn latex_ai_review(
    repo: String,
    current_file: String,
    segments: Vec<LatexReviewSegment>,
    host: Option<String>,
) -> Result<LatexReviewResult, String> {
    if repo.trim().is_empty() || current_file.trim().is_empty() {
        return Err("Open a repository LaTeX file before reviewing prose.".into());
    }
    let mut accepted_segments = Vec::new();
    let mut total_chars = 0usize;
    for mut segment in segments.into_iter().take(8) {
        segment.id = truncate_chars(segment.id.trim(), 160);
        segment.text = truncate_chars(&segment.text, 2_600);
        let length = segment.text.chars().count();
        if segment.id.is_empty() || segment.text.trim().is_empty() || length < 8 {
            continue;
        }
        if total_chars + length > 13_000 {
            break;
        }
        total_chars += length;
        accepted_segments.push(segment);
    }
    if accepted_segments.is_empty() {
        return Ok(LatexReviewResult {
            issues: Vec::new(),
            agent: String::new(),
            model: String::new(),
            files_considered: 0,
        });
    }

    // Automatic proofreading stays local to the selected file's prose. Repository-wide
    // evidence collection is reserved for the explicit completion command.
    let evidence = Vec::new();
    let files_considered = 0;
    let prompt = review_prompt_for(&repo, &current_file, &accepted_segments, &evidence)?;
    let agent = selected_agent()?;
    let raw = run_agent_prompt(
        &agent,
        &repo,
        &prompt,
        host.as_deref(),
        1_600,
        AgentPromptKind::Review,
    )
    .await?;
    let available = evidence
        .iter()
        .map(|item| item.path.clone())
        .collect::<Vec<_>>();
    let issues = parse_model_review(&raw, &accepted_segments, &available)?;
    let model = selected_model(&agent);
    Ok(LatexReviewResult {
        issues,
        agent: agent.name,
        model,
        files_considered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn extracts_repository_terms_and_filters_generic_words() {
        let terms = context_terms(
            "The ReliabilityMemory module uses peer_specific_scores from the trainer.",
        );
        assert!(terms.contains(&"reliabilitymemory".to_string()));
        assert!(terms.contains(&"peer_specific_scores".to_string()));
        assert!(!terms.contains(&"the".to_string()));
    }

    #[test]
    fn parses_json_and_rejects_unavailable_evidence() {
        let parsed = parse_model_suggestion(
            r#"{
              "suggestion":"uses ReliabilityMemory.",
              "edits":[{
                "original":"use ReliabilityMemory",
                "replacement":"uses ReliabilityMemory",
                "reason":"Subject-verb agreement",
                "evidence":["src/model.py","invented.txt"]
              }],
              "evidence":["src/model.py","invented.txt"]
            }"#,
            "use ReliabilityMemory.",
            &["src/model.py".into()],
        )
        .unwrap();
        assert_eq!(parsed.suggestion, "uses ReliabilityMemory.");
        assert_eq!(parsed.evidence, vec!["src/model.py"]);
        assert_eq!(parsed.edits.len(), 1);
        assert_eq!(parsed.edits[0].evidence, vec!["src/model.py"]);
    }

    #[test]
    fn completion_prompt_allows_language_edits_without_repository_evidence() {
        let prompt = prompt_for(
            "repo",
            "paper/main.tex",
            "Before.",
            "This method are reliable.",
            "After.",
            &[],
            true,
        );
        assert!(prompt.contains("do not require repository evidence"));
        assert!(prompt.contains("No repository evidence matched this passage"));
        assert!(prompt.contains("connections between sentences"));
        assert!(prompt.contains("between this passage and the surrounding paragraphs"));
    }

    #[test]
    fn standard_completion_prompt_avoids_repository_grounding() {
        let prompt = prompt_for(
            "repo",
            "paper/main.tex",
            "Before.",
            "This method are reliable.",
            "After.",
            &[],
            false,
        );
        assert!(prompt.contains("scientific writing editor"));
        assert!(prompt.contains("Do not inspect or rely on repository files"));
        assert!(!prompt.contains("No repository evidence matched this passage"));
        assert!(!prompt.contains("Repository: repo"));
    }

    #[test]
    fn source_declarations_are_kept_in_evidence_excerpt() {
        let source = "noise\nfn score_peer(input: Tensor) -> Tensor {\n  input\n}\n";
        let excerpt = useful_excerpt(source, "model.rs", &[]);
        assert!(excerpt.contains("fn score_peer"));
        assert!(!excerpt.contains("noise"));
    }

    #[test]
    fn repository_evidence_includes_matching_code_and_excludes_current_manuscript() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("linco-latex-ai-{nonce}"));
        let source_dir = root.join("src");
        let paper_dir = root.join("paper");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::create_dir_all(&paper_dir).unwrap();
        std::fs::write(
            root.join("README.md"),
            "A repository for scientific agents.",
        )
        .unwrap();
        std::fs::write(
            source_dir.join("memory.rs"),
            "pub struct ReliabilityMemory { pub peer_specific_scores: Vec<f32> }",
        )
        .unwrap();
        let manuscript = paper_dir.join("main.tex");
        std::fs::write(
            &manuscript,
            "\\documentclass{article}\\begin{document}ReliabilityMemory\\end{document}",
        )
        .unwrap();

        let (evidence, considered) = collect_evidence(
            root.to_str().unwrap(),
            manuscript.to_str().unwrap(),
            "The ReliabilityMemory module uses peer_specific_scores.",
            None,
        )
        .unwrap();
        assert!(considered >= 2);
        assert!(evidence.iter().any(|item| item.path == "src/memory.rs"));
        assert!(evidence.iter().all(|item| item.path != "paper/main.tex"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn paragraph_review_keeps_only_uniquely_mappable_issues() {
        let segments = vec![
            LatexReviewSegment {
                id: "p1".into(),
                text: "Reliability memory are useful for peer selection.".into(),
            },
            LatexReviewSegment {
                id: "p2".into(),
                text: "The peer and the peer both respond.".into(),
            },
        ];
        let raw = r#"{
          "issues": [
            {
              "segmentId": "p1",
              "original": "memory are",
              "replacement": "memory is",
              "reason": "Subject-verb agreement",
              "category": "grammar",
              "evidence": ["src/memory.rs", "invented.txt"]
            },
            {
              "segmentId": "p1",
              "original": "missing words",
              "replacement": "replacement",
              "category": "clarity"
            },
            {
              "segmentId": "p2",
              "original": "peer",
              "replacement": "agent",
              "category": "consistency"
            },
            {
              "segmentId": "p1",
              "original": "Reliability",
              "replacement": "Trust",
              "category": "consistency",
              "evidence": ["invented.txt"]
            }
          ]
        }"#;
        let issues = parse_model_review(raw, &segments, &["src/memory.rs".into()]).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].original, "memory are");
        assert_eq!(issues[0].replacement, "memory is");
        assert_eq!(issues[0].evidence, vec!["src/memory.rs"]);
    }
}
