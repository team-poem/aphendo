use chrono::NaiveDate;
use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ExtractedTodo {
    pub title: String,
    pub due: Option<NaiveDate>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Config {
    pub mcp_url: Option<String>,
    pub mcp_token: Option<String>,
}

impl Config {
    /// `MCP_URL`/`MCP_TOKEN` env, each overridden by `config.json` in the data dir.
    /// Read per job so editing config.json takes effect without a restart.
    pub fn load(data_dir: &Path) -> Result<Self, String> {
        let file: Config = match std::fs::read(data_dir.join("config.json")) {
            Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("config.json 형식 오류: {e}"))?,
            Err(_) => Config::default(),
        };
        let nonempty = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
        Ok(Config {
            mcp_url: nonempty(file.mcp_url).or_else(|| nonempty(std::env::var("MCP_URL").ok())),
            mcp_token: nonempty(file.mcp_token).or_else(|| nonempty(std::env::var("MCP_TOKEN").ok())),
        })
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
    let url = cfg.mcp_url.clone().ok_or("MCP_URL 미설정 (환경변수 또는 config.json)")?;
    let mut transport_cfg = StreamableHttpClientTransportConfig::with_uri(url);
    if let Some(token) = &cfg.mcp_token {
        transport_cfg = transport_cfg.auth_header(token.clone());
    }
    let args = serde_json::json!({
        "image_base64": base64::engine::general_purpose::STANDARD.encode(image),
        "mime_type": mime_type,
        "today": today.format("%Y-%m-%d").to_string(),
    });
    let call = async {
        // ponytail: one MCP session per capture; pool a client if captures get frequent.
        let client = ()
            .serve(StreamableHttpClientTransport::from_config(transport_cfg))
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
