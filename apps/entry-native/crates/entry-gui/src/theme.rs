//! macOS-oriented visual system for the egui shell.
//!
//! Inter (OFL) is bundled for real weight control — SF is a variable font and
//! egui can only render its default instance. SF Mono / PingFang are loaded
//! from the system at runtime when present (validated first — egui panics on
//! unparsable font data).

use std::sync::Arc;

use eframe::egui::{
    self, Align2, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Frame,
    Margin, Pos2, Rect, Response, RichText, Sense, Stroke, Ui, Vec2, WidgetInfo, WidgetType,
};

// ── color tokens ────────────────────────────────────────────────────────────

/// Semantic palette resolved per appearance. Named after macOS dynamic colors.
#[derive(Clone, Copy)]
pub struct Tokens {
    pub dark: bool,
    /// windowBackground — the canvas under everything.
    pub window_bg: Color32,
    /// Sidebar/source-list material (flat approximation — egui has no blur).
    pub sidebar_bg: Color32,
    /// Toolbar strip under the native title bar.
    pub toolbar_bg: Color32,
    /// Content cards / grouped surfaces.
    pub card_bg: Color32,
    /// Slightly raised surface for text inputs, combo boxes.
    pub control_bg: Color32,
    /// 1px hairlines.
    pub hairline: Color32,
    pub label: Color32,
    pub secondary_label: Color32,
    pub tertiary_label: Color32,
    pub accent: Color32,
    /// accent at low alpha — selected rows, tinted chips.
    pub accent_soft: Color32,
    pub green: Color32,
    pub red: Color32,
    pub orange: Color32,
    /// Hover fill on neutral rows/buttons.
    pub hover_fill: Color32,
    /// Pressed fill on neutral rows/buttons.
    pub pressed_fill: Color32,
    /// Solid neutral gray — pills/dots that must stay readable.
    pub neutral: Color32,
    /// Dim layer behind sheets.
    pub scrim: Color32,
}

pub fn tokens(dark: bool) -> Tokens {
    if dark {
        Tokens {
            dark,
            window_bg: Color32::from_rgb(0x1b, 0x1b, 0x1f),
            sidebar_bg: Color32::from_rgb(0x20, 0x20, 0x25),
            toolbar_bg: Color32::from_rgb(0x20, 0x20, 0x25),
            card_bg: Color32::from_rgb(0x26, 0x26, 0x2b),
            control_bg: Color32::from_rgb(0x32, 0x32, 0x38),
            hairline: Color32::from_rgba_unmultiplied(255, 255, 255, 17),
            label: Color32::from_rgba_unmultiplied(246, 246, 250, 235),
            secondary_label: Color32::from_rgba_unmultiplied(235, 235, 245, 158),
            tertiary_label: Color32::from_rgba_unmultiplied(235, 235, 245, 92),
            accent: Color32::from_rgb(0x4c, 0x8d, 0xff),
            accent_soft: Color32::from_rgba_unmultiplied(0x4c, 0x8d, 0xff, 42),
            green: Color32::from_rgb(0x34, 0xc7, 0x59),
            red: Color32::from_rgb(0xff, 0x45, 0x3a),
            orange: Color32::from_rgb(0xff, 0x9f, 0x0a),
            hover_fill: Color32::from_rgba_unmultiplied(255, 255, 255, 13),
            pressed_fill: Color32::from_rgba_unmultiplied(255, 255, 255, 23),
            neutral: Color32::from_rgb(0x8e, 0x8e, 0x96),
            scrim: Color32::from_rgba_unmultiplied(0, 0, 0, 107),
        }
    } else {
        Tokens {
            dark,
            window_bg: Color32::from_rgb(0xf2, 0xf2, 0xf4),
            sidebar_bg: Color32::from_rgb(0xe9, 0xe9, 0xec),
            toolbar_bg: Color32::from_rgb(0xed, 0xed, 0xf0),
            card_bg: Color32::from_rgb(0xff, 0xff, 0xff),
            control_bg: Color32::from_rgb(0xf0, 0xf0, 0xf3),
            hairline: Color32::from_rgba_unmultiplied(0, 0, 0, 18),
            label: Color32::from_rgba_unmultiplied(0, 0, 0, 224),
            secondary_label: Color32::from_rgba_unmultiplied(60, 60, 67, 158),
            tertiary_label: Color32::from_rgba_unmultiplied(60, 60, 67, 92),
            accent: Color32::from_rgb(0x0b, 0x5d, 0xff),
            accent_soft: Color32::from_rgba_unmultiplied(0x0b, 0x5d, 0xff, 26),
            green: Color32::from_rgb(0x1f, 0xa9, 0x4b),
            red: Color32::from_rgb(0xd7, 0x00, 0x15),
            orange: Color32::from_rgb(0xc9, 0x4f, 0x00),
            hover_fill: Color32::from_rgba_unmultiplied(0, 0, 0, 10),
            pressed_fill: Color32::from_rgba_unmultiplied(0, 0, 0, 18),
            neutral: Color32::from_rgb(0x8e, 0x8e, 0x93),
            scrim: Color32::from_rgba_unmultiplied(0, 0, 0, 56),
        }
    }
}

