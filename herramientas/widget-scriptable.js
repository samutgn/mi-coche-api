// Mi Garaje — widget para la pantalla de inicio del iPhone (app gratuita "Scriptable").
// Tamaños: pequeño (lo básico), mediano/grande (todo) y pantalla de bloqueo (rectangular, redondo y en línea). La primera vez que lo ejecutes dentro de Scriptable
// te pide la URL del servidor y la contraseña (APP_KEY) y las guarda en el llavero del iPhone.

const URL_KEY = 'fiesta_st_url', PASS_KEY = 'fiesta_st_key';
const AC = new Color('#ffd400'), OK = new Color('#2ee59d'), WA = new Color('#ffb21e'), BAD = new Color('#ff4d3d');
const MU = new Color('#7d858f'), TX = new Color('#f4f5f6'), BG = new Color('#0a0b0d'), PN = new Color('#16191d');

async function ask(title, key, secure) {
  if (Keychain.contains(key) && Keychain.get(key).trim()) return Keychain.get(key);
  const a = new Alert();
  a.title = title;
  if (secure) a.addSecureTextField('Contraseña'); else a.addTextField('URL', 'https://mi-coche-api.tu-usuario.workers.dev');
  a.addAction('Guardar');
  await a.present();
  const v = a.textFieldValue(0).trim();
  Keychain.set(key, v);
  return v;
}

const base = (await ask('URL del servidor', URL_KEY, false)).replace(/\/+$/, '');
const pass = await ask('Contraseña de la app (APP_KEY)', PASS_KEY, true);

let d = null, err = null;
try {
  const r = new Request(base + '/api/widget');
  r.headers = { 'x-app-key': pass };
  d = await r.loadJSON();
  if (d.error) { err = d.error; d = null; }
} catch (e) { err = 'Sin conexión: ' + e.message; }
if (err && /401|Contraseña/i.test(err)) Keychain.remove(PASS_KEY);

const fam = config.widgetFamily || (config.runsInWidget ? 'small' : 'medium');
const f2 = v => v == null ? '—' : v.toFixed(2).replace('.', ',');
const n0 = v => v == null ? '—' : Math.round(v).toLocaleString('es-ES');

function txt(stack, s, size, color, weight = 'medium', mono = false) {
  const t = stack.addText(String(s));
  t.font = mono ? (weight === 'bold' ? Font.boldMonospacedSystemFont(size) : Font.mediumMonospacedSystemFont(size))
    : weight === 'bold' ? Font.boldSystemFont(size) : weight === 'regular' ? Font.systemFont(size) : Font.mediumSystemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function label(stack, s) { return txt(stack, s.toUpperCase(), 9, new Color('#b3bac2'), 'bold'); }

function bar(stack, pct, width, color) {
  const c = new DrawContext();
  c.size = new Size(width, 6); c.opaque = false; c.respectScreenScale = true;
  const bg = new Path(); bg.addRoundedRect(new Rect(0, 0, width, 6), 3, 3); c.addPath(bg); c.setFillColor(new Color('#2a2f35')); c.fillPath();
  const w = Math.max(6, width * Math.max(0, Math.min(1, pct / 100)));
  const fg = new Path(); fg.addRoundedRect(new Rect(0, 0, w, 6), 3, 3); c.addPath(fg); c.setFillColor(color); c.fillPath();
  const img = stack.addImage(c.getImage()); img.imageSize = new Size(width, 6);
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60e3);
  return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
}

const w = new ListWidget();
if (!fam.startsWith('accessory')) w.backgroundColor = BG;

// Fondo: foto del coche oscurecida para que se lea el texto (se guarda en el iPhone por si no hay conexión)
async function background(file) {
  const fm = FileManager.local(), path = fm.joinPath(fm.documentsDirectory(), 'fiesta-' + file);
  let img = null;
  try { img = await new Request('https://garaje-coche-app.github.io/app/herramientas/' + file).loadImage(); fm.writeImage(path, img); }
  catch (e) { if (fm.fileExists(path)) img = fm.readImage(path); }
  if (!img) return null;
  const c = new DrawContext(); c.size = img.size; c.opaque = true;
  c.drawImageInRect(img, new Rect(0, 0, img.size.width, img.size.height));
  const W = img.size.width, H = img.size.height;
  c.setFillColor(new Color('#000000', 0.62)); c.fillRect(new Rect(0, 0, W, H));
  // Más oscuro arriba (donde va el texto) que abajo (donde se ve el coche)
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    const a = 0.28 * (1 - i / steps);
    c.setFillColor(new Color('#000000', a)); c.fillRect(new Rect(0, (H * 0.75 / steps) * i, W, H * 0.75 / steps + 1));
  }
  return c.getImage();
}
w.url = 'https://garaje-coche-app.github.io/app/';
w.refreshAfterDate = new Date(Date.now() + 15 * 60e3);

