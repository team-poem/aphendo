use crate::remote::ExtractedTodo;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
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
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub contact: Option<String>,
    pub detail: Option<String>,
    pub done: bool,
    /// When the user last checked it off; None while open.
    #[serde(default)]
    pub done_at: Option<DateTime<Utc>>,
    /// 0 = unset, 1..=3 stars.
    #[serde(default)]
    pub priority: u8,
    pub created_at: DateTime<Utc>,
}

impl Todo {
    /// `capture_id` is empty for a todo the user typed in.
    fn new(capture_id: &str, title: String, item: ExtractedTodo) -> Self {
        Todo {
            id: new_id(),
            capture_id: capture_id.into(),
            title,
            due: item.due,
            sender: clean(item.sender),
            method: clean(item.method),
            contact: clean(item.contact),
            detail: clean(item.detail),
            done: false,
            done_at: None,
            priority: 0,
            created_at: Utc::now(),
        }
    }
}

/// Fields the user edits on a todo. Absent fields stay as they are; for the
/// nullable ones `null` (or a blank string) clears.
#[derive(Debug, Default, Deserialize)]
pub struct TodoPatch {
    pub done: Option<bool>,
    pub priority: Option<u8>,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub due: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "present")]
    pub sender: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub method: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub contact: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub detail: Option<Option<String>>,
}

/// Tells a present `null` apart from an absent key.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
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
                d.todos.push(Todo::new(capture_id, title, item));
                added += 1;
            }
            if let Some(c) = d.captures.iter_mut().find(|c| c.id == capture_id) {
                c.status = CaptureStatus::Done { added };
            }
            added
        })
    }

    /// A todo with no capture behind it. None when the title is blank.
    pub fn add_todo(&self, item: ExtractedTodo, priority: u8) -> std::io::Result<Option<Todo>> {
        let Some(title) = clean(Some(item.title.clone())) else { return Ok(None) };
        let todo = Todo { priority, ..Todo::new("", title, item) };
        self.mutate(|d| d.todos.push(todo.clone()))?;
        Ok(Some(todo))
    }

    /// Returns false when no todo has this id.
    pub fn update_todo(&self, id: &str, p: TodoPatch) -> std::io::Result<bool> {
        self.mutate(|d| match d.todos.iter_mut().find(|t| t.id == id) {
            Some(t) => {
                if let Some(done) = p.done.filter(|&d| d != t.done) {
                    t.done = done;
                    t.done_at = done.then(Utc::now);
                }
                t.priority = p.priority.unwrap_or(t.priority);
                if let Some(title) = clean(p.title) {
                    t.title = title;
                }
                if let Some(due) = p.due {
                    t.due = due;
                }
                for (field, v) in [(&mut t.sender, p.sender), (&mut t.method, p.method), (&mut t.contact, p.contact), (&mut t.detail, p.detail)] {
                    if let Some(v) = v {
                        *field = clean(v);
                    }
                }
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
        ExtractedTodo { title: title.into(), ..Default::default() }
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
    fn manual_todo_needs_a_title_and_survives_completion() {
        let s = Store::open(&tmp()).unwrap();
        assert!(s.add_todo(item("  "), 0).unwrap().is_none());
        let t = s.add_todo(ExtractedTodo { title: " 주간 보고 ".into(), sender: Some("팀장".into()), ..Default::default() }, 2).unwrap().unwrap();
        assert_eq!((t.title.as_str(), t.capture_id.as_str(), t.priority), ("주간 보고", "", 2));
        s.update_todo(&t.id, TodoPatch { done: Some(true), ..Default::default() }).unwrap();
        assert!(s.snapshot().todos.iter().any(|x| x.id == t.id && x.done), "completing keeps the record");
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
            let item = ExtractedTodo { title: "회의".into(), due, sender: Some(" 총무팀 ".into()), method: Some("".into()), detail: Some("3층".into()), ..Default::default() };
            s.complete(&done.id, vec![item]).unwrap();
            let tid = s.snapshot().todos[0].id.clone();
            s.update_todo(&tid, TodoPatch { done: Some(true), ..Default::default() }).unwrap();
            let edit: TodoPatch = serde_json::from_str(r#"{"priority":2,"title":"회의 참석","due":null,"contact":"내선 1","detail":" "}"#).unwrap();
            s.update_todo(&tid, edit).unwrap();
            (a.id, b.id, tid)
        };
        let s = Store::open(&dir).unwrap();
        let d = s.snapshot();
        for id in [&running, &queued] {
            let c = d.captures.iter().find(|c| &c.id == id).unwrap();
            assert_eq!(c.status, CaptureStatus::Failed { error: "앱 재시작으로 중단".into() });
        }
        let t = d.todos.iter().find(|t| t.id == tid).unwrap();
        assert!(t.done, "priority-only patch keeps done");
        let at = t.done_at.expect("checking off stamps done_at");
        s.update_todo(&tid, TodoPatch { done: Some(true), ..Default::default() }).unwrap();
        assert_eq!(s.snapshot().todos.iter().find(|t| t.id == tid).unwrap().done_at, Some(at), "re-sending done keeps the first stamp");
        s.update_todo(&tid, TodoPatch { done: Some(false), ..Default::default() }).unwrap();
        assert_eq!(s.snapshot().todos.iter().find(|t| t.id == tid).unwrap().done_at, None, "reopening clears it");
        assert_eq!(t.priority, 2);
        assert_eq!(t.sender.as_deref(), Some("총무팀"));
        assert_eq!(t.method, None, "blank method dropped");
        assert_eq!(t.title, "회의 참석");
        assert_eq!(t.due, None, "null clears due");
        assert_eq!(t.sender.as_deref(), Some("총무팀"), "absent key keeps sender");
        assert_eq!(t.contact.as_deref(), Some("내선 1"));
        assert_eq!(t.detail, None, "blank clears detail");
        assert!(s.retry(&running).unwrap().is_some(), "interrupted capture is retryable");
    }
}