/// Small status-tone palette behind a colored label (pills, dots).
pub fn soft(tone: Color32) -> Color32 {
    let [r, g, b, _] = tone.to_array();
    Color32::from_rgba_unmultiplied(r, g, b, 30)
}

fn shade(c: Color32, factor: f32) -> Color32 {
    let [r, g, b, a] = c.to_array();
    Color32::from_rgba_premultiplied(
        (r as f32 * factor) as u8,
        (g as f32 * factor) as u8,
        (b as f32 * factor) as u8,
        a,
    )
}

// ── type scale ──────────────────────────────────────────────────────────────

fn fam(name: &str) -> FontFamily {
    FontFamily::Name(Arc::from(name))
}

/// macOS text styles mapped onto Inter weights.
#[derive(Clone, Copy)]
pub enum Role {
    /// 20pt display semibold — detail-pane titles.
    Title2,
    /// 13pt semibold — buttons, emphasized rows.
    Headline,
    /// 13pt regular — primary text.
    Body,
    /// 13pt medium — labels next to values.
    BodyMedium,
    /// 12pt regular — secondary text.
    Callout,
    /// 11pt regular — captions, metadata.
    Footnote,
    /// 10pt medium — pills, section headers.
    Caption,
    /// 12pt monospace.
    Mono,
    /// 10.5pt monospace — logs.
    MonoSmall,
}

impl Role {
    pub fn font(self) -> FontId {
        match self {
            Role::Title2 => FontId::new(20.0, fam("display-semibold")),
            Role::Headline => FontId::new(13.0, fam("text-semibold")),
            Role::Body => FontId::new(13.0, FontFamily::Proportional),
            Role::BodyMedium => FontId::new(13.0, fam("text-medium")),
            Role::Callout => FontId::new(12.0, FontFamily::Proportional),
            Role::Footnote => FontId::new(11.0, FontFamily::Proportional),
            Role::Caption => FontId::new(10.0, fam("text-medium")),
            Role::Mono => FontId::new(12.0, FontFamily::Monospace),
            Role::MonoSmall => FontId::new(10.5, FontFamily::Monospace),
        }
    }
}

pub fn rt(text: impl Into<String>, role: Role, color: Color32) -> RichText {
    RichText::new(text.into()).font(role.font()).color(color)
}

pub fn label(ui: &mut Ui, text: impl Into<String>, role: Role, color: Color32) -> Response {
    ui.label(rt(text, role, color))
}

