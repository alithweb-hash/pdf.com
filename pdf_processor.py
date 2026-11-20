import base64
import html
import io
import os
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pymupdf as fitz  # PyMuPDF
from PIL import Image


# ============================================================
# Font & Arabic Text Utilities
# ============================================================

def find_arabic_font_files() -> Tuple[Optional[str], Optional[str]]:
    """Locate reliable Arabic-capable Regular and Bold TrueType fonts on the system."""
    pairs = [
        (r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\arialbd.ttf"),
        (r"C:\Windows\Fonts\tahoma.ttf", r"C:\Windows\Fonts\tahomabd.ttf"),
        (r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\segoeuib.ttf"),
        (r"C:\Windows\Fonts\simpo.ttf", r"C:\Windows\Fonts\simpbdo.ttf"),
        (r"C:\Windows\Fonts\trado.ttf", r"C:\Windows\Fonts\tradbdo.ttf"),
        (r"C:\Windows\Fonts\calibri.ttf", r"C:\Windows\Fonts\calibrib.ttf"),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf", "/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf"),
        ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ]
    for reg, bold in pairs:
        if os.path.isfile(reg):
            return reg, (bold if os.path.isfile(bold) else None)
    return None, None


ARABIC_FONT_PATH, ARABIC_BOLD_FONT_PATH = find_arabic_font_files()
ARABIC_FONT_DIR = os.path.dirname(ARABIC_FONT_PATH) if ARABIC_FONT_PATH else None
ARABIC_FONT_FILE = os.path.basename(ARABIC_FONT_PATH) if ARABIC_FONT_PATH else None
ARABIC_BOLD_FONT_FILE = os.path.basename(ARABIC_BOLD_FONT_PATH) if ARABIC_BOLD_FONT_PATH else None

ARABIC_DIACRITICS_RE = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")


def has_arabic(text: str) -> bool:
    return any("\u0600" <= ch <= "\u06FF" or "\uFB50" <= ch <= "\uFEFF" for ch in text)


def normalize_arabic(text: str, fuzzy: bool = True) -> str:
    """Normalize Arabic/English text for robust matching across PDF encodings."""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text)
    if fuzzy:
        s = ARABIC_DIACRITICS_RE.sub("", s)
        s = s.replace("\u0640", "")  # Tatweel / Kashida
        s = re.sub(r"[أإآٱ]", "ا", s)
        s = s.replace("ة", "ه")
        s = s.replace("ى", "ي")
        s = s.replace("ؤ", "و").replace("ئ", "ي")
    s = re.sub(r"\s+", " ", s).strip()
    return s.lower()


def hex_to_rgb_float(hex_color: str) -> Tuple[float, float, float]:
    h = (hex_color or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return (1.0, 1.0, 1.0)
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)


def int_color_to_rgb(color_int: int) -> Tuple[int, int, int]:
    r = (color_int >> 16) & 255
    g = (color_int >> 8) & 255
    b = color_int & 255
    return (r, g, b)


def is_light_gray_color(color_int: int) -> bool:
    r, g, b = int_color_to_rgb(color_int)
    # Light gray or washed-out watermark tint
    avg = (r + g + b) / 3.0
    return avg >= 165


def build_font_css() -> str:
    rules = []
    if ARABIC_FONT_FILE:
        rules.append(f"@font-face {{ font-family: 'AppArabic'; src: url('{ARABIC_FONT_FILE}'); font-weight: normal; }}")
    if ARABIC_BOLD_FONT_FILE:
        rules.append(f"@font-face {{ font-family: 'AppArabic'; src: url('{ARABIC_BOLD_FONT_FILE}'); font-weight: bold; }}")
    if rules:
        rules.append("body, div, p, table, td, span { font-family: 'AppArabic', sans-serif; margin: 0; padding: 0; }")
        return "\n".join(rules)
    return "body, div, p, table, td, span { font-family: sans-serif; margin: 0; padding: 0; }"


def insert_styled_html(page: fitz.Page, rect: fitz.Rect, html_body: str, css_extra: str = "") -> None:
    """Insert RTL/Arabic-ready HTML into a PDF rectangle using MuPDF Story engine."""
    css = build_font_css() + "\n" + css_extra
    archive = fitz.Archive(ARABIC_FONT_DIR) if ARABIC_FONT_DIR else None
    try:
        page.insert_htmlbox(rect, html_body, css=css, archive=archive)
    except Exception:
        # Fallback without archive if needed
        page.insert_htmlbox(rect, html_body, css=css)


# ============================================================
# PDF Analysis (Headers, Footers, Watermarks)
# ============================================================

def _make_image_thumbnail(doc: fitz.Document, xref: int, max_dim: int = 120) -> Optional[str]:
    try:
        base_img = doc.extract_image(xref)
        if not base_img or not base_img.get("image"):
            return None
        img = Image.open(io.BytesIO(base_img["image"]))
        img.thumbnail((max_dim, max_dim))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"
    except Exception:
        return None


def _is_transparent_xobject(doc: fitz.Document, xref: int) -> bool:
    """Check if a Form XObject looks like a watermark (Watermark subtype/tag or low opacity)."""
    try:
        obj_str = doc.xref_object(xref, compressed=False)
    except Exception:
        return False
    if "/Subtype /Form" not in obj_str and "/Subtype/Form" not in obj_str:
        return False

    lower = obj_str.lower()
    if any(k in lower for k in ("/watermark", "adbe_compoundtype", "watermark")):
        return True

    # Inspect stream for /Artifact /Watermark
    try:
        stream_bytes = doc.xref_stream(xref) or b""
        if b"/Watermark" in stream_bytes or b"Watermark" in stream_bytes:
            return True
    except Exception:
        pass

    # Inspect referenced ExtGState for low opacity (ca < 0.65 or CA < 0.65)
    gs_refs = re.findall(r"/ExtGState\s*<<([^>]+)>>", obj_str, re.S)
    for gs_block in gs_refs:
        for ref_id in re.findall(r"(\d+)\s+0\s+R", gs_block):
            try:
                gs_obj = doc.xref_object(int(ref_id))
                for m in re.finditer(r"/(?:ca|CA)\s+([0-9]*\.?[0-9]+)", gs_obj):
                    val = float(m.group(1))
                    if 0.0 < val <= 0.65:
                        return True
            except Exception:
                pass
    return False


def analyze_pdf(pdf_path: str) -> Dict[str, Any]:
    """Inspect a PDF file for page geometry, repeated headers/footers, and watermarks."""
    doc = fitz.open(pdf_path)
    try:
        page_count = len(doc)
        page_sizes = [
            {"width": round(p.rect.width, 1), "height": round(p.rect.height, 1)}
            for p in doc
        ]

        header_lines: Counter = Counter()
        footer_lines: Counter = Counter()
        diagonal_texts: Counter = Counter()
        large_light_texts: Counter = Counter()

        annotation_count = 0
        diagonal_span_count = 0
        transparent_xobjs = set()

        image_pages: Dict[int, set] = defaultdict(set)
        image_meta: Dict[int, Dict[str, Any]] = {}

        # Sample up to 60 pages evenly for very large books to stay fast
        if page_count <= 60:
            sample_indices = list(range(page_count))
        else:
            step = max(1, page_count // 60)
            sample_indices = list(range(0, page_count, step))[:60]

        for idx in sample_indices:
            page = doc[idx]
            h = page.rect.height
            w = page.rect.width

            # 1. Check annotations
            for annot in page.annots() or []:
                subtype = (annot.type[1] or "").lower() if annot.type else ""
                info = annot.info or {}
                combined = f"{subtype} {info.get('title', '')} {info.get('subject', '')} {info.get('content', '')}".lower()
                if subtype in ("watermark", "stamp") or "watermark" in combined:
                    annotation_count += 1

            # 2. Check Form XObjects
            for xobj in page.get_xobjects():
                xref = xobj[0]
                if xref not in transparent_xobjs and _is_transparent_xobject(doc, xref):
                    transparent_xobjs.add(xref)

            # 3. Check Images
            for img in page.get_images(full=True):
                xref = img[0]
                img_w, img_h = img[2], img[3]
                smask = img[1]
                image_pages[xref].add(idx)
                if xref not in image_meta:
                    image_meta[xref] = {
                        "xref": xref,
                        "width": img_w,
                        "height": img_h,
                        "has_alpha": smask > 0,
                    }

            # 4. Inspect text blocks for headers, footers, diagonal/light watermarks
            text_dict = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT)
            for block in text_dict.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    direction = line.get("dir", (1.0, 0.0))
                    is_rotated = abs(direction[1]) > 0.15
                    line_bbox = fitz.Rect(line["bbox"])
                    spans = line.get("spans", [])
                    line_text = "".join(sp.get("text", "") for sp in spans).strip()
                    if not line_text:
                        continue

                    if is_rotated:
                        diagonal_span_count += 1
                        if len(line_text) >= 2:
                            diagonal_texts[line_text] += 1
                        continue

                    # Check large + light gray text (typical horizontal watermark)
                    max_size = max((sp.get("size", 0) for sp in spans), default=0)
                    all_light = spans and all(is_light_gray_color(sp.get("color", 0)) for sp in spans)
                    if max_size >= 24 and all_light:
                        diagonal_span_count += 1
                        large_light_texts[line_text] += 1

                    # Header & footer candidates (top 12% and bottom 12%)
                    if line_bbox.y1 <= h * 0.13 and len(line_text) >= 2:
                        cleaned = re.sub(r"\d+", "#", line_text)
                        header_lines[line_text if page_count <= 2 else cleaned] += 1
                    elif line_bbox.y0 >= h * 0.87 and len(line_text) >= 2:
                        cleaned = re.sub(r"\d+", "#", line_text)
                        footer_lines[line_text if page_count <= 2 else cleaned] += 1

        # Determine most common repeated header/footer
        min_repeat = 2 if len(sample_indices) >= 3 else 1
        detected_header = ""
        for txt, cnt in header_lines.most_common(3):
            if cnt >= min_repeat:
                detected_header = unicodedata.normalize("NFKC", txt.replace("#", "...")).replace("\u00a0", " ").strip()
                break

        detected_footer = ""
        for txt, cnt in footer_lines.most_common(3):
            if cnt >= min_repeat:
                detected_footer = unicodedata.normalize("NFKC", txt.replace("#", "...")).replace("\u00a0", " ").strip()
                break

        # Build watermark text candidates
        text_candidates: List[str] = []
        for txt, _ in (diagonal_texts + large_light_texts).most_common(10):
            clean_txt = unicodedata.normalize("NFKC", txt).replace("\u00a0", " ").strip()
            if clean_txt not in text_candidates and len(clean_txt) >= 2:
                text_candidates.append(clean_txt)

        # Build repeated images list (images appearing on >= 2 sampled pages)
        repeated_images: List[Dict[str, Any]] = []
        sample_total = max(1, len(sample_indices))
        for xref, pages_set in sorted(image_pages.items(), key=lambda kv: len(kv[1]), reverse=True):
            cnt = len(pages_set)
            if page_count >= 2 and cnt < 2:
                continue
            if page_count == 1 and not image_meta[xref]["has_alpha"]:
                continue
            meta = image_meta[xref]
            ratio = cnt / sample_total
            likely = (cnt >= 2 and ratio >= 0.35 and (meta["has_alpha"] or (meta["width"] >= 180 and meta["height"] >= 180)))
            repeated_images.append({
                "xref": xref,
                "width": meta["width"],
                "height": meta["height"],
                "page_count": cnt,
                "has_alpha": meta["has_alpha"],
                "likely_watermark": likely,
                "thumbnail": _make_image_thumbnail(doc, xref),
            })
            if len(repeated_images) >= 12:
                break

        return {
            "page_count": page_count,
            "page_sizes": page_sizes,
            "analysis": {
                "detected_header": detected_header,
                "detected_footer": detected_footer,
                "watermarks": {
                    "annotation_count": annotation_count,
                    "diagonal_text_count": diagonal_span_count,
                    "transparent_xobject_count": len(transparent_xobjs),
                    "text_candidates": text_candidates,
                    "repeated_images": repeated_images,
                },
            },
        }
    finally:
        doc.close()


# ============================================================
# Smart Text Search (Supports Arabic + English + Reversed PDFs)
# ============================================================

def _find_matches_on_page(page: fitz.Page, query: str, fuzzy_arabic: bool = True) -> List[Dict[str, Any]]:
    """
    Find all occurrences of `query` on a page, returning structured hit descriptors:
    {
      "rect": fitz.Rect,
      "full_line_text": str,
      "replace_mode": "span" | "exact",
      "span_text": str,
      "matched_substr": str,
      "font_size": float,
      "is_rtl": bool,
      "reversed_pdf": bool
    }
    """
    q_clean = query.strip()
    if not q_clean:
        return []

    q_norm = normalize_arabic(q_clean, fuzzy=fuzzy_arabic)
    q_norm_rev = q_norm[::-1]
    if not q_norm:
        return []

    hits: List[Dict[str, Any]] = []
    seen_rects: List[fitz.Rect] = []

    def rect_already_seen(r: fitz.Rect) -> bool:
        for sr in seen_rects:
            inter = sr & r
            if not inter.is_empty and inter.get_area() > 0.5 * min(sr.get_area(), r.get_area()):
                return True
        return False

    # Pass 1: Line & span inspection (best for Arabic shaping, fuzzy matching, and preserving surrounding text)
    text_dict = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT)
    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue

            # Check each individual span first
            line_matched_in_span = False
            for sp in spans:
                sp_text = sp.get("text", "")
                sp_norm = normalize_arabic(sp_text, fuzzy=fuzzy_arabic)
                if not sp_norm:
                    continue

                is_normal_match = q_norm in sp_norm
                is_rev_match = (not is_normal_match) and has_arabic(q_clean) and (q_norm_rev in sp_norm)

                if is_normal_match or is_rev_match:
                    r = fitz.Rect(sp["bbox"])
                    if not rect_already_seen(r):
                        seen_rects.append(r)
                        hits.append({
                            "rect": r,
                            "span_text": sp_text,
                            "font_size": float(sp.get("size", 11.0)),
                            "is_rtl": has_arabic(sp_text) or has_arabic(q_clean),
                            "reversed_pdf": is_rev_match,
                            "replace_entire_box": (sp_norm == q_norm or sp_norm == q_norm_rev),
                        })
                        line_matched_in_span = True

            if line_matched_in_span:
                continue

            # Check combined line (in case the name spans multiple PDF spans, e.g. "أ.د." + " أحمد محمد")
            combined_text = "".join(sp.get("text", "") for sp in spans)
            comb_norm = normalize_arabic(combined_text, fuzzy=fuzzy_arabic)
            is_normal_line = q_norm in comb_norm
            is_rev_line = (not is_normal_line) and has_arabic(q_clean) and (q_norm_rev in comb_norm)

            if not (is_normal_line or is_rev_line):
                # Also try reversed span order (common when RTL spans are ordered left-to-right in PDF)
                rev_spans_text = "".join(sp.get("text", "") for sp in reversed(spans))
                rev_spans_norm = normalize_arabic(rev_spans_text, fuzzy=fuzzy_arabic)
                if q_norm in rev_spans_norm:
                    combined_text = rev_spans_text
                    is_normal_line = True

            if is_normal_line or is_rev_line:
                r = fitz.Rect(line["bbox"])
                if not rect_already_seen(r):
                    seen_rects.append(r)
                    avg_size = sum(sp.get("size", 11.0) for sp in spans) / max(1, len(spans))
                    hits.append({
                        "rect": r,
                        "span_text": combined_text,
                        "font_size": float(avg_size),
                        "is_rtl": has_arabic(combined_text) or has_arabic(q_clean),
                        "reversed_pdf": is_rev_line,
                        "replace_entire_box": (normalize_arabic(combined_text, fuzzy=fuzzy_arabic) in (q_norm, q_norm_rev)),
                    })

    # Pass 2: Native PyMuPDF search fallback (catches ligatures or multi-line cases)
    if not hits:
        for r in page.search_for(q_clean):
            if not rect_already_seen(r):
                seen_rects.append(r)
                hits.append({
                    "rect": r,
                    "span_text": q_clean,
                    "font_size": max(8.0, min(20.0, r.height * 0.78)),
                    "is_rtl": has_arabic(q_clean),
                    "reversed_pdf": False,
                    "replace_entire_box": True,
                })

    return hits


