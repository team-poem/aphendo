use chrono::NaiveDate;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(240);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// Baked in at build time so a fresh install only needs its token.
const DEFAULT_MCP_URL: Option<&str> = option_env!("CAPTURE_TODO_DEFAULT_MCP_URL");

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ExtractedTodo {
    pub title: String,
    pub due: Option<NaiveDate>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_token: Option<String>,
}

fn nonempty(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn read_file(data_dir: &Path) -> Result<Config, String> {
    match std::fs::read(data_dir.join("config.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("config.json 형식 오류: {e}")),
        Err(_) => Ok(Config::default()),
    }
}

/// http(s) with a host; anything else would only fail later at capture time.
pub fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("MCP 주소 형식 오류: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("MCP 주소는 http:// 또는 https:// 로 시작해야 합니다".into());
    }
    Ok(url.to_string())
}

impl Config {
    /// `config.json` in the data dir, then `MCP_URL`/`MCP_TOKEN` env, then the built-in URL.
    /// Read per job so editing config.json takes effect without a restart.
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let file = read_file(data_dir)?;
        Ok(Config {
            mcp_url: nonempty(file.mcp_url)
                .or_else(|| nonempty(std::env::var("MCP_URL").ok()))
                .or_else(|| DEFAULT_MCP_URL.map(String::from)),
            mcp_token: nonempty(file.mcp_token).or_else(|| nonempty(std::env::var("MCP_TOKEN").ok())),
        })
    }

    /// Writes `config.json` atomically. A missing or blank token keeps the stored one.
    /// An unreadable config.json is replaced: the settings dialog is how the user repairs it.
    pub fn save(data_dir: &Path, mcp_url: &str, mcp_token: Option<String>) -> Result<(), String> {
        let mut file = read_file(data_dir).unwrap_or_default();
        file.mcp_url = Some(validate_url(mcp_url)?);
        if let Some(token) = nonempty(mcp_token) {
            file.mcp_token = Some(token);
        }
        let path = data_dir.join("config.json");
        let tmp = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("config.json 저장 실패: {e}"))
    }

    fn transport(&self) -> Result<StreamableHttpClientTransport<reqwest::Client>, String> {
        let url = self.mcp_url.clone().ok_or("MCP 주소 미설정 (⚙ 설정)")?;
        let mut cfg = StreamableHttpClientTransportConfig::with_uri(url);
        if let Some(token) = &self.mcp_token {
            cfg = cfg.auth_header(token.clone());
        }
        Ok(StreamableHttpClientTransport::from_config(cfg))
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Probe {
    Ok { tools: Vec<String> },
    Unauthorized,
    Unreachable { error: String },
}

/// MCP initialize + tools/list, the same handshake a capture starts with.
pub async fn probe(cfg: &Config) -> Probe {
    let run = async {
        let transport = cfg.transport().map_err(|error| Probe::Unreachable { error })?;
        let client = ().serve(transport).await.map_err(|e| {
            // ponytail: rmcp reports a challenge-less 401 only as text ("unexpected server response: HTTP 401 …").
            let full = e.to_string();
            let error = full.split_once("] error: ").map_or(full.as_str(), |(_, rest)| rest).trim().to_string();
            match ["HTTP 401", "HTTP 403", "Auth required", "Insufficient scope"].iter().any(|m| error.contains(m)) {
                true => Probe::Unauthorized,
                false => Probe::Unreachable { error },
            }
        })?;
        let tools = client.list_all_tools().await.map_err(|e| Probe::Unreachable { error: e.to_string() });
        let _ = client.cancel().await;
        Ok::<_, Probe>(Probe::Ok { tools: tools?.into_iter().map(|t| t.name.to_string()).collect() })
    };
    match tokio::time::timeout(PROBE_TIMEOUT, run).await {
        Ok(Ok(p) | Err(p)) => p,
        Err(_) => Probe::Unreachable { error: format!("시간 초과 ({}초)", PROBE_TIMEOUT.as_secs()) },
    }
}

#[derive(Deserialize)]
struct Payload {
    todos: Vec<ExtractedTodo>,
}

/// structuredContent first, then any text block holding the same JSON.
pub fn parse_result(r: CallToolResult) -> Result<Vec<ExtractedTodo>, String> {
    let texts: Vec<&str> = r.content.iter().filter_map(|c| c.as_text()).map(|t| t.text.as_str()).collect();
    if r.is_error == Some(true) {
        return Err(format!("서버 오류: {}", texts.join(" ")));
    }
    if let Some(v) = r.structured_content {
        return serde_json::from_value::<Payload>(v)
            .map(|p| p.todos)
            .map_err(|e| format!("응답 형식 오류: {e}"));
    }
    let mut last_err = "응답에 todos 없음".to_string();
    for t in texts {
        match serde_json::from_str::<Payload>(t) {
            Ok(p) => return Ok(p.todos),
            Err(e) => last_err = format!("응답 형식 오류: {e}"),
        }
    }
    Err(last_err)
}

pub async fn extract_todos(
    cfg: &Config,
    image: &[u8],
    mime_type: &str,
    today: NaiveDate,
) -> Result<Vec<ExtractedTodo>, String> {
    use base64::Engine;
    let transport = cfg.transport()?;
    let args = serde_json::json!({
        "image_base64": base64::engine::general_purpose::STANDARD.encode(image),
        "mime_type": mime_type,
        "today": today.format("%Y-%m-%d").to_string(),
    });
    let call = async {
        // ponytail: one MCP session per capture; pool a client if captures get frequent.
        let client = ()
            .serve(transport)
            .await
            .map_err(|e| format!("MCP 연결 실패: {e}"))?;
        let params = CallToolRequestParams::new("extract_todos")
            .with_arguments(args.as_object().cloned().unwrap_or_default());
        let result = client.call_tool(params).await.map_err(|e| format!("MCP 호출 실패: {e}"));
        let _ = client.cancel().await;
        result
    };
    let result = tokio::time::timeout(TIMEOUT, call)
        .await
        .map_err(|_| format!("시간 초과 ({}초)", TIMEOUT.as_secs()))??;
    parse_result(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ContentBlock;
    use serde_json::json;

    #[test]
    fn parses_structured_content() {
        let r = CallToolResult::structured(json!({"todos": [
            {"title": "보고서 제출", "due": "2026-11-05", "detail": "팀장 결재"},
            {"title": "교육 이수", "due": null, "detail": null}
        ]}));
        let todos = parse_result(r).unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].due, NaiveDate::from_ymd_opt(2026, 11, 5));
        assert_eq!(todos[1].due, None);
    }

    #[test]
    fn falls_back_to_text_json() {
        let r = CallToolResult::success(vec![
            ContentBlock::text("분석 결과"),
            ContentBlock::text(r#"{"todos":[{"title":"회의","due":null,"detail":null}]}"#),
        ]);
        assert_eq!(parse_result(r).unwrap()[0].title, "회의");
    }

    #[test]
    fn rejects_malformed_and_error_results() {
        let bad_date = CallToolResult::structured(json!({"todos": [{"title": "x", "due": "11/05", "detail": null}]}));
        assert!(parse_result(bad_date).unwrap_err().contains("응답 형식 오류"));
        assert!(parse_result(CallToolResult::structured(json!({"items": []}))).is_err());
        assert!(parse_result(CallToolResult::success(vec![ContentBlock::text("not json")])).is_err());
        let err = CallToolResult::error(vec![ContentBlock::text("codex 실패")]);
        assert!(parse_result(err).unwrap_err().contains("codex 실패"));
    }
}