/// Truncate `text` so its rendered galley fits `max_width`; a clipped value
/// ends with a single "…". Never wraps and never elides the middle — ids keep
/// their identifying prefix.
pub fn ellipsize(ui: &Ui, text: &str, role: Role, max_width: f32) -> String {
    let font = role.font();
    let fits = |s: &str| {
        ui.fonts(|f| f.layout_no_wrap(s.to_owned(), font.clone(), Color32::WHITE))
            .size()
            .x
    };
    if fits(text) <= max_width {
        return text.to_owned();
    }
    let budget = (max_width - fits("…")).max(0.0);
    let chars: Vec<char> = text.chars().collect();
    let (mut lo, mut hi) = (0usize, chars.len());
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if fits(&chars[..mid].iter().collect::<String>()) <= budget {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    format!("{}…", chars[..lo].iter().collect::<String>())
}

// ── font + style install ─────────────────────────────────────────────────────

fn push_system_font(fonts: &mut FontDefinitions, name: &str, path: &str, index: u32) {
    if let Ok(bytes) = std::fs::read(path) {
        // egui panics on unparsable font data — validate before registering.
        if ab_glyph::FontVec::try_from_vec_and_index(bytes.clone(), index).is_ok() {
            let mut data = FontData::from_owned(bytes);
            data.index = index;
            fonts.font_data.insert(name.to_owned(), Arc::new(data));
        }
    }
}

pub fn install(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let add = |fonts: &mut FontDefinitions, name: &str, bytes: &'static [u8]| {
        fonts
            .font_data
            .insert(name.to_owned(), Arc::new(FontData::from_static(bytes)));
    };
    add(
        &mut fonts,
        "inter",
        include_bytes!("../assets/fonts/Inter-Regular.ttf"),
    );
    add(
        &mut fonts,
        "inter-medium",
        include_bytes!("../assets/fonts/Inter-Medium.ttf"),
    );
    add(
        &mut fonts,
        "inter-semibold",
        include_bytes!("../assets/fonts/Inter-SemiBold.ttf"),
    );
    add(
        &mut fonts,
        "inter-bold",
        include_bytes!("../assets/fonts/Inter-Bold.ttf"),
    );
    add(
        &mut fonts,
        "display-semibold",
        include_bytes!("../assets/fonts/InterDisplay-SemiBold.ttf"),
    );
    add(
        &mut fonts,
        "display-bold",
        include_bytes!("../assets/fonts/InterDisplay-Bold.ttf"),
    );

    push_system_font(
        &mut fonts,
        "sf-mono",
        "/System/Library/Fonts/SFNSMono.ttf",
        0,
    );
    // CJK fallback — Inter covers Latin only.
    push_system_font(&mut fonts, "cjk", "/System/Library/Fonts/PingFang.ttc", 0);
    push_system_font(
        &mut fonts,
        "cjk-alt",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        0,
    );

    let proportional = fonts.families.entry(FontFamily::Proportional).or_default();
    let mut order = vec!["inter".to_owned()];
    for extra in ["cjk", "cjk-alt"] {
        if fonts.font_data.contains_key(extra) {
            order.push(extra.to_owned());
        }
    }
    order.extend(proportional.iter().cloned());
    *proportional = order;

    let mono = fonts.families.entry(FontFamily::Monospace).or_default();
    if fonts.font_data.contains_key("sf-mono") {
        mono.insert(0, "sf-mono".to_owned());
    }

    for (alias, list) in [
        ("text-medium", vec!["inter-medium", "inter"]),
        ("text-semibold", vec!["inter-semibold", "inter"]),
        ("text-bold", vec!["inter-bold", "inter-semibold"]),
        (
            "display-semibold",
            vec!["display-semibold", "inter-semibold"],
        ),
        ("display-bold", vec!["display-bold", "inter-bold"]),
    ] {
        fonts
            .families
            .insert(fam(alias), list.into_iter().map(str::to_owned).collect());
    }

    ctx.set_fonts(fonts);
}

