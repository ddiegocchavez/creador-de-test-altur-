# Generador de Test — Altur

Servidor local con interfaz visual para:
1. Subir clips de audio (cualquier formato/sample rate).
2. Armar una conversación arrastrando cada clip a un timeline con dos canales
   (0 = llamante, 1 = agente).
3. Ajustar los parámetros del VAD (`frame_ms`, `thresh_db`, `min_speech`,
   `min_sil`, `noise_margin`) con sliders y ver en vivo qué turnos detectaría
   `vad.py` sobre el resultado.
4. Construir el WAV final (estéreo, 8kHz, PCM16 — el formato exacto que
   exige el endpoint del proyecto).
5. Mandarlo en base64 a un `POST /detect` (local o público) y ver el
   veredicto, la confianza y la latencia con una interfaz clara.
6. **Exportar** el resultado para probarlo en otro lugar: descargar el
   `.wav` tal cual, copiar el base64 crudo al portapapeles, o descargar un
   `payload.json` (`{"audio": "...", "format": "wav"}`) listo para usarse
   con `curl -d @payload.json ...` o con el script `send_to_detect.py`.

## Arrancar

```bash
git clone https://github.com/<tu-usuario>/generador-de-test.git
cd generador-de-test
pip install -r requirements.txt
python3 app.py
```

En Windows (PowerShell), usa `python` en vez de `python3`:
```powershell
python -m pip install -r requirements.txt
python app.py
```

Abre `http://localhost:8600` en tu navegador.

## Notas

- El servidor de este estudio (puerto 8600) es **distinto** al servidor del
  modelo (`serve.py` del proyecto, típicamente puerto 8000). Corre ambos en
  paralelo: uno sirve el modelo, el otro te deja construir y mandar pruebas.
- El envío al endpoint `/detect` se hace **desde el backend de Python**, no
  desde el navegador — así evitas problemas de CORS al mandar a hosts
  externos (como tu servicio en Render) sin que ellos tengan que configurar
  cabeceras especiales.
- Los archivos que subes nunca se guardan en disco: se procesan en memoria
  para construir el WAV y se descartan al terminar la petición.
- Si tu proyecto real tiene un `vad_config.json` con parámetros ajustados
  (por ejemplo, `thresh_db: -46`), usa el botón de preset "Ajustado del
  proyecto" o edítalo directamente en los sliders para que la previsualización
  de turnos sea fiel a lo que corre en producción.
