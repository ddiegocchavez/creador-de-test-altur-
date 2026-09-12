// ---------- estado global ----------
let PX_PER_SEC = 20;
const clips = new Map(); // filename -> { file, durationSec, channel, start }
let lastWavBase64 = null;

// ---------- utilidades ----------
function fmt(n, d = 2) { return Number(n).toFixed(d); }

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.addEventListener("loadedmetadata", () => {
      resolve(audio.duration || 1);
      URL.revokeObjectURL(url);
    });
    audio.src = url;
  });
}

// ---------- subida de archivos ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
["dragenter", "dragover"].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

async function handleFiles(fileList) {
  let nextStart = 0;
  for (const file of fileList) {
    if (clips.has(file.name)) continue;
    const duration = await getAudioDuration(file);
    clips.set(file.name, { file, durationSec: duration, channel: 0, start: nextStart });
    nextStart += duration + 0.5;
  }
  renderClipList();
  renderTimeline();
}

function renderClipList() {
  const container = document.getElementById("clipList");
  container.innerHTML = "";
  for (const [name, clip] of clips) {
    const chip = document.createElement("div");
    chip.className = "clip-chip";
    chip.innerHTML = `<span>${name}</span><span class="dur">${fmt(clip.durationSec, 1)}s</span>
      <button data-name="${name}">✕</button>`;
    chip.querySelector("button").onclick = () => {
      clips.delete(name);
      renderClipList();
      renderTimeline();
    };
    container.appendChild(chip);
  }
}

// ---------- timeline ----------
const lane0 = document.getElementById("lane0");
const lane1 = document.getElementById("lane1");
const overlay0 = document.getElementById("overlay0");
const overlay1 = document.getElementById("overlay1");
const ruler = document.getElementById("ruler");

document.getElementById("zoomSlider").addEventListener("input", (e) => {
  PX_PER_SEC = Number(e.target.value);
  document.getElementById("zoomValue").textContent = `${PX_PER_SEC} px/s`;
  renderTimeline();
});

function renderTimeline() {
  lane0.innerHTML = "";
  lane1.innerHTML = "";
  let maxEnd = 10;
  for (const clip of clips.values()) maxEnd = Math.max(maxEnd, clip.start + clip.durationSec);
  const widthPx = (maxEnd + 5) * PX_PER_SEC;
  lane0.style.minWidth = lane1.style.minWidth = `${widthPx}px`;

  renderRuler(maxEnd + 5);

  for (const [name, clip] of clips) {
    const block = document.createElement("div");
    block.className = `clip-block chan${clip.channel}`;
    block.style.left = `${clip.start * PX_PER_SEC}px`;
    block.style.width = `${Math.max(clip.durationSec * PX_PER_SEC, 24)}px`;
    block.innerHTML = `<span>${name}</span><button title="cambiar canal">⇄</button>`;
    block.querySelector("button").onclick = (e) => {
      e.stopPropagation();
      clip.channel = clip.channel === 0 ? 1 : 0;
      renderTimeline();
    };
    makeDraggable(block, clip);
    (clip.channel === 0 ? lane0 : lane1).appendChild(block);
  }
}

