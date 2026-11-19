// Распаковка deflate (RFC 1951) — то, чем сжаты файлы в zip-архиве темы. Небольшая и без зависимостей,
// по образцу puff из zlib. Потолок размера проверяется во время распаковки: заявленному в оглавлении zip
// размеру верить нельзя (его подделывают), поэтому распаковка обрывается, как только вышла за limit.

pub(crate) struct Bits<'a> { d: &'a [u8], pos: usize, buf: u32, cnt: u32 }

#[derive(Debug, PartialEq)]
pub(crate) enum InflateError { Broken, TooBig }

type R<T> = Result<T, InflateError>;

impl<'a> Bits<'a> {
    fn bits(&mut self, n: u32) -> R<u32> {
        while self.cnt < n {
            let b = *self.d.get(self.pos).ok_or(InflateError::Broken)?;
            self.pos += 1;
            self.buf |= (b as u32) << self.cnt;
            self.cnt += 8;
        }
        let v = self.buf & ((1u32 << n) - 1);
        self.buf >>= n;
        self.cnt -= n;
        Ok(v)
    }
}

struct Huff { count: [i32; 16], sym: Vec<u16> }

fn huff(lengths: &[u8]) -> R<Huff> {
    let mut count = [0i32; 16];
    for &l in lengths { count[l as usize] += 1; }
    let mut left = 1i32;
    for c in count.iter().skip(1) { left <<= 1; left -= c; if left < 0 { return Err(InflateError::Broken); } }   // лишние коды
    let mut offs = [0i32; 16];
    for i in 1..15 { offs[i + 1] = offs[i] + count[i]; }
    let mut sym = vec![0u16; lengths.len()];
    for (s, &l) in lengths.iter().enumerate() { if l != 0 { sym[offs[l as usize] as usize] = s as u16; offs[l as usize] += 1; } }
    count[0] = 0;
    Ok(Huff { count, sym })
}

fn decode(b: &mut Bits, h: &Huff) -> R<u16> {
    let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
    for len in 1..16 {
        code |= b.bits(1)? as i32;
        let c = h.count[len];
        if code - c < first { return h.sym.get((index + (code - first)) as usize).copied().ok_or(InflateError::Broken); }
        index += c; first += c; first <<= 1; code <<= 1;
    }
    Err(InflateError::Broken)
}

const LBASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

fn codes(b: &mut Bits, out: &mut Vec<u8>, lit: &Huff, dist: &Huff, limit: usize) -> R<()> {
    loop {
        let s = decode(b, lit)?;
        if s < 256 {
            if out.len() >= limit { return Err(InflateError::TooBig); }
            out.push(s as u8);
        } else if s == 256 {
            return Ok(());
        } else {
            let s = (s - 257) as usize;
            if s >= 29 { return Err(InflateError::Broken); }
            let len = LBASE[s] as usize + b.bits(LEXT[s] as u32)? as usize;
            let ds = decode(b, dist)? as usize;
            if ds >= 30 { return Err(InflateError::Broken); }
            let d = DBASE[ds] as usize + b.bits(DEXT[ds] as u32)? as usize;
            if d > out.len() { return Err(InflateError::Broken); }
            if out.len() + len > limit { return Err(InflateError::TooBig); }
            let st = out.len() - d;
            for k in 0..len { let c = out[st + k]; out.push(c); }       // копия может перекрываться — по байту
        }
    }
}

/// Распаковать «сырой» deflate (как в zip, метод 8) не больше limit байт.
pub(crate) fn inflate(data: &[u8], limit: usize, size_hint: usize) -> R<Vec<u8>> {
    let mut b = Bits { d: data, pos: 0, buf: 0, cnt: 0 };
    let mut out = Vec::with_capacity(size_hint.min(limit));
    loop {
        let last = b.bits(1)?;
        match b.bits(2)? {
            0 => {
                b.buf = 0; b.cnt = 0;                                // к границе байта
                let p = b.pos;
                if p + 4 > data.len() { return Err(InflateError::Broken); }
                let len = u16::from_le_bytes([data[p], data[p + 1]]) as usize;
                let nlen = u16::from_le_bytes([data[p + 2], data[p + 3]]) as usize;
                if len != (!nlen & 0xffff) || p + 4 + len > data.len() { return Err(InflateError::Broken); }
                if out.len() + len > limit { return Err(InflateError::TooBig); }
                out.extend_from_slice(&data[p + 4..p + 4 + len]);
                b.pos = p + 4 + len;
            }
            1 => {
                let mut l = [0u8; 288];
                for (i, x) in l.iter_mut().enumerate() { *x = match i { 0..=143 => 8, 144..=255 => 9, 256..=279 => 7, _ => 8 }; }
                let lit = huff(&l)?;
                let dist = huff(&[5u8; 30])?;
                codes(&mut b, &mut out, &lit, &dist, limit)?;
            }
            2 => {
                let nlen = b.bits(5)? as usize + 257;
                let ndist = b.bits(5)? as usize + 1;
                let ncode = b.bits(4)? as usize + 4;
                if nlen > 286 || ndist > 30 { return Err(InflateError::Broken); }
                const ORD: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                let mut cl = [0u8; 19];
                for &o in ORD.iter().take(ncode) { cl[o] = b.bits(3)? as u8; }
                let ch = huff(&cl)?;
                let mut lens = vec![0u8; nlen + ndist];
                let mut i = 0;
                while i < nlen + ndist {
                    let s = decode(&mut b, &ch)?;
                    if s < 16 { lens[i] = s as u8; i += 1; continue; }
                    let (v, n) = match s {
                        16 => { if i == 0 { return Err(InflateError::Broken); } (lens[i - 1], 3 + b.bits(2)? as usize) }
                        17 => (0, 3 + b.bits(3)? as usize),
                        _ => (0, 11 + b.bits(7)? as usize),
                    };
                    if i + n > nlen + ndist { return Err(InflateError::Broken); }
                    for x in &mut lens[i..i + n] { *x = v; }
                    i += n;
                }
                if lens[256] == 0 { return Err(InflateError::Broken); }   // нет кода конца блока
                let lit = huff(&lens[..nlen])?;
                let dist = huff(&lens[nlen..])?;
                codes(&mut b, &mut out, &lit, &dist, limit)?;
            }
            _ => return Err(InflateError::Broken),
        }
        if last == 1 { return Ok(out); }
    }
}
