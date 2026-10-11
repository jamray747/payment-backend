import express from 'express'
import pkg from 'pg'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
const { Pool } = pkg

// ============================================================================
//  AR PAYMENT BACKEND  (Railway)
//  - merkt sich geraetebasiert, welches Geraet welche Modelle gekauft hat
//  - Testmodus (BILLER=test) zum sofortigen Durchtesten ohne echten Abrechner
//  - Stellen fuer CCBill/Verotel/SegPay sind mit TODO markiert
//
//  Env-Variablen (in Railway setzen):
//    DATABASE_URL    -> automatisch, wenn du eine Railway-Postgres-DB hinzufuegst
//    ALLOWED_ORIGIN  -> URL deiner AR-App, z. B. https://deine-app.com  (oder *)
//    BILLER          -> 'test' (Default) | 'ccbill' | 'verotel' | 'segpay'
//    PORT            -> automatisch von Railway gesetzt
// ============================================================================

const PORT = process.env.PORT || 3000
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
const BILLER = process.env.BILLER || 'test'

// --- Signierte Auslieferung der bezahlten .glb ---
//   SIGNING_SECRET  -> in Railway setzen (langer Zufallswert)!
//   Dateien liegen in ./protected/ (z. B. protected/2.glb) und werden NUR mit
//   gueltiger, kurzlebiger Signatur ausgeliefert.
const SIGNING_SECRET = process.env.SIGNING_SECRET || 'dev-insecure-change-me'
const PROTECTED_DIR = path.join(process.cwd(), 'protected')
const SIGN_TTL_MS = 2 * 60 * 60 * 1000  // 2 Stunden gueltig

function sign(sku, device, exp) {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(sku + '|' + device + '|' + exp).digest('hex')
}

// --- Produktkatalog: MUSS zu models.ts passen (sku = url) ---
const CATALOG = {
  'assets/2.glb':     {price: 2.99, name: 'Vendelin'},
  'assets/3.glb':     {price: 2.99, name: 'Anoki'},
  'assets/4.glb':     {price: 2.99, name: 'Scarlett'},
  'assets/5.glb':     {price: 2.99, name: 'Cloe on chair'},
  'assets/6_opt.glb': {price: 2.99, name: 'Scarlett on chair'},
  'assets/7.glb':     {price: 2.99, name: 'Cloe on chair'},
  'assets/8.glb':     {price: 2.99, name: 'Scarlett Joy'},
  'assets/9_opt.glb': {price: 2.99, name: 'Scarlett on chair'},
  'assets/10_opt.glb':{price: 2.99, name: 'Vivian on chair'},
  'assets/11.glb':    {price: 2.99, name: 'Nadine'},
  'assets/12.glb':    {price: 2.99, name: 'Jana'},
  'assets/13.glb':    {price: 2.99, name: 'Mary'},
  'assets/14.glb':    {price: 2.99, name: 'Alice'},
  'assets/15.glb':    {price: 2.99, name: 'Lena'},
  'assets/16.glb':    {price: 2.99, name: 'Sophia'},
}

// --- Speicher: Postgres falls DATABASE_URL, sonst In-Memory (nur Test) ---
let pool = null
const mem = new Map() // device -> Set(sku)

async function initStore() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}})
    await pool.query(
      'CREATE TABLE IF NOT EXISTS entitlements (' +
      'device TEXT, sku TEXT, created_at TIMESTAMPTZ DEFAULT now(), ' +
      'PRIMARY KEY (device, sku))')
    console.log('Postgres verbunden.')
  } else {
    console.log('Kein DATABASE_URL -> In-Memory-Speicher (nicht dauerhaft!).')
  }
}

async function grant(device, sku) {
  if (pool) {
    await pool.query('INSERT INTO entitlements(device, sku) VALUES($1,$2) ON CONFLICT DO NOTHING', [device, sku])
  } else {
    if (!mem.has(device)) mem.set(device, new Set())
    mem.get(device).add(sku)
  }
}

async function listSkus(device) {
  if (pool) {
    const r = await pool.query('SELECT sku FROM entitlements WHERE device=$1', [device])
    return r.rows.map(x => x.sku)
  }
  return [...(mem.get(device) || [])]
}

const app = express()
app.use(express.json())
app.use(express.urlencoded({extended: true}))