if (fam && fam.startsWith('accessory')) {
  // ---------- Pantalla de bloqueo (iOS pinta en un solo color) ----------
  const running = d && d.ignition && d.ignition !== 'off';
  const lockTxt = !d ? '—' : running ? 'En marcha' : d.lock_checking ? 'Comprobando' : d.locked ? 'Cerrado' : 'ABIERTO';
  if (fam === 'accessoryCircular') {
    const gauge = w.addStack(); gauge.layoutVertically(); gauge.centerAlignContent();
    w.addAccessoryWidgetBackground = true;
    const a = gauge.addStack(); a.addSpacer(); txt(a, d ? n0(d.fuel_pct) + '%' : '—', 16, Color.white(), 'bold', true); a.addSpacer();
    const b = gauge.addStack(); b.addSpacer(); txt(b, d ? (d.locked || running ? '⛽' : '🔓') : '', 11, Color.white()); b.addSpacer();
  } else if (fam === 'accessoryInline') {
    txt(w, d ? `⛽ ${n0(d.fuel_pct)} % · ${n0(d.range_km)} km · ${lockTxt}` : 'Fiesta ST sin datos', 12, Color.white());
  } else {
    // rectangular
    const h = w.addStack(); txt(h, 'FIESTA ST', 11, Color.white(), 'bold', true); h.addSpacer(); txt(h, lockTxt, 11, Color.white(), 'bold');
    txt(w, d ? `⛽ ${n0(d.fuel_pct)} % · ${n0(d.range_km)} km` : (err || 'Sin datos'), 14, Color.white(), 'bold', true);
    if (d) {
      const low = d.tyres_low || [];
      const t = d.tyres || {};
      txt(w, low.length ? `⚠︎ Rueda baja (${low.length})` : `${f2(t.fl)} ${f2(t.fr)} · ${f2(t.rl)} ${f2(t.rr)}`, 11, Color.white(), 'medium', true);
    }
  }
} else if (!d) {
  w.setPadding(14, 14, 14, 14);
  txt(w, 'FIESTA ST', 11, MU, 'bold', true);
  w.addSpacer(6);
  const t = txt(w, err || 'Sin datos', 13, BAD); t.lineLimit = 4;
} else if (fam === 'small') {
  w.setPadding(14, 14, 14, 14);
  txt(w, 'FIESTA ST', 11, MU, 'bold', true);
  w.addSpacer(4);
  txt(w, `${n0(d.range_km)} km`, 28, TX, 'bold', true);
  txt(w, `Depósito ${n0(d.fuel_pct)} %`, 12, (d.fuel_pct ?? 100) < 15 ? WA : MU);
  w.addSpacer(6);
  txt(w, d.lock_checking ? '● Comprobando…' : d.locked ? '● Cerrado' : '● Abierto', 13, d.lock_checking ? MU : d.locked ? OK : WA, 'bold');
  const low = d.tyres_low || [], t = d.tyres || {};
  for (const [a, b] of [['fl', 'fr'], ['rl', 'rr']]) {
    const row = w.addStack();
    txt(row, f2(t[a]), 12, low.includes(a) ? WA : TX, 'medium', true); row.addSpacer(10);
    txt(row, f2(t[b]), 12, low.includes(b) ? WA : TX, 'medium', true);
  }
  w.addSpacer();
  txt(w, ago(d.data_ts), 10, MU, 'regular');
} else {
  // ---------- Mediano y grande ----------
  w.setPadding(12, 14, 12, 14);
  const bgImg = await background(fam === 'large' ? 'widget-fondo-grande.jpg' : 'widget-fondo.jpg');
  if (bgImg) w.backgroundImage = bgImg;
  if (fam === 'large') w.addSpacer();
  const running = d.ignition && d.ignition !== 'off';

  // Cabecera
  const top = w.addStack(); top.centerAlignContent();
  txt(top, 'FIESTA ST', 11, AC, 'bold', true);
  if (d.circuit) { top.addSpacer(6); txt(top, '🏁 ' + d.circuit, 11, AC, 'bold'); }
  top.addSpacer();
  txt(top, running ? `● En marcha · ${n0(d.speed_kmh)} km/h` : d.lock_checking ? '● Comprobando cierre…' : d.locked ? '● Cerrado' : '● Abierto', 11, running ? AC : d.lock_checking ? MU : d.locked ? OK : WA, 'bold');
  w.addSpacer(8);

  const body = w.addStack(); body.layoutHorizontally();

  // Columna 1: autonomía y depósito
  const c1 = body.addStack(); c1.layoutVertically(); c1.size = new Size(112, 0);
  label(c1, 'Autonomía');
  const r = c1.addStack(); r.bottomAlignContent();
  txt(r, n0(d.range_km), 30, TX, 'bold', true); r.addSpacer(3); txt(r, 'km', 13, new Color('#c9ced4'), 'bold');
  c1.addSpacer(4);
  bar(c1, d.fuel_pct ?? 0, 100, (d.fuel_pct ?? 100) < 15 ? WA : AC);
  c1.addSpacer(3);
  txt(c1, `Depósito ${n0(d.fuel_pct)} %`, 11, new Color('#c9ced4'));
  if (!d.lock_checking && d.doors_open && d.doors_open.length) { c1.addSpacer(2); txt(c1, 'Puerta abierta', 11, WA, 'bold'); }
  else if (!d.lock_checking && d.windows_open && d.windows_open.length) { c1.addSpacer(2); txt(c1, 'Ventanilla bajada', 11, WA, 'bold'); }

  body.addSpacer(10);

  // Columna 2: neumáticos
  const c2 = body.addStack(); c2.layoutVertically(); c2.size = new Size(84, 0);
  label(c2, 'Neumáticos');
  c2.addSpacer(4);
  const low = d.tyres_low || [], t = d.tyres || {};
  for (const [a, b] of [['fl', 'fr'], ['rl', 'rr']]) {
    const row = c2.addStack(); row.spacing = 6;
    for (const k of [a, b]) {
      const cell = row.addStack(); cell.backgroundColor = new Color('#000000', 0.45); cell.cornerRadius = 6; cell.setPadding(3, 5, 3, 5);
      txt(cell, f2(t[k]), 12, low.includes(k) ? WA : OK, 'bold', true);
    }
    c2.addSpacer(4);
  }

  body.addSpacer(10);

  // Columna 3: motor, batería, aceite, km
  const c3 = body.addStack(); c3.layoutVertically();
  const kv = (k, v, col = TX) => { const s = c3.addStack(); txt(s, k, 11, new Color('#c9ced4')); s.addSpacer(); txt(s, v, 11, col, 'bold', true); c3.addSpacer(3); };
  const eng = d.engine_c;
  kv('Motor', eng == null ? '—' : `${eng}°`, eng == null ? TX : eng < 60 ? new Color('#4aa3ff') : eng > 110 ? BAD : TX);
  kv('Batería', d.battery_v != null ? `${f2(d.battery_v)} V` : d.battery_soc != null ? `${d.battery_soc} %` : '—', (d.battery_v != null && d.battery_v < 12.2) || (d.battery_v == null && d.battery_soc != null && d.battery_soc < 55) ? WA : TX);
  kv('Aceite', d.oil_life_pct == null ? '—' : `${n0(d.oil_life_pct)} %`, d.oil_life_pct != null && d.oil_life_pct < 20 ? WA : TX);
  kv('Km', n0(d.odometer_km));

  w.addSpacer();

  // Pie: aviso o lo próximo del taller, y cuándo son los datos
  const foot = w.addStack(); foot.centerAlignContent();
  const NAMES = { fl: 'del. izq.', fr: 'del. der.', rl: 'tras. izq.', rr: 'tras. der.' };
  const lowK = (d.tyres_low || [])[0];
  const alert = lowK ? `Rueda ${NAMES[lowK]} baja: ${f2((d.tyres || {})[lowK])} bar` + ((d.tyres_low || []).length > 1 ? ` (+${d.tyres_low.length - 1})` : '')
    : (d.alerts || [])[0];
  if (alert) txt(foot, '⚠︎ ' + alert, 11, WA, 'bold');
  else if (d.next) txt(foot, '🔧 ' + d.next.text, 10, d.next.urgent ? WA : MU, 'medium');
  foot.addSpacer();
  txt(foot, ago(d.data_ts), 10, MU, 'regular');
}

if (config.runsInWidget) Script.setWidget(w);
else if (fam === 'small') await w.presentSmall(); else if (fam === 'large') await w.presentLarge(); else await w.presentMedium();
Script.complete();