/// Apply the widget-level style for the current appearance. Re-run when the
/// system theme flips.
pub fn apply_style(ctx: &egui::Context, dark: bool) {
    let t = tokens(dark);
    let mut style = (*ctx.style()).clone();
    style.visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    let v = &mut style.visuals;

    v.panel_fill = t.window_bg;
    v.window_fill = t.card_bg;
    v.extreme_bg_color = t.control_bg;
    v.faint_bg_color = t.control_bg;
    v.hyperlink_color = t.accent;
    v.selection.bg_fill = t.accent;
    v.selection.stroke = Stroke::new(1.0, t.accent);
    v.window_corner_radius = CornerRadius::same(12);
    v.window_stroke = Stroke::new(1.0, t.hairline);
    v.widgets.inactive.bg_stroke = Stroke::new(1.0, t.hairline);

    for w in [
        &mut v.widgets.noninteractive,
        &mut v.widgets.inactive,
        &mut v.widgets.hovered,
        &mut v.widgets.active,
        &mut v.widgets.open,
    ] {
        w.fg_stroke = Stroke::new(1.0, t.label);
    }
    v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, t.label);
    v.widgets.inactive.weak_bg_fill = t.control_bg;
    v.widgets.inactive.corner_radius = CornerRadius::same(6);
    v.widgets.hovered.weak_bg_fill = t.hover_fill;
    v.widgets.hovered.corner_radius = CornerRadius::same(6);
    v.widgets.active.weak_bg_fill = t.pressed_fill;
    v.widgets.active.corner_radius = CornerRadius::same(6);

    let s = &mut style.spacing;
    s.item_spacing = Vec2::new(8.0, 8.0);
    s.button_padding = Vec2::new(12.0, 5.0);
    s.indent = 18.0;
    s.interact_size = Vec2::new(18.0, 18.0);
    s.scroll = egui::style::ScrollStyle::thin();
    s.scroll.floating = true;
    s.scroll.bar_width = 6.0;

    use egui::TextStyle;
    style.text_styles.insert(
        TextStyle::Heading,
        FontId::new(20.0, fam("display-semibold")),
    );
    style.text_styles.insert(TextStyle::Body, Role::Body.font());
    style
        .text_styles
        .insert(TextStyle::Button, Role::Headline.font());
    style
        .text_styles
        .insert(TextStyle::Small, Role::Footnote.font());
    style
        .text_styles
        .insert(TextStyle::Monospace, Role::Mono.font());

    ctx.set_style(style);
}

// ── primitives ──────────────────────────────────────────────────────────────

pub fn hairline_bottom(ui: &mut Ui, t: &Tokens) {
    let r = ui.max_rect();
    ui.painter()
        .hline(r.x_range(), r.bottom() - 0.5, Stroke::new(1.0, t.hairline));
}

/// Clickable disclosure triangle (painted — avoids missing-glyph boxes).
pub fn disclosure(ui: &mut Ui, t: &Tokens, expanded: bool) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(12.0), Sense::click());
    let c = rect.center();
    let pts = if expanded {
        [
            Pos2::new(c.x - 4.0, c.y - 3.0),
            Pos2::new(c.x + 4.0, c.y - 3.0),
            Pos2::new(c.x, c.y + 4.0),
        ]
    } else {
        [
            Pos2::new(c.x - 3.0, c.y - 4.0),
            Pos2::new(c.x - 3.0, c.y + 4.0),
            Pos2::new(c.x + 4.0, c.y),
        ]
    };
    ui.painter().add(egui::Shape::convex_polygon(
        pts.to_vec(),
        t.tertiary_label,
        Stroke::NONE,
    ));
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

/// Uppercase micro label above sidebar sections and page groups.
pub fn section_label(ui: &mut Ui, t: &Tokens, text: &str) {
    label(ui, text.to_uppercase(), Role::Caption, t.tertiary_label);
}