// CORS (Browser-Client darf zugreifen)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/', (req, res) => res.send('AR payment backend OK (biller=' + BILLER + ')'))

// Welche Modelle besitzt dieses Geraet?
app.get('/entitlements', async (req, res) => {
  const device = String(req.query.device || '')
  if (!device) return res.status(400).json({error: 'device missing'})
  res.json({skus: await listSkus(device)})
})

// Kauf starten
app.get('/checkout', async (req, res) => {
  const device = String(req.query.device || '')
  const sku = String(req.query.sku || '')
  const ret = String(req.query.return || '/')
  if (!device || !CATALOG[sku]) return res.status(400).send('Invalid product or device')

  if (BILLER === 'test') {
    // ===== NUR ZUM TESTEN: sofort freischalten und zurueck =====
    // In Produktion ENTFERNEN, sonst kann jeder gratis freischalten!
    await grant(device, sku)
    const sep = ret.includes('?') ? '&' : '?'
    return res.redirect(ret + sep + 'unlocked=' + encodeURIComponent(sku))
  }

  // ===== Echter Abrechner =====
  // device + sku in ein Pass-through/Custom-Feld der Bestellung legen, damit der
  // Postback sie zurueckliefert. Account-/Form-IDs aus Env-Variablen.
  // TODO (CCBill: dynamic pricing form; Verotel: FlexPay; SegPay: dynamic):
  //   const url = buildBillerCheckoutUrl({device, sku, price: CATALOG[sku].price, ret})
  //   return res.redirect(url)
  return res.status(501).send('Payment provider checkout not configured (BILLER=' + BILLER + ')')
})

// Postback/Webhook des Abrechners -> Freischaltung
app.all('/postback', async (req, res) => {
  // !!! TODO: Signatur/Authentizitaet anbieterspezifisch PRUEFEN, sonst kann jeder freischalten !!!
  const data = {...req.query, ...req.body}
  const device = String(data.device || '')
  const sku = String(data.sku || '')
  if (device && CATALOG[sku]) {
    await grant(device, sku)
    return res.send('OK')
  }
  res.status(400).send('Missing or invalid data')
})

// Signierte, kurzlebige URL fuer ein bezahltes Modell (nur fuer freigeschaltete Geraete).
app.get('/sign', async (req, res) => {
  const device = String(req.query.device || '')
  const sku = String(req.query.sku || '')
  if (!device || !CATALOG[sku]) return res.status(400).json({error: 'Invalid product or device'})
  const owned = await listSkus(device)
  if (!owned.includes(sku)) return res.status(403).json({error: 'Not purchased'})
  const exp = Date.now() + SIGN_TTL_MS
  const sig = sign(sku, device, exp)
  const base = encodeURIComponent(path.basename(sku))
  const q = 'device=' + encodeURIComponent(device) + '&exp=' + exp + '&sig=' + sig
  res.json({url: '/model/' + base + '?' + q, exp})
})

// Geschuetzte Auslieferung: streamt die .glb nur mit gueltiger, nicht abgelaufener Signatur.
app.get('/model/:file', async (req, res) => {
  const base = path.basename(String(req.params.file || ''))  // verhindert Path-Traversal
  const sku = 'assets/' + base
  const device = String(req.query.device || '')
  const exp = parseInt(String(req.query.exp || '0'), 10)
  const sig = String(req.query.sig || '')
  if (!CATALOG[sku]) return res.status(404).send('Unknown product')
  if (!exp || Date.now() > exp) return res.status(403).send('Link expired')
  const expected = sign(sku, device, exp)
  const ok = sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  if (!ok) return res.status(403).send('Bad signature')
  const owned = await listSkus(device)
  if (!owned.includes(sku)) return res.status(403).send('Not purchased')
  const file = path.join(PROTECTED_DIR, base)
  if (!fs.existsSync(file)) return res.status(404).send('File not available on server')
  res.setHeader('Content-Type', 'model/gltf-binary')
  res.setHeader('Cache-Control', 'private, no-store')
  fs.createReadStream(file).pipe(res)
})

initStore()
  .then(() => app.listen(PORT, () => console.log('AR payment backend laeuft auf Port ' + PORT)))
  .catch(e => { console.error('Start fehlgeschlagen:', e); process.exit(1) })
