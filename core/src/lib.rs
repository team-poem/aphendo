pub mod remote;
pub mod store;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use serde::Deserialize;
use axum::{Json, Router};
use std::path::PathBuf;
use std::sync::Arc;
use store::{Capture, CaptureStatus, Store};

pub const PORT: u16 = 47321;

#[derive(Clone)]
struct App {
    store: Arc<Store>,
    dir: PathBuf,
}

/// `CAPTURE_TODO_DATA`, else the OS data dir + `capture-todo`.
pub fn data_dir() -> PathBuf {
    std::env::var_os("CAPTURE_TODO_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| ".".into()).join("capture-todo"))
}

/// Serves `/api/*` on 127.0.0.1:PORT, plus `ui_dir` as static files when given (web mode).
pub async fn serve(dir: PathBuf, ui_dir: Option<PathBuf>) -> std::io::Result<()> {
    let mut app = router(dir)?;
    if let Some(ui) = ui_dir {
        app = app.fallback_service(tower_http::services::ServeDir::new(ui));
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await?;
    axum::serve(listener, app).await
}

pub fn router(dir: PathBuf) -> std::io::Result<Router> {
    std::fs::create_dir_all(dir.join("images"))?;
    let app = App { store: Arc::new(Store::open(&dir)?), dir };
    // The Tauri webview loads the UI from its own origin and calls this server cross-origin.
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(
            ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
                .map(HeaderValue::from_static),
        )
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE]);
    Ok(Router::new()
        .route("/api/state", get(get_state))
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/config/test", post(test_config))
        .route("/api/captures", post(post_capture))
        .route("/api/captures/{id}/image", get(capture_image))
        .route("/api/captures/{id}/retry", post(retry_capture))
        .route("/api/todos", post(add_todo))
        .route("/api/todos/{id}", patch(patch_todo).delete(delete_todo))
        .layer(DefaultBodyLimit::max(30 * 1024 * 1024))
        .layer(cors)
        .with_state(app))
}

type ApiResult = Result<Response, (StatusCode, String)>;

fn internal(e: std::io::Error) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn mime_for(image: &str) -> &'static str {
    if image.ends_with(".jpg") {
        "image/jpeg"
    } else {
        "image/png"
    }
}

async fn get_state(State(app): State<App>) -> Json<store::Data> {
    Json(app.store.snapshot())
}

async fn post_capture(State(app): State<App>, headers: HeaderMap, body: Bytes) -> ApiResult {
    let ext = match headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        other => return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, format!("png/jpeg만 지원: {other:?}"))),
    };
    if body.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "빈 이미지".into()));
    }
    let id = store::new_id();
    let image = format!("{id}.{ext}");
    tokio::fs::write(app.dir.join("images").join(&image), &body).await.map_err(internal)?;
    let capture = app.store.create_capture(id, image).map_err(internal)?;
    tokio::spawn(run(app, capture.clone()));
    Ok((StatusCode::CREATED, Json(capture)).into_response())
}

/// The file name comes from the store (server-generated), never from the request.
async fn capture_image(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let Some(image) = app.store.snapshot().captures.into_iter().find(|c| c.id == id).map(|c| c.image) else {
        return Err((StatusCode::NOT_FOUND, "없는 캡처".into()));
    };
    let bytes = tokio::fs::read(app.dir.join("images").join(&image)).await.map_err(internal)?;
    // Stored images never change, so the gallery's re-renders hit the cache.
    let cache = (header::CACHE_CONTROL, "max-age=31536000, immutable");
    Ok(([(header::CONTENT_TYPE, mime_for(&image)), cache], bytes).into_response())
}

async fn retry_capture(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    match app.store.retry(&id).map_err(internal)? {
        Some(capture) => {
            tokio::spawn(run(app, capture.clone()));
            Ok((StatusCode::ACCEPTED, Json(capture)).into_response())
        }
        None => Err((StatusCode::CONFLICT, "분석 중인 캡처는 다시 분석할 수 없음".into())),
    }
}

/// What the settings dialog may see: never the token itself.
#[derive(serde::Serialize)]
struct ConfigView {
    has_token: bool,
}

async fn get_config(State(app): State<App>) -> ApiResult {
    let cfg = remote::Config::load(&app.dir).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(ConfigView { has_token: cfg.mcp_token.is_some() }).into_response())
}

#[derive(Deserialize)]
struct ConfigPut {
    mcp_token: Option<String>,
}

async fn put_config(State(app): State<App>, Json(p): Json<ConfigPut>) -> ApiResult {
    remote::Config::save(&app.dir, p.mcp_token).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    get_config(State(app)).await
}

/// Unsaved form values override the stored config, so the dialog can check before saving.
#[derive(Deserialize, Default)]
struct ConfigTest {
    mcp_token: Option<String>,
}

