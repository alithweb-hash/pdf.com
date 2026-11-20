import io
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from pdf_processor import (
    analyze_pdf,
    process_full_pdf,
    render_cover_preview,
    render_edited_page_preview,
    render_page_png,
    search_text_in_pdf,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Academic PDF Editor", version="2.0.0")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# In-memory registries mapping UUID -> file metadata
FILE_STORE: Dict[str, Dict[str, Any]] = {}
OUTPUT_STORE: Dict[str, Dict[str, Any]] = {}
LOGO_STORE: Dict[str, Dict[str, Any]] = {}


def _cleanup_old_files(max_age_seconds: int = 10800) -> None:
    """Remove temporary PDF & logo files older than max_age_seconds (default 3 hours)."""
    now = time.time()
    for pattern in ("*.pdf", "logo_*.png"):
        for path in UPLOAD_DIR.glob(pattern):
            try:
                if now - path.stat().st_mtime > max_age_seconds:
                    path.unlink(missing_ok=True)
            except Exception:
                pass


def _is_valid_uuid(val: Optional[str]) -> bool:
    return bool(val and re.fullmatch(r"[a-f0-9]{32}", val))


def _get_uploaded_file(file_id: str) -> Dict[str, Any]:
    if not _is_valid_uuid(file_id):
        raise HTTPException(status_code=400, detail="معرّف الملف غير صالح")
    info = FILE_STORE.get(file_id)
    if not info or not os.path.isfile(info["path"]):
        raise HTTPException(status_code=404, detail="لم يتم العثور على الملف، يرجى إعادة رفعه")
    return info


def _resolve_logo_path(logo_id: Optional[str]) -> Optional[str]:
    if not _is_valid_uuid(logo_id):
        return None
    info = LOGO_STORE.get(logo_id)  # type: ignore[arg-type]
    if info and os.path.isfile(info["path"]):
        return info["path"]
    return None


def _prepare_options(raw_options: Dict[str, Any]) -> Dict[str, Any]:
    """Deep-resolve logo_id references safely into local filesystem paths (ignoring client-supplied paths)."""
    opts = dict(raw_options or {})

    header_opts = dict(opts.get("header") or {})
    header_opts.pop("logo_path", None)
    header_logo_path = _resolve_logo_path(header_opts.get("logo_id"))
    if header_logo_path:
        header_opts["logo_path"] = header_logo_path
    opts["header"] = header_opts

    cover_opts = dict(opts.get("cover_page") or {})
    cover_opts.pop("logo_path", None)
    cover_logo_path = _resolve_logo_path(cover_opts.get("logo_id"))
    if not cover_logo_path and cover_opts.get("use_header_logo", True):
        cover_logo_path = header_logo_path
    if cover_logo_path:
        cover_opts["logo_path"] = cover_logo_path
    opts["cover_page"] = cover_opts

    return opts


class SearchRequest(BaseModel):
    file_id: str
    query: str
    fuzzy_arabic: bool = True


class PreviewRequest(BaseModel):
    file_id: str
    page_number: int = 1
    options: Dict[str, Any] = {}


class ProcessRequest(BaseModel):
    file_id: str
    options: Dict[str, Any] = {}


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = STATIC_DIR / "index.html"
    return HTMLResponse(content=index_path.read_text(encoding="utf-8"))


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    _cleanup_old_files()

    original_name = file.filename or "document.pdf"
    if not original_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="يرجى رفع ملف بصيغة PDF فقط")

    file_id = uuid.uuid4().hex
    saved_path = UPLOAD_DIR / f"{file_id}.pdf"

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="الملف المرفوع فارغ")

    saved_path.write_bytes(content)

    try:
        analysis_data = analyze_pdf(str(saved_path))
    except Exception as exc:
        saved_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"تعذر قراءة ملف الـ PDF: {exc}") from exc

    FILE_STORE[file_id] = {
        "path": str(saved_path),
        "filename": original_name,
        "page_count": analysis_data["page_count"],
        "created_at": time.time(),
    }

    return {
        "file_id": file_id,
        "filename": original_name,
        **analysis_data,
    }


