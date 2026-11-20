// Pure Client-Side Academic PDF Editor Controller (Zero Python / Zero Server)

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// Application State
const state = {
  pdfBytes: null, // Uint8Array of uploaded PDF
  pdfJsDoc: null, // Loaded pdf.js document
  fileName: "",
  pageCount: 1,
  currentPage: 1,
  pageSizes: [],
  zoom: 1.0,
  previewMode: "original", // "original" | "edited" | "cover"
  headerLogoUrl: null, // Data URL
  coverLogoUrl: null, // Data URL
  lastDownloadUrl: null,
};

const $ = (id) => document.getElementById(id);

const uploadSection = $("uploadSection");
const editorSection = $("editorSection");
const dropZone = $("dropZone");
const pdfInput = $("pdfInput");
const btnSelectFile = $("btnSelectFile");
const uploadProgress = $("uploadProgress");

const fileBadgeArea = $("fileBadgeArea");
const navFileName = $("navFileName");
const navPageCount = $("navPageCount");
const btnNewFile = $("btnNewFile");

const previewImage = $("previewImage");
const previewLoader = $("previewLoader");
const headerGuideOverlay = $("headerGuideOverlay");
const footerGuideOverlay = $("footerGuideOverlay");
const currentPageInput = $("currentPageInput");
const totalPagesLabel = $("totalPagesLabel");
const btnPrevPage = $("btnPrevPage");
const btnNextPage = $("btnNextPage");
const btnModeOriginal = $("btnModeOriginal");
const btnModeEdited = $("btnModeEdited");
const btnModeCover = $("btnModeCover");
const btnZoomIn = $("btnZoomIn");
const btnZoomOut = $("btnZoomOut");
const zoomLabel = $("zoomLabel");
const statusToast = $("statusToast");

const replacementsList = $("replacementsList");
const btnAddReplacement = $("btnAddReplacement");
const btnPreviewEdited = $("btnPreviewEdited");
const btnProcessDownload = $("btnProcessDownload");

const processingModal = $("processingModal");
const modalLoading = $("modalLoading");
const modalProgressText = $("modalProgressText");
const modalSuccess = $("modalSuccess");
const processStats = $("processStats");
const btnDownloadFinal = $("btnDownloadFinal");
const btnCloseModal = $("btnCloseModal");

let toastTimer = null;

function showToast(msg, duration = 3200) {
  statusToast.textContent = msg;
  statusToast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    statusToast.classList.add("hidden");
  }, duration);
}

// ==========================================
// PDF File Selection & Local Analysis
// ==========================================
btnSelectFile.addEventListener("click", (e) => {
  e.stopPropagation();
  pdfInput.click();
});

dropZone.addEventListener("click", () => pdfInput.click());

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer.files?.[0];
  if (file) handleFileSelected(file);
});

pdfInput.addEventListener("change", () => {
  const file = pdfInput.files?.[0];
  if (file) handleFileSelected(file);
  pdfInput.value = "";
});

btnNewFile.addEventListener("click", () => {
  editorSection.classList.add("hidden");
  fileBadgeArea.classList.add("hidden");
  uploadSection.classList.remove("hidden");
  if (state.pdfJsDoc) {
    try {
      state.pdfJsDoc.destroy();
    } catch (_) {}
  }
  state.pdfBytes = null;
  state.pdfJsDoc = null;
});

async function handleFileSelected(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    alert("يرجى اختيار ملف بصيغة PDF فقط.");
    return;
  }

  uploadProgress.classList.remove("hidden");
  btnSelectFile.disabled = true;

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const result = await window.PdfStudioEngine.analyzePdf(bytes);

    state.pdfBytes = bytes;
    state.pdfJsDoc = result.pdfJsDoc;
    state.fileName = file.name;
    state.pageCount = result.pageCount;
    state.pageSizes = result.pageSizes;
    state.currentPage = 1;
    state.previewMode = "original";

    initEditorUI(result);
  } catch (err) {
    alert("تعذر قراءة ملف الـ PDF: " + (err?.message || err));
  } finally {
    uploadProgress.classList.add("hidden");
    btnSelectFile.disabled = false;
  }
}

