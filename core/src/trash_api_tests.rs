//! HTTP regressions for trash. Fixtures use a separate data directory and never call remote AI.
use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use serde_json::{json, Value};
use std::path::PathBuf;
use tower::ServiceExt;

struct Fixture {
    dir: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("aphendo-trash-http-{}", crate::store::new_id()));
        std::fs::create_dir_all(dir.join("images")).unwrap();
        // This is the pre-trash on-disk schema, including a completed task and linked follow-up.
        let legacy = json!({
            "captures": [{"id":"capture-1","image":"capture-1.png","status":{"kind":"done","added":2},"created_at":"2026-10-01T00:00:00Z"}],
            "todos": [
                {"id":"todo-1","capture_id":"capture-1","title":"원래 업무 제목","due":"2026-10-10","detail":"상세 기록","done":true,"done_at":"2026-10-11T03:00:00Z","done_note":"이 메모가 제목이 되면 안 됨","priority":3,"created_at":"2026-10-01T00:00:00Z"},
                {"id":"todo-2","capture_id":"capture-1","title":"독립 후속 업무","due":"2026-10-20","detail":null,"done":false,"parent_id":"todo-1","created_at":"2026-10-11T03:00:00Z"}
            ],
            "calls": [{"id":"call-1","who":"김 담당자","memo":"전화로 확인한 기록","created_at":"2026-10-02T00:00:00Z"}]
        });
        std::fs::write(dir.join("store.json"), serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
        std::fs::write(dir.join("images/capture-1.png"), b"test-image-bytes").unwrap();
        Self { dir }
    }

    fn app(&self) -> axum::Router {
        crate::router(self.dir.clone()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn request(app: &axum::Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(value) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&value).unwrap())
        }
        None => Body::empty(),
    };
    let response = app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
    (status, bytes)
}

async fn get_json(app: &axum::Router, uri: &str) -> Value {
    let (status, body) = request(app, Method::GET, uri, None).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).unwrap()
}

