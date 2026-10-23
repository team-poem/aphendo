use crate::remote::ExtractedTodo;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureStatus {
    Queued,
    Running,
    Done { added: u32 },
    Failed { error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capture {
    pub id: String,
    pub image: String,
    pub status: CaptureStatus,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub capture_id: String,
    pub title: String,
    pub due: Option<NaiveDate>,
    pub detail: Option<String>,
    pub done: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Data {
    pub captures: Vec<Capture>,
    pub todos: Vec<Todo>,
}

fn normalize(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

// ponytail: one global lock and a full-file rewrite per mutation; fine for a personal todo list.
pub struct Store {
    data: Mutex<Data>,
    path: PathBuf,
}

impl Store {
    /// Captures left Queued/Running by a previous process can never finish, so they become Failed.
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("store.json");
        let mut data: Data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Data::default(),
            Err(e) => return Err(e),
        };
        for c in &mut data.captures {
            if matches!(c.status, CaptureStatus::Queued | CaptureStatus::Running) {
                c.status = CaptureStatus::Failed { error: "앱 재시작으로 중단".into() };
            }
        }
        let store = Self { data: Mutex::new(data), path };
        store.mutate(|_| ())?;
        Ok(store)
    }

    pub fn snapshot(&self) -> Data {
        self.data.lock().unwrap().clone()
    }

    fn mutate<T>(&self, f: impl FnOnce(&mut Data) -> T) -> std::io::Result<T> {
        let mut data = self.data.lock().unwrap();
        let out = f(&mut data);
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*data)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(out)
    }

    pub fn create_capture(&self, id: String, image: String) -> std::io::Result<Capture> {
        let capture = Capture { id, image, status: CaptureStatus::Queued, created_at: Utc::now() };
        self.mutate(|d| d.captures.push(capture.clone()))?;
        Ok(capture)
    }

    pub fn set_status(&self, capture_id: &str, status: CaptureStatus) -> std::io::Result<()> {
        self.mutate(|d| {
            if let Some(c) = d.captures.iter_mut().find(|c| c.id == capture_id) {
                c.status = status;
            }
        })
    }

    /// Failed → Queued. Returns None when the capture is missing or not Failed.
    pub fn retry(&self, capture_id: &str) -> std::io::Result<Option<Capture>> {
        self.mutate(|d| {
            let c = d.captures.iter_mut().find(|c| c.id == capture_id)?;
            if !matches!(c.status, CaptureStatus::Failed { .. }) {
                return None;
            }
            c.status = CaptureStatus::Queued;
            Some(c.clone())
        })
    }

    /// Appends the remote result and marks the capture Done. Idempotent on
    /// (capture_id, normalized title), so a retry never duplicates. Returns how many were new.
    pub fn complete(&self, capture_id: &str, items: Vec<ExtractedTodo>) -> std::io::Result<u32> {
        self.mutate(|d| {
            let mut added = 0;
            for item in items {
                let title = item.title.split_whitespace().collect::<Vec<_>>().join(" ");
                let key = normalize(&title);
                if title.is_empty()
                    || d.todos.iter().any(|t| t.capture_id == capture_id && normalize(&t.title) == key)
                {
                    continue;
                }
                d.todos.push(Todo {
                    id: new_id(),
                    capture_id: capture_id.into(),
                    title,
                    due: item.due,
                    detail: item.detail.filter(|s| !s.trim().is_empty()),
                    done: false,
                    created_at: Utc::now(),
                });
                added += 1;
            }
            if let Some(c) = d.captures.iter_mut().find(|c| c.id == capture_id) {
                c.status = CaptureStatus::Done { added };
            }
            added
        })
    }

    /// Returns false when no todo has this id.
    pub fn set_done(&self, id: &str, done: bool) -> std::io::Result<bool> {
        self.mutate(|d| match d.todos.iter_mut().find(|t| t.id == id) {
            Some(t) => {
                t.done = done;
                true
            }
            None => false,
        })
    }

    pub fn delete_todo(&self, id: &str) -> std::io::Result<bool> {
        self.mutate(|d| {
            let before = d.todos.len();
            d.todos.retain(|t| t.id != id);
            d.todos.len() != before
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ct-test-{}", new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn item(title: &str) -> ExtractedTodo {
        ExtractedTodo { title: title.into(), due: None, detail: None }
    }

    #[test]
    fn retry_appends_only_new_titles() {
        let s = Store::open(&tmp()).unwrap();
        let c = s.create_capture(new_id(), "a.png".into()).unwrap();
        assert_eq!(s.complete(&c.id, vec![item("보고서 제출"), item("회의 참석")]).unwrap(), 2);
        s.set_status(&c.id, CaptureStatus::Failed { error: "x".into() }).unwrap();
        assert!(s.retry(&c.id).unwrap().is_some());
        assert_eq!(s.complete(&c.id, vec![item("  보고서   제출 "), item("교육 이수"), item(" ")]).unwrap(), 1);
        let d = s.snapshot();
        assert_eq!(d.todos.len(), 3);
        assert_eq!(d.captures[0].status, CaptureStatus::Done { added: 1 });

        let other = s.create_capture(new_id(), "b.png".into()).unwrap();
        assert_eq!(s.complete(&other.id, vec![item("보고서 제출")]).unwrap(), 1, "same title, other capture");
    }

    #[test]
    fn retry_only_from_failed() {
        let s = Store::open(&tmp()).unwrap();
        let c = s.create_capture(new_id(), "a.png".into()).unwrap();
        assert!(s.retry(&c.id).unwrap().is_none(), "queued is not retryable");
        assert!(s.retry("nope").unwrap().is_none());
    }

    #[test]
    fn restart_fails_interrupted_captures_and_keeps_todos() {
        let dir = tmp();
        let (running, queued, tid) = {
            let s = Store::open(&dir).unwrap();
            let a = s.create_capture(new_id(), "a.png".into()).unwrap();
            s.set_status(&a.id, CaptureStatus::Running).unwrap();
            let b = s.create_capture(new_id(), "b.png".into()).unwrap();
            let done = s.create_capture(new_id(), "c.png".into()).unwrap();
            let due = NaiveDate::from_ymd_opt(2026, 11, 5);
            s.complete(&done.id, vec![ExtractedTodo { title: "회의".into(), due, detail: Some("3층".into()) }])
                .unwrap();
            let tid = s.snapshot().todos[0].id.clone();
            s.set_done(&tid, true).unwrap();
            (a.id, b.id, tid)
        };
        let s = Store::open(&dir).unwrap();
        let d = s.snapshot();
        for id in [&running, &queued] {
            let c = d.captures.iter().find(|c| &c.id == id).unwrap();
            assert_eq!(c.status, CaptureStatus::Failed { error: "앱 재시작으로 중단".into() });
        }
        let t = d.todos.iter().find(|t| t.id == tid).unwrap();
        assert!(t.done);
        assert_eq!(t.due, NaiveDate::from_ymd_opt(2026, 11, 5));
        assert_eq!(t.detail.as_deref(), Some("3층"));
        assert!(s.retry(&running).unwrap().is_some(), "interrupted capture is retryable");
    }
}