function initEditorUI(data) {
  navFileName.textContent = state.fileName;
  navPageCount.textContent = `${data.pageCount} صفحة`;
  fileBadgeArea.classList.remove("hidden");

  totalPagesLabel.textContent = data.pageCount;
  currentPageInput.max = data.pageCount;
  currentPageInput.value = 1;
  $("headerEndPage").max = data.pageCount;
  $("footerEndPage").max = data.pageCount;

  // Detected Header & Footer
  const headerDetected = data.analysis?.detected_header || "";
  if (headerDetected) {
    $("detectedHeaderText").textContent = headerDetected;
    $("detectedHeaderBox").classList.remove("hidden");
  } else {
    $("detectedHeaderBox").classList.add("hidden");
  }

  const footerDetected = data.analysis?.detected_footer || "";
  if (footerDetected) {
    $("detectedFooterText").textContent = footerDetected;
    $("detectedFooterBox").classList.remove("hidden");
  } else {
    $("detectedFooterBox").classList.add("hidden");
  }

  populateWatermarkAnalysis(data.analysis?.watermarks || {});

  replacementsList.innerHTML = "";
  addReplacementRow();

  uploadSection.classList.add("hidden");
  editorSection.classList.remove("hidden");

  updateModeButtons();
  updateTabIndicators();
  loadCurrentPagePreview();
}

// ==========================================
// Local Logo Upload (100% Client-Side FileReader)
// ==========================================
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("تعذر قراءة صورة الشعار"));
    reader.readAsDataURL(file);
  });
}

function refreshCoverLogoPreview() {
  const imgEl = $("coverLogoPreviewImg");
  const placeholder = $("coverLogoPlaceholder");
  const removeBtn = $("btnRemoveCoverLogo");

  if (state.coverLogoUrl) {
    imgEl.src = state.coverLogoUrl;
    imgEl.classList.remove("hidden");
    placeholder.classList.add("hidden");
    removeBtn.classList.remove("hidden");
  } else if ($("coverUseHeaderLogo").checked && state.headerLogoUrl) {
    imgEl.src = state.headerLogoUrl;
    imgEl.classList.remove("hidden");
    placeholder.classList.add("hidden");
    removeBtn.classList.add("hidden");
  } else {
    imgEl.src = "";
    imgEl.classList.add("hidden");
    placeholder.classList.remove("hidden");
    removeBtn.classList.add("hidden");
  }
}

$("btnUploadHeaderLogo").addEventListener("click", () => $("headerLogoInput").click());
$("headerLogoInput").addEventListener("change", async () => {
  const file = $("headerLogoInput").files?.[0];
  $("headerLogoInput").value = "";
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    state.headerLogoUrl = dataUrl;
    $("headerLogoPreviewImg").src = dataUrl;
    $("headerLogoPreviewImg").classList.remove("hidden");
    $("headerLogoPlaceholder").classList.add("hidden");
    $("btnRemoveHeaderLogo").classList.remove("hidden");
    $("headerCenterFallbackWrap").classList.add("hidden");

    if (!$("headerEnabled").checked) $("headerEnabled").checked = true;
    if (Number($("headerHeight").value) < 70) {
      $("headerHeight").value = 76;
      $("headerHeightVal").textContent = "76 pt";
    }
    refreshCoverLogoPreview();
    updateTabIndicators();
    showToast("تم رفع شعار وسط الترويسة بنجاح");
  } catch (err) {
    alert(err.message);
  }
});

$("btnRemoveHeaderLogo").addEventListener("click", () => {
  state.headerLogoUrl = null;
  $("headerLogoPreviewImg").src = "";
  $("headerLogoPreviewImg").classList.add("hidden");
  $("headerLogoPlaceholder").classList.remove("hidden");
  $("btnRemoveHeaderLogo").classList.add("hidden");
  $("headerCenterFallbackWrap").classList.remove("hidden");
  refreshCoverLogoPreview();
  showToast("تم حذف شعار الترويسة");
});

$("btnUploadCoverLogo").addEventListener("click", () => $("coverLogoInput").click());
$("coverLogoInput").addEventListener("change", async () => {
  const file = $("coverLogoInput").files?.[0];
  $("coverLogoInput").value = "";
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataUrl(file);
    state.coverLogoUrl = dataUrl;
    $("coverUseHeaderLogo").checked = false;
    if (!$("coverEnabled").checked) $("coverEnabled").checked = true;
    refreshCoverLogoPreview();
    updateTabIndicators();
    showToast("تم رفع شعار الورقة الأولى بنجاح");
  } catch (err) {
    alert(err.message);
  }
});

