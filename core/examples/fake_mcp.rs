//! Stand-in for the remote codex MCP server: `cargo run -p core --example fake_mcp`.
//! Serves `extract_todos` on http://127.0.0.1:8787/mcp, requires `Bearer devtoken`,
//! waits FAKE_DELAY seconds (default 3), and returns fixed todos dated off `today`.
use axum::{extract::Request, http::StatusCode, middleware::Next, response::Response};
use chrono::{Duration, NaiveDate};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::transport::streamable_http_server::{session::local::LocalSessionManager, StreamableHttpService};
use rmcp::{schemars, tool, tool_router};

#[derive(Clone)]
struct Fake;

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct Args {
    image_base64: String,
    mime_type: String,
    today: String,
}

#[tool_router(server_handler)]
impl Fake {
    #[tool(description = "Extract todos from a screenshot.")]
    async fn extract_todos(&self, Parameters(a): Parameters<Args>) -> Result<CallToolResult, String> {
        let today = NaiveDate::parse_from_str(&a.today, "%Y-%m-%d").map_err(|e| e.to_string())?;
        if a.image_base64.is_empty() || !a.mime_type.starts_with("image/") {
            return Err("bad image".into());
        }
        let delay = std::env::var("FAKE_DELAY").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        let d = |days: i64| (today + Duration::days(days)).format("%Y-%m-%d").to_string();
        let n = a.image_base64.len() % 2;
        Ok(CallToolResult::structured(serde_json::json!({ "todos": [
            { "title": "정보보안 서약서 제출", "due": d(-1), "detail": "인사팀 메일 회신" },
            { "title": "연말정산 서류 업로드", "due": d(0), "detail": "홈택스 PDF" },
            { "title": "부서 워크숍 참석 여부 회신", "due": d(2), "detail": null },
            { "title": format!("법정의무교육 이수 ({n})"), "due": d(20), "detail": "온라인 4시간" },
            { "title": "사내 동호회 신청", "due": null, "detail": null }
        ]})))
    }
}

async fn require_token(req: Request, next: Next) -> Result<Response, StatusCode> {
    match req.headers().get("authorization").and_then(|v| v.to_str().ok()) {
        Some("Bearer devtoken") => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

#[tokio::main]
async fn main() {
    let mcp = StreamableHttpService::new(|| Ok(Fake), LocalSessionManager::default().into(), Default::default());
    let app = axum::Router::new()
        .nest_service("/mcp", mcp)
        .layer(axum::middleware::from_fn(require_token));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await.unwrap();
    println!("fake MCP on http://127.0.0.1:8787/mcp");
    axum::serve(listener, app).await.unwrap();
}
