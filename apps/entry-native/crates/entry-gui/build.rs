//! Rasterizes the canonical repository logo (`assets/brand/logo.svg`) into the
//! rounded accent tile used for the window icon and in-app marks. The source
//! render is white-on-black, so its luminance doubles as stroke coverage; that
//! coverage is composited onto the accent rounded tile at the macOS ~80% safe
//! area. The PNG lands in OUT_DIR and is embedded via include_bytes!, so the
//! asset always derives from the canonical SVG at build time.

use std::path::{Path, PathBuf};

use resvg::tiny_skia;

const SIZE: u32 = 512;
/// Fraction of the canvas covered by the rounded tile (Apple icon grid ~80%).
const TILE_FILL: f32 = 0.8;
/// Corner radius as a fraction of the tile (source tile rx is 72/320).
const CORNER: f32 = 0.225;
const ACCENT: (u8, u8, u8) = (0x4c, 0x8d, 0xff);

fn main() {
    let crate_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let svg_path = crate_dir.join("../../../../assets/brand/logo.svg");
    let out_png = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("logo.png");
    println!("cargo:rerun-if-changed={}", svg_path.display());

    if svg_path.is_file() {
        let svg = std::fs::read(&svg_path).expect("read assets/brand/logo.svg");
        compose(&svg, &out_png);
    } else {
        // Standalone build outside the monorepo: ship the last baked tile.
        let baked = crate_dir.join("assets/logo.png");
        assert!(
            baked.is_file(),
            "neither assets/brand/logo.svg nor assets/logo.png found"
        );
        std::fs::copy(&baked, &out_png).expect("copy baked logo.png");
    }
}

fn compose(svg: &[u8], out: &Path) {
    let tree = resvg::usvg::Tree::from_data(svg, &resvg::usvg::Options::default())
        .expect("parse assets/brand/logo.svg");
    let size = tree.size();
    let mut strokes = tiny_skia::Pixmap::new(SIZE, SIZE).expect("stroke pixmap");
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(
            SIZE as f32 / size.width(),
            SIZE as f32 / size.height(),
        ),
        &mut strokes.as_mut(),
    );

    // Accent tile with the standard icon safe area, anti-aliased.
    let tile = SIZE as f32 * TILE_FILL;
    let pad = (SIZE as f32 - tile) / 2.0;
    let mut dst = tiny_skia::Pixmap::new(SIZE, SIZE).expect("tile pixmap");
    let path = rounded_rect(pad, pad, tile, tile, tile * CORNER);
    let mut paint = tiny_skia::Paint::default();
    paint.set_color_rgba8(ACCENT.0, ACCENT.1, ACCENT.2, 255);
    paint.anti_alias = true;
    dst.fill_path(
        &path,
        &paint,
        tiny_skia::FillRule::Winding,
        tiny_skia::Transform::default(),
        None,
    );

    let s = strokes.pixels();
    for (i, px) in dst.pixels_mut().iter_mut().enumerate() {
        let stroke = s[i].red() as u32; // white strokes on black → r = coverage
        let cov = px.alpha() as u32; // tile coverage
        if cov == 0 {
            *px = tiny_skia::PremultipliedColorU8::TRANSPARENT;
            continue;
        }
        // Mix accent → white by stroke coverage; alpha stays the tile's
        // coverage (premultiplied, as Pixmap requires).
        let ch = |c: u32| (c * (255 - stroke) + 255 * stroke) / 255 * cov / 255;
        *px = tiny_skia::PremultipliedColorU8::from_rgba(
            ch(ACCENT.0 as u32) as u8,
            ch(ACCENT.1 as u32) as u8,
            ch(ACCENT.2 as u32) as u8,
            cov as u8,
        )
        .expect("premultiplied pixel");
    }
    dst.save_png(out).expect("write logo.png");
}

/// Rounded rectangle path; tiny-skia-path 0.11 has no helper, so corners are
/// quarter-circle cubic Béziers (κ = 4/3·tan(π/8)).
fn rounded_rect(x: f32, y: f32, w: f32, h: f32, rad: f32) -> tiny_skia::Path {
    const K: f32 = 0.552_284_75;
    let k = rad * K;
    let (r, b) = (x + w, y + h);
    let mut p = tiny_skia::PathBuilder::new();
    p.move_to(x + rad, y);
    p.line_to(r - rad, y);
    p.cubic_to(r - rad + k, y, r, y + rad - k, r, y + rad);
    p.line_to(r, b - rad);
    p.cubic_to(r, b - rad + k, r - rad + k, b, r - rad, b);
    p.line_to(x + rad, b);
    p.cubic_to(x + rad - k, b, x, b - rad + k, x, b - rad);
    p.line_to(x, y + rad);
    p.cubic_to(x, y + rad - k, x + rad - k, y, x + rad, y);
    p.close();
    p.finish().expect("rounded rect path")
}
