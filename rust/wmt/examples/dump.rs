// Сводка темы для сверки с wmt.js: cargo run --example dump -- файл.wmt
fn main() {
    for p in std::env::args().skip(1) {
        let b = std::fs::read(&p).expect("файл");
        match whisper_wmt::open(&b) {
            Ok(th) => {
                let mut a: Vec<String> = th.assets.iter().map(|x| format!("{}:{}", x.name, x.bytes.len())).collect();
                a.sort();
                let mut s: Vec<String> = th.sections.iter().filter(|s| s.kind != "asset").map(|s| format!("{} {}:{}", s.kind, s.name, s.text.len())).collect();
                s.sort();
                let t = th.tokens();
                println!("{} | {} | {} | bg={} | {} | {} | accent={:?} glow={:?}", th.id(), th.name(), th.archive,
                    th.background().map(|x| x.name.as_str()).unwrap_or("-"), a.join(","), s.join(","), t.accent, t.glow);
            }
            Err(e) => println!("ОШИБКА {p}: {e}"),
        }
    }
}