$("btnRemoveCoverLogo").addEventListener("click", () => {
  state.coverLogoUrl = null;
  refreshCoverLogoPreview();
});

$("coverUseHeaderLogo").addEventListener("change", refreshCoverLogoPreview);

// Copy university info & logo from Header tab -> Cover tab
$("btnCopyFromHeader").addEventListener("click", () => {
  $("coverTopLine1").value = $("headerRightLine1").value;
  $("coverTopLine2").value = $("headerRightLine2").value;

  const left1 = $("headerLeftLine1").value.trim();
  const left2 = $("headerLeftLine2").value.trim();
  if (left1 && !$("coverTitle").value.trim()) {
    $("coverTitle").value = left1.replace(/^(?:اسم\s*)?المادة\s*:\s*/i, "");
  }
  if (left2 && !$("coverLecturer").value.trim()) {
    $("coverLecturer").value = left2.replace(/^(?:اسم\s*)?التدريسي\s*:\s*/i, "");
  }

  $("coverUseHeaderLogo").checked = true;
  $("coverEnabled").checked = true;
  refreshCoverLogoPreview();
  updateTabIndicators();
  showToast("تم نسخ بيانات الترويسة والشعار إلى الورقة الأولى");
});

$("btnPreviewCoverNow").addEventListener("click", () => {
  if (!$("coverEnabled").checked) $("coverEnabled").checked = true;
  updateTabIndicators();
  state.previewMode = "cover";
  updateModeButtons();
  loadCurrentPagePreview();
  showToast("تم تحديث معاينة الورقة الأولى (الغلاف)");
});

// ==========================================
// Watermark Analysis Population
// ==========================================
function populateWatermarkAnalysis(wm) {
  const parts = [];
  const annCount = wm.annotation_count || 0;
  const diagCount = wm.diagonal_text_count || 0;
  const xobjCount = wm.transparent_xobject_count || 0;
  const detectedTexts = wm.text_candidates || [];

  if (annCount > 0) parts.push(`• ${annCount} تعليق/طبقة علامة مائية`);
  if (diagCount > 0) parts.push(`• ${diagCount} نص مائل أو شفاف/كبير`);
  if (xobjCount > 0) parts.push(`• ${xobjCount} كائن شفاف (Form XObject)`);

  if (parts.length > 0) {
    $("watermarkSummaryBody").innerHTML = parts.join("<br />");
    $("watermarkEnabled").checked = true;
  } else {
    $("watermarkSummaryBody").textContent =
      "لم يتم اكتشاف علامات مائية واضحة تلقائياً، ولكن يمكنك تفعيل الإزالة أو خيار تنظيف العلامات المائية الفاتحة أو كتابة نص محدد بالأسفل.";
    $("watermarkEnabled").checked = false;
  }

  const textsSec = $("detectedWmTextsSection");
  const textsList = $("detectedWmTextsList");
  textsList.innerHTML = "";
  if (detectedTexts.length > 0) {
    textsSec.classList.remove("hidden");
    detectedTexts.forEach((txt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip-btn";
      btn.textContent = `+ ${txt}`;
      btn.addEventListener("click", () => {
        const ta = $("wmCustomTexts");
        const lines = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
        if (!lines.includes(txt)) {
          lines.push(txt);
          ta.value = lines.join("\n");
          $("watermarkEnabled").checked = true;
          updateTabIndicators();
          showToast(`تمت إضافة "${txt}" إلى قائمة إزالة العلامة المائية`);
        }
      });
      textsList.appendChild(btn);
    });
  } else {
    textsSec.classList.add("hidden");
  }
}

// ==========================================
// Tabs & Indicators
// ==========================================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    updateGuideOverlays();
  });
});

function updateTabIndicators() {
  $("indHeader").classList.toggle("on", $("headerEnabled").checked);
  $("indCover").classList.toggle("on", $("coverEnabled").checked);
  $("indFooter").classList.toggle("on", $("footerEnabled").checked);
  $("indWatermark").classList.toggle("on", $("watermarkEnabled").checked);
  $("indLecturer").classList.toggle("on", getReplacements().length > 0);
  updateGuideOverlays();
}

