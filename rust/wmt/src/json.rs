// JSON с комментариями (// и /* */) и лишними запятыми — как в wmt.js (stripJsonc + JSON.parse).
// Свой разбор, чтобы у крейта не было зависимостей: секции manifest/tokens/settings маленькие.
// Объект хранит порядок ключей; повтор ключа — побеждает последний (как в JSON.parse).

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    /// поле объекта (или None)
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self { Value::Obj(v) => v.iter().rev().find(|(k, _)| k == key).map(|(_, x)| x), _ => None }
    }
    /// путь через точки: "color.accent"
    pub fn path(&self, p: &str) -> Option<&Value> { p.split('.').try_fold(self, |v, k| v.get(k)) }
    pub fn as_str(&self) -> Option<&str> { if let Value::Str(s) = self { Some(s) } else { None } }
    pub fn as_f64(&self) -> Option<f64> { if let Value::Num(n) = self { Some(*n) } else { None } }
    pub fn as_bool(&self) -> Option<bool> { if let Value::Bool(b) = self { Some(*b) } else { None } }
    pub fn as_array(&self) -> Option<&[Value]> { if let Value::Arr(a) = self { Some(a) } else { None } }
    pub fn as_object(&self) -> Option<&[(String, Value)]> { if let Value::Obj(o) = self { Some(o) } else { None } }
    pub fn is_object(&self) -> bool { matches!(self, Value::Obj(_)) }
}

#[derive(Debug, Clone, PartialEq)]
pub struct JsonError { pub msg: String, pub line: usize }
impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{} (строка {} секции)", self.msg, self.line) }
}

struct P<'a> { s: &'a [u8], i: usize, depth: usize }

pub fn parse(text: &str) -> Result<Value, JsonError> {
    let mut p = P { s: text.as_bytes(), i: 0, depth: 0 };
    p.ws()?;
    let v = p.value()?;
    p.ws()?;
    if p.i < p.s.len() { return Err(p.err("лишние символы после JSON")); }
    Ok(v)
}