/// Small filled capsule for state — semantic tone + leading dot + soft wash.
pub fn status_pill(ui: &mut Ui, tone: Color32, text: &str) {
    let font = Role::Caption.font();
    let galley = ui.fonts(|f| f.layout_no_wrap(text.to_owned(), font, tone));
    let size = galley.size() + Vec2::new(20.0, 6.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::hover());
    ui.painter()
        .rect_filled(rect, CornerRadius::same(size.y as u8 / 2), soft(tone));
    ui.painter()
        .circle_filled(Pos2::new(rect.left() + 9.0, rect.center().y), 2.5, tone);
    ui.painter().galley(
        Pos2::new(rect.left() + 15.0, rect.center().y - galley.size().y / 2.0),
        galley,
        tone,
    );
    resp.widget_info(|| WidgetInfo::labeled(WidgetType::Label, true, text));
}

#[derive(Clone, Copy)]
pub enum Btn {
    /// Filled accent — the single primary action of a surface.
    Primary,
    /// Bordered neutral — regular macOS push button.
    Bordered,
    /// No chrome until hover — toolbar/secondary actions.
    Quiet,
    /// Bordered with red label — destructive.
    Destructive,
}

/// Hand-painted macOS push button: explicit hover/press/disabled states.
pub fn button(ui: &mut Ui, t: &Tokens, text: &str, kind: Btn, enabled: bool) -> Response {
    let font = match kind {
        Btn::Primary => Role::Headline.font(),
        _ => Role::BodyMedium.font(),
    };
    let galley = ui.fonts(|f| f.layout_no_wrap(text.to_owned(), font, t.label));
    let desired = Vec2::new(galley.size().x + 28.0, 26.0);
    let sense = if enabled {
        Sense::click()
    } else {
        Sense::hover()
    };
    let (rect, resp) = ui.allocate_exact_size(desired, sense);

    let (mut fill, mut stroke, mut text_color) = match kind {
        Btn::Primary => (t.accent, Stroke::NONE, Color32::WHITE),
        Btn::Destructive => (t.card_bg, Stroke::new(1.0, t.hairline), t.red),
        Btn::Bordered => (t.card_bg, Stroke::new(1.0, t.hairline), t.label),
        Btn::Quiet => (Color32::TRANSPARENT, Stroke::NONE, t.secondary_label),
    };
    if enabled {
        if resp.hovered() {
            fill = match kind {
                Btn::Primary => shade(t.accent, 0.86),
                Btn::Quiet => t.hover_fill,
                _ => shade(t.card_bg, if t.dark { 1.12 } else { 0.97 }),
            };
            if matches!(kind, Btn::Quiet) {
                text_color = t.label;
            }
        }
        if resp.hovered() && ui.input(|i| i.pointer.primary_down()) {
            fill = match kind {
                Btn::Primary => shade(t.accent, 0.74),
                _ => t.pressed_fill,
            };
        }
    } else {
        fill = Color32::TRANSPARENT;
        if matches!(kind, Btn::Primary) {
            fill = t.accent_soft;
        }
        text_color = t.tertiary_label;
        stroke = if matches!(kind, Btn::Quiet) {
            Stroke::NONE
        } else {
            Stroke::new(stroke.width, stroke.color.linear_multiply(0.5))
        };
    }

    if fill != Color32::TRANSPARENT {
        ui.painter().rect_filled(rect, CornerRadius::same(7), fill);
    }
    if stroke != Stroke::NONE {
        ui.painter().rect_stroke(
            rect,
            CornerRadius::same(7),
            stroke,
            egui::StrokeKind::Inside,
        );
    }
    ui.painter()
        .galley(rect.center() - galley.size() / 2.0, galley, text_color);
    resp.widget_info(|| WidgetInfo::labeled(WidgetType::Button, enabled, text));
    if enabled && resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

// ── icons ───────────────────────────────────────────────────────────────────

/// Small painted glyphs — egui has no icon font, so each is drawn from
/// strokes at a fixed optical size.
#[derive(Clone, Copy)]
pub enum Icon {
    Agents,
    Endpoint,
    Recovery,
    Activity,
    Plus,
    Refresh,
}

fn arc_points(c: Pos2, r: f32, a0: f32, a1: f32) -> Vec<Pos2> {
    const N: usize = 18;
    (0..=N)
        .map(|i| {
            let a = a0 + (a1 - a0) * (i as f32 / N as f32);
            Pos2::new(c.x + r * a.cos(), c.y + r * a.sin())
        })
        .collect()
}

fn quad_bez(p0: Pos2, p1: Pos2, p2: Pos2, out: &mut Vec<Pos2>) {
    for i in 1..=6 {
        let u = i as f32 / 6.0;
        let m = 1.0 - u;
        out.push(Pos2::new(
            m * m * p0.x + 2.0 * m * u * p1.x + u * u * p2.x,
            m * m * p0.y + 2.0 * m * u * p1.y + u * u * p2.y,
        ));
    }
}

pub fn paint_icon(p: &egui::Painter, kind: Icon, center: Pos2, size: f32, color: Color32) {
    let s = Stroke::new((size / 9.5).max(1.0), color);
    let c = center;
    let h = size / 2.0;
    match kind {
        Icon::Agents => {
            let r = Rect::from_center_size(c, Vec2::splat(size * 0.6));
            p.rect_stroke(r, CornerRadius::same(2), s, egui::StrokeKind::Inside);
            let pin = size * 0.15;
            for d in [-size * 0.15, size * 0.15] {
                p.line_segment(
                    [Pos2::new(c.x + d, r.top() - pin), Pos2::new(c.x + d, r.top())],
                    s,
                );
                p.line_segment(
                    [
                        Pos2::new(c.x + d, r.bottom()),
                        Pos2::new(c.x + d, r.bottom() + pin),
                    ],
                    s,
                );
                p.line_segment(
                    [Pos2::new(r.left() - pin, c.y + d), Pos2::new(r.left(), c.y + d)],
                    s,
                );
                p.line_segment(
                    [
                        Pos2::new(r.right(), c.y + d),
                        Pos2::new(r.right() + pin, c.y + d),
                    ],
                    s,
                );
            }
        }
        Icon::Endpoint => {
            p.circle_filled(c, size * 0.1, color);
            for r in [size * 0.28, size * 0.45] {
                p.add(egui::Shape::line(arc_points(c, r, -0.8, 0.8), s));
                p.add(egui::Shape::line(
                    arc_points(c, r, std::f32::consts::PI - 0.8, std::f32::consts::PI + 0.8),
                    s,
                ));
            }
        }
        Icon::Recovery => {
            let w = size * 0.38;
            let top_l = Pos2::new(c.x - w, c.y - h * 0.78);
            let top_r = Pos2::new(c.x + w, c.y - h * 0.78);
            let mid_r = Pos2::new(c.x + w, c.y + h * 0.12);
            let mid_l = Pos2::new(c.x - w, c.y + h * 0.12);
            let apex = Pos2::new(c.x, c.y + h * 0.9);
            let mut pts = vec![top_l, top_r, mid_r];
            quad_bez(
                mid_r,
                Pos2::new(c.x + w * 0.92, c.y + h * 0.7),
                apex,
                &mut pts,
            );
            quad_bez(
                apex,
                Pos2::new(c.x - w * 0.92, c.y + h * 0.7),
                mid_l,
                &mut pts,
            );
            p.add(egui::Shape::closed_line(pts, s));
        }
        Icon::Activity => {
            let pts = vec![
                Pos2::new(c.x - h, c.y),
                Pos2::new(c.x - h * 0.42, c.y),
                Pos2::new(c.x - h * 0.12, c.y - h * 0.6),
                Pos2::new(c.x + h * 0.28, c.y + h * 0.6),
                Pos2::new(c.x + h * 0.52, c.y),
                Pos2::new(c.x + h, c.y),
            ];
            p.add(egui::Shape::line(pts, s));
        }
        Icon::Plus => {
            let d = h * 0.72;
            p.line_segment([Pos2::new(c.x - d, c.y), Pos2::new(c.x + d, c.y)], s);
            p.line_segment([Pos2::new(c.x, c.y - d), Pos2::new(c.x, c.y + d)], s);
        }
        Icon::Refresh => {
            let r = size * 0.38;
            let a0 = 0.5f32;
            let a1 = a0 + 4.9f32;
            let pts = arc_points(c, r, a0, a1);
            p.add(egui::Shape::line(pts.clone(), s));
            let e = *pts.last().unwrap();
            let dir = Vec2::new(-a1.sin(), a1.cos()).normalized();
            let n = Vec2::new(-dir.y, dir.x);
            let hl = size * 0.22;
            p.line_segment([e, e - dir * hl + n * hl * 0.75], s);
            p.line_segment([e, e - dir * hl - n * hl * 0.75], s);
        }
    }
}

/// Square glyph button for toolbars and section headers.
pub fn iconbtn(ui: &mut Ui, t: &Tokens, kind: Icon, enabled: bool) -> Response {
    let sense = if enabled { Sense::click() } else { Sense::hover() };
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(24.0), sense);
    if enabled && resp.hovered() {
        let fill = if ui.input(|i| i.pointer.primary_down()) {
            t.pressed_fill
        } else {
            t.hover_fill
        };
        ui.painter().rect_filled(rect, CornerRadius::same(6), fill);
    }
    let color = if !enabled {
        t.tertiary_label
    } else if resp.hovered() {
        t.label
    } else {
        t.secondary_label
    };
    paint_icon(ui.painter(), kind, rect.center(), 13.0, color);
    resp.widget_info(|| WidgetInfo::new(WidgetType::Button));
    if enabled && resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

// ── sidebar rows ────────────────────────────────────────────────────────────

pub enum Lead {
    Dot(Color32),
    Icon(Icon),
}

/// Single-line source-list row: leading dot/icon + title + trailing status.
pub fn srow(
    ui: &mut Ui,
    t: &Tokens,
    selected: bool,
    lead: Lead,
    title: &str,
    tail_dot: Option<Color32>,
    tail: &str,
) -> Response {
    let width = ui.available_width();
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(width, 32.0), Sense::click());
    let r = CornerRadius::same(7);
    if selected {
        ui.painter().rect_filled(rect, r, t.accent_soft);
    } else if resp.hovered() {
        ui.painter().rect_filled(rect, r, t.hover_fill);
    }
    let p = ui.painter();
    let cy = rect.center().y;
    let mut x = rect.left() + 10.0;
    match lead {
        Lead::Dot(c) => {
            p.circle_filled(Pos2::new(x + 3.5, cy), 3.5, c);
            x += 16.0;
        }
        Lead::Icon(i) => {
            paint_icon(
                p,
                i,
                Pos2::new(x + 6.5, cy),
                13.0,
                if selected { t.accent } else { t.secondary_label },
            );
            x += 22.0;
        }
    }
    let title_col = if selected { t.accent } else { t.label };
    let galley = p.layout_no_wrap(tail.to_owned(), Role::Footnote.font(), t.tertiary_label);
    let dot_w = if tail_dot.is_some() { 12.0 } else { 0.0 };
    // The title must yield to the right-aligned tail and stop at the row
    // edge — measure and tail-elide instead of letting paint run past the
    // clip rect.
    let title_budget =
        (rect.right() - 10.0 - galley.size().x - dot_w - 8.0 - x).max(24.0);
    let title = ellipsize(
        ui,
        title,
        if selected { Role::Headline } else { Role::BodyMedium },
        title_budget,
    );
    p.text(
        Pos2::new(x, cy),
        Align2::LEFT_CENTER,
        &title,
        if selected {
            Role::Headline.font()
        } else {
            Role::BodyMedium.font()
        },
        title_col,
    );
    let mut tx = rect.right() - 10.0 - galley.size().x - dot_w;
    if let Some(c) = tail_dot {
        p.circle_filled(Pos2::new(tx + 3.5, cy), 3.5, c);
        tx += 12.0;
    }
    p.galley(
        Pos2::new(tx, cy - galley.size().y / 2.0),
        galley,
        t.tertiary_label,
    );
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp.widget_info(|| {
        WidgetInfo::labeled(WidgetType::SelectableLabel, selected, title.clone())
    });
    resp
}