[
  "headerEnabled",
  "coverEnabled",
  "footerEnabled",
  "watermarkEnabled",
  "headerCoverOld",
  "footerCoverOld",
  "footerNumberingEnabled",
].forEach((id) => {
  $(id).addEventListener("change", () => {
    if (id === "footerNumberingEnabled" && $(id).checked && !$("footerEnabled").checked) {
      $("footerEnabled").checked = true;
    }
    updateTabIndicators();
  });
});

$("headerHeight").addEventListener("input", (e) => {
  $("headerHeightVal").textContent = `${e.target.value} pt`;
  if (!$("headerEnabled").checked) $("headerEnabled").checked = true;
  updateTabIndicators();
});

$("headerLogoSize").addEventListener("input", (e) => {
  $("headerLogoSizeVal").textContent = `${e.target.value} pt`;
});

$("coverLogoSize").addEventListener("input", (e) => {
  $("coverLogoSizeVal").textContent = `${e.target.value} pt`;
});

$("footerHeight").addEventListener("input", (e) => {
  $("footerHeightVal").textContent = `${e.target.value} pt`;
  if (!$("footerEnabled").checked) $("footerEnabled").checked = true;
  updateTabIndicators();
});

["headerRightLine1", "headerRightLine2", "headerLeftLine1", "headerLeftLine2", "headerCenter"].forEach((id) => {
  $(id).addEventListener("input", () => {
    if ($(id).value.trim() && !$("headerEnabled").checked) {
      $("headerEnabled").checked = true;
      updateTabIndicators();
    }
  });
});

["coverTopLine1", "coverTopLine2", "coverTitle", "coverLecturer"].forEach((id) => {
  $(id).addEventListener("input", () => {
    if ($(id).value.trim() && !$("coverEnabled").checked) {
      $("coverEnabled").checked = true;
      updateTabIndicators();
    }
  });
});

["footerRight", "footerCenter", "footerLeft"].forEach((id) => {
  $(id).addEventListener("input", () => {
    if ($(id).value.trim() && !$("footerEnabled").checked) {
      $("footerEnabled").checked = true;
      updateTabIndicators();
    }
  });
});

["footerNumberingFormat", "footerNumberingPosition", "footerNumberingStart", "footerNumberingArabicDigits"].forEach(
  (id) => {
    $(id).addEventListener("change", () => {
      if (!$("footerEnabled").checked) {
        $("footerEnabled").checked = true;
        updateTabIndicators();
      }
    });
  }
);

// ==========================================
// Lecturer Name / Text Replacement Rows
// ==========================================
let replacementCounter = 0;

function addReplacementRow(oldVal = "", newVal = "") {
  replacementCounter += 1;
  const card = document.createElement("div");
  card.className = "replacement-card";

  card.innerHTML = `
    <div class="replacement-card-head">
      <span>استبدال اسم التدريسي / النص #${replacementsList.children.length + 1}</span>
      ${replacementsList.children.length > 0 ? '<button type="button" class="btn btn-danger-ghost btn-remove-rep">حذف</button>' : ""}
    </div>
    <div class="form-group">
      <label>الاسم / النص القديم في الكتاب</label>
      <div class="search-row">
        <input type="text" class="rep-old" placeholder="مثال: أ.د. أحمد محمد علي" value="${escapeHtml(oldVal)}" />
        <button type="button" class="btn btn-secondary btn-sm btn-search-rep">بحث</button>
      </div>
    </div>
    <div class="rep-match-result hidden"></div>
    <div class="form-group">
      <label>الاسم / النص الجديد البديل</label>
      <input type="text" class="rep-new" placeholder="مثال: م.م رنا علي ذويب" value="${escapeHtml(newVal)}" />
    </div>
  `;

  const oldInput = card.querySelector(".rep-old");
  const newInput = card.querySelector(".rep-new");
  const searchBtn = card.querySelector(".btn-search-rep");
  const matchResult = card.querySelector(".rep-match-result");
  const removeBtn = card.querySelector(".btn-remove-rep");

  oldInput.addEventListener("input", updateTabIndicators);
  newInput.addEventListener("input", updateTabIndicators);

  searchBtn.addEventListener("click", async () => {
    const query = oldInput.value.trim();
    if (!query || !state.pdfJsDoc) return;
    searchBtn.disabled = true;
    searchBtn.textContent = "...";
    try {
      const data = await window.PdfStudioEngine.searchTextInPdf(
        state.pdfJsDoc,
        query,
        $("replaceFuzzyArabic").checked
      );
      matchResult.classList.remove("hidden");
      if (data.total_matches > 0) {
        const samplePages = data.pages.slice(0, 8).join("، ");
        const more = data.pages.length > 8 ? ` (+${data.pages.length - 8} صفحة أخرى)` : "";
        matchResult.className = "rep-match-result match-badge found";
        matchResult.textContent = `تم العثور على ${data.total_matches} تطابق في الصفحات: ${samplePages}${more}`;
      } else {
        matchResult.className = "rep-match-result match-badge none";
        matchResult.textContent = "لم يتم العثور على هذا النص في الملف. تأكد من الإملاء أو جرّب جزءاً من الاسم.";
      }
    } catch {
      showToast("تعذر تنفيذ البحث");
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = "بحث";
    }
  });

  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      card.remove();
      updateTabIndicators();
    });
  }

  replacementsList.appendChild(card);
}

