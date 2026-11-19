// Архив темы: подпапка, фон, файлы, вложенные папки не берутся; поддельный размер в оглавлении — отказ.
#[test]
fn archive_theme() {
    let th = whisper_wmt::open(include_bytes!("fixtures/archive.wmt")).unwrap();
    assert!(th.archive);
    assert_eq!(th.id(), "zip-test");
    assert_eq!(th.background().map(|b| (b.name.as_str(), b.mime, b.bytes.len())), Some(("background.webp", "image/webp", 1024)));
    assert_eq!(th.asset("pad.txt").map(|a| a.bytes.len()), Some(6000));
    assert!(th.asset("no.txt").is_none() && th.asset("deep/no.txt").is_none());
    assert_eq!(th.tokens().accent.as_deref(), Some("#aa11cc"));
    assert_eq!(th.roles_used(None), vec!["player"]);
    assert!(th.css("a").unwrap().lines().count() == 200);
}

#[test]
fn fake_size_rejected() {
    let e = whisper_wmt::open(include_bytes!("fixtures/bomb.wmt")).unwrap_err();
    assert!(e.msg.contains("больший размер"), "{e}");
}