/// Text-only accent action used in group headers and row footers.
pub fn link_btn(ui: &mut Ui, t: &Tokens, text: &str, enabled: bool) -> Response {
    let galley = ui.fonts(|f| f.layout_no_wrap(text.to_owned(), Role::Footnote.font(), t.accent));
    let sense = if enabled { Sense::click() } else { Sense::hover() };
    let (rect, resp) =
        ui.allocate_exact_size(galley.size() + Vec2::new(10.0, 4.0), sense);
    if enabled && resp.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(5), t.accent_soft);
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    ui.painter().galley(
        rect.center() - galley.size() / 2.0,
        galley,
        if enabled { t.accent } else { t.tertiary_label },
    );
    resp.widget_info(|| WidgetInfo::labeled(WidgetType::Button, enabled, text));
    resp
}

// ── grouped surfaces ────────────────────────────────────────────────────────

/// iOS-style group container: solid fill, hairline edge, rows inside use
/// [`grow`] so separators stay inset.
pub fn group_frame(t: &Tokens) -> Frame {
    Frame::new()
        .fill(t.card_bg)
        .corner_radius(CornerRadius::same(10))
        .stroke(Stroke::new(1.0, t.hairline))
        .inner_margin(Margin::symmetric(0, 2))
}

/// Render a [`group_frame`] stretched to the available width — a frame sizes
/// to its content, so groups need an explicit width claim.
pub fn group(ui: &mut Ui, t: &Tokens, add: impl FnOnce(&mut Ui)) {
    group_frame(t).show(ui, |ui| {
        ui.set_width(ui.available_width());
        add(ui);
    });
}