@app.post("/api/upload-logo")
async def upload_logo(file: UploadFile = File(...)):
    _cleanup_old_files()
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="ملف الشعار فارغ")

    try:
        img = Image.open(io.BytesIO(content))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        # Resize very large images cleanly to keep PDFs lightweight while staying sharp
        img.thumbnail((800, 800))
        logo_id = uuid.uuid4().hex
        saved_path = UPLOAD_DIR / f"logo_{logo_id}.png"
        img.save(str(saved_path), format="PNG")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"صورة الشعار غير صالحة: {exc}") from exc

    LOGO_STORE[logo_id] = {
        "path": str(saved_path),
        "filename": file.filename or "logo.png",
        "created_at": time.time(),
    }

    return {
        "logo_id": logo_id,
        "preview_url": f"/api/logo/{logo_id}",
    }


@app.get("/api/logo/{logo_id}")
async def get_logo_image(logo_id: str):
    path = _resolve_logo_path(logo_id)
    if not path:
        raise HTTPException(status_code=404, detail="الشعار غير موجود")
    return FileResponse(path=path, media_type="image/png")


@app.get("/api/page-image/{file_id}/{page_number}")
async def get_page_image(file_id: str, page_number: int):
    info = _get_uploaded_file(file_id)
    try:
        png_bytes = render_page_png(info["path"], page_number)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"فشل عرض الصفحة: {exc}") from exc
    return Response(content=png_bytes, media_type="image/png")


@app.post("/api/search")
async def search_text(req: SearchRequest):
    info = _get_uploaded_file(req.file_id)
    try:
        return search_text_in_pdf(info["path"], req.query, fuzzy_arabic=req.fuzzy_arabic)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"فشل البحث في الملف: {exc}") from exc


@app.post("/api/preview")
async def preview_edited_page(req: PreviewRequest):
    info = _get_uploaded_file(req.file_id)
    options = _prepare_options(req.options)
    try:
        png_bytes = render_edited_page_preview(info["path"], req.page_number, options)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"فشل توليد المعاينة: {exc}") from exc
    return Response(content=png_bytes, media_type="image/png")


@app.post("/api/preview-cover")
async def preview_cover_page(req: PreviewRequest):
    info = _get_uploaded_file(req.file_id)
    options = _prepare_options(req.options)
    try:
        png_bytes = render_cover_preview(info["path"], options)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"فشل توليد معاينة الغلاف: {exc}") from exc
    return Response(content=png_bytes, media_type="image/png")


@app.post("/api/process")
async def process_pdf(req: ProcessRequest):
    info = _get_uploaded_file(req.file_id)
    options = _prepare_options(req.options)
    output_id = uuid.uuid4().hex
    output_path = UPLOAD_DIR / f"edited_{output_id}.pdf"

    stem = Path(info["filename"]).stem
    output_filename = f"{stem}_معدل.pdf"

    try:
        stats = process_full_pdf(info["path"], str(output_path), options)
    except Exception as exc:
        output_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"حدث خطأ أثناء معالجة الكتاب: {exc}") from exc

    OUTPUT_STORE[output_id] = {
        "path": str(output_path),
        "filename": output_filename,
        "created_at": time.time(),
    }

    return {
        "output_id": output_id,
        "output_filename": output_filename,
        "download_url": f"/api/download/{output_id}",
        "stats": stats,
    }


@app.get("/api/download/{output_id}")
async def download_edited_pdf(output_id: str):
    if not _is_valid_uuid(output_id):
        raise HTTPException(status_code=400, detail="معرّف التحميل غير صالح")
    info = OUTPUT_STORE.get(output_id)
    if not info or not os.path.isfile(info["path"]):
        raise HTTPException(status_code=404, detail="الملف المعدّل غير موجود أو انتهت صلاحيته")

    encoded_name = quote(info["filename"])
    headers = {
        "Content-Disposition": f"attachment; filename=\"edited.pdf\"; filename*=UTF-8''{encoded_name}"
    }
    return FileResponse(
        path=info["path"],
        media_type="application/pdf",
        headers=headers,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