impl<'a> P<'a> {
    fn line(&self) -> usize { 1 + self.s[..self.i.min(self.s.len())].iter().filter(|&&c| c == b'\n').count() }
    fn err(&self, m: &str) -> JsonError { JsonError { msg: m.to_string(), line: self.line() } }
    fn peek(&self) -> Option<u8> { self.s.get(self.i).copied() }
    // пробелы и комментарии
    fn ws(&mut self) -> Result<(), JsonError> {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r') => self.i += 1,
                Some(b'/') if self.s.get(self.i + 1) == Some(&b'/') => { while let Some(c) = self.peek() { if c == b'\n' { break; } self.i += 1; } }
                Some(b'/') if self.s.get(self.i + 1) == Some(&b'*') => {
                    self.i += 2;
                    loop {
                        match self.peek() {
                            None => break,                       // как в wmt.js: незакрытый комментарий — до конца
                            Some(b'*') if self.s.get(self.i + 1) == Some(&b'/') => { self.i += 2; break; }
                            _ => self.i += 1,
                        }
                    }
                }
                _ => return Ok(()),
            }
        }
    }
    fn value(&mut self) -> Result<Value, JsonError> {
        match self.peek() {
            None => Err(self.err("JSON обрывается")),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') => self.word("true", Value::Bool(true)),
            Some(b'f') => self.word("false", Value::Bool(false)),
            Some(b'n') => self.word("null", Value::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number(),
            Some(_) => Err(self.err("неожиданный символ")),
        }
    }
    fn word(&mut self, w: &str, v: Value) -> Result<Value, JsonError> {
        if self.s[self.i..].starts_with(w.as_bytes()) { self.i += w.len(); Ok(v) } else { Err(self.err("неожиданное слово")) }
    }
    fn enter(&mut self) -> Result<(), JsonError> {
        self.depth += 1;
        if self.depth > 64 { Err(self.err("слишком глубокая вложенность")) } else { Ok(()) }
    }
    fn object(&mut self) -> Result<Value, JsonError> {
        self.enter()?;
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.ws()?;
            if self.peek() == Some(b'}') { self.i += 1; break; }       // в том числе после лишней запятой
            if self.peek() != Some(b'"') { return Err(self.err("ожидалось имя поля в кавычках")); }
            let k = self.string()?;
            self.ws()?;
            if self.peek() != Some(b':') { return Err(self.err("ожидалось «:»")); }
            self.i += 1;
            self.ws()?;
            let v = self.value()?;
            out.push((k, v));
            self.ws()?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => { self.i += 1; break; }
                _ => return Err(self.err("ожидалось «,» или «}»")),
            }
        }
        self.depth -= 1;
        Ok(Value::Obj(out))
    }
    fn array(&mut self) -> Result<Value, JsonError> {
        self.enter()?;
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.ws()?;
            if self.peek() == Some(b']') { self.i += 1; break; }
            out.push(self.value()?);
            self.ws()?;
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => { self.i += 1; break; }
                _ => return Err(self.err("ожидалось «,» или «]»")),
            }
        }
        self.depth -= 1;
        Ok(Value::Arr(out))
    }
    fn hex4(&mut self) -> Result<u32, JsonError> {
        let h = self.s.get(self.i..self.i + 4).ok_or_else(|| self.err("обрезанный \\u"))?;
        let s = std::str::from_utf8(h).map_err(|_| self.err("неверный \\u"))?;
        let n = u32::from_str_radix(s, 16).map_err(|_| self.err("неверный \\u"))?;
        self.i += 4;
        Ok(n)
    }
    fn string(&mut self) -> Result<String, JsonError> {
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.peek().ok_or_else(|| self.err("незакрытая строка"))?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = self.peek().ok_or_else(|| self.err("незакрытая строка"))?;
                    self.i += 1;
                    let ch = match e {
                        b'"' => '"', b'\\' => '\\', b'/' => '/', b'b' => '\u{8}', b'f' => '\u{c}',
                        b'n' => '\n', b'r' => '\r', b't' => '\t',
                        b'u' => {
                            let mut n = self.hex4()?;
                            if (0xd800..0xdc00).contains(&n) && self.s.get(self.i..self.i + 2) == Some(b"\\u") {
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xdc00..0xe000).contains(&lo) { n = 0x10000 + ((n - 0xd800) << 10) + (lo - 0xdc00); }
                                else { self.i -= 6; }
                            }
                            char::from_u32(n).unwrap_or('\u{fffd}')
                        }
                        _ => return Err(self.err("неверная escape-последовательность")),
                    };
                    let mut b = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
                }
                c if c < 0x20 => return Err(self.err("управляющий символ в строке")),
                c => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| self.err("строка не в UTF-8"))
    }
    fn number(&mut self) -> Result<Value, JsonError> {
        let st = self.i;
        if self.peek() == Some(b'-') { self.i += 1; }
        let digits = |p: &mut Self| { let a = p.i; while matches!(p.peek(), Some(b'0'..=b'9')) { p.i += 1; } p.i - a };
        if digits(self) == 0 { return Err(self.err("неверное число")); }
        if self.peek() == Some(b'.') { self.i += 1; if digits(self) == 0 { return Err(self.err("неверное число")); } }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) { self.i += 1; }
            if digits(self) == 0 { return Err(self.err("неверное число")); }
        }
        let t = std::str::from_utf8(&self.s[st..self.i]).unwrap_or("x");
        t.parse::<f64>().map(Value::Num).map_err(|_| self.err("неверное число"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jsonc() {
        let v = parse("{\n // комментарий\n \"a\": [1, 2,], /* x */ \"b\": { \"c\": \"\\u0442\\u0435\", },\n}").unwrap();
        assert_eq!(v.path("b.c").and_then(Value::as_str), Some("те"));
        assert_eq!(v.get("a").and_then(Value::as_array).map(|a| a.len()), Some(2));
        assert!(parse("{ \"a\": }").is_err());
        assert_eq!(parse("{\n\n \"a\" 1 }").unwrap_err().line, 3);
        assert_eq!(parse("-1.5e2").unwrap(), Value::Num(-150.0));
    }
}