/// One row inside a [`group_frame`]: inset hairline above unless `first`,
/// 14px side margins, vertically centered content.
pub fn grow(ui: &mut Ui, t: &Tokens, first: bool, add: impl FnOnce(&mut Ui)) {
    if !first {
        let w = ui.available_width();
        let (rect, _) = ui.allocate_exact_size(Vec2::new(w, 1.0), Sense::hover());
        ui.painter().hline(
            rect.left() + 14.0..=rect.right(),
            rect.center().y,
            Stroke::new(1.0, t.hairline),
        );
    }
    ui.vertical(|ui| {
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.add_space(14.0);
            add(ui);
        });
        ui.add_space(8.0);
    });
}

/// Warm approval surface — pending permission requests live here, not in
/// the operation ledger.
pub fn banner_frame(t: &Tokens) -> Frame {
    Frame::new()
        .fill(soft(t.orange))
        .corner_radius(CornerRadius::same(10))
        .stroke(Stroke::new(
            1.0,
            Color32::from_rgba_unmultiplied(0xff, 0x9f, 0x0a, 80),
        ))
        .inner_margin(Margin::symmetric(15, 13))
}

/// Centered sheet surface anchored like a macOS modal panel.
pub fn sheet_frame(t: &Tokens) -> Frame {
    Frame::new()
        .fill(t.card_bg)
        .corner_radius(CornerRadius::same(14))
        .stroke(Stroke::new(1.0, t.hairline))
        .inner_margin(Margin::symmetric(20, 16))
        .shadow(egui::epaint::Shadow {
            offset: [0, 10],
            blur: 32,
            spread: 0,
            color: Color32::from_rgba_unmultiplied(0, 0, 0, 90),
        })
}

/// Rounded text-input frame matching macOS field styling.
pub fn input_frame(t: &Tokens) -> Frame {
    Frame::new()
        .fill(t.control_bg)
        .corner_radius(CornerRadius::same(8))
        .stroke(Stroke::new(1.0, t.hairline))
        .inner_margin(Margin::symmetric(10, 8))
}