function renderRuler(totalSeconds) {
  ruler.innerHTML = "";
  ruler.style.minWidth = `${(totalSeconds) * PX_PER_SEC}px`;
  const step = PX_PER_SEC < 15 ? 5 : 1;
  for (let s = 0; s <= totalSeconds; s += step) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${s * PX_PER_SEC}px`;
    tick.textContent = `${s}s`;
    ruler.appendChild(tick);
  }
}

function makeDraggable(el, clip) {
  let dragging = false, startX = 0, originStart = 0;
  el.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "BUTTON") return;
    dragging = true;
    startX = e.clientX;
    originStart = clip.start;
    el.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const deltaSec = (e.clientX - startX) / PX_PER_SEC;
    clip.start = Math.max(0, originStart + deltaSec);
    el.style.left = `${clip.start * PX_PER_SEC}px`;
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; el.style.cursor = "grab"; }
  });
}

// ---------- parámetros del VAD ----------
const paramIds = ["frame_ms", "thresh_db", "min_speech", "min_sil", "noise_margin"];
const paramUnits = { frame_ms: "ms", thresh_db: "dB", min_speech: "s", min_sil: "s", noise_margin: "dB" };

paramIds.forEach((id) => {
  const input = document.getElementById(`p_${id}`);
  const label = document.getElementById(`v_${id}`);
  input.addEventListener("input", () => {
    label.textContent = `${input.value} ${paramUnits[id]}`;
  });
});

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const presets = {
      default: { frame_ms: 30, thresh_db: -38, min_speech: 0.2, min_sil: 0.25, noise_margin: 12 },
      tuned:   { frame_ms: 30, thresh_db: -46, min_speech: 0.1, min_sil: 0.2,  noise_margin: 18 },
    };
    const preset = presets[btn.dataset.preset];
    for (const [key, value] of Object.entries(preset)) {
      document.getElementById(`p_${key}`).value = value;
      document.getElementById(`v_${key}`).textContent = `${value} ${paramUnits[key]}`;
    }
  });
});

function getVadConfig() {
  const cfg = {};
  paramIds.forEach((id) => { cfg[id] = Number(document.getElementById(`p_${id}`).value); });
  return cfg;
}

// ---------- construir WAV ----------
document.getElementById("buildBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("buildResult");
  if (clips.size === 0) {
    resultEl.innerHTML = `<span class="error-text">Sube al menos un clip primero.</span>`;
    return;
  }
  resultEl.textContent = "Construyendo…";

  const formData = new FormData();
  const timeline = [];
  for (const [name, clip] of clips) {
    formData.append("files", clip.file, name);
    timeline.push({ filename: name, channel: clip.channel, start: clip.start });
  }
  formData.append("timeline", JSON.stringify(timeline));

  try {
    const res = await fetch("/api/build", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Error al construir");

    lastWavBase64 = data.wav_base64;
    resultEl.innerHTML = `<span class="ok">✓ WAV construido:</span> ${fmt(data.duration_s, 1)}s, ${(data.size_bytes / 1024).toFixed(1)} KB`;

    const player = document.getElementById("player");
    player.src = `data:audio/wav;base64,${data.wav_base64}`;
    player.style.display = "block";

    document.getElementById("turnsBtn").disabled = false;
    document.getElementById("sendBtn").disabled = false;
    document.getElementById("exportRow").style.display = "block";
  } catch (err) {
    resultEl.innerHTML = `<span class="error-text">${err.message}</span>`;
  }
});

// ---------- exportar ----------
function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showExportStatus(msg) {
  const el = document.getElementById("exportStatus");
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
}

document.getElementById("downloadWavBtn").addEventListener("click", () => {
  if (!lastWavBase64) return;
  const blob = base64ToBlob(lastWavBase64, "audio/wav");
  downloadBlob(blob, "llamada_prueba.wav");
  showExportStatus("✓ WAV descargado");
});

document.getElementById("copyB64Btn").addEventListener("click", async () => {
  if (!lastWavBase64) return;
  try {
    await navigator.clipboard.writeText(lastWavBase64);
    showExportStatus(`✓ Base64 copiado al portapapeles (${lastWavBase64.length.toLocaleString()} caracteres)`);
  } catch {
    // fallback si el navegador bloquea la API del portapapeles
    const textarea = document.createElement("textarea");
    textarea.value = lastWavBase64;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showExportStatus("✓ Base64 copiado (modo compatibilidad)");
  }
});

document.getElementById("downloadPayloadBtn").addEventListener("click", () => {
  if (!lastWavBase64) return;
  const payload = JSON.stringify({ audio: lastWavBase64, format: "wav" }, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  downloadBlob(blob, "llamada_prueba_payload.json");
  showExportStatus("✓ payload.json descargado — listo para curl o send_to_detect.py");
});

// ---------- recalcular turnos (overlay del VAD) ----------
document.getElementById("turnsBtn").addEventListener("click", async () => {
  if (!lastWavBase64) return;
  const config = getVadConfig();
  const res = await fetch("/api/turns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wav_base64: lastWavBase64, ...config }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.detail || "Error calculando turnos"); return; }

  overlay0.innerHTML = "";
  overlay1.innerHTML = "";
  for (const turn of data.turns) {
    const tick = document.createElement("div");
    tick.className = "turn-tick";
    tick.style.left = `${turn.start * PX_PER_SEC}px`;
    tick.style.width = `${Math.max((turn.end - turn.start) * PX_PER_SEC, 2)}px`;
    tick.title = `${turn.start}s - ${turn.end}s`;
    (turn.channel === 0 ? overlay0 : overlay1).appendChild(tick);
  }
});

// ---------- endpoint y envío ----------
const endpointPreset = document.getElementById("endpointPreset");
const endpointCustom = document.getElementById("endpointCustom");
endpointPreset.addEventListener("change", () => {
  endpointCustom.style.display = endpointPreset.value === "custom" ? "block" : "none";
});

document.getElementById("sendBtn").addEventListener("click", async () => {
  if (!lastWavBase64) return;
  const url = endpointPreset.value === "custom" ? endpointCustom.value.trim() : endpointPreset.value;
  if (!url) { alert("Escribe una URL de endpoint"); return; }

  const resultEl = document.getElementById("sendResult");
  resultEl.innerHTML = `<span class="meta-row">Enviando…</span>`;

  try {
    const res = await fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wav_base64: lastWavBase64, url }),
    });
    const data = await res.json();
    renderSendResult(data);
  } catch (err) {
    resultEl.innerHTML = `<span class="error-text">${err.message}</span>`;
  }
});

function renderSendResult(data) {
  const resultEl = document.getElementById("sendResult");
  if (!data.ok) {
    resultEl.innerHTML = `
      <div class="meta-row">HTTP ${data.status ?? "sin respuesta"} · ${fmt(data.latency_ms, 0)} ms</div>
      <div class="error-text">${JSON.stringify(data.body)}</div>`;
    return;
  }
  const body = data.body;
  const isAbstain = body.confidence === 0.5;
  const badgeClass = isAbstain ? "abstain" : (body.is_synthetic ? "synthetic" : "human");
  const badgeText = isAbstain ? "⚠ ABSTENCIÓN (evidencia insuficiente)"
    : (body.is_synthetic ? "🤖 SINTÉTICO" : "🧑 HUMANO");
  const pct = Math.round(body.confidence * 100);

  resultEl.innerHTML = `
    <div class="verdict-badge ${badgeClass}">${badgeText}</div>
    <div class="meta-row">Confianza: ${pct}% · Latencia: ${fmt(data.latency_ms, 0)} ms · HTTP ${data.status}</div>
    <div class="confidence-bar"><div class="confidence-fill" style="width:${pct}%"></div></div>
    <details class="raw-json">
      <summary>Ver JSON crudo</summary>
      <pre>${JSON.stringify(body, null, 2)}</pre>
    </details>`;
}

// ---------- init ----------
renderTimeline();
