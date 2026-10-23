//! Web test mode: the same API plus the built UI (`pnpm build`) on http://127.0.0.1:47321.
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let dir = capture_core::data_dir();
    let ui = std::env::var_os("UI_DIR")
        .map(Into::into)
        .unwrap_or_else(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/dist"));
    println!("data: {}", dir.display());
    println!("open http://127.0.0.1:{}", capture_core::PORT);
    capture_core::serve(dir, Some(ui)).await
}