async fn delete(app: &axum::Router, uri: &str) {
    let (status, body) = request(app, Method::DELETE, uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{}", String::from_utf8_lossy(&body));
}

async fn post(app: &axum::Router, uri: &str, body: Value, expected: StatusCode) -> Value {
    let (status, bytes) = request(app, Method::POST, uri, Some(body)).await;
    assert_eq!(status, expected, "{}", String::from_utf8_lossy(&bytes));
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

#[tokio::test]
async fn todo_restore_keeps_legacy_metadata_original_id_and_survives_restart() {
    let fixture = Fixture::new();
    let app = fixture.app();
    let before = get_json(&app, "/api/state").await;
    let original = before["todos"].as_array().unwrap().iter().find(|t| t["id"] == "todo-1").unwrap().clone();
    assert_eq!(get_json(&app, "/api/trash").await, json!([]));

    delete(&app, "/api/todos/todo-1").await;
    let state = get_json(&app, "/api/state").await;
    assert_eq!(state["todos"].as_array().unwrap().len(), 1);
    assert_eq!(state["todos"][0]["id"], "todo-2", "a follow-up is independent work, not an owned subtask");
    let trash = get_json(&app, "/api/trash").await;
    assert_eq!(trash[0]["title"], "원래 업무 제목", "the completion memo must never replace the task title");
    assert_eq!(trash[0]["kind"], "todo");
    assert_eq!(trash[0]["id"], "todo-1");
    assert_eq!(trash[0]["deleted_by"], "local");
    assert!(trash[0]["deleted_at"].as_str().is_some());

    drop(app);
    let reopened = fixture.app();
    assert_eq!(get_json(&reopened, "/api/trash").await, trash, "deletion metadata must persist without a running app");
    let restored = post(&reopened, "/api/trash/restore", json!({"ids":["todo-1"]}), StatusCode::OK).await;
    assert_eq!(restored["count"], 1);
    let repeated = post(&reopened, "/api/trash/restore", json!({"ids":["todo-1"]}), StatusCode::OK).await;
    assert_eq!(repeated["count"], 0);
    let state = get_json(&reopened, "/api/state").await;
    let restored: Vec<_> = state["todos"].as_array().unwrap().iter().filter(|t| t["id"] == "todo-1").collect();
    assert_eq!(restored.len(), 1);
    assert_eq!(*restored[0], original, "restoring must retain dates, done state, notes, priority, and evidence exactly");
    assert_eq!(get_json(&reopened, "/api/trash").await, json!([]));
    let history = state["history"].as_array().unwrap();
    assert_eq!(history.iter().filter(|h| h["entity_id"] == "todo-1").count(), 2, "one delete and one restore, not one event per repeat request");
}

#[tokio::test]
async fn bulk_restore_handles_memos_and_tasks_without_duplicating_ids() {
    let fixture = Fixture::new();
    let app = fixture.app();
    let before = get_json(&app, "/api/state").await;
    delete(&app, "/api/todos/todo-2").await;
    delete(&app, "/api/calls/call-1").await;
    let trash = get_json(&app, "/api/trash").await;
    assert_eq!(trash.as_array().unwrap().len(), 2);
    let call = trash.as_array().unwrap().iter().find(|t| t["id"] == "call-1").unwrap();
    assert_eq!(call["kind"], "call");

    let restored = post(&app, "/api/trash/restore", json!({"ids":["todo-2","call-1","todo-2"]}), StatusCode::OK).await;
    assert_eq!(restored["count"], 2);
    let after = get_json(&app, "/api/state").await;
    assert_eq!(after["calls"], before["calls"], "memo content and authored time must be retained");
    assert_eq!(after["todos"].as_array().unwrap().len(), 2);
    assert_eq!(get_json(&app, "/api/trash").await, json!([]));
}

#[tokio::test]
async fn archived_tasks_cannot_be_edited_finished_or_included_in_report_sources() {
    let fixture = Fixture::new();
    let app = fixture.app();
    delete(&app, "/api/todos/todo-1").await;
    delete(&app, "/api/todos/todo-2").await;
    let (status, _) = request(&app, Method::PATCH, "/api/todos/todo-1", Some(json!({"title":"몰래 변경"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    post(&app, "/api/todos/todo-2/finish", json!({"done_on":"2026-11-18","follow_ups":[{"title":"생기면 안 되는 후속 업무"}]}), StatusCode::NOT_FOUND).await;
    let sources = post(&app, "/api/reports/sources", json!({"start":"2026-10-01","end":"2026-10-31","planned_start":"2026-11-01","planned_end":"2026-11-30"}), StatusCode::OK).await;
    assert_eq!(sources, json!({"done":[],"planned":[]}));
    assert!(get_json(&app, "/api/state").await["todos"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn capture_trash_hides_gallery_but_retains_shared_evidence_and_rejects_unsafe_purge() {
    let fixture = Fixture::new();
    let app = fixture.app();
    delete(&app, "/api/captures/capture-1").await;
    let state = get_json(&app, "/api/state").await;
    assert!(state["captures"].as_array().unwrap().is_empty());
    assert_eq!(state["todos"].as_array().unwrap().len(), 2);
    assert_eq!(state["todos"][0]["capture_id"], "capture-1");
    assert_eq!(state["evidence_captures"][0]["id"], "capture-1");
    let (status, image) = request(&app, Method::GET, "/api/captures/capture-1/image", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(image, b"test-image-bytes");

    delete(&app, "/api/calls/call-1").await;
    post(&app, "/api/trash/purge", json!({"ids":["call-1","capture-1"],"confirm":true}), StatusCode::CONFLICT).await;
    assert_eq!(get_json(&app, "/api/trash").await.as_array().unwrap().len(), 2, "one blocked item must not partially purge the selection");
    assert!(fixture.dir.join("images/capture-1.png").exists());
    post(&app, "/api/trash/restore", json!({"ids":["capture-1"]}), StatusCode::OK).await;
    assert_eq!(get_json(&app, "/api/state").await["captures"][0]["id"], "capture-1");
}

#[tokio::test]
async fn permanent_deletion_requires_confirmation_and_removes_payloads_images_and_history() {
    let fixture = Fixture::new();
    let app = fixture.app();
    delete(&app, "/api/todos/todo-1").await;
    delete(&app, "/api/todos/todo-2").await;
    delete(&app, "/api/captures/capture-1").await;
    let ids = json!(["todo-1","todo-2","capture-1"]);
    post(&app, "/api/trash/purge", json!({"ids":ids}), StatusCode::BAD_REQUEST).await;
    post(&app, "/api/trash/purge", json!({"ids":ids,"confirm":false}), StatusCode::BAD_REQUEST).await;
    assert_eq!(get_json(&app, "/api/trash").await.as_array().unwrap().len(), 3);
    assert!(fixture.dir.join("images/capture-1.png").exists());

    let purged = post(&app, "/api/trash/purge", json!({"ids":ids,"confirm":true}), StatusCode::OK).await;
    assert_eq!(purged["count"], 3);
    assert_eq!(get_json(&app, "/api/trash").await, json!([]));
    assert!(!fixture.dir.join("images/capture-1.png").exists());
    let (status, _) = request(&app, Method::GET, "/api/captures/capture-1/image", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let persisted = std::fs::read_to_string(fixture.dir.join("store.json")).unwrap();
    for removed in ["원래 업무 제목", "독립 후속 업무", "상세 기록", "이 메모가 제목이 되면 안 됨"] {
        assert!(!persisted.contains(removed), "purged content must not remain hidden in audit data: {removed}");
    }
    assert!(persisted.contains("전화로 확인한 기록"), "unrelated data must survive a purge");

    drop(app);
    let reopened = fixture.app();
    let restore = post(&reopened, "/api/trash/restore", json!({"ids":ids}), StatusCode::OK).await;
    assert_eq!(restore["count"], 0);
    assert!(get_json(&reopened, "/api/state").await["todos"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn follow_up_can_restore_after_original_parent_was_permanently_deleted() {
    let fixture = Fixture::new();
    let app = fixture.app();
    delete(&app, "/api/todos/todo-1").await;
    delete(&app, "/api/todos/todo-2").await;
    post(&app, "/api/trash/purge", json!({"ids":["todo-1"],"confirm":true}), StatusCode::OK).await;
    post(&app, "/api/trash/restore", json!({"ids":["todo-2"]}), StatusCode::OK).await;
    let state = get_json(&app, "/api/state").await;
    assert_eq!(state["todos"].as_array().unwrap().len(), 1);
    assert_eq!(state["todos"][0]["id"], "todo-2");
    assert_eq!(state["todos"][0]["title"], "독립 후속 업무");
    assert_eq!(state["todos"][0]["due"], "2026-10-20");
    assert!(state["todos"][0]["parent_id"].is_null(), "never recreate a deleted parent or invent a replacement relationship");
    assert_eq!(state["todos"][0]["capture_id"], "capture-1");
    assert!(fixture.dir.join("images/capture-1.png").exists(), "unselected evidence remains available");
}

#[tokio::test]
async fn duplicate_candidate_survives_its_comparison_target_being_trashed_and_restored() {
    let fixture = Fixture::new();
    let app = fixture.app();
    let created = post(&app, "/api/todos", json!({"title":"원래 업무 제목","due":"2026-10-10"}), StatusCode::ACCEPTED).await;
    let pending = created["pending"].clone();
    let pending_id = pending["id"].as_str().unwrap();
    delete(&app, "/api/todos/todo-1").await;
    post(&app, &format!("/api/pending/{pending_id}/resolve"), json!({"action":"attach","todo_id":"todo-1"}), StatusCode::NOT_FOUND).await;
    let state = get_json(&app, "/api/state").await;
    assert_eq!(state["pending"][0], pending, "a missing comparison target must not discard the incoming candidate or its evidence");
    post(&app, "/api/trash/restore", json!({"ids":["todo-1"]}), StatusCode::OK).await;
    let state = get_json(&app, "/api/state").await;
    assert_eq!(state["pending"][0]["matches"][0]["todo_id"], "todo-1");
    assert!(state["todos"].as_array().unwrap().iter().any(|t| t["id"] == "todo-1"));
}