def search_text_in_pdf(pdf_path: str, query: str, fuzzy_arabic: bool = True) -> Dict[str, Any]:
    doc = fitz.open(pdf_path)
    try:
        total_matches = 0
        pages_found: List[int] = []
        for idx in range(len(doc)):
            hits = _find_matches_on_page(doc[idx], query, fuzzy_arabic=fuzzy_arabic)
            if hits:
                total_matches += len(hits)
                pages_found.append(idx + 1)
        return {
            "query": query,
            "total_matches": total_matches,
            "pages": pages_found,
        }
    finally:
        doc.close()


def _replace_substring_fuzzy(original: str, old_query: str, new_text: str, fuzzy_arabic: bool, reversed_pdf: bool) -> str:
    """Replace `old_query` inside `original` while preserving prefix/suffix text."""
    working = unicodedata.normalize("NFKC", original)
    if reversed_pdf:
        working = working[::-1]

    # Try case-insensitive direct regex first
    pattern = re.escape(unicodedata.normalize("NFKC", old_query.strip()))
    replaced, count = re.subn(pattern, new_text, working, flags=re.IGNORECASE)
    if count > 0:
        return replaced

    if fuzzy_arabic:
        # Build a regex that allows Arabic diacritics, tatweel, and Alef/Ta/Ya equivalents
        chars_regex = []
        q_norm = normalize_arabic(old_query, fuzzy=True)
        for ch in q_norm:
            if ch == " ":
                chars_regex.append(r"\s+")
            elif ch == "ا":
                chars_regex.append(r"[اأإآٱ][\u0610-\u061A\u064B-\u065F\u0670\u0640]*")
            elif ch == "ه":
                chars_regex.append(r"[هة][\u0610-\u061A\u064B-\u065F\u0670\u0640]*")
            elif ch == "ي":
                chars_regex.append(r"[يىئ][\u0610-\u061A\u064B-\u065F\u0670\u0640]*")
            elif ch == "و":
                chars_regex.append(r"[وؤ][\u0610-\u061A\u064B-\u065F\u0670\u0640]*")
            else:
                chars_regex.append(re.escape(ch) + r"[\u0610-\u061A\u064B-\u065F\u0670\u0640]*")
        fuzzy_pattern = "".join(chars_regex)
        replaced, count = re.subn(fuzzy_pattern, new_text, working, flags=re.IGNORECASE)
        if count > 0:
            return replaced

    return new_text


