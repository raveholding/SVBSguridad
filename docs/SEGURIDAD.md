# Sistemas VB Seguridad — Revisión de seguridad

Versión 2.3.0 · 3/11/2026

## Contra qué se protege

| Quién ataca | Qué tiene | Qué busca |
|---|---|---|
| Visitante malicioso | El QR o el sticker NFC de la puerta | Molestar con timbres falsos, hacerse pasar por el local, ver a otros visitantes |
| Alguien conectado al WiFi del lugar (cliente, empleado, vecino con la clave) | Acceso a la red local | Ver cámaras, adivinar PINs, abrir la puerta, capturar tráfico |
| Sitio web malicioso abierto en la tablet o la PC del panel | El navegador del panel | Mandar órdenes al servidor local (CSRF) o leer datos (DNS rebinding) |
| Otro sistema publicado en el mismo dominio | Código en `usuario.github.io` | Leer configuración, PINs de respaldo y claves guardadas en el navegador |
| Persona en la puerta con acceso físico a la tablet | La pantalla | Adivinar el PIN, entrar a administración |

## Corregido en esta versión

| Gravedad | Problema | Corrección |
|---|---|---|
| **Crítica** | El **PIN de administración se podía adivinar sin límite** por cualquier ruta de administración (`/api/setup`, `/api/v1/tokens`, etc.). Solo `/api/admin/check` contaba intentos: un PIN de 4 dígitos salía en segundos. | Cada intento fallido, por cualquier ruta, suma al bloqueo (5 intentos → 60 s, también para la puerta) y queda en la auditoría. |
| **Alta** | **Datos mezclados entre sistemas del mismo dominio.** Todos los sistemas publicados en `raveholding.github.io` comparten el almacenamiento del navegador: el sistema genérico mostraba el nombre y el logo de RAVE, y un sistema puede leer PINs de respaldo, temas de aviso y claves de WhatsApp de otro. | Cada instalación guarda sus datos en un espacio propio según su carpeta (incluida la bóveda de fotos y la caché offline). **Ver P1-b:** la protección completa es un dominio por cliente. |
| **Alta** | **CSRF:** una página web abierta en la tablet podía mandar órdenes al servidor local: avisos falsos a los dueños, eventos falsos en la auditoría, intentos de PIN. | Toda orden (POST/PUT/PATCH/DELETE) que llega desde otro sitio se rechaza y se registra (`CSRF_BLOCKED`). |
| **Alta** | **DNS rebinding:** un sitio externo podía apuntar su dominio a la IP del servidor y leer estado y fotos de cámaras. | El servidor solo atiende pedidos dirigidos a una IP, `localhost`, el nombre de la PC, `.local`, `.lan` o Tailscale (`.ts.net`), o a los dominios de `ALLOWED_HOSTS`. |
| **Alta** | **Panel sin contraseña por defecto:** cualquiera conectado al WiFi del lugar podía abrir el panel y ver las cámaras. | El asistente de instalación pide usuario y contraseña del panel por defecto (se puede desmarcar con la advertencia a la vista). |
| Media | La contraseña del panel no tenía bloqueo por intentos. | Bloqueo y registro `PANEL_AUTH_FAIL`. |
| Media | Un ataque desde muchas IPs de la red evitaba el bloqueo por IP. | **Bloqueo global:** 30 fallos en 10 minutos bloquean los accesos por PIN 5 minutos y avisan a los dueños (`GLOBAL_LOCKOUT`). |
| Media | `/api/alert` y `/api/events` sin límite: se podía llenar de avisos el celular de los dueños o el registro. | Límite por IP (12 avisos y 60 eventos por minuto). |
| Media | El panel se podía mostrar dentro de otra página (clickjacking). | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `nosniff`. |
| Media | La app de Windows abría con el sistema cualquier enlace (`file://`, protocolos que ejecutan programas). | Solo `https:`, `tel:` y `mailto:`; no puede navegar a otro sitio; ventana en *sandbox*. |
| Baja | Un sistema del mismo dominio podía borrar la caché offline de otro. | Caché propia por instalación. |

### Video portero (nuevo): cómo está protegido
- La cámara del visitante se enciende **solo al llamar**, con su permiso, y se apaga sola al responder, al cerrar la llamada, al salir de la página o a los 3 minutos.
- Cada llamada usa un **tema de señalización propio** (`<tema>-v<id>`). El panel nunca recibe ni muestra el tema principal.
- El panel acepta **una sola foto y una sola oferta de video por llamada**, con tamaños limitados y validación de formato. El video viaja cifrado de punta a punta (DTLS-SRTP de WebRTC), de celular a panel, sin pasar por servidores.

## Pendiente (en orden de prioridad)

| Prioridad | Problema | Solución propuesta |
|---|---|---|
| **P1-a** | **Cerradura ESP32:** la clave viaja tal cual en cada apertura por el WiFi del lugar. Quien capture ese tráfico una vez puede volver a abrir la puerta cuando quiera. | Desafío-respuesta: el servidor pide un número de un solo uso a la cerradura y firma la orden con HMAC-SHA256. Requiere cambiar el firmware y probarlo con una placa real antes de publicarlo. |
| **P1-b** | **Un dominio por cliente.** Hoy todos los sistemas de clientes están en `raveholding.github.io`, así que cualquiera de esos sistemas puede leer los datos guardados en el navegador de los otros. | Dominio propio de Vincular con un subdominio por cliente (GitHub Pages permite un dominio por repositorio), por ejemplo `rave.vincularbusiness.com.ar`. Afecta a los sistemas de RAVE y Cannabismática, que no se modificaron. |
| **P1-c** | En modo sin servidor, los PINs de respaldo quedan guardados en texto en el navegador de la tablet. | Guardar solo un hash (PBKDF2) y pasar a PINs de 6 dígitos. |
| P2 | **Portero QR:** el código del QR es el único secreto. Quien lo escanea puede escuchar el relevo público y ver los nombres de otros visitantes o mandar respuestas falsas. | Cifrado de punta a punta con una clave pública del panel incluida en el QR (ECDH + AES-GCM) y servidor ntfy propio con acceso por token. |
| P2 | En la red local, la contraseña del panel y los PINs viajan sin cifrar. | HTTPS en la red: `tailscale serve` o un certificado propio. |
| P2 | Si el video P2P no conecta (redes con NAT estricto), el panel queda con la foto. | Servidor TURN propio. |
| P3 | La auditoría se puede borrar o editar con acceso al disco. | Registro encadenado con hashes: se nota si falta o se cambió un evento. |
| P3 | Revisión independiente. | Prueba de intrusión (pentest) por terceros antes del lanzamiento comercial. |

## Cómo se verifica

```bash
cd server && npm test                 # 34 pruebas, incluye test/security.test.js
python3 tests/e2e_videoportero.py     # video portero, teclado de PC, almacenamiento separado
```

---
Sistemas VB Seguridad · Vincular Business · Sistema VB — WhatsApp (387) 4484132 · vincularbusiness@gmail.com
