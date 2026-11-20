// Pure Browser PDF Processing Engine (pdf.js + pdf-lib + High-DPI Arabic Canvas)
// Works 100% client-side on ANY web host (HTML/PHP/cPanel/WordPress) with ZERO Python!

(function (global) {
  "use strict";

  const A4_PORTRAIT_W = 595.28;
  const A4_PORTRAIT_H = 841.89;
  const CANVAS_SCALE = 3.2; // Crisp ~230 DPI for Arabic text in PDFs

  const ARABIC_RE = /[\u0600-\u06FF\uFB50-\uFEFF]/;
  const ARABIC_DIACRITICS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
  const ARABIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

  const OLD_HEADER_AR_KEYWORDS = [
    "جامعة", "كلية", "كليه", "قسم", "وزارة التعليم", "المرحلة", "المرحله",
    "الدراسة", "الصباحية", "المسائية", "رقم المحاضرة", "رقم المحاضره",
    "من اصل", "من أصل", "محاضرة رقم", "المحاضرة رقم", "المحاضره رقم",
    "العام الدراسي", "الفصل الدراسي", "السنة الدراسية", "اعداد", "إعداد",
    "التدريسي", "المدرس", "الاستاذ", "الأستاذ", "المحاضر", "أ.د", "ا.د",
    "م.د", "م.م", "أ.م.د", "ا.م.د", "اسم المادة", "المادة:", "المادة :",
    "التاريخ", "مذكرة", "ملزمة", "فرع "
  ];

  const OLD_HEADER_EN_KEYWORDS = [
    "university", "college", "department", "dept.", "faculty", "ministry",
    "lecture no", "lecture :", "lecture:", "lec.", "lec ", "academic year",
    "semester", "prepared by", "lecturer", "instructor", "prof.", "asst.",
    "subject:", "course:", "stage:", "date:"
  ];

  const DEFINITION_KEYWORDS = [
    "تعريف", "عبارة عن", "عباره عن", "يعرف", "تُعرف", "تعرف", "يقصد ب",
    "definition", "is defined as", "refers to", "introduction", "مقدمة", "مقدمه"
  ];

  const NUMERIC_HEADER_ONLY_RE =
    /^[\s\d٠-٩/\-–—:.()of]+$|^محاضره?\s*[\d٠-٩]+|^المحاضره?\s*[\d٠-٩]+|^lecture\s*\d+/i;

  // ============================================================
  // Text & Color Utilities
  // ============================================================

  function hasArabic(text) {
    return ARABIC_RE.test(text || "");
  }

  function toArabicDigits(str) {
    return String(str).replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)]);
  }

  function normalizeArabic(text, fuzzy = true) {
    if (!text) return "";
    let s = String(text).normalize("NFKC");
    if (fuzzy) {
      s = s.replace(ARABIC_DIACRITICS_RE, "");
      s = s.replace(/\u0640/g, "");
      s = s.replace(/[أإآٱ]/g, "ا");
      s = s.replace(/ة/g, "ه");
      s = s.replace(/[ىئ]/g, "ي");
      s = s.replace(/ؤ/g, "و");
    }
    return s.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function reverseStr(s) {
    return Array.from(s).reverse().join("");
  }

  function hexToRgb01(hex) {
    let h = (hex || "#ffffff").replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6) return { r: 1, g: 1, b: 1 };
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
    };
  }

  function expandPlaceholders(text, pageNum, totalPages) {
    if (!text) return "";
    return String(text)
      .replace(/\{page\}/g, String(pageNum))
      .replace(/\{total\}/g, String(totalPages));
  }

  function pageInRange(pageNum, totalPages, opts) {
    if (!opts || !opts.enabled) return false;
    if (opts.skip_first_page && pageNum === 1) return false;
    const startP = Number(opts.start_page) || 1;
    const endP = opts.end_page ? Number(opts.end_page) : totalPages;
    return pageNum >= startP && pageNum <= endP;
  }

  function formatFooterNumber(pageNum, totalPages, opts) {
    if (!opts || !opts.numbering_enabled) return "";
    const startP = Number(opts.start_page) || 1;
    const firstNumPage = opts.skip_first_page && startP < 2 ? 2 : startP;
    const startNum = Number(opts.numbering_start) || 1;
    const displayPage = Math.max(1, pageNum - firstNumPage + startNum);
    const endP = opts.end_page ? Number(opts.end_page) : totalPages;
    const displayTotal = Math.max(displayPage, endP - firstNumPage + startNum);

    const fmt = opts.numbering_format || "number_only";
    let out = `${displayPage}`;
    if (fmt === "dash_number") out = `- ${displayPage} -`;
    else if (fmt === "slash") out = `${displayPage} / ${displayTotal}`;
    else if (fmt === "page_of_total_ar") out = `صفحة ${displayPage} من ${displayTotal}`;
    else if (fmt === "page_of_total_en") out = `Page ${displayPage} of ${displayTotal}`;

    if (opts.numbering_arabic_digits) out = toArabicDigits(out);
    return out;
  }

  function isDefinitionOrBodyLine(text) {
    const norm = normalizeArabic(text, true);
    if (!norm) return false;
    for (const kw of DEFINITION_KEYWORDS) {
      if (norm.includes(normalizeArabic(kw, true))) return true;
    }
    return norm.length >= 72;
  }

  function isOldLectureHeaderLine(text) {
    const norm = normalizeArabic(text, true);
    if (!norm || norm.length < 2) return false;
    if (isDefinitionOrBodyLine(text)) return false;

    const cands = [norm];
    if (hasArabic(text)) cands.push(reverseStr(norm));

    for (const cand of cands) {
      for (const kw of OLD_HEADER_AR_KEYWORDS) {
        if (cand.includes(normalizeArabic(kw, true))) return true;
      }
      for (const kw of OLD_HEADER_EN_KEYWORDS) {
        if (cand.includes(kw)) return true;
      }
      if (NUMERIC_HEADER_ONLY_RE.test(cand)) return true;
      if ((cand.includes("محاضره") || cand.includes("محاضرات")) && cand.length <= 55) return true;
    }
    return false;
  }

  async function loadImageElement(dataUrl) {
    if (!dataUrl) return null;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error("Canvas export failed"));
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      }, "image/png");
    });
  }

  function drawBiDiLines(ctx, lines, boxX, boxY, boxW, boxH, align, fontSize, color, bold) {
    if (!lines || !lines.length) return;
    const fontFamily = '"Cairo", "Segoe UI", Tahoma, Arial, sans-serif';
    ctx.font = `${bold ? "700" : "400"} ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";

    const lineH = fontSize * 1.48;
    const totalH = lineH * lines.length;
    let startY = boxY + (boxH - totalH) / 2 + lineH / 2;

    for (const line of lines) {
      const rtl = hasArabic(line);
      ctx.direction = rtl ? "rtl" : "ltr";
      let drawX;
      if (align === "center") {
        ctx.textAlign = "center";
        drawX = boxX + boxW / 2;
      } else if (align === "right") {
        ctx.textAlign = "right";
        drawX = boxX + boxW;
      } else {
        ctx.textAlign = "left";
        drawX = boxX;
      }
      ctx.fillText(line, drawX, startY, boxW);
      startY += lineH;
    }
  }

  // ============================================================
  // Group pdf.js text items into logical visual lines
  // ============================================================

  async function extractPageLines(pdfJsPage) {
    const viewport = pdfJsPage.getViewport({ scale: 1.0 });
    const pw = viewport.width;
    const ph = viewport.height;
    const tc = await pdfJsPage.getTextContent();

    const rawItems = [];
    for (const item of tc.items || []) {
      if (!item.str || !item.str.trim()) continue;
      const t = item.transform; // [a, b, c, d, tx, ty] in PDF bottom-left coords
      const scaleX = Math.hypot(t[0], t[1]);
      const scaleY = Math.hypot(t[2], t[3]);
      const fontSize = Math.max(6, scaleY || scaleX || item.height || 11);
      const isRotated =
        (scaleX > 0 && Math.abs(t[1]) / scaleX > 0.15) ||
        (scaleY > 0 && Math.abs(t[2]) / scaleY > 0.15);

      const x0 = t[4];
      const w = Math.max(item.width || fontSize * item.str.length * 0.45, 4);
      const yBottomPdf = t[5];
      // Convert to top-down coordinates (y0 = distance from top)
      const yTop = ph - (yBottomPdf + fontSize * 0.9);
      const yBottom = ph - (yBottomPdf - fontSize * 0.25);

      rawItems.push({
        str: item.str,
        x0,
        x1: x0 + w,
        y0: yTop,
        y1: yBottom,
        yPdf: yBottomPdf,
        fontSize,
        isRotated,
      });
    }

    // Group horizontal items into lines by similar y0
    const lines = [];
    const horiz = rawItems.filter((it) => !it.isRotated).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

    for (const it of horiz) {
      let placed = false;
      for (const ln of lines) {
        if (Math.abs(ln.y0 - it.y0) <= Math.max(4.5, it.fontSize * 0.45)) {
          ln.items.push(it);
          ln.x0 = Math.min(ln.x0, it.x0);
          ln.x1 = Math.max(ln.x1, it.x1);
          ln.y0 = Math.min(ln.y0, it.y0);
          ln.y1 = Math.max(ln.y1, it.y1);
          ln.fontSize = Math.max(ln.fontSize, it.fontSize);
          placed = true;
          break;
        }
      }
      if (!placed) {
        lines.push({
          items: [it],
          x0: it.x0,
          x1: it.x1,
          y0: it.y0,
          y1: it.y1,
          fontSize: it.fontSize,
        });
      }
    }

    for (const ln of lines) {
      // Determine visual join order: RTL Arabic items in pdf.js can appear right-to-left or left-to-right
      const ltrSorted = [...ln.items].sort((a, b) => a.x0 - b.x0);
      const rtlSorted = [...ln.items].sort((a, b) => b.x0 - a.x0);
      const ltrText = ltrSorted.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
      const rtlText = rtlSorted.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
      ln.text = hasArabic(ltrText) ? rtlText : ltrText;
      ln.altText = ltrText;
    }

    lines.sort((a, b) => a.y0 - b.y0);
    return {
      width: pw,
      height: ph,
      lines,
      rotatedItems: rawItems.filter((it) => it.isRotated),
    };
  }

  // ============================================================
  // Analyze Uploaded PDF
  // ============================================================

  async function analyzePdf(pdfBytes) {
    const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
    const pdfJsDoc = await loadingTask.promise;
    const pageCount = pdfJsDoc.numPages;

    const pageSizes = [];
    const headerCounts = new Map();
    const footerCounts = new Map();
    const wmTextCounts = new Map();
    let diagonalCount = 0;

    // Collect sizes for all pages
    for (let p = 1; p <= pageCount; p++) {
      const page = await pdfJsDoc.getPage(p);
      const vp = page.getViewport({ scale: 1.0 });
      pageSizes.push({ width: Math.round(vp.width * 10) / 10, height: Math.round(vp.height * 10) / 10 });
    }

    // Sample up to 35 pages for text analysis
    const step = pageCount <= 35 ? 1 : Math.max(1, Math.floor(pageCount / 35));
    const sampled = [];
    for (let p = 1; p <= pageCount; p += step) sampled.push(p);

    for (const p of sampled) {
      const page = await pdfJsDoc.getPage(p);
      const info = await extractPageLines(page);

      for (const rot of info.rotatedItems) {
        diagonalCount += 1;
        const clean = rot.str.normalize("NFKC").trim();
        if (clean.length >= 2) wmTextCounts.set(clean, (wmTextCounts.get(clean) || 0) + 1);
      }

      for (const ln of info.lines) {
        const clean = ln.text.normalize("NFKC").trim();
        if (!clean || clean.length < 2) continue;

        if (ln.fontSize >= 28 && ln.y0 > info.height * 0.2 && ln.y1 < info.height * 0.8) {
          wmTextCounts.set(clean, (wmTextCounts.get(clean) || 0) + 1);
        }
        if (ln.y1 <= info.height * 0.14) {
          const key = pageCount <= 2 ? clean : clean.replace(/\d+/g, "...");
          headerCounts.set(key, (headerCounts.get(key) || 0) + 1);
        } else if (ln.y0 >= info.height * 0.86) {
          const key = pageCount <= 2 ? clean : clean.replace(/\d+/g, "...");
          footerCounts.set(key, (footerCounts.get(key) || 0) + 1);
        }
      }
    }

    // Quick pdf-lib scan for watermark annotations & transparent XObjects
    let annotationCount = 0;
    let xobjectCount = 0;
    try {
      const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pages = pdfDoc.getPages();
      const seenXobjs = new Set();
      for (const pg of pages) {
        const annots = pg.node.Annots();
        if (annots) {
          for (let i = 0; i < annots.size(); i++) {
            const ann = annots.lookup(i);
            if (ann instanceof PDFLib.PDFDict) {
              const st = ann.get(PDFLib.PDFName.of("Subtype"))?.toString() || "";
              if (/Watermark|Stamp/i.test(st)) annotationCount += 1;
            }
          }
        }
        const res = pg.node.Resources();
        const xobjs = res && res.lookupMaybe(PDFLib.PDFName.of("XObject"), PDFLib.PDFDict);
        if (xobjs) {
          for (const [, ref] of xobjs.entries()) {
            const key = ref.toString();
            if (seenXobjs.has(key)) continue;
            const obj = pdfDoc.context.lookup(ref);
            if (obj instanceof PDFLib.PDFStream && isWatermarkFormXObject(pdfDoc, obj)) {
              seenXobjs.add(key);
              xobjectCount += 1;
            }
          }
        }
      }
    } catch (_) {
      // Non-fatal
    }

    const minRep = sampled.length >= 3 ? 2 : 1;
    const topEntry = (map) => {
      let best = "";
      let bestCnt = 0;
      for (const [k, v] of map.entries()) {
        if (v >= minRep && v > bestCnt) {
          best = k;
          bestCnt = v;
        }
      }
      return best;
    };

    const textCandidates = [...wmTextCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);

    return {
      pdfJsDoc,
      pageCount,
      pageSizes,
      analysis: {
        detected_header: topEntry(headerCounts),
        detected_footer: topEntry(footerCounts),
        watermarks: {
          annotation_count: annotationCount,
          diagonal_text_count: diagonalCount,
          transparent_xobject_count: xobjectCount,
          text_candidates: textCandidates,
        },
      },
    };
  }

  // ============================================================
  // Smart Lecturer Text Search
  // ============================================================

  async function searchTextInPdf(pdfJsDoc, query, fuzzyArabic = true) {
    const qClean = (query || "").trim();
    if (!qClean) return { total_matches: 0, pages: [] };
    const qNorm = normalizeArabic(qClean, fuzzyArabic);
    const qRev = reverseStr(qNorm);

    let totalMatches = 0;
    const pages = [];

    for (let p = 1; p <= pdfJsDoc.numPages; p++) {
      const page = await pdfJsDoc.getPage(p);
      const info = await extractPageLines(page);
      let hitsOnPage = 0;

      for (const ln of info.lines) {
        const n1 = normalizeArabic(ln.text, fuzzyArabic);
        const n2 = normalizeArabic(ln.altText, fuzzyArabic);
        if (
          n1.includes(qNorm) ||
          n2.includes(qNorm) ||
          (hasArabic(qClean) && (n1.includes(qRev) || n2.includes(qRev)))
        ) {
          hitsOnPage += 1;
        }
      }

      if (hitsOnPage > 0) {
        totalMatches += hitsOnPage;
        pages.push(p);
      }
    }
    return { total_matches: totalMatches, pages };
  }

  function replaceSubstringFuzzy(original, oldQuery, newText, fuzzyArabic) {
    const working = String(original || "").normalize("NFKC");
    const escaped = oldQuery.trim().normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const directRe = new RegExp(escaped, "gi");
    if (directRe.test(working)) {
      return working.replace(directRe, newText);
    }

    if (fuzzyArabic) {
      const qNorm = normalizeArabic(oldQuery, true);
      let pat = "";
      for (const ch of qNorm) {
        if (ch === " ") pat += "\\s+";
        else if (ch === "ا") pat += "[اأإآٱ][\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u0640]*";
        else if (ch === "ه") pat += "[هة][\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u0640]*";
        else if (ch === "ي") pat += "[يىئ][\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u0640]*";
        else if (ch === "و") pat += "[وؤ][\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u0640]*";
        else pat += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u0640]*";
      }
      const fuzzyRe = new RegExp(pat, "gi");
      if (fuzzyRe.test(working)) {
        return working.replace(fuzzyRe, newText);
      }
    }
    return newText;
  }

  // ============================================================
  // Smart Old Lecture Header Cutoff Detection
  // ============================================================

  function detectSmartHeaderCutY(pageInfo, pageNum, headerOpts) {
    if (!headerOpts || !headerOpts.smart_clean_old) return 0;
    const ph = pageInfo.height;
    const topLines = pageInfo.lines.filter((ln) => ln.y0 <= ph * 0.52);
    if (!topLines.length) return 0;

    const startFrom = (headerOpts.start_from_text || "").trim();

    // 1. User-specified start phrase on Page 1
    if (pageNum === 1 && startFrom) {
      const qNorm = normalizeArabic(startFrom, true);
      const qRev = reverseStr(qNorm);
      for (const ln of topLines) {
        const n1 = normalizeArabic(ln.text, true);
        const n2 = normalizeArabic(ln.altText, true);
        if (n1.includes(qNorm) || n2.includes(qNorm) || (hasArabic(startFrom) && (n1.includes(qRev) || n2.includes(qRev)))) {
          return ln.y0 > 8 ? ln.y0 - 3 : 0;
        }
      }
    }

    // 2. Automatic smart detection of old lecture header up to first definition/topic
    const maxScanY = ph * (pageNum === 1 ? 0.42 : 0.22);
    let lastOldY1 = 0;
    let firstContentY0 = ph * 0.52;

    for (const ln of topLines) {
      if (ln.y0 > maxScanY) break;
      if (isOldLectureHeaderLine(ln.text) || isOldLectureHeaderLine(ln.altText)) {
        lastOldY1 = Math.max(lastOldY1, ln.y1);
      } else {
        firstContentY0 = ln.y0;
        break;
      }
    }

    if (lastOldY1 <= 0) return 0;
    // Include any horizontal divider rule right underneath the old header banner while staying strictly above the first definition!
    return Math.min(lastOldY1 + 14, firstContentY0 - 3);
  }

  // ============================================================
  // Pure-JS PDF Watermark Stripping (pdf-lib low-level stream cleaning)
  // ============================================================

  function isWatermarkFormXObject(pdfDoc, streamObj) {
    try {
      const dict = streamObj.dict;
      const subtype = dict.get(PDFLib.PDFName.of("Subtype"))?.toString() || "";
      if (subtype !== "/Form") return false;
      const dictText = dict.toString().toLowerCase();
      if (dictText.includes("watermark") || dictText.includes("adbe_compoundtype")) return true;

      // Check ExtGState opacity <= 0.65
      const res = dict.lookupMaybe(PDFLib.PDFName.of("Resources"), PDFLib.PDFDict);
      const extGs = res && res.lookupMaybe(PDFLib.PDFName.of("ExtGState"), PDFLib.PDFDict);
      if (extGs) {
        for (const [, ref] of extGs.entries()) {
          const gs = pdfDoc.context.lookup(ref);
          if (gs instanceof PDFLib.PDFDict) {
            const ca = gs.get(PDFLib.PDFName.of("ca"));
            const CA = gs.get(PDFLib.PDFName.of("CA"));
            const v1 = ca ? parseFloat(ca.toString()) : 1;
            const v2 = CA ? parseFloat(CA.toString()) : 1;
            if ((v1 > 0 && v1 <= 0.65) || (v2 > 0 && v2 <= 0.65)) return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  function matMul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[1] * m2[2],
      m1[0] * m2[1] + m1[1] * m2[3],
      m1[2] * m2[0] + m1[3] * m2[2],
      m1[2] * m2[1] + m1[3] * m2[3],
    ];
  }

  function stripDiagonalAndArtifactFromStream(streamStr, removeArtifacts, removeDiagonal) {
    let s = streamStr;
    let removed = 0;

    if (removeArtifacts) {
      const artRe = /\/Artifact\s*<<[^>]*?\/Subtype\s*\/Watermark[^>]*?>>\s*BDC[\s\S]*?EMC/g;
      s = s.replace(artRe, () => {
        removed += 1;
        return "";
      });
    }

    if (removeDiagonal) {
      const NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)";
      const eventRe = new RegExp(
        `(?<bt>(?<![A-Za-z0-9_])BT(?=[\\s/<\\[(\\r\\n])[\\s\\S]*?(?<![A-Za-z0-9_])ET(?![A-Za-z0-9_]))` +
          `|(?<cm>${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+cm(?![A-Za-z0-9_]))` +
          `|(?<rg>${NUM}\\s+${NUM}\\s+${NUM}\\s+rg(?![A-Za-z0-9_]))` +
          `|(?<gray>${NUM}\\s+g(?![A-Za-z0-9_]))` +
          `|(?<q_push>(?<![A-Za-z0-9_])q(?![A-Za-z0-9_]))` +
          `|(?<q_pop>(?<![A-Za-z0-9_])Q(?![A-Za-z0-9_]))`,
        "g"
      );
      const tmRe = new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+Tm(?![A-Za-z0-9_])`, "g");
      const tfRe = new RegExp(`/\\S+\\s+(${NUM})\\s+Tf(?![A-Za-z0-9_])`, "g");
      const rgRe = new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+rg(?![A-Za-z0-9_])`, "g");
      const gRe = new RegExp(`(${NUM})\\s+g(?![A-Za-z0-9_])`, "g");

      const stack = [{ ctm: [1, 0, 0, 1], light: false }];
      let out = "";
      let lastIdx = 0;
      let m;

      while ((m = eventRe.exec(s)) !== null) {
        const g = m.groups;
        if (g.q_push) {
          const top = stack[stack.length - 1];
          stack.push({ ctm: [...top.ctm], light: top.light });
        } else if (g.q_pop) {
          if (stack.length > 1) stack.pop();
        } else if (g.cm) {
          const nums = g.cm.trim().split(/\s+/).slice(0, 4).map(Number);
          const top = stack[stack.length - 1];
          top.ctm = matMul(nums, top.ctm);
        } else if (g.rg) {
          const nums = g.rg.trim().split(/\s+/).slice(0, 3).map(Number);
          stack[stack.length - 1].light = (nums[0] + nums[1] + nums[2]) / 3 >= 0.68;
        } else if (g.gray) {
          const val = parseFloat(g.gray);
          stack[stack.length - 1].light = val >= 0.68;
        } else if (g.bt) {
          const body = g.bt;
          const top = stack[stack.length - 1];
          let localLight = top.light;

          let cm;
          rgRe.lastIndex = 0;
          while ((cm = rgRe.exec(body)) !== null) {
            localLight = (parseFloat(cm[1]) + parseFloat(cm[2]) + parseFloat(cm[3])) / 3 >= 0.68;
          }
          gRe.lastIndex = 0;
          while ((cm = gRe.exec(body)) !== null) {
            localLight = parseFloat(cm[1]) >= 0.68;
          }

          let maxTf = 12;
          tfRe.lastIndex = 0;
          while ((cm = tfRe.exec(body)) !== null) {
            maxTf = Math.max(maxTf, Math.abs(parseFloat(cm[1])));
          }

          const matrices = [];
          tmRe.lastIndex = 0;
          while ((cm = tmRe.exec(body)) !== null) {
            matrices.push(matMul([+cm[1], +cm[2], +cm[3], +cm[4]], top.ctm));
          }
          if (!matrices.length) matrices.push(top.ctm);

          let strip = false;
          for (const [a, b, c, d] of matrices) {
            const scale = Math.max(Math.hypot(a, b), Math.hypot(c, d), 1e-6);
            const effSize = maxTf * scale;
            if (Math.abs(b) / scale > 0.15 || Math.abs(c) / scale > 0.15) {
              const isExact90 = Math.abs(a) / scale < 0.05 && Math.abs(d) / scale < 0.05;
              if (!isExact90 || effSize >= 22 || localLight) {
                strip = true;
                break;
              }
            }
            if (effSize >= 28 && localLight) {
              strip = true;
              break;
            }
          }

          if (strip) {
            out += s.slice(lastIdx, m.index);
            lastIdx = m.index + m[0].length;
            removed += 1;
          }
        }
      }

      if (lastIdx > 0) {
        out += s.slice(lastIdx);
        s = out;
      }
    }

    return { text: s, removed };
  }

  function cleanWatermarksOnPage(pdfDoc, page, wmOpts, clearedXobjs) {
    if (!wmOpts || !wmOpts.enabled) return 0;
    let removedCount = 0;

    // 1. Remove Watermark / Stamp annotations
    if (wmOpts.remove_annotations) {
      try {
        const annots = page.node.Annots();
        if (annots) {
          for (let i = annots.size() - 1; i >= 0; i--) {
            const ann = annots.lookup(i);
            if (ann instanceof PDFLib.PDFDict) {
              const st = ann.get(PDFLib.PDFName.of("Subtype"))?.toString() || "";
              if (/Watermark|Stamp/i.test(st)) {
                annots.remove(i);
                removedCount += 1;
              }
            }
          }
        }
      } catch (_) {}
    }

    // 2. Clear Transparent / Watermark Form XObjects
    if (wmOpts.remove_xobjects) {
      try {
        const res = page.node.Resources();
        const xobjs = res && res.lookupMaybe(PDFLib.PDFName.of("XObject"), PDFLib.PDFDict);
        if (xobjs) {
          for (const [, ref] of xobjs.entries()) {
            const key = ref.toString();
            if (clearedXobjs.has(key)) continue;
            const obj = pdfDoc.context.lookup(ref);
            if (obj instanceof PDFLib.PDFStream && isWatermarkFormXObject(pdfDoc, obj)) {
              const emptyStream = PDFLib.PDFRawStream.of(obj.dict, new Uint8Array(0));
              emptyStream.dict.set(PDFLib.PDFName.of("Length"), PDFLib.PDFNumber.of(0));
              emptyStream.dict.delete(PDFLib.PDFName.of("Filter"));
              pdfDoc.context.assign(ref, emptyStream);
              clearedXobjs.add(key);
              removedCount += 1;
            }
          }
        }
      } catch (_) {}
    }

    // 3. Strip Artifact/Watermark & Diagonal Text from Content Streams
    if (wmOpts.remove_annotations || wmOpts.remove_diagonal_text) {
      try {
        const contentsRef = page.node.get(PDFLib.PDFName.of("Contents"));
        const streamRefs = [];
        if (contentsRef instanceof PDFLib.PDFRef) {
          const resolved = pdfDoc.context.lookup(contentsRef);
          if (resolved instanceof PDFLib.PDFArray) {
            for (let i = 0; i < resolved.size(); i++) streamRefs.push(resolved.get(i));
          } else {
            streamRefs.push(contentsRef);
          }
        } else if (contentsRef instanceof PDFLib.PDFArray) {
          for (let i = 0; i < contentsRef.size(); i++) streamRefs.push(contentsRef.get(i));
        }

        const decoder = new TextDecoder("latin1");
        for (const sRef of streamRefs) {
          const stObj = pdfDoc.context.lookup(sRef);
          if (!(stObj instanceof PDFLib.PDFRawStream)) continue;
          let rawBytes;
          try {
            rawBytes = PDFLib.decodePDFRawStream(stObj).decode();
          } catch (_) {
            continue;
          }
          const str = decoder.decode(rawBytes);
          const { text: cleaned, removed } = stripDiagonalAndArtifactFromStream(
            str,
            !!wmOpts.remove_annotations,
            !!wmOpts.remove_diagonal_text
          );
          if (removed > 0) {
            const outBytes = new Uint8Array(cleaned.length);
            for (let i = 0; i < cleaned.length; i++) outBytes[i] = cleaned.charCodeAt(i) & 0xff;
            const newStream = pdfDoc.context.flateStream(outBytes);
            pdfDoc.context.assign(sRef, newStream);
            removedCount += removed;
          }
        }
      } catch (_) {}
    }

    return removedCount;
  }

  // ============================================================
  // High-DPI Canvas Renderers (Header, Footer, Cover Page, Text Patch)
  // ============================================================

  async function renderHeaderBandCanvas(pw, bandH, opts, pageNum, totalPages, logoImg) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(pw * CANVAS_SCALE);
    canvas.height = Math.round(bandH * CANVAS_SCALE);
    const ctx = canvas.getContext("2d");
    ctx.scale(CANVAS_SCALE, CANVAS_SCALE);

    // Background fill if covering old header
    if (opts.cover_old) {
      ctx.fillStyle = opts.bg_color || "#ffffff";
      ctx.fillRect(0, 0, pw, bandH);
    }

    const marginX = 32;
    const hasDivider = opts.divider !== false;
    if (hasDivider) {
      const lineY = bandH - 4;
      ctx.strokeStyle = opts.divider_color || "#000000";
      ctx.lineWidth = Math.max(0.5, Math.min(5, Number(opts.divider_width) || 2));
      ctx.beginPath();
      ctx.moveTo(marginX, lineY);
      ctx.lineTo(pw - marginX, lineY);
      ctx.stroke();
    }

    const contentY0 = 5;
    const contentY1 = bandH - (hasDivider ? 10 : 5);
    const availH = Math.max(16, contentY1 - contentY0);
    const innerW = pw - 2 * marginX;

    let logoRect = null;
    if (logoImg) {
      const reqH = Number(opts.logo_size) || 54;
      const maxH = Math.max(18, Math.min(reqH, availH));
      const maxW = innerW * 0.26;
      const aspect = logoImg.naturalWidth / Math.max(1, logoImg.naturalHeight);
      let drawH = maxH;
      let drawW = drawH * aspect;
      if (drawW > maxW) {
        drawW = maxW;
        drawH = drawW / Math.max(0.05, aspect);
      }
      const lx = (pw - drawW) / 2;
      const ly = contentY0 + (availH - drawH) / 2;
      ctx.drawImage(logoImg, lx, ly, drawW, drawH);
      logoRect = { x0: lx, x1: lx + drawW };
    }

    const rLines = [opts.right_line1, opts.right_line2]
      .map((s) => expandPlaceholders((s || "").trim(), pageNum, totalPages))
      .filter(Boolean);
    const lLines = [opts.left_line1, opts.left_line2]
      .map((s) => expandPlaceholders((s || "").trim(), pageNum, totalPages))
      .filter(Boolean);
    const cLines = (opts.center_text || "")
      .split("\n")
      .map((s) => expandPlaceholders(s.trim(), pageNum, totalPages))
      .filter(Boolean);

    let leftX0, leftW, rightX0, rightW, centerX0, centerW;
    if (logoRect) {
      const gap = 12;
      leftX0 = marginX;
      leftW = Math.max(40, logoRect.x0 - gap - marginX);
      rightX0 = logoRect.x1 + gap;
      rightW = Math.max(40, pw - marginX - rightX0);
    } else {
      const colW = innerW / 3;
      leftX0 = marginX;
      leftW = colW;
      centerX0 = marginX + colW;
      centerW = colW;
      rightX0 = marginX + 2 * colW;
      rightW = colW;
    }

    const sideAlign = opts.side_align || "center";
    const fontSize = Math.max(7, Math.min(24, Number(opts.font_size) || 11));
    const color = opts.text_color || "#000000";
    const bold = opts.bold !== false;

    if (lLines.length) {
      drawBiDiLines(ctx, lLines, leftX0, contentY0, leftW, availH, sideAlign === "center" ? "center" : "left", fontSize, color, bold);
    }
    if (rLines.length) {
      drawBiDiLines(ctx, rLines, rightX0, contentY0, rightW, availH, sideAlign === "center" ? "center" : "right", fontSize, color, bold);
    }
    if (cLines.length && !logoRect) {
      drawBiDiLines(ctx, cLines, centerX0, contentY0, centerW, availH, "center", fontSize, color, true);
    }

    return canvas;
  }

  async function renderFooterBandCanvas(pw, bandH, opts, pageNum, totalPages) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(pw * CANVAS_SCALE);
    canvas.height = Math.round(bandH * CANVAS_SCALE);
    const ctx = canvas.getContext("2d");
    ctx.scale(CANVAS_SCALE, CANVAS_SCALE);

    if (opts.cover_old) {
      ctx.fillStyle = opts.bg_color || "#ffffff";
      ctx.fillRect(0, 0, pw, bandH);
    }

    const marginX = 32;
    const hasDivider = !!opts.divider;
    if (hasDivider) {
      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(marginX, 4);
      ctx.lineTo(pw - marginX, 4);
      ctx.stroke();
    }

    const contentY0 = hasDivider ? 7 : 4;
    const contentY1 = bandH - 4;
    const availH = Math.max(14, contentY1 - contentY0);
    const innerW = pw - 2 * marginX;
    const colW = innerW / 3;

    let rLines = (opts.right_text || "").trim() ? [expandPlaceholders(opts.right_text.trim(), pageNum, totalPages)] : [];
    let cLines = (opts.center_text || "").trim() ? [expandPlaceholders(opts.center_text.trim(), pageNum, totalPages)] : [];
    let lLines = (opts.left_text || "").trim() ? [expandPlaceholders(opts.left_text.trim(), pageNum, totalPages)] : [];

    const numLabel = formatFooterNumber(pageNum, totalPages, opts);
    if (numLabel) {
      const pos = opts.numbering_position || "center";
      if (pos === "right") rLines.push(numLabel);
      else if (pos === "left") lLines.push(numLabel);
      else cLines.push(numLabel);
    }

    const fontSize = Math.max(7, Math.min(24, Number(opts.font_size) || 10));
    const color = opts.text_color || "#1e293b";
    const bold = !!opts.bold;

    if (lLines.length) drawBiDiLines(ctx, lLines, marginX, contentY0, colW, availH, "left", fontSize, color, bold);
    if (cLines.length) drawBiDiLines(ctx, cLines, marginX + colW, contentY0, colW, availH, "center", fontSize, color, bold);
    if (rLines.length) drawBiDiLines(ctx, rLines, marginX + 2 * colW, contentY0, colW, availH, "right", fontSize, color, bold);

    return canvas;
  }

  function resolveCoverSize(coverOpts, srcW, srcH) {
    if ((coverOpts.page_size || "a4_portrait") === "match_pdf" && srcW > 0 && srcH > 0) {
      return { width: srcW, height: srcH };
    }
    return { width: A4_PORTRAIT_W, height: A4_PORTRAIT_H };
  }

  async function renderCoverPageCanvas(coverOpts, srcW, srcH, coverLogoImg, scale = 2.4) {
    const { width: pw, height: ph } = resolveCoverSize(coverOpts, srcW, srcH);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(pw * scale);
    canvas.height = Math.round(ph * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = coverOpts.bg_color || "#ffffff";
    ctx.fillRect(0, 0, pw, ph);

    // Outer border
    const borderMargin = 24;
    if (coverOpts.border_enabled !== false) {
      ctx.strokeStyle = coverOpts.border_color || "#475569";
      ctx.lineWidth = Math.max(0.5, Math.min(6, Number(coverOpts.border_width) || 1.2));
      ctx.strokeRect(borderMargin, borderMargin, pw - 2 * borderMargin, ph - 2 * borderMargin);
    }

    const innerMargin = borderMargin + 24;
    const topY = borderMargin + 28;

    // Cover Logo
    let logoRect = null;
    const logoPos = coverOpts.logo_position || "left";
    const logoSize = Math.max(40, Math.min(200, Number(coverOpts.logo_size) || 96));

    if (coverLogoImg) {
      const aspect = coverLogoImg.naturalWidth / Math.max(1, coverLogoImg.naturalHeight);
      let drawH = logoSize;
      let drawW = Math.min(pw * 0.35, drawH * aspect);
      drawH = drawW / Math.max(0.05, aspect);

      let lx;
      if (logoPos === "center") lx = (pw - drawW) / 2;
      else if (logoPos === "right") lx = pw - innerMargin - drawW;
      else lx = innerMargin + 8;

      ctx.drawImage(coverLogoImg, lx, topY, drawW, drawH);
      logoRect = { x0: lx, x1: lx + drawW, y0: topY, y1: topY + drawH, h: drawH };
    }

    // Top University / Department lines
    const topLines = [coverOpts.top_line1, coverOpts.top_line2, coverOpts.top_line3]
      .map((s) => (s || "").trim())
      .filter(Boolean);

    if (topLines.length) {
      const topFont = Math.max(9, Math.min(24, Number(coverOpts.top_font_size) || 13));
      const topColor = coverOpts.top_color || "#000000";
      const estH = Math.max(topFont * 1.65 * topLines.length + 8, 48);

      let tx0, tx1, ty0;
      if (logoRect && logoPos === "left") {
        tx0 = Math.max(logoRect.x1 + 18, pw * 0.44);
        tx1 = pw - innerMargin;
        ty0 = topY + Math.max(0, (logoRect.h - estH) / 2);
      } else if (logoRect && logoPos === "right") {
        tx0 = innerMargin;
        tx1 = Math.min(logoRect.x0 - 18, pw * 0.56);
        ty0 = topY + Math.max(0, (logoRect.h - estH) / 2);
      } else if (logoRect && logoPos === "center") {
        tx0 = innerMargin;
        tx1 = pw - innerMargin;
        ty0 = logoRect.y1 + 16;
      } else {
        tx0 = pw * 0.44;
        tx1 = pw - innerMargin;
        ty0 = topY + 10;
      }
      drawBiDiLines(ctx, topLines, tx0, ty0, tx1 - tx0, estH, "center", topFont, topColor, true);
    }

    // Main Title & Subtitle
    const titleRaw = (coverOpts.title || "").trim();
    const subtitleRaw = (coverOpts.subtitle || "").trim();
    const titleYPct = Math.max(20, Math.min(70, Number(coverOpts.title_y_pct) || 42));
    const titleY = ph * (titleYPct / 100);
    let subTop = titleY;

    if (titleRaw) {
      const tf = Math.max(14, Math.min(56, Number(coverOpts.title_font_size) || 30));
      const tc = coverOpts.title_color || "#000000";
      const tLines = titleRaw.split("\n").map((s) => s.trim()).filter(Boolean);
      const tH = Math.max(tf * 1.55 * tLines.length + 10, 50);
      drawBiDiLines(ctx, tLines, innerMargin, titleY, pw - 2 * innerMargin, tH, "center", tf, tc, true);
      subTop = titleY + tH + 8;
    }

    if (subtitleRaw) {
      const sf = Math.max(10, Math.min(32, Number(coverOpts.subtitle_font_size) || 16));
      const sc = coverOpts.subtitle_color || "#334155";
      const sLines = subtitleRaw.split("\n").map((s) => s.trim()).filter(Boolean);
      const sH = Math.max(sf * 1.55 * sLines.length + 8, 30);
      drawBiDiLines(ctx, sLines, innerMargin, subTop, pw - 2 * innerMargin, sH, "center", sf, sc, false);
    }

    // Lecturer Name & Extra Bottom Info
    const lecRaw = (coverOpts.lecturer_name || "").trim();
    const extraRaw = (coverOpts.extra_info || "").trim();
    const lecYPct = Math.max(50, Math.min(90, Number(coverOpts.lecturer_y_pct) || 78));
    const lecY = ph * (lecYPct / 100);
    let extraTop = lecY;

    if (lecRaw) {
      const lf = Math.max(11, Math.min(36, Number(coverOpts.lecturer_font_size) || 18));
      const lc = coverOpts.lecturer_color || "#000000";
      const lLines = lecRaw.split("\n").map((s) => s.trim()).filter(Boolean);
      const lH = Math.max(lf * 1.55 * lLines.length + 8, 36);
      drawBiDiLines(ctx, lLines, innerMargin, lecY, pw - 2 * innerMargin, lH, "center", lf, lc, true);
      extraTop = lecY + lH + 8;
    }

    if (extraRaw) {
      const ef = 13;
      const eLines = extraRaw.split("\n").map((s) => s.trim()).filter(Boolean);
      const eH = Math.max(ef * 1.5 * eLines.length + 8, 28);
      drawBiDiLines(ctx, eLines, innerMargin, extraTop, pw - 2 * innerMargin, eH, "center", ef, "#334155", false);
    }

    return { canvas, width: pw, height: ph };
  }

  function renderTextPatchCanvas(text, boxW, boxH, fontSize, color, isRtl) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(boxW * CANVAS_SCALE));
    canvas.height = Math.max(8, Math.round(boxH * CANVAS_SCALE));
    const ctx = canvas.getContext("2d");
    ctx.scale(CANVAS_SCALE, CANVAS_SCALE);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, boxW, boxH);

    drawBiDiLines(ctx, [text], 2, 0, Math.max(4, boxW - 4), boxH, isRtl ? "right" : "left", fontSize, color, false);
    return canvas;
  }

  // ============================================================
  // Optional Faint Light-Gray Watermark Cleaner for Scanned/Image Pages
  // ============================================================

  function washOutLightWatermarkPixels(canvas, threshold = 192) {
    const ctx = canvas.getContext("2d");
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      // Faint neutral gray or very light washed-out watermark tint -> pure white
      const avg = (r + g + b) / 3;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      if (avg >= threshold && (spread <= 28 || avg >= 218)) {
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // ============================================================
  // Core Page Editing Pipeline (Shared by Live Preview & Full Export)
  // ============================================================

  async function processPdfBytes(pdfBytes, pdfJsDoc, options, logos, singlePageOnly = null, onProgress = null) {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const headerLogoImg = logos.headerLogoUrl ? await loadImageElement(logos.headerLogoUrl) : null;
    const coverLogoUrl =
      logos.coverLogoUrl || (options.cover_page?.use_header_logo !== false ? logos.headerLogoUrl : null);
    const coverLogoImg = coverLogoUrl ? await loadImageElement(coverLogoUrl) : null;

    // Cover-only preview shortcut
    if (singlePageOnly === 0) {
      const p1 = await pdfJsDoc.getPage(1);
      const vp = p1.getViewport({ scale: 1.0 });
      const { canvas } = await renderCoverPageCanvas(options.cover_page || {}, vp.width, vp.height, coverLogoImg, 1.8);
      return { previewDataUrl: canvas.toDataURL("image/png") };
    }

    const srcDoc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const origTotal = srcDoc.getPageCount();
    const coverOpts = options.cover_page || {};
    const headerOpts = options.header || {};
    const footerOpts = options.footer || {};
    const repOpts = options.text_replacements || {};
    const wmOpts = options.watermark || {};

    const stats = {
      pages_processed: origTotal + (coverOpts.enabled && coverOpts.mode !== "replace" ? 1 : 0),
      headers_updated: 0,
      footers_updated: 0,
      text_replacements: 0,
      watermarks_removed: 0,
      cover_added: coverOpts.enabled ? 1 : 0,
    };

    // Determine which 1-based pages to process
    let targetPages;
    if (singlePageOnly !== null) {
      targetPages = [Math.max(1, Math.min(origTotal, singlePageOnly))];
    } else {
      const startP = coverOpts.enabled && coverOpts.mode === "replace" && origTotal >= 1 ? 2 : 1;
      targetPages = [];
      for (let p = startP; p <= origTotal; p++) targetPages.push(p);
    }

    const clearedXobjs = new Set();
    const customWmTexts = (wmOpts.custom_texts || []).map((s) => s.trim()).filter(Boolean);
    const repItems = (repOpts.items || []).filter((it) => (it.old_text || "").trim());

    for (let idx = 0; idx < targetPages.length; idx++) {
      const pageNum = targetPages[idx];
      if (onProgress) onProgress(idx + 1, targetPages.length);

      const libPage = srcDoc.getPage(pageNum - 1);
      const { width: pw, height: ph } = libPage.getSize();
      const jsPage = await pdfJsDoc.getPage(pageNum);
      const pageInfo = await extractPageLines(jsPage);

      // 1. Vector / Stream Watermark Removal
      stats.watermarks_removed += cleanWatermarksOnPage(srcDoc, libPage, wmOpts, clearedXobjs);

      // 1b. Optional Raster Faint Watermark Wash (for scanned/image watermarks)
      if (wmOpts.enabled && wmOpts.wash_light_images) {
        const vp = jsPage.getViewport({ scale: 2.0 });
        const tmpC = document.createElement("canvas");
        tmpC.width = Math.round(vp.width);
        tmpC.height = Math.round(vp.height);
        await jsPage.render({ canvasContext: tmpC.getContext("2d"), viewport: vp }).promise;
        washOutLightWatermarkPixels(tmpC, 192);
        const pngBytes = await canvasToPngBytes(tmpC);
        const embedded = await srcDoc.embedPng(pngBytes);
        libPage.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });
        stats.watermarks_removed += 1;
      }

      // 1c. Custom watermark text cover
      if (wmOpts.enabled && customWmTexts.length) {
        for (const wmTxt of customWmTexts) {
          const qNorm = normalizeArabic(wmTxt, true);
          const qRev = reverseStr(qNorm);
          for (const ln of pageInfo.lines) {
            const n1 = normalizeArabic(ln.text, true);
            const n2 = normalizeArabic(ln.altText, true);
            if (n1.includes(qNorm) || n2.includes(qNorm) || (hasArabic(wmTxt) && (n1.includes(qRev) || n2.includes(qRev)))) {
              libPage.drawRectangle({
                x: Math.max(0, ln.x0 - 2),
                y: Math.max(0, ph - ln.y1 - 2),
                width: Math.min(pw, ln.x1 - ln.x0 + 4),
                height: Math.max(10, ln.y1 - ln.y0 + 4),
                color: PDFLib.rgb(1, 1, 1),
              });
              stats.watermarks_removed += 1;
            }
          }
        }
      }

      // 2. Smart Lecturer Name / Text Replacements
      if (repItems.length) {
        const fuzzy = repOpts.fuzzy_arabic !== false;
        const customSize = Number(repOpts.font_size) || 0;
        const repColor = repOpts.text_color || "#111827";

        for (const item of repItems) {
          const oldTxt = item.old_text.trim();
          const newTxt = (item.new_text || "").trim();
          const qNorm = normalizeArabic(oldTxt, fuzzy);
          const qRev = reverseStr(qNorm);

          for (const ln of pageInfo.lines) {
            const n1 = normalizeArabic(ln.text, fuzzy);
            const n2 = normalizeArabic(ln.altText, fuzzy);
            const matchedText =
              n1.includes(qNorm) || (hasArabic(oldTxt) && n1.includes(qRev))
                ? ln.text
                : n2.includes(qNorm) || (hasArabic(oldTxt) && n2.includes(qRev))
                ? ln.altText
                : null;

            if (!matchedText) continue;

            const finalText = newTxt ? replaceSubstringFuzzy(matchedText, oldTxt, newTxt, fuzzy) : "";
            const fSize = customSize > 0 ? customSize : Math.max(9, Math.min(24, ln.fontSize));
            const isRtl = hasArabic(finalText || matchedText);

            const extraW = Math.max(0, (finalText.length - matchedText.length) * fSize * 0.55);
            const boxX0 = isRtl ? Math.max(14, ln.x0 - extraW - 6) : Math.max(14, ln.x0 - 4);
            const boxX1 = isRtl ? Math.min(pw - 14, ln.x1 + 4) : Math.min(pw - 14, ln.x1 + extraW + 6);
            const boxW = Math.max(24, boxX1 - boxX0);
            const boxH = Math.max(ln.y1 - ln.y0 + 6, fSize * 1.65);
            const cyTop = (ln.y0 + ln.y1) / 2;
            const yTop = Math.max(0, cyTop - boxH / 2);

            if (finalText) {
              const patchCanvas = renderTextPatchCanvas(finalText, boxW, boxH, fSize, repColor, isRtl);
              const patchBytes = await canvasToPngBytes(patchCanvas);
              const embedded = await srcDoc.embedPng(patchBytes);
              libPage.drawImage(embedded, {
                x: boxX0,
                y: ph - (yTop + boxH),
                width: boxW,
                height: boxH,
              });
            } else {
              libPage.drawRectangle({
                x: boxX0,
                y: ph - (yTop + boxH),
                width: boxW,
                height: boxH,
                color: PDFLib.rgb(1, 1, 1),
              });
            }
            stats.text_replacements += 1;
          }
        }
      }

      // 3. Smart Old Lecture Header Removal (works even on Page 1 when new header skips Page 1!)
      const willDrawHeader = pageInRange(pageNum, origTotal, headerOpts);
      if (headerOpts.smart_clean_old) {
        const cutY = detectSmartHeaderCutY(pageInfo, pageNum, headerOpts);
        if (cutY > 6) {
          const bg = hexToRgb01(headerOpts.bg_color || "#ffffff");
          // Slight horizontal inset (27pt) preserves typical outer vertical page border frames when no new header is drawn
          const insetX = willDrawHeader ? 0 : 27;
          const eraseY0 = willDrawHeader ? 0 : 26;
          if (cutY > eraseY0 + 4) {
            libPage.drawRectangle({
              x: insetX,
              y: ph - cutY,
              width: Math.max(10, pw - 2 * insetX),
              height: cutY - eraseY0,
              color: PDFLib.rgb(bg.r, bg.g, bg.b),
            });
          }
        }
      }

      // 4. New Header Band (Center Logo + 2 Lines Right + 2 Lines Left)
      if (willDrawHeader) {
        const bandH = Math.max(28, Math.min(ph * 0.4, Number(headerOpts.height) || 76));
        const hCanvas = await renderHeaderBandCanvas(pw, bandH, headerOpts, pageNum, origTotal, headerLogoImg);
        const hBytes = await canvasToPngBytes(hCanvas);
        const hImg = await srcDoc.embedPng(hBytes);
        libPage.drawImage(hImg, { x: 0, y: ph - bandH, width: pw, height: bandH });
        stats.headers_updated += 1;
      }

      // 5. New Footer Band + Page Numbering
      if (pageInRange(pageNum, origTotal, footerOpts)) {
        const bandH = Math.max(24, Math.min(ph * 0.35, Number(footerOpts.height) || 45));
        const fCanvas = await renderFooterBandCanvas(pw, bandH, footerOpts, pageNum, origTotal);
        const fBytes = await canvasToPngBytes(fCanvas);
        const fImg = await srcDoc.embedPng(fBytes);
        libPage.drawImage(fImg, { x: 0, y: 0, width: pw, height: bandH });
        stats.footers_updated += 1;
      }
    }

    // 6. Live Single-Page Preview Render
    if (singlePageOnly !== null) {
      const editedBytes = await srcDoc.save();
      const previewDoc = await pdfjsLib.getDocument({ data: editedBytes }).promise;
      const previewPage = await previewDoc.getPage(targetPages[0]);
      const vp = previewPage.getViewport({ scale: 1.8 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      await previewPage.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      previewDoc.destroy();
      return { previewDataUrl: c.toDataURL("image/png") };
    }

    // 7. Insert / Replace Cover Page (Portrait A4 by default)
    if (coverOpts.enabled) {
      const firstSize = origTotal > 0 ? srcDoc.getPage(0).getSize() : { width: A4_PORTRAIT_W, height: A4_PORTRAIT_H };
      const { canvas: cCanvas, width: cw, height: ch } = await renderCoverPageCanvas(
        coverOpts,
        firstSize.width,
        firstSize.height,
        coverLogoImg,
        2.6
      );
      const cBytes = await canvasToPngBytes(cCanvas);
      const cImg = await srcDoc.embedPng(cBytes);

      if (coverOpts.mode === "replace" && origTotal >= 1) {
        srcDoc.removePage(0);
      }
      const coverPage = srcDoc.insertPage(0, [cw, ch]);
      coverPage.drawImage(cImg, { x: 0, y: 0, width: cw, height: ch });
    }

    const outBytes = await srcDoc.save({ useObjectStreams: false });
    return { pdfBytes: outBytes, stats };
  }

  // Expose public API
  global.PdfStudioEngine = {
    analyzePdf,
    searchTextInPdf,
    processPdfBytes,
  };
})(window);