# ============================================================
# Watermark Removal Helpers
# ============================================================

# Regex to match PDF BT...ET blocks and Artifact/Watermark marked content blocks
_NUM = rb"[+-]?(?:\d+\.?\d*|\.\d+)"
_ARTIFACT_WM_RE = re.compile(
    rb"/Artifact\s*<<[^>]*?/Subtype\s*/Watermark[^>]*?>>\s*BDC.*?EMC",
    re.S,
)
_STREAM_EVENT_RE = re.compile(
    rb"(?P<bt>(?<![A-Za-z0-9_])BT(?=[\s/<\[(\r\n]).*?(?<![A-Za-z0-9_])ET(?![A-Za-z0-9_]))"
    rb"|(?P<cm>" + _NUM + rb"\s+" + _NUM + rb"\s+" + _NUM + rb"\s+" + _NUM + rb"\s+" + _NUM + rb"\s+" + _NUM + rb"\s+cm(?![A-Za-z0-9_]))"
    rb"|(?P<rg>" + _NUM + rb"\s+" + _NUM + rb"\s+" + _NUM + rb"\s+rg(?![A-Za-z0-9_]))"
    rb"|(?P<gray>" + _NUM + rb"\s+g(?![A-Za-z0-9_]))"
    rb"|(?P<gs>/[A-Za-z0-9_.\-]+\s+gs(?![A-Za-z0-9_]))"
    rb"|(?P<q_push>(?<![A-Za-z0-9_])q(?![A-Za-z0-9_]))"
    rb"|(?P<q_pop>(?<![A-Za-z0-9_])Q(?![A-Za-z0-9_]))",
    re.S,
)
_TM_RE = re.compile(
    rb"(" + _NUM + rb")\s+(" + _NUM + rb")\s+(" + _NUM + rb")\s+(" + _NUM + rb")\s+(" + _NUM + rb")\s+(" + _NUM + rb")\s+Tm(?![A-Za-z0-9_])"
)
_TF_RE = re.compile(rb"/\S+\s+(" + _NUM + rb")\s+Tf(?![A-Za-z0-9_])")
_RG_COLOR_RE = re.compile(rb"(" + _NUM + rb")\s+(" + _NUM + rb")\s+(" + _NUM + rb")\s+rg(?![A-Za-z0-9_])")
_GRAY_COLOR_RE = re.compile(rb"(" + _NUM + rb")\s+g(?![A-Za-z0-9_])")


def _mat_mul(m1: Tuple[float, float, float, float], m2: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    """Multiply 2x2 linear parts (a, b, c, d) of PDF affine matrices."""
    a1, b1, c1, d1 = m1
    a2, b2, c2, d2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
    )


def _get_low_opacity_gs_names(doc: fitz.Document, page: fitz.Page) -> set:
    """Return ExtGState resource names (e.g. b'/GS1') on this page that set low opacity (ca <= 0.65)."""
    low_names = set()
    try:
        page_obj = doc.xref_object(page.xref, compressed=False)
        res_blocks = re.findall(r"/ExtGState\s*<<([^>]+)>>", page_obj, re.S)
        # Also follow indirect /Resources or /ExtGState if referenced
        for res_ref in re.findall(r"/Resources\s+(\d+)\s+0\s+R", page_obj):
            res_obj = doc.xref_object(int(res_ref), compressed=False)
            res_blocks.extend(re.findall(r"/ExtGState\s*<<([^>]+)>>", res_obj, re.S))
        for gs_ref in re.findall(r"/ExtGState\s+(\d+)\s+0\s+R", page_obj):
            res_blocks.append(doc.xref_object(int(gs_ref), compressed=False))

        for block in res_blocks:
            for name, ref_id in re.findall(r"(/[A-Za-z0-9_.\-]+)\s+(\d+)\s+0\s+R", block):
                try:
                    gs_obj = doc.xref_object(int(ref_id))
                    for m in re.finditer(r"/(?:ca|CA)\s+([0-9]*\.?[0-9]+)", gs_obj):
                        val = float(m.group(1))
                        if 0.0 < val <= 0.65:
                            low_names.add(name.encode("latin1"))
                except Exception:
                    pass
    except Exception:
        pass
    return low_names


def _strip_watermark_streams_on_page(
    doc: fitz.Document,
    page: fitz.Page,
    remove_artifacts: bool,
    remove_diagonal_text: bool,
) -> int:
    """
    Surgically strip Watermark Artifact blocks and rotated/diagonal/large-light BT..ET text blocks
    directly from the page content stream (tracking q/Q graphics state CTM, color, and opacity)
    without damaging normal horizontal text underneath!
    """
    removed = 0
    if not (remove_artifacts or remove_diagonal_text):
        return 0

    try:
        page.clean_contents()
    except Exception:
        pass

    low_opacity_gs = _get_low_opacity_gs_names(doc, page) if remove_diagonal_text else set()

    contents_xrefs = page.get_contents()
    for xref in contents_xrefs:
        try:
            stream = doc.xref_stream(xref)
        except Exception:
            continue
        if not stream:
            continue

        new_stream = stream

        # 1. Remove /Artifact << /Subtype /Watermark >> BDC ... EMC
        if remove_artifacts:
            new_stream, n_art = _ARTIFACT_WM_RE.subn(b"", new_stream)
            removed += n_art

        # 2. Remove rotated/diagonal or huge light/transparent BT ... ET blocks using graphics state tracking
        if remove_diagonal_text:
            # State: (ctm_2x2, is_light_fill, is_low_opacity)
            state_stack = [((1.0, 0.0, 0.0, 1.0), False, False)]
            out_parts: List[bytes] = []
            last_pos = 0

            for m in _STREAM_EVENT_RE.finditer(new_stream):
                kind = m.lastgroup
                if kind == "q_push":
                    state_stack.append(state_stack[-1])
                elif kind == "q_pop":
                    if len(state_stack) > 1:
                        state_stack.pop()
                elif kind == "cm":
                    nums = [float(x) for x in m.group(0).split()[:4]]
                    ctm, is_light, is_low_op = state_stack[-1]
                    state_stack[-1] = (_mat_mul((nums[0], nums[1], nums[2], nums[3]), ctm), is_light, is_low_op)
                elif kind == "rg":
                    nums = [float(x) for x in m.group(0).split()[:3]]
                    ctm, _, is_low_op = state_stack[-1]
                    state_stack[-1] = (ctm, (sum(nums) / 3.0) >= 0.68, is_low_op)
                elif kind == "gray":
                    val = float(m.group(0).split()[0])
                    ctm, _, is_low_op = state_stack[-1]
                    state_stack[-1] = (ctm, val >= 0.68, is_low_op)
                elif kind == "gs":
                    gs_name = m.group(0).split()[0]
                    ctm, is_light, is_low_op = state_stack[-1]
                    state_stack[-1] = (ctm, is_light, is_low_op or (gs_name in low_opacity_gs))
                elif kind == "bt":
                    body = m.group(0)
                    ctm, is_light, is_low_op = state_stack[-1]

                    # Also inspect color operators inside BT...ET
                    local_light = is_light
                    for rg in _RG_COLOR_RE.finditer(body):
                        r, g, b_val = float(rg.group(1)), float(rg.group(2)), float(rg.group(3))
                        local_light = (r + g + b_val) / 3.0 >= 0.68
                    for gr in _GRAY_COLOR_RE.finditer(body):
                        local_light = float(gr.group(1)) >= 0.68

                    tf_sizes = [abs(float(t.group(1))) for t in _TF_RE.finditer(body)]
                    max_tf = max(tf_sizes, default=12.0)

                    # Compute effective matrices (CTM * Tm for every Tm, or CTM if no Tm)
                    matrices = []
                    for tm in _TM_RE.finditer(body):
                        tm_2x2 = (float(tm.group(1)), float(tm.group(2)), float(tm.group(3)), float(tm.group(4)))
                        matrices.append(_mat_mul(tm_2x2, ctm))
                    if not matrices:
                        matrices.append(ctm)

                    strip_block = False
                    for a, b, c, d in matrices:
                        scale = max((a * a + b * b) ** 0.5, (c * c + d * d) ** 0.5, 1e-6)
                        effective_size = max_tf * scale

                        # Case A: Diagonal / rotated text watermark
                        if abs(b) / scale > 0.15 or abs(c) / scale > 0.15:
                            is_exact_90 = (abs(a) / scale < 0.05 and abs(d) / scale < 0.05)
                            if not is_exact_90 or effective_size >= 22 or local_light or is_low_op:
                                strip_block = True
                                break

                        # Case B: Large light-gray or low-opacity horizontal watermark
                        if effective_size >= 28 and (local_light or is_low_op):
                            strip_block = True
                            break

                    if strip_block:
                        out_parts.append(new_stream[last_pos:m.start()])
                        last_pos = m.end()
                        removed += 1

            if last_pos > 0:
                out_parts.append(new_stream[last_pos:])
                new_stream = b"".join(out_parts)

        if new_stream != stream:
            try:
                doc.update_stream(xref, new_stream)
            except Exception:
                pass

    return removed


