// Тесты на Windows: у тестового exe нет манифеста приложения (его ставит tauri-build только самой программе),
// и без Common Controls v6 Tauri (tao, muda) не находит функции comctl32 — тест падает ещё до запуска с
// 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND. Встраиваем тот же манифест, что у программ на Tauri, во всё,
// что собирает этот крейт (так же делает сам Tauri для своих тестов). На Linux ничего не нужно.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=test-manifest.xml");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "windows" && env == "msvc" {
        let m = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("test-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", m.display());
    }
}
