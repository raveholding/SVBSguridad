'use strict';
/**
 * Sistemas VB Seguridad — Bóveda de secretos (AES-256-GCM).
 *
 * Cifra en reposo las credenciales del .env (contraseña del grabador, tokens, claves de WhatsApp, MQTT)
 * y el archivo de personas con plantillas biométricas (data/access.json).
 *
 *  - Clave maestra de 256 bits: variable SVB_MASTER_KEY (64 hex) o archivo data/master.key (permisos 600),
 *    que se crea solo la primera vez. Sin la clave, un .env copiado no sirve para nada.
 *  - Formato: "enc:v1:" + base64( iv[12] | tag[16] | texto cifrado ). Autenticado: si alguien lo
 *    modifica, el descifrado falla en lugar de devolver basura.
 *  - Los valores sin prefijo se leen tal cual (compatibilidad con instalaciones anteriores).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const SECRET_KEYS = /(_PASS|_TOKEN|_SECRET|_KEY|_APIKEY)$|^WHATSAPP_TO$|^PANEL_PASS$/;

class Vault {
  /** @param {{dataDir?:string, key?:string}} opts */
  constructor({ dataDir, key } = {}) {
    const hex = key || process.env.SVB_MASTER_KEY || '';
    if (/^[0-9a-f]{64}$/i.test(hex)) { this.key = Buffer.from(hex, 'hex'); this.source = 'env'; return; }
    if (!dataDir) throw new Error('Vault: falta dataDir o SVB_MASTER_KEY');
    const file = path.join(dataDir, 'master.key');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) this.key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    else { this.key = crypto.randomBytes(32); fs.writeFileSync(file, this.key.toString('hex'), { mode: 0o600 }); }
    if (this.key.length !== 32) throw new Error('Vault: clave maestra inválida');
    this.source = 'file';
  }
  static isEncrypted(v) { return typeof v === 'string' && v.startsWith(PREFIX); }
  encrypt(text) {
    if (Vault.isEncrypted(text)) return text;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  decrypt(value) {
    if (!Vault.isEncrypted(value)) return value;
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
  /** Descifra en el lugar todas las variables "enc:v1:" de un objeto tipo process.env. */
  decryptEnv(env = process.env) {
    const failed = [];
    for (const [k, v] of Object.entries(env)) {
      if (!Vault.isEncrypted(v)) continue;
      try { env[k] = this.decrypt(v); } catch { failed.push(k); env[k] = ''; }
    }
    return failed;
  }
}

/** ¿Esta variable del .env es un secreto que conviene cifrar? */
const isSecretKey = (k) => SECRET_KEYS.test(k);

module.exports = { Vault, isSecretKey, PREFIX };