def _remove_watermarks_from_page(
    doc: fitz.Document,
    page: fitz.Page,
    wm_opts: Dict[str, Any],
    cleared_xobjs: set,
) -> int:
    if not wm_opts.get("enabled"):
        return 0

    removed_count = 0

    # 1. Remove Watermark & Stamp Annotations
    if wm_opts.get("remove_annotations", True):
        annots_to_delete = []
        for annot in page.annots() or []:
            subtype = (annot.type[1] or "").lower() if annot.type else ""
            info = annot.info or {}
            combined = f"{subtype} {info.get('title', '')} {info.get('subject', '')} {info.get('content', '')}".lower()
            if subtype in ("watermark", "stamp") or "watermark" in combined:
                annots_to_delete.append(annot)
        for annot in annots_to_delete:
            try:
                page.delete_annot(annot)
                removed_count += 1
            except Exception:
                pass

    # 2. Clear Transparent / Watermark Form XObjects
    if wm_opts.get("remove_xobjects", True):
        for xobj in page.get_xobjects():
            xref = xobj[0]
            if xref in cleared_xobjs:
                continue
            if _is_transparent_xobject(doc, xref):
                try:
                    doc.update_stream(xref, b"")
                    cleared_xobjs.add(xref)
                    removed_count += 1
                except Exception:
                    pass

    # 3. Remove selected repeated image watermarks
    image_xrefs = set(int(x) for x in wm_opts.get("image_xrefs", []) if str(x).isdigit())
    if image_xrefs:
        page_img_xrefs = {img[0] for img in page.get_images(full=True)}
        for xref in page_img_xrefs & image_xrefs:
            try:
                page.delete_image(xref)
                removed_count += 1
            except Exception:
                pass

    # 4. Strip Artifact/Watermark & Diagonal Text streams safely
    removed_count += _strip_watermark_streams_on_page(
        doc,
        page,
        remove_artifacts=wm_opts.get("remove_annotations", True),
        remove_diagonal_text=wm_opts.get("remove_diagonal_text", True),
    )

    # 5. Remove user-specified custom watermark texts cleanly (fill=False leaves background/text intact)
    custom_texts = [t.strip() for t in wm_opts.get("custom_texts", []) if t and t.strip()]
    if custom_texts:
        redact_added = False
        for wm_txt in custom_texts:
            hits = _find_matches_on_page(page, wm_txt, fuzzy_arabic=True)
            for hit in hits:
                try:
                    page.add_redact_annot(hit["rect"], fill=False)
                    redact_added = True
                    removed_count += 1
                except Exception:
                    pass
        if redact_added:
            try:
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_NONE,
                    graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                )
            except TypeError:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    return removed_count


def _disable_watermark_ocgs(doc: fitz.Document) -> int:
    """Turn off any Optional Content Groups (layers) explicitly named as watermarks."""
    removed = 0
    try:
        ocgs = doc.get_ocgs()
        off_xrefs = []
        for xref, info in (ocgs or {}).items():
            name = (info.get("name") or "").lower()
            if any(k in name for k in ("watermark", "علامة", "background", "draft")):
                off_xrefs.append(xref)
                removed += 1
        if off_xrefs:
            doc.set_layer(-1, off=off_xrefs)
    except Exception:
        pass
    return removed


# ============================================================
# Text / Lecturer Name Replacement
# ============================================================

def _apply_text_replacements_on_page(page: fitz.Page, rep_opts: Dict[str, Any]) -> int:
    items = rep_opts.get("items") or []
    if not items:
        return 0

    fuzzy_arabic = bool(rep_opts.get("fuzzy_arabic", True))
    custom_font_size = float(rep_opts.get("font_size") or 0)
    text_color = rep_opts.get("text_color") or "#111827"

    pending_inserts: List[Dict[str, Any]] = []
    redact_added = False

    for item in items:
        old_text = (item.get("old_text") or "").strip()
        new_text = (item.get("new_text") or "").strip()
        if not old_text:
            continue

        hits = _find_matches_on_page(page, old_text, fuzzy_arabic=fuzzy_arabic)
        for hit in hits:
            rect: fitz.Rect = hit["rect"]
            # Slightly pad the redaction box to cleanly erase old ascenders/descenders
            redact_rect = fitz.Rect(rect.x0 - 1.5, rect.y0 - 1.5, rect.x1 + 1.5, rect.y1 + 1.5)
            # Sample local background color or default to white
            bg_rgb = (1.0, 1.0, 1.0)
            try:
                page.add_redact_annot(redact_rect, fill=bg_rgb)
                redact_added = True
            except Exception:
                continue

            if new_text:
                if hit["replace_entire_box"]:
                    final_text = new_text
                else:
                    final_text = _replace_substring_fuzzy(
                        hit["span_text"],
                        old_text,
                        new_text,
                        fuzzy_arabic=fuzzy_arabic,
                        reversed_pdf=hit["reversed_pdf"],
                    )

                font_size = custom_font_size if custom_font_size > 0 else max(8.5, min(26.0, hit["font_size"]))
                # Expand box width slightly if new text is longer than old text, keeping inside page margins
                page_w = page.rect.width
                extra_w = max(0.0, (len(final_text) - len(hit["span_text"])) * font_size * 0.52)
                if hit["is_rtl"]:
                    new_x0 = max(12.0, rect.x0 - extra_w - 4.0)
                    new_x1 = min(page_w - 12.0, rect.x1 + 4.0)
                else:
                    new_x0 = max(12.0, rect.x0 - 4.0)
                    new_x1 = min(page_w - 12.0, rect.x1 + extra_w + 4.0)

                box_h = max(rect.height + 6.0, font_size * 1.7)
                cy = (rect.y0 + rect.y1) / 2.0
                insert_rect = fitz.Rect(new_x0, cy - box_h / 2.0, new_x1, cy + box_h / 2.0)

                pending_inserts.append({
                    "rect": insert_rect,
                    "text": final_text,
                    "font_size": font_size,
                    "is_rtl": hit["is_rtl"] or has_arabic(final_text),
                })

    if redact_added:
        try:
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            )
        except TypeError:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    for ins in pending_inserts:
        direction = "rtl" if ins["is_rtl"] else "ltr"
        align = "right" if ins["is_rtl"] else "left"
        safe_txt = html.escape(ins["text"])
        snippet = (
            f"<div dir='{direction}' style='font-size:{ins['font_size']:.1f}pt; "
            f"color:{text_color}; text-align:{align}; line-height:1.25; white-space:nowrap;'>"
            f"{safe_txt}</div>"
        )
        insert_styled_html(page, ins["rect"], snippet)

    return len(pending_inserts) if pending_inserts else (1 if redact_added else 0)


