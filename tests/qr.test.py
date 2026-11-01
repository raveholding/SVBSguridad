"""Verifica que el codificador QR propio genere códigos legibles (OpenCV) en todas las versiones 1-10."""
import json, subprocess, sys, os
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
samples = ["SVB", "SVB1|482913|2026-11-02T10:00", "https://rave.local:8080/?modo=puerta",
           "SVB1|123456|2026-12-31T23:59|Proveedor Coca-Cola Distribuidora Norte",
           "x" * 60, "y" * 90, "z" * 120, "w" * 150, "Ñandú áéíóú " * 10,
           "SVB1|" + "|".join(f"Pase{i:03d}-RaveAlmacenSalta" for i in range(7))]
js = f"""
const {{ qrEncode }} = require({json.dumps(os.path.join(HERE, 'qr-encoder.js'))});
const s = {json.dumps(samples)};
console.log(JSON.stringify(s.map(t => qrEncode(t))));
"""
out = json.loads(subprocess.check_output(["node", "-e", js]))
det = cv2.QRCodeDetector()
fails = 0
for text, q in zip(samples, out):
    m = np.array(q["modules"], dtype=np.uint8)
    img = np.where(m == 1, 0, 255).astype(np.uint8)
    img = np.pad(img, 4, constant_values=255)
    img = cv2.resize(img, None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)
    val, _, _ = det.detectAndDecode(img)
    ok = val == text
    fails += not ok
    print(f"v{q['version']:>2} {'OK ' if ok else 'FAIL'} {text[:40]!r} -> {val[:40]!r}")
sys.exit(1 if fails else 0)