btnAddReplacement.addEventListener("click", () => addReplacementRow());

function getReplacements() {
  const list = [];
  replacementsList.querySelectorAll(".replacement-card").forEach((card) => {
    const oldText = card.querySelector(".rep-old").value.trim();
    const newText = card.querySelector(".rep-new").value.trim();
    if (oldText) list.push({ old_text: oldText, new_text: newText });
  });
  return list;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ==========================================
// Build Edit Options Payload
// ==========================================
function buildOptionsPayload() {
  const customWmTexts = $("wmCustomTexts")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    cover_page: {
      enabled: $("coverEnabled").checked,
      mode: $("coverMode").value,
      page_size: $("coverPageSize").value,
      top_line1: $("coverTopLine1").value,
      top_line2: $("coverTopLine2").value,
      top_line3: $("coverTopLine3").value,
      top_font_size: Number($("coverTopFontSize").value) || 13,
      top_color: $("coverTopColor").value,
      use_header_logo: $("coverUseHeaderLogo").checked,
      logo_position: $("coverLogoPosition").value,
      logo_size: Number($("coverLogoSize").value) || 96,
      title: $("coverTitle").value,
      subtitle: $("coverSubtitle").value,
      title_font_size: Number($("coverTitleFontSize").value) || 30,
      title_color: $("coverTitleColor").value,
      title_y_pct: Number($("coverTitleYPct").value) || 42,
      lecturer_name: $("coverLecturer").value,
      extra_info: $("coverExtra").value,
      lecturer_font_size: Number($("coverLecturerFontSize").value) || 18,
      lecturer_color: $("coverLecturerColor").value,
      lecturer_y_pct: Number($("coverLecturerYPct").value) || 78,
      border_enabled: $("coverBorderEnabled").checked,
      border_color: $("coverBorderColor").value,
      border_width: Number($("coverBorderWidth").value) || 1.2,
      bg_color: $("coverBgColor").value,
    },
    header: {
      enabled: $("headerEnabled").checked,
      cover_old: $("headerCoverOld").checked,
      smart_clean_old: $("headerSmartCleanOld").checked,
      start_from_text: $("headerStartFromText").value,
      height: Number($("headerHeight").value) || 76,
      logo_size: Number($("headerLogoSize").value) || 54,
      right_line1: $("headerRightLine1").value,
      right_line2: $("headerRightLine2").value,
      center_text: $("headerCenter").value,
      left_line1: $("headerLeftLine1").value,
      left_line2: $("headerLeftLine2").value,
      side_align: $("headerSideAlign").value,
      bold: $("headerBold").checked,
      font_size: Number($("headerFontSize").value) || 11,
      text_color: $("headerColor").value,
      bg_color: $("headerBgColor").value,
      divider: $("headerDivider").checked,
      divider_color: $("headerDividerColor").value,
      divider_width: Number($("headerDividerWidth").value) || 2,
      skip_first_page: $("headerSkipFirst").checked,
      start_page: Number($("headerStartPage").value) || 1,
      end_page: $("headerEndPage").value ? Number($("headerEndPage").value) : null,
    },
    footer: {
      enabled: $("footerEnabled").checked,
      cover_old: $("footerCoverOld").checked,
      height: Number($("footerHeight").value) || 45,
      numbering_enabled: $("footerNumberingEnabled").checked,
      numbering_format: $("footerNumberingFormat").value,
      numbering_position: $("footerNumberingPosition").value,
      numbering_start: Number($("footerNumberingStart").value) || 1,
      numbering_arabic_digits: $("footerNumberingArabicDigits").checked,
      right_text: $("footerRight").value,
      center_text: $("footerCenter").value,
      left_text: $("footerLeft").value,
      bold: $("footerBold").checked,
      font_size: Number($("footerFontSize").value) || 10,
      text_color: $("footerColor").value,
      bg_color: $("footerBgColor").value,
      divider: $("footerDivider").checked,
      skip_first_page: $("footerSkipFirst").checked,
      start_page: Number($("footerStartPage").value) || 1,
      end_page: $("footerEndPage").value ? Number($("footerEndPage").value) : null,
    },
    text_replacements: {
      items: getReplacements(),
      font_size: Number($("replaceFontSize").value) || 0,
      text_color: $("replaceColor").value,
      fuzzy_arabic: $("replaceFuzzyArabic").checked,
    },
    watermark: {
      enabled: $("watermarkEnabled").checked,
      remove_annotations: $("wmRemoveAnnotations").checked,
      remove_diagonal_text: $("wmRemoveDiagonalText").checked,
      remove_xobjects: $("wmRemoveXObjects").checked,
      wash_light_images: $("wmWashLightImages").checked,
      custom_texts: customWmTexts,
    },
  };
}