# ============================================================
# Smart Old Lecture Header Detection & Removal
# ============================================================

_OLD_HEADER_AR_KEYWORDS = (
    "جامعة",
    "كلية",
    "كليه",
    "قسم",
    "وزارة التعليم",
    "المرحلة",
    "المرحله",
    "الدراسة",
    "الصباحية",
    "المسائية",
    "رقم المحاضرة",
    "رقم المحاضره",
    "من اصل",
    "من أصل",
    "محاضرة رقم",
    "المحاضرة رقم",
    "المحاضره رقم",
    "العام الدراسي",
    "الفصل الدراسي",
    "السنة الدراسية",
    "اعداد",
    "إعداد",
    "التدريسي",
    "المدرس",
    "الاستاذ",
    "الأستاذ",
    "المحاضر",
    "أ.د",
    "ا.د",
    "م.د",
    "م.م",
    "أ.م.د",
    "ا.م.د",
    "اسم المادة",
    "المادة:",
    "المادة :",
    "التاريخ",
    "مذكرة",
    "ملزمة",
    "فرع ",
)

_OLD_HEADER_EN_KEYWORDS = (
    "university",
    "college",
    "department",
    "dept.",
    "faculty",
    "ministry",
    "lecture no",
    "lecture :",
    "lecture:",
    "lec.",
    "lec ",
    "academic year",
    "semester",
    "prepared by",
    "lecturer",
    "instructor",
    "prof.",
    "asst.",
    "subject:",
    "course:",
    "stage:",
    "date:",
)

_DEFINITION_START_KEYWORDS = (
    "تعريف",
    "عبارة عن",
    "عباره عن",
    "يعرف",
    "تُعرف",
    "تعرف",
    "يقصد ب",
    "definition",
    "is defined as",
    "refers to",
    "introduction",
    "مقدمة",
    "مقدمه",
)

_NUMERIC_HEADER_ONLY_RE = re.compile(
    r"^[\s\d٠-٩/\-–—:.\(\)of]+$|^محاضره?\s*[\d٠-٩]+|^المحاضره?\s*[\d٠-٩]+|^lecture\s*\d+",
    re.I,
)


def _is_definition_or_body_line(text: str) -> bool:
    norm = normalize_arabic(text, fuzzy=True)
    if not norm:
        return False
    if any(normalize_arabic(k, fuzzy=True) in norm for k in _DEFINITION_START_KEYWORDS):
        return True
    # Long prose sentence is almost certainly lecture content, not a header line
    if len(norm) >= 72:
        return True
    return False


def _is_old_lecture_header_line(text: str) -> bool:
    """Return True if a top-of-page text line looks like old university/lecture header metadata."""
    norm = normalize_arabic(text, fuzzy=True)
    if not norm or len(norm) < 2:
        return False
    if _is_definition_or_body_line(text):
        return False

    candidates = [norm]
    if has_arabic(text):
        candidates.append(norm[::-1])

    for cand in candidates:
        for kw in _OLD_HEADER_AR_KEYWORDS:
            if normalize_arabic(kw, fuzzy=True) in cand:
                return True
        for kw in _OLD_HEADER_EN_KEYWORDS:
            if kw in cand:
                return True
        if _NUMERIC_HEADER_ONLY_RE.match(cand):
            return True
        # Pattern like "13 من اصل 15" or "محاضرة 13"
        if ("محاضره" in cand or "محاضرات" in cand) and len(cand) <= 55:
            return True
    return False


def _find_page_outer_frame_bounds(page: fitz.Page) -> Tuple[float, float, Optional[float]]:
    """
    Detect if a page has an outer vertical border frame (left/right vertical lines spanning >50% height).
    Returns (inner_x0, inner_x1, top_border_y_or_None).
    """
    pw = page.rect.width
    ph = page.rect.height
    left_x = 0.0
    right_x = pw
    top_border_y: Optional[float] = None

    try:
        for d in page.get_drawings():
            r = d.get("rect")
            if not r:
                continue
            rect = fitz.Rect(r)
            # Full-page outer rectangle border
            if rect.width > pw * 0.75 and rect.height > ph * 0.65:
                if rect.x0 < pw * 0.15:
                    left_x = max(left_x, rect.x0 + 2.5)
                if rect.x1 > pw * 0.85:
                    right_x = min(right_x, rect.x1 - 2.5)
                if rect.y0 < ph * 0.12:
                    top_border_y = rect.y0
            # Tall left or right vertical border line
            elif rect.height > ph * 0.50 and rect.width <= 4.0:
                if rect.x0 < pw * 0.15:
                    left_x = max(left_x, rect.x1 + 2.5)
                elif rect.x1 > pw * 0.85:
                    right_x = min(right_x, rect.x0 - 2.5)
    except Exception:
        pass

    return left_x, right_x, top_border_y


def _smart_clean_old_lecture_header(
    page: fitz.Page,
    page_num: int,
    header_opts: Dict[str, Any],
    will_draw_new_header: bool,
) -> int:
    """
    Smartly detect and cleanly remove old lecture header lines/banners (e.g. university info,
    'رقم المحاضرة : 13 من أصل 15 محاضرة', old header boxes & horizontal rules) right up to
    the first definition or topic title, without damaging real lecture content or outer borders!
    """
    if not header_opts.get("smart_clean_old", True):
        return 0

    pw = page.rect.width
    ph = page.rect.height
    start_from_text = (header_opts.get("start_from_text") or "").strip()

    # Collect all text lines in the upper 52% of the page sorted top-to-bottom
    top_lines: List[Tuple[float, float, fitz.Rect, str]] = []
    text_dict = page.get_text("dict", flags=fitz.TEXTFLAGS_DICT)
    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            bbox = fitz.Rect(line["bbox"])
            if bbox.y0 > ph * 0.52:
                continue
            txt = "".join(sp.get("text", "") for sp in line.get("spans", [])).strip()
            if txt:
                top_lines.append((bbox.y0, bbox.y1, bbox, txt))

    top_lines.sort(key=lambda item: (round(item[0], 1), item[2].x0))
    if not top_lines:
        return 0

    cut_y: Optional[float] = None
    first_content_y0: float = ph * 0.52
    matched_count = 0

    # Mode 1: Explicit start phrase on Page 1 (e.g. "متسلسلة فورييه" or "تعريف")
    if page_num == 1 and start_from_text:
        q_norm = normalize_arabic(start_from_text, fuzzy=True)
        q_rev = q_norm[::-1]
        for y0, y1, bbox, txt in top_lines:
            t_norm = normalize_arabic(txt, fuzzy=True)
            if q_norm in t_norm or (has_arabic(start_from_text) and q_rev in t_norm):
                if y0 > 8.0:
                    cut_y = y0 - 2.5
                    first_content_y0 = y0
                    matched_count = 1
                break

    # Mode 2: Automatic smart detection of old lecture header lines right up to first topic/definition
    if cut_y is None:
        max_scan_y = ph * (0.42 if page_num == 1 else 0.22)
        last_old_y1: Optional[float] = None

        for y0, y1, bbox, txt in top_lines:
            if y0 > max_scan_y:
                break
            if _is_old_lecture_header_line(txt):
                last_old_y1 = max(last_old_y1 or 0.0, y1)
                matched_count += 1
            else:
                # Hit first real lecture topic/definition line -> stop scanning!
                first_content_y0 = y0
                break

        if last_old_y1 is not None:
            cut_y = last_old_y1 + 3.5

            # Also detect any horizontal divider line/rule right beneath the old header banner
            # (strictly ABOVE the first real content/definition line!)
            try:
                for d in page.get_drawings():
                    r = d.get("rect")
                    if not r:
                        continue
                    rect = fitz.Rect(r)
                    if (
                        rect.width > pw * 0.35
                        and rect.height <= 6.0
                        and (last_old_y1 - 3.0) <= rect.y0 <= min(last_old_y1 + 36.0, first_content_y0 - 2.0)
                    ):
                        cut_y = max(cut_y, rect.y1 + 2.5)
            except Exception:
                pass

            # Never clip the first real topic/definition line!
            if first_content_y0 < ph * 0.52:
                cut_y = min(cut_y, first_content_y0 - 2.0)

    if cut_y is None or cut_y <= 6.0:
        return 0

    bg_rgb = hex_to_rgb_float(header_opts.get("bg_color") or "#ffffff")
    inner_x0, inner_x1, top_border_y = _find_page_outer_frame_bounds(page)

    # If we are NOT drawing a new header on this page and there's a clean top page frame border,
    # start erasing right inside the top border so the page's outer border stays neat!
    if (not will_draw_new_header) and top_border_y is not None and top_border_y < cut_y - 6.0:
        erase_y0 = top_border_y + 2.0
    else:
        erase_y0 = 0.0

    erase_rect = fitz.Rect(inner_x0, erase_y0, inner_x1, cut_y)
    if erase_rect.is_empty or erase_rect.height < 4.0:
        return 0

    # 1. Redact all old header text inside erase_rect
    try:
        page.add_redact_annot(erase_rect, fill=bg_rgb)
        try:
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            )
        except TypeError:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
    except Exception:
        pass

    # 2. Remove any old header logo images sitting completely within the erased header zone
    try:
        for img_info in page.get_images(full=True):
            xref = img_info[0]
            for img_rect in page.get_image_rects(xref):
                if img_rect.y1 <= cut_y + 4.0 and img_rect.height <= ph * 0.28:
                    page.delete_image(xref)
                    break
    except Exception:
        pass

    # 3. Paint clean background fill inside the inner bounds to cleanly wipe old header lines/boxes
    page.draw_rect(erase_rect, color=None, fill=bg_rgb)
    return max(1, matched_count)


