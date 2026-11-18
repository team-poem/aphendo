use crate::remote::{ExtractedTodo, ReportItem};
use chrono::{DateTime, Days, Local, Months, NaiveDate, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureStatus {
    Queued,
    Running,
    /// `held`: results parked for duplicate review instead of added.
    Done {
        added: u32,
        #[serde(default)]
        held: u32,
    },
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
    /// How it went and what it led to, written when checking it off.
    #[serde(default)]
    pub done_note: Option<String>,
    /// 0 = unset, 1..=3 stars.
    #[serde(default)]
    pub priority: u8,
    /// Checking off a repeating todo adds its next occurrence.
    #[serde(default)]
    pub repeat: Option<Repeat>,
    pub created_at: DateTime<Utc>,
    /// Captures linked later as more evidence for the same work; `capture_id` stays the first one.
    #[serde(default)]
    pub extra_captures: Vec<String>,
    /// The todo whose completion added this one as a follow-up. Follow-ups made before this field have none.
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Repeat {
    Weekly,
    Monthly,
}

impl Repeat {
    /// Monthly clamps to the month's last day (1/31 → 2/28).
    fn next(self, d: NaiveDate) -> NaiveDate {
        match self {
            Repeat::Weekly => d + Days::new(7),
            Repeat::Monthly => d.checked_add_months(Months::new(1)).unwrap_or(d),
        }
    }
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
            done_note: None,
            priority: 0,
            repeat: None,
            created_at: Utc::now(),
            extra_captures: Vec::new(),
            parent_id: None,
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
    pub repeat: Option<Option<Repeat>>,
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

/// Checking a todo off in the completion dialog.
#[derive(Debug, Deserialize)]
pub struct Finish {
    pub done_on: NaiveDate,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub follow_ups: Vec<NewTodo>,
}

/// A todo the user filled in by hand.
#[derive(Debug, Deserialize)]
pub struct NewTodo {
    #[serde(flatten)]
    pub todo: ExtractedTodo,
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub repeat: Option<Repeat>,
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
    #[serde(default)]
    pub calls: Vec<CallNote>,
    #[serde(default)]
    pub pending: Vec<Pending>,
    #[serde(default)]
    pub reports: Vec<Report>,
    #[serde(default)]
    trash: Vec<TrashRecord>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    /// Included in the API only for evidence viewers, never in the capture gallery.
    #[serde(default, skip_deserializing)]
    pub evidence_captures: Vec<Capture>,
    /// Only files explicitly selected for permanent deletion; retried after an interrupted cleanup.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pending_file_deletions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashKind { Todo, Capture, Call }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum TrashContent { Todo(Todo), Capture(Capture), Call(CallNote) }

impl TrashContent {
    fn id(&self) -> &str {
        match self { Self::Todo(t) => &t.id, Self::Capture(c) => &c.id, Self::Call(c) => &c.id }
    }
    fn kind(&self) -> TrashKind {
        match self { Self::Todo(_) => TrashKind::Todo, Self::Capture(_) => TrashKind::Capture, Self::Call(_) => TrashKind::Call }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashRecord {
    deleted_at: DateTime<Utc>,
    deleted_by: String,
    content: TrashContent,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrashItem {
    pub id: String,
    pub kind: TrashKind,
    pub title: String,
    pub deleted_at: DateTime<Utc>,
    pub deleted_by: String,
    pub original_location: String,
    pub related_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub entity_id: String,
    pub kind: TrashKind,
    pub action: String,
    pub at: DateTime<Utc>,
    pub actor: String,
}

fn references(t: &Todo, capture_id: &str) -> bool {
    t.capture_id == capture_id || t.extra_captures.iter().any(|id| id == capture_id)
}

fn archived_todos(d: &Data) -> impl Iterator<Item = &Todo> {
    d.trash.iter().filter_map(|r| match &r.content { TrashContent::Todo(t) => Some(t), _ => None })
}

fn audit(d: &mut Data, content: &TrashContent, action: &str, at: DateTime<Utc>) {
    d.history.push(HistoryEntry { entity_id: content.id().into(), kind: content.kind(), action: action.into(), at, actor: "local".into() });
}

fn archive(d: &mut Data, content: TrashContent) {
    let at = Utc::now();
    audit(d, &content, "deleted", at);
    d.trash.push(TrashRecord { deleted_at: at, deleted_by: "local".into(), content });
}

/// A weekly work log: the sentences of its 실시항목 and 예정항목 boxes as the user left them.
/// `start..=end` is the 실시 period and identifies the report; 예정 has its own period.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Report {
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub planned_start: NaiveDate,
    pub planned_end: NaiveDate,
    pub done: Vec<String>,
    pub planned: Vec<String>,
}

/// A new todo held back because it looks like one already listed. Nothing is merged or dropped
/// until the user picks what to do with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pending {
    pub id: String,
    pub todo: Todo,
    pub matches: Vec<Match>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Match {
    pub todo_id: String,
    pub reasons: Vec<String>,
}

/// What the user decided for a held todo.
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Resolve {
    /// The listed one stands; the new one is dropped.
    Keep,
    /// The listed one gains the new one's capture as evidence and is otherwise untouched.
    Attach { todo_id: String },
    /// They are different work; the new one is added.
    Add,
}

pub enum Added {
    Todo(Todo),
    Held(Pending),
}

/// A phone-call memo: who called and what was said. Kept apart from todos.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallNote {
    pub id: String,
    pub who: String,
    pub memo: String,
    pub created_at: DateTime<Utc>,
}

/// Marks `d.todos[i]` done; a repeating todo adds its next occurrence. No-op when already done.
fn check_off(d: &mut Data, i: usize, at: DateTime<Utc>) {
    let t = &mut d.todos[i];
    if t.done {
        return;
    }
    t.done = true;
    t.done_at = Some(at);
    let Some(repeat) = t.repeat else { return };
    let due = repeat.next(t.due.unwrap_or_else(|| Local::now().date_naive()));
    let next = Todo { id: new_id(), due: Some(due), done: false, done_at: None, done_note: None, created_at: Utc::now(), parent_id: None, ..t.clone() };
    // Unchecking and checking again must not stack a second copy.
    if !d.todos.iter().any(|o| !o.done && o.title == next.title && o.due == next.due) {
        d.todos.push(next);
    }
}

fn normalize(title: &str) -> String {
    title.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Dice coefficient over character pairs, spaces ignored: 1.0 for the same text, 0.0 for nothing shared.
fn similar(a: &str, b: &str) -> f32 {
    let pairs = |s: &str| {
        let c: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
        c.windows(2).map(|w| (w[0], w[1])).collect::<Vec<_>>()
    };
    let (a, mut b) = (pairs(a), pairs(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let total = (a.len() + b.len()) as f32;
    let mut shared = 0;
    for p in &a {
        if let Some(i) = b.iter().position(|q| q == p) {
            b.swap_remove(i);
            shared += 1;
        }
    }
    2.0 * shared as f32 / total
}

/// Why `new` might be `old` again, or None when it plainly is not. A like title on another due date is a
/// separate occurrence unless the body matches too, and never for a repeating todo's other round.
fn suspect(new: &Todo, old: &Todo) -> Option<Vec<String>> {
    let pct = |x: f32| (x * 100.0).round() as u32;
    let body = |t: &Todo| [&t.method, &t.detail].into_iter().flatten().cloned().collect::<Vec<_>>().join(" ");
    let same_title = normalize(&new.title) == normalize(&old.title);
    let title = if same_title { 1.0 } else { similar(&new.title, &old.title) };
    let content = similar(&body(new), &body(old));
    let same_due = new.due == old.due;
    let other_round = !same_due && old.repeat.is_some();
    if other_round || title < 0.6 || !(same_due || content >= 0.6) {
        return None;
    }
    let mut why = vec![if same_title { "제목 같음".to_string() } else { format!("제목 비슷함 {}%", pct(title)) }];
    if same_due {
        why.push(new.due.map_or("둘 다 마감 없음".into(), |d| format!("마감일 같음 {}", d.format("%-m/%-d"))));
    }
    if content >= 0.6 {
        why.push(format!("내용 비슷함 {}%", pct(content)));
    }
    if new.sender.is_some() && new.sender == old.sender {
        why.push("발신자 같음".into());
    }
    Some(why)
}

fn matches_for(new: &Todo, todos: &[Todo]) -> Vec<Match> {
    todos.iter().filter_map(|old| suspect(new, old).map(|reasons| Match { todo_id: old.id.clone(), reasons })).collect()
}

/// Adds `t`, or parks it for review when it looks like a listed todo.
fn add_or_hold(d: &mut Data, t: Todo) -> Added {
    let matches = matches_for(&t, &d.todos);
    if matches.is_empty() {
        d.todos.push(t.clone());
        return Added::Todo(t);
    }
    let p = Pending { id: new_id(), todo: t, matches };
    d.pending.push(p.clone());
    Added::Held(p)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn safe_image_name(image: &str) -> bool {
    !image.is_empty() && !image.contains(['/', '\\', ':']) && image != "." && image != ".."
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
        // A failed physical cleanup must not make the user's whole database unavailable.
        // The persisted queue remains for the next explicit purge or restart.
        let _ = store.cleanup_purged_files();
        Ok(store)
    }

    pub fn snapshot(&self) -> Data {
        let mut data = self.data.lock().unwrap().clone();
        data.evidence_captures = data.trash.iter().filter_map(|r| match &r.content {
            TrashContent::Capture(c) if data.todos.iter().chain(data.pending.iter().map(|p| &p.todo)).any(|t| references(t, &c.id)) => Some(c.clone()),
            _ => None,
        }).collect();
        // Deleted bodies are available only through restore, not the ordinary state API.
        data.trash.clear();
        data.pending_file_deletions.clear();
        data
    }

    fn mutate<T>(&self, f: impl FnOnce(&mut Data) -> T) -> std::io::Result<T> {
        let mut data = self.data.lock().unwrap();
        let mut next = data.clone();
        let out = f(&mut next);
        self.persist(&next)?;
        *data = next;
        Ok(out)
    }

    fn persist(&self, data: &Data) -> std::io::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// A hidden capture can still serve as evidence for a surviving task.
    pub fn capture_image(&self, id: &str) -> Option<String> {
        let d = self.data.lock().unwrap();
        d.captures.iter().find(|c| c.id == id).map(|c| c.image.clone()).or_else(|| {
            if !d.todos.iter().chain(d.pending.iter().map(|p| &p.todo)).any(|t| references(t, id)) { return None; }
            d.trash.iter().find_map(|r| match &r.content {
                TrashContent::Capture(c) if c.id == id => Some(c.image.clone()), _ => None,
            })
        })
    }

    pub fn trash_items(&self) -> Vec<TrashItem> {
        let d = self.data.lock().unwrap();
        let mut items: Vec<_> = d.trash.iter().map(|r| {
            let (title, location, related_count) = match &r.content {
                TrashContent::Todo(t) => (t.title.clone(), if t.parent_id.is_some() { "후속 업무" } else { "할 일" },
                    usize::from(!t.capture_id.is_empty()) + t.extra_captures.len()),
                TrashContent::Capture(c) => (format!("캡처 {}", c.created_at.with_timezone(&Local).format("%Y-%m-%d %H:%M")), "캡처 목록",
                    d.todos.iter().chain(archived_todos(&d)).chain(d.pending.iter().map(|p| &p.todo)).filter(|t| references(t, &c.id)).count()),
                TrashContent::Call(c) => (if c.who.is_empty() { "통화 메모".into() } else { format!("{} · 통화 메모", c.who) }, "통화 메모", 0),
            };
            TrashItem { id: r.content.id().into(), kind: r.content.kind(), title, deleted_at: r.deleted_at,
                deleted_by: r.deleted_by.clone(), original_location: location.into(), related_count }
        }).collect();
        items.sort_by_key(|r| std::cmp::Reverse(r.deleted_at));
        items
    }

    /// Moves the stored original back; repeated IDs or retries never create copies.
    pub fn restore_trash(&self, ids: &[String]) -> std::io::Result<usize> {
        let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
        self.mutate(|d| {
            let mut count = 0;
            let mut keep = Vec::new();
            for r in std::mem::take(&mut d.trash) {
                if !selected.contains(r.content.id()) { keep.push(r); continue; }
                let exists = match &r.content {
                    TrashContent::Todo(t) => d.todos.iter().any(|o| o.id == t.id),
                    TrashContent::Capture(c) => d.captures.iter().any(|o| o.id == c.id),
                    TrashContent::Call(c) => d.calls.iter().any(|o| o.id == c.id),
                };
                if exists { keep.push(r); continue; }
                audit(d, &r.content, "restored", Utc::now());
                match r.content {
                    TrashContent::Todo(t) => d.todos.push(t),
                    TrashContent::Capture(c) => d.captures.push(c),
                    TrashContent::Call(c) => d.calls.push(c),
                }
                count += 1;
            }
            d.trash = keep;
            count
        })
    }

    /// Rejects the whole batch if an image is still evidence for another retained record.
    pub fn purge_trash(&self, ids: &[String]) -> std::io::Result<usize> {
        let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
        let count = {
            let mut data = self.data.lock().unwrap();
            for r in data.trash.iter().filter(|r| selected.contains(r.content.id())) {
                if let TrashContent::Capture(c) = &r.content {
                    let active = data.todos.iter().chain(data.pending.iter().map(|p| &p.todo));
                    let retained_trash = archived_todos(&data).filter(|t| !selected.contains(t.id.as_str()));
                    if active.chain(retained_trash).any(|t| references(t, &c.id)) {
                        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,
                            "다른 업무나 중복 확인 항목에서 사용하는 근거 자료는 영구 삭제할 수 없습니다. 연결된 업무를 유지하려면 해당 캡처를 선택에서 제외해주세요."));
                    }
                    if !safe_image_name(&c.image) {
                        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "잘못된 이미지 파일 경로입니다."));
                    }
                }
            }
            let mut next = data.clone();
            let mut removed = HashSet::new();
            next.trash.retain(|r| {
                if !selected.contains(r.content.id()) { return true; }
                removed.insert(r.content.id().to_string());
                if let TrashContent::Capture(c) = &r.content {
                    // Two records can refer to one file after an import; keep it for surviving captures.
                    let used_elsewhere = data.captures.iter().any(|other| other.image == c.image)
                        || data.trash.iter().any(|other| !selected.contains(other.content.id()) && matches!(&other.content, TrashContent::Capture(other) if other.image == c.image));
                    if !used_elsewhere && !next.pending_file_deletions.contains(&c.image) { next.pending_file_deletions.push(c.image.clone()); }
                }
                false
            });
            next.history.retain(|h| !removed.contains(&h.entity_id));
            for t in next.todos.iter_mut().chain(next.pending.iter_mut().map(|p| &mut p.todo)) {
                if t.parent_id.as_ref().is_some_and(|id| removed.contains(id)) { t.parent_id = None; }
            }
            for r in &mut next.trash {
                if let TrashContent::Todo(t) = &mut r.content {
                    if t.parent_id.as_ref().is_some_and(|id| removed.contains(id)) { t.parent_id = None; }
                }
            }
            for p in &mut next.pending { p.matches.retain(|m| !removed.contains(&m.todo_id)); }
            self.persist(&next)?;
            *data = next;
            removed.len()
        };
        self.cleanup_purged_files().map_err(|e| std::io::Error::new(e.kind(),
            format!("항목은 영구 삭제됐지만 이미지 파일 정리가 완료되지 않았습니다. 다음 영구 삭제 작업이나 앱 재시작 시 다시 정리합니다. ({e})")))?;
        Ok(count)
    }

    fn cleanup_purged_files(&self) -> std::io::Result<()> {
        let mut data = self.data.lock().unwrap();
        let images = self.path.parent().unwrap().join("images");
        for image in &data.pending_file_deletions {
            if !safe_image_name(image) { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "잘못된 이미지 파일 경로입니다.")); }
            match std::fs::remove_file(images.join(image)) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        if !data.pending_file_deletions.is_empty() {
            let mut next = data.clone();
            next.pending_file_deletions.clear();
            self.persist(&next)?;
            *data = next;
        }
        Ok(())
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

    /// Failed or Done → Queued, so a capture can be analyzed again (e.g. it found nothing, or its
    /// todos were deleted). Returns None when the capture is missing or still in progress.
    pub fn retry(&self, capture_id: &str) -> std::io::Result<Option<Capture>> {
        self.mutate(|d| {
            let c = d.captures.iter_mut().find(|c| c.id == capture_id)?;
            if matches!(c.status, CaptureStatus::Queued | CaptureStatus::Running) {
                return None;
            }
            c.status = CaptureStatus::Queued;
            Some(c.clone())
        })
    }

    /// Hides a finished capture without removing its bytes or evidence references.
    pub fn delete_capture(&self, capture_id: &str) -> std::io::Result<bool> {
        self.mutate(|d| {
            let Some(i) = d.captures.iter().position(|c| c.id == capture_id) else { return false };
            if matches!(d.captures[i].status, CaptureStatus::Queued | CaptureStatus::Running) { return false; }
            let capture = d.captures.remove(i);
            archive(d, TrashContent::Capture(capture));
            true
        })
    }

    /// Appends the remote result and marks the capture Done. A title this capture already produced is
    /// skipped (re-analysis reads the same evidence again). One that looks like another listed todo,
    /// including one earlier in this same result, is held for review. Returns how many were added.
    pub fn complete(&self, capture_id: &str, items: Vec<ExtractedTodo>) -> std::io::Result<u32> {
        self.mutate(|d| {
            if !d.captures.iter().any(|c| c.id == capture_id) { return 0; }
            let (mut added, mut held) = (0, 0);
            for item in items {
                let title = item.title.split_whitespace().collect::<Vec<_>>().join(" ");
                let key = normalize(&title);
                let mine = d.todos.iter().chain(d.pending.iter().map(|p| &p.todo)).chain(archived_todos(d));
                if title.is_empty() || mine.into_iter().any(|t| t.capture_id == capture_id && normalize(&t.title) == key) {
                    continue;
                }
                match add_or_hold(d, Todo::new(capture_id, title, item)) {
                    Added::Todo(_) => added += 1,
                    Added::Held(_) => held += 1,
                }
            }
            if let Some(c) = d.captures.iter_mut().find(|c| c.id == capture_id) {
                c.status = CaptureStatus::Done { added, held };
            }
            added
        })
    }

    /// A todo with no capture behind it, held for review when it looks like a listed one. None when the title is blank.
    pub fn add_todo(&self, item: ExtractedTodo, priority: u8, repeat: Option<Repeat>) -> std::io::Result<Option<Added>> {
        let Some(title) = clean(Some(item.title.clone())) else { return Ok(None) };
        let todo = Todo { priority, repeat, ..Todo::new("", title, item) };
        self.mutate(|d| Some(add_or_hold(d, todo)))
    }

    /// Applies the user's call on a held todo. False when it or the todo to attach to is gone.
    pub fn resolve(&self, id: &str, r: Resolve) -> std::io::Result<bool> {
        self.mutate(|d| {
            let Some(i) = d.pending.iter().position(|p| p.id == id) else { return false };
            match r {
                Resolve::Keep => {}
                Resolve::Add => d.todos.push(d.pending[i].todo.clone()),
                Resolve::Attach { todo_id } => {
                    let cap = d.pending[i].todo.capture_id.clone();
                    let Some(t) = d.todos.iter_mut().find(|t| t.id == todo_id) else { return false };
                    if t.capture_id.is_empty() {
                        t.capture_id = cap;
                    } else if !cap.is_empty() && t.capture_id != cap && !t.extra_captures.contains(&cap) {
                        t.extra_captures.push(cap);
                    }
                }
            }
            d.pending.remove(i);
            true
        })
    }

    /// Returns false when no todo has this id.
    pub fn update_todo(&self, id: &str, p: TodoPatch) -> std::io::Result<bool> {
        self.mutate(|d| {
            let Some(i) = d.todos.iter().position(|t| t.id == id) else { return false };
            let t = &mut d.todos[i];
            if p.done == Some(false) {
                t.done = false;
                t.done_at = None;
            }
            t.priority = p.priority.unwrap_or(t.priority);
            if let Some(repeat) = p.repeat {
                t.repeat = repeat;
            }
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
            if p.done == Some(true) {
                check_off(d, i, Utc::now());
            }
            true
        })
    }

    /// Checks a todo off on the day the user names and keeps the note. Each follow-up with a title becomes
    /// an open todo linked to the original's capture. Returns false when no todo has this id.
    pub fn finish_todo(&self, id: &str, f: Finish) -> std::io::Result<bool> {
        // A past day is stamped at local noon so no time zone shift moves it to a neighboring day.
        let at = match f.done_on == Local::now().date_naive() {
            true => Utc::now(),
            false => f.done_on.and_hms_opt(12, 0, 0).unwrap().and_local_timezone(Local).earliest().map_or_else(Utc::now, |t| t.with_timezone(&Utc)),
        };
        self.mutate(|d| {
            let Some(i) = d.todos.iter().position(|t| t.id == id) else { return false };
            d.todos[i].done_note = clean(Some(f.note));
            check_off(d, i, at);
            let capture_id = d.todos[i].capture_id.clone();
            for n in f.follow_ups {
                let Some(title) = clean(Some(n.todo.title.clone())) else { continue };
                d.todos.push(Todo { priority: n.priority, repeat: n.repeat, parent_id: Some(id.to_string()), ..Todo::new(&capture_id, title, n.todo) });
            }
            true
        })
    }

    pub fn delete_todo(&self, id: &str) -> std::io::Result<bool> {
        self.mutate(|d| {
            let Some(i) = d.todos.iter().position(|t| t.id == id) else { return false };
            let todo = d.todos.remove(i);
            archive(d, TrashContent::Todo(todo));
            true
        })
    }

    /// What a report is written from: todos checked off in the 실시 period `start..=end` (with their
    /// completion note), and open todos due by the end of the 예정 period, overdue ones included.
    pub fn report_items(&self, start: NaiveDate, end: NaiveDate, planned_end: NaiveDate) -> (Vec<ReportItem>, Vec<ReportItem>) {
        let d = self.data.lock().unwrap();
        let item = |t: &Todo, note: Option<&String>| ReportItem { title: t.title.clone(), note: note.cloned(), due: t.due };
        let mut done: Vec<&Todo> = d.todos.iter().filter(|t| t.done_at.is_some_and(|at| (start..=end).contains(&at.with_timezone(&Local).date_naive()))).collect();
        done.sort_by_key(|t| t.done_at);
        let mut planned: Vec<&Todo> = d.todos.iter().filter(|t| !t.done && t.due.is_some_and(|due| due <= planned_end)).collect();
        planned.sort_by_key(|t| (t.due, std::cmp::Reverse(t.priority)));
        (
            done.into_iter().map(|t| item(t, t.done_note.as_ref().or(t.detail.as_ref()))).collect(),
            planned.into_iter().map(|t| item(t, t.detail.as_ref())).collect(),
        )
    }

    /// Keeps one report per period; saving the same period again replaces it.
    pub fn save_report(&self, r: Report) -> std::io::Result<()> {
        self.mutate(|d| {
            d.reports.retain(|o| (o.start, o.end) != (r.start, r.end));
            d.reports.push(r);
        })
    }

    /// None when both fields are blank.
    pub fn add_call(&self, who: &str, memo: &str) -> std::io::Result<Option<CallNote>> {
        let (who, memo) = (who.trim().to_string(), memo.trim().to_string());
        if who.is_empty() && memo.is_empty() {
            return Ok(None);
        }
        let note = CallNote { id: new_id(), who, memo, created_at: Utc::now() };
        self.mutate(|d| d.calls.push(note.clone()))?;
        Ok(Some(note))
    }

    pub fn delete_call(&self, id: &str) -> std::io::Result<bool> {
        self.mutate(|d| {
            let Some(i) = d.calls.iter().position(|c| c.id == id) else { return false };
            let note = d.calls.remove(i);
            archive(d, TrashContent::Call(note));
            true
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

    fn added(a: Option<Added>) -> Todo {
        match a {
            Some(Added::Todo(t)) => t,
            _ => panic!("expected the todo to be added"),
        }
    }

    #[test]
    fn trash_round_trip_keeps_original_payload_and_audit_after_restart() {
        let dir = tmp();
        let s = Store::open(&dir).unwrap();
        let t = added(s.add_todo(ExtractedTodo { title: "원래 업무 제목".into(), due: due(10, 1), detail: Some("업무 메모".into()), ..Default::default() }, 3, Some(Repeat::Weekly)).unwrap());
        s.finish_todo(&t.id, Finish { done_on: due(10, 2).unwrap(), note: "완료 후 작성한 기록".into(), follow_ups: vec![] }).unwrap();
        let original = s.snapshot().todos.into_iter().find(|o| o.id == t.id).unwrap();
        assert!(s.delete_todo(&t.id).unwrap());
        assert!(!s.delete_todo(&t.id).unwrap());
        assert!(!s.update_todo(&t.id, TodoPatch { title: Some("바뀌면 안 됨".into()), ..Default::default() }).unwrap());
        assert!(!s.snapshot().todos.iter().any(|o| o.id == t.id));
        let s = Store::open(&dir).unwrap();
        let trash = s.trash_items();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].title, "원래 업무 제목");
        assert_eq!(trash[0].deleted_by, "local");
        assert_eq!(s.restore_trash(&[t.id.clone(), t.id.clone()]).unwrap(), 1);
        assert_eq!(s.restore_trash(&[t.id.clone()]).unwrap(), 0);
        let d = s.snapshot();
        let restored = d.todos.iter().find(|o| o.id == t.id).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), serde_json::to_value(original).unwrap());
        let history: Vec<_> = d.history.iter().filter(|h| h.entity_id == t.id).collect();
        assert_eq!(history.len(), 2);
        assert_eq!((history[0].action.as_str(), history[1].action.as_str()), ("deleted", "restored"));
        assert!(s.trash_items().is_empty());
    }

    #[test]
    fn capture_trash_preserves_shared_evidence_and_bulk_purge_is_atomic() {
        let dir = tmp();
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images/a.png"), b"evidence").unwrap();
        let s = Store::open(&dir).unwrap();
        let c = s.create_capture(new_id(), "a.png".into()).unwrap();
        s.complete(&c.id, vec![item("첫째 업무"), item("둘째 약속")]).unwrap();
        let todos = s.snapshot().todos;
        assert!(s.delete_capture(&c.id).unwrap());
        assert_eq!(s.capture_image(&c.id).as_deref(), Some("a.png"));
        assert_eq!(s.snapshot().evidence_captures.len(), 1);
        assert!(s.delete_todo(&todos[0].id).unwrap());
        let selection = [todos[0].id.clone(), c.id.clone()];
        assert_eq!(s.purge_trash(&selection).unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(s.trash_items().len(), 2, "rejected purge must not remove its unrelated selected todo");
        assert!(dir.join("images/a.png").exists());
        assert!(s.delete_todo(&todos[1].id).unwrap());
        assert_eq!(s.purge_trash(&selection).unwrap_err().kind(), std::io::ErrorKind::InvalidInput, "archived work also protects its evidence");
        assert_eq!(s.purge_trash(&[todos[0].id.clone(), todos[1].id.clone(), c.id.clone()]).unwrap(), 3);
        assert!(!dir.join("images/a.png").exists());
        assert!(s.snapshot().history.is_empty());
        let bytes = std::fs::read_to_string(dir.join("store.json")).unwrap();
        assert!(!bytes.contains("첫째 업무") && !bytes.contains("둘째 약속"));
        assert_eq!(s.restore_trash(&selection).unwrap(), 0);
    }

    #[test]
    fn todo_purge_keeps_follow_ups_and_captures() {
        let s = Store::open(&tmp()).unwrap();
        let c = s.create_capture(new_id(), "a.png".into()).unwrap();
        s.complete(&c.id, vec![item("보고서 제출")]).unwrap();
        let parent = s.snapshot().todos[0].id.clone();
        s.finish_todo(&parent, Finish { done_on: due(11, 1).unwrap(), note: "기록".into(), follow_ups: vec![NewTodo { todo: item("자료 보완"), priority: 1, repeat: None }] }).unwrap();
        let child = s.snapshot().todos[1].id.clone();
        s.delete_todo(&child).unwrap();
        s.delete_todo(&parent).unwrap();
        assert_eq!(s.purge_trash(&[parent]).unwrap(), 1);
        assert_eq!(s.restore_trash(&[child.clone()]).unwrap(), 1);
        let d = s.snapshot();
        assert_eq!(d.todos[0].id, child);
        assert!(d.todos[0].parent_id.is_none(), "a permanently missing parent is safely detached");
        assert_eq!(d.todos[0].capture_id, c.id);
        assert_eq!(d.captures.len(), 1);
    }

    #[test]
    fn purging_one_capture_never_removes_a_shared_image_file() {
        let dir = tmp();
        std::fs::create_dir_all(dir.join("images")).unwrap();
        std::fs::write(dir.join("images/shared.png"), b"shared evidence").unwrap();
        let s = Store::open(&dir).unwrap();
        let a = s.create_capture(new_id(), "shared.png".into()).unwrap();
        let b = s.create_capture(new_id(), "shared.png".into()).unwrap();
        s.complete(&a.id, vec![]).unwrap();
        s.complete(&b.id, vec![]).unwrap();
        s.delete_capture(&a.id).unwrap();
        assert_eq!(s.purge_trash(&[a.id]).unwrap(), 1);
        assert!(dir.join("images/shared.png").exists());
        assert_eq!(s.capture_image(&b.id).as_deref(), Some("shared.png"));
    }

    #[test]
    fn failed_store_write_does_not_change_live_data() {
        let dir = tmp();
        let s = Store::open(&dir).unwrap();
        let t = added(s.add_todo(item("저장 보장"), 0, None).unwrap());
        std::fs::create_dir(dir.join("store.json.tmp")).unwrap();
        assert!(s.delete_todo(&t.id).is_err());
        assert_eq!(s.snapshot().todos.len(), 1);
        assert!(s.trash_items().is_empty());
        assert!(s.snapshot().history.is_empty());
    }

    #[test]
    fn explicit_purge_file_cleanup_survives_interruption() {
        let dir = tmp();
        std::fs::create_dir_all(dir.join("images/blocked.png")).unwrap();
        let s = Store::open(&dir).unwrap();
        let c = s.create_capture(new_id(), "blocked.png".into()).unwrap();
        s.complete(&c.id, vec![]).unwrap();
        s.delete_capture(&c.id).unwrap();
        assert!(s.purge_trash(&[c.id]).is_err(), "a directory in place of a file blocks deletion");
        assert!(s.trash_items().is_empty(), "the permanent-delete intent has been committed");
        assert_eq!(s.data.lock().unwrap().pending_file_deletions, vec!["blocked.png"]);
        std::fs::remove_dir(dir.join("images/blocked.png")).unwrap();
        std::fs::write(dir.join("images/blocked.png"), b"still pending").unwrap();
        let s = Store::open(&dir).unwrap();
        assert!(!dir.join("images/blocked.png").exists());
        assert!(s.data.lock().unwrap().pending_file_deletions.is_empty());
    }

    #[test]
    fn delete_capture_keeps_todos_and_refuses_in_progress() {
        let s = Store::open(&tmp()).unwrap();
        let c = s.create_capture(new_id(), "a.png".into()).unwrap();
        assert!(!s.delete_capture(&c.id).unwrap(), "queued");
        s.complete(&c.id, vec![item("보고서 제출")]).unwrap();
        assert!(s.delete_capture(&c.id).unwrap());
        let d = s.snapshot();
        assert!(d.captures.is_empty());
        assert_eq!((d.todos.len(), d.todos[0].capture_id.as_str()), (1, c.id.as_str()));
        assert_eq!(d.evidence_captures.len(), 1);
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
        assert_eq!(d.captures[0].status, CaptureStatus::Done { added: 1, held: 0 });

        let other = s.create_capture(new_id(), "b.png".into()).unwrap();
        assert_eq!(s.complete(&other.id, vec![item("보고서 제출")]).unwrap(), 0, "same notice captured twice is held, not added");
        assert_eq!(s.snapshot().pending.len(), 1);
        let later = ExtractedTodo { title: "보고서 제출".into(), due: NaiveDate::from_ymd_opt(2026, 12, 1), ..Default::default() };
        let third = s.create_capture(new_id(), "c.png".into()).unwrap();
        assert_eq!(s.complete(&third.id, vec![later]).unwrap(), 1, "same title, different due is a new task");

        assert!(s.retry(&c.id).unwrap().is_some(), "a done capture can be analyzed again");
        let gone = s.snapshot().todos.iter().find(|t| t.capture_id == c.id && t.title == "회의 참석").unwrap().id.clone();
        s.delete_todo(&gone).unwrap();
        assert_eq!(s.complete(&c.id, vec![item("회의 참석")]).unwrap(), 0, "re-analysis never recreates a trashed original");
    }

    #[test]
    fn manual_todo_needs_a_title_and_survives_completion() {
        let s = Store::open(&tmp()).unwrap();
        assert!(s.add_todo(item("  "), 0, None).unwrap().is_none());
        let t = added(s.add_todo(ExtractedTodo { title: " 주간 보고 ".into(), sender: Some("팀장".into()), ..Default::default() }, 2, None).unwrap());
        assert_eq!((t.title.as_str(), t.capture_id.as_str(), t.priority), ("주간 보고", "", 2));
        s.update_todo(&t.id, TodoPatch { done: Some(true), ..Default::default() }).unwrap();
        assert!(s.snapshot().todos.iter().any(|x| x.id == t.id && x.done), "completing keeps the record");
    }

    #[test]
    fn checking_off_a_repeating_todo_adds_the_next_one() {
        let s = Store::open(&tmp()).unwrap();
        let due = NaiveDate::from_ymd_opt(2026, 1, 31);
        let t = added(s.add_todo(ExtractedTodo { title: "월간 보고".into(), due, ..Default::default() }, 1, Some(Repeat::Monthly)).unwrap());
        let done = || TodoPatch { done: Some(true), ..Default::default() };
        s.update_todo(&t.id, done()).unwrap();
        s.update_todo(&t.id, TodoPatch { done: Some(false), ..Default::default() }).unwrap();
        s.update_todo(&t.id, done()).unwrap();
        let open: Vec<_> = s.snapshot().todos.into_iter().filter(|x| !x.done && x.id != t.id).collect();
        assert_eq!(open.len(), 1, "re-checking does not stack copies");
        assert_eq!((open[0].due, open[0].priority, open[0].repeat), (NaiveDate::from_ymd_opt(2026, 2, 28), 1, Some(Repeat::Monthly)));

        let w = added(s.add_todo(ExtractedTodo { title: "주간업무보고".into(), due: NaiveDate::from_ymd_opt(2026, 10, 30), ..Default::default() }, 0, Some(Repeat::Weekly)).unwrap());
        s.update_todo(&w.id, done()).unwrap();
        assert!(s.snapshot().todos.iter().any(|x| !x.done && x.due == NaiveDate::from_ymd_opt(2026, 11, 6)));
        let off: TodoPatch = serde_json::from_str(r#"{"repeat":null}"#).unwrap();
        s.update_todo(&open[0].id, off).unwrap();
        s.update_todo(&open[0].id, done()).unwrap();
        assert!(!s.snapshot().todos.iter().any(|x| !x.done && x.title == "월간 보고"), "repeat off stops the chain");
    }

    #[test]
    fn finishing_keeps_the_note_and_opens_follow_ups() {
        let s = Store::open(&tmp()).unwrap();
        let item = ExtractedTodo { title: "예산 보고".into(), sender: Some("기획처".into()), due: NaiveDate::from_ymd_opt(2026, 11, 5), ..Default::default() };
        let t = added(s.add_todo(item, 2, None).unwrap());
        let f: Finish = serde_json::from_str(r#"{"done_on":"2026-11-02","note":" 결재 완료, 증빙 추가 요청 받음 ","follow_ups":[{"title":"증빙 제출","due":"2026-11-09","sender":"기획처","priority":1},{"title":" "}]}"#).unwrap();
        assert!(s.finish_todo(&t.id, f).unwrap());
        let d = s.snapshot();
        let done = d.todos.iter().find(|x| x.id == t.id).unwrap();
        assert!(done.done);
        assert_eq!(done.done_note.as_deref(), Some("결재 완료, 증빙 추가 요청 받음"));
        assert_eq!(done.done_at.unwrap().with_timezone(&Local).date_naive(), NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(), "stamped on the chosen day");
        let open: Vec<_> = d.todos.iter().filter(|x| !x.done).collect();
        assert_eq!(open.len(), 1, "a follow-up without a title is skipped");
        assert_eq!((open[0].title.as_str(), open[0].sender.as_deref(), open[0].due, open[0].priority), ("증빙 제출", Some("기획처"), NaiveDate::from_ymd_opt(2026, 11, 9), 1));
        assert_eq!(open[0].capture_id, t.capture_id);
        assert_eq!(open[0].parent_id.as_deref(), Some(t.id.as_str()), "a follow-up remembers what it followed");
        assert!(!s.finish_todo("nope", serde_json::from_str(r#"{"done_on":"2026-11-02"}"#).unwrap()).unwrap());
    }

    fn due(m: u32, d: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(2026, m, d)
    }

    #[test]
    fn look_alikes_are_held_with_reasons_and_never_merged() {
        let s = Store::open(&tmp()).unwrap();
        let a = s.create_capture(new_id(), "a.png".into()).unwrap();
        let notice = |title: &str, d| ExtractedTodo { title: title.into(), due: d, detail: Some("본관 3층 총무팀에 서면 제출".into()), ..Default::default() };
        s.complete(&a.id, vec![notice("연말정산 서류 제출", due(11, 6))]).unwrap();
        let first = s.snapshot().todos[0].clone();
        s.update_todo(&first.id, TodoPatch { done: Some(true), ..Default::default() }).unwrap();

        let b = s.create_capture(new_id(), "b.png".into()).unwrap();
        let again = vec![notice("연말정산 서류 제출", due(11, 6)), notice("연말정산 관련 서류 제출", due(11, 6)), item("체육대회 참가 신청")];
        assert_eq!(s.complete(&b.id, again).unwrap(), 1, "only the unrelated one is added");
        let d = s.snapshot();
        assert_eq!(d.captures[1].status, CaptureStatus::Done { added: 1, held: 2 });
        let [same, close] = [&d.pending[0], &d.pending[1]];
        assert_eq!(same.matches[0].todo_id, first.id);
        assert!(same.matches[0].reasons.contains(&"제목 같음".to_string()), "{:?}", same.matches[0].reasons);
        assert!(close.matches[0].reasons[0].starts_with("제목 비슷함"), "{:?}", close.matches[0].reasons);

        assert!(s.resolve(&same.id, Resolve::Attach { todo_id: first.id.clone() }).unwrap());
        let t = s.snapshot().todos.into_iter().find(|t| t.id == first.id).unwrap();
        assert_eq!((t.title.as_str(), t.done, t.capture_id.as_str(), t.extra_captures.clone()), ("연말정산 서류 제출", true, a.id.as_str(), vec![b.id.clone()]), "attach links evidence only");
        assert!(s.resolve(&close.id, Resolve::Add).unwrap());
        assert_eq!(s.snapshot().todos.len(), 3);
        assert!(s.snapshot().pending.is_empty());
        assert!(!s.resolve("nope", Resolve::Keep).unwrap());

        assert!(s.delete_capture(&b.id).unwrap());
        assert!(s.snapshot().todos.iter().any(|t| references(t, &b.id)), "trashing a capture preserves evidence links");
    }

    #[test]
    fn a_repeating_todos_next_round_is_not_a_duplicate() {
        let s = Store::open(&tmp()).unwrap();
        let weekly = ExtractedTodo { title: "주간업무보고".into(), due: due(11, 6), detail: Some("팀 공유폴더에 업로드".into()), ..Default::default() };
        added(s.add_todo(weekly.clone(), 0, Some(Repeat::Weekly)).unwrap());
        let next = ExtractedTodo { due: due(11, 13), ..weekly.clone() };
        assert!(matches!(s.add_todo(next, 0, None).unwrap(), Some(Added::Todo(_))), "next week's round is added");
        assert!(matches!(s.add_todo(weekly, 0, None).unwrap(), Some(Added::Held(_))), "the same round again is held");
    }

    #[test]
    fn older_store_files_load_without_the_new_fields() {
        let dir = tmp();
        let old = r#"{"captures":[{"id":"c1","image":"c1.png","status":{"kind":"done","added":1},"created_at":"2026-10-01T00:00:00Z"}],
            "todos":[{"id":"t1","capture_id":"c1","title":"보고","due":null,"detail":null,"done":false,"created_at":"2026-10-01T00:00:00Z"}]}"#;
        std::fs::write(dir.join("store.json"), old).unwrap();
        let d = Store::open(&dir).unwrap().snapshot();
        assert_eq!(d.captures[0].status, CaptureStatus::Done { added: 1, held: 0 });
        assert!(d.todos[0].extra_captures.is_empty() && d.pending.is_empty() && d.calls.is_empty());
    }

    #[test]
    fn report_items_cover_the_done_span_and_up_to_the_planned_end() {
        let s = Store::open(&tmp()).unwrap();
        let add = |title: &str, d| added(s.add_todo(ExtractedTodo { title: title.into(), due: d, ..Default::default() }, 0, None).unwrap());
        let finished = add("예산 보고", due(11, 10));
        let f: Finish = serde_json::from_str(r#"{"done_on":"2026-11-11","note":"결재 완료"}"#).unwrap();
        s.finish_todo(&finished.id, f).unwrap();
        add("교육 이수", due(11, 20));
        add("지난 서류", due(11, 3));
        add("다음 달 행사", due(12, 15));
        add("마감 없는 일", None);
        let (done, planned) = s.report_items(due(11, 9).unwrap(), due(11, 13).unwrap(), due(11, 20).unwrap());
        assert_eq!(done, vec![ReportItem { title: "예산 보고".into(), note: Some("결재 완료".into()), due: due(11, 10) }]);
        assert_eq!(planned.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), ["지난 서류", "교육 이수"], "overdue and up to the planned end; not next month, not undated");
        let (done, _) = s.report_items(due(11, 16).unwrap(), due(11, 20).unwrap(), due(11, 27).unwrap());
        assert!(done.is_empty(), "finished outside the span");
    }

    #[test]
    fn saving_a_report_replaces_the_same_period() {
        let dir = tmp();
        let s = Store::open(&dir).unwrap();
        let r = |line: &str| Report { start: due(11, 9).unwrap(), end: due(11, 13).unwrap(), planned_start: due(11, 16).unwrap(), planned_end: due(11, 20).unwrap(), done: vec![line.into()], planned: vec![] };
        s.save_report(r("초안")).unwrap();
        s.save_report(r("고친 문장")).unwrap();
        s.save_report(Report { start: due(11, 16).unwrap(), end: due(11, 20).unwrap(), ..r("다음 주") }).unwrap();
        let d = Store::open(&dir).unwrap().snapshot();
        assert_eq!(d.reports.len(), 2);
        assert_eq!(d.reports[0].done, vec!["고친 문장".to_string()]);
    }

    #[test]
    fn call_notes_add_and_delete() {
        let dir = tmp();
        let s = Store::open(&dir).unwrap();
        assert!(s.add_call(" ", "").unwrap().is_none());
        let n = s.add_call(" 김과장 ", "견적 내일까지").unwrap().unwrap();
        assert_eq!(n.who, "김과장");
        assert_eq!(Store::open(&dir).unwrap().snapshot().calls.len(), 1, "persists");
        assert!(s.delete_call(&n.id).unwrap());
        assert!(s.snapshot().calls.is_empty());
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
