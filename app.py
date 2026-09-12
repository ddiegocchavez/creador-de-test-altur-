"""
Altur Test Studio — servidor local para construir llamadas de prueba
(estéreo 8kHz PCM16, canal 0 = llamante / canal 1 = agente), previsualizar
los turnos que detectaría el VAD del proyecto, y mandarlas en base64 al
POST /detect real (local o público).

Arrancar:
    pip install -r requirements.txt
    python3 app.py
Luego abre http://localhost:8600 en el navegador.
"""
import base64
import io
import json
import time
from math import gcd

import numpy as np
import soundfile as sf
import urllib.request
import urllib.error
from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from scipy.signal import resample_poly

import vad_lib

TARGET_SR = 8000
MAX_CLIP_SECONDS = 120

app = FastAPI(title="Altur Test Studio")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def to_mono_8k(raw_bytes: bytes) -> np.ndarray:
    data, sr = sf.read(io.BytesIO(raw_bytes), always_2d=True, dtype="float64")
    mono = data.mean(axis=1)
    if sr != TARGET_SR:
        g = gcd(sr, TARGET_SR)
        up, down = TARGET_SR // g, sr // g
        mono = resample_poly(mono, up, down)
    if len(mono) > MAX_CLIP_SECONDS * TARGET_SR:
        raise HTTPException(422, f"Clip excede {MAX_CLIP_SECONDS}s tras remuestrear")
    return mono


def build_stereo_wav(clips_by_name: dict, timeline: list) -> tuple[bytes, float]:
    """clips_by_name: {filename: np.ndarray mono a 8kHz}
    timeline: [{"filename":.., "channel":0|1, "start": float}]
    Devuelve (bytes de WAV PCM16, duración en segundos)."""
    max_end = 0
    placed = []
    for turn in timeline:
        audio = clips_by_name.get(turn["filename"])
        if audio is None:
            raise HTTPException(422, f"Archivo referenciado no subido: {turn['filename']}")
        start_sample = int(round(float(turn["start"]) * TARGET_SR))
        if start_sample < 0:
            raise HTTPException(422, "El inicio de un turno no puede ser negativo")
        end_sample = start_sample + len(audio)
        max_end = max(max_end, end_sample)
        channel = int(turn["channel"])
        if channel not in (0, 1):
            raise HTTPException(422, "channel debe ser 0 (llamante) o 1 (agente)")
        placed.append((channel, start_sample, audio))

    if not placed:
        raise HTTPException(422, "El timeline está vacío")

    total_samples = max_end + TARGET_SR  # 1s de cola de silencio
    canvas = np.zeros((total_samples, 2), dtype=np.float64)
    for channel, start_sample, audio in placed:
        end_sample = start_sample + len(audio)
        canvas[start_sample:end_sample, channel] += audio

    peak = np.abs(canvas).max()
    if peak > 1e-9:
        canvas = canvas / peak * 0.9

    pcm16 = (canvas * 32767).astype(np.int16)
    buffer = io.BytesIO()
    sf.write(buffer, pcm16, TARGET_SR, subtype="PCM_16", format="WAV")
    duration = total_samples / TARGET_SR
    return buffer.getvalue(), duration


@app.post("/api/build")
async def api_build(timeline: str = Form(...), files: list[UploadFile] = None):
    files = files or []
    if not files:
        raise HTTPException(422, "Sube al menos un clip de audio")
    try:
        timeline_data = json.loads(timeline)
    except json.JSONDecodeError:
        raise HTTPException(422, "timeline no es JSON válido")

    clips = {}
    for uploaded in files:
        raw = await uploaded.read()
        try:
            clips[uploaded.filename] = to_mono_8k(raw)
        except Exception as exc:
            raise HTTPException(422, f"No se pudo leer {uploaded.filename}: {exc}")

    wav_bytes, duration = build_stereo_wav(clips, timeline_data)
    return {
        "duration_s": round(duration, 3),
        "wav_base64": base64.b64encode(wav_bytes).decode("ascii"),
        "size_bytes": len(wav_bytes),
    }


@app.post("/api/turns")
async def api_turns(payload: dict):
    wav_base64 = payload.get("wav_base64")
    if not wav_base64:
        raise HTTPException(422, "Falta wav_base64")
    config = {
        "frame_ms": int(payload.get("frame_ms", 30)),
        "thresh_db": float(payload.get("thresh_db", -38.0)),
        "min_speech": float(payload.get("min_speech", 0.2)),
        "min_sil": float(payload.get("min_sil", 0.25)),
        "noise_margin": float(payload.get("noise_margin", 12.0)),
    }
    raw = base64.b64decode(wav_base64)
    data, sr = sf.read(io.BytesIO(raw), always_2d=True, dtype="float64")
    if sr != TARGET_SR or data.shape[1] != 2:
        raise HTTPException(422, "Se esperaba WAV estéreo de 8kHz")
    profiles = [vad_lib.energy_profile(data[:, ch], sr, config["frame_ms"]) for ch in (0, 1)]
    turns = vad_lib.turns_from_profiles(profiles, **config)
    return {"turns": turns, "config_used": config}


@app.post("/api/send")
async def api_send(payload: dict):
    wav_base64 = payload.get("wav_base64")
    url = payload.get("url")
    if not wav_base64 or not url:
        raise HTTPException(422, "Faltan wav_base64 o url")
    body = json.dumps({"audio": wav_base64, "format": "wav"}).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            elapsed_ms = (time.monotonic() - start) * 1000
            return {
                "ok": True, "status": response.status,
                "latency_ms": round(elapsed_ms, 1),
                "body": json.loads(response.read()),
            }
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.monotonic() - start) * 1000
        detail = e.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail)
        except json.JSONDecodeError:
            pass
        return JSONResponse(status_code=200, content={
            "ok": False, "status": e.code, "latency_ms": round(elapsed_ms, 1), "body": detail,
        })
    except urllib.error.URLError as e:
        elapsed_ms = (time.monotonic() - start) * 1000
        return JSONResponse(status_code=200, content={
            "ok": False, "status": None, "latency_ms": round(elapsed_ms, 1),
            "body": {"error": str(e.reason)},
        })


app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8600)