# ============================================================
# Header & Footer Replacement
# ============================================================

def _page_in_range(page_num: int, total_pages: int, opts: Dict[str, Any]) -> bool:
    if opts.get("skip_first_page") and page_num == 1:
        return False
    start_p = int(opts.get("start_page") or 1)
    end_p = opts.get("end_page")
    end_p = int(end_p) if end_p is not None and str(end_p).strip() != "" else total_pages
    return start_p <= page_num <= end_p


def _expand_placeholders(text: str, page_num: int, total_pages: int) -> str:
    if not text:
        return ""
    return (
        text.replace("{page}", str(page_num))
        .replace("{total}", str(total_pages))
    )


_ARABIC_INDIC_TABLE = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")


def _to_arabic_digits(text: str) -> str:
    return text.translate(_ARABIC_INDIC_TABLE)


def _format_page_number_label(page_num: int, total_pages: int, opts: Dict[str, Any]) -> str:
    """Build formatted footer page numbering string according to user preferences."""
    if not opts.get("numbering_enabled"):
        return ""

    start_p = int(opts.get("start_page") or 1)
    if opts.get("skip_first_page") and start_p < 2:
        first_numbered_page = 2
    else:
        first_numbered_page = start_p

    start_num = int(opts.get("numbering_start") or 1)
    display_page = max(1, (page_num - first_numbered_page) + start_num)

    end_p = opts.get("end_page")
    end_p_int = int(end_p) if end_p is not None and str(end_p).strip() != "" else total_pages
    display_total = max(display_page, (end_p_int - first_numbered_page) + start_num)

    fmt = opts.get("numbering_format") or "number_only"
    if fmt == "number_only":
        out = f"{display_page}"
    elif fmt == "dash_number":
        out = f"- {display_page} -"
    elif fmt == "slash":
        out = f"{display_page} / {display_total}"
    elif fmt == "page_of_total_en":
        out = f"Page {display_page} of {display_total}"
    elif fmt == "page_of_total_ar":
        out = f"صفحة {display_page} من {display_total}"
    else:
        out = f"{display_page}"

    if opts.get("numbering_arabic_digits"):
        out = _to_arabic_digits(out)
    return out


def _collect_lines(opts: Dict[str, Any], side: str, page_num: int, total_pages: int) -> List[str]:
    """Collect 1 or 2 lines for a side ('right' or 'left'), supporting dedicated line1/line2 or newline text."""
    l1 = opts.get(f"{side}_line1")
    l2 = opts.get(f"{side}_line2")
    if l1 is not None or l2 is not None:
        raw_lines = [s.strip() for s in (l1 or "", l2 or "") if s and s.strip()]
    else:
        legacy = opts.get(f"{side}_text") or ""
        raw_lines = [s.strip() for s in legacy.splitlines() if s.strip()]
    return [_expand_placeholders(line, page_num, total_pages) for line in raw_lines]


def _render_lines_html(
    lines: List[str],
    align: str,
    text_color: str,
    font_size: float,
    bold: bool,
) -> str:
    weight = "bold" if bold else "normal"
    parts = []
    for line in lines:
        line_dir = "rtl" if has_arabic(line) else "ltr"
        safe = html.escape(line)
        # Outer div controls physical horizontal alignment (left/center/right); inner span enforces BiDi direction
        parts.append(
            f"<div style='text-align:{align}; color:{text_color}; font-size:{font_size:.1f}pt; "
            f"font-weight:{weight}; line-height:1.38; margin:0; padding:0;'>"
            f"<span dir='{line_dir}'>{safe}</span></div>"
        )
    return "".join(parts)


def _apply_band(
    page: fitz.Page,
    page_num: int,
    total_pages: int,
    opts: Dict[str, Any],
    is_header: bool,
) -> bool:
    if not opts.get("enabled"):
        return False
    if not _page_in_range(page_num, total_pages, opts):
        return False

    pw = page.rect.width
    ph = page.rect.height
    band_h = max(24.0, min(ph * 0.4, float(opts.get("height") or (72 if is_header else 45))))

    if is_header:
        band_rect = fitz.Rect(0, 0, pw, band_h)
    else:
        band_rect = fitz.Rect(0, ph - band_h, pw, ph)

    bg_hex = opts.get("bg_color") or "#ffffff"
    bg_rgb = hex_to_rgb_float(bg_hex)
    text_color = opts.get("text_color") or ("#000000" if is_header else "#334155")
    font_size = max(7.0, min(28.0, float(opts.get("font_size") or (11 if is_header else 10))))
    is_bold = bool(opts.get("bold", True if is_header else False))
    margin_x = 32.0

    # 1. Cover / erase old header or footer area cleanly
    if opts.get("cover_old", True):
        try:
            page.add_redact_annot(band_rect, fill=bg_rgb)
            try:
                page.apply_redactions(
                    images=fitz.PDF_REDACT_IMAGE_NONE,
                    graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                )
            except TypeError:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        except Exception:
            pass
        page.draw_rect(band_rect, color=None, fill=bg_rgb)

    # 2. Optional divider line
    has_divider = bool(opts.get("divider", True))
    if has_divider:
        div_color_hex = opts.get("divider_color") or ("#000000" if is_header else "#cbd5e1")
        div_width = float(opts.get("divider_width") or (2.0 if is_header else 0.8))
        line_y = (band_h - 4.0) if is_header else (ph - band_h + 4.0)
        page.draw_line(
            fitz.Point(margin_x, line_y),
            fitz.Point(pw - margin_x, line_y),
            color=hex_to_rgb_float(div_color_hex),
            width=max(0.4, min(5.0, div_width)),
        )

    # 3. Compute content vertical region inside the band
    if is_header:
        content_y0 = 6.0
        content_y1 = band_h - (10.0 if has_divider else 6.0)
    else:
        content_y0 = ph - band_h + (8.0 if has_divider else 5.0)
        content_y1 = ph - 5.0

    avail_h = max(14.0, content_y1 - content_y0)
    inner_w = pw - 2.0 * margin_x

    # 4. Handle Header Center Logo (if provided)
    logo_path = opts.get("logo_path") if is_header else None
    has_logo = bool(logo_path and os.path.isfile(logo_path))
    logo_rect: Optional[fitz.Rect] = None

    if has_logo:
        requested_logo_h = float(opts.get("logo_size") or 52.0)
        max_logo_h = max(18.0, min(requested_logo_h, avail_h))
        max_logo_w = inner_w * 0.26
        try:
            with Image.open(logo_path) as im:
                iw, ih = im.size
            aspect = (iw / ih) if ih > 0 else 1.0
        except Exception:
            aspect = 1.0

        draw_h = max_logo_h
        draw_w = draw_h * aspect
        if draw_w > max_logo_w:
            draw_w = max_logo_w
            draw_h = draw_w / max(aspect, 0.05)

        cx = pw / 2.0
        cy = (content_y0 + content_y1) / 2.0
        logo_rect = fitz.Rect(cx - draw_w / 2.0, cy - draw_h / 2.0, cx + draw_w / 2.0, cy + draw_h / 2.0)
        try:
            page.insert_image(logo_rect, filename=logo_path, keep_proportion=True)
        except Exception:
            has_logo = False
            logo_rect = None

    # 5. Collect Left, Center, Right texts (plus Footer Auto-Numbering)
    r_lines = _collect_lines(opts, "right", page_num, total_pages)
    l_lines = _collect_lines(opts, "left", page_num, total_pages)
    c_raw = _expand_placeholders(opts.get("center_text") or "", page_num, total_pages).strip()
    c_lines = [s.strip() for s in c_raw.splitlines() if s.strip()] if c_raw else []

    if not is_header and opts.get("numbering_enabled"):
        num_label = _format_page_number_label(page_num, total_pages, opts)
        if num_label:
            num_pos = opts.get("numbering_position") or "center"
            if num_pos == "right":
                r_lines = r_lines + [num_label] if r_lines else [num_label]
            elif num_pos == "left":
                l_lines = l_lines + [num_label] if l_lines else [num_label]
            else:
                c_lines = [num_label] if not c_lines else c_lines + [num_label]

    # 6. Compute column horizontal bounds
    if has_logo and logo_rect is not None:
        gap = 12.0
        left_x0, left_x1 = margin_x, max(margin_x + 40.0, logo_rect.x0 - gap)
        right_x0, right_x1 = min(pw - margin_x - 40.0, logo_rect.x1 + gap), pw - margin_x
        center_x0, center_x1 = logo_rect.x0, logo_rect.x1
    else:
        col_w = inner_w / 3.0
        left_x0, left_x1 = margin_x, margin_x + col_w
        center_x0, center_x1 = margin_x + col_w, margin_x + 2.0 * col_w
        right_x0, right_x1 = margin_x + 2.0 * col_w, pw - margin_x

    # Side alignment: "center" matches classic 2-line academic headers (each side centered in its column)
    side_align = opts.get("side_align") or ("center" if is_header else "edge")
    left_align = "center" if side_align == "center" else "left"
    right_align = "center" if side_align == "center" else "right"

    def _vertical_box(x0: float, x1: float, num_lines: int) -> fitz.Rect:
        est_h = min(avail_h, max(font_size * 1.55 * num_lines + 4.0, font_size * 1.8))
        top_y = content_y0 + max(0.0, (avail_h - est_h) / 2.0)
        return fitz.Rect(x0, top_y, x1, min(content_y1, top_y + est_h + 2.0))

    if l_lines:
        l_rect = _vertical_box(left_x0, left_x1, len(l_lines))
        insert_styled_html(page, l_rect, _render_lines_html(l_lines, left_align, text_color, font_size, is_bold))

    if r_lines:
        r_rect = _vertical_box(right_x0, right_x1, len(r_lines))
        insert_styled_html(page, r_rect, _render_lines_html(r_lines, right_align, text_color, font_size, is_bold))

    if c_lines and not has_logo:
        c_rect = _vertical_box(center_x0, center_x1, len(c_lines))
        c_bold = True if is_header else bool(opts.get("bold", False))
        insert_styled_html(page, c_rect, _render_lines_html(c_lines, "center", text_color, font_size, c_bold))

    return True