// ==========================================
// Preview & Navigation
// ==========================================
function updateGuideOverlays() {
  const showGuides = state.previewMode === "original";
  const pageSize = state.pageSizes[state.currentPage - 1] || { width: 595, height: 842 };
  const pageHeightPt = pageSize.height || 842;

  if (showGuides && $("headerEnabled").checked) {
    const pct = Math.min(45, (Number($("headerHeight").value) / pageHeightPt) * 100);
    headerGuideOverlay.style.height = `${pct}%`;
    headerGuideOverlay.classList.remove("hidden");
  } else {
    headerGuideOverlay.classList.add("hidden");
  }

  if (showGuides && $("footerEnabled").checked) {
    const pct = Math.min(45, (Number($("footerHeight").value) / pageHeightPt) * 100);
    footerGuideOverlay.style.height = `${pct}%`;
    footerGuideOverlay.classList.remove("hidden");
  } else {
    footerGuideOverlay.classList.add("hidden");
  }
}

function updateModeButtons() {
  btnModeOriginal.classList.toggle("active", state.previewMode === "original");
  btnModeEdited.classList.toggle("active", state.previewMode === "edited");
  btnModeCover.classList.toggle("active", state.previewMode === "cover");
  updateGuideOverlays();
}

function applyZoom() {
  const baseWidth = 620;
  previewImage.style.width = `${Math.round(baseWidth * state.zoom)}px`;
  zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
}

async function renderOriginalPageDataUrl(pageNumber) {
  const page = await state.pdfJsDoc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1.8 });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c.toDataURL("image/png");
}

async function loadCurrentPagePreview() {
  if (!state.pdfJsDoc || !state.pdfBytes) return;
  previewLoader.classList.remove("hidden");

  try {
    let dataUrl;
    if (state.previewMode === "original") {
      dataUrl = await renderOriginalPageDataUrl(state.currentPage);
    } else if (state.previewMode === "cover") {
      const res = await window.PdfStudioEngine.processPdfBytes(
        state.pdfBytes,
        state.pdfJsDoc,
        buildOptionsPayload(),
        { headerLogoUrl: state.headerLogoUrl, coverLogoUrl: state.coverLogoUrl },
        0
      );
      dataUrl = res.previewDataUrl;
    } else {
      const res = await window.PdfStudioEngine.processPdfBytes(
        state.pdfBytes,
        state.pdfJsDoc,
        buildOptionsPayload(),
        { headerLogoUrl: state.headerLogoUrl, coverLogoUrl: state.coverLogoUrl },
        state.currentPage
      );
      dataUrl = res.previewDataUrl;
    }

    previewImage.onload = () => {
      applyZoom();
      updateGuideOverlays();
    };
    previewImage.src = dataUrl;
  } catch (err) {
    showToast("حدث خطأ في المعاينة: " + (err?.message || err));
  } finally {
    previewLoader.classList.add("hidden");
  }
}

btnPrevPage.addEventListener("click", () => {
  if (state.currentPage > 1) {
    state.currentPage -= 1;
    currentPageInput.value = state.currentPage;
    if (state.previewMode === "cover") state.previewMode = "edited";
    updateModeButtons();
    loadCurrentPagePreview();
  }
});