async fn test_config(State(app): State<App>, body: Option<Json<ConfigTest>>) -> ApiResult {
    let t = body.map(|Json(t)| t).unwrap_or_default();
    let mut cfg = remote::Config::load(&app.dir).unwrap_or_default();
    if let Some(token) = t.mcp_token.filter(|t| !t.trim().is_empty()) {
        cfg.mcp_token = Some(token.trim().to_string());
    }
    Ok(Json(remote::probe(&cfg).await).into_response())
}

#[derive(Deserialize)]
struct NewTodo {
    #[serde(flatten)]
    todo: remote::ExtractedTodo,
    #[serde(default)]
    priority: u8,
}

async fn add_todo(State(app): State<App>, Json(p): Json<NewTodo>) -> ApiResult {
    if p.priority > 3 {
        return Err((StatusCode::BAD_REQUEST, "중요도는 0~3".into()));
    }
    match app.store.add_todo(p.todo, p.priority).map_err(internal)? {
        Some(t) => Ok((StatusCode::CREATED, Json(t)).into_response()),
        None => Err((StatusCode::BAD_REQUEST, "업무내용은 비울 수 없습니다".into())),
    }
}

async fn patch_todo(State(app): State<App>, Path(id): Path<String>, Json(p): Json<store::TodoPatch>) -> ApiResult {
    if p.priority.is_some_and(|n| n > 3) {
        return Err((StatusCode::BAD_REQUEST, "중요도는 0~3".into()));
    }
    if p.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
        return Err((StatusCode::BAD_REQUEST, "업무내용은 비울 수 없습니다".into()));
    }
    match app.store.update_todo(&id, p).map_err(internal)? {
        true => Ok(StatusCode::NO_CONTENT.into_response()),
        false => Err((StatusCode::NOT_FOUND, "없는 할일".into())),
    }
}

async fn delete_todo(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    match app.store.delete_todo(&id).map_err(internal)? {
        true => Ok(StatusCode::NO_CONTENT.into_response()),
        false => Err((StatusCode::NOT_FOUND, "없는 할일".into())),
    }
}

async fn run(app: App, capture: Capture) {
    let outcome = async {
        app.store.set_status(&capture.id, CaptureStatus::Running).map_err(|e| e.to_string())?;
        let bytes = tokio::fs::read(app.dir.join("images").join(&capture.image))
            .await
            .map_err(|e| format!("이미지 읽기 실패: {e}"))?;
        let cfg = remote::Config::load(&app.dir)?;
        let today = chrono::Local::now().date_naive();
        let todos = remote::extract_todos(&cfg, &bytes, mime_for(&capture.image), today).await?;
        app.store.complete(&capture.id, todos).map_err(|e| e.to_string())
    }
    .await;
    if let Err(error) = outcome {
        eprintln!("capture {} failed: {error}", capture.id);
        if let Err(e) = app.store.set_status(&capture.id, CaptureStatus::Failed { error }) {
            eprintln!("capture {}: could not record failure: {e}", capture.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request, StatusCode};
    use tower::ServiceExt;

    async fn send(app: &axum::Router, req: Request<Body>) -> (StatusCode, String) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        (status, String::from_utf8(to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap())
    }

    fn put(body: &str) -> Request<Body> {
        Request::put("/api/config").header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn config_round_trips_and_never_returns_the_token() {
        let dir = std::env::temp_dir().join(format!("ct-cfg-{}", super::store::new_id()));
        let app = super::router(dir.clone()).unwrap();
        let get = || Request::get("/api/config").body(Body::empty()).unwrap();

        // An older config.json may still carry the server address; it is ignored.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"mcp_url":"https://old.example/mcp"}"#).unwrap();

        let (s, body) = send(&app, put(r#"{"mcp_token":"s3cret-tok"}"#)).await;
        assert_eq!(s, StatusCode::OK, "{body}");
        let (_, body) = send(&app, get()).await;
        assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap(), serde_json::json!({"has_token":true}));
        assert!(!body.contains("s3cret-tok"), "GET must not leak the token");

        send(&app, put(r#"{"mcp_token":"  "}"#)).await;
        assert_eq!(super::remote::Config::load(&dir).unwrap().mcp_token.as_deref(), Some("s3cret-tok"), "blank token keeps the stored one");
        assert!(!std::fs::read_to_string(dir.join("config.json")).unwrap().contains("mcp_url"), "save drops the old address");
    }

    #[tokio::test]
    async fn capture_image_serves_stored_bytes_and_404s_unknown() {
        let dir = std::env::temp_dir().join(format!("ct-api-{}", super::store::new_id()));
        let app = super::router(dir).unwrap();
        let png = b"\x89PNG\r\n\x1a\nfake".to_vec();
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/captures")
                    .header(header::CONTENT_TYPE, "image/png")
                    .body(Body::from(png.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let created: serde_json::Value = serde_json::from_slice(&to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
        let id = created["id"].as_str().unwrap();

        let res = app.clone().oneshot(Request::get(format!("/api/captures/{id}/image")).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(to_bytes(res.into_body(), usize::MAX).await.unwrap(), png, "served bytes match upload");

        for uri in ["/api/captures/nope/image", "/api/captures/..%2Fstore.json/image"] {
            let res = app.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }
}