# ============================================================
# Cover Page (First Page) Builder
# ============================================================

def _draw_cover_page(page: fitz.Page, cover_opts: Dict[str, Any]) -> None:
    """Draw a fully customizable academic cover page matching the classic university layout."""
    pw = page.rect.width
    ph = page.rect.height

    bg_rgb = hex_to_rgb_float(cover_opts.get("bg_color") or "#ffffff")
    page.draw_rect(page.rect, color=None, fill=bg_rgb)

    # 1. Optional Page Border
    border_margin = 24.0
    if cover_opts.get("border_enabled", True):
        border_rgb = hex_to_rgb_float(cover_opts.get("border_color") or "#475569")
        border_w = max(0.5, min(6.0, float(cover_opts.get("border_width") or 1.2)))
        border_rect = fitz.Rect(border_margin, border_margin, pw - border_margin, ph - border_margin)
        page.draw_rect(border_rect, color=border_rgb, fill=None, width=border_w)

    inner_margin = border_margin + 24.0
    top_y = border_margin + 28.0

    # 2. Cover Logo (Top-Left by default, or Top-Center / Top-Right)
    logo_path = cover_opts.get("logo_path")
    has_logo = bool(logo_path and os.path.isfile(logo_path))
    logo_pos = cover_opts.get("logo_position") or "left"
    logo_size = max(40.0, min(200.0, float(cover_opts.get("logo_size") or 96.0)))
    logo_rect: Optional[fitz.Rect] = None

    if has_logo:
        try:
            with Image.open(logo_path) as im:
                iw, ih = im.size
            aspect = (iw / ih) if ih > 0 else 1.0
        except Exception:
            aspect = 1.0

        draw_h = logo_size
        draw_w = min(pw * 0.35, draw_h * aspect)
        draw_h = draw_w / max(aspect, 0.05)

        if logo_pos == "center":
            lx0 = (pw - draw_w) / 2.0
        elif logo_pos == "right":
            lx0 = pw - inner_margin - draw_w
        else:  # left (default matching reference image)
            lx0 = inner_margin + 8.0

        logo_rect = fitz.Rect(lx0, top_y, lx0 + draw_w, top_y + draw_h)
        try:
            page.insert_image(logo_rect, filename=logo_path, keep_proportion=True)
        except Exception:
            has_logo = False
            logo_rect = None

    # 3. Top University / Department Info Lines
    top_lines = [
        (cover_opts.get("top_line1") or "").strip(),
        (cover_opts.get("top_line2") or "").strip(),
        (cover_opts.get("top_line3") or "").strip(),
    ]
    top_lines = [s for s in top_lines if s]

    if top_lines:
        top_font = max(9.0, min(24.0, float(cover_opts.get("top_font_size") or 13.0)))
        top_color = cover_opts.get("top_color") or "#000000"
        est_h = max(top_font * 1.65 * len(top_lines) + 8.0, 48.0)

        if has_logo and logo_rect is not None and logo_pos == "left":
            tx0 = max(logo_rect.x1 + 18.0, pw * 0.44)
            tx1 = pw - inner_margin
            ty0 = top_y + max(0.0, (logo_rect.height - est_h) / 2.0)
        elif has_logo and logo_rect is not None and logo_pos == "right":
            tx0 = inner_margin
            tx1 = min(logo_rect.x0 - 18.0, pw * 0.56)
            ty0 = top_y + max(0.0, (logo_rect.height - est_h) / 2.0)
        elif has_logo and logo_rect is not None and logo_pos == "center":
            tx0 = inner_margin
            tx1 = pw - inner_margin
            ty0 = logo_rect.y1 + 16.0
        else:
            tx0 = pw * 0.44
            tx1 = pw - inner_margin
            ty0 = top_y + 10.0

        t_rect = fitz.Rect(tx0, ty0, tx1, min(ph - 100.0, ty0 + est_h + 10.0))
        insert_styled_html(page, t_rect, _render_lines_html(top_lines, "center", top_color, top_font, bold=True))

    # 4. Main Book / Course Title & Optional Subtitle
    title_raw = (cover_opts.get("title") or "").strip()
    subtitle_raw = (cover_opts.get("subtitle") or "").strip()
    title_y_pct = max(20.0, min(70.0, float(cover_opts.get("title_y_pct") or 42.0)))
    title_y = ph * (title_y_pct / 100.0)

    if title_raw:
        title_font = max(14.0, min(56.0, float(cover_opts.get("title_font_size") or 30.0)))
        title_color = cover_opts.get("title_color") or "#000000"
        title_lines = [s.strip() for s in title_raw.splitlines() if s.strip()]
        t_box_h = max(title_font * 1.6 * len(title_lines) + 12.0, 52.0)
        title_rect = fitz.Rect(inner_margin, title_y, pw - inner_margin, min(ph - 80.0, title_y + t_box_h))
        insert_styled_html(page, title_rect, _render_lines_html(title_lines, "center", title_color, title_font, bold=True))
        sub_top = title_rect.y1 + 10.0
    else:
        sub_top = title_y

    if subtitle_raw:
        sub_font = max(10.0, min(32.0, float(cover_opts.get("subtitle_font_size") or 16.0)))
        sub_color = cover_opts.get("subtitle_color") or "#334155"
        sub_lines = [s.strip() for s in subtitle_raw.splitlines() if s.strip()]
        s_box_h = max(sub_font * 1.6 * len(sub_lines) + 8.0, 34.0)
        sub_rect = fitz.Rect(inner_margin, sub_top, pw - inner_margin, min(ph - 60.0, sub_top + s_box_h))
        insert_styled_html(page, sub_rect, _render_lines_html(sub_lines, "center", sub_color, sub_font, bold=False))

    # 5. Lecturer Name & Extra Bottom Info
    lecturer_raw = (cover_opts.get("lecturer_name") or "").strip()
    extra_raw = (cover_opts.get("extra_info") or "").strip()
    lec_y_pct = max(50.0, min(90.0, float(cover_opts.get("lecturer_y_pct") or 78.0)))
    lec_y = ph * (lec_y_pct / 100.0)

    if lecturer_raw:
        lec_font = max(11.0, min(36.0, float(cover_opts.get("lecturer_font_size") or 18.0)))
        lec_color = cover_opts.get("lecturer_color") or "#000000"
        lec_lines = [s.strip() for s in lecturer_raw.splitlines() if s.strip()]
        l_box_h = max(lec_font * 1.6 * len(lec_lines) + 8.0, 36.0)
        lec_rect = fitz.Rect(inner_margin, lec_y, pw - inner_margin, min(ph - border_margin - 12.0, lec_y + l_box_h))
        insert_styled_html(page, lec_rect, _render_lines_html(lec_lines, "center", lec_color, lec_font, bold=True))
        extra_top = lec_rect.y1 + 8.0
    else:
        extra_top = lec_y

    if extra_raw:
        ex_font = max(9.0, min(24.0, float(cover_opts.get("extra_font_size") or 13.0)))
        ex_color = cover_opts.get("extra_color") or "#334155"
        ex_lines = [s.strip() for s in extra_raw.splitlines() if s.strip()]
        e_box_h = max(ex_font * 1.55 * len(ex_lines) + 8.0, 30.0)
        ex_rect = fitz.Rect(inner_margin, extra_top, pw - inner_margin, min(ph - border_margin - 8.0, extra_top + e_box_h))
        insert_styled_html(page, ex_rect, _render_lines_html(ex_lines, "center", ex_color, ex_font, bold=False))