btnNextPage.addEventListener("click", () => {
  if (state.currentPage < state.pageCount) {
    state.currentPage += 1;
    currentPageInput.value = state.currentPage;
    if (state.previewMode === "cover") state.previewMode = "edited";
    updateModeButtons();
    loadCurrentPagePreview();
  }
});

currentPageInput.addEventListener("change", () => {
  let p = Number(currentPageInput.value) || 1;
  p = Math.max(1, Math.min(state.pageCount, p));
  state.currentPage = p;
  currentPageInput.value = p;
  if (state.previewMode === "cover") state.previewMode = "edited";
  updateModeButtons();
  loadCurrentPagePreview();
});

btnModeOriginal.addEventListener("click", () => {
  state.previewMode = "original";
  updateModeButtons();
  loadCurrentPagePreview();
});

btnModeEdited.addEventListener("click", () => {
  state.previewMode = "edited";
  updateModeButtons();
  loadCurrentPagePreview();
});

btnModeCover.addEventListener("click", () => {
  state.previewMode = "cover";
  updateModeButtons();
  loadCurrentPagePreview();
});

btnPreviewEdited.addEventListener("click", () => {
  const activeTab = document.querySelector(".tab-btn.active")?.dataset?.tab;
  state.previewMode = activeTab === "cover" ? "cover" : "edited";
  updateModeButtons();
  loadCurrentPagePreview();
  showToast(
    state.previewMode === "cover"
      ? "تم تحديث معاينة الورقة الأولى (الغلاف)"
      : "تم تحديث المعاينة بالتعديلات الحالية"
  );
});

btnZoomIn.addEventListener("click", () => {
  state.zoom = Math.min(2.0, +(state.zoom + 0.15).toFixed(2));
  applyZoom();
});

btnZoomOut.addEventListener("click", () => {
  state.zoom = Math.max(0.5, +(state.zoom - 0.15).toFixed(2));
  applyZoom();
});

// ==========================================
// Full PDF Processing & Browser Download
// ==========================================
btnProcessDownload.addEventListener("click", async () => {
  if (!state.pdfBytes || !state.pdfJsDoc) return;

  processingModal.classList.remove("hidden");
  modalLoading.classList.remove("hidden");
  modalSuccess.classList.add("hidden");
  modalProgressText.textContent = "جاري تجهيز الصفحات وتطبيق التعديلات...";

  try {
    const { pdfBytes, stats } = await window.PdfStudioEngine.processPdfBytes(
      state.pdfBytes,
      state.pdfJsDoc,
      buildOptionsPayload(),
      { headerLogoUrl: state.headerLogoUrl, coverLogoUrl: state.coverLogoUrl },
      null,
      (done, total) => {
        modalProgressText.textContent = `جاري معالجة الصفحة ${done} من ${total}...`;
      }
    );

    if (state.lastDownloadUrl) URL.revokeObjectURL(state.lastDownloadUrl);
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    state.lastDownloadUrl = URL.createObjectURL(blob);

    const stem = state.fileName.replace(/\.pdf$/i, "");
    const outName = `${stem}_معدل.pdf`;

    processStats.innerHTML = `
      <div class="stat-item">
        <div class="stat-val">${stats.pages_processed}</div>
        <div class="stat-lbl">إجمالي صفحات الملف النهائي</div>
      </div>
      <div class="stat-item">
        <div class="stat-val">${stats.headers_updated} / ${stats.footers_updated}</div>
        <div class="stat-lbl">ترويسة / تذييل وترقيم</div>
      </div>
      <div class="stat-item">
        <div class="stat-val">${stats.text_replacements}</div>
        <div class="stat-lbl">استبدال لاسم التدريسي/النص</div>
      </div>
      <div class="stat-item">
        <div class="stat-val">${stats.watermarks_removed}</div>
        <div class="stat-lbl">عناصر علامة مائية أُزيلت</div>
      </div>
    `;

    btnDownloadFinal.href = state.lastDownloadUrl;
    btnDownloadFinal.download = outName;

    modalLoading.classList.add("hidden");
    modalSuccess.classList.remove("hidden");
  } catch (err) {
    processingModal.classList.add("hidden");
    alert("حدث خطأ أثناء معالجة الملف: " + (err?.message || err));
  }
});

btnCloseModal.addEventListener("click", () => {
  processingModal.classList.add("hidden");
});