A4_PORTRAIT_W = 595.28
A4_PORTRAIT_H = 841.89


def _resolve_cover_dimensions(cover_opts: Dict[str, Any], src_w: float, src_h: float) -> Tuple[float, float]:
    """Return Portrait A4 (595.28 x 841.89 pt) by default, or match source PDF if explicitly requested."""
    size_mode = (cover_opts.get("page_size") or "a4_portrait").lower()
    if size_mode == "match_pdf" and src_w > 0 and src_h > 0:
        return src_w, src_h
    return A4_PORTRAIT_W, A4_PORTRAIT_H


def render_cover_preview(pdf_path: str, options: Dict[str, Any], dpi: int = 135) -> bytes:
    """Render a live PNG preview of the custom first/cover page (Portrait A4 by default)."""
    src_w, src_h = A4_PORTRAIT_W, A4_PORTRAIT_H
    if pdf_path and os.path.isfile(pdf_path):
        src = fitz.open(pdf_path)
        try:
            if len(src) > 0:
                src_w, src_h = src[0].rect.width, src[0].rect.height
        finally:
            src.close()

    cover_opts = options.get("cover_page") or {}
    pw, ph = _resolve_cover_dimensions(cover_opts, src_w, src_h)

    doc = fitz.open()
    try:
        page = doc.new_page(width=pw, height=ph)
        _draw_cover_page(page, cover_opts)
        return page.get_pixmap(dpi=dpi).tobytes("png")
    finally:
        doc.close()


# ============================================================
# Public Entry Points: Render Preview & Process Full PDF
# ============================================================

def render_page_png(pdf_path: str, page_number: int, dpi: int = 135) -> bytes:
    doc = fitz.open(pdf_path)
    try:
        idx = max(0, min(len(doc) - 1, page_number - 1))
        pix = doc[idx].get_pixmap(dpi=dpi)
        return pix.tobytes("png")
    finally:
        doc.close()


def render_edited_page_preview(pdf_path: str, page_number: int, options: Dict[str, Any], dpi: int = 135) -> bytes:
    """Apply all selected edits to a single page in memory and return PNG bytes."""
    cover_opts = options.get("cover_page") or {}
    if page_number == 0 or (cover_opts.get("enabled") and cover_opts.get("mode") == "replace" and page_number == 1):
        return render_cover_preview(pdf_path, options, dpi=dpi)

    doc = fitz.open(pdf_path)
    try:
        total_pages = len(doc)
        idx = max(0, min(total_pages - 1, page_number - 1))
        page = doc[idx]
        page_num = idx + 1

        wm_opts = options.get("watermark") or {}
        if wm_opts.get("enabled") and wm_opts.get("remove_annotations", True):
            _disable_watermark_ocgs(doc)

        cleared_xobjs: set = set()
        _remove_watermarks_from_page(doc, page, wm_opts, cleared_xobjs)
        _apply_text_replacements_on_page(page, options.get("text_replacements") or {})

        header_opts = dict(options.get("header") or {})
        footer_opts = dict(options.get("footer") or {})

        will_draw_header = bool(header_opts.get("enabled")) and _page_in_range(page_num, total_pages, header_opts)
        if header_opts.get("smart_clean_old"):
            _smart_clean_old_lecture_header(page, page_num, header_opts, will_draw_new_header=will_draw_header)

        _apply_band(page, page_num, total_pages, header_opts, is_header=True)
        _apply_band(page, page_num, total_pages, footer_opts, is_header=False)

        pix = page.get_pixmap(dpi=dpi)
        return pix.tobytes("png")
    finally:
        doc.close()


def process_full_pdf(input_path: str, output_path: str, options: Dict[str, Any]) -> Dict[str, int]:
    """Process every page of the PDF, optionally adding/replacing the Cover Page, and save."""
    doc = fitz.open(input_path)
    try:
        orig_total = len(doc)
        pw = doc[0].rect.width if orig_total > 0 else 595.0
        ph = doc[0].rect.height if orig_total > 0 else 842.0

        wm_opts = options.get("watermark") or {}
        rep_opts = options.get("text_replacements") or {}
        header_opts = dict(options.get("header") or {})
        footer_opts = dict(options.get("footer") or {})
        cover_opts = options.get("cover_page") or {}
        cover_enabled = bool(cover_opts.get("enabled"))
        cover_mode = cover_opts.get("mode") or "insert"

        stats = {
            "pages_processed": orig_total + (1 if (cover_enabled and cover_mode == "insert") else 0),
            "headers_updated": 0,
            "footers_updated": 0,
            "text_replacements": 0,
            "watermarks_removed": 0,
            "cover_added": 1 if cover_enabled else 0,
        }

        if wm_opts.get("enabled") and wm_opts.get("remove_annotations", True):
            stats["watermarks_removed"] += _disable_watermark_ocgs(doc)

        cleared_xobjs: set = set()
        start_idx = 1 if (cover_enabled and cover_mode == "replace" and orig_total >= 1) else 0

        for idx in range(start_idx, orig_total):
            page = doc[idx]
            page_num = idx + 1

            # 1. Remove watermarks first
            stats["watermarks_removed"] += _remove_watermarks_from_page(doc, page, wm_opts, cleared_xobjs)

            # 2. Replace lecturer name & custom text
            stats["text_replacements"] += _apply_text_replacements_on_page(page, rep_opts)

            # 3. Smartly clean old lecture header / metadata banner up to first definition
            will_draw_header = bool(header_opts.get("enabled")) and _page_in_range(page_num, orig_total, header_opts)
            if header_opts.get("smart_clean_old"):
                _smart_clean_old_lecture_header(page, page_num, header_opts, will_draw_new_header=will_draw_header)

            # 4. Apply new header & footer (strictly respecting skip_first_page & page range)
            if _apply_band(page, page_num, orig_total, header_opts, is_header=True):
                stats["headers_updated"] += 1
            if _apply_band(page, page_num, orig_total, footer_opts, is_header=False):
                stats["footers_updated"] += 1

        # Apply Cover Page cleanly at Page 1 (Portrait A4 by default)
        if cover_enabled:
            if cover_mode == "replace" and orig_total >= 1:
                doc.delete_page(0)
            cover_w, cover_h = _resolve_cover_dimensions(cover_opts, pw, ph)
            cover_page = doc.new_page(pno=0, width=cover_w, height=cover_h)
            _draw_cover_page(cover_page, cover_opts)

        doc.save(output_path, garbage=4, deflate=True, clean=True)
        return stats
    finally:
        doc.close()
